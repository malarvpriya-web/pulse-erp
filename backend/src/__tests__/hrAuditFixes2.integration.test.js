/**
 * HR audit fixes, second round (2026-11-16, HR_MODULE_PAGE_AUDIT_2026-11-16.md §3a/§3b),
 * real routers against the test database with real tokens:
 *   B4  Exit Management access comes from the exit / fnf matrix modules, every role held.
 *   B6  A new policy version asks again; the reminder notifies, company-scoped.
 *   B7  A new exit archives the previous exit's clearance.
 *       Biometric user ID and default shift are settable and validated.
 *       Intern stipends: due amounts, raise, pay (never by the raiser), bank check.
 *       F&F review: read-only, the computer cannot approve, Approval Center sources run.
 *       HR Documents: employees read the 'all' audience only.
 *       Offboarding Notify reaches a department head, or says why not.
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
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: jwt } = await import('jsonwebtoken');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { requireCompanyScope } = await import('../shared/scope.js');
const { default: hrRouter } = await import('../modules/hr/hr.routes.js');
const { default: exitRouter } = await import('../modules/hr/exit.routes.js');
const { default: stipendRouter, stipendDue } = await import('../modules/hr/internStipends.routes.js');
const { freshClearance } = await import('../modules/hr/exitCase.js');
const { updateEmployee } = await import('../employees/employee.service.js');
const { SOURCES } = await import('../modules/approvals/approvals.sources.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies } = await import('./helpers/isolatedCompany.js');

const PREFIX = 'ZZHRAU2';
const app = express();
app.use(express.json());
app.use('/api/hr', verifyToken, requireCompanyScope, hrRouter);
app.use('/api/exit', verifyToken, exitRouter);
app.use('/api/intern-stipends', verifyToken, requireCompanyScope, stipendRouter);

const fx = { co: null, other: null, users: {} };
let seq = 0;

async function login(company, role, employeeId = null) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role, employee_id)
     VALUES ($1, $2, 'x', $3, true, $4, $5) RETURNING id`,
    [`zz ${role} ${seq}`, `${company.code.toLowerCase()}.${role}.${seq}@test.invalid`, company.companyId, role, employeeId]);
  const { rows: [r] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1`, [role]);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, r.id]);
  const token = jwt.sign({ userId: u.id, role, roles: [role], company_id: company.companyId, employee_id: employeeId },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  return { id: u.id, auth: { Authorization: `Bearer ${token}` } };
}
async function employee(company, extra = {}) {
  seq += 1;
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date, department, reporting_manager_id)
     VALUES ($1, $2, 'Zz', $3, $4, $5, '2024-01-01', $6, $7) RETURNING id`,
    [company.companyId, `EMP2116${String(seq).padStart(3, '0')}`, `Au${seq}`, `zz.au2.${company.code.toLowerCase()}.${seq}@example.com`,
      extra.status || 'Active', extra.department || null, extra.manager || null]);
  return e.id;
}
async function cleanupCompany(id) {
  const q = (sql) => pool.query(sql, [id]).catch(e => { throw new Error(`${sql}: ${e.message}`); });
  const emps = `SELECT id FROM employees WHERE company_id = $1`;
  await q(`DELETE FROM audit_logs WHERE company_id = $1`);
  await q(`DELETE FROM intern_stipend_payments WHERE company_id = $1`);
  await q(`DELETE FROM interns WHERE company_id = $1`);
  await q(`DELETE FROM hr_policy_acknowledgements WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM hr_policies WHERE company_id = $1`);
  await q(`DELETE FROM hr_downloads WHERE company_id = $1`);
  await q(`DELETE FROM fnf_settlement_events WHERE company_id = $1`);
  await q(`DELETE FROM fnf_settlements WHERE company_id = $1`);
  await q(`DELETE FROM exit_clearance_history WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM hr_offboarding_checklist_progress WHERE employee_id IN (${emps})`);
  await q(`DELETE FROM hr_offboarding_checklist_templates WHERE company_id = $1`);
  await q(`DELETE FROM department_heads WHERE company_id = $1`);
  await q(`DELETE FROM bank_accounts WHERE company_id = $1`);
  await q(`DELETE FROM hr_shifts WHERE company_id = $1`);
  await q(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`);
  await pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]);
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [id]);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await dropIsolatedCompany(pool, id);
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) await cleanupCompany(id);
  fx.co = await createIsolatedCompany(pool, `${PREFIX}A`);
  fx.other = await createIsolatedCompany(pool, `${PREFIX}B`);
});
afterAll(async () => {
  await new Promise(r => setTimeout(r, 500));
  for (const co of [fx.co, fx.other]) if (co) await cleanupCompany(co.companyId);
});

describe('B4: exit access from the permission matrix', () => {
  it('hr_exec reads but cannot write; manager is refused; Finance reaches only the F&F steps', async () => {
    const hrExec = await login(fx.co, 'hr_exec');
    const manager = await login(fx.co, 'manager');
    const finance = await login(fx.co, 'finance_manager');
    expect((await request(app).get('/api/exit/active').set(hrExec.auth)).status).toBe(200);
    expect((await request(app).post('/api/exit/initiate').set(hrExec.auth).send({})).status).toBe(403);
    expect((await request(app).get('/api/exit/active').set(manager.auth)).status).toBe(403);
    expect((await request(app).get('/api/exit/active').set(finance.auth)).status).toBe(403);
    expect((await request(app).get('/api/exit/fnf/rules').set(finance.auth)).status).toBe(200);
  });

  it('a grant made in the matrix takes effect (user override on the exit module)', async () => {
    const manager = await login(fx.co, 'manager');
    await pool.query(
      `INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       VALUES ($1, 'exit', true, false, false, false, false, false)`, [manager.id]);
    try {
      expect((await request(app).get('/api/exit/active').set(manager.auth)).status).toBe(200);
    } finally {
      await pool.query(`DELETE FROM permissions WHERE user_id = $1`, [manager.id]);
    }
  });
});

describe('B6: policy versions', () => {
  it('an acknowledgement counts for its version only; the reminder notifies who has not', async () => {
    const hr = await login(fx.co, 'hr');
    const emp = await employee(fx.co);
    const staff = await login(fx.co, 'employee', emp);
    const created = await request(app).post('/api/hr/policies').set(hr.auth)
      .send({ title: 'ZZ Leave Policy', category: 'Leave', description: 'x', version: 'v1', requires_acknowledgement: true, applicable_to: 'all', file_url: 'https://drive.google.com/file/d/1ZzAuditPolicyFile0000000000000/view' });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const pid = created.body.id ?? created.body.data?.id;

    expect((await request(app).post(`/api/hr/policies/${pid}/acknowledge`).set(staff.auth)).status).toBe(200);
    expect((await request(app).get('/api/hr/policies/my-acknowledgements').set(staff.auth)).body).toEqual([pid]);

    expect((await request(app).put(`/api/hr/policies/${pid}`).set(hr.auth).send({ version: 'v2' })).status).toBeLessThan(300);
    expect((await request(app).get('/api/hr/policies/my-acknowledgements').set(staff.auth)).body).toEqual([]);

    const remind = await request(app).post(`/api/hr/policies/${pid}/send-reminder`).set(hr.auth);
    expect(remind.body.pending_count).toBe(1);
    await new Promise(r => setTimeout(r, 300));
    const { rows: notes } = await pool.query(`SELECT title FROM notifications WHERE user_id = $1`, [staff.id]);
    expect(notes.map(n => n.title)).toContain('Please acknowledge: ZZ Leave Policy');

    expect((await request(app).post(`/api/hr/policies/${pid}/acknowledge`).set(staff.auth)).status).toBe(200);
    expect((await request(app).get('/api/hr/policies/my-acknowledgements').set(staff.auth)).body).toEqual([pid]);
    const { rows } = await pool.query(`SELECT policy_version FROM hr_policy_acknowledgements WHERE policy_id = $1 ORDER BY id`, [pid]);
    expect(rows.map(r => r.policy_version)).toEqual(['v1', 'v2']);
  });
});

describe('B7: clearance history', () => {
  it('a new exit keeps the previous exit\'s clearance in history, linked to that exit', async () => {
    const emp = await employee(fx.co);
    const { rows: [old] } = await pool.query(
      `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status) VALUES ($1, 'resignation', '2025-01-31', 'closed') RETURNING id`, [emp]);
    await pool.query(`INSERT INTO exit_clearance (employee_id, noc_hr, noc_finance) VALUES ($1, true, true)`, [emp]);
    const client = await pool.connect();
    try { await freshClearance(client, emp); } finally { client.release(); }
    const { rows: [now] } = await pool.query(`SELECT noc_hr FROM exit_clearance WHERE employee_id = $1`, [emp]);
    expect(now.noc_hr).toBe(false);
    const hr = await login(fx.co, 'hr');
    const hist = await request(app).get(`/api/exit/clearance/${emp}/history`).set(hr.auth);
    expect(hist.status).toBe(200);
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0].exit_request_id).toBe(old.id);
    expect(hist.body[0].clearance.noc_finance).toBe(true);
    // Another company's HR cannot read it.
    const otherHr = await login(fx.other, 'hr');
    expect((await request(app).get(`/api/exit/clearance/${emp}/history`).set(otherHr.auth)).status).toBe(404);
    expect((await request(app).get(`/api/exit/clearance/${emp}`).set(otherHr.auth)).status).toBe(404);
  });
});

describe('Biometric user ID and default shift', () => {
  it('are saved, cleared, and refused when duplicated or foreign', async () => {
    const a = await employee(fx.co);
    const b = await employee(fx.co);
    const { rows: [shift] } = await pool.query(
      `INSERT INTO hr_shifts (name, start_time, end_time, company_id) VALUES ('ZZ General', '09:30', '18:30', $1) RETURNING id`, [fx.co.companyId]);
    const { rows: [foreign] } = await pool.query(
      `INSERT INTO hr_shifts (name, start_time, end_time, company_id) VALUES ('ZZ Other', '09:30', '18:30', $1) RETURNING id`, [fx.other.companyId]);
    await updateEmployee(a, { biometric_user_id: '17', default_shift_id: String(shift.id) }, fx.co.companyId);
    const { rows: [row] } = await pool.query(`SELECT biometric_user_id, default_shift_id FROM employees WHERE id = $1`, [a]);
    expect(row).toEqual({ biometric_user_id: '17', default_shift_id: shift.id });
    await expect(updateEmployee(b, { biometric_user_id: '17' }, fx.co.companyId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateEmployee(b, { default_shift_id: String(foreign.id) }, fx.co.companyId)).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateEmployee(b, { biometric_user_id: '1 7' }, fx.co.companyId)).rejects.toMatchObject({ statusCode: 400 });
    await updateEmployee(a, { biometric_user_id: '', default_shift_id: '' }, fx.co.companyId);
    const { rows: [cleared] } = await pool.query(`SELECT biometric_user_id, default_shift_id FROM employees WHERE id = $1`, [a]);
    expect(cleared).toEqual({ biometric_user_id: null, default_shift_id: null });
  });
});

describe('Intern stipends', () => {
  it('works out the month\'s due by frequency, pro-rated', () => {
    const base = { stipend: 15000, start_date: '2026-10-12', end_date: '2026-12-15', status: 'Active' };
    expect(stipendDue({ ...base, stipend_frequency: 'Monthly' }, '2026-11')).toEqual({ amount: 15000, basis: '₹15000/month, full month' });
    expect(stipendDue({ ...base, stipend_frequency: 'Monthly' }, '2026-10').amount).toBe(Math.round(15000 * 20 / 31));
    expect(stipendDue({ ...base, stipend_frequency: 'Monthly' }, '2026-12').amount).toBe(Math.round(15000 * 15 / 31));
    expect(stipendDue({ ...base, stipend_frequency: 'Monthly' }, '2027-01')).toBeNull();
    expect(stipendDue({ ...base, stipend_frequency: 'Weekly', stipend: 3500 }, '2026-11').amount).toBe(15000);
    expect(stipendDue({ ...base, stipend_frequency: 'One-time' }, '2026-10').amount).toBe(15000);
    expect(stipendDue({ ...base, stipend_frequency: 'One-time' }, '2026-11')).toBeNull();
    expect(stipendDue({ ...base, stipend_frequency: 'Unpaid', stipend: 0 }, '2026-11')).toBeNull();
    expect(stipendDue({ ...base, stipend_frequency: 'Monthly', status: 'Completed', completed_on: '2026-11-10' }, '2026-11').amount)
      .toBe(Math.round(15000 * 10 / 30));
  });

  it('HR raises, Finance pays (never the raiser, never into a bad account)', async () => {
    const hr = await login(fx.co, 'hr');
    const fin = await login(fx.co, 'finance_manager');
    const { rows: [intern] } = await pool.query(
      `INSERT INTO interns (company_id, intern_code, first_name, last_name, college, course, department, designation,
                            status, start_date, end_date, stipend, stipend_frequency)
       VALUES ($1, 'INT901', 'Zz', 'Stipend', 'ZZ College', 'B.E.', 'Engineering', 'Intern',
               'Active', '2026-10-01', '2026-12-31', 10000, 'Monthly') RETURNING id`, [fx.co.companyId]);
    const { rows: [bank] } = await pool.query(
      `INSERT INTO bank_accounts (account_name, bank_name, account_number, ifsc_code, company_id, is_active)
       VALUES ('ZZ Current', 'ZZ Bank', '123456789012', 'HDFC0001234', $1, true) RETURNING id`, [fx.co.companyId]);

    const gen = await request(app).post('/api/intern-stipends/generate').set(hr.auth).send({ month: '2026-11' });
    expect(gen.status).toBe(200);
    expect(gen.body.raised).toBe(1);
    expect((await request(app).post('/api/intern-stipends/generate').set(hr.auth).send({ month: '2026-11' })).body.raised).toBe(0);
    const list = await request(app).get('/api/intern-stipends?month=2026-11').set(fin.auth);
    expect(list.status).toBe(200);
    const row = list.body.rows[0];
    expect(Number(row.amount)).toBe(10000);

    const pay = { utr: 'ZZUTR20261116', value_date: '2026-11-15', bank_account_id: bank.id };
    const noBank = await request(app).post(`/api/intern-stipends/${row.id}/pay`).set(fin.auth).send(pay);
    expect(noBank.body.code).toBe('INTERN_BANK_INVALID');
    await pool.query(`UPDATE interns SET bank_account_number = '987654321098', bank_ifsc = 'SBIN0001234' WHERE id = $1`, [intern.id]);
    expect((await request(app).post(`/api/intern-stipends/${row.id}/pay`).set(hr.auth).send(pay)).status).toBe(403);
    const paid = await request(app).post(`/api/intern-stipends/${row.id}/pay`).set(fin.auth).send(pay);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect((await request(app).post(`/api/intern-stipends/${row.id}/pay`).set(fin.auth).send(pay)).status).toBe(409);
  });
});

describe('F&F review and the Approval Center', () => {
  it('reads the saved version; the person who computed it cannot approve it', async () => {
    // The runner switches F&F containment ON (shipped default); lift it here so
    // the separation-of-duty rule is what is tested. Its own message is checked last.
    const before = process.env.HR_CONTAINMENT_FNF;
    process.env.HR_CONTAINMENT_FNF = 'off';
    try {
    const leaver = await employee(fx.co, { status: 'Notice' });
    const hr = await login(fx.co, 'hr');
    const approver = await login(fx.co, 'admin');
    const fin = await login(fx.co, 'finance_manager');
    const { rows: [er] } = await pool.query(
      `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status) VALUES ($1, 'resignation', CURRENT_DATE, 'active', 'draft') RETURNING id`, [leaver]);
    await pool.query(
      `INSERT INTO fnf_settlements (exit_request_id, employee_id, company_id, version, separation_type, last_working_date,
          total_payable, total_recoverable, net_payable, lines, warnings, inputs, rules, rules_unconfirmed, computed_by)
       VALUES ($1, $2, $3, 1, 'resignation', CURRENT_DATE, 1000, 0, 1000, '[]', '[]', '{}', '[]', '[]', $4)`,
      [er.id, leaver, fx.co.companyId, approver.id]);
    const mine = await request(app).get(`/api/exit/fnf/review/${er.id}`).set(approver.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.settlement.version).toBe(1);
    expect(mine.body.can_approve).toBe(false);
    expect(mine.body.why_not).toMatch(/You computed this version/);
    const theirs = await request(app).get(`/api/exit/fnf/review/${er.id}`).set(fin.auth);
    expect(theirs.status).toBe(200);
    // Reading changed nothing: still one version.
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM fnf_settlements WHERE exit_request_id = $1`, [er.id]);
    expect(rows[0].n).toBe(1);
    void hr;
    } finally { process.env.HR_CONTAINMENT_FNF = before ?? ''; }
    const suspended = await request(app).get(`/api/exit/fnf/review/${(await pool.query(`SELECT id FROM exit_requests WHERE employee_id IN (SELECT id FROM employees WHERE company_id = $1) ORDER BY id DESC LIMIT 1`, [fx.co.companyId])).rows[0].id}`)
      .set((await login(fx.co, 'admin')).auth);
    expect(suspended.body.can_approve).toBe(false);
    expect(suspended.body.why_not).toMatch(/switched off/);
  });

  it('the fnf and stip sources list pending rows without error', async () => {
    for (const type of ['fnf', 'stip']) {
      const src = SOURCES.find(s => s.type === type);
      expect(src, type).toBeTruthy();
      const rows = await src.pending(fx.co.companyId);
      expect(Array.isArray(rows)).toBe(true);
    }
    const fnf = await SOURCES.find(s => s.type === 'fnf').pending(fx.co.companyId);
    const row = fnf.find(r => r.request_title.startsWith('Full & final'));
    expect(row).toBeTruthy();
    expect(SOURCES.find(s => s.type === 'fnf').stage(row)).toBe('Finance approval');
  });
});

describe('HR Documents for employees', () => {
  it('an employee reads the all-staff documents only', async () => {
    const emp = await employee(fx.co);
    const staff = await login(fx.co, 'employee', emp);
    await pool.query(
      `INSERT INTO hr_downloads (company_id, title, category, file_url, visible_to) VALUES
        ($1, 'ZZ Leave form', 'Forms', 'https://example.com/a.pdf', 'all'),
        ($1, 'ZZ HR SOP', 'Policies', 'https://example.com/b.pdf', 'hr_only')`, [fx.co.companyId]);
    const res = await request(app).get('/api/hr/downloads').set(staff.auth);
    expect(res.status).toBe(200);
    expect(res.body.map(d => d.title)).toEqual(['ZZ Leave form']);
    expect((await request(app).post('/api/hr/downloads').set(staff.auth).send({ title: 'x' })).status).toBe(403);
  });
});

describe('Offboarding Notify', () => {
  it('names why when no one can be reached, and notifies the department head', async () => {
    const hr = await login(fx.co, 'hr');
    const leaver = await employee(fx.co, { status: 'Notice', department: 'ZZIT' });
    await request(app).put('/api/hr/offboarding/templates').set(hr.auth)
      .send({ items: [{ category: 'IT', item_label: 'Laptop returned', default_assignee: 'ZZIT' }] });
    const none = await request(app).post(`/api/hr/offboarding/${leaver}/checklist/notify`).set(hr.auth).send({ assignee: 'ZZIT' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('NO_RECIPIENT');

    const { rows: [dept] } = await pool.query(
      `INSERT INTO master_departments (name, is_active) VALUES ('ZZIT', true)
       ON CONFLICT DO NOTHING RETURNING id`);
    const deptId = dept?.id ?? (await pool.query(`SELECT id FROM master_departments WHERE name = 'ZZIT'`)).rows[0].id;
    const head = await employee(fx.co, { department: 'ZZIT' });
    const headLogin = await login(fx.co, 'employee', head);
    await pool.query(`INSERT INTO department_heads (company_id, department_id, head_employee_id) VALUES ($1, $2, $3)`,
      [fx.co.companyId, deptId, head]);
    const sent = await request(app).post(`/api/hr/offboarding/${leaver}/checklist/notify`).set(hr.auth).send({ assignee: 'ZZIT' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.items).toBe(1);
    await new Promise(r => setTimeout(r, 300));
    const { rows } = await pool.query(`SELECT message FROM notifications WHERE user_id = $1`, [headLogin.id]);
    expect(rows[0]?.message).toMatch(/Laptop returned/);
    await pool.query(`DELETE FROM department_heads WHERE company_id = $1`, [fx.co.companyId]);
    await pool.query(`DELETE FROM master_departments WHERE id = $1`, [deptId]).catch(() => {});
  });
});

// ── Owner decisions 2026-11-17 ────────────────────────────────────────────────
describe('One exit checklist (clearance + company items merged)', () => {
  it('an open company item blocks the settlement; ticking it clears; a new exit archives the items', async () => {
    const hr = await login(fx.co, 'hr');
    const leaver = await employee(fx.co, { status: 'Notice' });
    await request(app).put('/api/hr/offboarding/templates').set(hr.auth)
      .send({ items: [{ category: 'Admin', item_label: 'Return ID badge', default_assignee: 'HR' }] });
    const open = await request(app).get(`/api/exit/clearance/${leaver}/status`).set(hr.auth);
    const item = open.body.blockers.find(b => b.key === 'checklist');
    expect(item.cleared).toBe(false);
    expect(item.detail).toEqual(['Return ID badge (HR)']);
    expect(open.body.can_settle).toBe(false);

    await request(app).patch(`/api/hr/offboarding/${leaver}/checklist`).set(hr.auth)
      .send({ items: [{ category: 'Admin', item_label: 'Return ID badge', done: true }] });
    const done = await request(app).get(`/api/exit/clearance/${leaver}/status`).set(hr.auth);
    expect(done.body.blockers.find(b => b.key === 'checklist').cleared).toBe(true);

    const client = await pool.connect();
    try { await freshClearance(client, leaver); } finally { client.release(); }
    const { rows } = await pool.query(`SELECT 1 FROM hr_offboarding_checklist_progress WHERE employee_id = $1`, [leaver]);
    expect(rows).toEqual([]);
    const { rows: [h] } = await pool.query(`SELECT clearance FROM exit_clearance_history WHERE employee_id = $1`, [leaver]);
    expect(h.clearance.checklist_items.map(i => [i.item_label, i.done])).toEqual([['Return ID badge', true]]);
  });
});

describe('HR may archive announcements', () => {
  it('hr, hr_manager and hr_exec hold announcements:delete; manager does not', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS code, rp.can_delete FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.module = 'announcements' AND LOWER(r.code) IN ('hr','hr_manager','hr_exec','manager') ORDER BY 1`);
    expect(Object.fromEntries(rows.map(r => [r.code, r.can_delete])))
      .toEqual({ hr: true, hr_exec: true, hr_manager: true, manager: false });
  });
});
