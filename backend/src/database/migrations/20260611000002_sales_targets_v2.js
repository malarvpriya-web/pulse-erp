export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_stv2_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|multiple primary/i.test(err.message || '')) throw err;
    }
  };

  // Ensure the table exists (handles fresh installs)
  await safe(`
    CREATE TABLE IF NOT EXISTS sales_targets (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER,
      owner_id      INTEGER REFERENCES employees(id),
      period_type   VARCHAR(20),
      period_year   INTEGER,
      period_value  INTEGER,
      target_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
      achieved_amount NUMERIC(15,2) DEFAULT 0,
      currency      VARCHAR(10) DEFAULT 'INR',
      notes         TEXT,
      created_by    INTEGER REFERENCES employees(id),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add columns to existing installations
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES employees(id)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_type VARCHAR(20)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_year INTEGER`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_value INTEGER`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR'`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES employees(id)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // Migrate old employee_id → owner_id where owner_id is still null
  await safe(`UPDATE sales_targets SET owner_id = employee_id WHERE owner_id IS NULL AND employee_id IS NOT NULL`);

  // Drop old unique constraint that used (employee_id, month)
  await safe(`ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_employee_id_month_key`);
  await safe(`ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_employee_id_period_key`);

  // New unique constraint for upsert: (company_id, owner_id, period_type, period_year, period_value)
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_targets_v2
    ON sales_targets(company_id, owner_id, period_type, period_year, period_value)
  `);

  // Performance index
  await safe(`CREATE INDEX IF NOT EXISTS idx_sales_targets_company ON sales_targets(company_id)`);
}

export async function down(knex) {}
