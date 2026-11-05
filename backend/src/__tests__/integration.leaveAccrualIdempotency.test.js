/**
 * integration.leaveAccrualIdempotency.test.js
 *
 * Drives the REAL `/leave-accrual` router and the REAL accrual service against the
 * REAL database, including REAL concurrency.
 *
 * WHAT IS BEING PROVED
 * ====================
 * A given (employee, leave type, period) is credited AT MOST ONCE, whatever
 * happens:
 *
 *   1. The same month run twice by hand      → credited once
 *   2. The cron and a human running the same month → credited once
 *   3. Several runs firing simultaneously    → credited once
 *   4. A DIFFERENT month                     → credited again (the boundary is not too wide)
 *   5. Carry-forward run twice               → carried once
 *
 * ⚠ CASE 4 IS LOAD-BEARING. An idempotency key that is too coarse — one that keys
 * on (employee, leave_type, year) and ignores the month, which is precisely what
 * `ON CONFLICT (employee_id, leave_type_id, year)` did — would make cases 1-3 pass
 * while silently breaking accrual for every month after the first. A suite that
 * only asserts "the second run does nothing" cannot tell the fix from that
 * regression.
 *
 * ⚠ EVERY ASSERTION IS ON `leave_balances.allocated_days`, THE NUMBER THAT IS
 * MONEY. It feeds encashment, full-and-final settlement and the payroll LOP
 * calculation. Asserting the response counters alone would pass a version that
 * reports 0 accrued and credits anyway.
 *
 * Self-cleaning; sweep() runs on the way in as well as out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FIXTURE_CODE_SQL } from '../shared/employeeCode.js';

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
const { default: accrualRouter } = await import('../modules/leaves/routes/accrual.routes.js');
const { runMonthlyAccrual, runCarryForward } =
  await import('../modules/leaves/services/leaveAccrual.service.js');

const TAG = 'ZZACCR';
const YEAR = 2031;                 // deliberately far from any seeded data

/**
 * An app whose caller is an HR admin of this company.
 *
 * `allowRoles` and `requirePermission` are both satisfied by the stub: the point of
 * this suite is idempotency, not authorization, so the caller must be FULLY
 * entitled and still be unable to double-credit.
 */
function appAs(companyId, employeeId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: 1, id: 1, employee_id: employeeId, company_id: companyId,
      roles: ['hr_manager'], role: 'hr_manager', permissions: ['*'],
    };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/leave-accrual', accrualRouter);
  return app;
}

const ids = { company: null, employee: null, employee2: null, monthlyType: null, cfType: null };
let A;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const co = rows.map(r => r.id);
  if (!co.length) return;

  const ourEmployees = `(SELECT id FROM employees WHERE company_id = ANY($1))`;
  const ourTypes     = `(SELECT id FROM leave_types WHERE company_id = ANY($1))`;
  await pool.query(`DELETE FROM leave_accrual_log WHERE employee_id IN ${ourEmployees} OR leave_type_id IN ${ourTypes}`, [co]);
  await pool.query(`DELETE FROM leave_balances    WHERE employee_id IN ${ourEmployees} OR leave_type_id IN ${ourTypes}`, [co]);
  await pool.query(`DELETE FROM leave_types       WHERE company_id = ANY($1)`, [co]);

  const { rows: fks } = await pool.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu  ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'companies'`);
  for (let pass = 0; pass < 2; pass++) {
    for (const { table_name, column_name } of fks) {
      try { await pool.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1)`, [co]); } catch { /* ordering */ }
    }
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

/** The number that is money. */
async function allocated(employeeId, leaveTypeId, year = YEAR) {
  const { rows } = await pool.query(
    `SELECT allocated_days::float AS d FROM leave_balances
      WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
    [employeeId, leaveTypeId, year]);
  return rows[0]?.d ?? 0;
}

async function logRows(employeeId, leaveTypeId, year = YEAR) {
  const { rows } = await pool.query(
    `SELECT month, days_accrued::float AS days, accrual_type, run_mode
       FROM leave_accrual_log
      WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3
      ORDER BY COALESCE(month, 0)`,
    [employeeId, leaveTypeId, year]);
  return rows;
}

/** Wipe only this suite's accrual state, so each test starts from zero. */
async function resetAccrualState() {
  await pool.query(`DELETE FROM leave_accrual_log WHERE employee_id = ANY($1)`, [[ids.employee, ids.employee2]]);
  await pool.query(`DELETE FROM leave_balances    WHERE employee_id = ANY($1)`, [[ids.employee, ids.employee2]]);
}

beforeAll(async () => {
  await sweep();

  const { rows: [co] } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
    [`${TAG} Co`, `${TAG}A`]);
  ids.company = co.id;

  // 'Active', Capitalized — the live vocabulary. The manual carry-forward endpoint
  // used to filter on lowercase 'active' and therefore matched nobody; a fixture
  // written with lowercase here would hide that.
  const { rows: [e1] } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status, joining_date)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'One', $2, 'Active', '2020-01-01') RETURNING id`, [TAG, ids.company]);
  const { rows: [e2] } = await pool.query(
    `INSERT INTO employees (office_id, first_name, last_name, company_id, status, joining_date)
     VALUES (${FIXTURE_CODE_SQL}, $1, 'Two', $2, 'Active', '2020-01-01') RETURNING id`, [TAG, ids.company]);
  ids.employee  = e1.id;
  ids.employee2 = e2.id;

  const { rows: [mt] } = await pool.query(
    `INSERT INTO leave_types
       (leave_name, leave_code, company_id, accrual_type, accrual_days_per_month, is_active)
     VALUES ($1, $2, $3, 'monthly', 1.25, true) RETURNING id`,
    [`${TAG} Earned`, `${TAG}EL`, ids.company]);
  ids.monthlyType = mt.id;

  const { rows: [cf] } = await pool.query(
    `INSERT INTO leave_types
       (leave_name, leave_code, company_id, accrual_type, carry_forward_allowed,
        max_carry_forward_days, is_active)
     VALUES ($1, $2, $3, 'manual', true, 10, true) RETURNING id`,
    [`${TAG} CarryFwd`, `${TAG}CF`, ids.company]);
  ids.cfType = cf.id;

  A = appAs(ids.company, ids.employee);
}, 60_000);

afterAll(async () => { await sweep(); }, 60_000);
beforeEach(async () => { await resetAccrualState(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · the constraint that makes a double credit impossible', () => {
  it('uq_accrual_log_period exists and keys on the period, not on run_mode', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_accrual_log_period'`);
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef;
    expect(def).toContain('UNIQUE');
    expect(def).toContain('employee_id');
    expect(def).toContain('leave_type_id');
    expect(def).toContain('year');
    // COALESCE(month, 0), not bare `month` — NULL <> NULL in Postgres, so a plain
    // index on the raw column lets every year-scoped credit duplicate freely.
    expect(def).toMatch(/COALESCE\(month/i);
    // run_mode MUST NOT be in the key, or 'cron' and 'manual' become distinct keys
    // and the cross-writer double-credit is back.
    expect(def).not.toContain('run_mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · POST /run is idempotent per month', () => {
  it('credits 1.25 days once', async () => {
    const res = await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    expect(res.status).toBe(200);
    expect(res.body.records_accrued).toBeGreaterThanOrEqual(2);   // two employees
    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
  });

  it('running the SAME month twice credits it ONCE', async () => {
    await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    const after1 = await allocated(ids.employee, ids.monthlyType);

    const second = await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    expect(second.status).toBe(200);
    // Additive reporting: the endpoint now SAYS it skipped rather than silently
    // appearing to have worked twice.
    expect(second.body.records_accrued).toBe(0);
    expect(second.body.records_skipped).toBeGreaterThanOrEqual(2);

    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(after1, 4);
    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
  });

  it('running the same month FIVE times credits it once', async () => {
    for (let i = 0; i < 5; i++) {
      await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    }
    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
    expect(await logRows(ids.employee, ids.monthlyType)).toHaveLength(1);
  });

  it('a DIFFERENT month accrues again — the key is not too coarse', async () => {
    // The assertion that distinguishes the fix from a key of
    // (employee, leave_type, year), which would pass every test above while
    // breaking accrual for month 2 onwards.
    await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    await request(A).post('/leave-accrual/run').send({ month: 4, year: YEAR });
    await request(A).post('/leave-accrual/run').send({ month: 5, year: YEAR });

    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(3.75, 4);   // 3 x 1.25
    const log = await logRows(ids.employee, ids.monthlyType);
    expect(log.map(r => r.month)).toEqual([3, 4, 5]);
  });

  it('a different YEAR accrues again', async () => {
    await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR });
    await request(A).post('/leave-accrual/run').send({ month: 3, year: YEAR + 1 });
    expect(await allocated(ids.employee, ids.monthlyType, YEAR)).toBeCloseTo(1.25, 4);
    expect(await allocated(ids.employee, ids.monthlyType, YEAR + 1)).toBeCloseTo(1.25, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · the cron and the button cannot both credit', () => {
  it('cron then manual, same month → credited once', async () => {
    // The cron's own entry point, with runMode 'cron'.
    const cron = await runMonthlyAccrual({ companyId: ids.company, month: 6, year: YEAR, runMode: 'cron', runBy: null });
    expect(cron.credited).toBeGreaterThanOrEqual(2);

    const manual = await request(A).post('/leave-accrual/run').send({ month: 6, year: YEAR });
    expect(manual.body.records_accrued).toBe(0);

    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
    const log = await logRows(ids.employee, ids.monthlyType);
    expect(log).toHaveLength(1);
    expect(log[0].run_mode).toBe('cron');      // the cron's row is the one that stuck
  });

  it('manual then cron, same month → credited once', async () => {
    await request(A).post('/leave-accrual/run').send({ month: 7, year: YEAR });
    const cron = await runMonthlyAccrual({ companyId: ids.company, month: 7, year: YEAR, runMode: 'cron', runBy: null });
    expect(cron.credited).toBe(0);
    expect(cron.skipped).toBeGreaterThanOrEqual(2);

    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
    const log = await logRows(ids.employee, ids.monthlyType);
    expect(log).toHaveLength(1);
    expect(log[0].run_mode).toBe('manual');
  });

  it('the cron DOES write an accrual-log row — it used to write none at all', async () => {
    await runMonthlyAccrual({ companyId: ids.company, month: 8, year: YEAR, runMode: 'cron', runBy: null });
    const log = await logRows(ids.employee, ids.monthlyType);
    expect(log).toHaveLength(1);
    expect(log[0].days).toBeCloseTo(1.25, 4);
    expect(log[0].accrual_type).toBe('monthly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · concurrency-safe', () => {
  it('four SIMULTANEOUS runs of the same month credit it once', async () => {
    const results = await Promise.all([
      runMonthlyAccrual({ companyId: ids.company, month: 9, year: YEAR, runMode: 'cron',   runBy: null }),
      runMonthlyAccrual({ companyId: ids.company, month: 9, year: YEAR, runMode: 'manual', runBy: ids.employee }),
      runMonthlyAccrual({ companyId: ids.company, month: 9, year: YEAR, runMode: 'cron',   runBy: null }),
      runMonthlyAccrual({ companyId: ids.company, month: 9, year: YEAR, runMode: 'manual', runBy: ids.employee }),
    ]);

    // None may throw — a retry that 500s is a worse outcome than the duplicate was.
    for (const r of results) expect(r.failed).toBe(0);
    // Exactly one run credited each employee; the other three skipped.
    expect(results.reduce((s, r) => s + r.credited, 0)).toBe(2);   // two employees, once each

    expect(await allocated(ids.employee,  ids.monthlyType)).toBeCloseTo(1.25, 4);
    expect(await allocated(ids.employee2, ids.monthlyType)).toBeCloseTo(1.25, 4);
    expect(await logRows(ids.employee, ids.monthlyType)).toHaveLength(1);
  });

  it('four simultaneous HTTP runs of the same month credit it once', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(appAs(ids.company, ids.employee)).post('/leave-accrual/run').send({ month: 10, year: YEAR })));

    for (const r of results) expect(r.status).toBe(200);
    expect(results.reduce((s, r) => s + r.body.records_accrued, 0)).toBe(2);
    expect(await allocated(ids.employee, ids.monthlyType)).toBeCloseTo(1.25, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · carry-forward is idempotent too', () => {
  it('carries the capped balance once, however many times it runs', async () => {
    // A closing balance in the source year for the carry-forward type.
    await pool.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
       VALUES ($1, $2, $3, 18, 2)`,
      [ids.employee, ids.cfType, YEAR]);

    const first = await request(A).post('/leave-accrual/carry-forward').send({ from_year: YEAR });
    expect(first.status).toBe(200);
    // 18 - 2 = 16 remaining, capped at max_carry_forward_days = 10.
    expect(first.body.records_carried).toBeGreaterThanOrEqual(1);
    expect(await allocated(ids.employee, ids.cfType, YEAR + 1)).toBeCloseTo(10, 4);

    const second = await request(A).post('/leave-accrual/carry-forward').send({ from_year: YEAR });
    expect(second.body.records_carried).toBe(0);
    expect(second.body.records_skipped).toBeGreaterThanOrEqual(1);

    // Still 10, not 20. The source row is untouched by the first run, so a naive
    // re-run would have read the same 16 and carried another 10 — the log gate is
    // the only thing that could have stopped it.
    expect(await allocated(ids.employee, ids.cfType, YEAR + 1)).toBeCloseTo(10, 4);

    const { rows: cfLog } = await pool.query(
      `SELECT month, accrual_type FROM leave_accrual_log
        WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
      [ids.employee, ids.cfType, YEAR + 1]);
    expect(cfLog).toHaveLength(1);
    expect(cfLog[0].accrual_type).toBe('carry_forward');
    expect(cfLog[0].month).toBeNull();          // year-scoped, hence COALESCE(month,0)
  });

  it('the manual carry-forward endpoint finds Capitalized-status employees', async () => {
    // ⚠ This endpoint had NEVER carried anything forward for anyone: its filter read
    // `e.status IN ('active','probation','notice')`, lowercase, against a column
    // whose live values are 'Active' / 'Probation' / 'Notice'. It returned
    // records_carried: 0 every time, indistinguishable from "nobody was eligible".
    const { rows: [emp] } = await pool.query(
      `SELECT status FROM employees WHERE id = $1`, [ids.employee]);
    expect(emp.status).toBe('Active');           // the fixture is the live vocabulary

    await pool.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
       VALUES ($1, $2, $3, 8, 0)`,
      [ids.employee2, ids.cfType, YEAR]);

    const res = await request(A).post('/leave-accrual/carry-forward').send({ from_year: YEAR });
    expect(res.body.records_carried).toBeGreaterThanOrEqual(1);
    expect(await allocated(ids.employee2, ids.cfType, YEAR + 1)).toBeCloseTo(8, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Leave accrual · the log row and the credit are one unit of work', () => {
  it('a log row exists for every credited day, and no log row means no days', async () => {
    await request(A).post('/leave-accrual/run').send({ month: 11, year: YEAR });

    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(days_accrued), 0)::float AS logged
        FROM leave_accrual_log
       WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
      [ids.employee, ids.monthlyType, YEAR]);

    // The invariant that makes the log trustworthy as a ledger: what the log says
    // was credited is what the balance holds. A split transaction would break this
    // in the direction nobody can detect afterwards.
    expect(rows[0].logged).toBeCloseTo(await allocated(ids.employee, ids.monthlyType), 4);
  });

  it('rejects a nonsense period rather than crediting something arbitrary', async () => {
    const res = await request(A).post('/leave-accrual/run').send({ month: 13, year: YEAR });
    expect(res.status).toBe(422);
    expect(await allocated(ids.employee, ids.monthlyType)).toBe(0);
  });
});
