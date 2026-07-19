import express from 'express';
import pool from '../../../config/db.js';
import { allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

// ── GET /project-profitability/cost-lines ──────────────────────────────────────
router.get('/cost-lines', async (req, res) => {
  try {
    const { project_id, customer_id, po_number, cost_type, from_date, to_date, limit = 200 } = req.query;
    const companyId = cid(req);
    const conds = [];
    const params = [];
    let idx = 1;
    if (companyId) { conds.push(`company_id=$${idx++}`); params.push(companyId); }
    if (project_id) { conds.push(`project_id=$${idx++}`); params.push(project_id); }
    if (customer_id) { conds.push(`customer_id=$${idx++}`); params.push(customer_id); }
    if (po_number) { conds.push(`po_number=$${idx++}`); params.push(po_number); }
    if (cost_type) { conds.push(`cost_type=$${idx++}`); params.push(cost_type); }
    if (from_date) { conds.push(`cost_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conds.push(`cost_date<=$${idx++}`); params.push(to_date); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM project_cost_lines ${where} ORDER BY cost_date DESC, created_at DESC LIMIT ${parseInt(limit)}`,
      params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /project-profitability/cost-lines ────────────────────────────────────
router.post('/cost-lines', async (req, res) => {
  try {
    const {
      cost_type, description, customer_id, customer_name, project_id, project_number,
      po_number, site_name, cost_centre_id, amount, currency, cost_date,
      reference_type, reference_id,
    } = req.body;
    const actorId = uid(req);
    const companyId = cid(req);
    const { rows: [cl] } = await pool.query(`
      INSERT INTO project_cost_lines
        (cost_type, description, customer_id, customer_name, project_id, project_number,
         po_number, site_name, cost_centre_id, amount, currency, cost_date,
         reference_type, reference_id, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [cost_type, description, customer_id, customer_name, project_id, project_number,
        po_number, site_name, cost_centre_id, amount, currency||'INR', cost_date,
        reference_type, reference_id, companyId, actorId]);
    logAudit({ userId: actorId, module: 'project_profitability', recordId: cl.id, recordType: 'cost_line', action: 'create', newData: cl });
    res.status(201).json(cl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/summary/:project_id ────────────────────────────
router.get('/summary/:project_id', async (req, res) => {
  try {
    const pid = req.params.project_id;
    const companyId = cid(req);

    const [project, costLines, timesheets, travelCosts, procurementCosts] = await Promise.all([
      pool.query(`
        SELECT p.*, pcs.*
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
        WHERE p.id=$1
      `, [pid]),
      pool.query(`
        SELECT cost_type, SUM(amount) AS total
        FROM project_cost_lines WHERE project_id=$1
        GROUP BY cost_type
      `, [pid]),
      pool.query(`
        SELECT COALESCE(SUM(hours * COALESCE(billing_rate,0)),0) AS labour_cost
        FROM timesheets WHERE project_id=$1 AND status='Approved'
      `, [pid]).catch(() => ({ rows: [{ labour_cost: 0 }] })),
      pool.query(`
        SELECT COALESCE(SUM(budget),0) AS travel_cost
        FROM travel_requests WHERE project_id=$1 AND status='Approved'
      `, [pid]).catch(() => ({ rows: [{ travel_cost: 0 }] })),
      pool.query(`
        SELECT COALESCE(SUM(total_amount),0) AS procurement_cost
        FROM purchase_orders WHERE project_id=$1 AND status NOT IN ('Cancelled','Rejected')
      `, [pid]).catch(() => ({ rows: [{ procurement_cost: 0 }] })),
    ]);

    if (!project.rows.length) return res.status(404).json({ error: 'Project not found' });
    const p = project.rows[0];

    // Build cost breakdown from cost lines
    const costBreakdown = {};
    const COST_TYPES = ['Sales Travel','Application Engineering','Design','Procurement','Material',
      'Manufacturing','Quality','FAT','Transport','Installation','Commissioning','Service','AMC'];
    COST_TYPES.forEach(t => { costBreakdown[t] = 0; });
    costLines.rows.forEach(cl => { costBreakdown[cl.cost_type] = parseFloat(cl.total || 0); });

    const revenue = parseFloat(p.contract_value || p.total_revenue || 0);
    const materialCost = parseFloat(p.material_cost || costBreakdown['Material'] || procurementCosts.rows[0].procurement_cost || 0);
    const engineeringCost = parseFloat(timesheets.rows[0].labour_cost || 0);
    const travelCost = parseFloat(travelCosts.rows[0].travel_cost || costBreakdown['Sales Travel'] || 0);
    const manufacturingCost = parseFloat(p.manufacturing_cost || costBreakdown['Manufacturing'] || 0);
    const qualityCost = parseFloat(p.quality_cost || costBreakdown['Quality'] || 0);
    const logisticsCost = parseFloat(costBreakdown['Transport'] || 0);
    const serviceCost = parseFloat(p.service_cost || costBreakdown['Service'] || 0);
    const amcRevenue = parseFloat(p.amc_revenue || costBreakdown['AMC'] || 0);
    const installationCost = parseFloat(p.installation_cost || costBreakdown['Installation'] || 0);
    const commissioningCost = parseFloat(p.commissioning_cost || costBreakdown['Commissioning'] || 0);

    const totalCost = materialCost + engineeringCost + travelCost + manufacturingCost +
      qualityCost + logisticsCost + serviceCost + installationCost + commissioningCost;
    const actualProfit = revenue - totalCost;
    const margin = revenue > 0 ? ((actualProfit / revenue) * 100).toFixed(2) : 0;

    res.json({
      project_id: pid,
      project_name: p.name || p.project_name,
      project_number: p.project_number,
      customer_name: p.customer_name,
      revenue,
      cost_breakdown: {
        material: materialCost,
        engineering: engineeringCost,
        travel: travelCost,
        manufacturing: manufacturingCost,
        quality: qualityCost,
        logistics: logisticsCost,
        service: serviceCost,
        installation: installationCost,
        commissioning: commissioningCost,
        amc_revenue: amcRevenue,
      },
      total_cost: totalCost,
      actual_profit: actualProfit,
      gross_margin_pct: parseFloat(margin),
      cost_lines_breakdown: costBreakdown,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/all ───────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE p.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT p.id, p.project_name, NULL::text AS project_number, p.customer_name,
             COALESCE(p.budget_amount, p.budget, pcs.total_revenue, 0) AS revenue,
             COALESCE(pcs.material_cost, 0) AS material_cost,
             COALESCE(pcs.labour_cost, 0) AS labour_cost,
             COALESCE(pcs.travel_cost, 0) AS travel_cost,
             COALESCE(pcs.procurement_overhead, 0) AS overhead,
             COALESCE(pcs.profit, 0) AS actual_profit,
             CASE WHEN COALESCE(p.budget_amount, p.budget, 0) > 0
               THEN ROUND((COALESCE(pcs.profit,0) / NULLIF(COALESCE(p.budget_amount, p.budget, 0), 0)) * 100, 2)
               ELSE 0 END AS margin_pct,
             p.status
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
      ${cFilter}
      ORDER BY revenue DESC LIMIT 50
    `);
    res.json(rows.map(r => ({
      ...r,
      revenue: parseFloat(r.revenue || 0),
      material_cost: parseFloat(r.material_cost || 0),
      labour_cost: parseFloat(r.labour_cost || 0),
      travel_cost: parseFloat(r.travel_cost || 0),
      overhead: parseFloat(r.overhead || 0),
      actual_profit: parseFloat(r.actual_profit || 0),
      margin_pct: parseFloat(r.margin_pct || 0),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/top-customers ──────────────────────────────────
router.get('/top-customers', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT customer_name,
             COUNT(*) AS project_count,
             COALESCE(SUM(contract_value),0) AS total_revenue,
             COALESCE(AVG(CASE WHEN contract_value > 0
               THEN (SELECT COALESCE(pcs.actual_profit,0) / p2.contract_value * 100
                     FROM project_cost_summary pcs WHERE pcs.project_id=p.id LIMIT 1) END), 0)::numeric(5,2) AS avg_margin
      FROM projects p
      ${cFilter}
      GROUP BY customer_name
      ORDER BY total_revenue DESC LIMIT 10
    `);
    res.json(rows.map(r => ({ ...r, total_revenue: parseFloat(r.total_revenue || 0), avg_margin: parseFloat(r.avg_margin || 0) })));
  } catch { res.json([]); }
});

// ── GET /project-profitability/dashboard-kpis ────────────────────────────────
router.get('/dashboard-kpis', async (req, res) => {
  try {
    const companyId = cid(req);
    const cWhere = companyId ? `WHERE p.company_id=${companyId}` : '';
    const [overview, costLineAgg, statusBreakdown] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_projects,
          COALESCE(SUM(p.contract_value),0) AS total_revenue,
          COALESCE(SUM(pcs.material_cost + pcs.labour_cost + pcs.travel_cost + pcs.procurement_overhead),0) AS total_cost,
          COALESCE(AVG(CASE WHEN p.contract_value > 0 THEN pcs.actual_profit / p.contract_value * 100 END),0) AS avg_margin_pct,
          COUNT(CASE WHEN pcs.actual_profit < 0 THEN 1 END) AS loss_making_count,
          COUNT(CASE WHEN p.status = 'active' THEN 1 END) AS active_count
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
        ${cWhere}
      `).catch(() => ({ rows: [{ total_projects:0, total_revenue:0, total_cost:0, avg_margin_pct:0, loss_making_count:0, active_count:0 }] })),
      pool.query(`
        SELECT cost_type, SUM(amount) AS total
        FROM project_cost_lines
        ${companyId ? `WHERE company_id=${companyId}` : ''}
        GROUP BY cost_type ORDER BY total DESC
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(contract_value),0) AS revenue
        FROM projects p ${cWhere}
        GROUP BY status
      `).catch(() => ({ rows: [] })),
    ]);
    const o = overview.rows[0];
    res.json({
      total_projects:      parseInt(o.total_projects || 0),
      total_revenue:       parseFloat(o.total_revenue || 0),
      total_cost:          parseFloat(o.total_cost || 0),
      actual_profit:       parseFloat(o.total_revenue || 0) - parseFloat(o.total_cost || 0),
      avg_margin_pct:      parseFloat(o.avg_margin_pct || 0).toFixed(2),
      loss_making_count:   parseInt(o.loss_making_count || 0),
      active_count:        parseInt(o.active_count || 0),
      cost_type_breakdown: costLineAgg.rows.map(r => ({ cost_type: r.cost_type, total: parseFloat(r.total || 0) })),
      status_breakdown:    statusBreakdown.rows.map(r => ({ status: r.status, count: parseInt(r.count), revenue: parseFloat(r.revenue || 0) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/budget-vs-actual ──────────────────────────────
router.get('/budget-vs-actual', async (req, res) => {
  try {
    const companyId = cid(req);
    const cWhere = companyId ? `WHERE p.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT p.id, p.name AS project_name, p.project_number, p.customer_name,
             COALESCE(p.contract_value, 0) AS budget_revenue,
             COALESCE(p.budget, p.contract_value, 0) AS budget_cost,
             COALESCE(pcs.material_cost,0) + COALESCE(pcs.labour_cost,0) + COALESCE(pcs.travel_cost,0) + COALESCE(pcs.procurement_overhead,0) AS actual_cost,
             COALESCE(pcs.profit, 0) AS actual_profit,
             p.status
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
      ${cWhere}
      ORDER BY budget_revenue DESC LIMIT 20
    `).catch(() => ({ rows: [] }));
    res.json(rows.map(r => ({
      ...r,
      budget_revenue: parseFloat(r.budget_revenue || 0),
      budget_cost:    parseFloat(r.budget_cost || 0),
      actual_cost:    parseFloat(r.actual_cost || 0),
      actual_profit:  parseFloat(r.actual_profit || 0),
      variance:       parseFloat(r.budget_cost || 0) - parseFloat(r.actual_cost || 0),
      variance_pct:   parseFloat(r.budget_cost || 0) > 0
        ? (((parseFloat(r.budget_cost || 0) - parseFloat(r.actual_cost || 0)) / parseFloat(r.budget_cost || 0)) * 100).toFixed(1)
        : 0,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/loss-makers ───────────────────────────────────
router.get('/loss-makers', async (req, res) => {
  try {
    const companyId = cid(req);
    const cWhere = companyId ? `WHERE p.company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT p.id, p.name AS project_name, p.project_number, p.customer_name, p.status,
             COALESCE(p.contract_value, 0) AS revenue,
             COALESCE(pcs.material_cost,0)+COALESCE(pcs.labour_cost,0)+COALESCE(pcs.travel_cost,0)+COALESCE(pcs.procurement_overhead,0) AS total_cost,
             COALESCE(pcs.profit, 0) AS actual_profit,
             CASE WHEN COALESCE(p.contract_value,0) > 0
               THEN ROUND((COALESCE(pcs.actual_profit,0) / p.contract_value) * 100, 2)
               ELSE 0 END AS margin_pct
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
      ${cWhere}
      HAVING (COALESCE(pcs.actual_profit, 0) < 0 OR (COALESCE(pcs.material_cost,0)+COALESCE(pcs.labour_cost,0)) > COALESCE(p.contract_value,0)*0.9)
      ORDER BY actual_profit ASC LIMIT 10
    `).catch(() => ({ rows: [] }));
    res.json(rows.map(r => ({
      ...r,
      revenue:       parseFloat(r.revenue || 0),
      total_cost:    parseFloat(r.total_cost || 0),
      actual_profit: parseFloat(r.actual_profit || 0),
      margin_pct:    parseFloat(r.margin_pct || 0),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /project-profitability/cost-lines/:id (update) ───────────────────────
router.put('/cost-lines/:id', async (req, res) => {
  try {
    const { amount, description, cost_date, cost_type } = req.body;
    const { rows: [cl] } = await pool.query(`
      UPDATE project_cost_lines SET amount=$1, description=$2, cost_date=$3, cost_type=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [amount, description, cost_date, cost_type, req.params.id]);
    if (!cl) return res.status(404).json({ error: 'Not found' });
    logAudit({ userId: uid(req), module: 'project_profitability', recordId: cl.id, recordType: 'cost_line', action: 'update', newData: cl });
    res.json(cl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/cost-lines/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM project_cost_lines WHERE id=$1`, [req.params.id]);
    logAudit({ userId: uid(req), module: 'project_profitability', recordId: req.params.id, recordType: 'cost_line', action: 'delete' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
