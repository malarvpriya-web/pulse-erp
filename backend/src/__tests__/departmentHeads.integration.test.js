/**
 * Department heads — per-company mapping with history (20261014000006).
 *
 * Against the live database and the real router + permission middleware:
 *   - missing company context → 403 on every route;
 *   - authorization: hr / hr_exec / hr_manager (hr:edit) manage; department
 *     heads, managers and employees get 403 — and no permission row changes;
 *   - eligibility: same company, current, not deleted, active linked login,
 *     active department;
 *   - one active head per company + department; reassignment ends the old
 *     row and inserts the new one atomically, with a required reason; the
 *     same head again adds no history; concurrent reassignment → one winner;
 *   - tenant isolation: company B never sees or changes company A's mappings
 *     and cannot name A's employees.
 *
 * master_departments is global and only READ here. Fixtures live in two
 * registry tenants (testTenantIds.contract.test.js) and are deleted in
 * afterAll. ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { default: router } = await import('../probation/departmentHeads.routes.js');

const A = 999969;
const B = 999970;
const PW = 'Zz-DHead-Test-9!';
const fx = { tok: {}, user: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/department-heads', router);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const get = (who, path = '') => request(app).get(`/api/department-heads${path}`).set(as(who));
const put = (who, dept, body) => request(app).put(`/api/department-heads/${dept}`).set(as(who)).send(body);
const del = (who, dept, body) => request(app).delete(`/api/department-heads/${dept}`).set(as(who)).send(body);
const headOf = async (who, dept) => (await get(who)).body.departments.find((d) => d.department_id === dept)?.head ?? null;
const rows = async (cid, dept) => (await pool.query(
  `SELECT id, head_employee_id, ended_at, ended_by_user_id, end_reason, assigned_by_user_id
     FROM department_heads WHERE company_id = $1 AND department_id = $2 ORDER BY id`, [cid, dept])).rows;

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.dhead.%@example.com'`;
  await pool.query(`DELETE FROM department_heads WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.dhead.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
let deptName; let desig;
async function emp(key, cid, { status = 'Active', deleted = false } = {}) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, deleted_at)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,'2025-01-01',$8) RETURNING id`,
    [cid, `EMP969${String(seq).padStart(3, '0')}`, key, `zz.dhead.emp.${key}@example.com`, deptName, desig,
      status, deleted ? new Date() : null])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null, { active = true } = {}) {
  const email = `zz.dhead.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
  if (!active) await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [fx.user[key]]);
}

beforeAll(async () => {
  await cleanup();
  const { rows: depts } = await pool.query(`SELECT id, name FROM master_departments WHERE is_active ORDER BY id LIMIT 3`);
  [fx.d1, fx.d2, fx.d3] = depts.map((d) => d.id);
  deptName = depts[0].name;
  fx.inactiveDept = (await pool.query(`SELECT id FROM master_departments WHERE is_active = false ORDER BY id LIMIT 1`)).rows[0]?.id ?? null;
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ DHead A','ZZDHA'), ($2,'ZZ DHead B','ZZDHB')`, [A, B]);

  // Eligible heads in A (current, with an active login)
  await login('head1', 'employee', A, await emp('head1', A));
  await login('head2', 'employee', A, await emp('head2', A, { status: 'Probation' }));
  await login('head3', 'employee', A, await emp('head3', A));
  // Ineligible in A
  await emp('noLogin', A);
  await login('inactiveLogin', 'employee', A, await emp('inactiveLogin', A), { active: false });
  await login('exited', 'employee', A, await emp('exited', A, { status: 'Left' }));
  await login('deleted', 'employee', A, await emp('deleted', A, { deleted: true }));
  // Company B
  await login('bHead', 'employee', B, await emp('bHead', B));

  // Administrators and the roles that must be refused
  await login('hr', 'hr', A);
  await login('hrExec', 'hr_exec', A);
  await login('hrManager', 'hr_manager', A);
  await login('deptHead', 'department_head', A, await emp('deptHeadUser', A));
  await login('manager', 'manager', A);
  await login('employee', 'employee', A, await emp('plainEmployee', A));
  await login('hrB', 'hr', B);
  await login('noCompanyHr', 'hr', null);
}, 90000);

afterAll(cleanup);

describe('company context and authorization', () => {
  it('a login with no company context is refused on every route', async () => {
    expect((await get('noCompanyHr')).status).toBe(403);
    expect((await get('noCompanyHr', `/${fx.d1}/history`)).status).toBe(403);
    expect((await put('noCompanyHr', fx.d1, { head_employee_id: fx.emp.head1 })).status).toBe(403);
    expect((await del('noCompanyHr', fx.d1, { reason: 'x' })).status).toBe(403);
  });

  it('department heads, managers and employees cannot read or manage it', async () => {
    for (const who of ['deptHead', 'manager', 'employee']) {
      expect((await get(who)).status, who).toBe(403);
      expect((await get(who, `/${fx.d1}/history`)).status, who).toBe(403);
      expect((await put(who, fx.d1, { head_employee_id: fx.emp.head1 })).status, who).toBe(403);
      expect((await del(who, fx.d1, { reason: 'x' })).status, who).toBe(403);
    }
  });

  it('the department_head role still holds no hr or internships permission', async () => {
    const { rows: perms } = await pool.query(
      `SELECT rp.module, rp.can_view, rp.can_edit FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'department_head' AND rp.module IN ('hr', 'internships') ORDER BY rp.module`);
    expect(perms.every((p) => p.can_view === false && p.can_edit === false)).toBe(true);
  });

  it('hr, hr_exec and hr_manager can read it', async () => {
    for (const who of ['hr', 'hrExec', 'hrManager']) {
      const res = await get(who);
      expect(res.status, who).toBe(200);
      expect(res.body.departments.length).toBeGreaterThan(0);
    }
  });
});

describe('eligibility', () => {
  it('lists only current employees of this company with an active login as eligible heads', async () => {
    const ids = (await get('hr')).body.eligible_heads.map((e) => e.employee_id);
    for (const k of ['head1', 'head2', 'head3', 'deptHeadUser', 'plainEmployee']) expect(ids, k).toContain(fx.emp[k]);
    for (const k of ['noLogin', 'inactiveLogin', 'exited', 'deleted', 'bHead']) expect(ids, k).not.toContain(fx.emp[k]);
  });

  it('refuses each ineligible head with a reason, and assigns nothing', async () => {
    const cases = {
      noLogin: /no active Pulse login/,
      inactiveLogin: /no active Pulse login/,
      exited: /not a current employee/,
      deleted: /not a current employee/,
      bHead: /not an employee of this company/,
    };
    for (const [k, msg] of Object.entries(cases)) {
      const res = await put('hr', fx.d1, { head_employee_id: fx.emp[k] });
      expect(res.status, k).toBe(400);
      expect(res.body.error, k).toMatch(msg);
    }
    expect((await put('hr', fx.d1, { head_employee_id: 987654321 })).status).toBe(400);
    expect((await put('hr', fx.d1, {})).status).toBe(400);
    expect(await rows(A, fx.d1)).toEqual([]);
  });

  it('refuses an unknown or inactive department', async () => {
    expect((await put('hr', 987654321, { head_employee_id: fx.emp.head1 })).status).toBe(404);
    if (fx.inactiveDept) {
      const res = await put('hr', fx.inactiveDept, { head_employee_id: fx.emp.head1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/inactive/);
    }
  });
});

describe('assignment, reassignment and history', () => {
  it('assigns a head and records who did it', async () => {
    const res = await put('hr', fx.d1, { head_employee_id: fx.emp.head1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, head_employee_id: fx.emp.head1, replaced_assignment_id: null });
    const head = await headOf('hr', fx.d1);
    expect(head).toMatchObject({ employee_id: fx.emp.head1, is_current: true, has_login: true });
    expect((await rows(A, fx.d1))[0]).toMatchObject({ assigned_by_user_id: fx.user.hr, ended_at: null });
  });

  it('assigning the same head again changes nothing and adds no history', async () => {
    const res = await put('hrExec', fx.d1, { head_employee_id: fx.emp.head1, reason: 'again' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(await rows(A, fx.d1)).toHaveLength(1);
  });

  it('reassigning requires a reason, then ends the old row and starts a new one atomically', async () => {
    const noReason = await put('hr', fx.d1, { head_employee_id: fx.emp.head2 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/reason is required/);
    expect((await rows(A, fx.d1)).filter((r) => r.ended_at == null).map((r) => r.head_employee_id)).toEqual([fx.emp.head1]);

    const res = await put('hrManager', fx.d1, { head_employee_id: fx.emp.head2, reason: 'Moved to Operations' });
    expect(res.status).toBe(200);
    const all = await rows(A, fx.d1);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ head_employee_id: fx.emp.head1, ended_by_user_id: fx.user.hrManager, end_reason: 'Moved to Operations' });
    expect(all[0].ended_at).not.toBeNull();
    expect(all[1]).toMatchObject({ head_employee_id: fx.emp.head2, ended_at: null, assigned_by_user_id: fx.user.hrManager });
  });

  it('history lists every assignment, newest first, with who and why', async () => {
    const res = await get('hr', `/${fx.d1}/history`);
    expect(res.status).toBe(200);
    expect(res.body.history.map((h) => h.employee_id)).toEqual([fx.emp.head2, fx.emp.head1]);
    expect(res.body.history[1]).toMatchObject({ end_reason: 'Moved to Operations', ended_by: 'Zz hrManager', assigned_by: 'Zz hr' });
  });

  it('a reassignment that loses a race gets 409 and leaves no partial row', async () => {
    // Deterministic race: a competing transaction holds the active row's lock,
    // the request blocks on it, the competitor commits its own reassignment,
    // and only then does the request proceed — into the unique active index.
    const competitor = await pool.connect();
    try {
      await competitor.query('BEGIN');
      await competitor.query(
        `SELECT id FROM department_heads WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL FOR UPDATE`,
        [A, fx.d1]);
      // .then() SENDS it now — a supertest request is lazy until awaited.
      const pending = put('hrExec', fx.d1, { head_employee_id: fx.emp.head3, reason: 'race loser' }).then((r) => r);
      // Wait until the request is really BLOCKED behind the competitor's lock
      // (a fixed sleep raced under full-suite load), up to 10 s.
      for (let i = 0; i < 100; i++) {
        const { rows: [w] } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%FROM department_heads%FOR UPDATE%'`);
        if (w.n > 0) break;
        await new Promise((r) => { setTimeout(r, 100); });
      }
      await competitor.query(
        `UPDATE department_heads SET ended_at = NOW(), ended_by_user_id = $3, end_reason = 'race winner'
          WHERE company_id = $1 AND department_id = $2 AND ended_at IS NULL`, [A, fx.d1, fx.user.hr]);
      await competitor.query(
        `INSERT INTO department_heads (company_id, department_id, head_employee_id, assigned_by_user_id)
         VALUES ($1, $2, $3, $4)`, [A, fx.d1, fx.emp.head1, fx.user.hr]);
      await competitor.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/changed by someone else/);
    } finally {
      // A failed assertion must not hand back a connection mid-transaction.
      await competitor.query('ROLLBACK').catch(() => {});
      competitor.release();
    }
    const all = await rows(A, fx.d1);
    expect(all.filter((r) => r.ended_at == null).map((r) => r.head_employee_id)).toEqual([fx.emp.head1]);
    expect(all).toHaveLength(3);                                       // the loser wrote nothing
    expect(all.some((r) => r.end_reason === 'race loser')).toBe(false);
  }, 20000);

  it('two reassignments sent together still leave exactly one active head', async () => {
    // Either they serialise (both succeed, each ending the previous head with
    // its own reason) or they collide (one 409). Both are correct; what must
    // never happen is two active heads or an ended row with no reason.
    const results = await Promise.all([
      put('hr', fx.d1, { head_employee_id: fx.emp.head2, reason: 'together one' }),
      put('hrExec', fx.d1, { head_employee_id: fx.emp.head3, reason: 'together two' }),
    ]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    const all = await rows(A, fx.d1);
    expect(all.filter((r) => r.ended_at == null)).toHaveLength(1);
    expect(all.filter((r) => r.ended_at != null).every((r) => r.end_reason && r.ended_by_user_id)).toBe(true);
  }, 20000);

  it('removing a head requires a reason, keeps the history, and leaves the department unassigned', async () => {
    expect((await del('hr', fx.d1, {})).status).toBe(400);
    const before = (await rows(A, fx.d1)).length;
    const res = await del('hr', fx.d1, { reason: 'Department restructured' });
    expect(res.status).toBe(200);
    expect(await headOf('hr', fx.d1)).toBeNull();
    const all = await rows(A, fx.d1);
    expect(all).toHaveLength(before);
    expect(all.every((r) => r.ended_at != null)).toBe(true);
    expect(all.at(-1)).toMatchObject({ end_reason: 'Department restructured', ended_by_user_id: fx.user.hr });
    expect((await del('hr', fx.d1, { reason: 'again' })).status).toBe(404);
  });

  it('a head who later exits stays mapped but is flagged', async () => {
    await put('hr', fx.d2, { head_employee_id: fx.emp.head3 });
    await pool.query(`UPDATE employees SET status = 'Left' WHERE id = $1`, [fx.emp.head3]);
    expect(await headOf('hr', fx.d2)).toMatchObject({ employee_id: fx.emp.head3, is_current: false });
    await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [fx.emp.head3]);
  });
});

describe('tenant isolation', () => {
  it('each company has its own head for the same department, invisible to the other', async () => {
    expect((await put('hr', fx.d3, { head_employee_id: fx.emp.head1 })).status).toBe(200);
    expect((await put('hrB', fx.d3, { head_employee_id: fx.emp.bHead })).status).toBe(200);
    expect(await headOf('hr', fx.d3)).toMatchObject({ employee_id: fx.emp.head1 });
    expect(await headOf('hrB', fx.d3)).toMatchObject({ employee_id: fx.emp.bHead });

    const bList = (await get('hrB')).body;
    const aIds = Object.values(fx.emp);
    expect(bList.departments.every((d) => d.head == null || d.head.employee_id === fx.emp.bHead)).toBe(true);
    expect(bList.eligible_heads.every((e) => e.employee_id === fx.emp.bHead || !aIds.includes(e.employee_id))).toBe(true);
    expect((await get('hrB', `/${fx.d1}/history`)).body.history).toEqual([]);
  });

  it('company B cannot assign A\'s employees, or end A\'s mapping', async () => {
    const res = await put('hrB', fx.d2, { head_employee_id: fx.emp.head1 });
    expect(res.status).toBe(400);
    expect((await del('hrB', fx.d2, { reason: 'cross-tenant' })).status).toBe(404);
    expect(await headOf('hr', fx.d2)).toMatchObject({ employee_id: fx.emp.head3 });
  });
});
