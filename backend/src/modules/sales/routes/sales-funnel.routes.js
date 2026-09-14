import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import {
  sqlSalesOrderBooked, sqlLeadQualified,
  sqlOpportunityWon, sqlOpportunityLost,
  LEAD_UNWORKED, LEAD_DISQUALIFIED, SALES_ORDER_VOID,
} from '../../../shared/statusSets.js';

/**
 * Sales funnel / conversion analytics.
 *
 * Every query in this file used to end in `.catch(() => ({ rows: [] }))`. Three
 * of them threw on EVERY request and nobody could see it:
 *   - /monthly appended a second WHERE to a query that already had one
 *     ("syntax error at or near WHERE") - all six series, so Monthly Trends has
 *     been an empty state since it shipped;
 *   - /won-lost-analysis read `opportunities.status` and `opportunities.value`,
 *     neither of which exists (the columns are `stage` and `expected_value`), so
 *     Win Rate rendered "0.0% - 0 won of 0" on a page whose own KPI row said
 *     6 orders won.
 * The swallow is gone. An analytics endpoint that cannot answer must say so
 * with a 500, not return a confident zero.
 *
 * Three further rules this file now holds to:
 *   - Tenant scope is `($1::int IS NULL OR company_id = $1)` - the predicate
 *     companyOf() documents and the rest of the sales module uses. The old
 *     `(company_id=$1 OR company_id IS NULL)` pulled super-admin-authored
 *     NULL-company rows into a scoped user's totals, which is why this page
 *     counted 17 enquiries and 9 quotations while the Customer/Product tabs
 *     beside it (sales-command-center) counted 16 and 6.
 *   - Soft-deleted rows are excluded everywhere. They were not, so a deleted
 *     lead inflated the funnel and a deleted opportunity was the ONLY row in
 *     "Win Rate by Salesperson".
 *   - Stage vocabularies come from statusSets.js. `stage='won'` matched nothing
 *     - the live values are 'Won' and 'Lost' alongside lowercase 'proposal'.
 */

const router = express.Router();
const cid = req => companyOf(req);

/** The canonical tenant predicate. `alias` is a caller-controlled table alias. */
const scope = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `($1::int IS NULL OR ${p}company_id = $1)`;
};
const live = (alias = '') => `${alias ? alias + '.' : ''}deleted_at IS NULL`;

const int = v => parseInt(v || 0, 10) || 0;
const num = v => parseFloat(v || 0) || 0;
/** Percentage to one decimal. Returns null - never 0 - when the denominator is
 *  empty, so "no data" can't be drawn as a real 0% conversion. */
const pct = (n, d) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(1)) : null);

// -- Monthly funnel snapshot --------------------------------------------------
// One query over a generated month series, so a month with no activity comes
// back as a zero row instead of vanishing from the chart's x-axis.
router.get('/monthly', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const months = Math.min(Math.max(parseInt(req.query.months || 12, 10) || 12, 1), 36);

    const { rows } = await pool.query(`
      WITH bounds AS (
        SELECT DATE_TRUNC('month', NOW()) - (($2::int - 1) * INTERVAL '1 month') AS from_month
      ),
      series AS (
        SELECT TO_CHAR(gs, 'YYYY-MM') AS month
        FROM bounds, generate_series(bounds.from_month, DATE_TRUNC('month', NOW()), INTERVAL '1 month') gs
      ),
      enq AS (
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM leads, bounds
        WHERE ${live()} AND ${scope()} AND created_at >= bounds.from_month
        GROUP BY 1
      ),
      qual AS (
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM leads, bounds
        WHERE ${live()} AND ${scope()} AND created_at >= bounds.from_month
          AND ${sqlLeadQualified('status')}
        GROUP BY 1
      ),
      opp AS (
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM opportunities, bounds
        WHERE ${live()} AND ${scope()} AND created_at >= bounds.from_month
        GROUP BY 1
      ),
      quo AS (
        -- quotation_date is the business date; created_at is the audit stamp.
        SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(quotation_date, created_at::date)), 'YYYY-MM') AS month,
               COUNT(*)::int AS n
        FROM quotations, bounds
        WHERE ${live()} AND ${scope()}
          AND COALESCE(quotation_date, created_at::date) >= bounds.from_month
        GROUP BY 1
      ),
      ord AS (
        SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') AS month,
               COUNT(*)::int AS n,
               COALESCE(SUM(total_amount), 0) AS revenue
        FROM sales_orders, bounds
        WHERE ${live()} AND ${scope()} AND ${sqlSalesOrderBooked('order_status')}
          AND order_date >= bounds.from_month
        GROUP BY 1
      )
      SELECT s.month,
             COALESCE(enq.n, 0)       AS enquiries,
             COALESCE(qual.n, 0)      AS leads,
             COALESCE(opp.n, 0)       AS opportunities,
             COALESCE(quo.n, 0)       AS quotations,
             COALESCE(ord.n, 0)       AS orders,
             COALESCE(ord.revenue, 0) AS revenue
      FROM series s
      LEFT JOIN enq  ON enq.month  = s.month
      LEFT JOIN qual ON qual.month = s.month
      LEFT JOIN opp  ON opp.month  = s.month
      LEFT JOIN quo  ON quo.month  = s.month
      LEFT JOIN ord  ON ord.month  = s.month
      ORDER BY s.month
    `, [companyId, months]);

    res.json(rows.map(r => ({
      month:         r.month,
      enquiries:     int(r.enquiries),
      leads:         int(r.leads),
      opportunities: int(r.opportunities),
      quotations:    int(r.quotations),
      orders:        int(r.orders),
      revenue:       num(r.revenue),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Conversion ratios --------------------------------------------------------
// Returns TWO readings of the same funnel and says which is which:
//
//   ratios  - stage VOLUME. "How many quotations exist for every opportunity."
//             A step can exceed 100% here, and that is a finding, not an error:
//             it means records enter the funnel mid-stream (a quotation raised
//             with no opportunity behind it). The old page printed one such
//             step as a plain "450.0% conversion".
//   linked  - conversion measured along the real foreign keys
//             (opportunities.lead_id -> quotations.opportunity_id ->
//             sales_orders.quotation_id). Bounded by 0-100% by construction,
//             but only as meaningful as `coverage` says it is.
//
// Volume stays the headline because linkage in this schema is optional and
// sparse; publishing only the linked number would report a near-empty funnel
// for a company that is demonstrably winning orders.
router.get('/conversion-ratios', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);

    const { rows: [r] } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM leads
          WHERE ${live()} AND ${scope()})                                        AS enquiries,
        (SELECT COUNT(*)::int FROM leads
          WHERE ${live()} AND ${scope()} AND ${sqlLeadQualified('status')})      AS qualified_leads,
        (SELECT COUNT(*)::int FROM opportunities
          WHERE ${live()} AND ${scope()})                                        AS opportunities,
        (SELECT COUNT(*)::int FROM quotations
          WHERE ${live()} AND ${scope()})                                        AS quotations,
        (SELECT COUNT(*)::int FROM sales_orders
          WHERE ${live()} AND ${scope()} AND ${sqlSalesOrderBooked('order_status')}) AS orders,

        -- Linkage: numerators are DISTINCT parents so one lead with three
        -- opportunities can never push the ratio past 100%.
        (SELECT COUNT(DISTINCT o.lead_id)::int
           FROM opportunities o
           JOIN leads l ON l.id = o.lead_id AND ${live('l')} AND ${scope('l')}
          WHERE ${live('o')} AND ${scope('o')}
            AND ${sqlLeadQualified('l.status')})                                 AS qualified_leads_with_opportunity,
        (SELECT COUNT(*)::int FROM opportunities o
          WHERE ${live('o')} AND ${scope('o')} AND o.lead_id IS NOT NULL)        AS opportunities_with_lead,
        (SELECT COUNT(DISTINCT q.opportunity_id)::int
           FROM quotations q
           JOIN opportunities o ON o.id = q.opportunity_id AND ${live('o')} AND ${scope('o')}
          WHERE ${live('q')} AND ${scope('q')})                                  AS opportunities_with_quotation,
        (SELECT COUNT(*)::int FROM quotations q
          WHERE ${live('q')} AND ${scope('q')} AND q.opportunity_id IS NOT NULL) AS quotations_with_opportunity,
        (SELECT COUNT(DISTINCT s.quotation_id)::int
           FROM sales_orders s
           JOIN quotations q ON q.id = s.quotation_id AND ${live('q')} AND ${scope('q')}
          WHERE ${live('s')} AND ${scope('s')} AND ${sqlSalesOrderBooked('s.order_status')}) AS quotations_with_order,
        (SELECT COUNT(*)::int FROM sales_orders s
          WHERE ${live('s')} AND ${scope('s')} AND ${sqlSalesOrderBooked('s.order_status')}
            AND s.quotation_id IS NOT NULL)                                      AS orders_with_quotation
    `, [companyId]);

    const e   = int(r.enquiries);
    const l   = int(r.qualified_leads);
    const o   = int(r.opportunities);
    const q   = int(r.quotations);
    const ord = int(r.orders);

    const leadsWithOpp = int(r.qualified_leads_with_opportunity);
    const oppsWithQuo  = int(r.opportunities_with_quotation);
    const quosWithOrd  = int(r.quotations_with_order);

    res.json({
      funnel: { enquiries: e, leads: l, opportunities: o, quotations: q, orders: ord },
      ratios: {
        enquiry_to_lead:          pct(l, e),
        lead_to_opportunity:      pct(o, l),
        opportunity_to_quotation: pct(q, o),
        quotation_to_order:       pct(ord, q),
        enquiry_to_order:         pct(ord, e),
      },
      linked: {
        ratios: {
          lead_to_opportunity:      pct(leadsWithOpp, l),
          opportunity_to_quotation: pct(oppsWithQuo, o),
          quotation_to_order:       pct(quosWithOrd, q),
        },
        counts: {
          qualified_leads_with_opportunity: leadsWithOpp,
          opportunities_with_quotation:     oppsWithQuo,
          quotations_with_order:            quosWithOrd,
        },
        // How much of each stage can be traced to the stage before it. A linked
        // ratio computed over 1 of 9 quotations is not a conversion rate, and
        // the UI needs to be able to say so.
        coverage: {
          opportunities_with_lead:     pct(int(r.opportunities_with_lead), o),
          quotations_with_opportunity: pct(int(r.quotations_with_opportunity), q),
          orders_with_quotation:       pct(int(r.orders_with_quotation), ord),
        },
      },
      basis: {
        window: 'all_time',
        company_id: companyId,
        qualified_lead_rule: `lead status is set and not in ${LEAD_UNWORKED.join('/')} or ${LEAD_DISQUALIFIED.join('/')}`,
        excludes: ['soft-deleted records', `sales orders in ${SALES_ORDER_VOID.join('/')}`],
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Salesperson performance vs target ----------------------------------------
router.get('/salesperson-performance', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const yr = parseInt(req.query.fy_year || new Date().getFullYear(), 10);
    // India FY: 1 Apr yr -> 31 Mar yr+1
    const fyStart = `${yr}-04-01`;
    const fyEnd   = `${yr + 1}-03-31`;

    // Orders and quotations are aggregated in SEPARATE CTEs, then joined.
    // Joining both directly onto sales_targets produced an orders x quotations
    // cartesian per owner: COUNT(so.id) counted every order once per quotation,
    // and SUM(so.total_amount) - the "Achieved" column and its achievement % -
    // was multiplied by that owner's quotation count.
    const { rows } = await pool.query(`
      WITH tgt AS (
        SELECT owner_id,
               SUM(target_amount)              AS annual_target,
               AVG(NULLIF(commission_rate, 0)) AS commission_rate
        FROM sales_targets
        WHERE period_type = 'annual' AND period_year = $2
          AND ${scope()}
        GROUP BY owner_id
      ),
      ord AS (
        SELECT u.employee_id AS owner_id,
               COUNT(*)::int AS orders_won,
               COALESCE(SUM(so.total_amount), 0) AS achieved
        FROM sales_orders so
        JOIN users u ON u.id = so.created_by
        WHERE ${live('so')} AND ($1::int IS NULL OR so.company_id = $1)
          AND ${sqlSalesOrderBooked('so.order_status')}
          AND so.order_date BETWEEN $3 AND $4
          AND u.employee_id IS NOT NULL
        GROUP BY 1
      ),
      quo AS (
        SELECT u.employee_id AS owner_id,
               COUNT(*)::int AS quotes_sent
        FROM quotations q
        JOIN users u ON u.id = q.created_by
        WHERE ${live('q')} AND ($1::int IS NULL OR q.company_id = $1)
          AND COALESCE(q.quotation_date, q.created_at::date) BETWEEN $3 AND $4
          AND u.employee_id IS NOT NULL
        GROUP BY 1
      )
      SELECT COALESCE(e.name, 'Unassigned')   AS salesperson_name,
             COALESCE(tgt.annual_target, 0)   AS annual_target,
             COALESCE(ord.achieved, 0)        AS achieved,
             COALESCE(ord.orders_won, 0)      AS orders_won,
             COALESCE(quo.quotes_sent, 0)     AS quotes_sent,
             CASE WHEN COALESCE(tgt.annual_target, 0) > 0
                  THEN ROUND(COALESCE(ord.achieved, 0) / tgt.annual_target * 100, 1)
                  END                         AS achievement_pct,
             COALESCE(tgt.commission_rate, 0) AS commission_rate,
             CASE WHEN COALESCE(tgt.commission_rate, 0) > 0
                  THEN ROUND(COALESCE(ord.achieved, 0) * tgt.commission_rate / 100, 2)
                  ELSE 0 END                  AS commission_earned
      FROM tgt
      LEFT JOIN employees e ON e.id = tgt.owner_id
      LEFT JOIN ord ON ord.owner_id = tgt.owner_id
      LEFT JOIN quo ON quo.owner_id = tgt.owner_id
      ORDER BY achieved DESC, annual_target DESC
    `, [companyId, yr, fyStart, fyEnd]);

    // Revenue booked in the FY that no salesperson can be credited with: the
    // order's creator has no employees row (admin and service accounts don't),
    // so it never reaches a target line. Without this bucket the table reports
    // "Achieved 0" for everyone on a page whose funnel says six orders were won,
    // and the money silently disappears between the two panels.
    const { rows: [orphan] } = await pool.query(`
      SELECT COUNT(*)::int AS orders_won,
             COALESCE(SUM(so.total_amount), 0) AS achieved
      FROM sales_orders so
      LEFT JOIN users u ON u.id = so.created_by
      WHERE ${live('so')} AND ($1::int IS NULL OR so.company_id = $1)
        AND ${sqlSalesOrderBooked('so.order_status')}
        AND so.order_date BETWEEN $2 AND $3
        AND u.employee_id IS NULL
    `, [companyId, fyStart, fyEnd]);

    const out = rows.map(r => ({
      salesperson_name:  r.salesperson_name,
      annual_target:     num(r.annual_target),
      achieved:          num(r.achieved),
      orders_won:        int(r.orders_won),
      quotes_sent:       int(r.quotes_sent),
      // null, not 0 - "no target set" is not "0% of target achieved".
      achievement_pct:   r.achievement_pct === null ? null : num(r.achievement_pct),
      commission_rate:   num(r.commission_rate),
      commission_earned: num(r.commission_earned),
      unattributed:      false,
      fy_start: fyStart,
      fy_end:   fyEnd,
    }));

    if (int(orphan?.orders_won) > 0) {
      out.push({
        salesperson_name:  'Unattributed',
        annual_target:     0,
        achieved:          num(orphan.achieved),
        orders_won:        int(orphan.orders_won),
        quotes_sent:       0,
        achievement_pct:   null,
        commission_rate:   0,
        commission_earned: 0,
        unattributed:      true,
        fy_start: fyStart,
        fy_end:   fyEnd,
      });
    }

    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Won / Lost analysis ------------------------------------------------------
router.get('/won-lost-analysis', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);

    // `assigned_to` carries no foreign key and both id spaces have been written
    // into it, so ownership is resolved in FK-first order: held_by (a real
    // employees FK), then assigned_to read as a users.id via the users->employees
    // bridge, then as an employees.id directly, then the user's own name/email.
    const [summary, reasons, byPerson] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${sqlOpportunityWon('stage')})::int  AS won,
          COUNT(*) FILTER (WHERE ${sqlOpportunityLost('stage')})::int AS lost,
          COUNT(*)::int                                               AS total,
          COALESCE(SUM(expected_value) FILTER (WHERE ${sqlOpportunityWon('stage')}), 0)  AS won_value,
          COALESCE(SUM(expected_value) FILTER (WHERE ${sqlOpportunityLost('stage')}), 0) AS lost_value
        FROM opportunities
        WHERE ${live()} AND ${scope()}
      `, [companyId]),

      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(COALESCE(lost_reason, close_reason)), ''), 'Not recorded') AS reason,
               COUNT(*)::int AS count,
               COALESCE(SUM(expected_value), 0) AS value
        FROM opportunities
        WHERE ${live()} AND ${scope()} AND ${sqlOpportunityLost('stage')}
        GROUP BY 1
        ORDER BY count DESC, value DESC
        LIMIT 10
      `, [companyId]),

      pool.query(`
        SELECT COALESCE(eh.name, ea.name, ua.name, ua.email, 'Unassigned') AS salesperson,
               COUNT(*) FILTER (WHERE ${sqlOpportunityWon('o.stage')})::int  AS won,
               COUNT(*) FILTER (WHERE ${sqlOpportunityLost('o.stage')})::int AS lost,
               COUNT(*)::int AS total,
               COALESCE(SUM(o.expected_value) FILTER (WHERE ${sqlOpportunityWon('o.stage')}), 0) AS revenue
        FROM opportunities o
        LEFT JOIN employees eh ON eh.id = o.held_by
        LEFT JOIN users     ua ON ua.id = o.assigned_to
        LEFT JOIN employees ea ON ea.id = COALESCE(ua.employee_id, o.assigned_to)
        WHERE ${live('o')} AND ${scope('o')}
        GROUP BY 1
        ORDER BY revenue DESC, total DESC
        LIMIT 10
      `, [companyId]),
    ]);

    const s = summary.rows[0] || {};
    const won = int(s.won), lost = int(s.lost);

    res.json({
      won,
      lost,
      open: int(s.total) - won - lost,
      won_value:  num(s.won_value),
      lost_value: num(s.lost_value),
      // null when nothing has closed yet - a win rate of "0.0%" on an untouched
      // pipeline reads as losing every deal.
      win_rate: pct(won, won + lost),
      lost_reasons: reasons.rows.map(r => ({
        reason: r.reason, count: int(r.count), value: num(r.value),
      })),
      salesperson_win_rates: byPerson.rows.map(r => ({
        salesperson: r.salesperson,
        won: int(r.won), lost: int(r.lost), total: int(r.total),
        win_rate: pct(int(r.won), int(r.won) + int(r.lost)),
        revenue: num(r.revenue),
      })),
      basis: { measured_on: 'opportunities', value_column: 'expected_value', company_id: companyId },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- Team / regional targets --------------------------------------------------
router.get('/team-targets', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const yr = parseInt(req.query.fy_year || new Date().getFullYear(), 10);

    // sales_targets has target_amount / achieved_amount. The columns this query
    // summed - `target` and `achieved` - have never existed, so it threw on
    // every call and the `.catch` below it returned [].
    const { rows } = await pool.query(`
      SELECT target_type, team_name, region,
             COALESCE(SUM(target_amount), 0)   AS total_target,
             COALESCE(SUM(achieved_amount), 0) AS total_achieved,
             CASE WHEN COALESCE(SUM(target_amount), 0) > 0
                  THEN ROUND(SUM(COALESCE(achieved_amount, 0)) / SUM(target_amount) * 100, 1)
                  END AS pct
      FROM sales_targets
      WHERE period_type = 'annual' AND period_year = $2
        AND target_type IN ('team', 'regional')
        AND ${scope()}
      GROUP BY target_type, team_name, region
      ORDER BY total_target DESC
    `, [companyId, yr]);

    res.json(rows.map(r => ({
      target_type: r.target_type,
      team_name: r.team_name,
      region: r.region,
      total_target:   num(r.total_target),
      total_achieved: num(r.total_achieved),
      pct: r.pct === null ? null : num(r.pct),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
