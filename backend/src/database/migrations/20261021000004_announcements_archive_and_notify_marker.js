/**
 * 20261021000004 — announcements: archive instead of delete, and a sent marker.
 *
 *   deleted_at / deleted_by  DELETE /announcements/:id now archives. The row and
 *                            its read receipts stay; every feed and list filters
 *                            `deleted_at IS NULL`. deleted_by / updated_by are
 *                            users.id, like created_by.
 *   notified_at              Set in the same statement that claims the
 *                            announcement for notification, so a publish runs at
 *                            most once however many times the job or a save
 *                            calls it (announcement.publisher.js).
 *
 * Existing rows are stamped notified_at = created_at. They were notified (best
 * effort) when they were created; without the stamp the first run of the
 * publish job would re-announce every live one of them. On the dev database the
 * table is empty, so this touches no rows there.
 *
 * Additive only; nothing is dropped.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE announcements
      ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by  INTEGER,
      ADD COLUMN IF NOT EXISTS updated_by  INTEGER,
      ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

    UPDATE announcements
       SET notified_at = COALESCE(created_at, NOW())
     WHERE notified_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_announcements_publish_due
      ON announcements (company_id)
      WHERE notified_at IS NULL AND deleted_at IS NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_announcements_publish_due;
    ALTER TABLE announcements
      DROP COLUMN IF EXISTS notified_at,
      DROP COLUMN IF EXISTS updated_by,
      DROP COLUMN IF EXISTS deleted_by,
      DROP COLUMN IF EXISTS deleted_at;
  `);
}
