/**
 * test_runs.run_number — give it a default.
 *
 * `run_number` is NOT NULL with no default, and the witnessed-test path
 * (`POST /quality/test-runs`) does not supply one — it writes title/status/
 * project_id and lets the shop-floor identifier be someone else's problem. So
 * even after 20260819000010 added the missing columns, every insert still failed,
 * just on a different constraint.
 *
 * A sequence-backed default means both writers work: the shop-floor path can
 * keep passing its own run_number, and the witnessed path gets one generated.
 */

export async function up(knex) {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS test_run_number_seq;`);
  // Start past anything already used so a generated number can never collide.
  await knex.raw(`
    SELECT setval('test_run_number_seq',
      GREATEST(
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(run_number, '\\D', '', 'g'), ''))::bigint, 0) FROM test_runs),
        (SELECT COUNT(*) FROM test_runs)
      ) + 1,
      false);
  `);
  await knex.raw(`
    ALTER TABLE test_runs
      ALTER COLUMN run_number SET DEFAULT 'TR-' || LPAD(nextval('test_run_number_seq')::text, 5, '0');
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE test_runs ALTER COLUMN run_number DROP DEFAULT;`);
  await knex.raw(`DROP SEQUENCE IF EXISTS test_run_number_seq;`);
}
