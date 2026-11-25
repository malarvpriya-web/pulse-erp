/**
 * Leave rules fixed in the Leaves review (2026-11-23), against a real DB in a
 * throwaway company:
 *   - L2 and HR queues never list the same leave (L2 only for l2_required types)
 *   - HR bulk approve takes the HR step (needs L1 first), not a shortcut
 *   - a type's required attachment is enforced on the server
 *   - notice period → Loss of Pay only
 *   - a leave type in use cannot be deleted; it can be switched off
 *   - Allocations "used" = approved leave
 *   - (2026-11-24) the reporting manager takes the L1 step with only the
 *     employee role; HR/admin step in only when the manager cannot log in
 *   - (2026-11-24) a manager login with no employee record sees no one's
 *     pending leave or balances (it used to see the whole company's)
 *   - (2026-11-24) the server counts the leave days itself: the client's
 *     number_of_days / lop_days / is_lop are ignored
 *   - (2026-11-24) cancel: an employee only before the leave starts; HR any,
 *     with a reason once started; approved LOP comes off the draft payroll
 *   - (2026-11-24) a leave attachment is a real stored file; the applicant,
 *     their manager and HR open it, an unrelated colleague cannot
 *   - (2026-11-24) escalation: once per step after N days; HR told and may
 *     then take the manager step; 0 days = never
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const { default: pool }         = await import('../config/db.js');
const { verifyToken }           = await import('../middlewares/auth.middleware.js');
const { buildApp }              = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');
const { default: leaveRoutes }  = await import('../modules/leaves/routes/leaves.routes.js');
const { default: encRoutes }    = await import('../modules/leaves/routes/encashment.routes.js');
const { default: fileRoutes }   = await import('../modules/files/secureFiles.routes.js');
const { LOCAL_UPLOAD_DIR }      = await import('../services/StorageService.js');
const { rmSync }                = await import('node:fs');
const { getWeekendDays, dayIsWeekend } = await import('../shared/weekend.js');
const { runWorkedAccrual }      = await import('../modules/leaves/services/leaveAccrual.service.js');
const { runLeaveEscalation }    = await import('../modules/leaves/services/leaveEscalation.service.js');

const app = buildApp(['/api/leaves', verifyToken, leaveRoutes], ['/api/leave-encashment', verifyToken, encRoutes], ['/api/files', fileRoutes]);
const PREFIX = 'ZZLVRULE';
let A, emp, noticeEmp, T = {};
const api = (method, path, body) => {
  const r = request(app)[method](`/api/leaves${path}`).set('Authorization', `Bearer ${A.token()}`);
  return body ? r.send(body) : r;
};
const apply = (body) => api('post', '/apply', { employee_id: emp, reason: 'rule test', ...body });

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  const q = (sql) => pool.query(sql, [companyId]);
  await q(`UPDATE users SET employee_id = NULL WHERE company_id = $1`);
  await q(`DELETE FROM leave_approval_history WHERE leave_application_id IN (SELECT id FROM leave_applications WHERE employee_id IN ${emps})`);
  await q(`DELETE FROM leave_encashments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_adjustments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM leave_accrual_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM compensatory_off WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`);
  await q(`DELETE FROM attendance_general_settings WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'leaves'`);
  await q(`DELETE FROM attendance_records WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM leave_applications WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM leave_balances WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM leave_types WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  A = await createIsolatedCompany(pool, PREFIX);
  const mk = async (code, status = 'Active') => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
     VALUES ($1, $2, 'Rule', $2, $3, '2025-01-01', 'Testing') RETURNING id`, [A.companyId, code, status])).rows[0].id;
  emp = await mk('EMP901');
  noticeEmp = await mk('EMP902', 'Notice');
  const type = async (name, code, extra = {}) => (await pool.query(
    `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, l2_required, requires_attachment, is_active)
     VALUES ($1, $2, 10, $3, $4, $5, true) RETURNING id`,
    [name, code, A.companyId, !!extra.l2, !!extra.att])).rows[0].id;
  T.plain = await type('ZZ Plain', 'ZZPLAIN');
  T.l2 = await type('ZZ Needs L2', 'ZZL2', { l2: true });
  T.att = await type('ZZ Needs Doc', 'ZZDOC', { att: true });
  for (const e of [emp, noticeEmp]) for (const t of Object.values(T)) {
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [e, t]);
  }
}, 60000);

afterAll(async () => {
  if (A) { await sweep(A.companyId); await dropIsolatedCompany(pool, A.companyId); }
}, 60000);

describe('apply', () => {
  it('a type that needs a document is refused without one, accepted with one', async () => {
    const no = await apply({ leave_type_id: T.att, start_date: '2027-03-01', end_date: '2027-03-01', number_of_days: 1 });
    expect(no.status, JSON.stringify(no.body)).toBe(422);
    expect(no.body.code).toBe('ATTACHMENT_REQUIRED');
    const yes = await apply({ leave_type_id: T.att, start_date: '2027-03-01', end_date: '2027-03-01', number_of_days: 1, attachment_url: '/uploads/1700000000000_certificate.pdf' });
    expect(yes.status, JSON.stringify(yes.body)).toBe(201);
  });

  it('someone serving notice may take Loss of Pay only', async () => {
    const res = await api('post', '/apply', { employee_id: noticeEmp, leave_type_id: T.plain, start_date: '2027-03-02', end_date: '2027-03-02', number_of_days: 1, reason: 'x' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('NOTICE_RESTRICTED');
    const st = await api('get', `/probation-status?employee_id=${noticeEmp}`);
    expect(st.body.in_notice).toBe(true);
  });

  it('a full Mon–Fri week is no longer refused by the old sandwich check', async () => {
    await pool.query('UPDATE leave_types SET sandwich_rule = true WHERE id = $1', [T.plain]);
    const res = await apply({ leave_type_id: T.plain, start_date: '2027-03-08', end_date: '2027-03-12', number_of_days: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('approval queues', () => {
  let plainId, l2Id;
  beforeAll(async () => {
    plainId = (await apply({ leave_type_id: T.plain, start_date: '2027-04-05', end_date: '2027-04-05', number_of_days: 1 })).body.id;
    l2Id = (await apply({ leave_type_id: T.l2, start_date: '2027-04-06', end_date: '2027-04-06', number_of_days: 1 })).body.id;
  });
  const ids = async (queue) => (await api('get', `/applications?queue=${queue}`)).body.map(r => r.id);

  it('bulk approve does not skip the manager step', async () => {
    const res = await api('post', '/bulk-approve', { ids: [plainId] });
    expect(res.body.results[0].status).toBe('error');
    const { rows: [l] } = await pool.query('SELECT status FROM leave_applications WHERE id = $1', [plainId]);
    expect(l.status).toBe('pending');
  });

  it('after L1, a plain type goes to HR only; an L2 type to the department head only', async () => {
    for (const id of [plainId, l2Id]) {
      const r = await api('post', `/approve/manager/${id}`, { comments: 'ok' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe('pending');
    }
    const l2 = await ids('l2'); const hr = await ids('hr');
    expect(l2).toContain(l2Id); expect(l2).not.toContain(plainId);
    expect(hr).toContain(plainId); expect(hr).not.toContain(l2Id);
  });

  it('the L2 leave reaches HR after the department head; bulk approve then finalises both', async () => {
    expect((await api('post', `/approve/l2/${l2Id}`, { comments: 'ok' })).status).toBe(200);
    expect(await ids('hr')).toEqual(expect.arrayContaining([plainId, l2Id]));
    const res = await api('post', '/bulk-approve', { ids: [plainId, l2Id] });
    expect(res.body.results.map(r => r.status)).toEqual(['approved', 'approved']);
    const { rows } = await pool.query('SELECT status, hr_status FROM leave_applications WHERE id = ANY($1::int[])', [[plainId, l2Id]]);
    expect(rows.every(r => r.status === 'approved' && r.hr_status === 'approved')).toBe(true);
  });

  it('Allocations count approved leave as used', async () => {
    const res = await api('get', '/allocations?year=2027');
    const row = res.body.find(r => r.employee_id === emp && r.leave_type_id === T.plain);
    expect(Number(row.used_days)).toBe(1);
  });
});

describe('leave types', () => {
  it('a type in use cannot be deleted, but can be switched off and listed for Settings', async () => {
    const del = await api('delete', `/types/${T.plain}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('LEAVE_TYPE_IN_USE');
    const off = await api('put', `/types/${T.plain}`, { leave_name: 'ZZ Plain', default_days: 10, is_active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const applyList = (await api('get', '/types?applicable=1')).body.map(t => t.id);
    expect(applyList).not.toContain(T.plain);
    const settings = (await api('get', '/types?include_inactive=1')).body.find(t => t.id === T.plain);
    expect(settings?.is_active).toBe(false);
  });
});

// ── Owner's rules, 2026-11-23 ───────────────────────────────────────────────
describe('Saturdays off by week of the month', () => {
  it('2nd and 4th Saturday off, the other Saturdays working; Sunday always off', async () => {
    await pool.query(
      `INSERT INTO attendance_general_settings (company_id, working_days, weekend_days, saturday_off_weeks)
       VALUES ($1, '["monday","tuesday","wednesday","thursday","friday","saturday"]', '["sunday"]', '[2,4]')
       ON CONFLICT (company_id) DO UPDATE SET working_days = EXCLUDED.working_days, weekend_days = EXCLUDED.weekend_days,
         saturday_off_weeks = EXCLUDED.saturday_off_weeks`, [A.companyId]);
    const wk = await getWeekendDays(A.companyId);
    // March 2027: Saturdays are the 6th (1st), 13th (2nd), 20th (3rd), 27th (4th)
    expect(dayIsWeekend('2027-03-06', wk)).toBe(false);
    expect(dayIsWeekend('2027-03-13', wk)).toBe(true);
    expect(dayIsWeekend('2027-03-20', wk)).toBe(false);
    expect(dayIsWeekend('2027-03-27', wk)).toBe(true);
    expect(dayIsWeekend('2027-03-07', wk)).toBe(true);
    const s = await api('get', '/settings');
    expect(s.body.saturday_off_weeks).toEqual([2, 4]);
    expect(s.body.weekend_days).toEqual(['sunday']);
  });
});

describe('encashment tax (default 20%, editable) reaches payroll as a flat TDS', () => {
  it('a claim takes the company %, and approval adds a 20% flat-TDS earning outside wages', async () => {
    expect((await api('get', '/settings')).body.encashment_tds_pct).toBe(20);
    await pool.query('UPDATE employees SET basic_salary = 26000 WHERE id = $1', [emp]);
    await pool.query('UPDATE leave_types SET is_encashable = true, is_active = true WHERE id = $1', [T.l2]);
    const post = (p, b) => request(app).post(`/api/leave-encashment${p}`).set('Authorization', `Bearer ${A.token()}`).send(b);
    const c = await post('', { employee_id: emp, leave_type_id: T.l2, year: 2027, days_encashed: 2 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(Number(c.body.gross_amount)).toBe(2000);
    expect(Number(c.body.tds_amount)).toBe(400);
    expect(Number(c.body.net_amount)).toBe(1600);
    const ap = await post(`/approve/${c.body.id}`, { payout_month: 5, payout_year: 2027 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const { rows: [adj] } = await pool.query('SELECT kind, amount, month, year, tds_rate, in_wages FROM payroll_adjustments WHERE id = $1', [ap.body.payroll_adjustment_id]);
    expect(adj).toMatchObject({ kind: 'earning', month: 5, year: 2027, in_wages: false });
    expect(Number(adj.amount)).toBe(2000);
    expect(Number(adj.tds_rate)).toBe(20);
  });

  it('HR can change the %; new claims use it', async () => {
    expect((await api('put', '/settings', { encashment_tds_pct: 30 })).status).toBe(200);
    const c = await request(app).post('/api/leave-encashment').set('Authorization', `Bearer ${A.token()}`)
      .send({ employee_id: emp, leave_type_id: T.l2, year: 2027, days_encashed: 1 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(Number(c.body.tds_amount)).toBe(300);
    expect((await api('put', '/settings', { encashment_tds_pct: 150 })).status).toBe(400);
  });
});

describe('Earned Leave by days worked (1 per N)', () => {
  it('credits days worked ÷ N for a finished month, once', async () => {
    const { rows: [t] } = await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, accrual_type, days_worked_per_leave_day, is_active)
       VALUES ('ZZ Worked EL', 'ZZWEL', 0, $1, 'worked', 20, true) RETURNING id`, [A.companyId]);
    // 22 working days present in Oct 2026, one of them a half day → 21.5 worked
    for (let d = 1; d <= 22; d++) {
      await pool.query(
        `INSERT INTO attendance_records (employee_id, attendance_date, status, company_id)
         VALUES ($1, $2::date, $3, $4) ON CONFLICT (employee_id, attendance_date) DO NOTHING`,
        [noticeEmp, `2026-10-${String(d).padStart(2, '0')}`, d === 22 ? 'half_day' : 'present', A.companyId]);
    }
    await runWorkedAccrual({ companyId: A.companyId, month: 10, year: 2026, runMode: 'manual' });
    await runWorkedAccrual({ companyId: A.companyId, month: 10, year: 2026, runMode: 'manual' });
    const { rows: [b] } = await pool.query(
      'SELECT allocated_days FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = 2026', [noticeEmp, t.id]);
    expect(Number(b.allocated_days)).toBe(1.07);   // 21.5 ÷ 20, rounded down to 2 decimals, credited once
  });
});

describe('L1 by the reporting line (2026-11-24)', () => {
  let report, mgr, mgrUser, leaveId, lineType;
  const asMgr = (method, path, body) => request(app)[method](`/api/leaves${path}`)
    .set('Authorization', `Bearer ${jwt.sign({ userId: mgrUser, role: 'employee', roles: ['employee'], company_id: A.companyId, employee_id: mgr }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
    .send(body || {});
  beforeAll(async () => {
    const mk = async (code, managerId = null) => (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id)
       VALUES ($1, $2, 'Line', $2, 'Active', '2025-01-01', 'Testing', $3) RETURNING id`, [A.companyId, code, managerId])).rows[0].id;
    mgr = await mk('EMP904');
    report = await mk('EMP903', mgr);
    // Its own active type: an earlier suite switches T.plain off.
    lineType = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Line', 'ZZLINE', 10, $1, true) RETURNING id`,
      [A.companyId])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [report, lineType]);
    // The manager's login holds ONLY the employee role — no leaves:approve.
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
      [`${A.code} line mgr`, `${A.code.toLowerCase()}.linemgr@test.invalid`, A.companyId, mgr]);
    mgrUser = u.id;
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [mgrUser, role.id]);
    leaveId = (await apply({ employee_id: report, leave_type_id: lineType, start_date: '2027-05-03', end_date: '2027-05-03', number_of_days: 1 })).body.id;
  });

  it('HR/admin cannot take L1 while the manager can log in', async () => {
    const res = await api('post', `/approve/manager/${leaveId}`, { comments: 'x' });
    expect(res.status).toBe(403);
  });

  it('the manager with only the employee role approves L1', async () => {
    const res = await asMgr('post', `/approve/manager/${leaveId}`, { comments: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body.manager_status).toBe('approved');
  });

  it('when the manager has no active login, HR/admin may take L1', async () => {
    const second = (await apply({ employee_id: report, leave_type_id: lineType, start_date: '2027-05-04', end_date: '2027-05-04', number_of_days: 1 })).body.id;
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [mgrUser]);
    try {
      const res = await api('post', `/approve/manager/${second}`, { comments: 'manager away' });
      expect(res.status).toBe(200);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [mgrUser]);
    }
  });

  // 2026-11-25: the queue was built on the apply-time manager_id, so a
  // delegate (and a manager who took over the team) never saw the leave.
  it('a delegated leave reaches the delegate\'s queue; they can read its history and decide it', async () => {
    const third = (await apply({ employee_id: report, leave_type_id: lineType, start_date: '2027-05-05', end_date: '2027-05-05', number_of_days: 1 })).body.id;
    const delegateEmp = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
       VALUES ($1, 'EMP905', 'Line', 'Delegate', 'Active', '2025-01-01', 'Other') RETURNING id`, [A.companyId])).rows[0].id;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
      [`${A.code} delegate`, `${A.code.toLowerCase()}.delegate@test.invalid`, A.companyId, delegateEmp]);
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
    const t = jwt.sign({ userId: u.id, role: 'employee', roles: ['employee'], company_id: A.companyId, employee_id: delegateEmp }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const asDel = (method, path, body) => request(app)[method](`/api/leaves${path}`).set('Authorization', `Bearer ${t}`).send(body || {});

    const before = await asDel('get', '/applications?manager_status=pending&status=pending');
    expect(before.body.map(l => l.id)).not.toContain(third);

    expect((await asMgr('post', `/delegate/${third}`, { delegate_employee_id: delegateEmp })).status).toBe(200);
    const after = await asDel('get', '/applications?manager_status=pending&status=pending');
    const row = after.body.find(l => l.id === third);
    expect(row, JSON.stringify(after.body)).toBeTruthy();
    expect(row.delegate_name).toBe('Line Delegate');
    expect(row.step_since).toBeTruthy();
    // A manager_id in the query string does not widen what a non-HR caller sees.
    const spoof = await asDel('get', `/applications?manager_status=pending&status=pending&manager_id=${mgr}`);
    expect(spoof.body.every(l => l.id === third || l.delegate_approver_id === delegateEmp)).toBe(true);

    expect((await asDel('get', `/applications/${third}/history`)).status).toBe(200);
    expect((await asDel('post', `/approve/manager/${third}`, { comments: 'decided as delegate' })).status).toBe(200);
  });

  it('a new reporting manager sees the team\'s pending leave filed under the old one', async () => {
    const fourth = (await apply({ employee_id: report, leave_type_id: lineType, start_date: '2027-05-06', end_date: '2027-05-06', number_of_days: 1 })).body.id;
    const newMgr = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
       VALUES ($1, 'EMP906', 'Line', 'NewMgr', 'Active', '2025-01-01', 'Testing') RETURNING id`, [A.companyId])).rows[0].id;
    await pool.query('UPDATE employees SET reporting_manager_id = $1 WHERE id = $2', [newMgr, report]);
    try {
      const t = jwt.sign({ userId: mgrUser, role: 'employee', roles: ['employee'], company_id: A.companyId, employee_id: newMgr }, process.env.JWT_SECRET, { expiresIn: '1h' });
      const res = await request(app).get('/api/leaves/applications?manager_status=pending&status=pending').set('Authorization', `Bearer ${t}`);
      expect(res.body.map(l => l.id)).toContain(fourth);
      // and the old manager no longer does
      expect((await asMgr('get', '/applications?manager_status=pending&status=pending')).body.map(l => l.id)).not.toContain(fourth);
    } finally {
      await pool.query('UPDATE employees SET reporting_manager_id = $1 WHERE id = $2', [mgr, report]);
    }
  });
});

describe('a manager login with no employee record (2026-11-24)', () => {
  it('sees no pending L1 requests and no balances, not the whole company', async () => {
    // At least one pending L1 leave exists in this company from the suites above.
    await apply({ leave_type_id: T.l2, start_date: '2027-06-07', end_date: '2027-06-07', number_of_days: 1 });
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'manager') RETURNING id`,
      [`${A.code} unlinked mgr`, `${A.code.toLowerCase()}.unlinked@test.invalid`, A.companyId]);
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'manager' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
    const t = jwt.sign({ userId: u.id, role: 'manager', roles: ['manager'], company_id: A.companyId, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const get = (path) => request(app).get(`/api/leaves${path}`).set('Authorization', `Bearer ${t}`);
    const queue = await get('/applications?manager_status=pending&status=pending');
    expect(queue.status).toBe(200);
    expect(queue.body).toEqual([]);
    const alloc = await get('/allocations?year=2027');
    expect(alloc.status).toBe(200);
    expect(alloc.body).toEqual([]);
    // and the admin, for contrast, does see the pending request
    expect((await api('get', '/applications?manager_status=pending&status=pending')).body.length).toBeGreaterThan(0);
  });
});

describe('the server counts the days (2026-11-24)', () => {
  let typeId, lopId;
  beforeAll(async () => {
    const mkType = async (name, code, lop) => (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_lop_type, is_active)
       VALUES ($1, $2, 30, $3, $4, true) RETURNING id`, [name, code, A.companyId, lop])).rows[0].id;
    typeId = await mkType('ZZ Count', 'ZZCOUNT', false);
    lopId = await mkType('ZZ Unpaid', 'ZZUNPAID', true);
    for (const t of [typeId, lopId]) {
      await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,30,0)`, [emp, t]);
    }
  });

  it('a Mon→next-Wed range is 8 days + 2 clubbed LOP, whatever number_of_days says', async () => {
    const res = await apply({ leave_type_id: typeId, start_date: '2027-09-06', end_date: '2027-09-15', number_of_days: 0.5, lop_days: 0, is_lop: false });
    expect(res.status).toBe(201);
    expect(Number(res.body.number_of_days)).toBe(8);
    expect(Number(res.body.lop_days)).toBe(2);
    expect(res.body.clubbing_flag).toBe(true);
  });

  it('a single Monday is 1 day and is not clubbing', async () => {
    const res = await apply({ leave_type_id: typeId, start_date: '2027-09-20', end_date: '2027-09-20' });
    expect(res.status).toBe(201);
    expect(Number(res.body.number_of_days)).toBe(1);
    expect(res.body.clubbing_flag).toBe(false);
  });

  it('a half day on a Sunday is refused', async () => {
    const res = await apply({ leave_type_id: typeId, start_date: '2027-09-26', end_date: '2027-09-26', half_day: true, number_of_days: 0.5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_WORKING_DAYS');
  });

  it('a half day on a working day is 0.5', async () => {
    const res = await apply({ leave_type_id: typeId, start_date: '2027-09-27', end_date: '2027-09-29', half_day: true, half_day_session: 'AM' });
    expect(res.status).toBe(201);
    expect(Number(res.body.number_of_days)).toBe(0.5);
    expect(String(res.body.end_date).slice(0, 10)).toBe(String(res.body.start_date).slice(0, 10));
  });

  it('a Loss of Pay type is unpaid for every day; is_lop on a paid type is ignored', async () => {
    const lop = await apply({ leave_type_id: lopId, start_date: '2027-10-04', end_date: '2027-10-05', is_lop: false });
    expect(lop.status).toBe(201);
    expect(lop.body.is_lop).toBe(true);
    expect(Number(lop.body.lop_days)).toBe(2);
    const paid = await apply({ leave_type_id: typeId, start_date: '2027-10-11', end_date: '2027-10-11', is_lop: true });
    expect(paid.status).toBe(201);
    expect(paid.body.is_lop).toBe(false);
  });
});

describe('cancel (2026-11-24)', () => {
  let empUser, typeId;
  const asEmp = (method, path, body) => request(app)[method](`/api/leaves${path}`)
    .set('Authorization', `Bearer ${jwt.sign({ userId: empUser, role: 'employee', roles: ['employee'], company_id: A.companyId, employee_id: emp }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
    .send(body || {});
  beforeAll(async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
      [`${A.code} emp`, `${A.code.toLowerCase()}.emp@test.invalid`, A.companyId, emp]);
    empUser = u.id;
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [empUser, role.id]);
    typeId = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Cancel', 'ZZCANCEL', 30, $1, true) RETURNING id`,
      [A.companyId])).rows[0].id;
    for (const y of [2026, 2027]) await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,$3,30,0)`, [emp, typeId, y]);
  });

  it('the employee cannot cancel a leave that has started; HR can, with a reason', async () => {
    const id = (await apply({ leave_type_id: typeId, start_date: '2026-01-05', end_date: '2026-01-06' })).body.id;
    const mine = await asEmp('put', `/${id}/cancel`);
    expect(mine.status).toBe(409);
    expect(mine.body.code).toBe('LEAVE_ALREADY_STARTED');
    expect((await api('put', `/${id}/cancel`, {})).status).toBe(400);
    expect((await api('put', `/${id}/cancel`, { reason: 'entered by mistake' })).status).toBe(200);
  });

  it('the employee cancels a future leave', async () => {
    const id = (await apply({ leave_type_id: typeId, start_date: '2027-11-08', end_date: '2027-11-08' })).body.id;
    expect((await asEmp('put', `/${id}/cancel`)).status).toBe(200);
  });

  it('an employee withdrawing their own leave is not recorded as the HR decider (2026-11-25)', async () => {
    const id = (await apply({ leave_type_id: typeId, start_date: '2027-11-15', end_date: '2027-11-15' })).body.id;
    expect((await asEmp('post', `/${id}/withdraw`, { reason: 'plans changed' })).status).toBe(200);
    const { rows: [la] } = await pool.query('SELECT status, hr_id, hr_comments, withdrawal_reason FROM leave_applications WHERE id = $1', [id]);
    expect(la.status).toBe('cancelled');
    expect(la.hr_id).toBeNull();
    expect(la.hr_comments).toBeNull();
    expect(la.withdrawal_reason).toBe('plans changed');
  });

  it('the balance tells a Loss of Pay type apart (My Leaves shows it as unpaid days, not "0 of 0 left")', async () => {
    const res = await asEmp('get', `/balance/${emp}?year=2027`);
    expect(res.status).toBe(200);
    expect(res.body.find(b => b.leave_type_id === typeId)?.is_lop_type).toBe(false);
  });

  it('cancelling an approved LOP leave takes the LOP off the draft payroll run', async () => {
    const lopType = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_lop_type, allow_negative_balance, is_active)
       VALUES ('ZZ Cancel LOP', 'ZZCLOP', 0, $1, true, true, true) RETURNING id`, [A.companyId])).rows[0].id;
    const id = (await apply({ leave_type_id: lopType, start_date: '2027-12-06', end_date: '2027-12-07' })).body.id;
    await api('post', `/approve/manager/${id}`, { comments: 'ok' });
    const fin = await api('post', `/approve/hr/${id}`, { comments: 'ok' });
    expect(fin.body.status).toBe('approved');
    const { rows: [run] } = await pool.query(
      `INSERT INTO payroll_runs (employee_id, month, year, status, lop_days, lop_amount)
       VALUES ($1, 12, 2027, 'draft', 2, 0) RETURNING id`, [emp]);
    const res = await api('put', `/${id}/cancel`, {});
    expect(res.status).toBe(200);
    const { rows: [after] } = await pool.query('SELECT lop_days FROM payroll_runs WHERE id = $1', [run.id]);
    expect(Number(after.lop_days)).toBe(0);
    await pool.query('DELETE FROM payroll_runs WHERE id = $1', [run.id]);
  });
});

describe('a leave type picked by id (2026-11-24)', () => {
  it('a switched-off type is refused', async () => {
    const off = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Off', 'ZZOFF', 10, $1, false) RETURNING id`,
      [A.companyId])).rows[0].id;
    const res = await apply({ leave_type_id: off, start_date: '2027-08-02', end_date: '2027-08-02' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEAVE_TYPE_NOT_AVAILABLE');
  });
});

describe('leave attachment (2026-11-24)', () => {
  let applicant, boss, stranger, tokens = {}, typeId, stored;
  const tokenFor = async (empId, label) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
      [`${A.code} ${label}`, `${A.code.toLowerCase()}.${label}@test.invalid`, A.companyId, empId]);
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
    return jwt.sign({ userId: u.id, role: 'employee', roles: ['employee'], company_id: A.companyId, employee_id: empId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  };
  beforeAll(async () => {
    const mk = async (code, mgr = null) => (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id)
       VALUES ($1, $2, 'Doc', $2, 'Active', '2025-01-01', 'Testing', $3) RETURNING id`, [A.companyId, code, mgr])).rows[0].id;
    boss = await mk('EMP911');
    applicant = await mk('EMP912', boss);
    stranger = await mk('EMP913');
    tokens.applicant = await tokenFor(applicant, 'docapp');
    tokens.boss = await tokenFor(boss, 'docboss');
    tokens.stranger = await tokenFor(stranger, 'docstr');
    typeId = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, requires_attachment, is_active)
       VALUES ('ZZ Doc', 'ZZDOC2', 10, $1, true, true) RETURNING id`, [A.companyId])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [applicant, typeId]);
  });
  afterAll(() => { if (stored) rmSync(`${LOCAL_UPLOAD_DIR}/${stored.split('/').pop()}`, { force: true }); });

  it('uploads, applies with it, and only the right people can open it', async () => {
    const up = await request(app).post('/api/leaves/attachment').set('Authorization', `Bearer ${tokens.applicant}`)
      .attach('file', Buffer.from('%PDF-1.4 test certificate'), 'certificate.pdf');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    stored = up.body.attachment_url;
    expect(stored).toMatch(/^\/uploads\//);
    const ap = await request(app).post('/api/leaves/apply').set('Authorization', `Bearer ${tokens.applicant}`)
      .send({ leave_type_id: typeId, start_date: '2027-07-05', end_date: '2027-07-05', reason: 'doc', attachment_url: stored });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    const name = stored.split('/').pop();
    const get = (t) => request(app).get(`/api/files/${name}`).set('Authorization', `Bearer ${t}`);
    expect((await get(tokens.applicant)).status).toBe(200);
    expect((await get(tokens.boss)).status).toBe(200);
    expect((await get(A.token())).status).toBe(200);
    expect((await get(tokens.stranger)).status).toBe(403);
  });

  it('a made-up attachment link is refused', async () => {
    const res = await request(app).post('/api/leaves/apply').set('Authorization', `Bearer ${tokens.applicant}`)
      .send({ leave_type_id: typeId, start_date: '2027-07-12', end_date: '2027-07-12', reason: 'doc', attachment_url: 'see whatsapp' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ATTACHMENT_INVALID');
  });
});

describe('escalation (2026-11-24)', () => {
  let worker, boss, bossUser, hrUser, typeId, leaveId;
  const mkUser = async (label, role, empId = null) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, $4, $5) RETURNING id`,
      [`${A.code} ${label}`, `${A.code.toLowerCase()}.${label}@test.invalid`, A.companyId, role, empId]);
    const { rows: [r] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [role]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, r.id]);
    return u.id;
  };
  beforeAll(async () => {
    const mk = async (code, mgr = null) => (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id)
       VALUES ($1, $2, 'Esc', $2, 'Active', '2025-01-01', 'Testing', $3) RETURNING id`, [A.companyId, code, mgr])).rows[0].id;
    boss = await mk('EMP921');
    worker = await mk('EMP922', boss);
    bossUser = await mkUser('escboss', 'employee', boss);
    hrUser = await mkUser('eschr', 'hr');
    typeId = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Esc', 'ZZESC', 10, $1, true) RETURNING id`,
      [A.companyId])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [worker, typeId]);
    leaveId = (await apply({ employee_id: worker, leave_type_id: typeId, start_date: '2027-08-09', end_date: '2027-08-09' })).body.id;
  });
  afterAll(async () => { await pool.query(`DELETE FROM company_settings WHERE company_id = $1 AND module = 'leaves'`, [A.companyId]); });

  it('not yet: HR cannot take the manager step, and nothing is escalated', async () => {
    expect((await api('post', `/approve/manager/${leaveId}`, { comments: 'x' })).status).toBe(403);
    const row = (await api('get', '/applications?manager_status=pending&status=pending')).body.find(r => r.id === leaveId);
    expect(row.hr_may_decide_l1).toBe(false);   // false, not null — the screen disables HR's buttons on it
    const { escalated } = await runLeaveEscalation({ companyId: A.companyId });
    expect(escalated.find(e => e.id === leaveId)).toBeUndefined();
  });

  it('after 3 days it is escalated once, HR is told, and HR may then decide', async () => {
    await pool.query(`UPDATE leave_applications SET applied_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [leaveId]);
    const first = await runLeaveEscalation({ companyId: A.companyId });
    expect(first.escalated.find(e => e.id === leaveId)?.step).toBe('l1');
    const again = await runLeaveEscalation({ companyId: A.companyId });
    expect(again.escalated.find(e => e.id === leaveId)).toBeUndefined();
    await new Promise(r => setTimeout(r, 300));   // notifications are written on the next tick
    const { rows: notes } = await pool.query(
      `SELECT user_id FROM notifications WHERE reference_id::text = $1::text AND module_name = 'Leave'`, [leaveId]);
    const told = notes.map(n => Number(n.user_id));
    expect(told).toContain(hrUser);
    expect(told).toContain(bossUser);
    const list = (await api('get', '/applications?manager_status=pending&status=pending')).body.find(r => r.id === leaveId);
    expect(list.hr_may_decide_l1).toBe(true);
    expect((await api('post', `/approve/manager/${leaveId}`, { comments: 'manager away' })).status).toBe(200);
  });

  it('0 days switches escalation off', async () => {
    await api('put', '/settings', { escalation_days: 0 });
    const id = (await apply({ employee_id: worker, leave_type_id: typeId, start_date: '2027-08-16', end_date: '2027-08-16' })).body.id;
    await pool.query(`UPDATE leave_applications SET applied_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [id]);
    const { escalated } = await runLeaveEscalation({ companyId: A.companyId });
    expect(escalated.find(e => e.id === id)).toBeUndefined();
    expect((await api('put', '/settings', { escalation_days: 31 })).status).toBe(400);
  });
});

// 2026-11-24 audit: advance notice counted on dates (it read UTC midnight
// against local midnight → one day too generous) and exempt by the TYPE's
// name, not the free-text leave_type the request carries; a zone's holiday
// is off only for that zone.
describe('advance notice and zone holidays (2026-11-24)', () => {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let start, diff, zoneId = null, zoneEmp = null;
  beforeAll(async () => {
    // First weekday ≥ 5 days ahead that is no holiday of this company / global.
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + 5);
    for (;;) {
      const s = ymd(d);
      const { rows } = await pool.query(`SELECT 1 FROM holidays WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL)`, [s, A.companyId]);
      if (d.getDay() !== 0 && d.getDay() !== 6 && !rows.length) break;
      d.setDate(d.getDate() + 1);
    }
    start = ymd(d);
    const t = new Date(); t.setHours(12, 0, 0, 0);
    diff = Math.round((d - t) / 86400000);
    zoneId = (await pool.query('SELECT id FROM master_zones ORDER BY id LIMIT 1')).rows[0]?.id ?? null;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM holidays WHERE company_id = $1`, [A.companyId]);
    if (zoneEmp) await pool.query('UPDATE employees SET zone_id = NULL WHERE id = $1', [zoneEmp]);
  });
  const typeWithNotice = async (code, days, year = Number(start.slice(0, 4))) => {
    const id = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, min_notice_days, is_active)
       VALUES ($1, $1, 30, $2, $3, true) RETURNING id`, [code, A.companyId, days])).rows[0].id;
    for (const e of [emp, noticeEmp]) {
      await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,$3,30,0)`, [e, id, year]);
    }
    return id;
  };

  it('exactly the notice given is accepted; one day short is refused', async () => {
    const ok = await apply({ leave_type_id: await typeWithNotice('ZZNTCOK', diff), start_date: start, end_date: start });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await pool.query('DELETE FROM leave_applications WHERE id = $1', [ok.body.id]);
    const short = await apply({ leave_type_id: await typeWithNotice('ZZNTCSHORT', diff + 1), start_date: start, end_date: start });
    expect(short.status, JSON.stringify(short.body)).toBe(422);
    expect(short.body.code).toBe('INSUFFICIENT_NOTICE');
  });

  it('calling it "Sick Leave" in the request does not skip another type\'s notice', async () => {
    const r = await apply({ leave_type_id: await typeWithNotice('ZZNTCNAME', 60), leave_type: 'Sick Leave', start_date: start, end_date: start });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_NOTICE');
  });

  it('a zone holiday is off for that zone only', async () => {
    if (zoneId == null) return;   // no master zone in this database
    await pool.query(`INSERT INTO holidays (name, date, company_id, zone_id, type) VALUES ('ZZ zone day', '2027-11-16', $1, $2, 'Regional')`, [A.companyId, zoneId]);
    const zt = await typeWithNotice('ZZZONE', 0, 2027);
    const other = await apply({ leave_type_id: zt, start_date: '2027-11-16', end_date: '2027-11-16' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(Number(other.body.number_of_days)).toBe(1);
    await pool.query('DELETE FROM leave_applications WHERE id = $1', [other.body.id]);
    zoneEmp = noticeEmp;
    await pool.query('UPDATE employees SET zone_id = $1 WHERE id = $2', [zoneId, zoneEmp]);
    const inZone = await api('post', '/apply', { employee_id: zoneEmp, reason: 'zone', leave_type_id: zt, start_date: '2027-11-16', end_date: '2027-11-16' });
    expect(inZone.status, JSON.stringify(inZone.body)).toBe(400);
    expect(inZone.body.code).toBe('NO_WORKING_DAYS');
  });
});

// Owner decisions 2026-11-24: no back-dated leave from employees (HR enters
// it); Apply Leave lists no type the person cannot take for their gender.
describe('back-dated leave and gender-restricted types (2026-11-24)', () => {
  let empUserId, typeF;
  const selfToken = () => jwt.sign({ userId: empUserId, role: 'employee', company_id: A.companyId, employee_id: emp }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const asSelf = (method, path, body) => request(app)[method](`/api/leaves${path}`)
    .set('Authorization', `Bearer ${selfToken()}`).send(body || {});
  beforeAll(async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4) RETURNING id`,
      [`${A.code} bd`, `${A.code.toLowerCase()}.bd@test.invalid`, A.companyId, emp]);
    empUserId = u.id;
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'employee' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [empUserId, role.id]);
    await pool.query(`UPDATE employees SET gender = 'Male' WHERE id = $1`, [emp]);
    typeF = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, gender_restriction, is_active)
       VALUES ('ZZ Maternity', 'ZZMAT', 180, $1, 'F', true) RETURNING id`, [A.companyId])).rows[0].id;
  });
  afterAll(async () => { await pool.query(`UPDATE employees SET gender = NULL WHERE id = ANY($1::int[])`, [[emp, noticeEmp]]); });

  it('an employee cannot apply for a past date', async () => {
    const mine = await asSelf('post', '/apply', { employee_id: emp, leave_type_id: T.plain, start_date: '2026-01-05', end_date: '2026-01-05', reason: 'past' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(422);
    expect(mine.body.code).toBe('BACKDATED_NOT_ALLOWED');
  });

  it('a female-only type is hidden from a male employee and shown to HR for a woman; the id cannot be spoofed', async () => {
    const mine = await asSelf('get', `/types?applicable=1&for_employee=${emp}`);
    expect(mine.status).toBe(200);
    expect(mine.body.map(t => t.id)).not.toContain(typeF);
    await pool.query(`UPDATE employees SET gender = 'Female' WHERE id = $1`, [noticeEmp]);
    const forHer = await api('get', `/types?applicable=1&for_employee=${noticeEmp}`);
    expect(forHer.body.map(t => t.id)).toContain(typeF);
    const spoof = await asSelf('get', `/types?applicable=1&for_employee=${noticeEmp}`);
    expect(spoof.body.map(t => t.id)).not.toContain(typeF);
  });
});

describe('Leave Settings (2026-11-25 audit)', () => {
  it('Add saves Paid / Loss of Pay / Active / expiry; "No restriction" clears gender', async () => {
    const add = await api('post', '/types', { leave_name: 'ZZ Unpaid New', default_days: 0, is_paid: false, is_lop_type: true, is_active: false, carry_forward_allowed: true, carry_forward_expiry_months: 3, gender_restriction: 'F' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const { rows: [t] } = await pool.query('SELECT * FROM leave_types WHERE id = $1', [add.body.id]);
    expect([t.is_paid, t.is_lop_type, t.is_active, t.carry_forward_expiry_months, t.gender_restriction]).toEqual([false, true, false, 3, 'F']);
    const put = await api('put', `/types/${t.id}`, { leave_name: t.leave_name, default_days: 0, is_paid: false, is_lop_type: true, gender_restriction: null });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await pool.query('SELECT gender_restriction FROM leave_types WHERE id = $1', [t.id])).rows[0].gender_restriction).toBeNull();
  });

  it('refuses negative numbers, Paid + Loss of Pay, and a rename onto another type (409, not 500)', async () => {
    expect((await api('post', '/types', { leave_name: 'ZZ Neg', default_days: -2 })).status).toBe(400);
    expect((await api('put', `/types/${T.plain}`, { leave_name: 'ZZ Plain', default_days: 10, is_paid: true, is_lop_type: true })).status).toBe(400);
    expect((await api('put', `/types/${T.plain}`, { leave_name: 'ZZ Needs L2', default_days: 10 })).status).toBe(409);
  });

  it('allocate: own current employee + active type only, days 0–366, audited', async () => {
    expect((await api('post', '/allocate', { employee_id: emp, leave_type_id: T.plain, allocated_days: -1, year: 2027 })).status).toBe(400);
    expect((await api('post', '/allocate', { employee_id: 2147483000, leave_type_id: T.plain, allocated_days: 1, year: 2027 })).status).toBe(404);
    const off = (await pool.query(`INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Alloc Off', 'ZZAOFF', 1, $1, false) RETURNING id`, [A.companyId])).rows[0].id;
    expect((await api('post', '/allocate', { employee_id: emp, leave_type_id: off, allocated_days: 1, year: 2027 })).status).toBe(404);
    const on = (await pool.query(`INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Alloc On', 'ZZAON', 5, $1, true) RETURNING id`, [A.companyId])).rows[0].id;
    const ok = await api('post', '/allocate', { employee_id: emp, leave_type_id: on, allocated_days: 9, year: 2027 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Number(ok.body.allocated_days)).toBe(9);
  });

  it('bulk allocate counts only balances it created', async () => {
    const first = await api('post', '/bulk-allocate', { year: 2028 });
    expect(first.status).toBe(200);
    expect(first.body.records).toBeGreaterThan(0);
    const again = await api('post', '/bulk-allocate', { year: 2028 });
    expect(again.body.records).toBe(0);
    expect(again.body.existing).toBe(first.body.records + first.body.existing);
  });
});

describe('Leave Settings: delete allocation + change history (2026-11-25)', () => {
  it('deletes an untouched allocation; refuses one with leave or an accrual credit', async () => {
    const t = (await pool.query(`INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Del Alloc', 'ZZDELA', 4, $1, true) RETURNING id`, [A.companyId])).rows[0].id;
    const free = (await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days) VALUES ($1,$2,2029,4) RETURNING id`, [emp, t])).rows[0].id;
    const del = await api('delete', `/allocations/${free}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await pool.query('SELECT 1 FROM leave_balances WHERE id = $1', [free])).rowCount).toBe(0);

    const used = (await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days) VALUES ($1,$2,2029,4) RETURNING id`, [emp, t])).rows[0].id;
    await pool.query(`INSERT INTO leave_accrual_log (employee_id, leave_type_id, year, month, days_accrued, accrual_type, run_mode, company_id) VALUES ($1,$2,2029,1,1,'monthly','manual',$3)`, [emp, t, A.companyId]);
    const refused = await api('delete', `/allocations/${used}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ALLOCATION_IN_USE');
    expect((await api('delete', '/allocations/2147483000')).status).toBe(404);
  });

  it('history lists the company\'s leave configuration changes, filterable by kind', async () => {
    await new Promise(r => setTimeout(r, 300));   // logAudit writes after the response
    const all = await api('get', '/settings/history');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.some(r => r.record_type === 'leave_balance' && r.action === 'delete')).toBe(true);
    const types = await api('get', '/settings/history?kind=types');
    expect(types.body.length).toBeGreaterThan(0);
    expect(types.body.every(r => r.record_type === 'leave_type')).toBe(true);
  });
});

describe('own leave for everyone (2026-11-25)', () => {
  // A store keeper: linked to an employee, but the role holds no leaves grant.
  let staff, staffUser, unlinkedUser, own;  // own: an active type (an earlier suite switches own off)
  const as = (userId, employeeId, method, path, body) => request(app)[method](`/api/leaves${path}`)
    .set('Authorization', `Bearer ${jwt.sign({ userId, role: 'store_keeper', roles: ['store_keeper'], company_id: A.companyId, employee_id: employeeId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
    .send(body || {});
  beforeAll(async () => {
    staff = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
       VALUES ($1, 'EMP959', 'Store', 'Keeper', 'Active', '2025-01-01', 'Stores') RETURNING id`, [A.companyId])).rows[0].id;
    own = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active) VALUES ('ZZ Own', 'ZZOWN', 10, $1, true) RETURNING id`,
      [A.companyId])).rows[0].id;
    for (const e of [staff, emp]) await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [e, own]);
    const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'store_keeper' LIMIT 1`);
    const mkUser = async (tag, employeeId) => {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
         VALUES ($1, $2, 'not-a-real-hash', $3, true, 'store_keeper', $4) RETURNING id`,
        [`${A.code} ${tag}`, `${A.code.toLowerCase()}.${tag}@test.invalid`, A.companyId, employeeId]);
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
      return u.id;
    };
    staffUser = await mkUser('stores', staff);
    unlinkedUser = await mkUser('stores2', null);
  });

  it('a linked store keeper sees their balance, applies, reads history and cancels — their own only', async () => {
    const bal = await as(staffUser, staff, 'get', `/balance/${staff}?year=2027`);
    expect(bal.status, JSON.stringify(bal.body)).toBe(200);
    expect(bal.body.some(b => b.leave_type_id === own)).toBe(true);
    expect((await as(staffUser, staff, 'get', '/types?applicable=1')).status).toBe(200);
    expect((await as(staffUser, staff, 'get', '/probation-status')).status).toBe(200);
    // employee_id of someone else is ignored: the leave is filed for the caller.
    const applied = await as(staffUser, staff, 'post', '/apply', { employee_id: emp, leave_type_id: own, start_date: '2027-10-04', end_date: '2027-10-04', reason: 'own' });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.employee_id).toBe(staff);
    expect((await as(staffUser, staff, 'get', `/applications/${applied.body.id}/history`)).status).toBe(200);
    expect((await as(staffUser, staff, 'put', `/${applied.body.id}/cancel`)).status).toBe(200);
  });

  it('… but nothing beyond their own', async () => {
    const ob = await as(staffUser, staff, 'get', `/balance/${emp}`); expect(ob.status, JSON.stringify(ob.body)).toBe(403);
    expect((await as(staffUser, staff, 'get', '/applications')).status).toBe(403);
    const ap = await apply({ leave_type_id: own, start_date: '2027-10-19', end_date: '2027-10-19' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    const other = ap.body.id;
    expect((await as(staffUser, staff, 'put', `/${other}/cancel`)).status).toBe(403);
    expect((await as(staffUser, staff, 'get', `/applications/${other}/history`)).status).toBe(404);
  });

  it('an unlinked login without the grant is still refused', async () => {
    expect((await as(unlinkedUser, null, 'get', '/types?applicable=1')).status).toBe(403);
    expect((await as(unlinkedUser, null, 'post', '/apply', { leave_type_id: own, start_date: '2027-10-06', end_date: '2027-10-06', reason: 'x' })).status).toBe(403);
  });
});

describe('a leave over New Year (2026-11-25)', () => {
  it('is refused — one request per year, each year has its own balance', async () => {
    const res = await apply({ leave_type_id: T.l2, start_date: '2027-12-30', end_date: '2028-01-03' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('LEAVE_CROSSES_YEAR');
  });
});

describe('cancelling an approved Comp Off leave (2026-11-25)', () => {
  it('hands its credit back, so it can still expire', async () => {
    const co = (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_comp_off_type, is_active)
       VALUES ('ZZ Comp Off', 'ZZCO', 0, $1, true, true) RETURNING id`, [A.companyId])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,1,0)`, [emp, co]);
    const { rows: [credit] } = await pool.query(
      `INSERT INTO compensatory_off (employee_id, work_date, hours_worked, status, credited, expires_on, company_id)
       VALUES ($1, '2027-09-05', 8, 'approved', true, '2099-12-31', $2) RETURNING id`, [emp, A.companyId]);
    const id = (await apply({ leave_type_id: co, start_date: '2027-11-22', end_date: '2027-11-22' })).body.id;
    await api('post', `/approve/manager/${id}`, { comments: 'ok' });
    expect((await api('post', `/approve/hr/${id}`, { comments: 'ok' })).body.status).toBe('approved');
    const st = async () => (await pool.query('SELECT status FROM compensatory_off WHERE id = $1', [credit.id])).rows[0].status;
    expect(await st()).toBe('used');
    expect((await api('put', `/${id}/cancel`, {})).status).toBe(200);
    expect(await st()).toBe('approved');
  });
});

describe('Apply Leave page audit (2026-11-25)', () => {
  // Own types: earlier suites switch T.plain off and change T.l2.
  let full, noHalf;
  beforeAll(async () => {
    const mk = async (name, code, half) => (await pool.query(
      `INSERT INTO leave_types (leave_name, leave_code, annual_quota, company_id, is_active, allow_half_day)
       VALUES ($1, $2, 10, $3, true, $4) RETURNING id`, [name, code, A.companyId, half])).rows[0].id;
    full = await mk('ZZ Apply Audit', 'ZZAPA', true);
    noHalf = await mk('ZZ No Half', 'ZZNOH', false);
    for (const t of [full, noHalf]) await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [emp, t]);
  });
  it('a morning half and an afternoon half on the same day do not clash; a second morning does', async () => {
    const am = await apply({ leave_type_id: full, start_date: '2027-06-14', end_date: '2027-06-14', half_day: true, half_day_session: 'AM' });
    expect(am.status, JSON.stringify(am.body)).toBe(201);
    const pm = await apply({ leave_type_id: full, start_date: '2027-06-14', end_date: '2027-06-14', half_day: true, half_day_session: 'pm' });
    expect(pm.status, JSON.stringify(pm.body)).toBe(201);
    expect(pm.body.half_day_session).toBe('PM');
    const am2 = await apply({ leave_type_id: full, start_date: '2027-06-14', end_date: '2027-06-14', half_day: true, half_day_session: 'AM' });
    expect(am2.status).toBe(409);
    // A full day on top of a half day still clashes.
    const fullDay = await apply({ leave_type_id: full, start_date: '2027-06-14', end_date: '2027-06-14' });
    expect(fullDay.status).toBe(409);
  });

  it('a half day on a type that does not allow one is refused', async () => {
    const res = await apply({ leave_type_id: noHalf, start_date: '2027-06-15', end_date: '2027-06-15', half_day: true, half_day_session: 'AM' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe('HALF_DAY_NOT_ALLOWED');
  });

  it('probation-status says who approves: the manager with a login, else nobody (HR steps in); a left manager is not used', async () => {
    const mgr = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department)
       VALUES ($1, 'EMP971', 'Mana', 'Ger', 'Active', '2024-01-01', 'Testing') RETURNING id`, [A.companyId])).rows[0].id;
    const rep = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, reporting_manager_id, probation_end_date)
       VALUES ($1, 'EMP972', 'New', 'Joiner', 'Active', '2026-11-01', 'Testing', $2, '2027-02-28') RETURNING id`, [A.companyId, mgr])).rows[0].id;
    const st = async () => (await api('get', `/probation-status?employee_id=${rep}`)).body;
    // Manager has no login yet → HR decides.
    let s = await st();
    expect(s.approver).toBeNull();
    // Probation by stored end date only, not by status.
    expect(s.status_probation).toBe(false);
    expect(s.probation_end).toBe('2027-02-28');
    await pool.query(
      `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
       VALUES ($1, $2, 'not-a-real-hash', $3, true, 'employee', $4)`,
      [`${A.code} mgr`, `${A.code.toLowerCase()}.mgr@test.invalid`, A.companyId, mgr]);
    s = await st();
    expect(s.approver?.id).toBe(mgr);
    expect(s.approver?.office_id).toBe('EMP971');
    // A manager who has left (any exited spelling) is not the approver.
    await pool.query(`UPDATE employees SET status = 'terminated' WHERE id = $1`, [mgr]);
    s = await st();
    expect(s.approver).toBeNull();
  });

  it('paid leave starting after the probation end date is accepted; on or before it is refused', async () => {
    const pe = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, probation_end_date)
       VALUES ($1, 'EMP973', 'Prob', 'Ation', 'Active', '2026-10-01', 'Testing', '2027-06-30') RETURNING id`, [A.companyId])).rows[0].id;
    await pool.query(`INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days) VALUES ($1,$2,2027,10,0)`, [pe, full]);
    const inside = await api('post', '/apply', { employee_id: pe, leave_type_id: full, start_date: '2027-06-30', end_date: '2027-06-30', reason: 'x' });
    expect(inside.status, JSON.stringify(inside.body)).toBe(422);
    expect(inside.body.code).toBe('PROBATION_RESTRICTED');
    const after = await api('post', '/apply', { employee_id: pe, leave_type_id: full, start_date: '2027-07-01', end_date: '2027-07-01', reason: 'x' });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
  });
});
