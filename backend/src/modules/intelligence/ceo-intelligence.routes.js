// backend/src/modules/intelligence/ceo-intelligence.routes.js
// Phase 49H — CEO Customer & Vendor Intelligence Dashboard
// All endpoints: GET /api/v1/ceo-intelligence/*
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { respondError } from '../../shared/pgErrors.js';
import { companyOf } from '../../shared/scope.js';
import { resolveRange } from '../../shared/dashboardFilters.js';
import { classifyVendorScore, vendorScoreColor } from '../../shared/vendorScore.js';
import {
  TICKET_CLOSED, TICKET_CRITICAL, TICKET_ESCALATED,
  INVOICE_PAID, INVOICE_VOID, PROJECT_CLOSED, PROJECT_ACTIVE,
  AMC_ACTIVE, NCR_CLOSED, VENDOR_BLOCKED,
  isIn, notIn, sqlInvoiceOutstanding, sqlBillOutstanding,
} from '../../shared/statusSets.js';

const router = express.Router();
const cid = req => companyOf(req);

/**
 * Company filter fragment, interpolated rather than bound.
 *
 * 31 queries in this file build their company filter as a string. That is safe
 * only because `companyOf()` parses to an integer or null — but the safety of
 * every one of those sites then rests on a helper in another module continuing
 * to do that, which is not a property this file can see or a reviewer can check
 * locally. The coercion is repeated here so the guarantee is visible at the
 * point of interpolation: anything that is not a finite integer produces no
 * filter at all rather than reaching the query text.
 *
 * A null/absent company means a genuinely global scope (an unassigned super
 * admin), which is the established convention across the analytics surface.
 */
const cc = (companyId, alias = '') => {
  if (companyId == null || companyId === '') return '';
  const n = Number(companyId);
  if (!Number.isInteger(n)) return '';
  return alias ? `AND ${alias}.company_id=${n}` : `AND company_id=${n}`;
};

/** As `cc`, but emits a leading WHERE for queries with no other predicate. */
const cw2 = (companyId) => {
  const frag = cc(companyId);
  return frag ? frag.replace(/^AND /, 'WHERE ') : '';
};

// ── period filter ─────────────────────────────────────────────────────────────
/**
 * `col` restricted to the resolved range, as an always-bound predicate.
 *
 * The two placeholders are always present and always bound, so `period=all`
 * (which resolves both bounds to null) turns the predicate into a no-op rather
 * than changing the query TEXT. Conditional fragments renumber `$n` the moment
 * a second filter is added — the failure mode documented in §107.
 *
 * `to` is inclusive of the whole day; the `+ INTERVAL '1 day'` form is correct
 * for both DATE and TIMESTAMP columns, so it is used regardless of the column
 * type here.
 *
 * @param {string} col qualified column name — a literal from this file, never input
 * @param {number} n   index of the `from` placeholder; `to` is n + 1
 */
const inRange = (col, n) =>
  `($${n}::date IS NULL OR ${col} >= $${n}::date) `
  + `AND ($${n + 1}::date IS NULL OR ${col} < ($${n + 1}::date + INTERVAL '1 day'))`;

/**
 * Projects overlap a window; they do not happen on a date. A project running
 * Jan–Dec belongs in a Q3 view, and filtering it by `start_date` would drop it.
 * Rows missing either bound are kept — an open-ended project is still running.
 */
const projectOverlaps = (alias, n) =>
  `($${n}::date IS NULL OR ${alias}.end_date IS NULL OR ${alias}.end_date >= $${n}::date) `
  + `AND ($${n + 1}::date IS NULL OR ${alias}.start_date IS NULL `
  + `OR ${alias}.start_date <= $${n + 1}::date)`;

// ── shared formatter ──────────────────────────────────────────────────────────
const healthLabelCustomer = score =>
  score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Watchlist' : 'Critical';
const healthColorCustomer = score =>
  score >= 90 ? '#16a34a' : score >= 75 ? '#2563eb' : score >= 60 ? '#d97706' : '#dc2626';
// vendor_scorecards is scored 0-100 (shared/vendorScore.js). This used to band
// it at 4/3/2 -- correct only for the seeded 1-5 placeholder rows, and
// guaranteed to colour the first real scorecard green on the strength of
// `85 >= 4`. It now delegates to the one banding the health engine also uses.
const healthColorVendor = score => vendorScoreColor(score);

// ── customer revenue-growth window ────────────────────────────────────────────
/**
 * Pick the two windows a customer's revenue growth is measured across.
 *
 * The previous implementation compared FY-TO-DATE revenue against the FULL
 * prior financial year — five months of billing against twelve. Every customer
 * therefore scored somewhere around -60% to -100%, `growth_leaders` filtered on
 * `> 0`, and the Growth Center rendered "No growth data available" permanently.
 * The comparison has to be like-for-like, so the prior window is now the SAME
 * elapsed span, one year earlier.
 *
 * That alone is not enough on a young dataset: with less than a year of invoice
 * history the prior-year window is empty for everyone and the panel goes blank
 * again — truthfully, but uselessly. So when the year-ago window holds nothing
 * at all, the history is split at its midpoint and the two halves are compared
 * instead. Both halves are non-empty by construction, and `basis` travels with
 * the payload so the UI states exactly which windows produced the number rather
 * than implying a year-over-year read it did not make.
 *
 * @param {string} today          'YYYY-MM-DD'
 * @param {string|null} firstInvoice earliest non-void invoice date, or null
 * @returns {{curStart:string,curEnd:string,prevStart:string,prevEnd:string,basis:'yoy'|'half',label:string}}
 */
const iso = d => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const addYears = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return iso(d);
};
const monthName = isoDate =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const growthWindows = (today, firstInvoice, fyStart) => {
  // Exclusive upper bound, so an invoice dated today is inside the window.
  const curEnd = addDays(today, 1);
  const yoy = {
    curStart: fyStart, curEnd,
    prevStart: addYears(fyStart, -1), prevEnd: addYears(curEnd, -1),
    basis: 'yoy',
    label: `FY to date (${monthName(fyStart)} – ${monthName(today)}) vs the same months a year earlier`,
  };
  // No history at all, or history that reaches back past the year-ago window →
  // a real year-over-year read is available.
  if (!firstInvoice || firstInvoice < yoy.prevEnd) return yoy;

  // Otherwise split what history there is down the middle.
  const spanDays = Math.round(
    (new Date(`${curEnd}T00:00:00Z`) - new Date(`${firstInvoice}T00:00:00Z`)) / 86400000
  );
  const mid = addDays(firstInvoice, Math.max(1, Math.floor(spanDays / 2)));
  return {
    curStart: mid, curEnd, prevStart: firstInvoice, prevEnd: mid,
    basis: 'half',
    label: `${monthName(mid)} – ${monthName(today)} vs ${monthName(firstInvoice)} – ${monthName(mid)}`
      + ' — invoice history is under a year, so the period before it is used in place of last year',
  };
};

// ── 1. EXECUTIVE SUMMARY ─────────────────────────────────────────────────────
// GET /ceo-intelligence/executive-summary
router.get('/executive-summary', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = cc(companyId);
    // Activity follows the filter; backlog does not. Outstanding AR, the open
    // pipeline, the project counters and the AP position below are all
    // point-in-time balances — narrowing the period must not hide work that is
    // still awaiting action, so they are deliberately left unbounded.
    const range = resolveRange(req.query);
    const rp = [range.from, range.to];

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [
      revMonth, revYTD, outstanding, pipeline, projects,
      poPayable, vendorCount, customerCount, amcTotal,
      revTrend,
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE ${isIn('status', INVOICE_PAID)} AND invoice_date >= $1 ${cw}`, [monthStart]).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE ${isIn('status', INVOICE_PAID)} AND ${inRange('invoice_date', 1)} ${cw}`, rp).catch(() => ({ rows: [{ v: 0 }] })),
      // Outstanding is now defined as "not paid and not void", the same predicate
      // CFO's Accounts Receivable uses. The old `IN ('overdue','pending')` silently
      // dropped every invoice in any other unpaid state — 'Sent' invoices in this
      // database — so the two pages reported different receivables for the same day.
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices WHERE ${sqlInvoiceOutstanding()} ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(expected_value),0) AS v FROM opportunities WHERE deleted_at IS NULL AND LOWER(stage) NOT IN ('closed won','closed lost','closed_won','closed_lost') ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      // 'delayed' is never a stored status (projects_status_check doesn't allow it) — it's a
      // derived condition (past end_date, not yet completed/cancelled), same logic the
      // /projects endpoint below already computes per-row as `isDelayed`.
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(CASE WHEN ${isIn('status', PROJECT_ACTIVE)} THEN 1 END)::int AS active, COUNT(CASE WHEN end_date < NOW() AND ${notIn('status', PROJECT_CLOSED)} THEN 1 END)::int AS delayed FROM projects WHERE deleted_at IS NULL ${cw}`).catch(() => ({ rows: [{ total: 0, active: 0, delayed: 0 }] })),
      // vendor_invoices doesn't exist — the real AP-ledger table is bills, with lowercase
      // status values; balance (not total_amount) is the actual outstanding-payable figure.
      pool.query(`SELECT COALESCE(SUM(balance),0) AS v FROM bills WHERE ${sqlBillOutstanding()} ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM vendors WHERE 1=1 ${cw}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(DISTINCT customer_id)::int AS c FROM invoices WHERE 1=1 ${cw}`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COALESCE(SUM(contract_value),0) AS v FROM amc_contracts WHERE ${isIn('status', AMC_ACTIVE)} ${cw}`).catch(() => ({ rows: [{ v: 0 }] })),
      // 6-month revenue trend
      pool.query(`
        SELECT TO_CHAR(invoice_date,'YYYY-MM') AS month,
               COALESCE(SUM(total_amount) FILTER (WHERE ${isIn('status', INVOICE_PAID)}),0) AS revenue,
               COALESCE(SUM(total_amount) FILTER (WHERE ${sqlInvoiceOutstanding()}),0) AS outstanding
        FROM invoices
        WHERE invoice_date >= NOW() - INTERVAL '6 months' ${cw}
        GROUP BY month ORDER BY month
      `).catch(() => ({ rows: [] })),
    ]);

    const revMonthVal = parseFloat(revMonth.rows[0]?.v || 0);
    const revYTDVal   = parseFloat(revYTD.rows[0]?.v || 0);
    const pipelineVal = parseFloat(pipeline.rows[0]?.v || 0);
    const outstandingVal = parseFloat(outstanding.rows[0]?.v || 0);

    // Forecast = weighted pipeline + YTD run-rate.
    //
    // The weight used to be a hardcoded 0.35 while computeSalesKPIs was already
    // measuring the real historical win rate from `opportunities` a few files
    // away. It now uses that measured rate, and only falls back to a documented
    // default when there is not yet enough closed history to measure one — in
    // which case `forecast_basis` says so, so the UI can label the number
    // instead of presenting an assumption as a calculation.
    const winRate = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE LOWER(stage) IN ('closed_won','closed won'))::float AS won,
             COUNT(*) FILTER (WHERE LOWER(stage) IN ('closed_won','closed won','closed_lost','closed lost'))::float AS closed
      FROM opportunities WHERE deleted_at IS NULL ${cw}
    `).catch(() => ({ rows: [{ won: 0, closed: 0 }] }));
    const closedCount = parseFloat(winRate.rows[0]?.closed || 0);
    const wonCount    = parseFloat(winRate.rows[0]?.won || 0);
    const measuredWinRate = closedCount >= 5 ? wonCount / closedCount : null;
    const DEFAULT_WIN_RATE = 0.35;
    const appliedWinRate = measuredWinRate ?? DEFAULT_WIN_RATE;
    const monthsElapsed = Math.max(now.getMonth() >= 3 ? now.getMonth() - 3 + 1 : now.getMonth() + 10, 1);
    const forecastRev = pipelineVal * appliedWinRate + (revYTDVal / monthsElapsed) * 3;

    // Traffic lights.
    //
    // `supply_chain` and `profitability` were the literal string 'green' — they
    // asserted health without measuring anything, on the one widget whose entire
    // job is to say whether something needs attention. Both are computed now, and
    // both report 'unknown' (rendered as a grey dot) when their inputs are absent,
    // rather than claiming a clean bill of health the data cannot support.
    const [scRow, profRow] = await Promise.all([
      // Supply chain: blocked vendors, or single-source vendors carrying open NCRs.
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE ${isIn('v.status', VENDOR_BLOCKED)})::int      AS blocked,
               COUNT(*) FILTER (WHERE v.is_single_source IS TRUE)::int               AS single_source,
               COUNT(*) FILTER (WHERE v.is_critical_supplier IS TRUE)::int           AS critical,
               COUNT(*)::int                                                          AS total
        FROM vendors v
        WHERE v.deleted_at IS NULL ${cc(companyId, 'v')}
      `).catch(() => ({ rows: [] })),
      // Profitability: portfolio margin, only where cost has actually been booked.
      pool.query(`
        SELECT COALESCE(SUM(p.budget_amount),0) AS budget,
               COALESCE(SUM(cs.total_cost),0)   AS cost,
               COUNT(cs.project_id)::int         AS costed
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.deleted_at IS NULL ${cw}
      `).catch(() => ({ rows: [] })),
    ]);
    const sc = scRow.rows?.[0];
    const pf = profRow.rows?.[0];
    const supplyChainLight = !sc || sc.total === 0 ? 'unknown'
      : sc.blocked > 0 ? 'red'
      : sc.single_source > 0 ? 'amber'
      : 'green';
    const portfolioMargin = pf && parseFloat(pf.budget) > 0
      ? (parseFloat(pf.budget) - parseFloat(pf.cost)) / parseFloat(pf.budget)
      : null;
    const profitabilityLight = !pf || pf.costed === 0 || portfolioMargin == null ? 'unknown'
      : portfolioMargin < 0.05 ? 'red'
      : portfolioMargin < 0.15 ? 'amber'
      : 'green';

    const trafficLights = {
      revenue: revMonthVal > 0 ? 'green' : 'amber',
      collections: outstandingVal > revYTDVal * 0.3 ? 'red' : outstandingVal > revYTDVal * 0.15 ? 'amber' : 'green',
      projects: projects.rows[0]?.delayed > 2 ? 'red' : projects.rows[0]?.delayed > 0 ? 'amber' : 'green',
      supply_chain: supplyChainLight,
      profitability: profitabilityLight,
    };

    res.json({
      // Echoed so cards can label themselves from the response instead of
      // asserting a fixed window the filter may have moved.
      period: { period: range.period, label: range.label, from: range.from, to: range.to },
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
      // Surfaced so the Forecast tile can name its own assumption instead of
      // presenting a coefficient as though it were measured.
      forecast_basis: measuredWinRate != null
        ? `measured win rate ${(measuredWinRate * 100).toFixed(0)}% over ${closedCount} closed opportunities`
        : `assumed ${(DEFAULT_WIN_RATE * 100).toFixed(0)}% win rate — fewer than 5 closed opportunities on record`,
      forecast_win_rate: appliedWinRate,
      forecast_is_measured: measuredWinRate != null,
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
    const cw = cc(companyId, 'p');
    const cwBase = cc(companyId);

    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? `${now.getFullYear()}-04-01`
      : `${now.getFullYear() - 1}-04-01`;
    const today = iso(now);
    // Drives the per-customer `revenue` column only. The growth board below is
    // deliberately NOT filtered: it is a fixed comparison between two equal
    // windows, and letting a page filter move one of them would make the
    // percentage mean something different on every selection.
    const range = resolveRange(req.query);
    const rp = [range.from, range.to];

    // Growth is measured on BILLED revenue, not collected. `revenue` below is
    // paid-only, which is the right basis for "what has this account been worth"
    // but the wrong one for "is this account growing": an invoice raised last
    // month and not yet settled reads as the customer having stopped buying.
    // That is a collections signal, and the page already carries it separately
    // as Outstanding and on the Collections tab.
    const hist = await pool.query(
      `SELECT MIN(invoice_date) AS first_invoice FROM invoices
        WHERE ${notIn('status', INVOICE_VOID)} AND customer_id IS NOT NULL ${cwBase}`
    ).catch(() => ({ rows: [] }));
    // invoice_date is DATE — the pg type parser hands these back as
    // 'YYYY-MM-DD' strings already, so no Date round-trip (and no timezone
    // shift) is needed here.
    const win = growthWindows(today, hist.rows[0]?.first_invoice || null, fyStart);

    const [topRevenue, outstanding, prevRevenue, projectMargins, openTickets, amcStatus, openNcr] = await Promise.all([
      pool.query(`
        SELECT p.id, p.name, p.city, p.state,
               COALESCE(SUM(i.total_amount) FILTER (WHERE ${isIn('i.status', INVOICE_PAID)} AND ${inRange('i.invoice_date', 1)}), 0) AS revenue,
               COALESCE(SUM(i.total_amount) FILTER (WHERE ${isIn('i.status', INVOICE_PAID)}), 0) AS revenue_all_time,
               COALESCE(SUM(i.total_amount) FILTER (WHERE ${sqlInvoiceOutstanding('i.status')}), 0) AS outstanding,
               COUNT(DISTINCT i.id) FILTER (WHERE ${isIn('i.status', INVOICE_PAID)})::int AS invoice_count
        FROM parties p
        LEFT JOIN invoices i ON i.customer_id = p.id
        WHERE (p.party_type='Customer' OR p.party_type IS NULL) ${cw}
        GROUP BY p.id, p.name, p.city, p.state
        HAVING COUNT(i.id) > 0
        ORDER BY revenue DESC LIMIT 50
      `, rp).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT customer_id, COALESCE(SUM(total_amount),0) AS outstanding,
               MAX(due_date) AS last_due
        FROM invoices WHERE ${sqlInvoiceOutstanding()} ${cwBase}
        GROUP BY customer_id ORDER BY outstanding DESC LIMIT 20
      `).catch(() => ({ rows: [] })),

      // Both windows in one pass. Equal-length spans — the old query compared
      // the whole prior financial year against a five-month year-to-date and so
      // scored every customer as collapsing.
      pool.query(`
        SELECT customer_id,
               COALESCE(SUM(total_amount) FILTER (WHERE invoice_date >= $1 AND invoice_date < $2),0) AS curr_billed,
               COALESCE(SUM(total_amount) FILTER (WHERE invoice_date >= $3 AND invoice_date < $4),0) AS prev_billed
        FROM invoices
        WHERE ${notIn('status', INVOICE_VOID)} AND customer_id IS NOT NULL ${cwBase}
        GROUP BY customer_id
      `, [win.curStart, win.curEnd, win.prevStart, win.prevEnd]).catch(() => ({ rows: [] })),

      // projects has no customer_id FK, only free-text customer_name/client_name — best-effort
      // name-match onto parties, same discipline used for service_contracts/field_visits elsewhere.
      pool.query(`
        SELECT pt.id AS customer_id,
               COALESCE(SUM(p.budget_amount),0) AS budget,
               COALESCE(SUM(cs.total_cost),0) AS actual
        FROM projects p
        JOIN parties pt ON LOWER(pt.name) = LOWER(COALESCE(p.customer_name, p.client_name))
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE COALESCE(p.customer_name, p.client_name) IS NOT NULL AND p.deleted_at IS NULL ${cc(companyId, 'p')}
        GROUP BY pt.id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        -- support_tickets.priority is written as 'Low'/'Medium'/'High'/'Critical'
        -- from the UI, so priority='critical' matched nothing and the customer
        -- health score's 25-point ticket component was pinned at full marks for
        -- every customer. Case-insensitive now, as is the open-ticket predicate,
        -- which previously disagreed with /dashboard/operations purely on casing.
        SELECT customer_id, COUNT(*)::int AS open_tickets,
               COUNT(*) FILTER (WHERE ${isIn('priority', TICKET_CRITICAL)})::int AS critical_tickets,
               COUNT(*) FILTER (WHERE ${isIn('status', TICKET_ESCALATED)})::int  AS escalated
        FROM support_tickets
        WHERE ${notIn('status', TICKET_CLOSED)} AND deleted_at IS NULL ${cwBase}
        GROUP BY customer_id
      `).catch(() => ({ rows: [] })),

      // amc_contracts has no customer_id/annual_value — resolve via sales_order_id -> sales_orders.customer_id
      pool.query(`
        SELECT so.customer_id, COUNT(*)::int AS active_amc,
               COALESCE(SUM(ac.contract_value),0) AS amc_revenue,
               MIN(CASE WHEN ac.status='active' THEN ac.end_date END) AS next_expiry
        FROM amc_contracts ac
        JOIN sales_orders so ON so.id = ac.sales_order_id
        WHERE ${isIn('ac.status', AMC_ACTIVE)} ${cc(companyId, 'ac')}
        GROUP BY so.customer_id
      `).catch(() => ({ rows: [] })),

      // projects has no customer_id — resolve via best-effort name-match onto parties,
      // same pattern as the projectMargins query above.
      pool.query(`
        SELECT pt.id AS customer_id, COUNT(*)::int AS open_ncr
        FROM ncr_reports n
        JOIN projects proj ON proj.id = n.project_id
        JOIN parties pt ON LOWER(pt.name) = LOWER(COALESCE(proj.customer_name, proj.client_name))
        WHERE ${notIn('n.status', NCR_CLOSED)} AND COALESCE(proj.customer_name, proj.client_name) IS NOT NULL
        ${cc(companyId, 'n')}
        GROUP BY pt.id
      `).catch(() => ({ rows: [] })),
    ]);

    // Build lookup maps
    const outMap    = {};  outstanding.rows.forEach(r => { outMap[r.customer_id] = r; });
    const growthMap = {};  prevRevenue.rows.forEach(r => {
      growthMap[r.customer_id] = {
        curr: parseFloat(r.curr_billed) || 0,
        prev: parseFloat(r.prev_billed) || 0,
      };
    });
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
      const currRev   = parseFloat(c.revenue);
      const gw        = growthMap[c.id] || { curr: 0, prev: 0 };

      // Health score (100-point)
      const pScore  = Math.max(0, 25 - overdue * 8);
      const mScore  = margin != null ? (margin >= 20 ? 25 : margin >= 10 ? 18 : margin >= 0 ? 10 : 0) : 15;
      const tScore  = Math.max(0, 25 - tickets * 8);
      const amcScore = hasAMC ? 25 : 10;
      const health  = pScore + mScore + tScore + amcScore;

      // Revenue growth over the two equal windows chosen above. A customer with
      // nothing in the prior window has no percentage to report — dividing by
      // zero used to null the whole customer out of the leaderboard, which hid
      // exactly the accounts that grew fastest. They are flagged instead.
      const revenueGrowth = gw.prev > 0
        ? Math.round(((gw.curr - gw.prev) / gw.prev) * 100)
        : null;
      const isNewRevenue = gw.prev === 0 && gw.curr > 0;

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
        billed_current: gw.curr,
        billed_prior: gw.prev,
        revenue_growth_pct: revenueGrowth,
        is_new_revenue: isNewRevenue,
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

    // Growth board. Only accounts that billed something in one of the two
    // windows can be ranked — a customer with no activity in either has no
    // movement to report and is not a "0% grower".
    const measurable = customers.filter(c => c.billed_current > 0 || c.billed_prior > 0);

    // New revenue first (no prior-window baseline, so no percentage — ranked by
    // what they actually billed), then the risers, steepest first.
    const growthLeaders = [
      ...measurable.filter(c => c.is_new_revenue).sort((a, b) => b.billed_current - a.billed_current),
      ...measurable.filter(c => c.revenue_growth_pct > 0).sort((a, b) => b.revenue_growth_pct - a.revenue_growth_pct),
    ].slice(0, 10);

    // The mirror image, and the reason this section used to look broken: when
    // every account is contracting there are no leaders to show. Shipping the
    // decliners alongside means the panel reports the real picture instead of
    // an empty state that reads as missing data.
    // Steepest first, then — because a lapsed account is -100% whatever its size
    // — biggest rupee loss first among the ties. Without the tie-break a customer
    // that stopped at 62k outranked one that stopped at 21 lakh.
    const growthDecliners = measurable
      .filter(c => c.revenue_growth_pct != null && c.revenue_growth_pct < 0)
      .sort((a, b) =>
        (a.revenue_growth_pct - b.revenue_growth_pct)
        || ((b.billed_prior - b.billed_current) - (a.billed_prior - a.billed_current)))
      .slice(0, 10);

    // Risk list (critical + high risk, sorted)
    const atRisk = customers
      .filter(c => c.risk_level === 'Critical' || c.risk_level === 'High')
      .sort((a, b) => a.health_score - b.health_score)
      .slice(0, 15);

    res.json({
      // Echoed so cards can label themselves from the response instead of
      // asserting a fixed window the filter may have moved.
      period: { period: range.period, label: range.label, from: range.from, to: range.to },
      customers: customers.slice(0, 20),
      all_customers: customers,
      health_distribution: Object.entries(dist).map(([label, count]) => ({ label, count })),
      growth_leaders: growthLeaders,
      growth_decliners: growthDecliners,
      // Lets the UI name the windows it is showing rather than claiming a
      // year-over-year read the data may not support.
      growth_basis: {
        basis: win.basis,
        label: win.label,
        current_from: win.curStart, current_to: win.curEnd,
        prior_from: win.prevStart, prior_to: win.prevEnd,
        measured_customers: measurable.length,
      },
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

// ── Convert an AI-detected upsell signal into a real, trackable CRM
// opportunity (Priority 2/4: "AI detects opportunity -> Create CRM
// Opportunity -> Assign Salesperson -> Create Task -> Notify Sales Manager ->
// Track Conversion"). Previously `upsell_opportunity` (computed above) was
// only ever rendered as a plain, unclickable label on the dashboard — see
// MODULE_FEATURE_CONNECTION_MANUAL.md §18.1 #7.
// POST /ceo-intelligence/customers/:partyId/convert-upsell
router.post('/customers/:partyId/convert-upsell', requirePermission('crm', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { partyId } = req.params;
    const { reason, expected_value, assigned_to } = req.body;
    const companyId = cid(req);
    const actorUserId = req.user?.userId ?? req.user?.id ?? null;

    await client.query('BEGIN');

    const { rows: [party] } = await client.query(`SELECT id, name FROM parties WHERE id=$1`, [partyId]);
    if (!party) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer not found' }); }

    // Resolve the CRM account bridging this Finance party. accounts.party_id
    // exists as a schema link but is unpopulated for most rows today (same
    // "real column, empty in practice" gap as vendors.party_id) — try the
    // real link first, fall back to a best-effort name match (and backfill
    // the link when found), else create a fresh account so the opportunity
    // has somewhere real to live.
    let account;
    ({ rows: [account] } = await client.query(`SELECT * FROM accounts WHERE party_id=$1`, [partyId]));
    if (!account) {
      ({ rows: [account] } = await client.query(
        `SELECT * FROM accounts WHERE party_id IS NULL AND LOWER(account_name)=LOWER($1) AND (company_id=$2 OR $2 IS NULL) LIMIT 1`,
        [party.name, companyId]
      ));
      if (account) {
        await client.query(`UPDATE accounts SET party_id=$1, updated_at=NOW() WHERE id=$2`, [partyId, account.id]);
      }
    }
    if (!account) {
      ({ rows: [account] } = await client.query(
        `INSERT INTO accounts (name, account_type, company_id, party_id)
         VALUES ($1,'Customer',$2,$3) RETURNING *`,
        [party.name, companyId, partyId]
      ));
    }

    // Idempotent: don't spawn a second open upsell opportunity for the same account
    const { rows: dup } = await client.query(
      `SELECT id FROM opportunities
       WHERE account_id=$1 AND deleted_at IS NULL AND LOWER(stage) NOT IN ('won','lost')
         AND opportunity_name ILIKE 'Upsell:%'`,
      [account.id]
    );
    if (dup.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An open upsell opportunity already exists for this account', opportunity_id: dup[0].id });
    }

    // Assign Salesperson — the account's existing owner if known, else whoever
    // triggered the conversion (there's no reliable territory/round-robin
    // signal for an AI-detected upsell the way there is for inbound leads).
    const assignedTo = assigned_to || account.assigned_to || actorUserId;
    const label = reason || 'Account Growth';
    const followUpDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const { rows: [opp] } = await client.query(
      `INSERT INTO opportunities
         (opportunity_name, account_id, stage, expected_value, probability_percentage,
          assigned_to, created_by, company_id, notes, next_step, follow_up_date)
       VALUES ($1,$2,'Qualification',$3,30,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        `Upsell: ${label} — ${party.name}`,
        account.id,
        expected_value || null,
        assignedTo,
        actorUserId,
        companyId,
        `Auto-created from CEO Intelligence upsell signal (${label}).`,
        `Follow up with ${party.name} regarding ${label.toLowerCase()}`,
        followUpDate,
      ]
    );

    // Notify Sales Manager
    const { rows: managers } = await client.query(
      `SELECT id FROM users WHERE is_active=true AND LOWER(role) IN ('admin','super_admin','sales_manager','manager')`
    );
    for (const m of managers) {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
         VALUES ($1,$2,$3,'crm',$4,'upsell_opportunity')`,
        [m.id, `New Upsell Opportunity: ${party.name}`,
         `${label} opportunity detected for ${party.name} — created as opportunity #${opp.id}.`,
         opp.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(opp);
  } catch (err) {
    await client.query('ROLLBACK');
    // `parties.id` is a uuid. A non-uuid :partyId reaches Postgres and raises
    // 22P02 (invalid text representation), which this handler turned into a 500
    // — a malformed request reported as a server fault, and in development the
    // raw Postgres text went back to the caller with it. respondError maps the
    // constraint SQLSTATEs to 4xx and leaves anything genuinely unexpected as a
    // 500 for errorSanitizer to scrub.
    respondError(res, err);
  } finally {
    client.release();
  }
});

// ── 3. VENDOR INTELLIGENCE ───────────────────────────────────────────────────
// GET /ceo-intelligence/vendors
router.get('/vendors', requirePermission('procurement', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw  = cc(companyId, 'v');
    const cwP = cc(companyId, 'po');
    const cwBase = cc(companyId);
    // PO spend is activity and follows the period. Scorecards, NCR counts and
    // the vendor master itself are current-state and stay unbounded.
    const range = resolveRange(req.query);

    const [topVendors, scorecards, ncrSummary, delivery, projectImpact, criticalItems] = await Promise.all([
      pool.query(`
        SELECT v.id, v.name, v.vendor_code, v.vendor_type, v.status, v.city, v.state,
               v.msme_status,
               COALESCE(v.is_critical_supplier, false) AS critical_vendor,
               COALESCE(v.is_long_lead, false)         AS long_lead,
               COALESCE(pa.po_count, 0) AS po_count,
               COALESCE(pa.po_value, 0) AS po_value,
               COALESCE(pa.open_pos, 0) AS open_pos,
               -- vendors.is_single_source is a real boolean on the vendor master.
               -- This used to rely solely on a notes ILIKE scan of purchase
               -- agreements, so a vendor correctly flagged single-source in the
               -- master did not register unless someone had also typed the words
               -- into an agreement note. The master flag wins; the note scan is
               -- kept as a fallback for vendors predating the column.
               COALESCE(v.is_single_source, pa.single_source, false) AS single_source
        FROM vendors v
        LEFT JOIN (
          SELECT supplier_id AS vendor_id,
                 COUNT(*)::int AS po_count,
                 SUM(total_amount) AS po_value,
                 COUNT(CASE WHEN status IN ('Approved','Sent','Partial') THEN 1 END)::int AS open_pos,
                 BOOL_OR(CASE WHEN notes ILIKE '%single source%' OR notes ILIKE '%sole source%' THEN true ELSE false END) AS single_source
          FROM purchase_orders
          WHERE ${inRange('order_date', 1)} ${cc(companyId)}
          GROUP BY supplier_id
        ) pa ON pa.vendor_id = v.id
        WHERE 1=1 ${cw}
        ORDER BY pa.po_value DESC NULLS LAST LIMIT 50
      `, [range.from, range.to]).catch(() => ({ rows: [] })),

      // `cwBase` is cc(companyId), which emits "AND company_id=…". Both of these
      // queries have no other predicate, so it landed straight after a bare FROM
      // and Postgres raised 42601 syntax error on every call. The catch swallowed
      // it, both maps came back empty, and every vendor was therefore scored 0 —
      // rendering all of them as "Watchlist / High risk" on the CEO's screen from
      // nothing at all. cw2() is the variant that emits a leading WHERE.
      pool.query(`
        SELECT DISTINCT ON (vendor_id) vendor_id,
               (quality_score+delivery_score+cost_score+support_score+compliance_score)/5.0 AS overall,
               quality_score, delivery_score, compliance_score
        FROM vendor_scorecards ${cw2(companyId)}
        ORDER BY vendor_id, created_at DESC
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT vendor_id, COUNT(*)::int AS total, COUNT(CASE WHEN status!='Closed' THEN 1 END)::int AS open
        FROM ncr_reports ${cw2(companyId)}
        GROUP BY vendor_id
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT supplier_id AS vendor_id,
               COUNT(CASE WHEN status IN ('Received','Completed') THEN 1 END)::int AS completed,
               COUNT(*)::int AS total
        FROM purchase_orders po WHERE 1=1 ${cwP}
        GROUP BY supplier_id
      `).catch(() => ({ rows: [] })),

      // Projects where a vendor has open POs (supply risk to project)
      pool.query(`
        SELECT po.supplier_id AS vendor_id, COUNT(DISTINCT p.id)::int AS project_count
        FROM purchase_orders po
        JOIN projects p ON p.id = po.project_id
        WHERE p.status IN ('active','in_progress') ${cwP}
        GROUP BY po.supplier_id
      `).catch(() => ({ rows: [] })),

      // Critical/long-lead items from item master — real table is inventory_items, with a
      // category_id FK (not free-text category) and preferred_vendor_id (not vendor_id).
      pool.query(`
        SELECT ii.preferred_vendor_id AS vendor_id, COUNT(*)::int AS critical_items
        FROM inventory_items ii
        LEFT JOIN item_categories ic ON ic.id = ii.category_id
        WHERE (ic.name ILIKE '%critical%' OR ii.lead_time_days > 60) AND ii.preferred_vendor_id IS NOT NULL
        ${cc(companyId, 'ii')}
        GROUP BY ii.preferred_vendor_id
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
      // UNMEASURED IS NOT ZERO. A vendor with no scorecard row used to fall
      // through `parseFloat(undefined || 0)` to 0 and be labelled "Watchlist" —
      // a judgement the data never supported. `scored` says whether anyone has
      // actually assessed this vendor, and the label says "Not Scored" when
      // nobody has, so the CEO can tell an unrated supplier from a bad one.
      const scored  = sc.overall != null;
      const overall = scored ? parseFloat(sc.overall) : null;

      // Health classification. The band comes from shared/vendorScore.js on the
      // 0-100 scale; 'Blocked' is this board's own overlay -- a supplier in the
      // bottom band with a stack of open NCRs is not merely being watched.
      const banded = classifyVendorScore(overall);
      const rawLabel = !scored
        ? (ncr.open > 3 ? 'Blocked' : 'Not Scored')
        : banded === 'Critical' ? (ncr.open > 3 ? 'Blocked' : 'Watchlist')
        : banded;

      // Risk calculation
      const riskScore =
        (rawLabel === 'Blocked' ? 4 : rawLabel === 'Watchlist' ? 2 : 0) +
        // An unrated vendor is unknown, not safe and not risky — it contributes
        // nothing here and is surfaced through `scored:false` instead.
        0 +
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
        scored,
        overall_score: overall,
        quality_score: scored ? parseFloat(sc.quality_score ?? 0) : null,
        delivery_score: scored ? parseFloat(sc.delivery_score ?? 0) : null,
        compliance_score: scored ? parseFloat(sc.compliance_score ?? 0) : null,
        total_ncrs: ncr.total,
        open_ncrs: ncr.open,
        on_time_delivery_pct: otd,
        projects_impacted: projMap[v.id] || 0,
        critical_items: ciMap[v.id] || 0,
        long_lead: v.long_lead,
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
      // Echoed so cards can label themselves from the response instead of
      // asserting a fixed window the filter may have moved.
      period: { period: range.period, label: range.label, from: range.from, to: range.to },
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
    const cw = cc(companyId, 'p');
    const range = resolveRange(req.query);

    const [projects, costBreakdown] = await Promise.all([
      // projects has no customer_id/contract_value/expected_end_date columns and no "name"
      // (real: project_name) — best-effort name-match onto parties for customer_id, same
      // discipline used for service_contracts/field_visits elsewhere; contract_value has no
      // real equivalent so it's omitted (JS already falls back to budget via `p.contract_value || budget`).
      pool.query(`
        SELECT p.id, p.project_code, p.project_name AS name, pt.id AS customer_id, p.status,
               COALESCE(p.customer_name, p.client_name) AS customer_name,
               p.budget_amount, p.start_date, p.end_date AS expected_end_date,
               cs.total_cost    AS actual_cost,
               COALESCE(cs.total_revenue, 0) AS invoiced
        FROM projects p
        LEFT JOIN parties pt ON LOWER(pt.name) = LOWER(COALESCE(p.customer_name, p.client_name))
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.deleted_at IS NULL AND ${projectOverlaps('p', 1)} ${cw}
        ORDER BY p.budget_amount DESC NULLS LAST LIMIT 50
      `, [range.from, range.to]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT cost_type, COALESCE(SUM(amount),0) AS total
        FROM project_cost_lines WHERE 1=1 ${cc(companyId)}
        GROUP BY cost_type ORDER BY total DESC
      `).catch(() => ({ rows: [] })),
    ]);

    const enriched = projects.rows.map(p => {
      const budget  = parseFloat(p.budget_amount || 0);
      const actual  = p.actual_cost == null ? 0 : parseFloat(p.actual_cost);
      const invoiced = parseFloat(p.invoiced || 0);
      const contract = parseFloat(p.contract_value || budget);
      // `project_cost_summary` is the only source of actual cost. When a project
      // has no row there, cost is unknown — not zero. Treating unknown as zero
      // made every uncosted project report 100% margin and a green "On Track"
      // health label, which is the most dangerous possible default on a
      // profitability dashboard. `has_cost_data` carries that distinction to the
      // UI so the panel can render "—" instead of a fabricated margin.
      const hasCostData = p.actual_cost !== null && p.actual_cost !== undefined;
      const profit  = hasCostData ? contract - actual : null;
      const margin  = hasCostData && contract > 0 ? Math.round(((contract - actual) / contract) * 100) : null;
      const budgetVar = hasCostData && budget > 0 ? Math.round(((actual - budget) / budget) * 100) : null;

      const now = new Date();
      const endDate = p.expected_end_date ? new Date(p.expected_end_date) : null;
      const isDelayed = endDate && endDate < now
        && !['completed', 'cancelled', 'closed'].includes(String(p.status || '').toLowerCase());
      const isOverBudget = budgetVar != null && budgetVar > 10;
      const isLossMaking = margin != null && margin < 0;

      // Health is only claimed where it can be evidenced. Schedule is always
      // known; margin is only known once cost has been booked.
      let healthLabel = hasCostData ? 'On Track' : 'Cost Not Tracked';
      let healthColor = hasCostData ? '#16a34a' : '#9ca3af';
      if (isLossMaking || (isDelayed && isOverBudget)) { healthLabel = 'Critical'; healthColor = '#dc2626'; }
      else if (isDelayed || isOverBudget) { healthLabel = 'At Risk'; healthColor = '#d97706'; }
      else if (margin != null && margin < 5) { healthLabel = 'Margin Watch'; healthColor = '#f59e0b'; }

      return {
        id: p.id, code: p.project_code, name: p.name,
        customer_id: p.customer_id, customer_name: p.customer_name,
        status: p.status, budget, actual_cost: actual, contract_value: contract,
        invoiced, profit, margin_pct: margin, budget_variance_pct: budgetVar,
        has_cost_data: hasCostData,
        is_delayed: isDelayed, is_over_budget: isOverBudget, is_loss_making: isLossMaking,
        health_label: healthLabel, health_color: healthColor,
        start_date: p.start_date, expected_end_date: p.expected_end_date,
      };
    });

    // Portfolio roll-ups cover only the projects that actually have cost booked;
    // averaging costed and uncosted projects together overstates margin.
    //
    // Contract value is the exception: it comes from the project record and does
    // not depend on cost at all. Restricting it to the costed subset made the
    // "Total Contract Value" card read Rs 0 while the table directly beneath it
    // listed three projects worth Rs 50,000 each — a card contradicting the rows
    // it summarises. It is now reported across every project, with the costed
    // subset carried separately so margin still divides by a like-for-like base.
    const costed         = enriched.filter(p => p.has_cost_data);
    const totalContract  = enriched.reduce((s, p) => s + p.contract_value, 0);
    const costedContract = costed.reduce((s, p) => s + p.contract_value, 0);
    const totalActual    = costed.reduce((s, p) => s + p.actual_cost, 0);
    const totalProfit    = costed.reduce((s, p) => s + (p.profit || 0), 0);

    res.json({
      // Echoed so cards can label themselves from the response instead of
      // asserting a fixed window the filter may have moved.
      period: { period: range.period, label: range.label, from: range.from, to: range.to },
      projects: enriched,
      top_profitable: [...enriched].sort((a, b) => b.profit - a.profit).slice(0, 10),
      loss_making: enriched.filter(p => p.is_loss_making).sort((a, b) => a.margin_pct - b.margin_pct),
      over_budget: enriched.filter(p => p.is_over_budget).sort((a, b) => b.budget_variance_pct - a.budget_variance_pct),
      delayed: enriched.filter(p => p.is_delayed),
      cost_breakdown: costBreakdown.rows,
      summary: {
        total_projects: enriched.length,
        costed_projects: costed.length,
        uncosted_projects: enriched.length - costed.length,
        active_projects: enriched.filter(p => String(p.status || '').toLowerCase() === 'active').length,
        delayed_count: enriched.filter(p => p.is_delayed).length,
        over_budget_count: enriched.filter(p => p.is_over_budget).length,
        loss_making_count: enriched.filter(p => p.is_loss_making).length,
        total_contract_value: totalContract,
        // Cost-derived roll-ups are null, not zero, when nothing has been
        // costed: summing an empty set gives 0, and a KPI card reading
        // "Total Cost Rs 0" asserts a measurement that was never taken.
        total_actual_cost: costed.length > 0 ? totalActual : null,
        total_profit:      costed.length > 0 ? totalProfit : null,
        // The base for margin is the costed subset's contract value, so the
        // ratio compares like with like even though the card above reports the
        // whole portfolio.
        costed_contract_value: costed.length > 0 ? costedContract : null,
        portfolio_margin_pct: costed.length > 0 && costedContract > 0
          ? Math.round((totalProfit / costedContract) * 100) : null,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 5. COLLECTIONS AGING ─────────────────────────────────────────────────────
// GET /ceo-intelligence/collections
router.get('/collections', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = cc(companyId, 'i');

    const aging = await pool.query(`
      SELECT p.id AS customer_id, p.name AS customer,
             COALESCE(SUM(i.total_amount),0) AS total_outstanding,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '0 days' AND '30 days'), 0) AS bucket_0_30,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '31 days' AND '60 days'), 0) AS bucket_31_60,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date BETWEEN '61 days' AND '90 days'), 0) AS bucket_61_90,
             COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date > '90 days'), 0) AS bucket_90plus,
             EXTRACT(DAY FROM MAX(NOW()-i.due_date))::int AS max_overdue_days
      FROM parties p
      JOIN invoices i ON i.customer_id = p.id
      WHERE ${sqlInvoiceOutstanding('i.status')} AND i.due_date IS NOT NULL ${cw}
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
    const cw = cc(companyId);

    const [tickets, amcContracts, expiringAmc] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS open_tickets,
               COUNT(*) FILTER (WHERE ${isIn('priority', TICKET_CRITICAL)} OR ${isIn('status', TICKET_ESCALATED)})::int AS escalations,
               COUNT(*) FILTER (WHERE ${isIn('status', TICKET_ESCALATED)})::int AS escalated_count
        FROM support_tickets
        WHERE ${notIn('status', TICKET_CLOSED)} AND deleted_at IS NULL ${cw}
      `).catch(() => ({ rows: [{ open_tickets: 0, escalations: 0, escalated_count: 0 }] })),

      pool.query(`
        SELECT COUNT(*)::int AS active_amc,
               COALESCE(SUM(contract_value),0) AS amc_revenue,
               COALESCE(AVG(contract_value),0) AS avg_amc_value
        FROM amc_contracts WHERE ${isIn('status', AMC_ACTIVE)} ${cw}
      `).catch(() => ({ rows: [{ active_amc: 0, amc_revenue: 0, avg_amc_value: 0 }] })),

      // amc_contracts has no customer_id/annual_value — resolve customer via sales_order_id
      pool.query(`
        SELECT ac.id, ac.contract_number, ac.end_date, ac.contract_value AS annual_value,
               COALESCE(p.name, ac.product_name) AS customer_name
        FROM amc_contracts ac
        LEFT JOIN sales_orders so ON so.id = ac.sales_order_id
        LEFT JOIN parties p ON p.id = so.customer_id
        WHERE ${isIn('ac.status', AMC_ACTIVE)} AND ac.end_date BETWEEN NOW() AND NOW() + INTERVAL '90 days'
        ${cc(companyId, 'ac')}
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
    const cw = cc(companyId);

    const [
      criticalCustomers, criticalVendors, lowMarginProjects,
      overdueCollections, expiringAMC, openCriticalNCR,
    ] = await Promise.all([
      // Customers with critical tickets or 90+ day outstanding
      pool.query(`
        SELECT DISTINCT p.name, 'Critical Customer Health' AS type,
               'Customer health score critical - requires immediate attention' AS message
        FROM parties p
        JOIN invoices i ON i.customer_id=p.id
        WHERE ${sqlInvoiceOutstanding('i.status')} AND NOW()-i.due_date > INTERVAL '90 days'
        ${cc(companyId, 'p')} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Vendors with Blocked status or 3+ open NCRs
      pool.query(`
        SELECT v.name, 'Critical Vendor Risk' AS type,
               'Vendor has open NCRs or is blocked - supply chain at risk' AS message
        FROM vendors v
        LEFT JOIN ncr_reports n ON n.vendor_id=v.id AND n.status!='Closed'
        WHERE ${isIn('v.status', VENDOR_BLOCKED)} OR (SELECT COUNT(*) FROM ncr_reports WHERE vendor_id=v.id AND ${notIn('status', NCR_CLOSED)})>2
        ${cc(companyId, 'v')}
        GROUP BY v.id, v.name LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Projects with margin < 5%
      pool.query(`
        SELECT p.project_name AS name, 'Low Margin Project' AS type,
               'Project margin below 5% - profitability at risk' AS message
        FROM projects p
        LEFT JOIN project_cost_summary cs ON cs.project_id=p.id
        WHERE p.deleted_at IS NULL AND p.budget_amount > 0
          AND (cs.total_cost / NULLIF(p.budget_amount,0)) > 0.95
        ${cc(companyId, 'p')} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Collections overdue > 90 days
      pool.query(`
        SELECT p.name, 'Collection Risk' AS type,
               'Outstanding collection overdue 90+ days' AS message
        FROM parties p JOIN invoices i ON i.customer_id=p.id
        WHERE ${sqlInvoiceOutstanding('i.status')} AND NOW()-i.due_date > INTERVAL '90 days'
        ${cc(companyId, 'p')}
        GROUP BY p.name LIMIT 5
      `).catch(() => ({ rows: [] })),

      // AMC expiring in 30 days — amc_contracts has no customer_id, resolve via sales_order_id
      pool.query(`
        SELECT COALESCE(p.name, ac.product_name) AS name, 'AMC Expiring' AS type,
               'AMC contract expiring within 30 days - renewal required' AS message
        FROM amc_contracts ac
        LEFT JOIN sales_orders so ON so.id=ac.sales_order_id
        LEFT JOIN parties p ON p.id=so.customer_id
        WHERE ${isIn('ac.status', AMC_ACTIVE)} AND ac.end_date BETWEEN NOW() AND NOW()+INTERVAL '30 days'
        ${cc(companyId, 'ac')} LIMIT 5
      `).catch(() => ({ rows: [] })),

      // Critical NCRs open
      pool.query(`
        SELECT COALESCE(v.name, proj.customer_name, proj.client_name, 'Unknown') AS name,
               'Critical NCR Open' AS type,
               'Critical quality non-conformance report unresolved' AS message
        FROM ncr_reports n
        LEFT JOIN vendors v ON v.id=n.vendor_id
        LEFT JOIN projects proj ON proj.id=n.project_id
        WHERE ${notIn('n.status', NCR_CLOSED)} AND LOWER(n.severity)='critical'
        ${cc(companyId, 'n')} LIMIT 5
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

// ── 8. SIGNAL DIGEST ─────────────────────────────────────────────────────────
// GET /ceo-intelligence/ai-insights
//
// WHAT THIS USED TO BE
// --------------------
// This endpoint returned 25 bullets across 5 categories. Exactly 4 of them were
// derived from data; the other 21 were fixed prose written at build time —
// "Single-source components for IGBT, Transformers, and Capacitors represent
// highest supply chain risk", "Pipeline conversion at ~35%", "Top 5 customers by
// revenue growth show 40%+ YoY increase" — none of which queried anything. The
// `margin_risks` category was 100% hardcoded. The panel rendering them told the
// reader "no hardcoded or fabricated values".
//
// WHAT IT IS NOW
// --------------
// Every line is produced by a rule that reads live data and reports the figure it
// measured. A rule that has no data to stand on emits nothing at all, so an empty
// category means "no signal", not "we ran out of canned text". Each item carries
// the evidence (`metric`, `value`) and a `severity` so the UI can rank rather
// than dump. This is deliberately NOT an LLM call: the numbers must be
// reproducible and attributable, and the narrative layer already exists
// separately at POST /ai/ceo-insights.
router.get('/ai-insights', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw   = cc(companyId);
    const cwP  = cc(companyId, 'p');

    // `derived_from_live_data` used to be the literal `true`, asserted alongside
    // the comment "everything in insights is measured". It was not: one of the
    // nine signal queries below threw on every call and this helper quietly
    // returned its fallback, so the endpoint claimed completeness over a signal
    // that had never fired. The flag is now computed from what actually ran, and
    // any signal that failed is named in the response so the UI can say which
    // part of the picture is missing rather than implying there is none.
    const failedSignals = [];
    const q = (signal, sql, params = [], fallback = []) =>
      pool.query(sql, params).then(r => r.rows).catch((err) => {
        if (!failedSignals.includes(signal)) failedSignals.push(signal);
        console.error(`[ceo-intelligence/ai-insights] signal "${signal}" failed [${err.code || 'n/a'}]: ${err.message}`);
        return fallback;
      });

    const [
      agedRows, blockedVendors, singleSourceNcr, churnRisk, amcGap,
      marginRows, growthRows, ncrVendors, ticketRows,
    ] = await Promise.all([
      // Receivables aged past 60 and past 90, with the customer count behind each.
      q('aged_receivables', `SELECT
           COUNT(DISTINCT p.id) FILTER (WHERE NOW()-i.due_date > INTERVAL '60 days')::int AS cust_60,
           COALESCE(SUM(i.total_amount) FILTER (WHERE NOW()-i.due_date > INTERVAL '90 days'),0) AS amt_90,
           COUNT(*) FILTER (WHERE NOW()-i.due_date > INTERVAL '90 days')::int AS inv_90
         FROM parties p JOIN invoices i ON i.customer_id=p.id
         WHERE ${sqlInvoiceOutstanding('i.status')} AND i.due_date IS NOT NULL ${cwP}`),

      q('blocked_vendors', `SELECT name FROM vendors WHERE ${isIn('status', VENDOR_BLOCKED)} ${cw} LIMIT 5`),

      // Single-source vendors that also have open non-conformances: the genuine
      // supply-chain concentration signal, replacing the hardcoded component list.
      q('single_source_ncr', `SELECT v.name, COUNT(n.id)::int AS open_ncrs
         FROM vendors v
         LEFT JOIN ncr_reports n ON n.vendor_id=v.id AND ${notIn('n.status', NCR_CLOSED)}
         WHERE v.is_single_source IS TRUE AND v.deleted_at IS NULL
           ${companyId ? 'AND v.company_id=' + companyId : ''}
         GROUP BY v.id, v.name HAVING COUNT(n.id) > 0
         ORDER BY 2 DESC LIMIT 5`),

      // Customers carrying BOTH overdue money and open tickets — compounding risk.
      // `support_tickets.customer_id` is an INTEGER pointing at `accounts.id`,
      // while `parties.id` is a UUID — comparing them raised
      // "42883 operator does not exist: integer = uuid" on every single call, so
      // this signal (customers carrying BOTH overdue money and open tickets, the
      // most decision-relevant one on the page) had never once fired, and
      // customer_risks was permanently empty. The bridge is `accounts`, which
      // carries party_id NOT NULL and is the documented extension of the party
      // master.
      q('churn_risk', `SELECT p.name,
                COALESCE(SUM(i.total_amount),0) AS outstanding,
                (SELECT COUNT(*) FROM support_tickets t
                   JOIN accounts a ON a.id = t.customer_id
                  WHERE a.party_id = p.id AND ${notIn('t.status', TICKET_CLOSED)} AND t.deleted_at IS NULL)::int AS open_tickets
         FROM parties p JOIN invoices i ON i.customer_id=p.id
         WHERE ${sqlInvoiceOutstanding('i.status')} ${cwP}
         GROUP BY p.id, p.name
         HAVING (SELECT COUNT(*) FROM support_tickets t
                   JOIN accounts a ON a.id = t.customer_id
                  WHERE a.party_id = p.id AND ${notIn('t.status', TICKET_CLOSED)} AND t.deleted_at IS NULL) > 0
         ORDER BY 2 DESC LIMIT 5`),

      // Revenue-generating customers with no active AMC — the real upsell list.
      q('amc_gap', `SELECT p.name, COALESCE(SUM(i.total_amount),0) AS revenue
         FROM parties p JOIN invoices i ON i.customer_id=p.id
         WHERE ${isIn('i.status', INVOICE_PAID)} ${cwP}
           AND NOT EXISTS (
             SELECT 1 FROM amc_contracts ac
             JOIN sales_orders so ON so.id=ac.sales_order_id
             WHERE so.customer_id=p.id AND ${isIn('ac.status', AMC_ACTIVE)})
         GROUP BY p.id, p.name HAVING COALESCE(SUM(i.total_amount),0) > 0
         ORDER BY 2 DESC LIMIT 5`),

      // Projects whose booked cost has eaten most of the budget.
      q('margin_risk', `SELECT p.project_name AS name, p.budget_amount, cs.total_cost
         FROM projects p JOIN project_cost_summary cs ON cs.project_id=p.id
         WHERE p.deleted_at IS NULL AND p.budget_amount > 0 ${cwP}
           AND cs.total_cost > p.budget_amount * 0.90
         ORDER BY cs.total_cost / NULLIF(p.budget_amount,0) DESC LIMIT 5`),

      // Real YoY growth leaders, replacing the asserted "40%+ YoY".
      q('growth_leaders', `SELECT p.name,
                COALESCE(SUM(i.total_amount) FILTER (WHERE i.invoice_date >= $1),0)                       AS curr,
                COALESCE(SUM(i.total_amount) FILTER (WHERE i.invoice_date >= $2 AND i.invoice_date < $1),0) AS prev
         FROM parties p JOIN invoices i ON i.customer_id=p.id
         WHERE ${isIn('i.status', INVOICE_PAID)} ${cwP}
         GROUP BY p.id, p.name`,
        (() => {
          const n = new Date();
          const fy  = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1;
          return [`${fy}-04-01`, `${fy - 1}-04-01`];
        })()),

      // Vendors whose on-time delivery is genuinely below par.
      q('ncr_vendors', `SELECT v.name, COUNT(n.id)::int AS open_ncrs
         FROM vendors v JOIN ncr_reports n ON n.vendor_id=v.id AND ${notIn('n.status', NCR_CLOSED)}
         WHERE 1=1 ${companyId ? 'AND v.company_id=' + companyId : ''}
         GROUP BY v.id, v.name ORDER BY 2 DESC LIMIT 5`),

      q('ticket_load', `SELECT COUNT(*)::int AS open_tickets,
                COUNT(*) FILTER (WHERE ${isIn('priority', TICKET_CRITICAL)})::int AS critical
         FROM support_tickets WHERE ${notIn('status', TICKET_CLOSED)} AND deleted_at IS NULL ${cw}`),
    ]);

    const fmtV = (v) => v >= 1e7 ? `₹${(v / 1e7).toFixed(1)} Cr`
                      : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L`
                      : `₹${Number(v).toLocaleString('en-IN')}`;
    const agg = agedRows[0] || {};
    const tix = ticketRows[0] || {};

    /** Push a finding only when its supporting figure actually exists. */
    const findings = { customer_risks: [], supplier_risks: [], growth_opportunities: [], collection_risks: [], margin_risks: [] };
    const add = (bucket, severity, text, metric, value) => {
      findings[bucket].push({ text, severity, metric, value });
    };

    // Collections
    const amt90 = parseFloat(agg.amt_90 || 0);
    if (amt90 > 0) add('collection_risks', 'high',
      `${fmtV(amt90)} across ${agg.inv_90} invoice(s) is more than 90 days past due — escalate to legal or MD review.`,
      'receivables_over_90d', amt90);
    if (parseInt(agg.cust_60 || 0) > 0) add('collection_risks', 'medium',
      `${agg.cust_60} customer(s) hold invoices more than 60 days past due.`,
      'customers_over_60d', parseInt(agg.cust_60));

    // Customer risk
    for (const c of churnRisk) {
      add('customer_risks', 'high',
        `${c.name} has ${fmtV(parseFloat(c.outstanding))} outstanding and ${c.open_tickets} open ticket(s) — money and service risk are compounding.`,
        'customer_compound_risk', parseFloat(c.outstanding));
    }
    if (parseInt(tix.critical || 0) > 0) add('customer_risks', 'high',
      `${tix.critical} critical-priority ticket(s) are open across ${tix.open_tickets} total.`,
      'critical_tickets', parseInt(tix.critical));

    // Supplier risk
    if (blockedVendors.length) add('supplier_risks', 'high',
      `${blockedVendors.length} vendor(s) are blocked: ${blockedVendors.map(v => v.name).join(', ')}. Identify alternate sources.`,
      'blocked_vendors', blockedVendors.length);
    for (const v of singleSourceNcr) {
      add('supplier_risks', 'high',
        `${v.name} is a single-source supplier with ${v.open_ncrs} open NCR(s) — no qualified fallback if quality holds shipment.`,
        'single_source_with_ncr', v.open_ncrs);
    }
    for (const v of ncrVendors.filter(v => !singleSourceNcr.some(x => x.name === v.name))) {
      add('supplier_risks', 'medium',
        `${v.name} has ${v.open_ncrs} open NCR(s) outstanding.`, 'vendor_open_ncrs', v.open_ncrs);
    }

    // Growth
    const growers = growthRows
      .map(r => ({ name: r.name, curr: parseFloat(r.curr), prev: parseFloat(r.prev) }))
      .filter(r => r.prev > 0 && r.curr > r.prev)
      .map(r => ({ ...r, pct: Math.round(((r.curr - r.prev) / r.prev) * 100) }))
      .sort((a, b) => b.pct - a.pct).slice(0, 3);
    for (const g of growers) {
      add('growth_opportunities', 'info',
        `${g.name} is up ${g.pct}% year on year (${fmtV(g.prev)} → ${fmtV(g.curr)}) — expand the account.`,
        'customer_yoy_growth', g.pct);
    }
    for (const c of amcGap) {
      add('growth_opportunities', 'info',
        `${c.name} bills ${fmtV(parseFloat(c.revenue))} with no active AMC — recurring-revenue upsell candidate.`,
        'amc_upsell', parseFloat(c.revenue));
    }

    // Margin
    for (const m of marginRows) {
      const used = Math.round((parseFloat(m.total_cost) / parseFloat(m.budget_amount)) * 100);
      add('margin_risks', used >= 100 ? 'high' : 'medium',
        `${m.name} has consumed ${used}% of its budget (${fmtV(parseFloat(m.total_cost))} of ${fmtV(parseFloat(m.budget_amount))}).`,
        'budget_consumed_pct', used);
    }

    const total = Object.values(findings).reduce((n, arr) => n + arr.length, 0);
    const high  = Object.values(findings).flat().filter(f => f.severity === 'high').length;

    // The summary must not claim a complete picture when part of it failed to
    // compute. A degraded run says so, by name, in both the prose and the payload.
    const asOf = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
    const degradedNote = failedSignals.length
      ? ` ${failedSignals.length} signal(s) could not be computed (${failedSignals.join(', ')}) — this list is incomplete.`
      : '';
    const summary = total === 0
      ? 'No signals crossed their thresholds in the current data. This reflects the records on file — it is not an assessment of areas the ERP does not yet track.' + degradedNote
      : `${total} signal(s) detected, ${high} at high severity, as of ${asOf}. Every line below cites the figure it was derived from.` + degradedNote;

    res.json({
      insights: findings,
      summary,
      signal_count: total,
      high_severity_count: high,
      // Contract with the UI: true only when every signal query actually ran.
      // This used to be the literal `true` while one of the nine threw on every
      // call, which is how the page asserted completeness over a dead signal.
      derived_from_live_data: failedSignals.length === 0,
      signals_total: 9,
      signals_computed: 9 - failedSignals.length,
      ...(failedSignals.length ? { dataUnavailable: failedSignals, degraded: true } : {}),
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 9. BUSINESS LINES ────────────────────────────────────────────────────────
// GET /ceo-intelligence/manifest
//
// WHAT THIS USED TO BE
// --------------------
// The response was built from a hardcoded literal list —
// ['HVDC','STATCOM','SST','Automation','Service','AMC'] — matched by exact string
// equality against `product_lines.display_name`, whose actual values are 'ACB',
// 'APFC - 440V', 'ASTRA - 415V', 'MV-VAJRA' and similar. The two vocabularies had
// zero overlap, so `projectsByBL.rows.find(...)` never matched and all six cards
// rendered ₹0 / 0% / 0 projects permanently, regardless of the data.
//
// WHAT IT IS NOW
// --------------
// The taxonomy is read from `product_lines` itself, so it can never drift from
// the master again — adding a product line makes it appear here with no code
// change. Projects and opportunities that carry no product line are grouped under
// an explicit 'Unassigned' bucket rather than being silently dropped, and the
// response reports how much of the portfolio is actually classified so the UI can
// say "3 of 3 projects unassigned" instead of implying the business did no work.
router.get('/manifest', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cw = cc(companyId, 'p');
    // Projects and their coverage follow the period by overlap. Open pipeline and
    // active AMC are current-state and stay unbounded.
    const range = resolveRange(req.query);
    const rp = [range.from, range.to];

    const [lines, projectsByBL, pipelineByBL, amcTotals, coverage] = await Promise.all([
      // The taxonomy itself — no literals.
      pool.query(`SELECT id, display_name FROM product_lines ORDER BY display_name`)
        .catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          COALESCE(pl.display_name, 'Unassigned') AS business_line,
          COUNT(*)::int                            AS project_count,
          COALESCE(SUM(p.budget_amount),0)         AS revenue,
          COALESCE(SUM(cs.total_cost),0)           AS cost,
          COUNT(cs.project_id)::int                AS costed_count,
          COUNT(DISTINCT COALESCE(p.customer_name, p.client_name))::int AS customer_count
        FROM projects p
        LEFT JOIN product_lines pl ON pl.id = p.product_line_id
        LEFT JOIN project_cost_summary cs ON cs.project_id = p.id
        WHERE p.deleted_at IS NULL AND ${projectOverlaps('p', 1)} ${cw}
        GROUP BY COALESCE(pl.display_name, 'Unassigned')
      `, rp).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT COALESCE(product_line, 'Unassigned') AS business_line,
               COALESCE(SUM(expected_value),0)      AS pipeline,
               COUNT(*)::int                        AS opp_count
        FROM opportunities
        WHERE deleted_at IS NULL
          AND LOWER(stage) NOT IN ('closed won','closed lost','closed_won','closed_lost')
          ${cc(companyId)}
        GROUP BY COALESCE(product_line, 'Unassigned')
      `).catch(() => ({ rows: [] })),

      // amc_contracts carries no product line, so AMC revenue is reported once at
      // portfolio level rather than being attributed to a line it does not name.
      pool.query(`
        SELECT COALESCE(SUM(contract_value),0) AS amc_revenue, COUNT(*)::int AS contract_count
        FROM amc_contracts WHERE ${isIn('status', AMC_ACTIVE)}
        ${cc(companyId)}
      `).catch(() => ({ rows: [{ amc_revenue: 0, contract_count: 0 }] })),

      pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(product_line_id)::int AS classified
        FROM projects p WHERE p.deleted_at IS NULL AND ${projectOverlaps('p', 1)} ${cw}
      `, rp).catch(() => ({ rows: [{ total: 0, classified: 0 }] })),
    ]);

    const pipeMap = Object.fromEntries(
      pipelineByBL.rows.map(r => [r.business_line, { value: parseFloat(r.pipeline), count: r.opp_count }])
    );

    // Union of: every configured product line, plus any bucket that actually has
    // projects or pipeline (which picks up 'Unassigned' and any stale free-text
    // product_line on opportunities).
    const names = new Set([
      ...lines.rows.map(r => r.display_name),
      ...projectsByBL.rows.map(r => r.business_line),
      ...pipelineByBL.rows.map(r => r.business_line),
    ]);

    const winRateRow = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE LOWER(stage) IN ('closed_won','closed won'))::float AS won,
             COUNT(*) FILTER (WHERE LOWER(stage) IN ('closed_won','closed won','closed_lost','closed lost'))::float AS closed
      FROM opportunities WHERE deleted_at IS NULL ${cc(companyId)}
    `).catch(() => ({ rows: [{ won: 0, closed: 0 }] }));
    const closed = parseFloat(winRateRow.rows[0]?.closed || 0);
    const measuredWinRate = closed >= 5 ? parseFloat(winRateRow.rows[0]?.won || 0) / closed : null;
    const winRate = measuredWinRate ?? 0.35;

    const manifest = [...names].map(name => {
      const proj    = projectsByBL.rows.find(r => r.business_line === name) || {};
      const revenue = parseFloat(proj.revenue || 0);
      const cost    = parseFloat(proj.cost    || 0);
      const costed  = parseInt(proj.costed_count || 0);
      const pipe    = pipeMap[name]?.value || 0;
      // Margin is only claimed where cost has actually been booked — see the same
      // rule in /ceo-intelligence/projects.
      const profit  = costed > 0 ? revenue - cost : null;
      const margin  = costed > 0 && revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : null;

      return {
        business_line:  name,
        project_count:  parseInt(proj.project_count || 0),
        costed_count:   costed,
        revenue, cost, profit,
        margin_pct:     margin,
        has_cost_data:  costed > 0,
        pipeline:       pipe,
        opportunity_count: pipeMap[name]?.count || 0,
        customer_count: parseInt(proj.customer_count || 0),
        forecast:       revenue + pipe * winRate,
      };
    })
    // Empty lines sink to the bottom rather than padding the top of the grid.
    .sort((a, b) => (b.revenue + b.pipeline) - (a.revenue + a.pipeline));

    const cov = coverage.rows[0] || { total: 0, classified: 0 };
    const amc = amcTotals.rows[0] || { amc_revenue: 0, contract_count: 0 };

    res.json({
      // Echoed so cards can label themselves from the response instead of
      // asserting a fixed window the filter may have moved.
      period: { period: range.period, label: range.label, from: range.from, to: range.to },
      manifest,
      // AMC is portfolio-level, not per-line — reported once, honestly.
      amc: { revenue: parseFloat(amc.amc_revenue || 0), contracts: parseInt(amc.contract_count || 0) },
      coverage: {
        total_projects:      parseInt(cov.total || 0),
        classified_projects: parseInt(cov.classified || 0),
        unclassified_projects: parseInt(cov.total || 0) - parseInt(cov.classified || 0),
      },
      forecast_win_rate: winRate,
      forecast_is_measured: measuredWinRate != null,
      taxonomy_source: 'product_lines',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
