/**
 * Migration: stamp NULL-company travel_requests rows with the company that
 * demonstrably owns the rest of that table.
 *
 * SUPERSEDES the guard in 20260917000004, which refused to run. That migration
 * required `COUNT(*) FROM companies = 1`, the same condition
 * 20260706000003_backfill_company_id_all_tenant_tables.js uses. Measured
 * 2026-09-17: this database holds 41 companies — one real
 * ("Manifest Electra Private Limited", id 1) and 40 LEAKED TEST TENANTS with
 * generated names (ZZGEN_/IOTP4_/IOTE2E_/ZZTSP_/ZZPROC/ZZHD/ZZAN/…). So the
 * "exactly one company" guard is permanently false here, and every backfill
 * gated on it silently skips. 20260917000004 is left applied and untouched —
 * editing a recorded migration only produces a checksum mismatch, it does not
 * re-run.
 *
 * WHY THIS GUARD IS SAFER, NOT WEAKER
 * -----------------------------------
 * Rather than asking "is this a single-tenant database?" (no longer answerable
 * here), it asks the narrower question the data can answer: "do ALL the rows in
 * this table that DO carry a company agree on which one?" travel_requests holds
 * 284 rows — 283 with company_id = 1 and exactly 1 NULL. The owner is not
 * inferred from MIN(id) or from a hardcoded 1; it is read from the table, and if
 * the non-NULL rows disagree the migration skips rather than guessing. That is
 * strictly safer than the count-based guard in a genuinely multi-tenant install:
 * a mixed table is never touched.
 *
 * WHY IT MATTERS
 * --------------
 * /travel/analytics/by-project gained correct company scoping on 2026-09-16 and
 * immediately went empty: its only row carrying a project_number is the NULL one,
 * so `company_id = $1` excludes it. The scoping is right; the unstamped row is
 * the defect.
 *
 * Scoped to travel_requests ONLY. 25 tables still hold NULL company_id rows
 * (13,889 total), but most SHOULD stay NULL — audit_logs, access_denials,
 * signature_audit_log and workflow_run_logs are audit trails; users, user_roles,
 * master_values, validation_rules and the iot_* definition tables are global or
 * cross-company config. This touches the one table whose NULL row was measured
 * and whose breakage was observed.
 *
 * Bindings are $1/$2. The `knex` passed to a migration here is a pg shim
 * (src/config/migrations.js), so a knex-style `?` is read by Postgres as the
 * jsonb-exists operator and raises a syntax error.
 */

export async function up(knex) {
  const { rows: owners } = await knex.raw(`
    SELECT company_id, COUNT(*)::int AS n
    FROM travel_requests
    WHERE company_id IS NOT NULL
    GROUP BY company_id
  `);

  if (owners.length === 0) {
    console.warn('[20260917000005] Skipped: travel_requests has no company-stamped rows, so there is no owner to infer.');
    return;
  }
  if (owners.length > 1) {
    const seen = owners.map(o => `${o.company_id}:${o.n}`).join(', ');
    console.warn(`[20260917000005] Skipped: travel_requests spans multiple companies (${seen}). Refusing to guess which owns the NULL rows.`);
    return;
  }

  const ownerId = owners[0].company_id;

  const { rows: before } = await knex.raw(
    'SELECT id FROM travel_requests WHERE company_id IS NULL ORDER BY id'
  );
  if (before.length === 0) {
    console.log('[20260917000005] No NULL company_id rows in travel_requests. Nothing to do.');
    return;
  }

  const res = await knex.raw(
    'UPDATE travel_requests SET company_id = $1 WHERE company_id IS NULL',
    [ownerId]
  );

  console.log(
    `[20260917000005] travel_requests: stamped ${res.rowCount} row(s) -> company_id ${ownerId} `
    + `(ids: ${before.map(r => r.id).join(', ')}; owner inferred from ${owners[0].n} already-stamped rows)`
  );
}

export async function down() {
  // Intentionally not reversed. Re-NULLing by predicate would also clear rows that
  // legitimately carry this company. To undo a specific run, use the row ids this
  // migration logged.
}
