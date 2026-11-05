/**
 * integration.upcomingJoinees.test.js — the Upcoming Joinees state machine,
 * against the REAL database.
 *
 * The interesting states have no rows in the live tenant: every accepted offer
 * there belongs to somebody who has already been onboarded. So this suite owns
 * tenant 999918 and builds each state explicitly. Without it the feature would
 * ship verified only against "0, and nothing crashed".
 *
 * What it pins down, in order of how quietly each would fail:
 *
 *   1. A candidate who is ALREADY AN EMPLOYEE must not appear — including when
 *      the link is only an email match. `employees.source_candidate_id` is
 *      populated on 1 of 44 live rows, so keying on the FK alone reported
 *      someone who had been on the payroll for seven weeks as an upcoming
 *      joinee.
 *   2. An offer that is merely SENT is not a confirmed joinee, and must never
 *      be added into the headline total.
 *   3. An accepted offer whose joining date has PASSED must stay visible as
 *      `overdue`. That is the row a forward-only window drops on the day it
 *      starts to matter.
 *   4. One candidate holding several offers counts once.
 *
 * READ-MOSTLY: it creates its own tenant and deletes everything it made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';
import { dbToday, addDays } from './helpers/dbDate.js';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { getUpcomingJoinees, IMMINENT_DAYS } = await import('../modules/hr/upcomingJoinees.service.js');

/** This suite's own tenant. Registered in testTenantIds.contract.test.js. */
const CID = 999918;
const TAG = 'ZZJOIN';

const ids = { candidates: [], offers: [], employees: [], openings: [] };

async function makeCandidate(name, email) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO candidates (full_name, email) VALUES ($1, $2) RETURNING id`,
    [`${TAG} ${name}`, email],
  );
  ids.candidates.push(r.id);
  return r.id;
}

async function makeOffer(candidateId, joiningDate, status, openingId = null) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO offer_letters (candidate_id, job_opening_id, joining_date, offer_status, company_id)
     VALUES ($1, $2, $3::date, $4, $5) RETURNING id`,
    [candidateId, openingId, joiningDate, status, CID],
  );
  ids.offers.push(r.id);
  return r.id;
}

/** `days` relative to the DATABASE's today (helpers/dbDate.js), as YYYY-MM-DD. */
let TODAY;
const dayOffset = (days) => addDays(TODAY, days);

const byName = (rows, needle) => rows.find(r => String(r.name).includes(needle));

describe('upcoming joinees', () => {
  let result;

  beforeAll(async () => {
    TODAY = await dbToday(pool);
    await pool.query(
      `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [CID, `${TAG} Joinee Co`, TAG],
    );

    const { rows: [op] } = await pool.query(
      `INSERT INTO job_openings (job_title, department, company_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${TAG} Engineer`, 'Widgets', CID],
    );
    ids.openings.push(op.id);

    // 1. Confirmed and comfortably ahead.
    const future = await makeCandidate('Future Joiner', `${TAG}.future@test.invalid`);
    await makeOffer(future, dayOffset(20), 'accepted', op.id);

    // 2. Confirmed and imminent (inside the 7-day sub-window).
    const soon = await makeCandidate('Imminent Joiner', `${TAG}.soon@test.invalid`);
    await makeOffer(soon, dayOffset(3), 'accepted', op.id);

    // 3. Confirmed but the start date has passed and nobody onboarded them.
    const late = await makeCandidate('Overdue Joiner', `${TAG}.late@test.invalid`);
    await makeOffer(late, dayOffset(-10), 'accepted', op.id);

    // 4. Offered but not accepted — not a commitment.
    const sent = await makeCandidate('Sent Not Accepted', `${TAG}.sent@test.invalid`);
    await makeOffer(sent, dayOffset(12), 'sent', op.id);

    // 5. Drafted and never extended.
    const draft = await makeCandidate('Draft Only', `${TAG}.draft@test.invalid`);
    await makeOffer(draft, dayOffset(14), 'draft', op.id);

    // 6. Accepted AND already an employee, linked by the explicit FK.
    const joinedFk = await makeCandidate('Joined Via Fk', `${TAG}.fk@test.invalid`);
    await makeOffer(joinedFk, dayOffset(9), 'accepted', op.id);
    const { rows: [e1] } = await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_email, company_id, source_candidate_id, status, joining_date)
       VALUES (${FIXTURE_CODE_SQL}, $1,$2,$3,$4,$5,'Active',$6::date) RETURNING id`,
      [TAG, 'Joined Via Fk', `${TAG}.fk.emp@test.invalid`, CID, joinedFk, dayOffset(9)],
    );
    ids.employees.push(e1.id);

    // 7. Accepted AND already an employee, but the FK was never set — the
    //    shape that live data actually has. Only the email match catches it.
    const joinedEmail = await makeCandidate('Joined Via Email', `${TAG}.email@test.invalid`);
    await makeOffer(joinedEmail, dayOffset(11), 'accepted', op.id);
    const { rows: [e2] } = await pool.query(
      `INSERT INTO employees (office_id, first_name, last_name, company_email, company_id, status, joining_date)
       VALUES (${FIXTURE_CODE_SQL}, $1,$2,$3,$4,'Active',$5::date) RETURNING id`,
      [TAG, 'Joined Via Email', `${TAG}.email@test.invalid`, CID, dayOffset(11)],
    );
    ids.employees.push(e2.id);

    // 8. One candidate, two accepted offers — must count once.
    const twice = await makeCandidate('Two Offers', `${TAG}.twice@test.invalid`);
    await makeOffer(twice, dayOffset(25), 'accepted', op.id);
    await makeOffer(twice, dayOffset(28), 'accepted', op.id);

    result = await getUpcomingJoinees({ company_id: CID, days: 30 });
  }, 40000);

  afterAll(async () => {
    // Child rows first. Not pool.end() — the pool is shared across suites.
    if (ids.offers.length)     await pool.query(`DELETE FROM offer_letters WHERE id = ANY($1::uuid[])`, [ids.offers]);
    if (ids.employees.length)  await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [ids.employees]);
    if (ids.candidates.length) await pool.query(`DELETE FROM candidates WHERE id = ANY($1::int[])`, [ids.candidates]);
    if (ids.openings.length)   await pool.query(`DELETE FROM job_openings WHERE id = ANY($1::int[])`, [ids.openings]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [CID]);
  }, 30000);

  it('counts a confirmed future joiner', () => {
    const row = byName(result.joinees, 'Future Joiner');
    expect(row, 'future joiner present').toBeTruthy();
    expect(row.joinee_state).toBe('upcoming');
    expect(row.department).toBe('Widgets');
    expect(row.days_to_join).toBe(20);
  });

  it('flags a joiner inside the 7-day window as imminent', () => {
    const row = byName(result.joinees, 'Imminent Joiner');
    expect(row.joinee_state).toBe('imminent');
    expect(row.days_to_join).toBeLessThanOrEqual(IMMINENT_DAYS);
    expect(result.summary.next7).toBe(1);
  });

  it('keeps an accepted offer whose start date has passed, as overdue', () => {
    // The whole reason the lower bound is not CURRENT_DATE.
    const row = byName(result.joinees, 'Overdue Joiner');
    expect(row, 'overdue joiner must stay visible').toBeTruthy();
    expect(row.joinee_state).toBe('overdue');
    expect(row.days_to_join).toBeLessThan(0);
    expect(result.summary.overdue).toBe(1);
  });

  it('excludes an overdue joiner from the forward-looking total', () => {
    // Future + imminent + the two-offer candidate. Not the overdue one.
    expect(result.summary.total).toBe(3);
  });

  it('reports a SENT offer separately and never inside the total', () => {
    expect(byName(result.joinees, 'Sent Not Accepted')).toBeUndefined();
    expect(byName(result.pending, 'Sent Not Accepted')).toBeTruthy();
    expect(result.summary.pendingAcceptance).toBe(1);
  });

  it('ignores a draft offer entirely — it was never extended', () => {
    expect(byName(result.joinees, 'Draft Only')).toBeUndefined();
    expect(byName(result.pending, 'Draft Only')).toBeUndefined();
  });

  it('excludes a candidate already onboarded via source_candidate_id', () => {
    expect(byName(result.joinees, 'Joined Via Fk')).toBeUndefined();
  });

  it('excludes a candidate already onboarded with NO fk, matched on email', () => {
    // ⚠ The live-data shape. If this regresses, the dashboard reports people
    // who have been on the payroll for weeks as not having started.
    expect(byName(result.joinees, 'Joined Via Email')).toBeUndefined();
  });

  it('counts a candidate holding two accepted offers exactly once', () => {
    const rows = result.joinees.filter(r => String(r.name).includes('Two Offers'));
    expect(rows).toHaveLength(1);
    // The earlier of the two.
    expect(rows[0].days_to_join).toBe(25);
  });

  it('every returned row carries a joining date, a department and a state', () => {
    for (const r of result.joinees) {
      expect(r.joining_date).toBeTruthy();
      expect(r.department).toBeTruthy();
      expect(['upcoming', 'imminent', 'overdue']).toContain(r.joinee_state);
      expect(typeof r.days_to_join).toBe('number');
    }
  });

  it('a narrower window cannot return more joinees than a wider one', async () => {
    const narrow = await getUpcomingJoinees({ company_id: CID, days: 7 });
    expect(narrow.summary.total).toBeLessThanOrEqual(result.summary.total);
    // Overdue is not bounded by the forward window — it is already behind us.
    expect(narrow.summary.overdue).toBe(result.summary.overdue);
  }, 20000);

  it('is tenant scoped', async () => {
    const other = await getUpcomingJoinees({ company_id: 1, days: 30 });
    expect(other.joinees.some(r => String(r.name).includes(TAG))).toBe(false);
    expect(other.pending.some(r => String(r.name).includes(TAG))).toBe(false);
  }, 20000);
});
