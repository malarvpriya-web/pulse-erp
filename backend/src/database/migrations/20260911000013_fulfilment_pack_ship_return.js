/**
 * The missing half of order-to-delivery: packing, a real dispatch, and returns.
 *
 * The audit traced the fulfilment chain and found it breaks after picking:
 *
 *   POST /warehouse/dispatch accepted courier, tracking_number, carton_count and
 *     weight_kg, stored NONE of them, wrote no shipment row, and returned a
 *     DSP-<timestamp> reference that was never persisted and could never be
 *     looked up again. Picking and shipping were two islands — shipments was
 *     populated only by a separate manual screen whose reference_type and
 *     reference_id were untyped varchars with no foreign key.
 *
 *   Packing did not exist at all. No pack list, no carton, no package entity.
 *
 *   Returns did not exist either: 'sales_return' was a credit-note reason code
 *     and nothing more.
 *
 *   Backorders and order prioritisation had no representation, so an
 *     under-supplied order simply stalled with nothing in the system saying so.
 *
 * shipments gains typed links rather than replacing reference_type/reference_id,
 * which other code still reads. The typed columns are what new code joins on.
 */

export async function up(knex) {
  // ── Carrier master ─────────────────────────────────────────────────────────
  // courier_partner was free text, so the same carrier arrived spelled three
  // ways and no rate, lead time or performance could attach to it.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS carriers (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      carrier_code      VARCHAR(30),
      carrier_name      VARCHAR(150) NOT NULL,
      mode              VARCHAR(20) DEFAULT 'road',
      contact_person    VARCHAR(120),
      phone             VARCHAR(40),
      email             VARCHAR(150),
      tracking_url_template TEXT,
      standard_lead_days   INTEGER,
      status            VARCHAR(16) DEFAULT 'active',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_carriers_company ON carriers(company_id)`);

  // ── Packing ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS packages (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      package_no        VARCHAR(40),
      pick_list_id      INTEGER REFERENCES pick_lists(id) ON DELETE SET NULL,
      sales_order_id    INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
      package_type      VARCHAR(24) DEFAULT 'carton',
      gross_weight_kg   NUMERIC(12,3),
      net_weight_kg     NUMERIC(12,3),
      length_cm         NUMERIC(10,2),
      width_cm          NUMERIC(10,2),
      height_cm         NUMERIC(10,2),
      status            VARCHAR(16) DEFAULT 'open',
      packed_by         INTEGER,
      packed_by_name    VARCHAR(120),
      packed_at         TIMESTAMPTZ,
      shipment_id       INTEGER,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_packages_picklist ON packages(pick_list_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_packages_order    ON packages(sales_order_id)`);

  // What is physically in the carton, down to the lot — this is what makes a
  // shipped batch traceable to the customer who received it.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS package_lines (
      id                SERIAL PRIMARY KEY,
      package_id        INTEGER REFERENCES packages(id) ON DELETE CASCADE,
      company_id        INTEGER,
      item_id           INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name         VARCHAR(200),
      batch_id          INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      serial_id         INTEGER REFERENCES serial_numbers(id) ON DELETE SET NULL,
      pick_list_line_id INTEGER,
      quantity          NUMERIC(15,3) NOT NULL,
      uom               VARCHAR(20),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_package_lines_pkg   ON package_lines(package_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_package_lines_batch ON package_lines(batch_id) WHERE batch_id IS NOT NULL`);

  // ── Shipment: typed links + dispatch identity ──────────────────────────────
  const shipCols = [
    ['sales_order_id',  'INTEGER'],
    ['pick_list_id',    'INTEGER'],
    ['carrier_id',      'INTEGER'],
    ['dispatch_ref',    'VARCHAR(40)'],
    ['package_count',   'INTEGER'],
    ['promised_date',   'DATE'],
    ['dispatched_by',   'INTEGER'],
    ['dispatched_by_name', 'VARCHAR(120)'],
  ];
  for (const [n, t] of shipCols) {
    await knex.raw(`ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ${n} ${t}`);
  }
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_sales_order_id_fkey') THEN
        ALTER TABLE shipments ADD CONSTRAINT shipments_sales_order_id_fkey
          FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_pick_list_id_fkey') THEN
        ALTER TABLE shipments ADD CONSTRAINT shipments_pick_list_id_fkey
          FOREIGN KEY (pick_list_id) REFERENCES pick_lists(id) ON DELETE SET NULL;
      END IF;
    END $$;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_shipments_order    ON shipments(sales_order_id) WHERE sales_order_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_shipments_picklist ON shipments(pick_list_id)   WHERE pick_list_id   IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_dispatch_ref ON shipments(dispatch_ref) WHERE dispatch_ref IS NOT NULL`);

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packages_shipment_id_fkey') THEN
        ALTER TABLE packages ADD CONSTRAINT packages_shipment_id_fkey
          FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE SET NULL;
      END IF;
    END $$;`);

  // ── Pick list: scope to an order line and a status vocabulary ──────────────
  await knex.raw(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS priority VARCHAR(16) DEFAULT 'normal'`);
  await knex.raw(`ALTER TABLE pick_list_lines ADD COLUMN IF NOT EXISTS batch_id INTEGER`);
  await knex.raw(`ALTER TABLE pick_list_lines ADD COLUMN IF NOT EXISTS sales_order_item_id INTEGER`);

  // ── Backorders ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS backorders (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      sales_order_id      INTEGER REFERENCES sales_orders(id) ON DELETE CASCADE,
      sales_order_item_id INTEGER,
      order_number        VARCHAR(60),
      item_id             INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name           VARCHAR(200),
      qty_ordered         NUMERIC(15,3),
      qty_available       NUMERIC(15,3),
      qty_backordered     NUMERIC(15,3) NOT NULL,
      qty_released        NUMERIC(15,3) DEFAULT 0,
      promised_date       DATE,
      expected_date       DATE,
      reason              VARCHAR(40),
      priority            VARCHAR(16) DEFAULT 'normal',
      status              VARCHAR(16) DEFAULT 'open',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      released_at         TIMESTAMPTZ,
      closed_at           TIMESTAMPTZ
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_backorders_open ON backorders(company_id, status) WHERE status = 'open'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_backorders_item ON backorders(item_id)`);

  // Order prioritisation — allocation needs a documented order to ration in.
  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS priority VARCHAR(16) DEFAULT 'normal'`);
  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS promised_date DATE`);
  // The promise is the delivery date agreed at order time. Backfilling from
  // delivery_date is correct for existing rows: it is the only date the customer
  // was ever given, and OTIF measured against a blank promise is not a metric.
  await knex.raw(`UPDATE sales_orders SET promised_date = delivery_date WHERE promised_date IS NULL AND delivery_date IS NOT NULL`);

  // ── Returns / RMA ──────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_returns (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      rma_number        VARCHAR(40),
      sales_order_id    INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
      shipment_id       INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
      customer_id       UUID,
      customer_name     VARCHAR(200),
      return_date       DATE DEFAULT CURRENT_DATE,
      reason            VARCHAR(40),
      reason_detail     TEXT,
      status            VARCHAR(20) DEFAULT 'requested',
      disposition       VARCHAR(20),
      complaint_id      INTEGER,
      credit_note_id    INTEGER,
      approved_by       INTEGER,
      approved_at       TIMESTAMPTZ,
      received_at       TIMESTAMPTZ,
      closed_at         TIMESTAMPTZ,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_rma ON sales_returns(rma_number) WHERE rma_number IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sales_returns_company ON sales_returns(company_id, status)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_return_items (
      id                SERIAL PRIMARY KEY,
      return_id         INTEGER REFERENCES sales_returns(id) ON DELETE CASCADE,
      company_id        INTEGER,
      item_id           INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name         VARCHAR(200),
      batch_id          INTEGER REFERENCES inventory_batches(id) ON DELETE SET NULL,
      serial_id         INTEGER REFERENCES serial_numbers(id) ON DELETE SET NULL,
      quantity          NUMERIC(15,3) NOT NULL,
      uom               VARCHAR(20),
      unit_price        NUMERIC(15,2),
      disposition       VARCHAR(20),
      qc_result         VARCHAR(16),
      restocked_qty     NUMERIC(15,3) DEFAULT 0,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sales_return_items_ret ON sales_return_items(return_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS sales_return_items`);
  await knex.raw(`DROP TABLE IF EXISTS sales_returns`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS promised_date`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS priority`);
  await knex.raw(`DROP TABLE IF EXISTS backorders`);
  await knex.raw(`ALTER TABLE pick_list_lines DROP COLUMN IF EXISTS sales_order_item_id`);
  await knex.raw(`ALTER TABLE pick_list_lines DROP COLUMN IF EXISTS batch_id`);
  await knex.raw(`ALTER TABLE pick_lists DROP COLUMN IF EXISTS priority`);
  await knex.raw(`ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_shipment_id_fkey`);
  await knex.raw(`DROP INDEX IF EXISTS uq_shipments_dispatch_ref`);
  for (const c of ['dispatched_by_name','dispatched_by','promised_date','package_count','dispatch_ref','carrier_id','pick_list_id','sales_order_id']) {
    await knex.raw(`ALTER TABLE shipments DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`DROP TABLE IF EXISTS package_lines`);
  await knex.raw(`DROP TABLE IF EXISTS packages`);
  await knex.raw(`DROP TABLE IF EXISTS carriers`);
}
