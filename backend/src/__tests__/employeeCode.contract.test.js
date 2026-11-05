/**
 * Employee ID must be server-generated, unique, non-null and in the company's own
 * format on EVERY creation path.
 *
 * The format is `EMP001` — no hyphen, three digits minimum, not capped at three
 * (`EMP1000` is the thousandth employee, not an error):
 *
 *     ^EMP[0-9]{3,}$
 *
 * ⚠ An earlier pass of mine adopted the DASHED `EMP-0001` instead, because
 * `shared/docNumber.js`, `utils/generateCode.js` and the recruitment hire path all
 * produced it — and backfilled 35 employees that way. Two of those three code
 * paths turned out to have no callers at all. The eight rows that predated
 * everything (`EMP001`…`EMP012`) were the real convention and were dismissed as
 * "legacy". Live data that predates the code is the spec; three agreeing code
 * paths are not. `renumber-employee-codes.mjs` undid it.
 *
 * The bug this locks down was live on 2026-09-28. `POST /employees` created a
 * second employee with office_id 'EMP001' in company 1, alongside employee id=1
 * which had held that code since February. Three independent causes stacked up:
 *
 *   1. the generator read `ORDER BY id DESC LIMIT 1` with NO company filter, so
 *      it saw another tenant's newest row;
 *   2. that row's office_id was NULL, so the generator took its "first ever
 *      employee" branch and returned 'EMP001';
 *   3. the only duplicate check in the function guarded the caller-supplied
 *      branch, so the auto-generated path — the one the UI uses — was unchecked;
 *   4. and `employees.office_id` had no unique index, so the database did not
 *      object either.
 *
 * The generator was also one row away from emitting a code that is not a code:
 * given 'EMP-0002', `parseInt('EMP-0002'.substring(3))` is -2, and the template
 * produced 'EMP0-1'. `codeSeq` and the format tests below pin both halves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const code = await import('../shared/employeeCode.js');
const { addEmployee } = await import('../employees/employee.service.js');

const {
  CODE_RE, codeSeq, formatEmployeeCode, isValidEmployeeCode,
  nextEmployeeCode, FIXTURE_CODE_SQL, FIXTURE_FLOOR,
} = code;

const COMPANY_ID = 1;
/** Distinct prefix so a sweep can never eat a real row. See TAG-collision note
 *  in the tenant fixture tests: match on the WHOLE tag, not a LIKE prefix. */
const TAG = 'ZZEMPCODE';

describe('employee code — pure helpers', () => {
  it('reads the numeric suffix of BOTH live code families the same way', () => {
    // The whole bug in one assertion: a fixed substring(3) offset cannot read
    // both, and reading one of them as a negative number is what produced
    // 'EMP0-1'.
    expect(codeSeq('EMP001')).toBe(1);
    expect(codeSeq('EMP012')).toBe(12);
    expect(codeSeq('EMP013')).toBe(13);
    expect(codeSeq('EMP1000')).toBe(1000);
    // Still reads a hyphenated straggler correctly. None should exist any more,
    // but a reader that copes with one is what let the renumbering script and the
    // generator agree during the migration instead of producing -2.
    expect(codeSeq('EMP-0001')).toBe(1);
    expect(codeSeq(null)).toBeNull();
    expect(codeSeq('EMP')).toBeNull();
  });

  it('never produces a negative or malformed code from any legal input', () => {
    for (const input of ['EMP001', 'EMP012', 'EMP999', 'EMP1000', 'EMP-0001', null, undefined, '', 'EMP']) {
      const next = formatEmployeeCode((codeSeq(input) ?? 0) + 1);
      expect(next, `from ${JSON.stringify(input)}`).toMatch(CODE_RE);
    }
  });

  it('accepts the company convention, at three digits and beyond', () => {
    // 999 employees is not a ceiling: padStart pads, it never truncates.
    for (const good of ['EMP001', 'EMP002', 'EMP009', 'EMP012', 'EMP013', 'EMP036',
                        'EMP099', 'EMP100', 'EMP999', 'EMP1000', 'EMP12345']) {
      expect(isValidEmployeeCode(good), good).toBe(true);
    }
  });

  it('rejects the hyphenated form, short forms and anything else', () => {
    for (const bad of [
      'EMP-001', 'EMP-012', 'EMP-0013', 'EMP-0001',   // the shape this replaced
      'EMP01', 'EMP1',                                 // too few digits
      'EMP 001', 'EMPABC', 'ABC001', 'emp001',         // not the convention at all
      'EMP0-1',                                        // what the broken generator emitted
      '', 'EMP', '0001', null, undefined,
    ]) {
      expect(isValidEmployeeCode(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('formats a number into the convention', () => {
    const cases = [[1, 'EMP001'], [2, 'EMP002'], [9, 'EMP009'], [10, 'EMP010'],
                   [12, 'EMP012'], [13, 'EMP013'], [36, 'EMP036'],
                   [100, 'EMP100'], [999, 'EMP999'], [1000, 'EMP1000']];
    for (const [n, want] of cases) {
      expect(formatEmployeeCode(n), String(n)).toBe(want);
      expect(isValidEmployeeCode(want), want).toBe(true);
    }
  });
});

describe('employee code — generator against the live database', () => {
  it('continues from the highest SUFFIX, not the highest row id', async () => {
    // EMP001, EMP002, EMP005 -> EMP006. Not EMP003 (a gap is left alone: reissuing
    // a removed employee's number to someone else is worse than a gap) and not
    // derived from employees.id.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A private company, so the fixture controls the whole series.
      const { rows: [co] } = await client.query(
        `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
        [`${TAG} seq co`, `${TAG}SEQ`]);
      for (const code of ['EMP001', 'EMP002', 'EMP005']) {
        await client.query(
          `INSERT INTO employees (office_id, first_name, company_email, company_id,
                                  department, designation, status, joining_date)
           VALUES ($1, $2, $3, $4, 'IT', 'Engineer', 'Active', CURRENT_DATE)`,
          [code, `${TAG}${code}`, `${TAG}.${code}@probe.test`.toLowerCase(), co.id]);
      }
      expect(await nextEmployeeCode(client, co.id)).toBe('EMP006');
      await client.query('ROLLBACK');
    } finally { client.release(); }
  }, 20000);

  it('ignores fixture-range codes so a test row cannot hijack a real series', async () => {
    // FIXTURE_CODE_SQL mints from 900000+. integration.reports.test.js inserts one
    // of those into COMPANY 1 — without this exclusion the next real hire there
    // would be EMP900002 and the company's numbering would be abandoned.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [co] } = await client.query(
        `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
        [`${TAG} fix co`, `${TAG}FIX`]);
      await client.query(
        `INSERT INTO employees (office_id, first_name, company_email, company_id,
                                department, designation, status, joining_date)
         VALUES ('EMP007', $1, $2, $3, 'IT', 'Engineer', 'Active', CURRENT_DATE)`,
        [`${TAG}real`, `${TAG}.real@probe.test`.toLowerCase(), co.id]);
      await client.query(
        `INSERT INTO employees (office_id, first_name, company_email, company_id,
                                department, designation, status, joining_date)
         VALUES (${FIXTURE_CODE_SQL}, $1, $2, $3, 'IT', 'Engineer', 'Active', CURRENT_DATE)`,
        [`${TAG}fix`, `${TAG}.fix@probe.test`.toLowerCase(), co.id]);
      expect(await nextEmployeeCode(client, co.id)).toBe('EMP008');
      await client.query('ROLLBACK');
    } finally { client.release(); }
  }, 20000);

  it('is company-scoped, and reads any EMP-prefixed code', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const next = await nextEmployeeCode(client, COMPANY_ID);
      expect(next).toMatch(CODE_RE);

      // Past the highest suffix in this company, fixture range excluded.
      const { rows: [{ max_seq }] } = await client.query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM (
           SELECT NULLIF(REGEXP_REPLACE(office_id,'\\D','','g'),'')::bigint AS seq
             FROM employees WHERE company_id = $1 AND office_id ~ '^EMP'
         ) s WHERE seq < 900000`,
        [COMPANY_ID],
      );
      expect(codeSeq(next)).toBe(Number(max_seq) + 1);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  it('refuses to run without an explicit scope', async () => {
    const client = await pool.connect();
    try {
      // `undefined` = a caller forgot; `null` = deliberately global. Conflating
      // them is how a tenant filter goes missing without anyone noticing.
      await expect(nextEmployeeCode(client, undefined)).rejects.toThrow(/companyId is required/);
    } finally { client.release(); }
  });

  it('never returns a code that is already in use in that company', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const next = await nextEmployeeCode(client, COMPANY_ID);
      const { rows } = await client.query(
        `SELECT id FROM employees WHERE LOWER(office_id) = LOWER($1) AND company_id = $2`,
        [next, COMPANY_ID],
      );
      expect(rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});

describe('employee code — database guards', () => {
  it('a per-company unique index exists on LOWER(office_id)', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'employees' AND indexname = 'employees_office_id_company_uniq'`,
    );
    expect(rows, 'migration 20260928000001 has not been applied').toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/lower\(\(?office_id/i);
    expect(rows[0].indexdef).toMatch(/company_id/);
  });

  it('the database refuses a duplicate code inside one company', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(
        `INSERT INTO employees (first_name, company_email, company_id, office_id, department, designation, status)
         VALUES ($1, $2, $3, 'EMP001', 'IT', 'Engineer', 'Active')`,
        [`${TAG}_dup`, `${TAG}_dup@probe.test`, COMPANY_ID],
      )).rejects.toThrow(/employees_office_id_company_uniq/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the database refuses every non-canonical shape', async () => {
    // Including the hyphenated form, which this constraint used to allow.
    for (const bad of ['EMP0-1', 'EMP-001', 'EMP-0013', 'EMP01', 'EMP1', 'EMPABC', 'ABC001']) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query(
          `INSERT INTO employees (first_name, company_email, company_id, office_id, department, designation, status)
           VALUES ($1, $2, $3, $4, 'IT', 'Engineer', 'Active')`,
          [`${TAG}_fmt`, `${TAG}_fmt_${bad}@probe.test`, COMPANY_ID, bad],
        ), bad).rejects.toThrow(/employees_office_id_format/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  }, 20000);

  it('the database accepts four-digit and longer codes', async () => {
    // 999 employees must not be a hard ceiling.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const good of ['EMP1000', 'EMP12345']) {
        const r = await client.query(
          `INSERT INTO employees (first_name, company_email, company_id, office_id, department, designation, status, joining_date)
           VALUES ($1, $2, $3, $4, 'IT', 'Engineer', 'Active', CURRENT_DATE) RETURNING office_id`,
          [`${TAG}_big`, `${TAG}_big_${good}@probe.test`, COMPANY_ID, good]);
        expect(r.rows[0].office_id).toBe(good);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 20000);

  it('an EMP001-style row is still editable after the strict CHECK', async () => {
    // ⚠ Postgres evaluates a CHECK on every UPDATE as well as every INSERT, NOT
    // VALID included — NOT VALID only skips the initial table scan. So a CHECK
    // that ANY live row fails turns every later edit of that row into a 400:
    // changing a phone number rejected because of an Employee ID nobody touched.
    // The constraint is only safe because every row satisfies it, which
    // 20260928000004 proves by adding it VALID after renumbering. These are the
    // ordinary edits from §5 of the review.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [emp] } = await client.query(
        `SELECT id FROM employees WHERE office_id = 'EMP001' AND company_id = $1`,
        [COMPANY_ID]);
      expect(emp, 'company 1 should still hold EMP001').toBeDefined();
      for (const [col, val] of [
        ['first_name', 'ZZEdited'], ['phone', '9998887776'], ['department', 'IT'],
        ['designation', 'Engineer'], ['status', 'Probation'],
      ]) {
        const res = await client.query(
          `UPDATE employees SET ${col} = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
          [val, emp.id]);
        expect(res.rowCount, `editing ${col} on EMP001`).toBe(1);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 20000);
});

describe('POST /employees creation contract', () => {
  const created = [];

  const base = (n) => ({
    company_id: COMPANY_ID,
    first_name: `${TAG}${n}`,
    last_name: 'Probe',
    company_email: `${TAG.toLowerCase()}${n}@probe.test`,
    department: 'IT',
    designation: 'Manager',
    status: 'Active',
    // Required on create since 2026-09-28 — a missing joining_date puts the
    // employee outside every hiring window and into the tenure chart's
    // 'Not recorded' bucket, which getEmployeeAnalytics already calls critical.
    joining_date: '2026-01-15',
  });

  afterAll(async () => {
    // Match on the WHOLE tag in the email, never a LIKE prefix: a sweep on
    // `LIKE 'ZZEMPCODE%'` would also eat 'ZZEMPCODE2A' created by a concurrent
    // run. Login rows first — users.employee_id references employees.
    for (const id of created) {
      await pool.query(`DELETE FROM user_scope WHERE user_id IN (SELECT id FROM users WHERE employee_id = $1)`, [id]);
      await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE employee_id = $1)`, [id]);
      await pool.query(`DELETE FROM users WHERE employee_id = $1`, [id]);
      await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id = $1`, [id]);
      await pool.query(`DELETE FROM employees WHERE id = $1`, [id]);
    }
    // NOT pool.end() — the pool is shared across suites.
  });

  it('mints a valid, unique, non-null Employee ID with no code supplied', async () => {
    const a = await addEmployee(base('A'));
    created.push(a.id);
    expect(a.office_id).toMatch(CODE_RE);

    const b = await addEmployee(base('B'));
    created.push(b.id);
    expect(b.office_id).toMatch(CODE_RE);

    // Consecutive, and — the actual regression — DIFFERENT. Two sequential
    // creates both returned 'EMP001' before this change.
    expect(b.office_id).not.toBe(a.office_id);
    expect(codeSeq(b.office_id)).toBe(codeSeq(a.office_id) + 1);
  }, 20000);

  it('rejects a duplicate caller-supplied Employee ID', async () => {
    await expect(addEmployee({ ...base('C'), office_id: 'EMP001' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a malformed caller-supplied Employee ID before it reaches SQL', async () => {
    for (const bad of ['EMP0-1', 'EMP-0013', 'EMP01', 'EMPABC']) {
      await expect(addEmployee({ ...base('D'), office_id: bad }), bad)
        .rejects.toThrow(/not a valid Employee ID/);
    }
  });

  for (const field of ['department', 'designation', 'status', 'joining_date']) {
    it(`rejects a create with no ${field}`, async () => {
      const body = { ...base('E') };
      delete body[field];
      await expect(addEmployee(body)).rejects.toThrow(/required/i);
    });

    it(`rejects a create with a BLANK ${field}`, async () => {
      // '' is what the Add Employee form POSTs for an untouched picker, and it
      // passed every `!value` guard in addEmployee. This is the case that
      // produced 24 register rows reading Department: —.
      await expect(addEmployee({ ...base('F'), [field]: '   ' }))
        .rejects.toThrow(/required/i);
    });
  }

  it('rejects a status outside the canonical WRITE vocabulary', async () => {
    await expect(addEmployee({ ...base('G'), status: 'Inactive' }))
      .rejects.toThrow(/not a valid employment status/);
    await expect(addEmployee({ ...base('H'), status: 'notice_period' }))
      .rejects.toThrow(/not a valid employment status/);
  });

  it('normalises the case of a canonical status rather than storing a new variant', async () => {
    const e = await addEmployee({ ...base('I'), status: 'notice' });
    created.push(e.id);
    expect(e.status).toBe('Notice');
  }, 20000);

  it('rejects a duplicate company email', async () => {
    const e = await addEmployee(base('J'));
    created.push(e.id);
    await expect(addEmployee({ ...base('J'), first_name: `${TAG}J2` }))
      .rejects.toMatchObject({ statusCode: 409 });
  }, 20000);

  it('rejects a malformed company email', async () => {
    // company_email becomes the LOGIN identity (createEmployeeLogin keys the
    // users row on it), and the API used to accept any non-empty string.
    await expect(addEmployee({ ...base('L'), company_email: 'not-an-email' }))
      .rejects.toThrow(/not a valid company email/i);
  });

  it('rejects an unparseable joining date as a 400, not a 500 from Postgres', async () => {
    await expect(addEmployee({ ...base('M'), joining_date: '15/01/2026' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('allows a near-future joining date but refuses an implausible one', async () => {
    const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const e = await addEmployee({ ...base('N'), joining_date: soon });
    created.push(e.id);
    expect(String(e.joining_date).slice(0, 10)).toBe(soon);

    const far = new Date(Date.now() + 4 * 365 * 864e5).toISOString().slice(0, 10);
    await expect(addEmployee({ ...base('O'), joining_date: far }))
      .rejects.toThrow(/more than two years in the future/);
  }, 20000);

  /**
   * The race the advisory lock exists for.
   *
   * MAX()+1 is a check-then-act pair: without serialisation, N simultaneous
   * creates all read the same max and all mint the same code. Sequential tests
   * cannot see this — the two consecutive creates above pass either way.
   *
   * 5 in parallel, not more: `db.js` caps the pool at 6 in test mode and the pool
   * is SHARED across suites in a vitest worker. Asking for more connections than
   * the cap would be testing the pool's queue rather than the generator, and
   * (per the pool-exhaustion incident in BATCH 01) reads as a bare 500 after a
   * multi-second stall. addEmployee holds exactly one connection and never asks
   * for a second while holding it, so 5 is safe.
   */
  it('mints distinct codes under concurrent creation', async () => {
    const n = 5;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => addEmployee(base(`CC${i}`))),
    );

    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    for (const e of ok) created.push(e.id);

    const failures = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    expect(failures, `concurrent creates must not fail: ${failures.join(' | ')}`).toEqual([]);
    expect(ok).toHaveLength(n);

    // Every code well-formed, and every code DIFFERENT. A duplicate here is the
    // exact production defect: two employees, one Employee ID.
    const codes = ok.map(e => e.office_id);
    for (const c of codes) expect(c, `${c} is malformed`).toMatch(CODE_RE);
    expect(new Set(codes).size, `duplicate codes minted: ${codes.join(', ')}`).toBe(n);

    // Contiguous, which proves they were serialised rather than merely lucky.
    const seqs = codes.map(codeSeq).sort((x, y) => x - y);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(n - 1);

    // And the database agrees — not just the returned objects.
    const { rows } = await pool.query(
      `SELECT LOWER(office_id) AS c, COUNT(*)::int AS n FROM employees
        WHERE id = ANY($1::int[]) GROUP BY 1 HAVING COUNT(*) > 1`,
      [ok.map(e => e.id)],
    );
    expect(rows).toEqual([]);
  }, 45000);

  /**
   * The review's scenario, verbatim: highest code EMP012, five concurrent
   * creations, expect EMP013-EMP017.
   *
   * A private company seeded to exactly EMP012 — company 1's highest is now
   * EMP038, so a demonstration there would prove the same property while showing
   * different numbers, and a test whose expectation drifts with the seed data is a
   * test nobody trusts. The seed deliberately contains GAPS (no 004, no 006-009,
   * no 011) to prove the generator follows the highest SUFFIX rather than a count
   * and does not backfill a departed employee's number.
   */
  it('5 concurrent creates after EMP012 produce EMP013-EMP017, no duplicates, no gaps', async () => {
    const tag = `${TAG}CC${Date.now().toString(36)}`;
    const { rows: [co] } = await pool.query(
      `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`,
      [`${tag} concurrency`, tag.slice(0, 40)]);
    const madeEmployees = [];
    try {
      for (const code of ['EMP001', 'EMP002', 'EMP003', 'EMP005', 'EMP010', 'EMP012']) {
        await pool.query(
          `INSERT INTO employees (office_id, first_name, company_email, company_id,
                                  department, designation, status, joining_date)
           VALUES ($1, $2, $3, $4, 'IT', 'Engineer', 'Active', CURRENT_DATE)`,
          [code, `${tag}${code}`, `${tag}.${code}@conc.test`.toLowerCase(), co.id]);
      }

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => addEmployee({
          company_id: co.id,
          first_name: `${tag}C${i}`, last_name: 'Concurrent',
          company_email: `${tag}.c${i}@conc.test`.toLowerCase(),
          department: 'IT', designation: 'Engineer', status: 'Active',
          joining_date: '2026-01-15',
        })));

      const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      for (const e of ok) madeEmployees.push(e.id);
      const errs = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
      expect(errs, `concurrent creates must not fail: ${errs.join(' | ')}`).toEqual([]);

      const codes = ok.map(e => e.office_id).sort();
      expect(codes).toEqual(['EMP013', 'EMP014', 'EMP015', 'EMP016', 'EMP017']);
      expect(new Set(codes).size).toBe(5);

      // And the database agrees, not just the returned objects.
      const { rows: dupes } = await pool.query(
        `SELECT office_id FROM employees WHERE company_id = $1
          GROUP BY 1 HAVING COUNT(*) > 1`, [co.id]);
      expect(dupes).toEqual([]);
    } finally {
      // Logins first — users.employee_id references employees.
      for (const id of madeEmployees) {
        await pool.query(`DELETE FROM user_scope WHERE user_id IN (SELECT id FROM users WHERE employee_id=$1)`, [id]);
        await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE employee_id=$1)`, [id]);
        await pool.query(`DELETE FROM users WHERE employee_id=$1`, [id]);
        await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id=$1`, [id]);
      }
      await pool.query(`DELETE FROM user_scope WHERE company_id=$1`, [co.id]);
      await pool.query(`DELETE FROM users WHERE employee_id IN (SELECT id FROM employees WHERE company_id=$1)`, [co.id]);
      await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id IN (SELECT id FROM employees WHERE company_id=$1)`, [co.id]);
      await pool.query(`DELETE FROM employees WHERE company_id=$1`, [co.id]);
      // talent.routes.js seeds default interview questions for EVERY active
      // company when imported (integration.recruitmentRegression does, in
      // parallel); if that lands while this company exists, the FK blocks the
      // DELETE below and the company leaks.
      await pool.query(`DELETE FROM interview_questions WHERE company_id=$1`, [co.id]);
      await pool.query(`DELETE FROM companies WHERE id=$1`, [co.id]);
    }
  }, 60000);

  it('never stores the STRING "null" in reporting_manager', async () => {
    // Three live rows hold it, which is why the Manager column rendered `null`.
    const e = await addEmployee({ ...base('K'), reporting_manager: 'null' });
    created.push(e.id);
    expect(e.reporting_manager).toBe('');
  }, 20000);
});
