// backend/src/modules/hr/certifications.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','hr_exec','HR','Admin','SuperAdmin','lnd_admin'];

function sc(companyId, alias = '') {
  const col = alias ? `${alias}.company_id` : 'company_id';
  return companyId != null ? ` AND (${col} IS NULL OR ${col}=${companyId})` : '';
}

/* ── GET /certifications/master ────────────────────────────── */
router.get('/master', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM certifications WHERE 1=1${sc(companyId)} ORDER BY category, name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /certifications/master ───────────────────────────── */
router.post('/master', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, code, issuing_body, category, validity_months = 12, is_mandatory = false, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO certifications (name,code,issuing_body,category,validity_months,is_mandatory,description,company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, code || null, issuing_body || null, category || null, validity_months, is_mandatory, description || null, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /certifications/master/:id ────────────────────────── */
router.put('/master/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, code, issuing_body, category, validity_months, is_mandatory, description } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE certifications SET
         name=COALESCE($1,name), code=COALESCE($2,code),
         issuing_body=COALESCE($3,issuing_body), category=COALESCE($4,category),
         validity_months=COALESCE($5,validity_months), is_mandatory=COALESCE($6,is_mandatory),
         description=COALESCE($7,description)
       WHERE id=$8 RETURNING *`,
      [name, code, issuing_body, category, validity_months, is_mandatory, description, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /certifications/master/:id ─────────────────────── */
router.delete('/master/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await pool.query(`DELETE FROM certifications WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /certifications/employee ──────────────────────────── */
router.get('/employee', async (req, res) => {
  const companyId = cid(req);
  const { employee_id, status, expiring_days } = req.query;
  let where = `WHERE 1=1${sc(companyId, 'ec')}`;
  if (employee_id)   where += ` AND ec.employee_id=${parseInt(employee_id)}`;
  if (status)        where += ` AND ec.status='${status.replace(/'/g,"''")}'`;
  if (expiring_days) where += ` AND ec.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+${parseInt(expiring_days)}`;
  try {
    const { rows } = await pool.query(`
      SELECT ec.*, c.name AS cert_name, c.issuing_body, c.category, c.validity_months,
             e.name AS employee_name, e.department, e.designation,
             (ec.expiry_date - CURRENT_DATE) AS days_until_expiry
      FROM   employee_certifications ec
      JOIN   certifications c ON c.id = ec.certification_id
      JOIN   employees e ON e.id = ec.employee_id
      ${where}
      ORDER  BY ec.expiry_date NULLS LAST, e.name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /certifications/employee ─────────────────────────── */
router.post('/employee', async (req, res) => {
  const {
    employee_id, certification_id, certificate_number,
    issue_date, expiry_date, renewal_date,
    certificate_url, issued_by, notes,
  } = req.body;
  if (!employee_id || !certification_id)
    return res.status(400).json({ error: 'employee_id and certification_id required' });
  const companyId = cid(req);
  try {
    // Auto-compute expiry if not provided
    let resolvedExpiry = expiry_date || null;
    if (!resolvedExpiry && issue_date) {
      const certRes = await pool.query(`SELECT validity_months FROM certifications WHERE id=$1`, [certification_id]);
      if (certRes.rows[0]?.validity_months) {
        resolvedExpiry = `(DATE '${issue_date}' + INTERVAL '${certRes.rows[0].validity_months} months')::DATE`;
        const exp = await pool.query(`SELECT ${resolvedExpiry} AS d`);
        resolvedExpiry = exp.rows[0].d;
      }
    }
    const { rows } = await pool.query(`
      INSERT INTO employee_certifications
        (employee_id,certification_id,certificate_number,issue_date,expiry_date,renewal_date,
         certificate_url,status,issued_by,notes,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10) RETURNING *`,
      [employee_id, certification_id, certificate_number || null, issue_date || null,
       resolvedExpiry, renewal_date || null, certificate_url || null,
       issued_by || null, notes || null, companyId]
    );
    // Sync to skill_matrix
    await pool.query(`
      INSERT INTO skill_matrix (employee_id, skill_name, category, proficiency_level, certified, certification_name, expiry_date, company_id)
      SELECT $1, c.name, c.category, 4, true, c.name, $3, $4
      FROM certifications c WHERE c.id=$2
      ON CONFLICT ON CONSTRAINT uq_skill_matrix_emp_skill DO UPDATE SET
        certified=true, certification_name=EXCLUDED.certification_name,
        expiry_date=EXCLUDED.expiry_date, last_assessed=CURRENT_DATE`,
      [employee_id, certification_id, resolvedExpiry, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /certifications/employee/:id ──────────────────────── */
router.put('/employee/:id', async (req, res) => {
  const { certificate_number, issue_date, expiry_date, renewal_date,
          certificate_url, status, issued_by, notes } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE employee_certifications SET
        certificate_number = COALESCE($1,certificate_number),
        issue_date         = COALESCE($2,issue_date),
        expiry_date        = COALESCE($3,expiry_date),
        renewal_date       = COALESCE($4,renewal_date),
        certificate_url    = COALESCE($5,certificate_url),
        status             = COALESCE($6,status),
        issued_by          = COALESCE($7,issued_by),
        notes              = COALESCE($8,notes)
      WHERE id=$9 RETURNING *`,
      [certificate_number, issue_date, expiry_date, renewal_date,
       certificate_url, status, issued_by, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /certifications/employee/:id ───────────────────── */
router.delete('/employee/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM employee_certifications WHERE id=$1 RETURNING id`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /certifications/expiry-dashboard ──────────────────── */
router.get('/expiry-dashboard', async (req, res) => {
  const companyId = cid(req);
  const sc2 = companyId != null ? ` AND ec.company_id=${companyId}` : '';
  try {
    const [exp30, exp60, exp90, expiredRes, activeRes] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) FROM employee_certifications ec WHERE status='active' AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30${sc2}`),
      pool.query(`SELECT COUNT(*) FROM employee_certifications ec WHERE status='active' AND expiry_date BETWEEN CURRENT_DATE+31 AND CURRENT_DATE+60${sc2}`),
      pool.query(`SELECT COUNT(*) FROM employee_certifications ec WHERE status='active' AND expiry_date BETWEEN CURRENT_DATE+61 AND CURRENT_DATE+90${sc2}`),
      pool.query(`SELECT COUNT(*) FROM employee_certifications ec WHERE status='expired'${sc2}`),
      pool.query(`SELECT COUNT(*) FROM employee_certifications ec WHERE status='active'${sc2}`),
    ]);
    res.json({
      expiring_30d:  parseInt(exp30.value?.rows[0]?.count   || 0),
      expiring_60d:  parseInt(exp60.value?.rows[0]?.count   || 0),
      expiring_90d:  parseInt(exp90.value?.rows[0]?.count   || 0),
      expired:       parseInt(expiredRes.value?.rows[0]?.count || 0),
      active:        parseInt(activeRes.value?.rows[0]?.count  || 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /certifications/employee/:id/renew ───────────────── */
router.post('/employee/:id/renew', async (req, res) => {
  const { new_expiry_date, certificate_url, notes } = req.body;
  if (!new_expiry_date) return res.status(400).json({ error: 'new_expiry_date required' });
  try {
    // Mark old as renewed
    await pool.query(
      `UPDATE employee_certifications SET status='renewed' WHERE id=$1`, [req.params.id]
    );
    // Fetch old record to clone
    const { rows: old } = await pool.query(`SELECT * FROM employee_certifications WHERE id=$1`, [req.params.id]);
    if (!old.length) return res.status(404).json({ error: 'Not found' });
    const o = old[0];
    const { rows } = await pool.query(`
      INSERT INTO employee_certifications
        (employee_id,certification_id,certificate_number,issue_date,expiry_date,
         certificate_url,status,issued_by,notes,company_id)
      VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,'active',$6,$7,$8) RETURNING *`,
      [o.employee_id, o.certification_id, o.certificate_number,
       new_expiry_date, certificate_url || o.certificate_url,
       o.issued_by, notes || null, o.company_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
