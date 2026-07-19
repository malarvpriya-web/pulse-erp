// backend/src/modules/crm/routes/ceo360.routes.js
// CEO Command Center — Customer & Vendor 360° Intelligence
import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);

// ── GET /ceo360/customers — top customers with health scores ─────────────────
router.get('/customers', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cc = companyId ? `AND p.company_id=${companyId}` : '';

    const [topRevenue, outstanding, healthInputs, projectMargins, openTickets, amcStatus] = await Promise.all([
      // Top customers by revenue (paid invoices)
      pool.query(`
        SELECT p.id, p.name, p.city, p.state, p.gstin,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status='paid'), 0) AS revenue,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status!='paid'), 0) AS outstanding,
               COUNT(i.id)::int AS invoice_count
        FROM parties p
        LEFT JOIN invoices i ON i.party_id = p.id
        WHERE (p.type='customer' OR p.type IS NULL) ${cc}
        GROUP BY p.id, p.name, p.city, p.state, p.gstin
        HAVING COUNT(i.id) > 0
        ORDER BY revenue DESC LIMIT 20
      `).catch(() => ({ rows: [] })),

      // Top customers by outstanding
      pool.query(`
        SELECT p.id, p.name,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status IN ('overdue','pending')), 0) AS outstanding
        FROM parties p
        LEFT JOIN invoices i ON i.party_id = p.id
        WHERE (p.type='customer' OR p.type IS NULL) ${cc}
        GROUP BY p.id, p.name
        HAVING COALESCE(SUM(i.total_amount) FILTER (WHERE i.status IN ('overdue','pending')), 0) > 0
        ORDER BY outstanding DESC LIMIT 10
      `).catch(() => ({ rows: [] })),

      // Overdue invoice count per customer
      pool.query(`
        SELECT party_id, COUNT(*)::int AS overdue_count
        FROM invoices WHERE status='overdue'
        GROUP BY party_id
      `).catch(() => ({ rows: [] })),

      // Project margin per customer
      pool.query(`
        SELECT p.customer_id,
               COALESCE(SUM(p.budget_amount), 0) AS total_budget,
               COALESCE(SUM(cs.actual_cost), 0) AS total_actual
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.customer_id IS NOT NULL AND p.deleted_at IS NULL
        GROUP BY p.customer_id
      `).catch(() => ({ rows: [] })),

      // Open critical tickets per customer
      pool.query(`
        SELECT customer_id, COUNT(*)::int AS open_tickets,
               COUNT(CASE WHEN priority='critical' THEN 1 END)::int AS critical_tickets
        FROM support_tickets WHERE status NOT IN ('resolved','closed')
        GROUP BY customer_id
      `).catch(() => ({ rows: [] })),

      // Active AMC per customer
      pool.query(`
        SELECT customer_id, COUNT(*)::int AS active_amc,
               COALESCE(SUM(annual_value), 0) AS amc_revenue
        FROM amc_contracts WHERE status='active'
        GROUP BY customer_id
      `).catch(() => ({ rows: [] })),
    ]);

    // Build lookup maps
    const overdueMap = {};
    healthInputs.rows.forEach(r => { overdueMap[r.party_id] = r.overdue_count; });

    const marginMap = {};
    projectMargins.rows.forEach(r => {
      marginMap[r.customer_id] = r.total_budget > 0
        ? Math.round(((r.total_budget - r.total_actual) / r.total_budget) * 100)
        : null;
    });

    const ticketMap = {};
    openTickets.rows.forEach(r => { ticketMap[r.customer_id] = r; });

    const amcMap = {};
    amcStatus.rows.forEach(r => { amcMap[r.customer_id] = r; });

    // Compute health score and enrich
    const customers = topRevenue.rows.map(c => {
      const overdue   = overdueMap[c.id] || 0;
      const margin    = marginMap[c.id];
      const tickets   = ticketMap[c.id]?.critical_tickets || 0;
      const hasAMC    = !!(amcMap[c.id]?.active_amc > 0);
      const pScore    = Math.max(0, 25 - overdue * 5);
      const mScore    = margin != null ? (margin >= 20 ? 25 : margin >= 10 ? 18 : margin >= 0 ? 10 : 0) : 15;
      const tScore    = Math.max(0, 25 - tickets * 8);
      const amcScore  = hasAMC ? 25 : 10;
      const health    = pScore + mScore + tScore + amcScore;
      const healthLabel = health >= 90 ? 'Excellent' : health >= 75 ? 'Good' : health >= 60 ? 'Watchlist' : 'Critical';
      const healthColor = health >= 90 ? '#16a34a' : health >= 75 ? '#2563eb' : health >= 60 ? '#d97706' : '#dc2626';

      return {
        id: c.id, name: c.name, city: c.city, state: c.state, gstin: c.gstin,
        revenue: parseFloat(c.revenue), outstanding: parseFloat(c.outstanding),
        invoice_count: c.invoice_count,
        margin_pct: margin,
        amc_revenue: parseFloat(amcMap[c.id]?.amc_revenue || 0),
        active_amc: parseInt(amcMap[c.id]?.active_amc || 0),
        open_tickets: ticketMap[c.id]?.open_tickets || 0,
        critical_tickets: tickets,
        health_score: health, health_label: healthLabel, health_color: healthColor,
      };
    });

    // Health distribution
    const distribution = { Excellent: 0, Good: 0, Watchlist: 0, Critical: 0 };
    customers.forEach(c => { distribution[c.health_label] = (distribution[c.health_label] || 0) + 1; });

    // Top outstanding
    const topOutstanding = outstanding.rows
      .slice(0, 10)
      .map(r => ({ id: r.id, name: r.name, outstanding: parseFloat(r.outstanding) }));

    res.json({
      customers,
      top_outstanding: topOutstanding,
      health_distribution: Object.entries(distribution).map(([label, count]) => ({ label, count })),
      summary: {
        total_customers: customers.length,
        total_revenue: customers.reduce((s, c) => s + c.revenue, 0),
        total_outstanding: customers.reduce((s, c) => s + c.outstanding, 0),
        total_amc_revenue: customers.reduce((s, c) => s + c.amc_revenue, 0),
        excellent_count: distribution.Excellent,
        critical_count: distribution.Critical,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /ceo360/vendors — top vendors with performance data ───────────────────
router.get('/vendors', requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cc = companyId ? `AND v.company_id=${companyId}` : '';
    const ccPO = companyId ? `AND po.company_id=${companyId}` : '';

    const [topSpend, scorecards, ncrSummary, deliveryMetrics] = await Promise.all([
      pool.query(`
        SELECT v.id, v.name, v.vendor_code, v.vendor_type, v.status, v.city, v.state,
               v.msme_status,
               COALESCE(po_agg.po_count, 0) AS po_count,
               COALESCE(po_agg.po_value, 0) AS po_value,
               COALESCE(po_agg.open_pos, 0) AS open_pos
        FROM vendors v
        LEFT JOIN (
          SELECT vendor_id,
                 COUNT(*)::int AS po_count,
                 SUM(total_amount) AS po_value,
                 COUNT(CASE WHEN status IN ('Approved','Sent','Partial') THEN 1 END)::int AS open_pos
          FROM purchase_orders ${companyId ? `WHERE company_id=${companyId}` : ''}
          GROUP BY vendor_id
        ) po_agg ON po_agg.vendor_id = v.id
        WHERE 1=1 ${cc}
        ORDER BY po_value DESC NULLS LAST LIMIT 20
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT DISTINCT ON (vendor_id) vendor_id,
               (quality_score+delivery_score+cost_score+support_score+compliance_score)/5 AS overall_score,
               quality_score, delivery_score
        FROM vendor_scorecards
        ${companyId ? `WHERE company_id=${companyId}` : ''}
        ORDER BY vendor_id, scored_at DESC
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT vendor_id, COUNT(*)::int AS total_ncrs,
               COUNT(CASE WHEN status!='Closed' THEN 1 END)::int AS open_ncrs
        FROM ncr_reports
        ${companyId ? `WHERE company_id=${companyId}` : ''}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT vendor_id,
               COUNT(CASE WHEN status IN ('Received','Completed') THEN 1 END)::int AS completed,
               COUNT(*)::int AS total
        FROM purchase_orders WHERE 1=1 ${ccPO}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),
    ]);

    const scoreMap = {};
    scorecards.rows.forEach(r => { scoreMap[r.vendor_id] = r; });

    const ncrMap = {};
    ncrSummary.rows.forEach(r => { ncrMap[r.vendor_id] = r; });

    const deliveryMap = {};
    deliveryMetrics.rows.forEach(r => {
      deliveryMap[r.vendor_id] = r.total > 0
        ? parseFloat(((r.completed / r.total) * 100).toFixed(1)) : null;
    });

    const vendors = topSpend.rows.map(v => {
      const sc   = scoreMap[v.id] || {};
      const ncr  = ncrMap[v.id]  || { total_ncrs: 0, open_ncrs: 0 };
      const otd  = deliveryMap[v.id];
      const overall = parseFloat(sc.overall_score || 0);

      // Vendor health: Preferred / Approved / Watchlist / Blocked
      const label = overall >= 4 ? 'Preferred' : overall >= 3 ? 'Approved' : overall >= 2 ? 'Watchlist' : ncr.open_ncrs > 3 ? 'Blocked' : 'Watchlist';
      const healthColor = label === 'Preferred' ? '#16a34a' : label === 'Approved' ? '#2563eb' : label === 'Watchlist' ? '#d97706' : '#dc2626';

      return {
        id: v.id, name: v.name, vendor_code: v.vendor_code, vendor_type: v.vendor_type,
        status: v.status, city: v.city, state: v.state, msme_status: v.msme_status,
        po_count: v.po_count, po_value: parseFloat(v.po_value || 0), open_pos: v.open_pos,
        overall_score: overall,
        quality_score: parseFloat(sc.quality_score || 0),
        delivery_score: parseFloat(sc.delivery_score || 0),
        total_ncrs: ncr.total_ncrs, open_ncrs: ncr.open_ncrs,
        on_time_delivery_pct: otd,
        health_label: label, health_color: healthColor,
      };
    });

    const dist = { Preferred: 0, Approved: 0, Watchlist: 0, Blocked: 0 };
    vendors.forEach(v => { dist[v.health_label] = (dist[v.health_label] || 0) + 1; });

    res.json({
      vendors,
      health_distribution: Object.entries(dist).map(([label, count]) => ({ label, count })),
      top_risk_vendors: vendors.filter(v => v.health_label === 'Blocked' || v.health_label === 'Watchlist').slice(0, 5),
      summary: {
        total_vendors: vendors.length,
        total_spend: vendors.reduce((s, v) => s + v.po_value, 0),
        preferred_count: dist.Preferred,
        blocked_count: dist.Blocked,
        total_open_ncrs: vendors.reduce((s, v) => s + v.open_ncrs, 0),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /ceo360/summary — single-call aggregate for header KPIs ───────────────
router.get('/summary', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cc = companyId ? `AND company_id=${companyId}` : '';

    const [customerCount, vendorCount, totalRevenue, totalOutstanding, totalPayable, openNcrs] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT party_id)::int AS c FROM invoices WHERE 1=1 ${cc}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM vendors WHERE 1=1 ${cc}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE status='paid' ${cc}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE status IN ('overdue','pending') ${cc}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM vendor_invoices WHERE status IN ('Approved','Pending') ${cc}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM ncr_reports WHERE status!='Closed' ${cc}`).catch(() => ({ rows: [{ c: 0 }] })),
    ]);

    res.json({
      active_customers: customerCount.rows[0]?.c || 0,
      active_vendors: vendorCount.rows[0]?.c || 0,
      total_revenue: parseFloat(totalRevenue.rows[0]?.v || 0),
      customer_outstanding: parseFloat(totalOutstanding.rows[0]?.v || 0),
      vendor_payable: parseFloat(totalPayable.rows[0]?.v || 0),
      open_ncrs: openNcrs.rows[0]?.c || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
