/**
 * vendorScore.js — the one scale the Supplier Performance Index is measured on.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vendor_scorecards` carried six dimension scores and an `overall_score` with
 * no declared scale, and its readers had quietly split into two camps:
 *
 *   0–100  VendorScorecard.jsx writes it (sliders labelled "Evaluation Scores
 *          (0–100)", min 0 / max 100), vendor-portal.routes.js bands the risk
 *          rating at 80/60, vendorHealth.service.js feeds `support_score`
 *          straight into the health engine as `Math.min(100, score)`.
 *
 *   1–5    ceo-intelligence.routes.js and ceo360.routes.js labelled vendors
 *          `overall >= 4 ? 'Preferred' : >= 3 ? 'Approved' : >= 2 ? 'Watchlist'`,
 *          and CEOIntelligenceDashboard.jsx rendered the number as `x/5`.
 *
 * Only seeded placeholder rows (all six dimensions identical, 3.50–4.30) were
 * ever in the table, so the 1–5 readers looked plausible while the 0–100 ones
 * showed "3.9 / 100" in red — and the health engine took a 3.9 support score,
 * dragging every vendor's index down by ~9.6 points at its 0.10 weight. The
 * failure was latent in the other direction too: the first real scorecard saved
 * through the UI (say 85) would have labelled that vendor "Preferred" on the
 * CEO's board on the strength of `85 >= 4`.
 *
 * 0–100 is canonical — it is the only scale the write path offers, the scale
 * the health engine consumes, and the scale the DDL's NUMERIC(5,2) DEFAULT 0
 * implies. Migration 20260826000003 rescaled the legacy rows and added CHECK
 * constraints so the column can no longer hold a 1–5 value. Every consumer must
 * band scores through this module rather than inlining thresholds.
 */

/** The scale every vendor_scorecards score column is expressed on. */
export const SCORECARD_SCALE_MAX = 100;

/**
 * Supplier classification bands. Identical to vendorHealthEngine.classifyHealth
 * so a manually-entered scorecard and a computed health score land the same
 * vendor in the same bucket.
 */
export const VENDOR_SCORE_BANDS = [
  { min: 90, label: 'Preferred', color: '#16a34a' },
  { min: 75, label: 'Approved',  color: '#2563eb' },
  { min: 50, label: 'Watchlist', color: '#d97706' },
  { min: 0,  label: 'Critical',  color: '#dc2626' },
];

/**
 * Classify a 0–100 score. Returns null for an unscored vendor — UNMEASURED IS
 * NOT ZERO, and callers must render "Not Scored" rather than the bottom band.
 */
export function classifyVendorScore(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const n = Number(score);
  return (VENDOR_SCORE_BANDS.find(b => n >= b.min) || VENDOR_SCORE_BANDS.at(-1)).label;
}

/** Band colour for a 0–100 score; null (unscored) renders neutral grey. */
export function vendorScoreColor(score) {
  if (score == null || Number.isNaN(Number(score))) return '#9ca3af';
  const n = Number(score);
  return (VENDOR_SCORE_BANDS.find(b => n >= b.min) || VENDOR_SCORE_BANDS.at(-1)).color;
}

/**
 * Procurement's Low/Medium/High risk rating stored on vendor_scorecards.
 * Deliberately a coarser, more forgiving set of cut-offs than the four
 * classification bands above: "is this supplier a risk to place work with"
 * is a different question from "how did they perform last quarter".
 */
export function scorecardRisk(score) {
  const n = Number(score || 0);
  return n >= 80 ? 'Low' : n >= 60 ? 'Medium' : 'High';
}

/** The six dimensions a quarterly scorecard is scored on, in display order. */
export const SCORECARD_DIMENSIONS = [
  'quality_score', 'delivery_score', 'cost_score',
  'support_score', 'compliance_score', 'documentation_score',
];

export default {
  SCORECARD_SCALE_MAX,
  VENDOR_SCORE_BANDS,
  SCORECARD_DIMENSIONS,
  classifyVendorScore,
  vendorScoreColor,
  scorecardRisk,
};
