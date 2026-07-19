/**
 * Migration: Add company_id to all budget tables + fix budget_alerts schema.
 * Budget tables were created without multi-tenant scoping.
 */

export async function up(knex) {
  const tryAlter = (sql) => knex.raw(sql).catch(() => {});

  // Add company_id to all budget tables
  await tryAlter(`ALTER TABLE budgets           ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE budget_actuals    ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE budget_alerts     ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Fix budget_alerts — actuals endpoint inserts category/current_pct/budgeted/actual/is_read
  // but the original CREATE TABLE only had threshold_pct and is_active
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS category     VARCHAR(100)`);
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS current_pct  NUMERIC(5,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS budgeted     NUMERIC(15,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS actual       NUMERIC(15,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS is_read      BOOLEAN DEFAULT false`);
  await tryAlter(`ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS alert_type   VARCHAR(50) DEFAULT 'threshold'`);

  // Performance indexes
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_budgets_company_fy
    ON budgets(company_id, financial_year, status)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_budget_actuals_company
    ON budget_actuals(budget_id, company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_budget_alerts_company
    ON budget_alerts(company_id, is_read)`);
}

export async function down(knex) {
  const tryAlter = (sql) => knex.raw(sql).catch(() => {});
  await tryAlter(`ALTER TABLE budgets           DROP COLUMN IF EXISTS company_id`);
  await tryAlter(`ALTER TABLE budget_line_items DROP COLUMN IF EXISTS company_id`);
  await tryAlter(`ALTER TABLE budget_actuals    DROP COLUMN IF EXISTS company_id`);
  await tryAlter(`ALTER TABLE budget_alerts     DROP COLUMN IF EXISTS company_id`);
}
