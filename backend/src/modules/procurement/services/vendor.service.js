/**
 * Phase 49C — Vendor Service + Risk Engine (49C-14)
 *
 * Risk dimensions:
 *   Financial Risk    — turnover < threshold, missing bank verification
 *   Quality Risk      — NCR count, low quality scorecard
 *   Delivery Risk     — late delivery rate, no ISO
 *   Compliance Risk   — missing GSTIN/PAN, expired docs
 *   Dependency Risk   — single-source status, spend concentration
 *
 * Overall score 0–100: Low < 30, Medium 30–60, High 60–80, Critical > 80
 */
import pool from '../../../config/db.js';
import vendorRepo from '../repositories/vendor.repository.js';

const WEIGHTS = {
  financial:   0.25,
  quality:     0.25,
  delivery:    0.20,
  compliance:  0.20,
  dependency:  0.10,
};

class VendorService {

  // ─── RISK ENGINE ──────────────────────────────────────────────────────────

  async computeRisk(vendorId, companyId) {
    const [
      { rows: [vendor] },
      { rows: [scorecard] },
      { rows: [ncrStats] },
      { rows: [poStats] },
      { rows: docs },
    ] = await Promise.all([
      pool.query(`SELECT * FROM vendors WHERE id=$1`, [vendorId]),
      pool.query(`SELECT * FROM vendor_scorecards WHERE vendor_id=$1 ORDER BY period_year DESC, period_quarter DESC LIMIT 1`, [vendorId]),
      pool.query(`
        SELECT
          COUNT(*) AS total_ncr,
          COUNT(*) FILTER (WHERE ncr_date > NOW() - INTERVAL '12 months') AS ncr_12m,
          COUNT(*) FILTER (WHERE status='Open') AS open_ncr
        FROM vendor_ncr WHERE vendor_id=$1
      `, [vendorId]),
      pool.query(`
        SELECT
          COUNT(*) AS total_pos,
          COUNT(*) FILTER (WHERE status IN ('delayed','overdue')) AS late_pos
        FROM purchase_orders WHERE supplier_id=$1::text
      `, [vendorId]).catch(() => ({ rows: [{ total_pos: 0, late_pos: 0 }] })),
      pool.query(`SELECT doc_type, expiry_date, verified FROM vendor_documents WHERE vendor_id=$1`, [vendorId]),
    ]);

    if (!vendor) throw new Error('Vendor not found');

    // 1. Financial Risk (0–100)
    let financialRisk = 0;
    if (!vendor.gstin)          financialRisk += 20;
    if (!vendor.pan)            financialRisk += 15;
    if (!vendor.annual_turnover) financialRisk += 20;
    if (Number(vendor.annual_turnover || 0) < 1_000_000) financialRisk += 15; // < 10L
    const bankDocs = docs.filter(d => d.doc_type === 'Cancelled Cheque');
    if (!bankDocs.length || !bankDocs[0]?.verified) financialRisk += 30;
    financialRisk = Math.min(financialRisk, 100);

    // 2. Quality Risk (0–100)
    let qualityRisk = 0;
    const ncrCount12m = Number(ncrStats.ncr_12m || 0);
    qualityRisk += Math.min(ncrCount12m * 15, 60);
    if (Number(ncrStats.open_ncr || 0) > 0) qualityRisk += 20;
    const qualScore = Number(scorecard?.quality_score || 0);
    if (qualScore > 0) qualityRisk += Math.max(0, (80 - qualScore));
    const hasISO = docs.some(d => d.doc_type?.includes('ISO'));
    if (!hasISO) qualityRisk += 20;
    qualityRisk = Math.min(qualityRisk, 100);

    // 3. Delivery Risk (0–100)
    let deliveryRisk = 0;
    const totalPOs = Number(poStats.total_pos || 0);
    const latePOs  = Number(poStats.late_pos || 0);
    const latePct  = totalPOs > 0 ? (latePOs / totalPOs) * 100 : 0;
    deliveryRisk += Math.min(latePct * 1.5, 60);
    const delScore = Number(scorecard?.delivery_score || 0);
    if (delScore > 0) deliveryRisk += Math.max(0, (80 - delScore) * 0.5);
    if (!vendor.year_established) deliveryRisk += 10;
    deliveryRisk = Math.min(deliveryRisk, 100);

    // 4. Compliance Risk (0–100)
    let complianceRisk = 0;
    const criticalDocs = ['GST Certificate', 'PAN', 'Bank Proof'];
    for (const dt of criticalDocs) {
      const doc = docs.find(d => d.doc_type === dt);
      if (!doc) complianceRisk += 15;
      else if (!doc.verified) complianceRisk += 8;
      else if (doc.expiry_date && new Date(doc.expiry_date) < new Date()) complianceRisk += 12;
    }
    if (!vendor.msme_status && !vendor.udyam_number) complianceRisk += 5;
    complianceRisk = Math.min(complianceRisk, 100);

    // 5. Dependency Risk (0–100)
    let dependencyRisk = 0;
    if (vendor.is_single_source) dependencyRisk += 50;
    if (vendor.is_long_lead)     dependencyRisk += 30;
    if (vendor.is_critical_supplier) dependencyRisk += 20;
    dependencyRisk = Math.min(dependencyRisk, 100);

    // Weighted overall
    const overallRisk = (
      financialRisk   * WEIGHTS.financial  +
      qualityRisk     * WEIGHTS.quality    +
      deliveryRisk    * WEIGHTS.delivery   +
      complianceRisk  * WEIGHTS.compliance +
      dependencyRisk  * WEIGHTS.dependency
    );

    const rating =
      overallRisk >= 70 ? 'Critical' :
      overallRisk >= 50 ? 'High'     :
      overallRisk >= 30 ? 'Medium'   : 'Low';

    return {
      vendor_id:         vendorId,
      financial_risk:    parseFloat(financialRisk.toFixed(2)),
      quality_risk:      parseFloat(qualityRisk.toFixed(2)),
      delivery_risk:     parseFloat(deliveryRisk.toFixed(2)),
      compliance_risk:   parseFloat(complianceRisk.toFixed(2)),
      dependency_risk:   parseFloat(dependencyRisk.toFixed(2)),
      overall_risk_score: parseFloat(overallRisk.toFixed(2)),
      risk_rating:       rating,
      ncr_count_12m:     ncrCount12m,
      late_delivery_pct: parseFloat(latePct.toFixed(2)),
      breakdown: { financialRisk, qualityRisk, deliveryRisk, complianceRisk, dependencyRisk },
    };
  }

  // ─── INITIAL RISK (for newly approved vendors) ────────────────────────────

  computeInitialRisk(regData) {
    let score = 0;
    if (!regData.gstin) score += 15;
    if (!regData.pan)   score += 15;
    if (!regData.annual_turnover) score += 10;
    if (!regData.msme_status && !regData.udyam_number) score += 5;
    if (!regData.iso_certificates) score += 15;
    if (!regData.num_employees) score += 5;
    return Math.min(score, 100);
  }

  // ─── SCORECARD COMPUTE ────────────────────────────────────────────────────

  computeScorecard({ quality_score, delivery_score, cost_score, support_score, compliance_score, documentation_score }) {
    const scores = [quality_score, delivery_score, cost_score, support_score, compliance_score, documentation_score].map(Number);
    const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
    const classification =
      overall >= 85 ? 'Preferred' :
      overall >= 65 ? 'Approved'  :
      overall >= 40 ? 'Watchlist' : 'Blocked';
    return { overall: parseFloat(overall.toFixed(2)), classification };
  }

  // ─── DUPLICATE DETECTION (49C-23) ────────────────────────────────────────

  async detectDuplicates({ gstin, pan, vendor_name, excludeId }) {
    const results = [];
    const queries = [];

    if (gstin) queries.push(
      pool.query(`SELECT id, vendor_name, 'GSTIN' AS match_field FROM vendors WHERE gstin=$1 ${excludeId ? 'AND id<>$2' : ''} AND deleted_at IS NULL LIMIT 1`,
        excludeId ? [gstin, excludeId] : [gstin])
    );
    if (pan) queries.push(
      pool.query(`SELECT id, vendor_name, 'PAN' AS match_field FROM vendors WHERE pan=$1 ${excludeId ? 'AND id<>$2' : ''} AND deleted_at IS NULL LIMIT 1`,
        excludeId ? [pan, excludeId] : [pan])
    );
    if (vendor_name) queries.push(
      pool.query(`SELECT id, vendor_name, 'Name' AS match_field FROM vendors WHERE LOWER(vendor_name)=LOWER($1) ${excludeId ? 'AND id<>$2' : ''} AND deleted_at IS NULL LIMIT 1`,
        excludeId ? [vendor_name, excludeId] : [vendor_name])
    );

    const resolved = await Promise.allSettled(queries);
    for (const r of resolved) {
      if (r.status === 'fulfilled' && r.value.rows[0]) {
        results.push(r.value.rows[0]);
      }
    }
    return results;
  }

  // ─── CLASSIFICATION UPDATE ────────────────────────────────────────────────

  async updateClassification(vendorId, overall_score) {
    const classification =
      overall_score >= 85 ? 'Preferred' :
      overall_score >= 65 ? 'Approved'  :
      overall_score >= 40 ? 'Watchlist' : 'Blocked';

    await pool.query(
      `UPDATE vendors SET classification=$1, updated_at=NOW() WHERE id=$2`,
      [classification, vendorId]
    );
    return classification;
  }

  // ─── GOOGLE DRIVE FOLDER STRUCTURE (49C-8) ───────────────────────────────

  buildFolderStructure(vendorName) {
    return {
      name: `Vendors/${vendorName}`,
      subfolders: [
        { id: '01', name: '01 Registration' },
        { id: '02', name: '02 GST' },
        { id: '03', name: '03 PAN' },
        { id: '04', name: '04 Bank' },
        { id: '05', name: '05 Agreements' },
        { id: '06', name: '06 Certifications' },
        { id: '07', name: '07 Quotations' },
        { id: '08', name: '08 Purchase Orders' },
        { id: '09', name: '09 Quality Records' },
        { id: '10', name: '10 Audits' },
        { id: '11', name: '11 NCR' },
        { id: '12', name: '12 CAPA' },
        { id: '13', name: '13 Invoices' },
        { id: '14', name: '14 Payments' },
      ],
    };
  }

  // ─── VENDOR STATS ─────────────────────────────────────────────────────────

  async getStats(company_id) {
    return vendorRepo.getStats(company_id);
  }
}

export default new VendorService();
