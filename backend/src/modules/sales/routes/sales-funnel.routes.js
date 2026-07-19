import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);

// ── Monthly funnel snapshot (enquiries → leads → opps → quotes → orders → revenue) ──
router.get('/monthly', async (req, res) => {
  try {
    const companyId = cid(req);
    const { months = 12 } = req.query;
    const cond = companyId ? `AND (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];

    const [enquiries, leads, opps, quotes, orders, revenue] = await Promise.all([
      // Enquiries = all CRM leads created per month
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,
               COUNT(*) AS count
        FROM leads WHERE created_at >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),

      // Leads = qualified leads
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,
               COUNT(*) AS count
        FROM leads WHERE status IN ('Qualified','Hot') AND created_at >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),

      // Opportunities
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,
               COUNT(*) AS count
        FROM opportunities WHERE created_at >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),

      // Quotations
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,
               COUNT(*) AS count
        FROM quotations WHERE created_at >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),

      // Orders won
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'YYYY-MM') AS month,
               COUNT(*) AS count
        FROM sales_orders WHERE created_at >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),

      // Revenue
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',order_date),'YYYY-MM') AS month,
               COALESCE(SUM(total_amount),0) AS revenue
        FROM sales_orders
        WHERE order_date >= NOW()-INTERVAL '${parseInt(months)} months'
        ${cond ? cond.replace('AND','WHERE') : ''}
        GROUP BY month ORDER BY month
      `, params).catch(() => ({ rows: [] })),
    ]);

    // Merge into a month-indexed map
    const monthMap = {};
    const toMap = (rows, key) => rows.forEach(r => {
      if (!monthMap[r.month]) monthMap[r.month] = { month: r.month, enquiries:0, leads:0, opportunities:0, quotations:0, orders:0, revenue:0 };
      monthMap[r.month][key] = parseInt(r.count || r.revenue || 0);
    });
    toMap(enquiries.rows, 'enquiries');
    toMap(leads.rows, 'leads');
    toMap(opps.rows, 'opportunities');
    toMap(quotes.rows, 'quotations');
    toMap(orders.rows, 'orders');
    revenue.rows.forEach(r => {
      if (!monthMap[r.month]) monthMap[r.month] = { month: r.month, enquiries:0, leads:0, opportunities:0, quotations:0, orders:0, revenue:0 };
      monthMap[r.month].revenue = parseFloat(r.revenue || 0);
    });

    const result = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Conversion ratios ─────────────────────────────────────────────────────────
router.get('/conversion-ratios', async (req, res) => {
  try {
    const companyId = cid(req);
    const cond = companyId ? `AND (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];

    const [enquiries, leads, opps, quotes, orders] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM leads ${cond ? cond.replace('AND','WHERE') : ''}`, params).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) FROM leads WHERE status IN ('Qualified','Hot') ${cond}`, params).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) FROM opportunities ${cond ? cond.replace('AND','WHERE') : ''}`, params).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) FROM quotations ${cond ? cond.replace('AND','WHERE') : ''}`, params).catch(() => ({ rows: [{ count: 0 }] })),
      pool.query(`SELECT COUNT(*) FROM sales_orders ${cond ? cond.replace('AND','WHERE') : ''}`, params).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const e = parseInt(enquiries.rows[0].count || 0);
    const l = parseInt(leads.rows[0].count || 0);
    const o = parseInt(opps.rows[0].count || 0);
    const q = parseInt(quotes.rows[0].count || 0);
    const ord = parseInt(orders.rows[0].count || 0);

    const pct = (n, d) => d > 0 ? parseFloat(((n / d) * 100).toFixed(1)) : 0;

    res.json({
      funnel: { enquiries: e, leads: l, opportunities: o, quotations: q, orders: ord },
      ratios: {
        enquiry_to_lead: pct(l, e),
        lead_to_opportunity: pct(o, l),
        opportunity_to_quotation: pct(q, o),
        quotation_to_order: pct(ord, q),
        enquiry_to_order: pct(ord, e),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Salesperson performance ───────────────────────────────────────────────────
router.get('/salesperson-performance', async (req, res) => {
  try {
    const companyId = cid(req);
    const { fy_year } = req.query;
    const yr = parseInt(fy_year || new Date().getFullYear());
    // India FY: Apr yr to Mar yr+1
    const fyStart = `${yr}-04-01`;
    const fyEnd = `${yr + 1}-03-31`;

    const { rows } = await pool.query(`
      SELECT st.salesperson_name, st.target AS annual_target,
             COALESCE(SUM(so.total_amount),0) AS achieved,
             COUNT(so.id) AS orders_won,
             COUNT(q.id) AS quotes_sent,
             CASE WHEN st.target > 0
               THEN ROUND((COALESCE(SUM(so.total_amount),0) / st.target)*100, 1)
               ELSE 0 END AS achievement_pct,
             COALESCE(st.commission_rate,0) AS commission_rate,
             CASE WHEN st.target > 0
               THEN ROUND((COALESCE(SUM(so.total_amount),0) / st.target)*100*COALESCE(st.commission_rate,0)/100, 2)
               ELSE 0 END AS commission_earned
      FROM sales_targets st
      LEFT JOIN sales_orders so ON LOWER(so.salesperson) = LOWER(st.salesperson_name)
        AND so.order_date BETWEEN $1 AND $2
      LEFT JOIN quotations q ON LOWER(q.salesperson) = LOWER(st.salesperson_name)
        AND q.created_at BETWEEN $1 AND $2
      WHERE st.period_type='annual' AND st.period_year=$3
      GROUP BY st.salesperson_name, st.target, st.commission_rate
      ORDER BY achieved DESC
    `, [fyStart, fyEnd, yr]).catch(() => ({ rows: [] }));

    res.json(rows.map(r => ({
      ...r,
      annual_target: parseFloat(r.annual_target || 0),
      achieved: parseFloat(r.achieved || 0),
      achievement_pct: parseFloat(r.achievement_pct || 0),
      commission_earned: parseFloat(r.commission_earned || 0),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Won / Lost analysis ───────────────────────────────────────────────────────
router.get('/won-lost-analysis', async (req, res) => {
  try {
    const companyId = cid(req);
    const cond = companyId ? `AND (company_id=$1 OR company_id IS NULL)` : '';
    const params = companyId ? [companyId] : [];

    const [wonLost, lostReasons, salespersonWinRate] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(CASE WHEN stage='won' OR status='Won' THEN 1 END) AS won,
          COUNT(CASE WHEN stage='lost' OR status='Lost' THEN 1 END) AS lost,
          COALESCE(SUM(CASE WHEN stage='won' OR status='Won' THEN value ELSE 0 END),0) AS won_value,
          COALESCE(SUM(CASE WHEN stage='lost' OR status='Lost' THEN value ELSE 0 END),0) AS lost_value
        FROM opportunities ${cond ? cond.replace('AND','WHERE') : ''}
      `, params).catch(() => ({ rows: [{ won:0, lost:0, won_value:0, lost_value:0 }] })),
      pool.query(`
        SELECT COALESCE(lost_reason,'Not Specified') AS reason, COUNT(*) AS count,
               COALESCE(SUM(value),0) AS value
        FROM opportunities WHERE (stage='lost' OR status='Lost') ${cond}
        GROUP BY reason ORDER BY count DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT o.assigned_to AS salesperson,
               COUNT(CASE WHEN o.stage='won' THEN 1 END) AS won,
               COUNT(CASE WHEN o.stage='lost' THEN 1 END) AS lost,
               COUNT(*) AS total,
               CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(CASE WHEN o.stage='won' THEN 1 END)::numeric / COUNT(*) * 100,1) ELSE 0 END AS win_rate,
               COALESCE(SUM(CASE WHEN o.stage='won' THEN o.value ELSE 0 END),0) AS revenue
        FROM opportunities o
        WHERE o.assigned_to IS NOT NULL ${cond}
        GROUP BY o.assigned_to ORDER BY revenue DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),
    ]);
    const wl = wonLost.rows[0];
    res.json({
      won: parseInt(wl.won || 0),
      lost: parseInt(wl.lost || 0),
      won_value: parseFloat(wl.won_value || 0),
      lost_value: parseFloat(wl.lost_value || 0),
      win_rate: (parseInt(wl.won||0)+parseInt(wl.lost||0)) > 0
        ? parseFloat(((parseInt(wl.won||0)/(parseInt(wl.won||0)+parseInt(wl.lost||0)))*100).toFixed(1)) : 0,
      lost_reasons: lostReasons.rows.map(r => ({ ...r, count: parseInt(r.count), value: parseFloat(r.value||0) })),
      salesperson_win_rates: salespersonWinRate.rows.map(r => ({
        ...r, won: parseInt(r.won||0), lost: parseInt(r.lost||0), total: parseInt(r.total||0),
        win_rate: parseFloat(r.win_rate||0), revenue: parseFloat(r.revenue||0),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team/regional targets ─────────────────────────────────────────────────────
router.get('/team-targets', async (req, res) => {
  try {
    const companyId = cid(req);
    const { fy_year } = req.query;
    const yr = parseInt(fy_year || new Date().getFullYear());
    const params = [yr];
    let idx = 2;
    let cond = '';
    if (companyId) { cond = `AND company_id=$${idx++}`; params.push(companyId); }
    const { rows } = await pool.query(`
      SELECT target_type, team_name, region,
             SUM(target) AS total_target,
             SUM(achieved) AS total_achieved,
             CASE WHEN SUM(target) > 0
               THEN ROUND((SUM(achieved)/SUM(target))*100, 1) ELSE 0 END AS pct
      FROM sales_targets
      WHERE period_type='annual' AND period_year=$1
        AND target_type IN ('team','regional') ${cond}
      GROUP BY target_type, team_name, region
      ORDER BY total_target DESC
    `, params).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

export default router;
