/**
 * 20261027000007 — RMA numbers are unique per company, not globally.
 *
 * POST /scm/returns numbers RMAs per company (MAX + 1 over the company's own
 * returns), but uq_sales_returns_rma is unique across ALL companies. So every
 * company after the first computed RMA-000001, which another company already
 * held, and the insert failed with a 500 — every time, because its own MAX
 * never moves. The same defect shipments.dispatch_ref had (20261027000002).
 *
 * The index becomes (company_id, rma_number). Every existing row was globally
 * unique, so it is certainly unique per company: this cannot fail on existing
 * data. The new index is created before the old one is dropped.
 *
 * Rollback: down() restores the global index — which only succeeds while no two
 * companies share an RMA number.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_company_rma
      ON sales_returns (company_id, rma_number) WHERE rma_number IS NOT NULL
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_sales_returns_rma`);
}

export async function down(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_rma
      ON sales_returns (rma_number) WHERE rma_number IS NOT NULL
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_sales_returns_company_rma`);
}
