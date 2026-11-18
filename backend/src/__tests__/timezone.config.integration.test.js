/**
 * Business time zone (config/timezone.js + config/db.js), 2026-11-10.
 *
 * Nothing used to pin either clock, so "today", announcement go-live/expiry and
 * scheduled publishes were right only on an IST machine. These tests start a
 * child process that looks like a UTC cloud host (TZ=UTC, and a Postgres
 * session defaulting to UTC via PGOPTIONS) and check the app still runs in IST.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveTimezone, DEFAULT_TIMEZONE } from '../config/timezone.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbUrl = pathToFileURL(resolve(here, '../config/db.js')).href;

// setup.js puts a placeholder DB_PASSWORD in the environment; the real one is in
// backend/.env, read the same way the other real-DB suites read it.
const realPassword = () => process.env.DATABASE_URL ? undefined
  : readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();

/** Run a snippet in a fresh Node process that pretends to be a UTC host. */
function onUtcHost(extraEnv = {}) {
  const code = `
    const { default: pool } = await import(${JSON.stringify(dbUrl)});
    const { rows: [r] } = await pool.query(
      "select current_setting('TimeZone') tz, '2026-11-10 21:49'::timestamp ts, " +
      "('2026-11-10 21:49'::timestamp <= '2026-11-10 16:30+00'::timestamptz) due");
    // A separate process: exiting closes its own pool (nothing shared with vitest).
    process.stdout.write(JSON.stringify({ tz: r.tz, ts: r.ts.toISOString(), due: r.due,
      nodeTZ: process.env.TZ, offset: new Date().getTimezoneOffset() }) + String.fromCharCode(10), () => process.exit(0));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env, VITEST: '', NODE_ENV: 'development',
      ...(realPassword() ? { DB_PASSWORD: realPassword() } : {}),
      TZ: 'UTC', PGOPTIONS: '-c TimeZone=UTC', ...extraEnv,
    },
    // backend/: the child's dotenv reads the same .env the test runner did.
    cwd: resolve(here, '../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop());
}

describe('business time zone', () => {
  it('defaults to Asia/Kolkata and rejects an unknown zone at boot', () => {
    expect(resolveTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('  ')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone('Asia/Dubai')).toBe('Asia/Dubai');
    expect(() => resolveTimezone('Mars/Olympus')).toThrow(/not a valid IANA time zone/);
  });

  it('on a UTC host, the process and every DB session still run in IST', () => {
    const r = onUtcHost();
    expect(r.nodeTZ).toBe('Asia/Kolkata');
    expect(r.offset).toBe(-330);
    expect(r.tz).toBe('Asia/Kolkata');
    // A naive 21:49 (what the HR form stores) is 16:19 UTC, not 21:49 UTC.
    expect(r.ts).toBe('2026-11-10T16:19:00.000Z');
    // ...so a publish_at of 21:49 IST is due at 16:30 UTC, not 5h30m later.
    expect(r.due).toBe(true);
  }, 30000);

  it('APP_TIMEZONE overrides the default for both clocks', () => {
    const r = onUtcHost({ APP_TIMEZONE: 'Asia/Dubai' });
    expect(r.nodeTZ).toBe('Asia/Dubai');
    expect(r.tz).toBe('Asia/Dubai');
    expect(r.ts).toBe('2026-11-10T17:49:00.000Z');
  }, 30000);
});
