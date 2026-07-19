/**
 * Phase 44A — Production performance indexes
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
    // Stock lookups by item + warehouse (inventory hot path)
    `CREATE INDEX IF NOT EXISTS idx_stock_item_warehouse
       ON stock_entries (item_id, warehouse_id)`,

    // Attendance queries filtered by date + status (dashboard + reports)
    `CREATE INDEX IF NOT EXISTS idx_attendance_date_status
       ON attendance (attendance_date, status)`,

    // Audit log queries by user + date (audit trail, compliance)
    `CREATE INDEX IF NOT EXISTS idx_audit_user_date
       ON audit_logs (user_id, created_at DESC)`,

    // Audit log queries by module + action (admin analytics)
    `CREATE INDEX IF NOT EXISTS idx_audit_module_action_date
       ON audit_logs (module, action, created_at DESC)`,

    // Employee list filtered to active only (most pages exclude terminated)
    `CREATE INDEX IF NOT EXISTS idx_employees_active
       ON employees (company_id, is_active)
       WHERE is_active = true`,

    // Notification badge count — active unread notifications per user
    `CREATE INDEX IF NOT EXISTS idx_notifications_active
       ON notifications (user_id, is_read, created_at DESC)
       WHERE is_read = false`,
  ];

  for (const sql of indexes) {
    await knex.raw('SAVEPOINT idx_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT idx_sp');
    } catch (err) {
      await knex.raw('ROLLBACK TO SAVEPOINT idx_sp');
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[phase44] Skipped index — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  }
}

export async function down(knex) {
  const drops = [
    'DROP INDEX IF EXISTS idx_stock_item_warehouse',
    'DROP INDEX IF EXISTS idx_attendance_date_status',
    'DROP INDEX IF EXISTS idx_audit_user_date',
    'DROP INDEX IF EXISTS idx_audit_module_action_date',
    'DROP INDEX IF EXISTS idx_employees_active',
    'DROP INDEX IF EXISTS idx_notifications_active',
  ];

  for (const sql of drops) {
    await knex.raw(sql);
  }
}
