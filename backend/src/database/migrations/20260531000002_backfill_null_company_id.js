/**
 * Phase 49 — Backfill NULL company_id on employees, leave_applications, leave_requests.
 *
 * Migration 20260428000002 added company_id columns as nullable with no backfill,
 * so rows inserted before the setup wizard completed have company_id = NULL.
 * Once a user logs in (JWT carries company_id from user_scope), every scoped
 * query runs WHERE company_id = <id> and returns 0 rows even though data exists.
 *
 * Fix: assign the single company_id (first in the companies table) to all rows
 * that still have company_id = NULL. Safe to re-run — the WHERE clause limits
 * updates to NULL rows only.
 */
export async function up(knex) {
  await knex.raw(`
    DO $$
    DECLARE
      cid INTEGER;
    BEGIN
      SELECT id INTO cid FROM companies ORDER BY id LIMIT 1;
      IF cid IS NULL THEN
        RAISE NOTICE 'No company found — skipping backfill';
        RETURN;
      END IF;

      UPDATE employees         SET company_id = cid WHERE company_id IS NULL;
      UPDATE leave_applications SET company_id = cid WHERE company_id IS NULL;
      UPDATE leave_requests     SET company_id = cid WHERE company_id IS NULL;

      RAISE NOTICE 'Backfilled company_id = % on employees, leave_applications, leave_requests', cid;
    END $$;
  `);
}

export async function down(_knex) {
  // Intentionally irreversible — setting company_id back to NULL
  // would re-break multi-tenant scoping.
}
