/**
 * Succession — permission, company isolation, attributable history (§209).
 *
 *  - Access is the `succession` matrix permission, resolved over EVERY role a
 *    user holds. hr / hr_manager / admin / super_admin hold it by default;
 *    manager, department_head, hr_exec and employee do not (they used to read
 *    every colleague's ratings, while the live `hr` role was refused).
 *  - A login without a company is refused before any SQL runs.
 *  - Ids from another company — critical roles, candidates, pools, members,
 *    alerts, plans, employees — reach nothing and change nothing.
 *  - Edits, deletions, re-assessments and the performance-review sync keep the
 *    previous version in talent_assessment_history, with who and how.
 *  - Reads and the router import never create, change or remove an assessment.
 *  - The 1×1 cell reads "Low Performance / Low Potential"; scores are untouched.
 *
 * Real routers and database; two throwaway companies with synthetic employees
 * and succession rows only — all removed afterwards. Requires migration
 * 20261029000004 (the `succession` grants and the history columns).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}
// The removed import-time seed was switched on by this variable. Importing the
// router with it set must create nothing.
process.env.RUN_SUCCESSION_SEED = 'true';

const { default: pool }        = await import('../config/db.js');
const { verifyToken }          = await import('../middlewares/auth.middleware.js');
const { buildApp }             = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { FIXTURE_CODE_SQL }     = await import('../shared/employeeCode.js');
const { default: successionRoutes }  = await import('../modules/hr/succession.routes.js');
const { default: performanceRoutes } = await import('../modules/performance/routes/performance.routes.js');
const { default: calibrationRoutes } = await import('../modules/performance/routes/calibration.routes.js');

// Mounted in server.js's order: /performance before /performance/calibration.
const app = buildApp(
  ['/api/succession', verifyToken, successionRoutes],
  ['/api/performance', verifyToken, performanceRoutes],
  ['/api/performance/calibration', verifyToken, calibrationRoutes],
);

const PREFIX = 'ZZSUCC';
let A, B;
const U = {}, E = {}, R = {};
const call = (who, method, path) => request(app)[method](`/api/succession${path}`).set('Authorization', `Bearer ${who.token()}`);

async function addEmployee(company, first) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, ${FIXTURE_CODE_SQL}, $2, 'Fixture', 'Active', '2025-04-01') RETURNING id`, [company.companyId, first]);
  return r.id;
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const assessmentOf = (employeeId) => one(`SELECT * FROM talent_assessments WHERE employee_id = $1`, [employeeId]);
const historyOf = async (employeeId) =>
  (await pool.query(`SELECT * FROM talent_assessment_history WHERE employee_id = $1 ORDER BY id`, [employeeId])).rows;
const rowOf = async (id) => JSON.stringify(await one(`SELECT * FROM performance_reviews WHERE id = $1`, [id]));

/**
 * Run `send` with the route's transaction client failing the first statement
 * that contains `sqlFragment`, to prove everything before it is rolled back.
 * pool.query() calls connect(callback) internally; only the route's own
 * promise-style connect() gets the failing client.
 */
const withFailingAssessmentSync = (send) => withFailingQuery('INSERT INTO talent_assessments (', send);
async function withFailingQuery(sqlFragment, send) {
  const realConnect = pool.connect.bind(pool);
  const failingClient = async () => {
    const client = await realConnect();
    // The pool sets `release` as the client's own property: put it back as it
    // was, so the client returns to the pool untouched.
    const ownQuery = Object.prototype.hasOwnProperty.call(client, 'query') ? client.query : undefined;
    const poolRelease = client.release;
    const realQuery = client.query.bind(client);
    client.query = (sql, ...rest) => (typeof sql === 'string' && sql.includes(sqlFragment)
      ? Promise.reject(new Error('simulated failure'))
      : realQuery(sql, ...rest));
    client.release = (...a) => {
      if (ownQuery) client.query = ownQuery; else delete client.query;
      client.release = poolRelease;
      return poolRelease.apply(client, a);
    };
    return client;
  };
  let armed = true;
  const spy = vi.spyOn(pool, 'connect').mockImplementation((...args) => {
    if (args.length || !armed) return realConnect(...args);
    armed = false;
    return failingClient();
  });
  try { return await send(); } finally { spy.mockRestore(); }
}

/** Every succession row of a company — what "changed nothing" is measured against. */
async function stateOf(company) {
  const cid = company.companyId;
  const q = async (sql) => (await pool.query(sql, [cid])).rows;
  return JSON.stringify({
    assessments: await q(`SELECT * FROM talent_assessments WHERE company_id = $1 ORDER BY id`),
    history:     await q(`SELECT * FROM talent_assessment_history WHERE company_id = $1 ORDER BY id`),
    plans:       await q(`SELECT * FROM succession_plans WHERE company_id = $1 ORDER BY id`),
    members:     await q(`SELECT m.* FROM employee_pool_members m JOIN employee_talent_pools p ON p.id = m.pool_id WHERE p.company_id = $1 ORDER BY m.pool_id, m.employee_id`),
    pools:       await q(`SELECT * FROM employee_talent_pools WHERE company_id = $1 ORDER BY id`),
    alerts:      await q(`SELECT * FROM succession_alerts WHERE company_id = $1 ORDER BY id`),
    actions:     await q(`SELECT a.* FROM development_actions a JOIN development_plans p ON p.id = a.plan_id WHERE p.company_id = $1 ORDER BY a.id`),
  });
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
  // These two were missing: every run left its pipeline entries and the
  // 'ZZSUCC L' level behind, under a company id that no longer existed (§210).
  await soft(`DELETE FROM leadership_pipeline_entries WHERE company_id = $1`);
  await soft(`DELETE FROM leadership_pipeline_levels WHERE company_id = $1`);
  await soft(`DELETE FROM succession_settings WHERE company_id = $1`);
  await soft(`DELETE FROM succession_perf_sync_log WHERE company_id = $1`);
  await soft(`DELETE FROM talent_assessment_history WHERE company_id = $1`);
  await soft(`DELETE FROM talent_assessments WHERE company_id = $1`);
  await soft(`DELETE FROM calibration_adjustments WHERE company_id = $1 OR session_id IN (SELECT id FROM calibration_sessions WHERE company_id = $1)`);
  await soft(`DELETE FROM calibration_sessions WHERE company_id = $1`);
  await soft(`DELETE FROM performance_reviews WHERE company_id = $1`);
  await pool.query(`UPDATE users SET employee_id = NULL WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1)`, c);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, c);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, PREFIX);
  B = await createIsolatedCompany(pool, `${PREFIX}X`);

  for (const role of ['hr', 'hr_manager', 'manager', 'department_head', 'hr_exec', 'employee']) {
    U[role] = await addUser(pool, A, { label: role.replace('_', ''), roleCode: role });
  }
  U.hrB = await addUser(pool, B, { label: 'hr', roleCode: 'hr' });
  // Primary role employee; hr held as a SECOND role. The token says 'employee'.
  U.multi = await addUser(pool, A, { label: 'multi', roleCode: 'employee' });
  await pool.query(`UPDATE user_roles SET is_primary = true WHERE user_id = $1`, [U.multi.userId]);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, is_primary) SELECT $1, id, false FROM roles WHERE LOWER(code) = 'hr'`,
    [U.multi.userId]);
  // A super admin with no company: the global scope that used to read every tenant.
  const sa = await addUser(pool, A, { label: 'nocosa', roleCode: 'super_admin' });
  await pool.query(`UPDATE users SET company_id = NULL WHERE id = $1`, [sa.userId]);
  U.noCompany = { userId: sa.userId, token: () => jwt.sign(
    { userId: sa.userId, role: 'super_admin', company_id: null, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };

  E.A1 = await addEmployee(A, 'Asha');
  E.A2 = await addEmployee(A, 'Arun');     // never assessed
  E.B1 = await addEmployee(B, 'Bala');

  // Pre-existing, authorised assessments in both companies.
  await pool.query(
    `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, flight_risk, readiness, notes, company_id)
     VALUES ($1, 1, 1, 'low', '1-2-years', 'A original', $2), ($3, 4, 5, 'high', 'ready-now', 'B original', $4)`,
    [E.A1, A.companyId, E.B1, B.companyId]);

  R.roleA = (await one(`INSERT INTO critical_roles (role_title, company_id) VALUES ('${PREFIX} A role', $1) RETURNING id`, [A.companyId])).id;
  R.roleB = (await one(`INSERT INTO critical_roles (role_title, company_id) VALUES ('${PREFIX} B role', $1) RETURNING id`, [B.companyId])).id;
  await pool.query(`INSERT INTO succession_plans (critical_role_id, candidate_employee_id, rank, company_id) VALUES ($1, $2, 1, $3)`,
    [R.roleB, E.B1, B.companyId]);
  R.poolB = (await one(`INSERT INTO employee_talent_pools (pool_name, company_id) VALUES ('${PREFIX} B pool', $1) RETURNING id`, [B.companyId])).id;
  await pool.query(`INSERT INTO employee_pool_members (pool_id, employee_id) VALUES ($1, $2)`, [R.poolB, E.B1]);
  R.alertB = (await one(`INSERT INTO succession_alerts (alert_type, role_id, message, company_id) VALUES ('zero_successor', $1, 'B alert', $2) RETURNING id`, [R.roleB, B.companyId])).id;
  R.planB = (await one(`INSERT INTO development_plans (employee_id, plan_title, company_id) VALUES ($1, '${PREFIX} B plan', $2) RETURNING id`, [E.B1, B.companyId])).id;
}, 90000);

afterAll(async () => {
  for (const c of [A, B]) if (c) await sweep(c.companyId);
  if (U.noCompany) {
    for (const t of ['audit_logs', 'access_denials', 'notifications', 'user_scope', 'user_roles']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [U.noCompany.userId]).catch(() => {});
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [U.noCompany.userId]);
  }
  for (const c of [A, B]) if (c) await dropIsolatedCompany(pool, c.companyId);
}, 90000);

describe('access is the succession permission, over every role held', () => {
  it.each(['hr', 'hr_manager'])('%s reads the module', async (role) => {
    for (const path of ['/dashboard', '/assessments', '/nine-box', '/reports/talent-risk']) {
      expect((await call(U[role], 'get', path)).status, `${role} ${path}`).toBe(200);
    }
  });

  it('a user whose second, non-primary role is hr is let in', async () => {
    expect((await call(U.multi, 'get', '/assessments')).status).toBe(200);
  });

  it.each(['manager', 'department_head', 'hr_exec', 'employee'])('%s is refused every read and write', async (role) => {
    const before = await stateOf(A);
    for (const path of ['/dashboard', '/assessments', '/nine-box', '/critical-roles', `/assessments/${E.A1}/history`, '/reports/talent-risk']) {
      const r = await call(U[role], 'get', path);
      expect(r.status, `${role} GET ${path}`).toBe(403);
      expect(r.body.code).toBe('PERMISSION_DENIED');
    }
    const id = (await assessmentOf(E.A1)).id;
    expect((await call(U[role], 'patch', `/assessments/${id}`).send({ performance_score: 5 })).status).toBe(403);
    expect((await call(U[role], 'delete', `/assessments/${id}`)).status).toBe(403);
    expect((await call(U[role], 'post', '/assessments').send({ employee_id: E.A2, performance_score: 3, potential_score: 3 })).status).toBe(403);
    expect(await stateOf(A)).toBe(before);
  });

  it('a login with no company is refused, even a super admin', async () => {
    const r = await call(U.noCompany, 'get', '/assessments');
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/needs a company/);
    expect((await call(U.noCompany, 'get', '/dashboard')).status).toBe(403);
  });
});

describe('another company\'s ids reach nothing and change nothing', () => {
  it('lists only the caller\'s own assessments', async () => {
    const ids = (await call(U.hr, 'get', '/assessments')).body.map(r => r.employee_id);
    expect(ids).toContain(E.A1);
    expect(ids).not.toContain(E.B1);
  });

  it('critical-role candidates: read and replace', async () => {
    const before = await stateOf(B);
    expect((await call(U.hr, 'get', `/critical-roles/${R.roleB}/candidates`)).status).toBe(404);
    expect((await call(U.hr, 'put', `/critical-roles/${R.roleB}/candidates`).send({ candidates: [] })).status).toBe(404);
    expect((await call(U.hr, 'put', `/critical-roles/${R.roleB}/candidates`)
      .send({ candidates: [{ candidate_employee_id: E.A1 }] })).status).toBe(404);
    // A's own role cannot take B's employee as a successor.
    expect((await call(U.hr, 'put', `/critical-roles/${R.roleA}/candidates`)
      .send({ candidates: [{ candidate_employee_id: E.B1 }] })).status).toBe(400);
    expect(await stateOf(B)).toBe(before);
  });

  it('pool members: list, add, remove, and deleting the pool', async () => {
    const before = await stateOf(B);
    expect((await call(U.hr, 'get', `/pools/${R.poolB}/members`)).status).toBe(404);
    expect((await call(U.hr, 'post', `/pools/${R.poolB}/members`).send({ employee_id: E.A1 })).status).toBe(404);
    expect((await call(U.hr, 'delete', `/pools/${R.poolB}/members/${E.B1}`)).status).toBe(404);
    expect((await call(U.hr, 'delete', `/pools/${R.poolB}`)).status).toBe(404);
    expect(await stateOf(B)).toBe(before);
  });

  it('alerts: marking another company\'s alert read', async () => {
    expect((await call(U.hr, 'patch', `/alerts/${R.alertB}/read`)).status).toBe(404);
    expect((await one(`SELECT is_read FROM succession_alerts WHERE id = $1`, [R.alertB])).is_read).toBe(false);
  });

  it('development plans: detail and actions', async () => {
    const before = await stateOf(B);
    expect((await call(U.hr, 'get', `/development-plans/${R.planB}`)).status).toBe(404);
    expect((await call(U.hr, 'post', `/development-plans/${R.planB}/actions`).send({ title: 'x' })).status).toBe(404);
    expect((await call(U.hr, 'delete', `/development-plans/${R.planB}/actions/1`)).status).toBe(404);
    expect((await call(U.hr, 'post', '/development-plans').send({ employee_id: E.B1, plan_title: 'x' })).status).toBe(400);
    expect((await call(U.hr, 'post', '/mentoring').send({ mentee_employee_id: E.A1, mentor_employee_id: E.B1 })).status).toBe(400);
    expect(await stateOf(B)).toBe(before);
  });

  it('assessments: another company\'s employee cannot be assessed, synced or read', async () => {
    const before = await stateOf(B);
    expect((await call(U.hr, 'post', '/assessments').send({ employee_id: E.B1, performance_score: 1, potential_score: 1 })).status).toBe(400);
    expect((await call(U.hr, 'post', '/assessments/sync-from-performance').send({ employee_id: E.B1, performance_score: 1 })).status).toBe(400);
    const bId = (await assessmentOf(E.B1)).id;
    expect((await call(U.hr, 'patch', `/assessments/${bId}`).send({ performance_score: 1 })).status).toBe(404);
    expect((await call(U.hr, 'delete', `/assessments/${bId}`)).status).toBe(404);
    expect((await call(U.hr, 'get', `/assessments/${E.B1}/history`)).body).toEqual([]);
    expect(await stateOf(B)).toBe(before);
    expect(await assessmentOf(E.B1)).toMatchObject({ performance_score: '4.00', potential_score: 5, notes: 'B original' });
  });
});

describe('assessment history keeps every previous version, with who and how', () => {
  it('reads and the router import create, change and remove nothing', async () => {
    const before = await stateOf(A);
    for (const path of ['/assessments', '/nine-box', '/dashboard', '/reports/nine-box-summary', '/reports/talent-risk', '/reports/readiness']) {
      expect((await call(U.hr, 'get', path)).status, path).toBe(200);
    }
    expect(await stateOf(A)).toBe(before);
    // Imported with RUN_SUCCESSION_SEED=true: the never-assessed employee stays unassessed.
    expect(await assessmentOf(E.A2)).toBeUndefined();
  });

  it('an edit keeps the version it replaced', async () => {
    const prev = await assessmentOf(E.A1);
    const r = await call(U.hr, 'patch', `/assessments/${prev.id}`).send({ performance_score: 2, notes: 'A edited' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ performance_score: '2.00', potential_score: 1, notes: 'A edited' });
    const h = (await historyOf(E.A1)).at(-1);
    expect(h).toMatchObject({
      change_action: 'edited', changed_by_user_id: U.hr.userId, assessment_id: prev.id,
      performance_score: '1.00', potential_score: 1, notes: 'A original', company_id: A.companyId,
    });
  });

  it('a re-assessment through POST keeps the version it replaced', async () => {
    const r = await call(U.hr_manager, 'post', '/assessments').send({ employee_id: E.A1, performance_score: 3, potential_score: 2, notes: 'A reassessed' });
    expect(r.status).toBe(201);
    expect((await historyOf(E.A1)).at(-1)).toMatchObject({
      change_action: 'reassessed', changed_by_user_id: U.hr_manager.userId, performance_score: '2.00', notes: 'A edited',
    });
  });

  it('a deletion keeps the deleted assessment, readable through the history endpoint', async () => {
    const prev = await assessmentOf(E.A1);
    expect((await call(U.hr, 'delete', `/assessments/${prev.id}`)).status).toBe(200);
    expect(await assessmentOf(E.A1)).toBeUndefined();
    const rows = (await call(U.hr, 'get', `/assessments/${E.A1}/history`)).body;
    expect(rows.map(x => x.change_action)).toEqual(['deleted', 'reassessed', 'edited']);
    expect(rows[0]).toMatchObject({
      assessment_id: prev.id, performance_score: '3.00', potential_score: 2, notes: 'A reassessed',
      changed_by_user_id: U.hr.userId, changed_by_name: expect.stringContaining('hr'),
    });
  });

  it('the performance-review sync keeps the version it replaced', async () => {
    await pool.query(
      `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
       VALUES ($1, 2, 4, 'before review', $2)`, [E.A1, A.companyId]);
    const rev = await one(
      `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'hr_review') RETURNING id`,
      [E.A1, A.companyId]);
    const r = await request(app).post(`/api/performance/reviews/${rev.id}/finalize`)
      .set('Authorization', `Bearer ${U.hr.token()}`).send({ calibrated_rating: 4 });
    expect(r.status).toBe(200);
    expect(await assessmentOf(E.A1)).toMatchObject({ performance_score: '4.00', potential_score: 4, notes: 'before review' });
    expect((await historyOf(E.A1)).at(-1)).toMatchObject({
      change_action: 'performance_review', changed_by_user_id: U.hr.userId, performance_score: '2.00', notes: 'before review',
    });
  });
});

// hr_reviewer_id references employees(id). Finalize used to write the caller's
// users.id there, so it failed the FK (500) unless an employees row happened to
// carry that number — and then named the wrong person as reviewer.
describe('performance-review finalize records the HR reviewer as an employee', () => {
  const finalize = (who, id) => request(app).post(`/api/performance/reviews/${id}/finalize`)
    .set('Authorization', `Bearer ${who.token()}`);
  const newReview = async (employeeId) => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'hr_review') RETURNING id`,
    [employeeId, A.companyId])).id;

  it('a linked HR login is stored by its employee id, not its user id', async () => {
    const hr = await addUser(pool, A, { label: 'hrlinked', roleCode: 'hr' });
    let reviewer = await addEmployee(A, 'Revathi');
    if (reviewer === hr.userId) reviewer = await addEmployee(A, 'Revathi2');
    expect(reviewer).not.toBe(hr.userId);
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [reviewer, hr.userId]);

    const reviewee = await addEmployee(A, 'Kavin');
    const id = await newReview(reviewee);
    const r = await finalize(hr, id).send({ calibrated_rating: 3, hr_comments: 'calibrated' });
    expect(r.status).toBe(200);
    expect(await one(`SELECT hr_reviewer_id, status, calibrated_rating::float AS rating, hr_comments
                        FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ hr_reviewer_id: reviewer, status: 'completed', rating: 3, hr_comments: 'calibrated' });
    expect(await assessmentOf(reviewee)).toMatchObject({ performance_score: '3.00', company_id: A.companyId });
  });

  it('an HR login with no employee record finalizes with hr_reviewer_id NULL', async () => {
    const hr = await addUser(pool, A, { label: 'hrnoemp', roleCode: 'hr' });
    const id = await newReview(await addEmployee(A, 'Meena'));
    const r = await finalize(hr, id).send({ hr_comments: 'no rating' });
    expect(r.status).toBe(200);
    expect(await one(`SELECT hr_reviewer_id, status FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ hr_reviewer_id: null, status: 'completed' });
  });

  it('another company\'s review is not finalized', async () => {
    const id = (await one(
      `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'hr_review') RETURNING id`,
      [E.B1, B.companyId])).id;
    expect((await finalize(U.hr, id).send({ calibrated_rating: 5 })).status).toBe(404);
    expect(await one(`SELECT hr_reviewer_id, status FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ hr_reviewer_id: null, status: 'hr_review' });
  });

  describe('calibrated rating: kept exactly, refused rather than rounded, one transaction', () => {
    let hr, hrEmployee;
    beforeAll(async () => {
      hr = await addUser(pool, A, { label: 'hrcalib', roleCode: 'hr' });
      hrEmployee = await addEmployee(A, 'Charu');
      if (hrEmployee === hr.userId) hrEmployee = await addEmployee(A, 'Charu2');
      await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [hrEmployee, hr.userId]);
    });

    it.each([[4, '4.00'], [3.75, '3.75'], ['4.3', '4.30']])(
      'calibrated %j is stored as %s on the review and the assessment; the replaced version goes to history',
      async (rating, stored) => {
        const reviewee = await addEmployee(A, 'Lakshmi');
        const prev = await one(
          `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
           VALUES ($1, 2.5, 3, 'before finalize', $2) RETURNING id`, [reviewee, A.companyId]);
        const id = await newReview(reviewee);
        const r = await finalize(hr, id).send({ calibrated_rating: rating, hr_comments: 'calibrated' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(await one(`SELECT calibrated_rating, status, hr_reviewer_id FROM performance_reviews WHERE id = $1`, [id]))
          .toEqual({ calibrated_rating: stored, status: 'completed', hr_reviewer_id: hrEmployee });
        expect(await assessmentOf(reviewee)).toMatchObject({ id: prev.id, performance_score: stored, potential_score: 3 });
        const history = await historyOf(reviewee);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          assessment_id: prev.id, change_action: 'performance_review', changed_by_user_id: hr.userId,
          performance_score: '2.50', notes: 'before finalize', company_id: A.companyId,
        });
      });

    it.each([
      [3.755, 'Calibrated rating can have at most 2 decimal places'],
      ['4.001', 'Calibrated rating can have at most 2 decimal places'],
      [0, 'Calibrated rating must be from 1 to 5'],
      [5.5, 'Calibrated rating must be from 1 to 5'],
      [-2, 'Calibrated rating must be a number from 1 to 5'],
      ['high', 'Calibrated rating must be a number from 1 to 5'],
    ])('calibrated %j is refused with 400 and nothing is written', async (rating, error) => {
      const reviewee = await addEmployee(A, 'Nila');
      const id = await newReview(reviewee);
      const before = await rowOf(id);
      const r = await finalize(hr, id).send({ calibrated_rating: rating });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error, code: 'INVALID_RATING', field: 'calibrated_rating' });
      expect(await rowOf(id)).toBe(before);
      expect(await assessmentOf(reviewee)).toBeUndefined();
    });

    it('a failing assessment sync rolls the finalize back', async () => {
      const reviewee = await addEmployee(A, 'Omar');
      const id = await newReview(reviewee);
      const before = await rowOf(id);
      expect((await withFailingAssessmentSync(() => finalize(hr, id).send({ calibrated_rating: 4 }))).status).toBe(500);
      expect(await rowOf(id)).toBe(before);
      expect(await assessmentOf(reviewee)).toBeUndefined();
      expect(await historyOf(reviewee)).toEqual([]);
    });

    it('an assessment held by another company is not changed, and the finalize is rolled back', async () => {
      const reviewee = await addEmployee(A, 'Pavan');
      await pool.query(
        `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
         VALUES ($1, 5, 5, 'held by B', $2)`, [reviewee, B.companyId]);
      const heldBefore = JSON.stringify(await assessmentOf(reviewee));
      const id = await newReview(reviewee);
      const before = await rowOf(id);
      const r = await finalize(hr, id).send({ calibrated_rating: 3 });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ASSESSMENT_OTHER_COMPANY');
      expect(await rowOf(id)).toBe(before);
      expect(JSON.stringify(await assessmentOf(reviewee))).toBe(heldBefore);
      expect(await historyOf(reviewee)).toEqual([]);
    });
  });
});

// self_rating is numeric(3,1): one decimal is kept, more would be rounded by
// PostgreSQL, so it is refused before the review is read or written. The
// self-review does not touch the talent assessment.
describe('performance self-review rating', () => {
  // Self-review is owner-only: every review here belongs to the rater's own
  // linked employee.
  let rater, emp;
  beforeAll(async () => {
    rater = await addUser(pool, A, { label: 'selfrater', roleCode: 'employee' });
    emp = await addEmployee(A, 'Selvi');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [emp, rater.userId]);
  });
  const selfReview = (id, body) => request(app).post(`/api/performance/reviews/${id}/self-review`)
    .set('Authorization', `Bearer ${rater.token()}`).send(body);
  const pendingReview = async (employeeId) => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'self_review_pending') RETURNING id`,
    [employeeId, A.companyId])).id;

  it.each([[4, '4.0'], [3.5, '3.5'], ['4.5', '4.5'], ['2.0', '2.0']])(
    'self rating %j is stored exactly as %s; no assessment or history is written', async (rating, stored) => {
      const id = await pendingReview(emp);
      const r = await selfReview(id, { self_rating: rating, self_comments: 'my year' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await one(`SELECT self_rating, self_comments, status FROM performance_reviews WHERE id = $1`, [id]))
        .toEqual({ self_rating: stored, self_comments: 'my year', status: 'self_submitted' });
      expect(await assessmentOf(emp)).toBeUndefined();
      expect(await historyOf(emp)).toEqual([]);
    });

  it.each([
    [3.55,   'Self rating can have at most 1 decimal place'],
    ['4.25', 'Self rating can have at most 1 decimal place'],
    [0,      'Self rating must be from 1 to 5'],
    [5.5,    'Self rating must be from 1 to 5'],
    [6,      'Self rating must be from 1 to 5'],
    [-1,     'Self rating must be a number from 1 to 5'],
    ['good', 'Self rating must be a number from 1 to 5'],
    ['',     'Self rating must be a number from 1 to 5'],
  ])('self rating %j is refused with 400 and the review is unchanged', async (rating, error) => {
    const id = await pendingReview(emp);
    const before = await rowOf(id);
    const r = await selfReview(id, { self_rating: rating, self_comments: 'should not save' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error, code: 'INVALID_RATING', field: 'self_rating' });
    expect(await rowOf(id)).toBe(before);
    expect(await assessmentOf(emp)).toBeUndefined();
  });
});

// An employee-role login may submit only its own self-review. Ownership used to
// compare review.employee_id (an employees.id) with users.id, so the real owner
// was refused and a login whose users.id happened to equal someone's employee
// id could submit that person's review.
describe('performance self-review ownership (employee role)', () => {
  const selfReviewAs = (who, id, body = { self_rating: 4, self_comments: 'mine' }) =>
    request(app).post(`/api/performance/reviews/${id}/self-review`)
      .set('Authorization', `Bearer ${who.token()}`).send(body);
  const pendingIn = async (company, employeeId) => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'self_review_pending') RETURNING id`,
    [employeeId, company.companyId])).id;
  const linkedEmployeeLogin = async (label, first) => {
    const login = await addUser(pool, A, { label, roleCode: 'employee' });
    let emp = await addEmployee(A, first);
    if (emp === login.userId) emp = await addEmployee(A, `${first}2`);
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [emp, login.userId]);
    return { login, emp };
  };
  let owner, other;
  beforeAll(async () => {
    owner = await linkedEmployeeLogin('selfowner', 'Uma');
    other = await linkedEmployeeLogin('selfother', 'Vikram');
  });

  it('the owner (users.id ≠ employee id) submits their own self-review', async () => {
    expect(owner.emp).not.toBe(owner.login.userId);
    const id = await pendingIn(A, owner.emp);
    const r = await selfReviewAs(owner.login, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await one(`SELECT self_rating, self_comments, status FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ self_rating: '4.0', self_comments: 'mine', status: 'self_submitted' });
  });

  it('another employee\'s review is refused (403 NOT_REVIEW_OWNER) and unchanged', async () => {
    const id = await pendingIn(A, owner.emp);
    const before = await rowOf(id);
    const r = await selfReviewAs(other.login, id);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'NOT_REVIEW_OWNER', message: 'You can only submit your own self-review' });
    expect(await rowOf(id)).toBe(before);
  });

  it('a login whose users.id equals the review\'s employee id, but linked elsewhere, is refused', async () => {
    // The old comparison (review.employee_id === users.id) let exactly this
    // through: the reviewed employee's id IS the lookalike login's users.id.
    const lookalike = await addUser(pool, A, { label: 'selflook', roleCode: 'employee' });
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [owner.emp, lookalike.userId]);
    const taken = await one(`SELECT 1 FROM employees WHERE id = $1`, [lookalike.userId]);
    expect(taken, 'an employee already holds this id; rerun to get a free one').toBeUndefined();
    await pool.query(
      `INSERT INTO employees (id, company_id, office_id, first_name, last_name, status, joining_date)
       VALUES ($1, $2, ${FIXTURE_CODE_SQL}, 'Lookalike', 'Fixture', 'Active', '2025-04-01')`, [lookalike.userId, A.companyId]);
    const id = await pendingIn(A, lookalike.userId);
    const before = await rowOf(id);
    expect((await selfReviewAs(lookalike, id)).status).toBe(403);
    expect(await rowOf(id)).toBe(before);
  });

  it('an employee login with no linked employee is refused (403 NO_LINKED_EMPLOYEE) and nothing changes', async () => {
    const id = await pendingIn(A, owner.emp);
    const before = await rowOf(id);
    const r = await selfReviewAs(U.employee, id);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_LINKED_EMPLOYEE');
    expect(await rowOf(id)).toBe(before);
  });

  it('another company\'s review is not found and unchanged', async () => {
    const id = await pendingIn(B, E.B1);
    const before = await rowOf(id);
    expect((await selfReviewAs(owner.login, id)).status).toBe(404);
    expect(await rowOf(id)).toBe(before);
  });

  // Owner-only for EVERY role: HR, managers and admins used to skip the check.
  it.each(['hr', 'hr_manager', 'manager', 'admin'])(
    'a linked %s login cannot submit another employee\'s self-review', async (roleCode) => {
      const login = await addUser(pool, A, { label: `self${roleCode.replace('_', '')}`, roleCode });
      const mine = await addEmployee(A, 'Ishaan');
      await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [mine, login.userId]);
      const id = await pendingIn(A, owner.emp);
      const before = await rowOf(id);
      const r = await selfReviewAs(login, id);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('NOT_REVIEW_OWNER');
      expect(await rowOf(id)).toBe(before);
    });

  it('an unlinked HR login cannot submit any self-review', async () => {
    const id = await pendingIn(A, owner.emp);
    const before = await rowOf(id);
    const r = await selfReviewAs(U.hr, id);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_LINKED_EMPLOYEE');
    expect(await rowOf(id)).toBe(before);
  });

  it('an HR login submits its OWN self-review', async () => {
    const login = await addUser(pool, A, { label: 'selfhrown', roleCode: 'hr' });
    const mine = await addEmployee(A, 'Jaya');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [mine, login.userId]);
    const id = await pendingIn(A, mine);
    expect((await selfReviewAs(login, id)).status).toBe(200);
    expect((await one(`SELECT status FROM performance_reviews WHERE id = $1`, [id])).status).toBe('self_submitted');
  });
});

// isHRPlus / isManagerPlus used to read only the PRIMARY role (req.user.role),
// so a secondary hr role was ignored and hr_manager was in neither list.
describe('performance review HR checks span every role held', () => {
  const putAs = (who, id, body = { manager_comments: 'by role' }) => request(app).put(`/api/performance/reviews/${id}`)
    .set('Authorization', `Bearer ${who.token()}`).send(body);
  const finalizeAs = (who, id) => request(app).post(`/api/performance/reviews/${id}/finalize`)
    .set('Authorization', `Bearer ${who.token()}`).send({ hr_comments: 'by role' });
  const openReview = async (company, employeeId) => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status) VALUES ($1, $2, 'manager_submitted') RETURNING id`,
    [employeeId, company.companyId])).id;
  const withSecondRole = async (label, primary, secondary) => {
    const login = await addUser(pool, A, { label, roleCode: primary });
    await pool.query(`UPDATE user_roles SET is_primary = true WHERE user_id = $1`, [login.userId]);
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id, is_primary) SELECT $1, id, false FROM roles WHERE LOWER(code) = $2`,
      [login.userId, secondary]);
    return login;
  };
  let hrManager, empPlusHr, empPlusHrManager, empPlusExec;
  beforeAll(async () => {
    hrManager        = await addUser(pool, A, { label: 'rolehrmgr', roleCode: 'hr_manager' });
    empPlusHr        = await withSecondRole('roleemphr', 'employee', 'hr');
    empPlusHrManager = await withSecondRole('roleemphrm', 'employee', 'hr_manager');
    empPlusExec      = await withSecondRole('roleempexec', 'employee', 'hr_exec');
  });

  it.each([
    ['hr_manager as primary role',   () => hrManager],
    ['hr as a secondary role',        () => empPlusHr],
    ['hr_manager as a secondary role', () => empPlusHrManager],
  ])('%s may edit and finalize', async (_n, who) => {
    const a = await openReview(A, await addEmployee(A, 'Kiran'));
    expect((await putAs(who(), a)).status).toBe(200);
    const b = await openReview(A, await addEmployee(A, 'Kiran2'));
    expect((await finalizeAs(who(), b)).status).toBe(200);
  });

  it.each([
    ['hr_exec as a secondary role', () => empPlusExec],
    ['employee',                    () => U.employee],
    ['manager',                     () => U.manager],
    ['department_head',             () => U.department_head],
    ['hr_exec',                     () => U.hr_exec],
  ])('%s may neither edit nor finalize, and nothing changes', async (_n, who) => {
    const id = await openReview(A, await addEmployee(A, 'Leela'));
    const before = await rowOf(id);
    expect((await putAs(who(), id)).status).toBe(403);
    expect((await finalizeAs(who(), id)).status).toBe(403);
    expect(await rowOf(id)).toBe(before);
  });

  it('a secondary HR role does not reach another company\'s review', async () => {
    const id = await openReview(B, E.B1);
    const before = await rowOf(id);
    expect((await putAs(empPlusHrManager, id)).status).toBe(404);
    expect((await finalizeAs(empPlusHr, id)).status).toBe(404);
    expect(await rowOf(id)).toBe(before);
  });
});

// Review reads for an employee: /review/current and /history (the Performance
// Reviews page), /reviews and /reviews/:id. All filtered by users.id, which is
// not an employees.id; /review/current and /reviews dropped the filter entirely
// when it was missing.
describe('review reads are filtered by the linked employee', () => {
  const get = (who, path) => request(app).get(`/api/performance${path}`).set('Authorization', `Bearer ${who.token()}`);
  const review = async (company, employeeId, status = 'completed') => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status, final_rating) VALUES ($1, $2, $3, 3.5) RETURNING id`,
    [employeeId, company.companyId, status])).id;
  let me, mine, other, lookalikeReview, mineDone, mineOpen, otherDone, foreign;
  beforeAll(async () => {
    me = await addUser(pool, A, { label: 'readme', roleCode: 'employee' });
    mine = await addEmployee(A, 'Mira');
    if (mine === me.userId) mine = await addEmployee(A, 'Mira2');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [mine, me.userId]);
    other = await addEmployee(A, 'Neel');
    mineDone  = await review(A, mine, 'completed');
    mineOpen  = await review(A, mine, 'self_review_pending');
    otherDone = await review(A, other, 'completed');
    // An employee whose id IS this login's users.id: the old filters matched it.
    expect(await one(`SELECT 1 FROM employees WHERE id = $1`, [me.userId]), 'id taken; rerun').toBeUndefined();
    await pool.query(
      `INSERT INTO employees (id, company_id, office_id, first_name, last_name, status, joining_date)
       VALUES ($1, $2, ${FIXTURE_CODE_SQL}, 'Lookalike', 'Reader', 'Active', '2025-04-01')`, [me.userId, A.companyId]);
    lookalikeReview = await review(A, me.userId, 'completed');
    // The same employee id under another company's review must not surface.
    foreign = await review(B, mine, 'completed');
  });

  it('/review/current is my latest review, by employee id', async () => {
    const r = await get(me, '/review/current');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(Math.max(mineDone, mineOpen));
    expect(r.body.employee_id).toBe(mine);
  });

  it('/history lists only my completed reviews in my company', async () => {
    const ids = (await get(me, '/history')).body.map(x => x.id);
    expect(ids).toEqual([mineDone]);
  });

  it('/reviews lists only mine, even when another employee_id is asked for', async () => {
    const ids = (await get(me, `/reviews?employee_id=${other}`)).body.map(x => x.id).sort((a, b) => a - b);
    expect(ids).toEqual([mineDone, mineOpen].sort((a, b) => a - b));
    expect(ids).not.toContain(lookalikeReview);
    expect(ids).not.toContain(foreign);
  });

  it('/reviews/:id: mine 200, another employee\'s 403 (incl. the users.id lookalike), another company\'s 404', async () => {
    expect((await get(me, `/reviews/${mineDone}`)).status).toBe(200);
    expect((await get(me, `/reviews/${otherDone}`)).status).toBe(403);
    expect((await get(me, `/reviews/${lookalikeReview}`)).status).toBe(403);
    expect((await get(me, `/reviews/${foreign}`)).status).toBe(404);
  });

  it('an unlinked login sees nothing — never every review', async () => {
    expect((await get(U.employee, '/review/current')).body).toBeNull();
    expect((await get(U.employee, '/history')).body).toEqual([]);
    expect((await get(U.employee, '/reviews')).body).toEqual([]);
    expect((await get(U.employee, `/reviews/${mineDone}`)).status).toBe(403);
  });

  it('a manager still lists the company\'s reviews, and not another company\'s', async () => {
    const ids = (await get(U.manager, '/reviews')).body.map(x => x.id);
    expect(ids).toEqual(expect.arrayContaining([mineDone, mineOpen, otherDone]));
    expect(ids).not.toContain(foreign);
  });
});

// Calibration sessions: role checks over every role held, created_by is an
// employee, finalize reads back only the caller's company's session.
describe('calibration sessions', () => {
  const as = (who) => ({
    create:   (body = { session_name: `${PREFIX} new` }) => request(app).post('/api/performance/calibration/sessions')
      .set('Authorization', `Bearer ${who.token()}`).send(body),
    finalize: (id) => request(app).post(`/api/performance/calibration/sessions/${id}/finalize`)
      .set('Authorization', `Bearer ${who.token()}`),
    list:     () => request(app).get('/api/performance/calibration/sessions').set('Authorization', `Bearer ${who.token()}`),
  });
  const sessionIn = async (company, status = 'in_progress') => (await one(
    `INSERT INTO calibration_sessions (company_id, session_name, status) VALUES ($1, '${PREFIX} s', $2) RETURNING id`,
    [company.companyId, status])).id;
  const sessionRow = async (id) => JSON.stringify(await one(`SELECT * FROM calibration_sessions WHERE id = $1`, [id]));
  const withSecondRole = async (label, primary, secondary) => {
    const login = await addUser(pool, A, { label, roleCode: primary });
    await pool.query(`UPDATE user_roles SET is_primary = true WHERE user_id = $1`, [login.userId]);
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id, is_primary) SELECT $1, id, false FROM roles WHERE LOWER(code) = $2`,
      [login.userId, secondary]);
    return login;
  };
  let hrLinked, hrLinkedEmp, empPlusHrManager, empPlusExec, hrManager;
  beforeAll(async () => {
    hrLinked = await addUser(pool, A, { label: 'calsesshr', roleCode: 'hr' });
    hrLinkedEmp = await addEmployee(A, 'Oviya');
    if (hrLinkedEmp === hrLinked.userId) hrLinkedEmp = await addEmployee(A, 'Oviya2');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [hrLinkedEmp, hrLinked.userId]);
    hrManager        = await addUser(pool, A, { label: 'calsesshrm', roleCode: 'hr_manager' });
    empPlusHrManager = await withSecondRole('calsessemphrm', 'employee', 'hr_manager');
    empPlusExec      = await withSecondRole('calsessempexec', 'employee', 'hr_exec');
  });

  it('created_by is the linked employee id, not the user id', async () => {
    expect(hrLinkedEmp).not.toBe(hrLinked.userId);
    const r = await as(hrLinked).create();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ company_id: A.companyId, created_by: hrLinkedEmp });
  });

  it('a login with no linked employee creates the session with created_by NULL', async () => {
    const r = await as(U.hr).create();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created_by).toBeNull();
  });

  it.each([
    ['hr_manager as primary role',     () => hrManager],
    ['hr_manager as a secondary role', () => empPlusHrManager],
  ])('%s may create, list and finalize', async (_n, who) => {
    expect((await as(who()).create()).status).toBe(201);
    expect((await as(who()).list()).status).toBe(200);
    const id = await sessionIn(A);
    const r = await as(who()).finalize(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: 'completed', company_id: A.companyId });
  });

  it.each([
    ['hr_exec as a secondary role', () => empPlusExec],
    ['employee',                    () => U.employee],
    ['manager',                     () => U.manager],
    ['department_head',             () => U.department_head],
  ])('%s may neither create nor finalize, and nothing changes', async (_n, who) => {
    const id = await sessionIn(A);
    const before = await sessionRow(id);
    expect((await as(who()).create()).status).toBe(403);
    expect((await as(who()).finalize(id)).status).toBe(403);
    expect(await sessionRow(id)).toBe(before);
  });

  it('a manager still reads sessions; an employee does not', async () => {
    expect((await as(U.manager).list()).status).toBe(200);
    expect((await as(U.employee).list()).status).toBe(403);
  });

  it('finalizing another company\'s session is 404, returns none of its data, and leaves it unchanged', async () => {
    const id = await sessionIn(B);
    const before = await sessionRow(id);
    const r = await as(hrLinked).finalize(id);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(`"company_id":${B.companyId}`);
    expect(r.body).toEqual({ error: 'Session not found' });
    expect(await sessionRow(id)).toBe(before);
  });

  it('a login with no company can neither create nor finalize', async () => {
    const id = await sessionIn(A);
    const before = await sessionRow(id);
    expect((await as(U.noCompany).create()).status).toBe(403);
    expect((await as(U.noCompany).finalize(id)).status).toBe(403);
    expect(await sessionRow(id)).toBe(before);
  });
});

// POST /performance/calibration/sessions/:id/adjust
describe('calibration adjustment', () => {
  const adjust = (who, sessionId, body) => request(app).post(`/api/performance/calibration/sessions/${sessionId}/adjust`)
    .set('Authorization', `Bearer ${who.token()}`).send(body);
  const sessionIn = async (company, status = 'in_progress') => (await one(
    `INSERT INTO calibration_sessions (company_id, session_name, status) VALUES ($1, '${PREFIX} session', $2) RETURNING id`,
    [company.companyId, status])).id;
  const reviewIn = async (company, employeeId, status = 'manager_submitted') => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status, final_rating) VALUES ($1, $2, $3, 3.0) RETURNING id`,
    [employeeId, company.companyId, status])).id;
  const adjustmentsOf = async (reviewId) =>
    (await pool.query(`SELECT * FROM calibration_adjustments WHERE review_id = $1 ORDER BY id`, [reviewId])).rows;
  let hr, hrEmployee;
  beforeAll(async () => {
    hr = await addUser(pool, A, { label: 'calibhr', roleCode: 'hr' });
    hrEmployee = await addEmployee(A, 'Madhu');
    if (hrEmployee === hr.userId) hrEmployee = await addEmployee(A, 'Madhu2');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [hrEmployee, hr.userId]);
  });

  it('records the adjustment and the calibrated rating under the HR employee id, not the user id', async () => {
    expect(hrEmployee).not.toBe(hr.userId);
    const emp = await addEmployee(A, 'Nandini');
    const s = await sessionIn(A);
    const rv = await reviewIn(A, emp);
    const r = await adjust(hr, s, { review_id: rv, employee_id: emp, original_rating: 3, proposed_rating: 3.75, justification: 'peer set' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ session_id: s, review_id: rv, employee_id: emp, company_id: A.companyId,
      original_rating: '3.00', proposed_rating: '3.75', final_rating: '3.75', adjusted_by: hrEmployee });
    expect(await one(`SELECT calibrated_rating, hr_reviewer_id, status FROM performance_reviews WHERE id = $1`, [rv]))
      .toEqual({ calibrated_rating: '3.75', hr_reviewer_id: hrEmployee, status: 'manager_submitted' });
  });

  it('a second adjustment of the same review revises the one row (it used to fail every time)', async () => {
    const emp = await addEmployee(A, 'Ojas');
    const s = await sessionIn(A);
    const rv = await reviewIn(A, emp);
    expect((await adjust(hr, s, { review_id: rv, employee_id: emp, original_rating: 3, proposed_rating: 4 })).status).toBe(201);
    expect((await adjust(hr, s, { review_id: rv, employee_id: emp, proposed_rating: 4, final_rating: 4.25 })).status).toBe(201);
    const rows = await adjustmentsOf(rv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ original_rating: '3.00', proposed_rating: '4.00', final_rating: '4.25' });
    expect((await one(`SELECT calibrated_rating FROM performance_reviews WHERE id = $1`, [rv])).calibrated_rating).toBe('4.25');
  });

  it('an HR login with no employee record adjusts with adjusted_by / hr_reviewer_id NULL', async () => {
    const emp = await addEmployee(A, 'Pooja');
    const s = await sessionIn(A);
    const rv = await reviewIn(A, emp);
    const r = await adjust(U.hr, s, { review_id: rv, employee_id: emp, proposed_rating: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.adjusted_by).toBeNull();
    expect((await one(`SELECT hr_reviewer_id FROM performance_reviews WHERE id = $1`, [rv])).hr_reviewer_id).toBeNull();
  });

  // Every refusal: 4xx, the review unchanged, and no adjustment row.
  const refused = async (sessionId, reviewId, body, status, code, who = hr) => {
    const before = await rowOf(reviewId);
    const r = await adjust(who, sessionId, body);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    if (code) expect(r.body.code).toBe(code);
    expect(await rowOf(reviewId)).toBe(before);
    expect(await adjustmentsOf(reviewId)).toEqual([]);
  };

  it('another company\'s session is not found', async () => {
    const emp = await addEmployee(A, 'Qadir');
    const rv = await reviewIn(A, emp);
    await refused(await sessionIn(B), rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 404);
  });

  it('another company\'s review is not found, even through our own session', async () => {
    const rv = await reviewIn(B, E.B1);
    await refused(await sessionIn(A), rv, { review_id: rv, employee_id: E.B1, proposed_rating: 4 }, 404);
  });

  it('an employee_id that is not the review\'s employee is refused', async () => {
    const rv = await reviewIn(A, await addEmployee(A, 'Rohan'));
    await refused(await sessionIn(A), rv, { review_id: rv, employee_id: E.A1, proposed_rating: 4 }, 400, 'EMPLOYEE_MISMATCH');
  });

  it('a completed session is not adjusted', async () => {
    const emp = await addEmployee(A, 'Sita');
    const rv = await reviewIn(A, emp);
    await refused(await sessionIn(A, 'completed'), rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 409, 'SESSION_COMPLETED');
  });

  it('a completed review is not adjusted (the completed-review lock holds)', async () => {
    const emp = await addEmployee(A, 'Tanvi');
    const rv = await reviewIn(A, emp, 'completed');
    await refused(await sessionIn(A), rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 409, 'REVIEW_COMPLETED');
  });

  it.each([[3.755, 'proposed_rating'], [6, 'proposed_rating'], ['abc', 'final_rating']])(
    'rating %j in %s is refused rather than rounded', async (value, field) => {
      const emp = await addEmployee(A, 'Usha');
      const rv = await reviewIn(A, emp);
      await refused(await sessionIn(A), rv, { review_id: rv, employee_id: emp, proposed_rating: 4, [field]: value }, 400, 'INVALID_RATING');
    });

  it('a failure while writing back the calibrated rating rolls the adjustment back', async () => {
    const emp = await addEmployee(A, 'Vani');
    const s = await sessionIn(A);
    const rv = await reviewIn(A, emp);
    const before = await rowOf(rv);
    // Matched against the route's write-back of the calibrated rating. Not the
    // statement's opening words: testCleanupScoping reads those as an unscoped
    // UPDATE in this file (it is only a pattern, never executed).
    const r = await withFailingQuery('hr_submitted_at   = NOW()',
      () => adjust(hr, s, { review_id: rv, employee_id: emp, proposed_rating: 4 }));
    expect(r.status).toBe(500);
    expect(await rowOf(rv)).toBe(before);
    expect(await adjustmentsOf(rv)).toEqual([]);
  });

  it('non-HR roles and a login with no company are refused', async () => {
    const emp = await addEmployee(A, 'Wafa');
    const s = await sessionIn(A);
    const rv = await reviewIn(A, emp);
    await refused(s, rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 403, null, U.manager);
    await refused(s, rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 403, null, U.employee);
    await refused(s, rv, { review_id: rv, employee_id: emp, proposed_rating: 4 }, 403, null, U.noCompany);
  });
});

// PUT /reviews/:id — HR correction of review fields. No screen calls it.
describe('performance review edit (PUT /reviews/:id)', () => {
  const edit = (who, id, body) => request(app).put(`/api/performance/reviews/${id}`)
    .set('Authorization', `Bearer ${who.token()}`).send(body);
  const reviewWith = async (company, employeeId, status = 'manager_submitted') => (await one(
    `INSERT INTO performance_reviews (employee_id, company_id, status, final_rating) VALUES ($1, $2, $3, 3.0) RETURNING id`,
    [employeeId, company.companyId, status])).id;

  it('HR edits whole and fractional values; each is stored exactly; status and the assessment are untouched', async () => {
    const emp = await addEmployee(A, 'Wasim');
    const id = await reviewWith(A, emp);
    const r = await edit(U.hr, id, {
      self_rating: 4.5, manager_rating: 4, final_rating: '3.5', calibrated_rating: 3.75,
      kra_score: 87.25, behavioral_score: 90, salary_revision_percentage: 7.5,
      promotion_recommendation: true, manager_comments: 'corrected', review_period: 'FY26 H1',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await one(
      `SELECT self_rating, manager_rating, final_rating, calibrated_rating, kra_score, behavioral_score,
              salary_revision_percentage, promotion_recommendation, manager_comments, review_period, status
         FROM performance_reviews WHERE id = $1`, [id])).toEqual({
      self_rating: '4.5', manager_rating: '4.0', final_rating: '3.5', calibrated_rating: '3.75',
      kra_score: '87.25', behavioral_score: '90.00', salary_revision_percentage: '7.50',
      promotion_recommendation: true, manager_comments: 'corrected', review_period: 'FY26 H1', status: 'manager_submitted',
    });
    expect(await assessmentOf(emp)).toBeUndefined();
  });

  it.each([
    [{ self_rating: 3.55 },                 'self_rating',                'INVALID_RATING', 'Self rating can have at most 1 decimal place'],
    [{ manager_rating: '4.25' },            'manager_rating',             'INVALID_RATING', 'Manager rating can have at most 1 decimal place'],
    [{ final_rating: 3.33 },                'final_rating',               'INVALID_RATING', 'Final rating can have at most 1 decimal place'],
    [{ calibrated_rating: 3.755 },          'calibrated_rating',          'INVALID_RATING', 'Calibrated rating can have at most 2 decimal places'],
    [{ kra_score: 87.255 },                 'kra_score',                  'INVALID_RATING', 'KRA score can have at most 2 decimal places'],
    [{ behavioral_score: '90.001' },        'behavioral_score',           'INVALID_RATING', 'Behavioral score can have at most 2 decimal places'],
    [{ salary_revision_percentage: 7.125 }, 'salary_revision_percentage', 'INVALID_RATING', 'Salary revision % can have at most 2 decimal places'],
    [{ final_rating: 6 },                   'final_rating',               'INVALID_RATING', 'Final rating must be from 1 to 5'],
    [{ calibrated_rating: 0.5 },            'calibrated_rating',          'INVALID_RATING', 'Calibrated rating must be from 1 to 5'],
    [{ kra_score: 101 },                    'kra_score',                  'INVALID_RATING', 'KRA score must be from 0 to 100'],
    [{ salary_revision_percentage: -1 },    'salary_revision_percentage', 'INVALID_RATING', 'Salary revision % must be a number from 0 to 100'],
    [{ self_rating: 'great' },              'self_rating',                'INVALID_RATING', 'Self rating must be a number from 1 to 5'],
    [{ status: 'completed' },               'status',                     'WORKFLOW_FIELD', 'Status changes go through self-review, manager review and finalize, not this edit.'],
    [{ promotion_recommendation: 'yes' },   'promotion_recommendation',   'INVALID_FIELD',  'promotion_recommendation must be true or false'],
    [{ review_period: 'x'.repeat(51) },     'review_period',              'INVALID_FIELD',  'review_period must be text of at most 50 characters'],
    [{ manager_comments: 42 },              'manager_comments',           'INVALID_FIELD',  'manager_comments must be text'],
  ])('%j is refused with 400 and nothing changes', async (body, field, code, error) => {
    const id = await reviewWith(A, await addEmployee(A, 'Xavier'));
    const before = await rowOf(id);
    // A valid field alongside proves nothing is half-applied.
    const r = await edit(U.hr, id, { manager_comments: 'must not save', ...body });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ field, code, error });
    expect(await rowOf(id)).toBe(before);
  });

  it.each(['manager', 'employee', 'department_head', 'hr_exec'])('%s may not edit (403) and nothing changes', async (who) => {
    const id = await reviewWith(A, await addEmployee(A, 'Yamini'));
    const before = await rowOf(id);
    expect((await edit(U[who], id, { final_rating: 5 })).status).toBe(403);
    expect(await rowOf(id)).toBe(before);
  });

  it('another company\'s review is not found and unchanged', async () => {
    const id = await reviewWith(B, E.B1);
    const before = await rowOf(id);
    expect((await edit(U.hr, id, { final_rating: 5, manager_comments: 'cross' })).status).toBe(404);
    expect(await rowOf(id)).toBe(before);
  });

  it('a login with no company is refused (fail closed) and nothing changes', async () => {
    const id = await reviewWith(A, await addEmployee(A, 'Zara'));
    const before = await rowOf(id);
    expect((await edit(U.noCompany, id, { final_rating: 5 })).status).toBe(403);
    expect(await rowOf(id)).toBe(before);
  });

  it('a completed review is locked (409 REVIEW_COMPLETED) and unchanged', async () => {
    const id = await reviewWith(A, await addEmployee(A, 'Arjun'), 'completed');
    const before = await rowOf(id);
    const r = await edit(U.hr, id, { calibrated_rating: 4.5 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REVIEW_COMPLETED');
    expect(await rowOf(id)).toBe(before);
  });

  it('a body with no editable field is a 400, not a silent 200', async () => {
    const id = await reviewWith(A, await addEmployee(A, 'Bhavna'));
    const before = await rowOf(id);
    const r = await edit(U.hr, id, { unknown_field: 1 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NO_FIELDS');
    expect(await rowOf(id)).toBe(before);
  });
});

// manager_id references employees(id) and is read as the reviewing manager
// (joined to employees for manager_name). The submit used to write users.id.
describe('performance-review manager submit records the manager as an employee', () => {
  const submit = (who, id, body = { manager_rating: 4, final_rating: 4, manager_comments: 'solid year' }) =>
    request(app).post(`/api/performance/reviews/${id}/manager-review`)
      .set('Authorization', `Bearer ${who.token()}`).send(body);
  const reviewIn = async (company, employeeId, managerId = null) => (await one(
    `INSERT INTO performance_reviews (employee_id, manager_id, company_id, status) VALUES ($1, $2, $3, 'self_submitted') RETURNING id`,
    [employeeId, managerId, company.companyId])).id;
  let mgr, mgrEmployee;

  beforeAll(async () => {
    mgr = await addUser(pool, A, { label: 'mgrlinked', roleCode: 'manager' });
    mgrEmployee = await addEmployee(A, 'Manoj');
    if (mgrEmployee === mgr.userId) mgrEmployee = await addEmployee(A, 'Manoj2');
    await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [mgrEmployee, mgr.userId]);
  });

  it('a linked manager login is stored by its employee id, not its user id', async () => {
    expect(mgrEmployee).not.toBe(mgr.userId);
    const reviewee = await addEmployee(A, 'Divya');
    const id = await reviewIn(A, reviewee);
    const r = await submit(mgr, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await one(`SELECT manager_id, status, manager_rating, final_rating, manager_comments
                        FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ manager_id: mgrEmployee, status: 'manager_submitted', manager_rating: '4.0', final_rating: '4.0', manager_comments: 'solid year' });
    // A whole rating syncs as itself; no earlier assessment, so no history row.
    expect(await assessmentOf(reviewee)).toMatchObject({ performance_score: '4.00', company_id: A.companyId });
    expect(await historyOf(reviewee)).toEqual([]);
  });

  it('a fractional rating is kept exactly, and the assessment it replaces goes to history', async () => {
    const reviewee = await addEmployee(A, 'Farah');
    const prev = await one(
      `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
       VALUES ($1, 2, 4, 'before manager review', $2) RETURNING id`, [reviewee, A.companyId]);
    const id = await reviewIn(A, reviewee);
    const r = await submit(mgr, id, { manager_rating: 3.5, final_rating: 3.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await one(`SELECT manager_rating, final_rating FROM performance_reviews WHERE id = $1`, [id]))
      .toEqual({ manager_rating: '3.5', final_rating: '3.5' });
    expect(await assessmentOf(reviewee)).toMatchObject({
      id: prev.id, performance_score: '3.50', potential_score: 4, notes: 'before manager review', company_id: A.companyId,
    });
    const history = await historyOf(reviewee);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      assessment_id: prev.id, change_action: 'performance_review', changed_by_user_id: mgr.userId,
      performance_score: '2.00', potential_score: 4, notes: 'before manager review', company_id: A.companyId,
    });
  });

  it.each([
    [{ manager_rating: 4, final_rating: 3.55 }, 'final_rating', 'Final rating can have at most 1 decimal place'],
    [{ manager_rating: 4, final_rating: 6 },    'final_rating', 'Final rating must be from 1 to 5'],
    [{ manager_rating: 0, final_rating: 4 },    'manager_rating', 'Manager rating must be from 1 to 5'],
    [{ manager_rating: 4, final_rating: 'x' },  'final_rating', 'Final rating must be a number from 1 to 5'],
  ])('an unsupported rating %j is refused (never rounded) and nothing is written', async (body, field, error) => {
    const reviewee = await addEmployee(A, 'Ravi');
    const id = await reviewIn(A, reviewee);
    const before = await rowOf(id);
    const r = await submit(mgr, id, body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error, code: 'INVALID_RATING', field });
    expect(await rowOf(id)).toBe(before);
    expect(await assessmentOf(reviewee)).toBeUndefined();
  });

  it('a failing assessment sync rolls the review back (no saved review behind an error)', async () => {
    const reviewee = await addEmployee(A, 'Sanjay');
    const id = await reviewIn(A, reviewee);
    const before = await rowOf(id);
    expect((await withFailingAssessmentSync(() => submit(mgr, id))).status).toBe(500);
    expect(await rowOf(id)).toBe(before);
    expect(await assessmentOf(reviewee)).toBeUndefined();
    expect(await historyOf(reviewee)).toEqual([]);
  });

  it('an assessment held by another company is not changed, and the review is rolled back', async () => {
    const reviewee = await addEmployee(A, 'Tara');
    // talent_assessments is UNIQUE (employee_id) across companies.
    await pool.query(
      `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
       VALUES ($1, 5, 5, 'held by B', $2)`, [reviewee, B.companyId]);
    const heldBefore = JSON.stringify(await assessmentOf(reviewee));
    const id = await reviewIn(A, reviewee);
    const before = await rowOf(id);
    const r = await submit(mgr, id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ASSESSMENT_OTHER_COMPANY');
    expect(await rowOf(id)).toBe(before);
    expect(JSON.stringify(await assessmentOf(reviewee))).toBe(heldBefore);
    expect(await historyOf(reviewee)).toEqual([]);
  });

  it('a manager login with no linked employee gets 400 and the review is unchanged', async () => {
    const unlinked = await addUser(pool, A, { label: 'mgrnoemp', roleCode: 'manager' });
    const reviewee = await addEmployee(A, 'Gopal');
    const id = await reviewIn(A, reviewee, mgrEmployee);
    const before = await rowOf(id);
    const r = await submit(unlinked, id);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NO_LINKED_EMPLOYEE');
    expect(await rowOf(id)).toBe(before);
    expect(await assessmentOf(reviewee)).toBeUndefined();
  });

  it('another company\'s review is not touched', async () => {
    const id = await reviewIn(B, E.B1);
    const before = await rowOf(id);
    expect((await submit(mgr, id)).status).toBe(404);
    expect(await rowOf(id)).toBe(before);
  });
});

// performance_score is numeric(3,2): two decimals are kept, a third is refused
// rather than rounded by PostgreSQL.
describe('succession performance score precision', () => {
  it('keeps 2 decimals and refuses 3 on every assessment write', async () => {
    const emp = await addEmployee(A, 'Priya');
    const r = await call(U.hr, 'post', '/assessments').send({ employee_id: emp, performance_score: 3.25, potential_score: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.performance_score).toBe('3.25');
    const before = JSON.stringify(await assessmentOf(emp));
    const msg = 'performance_score can have at most 2 decimal places';
    expect((await call(U.hr, 'post', '/assessments').send({ employee_id: emp, performance_score: 3.255, potential_score: 3 })).body)
      .toEqual({ message: msg });
    expect((await call(U.hr, 'patch', `/assessments/${r.body.id}`).send({ performance_score: '4.125' })).body).toEqual({ message: msg });
    expect((await call(U.hr, 'post', '/assessments/sync-from-performance').send({ employee_id: emp, performance_score: 2.001 })).body)
      .toEqual({ message: msg });
    expect(JSON.stringify(await assessmentOf(emp))).toBe(before);
    expect(await historyOf(emp)).toEqual([]);
  });
});

// Phase 2: employees.is_test (set only for user-approved records) keeps an
// employee out of every succession grid, count, report and export, and out of
// new succession writes. Their stored rows are kept; other modules ignore it.
describe('succession leaves out employees flagged is_test', () => {
  let real, fake, role, poolId, levelId;
  const ids = (rows, key = 'employee_id') => rows.map(r => r[key]);
  beforeAll(async () => {
    real = await addEmployee(A, 'Reena');
    fake = await addEmployee(A, 'Zorvex');
    await pool.query(`UPDATE employees SET is_test = true WHERE id = $1 AND company_id = $2`, [fake, A.companyId]);
    await pool.query(
      `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, flight_risk, notes, company_id)
       VALUES ($1, 4, 5, 'high', 'real person', $3), ($2, 4, 5, 'high', 'test record', $3)`, [real, fake, A.companyId]);
    role = (await one(`INSERT INTO critical_roles (role_title, company_id) VALUES ('${PREFIX} test-flag role', $1) RETURNING id`, [A.companyId])).id;
    await pool.query(
      `INSERT INTO succession_plans (critical_role_id, candidate_employee_id, rank, readiness_level, company_id)
       VALUES ($1, $2, 1, 'ready-now', $4), ($1, $3, 2, 'ready-now', $4)`, [role, real, fake, A.companyId]);
    poolId = (await one(`INSERT INTO employee_talent_pools (pool_name, company_id) VALUES ('${PREFIX} test-flag pool', $1) RETURNING id`, [A.companyId])).id;
    await pool.query(`INSERT INTO employee_pool_members (pool_id, employee_id) VALUES ($1, $2), ($1, $3)`, [poolId, real, fake]);
    levelId = (await one(`INSERT INTO leadership_pipeline_levels (level_name, level_order, company_id) VALUES ('${PREFIX} L', 1, $1) RETURNING id`, [A.companyId])).id;
    await pool.query(
      `INSERT INTO leadership_pipeline_entries (employee_id, current_level_id, status, company_id) VALUES ($1, $3, 'active', $4), ($2, $3, 'active', $4)`,
      [real, fake, levelId, A.companyId]);
    await pool.query(
      `INSERT INTO development_plans (employee_id, plan_title, status, company_id) VALUES ($1, '${PREFIX} real plan', 'active', $3), ($2, '${PREFIX} test plan', 'active', $3)`,
      [real, fake, A.companyId]);
  });

  it('grids leave the test employee out and keep the real one', async () => {
    const assessments = (await call(U.hr, 'get', '/assessments')).body;
    expect(ids(assessments)).toContain(real);
    expect(ids(assessments)).not.toContain(fake);
    const box = (await call(U.hr, 'get', '/nine-box')).body.flatMap(b => b.employees);
    expect(ids(box)).toContain(real);
    expect(ids(box)).not.toContain(fake);
    expect(ids((await call(U.hr, 'get', `/critical-roles/${role}/candidates`)).body, 'candidate_employee_id')).toEqual([real]);
    expect(ids((await call(U.hr, 'get', `/pools/${poolId}/members`)).body)).toEqual([real]);
    const entries = ids((await call(U.hr, 'get', '/pipeline/entries')).body);
    expect(entries).toContain(real);
    expect(entries).not.toContain(fake);
    const plans = ids((await call(U.hr, 'get', '/development-plans')).body);
    expect(plans).toContain(real);
    expect(plans).not.toContain(fake);
  });

  it('counts leave the test employee out', async () => {
    const r = (await call(U.hr, 'get', '/critical-roles')).body.find(x => x.id === role);
    expect(r.candidate_count).toBe(1);
    expect((await call(U.hr, 'get', '/pools')).body.find(p => p.id === poolId).member_count).toBe(1);
    const dash = (await call(U.hr, 'get', '/dashboard')).body;
    expect(dash.top_high_potential.some(x => /Zorvex/.test(x.name))).toBe(false);
    expect(dash.top_high_potential.some(x => /Reena/.test(x.name))).toBe(true);
    // Bench strength counts the role as covered by the real ready-now candidate only.
    const bench = (await call(U.hr, 'get', '/reports/bench-strength')).body.find(x => x.role_title === `${PREFIX} test-flag role`);
    expect(bench).toMatchObject({ successor_count: 1, ready_now: 1 });
  });

  it.each(['talent-risk', 'nine-box-summary', 'readiness', 'pipeline', 'development-progress'])(
    'report %s (and its CSV export) leaves the test employee out', async (report) => {
      const json = (await call(U.hr, 'get', `/reports/${report}`)).body;
      expect(JSON.stringify(json)).not.toMatch(/test record|test plan/);
      const names = json.map(r => r.employee_name || r.name);
      expect(names.some(n => /Reena/.test(n || ''))).toBe(true);
      expect(names.some(n => /Zorvex/.test(n || ''))).toBe(false);
      const csv = await call(U.hr, 'get', `/reports/${report}?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.text).toMatch(/Reena/);
      expect(csv.text).not.toMatch(/Zorvex/);
    });

  it('the test employee\'s stored succession rows are kept, including through a slate replacement', async () => {
    const r = await call(U.hr, 'put', `/critical-roles/${role}/candidates`)
      .send({ candidates: [{ candidate_employee_id: real, rank: 1, readiness_level: 'ready-now' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stored = (await pool.query(`SELECT candidate_employee_id FROM succession_plans WHERE critical_role_id = $1 ORDER BY candidate_employee_id`, [role])).rows;
    expect(ids(stored, 'candidate_employee_id').sort((a, b) => a - b)).toEqual([real, fake].sort((a, b) => a - b));
    expect(await assessmentOf(fake)).toMatchObject({ notes: 'test record', company_id: A.companyId });
    expect((await one(`SELECT count(*)::int n FROM employee_pool_members WHERE pool_id = $1 AND employee_id = $2`, [poolId, fake])).n).toBe(1);
  });

  it.each([
    ['assessment',        'post', '/assessments',                        () => ({ employee_id: fake, performance_score: 3, potential_score: 3 })],
    ['performance sync',  'post', '/assessments/sync-from-performance',  () => ({ employee_id: fake, performance_score: 3 })],
    ['candidate',         'put',  () => `/critical-roles/${role}/candidates`, () => ({ candidates: [{ candidate_employee_id: fake }] })],
    ['pool member',       'post', () => `/pools/${poolId}/members`,       () => ({ employee_id: fake })],
    ['pipeline entry',    'post', '/pipeline/entries',                    () => ({ employee_id: fake, current_level_id: levelId })],
    ['development plan',  'post', '/development-plans',                   () => ({ employee_id: fake, plan_title: 'x' })],
    ['mentoring (mentee)', 'post', '/mentoring',                          () => ({ mentee_employee_id: fake, mentor_employee_id: real })],
    ['role holder',       'post', '/critical-roles',                      () => ({ role_title: `${PREFIX} held`, current_holder_id: fake })],
  ])('a new %s for a test employee is refused (400 TEST_EMPLOYEE) and nothing changes', async (_n, method, path, body) => {
    const before = await stateOf(A);
    const r = await call(U.hr, method, typeof path === 'function' ? path() : path).send(body());
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.code).toBe('TEST_EMPLOYEE');
    expect(await stateOf(A)).toBe(before);
  });

  it('the test employee\'s assessment history stays readable (audit trail)', async () => {
    expect((await call(U.hr, 'get', `/assessments/${fake}/history`)).status).toBe(200);
  });
});

describe('neutral label for the low/low cell', () => {
  it('nine-box and its report say "Low Performance / Low Potential"; scores are not changed', async () => {
    await pool.query(
      `INSERT INTO talent_assessments (employee_id, performance_score, potential_score, notes, company_id)
       VALUES ($1, 1, 1, 'low low', $2)`, [E.A2, A.companyId]);
    const box = (await call(U.hr, 'get', '/nine-box')).body.find(b => b.performance === 1 && b.potential === 1);
    expect(box.label).toBe('Low Performance / Low Potential');
    expect(box.employees.map(e => e.employee_id)).toContain(E.A2);
    const row = (await call(U.hr, 'get', '/reports/nine-box-summary')).body.find(x => Number(x.performance_score) === 1 && x.potential_score === 1);
    expect(row.quadrant).toBe('Low Performance / Low Potential');
    expect(JSON.stringify((await call(U.hr, 'get', '/nine-box')).body)).not.toMatch(/deadwood/i);
    expect(await assessmentOf(E.A2)).toMatchObject({ performance_score: '1.00', potential_score: 1, notes: 'low low' });
  });

  it('no source file still carries the old label or the import-time seed', () => {
    const src = (p) => readFileSync(resolve(here, p), 'utf8');
    const backend = src('../modules/hr/succession.routes.js');
    expect(backend).not.toMatch(/'Deadwood'/);
    expect(backend).not.toMatch(/process\.env\.RUN_SUCCESSION_SEED/);
    expect(src('../../../frontend/src/features/hr/pages/SuccessionPlanning.jsx')).not.toMatch(/Deadwood/);
  });
});
