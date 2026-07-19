/**
 * 20260713000001_component_category_vendor_pricing.js
 *
 * Component master enrichment for "add each component with category, ABC class,
 * and many vendor prices to compare per store, with a dashboard":
 *
 * 1. `item_categories`      — managed category master (hierarchical via parent_id).
 *    Components previously only had a free-text `item_type` (Raw Material /
 *    Finished Good …); there was no true category to file or roll up a component
 *    under. Seeded with a starter set; company-scoped, soft-deletable.
 *
 * 2. `inventory_items.category_id` — FK to the new master (nullable).
 *    `inventory_items.abc_class`    — CHAR(1) A/B/C manual classification.
 *    ABC was only ever computed on-the-fly from 12-month consumption; there was
 *    no way to *assign* a class when adding a component. Left NULL => the
 *    dashboards fall back to the auto-computed class (manual-with-auto-suggest).
 *
 * 3. `item_vendor_prices`   — one row per (component × vendor × store) quote, so
 *    many vendors and prices can be compared per store. The item table only had
 *    a single `preferred_vendor_id`, which cannot express price competition.
 *    warehouse_id NULL = a price that applies to all stores.
 *
 * The migration runner's `knex` is a thin pg shim: bindings are $n, never `?`.
 */

const SEED_CATEGORIES = [
  ['ELEC', 'Electrical'],
  ['ELCT', 'Electronics'],
  ['MECH', 'Mechanical'],
  ['FAST', 'Fasteners'],
  ['RAWM', 'Raw Material'],
  ['CONS', 'Consumables'],
  ['PACK', 'Packaging'],
  ['SPAR', 'Spare Parts'],
  ['TOOL', 'Tools & Instruments'],
  ['CHEM', 'Chemicals'],
  ['SAFE', 'Safety & PPE'],
  ['OFFC', 'Office Supplies'],
];

export async function up(knex) {
  // ── 1. Category master ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS item_categories (
      id          SERIAL PRIMARY KEY,
      category_code VARCHAR(30),
      name        VARCHAR(120) NOT NULL,
      parent_id   INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
      description TEXT,
      company_id  INTEGER,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      deleted_at  TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_item_categories_name
      ON item_categories (company_id, LOWER(name)) WHERE deleted_at IS NULL
  `);

  // Seed the starter set for company 1 only if the table is empty for it.
  const seeded = await knex.raw(
    `SELECT COUNT(*)::int AS c FROM item_categories WHERE company_id = 1 AND deleted_at IS NULL`
  );
  if ((seeded.rows?.[0]?.c ?? 0) === 0 && (await knex.raw(`SELECT 1 FROM companies WHERE id = 1`)).rows.length) {
    for (const [code, name] of SEED_CATEGORIES) {
      await knex.raw(
        `INSERT INTO item_categories (category_code, name, company_id) VALUES ($1, $2, 1)`,
        [code, name]
      );
    }
  }

  // ── 2. Component columns ──────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS abc_class   CHAR(1)
  `);
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.constraint_column_usage
                      WHERE table_name = 'inventory_items' AND column_name = 'abc_class') THEN
        BEGIN
          ALTER TABLE inventory_items
            ADD CONSTRAINT inventory_items_abc_class_chk CHECK (abc_class IN ('A','B','C'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END IF;
    END $$
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items (category_id) WHERE deleted_at IS NULL`);

  // ── 3. Vendor price book (component × vendor × store) ──────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS item_vendor_prices (
      id               SERIAL PRIMARY KEY,
      item_id          INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      vendor_id        INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      warehouse_id     INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      unit_price       NUMERIC(15,4) NOT NULL DEFAULT 0,
      currency         VARCHAR(8) NOT NULL DEFAULT 'INR',
      moq              NUMERIC(15,4) NOT NULL DEFAULT 0,
      pack_size        NUMERIC(15,4),
      discount_pct     NUMERIC(6,3) NOT NULL DEFAULT 0,
      tax_pct          NUMERIC(6,3) NOT NULL DEFAULT 0,
      lead_time_days   INTEGER,
      vendor_sku       VARCHAR(100),
      last_quoted_date DATE DEFAULT CURRENT_DATE,
      valid_until      DATE,
      is_preferred     BOOLEAN NOT NULL DEFAULT FALSE,
      notes            TEXT,
      company_id       INTEGER,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      deleted_at       TIMESTAMPTZ
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ivp_item      ON item_vendor_prices (item_id)      WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ivp_vendor    ON item_vendor_prices (vendor_id)    WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ivp_warehouse ON item_vendor_prices (warehouse_id) WHERE deleted_at IS NULL`);
  // One live price per (item, vendor, store). warehouse_id NULL = "all stores".
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ivp_item_vendor_wh
      ON item_vendor_prices (item_id, vendor_id, COALESCE(warehouse_id, 0))
      WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS item_vendor_prices CASCADE`);
  await knex.raw(`DROP INDEX IF EXISTS idx_inventory_items_category`);
  await knex.raw(`ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_abc_class_chk`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS abc_class`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS category_id`);
  await knex.raw(`DROP TABLE IF EXISTS item_categories CASCADE`);
}
