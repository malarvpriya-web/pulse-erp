export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_mktg_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── marketing_campaigns already exists (SERIAL pk from 20260426) ──────────
  // Add new columns the new routes need; old campaign_name/campaign_type stay
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS type VARCHAR(50)`);
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS target_leads INTEGER DEFAULT 0`);
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS actual_leads INTEGER DEFAULT 0`);
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);

  // Back-fill name/type aliases from old column names
  await safe(`UPDATE marketing_campaigns SET name = campaign_name WHERE name IS NULL AND campaign_name IS NOT NULL`);
  await safe(`UPDATE marketing_campaigns SET type = campaign_type WHERE type IS NULL AND campaign_type IS NOT NULL`);
  await safe(`UPDATE marketing_campaigns SET actual_leads = leads_generated WHERE actual_leads = 0 AND leads_generated > 0`);

  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_company ON marketing_campaigns(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON marketing_campaigns(company_id, status)`);

  // ── marketing_tasks (new table) ───────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS marketing_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER REFERENCES companies(id),
      campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      assigned_to INTEGER REFERENCES employees(id),
      due_date DATE,
      status VARCHAR(30) DEFAULT 'pending',
      priority VARCHAR(20) DEFAULT 'medium',
      created_by INTEGER REFERENCES employees(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_tasks_company ON marketing_tasks(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_tasks_campaign ON marketing_tasks(campaign_id)`);

  // ── marketing_deliverables (new table) ───────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS marketing_deliverables (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER REFERENCES companies(id),
      campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50),
      status VARCHAR(30) DEFAULT 'pending',
      due_date DATE,
      delivered_at TIMESTAMPTZ,
      assigned_to INTEGER REFERENCES employees(id),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_deliverables_company ON marketing_deliverables(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_deliverables_campaign ON marketing_deliverables(campaign_id)`);

  // ── marketing_pursuit_list (new table) ───────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS marketing_pursuit_list (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER REFERENCES companies(id),
      account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      account_name VARCHAR(255),
      campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
      status VARCHAR(30) DEFAULT 'targeted',
      priority VARCHAR(20) DEFAULT 'medium',
      assigned_to INTEGER REFERENCES employees(id),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_pursuit_company ON marketing_pursuit_list(company_id)`);

  // ── marketing_timesheets (new table) ─────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS marketing_timesheets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER REFERENCES companies(id),
      employee_id INTEGER REFERENCES employees(id),
      campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
      task_id UUID REFERENCES marketing_tasks(id) ON DELETE SET NULL,
      date DATE NOT NULL,
      hours NUMERIC(4,2) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_timesheets_company ON marketing_timesheets(company_id, date)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_marketing_timesheets_employee ON marketing_timesheets(employee_id)`);

  // ── marketing_settings (new table) ───────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS marketing_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id),
      default_campaign_type VARCHAR(50) DEFAULT 'email',
      fiscal_year_start INTEGER DEFAULT 4,
      budget_alert_threshold NUMERIC(5,2) DEFAULT 80,
      auto_assign_tasks BOOLEAN DEFAULT false,
      default_pursuit_priority VARCHAR(20) DEFAULT 'medium',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add campaign_id to sales_orders for Orders Won/Lost attribution
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES marketing_campaigns(id) ON DELETE SET NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sales_orders_campaign ON sales_orders(campaign_id) WHERE campaign_id IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS campaign_id`);
  await knex.raw(`DROP TABLE IF EXISTS marketing_settings CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS marketing_timesheets CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS marketing_pursuit_list CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS marketing_deliverables CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS marketing_tasks CASCADE`);
  // Don't drop marketing_campaigns — it existed before this migration
  for (const col of ['name','type','target_leads','actual_leads','owner_id','company_id']) {
    await knex.raw(`ALTER TABLE marketing_campaigns DROP COLUMN IF EXISTS ${col}`);
  }
}
