/**
 * Phantom BOMs + co-/by-products
 * ------------------------------
 * - is_phantom on a BOM header marks a non-stocked "blow-through" assembly: MRP
 *   never plans it; its components are pulled straight up into the parent.
 * - bom_outputs lists ADDITIONAL outputs of a BOM beyond the primary product:
 *   co-products (main sellable outputs) and by-products (secondary/scrap credit).
 *   These are stocked in on production completion and can supply co-product
 *   demand in MRP.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS is_phantom BOOLEAN DEFAULT FALSE`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bom_outputs (
      id             SERIAL PRIMARY KEY,
      bom_id         INTEGER NOT NULL REFERENCES bom_headers(id) ON DELETE CASCADE,
      company_id     INTEGER,
      item_id        INTEGER,
      item_name      VARCHAR(250) NOT NULL,
      uom            VARCHAR(30),
      output_type    VARCHAR(10) NOT NULL DEFAULT 'co',
      qty_per_parent NUMERIC(14,4) NOT NULL DEFAULT 1,
      cost_share_pct NUMERIC(6,2) DEFAULT 0,
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_bom_output_type CHECK (output_type IN ('co','by'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bom_outputs_bom ON bom_outputs(bom_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bom_outputs_item ON bom_outputs(item_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS bom_outputs CASCADE`);
  await knex.raw(`ALTER TABLE bom_headers DROP COLUMN IF EXISTS is_phantom`);
}
