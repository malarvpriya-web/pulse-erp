/**
 * Approving and paying a Full & Final settlement (manual §254), through the real routes,
 * permission matrix and journal posting. Containment is lifted here because this is the logic
 * that runs once it is switched off; the contained behaviour is in hrP0Containment.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { default: pool } = await import('../config/db.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: exitRoutes } = await import('../modules/hr/exit.routes.js');
const { default: payrollRoutes } = await import('../modules/payroll/payroll.routes.js');
const { resolveSettlementRules, SETTLEMENT_RULE_KEYS } = await import('../modules/hr/settlementRules.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');

const STAMP = Date.now() % 1000000;
const EMAIL = (n) => `zz.fnfpay.${n}.${STAMP}@example.com`;
let company, otherCompany, app, bank, bankChart, seq = 200;
const users = {};
const employees = [];
const before = process.env.HR_CONTAINMENT_FNF;

async function login(name, role, co) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, role, is_active, company_id, password_hash) VALUES ($1, $2, $3, true, $4, 'x') RETURNING id`,
    [name, EMAIL(name), role, co]);
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [u.id, co]);
  await syncPrimaryRole(u.id, role, co);
  users[name] = jwt.sign({ userId: u.id, email: EMAIL(name), role, roles: [role] }, process.env.JWT_SECRET);
  users[`${name}Id`] = u.id;
}
const call = (who, method, url, body) => request(app)[method](url).set('Authorization', `Bearer ${users[who]}`).send(body ?? {});

/** Finance's account codes: real accounts of this test company. */
async function accounts() {
  const gl = {};
  for (const [key, code, type] of [
    ['salary_expense', 'ZZS', 'Expense'], ['leave_expense', 'ZZL', 'Expense'], ['bonus_expense', 'ZZB', 'Expense'], ['gratuity_expense', 'ZZG', 'Expense'],
    ['notice_recovery_income', 'ZZN', 'Revenue'], ['asset_recovery_income', 'ZZA', 'Revenue'], ['statutory_payable', 'ZZP', 'Liability'], ['tds_payable', 'ZZT', 'Liability'],
    ['loan_receivable', 'ZZR', 'Asset'], ['advance_receivable', 'ZZV', 'Asset'],
  ]) {
    await pool.query(`INSERT INTO chart_of_accounts (code, name, account_type, is_active, company_id) VALUES ($1, $1, $2, true, $3)`, [`${code}${STAMP}`, type, company]);
    gl[key] = `${code}${STAMP}`;
  }
  return gl;
}

/** Everyone's rules recorded, which is how a company confirms them. */
async function confirmRules(gl) {
  const { values } = resolveSettlementRules('2026-11-01');
  for (const key of SETTLEMENT_RULE_KEYS) {
    await pool.query(
      `INSERT INTO payroll_statutory_rules (company_id, rule_key, effective_from, value, source_reference) VALUES ($1, $2, '2025-11-21', $3, 'zz adviser')`,
      [company, key, JSON.stringify(key === 'settlement.gl' ? gl : values[key])]);
  }
}

async function leaver({ net = true } = {}) {
  seq += 1;
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, employment_type, account_number, ifsc_code)
     VALUES ($1, $2, 'Zz', 'Pay', 'Notice', '2020-04-01', 'Permanent', '123456789012', 'HDFC0001234') RETURNING id`, [company, `EMP${seq}`]);
  employees.push(e.id);
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, basic_salary, effective_from, company_id) VALUES ($1, 26000, '2020-04-01', $2)`, [e.id, company]);
  const { rows: [x] } = await pool.query(
    `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status, fnf_status, reason, notice_period, created_at)
     VALUES ($1, 'resignation', '2026-10-31', 'active', 'draft', 'zz', 30, '2026-10-01') RETURNING id`, [e.id]);
  // Every clearance the pay step checks is done.
  await pool.query(`INSERT INTO exit_clearance (employee_id, noc_finance, noc_manager, noc_hr, finance_noc_by, manager_noc_by, hr_noc_by) VALUES ($1, true, true, true, 1, 1, 1)`, [e.id]).catch(() => {});
  void net;
  return { emp: e.id, exit: x.id };
}
async function computed(s, by = 'hr', body = {}) {
  const r = await call(by, 'post', `/exit/fnf/compute/${s.emp}`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const paying = (sid, utr, extra = {}) => ({ settlement_id: sid, utr, value_date: new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10), bank_account_id: bank, ...extra });
const nextUtr = () => `ZZUTR${STAMP}${(seq += 1)}`;

beforeAll(async () => {
  process.env.HR_CONTAINMENT_FNF = 'off';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const mk = async (c) => {
    const id = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $1) RETURNING id`, [c])).rows[0].id;
    // rule changes apply at once here; the second-person review has its own tests
    await pool.query(`INSERT INTO company_settings (company_id, module, settings) VALUES ($1, 'payroll', '{"rules_two_person": false}'::jsonb)`, [id]);
    return id;
  };
  company = await mk(`ZZFNFP${STAMP}`);
  otherCompany = await mk(`ZZFNFQ${STAMP}`);
  await login('hr', 'hr_manager', company);
  await login('fin', 'finance_manager', company);
  await login('fin2', 'finance_manager', company);
  await login('admin', 'admin', company);
  await login('exec', 'hr_exec', company);
  await login('otherFin', 'finance_manager', otherCompany);
  const { rows: [coa] } = await pool.query(`INSERT INTO chart_of_accounts (code, name, account_type, is_active, company_id) VALUES ($1, 'ZZ Bank', 'Asset', true, $2) RETURNING id`, [`ZZK${STAMP}`, company]);
  bankChart = coa.id;
  const { rows: [b] } = await pool.query(
    `INSERT INTO bank_accounts (account_name, bank_name, is_active, company_id, chart_account_id, account_number) VALUES ('ZZ Bank', 'ZZ', true, $1, $2, $3) RETURNING id`, [company, bankChart, `ZZ${STAMP}`]);
  bank = b.id;
  app = express();
  app.use(express.json());
  app.use('/exit', verifyToken, exitRoutes);
  app.use('/payroll', payrollRoutes);
}, 60000);

afterAll(async () => {
  if (before === undefined) delete process.env.HR_CONTAINMENT_FNF; else process.env.HR_CONTAINMENT_FNF = before;
  const ids = [company, otherCompany];
  await pool.query(`DELETE FROM tds_transactions WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM tds_deductees WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1::int[]))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1::int[]))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM journal_entries WHERE company_id = ANY($1::int[])`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM fnf_settlement_events WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM fnf_settlements WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM exit_clearance WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM payroll_loans WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [employees]);
  await pool.query(`DELETE FROM payroll_statutory_rules WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM chart_of_accounts WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`zz.fnfpay.%.${STAMP}@example.com`]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`zz.fnfpay.%.${STAMP}@example.com`]);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`zz.fnfpay.%.${STAMP}@example.com`]);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`zz.fnfpay.%.${STAMP}@example.com`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`zz.fnfpay.%.${STAMP}@example.com`]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [ids]);
}, 60000);

describe('before the rules are confirmed', () => {
  it('approval is refused and names the rules', async () => {
    const s = await leaver();
    const c = await computed(s);
    const r = await call('fin', 'put', `/exit/fnf/${s.exit}/approve`, { settlement_id: c.settlement_id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RULES_UNCONFIRMED');
    expect(r.body.rules).toContain('settlement.gratuity');
  });
});

describe('once Finance has set the inputs', () => {
  beforeAll(async () => { await confirmRules(await accounts()); });
  let s, c;
  beforeEach(async () => { s = await leaver(); c = await computed(s); });
  const approve = (who = 'fin', id = c.settlement_id) => call(who, 'put', `/exit/fnf/${s.exit}/approve`, { settlement_id: id });
  const pay = (who, body) => call(who, 'post', `/exit/fnf/${s.exit}/pay`, body);

  it('a settlement computed after confirming lists no open rules', () => {
    expect(c.computation_details.rules_unconfirmed).toEqual([]);
  });

  it('HR cannot approve or pay; a role without the right gets 403', async () => {
    expect((await approve('hr')).status).toBe(403);
    expect((await pay('hr', paying(c.settlement_id, nextUtr()))).status).toBe(403);
    expect((await approve('exec')).status).toBe(403);
  });

  it('the person who computed it cannot approve it', async () => {
    const d = await computed(s, 'admin');
    const r = await approve('admin', d.settlement_id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SELF_APPROVAL');
  });

  it('a stale version cannot be approved', async () => {
    const newer = await computed(s, 'hr', { lop_days: 1 });
    const r = await approve('fin', c.settlement_id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SETTLEMENT_STALE', latest_settlement_id: newer.settlement_id });
  });

  it('another company cannot reach it', async () => {
    expect((await call('otherFin', 'put', `/exit/fnf/${s.exit}/approve`, { settlement_id: c.settlement_id })).status).toBe(404);
    expect((await call('otherFin', 'post', `/exit/fnf/${s.exit}/pay`, paying(c.settlement_id, nextUtr()))).status).toBe(404);
  });

  it('it cannot be paid before approval', async () => {
    const r = await pay('fin', paying(c.settlement_id, nextUtr()));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_APPROVED');
  });

  it('approving twice is harmless, and records once', async () => {
    expect((await approve()).status).toBe(200);
    expect((await approve()).status).toBe(200);
    const { rows } = await pool.query(`SELECT actor_id FROM fnf_settlement_events WHERE settlement_id = $1 AND action = 'approve'`, [c.settlement_id]);
    expect(rows).toEqual([{ actor_id: users.finId }]);
  });

  it('the approver cannot also record the payment', async () => {
    await approve('fin');
    const r = await pay('fin', paying(c.settlement_id, nextUtr()));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SELF_PAYMENT');
  });

  it.each([
    [{ utr: '' }, 'UTR_REQUIRED'],
    [{ value_date: 'soon' }, 'VALUE_DATE_REQUIRED'],
    [{ value_date: '2099-01-01' }, 'VALUE_DATE_FUTURE'],
    [{ value_date: '2020-01-01' }, 'VALUE_DATE_EARLY'],
    [{ bank_account_id: 2147483000 }, 'BANK_ACCOUNT_INVALID'],
  ])('payment is refused with %j, and changes nothing', async (bad, code) => {
    await approve('fin');
    const r = await pay('fin2', paying(c.settlement_id, nextUtr(), bad));
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(r.body.code).toBe(code);
    const { rows: [x] } = await pool.query(`SELECT fnf_status, status FROM exit_requests WHERE id = $1`, [s.exit]);
    expect(x).toEqual({ fnf_status: 'approved', status: 'active' });
  });

  it('an employee bank account that is on file but not valid is refused (§275)', async () => {
    await approve('fin');
    // The shape of the placeholders on file for live employees: IFSC "21312".
    await pool.query(`UPDATE employees SET ifsc_code = '21312' WHERE id = $1`, [s.emp]);
    try {
      const r = await pay('fin2', paying(c.settlement_id, nextUtr()));
      expect([r.status, r.body.code]).toEqual([422, 'EMPLOYEE_BANK_INVALID']);
      const { rows: [x] } = await pool.query(`SELECT fnf_status FROM exit_requests WHERE id = $1`, [s.exit]);
      expect(x.fnf_status).toBe('approved');
    } finally {
      await pool.query(`UPDATE employees SET ifsc_code = 'HDFC0001234' WHERE id = $1`, [s.emp]);
    }
  });

  it('a good payment: balanced journal, closed exit, loan closed, employee exited, all together', async () => {
    await pool.query(
      `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount, outstanding_balance, start_date, status)
       VALUES ($1, 'Loan', 9000, 1000, 5000, '2026-01-01', 'active')`, [s.emp]);
    const d = await computed(s);
    expect((await approve('fin', d.settlement_id)).status).toBe(200);
    const utr = nextUtr();
    const r = await pay('fin2', paying(d.settlement_id, utr));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ fnf_status: 'paid', status: 'closed', utr });

    const { rows: [je] } = await pool.query(`SELECT total_debit, total_credit, reference_type, reference_id, status FROM journal_entries WHERE id = $1`, [r.body.journal_entry_id]);
    expect(Number(je.total_debit)).toBeGreaterThan(0);
    expect(Number(je.total_debit)).toBe(Number(je.total_credit));
    expect(je).toMatchObject({ reference_type: 'fnf_settlement', reference_id: String(d.settlement_id) });

    const { rows: [loan] } = await pool.query(`SELECT status, outstanding_balance FROM payroll_loans WHERE employee_id = $1`, [s.emp]);
    expect(loan.status).toBe('closed');
    expect(Number(loan.outstanding_balance)).toBe(0);

    const { rows: [e] } = await pool.query(`SELECT status, exit_date FROM employees WHERE id = $1`, [s.emp]);
    expect(e.status).toBe('Left');
    expect((await pay('fin2', paying(d.settlement_id, nextUtr()))).status).toBe(409);
    expect((await computed(s).catch((x) => x.message))).toMatch(/expected|409/i);
  });

  it('a UTR cannot be used twice', async () => {
    const utr = nextUtr();
    await approve('fin');
    expect((await pay('fin2', paying(c.settlement_id, utr))).status).toBe(200);
    const t = await leaver();
    const d = await computed(t);
    await call('fin', 'put', `/exit/fnf/${t.exit}/approve`, { settlement_id: d.settlement_id });
    const r = await call('fin2', 'post', `/exit/fnf/${t.exit}/pay`, paying(d.settlement_id, utr));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('UTR_USED');
  });

  it('a failed journal changes nothing: no account code means no payment at all', async () => {
    await pool.query(
      `UPDATE payroll_statutory_rules SET value = jsonb_set(value, '{gratuity_expense}', 'null') WHERE company_id = $1 AND rule_key = 'settlement.gl'`, [company]);
    try {
      await approve('fin');
      const r = await pay('fin2', paying(c.settlement_id, nextUtr()));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'GL_MAPPING_REQUIRED', missing: ['gratuity_expense'] });
      const { rows: [x] } = await pool.query(`SELECT fnf_status FROM exit_requests WHERE id = $1`, [s.exit]);
      expect(x.fnf_status).toBe('approved');
      expect((await pool.query(`SELECT 1 FROM fnf_settlement_events WHERE settlement_id = $1 AND action = 'pay'`, [c.settlement_id])).rows).toEqual([]);
    } finally {
      await pool.query(
        `UPDATE payroll_statutory_rules SET value = jsonb_set(value, '{gratuity_expense}', to_jsonb($2::text)) WHERE company_id = $1 AND rule_key = 'settlement.gl'`, [company, `ZZG${STAMP}`]);
    }
  });

  it('a settlement missing its basis cannot be approved', async () => {
    const t = await leaver();
    await pool.query(`UPDATE exit_requests SET notice_period = NULL WHERE id = $1`, [t.exit]);
    const d = await computed(t);
    const r = await call('fin', 'put', `/exit/fnf/${t.exit}/approve`, { settlement_id: d.settlement_id });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SETTLEMENT_INCOMPLETE', warnings: ['NOTICE_DAYS_UNKNOWN'] });
  });
});

describe('recording rules through the screen\'s route', () => {
  const body = (value, extra = {}) => ({ rule_key: 'settlement.bonus', effective_from: '2026-11-01', value, source_reference: 'zz letter', ...extra });
  it('a bad value is refused with the reason', async () => {
    const r = await call('admin', 'post', '/payroll/statutory-rules', body({ wage_eligibility: 21000 }));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Missing/);
  });
  it('a good value is saved, whatever payroll is already approved, and the rule then reads as confirmed', async () => {
    const { values } = resolveSettlementRules('2026-11-01');
    const r = await call('admin', 'post', '/payroll/statutory-rules', body({ ...values['settlement.bonus'], calculation_wage: 7500 }, { effective_from: '2026-11-02' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = await call('hr', 'get', '/exit/fnf/rules');
    const bonus = list.body.data.find((x) => x.key === 'settlement.bonus');
    expect(bonus.status).toBe('confirmed');
    expect(bonus.value.calculation_wage).toBe(7500);
  });
  it('a role without the right cannot record one', async () => {
    const { values } = resolveSettlementRules('2026-11-01');
    expect((await call('exec', 'post', '/payroll/statutory-rules', body(values['settlement.bonus']))).status).toBe(403);
  });
  it('HR read the list; the rules appear with their status', async () => {
    const r = await call('hr', 'get', '/exit/fnf/rules');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x) => x.key)).toContain('settlement.gl');
  });
});
