/**
 * Phase 49 — Quotations schema upgrade
 *
 * Adds missing columns so the quotations repository matches the actual DB:
 *   company_id, customer_id, opportunity_id, validity_date,
 *   version, parent_id, original_id, deleted_at, updated_at
 *
 * Also extends quotation_items with the columns the repository inserts into:
 *   item_description, rate, tax_percentage, tax_amount, total
 */

export async function up(knex) {
  let _sp = 0;
  const tryAlter = async (sql) => {
    const sp = `_qsp${_sp++}`;
    try {
      await knex.raw(`SAVEPOINT ${sp}`);
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn('[quotations migration] skipped:', e.message);
    }
  };

  // ── quotations ──────────────────────────────────────────────────────────────
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS company_id     INTEGER`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_id    INTEGER`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_name  VARCHAR(255)`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS opportunity_id INTEGER`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS validity_date   DATE`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS version         INTEGER DEFAULT 1`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS parent_id       INTEGER`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS original_id     INTEGER`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ`);
  await tryAlter(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW()`);

  // Back-fill validity_date from valid_until where it already has data
  await tryAlter(`
    UPDATE quotations
    SET validity_date = valid_until
    WHERE validity_date IS NULL AND valid_until IS NOT NULL
  `);

  // ── quotation_items ─────────────────────────────────────────────────────────
  await tryAlter(`ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS item_description  VARCHAR(500)`);
  await tryAlter(`ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS rate              NUMERIC(12,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS tax_percentage    NUMERIC(5,2)  DEFAULT 18`);
  await tryAlter(`ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS tax_amount        NUMERIC(12,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS total             NUMERIC(12,2) DEFAULT 0`);

  // Back-fill aliases from the original column names where present
  await tryAlter(`
    UPDATE quotation_items
    SET item_description = description
    WHERE item_description IS NULL AND description IS NOT NULL
  `);
  await tryAlter(`
    UPDATE quotation_items
    SET rate = unit_price
    WHERE rate = 0 AND unit_price > 0
  `);

  // ── Indexes ─────────────────────────────────────────────────────────────────
  await tryAlter(`
    CREATE INDEX IF NOT EXISTS idx_quotations_company_status
    ON quotations(company_id, status, created_at DESC)
  `);
  await tryAlter(`
    CREATE INDEX IF NOT EXISTS idx_quotations_company_customer
    ON quotations(company_id, customer_id)
  `);
}

export async function down(knex) {
  const tryDrop = async (sql) => {
    try { await knex.raw(sql); }
    catch (e) { /* ignore */ }
  };

  await tryDrop(`DROP INDEX IF EXISTS idx_quotations_company_status`);
  await tryDrop(`DROP INDEX IF EXISTS idx_quotations_company_customer`);

  for (const col of ['company_id','customer_id','opportunity_id','validity_date',
                      'version','parent_id','original_id','deleted_at','updated_at']) {
    await tryDrop(`ALTER TABLE quotations DROP COLUMN IF EXISTS ${col}`);
  }
  for (const col of ['item_description','rate','tax_percentage','tax_amount','total']) {
    await tryDrop(`ALTER TABLE quotation_items DROP COLUMN IF EXISTS ${col}`);
  }
}
