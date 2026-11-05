/**
 * Date fixtures must follow the database's calendar, not UTC's
 * (PAYROLL_DATA_FLOW_AUDIT.md Part 6, T1). Deterministic: the session time
 * zone is pinned per transaction, so the result does not depend on when the
 * suite runs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dbToday, addDays } from './helpers/dbDate.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}
const { default: pool } = await import('../config/db.js');

async function todayIn(zone) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL TimeZone = '${zone}'`);
    return await dbToday(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

afterAll(() => {});   // the pool is shared across suites — never pool.end()

describe('dbToday', () => {
  it('is the session time zone\'s date, not the UTC date', async () => {
    // UTC+14 and UTC−12 are 26 hours apart: their dates differ at EVERY instant.
    const east = await todayIn('Pacific/Kiritimati');
    const west = await todayIn('Etc/GMT+12');
    expect(east).not.toBe(west);
    expect([1, 2]).toContain((Date.parse(east) - Date.parse(west)) / 86400000);
    const utcNow = new Date().toISOString().slice(0, 10);
    expect(await todayIn('UTC')).toBe(utcNow);
  });
});

describe('addDays', () => {
  it('does calendar arithmetic across month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-21', 20)).toBe('2026-11-10');
    expect(addDays('2026-10-21', -1)).toBe('2026-10-20');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', 0)).toBe('2026-03-01');
  });
});
