/**
 * integration.attendanceContract.test.js
 *
 * Attendance had 149 endpoints, 22 tables and ZERO automated tests, while being
 * the module payroll is computed from. Two defects had been live for months when
 * this suite was written, and NEITHER was findable with a mocked pool — a mock
 * returns whatever the test tells it to, so a query naming a column the database
 * does not have passes every time:
 *
 *   1. GET /biometric/employees/unmapped  →  500, "column employee_id does not
 *      exist". `employees` has no employee_id (the code column is office_id).
 *      This is the screen HR uses to find staff with no biometric enrolment, so
 *      while it 500'd the enrolment gap was invisible.
 *
 *   2. Every "present today" tile read 0. `attendance` (210 rows) is a FROZEN
 *      table — zero writers anywhere in the repo, newest row 2026-03-29. The
 *      live table is `attendance_records` (17 INSERT sites). A frozen table has
 *      no rows dated CURRENT_DATE, so attendanceRate was structurally 0.
 *
 * Both are schema-truth bugs, so this suite runs against the REAL database and
 * asserts on real responses.
 *
 * ⚠ The sweep below is the load-bearing test. It is deliberately a CONTRACT test
 * rather than a behavioural one: it does not care what the numbers are, only
 * that every read endpoint on this surface can execute its SQL. That is the
 * exact class of failure that went unnoticed here for months, and it costs one
 * assertion per endpoint to make impossible.
 *
 * Read-only: this suite issues GETs and creates no rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }          = await import('../config/db.js');
const { default: attendanceRtr } = await import('../modules/attendance/routes/attendance.routes.js');
const { default: biometricRtr }  = await import('../modules/hr/biometric.routes.js');

/** An app whose caller is an admin of company 1 — the shape these routes expect. */
function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user  = { userId: 1, id: 1, employee_id: 1, role: 'admin', roles: ['admin'], company_id: 1 };
    req.scope = { company_id: 1 };
    next();
  });
  a.use('/api/attendance', attendanceRtr);
  a.use('/api', biometricRtr);   // biometric.routes.js declares full paths
  return a;
}

let server;
beforeAll(() => { server = app(); });
afterAll(async () => { /* pool is shared — never end it here (see vitest.poolContract) */ });

// ─────────────────────────────────────────────────────────────────────────────
// 1. The two regressions, named and pinned
// ─────────────────────────────────────────────────────────────────────────────
describe('attendance — the defects this suite exists for', () => {
  it('GET /biometric/employees/unmapped executes (employees has office_id, not employee_id)', async () => {
    const res = await request(server).get('/api/biometric/employees/unmapped');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.unmapped)).toBe(true);
    // emp_code must be PROJECTED, not merely absent-and-forgiven: the bug was a
    // column that did not exist, and `SELECT` would have to name one again to
    // regress. A row with a null office_id is legitimate; a missing key is not.
    if (res.body.unmapped.length) {
      expect(Object.keys(res.body.unmapped[0])).toContain('emp_code');
    }
  });

  it('`attendance` is frozen — nothing in the repo writes it, so nothing should read it for "today"', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM attendance WHERE date = CURRENT_DATE`
    );
    // If this ever becomes non-zero, someone has started writing the old table
    // and the two-table split is live again — which is the bug, not the fix.
    expect(rows[0].n).toBe(0);
  });

  it('the production present predicate matches any casing, and counts Late as present — and only as present', async () => {
    // §226: this used to assert that the frozen `attendance` table holds Title
    // Case rows — true of one database's history, false on any fresh one. The
    // point it existed for is behaviour: `attendance` stores 'Present',
    // `attendance_records` stores 'present' (and the seed wrote 'Present'
    // there too), so a status match must not depend on case. That is now
    // tested on the production predicates themselves, evaluated by Postgres.
    //
    // Late: shared/statusSets.js ATTENDANCE_PRESENT includes 'late' — a late
    // arrival is a day worked — and the four buckets are documented as disjoint.
    const { sqlAttendancePresent, sqlAttendanceAbsent, sqlAttendanceLeave, sqlAttendanceOff } =
      await import('../shared/statusSets.js');
    const { rows } = await pool.query(`
      SELECT s AS status,
             ${sqlAttendancePresent('s')} AS present, ${sqlAttendanceAbsent('s')} AS absent,
             ${sqlAttendanceLeave('s')} AS leave,     ${sqlAttendanceOff('s')} AS off
        FROM (VALUES ('Present'), ('present'), ('PRESENT'), ('Late'), ('late'), ('LATE'),
                     ('WFH'), ('Half_Day'), ('Absent'), ('On_Leave'), ('Holiday')) v(s)`);
    const by = Object.fromEntries(rows.map((r) => [r.status, [r.present, r.absent, r.leave, r.off]]));
    for (const p of ['Present', 'present', 'PRESENT', 'WFH', 'Half_Day']) expect(by[p], p).toEqual([true, false, false, false]);
    for (const l of ['Late', 'late', 'LATE']) expect(by[l], l).toEqual([true, false, false, false]);
    expect(by.Absent).toEqual([false, true, false, false]);
    expect(by.On_Leave).toEqual([false, false, true, false]);
    expect(by.Holiday).toEqual([false, false, false, true]);
  });

  it('counts present days the shared predicate way, not with a bare literal', async () => {
    const PRESENT = `LOWER(status) IN ('present','late','wfh','work_from_home','half_day','on_duty')`;
    const { rows } = await pool.query(`
      WITH day AS (
        SELECT attendance_date d FROM attendance_records
         WHERE deleted_at IS NULL AND ${PRESENT}
         GROUP BY 1 ORDER BY 1 DESC LIMIT 1)
      SELECT (SELECT COUNT(*) FILTER (WHERE ${PRESENT})::int FROM attendance_records
               WHERE attendance_date = day.d AND deleted_at IS NULL) AS with_predicate,
             (SELECT COUNT(*)::int FROM attendance_records
               WHERE attendance_date = day.d AND deleted_at IS NULL AND status = 'present') AS bare_literal_live
        FROM day`);
    if (!rows.length) return;                  // no present rows recorded yet
    // The predicate must find at least what a bare literal finds, and the whole
    // point is that it finds MORE (late / wfh / half-day are present days too).
    expect(rows[0].with_predicate).toBeGreaterThanOrEqual(rows[0].bare_literal_live);
    expect(rows[0].with_predicate).toBeGreaterThan(0);
  });

  it('`attendance_records` is the live table and carries the columns the app writes', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'attendance_records'`
    );
    const cols = rows.map(r => r.column_name);
    for (const required of ['employee_id', 'attendance_date', 'check_in_time',
                            'check_out_time', 'status', 'company_id', 'deleted_at']) {
      expect(cols).toContain(required);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The contract sweep
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parameterless GETs on the attendance + biometric surface.
 *
 * A 4xx is a PASS here — "employee_id required" is the endpoint working. Only a
 * 5xx fails, because on this surface a 5xx has meant "the SQL names a column
 * that isn't there" every single time.
 */
const READ_ENDPOINTS = [
  '/api/attendance/today',
  '/api/attendance/live-dashboard',
  '/api/attendance/punch-mode',
  '/api/attendance/overtime',
  '/api/attendance/overtime/stats',
  '/api/attendance/regularize/stats',
  '/api/attendance/regularize/list',
  '/api/attendance/regularize/departments',
  '/api/attendance/regularize/pending',
  '/api/attendance/policies',
  '/api/biometric/employees/unmapped',
  '/api/biometric/devices',
  '/api/biometric/logs',
  '/api/gate-passes',
  '/api/visitors',
];

describe('attendance — read surface executes its SQL', () => {
  for (const path of READ_ENDPOINTS) {
    it(`GET ${path} does not 5xx`, async () => {
      const res = await request(server).get(path);
      expect(
        res.status,
        `${path} returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`
      ).toBeLessThan(500);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Scoping — an employee must not read a colleague's attendance
// ─────────────────────────────────────────────────────────────────────────────
describe('attendance — per-employee reads are scoped', () => {
  it('the employee detail route filters by the employee it was asked for', async () => {
    const { rows } = await pool.query(
      `SELECT employee_id FROM attendance_records
        WHERE deleted_at IS NULL GROUP BY employee_id ORDER BY COUNT(*) DESC LIMIT 1`
    );
    if (!rows.length) return;                 // nothing recorded yet — nothing to assert
    const target = rows[0].employee_id;

    const res = await request(server).get(`/api/attendance/employee/${target}`);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const list = Array.isArray(res.body) ? res.body : (res.body.records || res.body.data || []);
      const foreign = list.filter(r => r.employee_id != null && Number(r.employee_id) !== Number(target));
      expect(foreign, `leaked rows for ${foreign.map(r => r.employee_id).join(',')}`).toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Duplicate prevention is enforced by the database, not by the handler
// ─────────────────────────────────────────────────────────────────────────────
describe('attendance — one row per employee per day', () => {
  it('attendance_records has a UNIQUE key on (employee_id, attendance_date)', async () => {
    const { rows } = await pool.query(`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'attendance_records' AND indexdef ILIKE '%UNIQUE%'`);
    const defs = rows.map(r => r.indexdef.replace(/\s+/g, ' '));
    expect(
      defs.some(d => /\(employee_id, attendance_date\)/.test(d)),
      `no (employee_id, attendance_date) unique index; found: ${defs.join(' | ')}`
    ).toBe(true);
  });

  it('holds no duplicate (employee, date) pairs', async () => {
    const { rows } = await pool.query(`
      SELECT employee_id, attendance_date, COUNT(*)::int AS n
        FROM attendance_records
       WHERE deleted_at IS NULL
       GROUP BY employee_id, attendance_date HAVING COUNT(*) > 1`);
    expect(rows).toHaveLength(0);
  });
});
