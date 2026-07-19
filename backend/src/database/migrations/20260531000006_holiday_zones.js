export async function up(knex) {
  // companies.id is INTEGER — use INTEGER FK, not UUID
  await knex.raw(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES master_zones(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES master_zones(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_holidays_company_date ON holidays (company_id, date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_holidays_zone_id ON holidays (zone_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_employees_zone_id ON employees (zone_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_holidays_company_date`);
  await knex.raw(`DROP INDEX IF EXISTS idx_holidays_zone_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_employees_zone_id`);
  await knex.raw(`ALTER TABLE holidays  DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE holidays  DROP COLUMN IF EXISTS zone_id`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS zone_id`);
}
