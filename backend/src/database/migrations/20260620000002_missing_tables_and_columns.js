export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[missing_tables] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  // ── 1. journal_entries: add status column (is_posted was used before) ──────
  await safe('je add status',
    `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS status VARCHAR(20)`);
  await safe('je backfill status',
    `UPDATE journal_entries SET status = CASE WHEN is_posted THEN 'posted' ELSE 'draft' END WHERE status IS NULL`);
  await safe('je status default',
    `ALTER TABLE journal_entries ALTER COLUMN status SET DEFAULT 'draft'`);
  await safe('idx je status',
    `CREATE INDEX IF NOT EXISTS idx_je_status ON journal_entries(status)`);
  await safe('idx je status_company',
    `CREATE INDEX IF NOT EXISTS idx_je_status_company ON journal_entries(company_id, status)`);

  // ── 2. opportunities: add closed_date column ─────────────────────────────
  await safe('opp add closed_date',
    `ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS closed_date TIMESTAMPTZ`);
  await safe('idx opp closed_date',
    `CREATE INDEX IF NOT EXISTS idx_opp_closed_date ON opportunities(closed_date)`);

  // ── 3. timesheet_entries: add missing columns ────────────────────────────
  await safe('te add employee_id',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('te add work_date',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS work_date DATE`);
  await safe('te add hours_worked',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS hours_worked NUMERIC(6,2)`);
  await safe('te add description',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS description TEXT`);
  await safe('te add is_billable',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS is_billable BOOLEAN DEFAULT false`);
  await safe('te add status',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft'`);
  await safe('te add deleted_at',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await safe('te add task_id',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
  await safe('te add submitted_at',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
  await safe('te add approved_at',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await safe('te add approved_by',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('te add rejection_reason',
    `ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
  // Backfill from existing data
  await safe('te backfill employee_id from timesheets',
    `UPDATE timesheet_entries te
     SET employee_id = t.employee_id
     FROM timesheets t
     WHERE t.id = te.timesheet_id AND te.employee_id IS NULL`);
  await safe('te backfill work_date from entry_date',
    `UPDATE timesheet_entries SET work_date = entry_date WHERE work_date IS NULL AND entry_date IS NOT NULL`);
  await safe('te backfill hours_worked from hours',
    `UPDATE timesheet_entries SET hours_worked = hours WHERE hours_worked IS NULL AND hours IS NOT NULL`);
  await safe('te backfill description from task_description',
    `UPDATE timesheet_entries SET description = task_description WHERE description IS NULL AND task_description IS NOT NULL`);
  await safe('te backfill is_billable from billable',
    `UPDATE timesheet_entries SET is_billable = billable WHERE is_billable IS NULL AND billable IS NOT NULL`);
  await safe('idx te employee_id',
    `CREATE INDEX IF NOT EXISTS idx_te_employee_id ON timesheet_entries(employee_id)`);
  await safe('idx te work_date',
    `CREATE INDEX IF NOT EXISTS idx_te_work_date ON timesheet_entries(work_date)`);
  await safe('idx te company_status',
    `CREATE INDEX IF NOT EXISTS idx_te_company_status ON timesheet_entries(company_id, status)`);

  // ── 4. quotations table ──────────────────────────────────────────────────
  await safe('create quotations', `
    CREATE TABLE IF NOT EXISTS quotations (
      id                SERIAL PRIMARY KEY,
      quotation_number  VARCHAR(50) UNIQUE NOT NULL,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id       UUID REFERENCES parties(id) ON DELETE SET NULL,
      customer_name     VARCHAR(255),
      opportunity_id    INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
      quotation_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      validity_date     DATE,
      status            VARCHAR(30) DEFAULT 'draft',
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      version           INTEGER DEFAULT 1,
      parent_id         INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
      original_id       INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
      subtotal          NUMERIC(15,2) DEFAULT 0,
      tax_amount        NUMERIC(15,2) DEFAULT 0,
      total_amount      NUMERIC(15,2) DEFAULT 0,
      drive_file_id     VARCHAR(255),
      drive_link        TEXT,
      drive_folder_id   VARCHAR(255),
      deleted_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('create quotation_items', `
    CREATE TABLE IF NOT EXISTS quotation_items (
      id              SERIAL PRIMARY KEY,
      quotation_id    INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
      item_code       VARCHAR(100),
      description     TEXT,
      quantity        NUMERIC(12,3) DEFAULT 1,
      unit            VARCHAR(30),
      unit_price      NUMERIC(15,2) DEFAULT 0,
      discount_pct    NUMERIC(5,2)  DEFAULT 0,
      tax_rate        NUMERIC(5,2)  DEFAULT 0,
      tax_amount      NUMERIC(15,2) DEFAULT 0,
      total_amount    NUMERIC(15,2) DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('idx quotations company',
    `CREATE INDEX IF NOT EXISTS idx_quotations_company ON quotations(company_id)`);
  await safe('idx quotations status',
    `CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status)`);
  await safe('idx quotations customer',
    `CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id)`);

  // ── 5. sales_orders table ────────────────────────────────────────────────
  await safe('create sales_orders', `
    CREATE TABLE IF NOT EXISTS sales_orders (
      id              SERIAL PRIMARY KEY,
      order_number    VARCHAR(50) UNIQUE NOT NULL,
      quotation_id    INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id     UUID REFERENCES parties(id) ON DELETE SET NULL,
      customer_name   VARCHAR(255),
      order_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      delivery_date   DATE,
      order_status    VARCHAR(30) DEFAULT 'draft',
      notes           TEXT,
      carrier         VARCHAR(100),
      tracking_number VARCHAR(100),
      subtotal        NUMERIC(15,2) DEFAULT 0,
      tax_amount      NUMERIC(15,2) DEFAULT 0,
      total_amount    NUMERIC(15,2) DEFAULT 0,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('create sales_order_items', `
    CREATE TABLE IF NOT EXISTS sales_order_items (
      id            SERIAL PRIMARY KEY,
      order_id      INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      item_code     VARCHAR(100),
      description   TEXT,
      quantity      NUMERIC(12,3) DEFAULT 1,
      unit          VARCHAR(30),
      unit_price    NUMERIC(15,2) DEFAULT 0,
      discount_pct  NUMERIC(5,2)  DEFAULT 0,
      tax_rate      NUMERIC(5,2)  DEFAULT 0,
      tax_amount    NUMERIC(15,2) DEFAULT 0,
      total_amount  NUMERIC(15,2) DEFAULT 0,
      fulfilled_qty NUMERIC(12,3) DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('idx sales_orders company',
    `CREATE INDEX IF NOT EXISTS idx_so_company ON sales_orders(company_id)`);
  await safe('idx sales_orders status',
    `CREATE INDEX IF NOT EXISTS idx_so_status ON sales_orders(order_status)`);
  await safe('idx sales_orders customer',
    `CREATE INDEX IF NOT EXISTS idx_so_customer ON sales_orders(customer_id)`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`DROP INDEX IF EXISTS idx_so_customer`);
  await safe(`DROP INDEX IF EXISTS idx_so_status`);
  await safe(`DROP INDEX IF EXISTS idx_so_company`);
  await safe(`DROP TABLE IF EXISTS sales_order_items`);
  await safe(`DROP TABLE IF EXISTS sales_orders`);
  await safe(`DROP INDEX IF EXISTS idx_quotations_customer`);
  await safe(`DROP INDEX IF EXISTS idx_quotations_status`);
  await safe(`DROP INDEX IF EXISTS idx_quotations_company`);
  await safe(`DROP TABLE IF EXISTS quotation_items`);
  await safe(`DROP TABLE IF EXISTS quotations`);
  await safe(`DROP INDEX IF EXISTS idx_te_company_status`);
  await safe(`DROP INDEX IF EXISTS idx_te_work_date`);
  await safe(`DROP INDEX IF EXISTS idx_te_employee_id`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS rejection_reason`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS approved_by`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS approved_at`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS submitted_at`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS task_id`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS deleted_at`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS status`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS is_billable`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS description`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS hours_worked`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS work_date`);
  await safe(`ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS employee_id`);
  await safe(`ALTER TABLE opportunities DROP COLUMN IF EXISTS closed_date`);
  await safe(`DROP INDEX IF EXISTS idx_je_status_company`);
  await safe(`DROP INDEX IF EXISTS idx_je_status`);
  await safe(`ALTER TABLE journal_entries DROP COLUMN IF EXISTS status`);
}
