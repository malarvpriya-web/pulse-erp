/**
 * 20260915000005_item_gl_mapping_uuid.js
 *
 * Finance audit finding F17, the part that needed a schema change.
 *
 * `inventory_items.expense_account_id` and `.inventory_account_id` were INTEGER
 * with no foreign key, while `chart_of_accounts.id` is a UUID. The COGS service
 * compared them directly:
 *
 *     SELECT code FROM chart_of_accounts WHERE id = inventory_items.expense_account_id
 *
 * Postgres rejects `uuid = integer`, and the surrounding catch swallowed the
 * error and returned the 5001/1032 defaults. So per-item GL mapping never
 * resolved for any item, ever — while inventoryItem.repository.js accepted and
 * stored whatever the item form sent, giving every appearance of working.
 *
 * SAFETY: verified against the live database before writing this — 32 items,
 * NONE with either column set. There is no mapping data to convert or lose, so
 * the columns are retyped rather than migrated. The guard below re-checks that
 * at run time rather than trusting this note: if any row has a value, the
 * migration aborts instead of discarding it.
 */

export async function up(knex) {
  const { rows } = await knex.raw(`
    SELECT COUNT(*)::int AS n
      FROM inventory_items
     WHERE expense_account_id IS NOT NULL
        OR inventory_account_id IS NOT NULL
  `);
  const populated = rows?.[0]?.n ?? 0;
  if (populated > 0) {
    throw new Error(
      `20260915000005: ${populated} inventory_items row(s) carry an integer account mapping. ` +
      `Those values cannot reference chart_of_accounts (uuid) and this migration will not ` +
      `silently discard them. Decide what they meant, clear or translate them, then re-run.`
    );
  }

  await knex.raw(`
    ALTER TABLE inventory_items
      ALTER COLUMN expense_account_id   TYPE uuid USING NULL,
      ALTER COLUMN inventory_account_id TYPE uuid USING NULL
  `);

  // Now that the types match, the references can actually be enforced.
  // ON DELETE SET NULL: removing an account must not take items with it — the
  // COGS service falls back to the default codes when a mapping is absent.
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD CONSTRAINT inventory_items_expense_account_fkey
        FOREIGN KEY (expense_account_id)   REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
      ADD CONSTRAINT inventory_items_inventory_account_fkey
        FOREIGN KEY (inventory_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL
  `);

  console.log('[migration 20260915000005] item GL mapping columns are uuid and now reference chart_of_accounts.');
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP CONSTRAINT IF EXISTS inventory_items_expense_account_fkey,
      DROP CONSTRAINT IF EXISTS inventory_items_inventory_account_fkey
  `);
  await knex.raw(`
    ALTER TABLE inventory_items
      ALTER COLUMN expense_account_id   TYPE integer USING NULL,
      ALTER COLUMN inventory_account_id TYPE integer USING NULL
  `);
}
