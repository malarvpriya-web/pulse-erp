/**
 * 20260618000005_gst_karnataka_defaults.js
 *
 * 1. Fix sales_settings schema (was created with UUID ids — should be INTEGER)
 * 2. Update Manifest Technologies as Karnataka entity in companies
 * 3. Seed default sales_settings for Manifest
 */
export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_gst_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = (err.message || '') + (err.code || '');
      if (!/does not exist|already exists|duplicate|42804|42P07/i.test(msg)) throw err;
      console.warn(`[gst_karnataka] skip (${label}): ${(err.message||'').split('\n')[0]}`);
    }
  };

  // Fix schema: recreate sales_settings with correct INTEGER types (was UUID, table is empty)
  await safe('recreate sales_settings with correct types', `
    DO $$
    BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_name='sales_settings' AND column_name='company_id') = 'uuid' THEN
        DROP TABLE IF EXISTS sales_settings;
        CREATE TABLE sales_settings (
          id                        SERIAL PRIMARY KEY,
          company_id                INTEGER NOT NULL UNIQUE REFERENCES companies(id),
          default_currency          VARCHAR(10)  DEFAULT 'INR',
          quotation_validity_days   INTEGER      DEFAULT 30,
          order_prefix              VARCHAR(20)  DEFAULT 'SO',
          quotation_prefix          VARCHAR(20)  DEFAULT 'QUO',
          default_tax_rate          NUMERIC(5,2) DEFAULT 18,
          default_place_of_supply   VARCHAR(100),
          auto_invoice_on_delivery  BOOLEAN      DEFAULT false,
          fiscal_year_start         INTEGER      DEFAULT 4,
          require_approval_above    NUMERIC(15,2),
          created_at                TIMESTAMPTZ  DEFAULT NOW()
        );
      END IF;
    END$$
  `);

  // Ensure state columns exist on companies
  await safe('companies state_code col',
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS state_code VARCHAR(5)`);
  await safe('companies place_of_supply col',
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(100)`);

  // Update Manifest Technologies company record
  await safe('update manifest company', `
    UPDATE companies
    SET
      state           = 'Karnataka',
      state_code      = '29',
      city            = 'Bangalore',
      gstin           = '29AABCM1234A1Z5',
      place_of_supply = 'Karnataka',
      updated_at      = NOW()
    WHERE LOWER(name) LIKE '%manifest%'
  `);

  // Seed default sales_settings for Manifest if none exist
  await safe('seed sales_settings for manifest', `
    INSERT INTO sales_settings
      (company_id, default_currency, quotation_validity_days, order_prefix, quotation_prefix,
       default_tax_rate, default_place_of_supply, auto_invoice_on_delivery, fiscal_year_start)
    SELECT id, 'INR', 30, 'SO', 'QUO', 18, 'Karnataka', false, 4
    FROM companies
    WHERE LOWER(name) LIKE '%manifest%'
    ON CONFLICT (company_id) DO UPDATE
      SET default_place_of_supply = 'Karnataka'
  `);
}

export async function down(knex) {
  // Intentionally empty — data corrections not safely reversible
}
