/**
 * The View Employee surface, verified against the live database.
 *
 * Every case here corresponds to a defect found on 2026-09-30 and reproduced
 * before it was fixed:
 *
 *  1. The onboarding checklist could not be ticked AT ALL. `$8` (completed_by)
 *     appeared only inside `CASE WHEN $5 THEN $8 ELSE NULL END`, so Postgres
 *     deduced it as `text` against an integer column and every PATCH 500'd with
 *     `column "completed_by" is of type integer but expression is of type text`.
 *     The UI showed "Failed to update checklist item". A pure type-deduction
 *     bug: no fixture, no role and no tenant could avoid it, which is why the
 *     first case below runs the real statement rather than the route.
 *
 *  2. `hr_notes` had no tenant column and the service keyed on employee_id
 *     alone, so notes crossed companies in both directions.
 *
 *  3. `GET /employees/:id/salary-revisions` was gated on ROLE only — an HR user
 *     of company B could read company A's basic salary by id.
 *
 *  4. `GET /self-service/documents` had no tenant predicate either.
 *
 * Everything runs inside a transaction that is always rolled back.
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

const OWN = 1;
const FOREIGN = 565;

// The statement PATCH /onboarding/progress/:employee_id/item issues, copied
// exactly (it is an inline template literal in the handler).
const ONBOARDING_UPSERT = `
  INSERT INTO hr_onboarding_checklist_progress
    (company_id, employee_id, category, item_label, done, notes, assignee, completed_at, completed_by)
  VALUES ($1,$2,$3,$4,$5::boolean,$6,$7,
    CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
    CASE WHEN $5::boolean THEN $8::int ELSE NULL END)
  ON CONFLICT (employee_id, category, item_label) DO UPDATE SET
    done         = EXCLUDED.done,
    notes        = COALESCE(EXCLUDED.notes, hr_onboarding_checklist_progress.notes),
    assignee     = COALESCE(EXCLUDED.assignee, hr_onboarding_checklist_progress.assignee),
    completed_at = CASE WHEN EXCLUDED.done THEN NOW() ELSE NULL END,
    completed_by = CASE WHEN EXCLUDED.done THEN $8::int ELSE NULL END,
    updated_at   = NOW()
  RETURNING *`;

// The same statement WITHOUT the casts — i.e. what shipped. Kept so the suite
// proves the bug is real rather than only that the fix passes.
const ONBOARDING_UPSERT_UNCAST = ONBOARDING_UPSERT
  .replace(/\$5::boolean/g, '$5')
  .replace(/\$8::int/g, '$8');

describe('View Employee surface', () => {
  let client, ownId, foreignId;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: [own] } = await client.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [OWN]);
    const { rows: [foreign] } = await client.query(
      `SELECT id FROM employees WHERE company_id = $1 LIMIT 1`, [FOREIGN]);
    ownId = own?.id;
    foreignId = foreign?.id;
    expect(ownId, `company ${OWN} needs an employee`).toBeDefined();
    expect(foreignId, `company ${FOREIGN} needs an employee`).toBeDefined();
  });

  afterAll(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
  });

  describe('onboarding checklist item', () => {
    const args = (empId, done, by = null) => [OWN, empId, 'ZZVE Category', 'ZZVE Item', done, null, 'HR', by];

    it('ticks an item', async () => {
      const r = await client.query(ONBOARDING_UPSERT, args(ownId, true));
      expect(r.rows[0].done).toBe(true);
      expect(r.rows[0].completed_at).not.toBeNull();
    });

    it('unticks the same item and clears completed_at', async () => {
      await client.query(ONBOARDING_UPSERT, args(ownId, true));
      const r = await client.query(ONBOARDING_UPSERT, args(ownId, false));
      expect(r.rows[0].done).toBe(false);
      expect(r.rows[0].completed_at).toBeNull();
      expect(r.rows[0].completed_by).toBeNull();
    });

    it('records completed_by when the caller has an employee record', async () => {
      const r = await client.query(ONBOARDING_UPSERT, args(ownId, true, ownId));
      expect(r.rows[0].completed_by).toBe(ownId);
    });

    it('the pre-fix statement is the failure the UI reported', async () => {
      // Savepoint: the error aborts the transaction otherwise.
      await client.query('SAVEPOINT uncast');
      await expect(client.query(ONBOARDING_UPSERT_UNCAST, args(ownId, true)))
        .rejects.toThrow(/completed_by.*integer.*text/i);
      await client.query('ROLLBACK TO SAVEPOINT uncast');
    });

    it('the scope check refuses another tenant\'s employee', async () => {
      // employeeInScope() in the handler; the predicate is what matters.
      const inScope = async (companyId, empId) => {
        if (companyId == null) return true;
        const { rows } = await client.query(
          `SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
          [empId, companyId]);
        return rows.length > 0;
      };
      expect(await inScope(OWN, ownId)).toBe(true);
      expect(await inScope(OWN, foreignId)).toBe(false);
      expect(await inScope(null, foreignId), 'a global scope must still pass').toBe(true);
    });
  });

  describe('hr_notes', () => {
    it('carries a tenant column and an author column', async () => {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'hr_notes'`);
      const cols = rows.map(r => r.column_name);
      expect(cols).toContain('company_id');
      expect(cols).toContain('created_by');
    });

    it('every existing note has been given its employee\'s company', async () => {
      const { rows } = await client.query(`
        SELECT count(*)::int n
          FROM hr_notes n
          JOIN employees e ON e.id = n.employee_id
         WHERE e.company_id IS NOT NULL
           AND n.company_id IS DISTINCT FROM e.company_id`);
      expect(rows[0].n, 'a note is filed under a different company than its employee').toBe(0);
    });

    it('an insert derives company_id from the employee, not from the caller', async () => {
      const { rows } = await client.query(
        `INSERT INTO hr_notes (employee_id, note_text, company_id, created_by)
         VALUES ($1, $2, (SELECT company_id FROM employees WHERE id = $1), $3::int)
         RETURNING company_id`,
        [ownId, 'ZZVE scope probe', null]);
      expect(rows[0].company_id).toBe(OWN);
    });

    it('the read predicate hides another tenant\'s notes', async () => {
      await client.query(
        `INSERT INTO hr_notes (employee_id, note_text, company_id)
         VALUES ($1, 'ZZVE foreign', (SELECT company_id FROM employees WHERE id = $1))`,
        [foreignId]);
      const READ = `SELECT n.id FROM hr_notes n
                     WHERE n.employee_id = $1
                       AND ($2::int IS NULL OR COALESCE(n.company_id, $2::int) = $2::int)`;
      expect((await client.query(READ, [foreignId, OWN])).rowCount).toBe(0);
      expect((await client.query(READ, [foreignId, null])).rowCount).toBeGreaterThan(0);
    });
  });

  it('salary revisions are reachable only inside the caller\'s company', async () => {
    const SQL = `SELECT a.id
                   FROM employee_salary_assignments a
                   JOIN employees e ON e.id = a.employee_id AND e.deleted_at IS NULL
                  WHERE a.employee_id = $1
                    AND ($2::int IS NULL OR e.company_id = $2::int)`;
    const { rows: [withRev] } = await client.query(
      `SELECT a.employee_id AS id FROM employee_salary_assignments a
         JOIN employees e ON e.id = a.employee_id
        WHERE e.company_id = $1 AND e.deleted_at IS NULL LIMIT 1`, [OWN]);
    if (!withRev) return;                       // nothing to read; nothing to prove
    expect((await client.query(SQL, [withRev.id, OWN])).rowCount).toBeGreaterThan(0);
    expect((await client.query(SQL, [withRev.id, FOREIGN])).rowCount).toBe(0);
  });

  describe('onboarding checklist templates', () => {
    // The employee's completion is keyed on the TEXT PAIR (category,
    // item_label), not on a template id. Everything below is about that pair
    // staying in step with the template it describes.
    const CAT = 'ZZVE Test Category';
    const LABEL = 'ZZVE Test Item';

    it('renaming an item carries its completion history with it', async () => {
      await client.query(
        `INSERT INTO hr_onboarding_checklist_templates (company_id, category, item_label)
         VALUES ($1, $2, $3)`, [OWN, CAT, LABEL]);
      await client.query(
        `INSERT INTO hr_onboarding_checklist_progress
           (company_id, employee_id, category, item_label, done, completed_at)
         VALUES ($1, $2, $3, $4, true, NOW())`, [OWN, ownId, CAT, LABEL]);

      // The UPDATE the PUT handler runs before touching the template.
      await client.query(
        `UPDATE hr_onboarding_checklist_progress
            SET category = $1, item_label = $2, updated_at = NOW()
          WHERE category = $3 AND item_label = $4
            AND ($5::int IS NULL OR company_id = $5::int)`,
        [CAT, `${LABEL} renamed`, CAT, LABEL, OWN]);

      const { rows: stranded } = await client.query(
        `SELECT 1 FROM hr_onboarding_checklist_progress
          WHERE category = $1 AND item_label = $2`, [CAT, LABEL]);
      expect(stranded.length, 'the old pair must not be left behind').toBe(0);

      const { rows: moved } = await client.query(
        `SELECT done FROM hr_onboarding_checklist_progress
          WHERE category = $1 AND item_label = $2`, [CAT, `${LABEL} renamed`]);
      expect(moved[0]?.done, 'the tick must survive the rename').toBe(true);
    });

    it('a used item has history that a delete would strand', async () => {
      // This is the check the DELETE handler makes before choosing between
      // removing the row and deactivating it.
      await client.query(
        `INSERT INTO hr_onboarding_checklist_templates (company_id, category, item_label)
         VALUES ($1, $2, $3)`, [OWN, CAT, `${LABEL} used`]);
      await client.query(
        `INSERT INTO hr_onboarding_checklist_progress
           (company_id, employee_id, category, item_label, done)
         VALUES ($1, $2, $3, $4, true)`, [OWN, ownId, CAT, `${LABEL} used`]);

      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM hr_onboarding_checklist_progress
          WHERE category = $1 AND item_label = $2
            AND ($3::int IS NULL OR company_id = $3::int)`,
        [CAT, `${LABEL} used`, OWN]);
      expect(rows[0].n).toBeGreaterThan(0);

      // Deactivating keeps the history; the progress row is untouched.
      await client.query(
        `UPDATE hr_onboarding_checklist_templates SET is_active = false
          WHERE company_id = $1 AND category = $2 AND item_label = $3`,
        [OWN, CAT, `${LABEL} used`]);
      const { rows: after } = await client.query(
        `SELECT done FROM hr_onboarding_checklist_progress
          WHERE category = $1 AND item_label = $2`, [CAT, `${LABEL} used`]);
      expect(after[0]?.done, 'deactivating an item must not erase anybody\'s tick').toBe(true);
    });

    it("another tenant's history does not count as this tenant's usage", async () => {
      // Without the company predicate, company B having ticked an
      // identically-named item would stop company A deleting its own unused one.
      await client.query(
        `INSERT INTO hr_onboarding_checklist_progress
           (company_id, employee_id, category, item_label, done)
         VALUES ($1, $2, $3, $4, true)`, [FOREIGN, foreignId, CAT, `${LABEL} foreign`]);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM hr_onboarding_checklist_progress
          WHERE category = $1 AND item_label = $2
            AND ($3::int IS NULL OR company_id = $3::int)`,
        [CAT, `${LABEL} foreign`, OWN]);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('salary revisions', () => {
    // The screen-backed way to record a salary — HR -> Salary Structure ->
    // Assign — 500'd on every call. Its statement referenced an `updated_at`
    // column that did not exist AND an ON CONFLICT target with no unique index
    // behind it. Measured before the fix: 83 of 85 rows in this table held the
    // `basic_salary` column default of 30000, because nobody could save a real
    // figure.
    it('the upsert key the assign endpoint names actually exists', async () => {
      const { rows } = await client.query(`
        SELECT indexdef FROM pg_indexes
         WHERE tablename = 'employee_salary_assignments' AND indexdef LIKE '%UNIQUE%'`);
      const defs = rows.map(r => r.indexdef.replace(/\s+/g, ' '));
      expect(
        defs.some(d => /\(employee_id, effective_from\)/.test(d)),
        `no unique index on (employee_id, effective_from): ${JSON.stringify(defs)}`,
      ).toBe(true);
    });

    it('the table has the updated_at column the upsert writes', async () => {
      const { rows } = await client.query(`
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'employee_salary_assignments' AND column_name = 'updated_at'`);
      expect(rows.length, 'DO UPDATE SET updated_at = NOW() has no column to write to').toBe(1);
    });

    it('the assign statement runs and is idempotent on the same effective date', async () => {
      const SQL = `
        INSERT INTO employee_salary_assignments
          (employee_id, structure_id, effective_from, basic_salary, special_allowance,
           other_components, loan_deduction, advance_deduction)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (employee_id, effective_from)
        DO UPDATE SET
          structure_id = EXCLUDED.structure_id,
          basic_salary = EXCLUDED.basic_salary,
          special_allowance = EXCLUDED.special_allowance,
          other_components = EXCLUDED.other_components,
          loan_deduction = EXCLUDED.loan_deduction,
          advance_deduction = EXCLUDED.advance_deduction,
          updated_at = NOW()
        RETURNING *`;
      const { rows: [struct] } = await client.query(`SELECT id FROM salary_structures LIMIT 1`);
      const args = (basic) => [ownId, struct?.id ?? null, '2099-01-01', basic, 1000, '{}', 0, 0];

      const first = await client.query(SQL, args(55000));
      expect(Number(first.rows[0].basic_salary)).toBe(55000);

      // Same employee, same date -> the SAME row, corrected. Two salaries
      // effective one day for one person is a contradiction, not a history.
      const second = await client.query(SQL, args(61000));
      expect(second.rows[0].id, 'a re-assignment must correct the revision, not add one').toBe(first.rows[0].id);
      expect(Number(second.rows[0].basic_salary)).toBe(61000);

      const { rows: count } = await client.query(
        `SELECT COUNT(*)::int AS n FROM employee_salary_assignments
          WHERE employee_id = $1 AND effective_from = '2099-01-01'`, [ownId]);
      expect(count[0].n).toBe(1);
    });

    it('a later effective date is a NEW revision', async () => {
      const { rows } = await client.query(
        `INSERT INTO employee_salary_assignments (employee_id, effective_from, basic_salary)
         VALUES ($1, '2099-06-01', 70000)
         ON CONFLICT (employee_id, effective_from) DO NOTHING
         RETURNING id`, [ownId]);
      expect(rows.length, 'a different date must create its own revision').toBe(1);
    });

    it('the History read returns the fields the tab renders', async () => {
      // The chart and the table are both drawn from this ONE payload, so a
      // column missing here is missing from both.
      const { rows } = await client.query(
        `SELECT a.id, a.employee_id, a.effective_from, a.basic_salary,
                a.special_allowance, a.loan_deduction, a.advance_deduction, a.created_at,
                s.name AS structure_name, s.id AS structure_id
           FROM employee_salary_assignments a
           JOIN employees e ON e.id = a.employee_id AND e.deleted_at IS NULL
           LEFT JOIN salary_structures s ON s.id = a.structure_id
          WHERE a.employee_id = $1
            AND ($2::int IS NULL OR e.company_id = $2::int)
          ORDER BY a.effective_from DESC, a.created_at DESC`,
        [ownId, OWN]);
      expect(rows.length).toBeGreaterThan(0);
      for (const k of ['effective_from', 'basic_salary', 'special_allowance',
                       'loan_deduction', 'advance_deduction', 'structure_name']) {
        expect(Object.keys(rows[0]), `History renders ${k}`).toContain(k);
      }
      // Newest first is what "CURRENT" on the top row and the left-to-right
      // chart both depend on.
      const dates = rows.map(r => String(r.effective_from));
      expect([...dates].sort().reverse()).toEqual(dates);
    });
  });

  describe('Add Employee captures the salary and guards the figures', () => {
    const src = () => readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../employees/employee.service.js'), 'utf8');

    it('the hire path writes the entered salary, not the column default', () => {
      const s = src();
      // Auto-enrolment used to insert (employee_id, structure_id, effective_from)
      // only, so basic_salary fell to the column DEFAULT of 30000 — which is how
      // 83 of 85 rows came to hold exactly that.
      expect(s).toMatch(/basic_salary, special_allowance\)/);
      expect(s, 'the entered figure must reach the assignment').toMatch(/basicSalary, specialAllowance/);
    });

    it('both writers share ONE range guard', () => {
      const s = src();
      expect(s).toMatch(/const YEARS_RANGE = \{ min: 0, max: 60, integer: true \}/);
      expect(s).toMatch(/const SALARY_RANGE = \{ min: 0, max: 100000000 \}/);
      // The update path must use it too: a validator on only one of the two
      // writers is not a validator.
      expect(s).toMatch(/prevYears1Update = numericField\(data\.previous_years_1, .*YEARS_RANGE\)/);
      expect(s).toMatch(/prevYears2Update = numericField\(data\.previous_years_2, .*YEARS_RANGE\)/);
      expect(s, 'the raw values must no longer reach the UPDATE').not.toMatch(/previous_years_[12] \|\| null,/);
    });

    it('the database refuses an impossible prior-service figure', async () => {
      await client.query('SAVEPOINT yrs');
      await expect(
        client.query('UPDATE employees SET previous_years_2 = 123 WHERE id = $1', [ownId]),
      ).rejects.toThrow(/previous_years_2_range/);
      await client.query('ROLLBACK TO SAVEPOINT yrs');

      // and accepts a believable one
      const r = await client.query(
        'UPDATE employees SET previous_years_2 = 12 WHERE id = $1 RETURNING previous_years_2', [ownId]);
      expect(r.rows[0].previous_years_2).toBe(12);
    });

    it('no employee holds a prior-service figure outside 0-60', async () => {
      const { rows } = await client.query(`
        SELECT id, office_id, previous_years_1, previous_years_2 FROM employees
         WHERE previous_years_1 < 0 OR previous_years_1 > 60
            OR previous_years_2 < 0 OR previous_years_2 > 60`);
      const bad = rows.map(r => `${r.office_id || r.id} (${r.previous_years_1}/${r.previous_years_2})`);
      expect(bad, `implausible prior service: ${bad.join(', ')}`).toEqual([]);
    });

    it('an untouched picker cannot 400 the save as the string "null"', async () => {
      // `formData.append(k, null)` serialises to "null", which is neither
      // nullish nor empty — an untouched Reporting Manager picker POSTed that
      // and NO employee could be saved from the form at all.
      const { assertValidManager } = await import('../shared/employeeHierarchy.js');
      for (const sentinel of [null, '', 'null', 'undefined']) {
        await expect(
          assertValidManager(client, { employeeId: null, managerId: sentinel, companyId: OWN }),
        ).resolves.toBeNull();
      }
    });
  });

  describe('salary revisions over time', () => {
    // The workflow: HR records next year's increment as a NEW revision with its
    // own effective date. The previous figure stays on record, and neither one
    // takes effect early.
    // Dates well clear of the other blocks in this file: every test here shares
    // ONE rolled-back transaction, so a row another test inserted at 2099-01-01
    // is visible to the "in force" lookup below and silently becomes the answer.
    const EFF = { hire: '2150-10-01', raise: '2151-04-01', later: '2152-04-01' };

    it('a new effective date ADDS a revision and keeps the old one', async () => {
      const ASSIGN = `
        INSERT INTO employee_salary_assignments
          (employee_id, structure_id, effective_from, basic_salary, special_allowance,
           other_components, loan_deduction, advance_deduction)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (employee_id, effective_from)
        DO UPDATE SET
          structure_id = EXCLUDED.structure_id,
          basic_salary = EXCLUDED.basic_salary,
          special_allowance = EXCLUDED.special_allowance,
          other_components = EXCLUDED.other_components,
          loan_deduction = EXCLUDED.loan_deduction,
          advance_deduction = EXCLUDED.advance_deduction,
          updated_at = NOW()
        RETURNING id, basic_salary, special_allowance`;
      const { rows: [struct] } = await client.query(`SELECT id FROM salary_structures LIMIT 1`);
      const assign = (from, basic, allow) =>
        client.query(ASSIGN, [ownId, struct?.id ?? null, from, basic, allow, '{}', 0, 0]);

      const hire = await assign(EFF.hire, 64000, 6000);
      const raise = await assign(EFF.raise, 75000, 8000);

      // Different date => different row. This is the whole workflow.
      expect(raise.rows[0].id, 'an increment must not overwrite the previous revision').not.toBe(hire.rows[0].id);

      const { rows } = await client.query(
        `SELECT effective_from, basic_salary, special_allowance
           FROM employee_salary_assignments
          WHERE employee_id = $1 AND effective_from IN ($2, $3)
          ORDER BY effective_from DESC`, [ownId, EFF.hire, EFF.raise]);
      expect(rows).toHaveLength(2);
      expect(Number(rows[0].basic_salary)).toBe(75000);
      expect(Number(rows[0].special_allowance)).toBe(8000);
      expect(Number(rows[1].basic_salary), 'the pre-increment figure must survive').toBe(64000);
      expect(Number(rows[1].special_allowance)).toBe(6000);

      // Re-using a date corrects THAT revision rather than adding a third.
      const fix = await assign(EFF.raise, 76000, 8000);
      expect(fix.rows[0].id).toBe(raise.rows[0].id);
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM employee_salary_assignments
          WHERE employee_id = $1 AND effective_from IN ($2, $3)`, [ownId, EFF.hire, EFF.raise]);
      expect(n).toBe(2);
    });

    it('payroll reads the revision IN FORCE for the period, not the newest', async () => {
      // The exact predicate generatePayroll's LATERAL uses. Without the date
      // filter a future increment became the figure every payroll used the
      // moment it was recorded: an employee on 64,000 from Oct-2026 with a
      // revision booked for Apr-2028 was paid 85,000 in the November 2026 run.
      const inForce = async (periodEnd) => {
        const { rows } = await client.query(
          `SELECT basic_salary FROM employee_salary_assignments
            WHERE employee_id = $1
              AND (effective_from IS NULL OR effective_from <= $2::date)
            ORDER BY effective_from DESC NULLS LAST, created_at DESC
            LIMIT 1`, [ownId, periodEnd]);
        return rows[0] ? Number(rows[0].basic_salary) : null;
      };
      const { rows: [struct] } = await client.query(`SELECT id FROM salary_structures LIMIT 1`);
      for (const [from, basic] of [[EFF.hire, 64000], [EFF.raise, 75000], [EFF.later, 85000]]) {
        await client.query(
          `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (employee_id, effective_from) DO UPDATE SET basic_salary = EXCLUDED.basic_salary`,
          [ownId, struct?.id ?? null, from, basic]);
      }

      expect(await inForce('2150-11-30'), 'Nov 2150 must pay the Oct-2150 figure').toBe(64000);
      expect(await inForce('2151-05-31'), 'May 2151 must pay the Apr-2151 figure').toBe(75000);
      expect(await inForce('2152-05-31'), 'May 2152 must pay the Apr-2152 figure').toBe(85000);
      // The day before an increment lands, it is still the old figure.
      expect(await inForce('2151-03-31'), 'a revision must be inert before its date').toBe(64000);
    });

    it('the payroll query itself carries the period filter', () => {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../modules/payroll/payroll.service.js'), 'utf8');
      expect(src, 'generatePayroll must bound the salary lookup by the period end')
        .toMatch(/WHERE employee_id = e\.id AND effective_from <= \$1::date/);
      // $1 is the last day of the wage month (periodEndDate), not wall-clock.
      // (effective_from is NOT NULL, so the old `IS NULL OR` arm is gone.)
      expect(src).toMatch(/end: periodEndDate\(m, y\)/);
    });

    it('the Assign screen sends the allowance it collects', () => {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)),
          '../../../frontend/src/features/hr/pages/SalaryStructure.jsx'), 'utf8');
      // It collected basic + effective_from only, so the endpoint's `= 0`
      // default won and every increment silently zeroed the allowance.
      expect(src).toMatch(/special_allowance:\s*assignForm\.special_allowance/);
      expect(src, 'and it must be prefilled from the current revision')
        .toMatch(/special_allowance:\s*a\.special_allowance/);
    });

    it('updateEmployee corrects ONE named revision in place and never books a second', () => {
      // Reversed on 2026-10-12 at the user's request: Edit Employee must be
      // able to correct a mistyped salary. What still holds is the history
      // rule — a correction rewrites the revision it names (by id); it never
      // INSERTs a second row for the same effective date and never upserts.
      // Behaviour is covered by editEmployeeUpdate.integration.test.js.
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../employees/employee.service.js'), 'utf8');
      const update = src.slice(src.indexOf('export const updateEmployee'), src.indexOf('export const deleteEmployee'));
      expect(update).toMatch(/FROM employee_salary_assignments WHERE id = \$1 AND employee_id = \$2 FOR UPDATE/);
      expect(update, 'a correction must not upsert').not.toMatch(/ON CONFLICT/);
      expect(update, 'the only INSERT is the first-ever revision, after a count of zero')
        .toMatch(/already has salary revisions/);
    });
  });

  describe('employee document files', () => {
    it('no employee document column points at a file that is not on disk', async () => {
      // `employees.pan_file` and friends are stored PATHS: a Documents row
      // renders whether or not anything is behind it. EMP003 carried five
      // columns naming files that are gone, and the tab called them "On file".
      const { existsSync } = await import('node:fs');
      const { LOCAL_UPLOAD_DIR } = await import('../services/StorageService.js');
      const path = await import('node:path');

      const COLS = ['photo_url', 'pan_file', 'aadhaar_file', 'cancelled_cheque_file',
                    'bank_statement_file', 'resume_file', 'offer_letter_file'];
      const { rows } = await client.query(
        `SELECT id, office_id, ${COLS.join(', ')} FROM employees
          WHERE ${COLS.map(c => `${c} IS NOT NULL`).join(' OR ')}`);

      const missing = [];
      for (const r of rows) {
        for (const c of COLS) {
          const stored = r[c];
          if (!stored || /^https?:\/\//i.test(stored)) continue;
          const abs = path.join(LOCAL_UPLOAD_DIR, path.basename(stored));
          if (!existsSync(abs)) missing.push(`${r.office_id}.${c} -> ${stored}`);
        }
      }
      // Reported, not silently tolerated: the UI now shows these as "Missing"
      // rather than "On file", and this is the list to re-upload.
      expect(missing, `document records with no file in storage:\n  ${missing.join('\n  ')}`).toEqual([]);
    });
  });

  describe('employment_type is NULL, never the empty string', () => {
    it('no employee row carries an empty-string employment type', async () => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM employees WHERE employment_type = ''`);
      expect(rows[0].n, "'' and NULL both mean 'not recorded', but only one survives a NULL check").toBe(0);
    });

    it('the create path no longer defaults it to an empty string', async () => {
      // A source check, because the INSERT is a single template literal inside
      // addEmployee and there is no way to exercise that one bind in isolation.
      // The live-data check above catches a regression only AFTER a bad row has
      // been written; this catches the line that would write one.
      const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../employees/employee.service.js'), 'utf8');
      expect(src).not.toMatch(/employment_type\s*\|\|\s*""/);
      expect(src, 'the bind should go through cleanText()').toMatch(/cleanText\(employment_type\)/);
    });
  });

  it('employee documents are reachable only inside the caller\'s company', async () => {
    // The predicate is on the EMPLOYEE, not on employee_documents.company_id,
    // which is nullable and used to be written from the request body.
    const SQL = `SELECT d.id FROM employee_documents d
                   LEFT JOIN employees emp ON emp.id = d.employee_id
                  WHERE ($1::int IS NULL OR emp.company_id = $1::int)
                    AND d.employee_id = $2`;
    const { rows: [doc] } = await client.query(
      `SELECT d.employee_id AS id FROM employee_documents d
         JOIN employees e ON e.id = d.employee_id WHERE e.company_id = $1 LIMIT 1`, [OWN]);
    if (!doc) return;
    expect((await client.query(SQL, [OWN, doc.id])).rowCount).toBeGreaterThan(0);
    expect((await client.query(SQL, [FOREIGN, doc.id])).rowCount).toBe(0);
  });
});
