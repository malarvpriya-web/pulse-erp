#!/usr/bin/env node
/**
 * hr-containment-report.mjs — READ-ONLY report for HR P0 containment C2 + C4.
 *
 *   node scripts/hr/hr-containment-report.mjs [--company <id>] [--month YYYY-MM] [--json out.json]
 *
 *   C4  exited employees whose login is still active (and whether it was used
 *       after the last working day). Run daily until P0-4 ships; deactivate an
 *       account only after HR confirms that person, never in bulk.
 *   C2  leavers in a payroll month (default: the current month) and the state
 *       of their run. Run BEFORE generating that month; a leaver flagged
 *       `draft_at_risk` loses their draft if the month is regenerated.
 *
 * Runs inside a READ ONLY transaction that is rolled back; it cannot change a
 * row. Queries are in containmentReport.js (tested on pulse_e2e).
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { exitedActiveLogins, leaversInMonth } from './containmentReport.js';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env'), quiet: true });

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const companyId = arg('--company') ? Number(arg('--company')) : null;
const monthArg = arg('--month');
const jsonOut = arg('--json');
const now = new Date();
const [year, month] = monthArg
  ? monthArg.split('-').map(Number)
  : [now.getFullYear(), now.getMonth() + 1];   // local (IST) month, not UTC

if (companyId != null && !Number.isInteger(companyId)) throw new Error('--company must be an integer');

// pg returns a DATE as local midnight; toISOString() would print the day before
// in IST. Format the local calendar day instead.
const day = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : d ?? null);

const client = new pg.Client({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const logins = await exitedActiveLogins(client, { companyId });
  const leavers = await leaversInMonth(client, { year, month, companyId });

  console.log(`\nC4 — exited employees with an ACTIVE login: ${logins.length}`);
  console.table(logins.map(r => ({
    employee: r.office_id, status: r.status, user_id: r.user_id, email: r.email,
    lwd: day(r.last_working_date), exit_date: day(r.exit_date),
    last_login: r.last_login, used_after_lwd: r.logged_in_after_lwd, access_revoked_ticked: r.access_revoked,
  })));

  console.log(`\nC2 — leavers with a last working day / exit date in ${year}-${String(month).padStart(2, '0')}: ${leavers.length}`);
  console.table(leavers.map(r => ({
    employee: r.office_id, status: r.status, exit_request: r.exit_request_id,
    lwd: day(r.last_working_date), exit_date: day(r.exit_date), run: r.payroll_run_id, run_status: r.run_status,
    excluded_by_e2: r.excluded_by_e2, draft_at_risk: r.draft_at_risk,
  })));

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ generated_at: new Date().toISOString(), companyId, year, month, logins, leavers }, null, 2));
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
