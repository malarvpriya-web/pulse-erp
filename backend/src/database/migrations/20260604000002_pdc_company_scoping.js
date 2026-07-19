export async function up(knex) {
  // Add company_id and deposit_date to pdc_register
  await knex.raw(`
    ALTER TABLE pdc_register
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS deposit_date DATE,
      ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pdc_register_company ON pdc_register(company_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pdc_register_status_date ON pdc_register(company_id, status, cheque_date)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE pdc_register
      DROP COLUMN IF EXISTS company_id,
      DROP COLUMN IF EXISTS deposit_date,
      DROP COLUMN IF EXISTS bank_name
  `);
}
