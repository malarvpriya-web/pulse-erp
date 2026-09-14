/**
 * Total Cost of Ownership (TCO) — the cost fields a comparison needs but no
 * table held.
 *
 * Every "which vendor is cheaper?" surface in the app ranked on `unit_price`
 * alone: the RFQ award modal badges "↓ Lowest" off the minimum unit price, and
 * Component 360's vendor table sorts by `best_price`. That is the acquisition
 * price, not the cost of owning the part. A quote 4% cheaper from a vendor with
 * a 60-day lead time, a 3% reject rate and no credit terms routinely costs more
 * than the dearer one, and nothing in the schema could express that.
 *
 * Three groups of columns:
 *
 * 1. procurement_settings — the company's costing rates (cost of capital,
 *    ordering cost, inspection cost, expediting cost …). These are the levers a
 *    buyer tunes once; the TCO engine reads them per company. Rates live here
 *    rather than in a jsonb blob so the settings PUT can validate each one and
 *    so SQL can read them without json extraction.
 *
 * 2. rfq_quotes — the adders a vendor actually quotes: freight, insurance,
 *    duty, packaging, one-time tooling, other charges, plus warranty months and
 *    a price-validity date. Without these every landed-cost element had to be
 *    *modelled*, so the comparison could never tell a quoted ₹5,000 freight
 *    apart from an assumed one.
 *
 * 3. item_vendor_prices — the same adders on the negotiated price book, so a
 *    book price and a fresh quote are comparable on the same basis.
 *
 * Nothing is NOT NULL and nothing has a non-zero default on the quote tables:
 * a NULL adder means "not quoted" and the engine falls back to an estimate that
 * it labels as such. A 0 default would have silently asserted "freight is free".
 */

export async function up(knex) {
  // ── 1. Company costing rates ────────────────────────────────────────────
  // Defaults are the ones the engine also hard-codes, so a company that never
  // opens the settings page still gets a defensible model rather than zeros.
  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD COLUMN IF NOT EXISTS tco_enabled                  BOOLEAN       NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS cost_of_capital_pct          NUMERIC(6,3)  NOT NULL DEFAULT 12,
      ADD COLUMN IF NOT EXISTS inventory_carrying_pct       NUMERIC(6,3)  NOT NULL DEFAULT 18,
      ADD COLUMN IF NOT EXISTS ordering_cost_per_po         NUMERIC(14,2) NOT NULL DEFAULT 750,
      ADD COLUMN IF NOT EXISTS inspection_cost_per_receipt  NUMERIC(14,2) NOT NULL DEFAULT 500,
      ADD COLUMN IF NOT EXISTS expedite_cost_per_late_order NUMERIC(14,2) NOT NULL DEFAULT 2500,
      ADD COLUMN IF NOT EXISTS rework_cost_pct              NUMERIC(6,3)  NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS default_freight_pct          NUMERIC(6,3)  NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS gst_input_credit_pct         NUMERIC(6,3)  NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS single_source_risk_pct       NUMERIC(6,3)  NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS service_level_z              NUMERIC(6,3)  NOT NULL DEFAULT 1.65,
      ADD COLUMN IF NOT EXISTS tco_horizon_months           INTEGER       NOT NULL DEFAULT 12
  `);

  // Percentages are rates, not amounts — a negative or a 900% carrying cost is
  // a typo, and it would swing every ranking on the page.
  const rateCheck = async (col, max) => {
    await knex.raw(`
      ALTER TABLE procurement_settings
        ADD CONSTRAINT procurement_settings_${col}_range CHECK (${col} >= 0 AND ${col} <= ${max})
    `).catch(() => {});
  };
  for (const c of ['cost_of_capital_pct', 'inventory_carrying_pct', 'rework_cost_pct',
                   'default_freight_pct', 'gst_input_credit_pct', 'single_source_risk_pct']) {
    await rateCheck(c, 100);
  }
  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD CONSTRAINT procurement_settings_tco_horizon_range
      CHECK (tco_horizon_months >= 1 AND tco_horizon_months <= 120)
  `).catch(() => {});

  // ── 2. Quoted cost adders on RFQ quotes ─────────────────────────────────
  await knex.raw(`
    ALTER TABLE rfq_quotes
      ADD COLUMN IF NOT EXISTS freight_amount    NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS insurance_amount  NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS duty_amount       NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS packaging_amount  NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS other_charges     NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS tooling_cost      NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS tax_pct           NUMERIC(6,3),
      ADD COLUMN IF NOT EXISTS warranty_months   INTEGER,
      ADD COLUMN IF NOT EXISTS moq               NUMERIC(14,3),
      ADD COLUMN IF NOT EXISTS currency          VARCHAR(3),
      ADD COLUMN IF NOT EXISTS valid_until       DATE
  `);

  // ── 3. The same adders on the negotiated price book ─────────────────────
  // item_vendor_prices already carries unit_price/discount_pct/tax_pct/moq/
  // pack_size/lead_time_days — only the landed-cost and quality adders are new.
  await knex.raw(`
    ALTER TABLE item_vendor_prices
      ADD COLUMN IF NOT EXISTS freight_per_unit   NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS packaging_per_unit NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS duty_pct           NUMERIC(6,3),
      ADD COLUMN IF NOT EXISTS tooling_cost       NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS scrap_rate_pct     NUMERIC(6,3),
      ADD COLUMN IF NOT EXISTS warranty_months    INTEGER
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE procurement_settings
      DROP COLUMN IF EXISTS tco_enabled,
      DROP COLUMN IF EXISTS cost_of_capital_pct,
      DROP COLUMN IF EXISTS inventory_carrying_pct,
      DROP COLUMN IF EXISTS ordering_cost_per_po,
      DROP COLUMN IF EXISTS inspection_cost_per_receipt,
      DROP COLUMN IF EXISTS expedite_cost_per_late_order,
      DROP COLUMN IF EXISTS rework_cost_pct,
      DROP COLUMN IF EXISTS default_freight_pct,
      DROP COLUMN IF EXISTS gst_input_credit_pct,
      DROP COLUMN IF EXISTS single_source_risk_pct,
      DROP COLUMN IF EXISTS service_level_z,
      DROP COLUMN IF EXISTS tco_horizon_months
  `);
  await knex.raw(`
    ALTER TABLE rfq_quotes
      DROP COLUMN IF EXISTS freight_amount,   DROP COLUMN IF EXISTS insurance_amount,
      DROP COLUMN IF EXISTS duty_amount,      DROP COLUMN IF EXISTS packaging_amount,
      DROP COLUMN IF EXISTS other_charges,    DROP COLUMN IF EXISTS tooling_cost,
      DROP COLUMN IF EXISTS tax_pct,          DROP COLUMN IF EXISTS warranty_months,
      DROP COLUMN IF EXISTS moq,              DROP COLUMN IF EXISTS currency,
      DROP COLUMN IF EXISTS valid_until
  `);
  await knex.raw(`
    ALTER TABLE item_vendor_prices
      DROP COLUMN IF EXISTS freight_per_unit,   DROP COLUMN IF EXISTS packaging_per_unit,
      DROP COLUMN IF EXISTS duty_pct,           DROP COLUMN IF EXISTS tooling_cost,
      DROP COLUMN IF EXISTS scrap_rate_pct,     DROP COLUMN IF EXISTS warranty_months
  `);
}
