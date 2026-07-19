export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[pr_columns] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('pr add request_number',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS request_number VARCHAR(50)`);
  await safe('pr add requested_by_employee_id',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS requested_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('pr add department_id',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS department_id INTEGER`);
  await safe('pr add request_date',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS request_date DATE`);
  await safe('pr add required_date',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS required_date DATE`);
  await safe('pr add notes',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safe('pr add priority',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium'`);
  await safe('pr add approved_by',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('pr add approved_at',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await safe('pr backfill request_number from pr_number',
    `UPDATE purchase_requests SET request_number = pr_number WHERE request_number IS NULL AND pr_number IS NOT NULL`);
  await safe('idx pr requested_by',
    `CREATE INDEX IF NOT EXISTS idx_pr_requested_by ON purchase_requests(requested_by_employee_id)`);
  await safe('idx pr company_status',
    `CREATE INDEX IF NOT EXISTS idx_pr_company_status ON purchase_requests(company_id, status)`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`DROP INDEX IF EXISTS idx_pr_company_status`);
  await safe(`DROP INDEX IF EXISTS idx_pr_requested_by`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS approved_at`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS approved_by`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS priority`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS notes`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS required_date`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS request_date`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS department_id`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS requested_by_employee_id`);
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS request_number`);
}
