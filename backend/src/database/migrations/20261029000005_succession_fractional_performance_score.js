/**
 * 20261029000005 — Succession performance score keeps the review's decimals.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §209.
 *
 * Performance reviews are rated with decimals: final_rating / manager_rating
 * are numeric(3,1) and calibrated_rating numeric(3,2), and the live reviews
 * hold 3.5, 3.9 and 4.3. The manager-review and finalize syncs copy that rating
 * into talent_assessments.performance_score, which was INTEGER: every sync
 * failed ("invalid input syntax for type integer"), and rounding would have
 * changed the rating. The user chose to keep the decimals (2026-10-29).
 *
 * numeric(3,2) holds both the 1-decimal review ratings and the 2-decimal
 * calibrated rating exactly. The 1–5 CHECK constraints are kept as they are.
 * The same change is made to the history copy and to succession_perf_sync_log,
 * which record the same score.
 *
 * Existing values convert exactly (3 → 3.00); no row is otherwise touched.
 * No view depends on these columns (checked in pg_depend on 2026-10-29).
 * Rollback: down() restores INTEGER only while every stored score is whole,
 * and refuses otherwise rather than round anyone's rating.
 */
export const COLUMNS = [
  ['talent_assessments',        'performance_score'],
  ['talent_assessment_history', 'performance_score'],
  ['succession_perf_sync_log',  'performance_score'],
];

export async function up(knex) {
  for (const [table, column] of COLUMNS) {
    await knex.raw(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE NUMERIC(3,2) USING ${column}::numeric(3,2)`);
  }
}

export async function down(knex) {
  for (const [table, column] of COLUMNS) {
    const { rows: [r] } = await knex.raw(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> TRUNC(${column})`);
    if (r.n > 0) {
      throw new Error(`${table}.${column} holds ${r.n} fractional score(s); not converting back to INTEGER (it would round them).`);
    }
  }
  for (const [table, column] of COLUMNS) {
    await knex.raw(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE INTEGER USING ${column}::integer`);
  }
}
