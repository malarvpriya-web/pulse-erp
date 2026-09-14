/**
 * tcoPortfolio.service.js — the TCO engine, rolled up.
 *
 * WHY THIS EXISTS
 * ---------------
 * From the spend & BI parity audit:
 *
 *   "Pulse's TCO engine … is more sophisticated than the should-cost modelling
 *    any of the three spend suites ships natively. The gap is not capability.
 *    It is that this engine runs at the quote-comparison moment and never rolls
 *    up into a portfolio view."
 *
 * This is that rollup. The audit costed it at "1 week, reuses tcoEngine" and it
 * is less than that, because the per-decision record already exists:
 * `procurement_award_decisions` has been written on every RFQ award since §128,
 * carrying awarded / lowest-price / lowest-TCO totals, a frozen `tco_breakdown`
 * and `tco_basis`, and `tco_enabled`. Nothing here recomputes any of it.
 *
 * ⚠ AWARDED EVENTS ARE NEVER RE-SCORED
 * ------------------------------------
 * The tempting shortcut is to re-run the engine over historical quotes. It is
 * wrong, and quietly so. The engine's inputs are not stable: `vendors.on_time_pct`
 * and `defect_rate` move as delivery history accumulates, annual demand moves,
 * and the TCO parameters (holding cost, cost of capital, expedite premium) are
 * editable settings. Re-scoring a March decision with September's data produces
 * a figure that was never on any buyer's screen, and reporting it as "savings
 * you missed in March" is fabrication with a database behind it — the same class
 * of defect as a finance screen rendering KPIs from a hardcoded const, and it
 * passes every static gate for the same reason.
 *
 * So: the REALISED half reads frozen rows. The OPEN half re-scores live events,
 * which is the only honest reading there, because no decision has been made yet.
 * The two are labelled separately and never summed into one headline.
 *
 * THE THREE FIGURES, AND WHY captured CAN BE NEGATIVE
 * ---------------------------------------------------
 *   available  lowest_price_total − lowest_tco_total
 *              What awarding on total cost was worth AT ALL on this event. Zero
 *              when the cheapest quote was also the cheapest option.
 *   forgone    awarded_tco_total − lowest_tco_total   (stored, ≥ 0)
 *              What THIS award cost against the optimum.
 *   captured   lowest_price_total − awarded_tco_total
 *              What the award beat the price-only baseline by.
 *
 * `captured` is deliberately NOT clamped at zero. A negative value means the
 * buyer chose a vendor worse on total cost than the cheapest quote — neither
 * the price winner nor the TCO winner. That is a real and important outcome,
 * and flooring it at zero would hide the worst decisions inside a column of
 * successes.
 *
 * ⚠ COVERAGE IS PART OF THE ANSWER
 * A decision row exists only where the engine could rank: TCO enabled, at least
 * two computable quotes. Awards outside that set are not zero-saving awards,
 * they are UNMEASURED ones — and "we captured 100% of available savings"
 * computed over three measured decisions out of ninety is the headline this
 * file is most likely to be misread as. Hence `coverage`, and hence
 * `capture_rate_pct` is null rather than 100 when the denominator is empty.
 */
import pool from '../../shared/db.js';
import { rankOptions } from '../engines/tcoEngine.js';
import { loadTcoParams } from './tco.service.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** pg returns NUMERIC as a string; NULL must not become 0 by accident. */
const num = (v, fallback = 0) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export function resolveLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * The two derived money columns, as one SQL expression each.
 *
 * Written once and reused across every facet so a category total and the
 * headline it rolls into cannot drift — the same discipline `poSpendInr()`
 * enforces for the spend cube.
 *
 * COALESCE to the awarded total, not to zero: a decision where the engine could
 * not price the price-winner has no measurable gap, and a zero there would
 * report "no saving was available" when the truth is "we could not tell".
 */
const AVAILABLE = `GREATEST(COALESCE(d.lowest_price_total, d.awarded_tco_total) - d.lowest_tco_total, 0)`;
const CAPTURED  = `(COALESCE(d.lowest_price_total, d.awarded_tco_total) - d.awarded_tco_total)`;

/**
 * Only rows the engine actually ranked.
 *
 * `tco_enabled = false` means the award modal fell back to price and the TCO
 * columns are nulls — counting those as "no saving available" would make the
 * denominator of every rate below a lie.
 */
const MEASURABLE = `d.tco_enabled IS NOT FALSE
                    AND d.lowest_tco_total IS NOT NULL
                    AND d.awarded_tco_total IS NOT NULL`;

/**
 * ⚠ ONE DECISION PER EVENT, AND IT IS THE LATEST ONE.
 *
 * `procurement_award_decisions` is deliberately NOT unique on `rfq_id` — an
 * event that is awarded, reopened and re-awarded keeps every decision, because
 * "a re-award is history, not a conflict" (asserted by
 * integration.tcoAward.test.js).
 *
 * That is right for the audit trail and WRONG for a sum. Aggregating the raw
 * table counts a re-awarded event twice, inflating both the savings headline
 * and the decision count — and it inflates them silently, because nothing about
 * the number looks unusual. Every facet in this file therefore reads through
 * this CTE, which keeps the most recent decision per event and nothing else.
 *
 * `id DESC` breaks a tie on `created_at`: two decisions written inside the same
 * transaction share a timestamp, and an unordered pick would make the whole
 * board non-deterministic.
 */
const LATEST_PER_RFQ = `
  latest AS (
    SELECT DISTINCT ON (d.rfq_id) d.*
      FROM procurement_award_decisions d
     ORDER BY d.rfq_id, d.created_at DESC, d.id DESC
  )`;

/**
 * Live events where the cheapest quote is not the cheapest option.
 *
 * OPEN events only. An awarded event is read from its frozen row, never
 * re-scored — see the file header.
 */
async function loadOpenOpportunities({ companyId, limit }) {
  const params = await loadTcoParams(companyId);
  if (!params.tco_enabled) {
    return { rows: [], total: 0, group_count: 0, disabled: true };
  }

  // ⚠ BOTH child tables are read as SCALAR SUBQUERIES, never as joins.
  //
  // Joining `rfq_items` and `rfq_quotes` to the same parent multiplies their
  // rows: on RFQ-2026-003 — one 5-unit line, two quotes — `SUM(ri.quantity)`
  // over that join returns 10, and the whole event is then priced at twice the
  // quantity actually being bought. This is the recurring fan-out trap in this
  // codebase (a month with two deals reporting double its sales target), and it
  // is invisible because `COUNT(DISTINCT …)` beside it stays correct.
  //
  // `SUM(DISTINCT ri.quantity)` is NOT the fix: it returns the right number here
  // only because there is one line, and would silently collapse two legitimate
  // 5-unit lines into 5.
  const { rows: events } = await pool.query(`
    SELECT r.id, r.rfq_number, r.quantity AS header_qty,
           ic.name AS category_name,
           COALESCE((SELECT SUM(ri.quantity) FROM rfq_items ri
                      WHERE ri.rfq_id = r.id), 0) AS line_qty,
           (SELECT COUNT(DISTINCT q.vendor_id) FROM rfq_quotes q
             WHERE q.rfq_id = r.id)::INT AS quote_count
      FROM rfqs r
      LEFT JOIN item_categories ic ON ic.id = r.category_id AND ic.deleted_at IS NULL
     WHERE r.status <> 'closed'
       AND ($1::INTEGER IS NULL OR r.company_id = $1::INTEGER)
       AND (SELECT COUNT(DISTINCT q.vendor_id) FROM rfq_quotes q
             WHERE q.rfq_id = r.id) >= 2
     ORDER BY r.id DESC
     LIMIT $2`,
    [companyId ?? null, MAX_LIMIT]
  );
  if (!events.length) return { rows: [], total: 0, group_count: 0, disabled: false };

  const { rows: quotes } = await pool.query(`
    SELECT q.*, v.vendor_name,
           v.lead_time_days     AS vendor_lead_time_days,
           v.payment_terms_days AS vendor_payment_terms_days
      FROM rfq_quotes q
      LEFT JOIN vendors v ON v.id = q.vendor_id
     WHERE q.rfq_id = ANY($1::int[])`,
    [events.map((e) => e.id)]
  );

  const byRfq = new Map();
  for (const q of quotes) {
    if (!byRfq.has(q.rfq_id)) byRfq.set(q.rfq_id, []);
    byRfq.get(q.rfq_id).push(q);
  }

  const out = [];
  for (const ev of events) {
    const qs = byRfq.get(ev.id) ?? [];
    if (qs.length < 2) continue;

    const qty = num(ev.line_qty) > 0 ? num(ev.line_qty) : (num(ev.header_qty) || 1);
    const ranked = rankOptions(qs.map((q) => {
      const total = num(q.total_amount, null);
      const unit = num(q.unit_price, null) ?? (total != null && qty > 0 ? total / qty : null);
      return {
        vendor_id: Number(q.vendor_id),
        vendor_name: q.vendor_name || `Vendor #${q.vendor_id}`,
        unit_price: unit,
        quantity: qty,
        freight_amount:   num(q.freight_amount, null),
        insurance_amount: num(q.insurance_amount, null),
        duty_amount:      num(q.duty_amount, null),
        packaging_amount: num(q.packaging_amount, null),
        other_charges:    num(q.other_charges, null),
        tooling_cost:     num(q.tooling_cost, null),
        tax_pct:          num(q.tax_pct, null),
        moq:              num(q.moq, null),
        lead_time_days:     q.delivery_days ?? q.vendor_lead_time_days ?? null,
        payment_terms_days: num(q.vendor_payment_terms_days, null),
      };
    }), params);

    const rec = ranked.recommendation;
    if (!rec?.differs || !(rec.tco_saving > 0)) continue;

    out.push({
      rfq_id: ev.id,
      rfq_number: ev.rfq_number,
      category: ev.category_name ?? 'Unclassified',
      quote_count: ev.quote_count,
      quantity: qty,
      lowest_price_vendor: rec.lowest_price_label,
      lowest_tco_vendor: rec.lowest_tco_label,
      // What the buyer has to defend in the approval note: the TCO winner looks
      // this much dearer on sticker price.
      price_gap_pct: rec.price_gap_pct,
      saving_available: round2(rec.tco_saving),
      confidence: ranked.confidence,
    });
  }

  out.sort((a, b) => b.saving_available - a.saving_available);
  return {
    rows: out.slice(0, limit),
    total: round2(out.reduce((s, r) => s + r.saving_available, 0)),
    group_count: out.length,
    disabled: false,
  };
}

/**
 * The portfolio board.
 *
 * `from`/`to` filter the REALISED half on when the award was decided. The open
 * half is a snapshot of now and deliberately ignores the window: an opportunity
 * has no historical date, and filtering it by one would empty the panel for any
 * range ending before today.
 */
export async function loadTcoPortfolio({ companyId, from = null, to = null, limit = DEFAULT_LIMIT } = {}) {
  const lim = resolveLimit(limit);
  const params = [];
  const where = [MEASURABLE];
  if (companyId) { params.push(companyId); where.push(`d.company_id = $${params.length}`); }
  if (from)      { params.push(from);      where.push(`d.created_at >= $${params.length}::date`); }
  if (to)        { params.push(to);        where.push(`d.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
  const scoped = where.join(' AND ');

  // Every facet below is prefixed with this identical CTE and passed this
  // identical param array, so each `$n` is referenced in every statement —
  // sharing one fixed-position param array across sibling queries is otherwise
  // exactly how an "unreferenced parameter" bind error appears.
  const cte = `WITH ${LATEST_PER_RFQ}`;

  const [totalsRes, byCategoryRes, byVendorRes, byMonthRes, missesRes, coverageRes, openRes] =
    await Promise.all([
      pool.query(`${cte}
        SELECT COUNT(*)::INT AS decisions,
               COUNT(*) FILTER (WHERE d.followed_recommendation)::INT AS followed,
               COALESCE(SUM(${AVAILABLE}), 0)          AS available,
               COALESCE(SUM(${CAPTURED}), 0)           AS captured,
               COALESCE(SUM(d.tco_saving_forgone), 0)  AS forgone,
               ROUND(AVG(d.awarded_confidence))        AS avg_confidence
          FROM latest d WHERE ${scoped}`, params),

      // Category is joined through the RFQ rather than frozen on the decision.
      // A rename SHOULD re-bucket a historical saving — unlike the money, which
      // must not move — so this join is correct where re-scoring would not be.
      pool.query(`${cte}
        SELECT COALESCE(ic.name, 'Unclassified') AS category,
               COALESCE(ic.name, 'Unclassified') AS label,
               COALESCE(SUM(${AVAILABLE}), 0)         AS available,
               COALESCE(SUM(${CAPTURED}), 0)          AS captured,
               COALESCE(SUM(d.tco_saving_forgone), 0) AS forgone,
               COUNT(*)::INT                          AS decisions
          FROM latest d
          LEFT JOIN rfqs r ON r.id = d.rfq_id
          LEFT JOIN item_categories ic ON ic.id = r.category_id AND ic.deleted_at IS NULL
         WHERE ${scoped}
         GROUP BY COALESCE(ic.name, 'Unclassified')
         ORDER BY available DESC NULLS LAST`, params),

      pool.query(`${cte}
        SELECT COALESCE(v.vendor_name, 'Unknown') AS vendor_name,
               COALESCE(v.vendor_name, 'Unknown') AS label,
               COALESCE(SUM(${AVAILABLE}), 0)         AS available,
               COALESCE(SUM(${CAPTURED}), 0)          AS captured,
               COALESCE(SUM(d.tco_saving_forgone), 0) AS forgone,
               COUNT(*)::INT                          AS decisions
          FROM latest d
          LEFT JOIN vendors v ON v.id = d.awarded_vendor_id
         WHERE ${scoped}
         GROUP BY COALESCE(v.vendor_name, 'Unknown')
         ORDER BY available DESC NULLS LAST`, params),

      pool.query(`${cte}
        SELECT TO_CHAR(DATE_TRUNC('month', d.created_at), 'YYYY-MM') AS month,
               TO_CHAR(DATE_TRUNC('month', d.created_at), 'YYYY-MM') AS label,
               COALESCE(SUM(${AVAILABLE}), 0)         AS available,
               COALESCE(SUM(${CAPTURED}), 0)          AS captured,
               COALESCE(SUM(d.tco_saving_forgone), 0) AS forgone,
               COUNT(*)::INT                          AS decisions
          FROM latest d WHERE ${scoped}
         GROUP BY DATE_TRUNC('month', d.created_at)
         ORDER BY DATE_TRUNC('month', d.created_at) ASC`, params),

      // The actionable list: decisions that left the most on the table. Every
      // one of these is a choice somebody should be able to explain.
      pool.query(`${cte}
        SELECT d.rfq_id, r.rfq_number, d.po_id, po.po_number,
               COALESCE(aw.vendor_name, 'Unknown') AS awarded_vendor,
               COALESCE(bt.vendor_name, 'Unknown') AS recommended_vendor,
               d.tco_saving_forgone AS forgone,
               d.awarded_confidence AS confidence,
               d.created_at,
               COALESCE(ic.name, 'Unclassified') AS category
          FROM latest d
          LEFT JOIN rfqs r     ON r.id  = d.rfq_id
          LEFT JOIN vendors aw ON aw.id = d.awarded_vendor_id
          LEFT JOIN vendors bt ON bt.id = d.lowest_tco_vendor_id
          LEFT JOIN purchase_orders po ON po.id = d.po_id
          LEFT JOIN item_categories ic ON ic.id = r.category_id AND ic.deleted_at IS NULL
         WHERE ${scoped} AND COALESCE(d.tco_saving_forgone, 0) > 0
         ORDER BY d.tco_saving_forgone DESC
         LIMIT ${lim}`, params),

      // How much of the award book the engine actually measured.
      pool.query(`
        -- COUNT(DISTINCT rfq_id), not COUNT(*): the unit here is the EVENT, and
        -- a re-awarded event has several decision rows. Counting rows would
        -- report more measured events than there are events, and could put
        -- measured_pct above 100.
        SELECT (SELECT COUNT(*)::INT FROM rfqs r
                 WHERE r.status = 'closed'
                   AND ($1::INTEGER IS NULL OR r.company_id = $1::INTEGER)) AS closed_events,
               (SELECT COUNT(DISTINCT d2.rfq_id)::INT FROM procurement_award_decisions d2
                 WHERE ($1::INTEGER IS NULL OR d2.company_id = $1::INTEGER)) AS recorded_events,
               (SELECT COUNT(DISTINCT d3.rfq_id)::INT FROM procurement_award_decisions d3
                 WHERE ($1::INTEGER IS NULL OR d3.company_id = $1::INTEGER)
                   AND d3.tco_enabled IS NOT FALSE
                   AND d3.lowest_tco_total IS NOT NULL
                   AND d3.awarded_tco_total IS NOT NULL) AS measured_events`,
        [companyId ?? null]),

      loadOpenOpportunities({ companyId, limit: lim }),
    ]);

  const t = totalsRes.rows[0] ?? {};
  const available = round2(num(t.available));
  const captured  = round2(num(t.captured));
  const forgone   = round2(num(t.forgone));
  const decisions = num(t.decisions);
  const followed  = num(t.followed);

  const closed   = num(coverageRes.rows[0]?.closed_events);
  const recorded = num(coverageRes.rows[0]?.recorded_events);
  const measured = num(coverageRes.rows[0]?.measured_events);

  const shape = (rows) => rows.map((r) => ({
    ...r,
    available: round2(num(r.available)),
    captured:  round2(num(r.captured)),
    forgone:   round2(num(r.forgone)),
  }));

  return {
    currency: 'INR',
    from: from || null,
    to: to || null,

    realised: {
      decisions,
      followed,
      saving_available: available,
      saving_captured: captured,
      saving_forgone: forgone,
      // null, not 100 — a rate over an empty denominator is not a perfect score.
      capture_rate_pct: available > 0 ? round2((captured / available) * 100) : null,
      follow_rate_pct: decisions > 0 ? round2((followed / decisions) * 100) : null,
      avg_confidence: t.avg_confidence == null ? null : num(t.avg_confidence),
      note: 'Frozen at award time. saving_captured may be negative where the award went to a vendor worse on total cost than the cheapest quote — that is a real outcome and is not floored at zero.',
    },

    open_opportunity: {
      saving_available: openRes.total,
      event_count: openRes.group_count,
      rows: openRes.rows,
      tco_disabled: openRes.disabled,
      note: 'Live events re-scored against today\'s parameters. Awarded events are never re-scored: their comparison is frozen at the moment it was decided.',
    },

    by_category: shape(byCategoryRes.rows),
    by_vendor:   shape(byVendorRes.rows),
    by_month:    shape(byMonthRes.rows),

    biggest_misses: missesRes.rows.map((r) => ({
      rfq_id: r.rfq_id,
      rfq_number: r.rfq_number,
      po_id: r.po_id,
      po_number: r.po_number,
      category: r.category,
      awarded_vendor: r.awarded_vendor,
      recommended_vendor: r.recommended_vendor,
      forgone: round2(num(r.forgone)),
      confidence: r.confidence == null ? null : num(r.confidence),
      decided_at: r.created_at,
    })),

    coverage: {
      closed_events: closed,
      recorded_events: recorded,
      measured_events: measured,
      measured_pct: closed > 0 ? round2((measured / closed) * 100) : 0,
      note: 'A decision is measurable only where TCO was enabled and at least two quotes were computable. Unmeasured awards are not zero-saving awards; they are unmeasured, and are excluded from every rate above rather than counted as successes.',
    },
  };
}

export default { loadTcoPortfolio, resolveLimit, DEFAULT_LIMIT, MAX_LIMIT };
