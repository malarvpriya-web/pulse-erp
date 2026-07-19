/**
 * Adds missing announcements columns (is_pinned, publish_at) and creates
 * announcement_reads table referenced by announcement.service.js.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE announcements
      ADD COLUMN IF NOT EXISTS is_pinned  BOOLEAN   DEFAULT false,
      ADD COLUMN IF NOT EXISTS publish_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS announcement_reads (
      id              SERIAL PRIMARY KEY,
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL,
      read_at         TIMESTAMP DEFAULT NOW(),
      UNIQUE (announcement_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement
      ON announcement_reads(announcement_id);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS announcement_reads;
    ALTER TABLE announcements
      DROP COLUMN IF EXISTS is_pinned,
      DROP COLUMN IF EXISTS publish_at;
  `);
}
