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
  ] = await Promise.all([
    q(`SELECT * FROM vendors WHERE id = $1`, [vendorId]),

    q(`SELECT * FROM vendor_scorecards
       WHERE vendor_id = $1
       ORDER BY period_year DESC, period_quarter DESC LIMIT 1`, [vendorId]),

    q(`SELECT
         COUNT(*)                                        AS total_ncr,
         COUNT(*) FILTER (WHERE status = 'Open')        AS open_ncr,
         COUNT(*) FILTER (WHERE severity = 'Critical')  AS critical_ncr,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '12 months' AND severity = 'Critical') AS critical_ncr_12m,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '12 months' AND ncr_date IS NOT NULL AND ncr_date = ncr_date) AS repeat_ncr
       FROM vendor_ncr WHERE vendor_id = $1 AND company_id = $2`,
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
                         po.order_date + (v.lead_time_days || ' days')::interval)::date AS implied_expected
         FROM goods_receipt_notes grn
         JOIN purchase_orders po ON po.id = grn.po_id
         JOIN vendors v ON v.id = po.supplier_id
         WHERE po.supplier_id = $1 AND grn.company_id = $2 AND grn.deleted_at IS NULL
       )
       SELECT
         COUNT(*)                                                          AS total_grns,
         COUNT(*) FILTER (WHERE received_date <= implied_expected)         AS on_time_grns,
         COUNT(*) FILTER (WHERE received_date > implied_expected)          AS delayed_grns,
         COALESCE(AVG(received_date - implied_expected)
           FILTER (WHERE received_date > implied_expected), 0)             AS avg_delay_days,
         COUNT(*) FILTER (WHERE po_status = 'partial')                     AS partial_grns,
         COALESCE((SELECT SUM(gi.quantity_received) FROM grn_items gi JOIN g ON g.id = gi.grn_id), 0) AS total_received_qty,
         COALESCE((SELECT SUM(gi.quantity_rejected) FROM grn_items gi JOIN g ON g.id = gi.grn_id), 0) AS total_rejected_qty,
         COUNT(*) FILTER (WHERE quality_status = 'passed')                 AS passed_inspections,
         COUNT(*) FILTER (WHERE quality_status IN ('passed', 'failed'))    AS total_inspections
       FROM g`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    q(`SELECT
         COUNT(*)                               AS total_capas,
         COUNT(*) FILTER (WHERE status = 'Closed') AS closed_capas
       FROM vendor_capa WHERE vendor_id = $1 AND company_id = $2`,
      [vendorId, companyId]),

    // vendor_documents has no deleted_at column (soft-delete isn't modeled here — rows are
    // real or absent) — this filter always threw, with no .catch() guard, so computeAndSave
    // never completed a single run regardless of the GRN/PO fixes above.
    q(`SELECT doc_type, expiry_date, verified, status
       FROM vendor_documents
       WHERE vendor_id = $1`,
      [vendorId]),

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

    q(`SELECT * FROM vendor_strategic_flags WHERE vendor_id = $1`, [vendorId])
      .catch(() => ({ rows: [{}] })),
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
    },
    costInputs: {
      priceVariancePct, rfqCompetitive: priceVariancePct <= 10,
      escalationCount, last12mPOCount: totalPOs || 1,
      // Both windows have to have priced lines, otherwise priceVariancePct is 0
      // by fallback and scoreCost would read that as "perfectly stable".
      hasPriceHistory: avgPriceRecent > 0 && avgPricePrev > 0,
    },
    supportInputs: {
      storedSupportScore: scorecard?.support_score || null,
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
       risk_score, otd_pct, pass_rate_pct, open_ncr_count, capa_closure_pct, coverage_pct,
       calculated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
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
      pass_rate_pct    = EXCLUDED.pass_rate_pct,
      open_ncr_count   = EXCLUDED.open_ncr_count,
      capa_closure_pct = EXCLUDED.capa_closure_pct,
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
    result.detail.delivery.otdMeasured    ? result.detail.delivery.otdPct : null,
    result.detail.quality.passRateMeasured ? result.detail.quality.passRate : null,
    result.detail.quality.openNCR || 0,
    result.detail.quality.capaMeasured    ? result.detail.quality.capaClosurePct : null,
    result.coverage_pct,
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
  const otdPct = result.detail.delivery.otdMeasured ? result.detail.delivery.otdPct : null;
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
      .catch(() => ({ rows: [] })),

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
              COUNT(ncr.id) FILTER (WHERE ncr.status = 'Open')    AS open_ncr,
              COUNT(ncr.id) FILTER (WHERE ncr.severity = 'Critical') AS critical_ncr,
              vhs.health_score, vhs.health_status
       FROM vendors v
       JOIN vendor_ncr ncr ON ncr.vendor_id = v.id AND ncr.company_id = $1
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
      .catch(() => ({ rows: [] })),

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
  const { rows: [existing] } = await q(
    `SELECT * FROM vendor_health_scores WHERE vendor_id = $1 AND company_id = $2`,
    [vendorId, companyId]
  );

  const { rows: [flags] } = await q(
    `SELECT * FROM vendor_strategic_flags WHERE vendor_id = $1`, [vendorId]
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
