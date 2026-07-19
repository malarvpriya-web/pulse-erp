/**
 * 20260613000001_inventory_hardening.js
 *
 * 1. inventory_items — adds missing enterprise columns:
 *    hsn_code, gst_rate, manufacturer, lead_time_days, safety_stock
 *
 * 2. serial_numbers — full serial tracking table:
 *    linked to inventory_items, supports location/status/batch/production-order
 */

export async function up(knex) {
  // ── 1. inventory_items enhancements ─────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS hsn_code          VARCHAR(20)    DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS gst_rate          NUMERIC(5,2)   DEFAULT 0,
      ADD COLUMN IF NOT EXISTS manufacturer      VARCHAR(200)   DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS lead_time_days    INTEGER        DEFAULT 7,
      ADD COLUMN IF NOT EXISTS safety_stock      NUMERIC(12,2)  DEFAULT 0
  `);

  // ── 2. serial_numbers ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS serial_numbers (
      id                 SERIAL        PRIMARY KEY,
      serial_number      VARCHAR(100)  NOT NULL,
      item_id            INTEGER       NOT NULL REFERENCES inventory_items(id),
      batch_id           INTEGER       DEFAULT NULL REFERENCES inventory_batches(id),
      company_id         INTEGER       DEFAULT NULL,
      warehouse_id       INTEGER       DEFAULT NULL,
      status             VARCHAR(50)   NOT NULL DEFAULT 'in_stock',
      current_location   VARCHAR(200)  DEFAULT NULL,
      manufactured_date  DATE          DEFAULT NULL,
      warranty_expiry    DATE          DEFAULT NULL,
      production_order_id INTEGER      DEFAULT NULL,
      notes              TEXT          DEFAULT NULL,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      deleted_at         TIMESTAMPTZ   DEFAULT NULL,
      CONSTRAINT serial_numbers_item_serial_uq UNIQUE (item_id, serial_number)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_numbers_item_id
    ON serial_numbers(item_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_numbers_status
    ON serial_numbers(status) WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_numbers_company_id
    ON serial_numbers(company_id) WHERE deleted_at IS NULL
  `);

  // ── 3. serial_events — service history per serial ────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS serial_events (
      id            SERIAL        PRIMARY KEY,
      serial_id     INTEGER       NOT NULL REFERENCES serial_numbers(id) ON DELETE CASCADE,
      event_type    VARCHAR(50)   NOT NULL,
      event_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
      description   TEXT,
      performed_by  INTEGER       DEFAULT NULL,
      reference_type VARCHAR(50)  DEFAULT NULL,
      reference_id  INTEGER       DEFAULT NULL,
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_events_serial_id
    ON serial_events(serial_id)
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS serial_events CASCADE');
  await knex.raw('DROP TABLE IF EXISTS serial_numbers CASCADE');
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP COLUMN IF EXISTS hsn_code,
      DROP COLUMN IF EXISTS gst_rate,
      DROP COLUMN IF EXISTS manufacturer,
      DROP COLUMN IF EXISTS lead_time_days,
      DROP COLUMN IF EXISTS safety_stock
  `);
}
