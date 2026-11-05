/**
 * 20261031000001 — freight as weight x distance x rate (tonne-km).
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §216.
 *
 * Every live comparison costed freight at an assumed 2% of value: no quote, no
 * price book row, no GRN and no PO carried a freight figure. This adds the
 * inputs a modelled freight needs, each with its provenance, and nothing else:
 *
 *   inventory_items  shipping weight (kg PER a stated unit), its basis, a freight
 *                    category. Nullable, no defaults, NO backfill — an unknown
 *                    weight stays unknown; inventing one would make freight look
 *                    measured when it is not.
 *   rfq_quotes       a vendor-quoted weight per unit, transport mode, service level.
 *   freight_lanes    vendor → receiving warehouse distance in km, with its source
 *                    and who confirmed it. A straight-line suggestion may PREFILL
 *                    the form; only a person saves a lane.
 *   freight_rate_cards  rate per tonne-km by mode / service level / category,
 *                    maker-checker (draft → approved by someone else). Once a
 *                    card leaves draft its terms cannot change (trigger below): a
 *                    new rate is a new version with its own effective date.
 *   procurement_settings  the designated main receiving point (lanes are keyed
 *                    by warehouse; RFQs and POs carry none), and a switch for the
 *                    labelled "Assumed freight" fallback (ON — today's behaviour).
 *   procurement_award_decisions  comparison_status and recommendation_status,
 *                    separate from the award itself. Existing rows stay NULL
 *                    (recorded before §216).
 *   master_values    FREIGHT_CATEGORY: General, Fragile, Hazardous, Oversize
 *                    (shared seeds; companies may add their own).
 *
 * Rollback refuses while any weight, quoted weight, lane or rate card exists, so
 * entered data is never dropped silently.
 */
const MODES = `'road','rail','air','ship'`;
const SERVICE_LEVELS = `'FTL','LTL','FCL','LCL'`;
const BASES = `'quoted','observed','estimated','assumed'`;

export async function up(knex) {
  const check = (table, name, def) => knex.raw(`
    DO $$ BEGIN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${def});
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);

  // ── Item master ──────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS shipping_weight_kg    NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS shipping_weight_basis VARCHAR(10),
      ADD COLUMN IF NOT EXISTS shipping_weight_uom   VARCHAR(20),
      ADD COLUMN IF NOT EXISTS freight_category      VARCHAR(60)
  `);
  await check('inventory_items', 'inventory_items_shipping_weight_chk',
    `shipping_weight_kg IS NULL OR (shipping_weight_kg > 0 AND shipping_weight_basis IN (${BASES})
                                     AND shipping_weight_uom IS NOT NULL AND btrim(shipping_weight_uom) <> '')`);
  await check('inventory_items', 'inventory_items_shipping_weight_basis_chk',
    `shipping_weight_basis IS NULL OR shipping_weight_basis IN (${BASES})`);

  // ── Quotes ───────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE rfq_quotes
      ADD COLUMN IF NOT EXISTS shipping_weight_kg_per_unit NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS transport_mode              VARCHAR(10),
      ADD COLUMN IF NOT EXISTS service_level               VARCHAR(5)
  `);
  await check('rfq_quotes', 'rfq_quotes_freight_inputs_chk',
    `(shipping_weight_kg_per_unit IS NULL OR shipping_weight_kg_per_unit > 0)
     AND (transport_mode IS NULL OR transport_mode IN (${MODES}))
     AND (service_level IS NULL OR service_level IN (${SERVICE_LEVELS}))`);

  // ── Lanes ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS freight_lanes (
      id                     SERIAL PRIMARY KEY,
      company_id             INTEGER NOT NULL REFERENCES companies(id),
      vendor_id              INTEGER NOT NULL REFERENCES vendors(id),
      warehouse_id           INTEGER NOT NULL REFERENCES warehouses(id),
      distance_km            NUMERIC(10,2) NOT NULL CHECK (distance_km > 0),
      distance_source        VARCHAR(10) NOT NULL CHECK (distance_source IN ('quoted','observed','estimated','manual')),
      distance_note          TEXT,
      default_transport_mode VARCHAR(10) CHECK (default_transport_mode IN (${MODES})),
      default_service_level  VARCHAR(5)  CHECK (default_service_level IN (${SERVICE_LEVELS})),
      confirmed_by_user_id   INTEGER NOT NULL,
      confirmed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, vendor_id, warehouse_id)
    )
  `);

  // ── Rate cards ───────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS freight_rate_cards (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id),
      transport_mode      VARCHAR(10) NOT NULL CHECK (transport_mode IN (${MODES})),
      service_level       VARCHAR(5)  CHECK (service_level IN (${SERVICE_LEVELS})),
      freight_category    VARCHAR(60),
      rate_per_tonne_km   NUMERIC(14,6) NOT NULL CHECK (rate_per_tonne_km > 0),
      currency            VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      effective_from      DATE NOT NULL,
      source              VARCHAR(60),
      notes               TEXT,
      status              VARCHAR(10) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','approved','rejected','retired')),
      entered_by_user_id  INTEGER NOT NULL,
      approved_by_user_id INTEGER,
      approved_at         TIMESTAMPTZ,
      review_note         TEXT,
      retired_by_user_id  INTEGER,
      retired_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status NOT IN ('approved','retired') OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)),
      CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> entered_by_user_id)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_freight_rate_cards_lookup
      ON freight_rate_cards (company_id, transport_mode, effective_from DESC)
      WHERE status = 'approved'
  `);
  // A card's terms are frozen the moment it leaves draft. Status may move
  // (approve / reject / retire); the rate it was approved at may not.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION freight_rate_card_freeze() RETURNS trigger AS $f$
    BEGIN
      IF OLD.status <> 'draft' AND (
           NEW.rate_per_tonne_km IS DISTINCT FROM OLD.rate_per_tonne_km
        OR NEW.transport_mode    IS DISTINCT FROM OLD.transport_mode
        OR NEW.service_level     IS DISTINCT FROM OLD.service_level
        OR NEW.freight_category  IS DISTINCT FROM OLD.freight_category
        OR NEW.currency          IS DISTINCT FROM OLD.currency
        OR NEW.effective_from    IS DISTINCT FROM OLD.effective_from
        OR NEW.company_id        IS DISTINCT FROM OLD.company_id
        OR NEW.entered_by_user_id IS DISTINCT FROM OLD.entered_by_user_id) THEN
        RAISE EXCEPTION 'freight rate card % is %; its terms cannot change — create a new version', OLD.id, OLD.status
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.status IN ('rejected','retired') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'freight rate card % is % and cannot change status', OLD.id, OLD.status
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_freight_rate_card_freeze ON freight_rate_cards`);
  await knex.raw(`
    CREATE TRIGGER trg_freight_rate_card_freeze BEFORE UPDATE ON freight_rate_cards
      FOR EACH ROW EXECUTE FUNCTION freight_rate_card_freeze()
  `);

  // ── Settings ─────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD COLUMN IF NOT EXISTS main_receiving_warehouse_id INTEGER REFERENCES warehouses(id),
      ADD COLUMN IF NOT EXISTS tco_assumed_freight_enabled BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // ── Award decisions ──────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE procurement_award_decisions
      ADD COLUMN IF NOT EXISTS comparison_status     VARCHAR(12),
      ADD COLUMN IF NOT EXISTS recommendation_status VARCHAR(20)
  `);
  await check('procurement_award_decisions', 'procurement_award_decisions_comparison_status_chk',
    `comparison_status IS NULL OR comparison_status IN ('complete','provisional','incomplete')`);
  await check('procurement_award_decisions', 'procurement_award_decisions_recommendation_status_chk',
    `recommendation_status IS NULL OR recommendation_status IN ('made','provisional','withheld_incomplete','none')`);

  // ── Freight category vocabulary ──────────────────────────────────────────
  const seeds = ['General', 'Fragile', 'Hazardous', 'Oversize'];
  for (let i = 0; i < seeds.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('FREIGHT_CATEGORY', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [seeds[i], i + 1]
    );
  }
}

export async function down(knex) {
  const { rows: [n] } = await knex.raw(`
    SELECT (SELECT COUNT(*) FROM inventory_items WHERE shipping_weight_kg IS NOT NULL OR freight_category IS NOT NULL)::int AS items,
           (SELECT COUNT(*) FROM rfq_quotes WHERE shipping_weight_kg_per_unit IS NOT NULL OR transport_mode IS NOT NULL)::int AS quotes,
           (SELECT COUNT(*) FROM freight_lanes)::int AS lanes,
           (SELECT COUNT(*) FROM freight_rate_cards)::int AS cards,
           (SELECT COUNT(*) FROM procurement_settings WHERE main_receiving_warehouse_id IS NOT NULL)::int AS settings,
           (SELECT COUNT(*) FROM procurement_award_decisions WHERE comparison_status IS NOT NULL)::int AS decisions`);
  const held = Object.entries(n).filter(([, v]) => v > 0);
  if (held.length) {
    throw new Error(`Freight data exists (${held.map(([k, v]) => `${k}: ${v}`).join(', ')}); export and clear it deliberately before rolling back.`);
  }
  await knex.raw(`DELETE FROM master_values WHERE type = 'FREIGHT_CATEGORY' AND company_id IS NULL
                    AND value IN ('General','Fragile','Hazardous','Oversize')`);
  await knex.raw(`ALTER TABLE procurement_award_decisions
    DROP CONSTRAINT IF EXISTS procurement_award_decisions_comparison_status_chk,
    DROP CONSTRAINT IF EXISTS procurement_award_decisions_recommendation_status_chk,
    DROP COLUMN IF EXISTS comparison_status, DROP COLUMN IF EXISTS recommendation_status`);
  await knex.raw(`ALTER TABLE procurement_settings
    DROP COLUMN IF EXISTS main_receiving_warehouse_id, DROP COLUMN IF EXISTS tco_assumed_freight_enabled`);
  await knex.raw(`DROP TABLE IF EXISTS freight_rate_cards`);
  await knex.raw(`DROP FUNCTION IF EXISTS freight_rate_card_freeze()`);
  await knex.raw(`DROP TABLE IF EXISTS freight_lanes`);
  await knex.raw(`ALTER TABLE rfq_quotes DROP CONSTRAINT IF EXISTS rfq_quotes_freight_inputs_chk,
    DROP COLUMN IF EXISTS shipping_weight_kg_per_unit, DROP COLUMN IF EXISTS transport_mode, DROP COLUMN IF EXISTS service_level`);
  await knex.raw(`ALTER TABLE inventory_items
    DROP CONSTRAINT IF EXISTS inventory_items_shipping_weight_chk,
    DROP CONSTRAINT IF EXISTS inventory_items_shipping_weight_basis_chk,
    DROP COLUMN IF EXISTS shipping_weight_kg, DROP COLUMN IF EXISTS shipping_weight_basis,
    DROP COLUMN IF EXISTS shipping_weight_uom, DROP COLUMN IF EXISTS freight_category`);
}
