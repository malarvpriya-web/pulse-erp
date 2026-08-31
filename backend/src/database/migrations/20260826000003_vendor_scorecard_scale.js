/**
 * Supplier Performance Index — put vendor_scorecards on one declared scale.
 *
 * The table's six dimension scores and `overall_score` are NUMERIC(5,2) with no
 * range constraint, and its readers had split into a 0–100 camp (the entry UI,
 * the vendor-portal write path, the vendor health engine) and a 1–5 camp (CEO
 * Intelligence, CEO 360) — see backend/src/shared/vendorScore.js for the full
 * account. Every row in the table was seeded placeholder data on the 1–5 scale
 * with a `risk_rating` of 'SEED risk rating N' and, in one case, a
 * `period_quarter` of 5.
 *
 * 0–100 wins: it is the only scale the write path offers and the scale the
 * health engine consumes. This migration rescales the legacy rows, repairs the
 * quarter and the risk rating, and then adds the CHECK constraints that stop
 * the column drifting back.
 */

export async function up(knex) {
  // ── 1. Rescale legacy 1–5 rows to 0–100 ──────────────────────────────────
  // Gate: every non-null score on the row is > 0 and <= 5. A genuine 0–100
  // scorecard whose every dimension scored 5 or less would be a supplier scoring
  // under 5% across the board — not a case worth protecting against the certain
  // corruption of leaving the seeded rows on the wrong scale.
  await knex.raw(`
    UPDATE vendor_scorecards SET
      quality_score       = quality_score       * 20,
      delivery_score      = delivery_score      * 20,
      cost_score          = cost_score          * 20,
      support_score       = support_score       * 20,
      compliance_score    = compliance_score    * 20,
      documentation_score = documentation_score * 20,
      overall_score       = overall_score       * 20,
      updated_at          = NOW()
    WHERE GREATEST(
            COALESCE(quality_score, 0), COALESCE(delivery_score, 0),
            COALESCE(cost_score, 0),    COALESCE(support_score, 0),
            COALESCE(compliance_score, 0), COALESCE(documentation_score, 0),
            COALESCE(overall_score, 0)
          ) BETWEEN 0.01 AND 5
  `);

  // ── 2. Repair period_quarter ─────────────────────────────────────────────
  // UNIQUE (vendor_id, period_year, period_quarter) means a clamp can collide,
  // so drop the older duplicate before folding the out-of-range value back into
  // 1–4. ((q-1) % 4 + 4) % 4 + 1 is the negative-safe form.
  await knex.raw(`
    DELETE FROM vendor_scorecards a
    WHERE a.period_quarter NOT BETWEEN 1 AND 4
      AND EXISTS (
        SELECT 1 FROM vendor_scorecards b
        WHERE b.vendor_id     = a.vendor_id
          AND b.period_year   = a.period_year
          AND b.period_quarter = ((a.period_quarter - 1) % 4 + 4) % 4 + 1
      )
  `);
  await knex.raw(`
    UPDATE vendor_scorecards
       SET period_quarter = ((period_quarter - 1) % 4 + 4) % 4 + 1,
           updated_at     = NOW()
     WHERE period_quarter NOT BETWEEN 1 AND 4
  `);

  // ── 3. Repair risk_rating ────────────────────────────────────────────────
  // Only Low/Medium/High are meaningful to the UI's RISK_COLORS map and to the
  // scorecard filter; anything else renders as an unstyled, unfilterable label.
  await knex.raw(`
    UPDATE vendor_scorecards
       SET risk_rating = CASE
             WHEN overall_score >= 80 THEN 'Low'
             WHEN overall_score >= 60 THEN 'Medium'
             ELSE 'High'
           END,
           updated_at = NOW()
     WHERE risk_rating IS NULL OR risk_rating NOT IN ('Low', 'Medium', 'High')
  `);

  // ── 4. Lock the scale in ─────────────────────────────────────────────────
  // .catch() so a re-run over an already-constrained table is a no-op rather
  // than a failed migration.
  for (const col of ['quality_score', 'delivery_score', 'cost_score',
                     'support_score', 'compliance_score', 'documentation_score',
                     'overall_score']) {
    await knex.raw(`
      ALTER TABLE vendor_scorecards
        ADD CONSTRAINT vendor_scorecards_${col}_range
        CHECK (${col} IS NULL OR (${col} >= 0 AND ${col} <= 100))
    `).catch(() => {});
  }
  await knex.raw(`
    ALTER TABLE vendor_scorecards
      ADD CONSTRAINT vendor_scorecards_quarter_range
      CHECK (period_quarter BETWEEN 1 AND 4)
  `).catch(() => {});
  await knex.raw(`
    ALTER TABLE vendor_scorecards
      ADD CONSTRAINT vendor_scorecards_risk_rating_values
      CHECK (risk_rating IS NULL OR risk_rating IN ('Low', 'Medium', 'High'))
  `).catch(() => {});
}

export async function down(knex) {
  // The constraints come off; the rescaled values stay. Dividing back by 20
  // would corrupt any genuine 0–100 scorecard entered after this ran.
  for (const c of ['quality_score_range', 'delivery_score_range', 'cost_score_range',
                   'support_score_range', 'compliance_score_range',
                   'documentation_score_range', 'overall_score_range',
                   'quarter_range', 'risk_rating_values']) {
    await knex.raw(`ALTER TABLE vendor_scorecards DROP CONSTRAINT IF EXISTS vendor_scorecards_${c}`).catch(() => {});
  }
}
