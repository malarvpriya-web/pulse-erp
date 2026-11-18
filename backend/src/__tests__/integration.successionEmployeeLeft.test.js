/**
 * Succession — an employee leaving or serving notice (2026-11-12). Real routers
 * and database; throwaway companies with synthetic employees, removed afterwards.
 *
 *  - succession_employment_phase() agrees with employeeStatus.js for every
 *    spelling (exited, notice, current), and a soft delete is "left".
 *  - The employees trigger: when someone who appears anywhere in Succession
 *    leaves (any path that writes employees.status or deleted_at), ONE alert
 *    lists every place, and each user who can open Succession is notified;
 *    a user without Succession, another company, and a test employee are not.
 *    Notice raises an employee_notice alert. Nobody is notified for an
 *    employee who appears nowhere, or twice for the same change.
 *  - Settings → Notification Recipients limits who is notified.
 *  - Someone who has left is not counted (bench, candidates, pools, 9-box,
 *    HiPo, reports) but stays visible, marked, where there is work to clean
 *    up; and nobody who has left can be added anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const { EXITED_STATUSES, NOTICE_STATUSES, CURRENT_STATUSES } = await import('../shared/employeeStatus.js');
const { default: successionRoutes } = await import('../modules/hr/succession.routes.js');

const app = buildApp(['/api/succession', verifyToken, successionRoutes]);

const PREFIX = 'ZZSUCL';
let A, B;
const U = {};
const call = (who, method, path) => request(app)[method](`/api/succession${path}`).set('Authorization', `Bearer ${who.token()}`);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function addEmployee(company, first, status = 'Active') {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date)
     VALUES ($1, ${FIXTURE_CODE_SQL}, $2, 'Fixture', $3, '2025-04-01') RETURNING id`, [company.companyId, first, status]);
  return r.id;
}
const setStatus = (id, status) => pool.query(`UPDATE employees SET status = $2 WHERE id = $1`, [id, status]);
const alertsFor = async (employeeId) =>
  (await pool.query(`SELECT * FROM succession_alerts WHERE employee_id = $1 ORDER BY id`, [employeeId])).rows;
const notesFor = async (userId) =>
  (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 AND module_name = 'succession' ORDER BY id`, [userId])).rows;

async function sweep(companyId) {
  const c = [companyId];
  const soft = (sql) => pool.query(sql, c).catch(() => {});
  await soft(`DELETE FROM notifications WHERE module_name = 'succession' AND user_id IN (SELECT id FROM users WHERE company_id = $1)`);
  await soft(`DELETE FROM development_plans WHERE company_id = $1`);
  await soft(`DELETE FROM mentoring_assignments WHERE company_id = $1`);
  await soft(`DELETE FROM employee_talent_pools WHERE company_id = $1`);
  await soft(`DELETE FROM succession_alerts WHERE company_id = $1`);
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
  U.hr       = await addUser(pool, A, { label: 'hr', roleCode: 'hr' });
  U.hrMgr    = await addUser(pool, A, { label: 'hrmgr', roleCode: 'hr_manager' });
  U.employee = await addUser(pool, A, { label: 'emp', roleCode: 'employee' });
  U.hrB      = await addUser(pool, B, { label: 'hr', roleCode: 'hr' });
}, 90000);

afterAll(async () => {
  for (const c of [A, B]) if (c) await sweep(c.companyId);
  for (const c of [A, B]) if (c) await dropIsolatedCompany(pool, c.companyId);
}, 90000);

/* ── One vocabulary ────────────────────────────────────────────────────── */
describe('succession_employment_phase agrees with employeeStatus.js', () => {
  const phase = async (status, deleted = null) =>
    (await one(`SELECT succession_employment_phase($1, $2::timestamp) AS p`, [status, deleted])).p;

  it('every exited spelling (any case, padded) is left', async () => {
    for (const s of EXITED_STATUSES) {
      expect(await phase(s), s).toBe('left');
      expect(await phase(` ${s.toUpperCase()} `), s).toBe('left');
    }
  });
  it('every notice spelling is notice; every current one is employed', async () => {
    for (const s of NOTICE_STATUSES) expect(await phase(s), s).toBe('notice');
    for (const s of CURRENT_STATUSES.filter(x => !NOTICE_STATUSES.includes(x))) expect(await phase(s), s).toBe('employed');
    expect(await phase('Active')).toBe('employed');
    expect(await phase(null)).toBe('employed');
  });
  it('a soft-deleted employee has left whatever the status says', async () => {
    expect(await phase('Active', '2026-11-12 10:00')).toBe('left');
  });
});

/* ── The trigger ───────────────────────────────────────────────────────── */
describe('an employee who appears in Succession leaves', () => {
  const E = {};
  let roleId, otherRoleId, poolId, planId, mentoringId, levelId;

  beforeAll(async () => {
    E.leaver  = await addEmployee(A, 'Lakshmi');
    E.peer    = await addEmployee(A, 'Pavan');
    E.mentee  = await addEmployee(A, 'Mohan');
    E.nobody  = await addEmployee(A, 'Nila');
    E.tester  = await addEmployee(A, 'Testy');
    await pool.query(`UPDATE employees SET is_test = true WHERE id = $1`, [E.tester]);

    // The leaver holds one critical role, is successor #1 for another, is in
    // the pipeline, has a plan, mentors someone, is in a pool, and is rated.
    const post = (path, body) => call(U.hr, 'post', path).send(body);
    for (const id of [E.leaver, E.peer]) {
      expect((await post('/assessments', { employee_id: id, performance_score: 5, potential_score: 5, readiness: 'ready-now' })).status).toBe(201);
    }
    roleId = (await post('/critical-roles', { role_title: `${PREFIX} Head of Design`, current_holder_id: E.leaver, risk_level: 'high' })).body.id;
    otherRoleId = (await post('/critical-roles', { role_title: `${PREFIX} Plant Head`, risk_level: 'high' })).body.id;
    expect((await call(U.hr, 'put', `/critical-roles/${otherRoleId}/candidates`).send({ candidates: [
      { candidate_employee_id: E.leaver, rank: 1 }, { candidate_employee_id: E.peer, rank: 2 }] })).status).toBe(200);
    levelId = (await post('/pipeline/levels', { level_name: `${PREFIX} Manager`, level_order: 2 })).body.id;
    expect((await post('/pipeline/entries', { employee_id: E.leaver, current_level_id: levelId })).status).toBe(201);
    planId = (await post('/development-plans', { employee_id: E.leaver, plan_title: `${PREFIX} Design lead track` })).body.id;
    mentoringId = (await post('/mentoring', { mentee_employee_id: E.mentee, mentor_employee_id: E.leaver })).body.id;
    poolId = (await post('/pools', { pool_name: `${PREFIX} Future leaders`, pool_type: 'leadership' })).body.id;
    expect((await call(U.hr, 'post', `/pools/${poolId}/members`).send({ employee_id: E.leaver })).status).toBe(201);
    expect((await call(U.hr, 'post', `/pools/${poolId}/members`).send({ employee_id: E.peer })).status).toBe(201);
    // Recipients: everyone who can open Succession.
    const s = (await call(U.hr, 'get', '/settings')).body;
    expect((await call(U.hr, 'put', '/settings').send({ ...s, notify_roles: [] })).status).toBe(200);
  }, 60000);

  it('before: counted everywhere', async () => {
    const roles = (await call(U.hr, 'get', '/critical-roles')).body;
    expect(roles.find(r => r.id === otherRoleId)).toMatchObject({ candidate_count: 2, has_ready_now: true });
    expect((await call(U.hr, 'get', '/pools')).body.find(p => p.id === poolId).member_count).toBe(2);
  });

  it('serving notice raises an employee_notice alert and notifies, still counted', async () => {
    await pool.query(`UPDATE employees SET status = 'Notice', exit_date = '2026-12-31' WHERE id = $1`, [E.leaver]);
    const [alert] = await alertsFor(E.leaver);
    expect(alert).toMatchObject({ alert_type: 'employee_notice', company_id: A.companyId, is_read: false });
    expect(alert.message).toMatch(/serving notice \(last day 31 Dec 26\)/);
    expect((await notesFor(U.hr.userId)).map(n => n.reference_id)).toEqual([alert.id]);
    expect((await call(U.hr, 'get', '/critical-roles')).body.find(r => r.id === otherRoleId).candidate_count).toBe(2);
  });

  it('leaving raises ONE alert listing every place, and notifies HR only', async () => {
    await setStatus(E.leaver, 'Left');
    const alerts = await alertsFor(E.leaver);
    expect(alerts.map(a => a.alert_type)).toEqual(['employee_notice', 'employee_left']);
    const left = alerts[1];
    expect(left).toMatchObject({ severity: 'critical', role_id: roleId, company_id: A.companyId });
    const kinds = left.details.items.map(i => i.kind).sort();
    expect(kinds).toEqual(['assessment', 'development_plan', 'mentor', 'pipeline', 'pool', 'role_holder', 'successor']);
    for (const text of ['Recorded in Succession as: holder of the critical role', `successor #1 for "${PREFIX} Plant Head"`, 'leadership pipeline',
                        `${PREFIX} Design lead track`, 'mentor of Mohan Fixture', `${PREFIX} Future leaders`, 'rated on the 9-box']) {
      expect(left.message).toContain(text);
    }
    for (const u of [U.hr, U.hrMgr]) {
      const n = (await notesFor(u.userId)).at(-1);
      expect(n).toMatchObject({ reference_id: left.id, notification_type: 'warning', link: '/SuccessionCenter?tab=planning' });
      expect(n.title).toBe('Succession: Lakshmi Fixture has left');
    }
    expect(await notesFor(U.employee.userId)).toEqual([]);
    expect(await notesFor(U.hrB.userId)).toEqual([]);
    // The Planning banner lists it.
    const listed = (await call(U.hr, 'get', '/alerts?unread=1')).body.find(a => a.id === left.id);
    expect(listed).toMatchObject({ employee_name: 'Lakshmi Fixture', alert_type: 'employee_left' });
  });

  it('the same change again, or another exited spelling, does not notify twice', async () => {
    const before = (await alertsFor(E.leaver)).length;
    await setStatus(E.leaver, 'Left');
    await setStatus(E.leaver, 'relieved');
    await pool.query(`UPDATE employees SET deleted_at = NOW() WHERE id = $1`, [E.leaver]);
    await pool.query(`UPDATE employees SET deleted_at = NULL WHERE id = $1`, [E.leaver]);
    expect((await alertsFor(E.leaver)).length).toBe(before);
  });

  it('after: not counted, still shown and marked where there is work to clean up', async () => {
    const roles = (await call(U.hr, 'get', '/critical-roles')).body;
    expect(roles.find(r => r.id === roleId)).toMatchObject({ holder_phase: 'left' });
    expect(roles.find(r => r.id === otherRoleId)).toMatchObject({ candidate_count: 1, left_candidate_count: 1, has_ready_now: true });
    const cands = (await call(U.hr, 'get', `/critical-roles/${otherRoleId}/candidates`)).body;
    expect(cands.map(c => [c.candidate_employee_id, c.employment_phase])).toEqual([[E.leaver, 'left'], [E.peer, 'employed']]);
    expect((await call(U.hr, 'get', '/pools')).body.find(p => p.id === poolId).member_count).toBe(1);
    expect((await call(U.hr, 'get', `/pools/${poolId}/members`)).body.find(m => m.employee_id === E.leaver).employment_phase).toBe('left');
    expect((await call(U.hr, 'get', '/pipeline/entries')).body.find(e => e.employee_id === E.leaver).employment_phase).toBe('left');
    expect((await call(U.hr, 'get', '/development-plans')).body.find(p => p.id === planId).employment_phase).toBe('left');
    expect((await call(U.hr, 'get', '/mentoring')).body.find(m => m.id === mentoringId).mentor_phase).toBe('left');
    // The 9-box, HiPo and the people reports are current employees only.
    const grid = (await call(U.hr, 'get', '/nine-box')).body.flatMap(c => c.employees.map(e => e.employee_id));
    expect(grid).toContain(E.peer);
    expect(grid).not.toContain(E.leaver);
    const dash = (await call(U.hr, 'get', '/dashboard')).body;
    expect(dash.top_high_potential.map(x => x.name)).not.toContain('Lakshmi Fixture');
    for (const r of ['talent-risk', 'nine-box-summary', 'readiness']) {
      expect(JSON.stringify((await call(U.hr, 'get', `/reports/${r}`)).body), r).not.toContain('Lakshmi');
    }
    const bench = (await call(U.hr, 'get', '/reports/bench-strength')).body.find(r => r.role_title === `${PREFIX} Plant Head`);
    expect(bench).toMatchObject({ successor_count: 1, ready_now: 1 });
  });

  it('nobody who has left can be added anywhere; the stored slate can still be re-saved', async () => {
    const codes = [];
    const push = async (p) => codes.push((await p).body.code);
    await push(call(U.hr, 'post', '/assessments').send({ employee_id: E.leaver, performance_score: 3, potential_score: 3 }));
    await push(call(U.hr, 'post', '/critical-roles').send({ role_title: `${PREFIX} x`, current_holder_id: E.leaver }));
    await push(call(U.hr, 'patch', `/critical-roles/${otherRoleId}`).send({ current_holder_id: E.leaver }));
    await push(call(U.hr, 'post', `/pools/${poolId}/members`).send({ employee_id: E.leaver }));
    await push(call(U.hr, 'post', '/development-plans').send({ employee_id: E.leaver, plan_title: 'x' }));
    await push(call(U.hr, 'post', '/mentoring').send({ mentee_employee_id: E.peer, mentor_employee_id: E.leaver }));
    expect(codes).toEqual(Array(6).fill('EMPLOYEE_LEFT'));
    const newRole = (await call(U.hr, 'post', '/critical-roles').send({ role_title: `${PREFIX} y` })).body.id;
    expect((await call(U.hr, 'put', `/critical-roles/${newRole}/candidates`).send({ candidates: [{ candidate_employee_id: E.leaver, rank: 1 }] })).body.code).toBe('EMPLOYEE_LEFT');
    // The existing slate, leaver included, saves; removing them works.
    expect((await call(U.hr, 'put', `/critical-roles/${otherRoleId}/candidates`).send({ candidates: [
      { candidate_employee_id: E.leaver, rank: 1 }, { candidate_employee_id: E.peer, rank: 2 }] })).status).toBe(200);
    expect((await call(U.hr, 'put', `/critical-roles/${otherRoleId}/candidates`).send({ candidates: [
      { candidate_employee_id: E.peer, rank: 1 }] })).status).toBe(200);
    // The holder who left may stay on a role edit that does not change the holder.
    expect((await call(U.hr, 'patch', `/critical-roles/${roleId}`).send({ current_holder_id: E.leaver, reason: 'kept' })).status).toBe(200);
  });

  it('an employee who appears nowhere, or a test employee, raises nothing', async () => {
    await setStatus(E.nobody, 'Left');
    expect(await alertsFor(E.nobody)).toEqual([]);
    await pool.query(`INSERT INTO succession_plans (critical_role_id, candidate_employee_id, rank, company_id) VALUES ($1, $2, 3, $3)`,
      [otherRoleId, E.tester, A.companyId]);
    await setStatus(E.tester, 'Left');
    expect(await alertsFor(E.tester)).toEqual([]);
  });

  it('Settings → Notification Recipients limits who is told', async () => {
    const s = (await call(U.hr, 'get', '/settings')).body;
    const rr = await call(U.hr, 'get', '/settings/recipient-roles');
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    const roles = rr.body;
    expect(roles.map(r => r.code)).toEqual(expect.arrayContaining(['hr', 'hr_manager']));
    expect(roles.map(r => r.code)).not.toContain('employee');
    expect(roles.find(r => r.code === 'hr').user_count).toBe(1);
    expect((await call(U.hr, 'put', '/settings').send({ ...s, notify_roles: ['chro'] })).status).toBe(400);
    expect((await call(U.hr, 'put', '/settings').send({ ...s, notify_roles: ['employee'] })).status).toBe(400);
    expect((await call(U.hr, 'put', '/settings').send({ ...s, notify_roles: ['hr_manager'] })).status).toBe(200);
    const hrBefore = (await notesFor(U.hr.userId)).length;
    const mgrBefore = (await notesFor(U.hrMgr.userId)).length;
    await setStatus(E.peer, 'Resigned');
    expect((await alertsFor(E.peer)).map(a => a.alert_type)).toEqual(['employee_left']);
    expect((await notesFor(U.hr.userId)).length).toBe(hrBefore);
    expect((await notesFor(U.hrMgr.userId)).length).toBe(mgrBefore + 1);
    // Saving other settings keeps the recipients.
    const again = (await call(U.hr, 'get', '/settings')).body;
    expect(again.notify_roles).toEqual(['hr_manager']);
    const { notify_roles, ...rest } = again;
    expect((await call(U.hr, 'put', '/settings').send(rest)).body.notify_roles).toEqual(['hr_manager']);
  });
});
