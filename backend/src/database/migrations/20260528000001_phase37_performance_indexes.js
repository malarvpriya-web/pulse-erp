/**
 * 20260528000001_phase37_performance_indexes.js
 *
 * Phase 37J — Performance & reliability hardening
 *
 * Adds compound / covering indexes for the highest-traffic query patterns.
 * Each index is applied individually and wrapped in try/catch so a missing
 * column (e.g. company_id not yet added by a later migration) skips gracefully
 * rather than aborting the whole migration.
 *
 * ALL statements use CREATE INDEX IF NOT EXISTS — idempotent on re-run.
 */

export async function up(knex) {
  const tryIndex = async (sql) => {
    await knex.raw('SAVEPOINT idx_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT idx_sp');
    } catch (err) {
      await knex.raw('ROLLBACK TO SAVEPOINT idx_sp');
      if (err.message && (err.message.includes('does not exist') || err.message.includes('already exists'))) {
        console.warn(`[phase37] Skipped index — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  // ── attendance_records ────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_att_records_emp_date
      ON attendance_records(employee_id, attendance_date)
  `);

  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_att_records_company_date
      ON attendance_records(company_id, attendance_date)
  `);

  // ── notifications ─────────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications(user_id, is_read, created_at DESC)
      WHERE is_read = false
  `);

  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_notifications_company
      ON notifications(company_id, created_at DESC)
  `);

  // ── audit_logs ────────────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_audit_user_time
      ON audit_logs(user_id, created_at DESC)
  `);

  // ── approvals ─────────────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_approvals_company_status
      ON approvals(company_id, status, created_at DESC)
  `);

  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_approvals_entity
      ON approvals(entity_id, entity_type)
  `);

  // ── leave_applications ────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_leave_apps_emp_status
      ON leave_applications(employee_id, status)
  `);

  // ── payroll_records ───────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_payroll_emp_month
      ON payroll_records(employee_id, payroll_month, payroll_year)
  `);

  // ── employees ─────────────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_employees_company_status
      ON employees(company_id, status)
      WHERE deleted_at IS NULL
  `);

  // ── projects ─────────────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_projects_company_status
      ON projects(company_id, status)
  `);

  // ── support_tickets ───────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_tickets_company_status
      ON support_tickets(company_id, status)
  `);

  // ── crm_leads / opportunities ─────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_leads_company_status
      ON leads(company_id, status)
  `);

  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_opportunities_company_stage
      ON opportunities(company_id, stage)
  `);

  // ── production_orders ─────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_prod_orders_company_status
      ON production_orders(company_id, status)
  `);

  // ── inventory_items ───────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_inv_items_company_stock
      ON inventory_items(company_id, current_stock, reorder_point)
  `);

  // ── workflow_instances ────────────────────────────────────────────────────
  await tryIndex(`
    CREATE INDEX IF NOT EXISTS idx_wf_inst_active
      ON workflow_instances(module, entity_id, status)
      WHERE status = 'active'
  `);
}

export async function down(knex) {
  const indexes = [
    'idx_att_records_emp_date',
    'idx_att_records_company_date',
    'idx_notifications_user_unread',
    'idx_notifications_company',
    'idx_audit_user_time',
    'idx_approvals_company_status',
    'idx_approvals_entity',
    'idx_leave_apps_emp_status',
    'idx_payroll_emp_month',
    'idx_employees_company_status',
    'idx_projects_company_status',
    'idx_tickets_company_status',
    'idx_leads_company_status',
    'idx_opportunities_company_stage',
    'idx_prod_orders_company_status',
    'idx_inv_items_company_stock',
    'idx_wf_inst_active',
  ];
  for (const idx of indexes) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
}
