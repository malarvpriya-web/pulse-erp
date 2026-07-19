import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// ── GET /visits ───────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { customer_id, project_id, visited_by, status, from_date, to_date, limit = 100 } = req.query;
    const companyId = cid(req);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`cv.company_id=$${idx++}`); params.push(companyId); }
    if (customer_id) { conditions.push(`cv.customer_id=$${idx++}`); params.push(customer_id); }
    if (project_id) { conditions.push(`cv.project_id=$${idx++}`); params.push(project_id); }
    if (visited_by) { conditions.push(`cv.visited_by=$${idx++}`); params.push(visited_by); }
    if (status) { conditions.push(`cv.status=$${idx++}`); params.push(status); }
    if (from_date) { conditions.push(`cv.visit_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`cv.visit_date<=$${idx++}`); params.push(to_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT cv.*,
             CONCAT(e.first_name,' ',e.last_name) AS visited_by_name,
             e.designation,
             e.department
      FROM customer_visits cv
      LEFT JOIN employees e ON e.id = cv.visited_by
      ${where}
      ORDER BY cv.visit_date DESC, cv.created_at DESC
      LIMIT ${parseInt(limit)}
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /visits/:id ───────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: [visit] } = await pool.query(`
      SELECT cv.*,
             CONCAT(e.first_name,' ',e.last_name) AS visited_by_name
      FROM customer_visits cv
      LEFT JOIN employees e ON e.id = cv.visited_by
      WHERE cv.id=$1`, [req.params.id]);
    if (!visit) return res.status(404).json({ error: 'Not found' });
    const { rows: actions } = await pool.query(
      `SELECT * FROM customer_visit_action_items WHERE visit_id=$1 ORDER BY id`, [req.params.id]);
    res.json({ ...visit, action_items: actions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /visits ──────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      visit_type, customer_id, customer_name, project_id, project_number, site_name,
      opportunity_id, opportunity_ref, visited_by, visit_date, purpose,
      discussion_notes, location, gps_lat, gps_lng, photos_drive_link,
      visit_report, next_followup_date, next_followup_notes, status = 'Submitted',
      action_items = [],
    } = req.body;
    const actorId = uid(req);
    const companyId = cid(req);

    const { rows: [v] } = await pool.query(`
      INSERT INTO customer_visits
        (visit_type, customer_id, customer_name, project_id, project_number, site_name,
         opportunity_id, opportunity_ref, visited_by, visit_date, purpose,
         discussion_notes, location, gps_lat, gps_lng, photos_drive_link,
         visit_report, next_followup_date, next_followup_notes, status, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *
    `, [visit_type||'Customer Visit', customer_id, customer_name, project_id, project_number,
        site_name, opportunity_id, opportunity_ref, visited_by||actorId, visit_date, purpose,
        discussion_notes, location, gps_lat||null, gps_lng||null, photos_drive_link,
        visit_report, next_followup_date||null, next_followup_notes, status, companyId, actorId]);

    // Insert action items
    for (const ai of action_items) {
      await pool.query(
        `INSERT INTO customer_visit_action_items (visit_id, action, owner, due_date, status)
         VALUES ($1,$2,$3,$4,'Open')`,
        [v.id, ai.action, ai.owner, ai.due_date || null]
      );
    }
    logAudit({ userId: actorId, module: 'customer_visits', recordId: v.id, recordType: 'customer_visit', action: 'create', newData: v });
    res.status(201).json(v);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /visits/:id ───────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      visit_type, customer_id, customer_name, project_id, project_number, site_name,
      opportunity_id, opportunity_ref, visited_by, visit_date, purpose,
      discussion_notes, location, gps_lat, gps_lng, photos_drive_link,
      visit_report, next_followup_date, next_followup_notes, status,
    } = req.body;
    const { rows: [v] } = await pool.query(`
      UPDATE customer_visits SET
        visit_type=$1, customer_id=$2, customer_name=$3,
        project_id=$4, project_number=$5, site_name=$6,
        opportunity_id=$7, opportunity_ref=$8, visited_by=$9,
        visit_date=$10, purpose=$11, discussion_notes=$12,
        location=$13, gps_lat=$14, gps_lng=$15, photos_drive_link=$16,
        visit_report=$17, next_followup_date=$18, next_followup_notes=$19,
        status=$20, updated_at=NOW()
      WHERE id=$21 RETURNING *
    `, [visit_type, customer_id, customer_name, project_id, project_number, site_name,
        opportunity_id, opportunity_ref, visited_by, visit_date, purpose,
        discussion_notes, location, gps_lat||null, gps_lng||null, photos_drive_link,
        visit_report, next_followup_date||null, next_followup_notes, status, req.params.id]);
    res.json(v);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /visits/:id ────────────────────────────────────────────────────────
router.delete('/:id', allowRoles('admin','super_admin','manager'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM customer_visits WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Action items CRUD ─────────────────────────────────────────────────────────
router.get('/:id/actions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM customer_visit_action_items WHERE visit_id=$1 ORDER BY id`, [req.params.id]);
    res.json(rows);
  } catch { res.json([]); }
});

router.post('/:id/actions', async (req, res) => {
  try {
    const { action, owner, due_date } = req.body;
    const { rows: [ai] } = await pool.query(
      `INSERT INTO customer_visit_action_items (visit_id, action, owner, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, action, owner, due_date || null]);
    res.status(201).json(ai);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/actions/:actionId', async (req, res) => {
  try {
    const { status, completed_at } = req.body;
    const { rows: [ai] } = await pool.query(
      `UPDATE customer_visit_action_items SET status=$1, completed_at=$2 WHERE id=$3 RETURNING *`,
      [status, completed_at || null, req.params.actionId]);
    res.json(ai);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dashboard summary ─────────────────────────────────────────────────────────
router.get('/summary/stats', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE company_id=${companyId}` : '';
    const [total, thisMonth, pending, upcoming] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM customer_visits ${cFilter}`),
      pool.query(`SELECT COUNT(*) FROM customer_visits ${cFilter} ${cFilter?'AND':'WHERE'} DATE_TRUNC('month',visit_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COUNT(*) FROM customer_visit_action_items WHERE status='Open'`),
      pool.query(`SELECT COUNT(*) FROM customer_visits ${cFilter} ${cFilter?'AND':'WHERE'} next_followup_date >= NOW() AND next_followup_date <= NOW()+INTERVAL '7 days'`),
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      this_month: parseInt(thisMonth.rows[0].count),
      open_actions: parseInt(pending.rows[0].count),
      upcoming_followups: parseInt(upcoming.rows[0].count),
    });
  } catch { res.json({ total:0, this_month:0, open_actions:0, upcoming_followups:0 }); }
});

// ── Recent visits by customer ─────────────────────────────────────────────────
router.get('/summary/by-customer', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE cv.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT customer_name, COUNT(*) AS visit_count,
             MAX(visit_date) AS last_visit
      FROM customer_visits cv
      ${cFilter}
      GROUP BY customer_name ORDER BY visit_count DESC LIMIT 10
    `);
    res.json(rows);
  } catch { res.json([]); }
});

export default router;
