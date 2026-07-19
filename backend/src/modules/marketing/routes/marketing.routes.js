import express from 'express';
import pool from '../../shared/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => req.scope?.company_id ?? companyOf(req);
const uid = req => req.user?.id ?? null;

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const company_id = cid(req);
    const [statsR, recentR, topR, monthlyR] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='active')      AS active_campaigns,
          COUNT(*)                                      AS total_campaigns,
          COALESCE(SUM(budget), 0)                     AS total_budget,
          COALESCE(SUM(spent),  0)                     AS total_spent,
          COALESCE(SUM(actual_leads), 0)               AS total_leads_generated,
          CASE WHEN COALESCE(SUM(spent), 0) > 0
            THEN ROUND(COALESCE(SUM(actual_leads), 0)::numeric
                       / COALESCE(SUM(spent), 0) * 100, 2)
            ELSE 0 END                                 AS avg_roi
        FROM marketing_campaigns
        WHERE company_id = $1`, [company_id]),

      pool.query(`
        SELECT id, name, type, status, actual_leads, target_leads, budget, spent, start_date, end_date
        FROM marketing_campaigns
        WHERE company_id = $1
        ORDER BY created_at DESC LIMIT 5`, [company_id]),

      pool.query(`
        SELECT id, name, type, status, actual_leads, budget, spent
        FROM marketing_campaigns
        WHERE company_id = $1
        ORDER BY actual_leads DESC LIMIT 5`, [company_id]),

      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', start_date), 'Mon YY') AS month,
          COALESCE(SUM(actual_leads), 0)                     AS leads
        FROM marketing_campaigns
        WHERE company_id = $1
          AND start_date >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', start_date)
        ORDER BY DATE_TRUNC('month', start_date)`, [company_id]),
    ]);

    res.json({
      stats:           statsR.rows[0],
      recent_campaigns: recentR.rows,
      top_performing:   topR.rows,
      monthly_leads:    monthlyR.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaign Stats ────────────────────────────────────────────────────────────
router.get('/campaigns/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                     AS total,
        COUNT(*) FILTER (WHERE status='active')      AS active,
        COUNT(*) FILTER (WHERE status='draft')       AS draft,
        COUNT(*) FILTER (WHERE status='completed')   AS completed,
        COALESCE(SUM(budget), 0)                     AS total_budget,
        COALESCE(SUM(spent),  0)                     AS total_spent,
        COALESCE(SUM(actual_leads), 0)               AS total_leads
      FROM marketing_campaigns WHERE company_id = $1`, [cid(req)]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaigns CRUD ────────────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const { status, type, search } = req.query;
    const params = [cid(req)];
    let idx = 2;
    let where = `WHERE mc.company_id = $1`;
    if (status) { where += ` AND mc.status = $${idx++}`; params.push(status); }
    if (type)   { where += ` AND mc.type   = $${idx++}`; params.push(type); }
    if (search) { where += ` AND mc.name ILIKE $${idx++}`; params.push(`%${search}%`); }

    const { rows } = await pool.query(`
      SELECT mc.*,
        e.name                    AS owner_name,
        COUNT(DISTINCT mt.id)     AS task_count,
        COUNT(DISTINCT md.id)     AS deliverable_count
      FROM marketing_campaigns mc
      LEFT JOIN employees            e  ON e.id  = mc.owner_id
      LEFT JOIN marketing_tasks      mt ON mt.campaign_id = mc.id
      LEFT JOIN marketing_deliverables md ON md.campaign_id = mc.id
      ${where}
      GROUP BY mc.id, e.name
      ORDER BY mc.created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/campaigns/:id/analytics', async (req, res) => {
  try {
    const id = req.params.id;
    const [taskR, delivR, campR] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed
        FROM marketing_tasks WHERE campaign_id = $1`, [id]),
      pool.query(`
        SELECT status, COUNT(*) AS cnt
        FROM marketing_deliverables WHERE campaign_id = $1
        GROUP BY status`, [id]),
      pool.query(`SELECT budget, spent, actual_leads FROM marketing_campaigns WHERE id = $1`, [id]),
    ]);
    const c = campR.rows[0] || {};
    const spent = parseFloat(c.spent || 0);
    const leads = parseInt(c.actual_leads || 0);
    const cost_per_lead = leads > 0 ? (spent / leads).toFixed(2) : 0;
    const roi = spent > 0 ? ((leads * 5000 - spent) / spent * 100).toFixed(1) : 0;
    res.json({
      task_completion:   { total: taskR.rows[0]?.total || 0, completed: taskR.rows[0]?.completed || 0 },
      deliverable_status: delivR.rows,
      budget: c.budget, spent: c.spent, actual_leads: c.actual_leads,
      cost_per_lead, roi,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM marketing_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { name, type = 'email', status = 'draft', budget = 0, target_leads = 0,
            start_date, end_date, owner_id, description } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_campaigns
        (company_id, name, type, status, budget, target_leads, start_date, end_date, owner_id, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cid(req), name, type, status, budget, target_leads,
       start_date || null, end_date || null, owner_id || null, description || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const allowed = ['name','type','status','budget','spent','target_leads','actual_leads',
                     'start_date','end_date','owner_id','description'];
    const sets = []; const vals = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
    });
    if (!sets.length) return res.json({});
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id, cid(req));
    const { rows } = await pool.query(
      `UPDATE marketing_campaigns SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`,
      vals);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/campaigns/:id/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE marketing_campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
      [req.body.status, req.params.id, cid(req)]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM marketing_campaigns WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics Summary ─────────────────────────────────────────────────────────
router.get('/analytics/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                    AS total_campaigns,
        COALESCE(SUM(actual_leads), 0)              AS total_leads,
        CASE WHEN COALESCE(SUM(spent), 0) > 0
          THEN ROUND(COALESCE(SUM(actual_leads), 0)::numeric / COALESCE(SUM(spent), 0) * 100, 2)
          ELSE 0 END                                AS cost_per_lead_rate,
        (SELECT name FROM marketing_campaigns
         WHERE company_id = $1 ORDER BY actual_leads DESC LIMIT 1) AS best_campaign
      FROM marketing_campaigns WHERE company_id = $1`, [cid(req)]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const { campaign_id, assigned_to, status } = req.query;
    const params = [cid(req)]; let idx = 2;
    let where = `WHERE mt.company_id = $1`;
    if (campaign_id) { where += ` AND mt.campaign_id = $${idx++}`; params.push(campaign_id); }
    if (assigned_to) { where += ` AND mt.assigned_to = $${idx++}`; params.push(assigned_to); }
    if (status)      { where += ` AND mt.status = $${idx++}`;       params.push(status); }

    const { rows } = await pool.query(`
      SELECT mt.*, e.name AS assigned_to_name, mc.name AS campaign_name
      FROM marketing_tasks mt
      LEFT JOIN employees e ON e.id = mt.assigned_to
      LEFT JOIN marketing_campaigns mc ON mc.id = mt.campaign_id
      ${where}
      ORDER BY mt.due_date ASC NULLS LAST`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tasks', async (req, res) => {
  try {
    const { campaign_id, title, description, assigned_to, due_date, priority = 'medium' } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_tasks
        (company_id, campaign_id, title, description, assigned_to, due_date, priority, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid(req), campaign_id || null, title, description || null,
       assigned_to || null, due_date || null, priority, uid(req)]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tasks/:id', async (req, res) => {
  try {
    const allowed = ['title','description','assigned_to','due_date','status','priority','campaign_id'];
    const sets = []; const vals = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
    });
    if (!sets.length) return res.json({});
    vals.push(req.params.id, cid(req));
    const { rows } = await pool.query(
      `UPDATE marketing_tasks SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`,
      vals);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tasks/:id/complete', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE marketing_tasks SET status = 'completed' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, cid(req)]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM marketing_tasks WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Deliverables ──────────────────────────────────────────────────────────────
router.get('/deliverables', async (req, res) => {
  try {
    const { campaign_id, status } = req.query;
    const params = [cid(req)]; let idx = 2;
    let where = `WHERE md.company_id = $1`;
    if (campaign_id) { where += ` AND md.campaign_id = $${idx++}`; params.push(campaign_id); }
    if (status)      { where += ` AND md.status = $${idx++}`;       params.push(status); }

    const { rows } = await pool.query(`
      SELECT md.*, e.name AS assigned_to_name, mc.name AS campaign_name
      FROM marketing_deliverables md
      LEFT JOIN employees e ON e.id = md.assigned_to
      LEFT JOIN marketing_campaigns mc ON mc.id = md.campaign_id
      ${where}
      ORDER BY md.due_date ASC NULLS LAST`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deliverables', async (req, res) => {
  try {
    const { campaign_id, name, type, due_date, assigned_to, notes } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_deliverables (company_id, campaign_id, name, type, due_date, assigned_to, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid(req), campaign_id || null, name, type || null, due_date || null, assigned_to || null, notes || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/deliverables/:id', async (req, res) => {
  try {
    const allowed = ['name','type','status','due_date','assigned_to','notes','campaign_id'];
    const sets = []; const vals = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
    });
    if (!sets.length) return res.json({});
    vals.push(req.params.id, cid(req));
    const { rows } = await pool.query(
      `UPDATE marketing_deliverables SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`,
      vals);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/deliverables/:id/deliver', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE marketing_deliverables
        SET status = 'delivered', delivered_at = NOW(), notes = COALESCE($1, notes)
      WHERE id = $2 AND company_id = $3 RETURNING *`,
      [req.body.notes || null, req.params.id, cid(req)]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders Won/Lost ───────────────────────────────────────────────────────────
router.get('/orders-won-lost/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(status) = 'won')   AS won_count,
        COALESCE(SUM(total_amount) FILTER (WHERE LOWER(status) = 'won'), 0) AS won_value,
        COUNT(*) FILTER (WHERE LOWER(status) = 'lost')  AS lost_count,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(*) FILTER (WHERE LOWER(status) = 'won')::numeric / COUNT(*) * 100, 1)
          ELSE 0 END AS conversion_rate
      FROM sales_orders
      WHERE company_id = $1 AND campaign_id IS NOT NULL`, [cid(req)]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders-won-lost', async (req, res) => {
  try {
    const { campaign_id, period } = req.query;
    const params = [cid(req)]; let idx = 2;
    let where = `WHERE so.company_id = $1 AND so.campaign_id IS NOT NULL`;
    if (campaign_id) { where += ` AND so.campaign_id = $${idx++}`; params.push(campaign_id); }
    if (period === 'month')   where += ` AND so.created_at >= NOW() - INTERVAL '1 month'`;
    if (period === 'quarter') where += ` AND so.created_at >= NOW() - INTERVAL '3 months'`;

    const { rows } = await pool.query(`
      SELECT so.id, so.order_no,
        COALESCE(so.customer_name, a.name) AS customer_name,
        so.total_amount, so.status, so.created_at,
        mc.name AS campaign_name
      FROM sales_orders so
      LEFT JOIN marketing_campaigns mc ON mc.id = so.campaign_id
      LEFT JOIN accounts a ON a.id = so.account_id
      ${where}
      ORDER BY so.created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pursuit List ──────────────────────────────────────────────────────────────
router.get('/pursuit-list', async (req, res) => {
  try {
    const { status, campaign_id } = req.query;
    const params = [cid(req)]; let idx = 2;
    let where = `WHERE mpl.company_id = $1`;
    if (status)      { where += ` AND mpl.status = $${idx++}`;      params.push(status); }
    if (campaign_id) { where += ` AND mpl.campaign_id = $${idx++}`; params.push(campaign_id); }

    const { rows } = await pool.query(`
      SELECT mpl.*,
        COALESCE(a.name, mpl.account_name) AS display_account_name,
        e.name  AS assigned_to_name,
        mc.name AS campaign_name
      FROM marketing_pursuit_list mpl
      LEFT JOIN accounts a ON a.id = mpl.account_id
      LEFT JOIN employees e ON e.id = mpl.assigned_to
      LEFT JOIN marketing_campaigns mc ON mc.id = mpl.campaign_id
      ${where}
      ORDER BY mpl.priority DESC, mpl.created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pursuit-list', async (req, res) => {
  try {
    const { account_id, account_name, campaign_id, priority = 'medium', assigned_to, notes } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_pursuit_list
        (company_id, account_id, account_name, campaign_id, priority, assigned_to, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid(req), account_id || null, account_name || null, campaign_id || null,
       priority, assigned_to || null, notes || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/pursuit-list/:id', async (req, res) => {
  try {
    const allowed = ['status','notes','priority','assigned_to','campaign_id','account_name'];
    const sets = []; const vals = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
    });
    if (!sets.length) return res.json({});
    vals.push(req.params.id, cid(req));
    const { rows } = await pool.query(
      `UPDATE marketing_pursuit_list SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`,
      vals);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/pursuit-list/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM marketing_pursuit_list WHERE id = $1 AND company_id = $2`, [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Timesheets ────────────────────────────────────────────────────────────────
router.get('/timesheets/summary', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT e.id, e.name,
        COALESCE(SUM(mts.hours), 0) AS total_hours
      FROM employees e
      LEFT JOIN marketing_timesheets mts
        ON mts.employee_id = e.id AND mts.company_id = $1
        AND EXTRACT(MONTH FROM mts.date) = $2
        AND EXTRACT(YEAR  FROM mts.date) = $3
      WHERE e.company_id = $1 AND e.status IN ('active','probation')
      GROUP BY e.id, e.name
      HAVING COALESCE(SUM(mts.hours), 0) > 0
      ORDER BY total_hours DESC`, [cid(req), month, year]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/timesheets', async (req, res) => {
  try {
    const { employee_id, month, year } = req.query;
    const params = [cid(req)]; let idx = 2;
    let where = `WHERE mts.company_id = $1`;
    if (employee_id) { where += ` AND mts.employee_id = $${idx++}`; params.push(employee_id); }
    if (month)       { where += ` AND EXTRACT(MONTH FROM mts.date) = $${idx++}`; params.push(month); }
    if (year)        { where += ` AND EXTRACT(YEAR  FROM mts.date) = $${idx++}`; params.push(year); }

    const { rows } = await pool.query(`
      SELECT mts.*, e.name AS employee_name, mc.name AS campaign_name, mt.title AS task_name
      FROM marketing_timesheets mts
      LEFT JOIN employees e ON e.id = mts.employee_id
      LEFT JOIN marketing_campaigns mc ON mc.id = mts.campaign_id
      LEFT JOIN marketing_tasks mt ON mt.id = mts.task_id
      ${where}
      ORDER BY mts.date DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/timesheets', async (req, res) => {
  try {
    const { campaign_id, task_id, date, hours, description } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_timesheets
        (company_id, employee_id, campaign_id, task_id, date, hours, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid(req), uid(req), campaign_id || null, task_id || null, date, hours, description || null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User Performance ──────────────────────────────────────────────────────────
router.get('/user-performance', async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT e.id, e.name, e.designation,
        COUNT(DISTINCT mt.id)                                    AS tasks_assigned,
        COUNT(DISTINCT mt.id) FILTER (WHERE mt.status = 'completed') AS tasks_completed,
        COALESCE(SUM(mts.hours), 0)                              AS hours_logged,
        COUNT(DISTINCT mpl.id) FILTER (WHERE mpl.status = 'converted') AS pursuits_converted
      FROM employees e
      LEFT JOIN marketing_tasks mt
        ON mt.assigned_to = e.id AND mt.company_id = $1
      LEFT JOIN marketing_timesheets mts
        ON mts.employee_id = e.id AND mts.company_id = $1
        AND EXTRACT(MONTH FROM mts.date) = $2
        AND EXTRACT(YEAR  FROM mts.date) = $3
      LEFT JOIN marketing_pursuit_list mpl
        ON mpl.assigned_to = e.id AND mpl.company_id = $1
      WHERE e.company_id = $1 AND e.status IN ('active','probation')
      GROUP BY e.id, e.name, e.designation
      HAVING COUNT(DISTINCT mt.id) > 0 OR COALESCE(SUM(mts.hours), 0) > 0
      ORDER BY tasks_completed DESC, hours_logged DESC`, [cid(req), month, year]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics: Campaign ROI ───────────────────────────────────────────────────
router.get('/analytics/campaign-roi', async (req, res) => {
  try {
    const { campaign_id } = req.query;
    const params = [cid(req)];
    let where = `WHERE mc.company_id = $1`;
    if (campaign_id) { where += ` AND mc.id = $2`; params.push(campaign_id); }
    const { rows } = await pool.query(`
      SELECT mc.name AS campaign_name,
             COALESCE(mc.spent, 0) AS spend,
             COALESCE(SUM(so.total_amount) FILTER (WHERE LOWER(so.status) = 'won'), 0) AS revenue
      FROM marketing_campaigns mc
      LEFT JOIN sales_orders so ON so.campaign_id = mc.id
      ${where}
      GROUP BY mc.id, mc.name, mc.spent, mc.created_at
      ORDER BY mc.created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics: Leads by Campaign ──────────────────────────────────────────────
router.get('/analytics/leads-by-campaign', async (req, res) => {
  try {
    const { campaign_id } = req.query;
    const params = [cid(req)];
    let where = `WHERE company_id = $1`;
    if (campaign_id) { where += ` AND id = $2`; params.push(campaign_id); }
    const { rows } = await pool.query(`
      SELECT name AS campaign_name, COALESCE(actual_leads, 0) AS lead_count
      FROM marketing_campaigns ${where}
      ORDER BY created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const company_id = cid(req);
    await pool.query(
      `INSERT INTO marketing_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`,
      [company_id]);
    const { rows } = await pool.query(`SELECT * FROM marketing_settings WHERE company_id = $1`, [company_id]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const {
      default_campaign_type, fiscal_year_start, budget_alert_threshold,
      auto_assign_tasks, default_pursuit_priority,
      notify_new_lead, notify_campaign_end, notify_budget_alert,
      default_owner_id, auto_close_days, lead_expiry_days,
      currency, campaign_prefix, campaign_next,
    } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO marketing_settings
        (company_id, default_campaign_type, fiscal_year_start, budget_alert_threshold,
         auto_assign_tasks, default_pursuit_priority,
         notify_new_lead, notify_campaign_end, notify_budget_alert,
         default_owner_id, auto_close_days, lead_expiry_days,
         currency, campaign_prefix, campaign_next)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (company_id) DO UPDATE SET
        default_campaign_type    = EXCLUDED.default_campaign_type,
        fiscal_year_start        = EXCLUDED.fiscal_year_start,
        budget_alert_threshold   = EXCLUDED.budget_alert_threshold,
        auto_assign_tasks        = EXCLUDED.auto_assign_tasks,
        default_pursuit_priority = EXCLUDED.default_pursuit_priority,
        notify_new_lead          = EXCLUDED.notify_new_lead,
        notify_campaign_end      = EXCLUDED.notify_campaign_end,
        notify_budget_alert      = EXCLUDED.notify_budget_alert,
        default_owner_id         = EXCLUDED.default_owner_id,
        auto_close_days          = EXCLUDED.auto_close_days,
        lead_expiry_days         = EXCLUDED.lead_expiry_days,
        currency                 = EXCLUDED.currency,
        campaign_prefix          = EXCLUDED.campaign_prefix,
        campaign_next            = EXCLUDED.campaign_next
      RETURNING *`,
      [cid(req),
       default_campaign_type    || 'email',
       fiscal_year_start        || 4,
       budget_alert_threshold   ?? 80,
       auto_assign_tasks        ?? false,
       default_pursuit_priority || 'medium',
       notify_new_lead          ?? false,
       notify_campaign_end      ?? false,
       notify_budget_alert      ?? false,
       default_owner_id         || null,
       auto_close_days          ?? 90,
       lead_expiry_days         ?? 30,
       currency                 || 'INR',
       campaign_prefix          || 'CAMP',
       campaign_next            ?? 1001]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
