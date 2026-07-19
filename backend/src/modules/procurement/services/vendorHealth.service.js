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

    q(`SELECT
         COUNT(*)                                                     AS total_grns,
         COUNT(*) FILTER (WHERE actual_delivery_date <= expected_delivery_date OR actual_delivery_date IS NULL) AS on_time_grns,
         COUNT(*) FILTER (WHERE actual_delivery_date > expected_delivery_date) AS delayed_grns,
         COALESCE(AVG(EXTRACT(EPOCH FROM (actual_delivery_date - expected_delivery_date)) / 86400)
           FILTER (WHERE actual_delivery_date > expected_delivery_date), 0) AS avg_delay_days,
         COUNT(*) FILTER (WHERE partial_delivery = TRUE OR received_qty < ordered_qty) AS partial_grns,
         COALESCE(SUM(received_qty), 0)   AS total_received_qty,
         COALESCE(SUM(rejected_qty), 0)   AS total_rejected_qty,
         COUNT(*) FILTER (WHERE inspection_result = 'Pass') AS passed_inspections,
         COUNT(*) FILTER (WHERE inspection_result IS NOT NULL) AS total_inspections
       FROM goods_receipt_notes WHERE vendor_id = $1::text AND company_id = $2`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    q(`SELECT
         COUNT(*)                               AS total_capas,
         COUNT(*) FILTER (WHERE status = 'Closed') AS closed_capas
       FROM vendor_capa WHERE vendor_id = $1 AND company_id = $2`,
      [vendorId, companyId]),

    q(`SELECT doc_type, expiry_date, verified, status
       FROM vendor_documents
       WHERE vendor_id = $1 AND deleted_at IS NULL`,
      [vendorId]),

    q(`SELECT
         COUNT(*)                                                          AS total_pos,
         COUNT(*) FILTER (WHERE status IN ('delayed', 'overdue'))          AS late_pos_12m,
         COALESCE(AVG(unit_price) FILTER (WHERE created_at > NOW() - INTERVAL '6 months'), 0)  AS avg_price_recent,
         COALESCE(AVG(unit_price) FILTER (WHERE created_at BETWEEN NOW() - INTERVAL '18 months' AND NOW() - INTERVAL '6 months'), 0) AS avg_price_prev,
         COUNT(*) FILTER (WHERE price_increased = TRUE)                   AS escalation_count
       FROM purchase_orders WHERE supplier_id = $1::text AND company_id = $2`,
      [vendorId, companyId]).catch(() => ({ rows: [{}] })),

    q(`SELECT
         COUNT(DISTINCT p.id) AS project_count,
         COALESCE(SUM(p.contract_value), 0) AS total_project_value
       FROM projects p
       JOIN project_vendors pv ON pv.project_id = p.id
       WHERE pv.vendor_id = $1 AND p.company_id = $2
         AND p.status NOT IN ('Completed', 'Cancelled')`,
      [vendorId, companyId]).catch(() => ({ rows: [{ project_count: 0, total_project_value: 0 }] })),

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
    },
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
       risk_score, otd_pct, pass_rate_pct, open_ncr_count, capa_closure_pct,
       calculated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
    ON CONFLICT (company_id, vendor_id) DO UPDATE SET
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
    result.detail.delivery.otdPct || 0,
    result.detail.quality.passRate || 0,
    result.detail.quality.openNCR || 0,
    result.detail.quality.capaClosurePct || 0,
  ]);

  // ── Sync monthly timeline snapshot ────────────────────────────────────────────
  const snapshotMonth = new Date();
  snapshotMonth.setDate(1);
  await q(`
    INSERT INTO vendor_health_timeline
      (company_id, vendor_id, snapshot_month, health_score, health_status,
       quality_score, delivery_score, cost_score, compliance_score)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (company_id, vendor_id, snapshot_month) DO UPDATE SET
      health_score    = EXCLUDED.health_score,
      health_status   = EXCLUDED.health_status,
      quality_score   = EXCLUDED.quality_score,
      delivery_score  = EXCLUDED.delivery_score,
      cost_score      = EXCLUDED.cost_score,
      compliance_score = EXCLUDED.compliance_score
  `, [
    companyId, vendorId,
    snapshotMonth.toISOString().slice(0, 7) + '-01',
    result.health_score, result.health_status,
    result.quality_score, result.delivery_score,
    result.cost_score, result.compliance_score,
  ]);

  // ── Upsert early warnings ─────────────────────────────────────────────────────
  if (warnings.length > 0) {
    // Clear old active warnings for this vendor first
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
  }

  // ── Sync classification back to vendors table ─────────────────────────────────
  await q(`UPDATE vendors SET classification = $1, updated_at = NOW() WHERE id = $2`,
    [result.health_status, vendorId]);

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
    q(`SELECT
         COUNT(*) FILTER (WHERE health_status = 'Preferred')  AS preferred,
         COUNT(*) FILTER (WHERE health_status = 'Approved')   AS approved,
         COUNT(*) FILTER (WHERE health_status = 'Watchlist')  AS watchlist,
         COUNT(*) FILTER (WHERE health_status = 'Critical')   AS critical,
         COUNT(*)                                              AS total,
         ROUND(AVG(health_score)::numeric, 1)                 AS avg_score
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
      total:      Number(s.total     || 0),
      avg_score:  parseFloat(s.avg_score || 0),
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
      vhs.calculated_at,
      COALESCE(pv.project_count, 0)        AS projects_impacted,
      COALESCE(pv.total_project_value, 0)  AS revenue_at_risk,
      v.is_single_source,
      v.is_critical_supplier,
      v.is_long_lead
    FROM vendor_health_scores vhs
    JOIN vendors v ON v.id = vhs.vendor_id AND v.deleted_at IS NULL
    LEFT JOIN (
      SELECT pv2.vendor_id,
             COUNT(DISTINCT pv2.project_id) AS project_count,
             COALESCE(SUM(p.contract_value), 0) AS total_project_value
      FROM project_vendors pv2
      JOIN projects p ON p.id = pv2.project_id
      WHERE p.company_id = $1
        AND p.status NOT IN ('Completed', 'Cancelled')
      GROUP BY pv2.vendor_id
    ) pv ON pv.vendor_id = vhs.vendor_id
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
    q(`SELECT v.id, v.vendor_name, v.vendor_category,
              COALESCE(SUM(po.total_amount), 0) AS total_spend,
              vhs.health_score, vhs.health_status
       FROM vendors v
       LEFT JOIN purchase_orders po ON po.supplier_id = v.id::text AND po.company_id = $1
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

    // Most delayed
    q(`SELECT v.id AS vendor_id, v.vendor_name, v.vendor_category,
              COUNT(grn.id) FILTER (WHERE grn.actual_delivery_date > grn.expected_delivery_date) AS delayed_count,
              COUNT(grn.id) AS total_grns,
              vhs.health_score, vhs.health_status, vhs.otd_pct
       FROM vendors v
       JOIN goods_receipt_notes grn ON grn.vendor_id = v.id::text AND grn.company_id = $1
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
         ROUND(AVG(health_score)::numeric, 1)                AS avg_score,
         ROUND(AVG(quality_score)::numeric, 1)               AS avg_quality,
         ROUND(AVG(delivery_score)::numeric, 1)              AS avg_delivery,
         ROUND(AVG(compliance_score)::numeric, 1)            AS avg_compliance
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
    `SELECT COUNT(DISTINCT pv.project_id) AS project_count,
            COALESCE(SUM(p.contract_value), 0) AS total_project_value
     FROM project_vendors pv
     JOIN projects p ON p.id = pv.project_id
     WHERE pv.vendor_id = $1 AND p.company_id = $2
       AND p.status NOT IN ('Completed', 'Cancelled')`,
    [vendorId, companyId]
  ).catch(() => ({ rows: [{ project_count: 0, total_project_value: 0 }] }));

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
