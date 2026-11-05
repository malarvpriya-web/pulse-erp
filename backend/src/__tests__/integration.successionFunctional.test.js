/**
 * Succession — functional behaviour (§210). Real routers and database; two
 * throwaway companies with synthetic employees, all removed afterwards.
 *
 *  - Settings persist: the HiPo thresholds survive a reload, and saving another
 *    setting no longer writes the defaults back over them. Bad values → 400 and
 *    nothing is stored. One company's settings never reach another.
 *  - The HiPo thresholds decide the dashboard's high-potential list.
 *  - Bench strength, ready-now / zero-successor counts and the per-role
 *    readiness columns agree with the stored succession_plans rows. "Covered"
 *    is gone: coverage is Ready Now / Developing / No Successor, as on the
 *    Critical Roles tab, so a role without a ready-now successor no longer reads
 *    as covered beside a 0% bench.
 *  - Readiness, risk, status and score vocabularies are enforced on write. A
 *    stored legacy value may be re-sent unchanged.
 *  - The 9-Box Summary report places everyone in the same cell as the grid.
 *  - A development plan's progress follows its actions on add, edit and delete.
 *  - "By" columns hold the caller's employee, not users.id.
 *  - Alerts can be listed and marked read; the unread count follows.
 *  - A failed dashboard query is a 500, not a row of zeros.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }        = await import('../config/db.js');
const { verifyToken }          = await import('../middlewares/auth.middleware.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { FIXTURE_CODE_SQL }     = await import('../shared/employeeCode.js');
const { default: successionRoutes } = await import('../modules/hr/succession.routes.js');

const app = buildApp(['/api/succession', verifyToken, successionRoutes]);

const PREFIX = 'ZZSUCF';
let A, B;
const U = {}, E = {};
const call = (who, method, path) => request(app)[method](`/api/succession${path}`).set('Authorization', `Bearer ${who.token()}`);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function addEmployee(company, first) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, ${FIXTURE_CODE_SQL}, $2, 'Fixture', 'Active', '2025-04-01') RETURNING id`, [company.companyId, first]);
  return r.id;
}
async function assess(company, employeeId, perf, pot, extra = {}) {
  await pool.query(
    `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, flight_risk, readiness, company_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [employeeId, perf, pot, extra.flight_risk || 'low', extra.readiness || '1-2-years', company.companyId]);
}
async function role(company, title) {
  return (await one(`INSERT INTO critical_roles (role_title, risk_level, company_id) VALUES ($1, 'high', $2) RETURNING id`,
    [`${PREFIX} ${title}`, company.companyId])).id;
}
async function plan(company, roleId, employeeId, readiness) {
  await pool.query(
    `INSERT INTO succession_plans (critical_role_id, candidate_employee_id, rank, readiness_level, company_id) VALUES ($1, $2, 1, $3, $4)`,
    [roleId, employeeId, readiness, company.companyId]);
}

async function sweep(companyId) {
  const c = [companyId];
  const soft = (sql) => pool.query(sql, c).catch(() => {});
  await soft(`DELETE FROM development_actions WHERE plan_id IN (SELECT id FROM development_plans WHERE company_id = $1)`);
  await soft(`DELETE FROM mentoring_assignments WHERE company_id = $1`);
  await soft(`DELETE FROM development_plans WHERE company_id = $1`);
  await soft(`DELETE FROM employee_pool_members WHERE pool_id IN (SELECT id FROM employee_talent_pools WHERE company_id = $1)`);
  await soft(`DELETE FROM employee_talent_pools WHERE company_id = $1`);
  await soft(`DELETE FROM succession_alerts WHERE company_id = $1`);
  await soft(`DELETE FROM succession_plans WHERE company_id = $1`);
  await soft(`DELETE FROM critical_roles WHERE company_id = $1`);
  await soft(`DELETE FROM leadership_pipeline_entries WHERE company_id = $1`);
  await soft(`DELETE FROM leadership_pipeline_levels WHERE company_id = $1`);
  await soft(`DELETE FROM succession_settings WHERE company_id = $1`);
  await soft(`DELETE FROM succession_perf_sync_log WHERE company_id = $1`);
  await soft(`DELETE FROM talent_assessment_history WHERE company_id = $1`);
  await soft(`DELETE FROM talent_assessments WHERE company_id = $1`);
  await pool.query(`UPDATE users SET employee_id = NULL WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`, c);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, c);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, PREFIX);
  B = await createIsolatedCompany(pool, `${PREFIX}X`);
  U.hr      = await addUser(pool, A, { label: 'hr', roleCode: 'hr' });
  U.hrNoEmp = await addUser(pool, A, { label: 'hrnoemp', roleCode: 'hr' });
  U.hrB     = await addUser(pool, B, { label: 'hr', roleCode: 'hr' });
  E.hrSelf  = await addEmployee(A, 'Hema');
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.hrSelf, U.hr.userId]);
}, 90000);

afterAll(async () => {
  for (const c of [A, B]) if (c) await sweep(c.companyId);
  for (const c of [A, B]) if (c) await dropIsolatedCompany(pool, c.companyId);
}, 90000);

/* ── Settings ──────────────────────────────────────────────────────────── */
describe('settings persist and are validated', () => {
  const saved = {
    zero_successor_alert: false, single_successor_alert: false,
    flight_risk_threshold: 'medium', review_frequency: 'monthly',
    notify_roles: ['hr', 'hr_manager'], hiPo_threshold_potential: 5, hiPo_threshold_performance: 4,
  };

  it('a saved value comes back on reload, in the keys the screen reads', async () => {
    expect((await call(U.hr, 'put', '/settings').send(saved)).status).toBe(200);
    const row = await one(`SELECT * FROM succession_settings WHERE company_id = $1`, [A.companyId]);
    expect(row).toMatchObject({ hipo_threshold_potential: 5, hipo_threshold_performance: 4, flight_risk_threshold: 'medium',
      review_frequency: 'monthly', zero_successor_alert: false, single_successor_alert: false });
    const r = await call(U.hr, 'get', '/settings');
    expect(r.body).toMatchObject(saved);
    expect(r.body).not.toHaveProperty('hipo_threshold_potential');
  });

  it('saving another setting from the reloaded screen keeps the thresholds', async () => {
    const screen = (await call(U.hr, 'get', '/settings')).body;
    expect((await call(U.hr, 'put', '/settings').send({ ...screen, zero_successor_alert: true })).status).toBe(200);
    const row = await one(`SELECT * FROM succession_settings WHERE company_id = $1`, [A.companyId]);
    expect(row).toMatchObject({ zero_successor_alert: true, hipo_threshold_potential: 5, hipo_threshold_performance: 4 });
  });

  it.each([
    [{ hiPo_threshold_potential: 6 }, 'hiPo_threshold_potential'],
    [{ hiPo_threshold_performance: 2.5 }, 'hiPo_threshold_performance'],
    [{ hiPo_threshold_potential: 'four' }, 'hiPo_threshold_potential'],
    [{ flight_risk_threshold: 'extreme' }, 'flight_risk_threshold'],
    [{ review_frequency: 'weekly' }, 'review_frequency'],
    [{ zero_successor_alert: 'yes' }, 'zero_successor_alert'],
    [{ notify_roles: 'hr' }, 'notify_roles'],
  ])('%o is refused and nothing changes', async (patch, field) => {
    const before = await one(`SELECT * FROM succession_settings WHERE company_id = $1`, [A.companyId]);
    const screen = (await call(U.hr, 'get', '/settings')).body;
    const r = await call(U.hr, 'put', '/settings').send({ ...screen, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe(field);
    expect(await one(`SELECT * FROM succession_settings WHERE company_id = $1`, [A.companyId])).toEqual(before);
  });

  it("one company's settings never reach another", async () => {
    const b = await call(U.hrB, 'get', '/settings');
    expect(b.body).toMatchObject({ hiPo_threshold_potential: 4, hiPo_threshold_performance: 3, flight_risk_threshold: 'high' });
    expect((await call(U.hrB, 'put', '/settings').send({ ...b.body, hiPo_threshold_potential: 2 })).status).toBe(200);
    expect((await call(U.hr, 'get', '/settings')).body.hiPo_threshold_potential).toBe(5);
  });
});

/* ── Thresholds drive the high-potential list ──────────────────────────── */
describe('high potential follows the saved thresholds', () => {
  beforeAll(async () => {
    E.p34 = await addEmployee(A, 'Priya'); await assess(A, E.p34, 3, 4);
    E.p55 = await addEmployee(A, 'Ravi');  await assess(A, E.p55, 5, 5);
    E.p25 = await addEmployee(A, 'Sita');  await assess(A, E.p25, 2, 5);
  });
  const hipoIds = async () => {
    const names = (await call(U.hr, 'get', '/dashboard')).body.top_high_potential.map(e => e.name);
    return { names, has: (first) => names.some(n => n.startsWith(first)) };
  };
  const setThresholds = async (potential, performance) => {
    const s = (await call(U.hr, 'get', '/settings')).body;
    expect((await call(U.hr, 'put', '/settings').send({ ...s, hiPo_threshold_potential: potential, hiPo_threshold_performance: performance })).status).toBe(200);
  };

  it('potential 5 / performance 4 → only the 5/5 employee', async () => {
    await setThresholds(5, 4);
    const h = await hipoIds();
    expect([h.has('Ravi'), h.has('Priya'), h.has('Sita')]).toEqual([true, false, false]);
    expect((await call(U.hr, 'get', '/dashboard')).body.hipo_thresholds).toEqual({ potential: 5, performance: 4 });
  });
  it('potential 4 / performance 3 → 3/4 and 5/5, not 2/5', async () => {
    await setThresholds(4, 3);
    const h = await hipoIds();
    expect([h.has('Ravi'), h.has('Priya'), h.has('Sita')]).toEqual([true, true, false]);
  });
  it('potential 4 / performance 2 → all three', async () => {
    await setThresholds(4, 2);
    const h = await hipoIds();
    expect([h.has('Ravi'), h.has('Priya'), h.has('Sita')]).toEqual([true, true, true]);
  });
});

/* ── Coverage, bench strength and readiness counts ─────────────────────── */
describe('critical-role coverage agrees with the succession plans', () => {
  const R = {};
  beforeAll(async () => {
    const [c1, c2, c3, c4] = [await addEmployee(B, 'Bala'), await addEmployee(B, 'Bhanu'), await addEmployee(B, 'Bindu'), await addEmployee(B, 'Bose')];
    R.ready = await role(B, 'Ready role');      await plan(B, R.ready, c1, 'ready-now'); await plan(B, R.ready, c2, '3-5-years');
    R.dev   = await role(B, 'Developing role'); await plan(B, R.dev, c3, '1-2-years');
    R.none  = await role(B, 'Empty role');
    // A stored value outside the vocabulary, like Manifest's seeded rows.
    R.legacy = await role(B, 'Legacy role');    await plan(B, R.legacy, c4, 'SEED readiness level');
  });

  it('dashboard: 4 roles, 1 with a ready-now successor, 1 with none, bench 25%', async () => {
    const d = (await call(U.hrB, 'get', '/dashboard')).body;
    expect(d).toMatchObject({ total_critical_roles: 4, ready_now_count: 1, zero_successor_count: 1, bench_strength_pct: 25 });
    expect(d.zero_successor_roles.map(r => r.role_title)).toEqual([`${PREFIX} Empty role`]);
  });

  it('Bench Strength report: three coverage states, counts per readiness from the rows', async () => {
    const rows = (await call(U.hrB, 'get', '/reports/bench-strength')).body;
    const by = Object.fromEntries(rows.map(r => [r.role_title.replace(`${PREFIX} `, ''), r]));
    expect(by['Ready role']).toMatchObject({ successor_count: 2, ready_now: 1, ready_1_2yr: 0, ready_3_5yr: 1, coverage_status: 'Ready Now' });
    expect(by['Developing role']).toMatchObject({ successor_count: 1, ready_now: 0, ready_1_2yr: 1, ready_3_5yr: 0, coverage_status: 'Developing' });
    expect(by['Empty role']).toMatchObject({ successor_count: 0, coverage_status: 'No Successor' });
    // The legacy readiness counts as a successor, in Unclassified, in no readiness category.
    expect(by['Legacy role']).toMatchObject({ successor_count: 1, ready_now: 0, ready_1_2yr: 0, ready_3_5yr: 0, not_ready: 0, ready_unclassified: 1, coverage_status: 'Developing' });
    expect(by['Ready role'].ready_unclassified).toBe(0);
    // Every successor is in exactly one column.
    for (const r of rows) {
      expect(r.ready_now + r.ready_1_2yr + r.ready_3_5yr + r.not_ready + r.ready_unclassified, r.role_title).toBe(r.successor_count);
    }
    expect(rows.some(r => r.coverage_status === 'Covered')).toBe(false);
    for (const r of rows) {
      const n = await one(`SELECT COUNT(*)::int AS n FROM succession_plans WHERE critical_role_id = (SELECT id FROM critical_roles WHERE role_title = $1 AND company_id = $2)`,
        [r.role_title, B.companyId]);
      expect(r.successor_count, r.role_title).toBe(n.n);
    }
  });

  it('Critical Roles tab flags agree with the report', async () => {
    const roles = (await call(U.hrB, 'get', '/critical-roles')).body;
    const report = (await call(U.hrB, 'get', '/reports/bench-strength')).body;
    for (const r of roles) {
      const status = r.has_ready_now ? 'Ready Now' : r.has_any_successor ? 'Developing' : 'No Successor';
      expect(report.find(x => x.role_title === r.role_title).coverage_status, r.role_title).toBe(status);
      expect(r.candidate_count).toBe(report.find(x => x.role_title === r.role_title).successor_count);
    }
  });

  it('readiness distribution counts each stored level', async () => {
    const d = (await call(U.hrB, 'get', '/dashboard')).body;
    const dist = Object.fromEntries(d.readiness_summary.map(r => [r.readiness, r.cnt]));
    // §211: a missing or invalid stored readiness is reported as 'unclassified'.
    expect(dist).toEqual({ 'ready-now': 1, '3-5-years': 1, '1-2-years': 1, unclassified: 1 });
  });

  it('the candidate slate accepts the stored legacy value unchanged, refuses a new or invented one', async () => {
    const legacyEmp = (await one(`SELECT candidate_employee_id AS id FROM succession_plans WHERE critical_role_id = $1`, [R.legacy])).id;
    const other = await addEmployee(B, 'Bharat');
    const put = (candidates) => call(U.hrB, 'put', `/critical-roles/${R.legacy}/candidates`).send({ candidates });
    expect((await put([{ candidate_employee_id: legacyEmp, rank: 1, readiness_level: 'SEED readiness level' }])).status).toBe(200);
    const bad = await put([{ candidate_employee_id: other, rank: 1, readiness_level: 'SEED readiness level' }]);
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('readiness_level');
    expect((await put([{ candidate_employee_id: legacyEmp, rank: 1, readiness_level: 'soon' }])).status).toBe(400);
    const dup = await put([{ candidate_employee_id: other, rank: 1, readiness_level: 'ready-now' }, { candidate_employee_id: other, rank: 2, readiness_level: '1-2-years' }]);
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_CANDIDATE');
    const stored = await pool.query(`SELECT candidate_employee_id, readiness_level FROM succession_plans WHERE critical_role_id = $1`, [R.legacy]);
    expect(stored.rows).toEqual([{ candidate_employee_id: legacyEmp, readiness_level: 'SEED readiness level' }]);
  });
});

/* ── Vocabularies and scores on assessment / role / pipeline writes ────── */
describe('writes outside the vocabulary are refused', () => {
  let emp;
  beforeAll(async () => { emp = await addEmployee(A, 'Vani'); });

  it.each([
    [{ readiness: 'SEED readiness level' }, 'readiness'],
    [{ flight_risk: 'extreme' }, 'flight_risk'],
    [{ potential_score: 6 }, 'potential_score'],
    [{ potential_score: 3.5 }, 'potential_score'],
    [{ leadership_score: 0 }, 'leadership_score'],
  ])('POST /assessments %o → 400', async (patch, field) => {
    const r = await call(U.hr, 'post', '/assessments').send({ employee_id: emp, performance_score: 3, potential_score: 3, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe(field);
    expect(await one(`SELECT 1 AS x FROM talent_assessments WHERE employee_id = $1`, [emp])).toBeUndefined();
  });

  it('PATCH /assessments refuses a bad readiness and keeps the row', async () => {
    expect((await call(U.hr, 'post', '/assessments').send({ employee_id: emp, performance_score: 3, potential_score: 3, readiness: 'ready-now' })).status).toBe(201);
    const a = await one(`SELECT * FROM talent_assessments WHERE employee_id = $1`, [emp]);
    expect((await call(U.hr, 'patch', `/assessments/${a.id}`).send({ readiness: 'later' })).status).toBe(400);
    expect((await one(`SELECT readiness FROM talent_assessments WHERE id = $1`, [a.id])).readiness).toBe('ready-now');
  });

  it('critical role risk_level must be low, medium or high', async () => {
    expect((await call(U.hr, 'post', '/critical-roles').send({ role_title: `${PREFIX} r`, risk_level: 'critical' })).status).toBe(400);
    const ok = await call(U.hr, 'post', '/critical-roles').send({ role_title: `${PREFIX} r`, risk_level: 'low' });
    expect(ok.status).toBe(201);
    expect((await call(U.hr, 'patch', `/critical-roles/${ok.body.id}`).send({ risk_level: 'severe' })).status).toBe(400);
    expect((await one(`SELECT risk_level FROM critical_roles WHERE id = $1`, [ok.body.id])).risk_level).toBe('low');
  });

  it('pipeline entry readiness is checked; a stored legacy value may be re-sent unchanged', async () => {
    const lvl = (await one(`INSERT INTO leadership_pipeline_levels (level_name, level_order, company_id) VALUES ('${PREFIX} L', 1, $1) RETURNING id`, [A.companyId])).id;
    expect((await call(U.hr, 'post', '/pipeline/entries').send({ employee_id: emp, current_level_id: lvl, readiness: 'soon' })).status).toBe(400);
    const e = await call(U.hr, 'post', '/pipeline/entries').send({ employee_id: emp, current_level_id: lvl, readiness: 'ready-now' });
    expect(e.status).toBe(201);
    await pool.query(`UPDATE leadership_pipeline_entries SET readiness = 'SEED readiness 1' WHERE id = $1`, [e.body.id]);
    expect((await call(U.hr, 'patch', `/pipeline/entries/${e.body.id}`).send({ readiness: 'SEED readiness 1', notes: 'kept' })).status).toBe(200);
    expect((await call(U.hr, 'patch', `/pipeline/entries/${e.body.id}`).send({ readiness: 'SEED readiness 2' })).status).toBe(400);
    expect((await call(U.hr, 'delete', `/pipeline/entries/${e.body.id}`)).status).toBe(200);
    expect((await call(U.hr, 'delete', `/pipeline/entries/${e.body.id}`)).status).toBe(404);
  });
});

/* ── 9-box report = 9-box grid ─────────────────────────────────────────── */
describe('the 9-Box Summary places everyone where the grid does', () => {
  it('including Inconsistent Players (2_1) and Underperformers (1_2)', async () => {
    const e21 = await addEmployee(A, 'Inez');  await assess(A, e21, 3, 1);
    const e12 = await addEmployee(A, 'Uma');   await assess(A, e12, 1, 3);
    const e33 = await addEmployee(A, 'Tara');  await assess(A, e33, 3.5, 4);
    const grid = (await call(U.hr, 'get', '/nine-box')).body;
    const cellOf = Object.fromEntries(grid.flatMap(c => c.employees.map(e => [e.employee_id, c.label])));
    const report = (await call(U.hr, 'get', '/reports/nine-box-summary')).body;
    const names = Object.fromEntries((await pool.query(`SELECT id, name FROM employees WHERE company_id = $1`, [A.companyId])).rows.map(r => [r.name, r.id]));
    expect(report.length).toBe(Object.keys(cellOf).length);
    for (const r of report) expect(r.quadrant, r.name).toBe(cellOf[names[r.name]]);
    const q = Object.fromEntries(report.map(r => [r.name, r.quadrant]));
    expect(q['Inez Fixture']).toBe('Inconsistent Players');
    expect(q['Uma Fixture']).toBe('Underperformers');
    expect(q['Tara Fixture']).toBe('Stars');
    const csv = (await call(U.hr, 'get', '/reports/nine-box-summary?format=csv')).text;
    expect(csv.split(/\r?\n/)[0]).toBe('name,department,designation,performance_score,potential_score,quadrant,flight_risk,readiness,assessment_date');
    expect(csv).toContain('Inconsistent Players');
  });
});

/* ── Development plans: progress follows actions ───────────────────────── */
describe('development plan progress follows its actions', () => {
  let planId, emp;
  const progress = async () => (await one(`SELECT overall_progress FROM development_plans WHERE id = $1`, [planId])).overall_progress;
  const addAction = async (title) => (await call(U.hr, 'post', `/development-plans/${planId}/actions`).send({ title })).body.id;

  beforeAll(async () => {
    emp = await addEmployee(A, 'Kiran');
    const r = await call(U.hr, 'post', '/development-plans').send({ employee_id: emp, plan_title: `${PREFIX} plan` });
    expect(r.status).toBe(201);
    planId = r.body.id;
  });

  it('add, complete, add, delete — progress is always completed / total', async () => {
    const a1 = await addAction('one'); const a2 = await addAction('two');
    expect(await progress()).toBe(0);
    expect((await call(U.hr, 'patch', `/development-plans/${planId}/actions/${a1}`).send({ status: 'completed' })).status).toBe(200);
    expect(await progress()).toBe(50);
    const a3 = await addAction('three');
    expect(await progress()).toBe(33);
    expect((await call(U.hr, 'delete', `/development-plans/${planId}/actions/${a3}`)).status).toBe(200);
    expect(await progress()).toBe(50);
    expect((await call(U.hr, 'delete', `/development-plans/${planId}/actions/${a3}`)).status).toBe(404);
    expect((await call(U.hr, 'delete', `/development-plans/${planId}/actions/${a2}`)).status).toBe(200);
    expect(await progress()).toBe(100);
    expect((await call(U.hr, 'delete', `/development-plans/${planId}/actions/${a1}`)).status).toBe(200);
    expect(await progress()).toBe(0);
  });

  it('the list, the detail and the report agree with the actions table', async () => {
    const a1 = await addAction('x'); await addAction('y');
    await call(U.hr, 'patch', `/development-plans/${planId}/actions/${a1}`).send({ status: 'completed' });
    const list = (await call(U.hr, 'get', '/development-plans')).body.find(p => p.id === planId);
    const detail = (await call(U.hr, 'get', `/development-plans/${planId}`)).body;
    const report = (await call(U.hr, 'get', '/reports/development-progress')).body.find(p => p.plan_title === `${PREFIX} plan`);
    expect(list).toMatchObject({ action_count: 2, completed_count: 1, overall_progress: 50 });
    expect(detail.actions.filter(a => a.status === 'completed')).toHaveLength(1);
    expect(report).toMatchObject({ total_actions: 2, completed_actions: 1, overall_progress: 50 });
  });

  it('with actions, a typed-in progress is refused and nothing in the request is applied', async () => {
    const before = await one(`SELECT * FROM development_plans WHERE id = $1`, [planId]);
    const r = await call(U.hr, 'patch', `/development-plans/${planId}`).send({ overall_progress: 90, plan_title: 'renamed' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'PROGRESS_FROM_ACTIONS', field: 'overall_progress' });
    expect(await one(`SELECT * FROM development_plans WHERE id = $1`, [planId])).toEqual(before);
    // Other edits without a progress value still work.
    expect((await call(U.hr, 'patch', `/development-plans/${planId}`).send({ notes: 'still editable' })).status).toBe(200);
  });

  it('without actions, a manual progress is stored and kept; the first action takes over', async () => {
    const p = (await call(U.hr, 'post', '/development-plans').send({ employee_id: emp, plan_title: `${PREFIX} manual` })).body.id;
    const r = await call(U.hr, 'patch', `/development-plans/${p}`).send({ overall_progress: 40 });
    expect(r.status).toBe(200);
    expect(r.body.overall_progress).toBe(40);
    expect((await call(U.hr, 'patch', `/development-plans/${p}`).send({ notes: 'n' })).body.overall_progress).toBe(40);
    expect((await call(U.hr, 'get', `/development-plans/${p}`)).body.overall_progress).toBe(40);
    await call(U.hr, 'post', `/development-plans/${p}/actions`).send({ title: 'first' });
    expect((await one(`SELECT overall_progress FROM development_plans WHERE id = $1`, [p])).overall_progress).toBe(0);
    expect((await call(U.hr, 'patch', `/development-plans/${p}`).send({ overall_progress: 40 })).status).toBe(409);
    expect((await call(U.hr, 'patch', '/development-plans/999999999').send({ overall_progress: 40 })).status).toBe(404);
  });

  it('statuses outside the vocabulary are refused', async () => {
    const actionId = (await one(`SELECT id FROM development_actions WHERE plan_id = $1 LIMIT 1`, [planId])).id;
    expect((await call(U.hr, 'patch', `/development-plans/${planId}/actions/${actionId}`).send({ status: 'Completed' })).status).toBe(400);
    expect((await call(U.hr, 'patch', `/development-plans/${planId}`).send({ status: 'done' })).status).toBe(400);
    expect((await call(U.hr, 'patch', `/development-plans/${planId}`).send({ overall_progress: 140 })).status).toBe(400);
    expect((await call(U.hr, 'patch', `/development-plans/${planId}`).send({ status: 'paused' })).status).toBe(200);
  });

  it('mentoring: status and session count are checked; active mentors are counted', async () => {
    const mentor = await addEmployee(A, 'Meena');
    const m = await call(U.hr, 'post', '/mentoring').send({ mentee_employee_id: emp, mentor_employee_id: mentor, development_plan_id: planId });
    expect(m.status).toBe(201);
    expect((await call(U.hr, 'patch', `/mentoring/${m.body.id}`).send({ session_count: -1 })).status).toBe(400);
    expect((await call(U.hr, 'patch', `/mentoring/${m.body.id}`).send({ status: 'paused' })).status).toBe(400);
    expect((await call(U.hr, 'patch', `/mentoring/${m.body.id}`).send({ session_count: 3 })).body.session_count).toBe(3);
    const listed = (await call(U.hr, 'get', '/mentoring')).body.find(x => x.id === m.body.id);
    expect(listed.session_count).toBe(3);
    expect((await call(U.hr, 'get', '/reports/development-progress')).body.find(p => p.plan_title === `${PREFIX} plan`).active_mentors).toBe(1);
    expect((await call(U.hr, 'patch', `/mentoring/${m.body.id}`).send({ status: 'completed' })).status).toBe(200);
    expect((await call(U.hr, 'get', '/reports/development-progress')).body.find(p => p.plan_title === `${PREFIX} plan`).active_mentors).toBe(0);
    expect((await call(U.hr, 'delete', `/mentoring/${m.body.id}`)).status).toBe(200);
    expect((await call(U.hr, 'delete', `/mentoring/${m.body.id}`)).status).toBe(404);
  });
});

/* ── Who did it ────────────────────────────────────────────────────────── */
describe('"by" columns hold the caller\'s employee', () => {
  it('assessed_by, plan created_by and pool created_by = linked employee; NULL without one', async () => {
    const emp = await addEmployee(A, 'Lata');
    await call(U.hr, 'post', '/assessments').send({ employee_id: emp, performance_score: 4, potential_score: 4 });
    const a = (await call(U.hr, 'get', '/assessments')).body.find(x => x.employee_id === emp);
    expect(a.assessed_by_name).toBe('Hema Fixture');
    expect((await one(`SELECT assessed_by FROM talent_assessments WHERE employee_id = $1`, [emp])).assessed_by).toBe(E.hrSelf);

    const p = await call(U.hr, 'post', '/development-plans').send({ employee_id: emp, plan_title: `${PREFIX} by` });
    expect(p.body.created_by).toBe(E.hrSelf);
    expect((await call(U.hr, 'get', `/development-plans/${p.body.id}`)).body.created_by_name).toBe('Hema Fixture');

    const pl = await call(U.hr, 'post', '/pools').send({ pool_name: `${PREFIX} pool` });
    expect(pl.body.created_by).toBe(E.hrSelf);
    expect((await call(U.hr, 'get', '/pools')).body.find(x => x.id === pl.body.id).created_by_name).toBe('Hema Fixture');

    const p2 = await call(U.hrNoEmp, 'post', '/development-plans').send({ employee_id: emp, plan_title: `${PREFIX} nobody` });
    expect(p2.body.created_by).toBeNull();
  });
});

/* ── Alerts ────────────────────────────────────────────────────────────── */
describe('alerts are recorded per the switches and can be marked read', () => {
  it('single-successor alert, listed, marked read, unread count follows; switch off → none', async () => {
    const s = (await call(U.hr, 'get', '/settings')).body;
    await call(U.hr, 'put', '/settings').send({ ...s, single_successor_alert: true, zero_successor_alert: true });
    const roleId = (await call(U.hr, 'post', '/critical-roles').send({ role_title: `${PREFIX} alert role` })).body.id;
    const cand = await addEmployee(A, 'Asha');
    await call(U.hr, 'put', `/critical-roles/${roleId}/candidates`).send({ candidates: [{ candidate_employee_id: cand, rank: 1, readiness_level: 'ready-now' }] });
    const mine = (await call(U.hr, 'get', '/alerts')).body.filter(a => a.role_id === roleId);
    expect(mine.map(a => a.alert_type).sort()).toEqual(['single_successor', 'zero_successor']);
    const unread = async () => (await call(U.hr, 'get', '/dashboard')).body.unread_alerts;
    const before = await unread();
    expect((await call(U.hr, 'patch', `/alerts/${mine[0].id}/read`)).status).toBe(200);
    expect(await unread()).toBe(before - 1);
    expect((await call(U.hrB, 'patch', `/alerts/${mine[1].id}/read`)).status).toBe(404);

    await call(U.hr, 'put', '/settings').send({ ...s, single_successor_alert: false, zero_successor_alert: false });
    const n = (await call(U.hr, 'get', '/alerts')).body.length;
    await call(U.hr, 'put', `/critical-roles/${roleId}/candidates`).send({ candidates: [{ candidate_employee_id: cand, rank: 1, readiness_level: 'ready-now' }] });
    expect((await call(U.hr, 'get', '/alerts')).body.length).toBe(n);
  });
});

/* ── Dashboard fails closed ────────────────────────────────────────────── */
describe('a failed dashboard query is an error, not zeros', () => {
  it('500 when one of the queries fails', async () => {
    const real = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) =>
      (typeof sql === 'string' && sql.includes('AS unread_alerts') ? Promise.reject(new Error('simulated')) : real(sql, ...rest)));
    try {
      expect((await call(U.hr, 'get', '/dashboard')).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect((await call(U.hr, 'get', '/dashboard')).status).toBe(200);
  });
});
