export async function up(knex) {
  // Add company_id to all pricing tables (they were created without it)
  await knex.raw(`ALTER TABLE price_lists           ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await knex.raw(`ALTER TABLE discount_rules        ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await knex.raw(`ALTER TABLE promotions            ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await knex.raw(`ALTER TABLE discount_approvals    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await knex.raw(`ALTER TABLE price_change_log      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);

  // Add created_by to price_lists for audit trail
  await knex.raw(`ALTER TABLE price_lists ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES employees(id)`);

  // Performance indexes
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_lists_company       ON price_lists(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_discount_rules_company    ON discount_rules(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_promotions_company        ON promotions(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_change_log_company  ON price_change_log(company_id)`);

  // Seed Standard Price List for Manifest Technologies (idempotent)
  await knex.raw(`
    INSERT INTO price_lists (company_id, name, currency, applicable_to, is_default, is_active, created_at)
    SELECT c.id, 'Standard Price List', 'INR', 'all', true, true, NOW()
    FROM companies c
    WHERE c.name = 'Manifest Technologies'
      AND NOT EXISTS (
        SELECT 1 FROM price_lists pl
        WHERE pl.company_id = c.id AND pl.is_default = true
      )
    LIMIT 1
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE price_lists        DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE price_lists        DROP COLUMN IF EXISTS created_by`);
  await knex.raw(`ALTER TABLE discount_rules     DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE promotions         DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE discount_approvals DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE price_change_log   DROP COLUMN IF EXISTS company_id`);
}
