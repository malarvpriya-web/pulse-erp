/**
 * 20261111000007 — re-issuing a returned employee asset.
 *
 * A returned asset could only be disposed of or deleted: giving the same laptop
 * to someone new meant typing a fresh record, so its history was split across
 * unrelated rows. Re-issue (POST /employee-assets/:id/reissue) now creates the
 * new allocation with `reissued_from` pointing at the returned one, so the
 * History panel can walk the whole chain for one physical asset.
 *
 * ON DELETE SET NULL only as a safety net: the API refuses to delete a record
 * that a later allocation was re-issued from.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops the index and the column.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employee_asset_allocations
      ADD COLUMN IF NOT EXISTS reissued_from INTEGER
        REFERENCES employee_asset_allocations(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_emp_asset_alloc_reissued_from
      ON employee_asset_allocations(reissued_from)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_emp_asset_alloc_reissued_from`);
  await knex.raw(`ALTER TABLE employee_asset_allocations DROP COLUMN IF EXISTS reissued_from`);
}
