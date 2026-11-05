/**
 * GET /api/analytics/workforce — Workforce Analytics backend.
 *
 * Runs against the real database and the real role matrix. A fixture company
 * (999932) holds a small, fully known workforce so every count can be asserted
 * exactly; a second fixture company (999931) exists only to prove it never
 * leaks in; company 1 (live data) is checked for invariants, not numbers.
 *
 * Covered:
 *   · permissions  — hr:view allowed; payroll-only, employee and anonymous denied
 *   · scoping      — no cross-company rows; no company scope → 403, not "all"
 *   · filters      — each filter, combinations, 'Not recorded', the location alias
 *   · missing data — NULL, blank, whitespace and the string 'null' are all
 *                    'Not recorded'; recorded/total denominators
 *   · dates        — period window, validation, joins and exits by month
 *   · exits        — no exit date anywhere → "Exit date unknown", never the
 *                    month the record was last edited
 *   · unchanged    — the Employees Dashboard still dates that exit by
 *                    updated_at, and both endpoints agree on headcount
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// setup.js presets DB_PASSWORD to a placeholder; restore the real one before
// config/db.js builds its pool (hence the dynamic imports below).
if (!process.env.DATABASE_URL) {
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

const { default: pool }            = await import('../config/db.js');
const { analyticsPolicy }          = await import('../shared/analyticsAuthz.js');
const { default: analyticsRoutes } = await import('../analytics/routes/analytics.routes.js');
const { getEmployeeAnalytics, getWorkforceAnalytics } = await import('../employees/employee.service.js');

const PATH = '/api/analytics/workforce';

// requirePermission reads the user-level `permissions` table first; this id
// owns no override row (checked in beforeAll), so the role matrix answers.
const PROBE_USER_ID = -424244;

function appAs(roles, scope = { company_id: FIXTURE_CO }) {
  const a = express();
  a.use((req, _res, next) => {
    if (roles) {
      req.user  = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0],
                    company_id: scope?.company_id ?? null };
      req.scope = scope;
    }
    next();
  });
  a.use('/api/analytics', analyticsPolicy, analyticsRoutes);
  return a;
}

const get = (query = {}, roles = ['hr_exec'], scope) =>
  request(appAs(roles, scope)).get(PATH).query(query);

const YEAR = { from: '2026-01-01', to: '2026-12-31' };
const sum = (buckets) => buckets.reduce((n, b) => n + b.count, 0);
const countOf = (bd, value) => bd.buckets.find(b => b.value === value)?.count ?? 0;

// ── Fixtures ──────────────────────────────────────────────────────────────────
// 9999xx fixed tenants follow testTenantIds.contract.test.js: company rows stay
// (they are a registry), everything else is deleted by captured id.
const FOREIGN_CO = 999931;
const FIXTURE_CO = 999932;
const ids = { employees: [], branch: null };

const thirtyYearsAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 30);
  d.setDate(d.getDate() - 10);
  return d.toISOString().slice(0, 10);
};

async function addEmployee(company_id, office_id, fields) {
  const cols = ['company_id', 'office_id', 'first_name', ...Object.keys(fields)];
  const vals = [company_id, office_id, 'ZZWF', ...Object.values(fields)];
  const { rows } = await pool.query(
    `INSERT INTO employees (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
  ids.employees.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  const { rows: ov } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM permissions WHERE user_id = $1', [PROBE_USER_ID]);
  expect(ov[0].n, 'probe user must hold no user-level permission override').toBe(0);

  for (const [id, code] of [[FOREIGN_CO, 'ZZWFA'], [FIXTURE_CO, 'ZZWFB']]) {
    await pool.query(
      `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `${code} Workforce Fixture`, code]);
  }
  // A run interrupted before afterAll leaves its rows behind, and the fixed
  // office_ids / branch code below would then collide on every later run.
  // These two companies belong to this suite alone (testTenantIds registry),
  // so clearing them first cannot touch anyone else's data.
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN
                      (SELECT id FROM employees WHERE company_id IN ($1, $2))`, [FOREIGN_CO, FIXTURE_CO]);
  await pool.query(`DELETE FROM employees WHERE company_id IN ($1, $2)`, [FOREIGN_CO, FIXTURE_CO]);
  await pool.query(`DELETE FROM branches WHERE company_id = $1`, [FIXTURE_CO]);
  const { rows: br } = await pool.query(
    `INSERT INTO branches (company_id, name, code) VALUES ($1, 'ZZWF North Plant', 'ZZWFN1') RETURNING id`,
    [FIXTURE_CO]);
  ids.branch = br[0].id;

  // Current staff (3).
  await addEmployee(FIXTURE_CO, 'EMP99993201', {
    status: 'Active', department: 'Ops', designation: 'Driver', employment_type: 'Permanent',
    gender: 'Male', skill_type: 'Skilled', highest_qualification: 'Graduate',
    dob: thirtyYearsAgo(), previous_years_1: 2, joining_date: '2026-03-15', branch_id: ids.branch,
  });
  await addEmployee(FIXTURE_CO, 'EMP99993202', {
    // Every flavour of "not recorded": blank, whitespace, NULL, the string 'null'.
    status: 'Probation', department: '', designation: '   ', employment_type: null,
    gender: 'null', skill_type: 'Unskilled', joining_date: '2026-05-10',
  });
  await addEmployee(FIXTURE_CO, 'EMP99993203', {
    status: 'Active', department: 'Ops', designation: 'Security Guard', employment_type: 'Contract',
    gender: 'Female', skill_type: 'Semi Skilled', joining_date: '2026-05-20',
  });
  // Exited (3).
  await addEmployee(FIXTURE_CO, 'EMP99993204', {
    status: 'Left', department: 'Ops', exit_date: '2026-06-30', exit_reason: 'Better offer',
    joining_date: '2026-02-01',
  });
  // No exit_date, no exit request: the date is UNKNOWN. updated_at is set to a
  // July date that must not turn into a July exit.
  await addEmployee(FIXTURE_CO, 'EMP99993205', {
    status: 'resigned', department: 'Admin', joining_date: '2026-01-10', updated_at: '2026-07-15',
  });
  const viaRequest = await addEmployee(FIXTURE_CO, 'EMP99993206', {
    status: 'Left', department: 'Ops', joining_date: '2026-04-01',
  });
  await pool.query(
    `INSERT INTO exit_requests (employee_id, reason, last_working_date, status)
     VALUES ($1, 'Relocation', '2026-08-10', 'approved')`, [viaRequest]);
  // Soft-deleted: never counted.
  await addEmployee(FIXTURE_CO, 'EMP99993207', {
    status: 'Active', department: 'Ops', designation: 'Deleted Person', joining_date: '2026-03-01',
    deleted_at: '2026-09-01',
  });
  // Another company's employee, for the isolation tests. Its branch_id points
  // at the FIXTURE company's branch (the FK does not stop that), so the branch
  // join must not hand the foreign company another tenant's branch name.
  await addEmployee(FOREIGN_CO, 'EMP99993101', {
    status: 'Active', department: 'Ops', designation: 'ZZFOREIGN Designation', joining_date: '2026-03-01',
    branch_id: ids.branch,
  });
}, 30000);

afterAll(async () => {
  if (ids.employees.length) {
    await pool.query('DELETE FROM exit_requests WHERE employee_id = ANY($1::int[])', [ids.employees]);
    await pool.query('DELETE FROM employees WHERE id = ANY($1::int[])', [ids.employees]);
  }
  if (ids.branch != null) await pool.query('DELETE FROM branches WHERE id = $1', [ids.branch]);
});

// ── Permissions ───────────────────────────────────────────────────────────────
describe('permissions: hr:view', () => {
  it.each([['hr_exec'], ['hr'], ['payroll_admin']])('%s (holds hr:view) is allowed', async (role) => {
    const res = await get(YEAR, [role]);
    expect(res.status).toBe(200);
    expect(res.body.population.total).toBe(3);
  });

  it('finance_manager (payroll:view but NO hr:view) is denied', async () => {
    const res = await get(YEAR, ['finance_manager']);
    expect(res.status).toBe(403);
    expect(res.body.breakdowns).toBeUndefined();
  });

  it('employee is denied with no data', async () => {
    const res = await get(YEAR, ['employee']);
    expect(res.status).toBe(403);
    expect(res.body.breakdowns).toBeUndefined();
    expect(res.body.population).toBeUndefined();
  });

  it('an unauthenticated caller is refused', async () => {
    const res = await get(YEAR, null);
    expect(res.status).toBe(401);
    expect(res.body.breakdowns).toBeUndefined();
  });

  it('carries no salary data', async () => {
    const res = await get({ period: 'all' });
    expect(JSON.stringify(res.body)).not.toMatch(/salary|ctc|basic|allowance|compensation/i);
  });
});

// ── Company scoping ───────────────────────────────────────────────────────────
describe('company scoping', () => {
  it('a company sees none of another company\'s employees', async () => {
    const res = await get({ period: 'all' });
    expect(JSON.stringify(res.body)).not.toContain('ZZFOREIGN');
    const res1 = await get({ period: 'all' }, ['hr_exec'], { company_id: 1 });
    expect(JSON.stringify(res1.body)).not.toMatch(/ZZFOREIGN|Security Guard|ZZWF North Plant/);
  });

  it('the foreign company sees only its own one employee', async () => {
    const res = await get({ period: 'all' }, ['hr_exec'], { company_id: FOREIGN_CO });
    expect(res.status).toBe(200);
    expect(res.body.population.total).toBe(1);
    expect(res.body.breakdowns.designation.buckets).toEqual([{ value: 'ZZFOREIGN Designation', count: 1 }]);
  });

  it('a branch_id pointing at another company\'s branch does not reveal that branch\'s name', async () => {
    const res = await get({ period: 'all' }, ['hr_exec'], { company_id: FOREIGN_CO });
    expect(res.body.breakdowns.location.buckets).toEqual([
      { value: 'Unknown branch', count: 1, branchId: ids.branch }]);
    expect(JSON.stringify(res.body)).not.toContain('ZZWF North Plant');
  });

  it('a user with no company scope is refused, not shown every company', async () => {
    const res = await get(YEAR, ['hr_exec'], { company_id: null });
    expect(res.status).toBe(403);
    expect(res.body.breakdowns).toBeUndefined();
  });

  it('the service refuses a forgotten scope (undefined) instead of reading every company', async () => {
    await expect(getWorkforceAnalytics({ filters: {} })).rejects.toThrow(/company_id is required/);
  });
});

// ── Breakdowns, missing values and completeness ───────────────────────────────
describe('breakdowns and missing values', () => {
  let d;
  beforeAll(async () => { d = (await get(YEAR)).body; });

  it('counts current staff only, excluding exited and soft-deleted', () => {
    expect(d.population).toEqual({ basis: 'current', total: 3 });
  });

  it('every breakdown sums to the population and reports recorded + notRecorded = total', () => {
    for (const [name, bd] of Object.entries(d.breakdowns)) {
      expect(sum(bd.buckets), name).toBe(3);
      expect(bd.total, name).toBe(3);
      expect(bd.recorded + bd.notRecorded, name).toBe(3);
    }
  });

  it('NULL, blank, whitespace and the string "null" are all "Not recorded"', () => {
    expect(countOf(d.breakdowns.department, 'Not recorded')).toBe(1);       // ''
    expect(countOf(d.breakdowns.designation, 'Not recorded')).toBe(1);      // '   '
    expect(countOf(d.breakdowns.employmentType, 'Not recorded')).toBe(1);   // NULL
    expect(countOf(d.breakdowns.gender, 'Not recorded')).toBe(1);           // 'null'
    expect(d.breakdowns.gender.buckets.map(b => b.value)).not.toContain('null');
  });

  it('"Not recorded" sorts last', () => {
    for (const bd of Object.values(d.breakdowns)) {
      const i = bd.buckets.findIndex(b => b.value === 'Not recorded');
      if (i !== -1) expect(i).toBe(bd.buckets.length - 1);
    }
  });

  it('reports exact values per dimension', () => {
    expect(countOf(d.breakdowns.department, 'Ops')).toBe(2);
    expect(d.breakdowns.status.buckets).toEqual([
      { value: 'Active', count: 2 }, { value: 'Probation', count: 1 }]);
    expect(countOf(d.breakdowns.designation, 'Driver')).toBe(1);
    expect(countOf(d.breakdowns.qualification, 'Graduate')).toBe(1);
    expect(countOf(d.breakdowns.skillType, 'Semi Skilled')).toBe(1);
  });

  it('employment type values are reported as stored — no Permanent/Temporary mapping', () => {
    expect(d.breakdowns.employmentType.buckets.map(b => b.value).sort())
      .toEqual(['Contract', 'Not recorded', 'Permanent']);
  });

  it('location is the branch, carrying the branch id its filter takes', () => {
    expect(d.breakdowns.location.buckets).toEqual([
      { value: 'ZZWF North Plant', count: 1, branchId: ids.branch },
      { value: 'Not recorded', count: 2, branchId: null },
    ]);
  });

  it('age uses date of birth and keeps the full band axis', () => {
    expect(countOf(d.breakdowns.age, '30-34')).toBe(1);
    expect(countOf(d.breakdowns.age, 'Not recorded')).toBe(2);
    expect(d.breakdowns.age.buckets.map(b => b.value)).toEqual(
      ['Under 25', '25-29', '30-34', '35-39', '40-44', '45-49', '50+', 'Not recorded']);
  });

  it('experience is prior + tenure, and unknown when prior experience was never entered', () => {
    // 2 prior years + ~7 months here.
    expect(countOf(d.breakdowns.experience, '1-3 yrs')).toBe(1);
    expect(countOf(d.breakdowns.experience, 'Not recorded')).toBe(2);
  });

  it('flags low samples against minSample', () => {
    expect(d.minSample).toBe(5);
    expect(d.breakdowns.department.lowSample).toBe(true);   // 2 recorded < 5
  });

  it('completeness gives recorded and denominator for every field', () => {
    const c = Object.fromEntries(d.completeness.map(f => [f.field, f]));
    expect(c.department).toMatchObject({ recorded: 2, total: 3 });
    expect(c.designation).toMatchObject({ recorded: 2, total: 3 });
    expect(c.location).toMatchObject({ recorded: 1, total: 3 });
    expect(c.age).toMatchObject({ recorded: 1, total: 3 });
    expect(c.experience).toMatchObject({ recorded: 1, total: 3 });
    expect(c.joiningDate).toMatchObject({ recorded: 3, total: 3, pct: 100 });
    // Exit fields are measured against exited employees, not current staff.
    expect(c.exitDate).toMatchObject({ recorded: 2, total: 3 });
    expect(c.exitReason).toMatchObject({ recorded: 2, total: 3 });
  });

  it('workforce category with none assigned is all "Not recorded" — NOT inferred from designation', () => {
    // The fixture has a 'Driver' and a 'Security Guard' by designation and no
    // category on anyone. Both must stay Not recorded.
    expect(d.breakdowns.workforceCategory).toMatchObject({
      total: 3, recorded: 0, notRecorded: 3, buckets: [{ value: 'Not recorded', count: 3 }] });
    const c = d.completeness.find(f => f.field === 'workforceCategory');
    expect(c).toMatchObject({ recorded: 0, total: 3 });
  });
});

// ── Exits and dates ───────────────────────────────────────────────────────────
describe('exits, unknown exit dates and the period', () => {
  let d;
  beforeAll(async () => { d = (await get(YEAR)).body; });

  it('dates exits by exit_date, else the exit request\'s last working day', () => {
    const byMonth = Object.fromEntries(d.exits.byMonth.map(m => [m.monthKey, m.exits]));
    expect(byMonth['2026-06']).toBe(1);   // exit_date
    expect(byMonth['2026-08']).toBe(1);   // exit_requests.last_working_date
    expect(d.exits.inPeriod).toBe(2);
  });

  it('an exit with no date is "Exit date unknown" — never the month the row was edited', () => {
    const byMonth = Object.fromEntries(d.exits.byMonth.map(m => [m.monthKey, m.exits]));
    expect(byMonth['2026-07']).toBe(0);   // updated_at month
    expect(d.exits.dateUnknown).toEqual({ count: 1, byReason: [{ reason: 'Not recorded', count: 1 }] });
    expect(d.exits.allTime).toBe(3);
  });

  it('exit reasons: exit request first, then the employee record', () => {
    expect(d.exits.byReason).toEqual([
      { reason: 'Better offer', count: 1 }, { reason: 'Relocation', count: 1 }]);
  });

  it('the joining trend covers every month of the window and sums to its total', () => {
    expect(d.joiningTrend.months).toHaveLength(12);
    expect(d.joiningTrend.months.map(m => m.monthKey)[0]).toBe('2026-01');
    expect(d.joiningTrend.total).toBe(sum(d.joiningTrend.months.map(m => ({ count: m.joins }))));
    // Jan (resigned), Feb (left), Mar, Apr (left), May ×2 — soft-deleted excluded.
    expect(d.joiningTrend.total).toBe(6);
    const byMonth = Object.fromEntries(d.joiningTrend.months.map(m => [m.monthKey, m.joins]));
    expect(byMonth['2026-05']).toBe(2);
    expect(byMonth['2026-03']).toBe(1);
  });

  it('a narrower window counts only what falls inside it, to the day', async () => {
    const res = await get({ from: '2026-05-15', to: '2026-08-09' });
    expect(res.body.joiningTrend.total).toBe(1);     // 05-20 in; 05-10 out
    expect(res.body.exits.inPeriod).toBe(1);         // 06-30 in; 08-10 out
    expect(res.body.period).toMatchObject({ from: '2026-05-15', to: '2026-08-09' });
  });

  it('the period moves movement only, not composition', async () => {
    const narrow = (await get({ from: '2026-05-15', to: '2026-05-16' })).body;
    expect(narrow.population.total).toBe(3);
    expect(narrow.breakdowns.department).toEqual(d.breakdowns.department);
  });

  it('period=all resolves to real data bounds', async () => {
    const res = await get({ period: 'all' });
    expect(res.body.period.from).toBe('2026-01-10');
    expect(res.body.period.isAll).toBe(true);
  });

  it.each([['2026-13-01'], ['01-05-2026'], ['2026-02-30x']])('rejects malformed from=%s with 400', async (from) => {
    const res = await get({ from });
    expect(res.status).toBe(400);
  });

  it('an inverted range is swapped, as resolveRange does for every dashboard', async () => {
    const res = await get({ from: '2026-08-09', to: '2026-05-15' });
    expect(res.status).toBe(200);
    expect(res.body.period).toMatchObject({ from: '2026-05-15', to: '2026-08-09' });
    expect(res.body.exits.inPeriod).toBe(1);
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────
describe('filters', () => {
  const total = async (q) => {
    const res = await get({ ...YEAR, ...q });
    expect(res.status, JSON.stringify(q)).toBe(200);
    return res.body;
  };

  it.each([
    [{ department: 'Ops' }, 2],
    [{ department: 'Not recorded' }, 1],
    [{ designation: 'Driver' }, 1],
    [{ employment_type: 'Contract' }, 1],
    [{ employment_type: 'Not recorded' }, 1],
    [{ gender: 'Female' }, 1],
    [{ gender: 'Not recorded' }, 1],
    [{ skill_type: 'Unskilled' }, 1],
    [{ status: 'Probation' }, 1],
    [{ status: 'probation' }, 1],             // case-insensitive
    [{ department: 'all' }, 3],               // 'all' means no filter
  ])('%j → %i current employees', async (q, n) => {
    expect((await total(q)).population.total).toBe(n);
  });

  it('branch_id, its "Not recorded" form and the location alias', async () => {
    expect((await total({ branch_id: String(ids.branch) })).population.total).toBe(1);
    expect((await total({ location: String(ids.branch) })).population.total).toBe(1);
    expect((await total({ branch_id: 'Not recorded' })).population.total).toBe(2);
  });

  it('combines filters with AND', async () => {
    const d = await total({ department: 'Ops', gender: 'Female' });
    expect(d.population.total).toBe(1);
    expect(d.breakdowns.designation.buckets).toEqual([{ value: 'Security Guard', count: 1 }]);
    expect(d.filters).toEqual({ department: 'Ops', gender: 'Female' });
  });

  it('a combination that matches nobody returns zeros, not an error', async () => {
    const d = await total({ designation: 'Driver', employment_type: 'Contract' });
    expect(d.population.total).toBe(0);
    expect(d.breakdowns.department).toMatchObject({ total: 0, recorded: 0, lowSample: true, buckets: [] });
    expect(d.completeness.find(f => f.field === 'department').pct).toBeNull();
  });

  it('status=Exited describes the people who left', async () => {
    const d = await total({ status: 'Exited' });
    expect(d.population).toEqual({ basis: 'status:Exited', total: 3 });
    expect(countOf(d.breakdowns.department, 'Admin')).toBe(1);
  });

  it('filters narrow exits and joins too', async () => {
    const d = await total({ department: 'Admin' });
    expect(d.exits.dateUnknown.count).toBe(1);
    expect(d.exits.inPeriod).toBe(0);
    expect(d.joiningTrend.total).toBe(1);
  });

  it.each([
    [{ status: 'Retired' }],
    [{ branch_id: 'north' }],
    [{ department: 'x'.repeat(201) }],
  ])('rejects %j with 400', async (q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// ── The Employees Dashboard is unchanged, and agrees ──────────────────────────
describe('Employees Dashboard analytics', () => {
  it('still dates the undated exit by updated_at (its existing behaviour), counting 3 exits', async () => {
    const dash = await getEmployeeAnalytics({ company_id: FIXTURE_CO, ...YEAR });
    expect(dash.summary.exits).toBe(3);
    const wf = (await get(YEAR)).body;
    expect(wf.exits.inPeriod + wf.exits.dateUnknown.count).toBe(dash.summary.exits);
  });

  it.each([[FIXTURE_CO], [1]])('company %i: headcount and joins agree with the dashboard', async (cid) => {
    // Company 1 is live data that other suites add employees to and remove them
    // from while this runs, so two reads taken a moment apart can differ for
    // reasons that have nothing to do with either endpoint (it failed once as
    // 36 vs 38). Bracket the workforce read between two dashboard reads and
    // retry until they agree: then nothing changed in between and the
    // comparison is fair.
    let dash, wf;
    for (let attempt = 0; attempt < 5; attempt++) {
      dash = await getEmployeeAnalytics({ company_id: cid, ...YEAR });
      wf = (await get(YEAR, ['hr_exec'], { company_id: cid })).body;
      const after = await getEmployeeAnalytics({ company_id: cid, ...YEAR });
      if (after.summary.total === dash.summary.total && after.summary.newHires === dash.summary.newHires) break;
      await new Promise(r => { setTimeout(r, 200); });
    }
    expect(wf.population.total).toBe(dash.summary.total);
    expect(wf.joiningTrend.total).toBe(dash.summary.newHires);
    for (const bd of Object.values(wf.breakdowns)) expect(sum(bd.buckets)).toBe(dash.summary.total);
    expect(sum(wf.breakdowns.status.buckets)).toBe(sum(dash.statusBreakdown));
  });
});
