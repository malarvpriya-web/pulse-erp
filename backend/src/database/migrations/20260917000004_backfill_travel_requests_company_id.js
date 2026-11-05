/**
 * Migration: stamp the sole company's id onto NULL-company travel_requests rows.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * /travel/analytics/by-project and /by-employee had NO company scoping — they
 * summed every tenant's trips. Scoping was added 2026-09-16. The moment it was,
 * the by-project panel went EMPTY: its only row carrying a project_number has
 * company_id IS NULL, so a correctly-scoped `company_id = $1` predicate excludes
 * it. The scoping is right; the row is the problem.
 *
 * Measured 2026-09-17: travel_requests holds 284 rows, 283 with company_id = 1
 * and exactly 1 with NULL — the single row that has a project_number.
 *
 * WHY THE EARLIER BLANKET BACKFILL DID NOT COVER IT
 * -------------------------------------------------
 * 20260706000003_backfill_company_id_all_tenant_tables.js intends to do exactly
 * this for every tenant table, but it binds with knex-style `?`:
 *
 *     knex.raw('UPDATE "t" SET company_id = ? WHERE company_id IS NULL', [cid])
 *
 * The `knex` handed to a migration here is NOT knex — src/config/migrations.js
 * builds a shim whose `raw` is a raw pg `client.query`. Postgres reads `?` as the
 * jsonb-exists operator, so every one of those statements is a syntax error. The
 * migration wraps each table in SAVEPOINT/try/catch and logs failures as
 * "Skipped <table>", so the errors were swallowed and it reported success having
 * stamped nothing. Bindings in this repo are $1/$2 — never `?`.
 *
 * That earlier migration is already recorded in schema_migrations and is NOT
 * edited here: changing an applied migration only produces a checksum mismatch,
 * it does not re-run. 25 tables still hold NULL company_id rows (13,889 in
 * total), but most of them SHOULD stay NULL — audit_logs, access_denials,
 * signature_audit_log and workflow_run_logs are audit trails, and users,
 * user_roles, master_values, validation_rules and the iot_* definition tables are
 * global or cross-company config. Blanket-stamping them would mislabel data, so
 * this migration deliberately touches ONE table: the one whose NULL row was
 * measured and whose breakage was observed.
 */

export async function up(knex) {
  // Guarded: stamping NULL -> 1 is only correct where a single company exists.
  // On a genuine multi-tenant install we cannot know which tenant owns the row.
  const { rows: co } = await knex.raw('SELECT COUNT(*)::int AS cnt, MIN(id) AS cid FROM companies');
  const { cnt, cid } = co[0];
  if (cnt !== 1) {
    console.warn(`[20260917000004] Skipped: expected exactly 1 company, found ${cnt}. No backfill performed.`);
    return;
  }

  const { rows: before } = await knex.raw(
    'SELECT id FROM travel_requests WHERE company_id IS NULL ORDER BY id'
  );
  if (before.length === 0) {
    console.log('[20260917000004] No NULL company_id rows in travel_requests. Nothing to do.');
    return;
  }

  // $1/$2 bindings, not `?` — see the note above.
  const res = await knex.raw(
    'UPDATE travel_requests SET company_id = $1 WHERE company_id IS NULL',
    [cid]
  );

  console.log(
    `[20260917000004] travel_requests: stamped ${res.rowCount} row(s) -> company_id ${cid} `
    + `(ids: ${before.map(r => r.id).join(', ')})`
  );
}

export async function down() {
  // Intentionally not reversed. Re-NULLing by predicate would also clear rows that
  // legitimately belong to company 1, and the set that was originally NULL is not
  // recoverable from the schema. To undo a specific run, use the row ids this
  // migration logged.
}
