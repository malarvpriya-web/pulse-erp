// backend/src/modules/hr/hr-widgets.routes.js
// HR dashboard widget data: birthdays, anniversaries, expiring docs, pending confirmations
import express from 'express';
import pool from '../../config/db.js';
import { verifyToken } from '../../middlewares/auth.middleware.js';

const router = express.Router();

router.use(verifyToken);

/* GET /hr-widgets/upcoming-birthdays?days=30 */
router.get('/upcoming-birthdays', async (req, res) => {
  const days = Math.min(parseInt(req.query.days ?? '30', 10), 90);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, photo_url,
         dob,
         TO_CHAR(dob, 'MM-DD') AS birth_md
       FROM employees
       WHERE dob IS NOT NULL
         AND LOWER(status) IN ('active','probation')
         AND ($1::int IS NULL OR company_id = $1)
         AND (
           -- same-year: birthday MMDD falls between today and today+N days
           (TO_CHAR(CURRENT_DATE,'MMDD') <= TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')
            AND TO_CHAR(dob,'MMDD') BETWEEN TO_CHAR(CURRENT_DATE,'MMDD')
                                        AND TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD'))
           OR
           -- year-wrap: window crosses Dec→Jan boundary
           (TO_CHAR(CURRENT_DATE,'MMDD') > TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')
            AND (TO_CHAR(dob,'MMDD') >= TO_CHAR(CURRENT_DATE,'MMDD')
                 OR TO_CHAR(dob,'MMDD') <= TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')))
         )
       ORDER BY TO_CHAR(dob,'MM-DD')`,
      [cid, days]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/upcoming-anniversaries?days=30 */
router.get('/upcoming-anniversaries', async (req, res) => {
  const days = Math.min(parseInt(req.query.days ?? '30', 10), 90);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, photo_url,
         joining_date,
         DATE_PART('year', AGE(CURRENT_DATE, joining_date))::int AS years_completed
       FROM employees
       WHERE joining_date IS NOT NULL
         AND LOWER(status) IN ('active','probation')
         AND ($1::int IS NULL OR company_id = $1)
         AND (
           TO_DATE(TO_CHAR(CURRENT_DATE,'YYYY') || '-' || TO_CHAR(joining_date,'MM-DD'), 'YYYY-MM-DD')
           BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::INTERVAL
         )
         AND DATE_PART('year', AGE(CURRENT_DATE, joining_date)) >= 1
       ORDER BY TO_CHAR(joining_date,'MM-DD')`,
      [cid, days]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/pending-confirmations?days=14 — employees whose probation ends within N days */
router.get('/pending-confirmations', async (req, res) => {
  const days = parseInt(req.query.days ?? '14', 10);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, joining_date,
         probation_end_date,
         (probation_end_date - CURRENT_DATE) AS days_remaining
       FROM employees
       WHERE LOWER(status) = 'probation'
         AND probation_end_date IS NOT NULL
         AND probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY probation_end_date ASC`,
      [days, cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/expiring-documents?days=30 */
router.get('/expiring-documents', async (req, res) => {
  const days = parseInt(req.query.days ?? '30', 10);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         d.id AS doc_id,
         d.document_type,
         d.expiry_date,
         (d.expiry_date - CURRENT_DATE) AS days_remaining,
         e.id AS employee_id,
         TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
         e.department,
         e.designation
       FROM employee_documents d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.expiry_date IS NOT NULL
         AND d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL
         AND LOWER(e.status) IN ('active','probation')
         AND ($2::int IS NULL OR d.company_id = $2)
       ORDER BY d.expiry_date ASC`,
      [days, cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/upcoming-exits?days=30 — employees on notice with LWD coming up */
router.get('/upcoming-exits', async (req, res) => {
  const days = parseInt(req.query.days ?? '30', 10);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         e.id, e.office_id,
         TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name,
         e.designation, e.department,
         er.last_working_date,
         er.separation_type,
         (er.last_working_date - CURRENT_DATE) AS days_remaining
       FROM employees e
       JOIN exit_requests er ON er.employee_id = e.id
         AND er.status NOT IN ('rejected','cancelled')
       WHERE er.last_working_date IS NOT NULL
         AND er.last_working_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::INTERVAL
         AND ($2::int IS NULL OR e.company_id = $2)
       ORDER BY er.last_working_date ASC`,
      [days, cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
