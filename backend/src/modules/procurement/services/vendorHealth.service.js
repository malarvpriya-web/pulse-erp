/**
 * Phase 49G — Vendor Health Service
 *
 * Orchestrates DB queries, feeds data into vendorHealthEngine,
 * persists scores, and serves dashboard/heatmap/CEO views.
 */
import pool from '../../../config/db.js';
import engine from '../engines/vendorHealthEngine.js';

// ── Helpers ──────────────────────────────────────────────────────────────────────
const q = (sql, params) => pool.query(sql, params);

/**
 * A dashboard panel that is allowed to fail without blanking the page — but not
 * allowed to fail silently.
 *
 * Two panels on the CEO command centre carried a bare `.catch(() => ({ rows: [] }))`.
 * A broken query there renders as "no top suppliers" and "no delayed suppliers",
 * which reads as good news. The failure is still contained to its own panel; it
 * is now named in the log, so "the board is empty" is diagnosable rather than
 * indistinguishable from "nothing to report".
 */
const panel = (label, promise) => promise.catch((err) => {
  console.error(`[vendorHealth] ${label} panel failed (${err.code || 'no code'}): ${err.message}`);
  return { rows: [] };
});

// ── 49G-1  COMPUTE + PERSIST HEALTH SCORE ────────────────────────────────────────
async function computeAndSave(vendorId, companyId) {
  // Fetch all source data in parallel
  const [
    { rows: [vendor] },
    { rows: [scorecard] },
    { rows: [ncrStats] },
    { rows: [grnStats] },
    { rows: [capaStats] },
    { rows: docs },
    { rows: [poStats] },
    { rows: [projectStats] },
    { rows: [flags] },
    { rows: [fulfilStats] },
    { rows: [ppvStats] },
    { rows: [responseStats] },
  ] = await Promise.all([
    // Scoped. Four of the nine reads below already carried company_id and five
    // did not, so a caller in one tenant could score a vendor belonging to
    // another — reading that vendor's master record, its latest scorecard and
    // its document set, and then PERSISTING the resulting score into the
    // caller's own tenant. `vendor` is checked for existence below, so scoping
    // it here is what turns the whole call into a 404 for a foreign vendor.
    q(`SELECT * FROM vendors WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [vendorId, companyId]),

    q(`SELECT * FROM vendor_scorecards
       WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)
       ORDER BY period_year DESC, period_quarter DESC LIMIT 1`, [vendorId, companyId]),

    // ⚠ THIS READ USED TO POINT AT `vendor_ncr`, WHICH NOTHING WRITES.
    //
    // Incoming QC raises its NCRs into `ncr_reports` (quality.routes.js, three
    // auto-NCR paths plus the manual one). `vendor_ncr` is written only by four
    // endpoints in vendor-approval.routes.js that no screen calls — so the quality
    // half of every supplier rating had no write path at all, and a failed incoming
    // inspection could not reach the scorecard even in principle. `ncr_reports` is
    // now the single system of record; migration 20260910000006 moved the rows and
    // gave this table the columns vendor_ncr had. See that migration's header.
    //
    // Vocabulary comes from the code that WRITES it, never from the rows in it
    // (project_supplier_performance_index): ncr_reports.status is
    // open|under-review|resolved|closed and severity is lower-case. The old filters
    // ('Open', 'Critical') matched nothing here. "Open" means not closed, which is
    // the definition quality.routes.js and the dashboards already use.
    //
    // ⚠ `repeat_ncr` was `... AND ncr_date IS NOT NULL AND ncr_date = ncr_date` —
    // a tautology. It counted EVERY NCR in the window as a repeat, at -8 points
    // each on top of the -5/-15 those same rows already drew as open/critical. A
    // repeat is the same defect recurring: occurrences beyond the first for a given
    // defect_type. Rows with no defect_type establish no repeat and are excluded.
    q(`SELECT
         COUNT(*)                                                          AS total_ncr,
         COUNT(*) FILTER (WHERE LOWER(status) <> 'closed')                 AS open_ncr,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'critical')              AS critical_ncr,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'critical'
                            AND created_at > NOW() - INTERVAL '12 months') AS critical_ncr_12m,
         GREATEST(
           COUNT(*)          FILTER (WHERE defect_type IS NOT NULL
                                       AND created_at > NOW() - INTERVAL '12 months')
         - COUNT(DISTINCT defect_type) FILTER (WHERE defect_type IS NOT NULL
                                       AND created_at > NOW() - INTERVAL '12 months'),
           0)                                                              AS repeat_ncr
       FROM ncr_reports
       WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [vendorId, companyId]),

    // goods_receipt_notes has no vendor_id/actual_delivery_date/expected_delivery_date/
    // partial_delivery/received_qty/rejected_qty/inspection_result columns — bridge through
    // purchase_orders (supplier_id) for vendor identity and expected date, grn_items for
    // received/rejected quantities, and grn.quality_status ('passed'/'failed'/...) for
    // inspection outcome. Expected date falls back to order_date + vendor.lead_time_days
    // when a PO never got an explicit expected_delivery_date (same fallback already used by
    // ai.routes.js's vendor-delay prediction, not a new assumption). po.status = 'partial' is
    // the real partial-delivery signal — there's no separate flag at GRN/line-item level.
    q(`WITH g AS (
         SELECT grn.id, grn.received_date, grn.quality_status, po.status AS po_status,
                COALESCE(po.expected_delivery_date,
                         po.order_date + (v.lead_time_days || ' days')::interval)::date AS implied_expected,
                -- Did anyone actually promise this date, or did we derive it?
                -- 'quoted' is the supplier's own delivery days off the winning bid and
                -- 'agreed' is a date a buyer put on the order; both are commitments.
                -- Anything else is order_date + vendors.lead_time_days, which is master
                -- data we typed about them. A generous lead time flatters OTD, so the
                -- distinction has to survive all the way out to the score.
                (po.expected_delivery_date IS NOT NULL
                  AND COALESCE(po.expected_delivery_basis, 'agreed') IN ('quoted','agreed')) AS date_promised
         FROM goods_receipt_notes grn
         JOIN purchase_orders po ON po.id = grn.po_id
         JOIN vendors v ON v.id = po.supplier_id
         WHERE po.supplier_id = $1 AND grn.company_id = $2 AND grn.deleted_at IS NULL
       )
       SELECT
         COUNT(*)                                                          AS total_grns,
         COUNT(*) FILTER (WHERE received_date <= implied_expected)         AS on_time_grns,
         COUNT(*) FILTER (WHERE received_date > implied_expected)          AS delayed_grns,
         COUNT(*) FILTER (WHERE date_promised)                             AS promised_date_grns,
         COALESCE(AVG(received_date - implied_expected)
           FILTER (WHERE received_date > implied_expected), 0)             AS avg_delay_days,
         COUNT(*) FILTER (WHERE po_status = 'partial')                     AS partial_grns,
         COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN g ON g.id = gi.grn_id), 0) AS total_received_qty,
         COALESCE((SELECT SUM(gi.quantity_rejected) FROM grn_items gi JOIN g ON g.id = gi.grn_id), 0) AS total_rejected_qty,
         COUNT(*) FILTER (WHERE quality_status = 'passed')                 AS passed_inspections,
         COUNT(*) FILTER (WHERE quality_status IN ('passed', 'failed'))    AS total_inspections
       FROM g`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    // Same repoint as the NCR read above: `capa_actions` is what the Quality module
    // writes and what the NCR close-out gate checks. A supplier CAPA reaches this
    // vendor either directly (capa_actions.vendor_id, for an audit or development
    // action with no NCR behind it) or through the NCR it answers.
    //
    // ⚠ Closure was counted as status = 'Closed'. capa_actions never holds that
    // value — quality.routes.js gates NCR closure on status NOT IN
    // ('completed','verified'), which is the real definition of a closed CAPA.
    // Every seeded row said 'active', so closure read 0% for every supplier and
    // scoreQuality's flat -10 "below 60% closure" penalty applied universally, on
    // a vocabulary mismatch rather than on anyone's actual performance.
    q(`SELECT
         COUNT(*)                                                          AS total_capas,
         COUNT(*) FILTER (WHERE LOWER(ca.status) IN ('completed','verified')) AS closed_capas
       FROM capa_actions ca
       LEFT JOIN ncr_reports n ON n.id = ca.ncr_id
       WHERE COALESCE(ca.vendor_id, n.vendor_id) = $1
         AND ($2::int IS NULL OR ca.company_id = $2)`,
      [vendorId, companyId]),

    // vendor_documents has no deleted_at column (soft-delete isn't modeled here — rows are
    // real or absent) — this filter always threw, with no .catch() guard, so computeAndSave
    // never completed a single run regardless of the GRN/PO fixes above.
    q(`SELECT doc_type, expiry_date, verified, status
       FROM vendor_documents
       WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [vendorId, companyId]),

    // purchase_orders has no unit_price/price_increased column, real status values are only
    // 'partial'/'received' (never 'delayed'/'overdue'), and supplier_id is integer — the old
    // `= $1::text` cast would throw even after fixing the column names. unit_price lives on
    // purchase_order_items.rate (per line item); "late" is rederived the same way as the GRN
    // query above; escalation_count is a real signal — item ids whose most recent price
    // exceeds their own prior-period max for this vendor — not a column that exists anywhere.
    q(`WITH items AS (
         SELECT poi.item_id, poi.rate,
                (po.order_date > NOW() - INTERVAL '6 months')                                    AS is_recent,
                (po.order_date BETWEEN NOW() - INTERVAL '18 months' AND NOW() - INTERVAL '6 months') AS is_baseline
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.po_id
         WHERE po.supplier_id = $1 AND po.company_id = $2
       )
       SELECT
         (SELECT COUNT(DISTINCT po.id) FROM purchase_orders po
           WHERE po.supplier_id = $1 AND po.company_id = $2)                AS total_pos,
         (SELECT COUNT(DISTINCT po.id) FROM purchase_orders po
            JOIN vendors v ON v.id = po.supplier_id
           WHERE po.supplier_id = $1 AND po.company_id = $2
             AND po.order_date > NOW() - INTERVAL '12 months'
             AND EXISTS (
               SELECT 1 FROM goods_receipt_notes g
               WHERE g.po_id = po.id AND g.deleted_at IS NULL
                 AND g.received_date > COALESCE(po.expected_delivery_date,
                       po.order_date + (v.lead_time_days || ' days')::interval)::date
             ))                                                             AS late_pos_12m,
         COALESCE((SELECT AVG(rate) FROM items WHERE is_recent), 0)         AS avg_price_recent,
         COALESCE((SELECT AVG(rate) FROM items WHERE is_baseline), 0)       AS avg_price_prev,
         (SELECT COUNT(DISTINCT r.item_id) FROM items r
           WHERE r.is_recent AND r.rate > (
             SELECT MAX(p.rate) FROM items p WHERE p.item_id = r.item_id AND p.is_baseline
           ))                                                               AS escalation_count`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    q(`SELECT
         COUNT(DISTINCT p.id) AS project_count,
         COALESCE(SUM(p.budget_amount), 0) AS total_project_value
       FROM projects p
       JOIN purchase_orders po
         ON po.project_id::text = p.id::text
        AND po.deleted_at IS NULL
       WHERE po.supplier_id::text = $1::text AND p.company_id = $2
         AND p.status NOT IN ('Completed', 'Cancelled')`,
      [vendorId, companyId]),

    q(`SELECT * FROM vendor_strategic_flags
        WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)`, [vendorId, companyId])
      .catch(() => ({ rows: [{}] })),

    // ── FILL RATE + LEAD-TIME ADHERENCE ──────────────────────────────────────
    //
    // Fill rate comes off the LINES, not the order header. `purchase_order_items`
    // carries both `received_qty` and `received_quantity` — twin denormalised
    // columns kept in step by two separate migrations — so neither is trusted
    // here: the receipt quantities are summed from `grn_items`, which is where a
    // goods receipt actually lands. A line ordered and never received contributes
    // its full shortfall, which is the entire point of the KPI.
    //
    // Lead-time adherence only judges orders carrying a date the SUPPLIER
    // committed to (basis 'quoted' or 'agreed'), the same gate OTD's basis uses.
    // Against a date we derived from our own lead-time master data, "adherence"
    // would be measuring our guess against itself.
    //
    // ⚠ ±3 days is the tolerance. Early counts as out of schedule: a receipt that
    // lands two weeks ahead of a committed date is unplanned inventory and
    // unplanned payables, not good service.
    q(`WITH lines AS (
         SELECT poi.id, poi.quantity AS ordered_qty,
                COALESCE((SELECT SUM(gi.quantity_received)
                            FROM grn_items gi WHERE gi.po_item_id = poi.id), 0) AS got_qty
           FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.po_id
          WHERE po.supplier_id = $1 AND po.deleted_at IS NULL
            AND ($2::int IS NULL OR po.company_id = $2)
            AND po.status NOT IN ('draft', 'cancelled')
            AND po.order_date > NOW() - INTERVAL '12 months'
       ),
       sched AS (
         SELECT (grn.received_date - po.expected_delivery_date) AS variance_days
           FROM goods_receipt_notes grn
           JOIN purchase_orders po ON po.id = grn.po_id
          WHERE po.supplier_id = $1 AND grn.deleted_at IS NULL
            AND ($2::int IS NULL OR grn.company_id = $2)
            AND po.expected_delivery_date IS NOT NULL
            AND COALESCE(po.expected_delivery_basis, 'agreed') IN ('quoted', 'agreed')
            AND grn.received_date IS NOT NULL
       )
       SELECT
         (SELECT COUNT(*) FROM lines)                                        AS ordered_lines,
         COALESCE((SELECT SUM(ordered_qty) FROM lines), 0)                   AS ordered_qty,
         COALESCE((SELECT SUM(LEAST(got_qty, ordered_qty)) FROM lines), 0)   AS received_qty,
         (SELECT COUNT(*) FROM sched)                                        AS promised_receipts,
         (SELECT COUNT(*) FROM sched WHERE ABS(variance_days) <= 3)          AS on_schedule_receipts,
         (SELECT AVG(ABS(variance_days)) FROM sched)                         AS avg_variance_days`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    // ── PURCHASE PRICE VARIANCE ──────────────────────────────────────────────
    // What we paid this supplier against the item's standard cost, weighted by
    // quantity so a large line counts for more than a small one. Items with no
    // standard cost (or a zero one) are EXCLUDED, not treated as free — dividing
    // by a zero standard reports every purchase as infinitely unfavourable.
    q(`SELECT
         COALESCE(SUM(poi.quantity * ii.standard_cost), 0) AS standard_value,
         COALESCE(SUM(poi.quantity * poi.rate), 0)         AS actual_value,
         COUNT(*)                                          AS priced_lines
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       JOIN inventory_items ii ON ii.id = poi.item_id
      WHERE po.supplier_id = $1 AND po.deleted_at IS NULL
        AND ($2::int IS NULL OR po.company_id = $2)
        AND po.status NOT IN ('draft', 'cancelled')
        AND po.order_date > NOW() - INTERVAL '12 months'
        AND ii.standard_cost IS NOT NULL AND ii.standard_cost > 0
        AND poi.rate IS NOT NULL AND poi.quantity > 0`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    // ── RESPONSIVENESS ───────────────────────────────────────────────────────
    // Two clocks this system already keeps. Neither was ever read: the support
    // dimension was a hand-dragged slider over a hard-coded 24-hour default.
    //
    // ⚠ Quote turnaround can only be measured for vendors that ANSWERED. There is
    // no row for a vendor that was invited and stayed silent — `rfqs.vendor_ids`
    // is a jsonb list and is empty on every event in this database — so a
    // response RATE is not derivable and is not claimed. What is measured is how
    // fast the ones who replied, replied.
    q(`SELECT
         (SELECT AVG(EXTRACT(EPOCH FROM (rq.created_at - r.created_at)) / 86400.0)
            FROM rfq_quotes rq JOIN rfqs r ON r.id = rq.rfq_id
           WHERE rq.vendor_id = $1
             AND ($2::int IS NULL OR r.company_id = $2)
             AND rq.created_at >= r.created_at
             AND r.created_at > NOW() - INTERVAL '12 months')      AS quote_turnaround_days,
         (SELECT COUNT(*)
            FROM rfq_quotes rq JOIN rfqs r ON r.id = rq.rfq_id
           WHERE rq.vendor_id = $1
             AND ($2::int IS NULL OR r.company_id = $2)
             AND rq.created_at >= r.created_at
             AND r.created_at > NOW() - INTERVAL '12 months')      AS quotes_considered,
         (SELECT AVG(EXTRACT(EPOCH FROM (first_capa.first_at - n.created_at)) / 86400.0)
            FROM ncr_reports n
            JOIN LATERAL (SELECT MIN(ca.created_at) AS first_at
                            FROM capa_actions ca WHERE ca.ncr_id = n.id) first_capa ON TRUE
           WHERE n.vendor_id = $1
             AND ($2::int IS NULL OR n.company_id = $2)
             AND first_capa.first_at IS NOT NULL
             AND first_capa.first_at >= n.created_at)              AS ncr_response_days,
         (SELECT COUNT(*)
            FROM ncr_reports n
            JOIN LATERAL (SELECT MIN(ca.created_at) AS first_at
                            FROM capa_actions ca WHERE ca.ncr_id = n.id) first_capa ON TRUE
           WHERE n.vendor_id = $1
             AND ($2::int IS NULL OR n.company_id = $2)
             AND first_capa.first_at IS NOT NULL
             AND first_capa.first_at >= n.created_at)              AS ncrs_considered`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),
  ]);

  if (!vendor) throw Object.assign(new Error('Vendor not found'), { status: 404 });

  // ── Compliance checks ──────────────────────────────────────────────────────────
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const gstDoc   = docs.find(d => d.doc_type === 'GST Certificate' || d.doc_type === 'GSTIN');
  const panDoc   = docs.find(d => d.doc_type === 'PAN');
  const isoDoc   = docs.find(d => (d.doc_type || '').toUpperCase().includes('ISO'));
  const bankDoc  = docs.find(d => d.doc_type === 'Cancelled Cheque');

  const expiredDocs    = docs.filter(d => d.expiry_date && new Date(d.expiry_date) < now).length;
  const expiringSoon   = docs.filter(d => d.expiry_date && new Date(d.expiry_date) >= now && new Date(d.expiry_date) <= in30).length;

  // ── GRN metrics ───────────────────────────────────────────────────────────────
  const totalGRNs         = Number(grnStats?.total_grns         || 0);
  const onTimeGRNs        = Number(grnStats?.on_time_grns       || 0);
  const delayedGRNs       = Number(grnStats?.delayed_grns       || 0);
  const avgDelayDays      = parseFloat(grnStats?.avg_delay_days  || 0);
  const partialDeliveries = Number(grnStats?.partial_grns       || 0);
  const promisedDateGRNs  = Number(grnStats?.promised_date_grns || 0);
  const totalReceivedQty  = parseFloat(grnStats?.total_received_qty || 0);
  const totalRejectedQty  = parseFloat(grnStats?.total_rejected_qty || 0);
  const passedInsp        = Number(grnStats?.passed_inspections  || 0);
  const totalInsp         = Number(grnStats?.total_inspections   || 0);

  // ── NCR metrics ───────────────────────────────────────────────────────────────
  const openNCR       = Number(ncrStats?.open_ncr       || 0);
  const criticalNCR   = Number(ncrStats?.critical_ncr   || 0);
  const criticalNCR12m = Number(ncrStats?.critical_ncr_12m || 0);
  const repeatNCR     = Number(ncrStats?.repeat_ncr     || 0);

  // ── CAPA metrics ──────────────────────────────────────────────────────────────
  const totalCAPAs  = Number(capaStats?.total_capas  || 0);
  const closedCAPAs = Number(capaStats?.closed_capas || 0);

  // ── PPV metrics ───────────────────────────────────────────────────────────────
  const standardValue = parseFloat(ppvStats?.standard_value || 0);
  const actualValue   = parseFloat(ppvStats?.actual_value   || 0);

  // ── PO / cost metrics ─────────────────────────────────────────────────────────
  const totalPOs       = Number(poStats?.total_pos         || 0);
  const latePOs12m     = Number(poStats?.late_pos_12m      || 0);
  const avgPriceRecent = parseFloat(poStats?.avg_price_recent || 0);
  const avgPricePrev   = parseFloat(poStats?.avg_price_prev   || 0);
  const priceVariancePct = avgPricePrev > 0
    ? Math.abs((avgPriceRecent - avgPricePrev) / avgPricePrev) * 100 : 0;
  const escalationCount = Number(poStats?.escalation_count || 0);

  // ── Outstanding vs credit limit ───────────────────────────────────────────────
  const outstanding      = parseFloat(vendor.outstanding_amount || 0);
  const creditLimit      = parseFloat(vendor.credit_limit       || 0);
  const outstandingPct   = creditLimit > 0 ? (outstanding / creditLimit) * 100 : 0;

  // ── Run engine ────────────────────────────────────────────────────────────────
  const result = engine.computeVendorHealth({
    qualityInputs: {
      totalInspections: totalInsp, passedInspections: passedInsp,
      openNCR, repeatNCR, criticalNCR,
      totalCAPAs, closedCAPAs,
      rejectionQty: totalRejectedQty, totalReceivedQty,
    },
    deliveryInputs: {
      totalGRNs, onTimeGRNs, delayedGRNs, avgDelayDays, partialDeliveries,
      promisedDateGRNs,
      orderedQty:  parseFloat(fulfilStats?.ordered_qty  || 0),
      receivedQty: parseFloat(fulfilStats?.received_qty || 0),
      orderedLines: Number(fulfilStats?.ordered_lines || 0),
      promisedLeadTimeReceipts:   Number(fulfilStats?.promised_receipts    || 0),
      onScheduleLeadTimeReceipts: Number(fulfilStats?.on_schedule_receipts || 0),
      avgLeadTimeVarianceDays:    fulfilStats?.avg_variance_days == null
        ? null : parseFloat(fulfilStats.avg_variance_days),
    },
    costInputs: {
      // PPV: actual paid vs standard cost, quantity-weighted, over lines whose
      // item carries a standard cost. `priced_lines` is the evidence gate — with
      // no such line there is no standard to have varied from, and a 0% PPV would
      // read as "exactly on standard" rather than "never measured".
      ppvPct: standardValue > 0
        ? ((actualValue - standardValue) / standardValue) * 100 : null,
      ppvPricedLines: Number(ppvStats?.priced_lines || 0),
      priceVariancePct, rfqCompetitive: priceVariancePct <= 10,
      escalationCount, last12mPOCount: totalPOs || 1,
      // Both windows have to have priced lines, otherwise priceVariancePct is 0
      // by fallback and scoreCost would read that as "perfectly stable".
      hasPriceHistory: avgPriceRecent > 0 && avgPricePrev > 0,
    },
    supportInputs: {
      storedSupportScore: scorecard?.support_score || null,
      quoteTurnaroundDays: responseStats?.quote_turnaround_days == null
        ? null : parseFloat(responseStats.quote_turnaround_days),
      quotesConsidered: Number(responseStats?.quotes_considered || 0),
      ncrResponseDays: responseStats?.ncr_response_days == null
        ? null : parseFloat(responseStats.ncr_response_days),
      ncrsConsidered: Number(responseStats?.ncrs_considered || 0),
      // A closed NCR is an issue this supplier saw through; an open one is not.
      openIssues:     openNCR,
      resolvedIssues: Math.max(0, Number(ncrStats?.total_ncr || 0) - openNCR),
    },
    complianceInputs: {
      hasGST:       !!(vendor.gstin || gstDoc),
      hasPAN:       !!(vendor.pan   || panDoc),
      hasMSME:      !!(vendor.msme_status || vendor.udyam_number),
      hasISO:       !!isoDoc,
      docsExpiringSoon: expiringSoon,
      expiredDocs,
      gstVerified:  !!(gstDoc?.verified),
      panVerified:  !!(panDoc?.verified),
    },
    financialInputs: {
      annualTurnover:          parseFloat(vendor.annual_turnover || 0),
      bankVerified:            !!(bankDoc?.verified),
      pendingPaymentDisputes:  0,
      outstandingVsLimitPct:   outstandingPct,
      creditRating:            vendor.credit_rating || 'B',
    },
    dependencyInputs: {
      isSingleSource:      !!(vendor.is_single_source || flags?.is_single_source),
      isCriticalSupplier:  !!(vendor.is_critical_supplier || flags?.is_critical_supplier),
      isLongLead:          !!(vendor.is_long_lead || flags?.is_long_lead),
      alternativeCount:    3,
      spendConcentrationPct: 0,
    },
    riskEventInputs: {
      lateDeliveries12m:   latePOs12m,
      criticalNCR12m,
      failedAudits12m:     0,
      supplyInterruptions: 0,
      complianceViolations: expiredDocs,
      // A spotless event record only means something once there has been
      // something to have events about.
      hasHistory: totalPOs > 0 || totalGRNs > 0,
    },
    // Has anyone actually transacted with this supplier? A PO, a receipt, an
    // inspection or an NCR is enough. Without any of them the quality and
    // delivery dimensions are pure defaults and the composite means nothing --
    // see classifyHealth().
    hasEvidence: totalPOs > 0 || totalGRNs > 0 || totalInsp > 0
                 || Number(ncrStats?.total_ncr || 0) > 0,
  });

  // ── Detect early warnings ─────────────────────────────────────────────────────
  const warnings = engine.detectEarlyWarnings({
    vendorId,
    deliveryResult:   result.detail.delivery,
    qualityResult:    result.detail.quality,
    complianceInputs: result.detail.compliance,
    costResult:       result.detail.cost,
    riskEventInputs:  { failedAudits12m: 0, ...result.detail.risk_events },
  });

  // ── Upsert health score ───────────────────────────────────────────────────────
  await q(`
    INSERT INTO vendor_health_scores
      (company_id, vendor_id, health_score, health_status, quality_score, delivery_score,
       cost_score, support_score, compliance_score, financial_score, dependency_score,
       risk_score, otd_pct, otd_basis, promised_coverage_pct,
       pass_rate_pct, open_ncr_count, capa_closure_pct, coverage_pct,
       fill_rate_pct, lead_time_adherence_pct, avg_lead_time_variance_days,
       ppv_pct, response_days, response_source,
       calculated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
            $20,$21,$22,$23,$24,$25,NOW(),NOW())
    ON CONFLICT (company_id, vendor_id) DO UPDATE SET
      coverage_pct     = EXCLUDED.coverage_pct,
      health_score     = EXCLUDED.health_score,
      health_status    = EXCLUDED.health_status,
      quality_score    = EXCLUDED.quality_score,
      delivery_score   = EXCLUDED.delivery_score,
      cost_score       = EXCLUDED.cost_score,
      support_score    = EXCLUDED.support_score,
      compliance_score = EXCLUDED.compliance_score,
      financial_score  = EXCLUDED.financial_score,
      dependency_score = EXCLUDED.dependency_score,
      risk_score       = EXCLUDED.risk_score,
      otd_pct          = EXCLUDED.otd_pct,
      otd_basis             = EXCLUDED.otd_basis,
      promised_coverage_pct = EXCLUDED.promised_coverage_pct,
      pass_rate_pct    = EXCLUDED.pass_rate_pct,
      open_ncr_count   = EXCLUDED.open_ncr_count,
      capa_closure_pct = EXCLUDED.capa_closure_pct,
      fill_rate_pct               = EXCLUDED.fill_rate_pct,
      lead_time_adherence_pct     = EXCLUDED.lead_time_adherence_pct,
      avg_lead_time_variance_days = EXCLUDED.avg_lead_time_variance_days,
      ppv_pct                     = EXCLUDED.ppv_pct,
      response_days               = EXCLUDED.response_days,
      response_source             = EXCLUDED.response_source,
      calculated_at    = NOW(),
      updated_at       = NOW()
  `, [
    companyId, vendorId,
    result.health_score, result.health_status,
    result.quality_score, result.delivery_score,
    result.cost_score, result.support_score,
    result.compliance_score, result.financial_score,
    result.dependency_score, result.risk_score,
    // NULL, not the engine's neutral prior: otd_pct and pass_rate_pct are read
    // back as this supplier's measured record by the heatmap, the CEO roll-up
    // and vendors.on_time_pct. Storing the 75 default made "nothing has ever
    // been received from this vendor" indistinguishable from "three deliveries
    // in four arrived on time".
    // ⚠ Gated on the BASIS too, identically to vendors.on_time_pct below.
    // Leaving this ungated split the truth in two: the vendor master said "no
    // measured on-time rate" while this row, which the heatmap and the CEO
    // roll-up actually read, still said 100% — off a due date we derived from
    // our own lead-time master data. The basis travels with the number so a
    // reader can qualify it instead of having to infer it.
    result.detail.delivery.otdMeasured
      && ['promised', 'mixed'].includes(result.detail.delivery.otdBasis)
      ? result.detail.delivery.otdPct : null,
    result.detail.delivery.otdBasis,
    result.detail.delivery.promisedCoveragePct,
    result.detail.quality.passRateMeasured ? result.detail.quality.passRate : null,
    result.detail.quality.openNCR || 0,
    result.detail.quality.capaMeasured    ? result.detail.quality.capaClosurePct : null,
    result.coverage_pct,
    // Unmeasured is NULL for every one of these, never 0. The scorers already
    // return null rather than a default, so this is a pass-through — but the
    // measured flags are asserted here too, because a scorer that regresses to
    // emitting a default would otherwise publish it as this supplier's record.
    result.detail.delivery.fillRateMeasured ? result.detail.delivery.fillRatePct : null,
    result.detail.delivery.leadTimeMeasured ? result.detail.delivery.leadTimeAdherencePct : null,
    result.detail.delivery.leadTimeMeasured ? result.detail.delivery.avgLeadTimeVarianceDays : null,
    result.detail.cost.ppvMeasured          ? result.detail.cost.ppvPct : null,
    result.detail.support.source === 'measured'
      ? (result.detail.support.ncrResponseDays ?? result.detail.support.quoteTurnaroundDays)
      : null,
    result.detail.support.source,
  ]);

  // ── Sync monthly timeline snapshot ────────────────────────────────────────────
  const snapshotMonth = new Date();
  snapshotMonth.setDate(1);
  await q(`
    INSERT INTO vendor_health_timeline
      (company_id, vendor_id, snapshot_month, health_score, health_status,
       quality_score, delivery_score, cost_score, compliance_score, coverage_pct)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (company_id, vendor_id, snapshot_month) DO UPDATE SET
      health_score    = EXCLUDED.health_score,
      health_status   = EXCLUDED.health_status,
      quality_score   = EXCLUDED.quality_score,
      delivery_score  = EXCLUDED.delivery_score,
      cost_score      = EXCLUDED.cost_score,
      compliance_score = EXCLUDED.compliance_score,
      coverage_pct    = EXCLUDED.coverage_pct
  `, [
    companyId, vendorId,
    snapshotMonth.toISOString().slice(0, 7) + '-01',
    result.health_score, result.health_status,
    result.quality_score, result.delivery_score,
    result.cost_score, result.compliance_score,
    result.coverage_pct,
  ]);

  // ── Upsert early warnings ─────────────────────────────────────────────────────
  // The stand-down is UNCONDITIONAL. It used to sit inside `if (warnings.length
  // > 0)`, so a vendor whose last warning cleared never had it retired -- the
  // recalculation that proved the problem was fixed was exactly the run that
  // skipped the cleanup, and the warning stayed on the dashboard forever.
  await q(`UPDATE vendor_early_warnings SET is_active = FALSE, updated_at = NOW()
           WHERE vendor_id = $1 AND company_id = $2 AND is_active = TRUE`,
    [vendorId, companyId]);

  for (const w of warnings) {
    await q(`
      INSERT INTO vendor_early_warnings
        (company_id, vendor_id, warning_type, severity, message, metric_value, threshold_value, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
    `, [companyId, vendorId, w.warning_type, w.severity, w.message,
        w.metric_value, w.threshold_value]);
  }

  // ── Sync classification + headline KPIs back to vendors table ────────────────
  // vendors.on_time_pct and vendors.defect_rate are read by VendorManagement's
  // composite score (on_time 20%, defect 10%) and by the vendor list, but
  // nothing ever wrote them -- every vendor carried 0.0 for both, so the master
  // grid scored every supplier 30 points below its own scorecard. This is the
  // only place in the app that derives them from GRN data, so it is the place
  // that has to publish them.
  //
  // UNMEASURED IS NOT ZERO -- and it is not 75% either. scoreDelivery() falls
  // back to an otdPct of 75 when a vendor has no GRNs at all, which is a
  // reasonable neutral prior *inside* the composite but a fabrication the
  // moment it is published on the vendor master as that supplier's on-time
  // rate. Both KPIs are written only where there is evidence behind them and
  // NULLed otherwise, so "never received from" is distinguishable from "always
  // late".
  //
  // ⚠ AND IT IS NOT AN OTD AGAINST A DATE WE INVENTED. otdMeasured only says
  // receipts exist; otdBasis says what they were judged against. When no order
  // behind them carried a committed due date, every "due" date is
  // order_date + vendors.lead_time_days — master data a buyer typed about the
  // supplier, not a promise the supplier made. Published on the vendor master as
  // that supplier's on-time rate it is the same class of fabrication as the 75
  // prior, just better disguised: a generous lead time reads as a supplier that
  // never misses. 'mixed' still publishes — part of it is real, and
  // promisedCoveragePct on the scorecard detail says how much.
  const otdPct = result.detail.delivery.otdMeasured
    && ['promised', 'mixed'].includes(result.detail.delivery.otdBasis)
    ? result.detail.delivery.otdPct : null;
  const defectRatePct = totalReceivedQty > 0
    ? parseFloat(((totalRejectedQty / totalReceivedQty) * 100).toFixed(2))
    : null;
  await q(`UPDATE vendors
              SET classification = $1,
                  on_time_pct    = $2,
                  defect_rate    = $3,
                  updated_at     = NOW()
            WHERE id = $4`,
    [result.health_status, otdPct, defectRatePct, vendorId]);

  return {
    vendor_id:   vendorId,
    vendor_name: vendor.vendor_name,
    ...result,
    warnings,
    project_impact: {
      project_count:       Number(projectStats?.project_count || 0),
      total_project_value: parseFloat(projectStats?.total_project_value || 0),
    },
    strategic_flags: flags || {},
  };
}

// ── 49G-20  PROCUREMENT DASHBOARD ────────────────────────────────────────────────
async function getDashboard(companyId) {
  const [
    { rows: summary },
    { rows: distribution },
    { rows: topRisk },
    { rows: recentChanges },
  ] = await Promise.all([
    // 'Unrated' suppliers are counted but kept out of avg_score: their composite
    // is built from dimension defaults, so averaging them in drags the company's
    // headline index toward a number nobody's performance produced.
    q(`SELECT
         COUNT(*) FILTER (WHERE health_status = 'Preferred')  AS preferred,
         COUNT(*) FILTER (WHERE health_status = 'Approved')   AS approved,
         COUNT(*) FILTER (WHERE health_status = 'Watchlist')  AS watchlist,
         COUNT(*) FILTER (WHERE health_status = 'Critical')   AS critical,
         COUNT(*) FILTER (WHERE health_status = 'Unrated')    AS unrated,
         COUNT(*)                                              AS total,
         ROUND(AVG(health_score) FILTER (WHERE health_status <> 'Unrated')::numeric, 1) AS avg_score
       FROM vendor_health_scores WHERE company_id = $1`, [companyId]),

    q(`SELECT health_status AS name, COUNT(*) AS value
       FROM vendor_health_scores WHERE company_id = $1
       GROUP BY health_status ORDER BY value DESC`, [companyId]),

    q(`SELECT vhs.vendor_id, v.vendor_name, vhs.health_score, vhs.health_status,
              vhs.quality_score, vhs.delivery_score, vhs.risk_score,
              vhs.open_ncr_count, vhs.otd_pct, vhs.calculated_at
       FROM vendor_health_scores vhs
       JOIN vendors v ON v.id = vhs.vendor_id
       WHERE vhs.company_id = $1
       ORDER BY vhs.health_score ASC LIMIT 10`, [companyId]),

    q(`SELECT vhs.vendor_id, v.vendor_name, vhs.health_score, vhs.health_status,
              vhs.calculated_at
       FROM vendor_health_scores vhs
       JOIN vendors v ON v.id = vhs.vendor_id
       WHERE vhs.company_id = $1
       ORDER BY vhs.updated_at DESC LIMIT 5`, [companyId]),
  ]);

  const s = summary[0] || {};

  return {
    cards: {
      preferred:  Number(s.preferred || 0),
      approved:   Number(s.approved  || 0),
      watchlist:  Number(s.watchlist || 0),
      critical:   Number(s.critical  || 0),
      unrated:    Number(s.unrated   || 0),
      total:      Number(s.total     || 0),
      // null, not 0, when every supplier is Unrated -- an index of zero would be
      // a claim about performance that no data supports.
      avg_score:  s.avg_score == null ? null : parseFloat(s.avg_score),
    },
    charts: {
      distribution,
      quality_trend:   [],
      delivery_trend:  [],
    },
    top_risk_vendors:   topRisk,
    recent_changes:     recentChanges,
  };
}

// ── 49G-13  SUPPLIER RISK HEATMAP ────────────────────────────────────────────────
async function getHeatmap(companyId) {
  const { rows } = await q(`
    SELECT
      vhs.vendor_id,
      v.vendor_name,
      v.vendor_category,
      vhs.health_score,
      vhs.health_status,
      vhs.quality_score,
      vhs.delivery_score,
      vhs.compliance_score,
      vhs.financial_score,
      vhs.dependency_score,
      vhs.risk_score,
      vhs.open_ncr_count,
      vhs.otd_pct,
      vhs.coverage_pct,
      vhs.calculated_at,
      COALESCE(pv.project_count, 0)        AS projects_impacted,
      COALESCE(pv.total_project_value, 0)  AS revenue_at_risk,
      v.is_single_source,
      v.is_critical_supplier,
      v.is_long_lead
    FROM vendor_health_scores vhs
    JOIN vendors v ON v.id = vhs.vendor_id AND v.deleted_at IS NULL
    LEFT JOIN (
      SELECT po2.supplier_id AS vendor_id,
             COUNT(DISTINCT p.id) AS project_count,
             COALESCE(SUM(p.budget_amount), 0) AS total_project_value
      FROM purchase_orders po2
      JOIN projects p ON p.id::text = po2.project_id::text AND p.deleted_at IS NULL
      WHERE p.company_id = $1
        AND po2.deleted_at IS NULL
        AND p.status NOT IN ('Completed', 'Cancelled')
      GROUP BY po2.supplier_id
    ) pv ON pv.vendor_id::text = vhs.vendor_id::text
    WHERE vhs.company_id = $1
    ORDER BY vhs.health_score ASC, pv.total_project_value DESC NULLS LAST
    LIMIT 100
  `, [companyId]).catch(async () => {
    // project_vendors may not exist yet — fallback
    const { rows: r } = await q(`
      SELECT vhs.vendor_id, v.vendor_name, v.vendor_category,
             vhs.health_score, vhs.health_status, vhs.quality_score,
             vhs.delivery_score, vhs.compliance_score, vhs.financial_score,
             vhs.dependency_score, vhs.risk_score, vhs.open_ncr_count,
             vhs.otd_pct, vhs.calculated_at,
             0 AS projects_impacted, 0 AS revenue_at_risk,
             v.is_single_source, v.is_critical_supplier, v.is_long_lead
        FROM vendor_health_scores vhs
        JOIN vendors v ON v.id = vhs.vendor_id AND v.deleted_at IS NULL
       WHERE vhs.company_id = $1
       ORDER BY vhs.health_score ASC LIMIT 100
    `, [companyId]);
    return { rows: r };
  });

  return rows;
}

// ── 49G-17  DELIVERY TREND ENGINE ────────────────────────────────────────────────
async function getHealthTrend(vendorId, companyId) {
  const { rows } = await q(`
    SELECT
      TO_CHAR(snapshot_month, 'Mon YY')  AS month_label,
      snapshot_month,
      health_score,
      health_status,
      quality_score,
      delivery_score,
      cost_score,
      compliance_score
    FROM vendor_health_timeline
    WHERE vendor_id = $1 AND company_id = $2
    ORDER BY snapshot_month DESC LIMIT 12
  `, [vendorId, companyId]);

  return rows.reverse(); // oldest → newest for chart display
}

// ── 49G-14  EARLY WARNING SYSTEM ─────────────────────────────────────────────────
async function getEarlyWarnings(companyId) {
  const { rows } = await q(`
    SELECT
      vew.*,
      v.vendor_name,
      v.vendor_category,
      vhs.health_score,
      vhs.health_status
    FROM vendor_early_warnings vew
    JOIN vendors v ON v.id = vew.vendor_id
    LEFT JOIN vendor_health_scores vhs
      ON vhs.vendor_id = vew.vendor_id AND vhs.company_id = vew.company_id
    WHERE vew.company_id = $1 AND vew.is_active = TRUE
    ORDER BY
      CASE vew.severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END,
      vew.created_at DESC
    LIMIT 100
  `, [companyId]);

  return rows;
}

// ── 49G-23  CEO COMMAND CENTER ────────────────────────────────────────────────────
async function getCEOCommandCenter(companyId) {
  const [
    { rows: topSpend },
    { rows: topRisk },
    { rows: mostReliable },
    { rows: mostNCR },
    { rows: mostDelayed },
    { rows: summary },
  ] = await Promise.all([
    // Highest spend suppliers (from POs)
    // supplier_id is integer, not text — the old `v.id::text` cast made this throw
    // (operator does not exist: integer = text), silently swallowed by .catch() below.
    q(`SELECT v.id, v.vendor_name, v.vendor_category,
              COALESCE(SUM(po.total_amount), 0) AS total_spend,
              vhs.health_score, vhs.health_status
       FROM vendors v
       LEFT JOIN purchase_orders po ON po.supplier_id = v.id AND po.company_id = $1
       LEFT JOIN vendor_health_scores vhs ON vhs.vendor_id = v.id AND vhs.company_id = $1
       WHERE v.company_id = $1 AND v.deleted_at IS NULL
       GROUP BY v.id, v.vendor_name, v.vendor_category, vhs.health_score, vhs.health_status
       ORDER BY total_spend DESC LIMIT 10`, [companyId])
      .catch((err) => { console.error(`[vendorHealth] top-suppliers panel failed (${err.code || 'no code'}): ${err.message}`); return { rows: [] }; }),

    // Highest risk suppliers
    q(`SELECT vhs.vendor_id, v.vendor_name, v.vendor_category,
              vhs.health_score, vhs.health_status, vhs.quality_score,
              vhs.delivery_score, vhs.risk_score, vhs.open_ncr_count, vhs.otd_pct
       FROM vendor_health_scores vhs
       JOIN vendors v ON v.id = vhs.vendor_id AND v.deleted_at IS NULL
       WHERE vhs.company_id = $1
       ORDER BY vhs.health_score ASC LIMIT 10`, [companyId]),

    // Most reliable suppliers
    q(`SELECT vhs.vendor_id, v.vendor_name, v.vendor_category,
              vhs.health_score, vhs.health_status, vhs.otd_pct,
              vhs.quality_score, vhs.delivery_score
       FROM vendor_health_scores vhs
       JOIN vendors v ON v.id = vhs.vendor_id AND v.deleted_at IS NULL
       WHERE vhs.company_id = $1 AND vhs.health_status IN ('Preferred', 'Approved')
       ORDER BY vhs.health_score DESC LIMIT 10`, [companyId]),

    // Most NCRs
    q(`SELECT v.id, v.vendor_name, v.vendor_category,
              COUNT(ncr.id) AS ncr_count,
              COUNT(ncr.id) FILTER (WHERE LOWER(ncr.status) <> 'closed')      AS open_ncr,
              COUNT(ncr.id) FILTER (WHERE LOWER(ncr.severity) = 'critical')   AS critical_ncr,
              vhs.health_score, vhs.health_status
       FROM vendors v
       JOIN ncr_reports ncr ON ncr.vendor_id = v.id AND ncr.company_id = $1
       LEFT JOIN vendor_health_scores vhs ON vhs.vendor_id = v.id AND vhs.company_id = $1
       WHERE v.company_id = $1
       GROUP BY v.id, v.vendor_name, v.vendor_category, vhs.health_score, vhs.health_status
       ORDER BY ncr_count DESC LIMIT 10`, [companyId]),

    // Most delayed — goods_receipt_notes has no vendor_id/expected_delivery_date; bridge
    // through purchase_orders same as computeAndSave's grnStats query above.
    q(`SELECT v.id AS vendor_id, v.vendor_name, v.vendor_category,
              COUNT(grn.id) FILTER (
                WHERE grn.received_date > COALESCE(po.expected_delivery_date,
                      po.order_date + (v.lead_time_days || ' days')::interval)::date
              ) AS delayed_count,
              COUNT(grn.id) AS total_grns,
              vhs.health_score, vhs.health_status, vhs.otd_pct
       FROM vendors v
       JOIN purchase_orders po ON po.supplier_id = v.id AND po.company_id = $1
       JOIN goods_receipt_notes grn ON grn.po_id = po.id AND grn.company_id = $1 AND grn.deleted_at IS NULL
       LEFT JOIN vendor_health_scores vhs ON vhs.vendor_id = v.id AND vhs.company_id = $1
       WHERE v.company_id = $1
       GROUP BY v.id, v.vendor_name, v.vendor_category, vhs.health_score, vhs.health_status, vhs.otd_pct
       ORDER BY delayed_count DESC LIMIT 10`, [companyId])
      .catch((err) => { console.error(`[vendorHealth] delayed-suppliers panel failed (${err.code || 'no code'}): ${err.message}`); return { rows: [] }; }),

    q(`SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE health_status = 'Preferred') AS preferred,
         COUNT(*) FILTER (WHERE health_status = 'Approved')  AS approved,
         COUNT(*) FILTER (WHERE health_status = 'Watchlist') AS watchlist,
         COUNT(*) FILTER (WHERE health_status = 'Critical')  AS critical,
         COUNT(*) FILTER (WHERE health_status = 'Unrated')   AS unrated,
         -- Same reason as getDashboard: an Unrated supplier's dimension scores
         -- are engine defaults, so they must not move the company averages.
         ROUND(AVG(health_score)     FILTER (WHERE health_status <> 'Unrated')::numeric, 1) AS avg_score,
         ROUND(AVG(quality_score)    FILTER (WHERE health_status <> 'Unrated')::numeric, 1) AS avg_quality,
         ROUND(AVG(delivery_score)   FILTER (WHERE health_status <> 'Unrated')::numeric, 1) AS avg_delivery,
         ROUND(AVG(compliance_score) FILTER (WHERE health_status <> 'Unrated')::numeric, 1) AS avg_compliance
       FROM vendor_health_scores WHERE company_id = $1`, [companyId]),
  ]);

  return {
    summary:      summary[0] || {},
    top_spend:    topSpend,
    top_risk:     topRisk,
    most_reliable: mostReliable,
    most_ncr:     mostNCR,
    most_delayed: mostDelayed,
  };
}

// ── VENDOR DETAIL (49G-19) ────────────────────────────────────────────────────────
async function getVendorHealth(vendorId, companyId) {
  // The vendor itself is checked first. Without it this read answered 200 for a
  // vendor in another tenant — three of its four queries were scoped and looked
  // empty, but the fourth was not, so the response still carried that company's
  // strategic flags: is_critical_supplier, is_single_source, is_long_lead,
  // is_high_spend. That is a map of where a competitor's supply chain breaks.
  const { rows: [owned] } = await q(
    `SELECT id FROM vendors WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
    [vendorId, companyId]
  );
  if (!owned) throw Object.assign(new Error('Vendor not found'), { status: 404 });

  const { rows: [existing] } = await q(
    `SELECT * FROM vendor_health_scores WHERE vendor_id = $1 AND company_id = $2`,
    [vendorId, companyId]
  );

  const { rows: [flags] } = await q(
    `SELECT * FROM vendor_strategic_flags
      WHERE vendor_id = $1 AND ($2::int IS NULL OR company_id = $2)`, [vendorId, companyId]
  ).catch(() => ({ rows: [{}] }));

  const { rows: warnings } = await q(
    `SELECT * FROM vendor_early_warnings
     WHERE vendor_id = $1 AND company_id = $2 AND is_active = TRUE
     ORDER BY created_at DESC`, [vendorId, companyId]
  );

  const { rows: [projectImpact] } = await q(
    `SELECT COUNT(DISTINCT p.id) AS project_count,
            COALESCE(SUM(p.budget_amount), 0) AS total_project_value
     FROM projects p
     JOIN purchase_orders po
       ON po.project_id::text = p.id::text AND po.deleted_at IS NULL
     WHERE po.supplier_id::text = $1::text AND p.company_id = $2
       AND p.status NOT IN ('Completed', 'Cancelled')`,
    [vendorId, companyId]
  );

  return {
    health:          existing || null,
    strategic_flags: flags    || {},
    warnings,
    project_impact:  projectImpact || { project_count: 0, total_project_value: 0 },
  };
}

// ── ACKNOWLEDGE WARNING ───────────────────────────────────────────────────────────
async function acknowledgeWarning(warningId, userId, companyId) {
  const { rows: [row] } = await q(`
    UPDATE vendor_early_warnings
    SET acknowledged_by = $1, acknowledged_at = NOW(), is_active = FALSE, updated_at = NOW()
    WHERE id = $2 AND company_id = $3
    RETURNING *
  `, [userId, warningId, companyId]);
  return row;
}

export default {
  computeAndSave,
  getDashboard,
  getHeatmap,
  getHealthTrend,
  getEarlyWarnings,
  getCEOCommandCenter,
  getVendorHealth,
  acknowledgeWarning,
};
