/**
 * 20260601000007_contract_labour_enhancements.js
 *
 * Adds missing compliance columns to contract_labour:
 *   branch             — deployment site/plant
 *   aadhar_number      — mandatory for CLRA worker identity
 *   safety_cert_expiry — tracks when safety cert expires (not just boolean)
 *   pf_member          — PF enrollment status
 *   esi_covered        — ESI coverage status
 *   contact_phone      — worker's contact number
 *   notes              — compliance notes / special instructions
 *
 * Fixes: branch and aadhar were in the UI form but missing from the table,
 * causing silent data loss on every save since Phase 32.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE contract_labour
      ADD COLUMN IF NOT EXISTS branch             VARCHAR(100),
      ADD COLUMN IF NOT EXISTS aadhar_number      VARCHAR(20),
      ADD COLUMN IF NOT EXISTS safety_cert_expiry DATE,
      ADD COLUMN IF NOT EXISTS pf_member          BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS esi_covered        BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS contact_phone      VARCHAR(20),
      ADD COLUMN IF NOT EXISTS notes              TEXT
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cl_company_active ON contract_labour(company_id, is_active)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cl_safety_cert    ON contract_labour(company_id, safety_certified)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cl_cert_expiry    ON contract_labour(safety_cert_expiry) WHERE safety_cert_expiry IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE contract_labour
      DROP COLUMN IF EXISTS branch,
      DROP COLUMN IF EXISTS aadhar_number,
      DROP COLUMN IF EXISTS safety_cert_expiry,
      DROP COLUMN IF EXISTS pf_member,
      DROP COLUMN IF EXISTS esi_covered,
      DROP COLUMN IF EXISTS contact_phone,
      DROP COLUMN IF EXISTS notes
  `);
  await knex.raw(`DROP INDEX IF EXISTS idx_cl_company_active`);
  await knex.raw(`DROP INDEX IF EXISTS idx_cl_safety_cert`);
  await knex.raw(`DROP INDEX IF EXISTS idx_cl_cert_expiry`);
}
