/**
 * 20260527000001_leave_l2_approval.js
 * Adds L2 (second-level manager) approval to leave_applications.
 * Flow: Employee → L1 Manager → L2 Approver → L3 HR
 */

export async function up(knex) {
  await knex.raw(`
    -- Add L2 approver columns
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS l2_approver_id       INTEGER REFERENCES employees(id),
      ADD COLUMN IF NOT EXISTS l2_status            VARCHAR(20) DEFAULT 'pending'
                                                     CHECK (l2_status IN ('pending','approved','rejected')),
      ADD COLUMN IF NOT EXISTS l2_comments          TEXT,
      ADD COLUMN IF NOT EXISTS l2_approved_at       TIMESTAMP;

    -- Allow approval_level 3 in history (was 1,2 only)
    ALTER TABLE leave_approval_history
      DROP CONSTRAINT IF EXISTS leave_approval_history_approval_level_check;

    ALTER TABLE leave_approval_history
      ADD CONSTRAINT leave_approval_history_approval_level_check
      CHECK (approval_level IN (1, 2, 3));

    -- Index for efficient L2 queue queries
    CREATE INDEX IF NOT EXISTS idx_leave_applications_l2_status
      ON leave_applications(l2_status);

    -- Backfill: existing approved/rejected records skip L2
    UPDATE leave_applications
       SET l2_status = 'approved'
     WHERE status IN ('approved','rejected')
       AND l2_status = 'pending';
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_leave_applications_l2_status;

    ALTER TABLE leave_applications
      DROP COLUMN IF EXISTS l2_approver_id,
      DROP COLUMN IF EXISTS l2_status,
      DROP COLUMN IF EXISTS l2_comments,
      DROP COLUMN IF EXISTS l2_approved_at;

    ALTER TABLE leave_approval_history
      DROP CONSTRAINT IF EXISTS leave_approval_history_approval_level_check;

    ALTER TABLE leave_approval_history
      ADD CONSTRAINT leave_approval_history_approval_level_check
      CHECK (approval_level IN (1, 2));
  `);
}
