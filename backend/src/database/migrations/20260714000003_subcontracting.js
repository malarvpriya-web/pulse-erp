/**
 * Subcontracting (SAP PP subcontract / job-work)
 * ----------------------------------------------
 * A subcontract order sends component materials to a vendor who performs an
 * operation (or builds a sub-assembly) and returns the finished/semi-finished
 * item. Integrates with stock:
 *   - issue materials  → stock OUT of components (at vendor / WIP)
 *   - receive finished → stock IN of the produced item, valued at
 *     issued-material cost + service charge.
 *
 * Tables: header (subcontract_orders), the BOM of components to send
 * (subcontract_materials), and the movement log (subcontract_transactions).
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS subcontract_orders (
      id                     SERIAL PRIMARY KEY,
      company_id             INTEGER,
      sc_number              VARCHAR(40) UNIQUE,
      vendor_id              INTEGER,
      vendor_name            VARCHAR(200),
      production_order_id    INTEGER,
      item_id                INTEGER,
      item_name              VARCHAR(250) NOT NULL,
      uom                    VARCHAR(30),
      quantity_ordered       NUMERIC(14,3) NOT NULL,
      quantity_received      NUMERIC(14,3) NOT NULL DEFAULT 0,
      service_charge_per_unit NUMERIC(14,2) DEFAULT 0,
      material_cost_per_unit NUMERIC(14,2) DEFAULT 0,
      status                 VARCHAR(20) NOT NULL DEFAULT 'draft',
      order_date             DATE DEFAULT CURRENT_DATE,
      expected_date          DATE,
      warehouse_id           INTEGER,
      notes                  TEXT,
      created_by             INTEGER,
      created_by_name        VARCHAR(150),
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_sc_status CHECK (status IN ('draft','issued','materials_issued','partially_received','received','closed','cancelled'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sc_orders_company ON subcontract_orders(company_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sc_orders_vendor ON subcontract_orders(vendor_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS subcontract_materials (
      id             SERIAL PRIMARY KEY,
      sc_id          INTEGER NOT NULL REFERENCES subcontract_orders(id) ON DELETE CASCADE,
      company_id     INTEGER,
      item_id        INTEGER,
      item_name      VARCHAR(250) NOT NULL,
      uom            VARCHAR(30),
      qty_per_unit   NUMERIC(14,4) NOT NULL DEFAULT 0,
      qty_required   NUMERIC(14,3) NOT NULL DEFAULT 0,
      qty_issued     NUMERIC(14,3) NOT NULL DEFAULT 0,
      unit_cost      NUMERIC(14,2) DEFAULT 0,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sc_materials_sc ON subcontract_materials(sc_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS subcontract_transactions (
      id             SERIAL PRIMARY KEY,
      sc_id          INTEGER NOT NULL REFERENCES subcontract_orders(id) ON DELETE CASCADE,
      company_id     INTEGER,
      txn_type       VARCHAR(20) NOT NULL,
      item_id        INTEGER,
      item_name      VARCHAR(250),
      quantity       NUMERIC(14,3) NOT NULL,
      rate           NUMERIC(14,2) DEFAULT 0,
      challan_no     VARCHAR(60),
      txn_date       DATE DEFAULT CURRENT_DATE,
      remarks        TEXT,
      created_by     INTEGER,
      created_by_name VARCHAR(150),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_sc_txn_type CHECK (txn_type IN ('material_issue','finished_receipt','material_return'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sc_txn_sc ON subcontract_transactions(sc_id, txn_type)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS subcontract_transactions CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS subcontract_materials CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS subcontract_orders CASCADE`);
}
