/**
 * Give off-PO spend a tenant boundary and a document number.
 *
 * `local_purchase_requests` records purchases made outside the requisition/PO
 * process — the spend a finance review looks at first, because it is the spend
 * that bypassed every control. The table had NO `company_id` column at all:
 *
 *   - GET /procurement/local-purchase returned EVERY tenant's off-PO spend,
 *     with description, vendor name and amount, to any caller holding
 *     procurement view. There was no predicate to omit — the column did not
 *     exist, so there was nothing to scope on;
 *   - the INSERT could not record which company the spend belonged to, so each
 *     row counted in every tenant's maverick-spend figure at once.
 *
 * Backfilled through the requester: `requested_by_employee_id` FKs employees,
 * and an employee belongs to exactly one company. That is an assertion, not a
 * guess. A row with no requester cannot be attributed and is left NULL rather
 * than assigned to whichever company happens to be first — a NULL company_id is
 * already the codebase's "global" and is visible to a super-admin, which is the
 * right place for a row nobody can attribute.
 *
 * Also adds `seq_lpr`. Numbers were `LPR${Date.now()}` — see the same problem in
 * migration 20260903000012 for returns to vendor.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE local_purchase_requests ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`
    ALTER TABLE local_purchase_requests DROP CONSTRAINT IF EXISTS local_purchase_requests_company_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE local_purchase_requests
      ADD CONSTRAINT local_purchase_requests_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
  `);

  const { rows: attributed } = await knex.raw(`
    UPDATE local_purchase_requests lpr
       SET company_id = e.company_id
      FROM employees e
     WHERE lpr.company_id IS NULL
       AND lpr.requested_by_employee_id = e.id
       AND e.company_id IS NOT NULL
    RETURNING lpr.id
  `);

  const { rows: [orphaned] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM local_purchase_requests
     WHERE company_id IS NULL AND deleted_at IS NULL
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lpr_company ON local_purchase_requests(company_id)`);

  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_lpr START WITH 1 INCREMENT BY 1 NO CYCLE`);
  const { rows: [mx] } = await knex.raw(`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(request_number, '\\D', '', 'g'), ''))::bigint, 0) AS n
      FROM local_purchase_requests
     WHERE request_number ~ '^[A-Z]{2,10}[0-9]{4,}$'
  `);
  if (Number(mx.n) > 0) await knex.raw(`SELECT setval('seq_lpr', $1, true)`, [Number(mx.n)]);

  console.log(
    `[20260903000013] local_purchase_requests.company_id added; ${attributed.length} row(s) attributed ` +
    `via their requester's employee record; ${orphaned.n} row(s) left unattributed (no requester on file). ` +
    `seq_lpr created.`
  );
}

export async function down(knex) {
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_lpr`);
  await knex.raw(`DROP INDEX IF EXISTS idx_lpr_company`);
  await knex.raw(`ALTER TABLE local_purchase_requests DROP CONSTRAINT IF EXISTS local_purchase_requests_company_id_fkey`);
  await knex.raw(`ALTER TABLE local_purchase_requests DROP COLUMN IF EXISTS company_id`);
}
