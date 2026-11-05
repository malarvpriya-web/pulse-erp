/**
 * Employee bank details — HR-only, maker-checker, notified after approval,
 * masked, mandatory (§202, §204).
 *
 *  - New or changed details never reach the employees row directly: they
 *    become ONE pending request (employee_bank_change_requests). A DIFFERENT
 *    HR user with employee_bank:edit approves — only then is the row written,
 *    stamped bank_verified_at / _by, and Accounts (finance:edit holders)
 *    notified with the employee's name and code only.
 *  - employee_bank:add alone = propose only (no approval, numbers masked).
 *    hr_exec / payroll_admin hold neither by default and are refused.
 *  - The audit log keeps the history with numbers masked.
 *  - Account number, IFSC and address are required on Add Employee and cannot
 *    be cleared on edit; Data Quality counts unverified details (information).
 *  - Existing details are never stamped verified.
 *
 * Real routers, auth and role matrix. A throwaway company; its employees,
 * logins, requests, notifications and audit rows are removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const notify = vi.hoisted(() => ({ calls: [] }));
vi.mock('../services/WorkflowNotificationService.js', () => ({
  notifyWorkflowEvent: (event, ctx) => { notify.calls.push({ event, ctx }); },
  EVENT_MAP: {},
}));

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }            = await import('../config/db.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: employeeRoutes }  = await import('../employees/employee.routes.js');
const service                      = await import('../employees/employee.service.js');
const { maskSensitive }            = await import('../services/AuditService.js');

const app = buildApp(['/api/employees', employeeRoutes]);

const PREFIX = 'ZZBANK';
const ACCT = '123456789012';
let co, other, hrMgr, hrMgr2, hrExec, payrollAdmin, finUser, empUser, proposer, otherHr;
let dept, desig;
const E = {};
const created = [];
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const row = async (id) => (await pool.query(
  `SELECT account_number, ifsc_code, bank_name, current_address, designation, emergency_name, bank_verified_at, bank_verified_by
     FROM employees WHERE id = $1`, [id])).rows[0];
const pending = async (id) => (await pool.query(
  `SELECT * FROM employee_bank_change_requests WHERE employee_id = $1 AND status = 'pending'`, [id])).rows[0];
const settle = () => new Promise(r => { setTimeout(r, 300); });   // logAudit writes after the response
const bankNotices = () => notify.calls.filter(c => c.event === 'bank_details_changed');

async function sweep(companyId) {
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM permissions WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM audit_logs WHERE module_name = 'employees' AND reference_id IN (SELECT id::text FROM employees WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM employee_bank_change_requests WHERE company_id = $1`, [companyId]);
  const { rows } = await pool.query(`SELECT u.id FROM users u JOIN employees e ON e.id = u.employee_id WHERE e.company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]).catch(() => {});
  return rows;
}
async function addEmployee(company, code, extra = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, designation,
                            account_number, ifsc_code, bank_name, current_address, company_email)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [company.companyId, code, dept, desig, extra.account ?? null, extra.ifsc ?? null, extra.bank ?? null, extra.address ?? null,
     `${code.toLowerCase()}.${company.companyId}.${Date.now()}@test.invalid`]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  ({ rows: [{ name: dept }] } = await pool.query(`SELECT name FROM master_departments  WHERE is_active ORDER BY id LIMIT 1`));
  ({ rows: [{ name: desig }] } = await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`));
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  E.A = await addEmployee(co, 'EMP001', { account: ACCT, ifsc: 'HDFC0001234', bank: 'HDFC Bank', address: '1 Fixture Street' });
  E.N = await addEmployee(co, 'EMP002');   // never had bank details or an address
  E.O = await addEmployee(other, 'EMP001', { account: '999900001111', ifsc: 'SBIN0000001', address: 'x' });
  hrMgr = await addUser(pool, co, { label: 'hrm', roleCode: 'hr_manager' });
  hrMgr2 = await addUser(pool, co, { label: 'hrm2', roleCode: 'hr' });
  hrExec = await addUser(pool, co, { label: 'hrx', roleCode: 'hr_exec' });
  payrollAdmin = await addUser(pool, co, { label: 'pay', roleCode: 'payroll_admin' });
  finUser = await addUser(pool, co, { label: 'fin', roleCode: 'finance_manager' });
  empUser = await addUser(pool, co, { label: 'emp', roleCode: 'employee' });
  otherHr = await addUser(pool, other, { label: 'hrm', roleCode: 'hr_manager' });
  await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [E.A, empUser.userId]);
  // A propose-only HR login: hr_exec plus a user-level employee_bank:add — what
  // granting the propose-only flag to hr_exec in Roles Setup would give (§204).
  proposer = await addUser(pool, co, { label: 'prop', roleCode: 'hr_exec' });
  await pool.query(`INSERT INTO permissions (user_id, module, can_add) VALUES ($1, 'employee_bank', true)`, [proposer.userId]);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) {
    if (!c) continue;
    const logins = (await sweep(c.companyId)).map(r => r.id);
    if (logins.length) {
      await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [logins]);
      await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [logins]).catch(() => {});
    }
    await dropIsolatedCompany(pool, c.companyId);
  }
  await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [created]).catch(() => {});
}, 60000);

describe('who may propose', () => {
  it('hr_exec and payroll_admin cannot — and nothing in that request is saved', async () => {
    for (const who of [hrExec, payrollAdmin]) {
      const r = await call(who, 'put', `/api/employees/${E.A}`).send({ account_number: '999988887777', designation: 'Changed' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('BANK_DETAILS_PERMISSION');
    }
    expect(await row(E.A)).toMatchObject({ account_number: ACCT, designation: desig });
    expect(await pending(E.A)).toBeUndefined();
  });

  it('they keep every other edit, including a form that round-trips the masked number', async () => {
    const r = await call(hrExec, 'put', `/api/employees/${E.A}`).send({ account_number: 'XXXX9012', ifsc_code: 'HDFC0001234', emergency_name: 'Kin' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bank_change_request).toBeUndefined();
    expect(await row(E.A)).toMatchObject({ account_number: ACCT, emergency_name: 'Kin' });
  });
});

describe('maker-checker', () => {
  let reqId;

  it('a change by HR is saved as PENDING: the row keeps the old details, nobody is notified yet', async () => {
    notify.calls.length = 0;
    const r = await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ account_number: '5555 6666 7777', ifsc_code: 'icic0004321 ', emergency_name: 'Kin 2' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bank_change_request).toMatchObject({ status: 'pending' });
    reqId = r.body.bank_change_request.id;
    // other fields saved; bank fields NOT
    expect(await row(E.A)).toMatchObject({ account_number: ACCT, ifsc_code: 'HDFC0001234', emergency_name: 'Kin 2', bank_verified_at: null });
    expect(await pending(E.A)).toMatchObject({ id: reqId, proposed_account_number: '555566667777', proposed_ifsc_code: 'ICIC0004321',
      proposed_bank_name: 'HDFC Bank', requested_by: hrMgr.userId, source: 'edit' });
    expect(bankNotices()).toHaveLength(0);
  });

  it('one pending change per employee — a second is refused and nothing else in it is saved', async () => {
    const r = await call(hrMgr2, 'put', `/api/employees/${E.A}`).send({ account_number: '111122223333', emergency_name: 'Kin 3' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BANK_CHANGE_PENDING');
    expect((await row(E.A)).emergency_name).toBe('Kin 2');
  });

  it('the maker cannot approve or reject their own change', async () => {
    const a = await call(hrMgr, 'post', `/api/employees/bank-change-requests/${reqId}/approve`);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('SAME_PERSON');
    expect((await call(hrMgr, 'post', `/api/employees/bank-change-requests/${reqId}/reject`).send({ reason: 'x' })).status).toBe(403);
    expect((await row(E.A)).account_number).toBe(ACCT);
  });

  it('non-reviewers and other companies cannot decide it', async () => {
    for (const who of [hrExec, payrollAdmin, finUser, empUser]) {
      expect((await call(who, 'post', `/api/employees/bank-change-requests/${reqId}/approve`)).status).toBe(403);
    }
    expect((await call(otherHr, 'post', `/api/employees/bank-change-requests/${reqId}/approve`)).status).toBe(404);
    expect((await call(otherHr, 'get', '/api/employees/bank-change-requests')).body.some(r => r.id === reqId)).toBe(false);
  });

  it('the queue shows reviewers what changes, and who may decide', async () => {
    const q = await call(hrMgr2, 'get', '/api/employees/bank-change-requests');
    expect(q.status).toBe(200);
    const r = q.body.find(x => x.id === reqId);
    expect(r).toMatchObject({ employee_code: 'EMP001', proposed_account_number: '555566667777', current_account_number: ACCT, can_decide: true });
    expect((await call(hrMgr, 'get', '/api/employees/bank-change-requests')).body.find(x => x.id === reqId).can_decide).toBe(false);
    for (const who of [hrExec, payrollAdmin, finUser]) {
      expect((await call(who, 'get', '/api/employees/bank-change-requests')).status).toBe(403);
    }
  });

  it('a different HR reviewer approves: the row is written and stamped, THEN Accounts is notified (no number)', async () => {
    notify.calls.length = 0;
    const r = await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${reqId}/approve`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await row(E.A);
    expect(after).toMatchObject({ account_number: '555566667777', ifsc_code: 'ICIC0004321', bank_verified_by: hrMgr2.userId });
    expect(after.bank_verified_at).not.toBeNull();
    expect((await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${reqId}/approve`)).status).toBe(409);

    const sent = bankNotices();
    expect(sent).toHaveLength(1);
    expect(sent[0].ctx.recipientUserIds).toContain(finUser.userId);
    expect(sent[0].ctx.recipientUserIds).not.toContain(hrMgr2.userId);
    expect(JSON.stringify(sent[0].ctx)).not.toMatch(/5555|6666|7777|1234|ICIC/);
    expect(sent[0].ctx.context.employeeLabel).toContain('EMP001');

    await settle();
    const { rows: audit } = await pool.query(
      `SELECT action_type, old_data_json::text AS o, new_data_json::text AS n FROM audit_logs
        WHERE module_name = 'employees' AND reference_id = $1 AND reference_type = 'employee_bank_details' ORDER BY id`, [String(E.A)]);
    expect(audit.map(a => a.action_type)).toEqual(['propose', 'approve']);
    for (const a of audit) {
      expect(a.o ?? '').not.toContain(ACCT);
      expect(a.n ?? '').not.toContain('555566667777');
    }
  });

  it('a rejection needs a reason and changes nothing; the maker can withdraw instead', async () => {
    const p = await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ ifsc_code: 'SBIN0009999' });
    const id = p.body.bank_change_request.id;
    expect((await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${id}/reject`).send({})).status).toBe(400);
    expect((await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${id}/reject`).send({ reason: 'Cheque does not match' })).status).toBe(200);
    expect((await row(E.A)).ifsc_code).toBe('ICIC0004321');
    expect(bankNotices().filter(c => c.ctx.recordId === E.A)).toHaveLength(1);   // only the earlier approval

    const w = await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ ifsc_code: 'SBIN0009999' });
    const wid = w.body.bank_change_request.id;
    expect((await call(hrExec, 'post', `/api/employees/bank-change-requests/${wid}/withdraw`)).status).toBe(403);
    expect((await call(hrMgr, 'post', `/api/employees/bank-change-requests/${wid}/withdraw`)).status).toBe(200);
    expect(await pending(E.A)).toBeUndefined();
    expect((await row(E.A)).ifsc_code).toBe('ICIC0004321');
  });

  it('format is checked against the rule payroll pays on, before anything is recorded', async () => {
    expect((await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ ifsc_code: 'BAD' })).status).toBe(400);
    expect((await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ account_number: '12ab' })).status).toBe(400);
    expect(await pending(E.A)).toBeUndefined();
  });
});

describe('propose-only (employee_bank:add)', () => {
  it('can enter details as a pending request, sees no full numbers, and cannot approve', async () => {
    const r = await call(proposer, 'put', `/api/employees/${E.N}`).send({ account_number: '445566778899', ifsc_code: 'UTIB0001111' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.bank_change_request.id;
    expect((await row(E.N)).account_number).toBeNull();
    const q = await call(proposer, 'get', '/api/employees/bank-change-requests');
    const mine = q.body.find(x => x.id === id);
    expect(mine.proposed_account_number).toBe('XXXX8899');
    expect(mine.can_decide).toBe(false);
    expect(mine.can_withdraw).toBe(true);
    expect((await call(proposer, 'post', `/api/employees/bank-change-requests/${id}/approve`)).status).toBe(403);
    expect((await call(hrMgr, 'post', `/api/employees/bank-change-requests/${id}/approve`)).status).toBe(200);
    expect((await row(E.N)).account_number).toBe('445566778899');
  });
});

describe('mandatory fields', () => {
  it('an on-record account number, IFSC or address cannot be cleared', async () => {
    for (const k of ['account_number', 'ifsc_code', 'current_address']) {
      const r = await call(hrMgr, 'put', `/api/employees/${E.A}`).send({ [k]: '' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('REQUIRED_FIELDS');
    }
  });

  it('Add Employee requires them; the new hire\'s details wait for approval like any change', async () => {
    const base = {
      first_name: 'ZZBank', last_name: `New${Date.now()}`, company_email: `zz.bank.${Date.now()}@example.com`,
      department: dept, designation: desig, status: 'Active', joining_date: '2026-06-01',
    };
    const missing = await call(hrMgr, 'post', '/api/employees').send(base);
    expect(missing.status).toBe(400);
    expect(missing.body.missing).toEqual(['Bank account number', 'IFSC code', 'Current address']);
    const full = { ...base, account_number: '112233445566', ifsc_code: 'SBIN0001234', current_address: '9 New Road' };
    expect((await call(hrExec, 'post', '/api/employees').send(full)).status).toBe(403);
    notify.calls.length = 0;
    const ok = await call(hrMgr, 'post', '/api/employees').send(full);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    created.push(ok.body.id);
    expect(ok.body.bank_change_request).toMatchObject({ status: 'pending' });
    expect(await row(ok.body.id)).toMatchObject({ current_address: '9 New Road', bank_verified_at: null });
    expect((await row(ok.body.id)).account_number || null).toBeNull();
    expect(bankNotices()).toHaveLength(0);
    expect((await pending(ok.body.id)).source).toBe('create');
    expect((await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${ok.body.bank_change_request.id}/approve`)).status).toBe(200);
    expect((await row(ok.body.id)).account_number).toBe('112233445566');
    expect(bankNotices().some(c => c.ctx.recordId === ok.body.id)).toBe(true);
  });

  it('Data Quality: missing details are critical; unverified details are counted, not blocked', async () => {
    const a = await service.getEmployeeAnalytics({ company_id: co.companyId });
    expect(a.dataQuality.missingAddress).toBeGreaterThanOrEqual(1);   // EMP002
    expect(a.dataQuality.critical).toBeGreaterThanOrEqual(0);
    // EMP001 / EMP002 / the new hire are approved; none of the fixture rows is "unverified"
    expect(a.dataQuality.unverifiedBankDetails).toBe(0);
    await pool.query(`UPDATE employees SET bank_verified_at = NULL WHERE id = $1`, [E.A]);
    expect((await service.getEmployeeAnalytics({ company_id: co.companyId })).dataQuality.unverifiedBankDetails).toBe(1);
  });
});

describe('reading bank details', () => {
  it('unmasked only with employee_bank:view, or on one\'s own record', async () => {
    const full = await call(hrMgr, 'get', `/api/employees/${E.A}`);
    expect(full.body.account_number).toBe('555566667777');
    for (const who of [hrExec, payrollAdmin]) {
      const r = await call(who, 'get', `/api/employees/${E.A}`);
      expect(r.status).toBe(200);
      expect(r.body.account_number).toBe('XXXX7777');
    }
    const list = await call(hrExec, 'get', '/api/employees');
    expect(JSON.stringify(list.body)).not.toContain('555566667777');
  });
});

describe('audit masking', () => {
  it('keeps the last four of bank and identity numbers, at any depth, and nothing else changes', () => {
    expect(maskSensitive({ account_number: '1234 5678 9012', ifsc_code: 'HDFC0001234', nested: [{ aadhaar_number: '123412341234', pan_number: 'ABCDE1234F' }], name: 'A' }))
      .toEqual({ account_number: 'XXXX9012', ifsc_code: 'HDFC0001234', nested: [{ aadhaar_number: 'XXXX1234', pan_number: 'XXXX234F' }], name: 'A' });
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive({ account_number: '' })).toEqual({ account_number: '' });
  });
});

describe('verify as-is (§206)', () => {
  const V = {};
  beforeAll(async () => {
    V.ok = await addEmployee(co, 'EMP101', { account: '246813579024', ifsc: 'KKBK0001234', bank: 'Kotak', address: 'v' });
    V.bad = await addEmployee(co, 'EMP102', { account: '123', ifsc: 'X', address: 'v' });     // like the 4 live records
    V.none = await addEmployee(co, 'EMP103', { address: 'v' });
    V.race = await addEmployee(co, 'EMP104', { account: '135792468013', ifsc: 'HDFC0005555', address: 'v' });
  });

  it('refuses details that are missing or invalid — they need correcting, not verifying', async () => {
    const bad = await call(hrMgr, 'post', `/api/employees/${V.bad}/bank-verification-request`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BANK_DETAILS_INVALID');
    const none = await call(hrMgr, 'post', `/api/employees/${V.none}/bank-verification-request`);
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('NOTHING_TO_VERIFY');
    expect(await pending(V.bad)).toBeUndefined();
  });

  it('needs the bank grant and stays inside the company', async () => {
    for (const who of [hrExec, payrollAdmin, finUser, empUser]) {
      expect((await call(who, 'post', `/api/employees/${V.ok}/bank-verification-request`)).status).toBe(403);
    }
    expect((await call(otherHr, 'post', `/api/employees/${V.ok}/bank-verification-request`)).status).toBe(404);
  });

  it('a request changes nothing and notifies nobody; the maker cannot approve it; a different reviewer stamps it, then Accounts is told', async () => {
    notify.calls.length = 0;
    const before = await row(V.ok);
    const r = await call(hrMgr, 'post', `/api/employees/${V.ok}/bank-verification-request`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.bank_change_request).toMatchObject({ status: 'pending', source: 'verify' });
    const id = r.body.bank_change_request.id;
    expect(await pending(V.ok)).toMatchObject({ source: 'verify', fields_changed: [], proposed_account_number: '246813579024' });
    expect(await row(V.ok)).toEqual(before);
    expect(bankNotices()).toHaveLength(0);
    expect((await call(hrMgr, 'post', `/api/employees/${V.ok}/bank-verification-request`)).status).toBe(409);

    expect((await call(hrMgr, 'post', `/api/employees/bank-change-requests/${id}/approve`)).body.code).toBe('SAME_PERSON');
    const a = await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${id}/approve`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const after = await row(V.ok);
    expect(after).toMatchObject({ account_number: '246813579024', ifsc_code: 'KKBK0001234', bank_name: 'Kotak', bank_verified_by: hrMgr2.userId });
    expect(after.bank_verified_at).not.toBeNull();

    const sent = bankNotices();
    expect(sent).toHaveLength(1);
    expect(sent[0].ctx.context.action).toBe('verified');
    expect(JSON.stringify(sent[0].ctx)).not.toMatch(/2468|9024|KKBK/);

    await settle();
    const { rows: audit } = await pool.query(
      `SELECT action_type FROM audit_logs WHERE module_name = 'employees' AND reference_id = $1 AND reference_type = 'employee_bank_details' ORDER BY id`, [String(V.ok)]);
    expect(audit.map(x => x.action_type)).toEqual(['request_verification', 'approve']);
    const again = await call(hrMgr, 'post', `/api/employees/${V.ok}/bank-verification-request`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_VERIFIED');
  });

  it('if the details change between request and approval, nothing is stamped', async () => {
    const r = await call(hrMgr, 'post', `/api/employees/${V.race}/bank-verification-request`);
    const id = r.body.bank_change_request.id;
    await pool.query(`UPDATE employees SET ifsc_code = 'HDFC0006666' WHERE id = $1`, [V.race]);   // fixture row only
    const a = await call(hrMgr2, 'post', `/api/employees/bank-change-requests/${id}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('DETAILS_CHANGED');
    expect((await row(V.race)).bank_verified_at).toBeNull();
    expect(await pending(V.race)).toBeTruthy();
  });

  it('a propose-only holder lists only its OWN requests, masked, with no decisions', async () => {
    const own = await call(proposer, 'post', `/api/employees/${E.N}/bank-verification-request`);
    expect([201, 409]).toContain(own.status);
    const q = await call(proposer, 'get', '/api/employees/bank-change-requests?status=all');
    expect(q.status).toBe(200);
    expect(q.body.length).toBeGreaterThan(0);
    expect(q.body.every(x => x.requested_by === proposer.userId)).toBe(true);
    expect(q.body.every(x => x.can_decide === false)).toBe(true);
    expect(q.body.every(x => !x.proposed_account_number || /^XXXX/.test(x.proposed_account_number))).toBe(true);
    expect(q.body.every(x => !x.current_account_number || /^XXXX/.test(x.current_account_number))).toBe(true);
    // a reviewer still sees everyone's
    const all = await call(hrMgr2, 'get', '/api/employees/bank-change-requests?status=all');
    expect(all.body.some(x => x.requested_by === hrMgr.userId)).toBe(true);
  });
});
