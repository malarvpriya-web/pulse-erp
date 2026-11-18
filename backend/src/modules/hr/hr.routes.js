import { Router } from 'express';
import { verifyToken, requirePermission, permissionFor, can, rolesOf } from '../../middlewares/auth.middleware.js';
import { validateDocumentUrl } from '../../home/documentDownload.js';
import pool from '../shared/db.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { EXIT_STATUS, isCurrentSql } from '../../shared/employeeStatus.js';
import { companyOf, employeeOf } from '../../shared/scope.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { offboardingTemplates } from './exitChecklist.js';

const router = Router();

// â”€â”€ DOWNLOADS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Which audiences of HR Documents the caller sees. Every role held counts
// (HR audit 2026-11-16, B4: this read the single req.user.role, so hr_manager
// and hr_exec saw only 'all'). hr:view → every audience; a manager or
// department head → 'all' + 'managers'; everyone else → 'all'.
async function visibleToClause(req) {
  if (await can(req, 'hr', 'view')) return `'all','hr_only','managers'`;
  const roles = rolesOf(req);
  if (roles.some(r => ['manager', 'department_head', 'l2_approver'].includes(r))) return `'all','managers'`;
  return `'all'`;
}

/**
 * HR Documents are company forms: every endpoint needs a concrete company.
 * A login without one used to read, edit and delete EVERY company's rows
 * through `($1::int IS NULL OR company_id = $1)`, and to create rows with no
 * company at all. Now it is refused before any SQL runs (§208).
 */
function downloadsCompany(req, res) {
  const cid = companyOf(req);
  if (cid == null) {
    res.status(403).json({ error: 'No company context for this login' });
    return null;
  }
  return cid;
}

// Readable by every signed-in user of the company (HR audit 2026-11-16):
// employees could not reach a single company form (403). What each sees is
// limited by the document's audience (visible_to); writing still needs hr.
router.get('/downloads', async (req, res) => {
  try {
    const cid = downloadsCompany(req, res);
    if (cid == null) return;
    const { search = '', category = '' } = req.query;
    const allowed = await visibleToClause(req);
    const r = await pool.query(
      `SELECT * FROM hr_downloads
        WHERE company_id = $1
          AND COALESCE(visible_to,'all') IN (${allowed})
          AND ($2 = '' OR LOWER(category) = LOWER($2))
          AND ($3 = '' OR LOWER(title) ILIKE '%' || LOWER($3) || '%'
                       OR LOWER(description) ILIKE '%' || LOWER($3) || '%')
        ORDER BY created_at DESC`,
      [cid, category, search]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/downloads', requirePermission('hr', 'add'), async (req, res) => {
  try {
    const cid = downloadsCompany(req, res);
    if (cid == null) return;
    const { title, category, description, file_url, file_type, visible_to } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!file_url?.trim()) return res.status(400).json({ error: 'file_url is required' });
    // created_by references employees(id). It used to receive the users.id,
    // which failed the FK or credited whichever employee shared the number
    // (§208). The uploader must be an employee of the company being written to.
    const empId = await employeeOf(req, pool);
    const { rows: [emp] } = empId == null ? { rows: [] } : await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND company_id = $2`, [empId, cid]);
    if (!emp) return res.status(403).json({ error: 'No employee record is linked to this account' });
    const r = await pool.query(
      `INSERT INTO hr_downloads (company_id, title, category, description, file_url, file_type, visible_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, title.trim(), category || 'General', description || '', file_url.trim(),
       file_type || null, visible_to || 'all', emp.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/downloads/:id', requirePermission('hr', 'edit'), captureBefore('hr_downloads'), async (req, res) => {
  try {
    const cid = downloadsCompany(req, res);
    if (cid == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { title, category, description, file_url, file_type, visible_to } = req.body;
    const r = await pool.query(
      `UPDATE hr_downloads SET
         title       = COALESCE($1, title),
         category    = COALESCE($2, category),
         description = COALESCE($3, description),
         file_url    = COALESCE($4, file_url),
         file_type   = COALESCE($5, file_type),
         visible_to  = COALESCE($6, visible_to)
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [title?.trim() || null, category || null, description?.trim() || null,
       file_url?.trim() || null, file_type || null, visible_to || null, id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/downloads/:id/increment', requirePermission('hr', 'view'), captureBefore('hr_downloads'), async (req, res) => {
  try {
    const cid = downloadsCompany(req, res);
    if (cid == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `UPDATE hr_downloads SET download_count = COALESCE(download_count,0) + 1
        WHERE id=$1 AND company_id = $2 RETURNING id`,
      [id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/downloads/:id', requirePermission('hr', 'delete'), captureBefore('hr_downloads'), async (req, res) => {
  try {
    const cid = downloadsCompany(req, res);
    if (cid == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `DELETE FROM hr_downloads WHERE id=$1 AND company_id = $2 RETURNING id`,
      [id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POLICIES ──────────────────────────────────────────────────────────────────

// Containment C5 (HR_P0_REMEDIATION_DESIGN_2026-11-03.md, P0-5).
// hr_policy_acknowledgements.employee_id is an EMPLOYEES id — the register
// joins it to employees. Both routes below used the login's users.id (and
// acknowledge took any employee_id from the request body), so an acknowledgement
// was credited to whichever employee happened to share that number, and anyone
// could file one for anyone. The acknowledging person is now always the caller's
// own employee record in the caller's company; the body is never read for it.
async function ownEmployeeInCompany(req) {
  const cid = companyOf(req);
  if (cid == null) return { status: 403, error: 'No company context for this login' };
  const empId = await employeeOf(req, pool);
  const { rows: [emp] } = empId == null ? { rows: [] } : await pool.query(
    `SELECT id FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [empId, cid]);
  if (!emp) return { status: 403, error: 'No employee record is linked to this account' };
  return { cid, employeeId: emp.id };
}

// Must be registered before /:id routes to avoid conflict
// No requirePermission — any authenticated employee reads/acknowledges policies
router.get('/policies/my-acknowledgements', async (req, res) => {
  try {
    // A login with no employee of its own has acknowledged nothing.
    const me = await ownEmployeeInCompany(req);
    if (me.error) return res.json([]);
    const employeeId = me.employeeId;
    const r = await pool.query(
      // Only an acknowledgement of the policy's CURRENT version counts (B6):
      // a new version asks again.
      `SELECT a.policy_id FROM hr_policy_acknowledgements a
         JOIN hr_policies p ON p.id = a.policy_id AND a.policy_version IS NOT DISTINCT FROM p.version
        WHERE a.employee_id = $1`,
      [employeeId]
    );
    res.json(r.rows.map(row => row.policy_id));
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/policies/acknowledgement-counts', requirePermission('hr', 'view'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const [acksResult, totalResult] = await Promise.all([
      pool.query(
        `SELECT pa.policy_id, COUNT(*) AS ack_count
         FROM hr_policy_acknowledgements pa
         JOIN hr_policies p ON p.id = pa.policy_id AND pa.policy_version IS NOT DISTINCT FROM p.version
         JOIN employees e ON e.id = pa.employee_id AND e.deleted_at IS NULL AND ${isCurrentSql('e.status')}
                         AND ($1::int IS NULL OR e.company_id = $1)
         WHERE ($1::int IS NULL OR p.company_id = $1 OR p.company_id IS NULL)
         GROUP BY pa.policy_id`,
        [cid]
      ),
      pool.query(
        // Everyone still employed (active, probation, notice), not deleted.
        `SELECT COUNT(*) AS total FROM employees
         WHERE deleted_at IS NULL AND ${isCurrentSql('status')} AND ($1::int IS NULL OR company_id = $1)`,
        [cid]
      ),
    ]);
    const total = parseInt(totalResult.rows[0]?.total || 0, 10);
    const counts = {};
    acksResult.rows.forEach(row => {
      counts[row.policy_id] = { acknowledged: parseInt(row.ack_count, 10), total };
    });
    res.json({ counts, total_employees: total });
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json({ counts: {}, total_employees: 0 });
    res.status(500).json({ error: e.message });
  }
});

// Policy audience. 'all' = company-wide and employee-facing (also shown on
// Home); 'internal' = HR/admin SOPs that stay inside this module. Anything
// unrecognised is stored as 'internal': failing closed hides a document,
// failing open publishes one.
const POLICY_AUDIENCES = new Set(['all', 'internal']);
const policyAudience = (v) => (v == null || v === '' ? null : POLICY_AUDIENCES.has(v) ? v : 'internal');

// All authenticated employees can read company-wide, active policies. Internal
// and retired ones are visible only to holders of hr:view (HR, payroll, admin).
router.get('/policies', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const hrView = (await permissionFor(req, 'hr'))?.can_view === true;
    const r = await pool.query(
      `SELECT * FROM hr_policies
       WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
         AND ($2::boolean OR (is_active AND applicable_to = 'all'))
       ORDER BY created_at DESC`,
      [cid, hrView]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/policies', requirePermission('hr', 'add'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, name, category, description, file_url, drive_url,
            version, effective_date, review_date, requires_acknowledgement,
            applicable_to, is_active } = req.body;
    const policyTitle = title || name;
    if (!policyTitle) return res.status(400).json({ error: 'title is required' });
    if (file_url) {
      const urlError = validateDocumentUrl(file_url);
      if (urlError) return res.status(400).json({ error: urlError });
    }
    // If the submitted URL is a Drive link, store it in drive_url too
    const resolvedDriveUrl = drive_url || (file_url?.includes('drive.google.com') ? file_url : null);
    const r = await pool.query(
      `INSERT INTO hr_policies
         (company_id, title, category, description, file_url, drive_url, version,
          effective_date, review_date, requires_acknowledgement, created_by,
          applicable_to, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [cid, policyTitle, category || 'General', description || '',
       file_url || null, resolvedDriveUrl || null,
       version || 'v1.0', effective_date || null, review_date || null,
       !!requires_acknowledgement, req.user?.userId || null,
       policyAudience(applicable_to) ?? 'all', is_active === undefined ? true : !!is_active]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/policies/:id', requirePermission('hr', 'edit'), captureBefore('hr_policies'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, name, category, description, file_url, drive_url,
            version, effective_date, review_date, requires_acknowledgement,
            applicable_to, is_active } = req.body;
    const policyTitle = title || name;
    if (file_url) {
      const urlError = validateDocumentUrl(file_url);
      if (urlError) return res.status(400).json({ error: urlError });
    }
    const resolvedDriveUrl = drive_url || (file_url?.includes('drive.google.com') ? file_url : null);
    // A new file_url replaces drive_url as well: keeping the old Drive copy
    // under COALESCE left readers that prefer drive_url on the previous file.
    const r = await pool.query(
      `UPDATE hr_policies SET
         title=COALESCE($1,title), category=COALESCE($2,category),
         description=COALESCE($3,description), file_url=COALESCE($4::text,file_url),
         drive_url=CASE WHEN $4::text IS NOT NULL THEN $5::text ELSE COALESCE($5::text,drive_url) END,
         version=COALESCE($6,version),
         effective_date=COALESCE($7,effective_date), review_date=COALESCE($8,review_date),
         requires_acknowledgement=COALESCE($9,requires_acknowledgement),
         applicable_to=COALESCE($12,applicable_to), is_active=COALESCE($13,is_active),
         updated_at=NOW()
       WHERE id=$10 AND ($11::int IS NULL OR company_id = $11 OR company_id IS NULL)
       RETURNING *`,
      [policyTitle || null, category || null, description || null, file_url || null,
       resolvedDriveUrl || null, version || null, effective_date || null, review_date || null,
       requires_acknowledgement !== undefined ? !!requires_acknowledgement : null, id, cid,
       policyAudience(applicable_to), is_active === undefined || is_active === null ? null : !!is_active]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Policy not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/policies/:id', requirePermission('hr', 'delete'), captureBefore('hr_policies'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid policy id' });
    await pool.query(
      `DELETE FROM hr_policies WHERE id=$1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [id, cid]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any authenticated employee can acknowledge a policy — for themself only (C5).
router.post('/policies/:id/acknowledge', async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const me = await ownEmployeeInCompany(req);
    if (me.error) return res.status(me.status).json({ error: me.error });
    const employeeId = me.employeeId;
    // The same policies GET /policies shows this company: its own and global ones.
    const { rows: [policy] } = await pool.query(
      `SELECT id, is_active, version FROM hr_policies WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
      [policyId, me.cid]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (policy.is_active === false) return res.status(409).json({ error: 'This policy has been retired and can no longer be acknowledged' });
    // DO NOTHING — acknowledgements are immutable; the first timestamp for a
    // version is the legal record. Each version is acknowledged separately (B6).
    const r = await pool.query(
      `INSERT INTO hr_policy_acknowledgements (policy_id, employee_id, ip_address, policy_version)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (policy_id, employee_id, policy_version) DO NOTHING
       RETURNING *`,
      [policyId, employeeId, req.ip || null, policy.version ?? null]
    );
    res.json(r.rows[0] || { policy_id: policyId, employee_id: employeeId, already_acknowledged: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/policies/:id/acknowledgements', requirePermission('hr', 'view'), async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const r = await pool.query(
      // Every version's acknowledgements, newest first; is_current marks the
      // ones that count for the version in force (B6). Company-scoped.
      `SELECT a.*, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              (a.policy_version IS NOT DISTINCT FROM p.version) AS is_current
       FROM hr_policy_acknowledgements a
       JOIN hr_policies p ON p.id = a.policy_id
       JOIN employees e ON e.id = a.employee_id AND ($2::int IS NULL OR e.company_id = $2)
       WHERE a.policy_id=$1 AND ($2::int IS NULL OR p.company_id = $2 OR p.company_id IS NULL)
       ORDER BY a.acknowledged_at DESC`,
      [policyId, companyOf(req)]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/policies/:id/send-reminder', requirePermission('hr', 'edit'), async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  // HR audit 2026-11-16: this was a stub ("Reminder queued", nothing sent) and
  // counted active employees of EVERY company. It now notifies the caller's
  // company's current staff who have not accepted the CURRENT version (B6).
  const cid = companyOf(req);
  try {
    const { rows: [policy] } = await pool.query(
      `SELECT id, title, version, is_active, applicable_to, COALESCE(requires_acknowledgement, false) AS ack
         FROM hr_policies WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [policyId, cid]);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (policy.is_active === false) return res.status(409).json({ error: 'This policy is retired; there is nothing to acknowledge.' });
    if (!policy.ack) return res.status(409).json({ error: 'This policy does not ask for an acknowledgement.' });
    if (policy.applicable_to === 'internal') {
      return res.status(409).json({ error: 'This policy is internal (HR and admin only), so employees cannot see it to acknowledge it.' });
    }
    const { rows } = await pool.query(
      `SELECT e.id FROM employees e
        WHERE e.deleted_at IS NULL AND ${isCurrentSql('e.status')}
          AND ($2::int IS NULL OR e.company_id = $2)
          AND NOT EXISTS (SELECT 1 FROM hr_policy_acknowledgements a
                           WHERE a.policy_id = $1 AND a.employee_id = e.id
                             AND a.policy_version IS NOT DISTINCT FROM $3)`,
      [policyId, cid, policy.version ?? null]);
    const pendingCount = rows.length;
    if (pendingCount) {
      notifyWorkflowEvent('policy_ack_reminder', {
        module: 'Policies', recordId: policy.id, recipientIds: rows.map(r => r.id),
        context: { title: policy.title, version: policy.version },
      });
    }
    res.json({
      success: true, pending_count: pendingCount,
      message: pendingCount
        ? `Reminder sent to ${pendingCount} employee(s) who have not acknowledged this version. Those without a Pulse login get nothing.`
        : 'Everyone has acknowledged the current version.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// â”€â”€ helper: normalise a db row to the shape the frontend expects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function normaliseShift(row) {
  let weeklyOff = row.weekly_off;
  if (typeof weeklyOff === 'string') {
    try { weeklyOff = JSON.parse(weeklyOff); } catch { weeklyOff = []; }
  }
  let roleGrace = row.role_grace_minutes;
  if (typeof roleGrace === 'string') {
    try { roleGrace = JSON.parse(roleGrace); } catch { roleGrace = {}; }
  }
  const resolvedOff = Array.isArray(weeklyOff) ? weeklyOff : ['Sat', 'Sun'];
  return {
    ...row,
    start:                row.start_time,
    end:                  row.end_time,
    weekly_off:           resolvedOff,
    weekly_off_days:      resolvedOff,
    departments:          Array.isArray(row.departments) ? row.departments : (row.departments ?? []),
    night_shift_allowance: !!row.is_night_shift,
    role_grace_minutes:   roleGrace || {},
    half_day_hours:       row.half_day_hours ?? 4,
    break_duration:       row.break_duration ?? 30,
    employees_count:      row.employees_count ?? 0,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateShiftBody({ name, start, end, grace_minutes }) {
  if (!name?.trim())           return 'name is required';
  if (!start || !TIME_RE.test(start)) return 'start must be a valid HH:MM time';
  if (!end   || !TIME_RE.test(end))   return 'end must be a valid HH:MM time';
  const grace = Number(grace_minutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120)
    return 'grace_minutes must be an integer between 0 and 120';
  return null;
}

function isValidDateString(v) {
  return !v || (typeof v === 'string' && DATE_RE.test(v));
}

// â”€â”€ SHIFTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/shifts', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const r = await pool.query(`
      SELECT s.id, s.name,
             s.start_time, s.end_time,
             s.grace_minutes, s.color, s.departments, s.weekly_off,
             s.break_duration, s.is_night_shift, s.ot_eligible, s.capacity,
             s.half_day_hours, s.role_grace_minutes,
             COUNT(DISTINCT sa.employee_id) FILTER (WHERE sa.is_active = TRUE) AS employees_count
        FROM hr_shifts s
        LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id
       WHERE (s.deleted_at IS NULL OR s.deleted_at > NOW())
         AND ($1::int IS NULL OR s.company_id = $1 OR s.company_id IS NULL)
       GROUP BY s.id
       ORDER BY s.name ASC
    `, [cid]);
    res.json(r.rows.map(normaliseShift));
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shifts', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const {
    name, start, end, grace_minutes = 15, color = '#6366f1', departments = [],
    weekly_off_days, weekly_off,
    night_shift_allowance, is_night_shift,
    break_duration = 30, half_day_hours = 4,
    role_grace_minutes = {}, ot_eligible = true, capacity = 0,
  } = req.body;
  const err = validateShiftBody({ name, start, end, grace_minutes });
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(departments))
    return res.status(400).json({ error: 'departments must be an array' });
  const cid = req.scope?.company_id ?? null;
  const resolvedOff    = weekly_off_days || weekly_off || ['Sat', 'Sun'];
  const resolvedNight  = night_shift_allowance ?? is_night_shift ?? false;
  try {
    const r = await pool.query(
      `INSERT INTO hr_shifts
         (name, start_time, end_time, grace_minutes, color, departments,
          weekly_off, is_night_shift, break_duration, half_day_hours,
          role_grace_minutes, ot_eligible, capacity, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [name.trim(), start, end, Number(grace_minutes), color, JSON.stringify(departments),
       JSON.stringify(Array.isArray(resolvedOff) ? resolvedOff : ['Sat', 'Sun']),
       !!resolvedNight, Number(break_duration) || 30, Number(half_day_hours) || 4,
       JSON.stringify(role_grace_minutes || {}), !!ot_eligible, Number(capacity) || 0, cid]
    );
    res.status(201).json(normaliseShift(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/shifts/:id', verifyToken, requirePermission('hr', 'edit'), captureBefore('hr_shifts'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid shift id' });
  const {
    name, start, end, grace_minutes = 15, color = '#6366f1', departments = [],
    weekly_off_days, weekly_off,
    night_shift_allowance, is_night_shift,
    break_duration = 30, half_day_hours = 4,
    role_grace_minutes = {}, ot_eligible = true, capacity = 0,
  } = req.body;
  const err = validateShiftBody({ name, start, end, grace_minutes });
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(departments))
    return res.status(400).json({ error: 'departments must be an array' });
  const cid = req.scope?.company_id ?? null;
  const resolvedOff   = weekly_off_days || weekly_off || ['Sat', 'Sun'];
  const resolvedNight = night_shift_allowance ?? is_night_shift ?? false;
  try {
    const r = await pool.query(
      `UPDATE hr_shifts
          SET name=$1, start_time=$2, end_time=$3,
              grace_minutes=$4, color=$5, departments=$6,
              weekly_off=$7, is_night_shift=$8, break_duration=$9,
              half_day_hours=$10, role_grace_minutes=$11,
              ot_eligible=$12, capacity=$13
        WHERE id=$14
          AND ($15::int IS NULL OR company_id = $15 OR company_id IS NULL)
        RETURNING *`,
      [name.trim(), start, end, Number(grace_minutes), color,
       JSON.stringify(departments),
       JSON.stringify(Array.isArray(resolvedOff) ? resolvedOff : ['Sat', 'Sun']),
       !!resolvedNight, Number(break_duration) || 30, Number(half_day_hours) || 4,
       JSON.stringify(role_grace_minutes || {}), !!ot_eligible, Number(capacity) || 0, id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json(normaliseShift(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shifts/:id', verifyToken, requirePermission('hr', 'delete'), captureBefore('hr_shifts'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid shift id' });
  const cid = req.scope?.company_id ?? null;
  try {
    // Guard: refuse if employees are still actively assigned to this shift
    const assigned = await pool.query(
      'SELECT COUNT(*) AS cnt FROM hr_shift_assignments WHERE shift_id=$1 AND is_active=TRUE',
      [id]
    );
    if (parseInt(assigned.rows[0]?.cnt || 0) > 0)
      return res.status(400).json({ error: 'Cannot delete shift while employees are assigned. Remove all assignments first.' });
    // Soft-delete so audit history is preserved
    const r = await pool.query(
      `UPDATE hr_shifts SET deleted_at=NOW()
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       RETURNING id`,
      [id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€ OFFBOARDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns employees in a resignation/notice/termination state, joined with
// any open exit_requests row so we have a reliable last_working_date and reason
// even when the employees.exit_date column has not been populated.
router.get('/offboarding', verifyToken, requirePermission('exit', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = companyId != null ? [companyId] : [];
    const cidClause = companyId != null ? `AND e.company_id = $1` : '';
    const r = await pool.query(`
      SELECT
        e.id,
        COALESCE(e.office_id::text, e.id::text)                             AS employee_id,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.department,
        e.designation,
        e.status,
        COALESCE(er.last_working_date, e.exit_date)                         AS exit_date,
        COALESCE(er.last_working_date, e.exit_date)                         AS last_day,
        COALESCE(er.reason, e.exit_reason)                                  AS exit_reason,
        COALESCE(
          (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE p.done = TRUE) / NULLIF(COUNT(*), 0))
           FROM hr_offboarding_checklist_progress p WHERE p.employee_id = e.id),
          0
        )::int                                                               AS checklist_pct
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT * FROM exit_requests
        WHERE employee_id = e.id AND status NOT IN ('rejected','cancelled')
        ORDER BY created_at DESC LIMIT 1
      ) er ON true
      WHERE LOWER(e.status) IN ('resigned', 'terminated', 'notice', 'notice_period', 'notice period')
        AND e.deleted_at IS NULL   -- deleted (test/duplicate) records are not offboarding cases
        ${cidClause}
      ORDER BY COALESCE(er.last_working_date, e.exit_date) DESC NULLS LAST
      LIMIT 100
    `, params);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/shift-assignments', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const r = await pool.query(`
      SELECT a.*
      FROM hr_shift_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.is_active = TRUE
        AND ($1::int IS NULL OR e.company_id = $1)
      ORDER BY a.created_at DESC
    `, [cid]);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-assignments', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { employee_id, shift_id, effective_from = null, note = '' } = req.body || {};
  const employeeId = Number(employee_id);
  const shiftId = Number(shift_id);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'employee_id must be a valid integer' });
  if (!Number.isInteger(shiftId) || shiftId < 1) return res.status(400).json({ error: 'shift_id must be a valid integer' });
  if (!isValidDateString(effective_from)) return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' });
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, note, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [employeeId, shiftId, effective_from, String(note || ''), req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-assignments/:id', verifyToken, requirePermission('hr', 'delete'), captureBefore('hr_shift_assignments'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid assignment id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_assignments
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
      RETURNING id`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift assignment not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/shift-rotations', verifyToken, requirePermission('hr', 'view'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*
      FROM hr_shift_rotations r
      WHERE r.is_active = TRUE
      ORDER BY r.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-rotations', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { team, week_1_shift_id, week_2_shift_id, effective_from = null } = req.body || {};
  const week1 = Number(week_1_shift_id);
  const week2 = Number(week_2_shift_id);
  if (!team?.trim()) return res.status(400).json({ error: 'team is required' });
  if (!Number.isInteger(week1) || week1 < 1) return res.status(400).json({ error: 'week_1_shift_id must be a valid integer' });
  if (!Number.isInteger(week2) || week2 < 1) return res.status(400).json({ error: 'week_2_shift_id must be a valid integer' });
  if (week1 === week2) return res.status(400).json({ error: 'week_1_shift_id and week_2_shift_id must be different' });
  if (!isValidDateString(effective_from)) return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' });
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_rotations (team, week_1_shift_id, week_2_shift_id, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [team.trim(), week1, week2, effective_from, req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-rotations/:id', verifyToken, requirePermission('hr', 'delete'), captureBefore('hr_shift_rotations'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid rotation id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_rotations
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
      RETURNING id`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift rotation not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── SHIFT DATE OVERRIDES ──────────────────────────────────────────────────────
router.get('/shift-overrides', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { employee_id, from_date, to_date } = req.query;
    let q = `
      SELECT o.*, s.name AS shift_name, s.start_time, s.end_time, s.color,
             TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
        FROM hr_shift_date_overrides o
        JOIN hr_shifts s ON s.id = o.shift_id
        JOIN employees e ON e.id = o.employee_id
       WHERE o.is_active = TRUE
         AND ($1::int IS NULL OR o.company_id = $1 OR o.company_id IS NULL)
    `;
    const params = [cid];
    let n = 2;
    if (employee_id) { q += ` AND o.employee_id = $${n++}`; params.push(employee_id); }
    if (from_date)   { q += ` AND o.override_date >= $${n++}`; params.push(from_date); }
    if (to_date)     { q += ` AND o.override_date <= $${n++}`; params.push(to_date); }
    q += ' ORDER BY o.override_date DESC LIMIT 200';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-overrides', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { employee_id, shift_id, override_date, reason = '' } = req.body || {};
  const empId   = Number(employee_id);
  const shiftId = Number(shift_id);
  if (!Number.isInteger(empId)   || empId < 1)   return res.status(400).json({ error: 'employee_id must be a valid integer' });
  if (!Number.isInteger(shiftId) || shiftId < 1)  return res.status(400).json({ error: 'shift_id must be a valid integer' });
  if (!override_date || !/^\d{4}-\d{2}-\d{2}$/.test(override_date))
    return res.status(400).json({ error: 'override_date must be YYYY-MM-DD' });
  const cid = req.scope?.company_id ?? null;
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_date_overrides
         (employee_id, shift_id, override_date, reason, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (employee_id, override_date)
       DO UPDATE SET shift_id=$2, reason=$4, is_active=TRUE, created_by=$6
       RETURNING *`,
      [empId, shiftId, override_date, String(reason || ''), cid, req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-overrides/:id', verifyToken, requirePermission('hr', 'delete'), captureBefore('hr_shift_date_overrides'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid override id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_date_overrides SET is_active=FALSE WHERE id=$1 RETURNING id`, [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Override not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OFFBOARDING ───────────────────────────────────────────────────────────────
// The offboarding checklist is per company (HR audit 2026-11-16, B2;
// migration 20261116000003). A company with no checklist of its own uses the
// shared default (company_id NULL) until it saves one. Before this, every
// company read one global list and any company's save replaced it for all.
// offboardingTemplates() lives in exitChecklist.js: the payment gate reads the
// same list (one exit checklist, owner decision 2026-11-17).

// The employee whose checklist is read or written, in the caller's company and
// not deleted. A global caller (super admin with no company) may open any.
async function offboardingEmployee(db, employeeId, companyId) {
  const { rows: [emp] } = await db.query(
    `SELECT id, company_id FROM employees
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)`,
    [employeeId, companyId]);
  return emp || null;
}

router.get('/offboarding/templates', verifyToken, requirePermission('exit', 'view'), async (req, res) => {
  try {
    res.json(await offboardingTemplates(pool, companyOf(req)));
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.put('/offboarding/templates', verifyToken, requirePermission('exit', 'edit'), async (req, res) => {
  const rows = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rows.length) return res.status(400).json({ error: 'items array is required' });

  // Replaces the whole active template set — every current row is deactivated
  // and the body written in its place. There is no :id here at all, so the
  // before-image is the active set itself; without it, "what did the standard
  // exit checklist require last quarter" has no answer.
  // Only the caller's company's checklist is replaced (B2). A global caller
  // with no company edits the shared default (company_id NULL).
  const companyId = companyOf(req);
  try {
    // The before-image is what the company was using: its own list, or the
    // shared default when it had none yet.
    req._auditBefore = { company_id: companyId, templates: await offboardingTemplates(pool, companyId) };
  } catch { /* no before-image is a worse audit entry; a 500 is a worse product */ }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE hr_offboarding_checklist_templates SET is_active = FALSE, updated_at = NOW()
        WHERE is_active = TRUE AND company_id IS NOT DISTINCT FROM $1::int`, [companyId]);
    let order = 0;
    for (const it of rows) {
      const category = String(it.category || '').trim();
      const itemLabel = String(it.item_label || it.item || '').trim();
      if (!category || !itemLabel) continue;
      const defaultAssignee = String(it.default_assignee || 'HR').trim() || 'HR';
      const defaultOffsetDays = Number.isInteger(Number(it.default_offset_days)) ? Number(it.default_offset_days) : 0;
      await client.query(
        `INSERT INTO hr_offboarding_checklist_templates
          (category, item_label, default_assignee, default_offset_days, sort_order, is_active, updated_at, company_id)
         VALUES ($1,$2,$3,$4,$5,TRUE,NOW(),$6::int)
         ON CONFLICT (company_id, category, item_label)
         DO UPDATE SET
           default_assignee = EXCLUDED.default_assignee,
           default_offset_days = EXCLUDED.default_offset_days,
           sort_order = EXCLUDED.sort_order,
           is_active = TRUE,
           updated_at = NOW()`,
        [category, itemLabel, defaultAssignee, defaultOffsetDays, order++, companyId]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/offboarding/:employeeId/checklist', verifyToken, requirePermission('exit', 'view'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    // Scoped by the employee's company (B2): this read another company's
    // employee's checklist by id alone.
    const emp = await offboardingEmployee(pool, employeeId, companyOf(req));
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const t = { rows: await offboardingTemplates(pool, emp.company_id) };

    const p = await pool.query(`
      SELECT category, item_label, done, assignee, due_date, handover_notes, completed_at
      FROM hr_offboarding_checklist_progress
      WHERE employee_id = $1
    `, [employeeId]);

    const progressMap = new Map(p.rows.map(x => [`${x.category}__${x.item_label}`, x]));
    const merged = t.rows.map((row) => {
      const key = `${row.category}__${row.item_label}`;
      const pg = progressMap.get(key);
      return {
        category: row.category,
        item_label: row.item_label,
        done: !!pg?.done,
        assignee: pg?.assignee || row.default_assignee || 'HR',
        due_date: pg?.due_date || null,
        handover_notes: pg?.handover_notes || '',
        completed_at: pg?.completed_at || null,
      };
    });

    res.json(merged);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/offboarding/:employeeId/checklist', verifyToken, requirePermission('exit', 'edit'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const rows = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  if (!rows.length) return res.status(400).json({ error: 'items array is required' });
  // Same scope as the read (B2): writes used to key on the URL's id alone.
  try {
    if (!await offboardingEmployee(pool, employeeId, companyOf(req))) {
      return res.status(404).json({ error: 'Employee not found' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // This handler upserts MANY checklist rows in one request, so the before-image
  // is a SET, not a row — captureBefore() cannot express that. The whole of this
  // employee's prior checklist is snapshotted instead: it is what the exit
  // clearance was signed off against, and after the loop no copy of it survives.
  try {
    const { rows: prior } = await pool.query(
      `SELECT * FROM hr_offboarding_checklist_progress
        WHERE employee_id = $1 ORDER BY category, item_label`,
      [employeeId]
    );
    req._auditBefore = { employee_id: employeeId, checklist: prior };
  } catch { /* no before-image is a worse audit entry; a 500 is a worse product */ }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of rows) {
      const category = String(it.category || '').trim();
      const itemLabel = String(it.item_label || '').trim();
      if (!category || !itemLabel) continue;
      const done = !!it.done;
      const assignee = String(it.assignee || 'HR').trim() || 'HR';
      const dueDate = isValidDateString(it.due_date) ? it.due_date : null;
      const handoverNotes = String(it.handover_notes || '').trim();

      await client.query(
        `INSERT INTO hr_offboarding_checklist_progress
          (employee_id, category, item_label, done, assignee, due_date, handover_notes, completed_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (employee_id, category, item_label)
         DO UPDATE SET
           done = EXCLUDED.done,
           assignee = EXCLUDED.assignee,
           due_date = EXCLUDED.due_date,
           handover_notes = EXCLUDED.handover_notes,
           completed_at = EXCLUDED.completed_at,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [employeeId, category, itemLabel, done, assignee, dueDate, handoverNotes, done ? new Date().toISOString() : null, req.user?.userId || null]
      );
    }
    // Bridge: "Exit interview conducted" done → sync exit_requests.interview_done + exit_clearance
    const interviewDone = rows.some(
      (r) => r.done && /exit interview/i.test(String(r.item_label || ''))
    );
    if (interviewDone) {
      await client.query(
        `UPDATE exit_requests SET interview_done = TRUE
         WHERE employee_id = $1 AND status NOT IN ('rejected','cancelled')`,
        [employeeId]
      );
      await client.query(
        `INSERT INTO exit_clearance (employee_id, exit_interview_done)
         VALUES ($1, TRUE)
         ON CONFLICT (employee_id) DO UPDATE SET exit_interview_done = TRUE, updated_at = NOW()`,
        [employeeId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/offboarding/:employeeId/checklist/notify', verifyToken, requirePermission('exit', 'edit'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const assignee = String(req.body?.assignee || '').trim();
  if (!assignee) return res.status(400).json({ error: 'assignee is required' });
  // HR audit 2026-11-16: this was a stub that answered "Notification queued"
  // and sent nothing. An assignee is a department (its current head is told)
  // or the leaver's reporting manager ('Reporting manager'; legacy 'Manager').
  try {
    const emp = await offboardingEmployee(pool, employeeId, companyOf(req));
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const { rows: [leaver] } = await pool.query(
      `SELECT id, company_id, office_id, first_name, last_name, reporting_manager_id,
              (SELECT to_char(COALESCE(er.last_working_date, e.exit_date), 'DD Mon YY')
                 FROM exit_requests er WHERE er.employee_id = e.id AND er.status NOT IN ('rejected','cancelled')
                 ORDER BY er.created_at DESC LIMIT 1) AS last_day
         FROM employees e WHERE e.id = $1`, [employeeId]);
    const isManager = /^(reporting manager|manager)$/i.test(assignee);
    const { rows: who } = isManager
      ? await pool.query(
          `SELECT m.id FROM employees m
            WHERE m.id = $1 AND m.company_id = $2 AND m.deleted_at IS NULL AND ${isCurrentSql('m.status')}`,
          [leaver.reporting_manager_id, leaver.company_id])
      : await pool.query(
          `SELECT h.id FROM master_departments d
             JOIN department_heads dh ON dh.department_id = d.id AND dh.ended_at IS NULL AND dh.company_id = $2
             JOIN employees h ON h.id = dh.head_employee_id
            WHERE LOWER(BTRIM(d.name)) = LOWER(BTRIM($1)) AND d.is_active = true
              AND h.company_id = $2 AND h.deleted_at IS NULL AND ${isCurrentSql('h.status')}`,
          [assignee, leaver.company_id]);
    if (!who.length) {
      return res.status(409).json({
        code: 'NO_RECIPIENT',
        error: isManager
          ? 'This employee has no current reporting manager to notify.'
          : `No one heads "${assignee}". Assign a head in HR → Department Heads, or pick another assignee.`,
      });
    }
    const { rows: logins } = await pool.query(
      `SELECT id FROM users WHERE employee_id = ANY($1::int[]) AND is_active = true`, [who.map(w => w.id)]);
    if (!logins.length) {
      return res.status(409).json({ code: 'NO_LOGIN', error: `The person to notify for "${assignee}" has no active Pulse login, so nothing can be sent.` });
    }
    // The leaver's open items with this assignee.
    const templates = await offboardingTemplates(pool, leaver.company_id);
    const { rows: progress } = await pool.query(
      `SELECT category, item_label, done, assignee FROM hr_offboarding_checklist_progress WHERE employee_id = $1`, [employeeId]);
    const pg = new Map(progress.map(p => [`${p.category}__${p.item_label}`, p]));
    const items = templates
      .map(t => ({ t, p: pg.get(`${t.category}__${t.item_label}`) }))
      .filter(({ t, p }) => !p?.done && String(p?.assignee || t.default_assignee || 'HR').toLowerCase() === assignee.toLowerCase())
      .map(({ t }) => t.item_label);
    if (!items.length) return res.status(409).json({ code: 'NOTHING_OPEN', error: `${assignee} has no open items on this checklist.` });
    const label = [`${leaver.first_name || ''} ${leaver.last_name || ''}`.trim(), leaver.office_id && `(${leaver.office_id})`].filter(Boolean).join(' ');
    notifyWorkflowEvent('offboarding_items_assigned', {
      module: 'Offboarding', recordId: employeeId, recipientUserIds: logins.map(l => l.id),
      context: { employeeLabel: label, assignee, items, count: items.length, lastDay: leaver.last_day },
    });
    res.json({ success: true, notified: logins.length, items: items.length, employee_id: employeeId,
      message: `${logins.length === 1 ? 'Sent' : `Sent to ${logins.length} people`}: ${items.length} open item(s) for ${assignee}.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /offboarding/:employeeId/complete was removed (exit review 2026-11-17).
// No screen called it after "Mark complete" went (owner decision 2026-11-17):
// paying the F&F (POST /exit/fnf/:id/pay) closes the exit and sets Left.

export default router;


