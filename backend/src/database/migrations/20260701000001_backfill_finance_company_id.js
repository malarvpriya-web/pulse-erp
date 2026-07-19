/**
 * Migration: Backfill NULL company_id on finance tables
 *
 * The finance read paths were tightened to scope strictly by company_id (removing
 * the `OR company_id IS NULL` branch that made untagged rows visible to every
 * tenant). To avoid hiding legacy rows that predate company_id, backfill any NULL
 * company_id — but ONLY when there is exactly one company in the system, so we
 * never mislabel data in a genuine multi-tenant install.
 *
 * chart_of_accounts is intentionally left global (company_id NULL) and is skipped.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260701000001] Skipped (${label}): ${e.message}`);
    }
  };

  // Single-company guard: backfill each table's NULL company_id to the sole
  // company id. No-op when 0 or >1 companies exist.
  const backfill = (table) => `
    DO $$
    DECLARE cnt int; cid int;
    BEGIN
      SELECT COUNT(*), MIN(id) INTO cnt, cid FROM companies;
      IF cnt = 1 THEN
        UPDATE ${table} SET company_id = cid WHERE company_id IS NULL;
      END IF;
    END $$;
  `;

  await safe('backfill invoices',        backfill('invoices'));
  await safe('backfill bills',           backfill('bills'));
  await safe('backfill journal_entries', backfill('journal_entries'));
}

export async function down() {
  // Non-reversible data backfill — nothing to undo.
}
