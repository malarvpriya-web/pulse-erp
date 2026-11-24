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
