/**
 * Migration: Backfill NULL company_id across all tenant-scoped tables
 *
 * Most operational data predates the company_id multi-tenant scoping and was
 * therefore never stamped with a company. Scoped users (including the super
 * admin, whose primary user_scope points at company 1) filter reads by
 * `company_id = <their company>`, so every one of those legacy NULL rows is
 * invisible. Symptom: dashboard "Total Headcount" (and low-stock alerts,
 * pending approvals, on-leave, attendance rate, etc.) all read 0 even though
 * live data exists.
 *
 * Fix: stamp the sole company's id onto every NULL company_id row. Guarded to
 * run ONLY when exactly one company exists, so we never mislabel data in a
 * genuine multi-tenant install. Gap-filling only (WHERE company_id IS NULL) —
 * rows that already carry a company are left untouched.
 *
 * chart_of_accounts is intentionally kept global (company_id NULL) and skipped,
 * consistent with 20260701000001_backfill_finance_company_id.js.
 */
const SKIP_TABLES = new Set([
  'chart_of_accounts', // intentionally global
  'companies',         // the tenant table itself
]);

export async function up(knex) {
  const { rows: co } = await knex.raw('SELECT COUNT(*)::int AS cnt, MIN(id) AS cid FROM companies');
  const { cnt, cid } = co[0];
  if (cnt !== 1) {
    console.warn(`[20260706000003] Skipped: expected exactly 1 company, found ${cnt}. No backfill performed.`);
    return;
  }

  // Every table that carries a company_id column.
  const { rows: tables } = await knex.raw(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'company_id'
    ORDER BY table_name
  `);

  let touched = 0;
  for (const { table_name } of tables) {
    if (SKIP_TABLES.has(table_name)) continue;
    await knex.raw('SAVEPOINT sp');
    try {
      const res = await knex.raw(
        `UPDATE "${table_name}" SET company_id = ? WHERE company_id IS NULL`,
        [cid]
      );
      await knex.raw('RELEASE SAVEPOINT sp');
      if (res.rowCount > 0) {
        touched += res.rowCount;
        console.log(`[20260706000003] ${table_name}: backfilled ${res.rowCount} row(s) -> company_id ${cid}`);
      }
    } catch (e) {
      // Views or tables where company_id is not directly updatable — skip safely.
      await knex.raw('ROLLBACK TO SAVEPOINT sp');
      console.warn(`[20260706000003] Skipped ${table_name}: ${e.message}`);
    }
  }
  console.log(`[20260706000003] Backfill complete. Total rows stamped: ${touched}`);
}

export async function down() {
  // Non-reversible data backfill — we cannot know which rows were originally NULL.
}
