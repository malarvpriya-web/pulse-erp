/**
 * 20260706000005_celebration_wishes.js
 *
 * Wishes wall for today's celebrations (birthdays, work anniversaries,
 * wedding anniversaries). Any logged-in user can react with an emoji or
 * post a short message for a celebrant; the board shows aggregated
 * reactions plus the message feed.
 *
 * One row per wish. Emoji-only reactions are deduplicated per sender per
 * celebration per emoji (partial unique index) so tapping 🎉 twice cannot
 * double-count; messages are unlimited.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS celebration_wishes (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      employee_id      INTEGER NOT NULL,
      celebration_type VARCHAR(40) NOT NULL,
      celebration_date DATE NOT NULL DEFAULT CURRENT_DATE,
      sender_user_id   INTEGER,
      sender_name      VARCHAR(160),
      emoji            VARCHAR(16),
      message          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT celebration_wishes_has_content
        CHECK (emoji IS NOT NULL OR message IS NOT NULL)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_celebration_wishes_day
      ON celebration_wishes (celebration_date, employee_id)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_celebration_wishes_emoji_once
      ON celebration_wishes (employee_id, celebration_type, celebration_date, sender_user_id, emoji)
      WHERE message IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS celebration_wishes`);
}
