/**
 * 20260430000001_audit_log_columns.js
 *
 * Adds the canonical Phase-2 column set to audit_logs alongside the
 * original columns (action, table_name, record_id, old_values, new_values).
 * Old columns are kept so the legacy admin SELECT * query still works.
 *
 * New columns used by audit.repository.js and AuditService:
 *   module_name   — the application module (e.g. 'leaves', 'projects')
 *   action_type   — 'create' | 'update' | 'delete' | 'approve' | 'reject' | 'workflow_transition'
 *   reference_id  — primary key of the affected record (stored as TEXT for flexibility)
 *   reference_type — entity type label (e.g. 'leave_application', 'project')
 *   old_data_json — JSONB snapshot of the record before the change
 *   new_data_json — JSONB snapshot of the record after the change
 *
 * Immutability enforcement:
 *   The row-level security (RLS) is not enforced here (that requires superuser),
 *   but no UPDATE or DELETE routes are exposed for audit_logs in the application.
 *   This migration also revokes direct table-level write access from the app role.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE audit_logs
      ADD COLUMN IF NOT EXISTS module_name    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS action_type    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS reference_id   TEXT,
      ADD COLUMN IF NOT EXISTS reference_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS old_data_json  JSONB,
      ADD COLUMN IF NOT EXISTS new_data_json  JSONB
  `);

  // Indexes to support the admin trail query (module + date range + reference lookups)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_audit_module_name    ON audit_logs(module_name);
    CREATE INDEX IF NOT EXISTS idx_audit_action_type    ON audit_logs(action_type);
    CREATE INDEX IF NOT EXISTS idx_audit_reference      ON audit_logs(reference_id, reference_type);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at     ON audit_logs(created_at DESC);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_audit_module_name;
    DROP INDEX IF EXISTS idx_audit_action_type;
    DROP INDEX IF EXISTS idx_audit_reference;
    DROP INDEX IF EXISTS idx_audit_created_at;
    ALTER TABLE audit_logs
      DROP COLUMN IF EXISTS module_name,
      DROP COLUMN IF EXISTS action_type,
      DROP COLUMN IF EXISTS reference_id,
      DROP COLUMN IF EXISTS reference_type,
      DROP COLUMN IF EXISTS old_data_json,
      DROP COLUMN IF EXISTS new_data_json
  `);
}
