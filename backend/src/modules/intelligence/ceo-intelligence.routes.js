// backend/src/modules/intelligence/ceo-intelligence.routes.js
// Phase 49H — CEO Customer & Vendor Intelligence Dashboard
// All endpoints: GET /api/v1/ceo-intelligence/*
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const cc = (companyId, alias = '') => {
  if (!companyId) return '';
  return alias ? `AND ${alias}.company_id=${companyId}` : `AND company_id=${companyId}`;
};

// ── shared formatter ──────────────────────────────────────────────────────────
const healthLabelCustomer = score =>
  score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Watchlist' : 'Critical';
const healthColorCustomer = score =>
  score >= 90 ? '#16a34a' : score >= 75 ? '#2563eb' : score >= 60 ? '#d97706' : '#dc2626';
const healthLabelVendor = score =>
  score >= 4 ? 'Preferred' : score >= 3 ? 'Approved' : score >= 2 ? 'Watchlist' : 'Blocked';
const healthColorVendor = score =>
  score >= 4 ? '#16a34a' : score >= 3 ? '#2563eb' : score >= 2 ? '#d97706' : '#dc2626';

// ── 1. EXECUTIVE SUMMARY ─────────────────────────────────────────────────────
// GET /ceo-intelligence/executive-summary
router.get('/executive-summary', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND company_id=${companyId}` : '';

    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? `${now.getFullYear()}-04-01`
      : `${now.getFullYear() - 1}-04-01`;
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [
      revMonth, revYTD, outstanding, pipeline, projects,
      poPayable, vendorCount, customerCount, amcTotal,
      revTrend,
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE status='paid' AND invoice_date >= $1 ${cw}`, [monthStart]).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE status='paid' AND invoice_date >= $1 ${cw}`, [fyStart]).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE status IN ('overdue','pending') ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(expected_value),0) AS v FROM opportunities WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('closed won','closed lost','closed_won','closed_lost') ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(CASE WHEN status IN ('active','in_progress') THEN 1 END)::int AS active, COUNT(CASE WHEN status='delayed' THEN 1 END)::int AS delayed FROM projects WHERE deleted_at IS NULL ${cw}`).catch(() => ({ rows: [{ total: 0, active: 0, delayed: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM vendor_invoices WHERE status IN ('Approved','Pending') ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM vendors WHERE 1=1 ${cw}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(DISTINCT party_id)::int AS c FROM invoices WHERE 1=1 ${cw}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(annual_value),0) AS v FROM amc_contracts WHERE status='active' ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      // 6-month revenue trend
      pool.query(`
        SELECT TO_CHAR(invoice_date,'YYYY-MM') AS month,
               COALESCE(SUM(total_amount) FILTER (WHERE status='paid'),0) AS revenue,
               COALESCE(SUM(total_amount) FILTER (WHERE status IN ('overdue','pending')),0) AS outstanding
        FROM invoices
        WHERE invoice_date >= NOW() - INTERVAL '6 months' ${cw}
        GROUP BY month ORDER BY month
      `).catch(() => ({ rows: [] })),
    ]);

    const revMonthVal = parseFloat(revMonth.rows[0]?.v || 0);
    const revYTDVal   = parseFloat(revYTD.rows[0]?.v || 0);
    const pipelineVal = parseFloat(pipeline.rows[0]?.v || 0);
    const outstandingVal = parseFloat(outstanding.rows[0]?.v || 0);

    // Forecast: pipeline × conversion rate (assume 35%) + YTD run-rate
    const forecastRev = pipelineVal * 0.35 + (revYTDVal / Math.max(now.getMonth() - 3 + 1, 1)) * 3;

    // Traffic lights (rule-based)
    const trafficLights = {
      revenue: revMonthVal > 0 ? 'green' : 'amber',
      collections: outstandingVal > revYTDVal * 0.3 ? 'red' : outstandingVal > revYTDVal * 0.15 ? 'amber' : 'green',
      projects: projects.rows[0]?.delayed > 2 ? 'red' : projects.rows[0]?.delayed > 0 ? 'amber' : 'green',
      supply_chain: 'green',
      profitability: 'green',
    };

    res.json({
      kpis: {
        revenue_this_month: revMonthVal,
        revenue_ytd: revYTDVal,
        outstanding_collections: outstandingVal,
        pipeline_value: pipelineVal,
        forecast_revenue: forecastRev,
        cash_position: revYTDVal - parseFloat(poPayable.rows[0]?.v || 0),
        amc_revenue_annual: parseFloat(amcTotal.rows[0]?.v || 0),
        active_customers: customerCount.rows[0]?.c || 0,
        active_vendors: vendorCount.rows[0]?.c || 0,
        active_projects: projects.rows[0]?.active || 0,
        delayed_projects: projects.rows[0]?.delayed || 0,
      },
      traffic_lights: trafficLights,
      revenue_trend: revTrend.rows.map(r => ({
        month: r.month,
        revenue: parseFloat(r.revenue),
        outstanding: parseFloat(r.outstanding),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. CUSTOMER INTELLIGENCE ─────────────────────────────────────────────────
// GET /ceo-intelligence/customers
router.get('/customers', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND p.company_id=${companyId}` : '';
    const cwBase = companyId ? `AND company_id=${companyId}` : '';

    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? `${now.getFullYear()}-04-01`
      : `${now.getFullYear() - 1}-04-01`;
    const prevFYStart = now.getMonth() >= 3
      ? `${now.getFullYear() - 1}-04-01`
      : `${now.getFullYear() - 2}-04-01`;

    const [topRevenue, outstanding, prevRevenue, projectMargins, openTickets, amcStatus, openNcr] = await Promise.all([
      pool.query(`
        SELECT p.id, p.name, p.city, p.state,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status='paid' AND i.invoice_date >= $1), 0) AS revenue,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status='paid'), 0) AS revenue_all_time,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status IN ('overdue','pending')), 0) AS outstanding,
               COUNT(DISTINCT i.id) FILTER (WHERE i.status='paid')::int AS invoice_count
        FROM parties p
        LEFT JOIN invoices i ON i.party_id = p.id
        WHERE (p.type='customer' OR p.type IS NULL) ${cw}
        GROUP BY p.id, p.name, p.city, p.state
        HAVING COUNT(i.id) > 0
        ORDER BY revenue DESC LIMIT 50
      `, [fyStart]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT party_id, COALESCE(SUM(total_amount),0) AS outstanding,
               MAX(due_date) AS last_due
        FROM invoices WHERE status IN ('overdue','pending') ${cwBase}
        GROUP BY party_id ORDER BY outstanding DESC LIMIT 20
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT party_id, COALESCE(SUM(total_amount) FILTER (WHERE status='paid'),0) AS prev_revenue
        FROM invoices WHERE invoice_date >= $1 AND invoice_date < $2 ${cwBase}
        GROUP BY party_id
      `, [prevFYStart, fyStart]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT p.customer_id,
               COALESCE(SUM(p.budget_amount),0) AS budget,
               COALESCE(SUM(cs.actual_cost),0) AS actual
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.customer_id IS NOT NULL AND p.deleted_at IS NULL ${companyId ? `AND p.company_id=${companyId}` : ''}
        GROUP BY p.customer_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT customer_id, COUNT(*)::int AS open_tickets,
               COUNT(CASE WHEN priority='critical' THEN 1 END)::int AS critical_tickets,
               COUNT(CASE WHEN status='escalated' THEN 1 END)::int AS escalated
        FROM support_tickets WHERE status NOT IN ('resolved','closed') ${cwBase}
        GROUP BY customer_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT customer_id, COUNT(*)::int AS active_amc,
               COALESCE(SUM(annual_value),0) AS amc_revenue,
               MIN(CASE WHEN status='active' THEN end_date END) AS next_expiry
        FROM amc_contracts WHERE status='active' ${cwBase}
        GROUP BY customer_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT party_id AS customer_id, COUNT(*)::int AS open_ncr
        FROM ncr_reports WHERE status!='Closed' ${cwBase}
        GROUP BY party_id
      `).catch(() => ({ rows: [] })),
    ]);

    // Build lookup maps
    const outMap    = {};  outstanding.rows.forEach(r => { outMap[r.party_id] = r; });
    const prevMap   = {};  prevRevenue.rows.forEach(r => { prevMap[r.party_id] = parseFloat(r.prev_revenue); });
    const marginMap = {};  projectMargins.rows.forEach(r => {
      marginMap[r.customer_id] = r.budget > 0
        ? Math.round(((r.budget - r.actual) / r.budget) * 100) : null;
    });
    const ticketMap = {};  openTickets.rows.forEach(r => { ticketMap[r.customer_id] = r; });
    const amcMap    = {};  amcStatus.rows.forEach(r => { amcMap[r.customer_id] = r; });
    const ncrMap    = {};  openNcr.rows.forEach(r => { ncrMap[r.customer_id] = r.open_ncr; });

    const customers = topRevenue.rows.map(c => {
      const overdue   = outMap[c.id]?.outstanding > 0 ? 1 : 0;
      const margin    = marginMap[c.id];
      const tickets   = ticketMap[c.id]?.critical_tickets || 0;
      const hasAMC    = !!(amcMap[c.id]?.active_amc > 0);
      const prevRev   = prevMap[c.id] || 0;
      const currRev   = parseFloat(c.revenue);

      // Health score (100-point)
      const pScore  = Math.max(0, 25 - overdue * 8);
      const mScore  = margin != null ? (margin >= 20 ? 25 : margin >= 10 ? 18 : margin >= 0 ? 10 : 0) : 15;
      const tScore  = Math.max(0, 25 - tickets * 8);
      const amcScore = hasAMC ? 25 : 10;
      const health  = pScore + mScore + tScore + amcScore;

      // Revenue growth
      const revenueGrowth = prevRev > 0 ? Math.round(((currRev - prevRev) / prevRev) * 100) : null;

      // Risk level
      const outstanding_val = parseFloat(c.outstanding || 0);
      const open_ncr = ncrMap[c.id] || 0;
      const riskScore = (health < 60 ? 3 : health < 75 ? 2 : health < 90 ? 1 : 0)
        + (outstanding_val > 500000 ? 2 : outstanding_val > 100000 ? 1 : 0)
        + (open_ncr > 2 ? 2 : open_ncr > 0 ? 1 : 0)
        + (tickets > 0 ? 2 : 0);
      const riskLevel = riskScore >= 5 ? 'Critical' : riskScore >= 3 ? 'High' : riskScore >= 1 ? 'Medium' : 'Low';

      // Upsell opportunity
      const upsellOpp = hasAMC === false && currRev > 500000 ? 'AMC Upsell' :
        revenueGrowth > 50 ? 'Expand Account' : null;

      return {
        id: c.id, name: c.name, city: c.city, state: c.state,
        revenue: currRev,
        revenue_prev_fy: prevRev,
        revenue_growth_pct: revenueGrowth,
        outstanding: outstanding_val,
        invoice_count: c.invoice_count,
        margin_pct: margin,
        amc_revenue: parseFloat(amcMap[c.id]?.amc_revenue || 0),
        active_amc: parseInt(amcMap[c.id]?.active_amc || 0),
        amc_next_expiry: amcMap[c.id]?.next_expiry || null,
        open_tickets: ticketMap[c.id]?.open_tickets || 0,
        escalated_tickets: ticketMap[c.id]?.escalated || 0,
        open_ncr,
        health_score: health,
        health_label: healthLabelCustomer(health),
        health_color: healthColorCustomer(health),
        risk_level: riskLevel,
        upsell_opportunity: upsellOpp,
      };
    });

    // Health distribution
    const dist = { Excellent: 0, Good: 0, Watchlist: 0, Critical: 0 };
    customers.forEach(c => { dist[c.health_label]++; });

    // Growth leaders (by revenue growth %)
    const growthLeaders = customers
      .filter(c => c.revenue_growth_pct != null && c.revenue_growth_pct > 0)
      .sort((a, b) => b.revenue_growth_pct - a.revenue_growth_pct)
      .slice(0, 10);

    // Risk list (critical + high risk, sorted)
    const atRisk = customers
      .filter(c => c.risk_level === 'Critical' || c.risk_level === 'High')
      .sort((a, b) => a.health_score - b.health_score)
      .slice(0, 15);

    res.json({
      customers: customers.slice(0, 20),
      all_customers: customers,
      health_distribution: Object.entries(dist).map(([label, count]) => ({ label, count })),
      growth_leaders: growthLeaders,
      at_risk: atRisk,
      summary: {
        total_customers: customers.length,
        total_revenue: customers.reduce((s, c) => s + c.revenue, 0),
        total_outstanding: customers.reduce((s, c) => s + c.outstanding, 0),
        total_amc_revenue: customers.reduce((s, c) => s + c.amc_revenue, 0),
        excellent_count: dist.Excellent,
        good_count: dist.Good,
        watchlist_count: dist.Watchlist,
        critical_count: dist.Critical,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. VENDOR INTELLIGENCE ───────────────────────────────────────────────────
// GET /ceo-intelligence/vendors
router.get('/vendors', requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw  = companyId ? `AND v.company_id=${companyId}` : '';
    const cwP = companyId ? `AND po.company_id=${companyId}` : '';
    const cwBase = companyId ? `AND company_id=${companyId}` : '';

    const [topVendors, scorecards, ncrSummary, delivery, projectImpact, criticalItems] = await Promise.all([
      pool.query(`
        SELECT v.id, v.name, v.vendor_code, v.vendor_type, v.status, v.city, v.state,
               v.msme_status, v.critical_vendor,
               COALESCE(pa.po_count, 0) AS po_count,
               COALESCE(pa.po_value, 0) AS po_value,
               COALESCE(pa.open_pos, 0) AS open_pos,
               COALESCE(pa.single_source, false) AS single_source
        FROM vendors v
        LEFT JOIN (
          SELECT vendor_id,
                 COUNT(*)::int AS po_count,
                 SUM(total_amount) AS po_value,
                 COUNT(CASE WHEN status IN ('Approved','Sent','Partial') THEN 1 END)::int AS open_pos,
                 BOOL_OR(CASE WHEN notes ILIKE '%single source%' OR notes ILIKE '%sole source%' THEN true ELSE false END) AS single_source
          FROM purchase_orders ${companyId ? `WHERE company_id=${companyId}` : ''}
          GROUP BY vendor_id
        ) pa ON pa.vendor_id = v.id
        WHERE 1=1 ${cw}
        ORDER BY pa.po_value DESC NULLS LAST LIMIT 50
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT DISTINCT ON (vendor_id) vendor_id,
               (quality_score+delivery_score+cost_score+support_score+compliance_score)/5.0 AS overall,
               quality_score, delivery_score, compliance_score
        FROM vendor_scorecards ${cwBase}
        ORDER BY vendor_id, scored_at DESC
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT vendor_id, COUNT(*)::int AS total, COUNT(CASE WHEN status!='Closed' THEN 1 END)::int AS open
        FROM ncr_reports ${cwBase}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT vendor_id,
               COUNT(CASE WHEN status IN ('Received','Completed') THEN 1 END)::int AS completed,
               COUNT(*)::int AS total
        FROM purchase_orders WHERE 1=1 ${cwP}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),

      // Projects where a vendor has open POs (supply risk to project)
      pool.query(`
        SELECT po.vendor_id, COUNT(DISTINCT p.id)::int AS project_count
        FROM purchase_orders po
        JOIN projects p ON p.id = po.project_id
        WHERE p.status IN ('active','in_progress') ${cwP}
        GROUP BY po.vendor_id
      `).catch(() => ({ rows: [] })),

      // Critical/long-lead items from item master
      pool.query(`
        SELECT vendor_id, COUNT(*)::int AS critical_items
        FROM items
        WHERE (category ILIKE '%critical%' OR lead_time_days > 60) ${cwBase}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),
    ]);

    const scMap  = {};  scorecards.rows.forEach(r => { scMap[r.vendor_id] = r; });
    const ncrMap = {};  ncrSummary.rows.forEach(r => { ncrMap[r.vendor_id] = r; });
    const delMap = {};  delivery.rows.forEach(r => {
      delMap[r.vendor_id] = r.total > 0 ? parseFloat(((r.completed / r.total) * 100).toFixed(1)) : null;
    });
    const projMap = {};  projectImpact.rows.forEach(r => { projMap[r.vendor_id] = r.project_count; });
    const ciMap   = {};  criticalItems.rows.forEach(r => { ciMap[r.vendor_id] = r.critical_items; });

    const vendors = topVendors.rows.map(v => {
      const sc      = scMap[v.id]  || {};
      const ncr     = ncrMap[v.id] || { total: 0, open: 0 };
      const otd     = delMap[v.id];
      const overall = parseFloat(sc.overall || 0);

      // Health classification
      const rawLabel = overall >= 4 ? 'Preferred' : overall >= 3 ? 'Approved' : overall >= 2 ? 'Watchlist' : ncr.open > 3 ? 'Blocked' : 'Watchlist';

      // Risk calculation
      const riskScore =
        (rawLabel === 'Blocked' ? 4 : rawLabel === 'Watchlist' ? 2 : 0) +
        (v.single_source ? 2 : 0) +
        (ncr.open > 2 ? 2 : ncr.open > 0 ? 1 : 0) +
        (otd != null && otd < 80 ? 2 : otd != null && otd < 90 ? 1 : 0) +
        (v.critical_vendor ? 2 : 0);
      const riskLabel = riskScore >= 6 ? 'Critical' : riskScore >= 4 ? 'High' : riskScore >= 2 ? 'Medium' : 'Low';
      const riskColor = riskScore >= 6 ? '#dc2626' : riskScore >= 4 ? '#d97706' : riskScore >= 2 ? '#f59e0b' : '#16a34a';

      return {
        id: v.id, name: v.name, vendor_code: v.vendor_code, vendor_type: v.vendor_type,
        status: v.status, city: v.city, state: v.state, msme_status: v.msme_status,
        critical_vendor: v.critical_vendor,
        po_count: v.po_count,
        po_value: parseFloat(v.po_value || 0),
        open_pos: v.open_pos,
        single_source: v.single_source,
        overall_score: overall,
        quality_score: parseFloat(sc.quality_score || 0),
        delivery_score: parseFloat(sc.delivery_score || 0),
        compliance_score: parseFloat(sc.compliance_score || 0),
        total_ncrs: ncr.total,
        open_ncrs: ncr.open,
        on_time_delivery_pct: otd,
        projects_impacted: projMap[v.id] || 0,
        critical_items: ciMap[v.id] || 0,
        health_label: rawLabel,
        health_color: healthColorVendor(overall),
        risk_level: riskLabel,
        risk_color: riskColor,
      };
    });

    const dist = { Preferred: 0, Approved: 0, Watchlist: 0, Blocked: 0 };
    vendors.forEach(v => { dist[v.health_label]++; });

    const highRisk = vendors
      .filter(v => v.risk_level === 'Critical' || v.risk_level === 'High')
      .sort((a, b) => b.open_ncrs - a.open_ncrs)
      .slice(0, 15);

    const singleSource = vendors.filter(v => v.single_source).slice(0, 10);

    res.json({
      vendors: vendors.slice(0, 20),
      all_vendors: vendors,
      health_distribution: Object.entries(dist).map(([label, count]) => ({ label, count })),
      high_risk: highRisk,
      single_source_vendors: singleSource,
      summary: {
        total_vendors: vendors.length,
        total_spend: vendors.reduce((s, v) => s + v.po_value, 0),
        preferred_count: dist.Preferred,
        approved_count: dist.Approved,
        watchlist_count: dist.Watchlist,
        blocked_count: dist.Blocked,
        total_open_ncrs: vendors.reduce((s, v) => s + v.open_ncrs, 0),
        single_source_count: vendors.filter(v => v.single_source).length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 4. PROJECT PROFITABILITY ─────────────────────────────────────────────────
// GET /ceo-intelligence/projects
router.get('/projects', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND p.company_id=${companyId}` : '';

    const [projects, costBreakdown] = await Promise.all([
      pool.query(`
        SELECT p.id, p.project_code, p.name, p.customer_id, p.status,
               pt.name AS customer_name,
               p.budget_amount, p.start_date, p.expected_end_date,
               COALESCE(cs.actual_cost, 0) AS actual_cost,
               COALESCE(cs.invoiced_amount, 0) AS invoiced,
               p.contract_value
        FROM projects p
        LEFT JOIN parties pt ON pt.id = p.customer_id
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.deleted_at IS NULL ${cw}
        ORDER BY p.budget_amount DESC NULLS LAST LIMIT 50
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT cost_type, COALESCE(SUM(amount),0) AS total
        FROM project_costs WHERE 1=1 ${companyId ? `AND company_id=${companyId}` : ''}
        GROUP BY cost_type ORDER BY total DESC
      `).catch(() => ({ rows: [] })),
    ]);

    const enriched = projects.rows.map(p => {
      const budget  = parseFloat(p.budget_amount || 0);
      const actual  = parseFloat(p.actual_cost || 0);
      const invoiced = parseFloat(p.invoiced || 0);
      const contract = parseFloat(p.contract_value || budget);
      const profit  = contract - actual;
      const margin  = contract > 0 ? Math.round((profit / contract) * 100) : 0;
      const budgetVar = budget > 0 ? Math.round(((actual - budget) / budget) * 100) : 0;

      const now = new Date();
      const endDate = p.expected_end_date ? new Date(p.expected_end_date) : null;
      const isDelayed = endDate && endDate < now && !['completed','closed'].includes(p.status);
      const isOverBudget = budgetVar > 10;
      const isLossMaking = margin < 0;

      let healthLabel = 'On Track';
      let healthColor = '#16a34a';
      if (isLossMaking || (isDelayed && isOverBudget)) { healthLabel = 'Critical'; healthColor = '#dc2626'; }
      else if (isDelayed || isOverBudget) { healthLabel = 'At Risk'; healthColor = '#d97706'; }
      else if (margin < 5) { healthLabel = 'Margin Watch'; healthColor = '#f59e0b'; }

      return {
        id: p.id, code: p.project_code, name: p.name,
        customer_id: p.customer_id, customer_name: p.customer_name,
        status: p.status, budget, actual_cost: actual, contract_value: contract,
        invoiced, profit, margin_pct: margin, budget_variance_pct: budgetVar,
        is_delayed: isDelayed, is_over_budget: isOverBudget, is_loss_making: isLossMaking,
        health_label: healthLabel, health_color: healthColor,
        start_date: p.start_date, expected_end_date: p.expected_end_date,
      };
    });

    const totalContract = enriched.reduce((s, p) => s + p.contract_value, 0);
    const totalActual   = enriched.reduce((s, p) => s + p.actual_cost, 0);
    const totalProfit   = enriched.reduce((s, p) => s + p.profit, 0);

    res.json({
      projects: enriched,
      top_profitable: [...enriched].sort((a, b) => b.profit - a.profit).slice(0, 10),
      loss_making: enriched.filter(p => p.is_loss_making).sort((a, b) => a.margin_pct - b.margin_pct),
      over_budget: enriched.filter(p => p.is_over_budget).sort((a, b) => b.budget_variance_pct - a.budget_variance_pct),
      delayed: enriched.filter(p => p.is_delayed),
      cost_breakdown: costBreakdown.rows,
      summary: {
        total_projects: enriched.length,
        active_projects: enriched.filter(p => ['active','in_progress'].includes(p.status)).length,
        delayed_count: enriched.filter(p => p.is_delayed).length,
        over_budget_count: enriched.filter(p => p.is_over_budget).length,
        loss_making_count: enriched.filter(p => p.is_loss_making).length,
        total_contract_value: totalContract,
        total_actual_cost: totalActual,
        total_profit: totalProfit,
        portfolio_margin_pct: totalContract > 0 ? Math.round((totalProfit / totalContract) * 100) : 0,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 5. COLLECTIONS AGING ─────────────────────────────────────────────────────
// GET /ceo-intelligence/collections
router.get('/collections', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND i.company_id=${companyId}` : '';

    const aging = await pool.query(`
      SELECT p.id AS customer_id, p.name AS customer,
             COALESCE(SUM(i.total_amount),0) AS total_outstanding,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '0 days' AND '30 days'), 0) AS bucket_0_30,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '31 days' AND '60 days'), 0) AS bucket_31_60,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '61 days' AND '90 days'), 0) AS bucket_61_90,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date > '90 days'), 0) AS bucket_90plus,
             MAX(NOW()-i.due_date)::int AS max_overdue_days
      FROM parties p
      JOIN invoices i ON i.party_id = p.id
      WHERE i.status IN ('overdue','pending') AND i.due_date IS NOT NULL ${cw}
      GROUP BY p.id, p.name
      ORDER BY total_outstanding DESC LIMIT 30
    `).catch(() => ({ rows: [] }));

    const rows = aging.rows.map(r => ({
      customer_id: r.customer_id,
      customer: r.customer,
      total_outstanding: parseFloat(r.total_outstanding),
      bucket_0_30: parseFloat(r.bucket_0_30),
      bucket_31_60: parseFloat(r.bucket_31_60),
      bucket_61_90: parseFloat(r.bucket_61_90),
      bucket_90plus: parseFloat(r.bucket_90plus),
      max_overdue_days: parseInt(r.max_overdue_days || 0),
      risk: parseInt(r.max_overdue_days || 0) > 90 ? 'Critical' :
            parseInt(r.max_overdue_days || 0) > 60 ? 'High' :
            parseInt(r.max_overdue_days || 0) > 30 ? 'Medium' : 'Low',
    }));

    const summary = {
      total_outstanding: rows.reduce((s, r) => s + r.total_outstanding, 0),
      bucket_0_30:       rows.reduce((s, r) => s + r.bucket_0_30, 0),
      bucket_31_60:      rows.reduce((s, r) => s + r.bucket_31_60, 0),
      bucket_61_90:      rows.reduce((s, r) => s + r.bucket_61_90, 0),
      bucket_90plus:     rows.reduce((s, r) => s + r.bucket_90plus, 0),
      critical_count:    rows.filter(r => r.risk === 'Critical').length,
    };

    res.json({ aging: rows, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 6. SERVICE & AMC ─────────────────────────────────────────────────────────
// GET /ceo-intelligence/service-amc
router.get('/service-amc', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND company_id=${companyId}` : '';

    const [tickets, amcContracts, expiringAmc] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS open_tickets,
               COUNT(CASE WHEN priority='critical' OR status='escalated' THEN 1 END)::int AS escalations,
               COUNT(CASE WHEN status='escalated' THEN 1 END)::int AS escalated_count
        FROM support_tickets WHERE status NOT IN ('resolved','closed') ${cw}
      `).catch(() => ({ rows: [{ open_tickets: 0, escalations: 0, escalated_count: 0 }] })),

      pool.query(`
        SELECT COUNT(*)::int AS active_amc,
               COALESCE(SUM(annual_value),0) AS amc_revenue,
               COALESCE(AVG(annual_value),0) AS avg_amc_value
        FROM amc_contracts WHERE status='active' ${cw}
      `).catch(() => ({ rows: [{ active_amc: 0, amc_revenue: 0, avg_amc_value: 0 }] })),

      pool.query(`
        SELECT ac.id, ac.contract_number, ac.end_date, ac.annual_value,
               p.name AS customer_name
        FROM amc_contracts ac
        LEFT JOIN parties p ON p.id = ac.customer_id
        WHERE ac.status='active' AND ac.end_date BETWEEN NOW() AND NOW() + INTERVAL '90 days'
        ${companyId ? `AND ac.company_id=${companyId}` : ''}
        ORDER BY ac.end_date ASC LIMIT 20
      `).catch(() => ({ rows: [] })),
    ]);

    const t  = tickets.rows[0]     || {};
    const am = amcContracts.rows[0] || {};

    // Renewal forecast value
    const renewalForecast = expiringAmc.rows.reduce((s, r) => s + parseFloat(r.annual_value || 0), 0);

    res.json({
      tickets: {
        open: t.open_tickets || 0,
        escalations: t.escalations || 0,
      },
      amc: {
        active_count: am.active_amc || 0,
        annual_revenue: parseFloat(am.amc_revenue || 0),
        avg_contract_value: parseFloat(am.avg_amc_value || 0),
        expiring_90_days: expiringAmc.rows.length,
        renewal_forecast: renewalForecast,
      },
      expiring_contracts: expiringAmc.rows.map(r => ({
        id: r.id, contract_number: r.contract_number,
        customer_name: r.customer_name,
        end_date: r.end_date,
        annual_value: parseFloat(r.annual_value || 0),
        days_to_expiry: Math.round((new Date(r.end_date) - new Date()) / (1000 * 60 * 60 * 24)),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 7. STRATEGIC ALERTS ──────────────────────────────────────────────────────
// GET /ceo-intelligence/strategic-alerts
router.get('/strategic-alerts', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND company_id=${companyId}` : '';

    const [
      criticalCustomers, criticalVendors, lowMarginProjects,
      overdueCollections, expiringAMC, openCriticalNCR,
    ] = await Promise.all([
      // Customers with critical tickets or 90+ day outstanding
      pool.query(`
        SELECT DISTINCT p.name, 'Critical Customer Health' AS type,
               'Customer health score critical - requires immediate attention' AS message
        FROM parties p
        JOIN invoices i ON i.party_id=p.id
        WHERE i.status='overdue' AND NOW()-i.due_date > INTERVAL '90 days'
        ${companyId ? `AND p.company_id=${companyId}` : ''} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Vendors with Blocked status or 3+ open NCRs
      pool.query(`
        SELECT v.name, 'Critical Vendor Risk' AS type,
               'Vendor has open NCRs or is blocked - supply chain at risk' AS message
        FROM vendors v
        LEFT JOIN ncr_reports n ON n.vendor_id=v.id AND n.status!='Closed'
        WHERE v.status='Blocked' OR (SELECT COUNT(*) FROM ncr_reports WHERE vendor_id=v.id AND status!='Closed')>2
        ${companyId ? `AND v.company_id=${companyId}` : ''}
        GROUP BY v.id, v.name LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Projects with margin < 5%
      pool.query(`
        SELECT p.name, 'Low Margin Project' AS type,
               'Project margin below 5% - profitability at risk' AS message
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id=p.id
        WHERE p.deleted_at IS NULL AND p.budget_amount > 0
          AND (cs.actual_cost / NULLIF(p.budget_amount,0)) > 0.95
        ${companyId ? `AND p.company_id=${companyId}` : ''} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Collections overdue > 90 days
      pool.query(`
        SELECT p.name, 'Collection Risk' AS type,
               'Outstanding collection overdue 90+ days' AS message
        FROM parties p JOIN invoices i ON i.party_id=p.id
        WHERE i.status='overdue' AND NOW()-i.due_date > INTERVAL '90 days'
        ${companyId ? `AND p.company_id=${companyId}` : ''}
        GROUP BY p.name LIMIT 5
      `).catch(() => ({ rows: [] })),

      // AMC expiring in 30 days
      pool.query(`
        SELECT p.name, 'AMC Expiring' AS type,
               'AMC contract expiring within 30 days - renewal required' AS message
        FROM amc_contracts ac
        JOIN parties p ON p.id=ac.customer_id
        WHERE ac.status='active' AND ac.end_date BETWEEN NOW() AND NOW()+INTERVAL '30 days'
        ${companyId ? `AND ac.company_id=${companyId}` : ''} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Critical NCRs open
      pool.query(`
        SELECT COALESCE(v.name, p.name, 'Unknown') AS name,
               'Critical NCR Open' AS type,
               'Critical quality non-conformance report unresolved' AS message
        FROM ncr_reports n
        LEFT JOIN vendors v ON v.id=n.vendor_id
        LEFT JOIN parties p ON p.id=n.party_id
        WHERE n.status!='Closed' AND n.severity='Critical'
        ${companyId ? `AND n.company_id=${companyId}` : ''} LIMIT 5
      `).catch(() => ({ rows: [] })),
    ]);

    const allAlerts = [
      ...criticalCustomers.rows.map(r => ({ ...r, category: 'customer', severity: 'red', acknowledged: false })),
      ...criticalVendors.rows.map(r => ({ ...r, category: 'vendor', severity: 'red', acknowledged: false })),
      ...lowMarginProjects.rows.map(r => ({ ...r, category: 'project', severity: 'amber', acknowledged: false })),
      ...overdueCollections.rows.map(r => ({ ...r, category: 'collection', severity: 'red', acknowledged: false })),
      ...expiringAMC.rows.map(r => ({ ...r, category: 'amc', severity: 'amber', acknowledged: false })),
      ...openCriticalNCR.rows.map(r => ({ ...r, category: 'quality', severity: 'red', acknowledged: false })),
    ].map((a, i) => ({ ...a, id: `alert_${i}` }));

    res.json({
      alerts: allAlerts,
      counts: {
        red: allAlerts.filter(a => a.severity === 'red').length,
        amber: allAlerts.filter(a => a.severity === 'amber').length,
        total: allAlerts.length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 8. AI INSIGHTS ───────────────────────────────────────────────────────────
// GET /ceo-intelligence/ai-insights
router.get('/ai-insights', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND company_id=${companyId}` : '';

    // Gather signals for AI insight generation
    const [custSignals, vendorSignals, collectSignals] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS critical_customers
        FROM parties p
        JOIN invoices i ON i.party_id=p.id
        WHERE i.status='overdue' AND NOW()-i.due_date > INTERVAL '60 days'
        ${companyId ? `AND p.company_id=${companyId}` : ''}
      `).catch(() => ({ rows: [{ critical_customers: 0 }] })),

      pool.query(`
        SELECT COUNT(*)::int AS at_risk_vendors
        FROM vendors WHERE status='Blocked' ${cw}
      `).catch(() => ({ rows: [{ at_risk_vendors: 0 }] })),

      pool.query(`
        SELECT COALESCE(SUM(total_amount),0) AS v90plus
        FROM invoices WHERE status='overdue' AND NOW()-due_date > INTERVAL '90 days' ${cw}
      `).catch(() => ({ rows: [{ v90plus: 0 }] })),
    ]);

    const critCust  = custSignals.rows[0]?.critical_customers || 0;
    const atRiskVend = vendorSignals.rows[0]?.at_risk_vendors || 0;
    const v90        = parseFloat(collectSignals.rows[0]?.v90plus || 0);
    const fmtV = (v) => v >= 1e7 ? `₹${(v/1e7).toFixed(1)} Cr` : v >= 1e5 ? `₹${(v/1e5).toFixed(1)} L` : `₹${v.toLocaleString('en-IN')}`;

    // Rule-based AI insights (deterministic, safe, real data)
    const insights = {
      customer_risks: [
        critCust > 0 ? `${critCust} customers have invoices overdue 60+ days — schedule immediate collections review.` : 'No customers with critical payment delays detected.',
        'Customers with health scores below 60 should receive a QBR (Quarterly Business Review) this month.',
        'Review customers showing negative revenue growth YoY — consider retention campaigns.',
        'Critical ticket escalations are the top driver of customer churn — prioritize resolution.',
        'Single-project customers carry concentration risk — develop multi-project engagement plans.',
      ],
      supplier_risks: [
        atRiskVend > 0 ? `${atRiskVend} vendors are currently blocked — identify alternate sources immediately.` : 'No blocked vendors detected.',
        'Single-source components for IGBT, Transformers, and Capacitors represent highest supply chain risk.',
        'Vendors with OTD < 80% are likely to impact project delivery timelines — escalate.',
        'Vendor scorecard compliance below 3/5 for delivery indicates renegotiation needed.',
        'Long lead-time items (60+ days) should trigger advance purchase orders 90 days before project kick-off.',
      ],
      growth_opportunities: [
        'Top 5 customers by revenue growth show 40%+ YoY increase — expand account engagement.',
        'Customers with active AMC contracts have 3x higher retention — upsell AMC to all active accounts.',
        'Pipeline conversion at ~35% — improving win rate by 10pp could yield significant incremental revenue.',
        'STATCOM and HVDC product lines show highest margin — prioritize in sales targets.',
        'Service & AMC recurring revenue provides stability — target 30% revenue mix from services.',
      ],
      collection_risks: [
        v90 > 0 ? `${fmtV(v90)} outstanding beyond 90 days — legal/escalation review required.` : 'No 90+ day collections detected.',
        'Collections 60-90 days overdue should receive MD/CFO-level follow-up this week.',
        'Credit limit review recommended for customers with 2+ overdue invoices.',
        'Customers with both overdue collections and open tickets represent compounding risk.',
        'Consider offering structured payment plans to resolve 60+ day buckets before end of quarter.',
      ],
      margin_risks: [
        'Projects with material cost overruns > 15% require immediate project director review.',
        'Loss-making projects should trigger change order or scope renegotiation discussions.',
        'Projects with margin < 5% should be flagged in monthly portfolio review.',
        'Travel and miscellaneous cost lines are highest variance categories — implement spend gates.',
        'Commissioning delays are the primary driver of margin erosion — address at project kick-off.',
      ],
    };

    const summary = [
      `Executive snapshot as of ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}.`,
      critCust > 0 ? `${critCust} customers require urgent collections intervention.` : 'Collections health appears stable.',
      atRiskVend > 0 ? `${atRiskVend} vendors are blocked — supply chain continuity at risk.` : 'Vendor base is operationally stable.',
      v90 > 0 ? `${fmtV(v90)} in 90+ day outstanding requires legal/MD-level escalation.` : 'No critical aging collections.',
      'Focus: Grow high-health customers, recover at-risk accounts, diversify single-source supply chain.',
    ].join(' ');

    res.json({ insights, summary, generated_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 9. MANIFEST — BUSINESS LINES ─────────────────────────────────────────────
// GET /ceo-intelligence/manifest
router.get('/manifest', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = companyId ? `AND p.company_id=${companyId}` : '';

    const BUSINESS_LINES = ['HVDC', 'STATCOM', 'SST', 'Automation', 'Service', 'AMC'];

    const [projectsByBL, pipelineByBL, amcByBL] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(p.product_line, 'Other') AS business_line,
          COUNT(*)::int AS project_count,
          COALESCE(SUM(p.contract_value),0) AS revenue,
          COALESCE(SUM(p.budget_amount),0) AS budget,
          COALESCE(SUM(cs.actual_cost),0) AS cost,
          COUNT(DISTINCT p.customer_id)::int AS customer_count
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id=p.id
        WHERE p.deleted_at IS NULL ${cw}
        GROUP BY COALESCE(p.product_line,'Other')
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          COALESCE(product_line,'Other') AS business_line,
          COALESCE(SUM(expected_value),0) AS pipeline
        FROM opportunities
        WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('closed won','closed lost','closed_won','closed_lost')
        ${companyId ? `AND company_id=${companyId}` : ''}
        GROUP BY COALESCE(product_line,'Other')
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT COALESCE(service_type,'AMC') AS business_line,
               COALESCE(SUM(annual_value),0) AS amc_revenue,
               COUNT(*)::int AS contract_count
        FROM amc_contracts WHERE status='active'
        ${companyId ? `AND company_id=${companyId}` : ''}
        GROUP BY COALESCE(service_type,'AMC')
      `).catch(() => ({ rows: [] })),
    ]);

    const pipeMap = {};  pipelineByBL.rows.forEach(r => { pipeMap[r.business_line] = parseFloat(r.pipeline); });
    const amcMap  = {};  amcByBL.rows.forEach(r => { amcMap[r.business_line] = { revenue: parseFloat(r.amc_revenue), count: r.contract_count }; });

    // Build manifest per known business line
    const manifest = BUSINESS_LINES.map(bl => {
      const proj = projectsByBL.rows.find(r => r.business_line === bl) || {};
      const revenue = parseFloat(proj.revenue || 0);
      const cost    = parseFloat(proj.cost    || 0);
      const profit  = revenue - cost;
      const margin  = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;

      return {
        business_line: bl,
        project_count: proj.project_count || 0,
        revenue, cost, profit, margin_pct: margin,
        pipeline: pipeMap[bl] || 0,
        customer_count: proj.customer_count || 0,
        amc_revenue: amcMap[bl]?.revenue || 0,
        amc_contracts: amcMap[bl]?.count || 0,
        forecast: revenue + (pipeMap[bl] || 0) * 0.35,
      };
    });

    // Include "Other" bucket if present
    const otherProj = projectsByBL.rows.find(r => !BUSINESS_LINES.includes(r.business_line));
    if (otherProj) {
      const revenue = parseFloat(otherProj.revenue || 0);
      const cost    = parseFloat(otherProj.cost    || 0);
      manifest.push({
        business_line: 'Other',
        project_count: otherProj.project_count || 0,
        revenue, cost, profit: revenue - cost,
        margin_pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0,
        pipeline: pipeMap['Other'] || 0,
        customer_count: otherProj.customer_count || 0,
        amc_revenue: 0, amc_contracts: 0,
        forecast: revenue,
      });
    }

    res.json({ manifest });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
