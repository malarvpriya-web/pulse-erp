/**
 * 20260917000004_pct_family_seed_purge.js
 *
 * Finishes the sweep 20260902000004 started: the `_pct` half of the seed
 * generator's percentage defect.
 *
 * ── WHY THERE IS A SECOND SWEEP ─────────────────────────────────────────────
 * 20260902000004 constrained 35 `_rate` columns after finding 899 in the GST
 * master. Its header named `scripts/seed/lib-values.mjs` as the cause and fixed
 * two generator defects — but it only ever looked at columns whose name ends in
 * `_rate`. The generator's OTHER percentage branch, the one matching
 * `/(percent|pct|percentage|utilization|efficiency|progress)/`, was left
 * running, and it emits a fixed ladder:
 *
 *     Number(Math.min(100, 55 + i * 6.5).toFixed(2))
 *       ->  55.0, 61.5, 68.0, 74.5, 81.0, 87.5, 94.0, 100
 *
 * 20260917000002 cleaned `item_vendor_prices`, where the ladder had written an
 * 81% discount that made Component 360 headline a ₹370.6 "best price" and a
 * 2,328% spread on a ₹1,950.50 part. That was one table. A sweep of every
 * percentage-shaped column in the live schema found the same ladder in
 * 27 MORE columns across 15 tables, every one of them written in the
 * 2026-08-20 seed run.
 *
 * ── HOW CORRUPTION WAS TOLD FROM COINCIDENCE ────────────────────────────────
 * A value on the ladder is not proof by itself — 55 and 100 are perfectly
 * ordinary percentages. Three columns that matched were checked and CLEARED as
 * legitimate:
 *
 *   crp_load.load_pct              58 rows at exactly 55, but created
 *                                  2026-09-14/15 by real planning runs, in a
 *                                  column spanning 0..1772.40 across 207
 *                                  distinct values. Ordinary data.
 *   inventory_items.abc_cumulative_pct,
 *   inventory_planning_run_items.abc_cumulative_pct,
 *   opportunities.probability_percentage,
 *   procurement_settings.gst_input_credit_pct
 *                                  all matched only on 100, which is a real
 *                                  value for each of them (an ABC curve ENDS at
 *                                  100%; input credit IS 100% recoverable).
 *
 * So 0 and 100 are excluded from the ladder below, and the evidence required is
 * the ARITHMETIC RUN — several consecutive ladder values in one column — plus a
 * 2026-08-20 creation date. Where a table holds only four rows
 * (project_cost_summary) the run is four values rather than five; that is the
 * table's size, not a different pattern.
 *
 * The fingerprint is unmistakable once seen: the generator classifies on column
 * NAME alone, so a row gets the SAME number in every percentage column it has.
 * `increment_bands` rows read min = max = default = budget = 55.00, which is not
 * a band. `quotation_items` rows read discount = tax = 81.00. `project_cost_summary`
 * reads margin = gross_margin = net_margin = collection = 55.00.
 *
 * ── WHAT EACH COLUMN BECOMES ────────────────────────────────────────────────
 *   DISCOUNT columns -> 0
 *       For a discount, absence genuinely IS zero: net price equals list price,
 *       and that is what the five UNCONTAMINATED quotation_items rows actually
 *       hold (discount 0.00, tax 18.00). Same reasoning as 20260917000002.
 *
 *   other nullable   -> NULL
 *       The standing rule, and 20260902000004's: "NULL is the honest value:
 *       never measured." Zeroing an on-time percentage asserts the vendor is
 *       never on time; zeroing a tax rate asserts an exempt supply.
 *       ⚠ Readers must COALESCE. These columns were nullable already, so any
 *       reader that could not tolerate NULL was already broken.
 *
 *   NOT NULL         -> the column's own DEFAULT
 *       Four columns cannot take NULL. Following 20260902000004, they get their
 *       declared default, which is the one place this repair asserts a value
 *       instead of admitting ignorance.
 *
 *         increment_bands.increment_pct_min/max/default -> 0
 *           Defensible: the rows are literally named 'SEED Increment Bands 1-5'
 *           and 0 is both the column default and what increments.routes.js
 *           itself writes for an unspecified band (`increment_pct_min || 0`).
 *
 *         project_members.allocation_pct -> 100
 *           ⚠ THE WEAKEST CALL IN THIS MIGRATION, stated plainly so it can be
 *           audited. These five rows are NOT name-tagged as fixtures; they
 *           point at real projects and employees and only their percentage came
 *           from the seeder. 100 is the column default AND the application's
 *           own meaning for an unstated allocation — project-members.routes.js
 *           writes `allocation_pct ?? 100`. But manager.routes.js SUMs this
 *           column for team utilisation, so these five people will now read as
 *           fully committed rather than at a fabricated 55-81%. Both are
 *           assertions; this one at least matches what the product means by an
 *           unspecified allocation. If the real allocations are known, set them.
 *
 * ── PREVENTION ──────────────────────────────────────────────────────────────
 * No CHECK constraint is added here, and that is deliberate. Every ladder value
 * is between 0 and 100, so a range check could not have caught ANY of this —
 * it would be security theatre. The defect is semantic, not numeric: an 81%
 * discount is well-formed and catastrophic. The fix belongs in the generator,
 * and it is made in `scripts/seed/lib-values.mjs` alongside this migration:
 * money-semantic percentages (discount, tax, commission, margin, increment...)
 * now route through the same modest branch the `_rate` family already uses
 * instead of the 55-100 ladder.
 */

// The generator's ladder. 0 and 100 are EXCLUDED — see the header.
const LADDER = [55, 61.5, 68, 74.5, 81, 87.5, 94];

// Absence of a discount is zero, not unknown.
const TO_ZERO = [
  ['commercial_proposal_items', 'discount_pct'],
  ['quotation_items',           'discount_pct'],
];

// Unmeasured. Nullable already, so NULL is a value every reader had to handle.
const TO_NULL = [
  ['assessment_attempts',        'score_pct'],
  ['bom_outputs',                'cost_share_pct'],
  ['budget_alerts',              'current_pct'],
  ['budget_alerts',              'threshold_pct'],
  ['commercial_proposal_items',  'tax_pct'],
  ['commercial_proposals',       'contingency_pct'],
  ['commercial_proposals',       'tax_percentage'],
  ['increment_bands',            'budget_pct'],
  ['increment_recommendations',  'final_increment_pct'],
  ['increment_recommendations',  'recommended_increment_pct'],
  ['performance_reviews',        'salary_revision_percentage'],
  ['power_quality_logs',         'thd_pct'],
  ['project_cost_summary',       'collection_pct'],
  ['project_cost_summary',       'gross_margin_pct'],
  ['project_cost_summary',       'margin_pct'],
  ['project_cost_summary',       'net_margin_pct'],
  ['quotation_items',            'tax_percentage'],
  ['sales_commission_rules',     'rate_pct'],
  ['sales_partners',             'commission_pct'],
  ['supplier_quality_snapshots', 'on_time_pct'],
  ['vendor_risk_assessments',    'late_delivery_pct'],
];

// NOT NULL: the column's declared default. See the header for why each is
// defensible, and where the call is weakest.
const TO_DEFAULT = [
  ['increment_bands', 'increment_pct_min',     0],
  ['increment_bands', 'increment_pct_max',     0],
  ['increment_bands', 'increment_pct_default', 0],
  ['project_members', 'allocation_pct',        100],
];

// Identifiers come from the literal tables above, never from user input, but
// they are still quoted rather than interpolated bare.
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function clear(knex, table, column, valueSql, params = []) {
  // Only rows whose value IS on the ladder. A column where a real figure has
  // since overwritten the seeded one is left alone — project_cost_summary id 26
  // carries a genuine margin_pct of -1270.04 next to a seeded gross_margin_pct
  // of 68.00, and only the second is touched.
  await knex.raw(
    `UPDATE ${ident(table)}
        SET ${ident(column)} = ${valueSql}
      WHERE ${ident(column)} = ANY($${params.length + 1}::numeric[])`,
    [...params, `{${LADDER.join(',')}}`]
  );
}

export async function up(knex) {
  for (const [table, column] of TO_ZERO)  await clear(knex, table, column, '0');
  for (const [table, column] of TO_NULL)  await clear(knex, table, column, 'NULL');
  for (const [table, column, dflt] of TO_DEFAULT) {
    await clear(knex, table, column, `$1::numeric`, [dflt]);
  }
}

export async function down() {
  // Nothing is restored, following 20260902000004: these were generator
  // artefacts, not data. Re-writing an 81% discount onto a converted quotation
  // to satisfy a notion of symmetry would put the defect back into the ledger.
  // The migration is reversible in the only sense that matters — rolling it
  // back leaves the schema exactly as it was, because it changed no schema.
}
