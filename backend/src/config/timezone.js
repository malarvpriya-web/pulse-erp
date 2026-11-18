/**
 * The application's business time zone — one setting for the Node process and
 * for every database session.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pulse stores many local times as `timestamp without time zone` (announcements
 * from/to/publish_at among them) and asks the database for CURRENT_DATE / NOW()
 * to decide "today". Both only mean India time if the clocks agree:
 *
 *   - the Postgres session TimeZone decides CURRENT_DATE and how a naive
 *     timestamp compares with NOW();
 *   - the Node process TZ decides how node-postgres turns a naive timestamp into
 *     a JS Date (it reads it as LOCAL time), and what `new Date()` calls today.
 *
 * In development both happen to be IST (the PC, and the server's
 * postgresql.conf), so everything looked right. A managed host (Render / Neon /
 * Supabase) runs both in UTC: announcements would go live and expire at 05:30
 * IST, a scheduled publish would fire 5h30m late, and its time would display
 * shifted. Nothing pinned either clock, so correctness depended on the machine.
 *
 * WHAT IT DOES
 * ------------
 * APP_TIMEZONE (default Asia/Kolkata) is applied to process.env.TZ here, at
 * import time, and config/db.js sets the same zone on every new connection.
 * On an IST machine this changes nothing; elsewhere it makes the machine behave
 * like one. Import it before anything creates a Date — config/db.js imports it
 * first, and server.js imports db.js near the top.
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Throws on a name the runtime does not know, so a typo fails at boot, not in a report. */
export function resolveTimezone(name) {
  const tz = String(name || '').trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`APP_TIMEZONE "${tz}" is not a valid IANA time zone (e.g. Asia/Kolkata).`);
  }
  // Only letters, digits, '/', '_', '+', '-' reach the SET statement in db.js.
  if (!/^[A-Za-z0-9/_+-]+$/.test(tz)) throw new Error(`APP_TIMEZONE "${tz}" contains unexpected characters.`);
  return tz;
}

export const APP_TIMEZONE = resolveTimezone(process.env.APP_TIMEZONE);

// Node re-reads TZ when it changes, so later `new Date()` and pg's parsing of
// naive timestamps use the business zone, whatever the host is set to.
process.env.TZ = APP_TIMEZONE;

/** SQL that pins one database session to the business zone. */
export const SET_SESSION_TIMEZONE_SQL = `SET TIME ZONE '${APP_TIMEZONE}'`;
