/**
 * 20261028000012 — Biometric & Access Control: the columns and constraints the
 * workflows need to be honest. See MODULE_FEATURE_CONNECTION_MANUAL.md §197.
 *
 * biometric_devices
 *   · status_checked_at — WHEN `status` was last established by a real test or
 *     sync. The five dev-seed devices carry status 'online' written by the seed
 *     on 2026-04-05 and never re-checked; without a timestamp the page painted
 *     that as a live green dot. NULL now reads as "never verified".
 *   · last_error — the last test/sync failure, so the row can say why.
 *   · updated_at — the /test and /sync handlers have always written
 *     `updated_at=NOW()`, and the column did not exist, so a REACHABLE device's
 *     test answered 500 and a sync that had already written punches answered
 *     500 (its own error-path UPDATE failed too, silently).
 *
 * biometric_logs
 *   · Every writer used `ON CONFLICT DO NOTHING`, and there was no unique
 *     constraint for it to conflict on, so re-importing a CSV or re-syncing a
 *     device duplicated every punch. One punch per employee per instant; an
 *     unmatched device punch is keyed on the device user id it came with.
 *
 * gate_passes
 *   · approved_at / cancelled_* / completed_* — the lifecycle had one stored
 *     transition (pending → approved) and the page rendered colours for
 *     active/expired/cancelled that nothing could ever produce.
 *   · CHECKs: a window must run forwards; status is a known value ('active' is
 *     kept because the five SEED rows carry it).
 *
 * visitors
 *   · CHECK check_out_time >= check_in_time. The SEED rows have equal times,
 *     which satisfies it — they are not touched.
 *
 * Every CHECK was measured against live data before being written: all rows
 * satisfy them (5 gate passes, 5 visitors, 5 punches, no duplicates).
 *
 * Rollback: down() drops exactly what up() adds.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS status_checked_at timestamptz;
    ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS last_error        text;
    ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS updated_at        timestamptz;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_bio_logs_employee_punch
      ON biometric_logs (employee_id, punch_time)
      WHERE employee_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bio_logs_unmatched_punch
      ON biometric_logs (device_id, (raw_data->>'devUserId'), punch_time)
      WHERE employee_id IS NULL;

    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS approved_at   timestamptz;
    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS cancelled_by  integer;
    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS cancel_reason text;
    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS completed_at  timestamptz;
    ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS completed_by  integer;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gate_passes_window_forward') THEN
        ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_window_forward
          CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gate_passes_status_known') THEN
        ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_status_known
          CHECK (status IN ('pending', 'approved', 'active', 'cancelled', 'completed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitors_checkout_after_checkin') THEN
        ALTER TABLE visitors ADD CONSTRAINT visitors_checkout_after_checkin
          CHECK (check_out_time IS NULL OR check_in_time IS NULL OR check_out_time >= check_in_time);
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE visitors    DROP CONSTRAINT IF EXISTS visitors_checkout_after_checkin;
    ALTER TABLE gate_passes DROP CONSTRAINT IF EXISTS gate_passes_status_known;
    ALTER TABLE gate_passes DROP CONSTRAINT IF EXISTS gate_passes_window_forward;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS completed_by;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS completed_at;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS cancel_reason;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS cancelled_by;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS cancelled_at;
    ALTER TABLE gate_passes DROP COLUMN IF EXISTS approved_at;
    DROP INDEX IF EXISTS ux_bio_logs_unmatched_punch;
    DROP INDEX IF EXISTS ux_bio_logs_employee_punch;
    ALTER TABLE biometric_devices DROP COLUMN IF EXISTS updated_at;
    ALTER TABLE biometric_devices DROP COLUMN IF EXISTS last_error;
    ALTER TABLE biometric_devices DROP COLUMN IF EXISTS status_checked_at;
  `);
}
