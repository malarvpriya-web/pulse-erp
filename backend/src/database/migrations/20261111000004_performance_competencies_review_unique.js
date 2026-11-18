/**
 * 20261111000004 — saving competency scores never worked.
 *
 * POST /performance/competencies (self-scores) and /competencies/manager both
 * upsert with ON CONFLICT (review_id, competency_name), but no unique index on
 * those columns exists (dev and pulse_e2e had only the primary key on
 * 11 Nov 26), so Postgres refuses every call: "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification" → 500. Found by
 * performanceSelfScope.integration.test.js.
 *
 * Checked before adding: no (review_id, competency_name) duplicates in either
 * database (dev: 5 rows, all distinct). If a later database has duplicates the
 * index build fails loudly rather than deleting anything.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops the index.
 */
const INDEX = 'uq_performance_competencies_review_competency';

export async function up(knex) {
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON performance_competencies (review_id, competency_name)`,
  );
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
}
