/**
 * Phase 47 — Performance indexes for high-traffic query paths
 *
 * Uses plain CREATE INDEX (no CONCURRENTLY) because the migration runner
 * wraps each migration in an explicit transaction block, and CONCURRENTLY
 * is incompatible with transaction blocks.
 *
 * Each index is applied individually so a missing table on a partial install
 * skips gracefully rather than aborting the whole migration.
 */
export async function up(knex) {
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_sales_orders_company_status
       ON sales_orders(company_id, order_status, order_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_quotations_company_status
       ON quotations(company_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_production_orders_company_status
       ON production_orders(company_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_lifecycle_company_stage
       ON lifecycle_instances(company_id, current_stage, status)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_created
       ON notifications(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_company_status
       ON leads(company_id, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_opportunities_company_stage
       ON crm_opportunities(company_id, stage, created_at DESC)`,
  ];

  for (const sql of indexes) {
    await knex.raw('SAVEPOINT idx_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT idx_sp');
    } catch (err) {
      await knex.raw('ROLLBACK TO SAVEPOINT idx_sp');
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[phase47] Skipped index — table not found: ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  }
}

export async function down(knex) {
  const drops = [
    'DROP INDEX IF EXISTS idx_sales_orders_company_status',
    'DROP INDEX IF EXISTS idx_quotations_company_status',
    'DROP INDEX IF EXISTS idx_production_orders_company_status',
    'DROP INDEX IF EXISTS idx_lifecycle_company_stage',
    'DROP INDEX IF EXISTS idx_notifications_user_created',
    'DROP INDEX IF EXISTS idx_leads_company_status',
    'DROP INDEX IF EXISTS idx_opportunities_company_stage',
  ];

  for (const sql of drops) {
    await knex.raw(sql);
  }
}
