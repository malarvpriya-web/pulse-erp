// backend/src/modules/hr/certifications.routes.js
//
// Certifications — THE register of who holds which certificate (2026-11-18).
// The skill tables' "certified" flags are gone; this is the only place.
//
//   · status 'expired' is real: set by the daily L&D job and on every read,
//     so a certificate past its expiry never shows Active;
//   · a library entry with employee records cannot be deleted (it used to
//     cascade every employee's certificate away) — deactivate it instead;
//   · certificate files are uploaded (StorageService), not pasted URLs;
//   · mandatory certificates get a coverage view: who holds a valid one,
//     whose expired, who has none.
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { singleFileUpload } from './internshipUploads.js';
import { uploadFile } from '../../services/StorageService.js';
import {
  cid, sendError, httpError, intOrNull, strOrNull, dateOrNull, dim, params, upsertRating, EMP_NAME, ACTIVE_EMP,
} from './lnd/lndShared.js';

const router = express.Router();
router.use(requireCompanyScope);
const view = requirePermission('training', 'view');
const add = requirePermission('training', 'add');
const edit = requirePermission('training', 'edit');
const del = requirePermission('training', 'delete');
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

/** Certificates past their expiry are expired — applied before every read. */
export async function expireCertificates(db, companyId) {
  const { rowCount } = await db.query(
    `UPDATE employee_certifications SET status = 'expired', updated_at = NOW()
      WHERE status = 'active' AND expiry_date < CURRENT_DATE AND ($1::int IS NULL OR company_id = $1)`, [companyId]);
  return rowCount;
}

const addMonths = (isoDate, months) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // 31 Jan + 1 month → 28/29 Feb
  return dt.toISOString().slice(0, 10);
};

async function masterInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM certifications WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Certification not found');
  return rows[0];
}

/* ── Library ────────────────────────────────────────────────────── */
router.get('/master', view, async (req, res) => {
  try {
    const P = params([cid(req)]);
    const w = ['($1::int IS NULL OR c.company_id = $1)'];
    const st = dim(req.query, 'status') || 'active';
    if (st === 'active') w.push('c.is_active'); else if (st === 'inactive') w.push('NOT c.is_active');
    const cat = dim(req.query, 'category'); if (cat) w.push(`c.category = ${P.add(cat)}`);
    if (req.query.mandatory === 'true' || req.query.mandatory === 'false') w.push(`c.is_mandatory = ${P.add(req.query.mandatory === 'true')}`);
    const q = dim(req.query, 'q'); if (q) { const ph = P.add(`%${q}%`); w.push(`(c.name ILIKE ${ph} OR c.code ILIKE ${ph} OR c.issuing_body ILIKE ${ph})`); }
    const { rows } = await pool.query(
      `SELECT c.*, cf.name AS competency_name,
              (SELECT COUNT(*) FROM employee_certifications ec WHERE ec.certification_id = c.id AND ec.status = 'active')::int AS active_holders,
              (SELECT COUNT(*) FROM employee_certifications ec WHERE ec.certification_id = c.id)::int AS total_records
         FROM certifications c LEFT JOIN competency_framework cf ON cf.id = c.competency_id
        WHERE ${w.join(' AND ')} ORDER BY c.category NULLS LAST, c.name`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load certifications'); }
});

async function masterBody(db, b, companyId, cur = {}) {
  const name = strOrNull(b.name ?? cur.name);
  if (!name) throw httpError(400, 'Name is required');
  const validity = intOrNull(b.validity_months ?? cur.validity_months);
  if (validity != null && (validity < 0 || validity > 600)) throw httpError(400, 'Validity must be 0–600 months (0 = never expires)');
  const competency_id = b.competency_id === '' || b.competency_id === null ? null : intOrNull(b.competency_id ?? cur.competency_id);
  if (competency_id) {
    const { rows } = await db.query(`SELECT 1 FROM competency_framework WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [competency_id, companyId]);
    if (!rows.length) throw httpError(400, 'Unknown skill / competency');
  }
  const pick = (k) => (Object.prototype.hasOwnProperty.call(b, k) ? strOrNull(b[k]) : cur[k] ?? null);
  return {
    name, code: pick('code'), issuing_body: pick('issuing_body'), category: pick('category'), description: pick('description'),
    validity_months: validity ?? 12, competency_id,
    is_mandatory: b.is_mandatory === undefined ? !!cur.is_mandatory : (b.is_mandatory === true || b.is_mandatory === 'true'),
    is_active: b.is_active === undefined ? (cur.is_active ?? true) : !!b.is_active,
  };
}

router.post('/master', add, async (req, res) => {
  try {
    const b = await masterBody(pool, req.body || {}, cid(req));
    const { rows } = await pool.query(
      `INSERT INTO certifications (name, code, issuing_body, category, validity_months, is_mandatory, description, competency_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.name, b.code, b.issuing_body, b.category, b.validity_months, b.is_mandatory, b.description, b.competency_id, cid(req)]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A certification with this name already exists.' });
    sendError(res, err, 'Could not create the certification');
  }
});

router.put('/master/:id', edit, captureBefore('certifications'), async (req, res) => {
  try {
    const cur = await masterInCompany(pool, req.params.id, cid(req));
    const b = await masterBody(pool, req.body || {}, cid(req), cur);
    const { rows } = await pool.query(
      `UPDATE certifications SET name=$2, code=$3, issuing_body=$4, category=$5, validity_months=$6, is_mandatory=$7,
              description=$8, competency_id=$9, is_active=$10, updated_at=NOW() WHERE id = $1 RETURNING *`,
      [cur.id, b.name, b.code, b.issuing_body, b.category, b.validity_months, b.is_mandatory, b.description, b.competency_id, b.is_active]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A certification with this name already exists.' });
    sendError(res, err, 'Could not save the certification');
  }
});

router.delete('/master/:id', del, captureBefore('certifications'), async (req, res) => {
  try {
    const cur = await masterInCompany(pool, req.params.id, cid(req));
    const { rows: [c] } = await pool.query(`SELECT COUNT(*)::int AS n FROM employee_certifications WHERE certification_id = $1`, [cur.id]);
    if (c.n) return res.status(409).json({ error: `${c.n} employee record(s) use this certification — deactivate it instead, so their records stay.` });
    await pool.query(`DELETE FROM certifications WHERE id = $1`, [cur.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { sendError(res, err, 'Could not delete'); }
});

/* ── Employee certificates ──────────────────────────────────────── */
router.get('/employee', view, async (req, res) => {
  const companyId = cid(req);
  try {
    await expireCertificates(pool, companyId);
    const P = params([companyId]);
    const w = ['($1::int IS NULL OR ec.company_id = $1)'];
    const emp = intOrNull(req.query.employee_id); if (emp) w.push(`ec.employee_id = ${P.add(emp)}`);
    const st = dim(req.query, 'status');
    if (st) w.push(`ec.status = ANY(${P.add(st.split(','))}::text[])`); else w.push(`ec.status <> 'renewed'`);
    const certId = intOrNull(req.query.certification_id); if (certId) w.push(`ec.certification_id = ${P.add(certId)}`);
    const cat = dim(req.query, 'category'); if (cat) w.push(`c.category = ${P.add(cat)}`);
    const dept = dim(req.query, 'department'); if (dept) w.push(`e.department = ${P.add(dept)}`);
    if (req.query.mandatory === 'true') w.push('c.is_mandatory');
    const exp = intOrNull(req.query.expiring_days);
    if (exp) w.push(`ec.status = 'active' AND ec.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ${P.add(exp)}::int`);
    const q = dim(req.query, 'q'); if (q) { const ph = P.add(`%${q}%`); w.push(`(${EMP_NAME} ILIKE ${ph} OR c.name ILIKE ${ph} OR ec.certificate_number ILIKE ${ph} OR e.office_id ILIKE ${ph})`); }
    const { rows } = await pool.query(`
      SELECT ec.*, ec.issue_date::text AS issue_date, ec.expiry_date::text AS expiry_date, ec.renewal_date::text AS renewal_date,
             c.name AS cert_name, c.issuing_body, c.category, c.validity_months, c.is_mandatory,
             ${EMP_NAME} AS employee_name, e.office_id, e.department, e.designation,
             (ec.expiry_date - CURRENT_DATE)::int AS days_until_expiry
        FROM employee_certifications ec
        JOIN certifications c ON c.id = ec.certification_id
        JOIN employees e ON e.id = ec.employee_id
       WHERE ${w.join(' AND ')}
       ORDER BY ec.expiry_date NULLS LAST, 2`, P.list);
    res.json(rows);
  } catch (err) { sendError(res, err, 'Could not load employee certificates'); }
});

async function recordInCompany(db, id, companyId) {
  const { rows } = await db.query(`SELECT * FROM employee_certifications WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [id, companyId]);
  if (!rows.length) throw httpError(404, 'Certificate record not found');
  return rows[0];
}

/** Expiry = given, else issue date + validity (0 months = no expiry). */
function resolveExpiry(issue, expiry, validity) {
  if (expiry) return expiry;
  if (issue && validity) return addMonths(issue, validity);
  return null;
}

router.post('/employee', add, singleFileUpload('file'), async (req, res) => {
  const companyId = cid(req);
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const employeeId = intOrNull(b.employee_id);
    if (!employeeId) throw httpError(400, 'Choose the employee');
    const { rows: [emp] } = await client.query(`SELECT e.id FROM employees e WHERE e.id = $1 AND ${ACTIVE_EMP} AND ($2::int IS NULL OR e.company_id = $2)`, [employeeId, companyId]);
    if (!emp) throw httpError(400, 'Choose an active employee of this company');
    const cert = await masterInCompany(client, intOrNull(b.certification_id), companyId);
    if (!cert.is_active) throw httpError(400, 'This certification is deactivated');
    const issue = dateOrNull(b.issue_date);
    if (!issue) throw httpError(400, 'Issue date is required');
    const expiry = resolveExpiry(issue, dateOrNull(b.expiry_date), cert.validity_months);
    if (expiry && expiry < issue) throw httpError(400, 'Expiry cannot be before the issue date');
    const fileUrl = req.file ? await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype) : null;
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `INSERT INTO employee_certifications (employee_id, certification_id, certificate_number, issue_date, expiry_date,
         certificate_url, status, issued_by, notes, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5::date < CURRENT_DATE THEN 'expired' ELSE 'active' END,$7,$8,$9,$10) RETURNING *`,
      [emp.id, cert.id, strOrNull(b.certificate_number), issue, expiry, fileUrl, strOrNull(b.issued_by) || cert.issuing_body,
       strOrNull(b.notes), companyId, uid(req)]);
    if (cert.competency_id && row.status === 'active') {
      await upsertRating(client, { employeeId: emp.id, competencyId: cert.competency_id, level: 4, source: 'certification',
        companyId, assessedByUser: uid(req), notes: `Certified: ${cert.name}` });
    }
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'This certificate with the same issue date is already recorded for the employee.' });
    sendError(res, err, 'Could not record the certificate');
  } finally { client.release(); }
});

router.put('/employee/:id', edit, singleFileUpload('file'), captureBefore('employee_certifications'), async (req, res) => {
  const companyId = cid(req);
  try {
    const cur = await recordInCompany(pool, req.params.id, companyId);
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const issue = has('issue_date') ? dateOrNull(b.issue_date) : (cur.issue_date ? new Date(cur.issue_date).toISOString().slice(0, 10) : null);
    const expiry = has('expiry_date') ? dateOrNull(b.expiry_date) : cur.expiry_date;
    if (issue && expiry && String(expiry).slice(0, 10) < issue) throw httpError(400, 'Expiry cannot be before the issue date');
    const status = has('status') ? String(b.status) : cur.status;
    if (!['active', 'expired', 'renewed', 'revoked'].includes(status)) throw httpError(400, 'Unknown status');
    const fileUrl = req.file ? await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype) : cur.certificate_url;
    const { rows } = await pool.query(
      `UPDATE employee_certifications SET certificate_number = $2, issue_date = $3, expiry_date = $4, certificate_url = $5,
              status = CASE WHEN $6::text = 'active' AND $4::date < CURRENT_DATE THEN 'expired' ELSE $6::text END,
              issued_by = $7, notes = $8, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [cur.id, has('certificate_number') ? strOrNull(b.certificate_number) : cur.certificate_number, issue, expiry, fileUrl, status,
       has('issued_by') ? strOrNull(b.issued_by) : cur.issued_by, has('notes') ? strOrNull(b.notes) : cur.notes]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Could not save the certificate'); }
});

router.delete('/employee/:id', del, captureBefore('employee_certifications'), async (req, res) => {
  try {
    const cur = await recordInCompany(pool, req.params.id, cid(req));
    await pool.query(`UPDATE employee_certifications SET renewed_from_id = NULL WHERE renewed_from_id = $1`, [cur.id]);
    await pool.query(`DELETE FROM employee_certifications WHERE id = $1`, [cur.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { sendError(res, err, 'Could not delete'); }
});

/** Renew: the old record becomes 'renewed', a new active one carries the new dates. */
router.post('/employee/:id/renew', add, singleFileUpload('file'), async (req, res) => {
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await recordInCompany(client, req.params.id, companyId);
    if (!['active', 'expired'].includes(old.status)) throw httpError(409, 'Only an active or expired certificate can be renewed.');
    const cert = await masterInCompany(client, old.certification_id, companyId);
    const issue = dateOrNull(req.body?.issue_date) || new Date().toISOString().slice(0, 10);
    const expiry = resolveExpiry(issue, dateOrNull(req.body?.new_expiry_date || req.body?.expiry_date), cert.validity_months);
    if (expiry && expiry <= issue) throw httpError(400, 'The new expiry must be after the issue date');
    const fileUrl = req.file ? await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype) : null;
    await client.query(`UPDATE employee_certifications SET status = 'renewed', renewal_date = $2, updated_at = NOW() WHERE id = $1`, [old.id, issue]);
    const { rows: [row] } = await client.query(
      `INSERT INTO employee_certifications (employee_id, certification_id, certificate_number, issue_date, expiry_date,
         certificate_url, status, issued_by, notes, company_id, renewed_from_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11) RETURNING *`,
      [old.employee_id, old.certification_id, strOrNull(req.body?.certificate_number) || old.certificate_number, issue, expiry,
       fileUrl, old.issued_by, strOrNull(req.body?.notes), old.company_id, old.id, uid(req)]);
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'A renewal with this issue date already exists.' });
    sendError(res, err, 'Could not renew');
  } finally { client.release(); }
});

/* ── Dashboard + coverage ───────────────────────────────────────── */
router.get('/expiry-dashboard', view, async (req, res) => {
  const companyId = cid(req);
  try {
    await expireCertificates(pool, companyId);
    const dept = dim(req.query, 'department');
    const { rows: [k] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE ec.status='active' AND ec.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30)::int AS expiring_30d,
             COUNT(*) FILTER (WHERE ec.status='active' AND ec.expiry_date BETWEEN CURRENT_DATE+31 AND CURRENT_DATE+60)::int AS expiring_60d,
             COUNT(*) FILTER (WHERE ec.status='active' AND ec.expiry_date BETWEEN CURRENT_DATE+61 AND CURRENT_DATE+90)::int AS expiring_90d,
             COUNT(*) FILTER (WHERE ec.status='expired')::int AS expired,
             COUNT(*) FILTER (WHERE ec.status='active')::int AS active,
             COUNT(*) FILTER (WHERE ec.status='revoked')::int AS revoked
        FROM employee_certifications ec JOIN employees e ON e.id = ec.employee_id
       WHERE ($1::int IS NULL OR ec.company_id = $1) AND ($2::text IS NULL OR e.department = $2)`, [companyId, dept]);
    const cov = await coverage(pool, companyId, { department: dept });
    res.json({ ...k, mandatory_required: cov.summary.required, mandatory_missing: cov.summary.missing + cov.summary.expired, mandatory_coverage_pct: cov.summary.coverage_pct });
  } catch (err) { sendError(res, err, 'Could not load the expiry summary'); }
});

/** Every mandatory certificate × every active employee: valid / expired / missing. */
export async function coverage(db, companyId, { department = null, certificationId = null } = {}) {
  const { rows } = await db.query(`
    SELECT e.id AS employee_id, ${EMP_NAME} AS employee_name, e.office_id, e.department, e.designation,
           c.id AS certification_id, c.name AS cert_name, c.category,
           ec.id AS record_id, ec.expiry_date::text AS expiry_date,
           CASE WHEN ec.id IS NULL THEN 'missing'
                WHEN ec.status = 'active' THEN 'valid' ELSE 'expired' END AS status
      FROM certifications c
      CROSS JOIN employees e
      LEFT JOIN LATERAL (
        SELECT x.* FROM employee_certifications x WHERE x.employee_id = e.id AND x.certification_id = c.id AND x.status IN ('active','expired')
         ORDER BY (x.status = 'active') DESC, x.expiry_date DESC NULLS FIRST LIMIT 1) ec ON true
     WHERE c.is_mandatory AND c.is_active AND ($1::int IS NULL OR c.company_id = $1)
       AND ${ACTIVE_EMP} AND ($1::int IS NULL OR e.company_id = $1)
       AND ($2::text IS NULL OR e.department = $2) AND ($3::int IS NULL OR c.id = $3)
     ORDER BY c.name, 2`, [companyId, department, certificationId]);
  const summary = { required: rows.length, valid: 0, expired: 0, missing: 0 };
  for (const r of rows) summary[r.status]++;
  summary.coverage_pct = rows.length ? Math.round(100 * summary.valid / rows.length) : 100;
  return { rows, summary };
}

router.get('/coverage', view, async (req, res) => {
  try {
    await expireCertificates(pool, cid(req));
    const out = await coverage(pool, cid(req), { department: dim(req.query, 'department'), certificationId: intOrNull(req.query.certification_id) });
    const st = dim(req.query, 'status');
    if (st) out.rows = out.rows.filter(r => st.split(',').includes(r.status));
    res.json(out);
  } catch (err) { sendError(res, err, 'Could not load coverage'); }
});

export default router;
