/**
 * 20260718000005_device_push_tokens.js
 *
 * Maps a mobile device's push token to a user, so server-side events (approvals,
 * breakdown-call assignment, tender deadlines, IoT alerts) can be delivered to
 * the native app. Written by the Capacitor app via POST /notifications/push/register
 * (see src/mobile/native.js registerPush).
 *
 * A token is globally unique (one device → one row); re-registering the same
 * token just re-points it to the current user and bumps last_seen_at.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_push_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await knex.raw(sql); await knex.raw(`RELEASE SAVEPOINT ${sp}`); }
    catch (e) { await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`); console.warn(`[device_push_tokens] skipped (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('create', `
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      company_id   INTEGER,
      token        TEXT NOT NULL UNIQUE,
      platform     VARCHAR(20),           -- ios | android | web
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safe('idx_user', `CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user ON device_push_tokens(user_id)`);

  console.log('[migration 20260718000005] device_push_tokens applied.');
}

export async function down(knex) {
  try { await knex.raw(`DROP TABLE IF EXISTS device_push_tokens CASCADE`); } catch { /* ignore */ }
}
