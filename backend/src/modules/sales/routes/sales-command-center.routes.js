import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken, requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
router.use(verifyToken);

const cid = req => companyOf(req);
const pct = (n, d) => d > 0 ? parseFloat(((n / d) * 100).toFixed(1)) : 0;
const fmtNum = v => parseFloat(v || 0);

// ── CEO Summary KPIs ──────────────────────────────────────────────────────────
router.get('/summary', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const { fy_year } = req.query;
    const now = new Date();
    const fyStart = parseInt(fy_year) || (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
    const fyFrom  = `${fyStart}-04-01`;
    const fyTo    = `${fyStart + 1}-03-31`;

    const [targetR, ordersR, forecastR, pipelineR, funnelR, winlostR] = await Promise.all([
      // Annual target total
      pool.query(
        `SELECT COALESCE(SUM(target_amount),0) AS total_target,
                COALESCE(SUM(target_orders),0) AS total_target_orders
         FROM sales_targets
         WHERE period_type='annual' AND period_year=$1
           AND ($2::int IS NULL OR company_id=$2)`,
        [fyStart, company]
      ).catch(() => ({ rows: [{ total_target: 0, total_target_orders: 0 }] })),

      // Achieved revenue (sales orders)
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS achieved_revenue,
                COUNT(*)::int AS achieved_orders,
                COALESCE(SUM(margin_amount),0) AS achieved_margin
         FROM sales_orders
         WHERE deleted_at IS NULL
           AND order_status NOT IN ('cancelled','draft')
           AND order_date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR company_id=$3)`,
        [fyFrom, fyTo, company]
      ).catch(() => ({ rows: [{ achieved_revenue: 0, achieved_orders: 0, achieved_margin: 0 }] })),

      // Pipeline forecast (open opportunities weighted)
      pool.query(
        `SELECT COALESCE(SUM(expected_value * probability_percentage / 100.0),0) AS forecast_value,
                COUNT(*) AS open_count
         FROM opportunities
         WHERE deleted_at IS NULL
           AND LOWER(stage) NOT IN ('won','lost')
           AND ($1::int IS NULL OR company_id=$1)`,
        [company]
      ).catch(() => ({ rows: [{ forecast_value: 0, open_count: 0 }] })),

      // Total pipeline gross value
      pool.query(
        `SELECT COALESCE(SUM(expected_value),0) AS pipeline_value
         FROM opportunities
         WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('won','lost')
           AND ($1::int IS NULL OR company_id=$1)`,
        [company]
      ).catch(() => ({ rows: [{ pipeline_value: 0 }] })),

      // Funnel counts
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM leads WHERE ($1::int IS NULL OR company_id=$1)) AS leads,
           (SELECT COUNT(*) FROM opportunities WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)) AS opportunities,
           (SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)) AS quotations,
           (SELECT COUNT(*) FROM sales_orders WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)) AS orders`,
        [company]
      ).catch(() => ({ rows: [{ leads: 0, opportunities: 0, quotations: 0, orders: 0 }] })),

      // Win/loss
      pool.query(
        `SELECT
           COUNT(CASE WHEN LOWER(stage)='won' THEN 1 END) AS won,
           COUNT(CASE WHEN LOWER(stage)='lost' THEN 1 END) AS lost
         FROM opportunities
         WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)`,
        [company]
      ).catch(() => ({ rows: [{ won: 0, lost: 0 }] })),
    ]);

    const t  = targetR.rows[0];
    const o  = ordersR.rows[0];
    const f  = forecastR.rows[0];
    const p  = pipelineR.rows[0];
    const fn = funnelR.rows[0];
    const wl = winlostR.rows[0];

    const totalTarget    = fmtNum(t.total_target);
    const achievedRev    = fmtNum(o.achieved_revenue);
    const achievedOrders = parseInt(o.achieved_orders || 0);
    const achievedMargin = fmtNum(o.achieved_margin);
    const forecastVal    = fmtNum(f.forecast_value);
    const pipelineVal    = fmtNum(p.pipeline_value);
    const won            = parseInt(wl.won || 0);
    const lost           = parseInt(wl.lost || 0);

    res.json({
      fy_year: fyStart,
      total_target:         totalTarget,
      achieved_revenue:     achievedRev,
      achieved_orders:      achievedOrders,
      achieved_margin:      achievedMargin,
      achievement_pct:      pct(achievedRev, totalTarget),
      gap_value:            Math.max(0, totalTarget - achievedRev),
      gap_pct:              totalTarget > 0 ? parseFloat((100 - pct(achievedRev, totalTarget)).toFixed(1)) : 0,
      forecast_value:       forecastVal,
      pipeline_value:       pipelineVal,
      open_opportunities:   parseInt(f.open_count || 0),
      win_rate:             pct(won, won + lost),
      total_leads:          parseInt(fn.leads || 0),
      total_opportunities:  parseInt(fn.opportunities || 0),
      total_quotations:     parseInt(fn.quotations || 0),
      total_orders:         parseInt(fn.orders || 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Product Line Analytics ────────────────────────────────────────────────────
router.get('/product-analytics', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);

    const [oppByLine, ordersByLine, quotasByLine] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(product_line),''), 'Unclassified') AS product_line,
           COUNT(*)::int AS total,
           COUNT(CASE WHEN LOWER(stage)='won' THEN 1 END)::int AS won,
           COUNT(CASE WHEN LOWER(stage)='lost' THEN 1 END)::int AS lost,
           COALESCE(SUM(CASE WHEN LOWER(stage)='won' THEN expected_value ELSE 0 END),0) AS won_value,
           COALESCE(SUM(CASE WHEN LOWER(stage)='lost' THEN expected_value ELSE 0 END),0) AS lost_value,
           COALESCE(SUM(expected_value * probability_percentage / 100.0) FILTER (WHERE LOWER(stage) NOT IN ('won','lost')),0) AS pipeline_weighted
         FROM opportunities
         WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1 ORDER BY won_value DESC`,
        [company]
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(product_line),''), 'Unclassified') AS product_line,
           COUNT(*)::int AS orders,
           COALESCE(SUM(total_amount),0) AS revenue,
           COALESCE(SUM(margin_amount),0) AS margin,
           CASE WHEN COALESCE(SUM(total_amount),0) > 0
             THEN ROUND(COALESCE(SUM(margin_amount),0)/SUM(total_amount)*100,1)
             ELSE 0 END AS margin_pct
         FROM sales_orders
         WHERE deleted_at IS NULL AND order_status NOT IN ('cancelled','draft')
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1 ORDER BY revenue DESC`,
        [company]
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(product_line),''), 'Unclassified') AS product_line,
           COUNT(*)::int AS quotations,
           COALESCE(SUM(total_amount),0) AS quoted_value
         FROM quotations
         WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1`,
        [company]
      ).catch(() => ({ rows: [] })),
    ]);

    // Merge by product line
    const lineMap = {};
    const ensure = (line) => {
      if (!lineMap[line]) lineMap[line] = { product_line: line, won: 0, lost: 0, won_value: 0, lost_value: 0, pipeline_weighted: 0, orders: 0, revenue: 0, margin: 0, margin_pct: 0, quotations: 0, quoted_value: 0, win_rate: 0 };
      return lineMap[line];
    };
    oppByLine.rows.forEach(r => {
      const l = ensure(r.product_line);
      l.won = r.won; l.lost = r.lost;
      l.won_value = fmtNum(r.won_value); l.lost_value = fmtNum(r.lost_value);
      l.pipeline_weighted = fmtNum(r.pipeline_weighted);
      l.win_rate = pct(r.won, r.won + r.lost);
    });
    ordersByLine.rows.forEach(r => {
      const l = ensure(r.product_line);
      l.orders = r.orders; l.revenue = fmtNum(r.revenue);
      l.margin = fmtNum(r.margin); l.margin_pct = fmtNum(r.margin_pct);
    });
    quotasByLine.rows.forEach(r => {
      const l = ensure(r.product_line);
      l.quotations = r.quotations; l.quoted_value = fmtNum(r.quoted_value);
    });

    const result = Object.values(lineMap).sort((a, b) => b.revenue - a.revenue);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer Analytics ────────────────────────────────────────────────────────
router.get('/customer-analytics', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const limit = Math.min(parseInt(req.query.limit || 20), 100);

    const [topCustomers, categories, repeat] = await Promise.all([
      pool.query(
        `SELECT
           p.id,
           COALESCE(p.name, so.customer_name) AS customer_name,
           p.city,
           COALESCE(p.party_type, 'Customer') AS category,
           COUNT(so.id)::int AS total_orders,
           COALESCE(SUM(so.total_amount),0) AS total_revenue,
           COALESCE(SUM(so.margin_amount),0) AS total_margin,
           CASE WHEN COALESCE(SUM(so.total_amount),0) > 0
             THEN ROUND(COALESCE(SUM(so.margin_amount),0)/SUM(so.total_amount)*100,1)
             ELSE 0 END AS margin_pct,
           COUNT(DISTINCT opp.id)::int AS opportunities,
           COUNT(CASE WHEN LOWER(opp.stage)='won' THEN 1 END)::int AS won_opportunities,
           COUNT(CASE WHEN LOWER(opp.stage)='lost' THEN 1 END)::int AS lost_opportunities,
           MAX(so.order_date) AS last_order_date
         FROM sales_orders so
         LEFT JOIN parties p ON p.id = so.customer_id
         LEFT JOIN opportunities opp ON opp.customer_id = so.customer_id
           AND opp.deleted_at IS NULL
         WHERE so.deleted_at IS NULL
           AND so.order_status NOT IN ('cancelled','draft')
           AND ($1::int IS NULL OR so.company_id=$1)
         GROUP BY p.id, p.name, p.city, p.party_type, so.customer_name
         ORDER BY total_revenue DESC
         LIMIT $2`,
        [company, limit]
      ).catch(() => ({ rows: [] })),

      // Customer categories
      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(customer_category),''), 'Unclassified') AS category,
           COUNT(*)::int AS opportunities,
           COUNT(CASE WHEN LOWER(stage)='won' THEN 1 END)::int AS won,
           COALESCE(SUM(CASE WHEN LOWER(stage)='won' THEN expected_value ELSE 0 END),0) AS won_value
         FROM opportunities
         WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)
           AND customer_category IS NOT NULL AND TRIM(customer_category) != ''
         GROUP BY 1 ORDER BY won_value DESC`,
        [company]
      ).catch(() => ({ rows: [] })),

      // Repeat business ratio
      pool.query(
        `SELECT
           COUNT(DISTINCT customer_id)::int AS total_customers,
           COUNT(DISTINCT CASE WHEN order_count > 1 THEN customer_id END)::int AS repeat_customers
         FROM (
           SELECT customer_id, COUNT(*)::int AS order_count
           FROM sales_orders
           WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)
           GROUP BY customer_id
         ) sub`,
        [company]
      ).catch(() => ({ rows: [{ total_customers: 0, repeat_customers: 0 }] })),
    ]);

    const r = repeat.rows[0] || {};
    res.json({
      top_customers: topCustomers.rows.map(c => ({
        ...c,
        total_revenue: fmtNum(c.total_revenue),
        total_margin:  fmtNum(c.total_margin),
        margin_pct:    fmtNum(c.margin_pct),
        win_rate:      pct(c.won_opportunities, c.won_opportunities + c.lost_opportunities),
      })),
      categories: categories.rows.map(c => ({ ...c, won_value: fmtNum(c.won_value) })),
      repeat_business: {
        total_customers:   parseInt(r.total_customers || 0),
        repeat_customers:  parseInt(r.repeat_customers || 0),
        repeat_pct:        pct(parseInt(r.repeat_customers || 0), parseInt(r.total_customers || 0)),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Salesperson Scorecard ─────────────────────────────────────────────────────
router.get('/salesperson-scorecard', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const { fy_year } = req.query;
    const now = new Date();
    const fyStart = parseInt(fy_year) || (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
    const fyFrom  = `${fyStart}-04-01`;
    const fyTo    = `${fyStart + 1}-03-31`;

    const { rows } = await pool.query(
      `WITH reps AS (
         SELECT DISTINCT owner_id AS emp_id
         FROM sales_targets
         WHERE period_type='annual' AND period_year=$3
           AND ($1::int IS NULL OR company_id=$1)
           AND target_type='individual'
       ),
       targets AS (
         SELECT owner_id,
                SUM(target_amount) AS target_rev,
                SUM(target_orders) AS target_ord,
                SUM(commission_rate) / NULLIF(COUNT(*),0) AS avg_comm_rate
         FROM sales_targets
         WHERE period_type='annual' AND period_year=$3
           AND target_type='individual'
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY owner_id
       ),
       achieved_orders AS (
         SELECT COALESCE(salesperson_id, created_by) AS emp_id,
                COUNT(*)::int AS orders_won,
                COALESCE(SUM(total_amount),0) AS achieved_rev,
                COALESCE(SUM(margin_amount),0) AS achieved_margin,
                MIN(EXTRACT(EPOCH FROM (created_at::date - order_date))/86400) AS min_cycle
         FROM sales_orders
         WHERE deleted_at IS NULL AND order_status NOT IN ('cancelled','draft')
           AND order_date BETWEEN $4 AND $5
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1
       ),
       opp_data AS (
         SELECT COALESCE(assigned_to_id, assigned_to::int) AS emp_id,
                COUNT(*)::int AS total_opps,
                COUNT(CASE WHEN LOWER(stage)='won' THEN 1 END)::int AS won_opps,
                COUNT(CASE WHEN LOWER(stage)='lost' THEN 1 END)::int AS lost_opps,
                COALESCE(SUM(expected_value * probability_percentage/100.0)
                  FILTER (WHERE LOWER(stage) NOT IN ('won','lost')),0) AS pipeline_weighted,
                ROUND(AVG(sales_cycle_days) FILTER (WHERE sales_cycle_days IS NOT NULL),1) AS avg_cycle_days
         FROM opportunities
         WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1
       ),
       quote_data AS (
         SELECT COALESCE(salesperson_id, created_by) AS emp_id,
                COUNT(*)::int AS quotes_sent
         FROM quotations
         WHERE deleted_at IS NULL
           AND created_at BETWEEN $4 AND $5
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1
       )
       SELECT
         e.id,
         COALESCE(e.name, e.first_name || ' ' || e.last_name, 'Unknown') AS name,
         e.designation,
         e.email,
         COALESCE(t.target_rev, 0)             AS target_revenue,
         COALESCE(t.target_ord, 0)             AS target_orders,
         COALESCE(t.avg_comm_rate, 0)           AS commission_rate,
         COALESCE(ao.achieved_rev, 0)          AS achieved_revenue,
         COALESCE(ao.orders_won, 0)            AS orders_won,
         COALESCE(ao.achieved_margin, 0)       AS achieved_margin,
         COALESCE(od.pipeline_weighted, 0)     AS pipeline_value,
         COALESCE(od.won_opps, 0)              AS won_opportunities,
         COALESCE(od.lost_opps, 0)             AS lost_opportunities,
         COALESCE(od.total_opps, 0)            AS total_opportunities,
         COALESCE(qd.quotes_sent, 0)           AS quotes_sent,
         COALESCE(od.avg_cycle_days, 0)        AS avg_sales_cycle_days,
         CASE WHEN COALESCE(t.target_rev, 0) > 0
           THEN ROUND(COALESCE(ao.achieved_rev,0)/t.target_rev*100,1) ELSE 0 END AS achievement_pct,
         CASE WHEN COALESCE(t.target_rev, 0) > 0
           THEN COALESCE(t.target_rev, 0) - COALESCE(ao.achieved_rev, 0) ELSE 0 END AS gap_value,
         CASE WHEN COALESCE(od.won_opps,0) + COALESCE(od.lost_opps,0) > 0
           THEN ROUND(COALESCE(od.won_opps,0)::numeric/(od.won_opps+od.lost_opps)*100,1)
           ELSE 0 END AS win_rate,
         CASE WHEN COALESCE(qd.quotes_sent,0) > 0
           THEN ROUND(COALESCE(ao.orders_won,0)::numeric/qd.quotes_sent*100,1)
           ELSE 0 END AS quote_conversion_rate,
         CASE WHEN COALESCE(ao.orders_won, 0) > 0
           THEN ROUND(COALESCE(ao.achieved_rev,0)/ao.orders_won,0) ELSE 0 END AS avg_deal_size,
         CASE WHEN COALESCE(ao.achieved_rev,0) > 0
           THEN ROUND(COALESCE(ao.achieved_rev,0)*COALESCE(t.avg_comm_rate,0)/100,0)
           ELSE 0 END AS commission_earned
       FROM employees e
       JOIN (
         SELECT DISTINCT owner_id AS emp_id FROM sales_targets
         WHERE period_type='annual' AND period_year=$3
           AND ($1::int IS NULL OR company_id=$1)
       ) base ON base.emp_id = e.id
       LEFT JOIN targets   t  ON t.owner_id = e.id
       LEFT JOIN achieved_orders ao ON ao.emp_id = e.id
       LEFT JOIN opp_data  od ON od.emp_id = e.id
       LEFT JOIN quote_data qd ON qd.emp_id = e.id
       WHERE e.company_id=$2 OR $2 IS NULL
       ORDER BY achieved_revenue DESC`,
      [company, company, fyStart, fyFrom, fyTo]
    ).catch(() => ({ rows: [] }));

    res.json(rows.map(r => ({
      ...r,
      target_revenue:       fmtNum(r.target_revenue),
      achieved_revenue:     fmtNum(r.achieved_revenue),
      achieved_margin:      fmtNum(r.achieved_margin),
      pipeline_value:       fmtNum(r.pipeline_value),
      achievement_pct:      fmtNum(r.achievement_pct),
      gap_value:            fmtNum(r.gap_value),
      win_rate:             fmtNum(r.win_rate),
      quote_conversion_rate:fmtNum(r.quote_conversion_rate),
      avg_deal_size:        fmtNum(r.avg_deal_size),
      commission_earned:    fmtNum(r.commission_earned),
      avg_sales_cycle_days: fmtNum(r.avg_sales_cycle_days),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CEO Traceability — Lead to Revenue full chain ─────────────────────────────
router.get('/traceability', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const { customer_id, salesperson_id, limit: lim = 50 } = req.query;
    const limit = Math.min(parseInt(lim), 200);

    const { rows } = await pool.query(
      `SELECT
         l.id                                     AS lead_id,
         l.name                                   AS lead_name,
         l.source                                 AS lead_source,
         l.created_at                             AS lead_created,
         COALESCE(e_lead.name, l.assigned_to)     AS lead_owner,
         opp.id                                   AS opportunity_id,
         opp.name                                 AS opportunity_name,
         opp.stage                                AS opportunity_stage,
         opp.expected_value                       AS opportunity_value,
         COALESCE(e_opp.name, opp.assigned_to::text) AS opp_owner,
         opp.product_line,
         opp.competitor,
         opp.lost_reason,
         q.id                                     AS quotation_id,
         q.quotation_number,
         q.total_amount                           AS quotation_value,
         q.status                                 AS quotation_status,
         COALESCE(e_qt.name, q.salesperson)       AS quotation_owner,
         so.id                                    AS sales_order_id,
         so.order_number,
         so.total_amount                          AS order_value,
         so.margin_amount                         AS order_margin,
         so.order_status,
         COALESCE(e_so.name, so.salesperson_name) AS order_owner,
         p.id                                     AS project_id,
         p.project_code,
         p.project_name,
         p.status                                 AS project_status
       FROM leads l
       LEFT JOIN employees e_lead ON e_lead.id = l.assigned_to_id
       LEFT JOIN opportunities opp ON opp.lead_id = l.id AND opp.deleted_at IS NULL
       LEFT JOIN employees e_opp   ON e_opp.id = opp.assigned_to_id
       LEFT JOIN quotations q ON q.opportunity_id = opp.id AND q.deleted_at IS NULL
       LEFT JOIN employees e_qt   ON e_qt.id = q.salesperson_id
       LEFT JOIN sales_orders so ON so.quotation_id = q.id AND so.deleted_at IS NULL
       LEFT JOIN employees e_so   ON e_so.id = so.salesperson_id
       LEFT JOIN projects p ON p.id = so.project_id
       WHERE ($1::int IS NULL OR l.company_id=$1)
         AND ($2::int IS NULL OR l.customer_id=$2 OR opp.customer_id=$2)
         AND ($3::int IS NULL OR l.assigned_to_id=$3 OR opp.assigned_to_id=$3 OR so.salesperson_id=$3)
       ORDER BY l.created_at DESC
       LIMIT $4`,
      [company, customer_id || null, salesperson_id || null, limit]
    ).catch(() => ({ rows: [] }));

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lost Deal Analysis ────────────────────────────────────────────────────────
router.get('/lost-deal-analysis', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);

    const [byReason, byCompetitor, bySalesperson, topLost] = await Promise.all([
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(lost_reason),''),'Not Specified') AS reason,
                COUNT(*)::int AS count,
                COALESCE(SUM(expected_value),0) AS lost_value
         FROM opportunities
         WHERE LOWER(stage)='lost' AND deleted_at IS NULL
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1 ORDER BY count DESC LIMIT 15`,
        [company]
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(competitor),''),'Unknown') AS competitor,
                COUNT(*)::int AS deals_lost,
                COALESCE(SUM(expected_value),0) AS value_lost
         FROM opportunities
         WHERE LOWER(stage)='lost' AND deleted_at IS NULL
           AND competitor IS NOT NULL AND TRIM(competitor) != ''
           AND ($1::int IS NULL OR company_id=$1)
         GROUP BY 1 ORDER BY deals_lost DESC LIMIT 10`,
        [company]
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT COALESCE(e.name, o.assigned_to::text) AS salesperson,
                COUNT(*)::int AS lost,
                COALESCE(SUM(o.expected_value),0) AS lost_value
         FROM opportunities o
         LEFT JOIN employees e ON e.id = o.assigned_to_id
         WHERE LOWER(o.stage)='lost' AND o.deleted_at IS NULL
           AND ($1::int IS NULL OR o.company_id=$1)
         GROUP BY 1 ORDER BY lost DESC LIMIT 10`,
        [company]
      ).catch(() => ({ rows: [] })),

      pool.query(
        `SELECT name, expected_value, lost_reason, competitor, product_line,
                COALESCE(e.name, assigned_to::text) AS salesperson,
                updated_at AS lost_at
         FROM opportunities o
         LEFT JOIN employees e ON e.id = o.assigned_to_id
         WHERE LOWER(o.stage)='lost' AND o.deleted_at IS NULL
           AND ($1::int IS NULL OR o.company_id=$1)
         ORDER BY expected_value DESC LIMIT 20`,
        [company]
      ).catch(() => ({ rows: [] })),
    ]);

    const totalLost = byReason.rows.reduce((s, r) => s + r.count, 0);
    const totalLostValue = byReason.rows.reduce((s, r) => s + fmtNum(r.lost_value), 0);

    res.json({
      total_lost:       totalLost,
      total_lost_value: totalLostValue,
      by_reason:        byReason.rows.map(r => ({ ...r, lost_value: fmtNum(r.lost_value) })),
      by_competitor:    byCompetitor.rows.map(r => ({ ...r, value_lost: fmtNum(r.value_lost) })),
      by_salesperson:   bySalesperson.rows.map(r => ({ ...r, lost_value: fmtNum(r.lost_value) })),
      top_lost_deals:   topLost.rows.map(r => ({ ...r, expected_value: fmtNum(r.expected_value) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Upcoming Closures ─────────────────────────────────────────────────────────
router.get('/upcoming-closures', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const { days = 30 } = req.query;

    const { rows } = await pool.query(
      `SELECT
         o.id, o.name, o.expected_value, o.probability_percentage,
         o.expected_closing_date, o.stage, o.product_line,
         COALESCE(e.name, o.assigned_to::text) AS salesperson,
         COALESCE(p.name, o.customer_name)      AS customer,
         EXTRACT(DAY FROM (o.expected_closing_date - CURRENT_DATE))::int AS days_to_close,
         o.expected_value * o.probability_percentage / 100.0            AS weighted_value
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to_id
       LEFT JOIN parties p   ON p.id = o.customer_id
       WHERE o.deleted_at IS NULL
         AND LOWER(o.stage) NOT IN ('won','lost')
         AND o.expected_closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::interval
         AND ($1::int IS NULL OR o.company_id=$1)
       ORDER BY o.expected_closing_date ASC, o.expected_value DESC
       LIMIT 50`,
      [company, parseInt(days)]
    ).catch(() => ({ rows: [] }));

    res.json(rows.map(r => ({
      ...r,
      expected_value:    fmtNum(r.expected_value),
      weighted_value:    fmtNum(r.weighted_value),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sales Alerts ──────────────────────────────────────────────────────────────
router.get('/alerts', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const now  = new Date();
    const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const fyFrom  = `${fyStart}-04-01`;
    const fyTo    = `${fyStart + 1}-03-31`;
    const alerts = [];

    const [lowAchievers, stalled, expiringQuotes, pipelineDrop, targets] = await Promise.all([
      // Reps below 50% achievement
      pool.query(
        `SELECT
           COALESCE(e.name, 'Rep') AS name,
           ROUND(COALESCE(SUM(so.total_amount),0)/NULLIF(SUM(st.target_amount),0)*100,1) AS achievement_pct,
           SUM(st.target_amount) AS target,
           COALESCE(SUM(so.total_amount),0) AS achieved
         FROM sales_targets st
         LEFT JOIN employees e ON e.id = st.owner_id
         LEFT JOIN sales_orders so ON so.salesperson_id = st.owner_id
           AND so.deleted_at IS NULL AND so.order_status NOT IN ('cancelled','draft')
           AND so.order_date BETWEEN $2 AND $3
         WHERE st.period_type='annual' AND st.period_year=$4
           AND ($1::int IS NULL OR st.company_id=$1) AND st.target_type='individual'
         GROUP BY e.name, st.owner_id
         HAVING ROUND(COALESCE(SUM(so.total_amount),0)/NULLIF(SUM(st.target_amount),0)*100,1) < 50`,
        [company, fyFrom, fyTo, fyStart]
      ).catch(() => ({ rows: [] })),

      // Opportunities stalled > 7 days
      pool.query(
        `SELECT id, name, COALESCE(e.name, assigned_to::text) AS salesperson, expected_value, stage,
                EXTRACT(DAY FROM (NOW() - updated_at))::int AS days_stalled
         FROM opportunities o
         LEFT JOIN employees e ON e.id = o.assigned_to_id
         WHERE o.deleted_at IS NULL AND LOWER(o.stage) NOT IN ('won','lost')
           AND o.updated_at < NOW() - INTERVAL '7 days'
           AND ($1::int IS NULL OR o.company_id=$1)
         ORDER BY days_stalled DESC LIMIT 10`,
        [company]
      ).catch(() => ({ rows: [] })),

      // Quotations expiring in 7 days
      pool.query(
        `SELECT id, quotation_number, customer_name, total_amount,
                EXTRACT(DAY FROM (valid_until - NOW()))::int AS days_left
         FROM quotations
         WHERE deleted_at IS NULL AND status IN ('sent','draft')
           AND valid_until BETWEEN NOW() AND NOW() + INTERVAL '7 days'
           AND ($1::int IS NULL OR company_id=$1)
         ORDER BY valid_until ASC LIMIT 10`,
        [company]
      ).catch(() => ({ rows: [] })),

      // Pipeline value drop (simplified: just return open pipeline)
      pool.query(
        `SELECT COALESCE(SUM(expected_value),0) AS pipeline, COUNT(*)::int AS deal_count
         FROM opportunities WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('won','lost')
           AND ($1::int IS NULL OR company_id=$1)`,
        [company]
      ).catch(() => ({ rows: [{ pipeline: 0, deal_count: 0 }] })),

      pool.query(
        `SELECT COUNT(*) AS cnt FROM sales_targets
         WHERE period_type='annual' AND period_year=$2 AND ($1::int IS NULL OR company_id=$1)`,
        [company, fyStart]
      ).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    lowAchievers.rows.forEach(r => {
      alerts.push({
        type: 'low_achievement', severity: 'critical',
        title: `${r.name} at ${r.achievement_pct}% achievement`,
        message: `Target: ₹${(r.target/100000).toFixed(1)}L · Achieved: ₹${(r.achieved/100000).toFixed(1)}L`,
        entity_type: 'salesperson', entity_name: r.name,
      });
    });
    stalled.rows.forEach(r => {
      alerts.push({
        type: 'stalled_opportunity', severity: 'warning',
        title: `"${r.name}" stalled ${r.days_stalled} days`,
        message: `${r.salesperson} · Stage: ${r.stage} · Value: ₹${(r.expected_value/100000).toFixed(1)}L`,
        entity_type: 'opportunity', entity_id: r.id, entity_name: r.name,
      });
    });
    expiringQuotes.rows.forEach(r => {
      alerts.push({
        type: 'expiring_quotation', severity: r.days_left <= 2 ? 'critical' : 'warning',
        title: `${r.quotation_number} expires in ${r.days_left} day(s)`,
        message: `Customer: ${r.customer_name} · Value: ₹${(r.total_amount/100000).toFixed(1)}L`,
        entity_type: 'quotation', entity_id: r.id, entity_name: r.quotation_number,
      });
    });
    if (parseInt(targets.rows[0]?.cnt || 0) === 0) {
      alerts.push({
        type: 'no_targets', severity: 'info',
        title: `No annual targets set for FY ${fyStart}-${String(fyStart+1).slice(2)}`,
        message: 'Go to Sales → Sales Targets to assign individual and team targets.',
        entity_type: 'system',
      });
    }

    res.json(alerts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Team / Region / BU Targets ────────────────────────────────────────────────
router.get('/team-targets', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const company = cid(req);
    const { fy_year } = req.query;
    const now = new Date();
    const fyStart = parseInt(fy_year) || (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1);
    const fyFrom  = `${fyStart}-04-01`;
    const fyTo    = `${fyStart + 1}-03-31`;

    const { rows } = await pool.query(
      `SELECT
         st.target_type,
         COALESCE(st.team_name, st.region, st.business_unit, 'Default') AS group_name,
         st.region,
         st.business_unit,
         SUM(st.target_amount)::numeric AS target_revenue,
         SUM(st.target_orders)::int AS target_orders,
         COALESCE(SUM(so.total_amount),0) AS achieved_revenue,
         COALESCE(COUNT(so.id),0)::int AS achieved_orders,
         CASE WHEN SUM(st.target_amount) > 0
           THEN ROUND(COALESCE(SUM(so.total_amount),0)/SUM(st.target_amount)*100,1) ELSE 0 END AS achievement_pct
       FROM sales_targets st
       LEFT JOIN sales_orders so ON so.order_status NOT IN ('cancelled','draft')
         AND so.deleted_at IS NULL AND so.order_date BETWEEN $2 AND $3
         AND (
           (st.target_type='team' AND so.salesperson_name ILIKE '%' || st.team_name || '%')
           OR (st.target_type='regional' AND so.region = st.region)
           OR (st.target_type='bu' AND so.business_unit = st.business_unit)
         )
       WHERE st.period_type='annual' AND st.period_year=$4
         AND st.target_type IN ('team','regional','bu')
         AND ($1::int IS NULL OR st.company_id=$1)
       GROUP BY st.target_type, st.team_name, st.region, st.business_unit
       ORDER BY target_revenue DESC`,
      [company, fyFrom, fyTo, fyStart]
    ).catch(() => ({ rows: [] }));

    res.json(rows.map(r => ({
      ...r,
      target_revenue:   fmtNum(r.target_revenue),
      achieved_revenue: fmtNum(r.achieved_revenue),
      achievement_pct:  fmtNum(r.achievement_pct),
      gap_value:        Math.max(0, fmtNum(r.target_revenue) - fmtNum(r.achieved_revenue)),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Save team/region/BU target ────────────────────────────────────────────────
router.post('/team-targets', requirePermission('sales', 'add'), async (req, res) => {
  try {
    const company = cid(req);
    const {
      target_type, team_name, region, business_unit,
      target_amount, target_orders, period_year,
    } = req.body;
    if (!target_type || !target_amount) {
      return res.status(400).json({ error: 'target_type and target_amount are required' });
    }
    const fyYear = parseInt(period_year) || (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
    const { rows } = await pool.query(
      `INSERT INTO sales_targets
         (company_id, target_type, team_name, region, business_unit,
          period_type, period_year, period_value, target_amount, target_orders, created_by)
       VALUES ($1,$2,$3,$4,$5,'annual',$6,$6,$7,$8,$9)
       RETURNING *`,
      [company, target_type, team_name||null, region||null, business_unit||null,
       fyYear, parseFloat(target_amount), parseInt(target_orders||0), req.user?.userId||req.user?.id||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
