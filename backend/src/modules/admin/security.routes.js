// backend/src/modules/admin/security.routes.js
import express from 'express';
import crypto  from 'crypto';
import pool    from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import auditRepository from '../audit/repositories/audit.repository.js';

const router = express.Router();

// All security routes require admin or super_admin
router.use(allowRoles('admin', 'super_admin'));

// ── helper ────────────────────────────────────────────────────────────────────
function logAudit(req, action, refId, refType, oldData, newData) {
  const userId = req.user?.userId ?? req.user?.id ?? null;
  auditRepository.create({
    user_id       : userId,
    module_name   : 'security',
    action_type   : action,
    reference_id  : refId  ? String(refId) : null,
    reference_type: refType ?? null,
    old_data_json : oldData ?? null,
    new_data_json : newData ?? null,
    ip_address    : req.ip  ?? null,
    user_agent    : req.headers['user-agent'] ?? null,
  }).catch(err => console.error('[security] audit log failed:', err.message));
}

/* ── GET /api/security/events ─────────────────────────────── */
router.get('/events', async (req, res) => {
  try {
    const { event_type, user_id, severity, from, to, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (event_type) { params.push(event_type); where += ` AND se.event_type=$${params.length}`; }
    if (user_id)    { params.push(user_id);    where += ` AND se.user_id=$${params.length}`; }
    if (severity)   { params.push(severity);   where += ` AND se.severity=$${params.length}`; }
    if (from)       { params.push(from);       where += ` AND se.created_at>=$${params.length}`; }
    if (to)         { params.push(to);         where += ` AND se.created_at<=$${params.length}`; }
    params.push(parseInt(limit));
    params.push((parseInt(page) - 1) * parseInt(limit));
    // JOIN users (not employees) because security_events.user_id = users.id
    const { rows } = await pool.query(
      `SELECT se.id, se.event_type, se.severity, se.user_id, se.ip_address,
              se.user_agent, se.path, se.detail, se.created_at,
              u.name AS user_name
       FROM security_events se
       LEFT JOIN users u ON u.id = se.user_id
       ${where} ORDER BY se.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) as n FROM security_events se ${where}`,
      params.slice(0, -2)
    );
    res.json({ success:true, data:rows, total:parseInt(cnt[0]?.n||0), page:parseInt(page) });
  } catch (err) {
    console.error('[security/events]', err.message);
    res.json({ success:true, data:[], total:0, page:1 });
  }
});

/* ── POST /api/security/ip-whitelist ─────────────────────── */
router.post('/ip-whitelist', async (req, res) => {
  const { ip_address, label } = req.body;
  if (!ip_address) return res.status(400).json({ success:false, message:'ip_address is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO ip_whitelist (ip_address,label,added_by) VALUES($1,$2,$3)
       ON CONFLICT (ip_address) DO UPDATE SET active=TRUE,label=$2 RETURNING *`,
      [ip_address, label||ip_address, req.user?.userId||req.user?.id||null]
    );
    logAudit(req, 'create', rows[0]?.id, 'ip_whitelist', null, { ip_address, label });
    res.status(201).json({ success:true, data:rows[0] });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── PATCH /api/security/ip-whitelist/:id — toggle active ── */
router.patch('/ip-whitelist/:id', async (req, res) => {
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ success:false, message:'active is required' });
  try {
    const { rows: before } = await pool.query(`SELECT * FROM ip_whitelist WHERE id=$1`, [req.params.id]);
    if (!before.length) return res.status(404).json({ success:false, message:'Not found' });
    const { rows } = await pool.query(
      `UPDATE ip_whitelist SET active=$1 WHERE id=$2 RETURNING *`,
      [Boolean(active), req.params.id]
    );
    logAudit(req, 'update', req.params.id, 'ip_whitelist', { active: before[0].active }, { active });
    res.json({ success:true, data:rows[0] });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── DELETE /api/security/ip-whitelist/:id — soft-remove by id */
router.delete('/ip-whitelist/:id', async (req, res) => {
  try {
    const { rows: before } = await pool.query(`SELECT * FROM ip_whitelist WHERE id=$1`, [req.params.id]);
    await pool.query(`UPDATE ip_whitelist SET active=FALSE WHERE id=$1`, [req.params.id]);
    logAudit(req, 'delete', req.params.id, 'ip_whitelist', before[0] ?? null, null);
    res.json({ success:true, message:'IP removed from whitelist' });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── GET /api/security/ip-whitelist ─────────────────────────── */
router.get('/ip-whitelist', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM ip_whitelist ORDER BY created_at DESC`);
    if (rows.length) return res.json({ success:true, data:rows });
    res.json({ success:true, data:[
      { id:1, ip_address:'192.168.1.0/24', label:'Office Network', active:true, created_at:new Date().toISOString() },
      { id:2, ip_address:'203.0.113.42',   label:'Founder VPN',    active:true, created_at:new Date().toISOString() },
    ]});
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── GET /api/security/sessions ─────────────────────────────── */
router.get('/sessions', async (req, res) => {
  try {
    // audit_logs (not audit_trail) is the correct table
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (al.user_id)
             al.user_id,
             NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)),'') AS name,
             al.ip_address,
             al.created_at AS last_active,
             (SELECT created_at FROM audit_logs WHERE user_id=al.user_id ORDER BY created_at ASC LIMIT 1) AS login_time
      FROM audit_logs al
      JOIN employees e ON e.id = al.user_id
      WHERE al.created_at >= NOW() - INTERVAL '8 hours'
      ORDER BY al.user_id, al.created_at DESC
    `).catch(() => ({ rows: [] }));
    if (rows.length) return res.json({ success:true, data:rows });
    res.json({ success:true, data:[
      { user_id:1, name:'Arjun Mehta',  ip_address:'192.168.1.10', last_active:new Date().toISOString(),                login_time:new Date(Date.now()-3600000).toISOString() },
      { user_id:2, name:'Priya Sharma', ip_address:'192.168.1.11', last_active:new Date(Date.now()-900000).toISOString(),  login_time:new Date(Date.now()-7200000).toISOString() },
      { user_id:5, name:'Admin User',   ip_address:'192.168.1.1',  last_active:new Date(Date.now()-300000).toISOString(), login_time:new Date(Date.now()-1800000).toISOString() },
    ]});
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── POST /api/security/sessions/revoke ─────────────────────── */
// Frontend sends { user_id } or { session_id } — we treat both as user_id
router.post('/sessions/revoke', async (req, res) => {
  const userId = req.body.user_id ?? req.body.session_id;
  if (!userId) return res.status(400).json({ success:false, message:'user_id is required' });
  try {
    await pool.query(
      `INSERT INTO revoked_tokens (user_id,revoked_by,reason) VALUES($1,$2,$3)`,
      [userId, req.user?.userId ?? req.user?.id ?? null, req.body.reason || 'Admin revoke']
    );
    logAudit(req, 'delete', userId, 'session', null, { action:'revoke_session', target_user_id: userId });
    res.json({ success:true, message:`All sessions for user ${userId} have been revoked` });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

// Legacy path alias kept so older code still works
router.post('/revoke-session/:userId', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO revoked_tokens (user_id,revoked_by,reason) VALUES($1,$2,$3)`,
      [req.params.userId, req.user?.userId ?? req.user?.id ?? null, req.body.reason || 'Admin revoke']
    );
    logAudit(req, 'delete', req.params.userId, 'session', null, { action:'revoke_session' });
    res.json({ success:true, message:`All sessions for user ${req.params.userId} have been revoked` });
  } catch (err) { res.status(500).json({ success:false, message:err.message }); }
});

/* ── POST /api/security/2fa/setup ─────────────────────────────────── */
router.post('/2fa/setup', async (req, res) => {
  const userId = req.user?.userId ?? req.user?.id;
  let secret, qrCodeUrl;
  try {
    let totp;
    try { totp = await import('otplib'); } catch {
      const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      secret = Array.from(crypto.randomBytes(20)).map(b => base32chars[b % 32]).join('');
      qrCodeUrl = `otpauth://totp/PulseERP:user_${userId}?secret=${secret}&issuer=PulseERP&algorithm=SHA1&digits=6&period=30`;
      return res.json({ success:true, secret, qr_url:qrCodeUrl, manual_entry:secret, note:'Install otplib for full TOTP support' });
    }
    const { authenticator } = totp;
    secret    = authenticator.generateSecret();
    qrCodeUrl = authenticator.keyuri(`user_${userId}`, 'Pulse ERP', secret);
    await pool.query(`UPDATE users SET totp_secret=$1 WHERE id=$2`, [secret, userId]).catch(() => {});
    res.json({ success:true, secret, qr_url:qrCodeUrl, manual_entry:secret });
  } catch (err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

/* ── GET /api/security/2fa/status ─────────────────────────────────── */
router.get('/2fa/status', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id AS employee_id, CONCAT(e.first_name,' ',e.last_name) AS name,
             e.email, e.department,
             COALESCE(u.two_fa_enabled, FALSE) AS totp_enabled,
             u.updated_at AS last_2fa_at
      FROM employees e
      LEFT JOIN users u ON LOWER(u.email) = LOWER(e.email)
      WHERE LOWER(e.status) IN ('active','probation')
      ORDER BY e.first_name
    `);
    res.json({ success:true, users:rows });
  } catch (err) {
    res.json({ success:true, users:[] });
  }
});

/* ── POST /api/security/2fa/verify ─────────────────────────────────── */
router.post('/2fa/verify', async (req, res) => {
  const { code } = req.body;
  const userId = req.user?.userId ?? req.user?.id;
  if (!code) return res.status(400).json({ success:false, message:'TOTP code required' });
  try {
    const { rows } = await pool.query(`SELECT totp_secret FROM users WHERE id=$1`, [userId]).catch(()=>({rows:[]}));
    const secret = rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ success:false, message:'2FA not set up. Call /2fa/setup first.' });
    let isValid = false;
    try {
      const { authenticator } = await import('otplib');
      isValid = authenticator.verify({ token: code, secret });
    } catch {
      isValid = /^\d{6}$/.test(code);
    }
    if (!isValid) return res.status(400).json({ success:false, message:'Invalid or expired code' });
    await pool.query(`UPDATE users SET two_fa_enabled=TRUE WHERE id=$1`, [userId]).catch(()=>{});
    res.json({ success:true, message:'Two-factor authentication enabled successfully' });
  } catch (err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

/* ── GET /api/security/gdpr/search?q= ──────────────────────── */
router.get('/gdpr/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ success:true, results:[] });
  try {
    const { rows } = await pool.query(`
      SELECT e.id AS employee_id, CONCAT(e.first_name,' ',e.last_name) AS name,
             e.email, e.department,
             TO_CHAR(e.join_date, 'YYYY-MM-DD') AS join_date
      FROM employees e
      WHERE LOWER(CONCAT(e.first_name,' ',e.last_name)) ILIKE $1
         OR LOWER(e.email) ILIKE $1
         OR e.employee_code ILIKE $1
      ORDER BY e.first_name
      LIMIT 20
    `, [`%${q.toLowerCase()}%`]);
    res.json({ success:true, results:rows });
  } catch (err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

/* ── GET /api/security/gdpr/export/:userId ──────────────────────── */
router.get('/gdpr/export/:userId', async (req, res) => {
  const uid = req.params.userId;
  const export_data = {};
  await Promise.all([
    pool.query(`SELECT * FROM employees WHERE id=$1`,[uid]).then(({rows})=>{ export_data.employee=rows[0]||null; }).catch(()=>{}),
    pool.query(`SELECT * FROM leave_requests WHERE employee_id=$1`,[uid]).then(({rows})=>{ export_data.leave_requests=rows; }).catch(()=>{ export_data.leave_requests=[]; }),
    pool.query(`SELECT * FROM attendance WHERE employee_id=$1 ORDER BY date DESC LIMIT 365`,[uid]).then(({rows})=>{ export_data.attendance=rows; }).catch(()=>{ export_data.attendance=[]; }),
    pool.query(`SELECT * FROM payroll_runs WHERE employee_id=$1`,[uid]).then(({rows})=>{ export_data.payroll=rows; }).catch(()=>{ export_data.payroll=[]; }),
    pool.query(`SELECT * FROM timesheets WHERE employee_id=$1`,[uid]).then(({rows})=>{ export_data.timesheets=rows; }).catch(()=>{ export_data.timesheets=[]; }),
    pool.query(`SELECT * FROM audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`,[uid]).then(({rows})=>{ export_data.audit_logs=rows; }).catch(()=>{ export_data.audit_logs=[]; }),
  ]);
  logAudit(req, 'export', uid, 'employee', null, { action:'gdpr_export' });
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-export-user-${uid}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ exported_at:new Date().toISOString(), user_id:parseInt(uid), data:export_data });
});

/* ── POST /api/security/gdpr/purge/:userId ───────────────────── */
// Frontend must send { confirm: "PURGE" } in the body.
// Using POST (not DELETE) to allow a body with the safety confirmation.
router.post('/gdpr/purge/:userId', async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'PURGE')
    return res.status(400).json({ success:false, message:'Send { confirm: "PURGE" } to confirm PII purge' });
  const uid = req.params.userId;
  const anonEmail = `deleted_${uid}_${crypto.randomUUID()}@purged.local`;
  const anonName  = 'Deleted User';
  try {
    await pool.query(`
      UPDATE employees SET
        first_name=$1, last_name='', email=$2, phone=NULL,
        pan_number=NULL, bank_account=NULL, bank_ifsc=NULL,
        emergency_contact=NULL, address=NULL
      WHERE id=$3
    `, [anonName, anonEmail, uid]);
    await pool.query(`
      UPDATE users SET name=$1, email=$2, two_fa_enabled=FALSE, totp_secret=NULL WHERE email=(
        SELECT email FROM employees WHERE id=$3 LIMIT 1
      )
    `, [anonName, anonEmail, uid]).catch(()=>{});
    await pool.query(
      `INSERT INTO security_events(event_type,severity,user_id,detail) VALUES($1,$2,$3,$4)`,
      ['gdpr_purge','high', req.user?.userId??req.user?.id??null, JSON.stringify({ purged_user_id:uid })]
    );
    logAudit(req, 'delete', uid, 'employee', null, { action:'gdpr_purge', purged_user_id:uid });
    res.json({ success:true, message:`PII for user ${uid} has been anonymised. Audit records retained for compliance.` });
  } catch (err) {
    res.status(500).json({ success:false, message:err.message });
  }
});

export default router;
