/**
 * leaveAccrual.service.js — THE canonical owner of every write to
 * `leave_balances.allocated_days` that represents an ACCRUAL.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Three writers credited earned leave, none of them aware of the others:
 *
 *   A. `POST /api/v1/leave-accrual/run`        (leaves/routes/accrual.routes.js)
 *   B. `cron.schedule('0 1 1 * *')`            (jobs/leave.cron.js) — 1st @ 01:00 IST
 *   C. `POST /api/v1/leave-accrual/carry-forward` and its `0 2 1 1 *` cron twin
 *
 * A and B are copy-paste twins of each other, C is a copy-paste twin of its own
 * cron, and every one of them issued the same statement:
 *
 *     INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, ...)
 *     VALUES ($1, $2, $3, $4, 0)
 *     ON CONFLICT (employee_id, leave_type_id, year)
 *     DO UPDATE SET allocated_days = leave_balances.allocated_days + $4
 *
 * ⚠⚠ THAT ON CONFLICT READS AS IDEMPOTENT AND IS NOT. The conflict target is
 * (employee, leave_type, YEAR) — the identity of the balance ROW — and it says
 * nothing about WHICH PERIOD the increment is for. The action is `+ $4`. So the
 * statement is idempotent about creating the row and purely ADDITIVE about the
 * days. Every re-run credits again:
 *
 *   - `POST /leave-accrual/run` takes `month` and `year` FROM THE REQUEST BODY.
 *     Running March twice — an HR user being thorough, a double-submit, a retry
 *     after a gateway timeout — granted every employee in the company a second
 *     month of earned leave. Nothing in the endpoint could tell it had already run.
 *   - The 01:00 cron firing, then HR running that same month by hand, did the
 *     same thing across a process boundary, with neither able to see the other's
 *     work: the cron wrote NO `leave_accrual_log` row at all, and the manual route
 *     wrote one un-awaited inside `.catch(() => {})`, so a failed log still left
 *     the credit in place.
 *   - Two app instances both running crons, or one restarted on the 1st between
 *     01:00 and 01:01, double-credited with no human involved.
 *
 * This is money. `leave_balances.allocated_days` feeds encashment, full-and-final
 * settlement and the LOP calculation in payroll.
 *
 * THE CANONICAL OWNER, AND WHY THIS ONE
 * =====================================
 * Neither A nor B was adopted as-is; the shared body is lifted here and both
 * delegate. Where they disagreed on substance, these won:
 *
 *   - PRO-RATING: identical in both, kept verbatim (joining mid-month scales by
 *     days-worked / days-in-month; joined after the period starts = skip).
 *   - EMPLOYEE FILTER: the CRON's `status IS DISTINCT FROM 'Left'`, not the manual
 *     carry-forward route's `status IN ('active','probation','notice')`. ⚠ That
 *     second predicate is LOWERCASE and `employees.status` in this database is
 *     Capitalized ('Active', 'Probation', 'Notice') — verified live — so the
 *     manual carry-forward endpoint matched ZERO employees and has never carried
 *     anything forward for anyone. Consolidating on the cron's predicate fixes
 *     that endpoint as a side effect of having one implementation.
 *   - THE LOG: the manual route's `leave_accrual_log` write, promoted from an
 *     un-awaited afterthought to the thing that AUTHORISES the credit.
 *
 * IDEMPOTENCE
 * ===========
 * `leave_accrual_log` is no longer an audit trail written after the fact. It is
 * the lock:
 *
 *     BEGIN
 *       INSERT INTO leave_accrual_log (employee, type, year, month, days, accrual_type, ...)
 *       ON CONFLICT DO NOTHING
 *       RETURNING id
 *       -- no row returned  => this period is ALREADY accrued => touch nothing
 *       -- row returned     => apply the increment to leave_balances
 *     COMMIT
 *
 * `uq_accrual_log_period` (migration 20260926000012) is a unique index on
 * (employee_id, leave_type_id, year, COALESCE(month,0), COALESCE(accrual_type,'monthly')).
 * Two concurrent runs therefore CONTEND ON THE INDEX and exactly one wins — in
 * one process, across processes, and across the cron/manual boundary alike.
 * `run_mode` is deliberately NOT in the key: if it were, 'cron' and 'manual'
 * would be distinct keys and the cross-writer double-credit would be back.
 *
 * ⚠ The log row and the balance update are in ONE transaction. Splitting them —
 * log first, then credit — would make a crash between the two leave the period
 * marked accrued with no days granted, which is the failure mode that cannot be
 * detected afterwards.
 */
import pool from '../../../config/db.js';

/** Accrual kinds, which are also part of the idempotency key. */
export const ACCRUAL_MONTHLY       = 'monthly';
export const ACCRUAL_CARRY_FORWARD = 'carry_forward';

/**
 * Credit one employee one leave type for one period, at most once, ever.
 *
 * @param {object} args
 * @param {number} args.employeeId
 * @param {number} args.leaveTypeId
 * @param {number} args.year          the year the days land in
 * @param {number|null} args.month    1-12 for monthly accrual; null for a
 *                                    year-scoped credit such as carry-forward
 * @param {number} args.days          must be > 0
 * @param {string} args.accrualType   ACCRUAL_MONTHLY | ACCRUAL_CARRY_FORWARD
 * @param {string} args.runMode       'cron' | 'manual' — recorded, NOT part of the key
 * @param {number|null} args.runBy     an employees.id (the column FKs employees), or null for a cron
 * @param {number|null} args.companyId
 * @param {object} [args.carryForward] when present, also maintains the
 *                                     carried_forward_days / opening_balance columns
 * @returns {Promise<'credited'|'already_accrued'>}
 */
export async function creditAccrual({
  employeeId, leaveTypeId, year, month, days, accrualType,
  runMode = 'cron', runBy = null, companyId = null, carryForward = false,
}) {
  const amount = Number(days);
  if (!Number.isFinite(amount) || amount <= 0) return 'already_accrued';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── The gate. This is the whole idempotency mechanism. ──────────────────
    const { rows: claimed } = await client.query(
      `INSERT INTO leave_accrual_log
         (employee_id, leave_type_id, year, month, days_accrued, accrual_type, run_by, run_mode, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [employeeId, leaveTypeId, year, month, amount, accrualType, runBy, runMode, companyId]
    );

    if (!claimed.length) {
      // Somebody — an earlier run, the cron, another instance, the same HR user
      // ten seconds ago — already claimed this exact period. The balance is NOT
      // touched. This is the branch that used to double-credit.
      await client.query('ROLLBACK');
      return 'already_accrued';
    }

    if (carryForward) {
      await client.query(
        `INSERT INTO leave_balances
           (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance, used_days)
         VALUES ($1, $2, $3, $4, $4, $4, 0)
         ON CONFLICT (employee_id, leave_type_id, year)
         DO UPDATE SET
           allocated_days       = leave_balances.allocated_days + $4,
           carried_forward_days = COALESCE(leave_balances.carried_forward_days, 0) + $4,
           opening_balance      = COALESCE(leave_balances.opening_balance, 0) + $4,
           updated_at           = NOW()`,
        [employeeId, leaveTypeId, year, amount]
      );
    } else {
      await client.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (employee_id, leave_type_id, year)
         DO UPDATE SET allocated_days = leave_balances.allocated_days + $4, updated_at = NOW()`,
        [employeeId, leaveTypeId, year, amount]
      );
    }

    await client.query('COMMIT');
    return 'credited';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pro-rate a month's accrual for an employee's joining date.
 *
 * Lifted verbatim from the two identical copies in accrual.routes.js and
 * leave.cron.js. Returns 0 when the employee had not joined yet, which the
 * callers treat as "skip", and 1 for a full month.
 *
 * ⚠ `joining_date` is a DATE column, so pg hands it back as a 'YYYY-MM-DD'
 * STRING, and `new Date('2026-03-15')` is parsed as UTC midnight while
 * `new Date(year, month-1, 1)` is LOCAL midnight. Comparing the two is how a
 * future-date guard elsewhere in this codebase failed open behind a UTC offset.
 * Here the comparison is done on the date PARTS rather than on Date objects, so
 * the server's timezone cannot change who gets accrued.
 */
export function proRationFactor(joiningDate, year, month) {
  if (!joiningDate) return 1;

  const raw = typeof joiningDate === 'string' ? joiningDate : joiningDate.toISOString();
  const [jy, jm, jd] = raw.slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(jy) || !Number.isFinite(jm) || !Number.isFinite(jd)) return 1;

  if (jy === year && jm === month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    return (daysInMonth - jd + 1) / daysInMonth;
  }
  // Joined after this period began — nothing accrues for it.
  if (jy > year || (jy === year && jm > month)) return 0;
  return 1;
}

/**
 * The accrual-eligible leave types for a company.
 *
 * `(company_id IS NULL OR company_id = $1)` is the pre-existing predicate in both
 * writers and is kept: a NULL-company leave type is a GLOBAL policy (the seeded
 * Earned Leave / Casual Leave set) that every company uses, so excluding it would
 * stop accrual for everyone. That is the opposite of the usual rule in this
 * codebase and is correct here because these rows are configuration, not tenant
 * data.
 */
async function monthlyAccrualTypes(companyId) {
  const { rows } = await pool.query(
    `SELECT id, leave_name, accrual_days_per_month
       FROM leave_types
      WHERE accrual_type = 'monthly'
        AND is_active = true AND deleted_at IS NULL
        AND accrual_days_per_month > 0
        AND (company_id IS NULL OR company_id = $1)`,
    [companyId ?? null]);
  return rows;
}

/**
 * The employees a period accrues for.
 *
 * `status IS DISTINCT FROM 'Left'` — the CRON's predicate, not the manual
 * carry-forward route's `status IN ('active','probation','notice')`. See the
 * header: that second one is lowercase against a Capitalized column and matched
 * nobody.
 */
async function accrualEmployees(companyId) {
  const { rows } = await pool.query(
    `SELECT id, joining_date FROM employees
      WHERE status IS DISTINCT FROM 'Left'
        AND deleted_at IS NULL
        AND ($1::integer IS NULL OR company_id = $1)`,
    [companyId ?? null]);
  return rows;
}

/**
 * Run monthly accrual for one company and one period.
 *
 * Safe to call any number of times for the same (company, month, year): the
 * second and later calls report everything as `skipped` and write nothing.
 *
 * @returns {Promise<{credited:number, skipped:number, failed:number,
 *                    employees:number, leave_types:number}>}
 */
export async function runMonthlyAccrual({ companyId = null, month, year, runMode = 'cron', runBy = null }) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw Object.assign(new Error('month must be an integer 1-12'), { status: 422 });
  }
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw Object.assign(new Error('year must be a four-digit year'), { status: 422 });
  }

  const leaveTypes = await monthlyAccrualTypes(companyId);
  const result = { credited: 0, skipped: 0, failed: 0, employees: 0, leave_types: leaveTypes.length };
  if (!leaveTypes.length) return result;

  const employees = await accrualEmployees(companyId);
  result.employees = employees.length;

  for (const emp of employees) {
    const factor = proRationFactor(emp.joining_date, y, m);
    if (factor <= 0) continue;

    for (const lt of leaveTypes) {
      const days = Number((lt.accrual_days_per_month * factor).toFixed(2));
      if (days <= 0) continue;
      try {
        const outcome = await creditAccrual({
          employeeId: emp.id, leaveTypeId: lt.id, year: y, month: m, days,
          accrualType: ACCRUAL_MONTHLY, runMode, runBy, companyId,
        });
        if (outcome === 'credited') result.credited++; else result.skipped++;
      } catch (err) {
        result.failed++;
        // Counters, not row content — never an employee name or a day count in a
        // log line. One employee's FK problem must not abort the whole company's
        // payroll-relevant accrual.
        console.error(`[leaveAccrual] employee ${emp.id} / type ${lt.id} ${y}-${m}: ${err.message}`);
      }
    }
  }
  return result;
}

/**
 * Year-end carry-forward for one company.
 *
 * Idempotent on (employee, leave_type, toYear, accrual_type='carry_forward') with
 * `month = NULL` — the index's `COALESCE(month, 0)` is what makes a NULL month a
 * real key component rather than a free pass, since NULL <> NULL in Postgres.
 *
 * ⚠ THE CAP IS COMPUTED FROM A BALANCE THIS FUNCTION IS ABOUT TO CHANGE. The
 * remaining days are read from `fromYear` and written into `toYear`, so the read
 * and the write are different rows and there is no self-reference — but running
 * this twice for the same fromYear WOULD have doubled the carry-forward, because
 * the source row is untouched by the first run. The log gate is what stops it, and
 * it is the only thing that could: no amount of care in the SELECT can tell
 * whether these days were already carried.
 */
export async function runCarryForward({ companyId = null, fromYear, runMode = 'cron', runBy = null }) {
  const from = Number(fromYear);
  if (!Number.isInteger(from)) {
    throw Object.assign(new Error('from_year must be a four-digit year'), { status: 422 });
  }
  const toYear = from + 1;

  const { rows: leaveTypes } = await pool.query(
    `SELECT id, leave_name, max_carry_forward_days
       FROM leave_types
      WHERE carry_forward_allowed = true AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)`,
    [companyId ?? null]);

  const result = { credited: 0, skipped: 0, failed: 0, from_year: from, to_year: toYear, leave_types: leaveTypes.length };
  if (!leaveTypes.length) return result;

  for (const lt of leaveTypes) {
    const { rows: balances } = await pool.query(
      `SELECT lb.employee_id,
              GREATEST(COALESCE(lb.allocated_days,0)
                     - COALESCE(lb.used_days,0)
                     - COALESCE(lb.encashed_days,0), 0) AS remaining
         FROM leave_balances lb
         JOIN employees e ON lb.employee_id = e.id
        WHERE lb.leave_type_id = $1 AND lb.year = $2
          AND e.status IS DISTINCT FROM 'Left'
          AND e.deleted_at IS NULL
          AND ($3::integer IS NULL OR e.company_id = $3)
          AND GREATEST(COALESCE(lb.allocated_days,0)
                     - COALESCE(lb.used_days,0)
                     - COALESCE(lb.encashed_days,0), 0) > 0`,
      [lt.id, from, companyId ?? null]);

    for (const bal of balances) {
      const carryDays = Math.min(Number(bal.remaining), Number(lt.max_carry_forward_days) || 0);
      if (carryDays <= 0) continue;
      try {
        const outcome = await creditAccrual({
          employeeId: bal.employee_id, leaveTypeId: lt.id, year: toYear, month: null,
          days: carryDays, accrualType: ACCRUAL_CARRY_FORWARD, runMode, runBy, companyId,
          carryForward: true,
        });
        if (outcome === 'credited') result.credited++; else result.skipped++;
      } catch (err) {
        result.failed++;
        console.error(`[leaveCarryForward] employee ${bal.employee_id} / type ${lt.id} -> ${toYear}: ${err.message}`);
      }
    }
  }
  return result;
}

export default { creditAccrual, runMonthlyAccrual, runCarryForward, proRationFactor };
