/**
 * 20261103000002 — inventory_allocations.allocation_source: what an allocation
 * row IS, stated by the code that writes it.
 *
 * WHY
 * One table holds two different things. POST /inventory/consumption writes a row
 * for material ALREADY consumed (its stock_ledger issue is written in the same
 * transaction), while order promising writes a row for stock COMMITTED to a
 * sales order. MRP (mrpEngine.service) and order promising (orderPromising.service)
 * sum every row as a live commitment, so a consumption was counted twice: once
 * as the ledger issue, and again as committed demand, permanently (allocations
 * are never released). allocation_type cannot tell them apart — before Stage 5B
 * the consumption route stored any body value there, including 'sales_order'.
 *
 * VALUES
 *   consumption      POST /inventory/consumption        physical consumption; never a commitment
 *   order_promise    orderPromising promise + backorder  sales-order commitment
 *   advanced_manual  POST /inventory/advanced/allocations kept as a commitment (provisional)
 *   NULL             rows that existed before this migration: historical, unclassified
 *
 * HISTORICAL ROWS ARE NOT TOUCHED
 * No backfill, no UPDATE. The column is added nullable, so every existing row
 * keeps exactly its current values with allocation_source NULL, and the readers
 * treat NULL as before (MRP and promising still count it).
 *
 * TWO CONSTRAINTS
 *   inventory_allocations_source_chk       the value, when present, is one of the three
 *   inventory_allocations_source_required  NOT NULL for every NEW row — added NOT VALID,
 *                                          so the existing NULL rows are grandfathered
 *                                          (PostgreSQL does not check existing rows for a
 *                                          NOT VALID constraint, but does check every
 *                                          INSERT and every UPDATE after it). A writer
 *                                          that forgets its source fails loudly instead
 *                                          of creating another unclassified row.
 * Allocations are append-only in this codebase (no UPDATE anywhere), so the
 * UPDATE half of NOT VALID never bites a grandfathered row.
 *
 * Both are looked up by name on THIS table only, so re-running is a no-op.
 */
const TABLE = 'inventory_allocations';
const SOURCES = ['consumption', 'order_promise', 'advanced_manual'];

async function hasConstraint(knex, name) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)`, [name, TABLE]);
  return rows.length > 0;
}

export async function up(knex) {
  const { rows: [t] } = await knex.raw(`SELECT to_regclass($1) AS oid`, [TABLE]);
  if (!t?.oid) return;   // no table, nothing to mark (the baseline always has it)

  await knex.raw(`ALTER TABLE inventory_allocations ADD COLUMN IF NOT EXISTS allocation_source VARCHAR(30)`);

  if (!(await hasConstraint(knex, 'inventory_allocations_source_chk'))) {
    await knex.raw(`ALTER TABLE inventory_allocations ADD CONSTRAINT inventory_allocations_source_chk
      CHECK (allocation_source IS NULL OR allocation_source IN ('${SOURCES.join("','")}'))`);
  }
  if (!(await hasConstraint(knex, 'inventory_allocations_source_required'))) {
    await knex.raw(`ALTER TABLE inventory_allocations ADD CONSTRAINT inventory_allocations_source_required
      CHECK (allocation_source IS NOT NULL) NOT VALID`);
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE inventory_allocations DROP CONSTRAINT IF EXISTS inventory_allocations_source_required`);
  await knex.raw(`ALTER TABLE inventory_allocations DROP CONSTRAINT IF EXISTS inventory_allocations_source_chk`);
  await knex.raw(`ALTER TABLE inventory_allocations DROP COLUMN IF EXISTS allocation_source`);
}
