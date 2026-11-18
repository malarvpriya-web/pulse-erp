/**
 * The server's own database login (DB-01C3, manual §250).
 *
 * The running application should log in as a role that cannot change the schema. Other
 * programs in this repo share backend/.env and need more: migrations, DBA tools and the
 * test suites, 184 of which read DB_PASSWORD from that file directly. So DB_USER and
 * DB_PASSWORD keep meaning "the tools' login", and only server.js, by importing this
 * first, swaps in APP_DB_USER and APP_DB_PASSWORD (or APP_DATABASE_URL). With neither
 * set, nothing changes.
 *
 * config/db.js reads the environment when it is imported, so this must be server.js's
 * first import.
 */
import dotenv from 'dotenv';

export function applyAppLogin(env = process.env) {
  if (env.APP_DATABASE_URL) {
    env.DATABASE_URL = env.APP_DATABASE_URL;
    return 'APP_DATABASE_URL';
  }
  if (env.APP_DB_USER) {
    // Falling back to the tools' password would either fail to log in or hide a mistake.
    if (!env.APP_DB_PASSWORD) throw new Error('APP_DB_USER is set without APP_DB_PASSWORD.');
    env.DB_USER = env.APP_DB_USER;
    env.DB_PASSWORD = env.APP_DB_PASSWORD;
    return 'APP_DB_USER';
  }
  return null;
}

// A server started on the test database keeps the tools' login: the application role
// has no grants there. PULSE_TEST_DB is the marker every guarded test tool sets.
if (process.env.PULSE_APP_LOGIN_APPLIED !== '1' && process.env.PULSE_TEST_DB !== '1') {
  dotenv.config({ quiet: true });
  applyAppLogin();
  process.env.PULSE_APP_LOGIN_APPLIED = '1';
}
