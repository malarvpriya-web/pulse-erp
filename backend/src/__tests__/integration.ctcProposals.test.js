/**
 * CTC-driven salary system — PAYROLL_DATA_FLOW_AUDIT.md Part 4 / Phase 2.
 *
 * Real routers, real database, two throwaway companies, synthetic employees.
 * No real salary, payroll run or statutory setting is read or written.
 *
 * Fixture "CTC-30K": company-specific copy of the Standard Structure, Basic
 * ₹30,000/month, Karnataka, effective 1-Oct-2026 (₹25,000 PF ceiling):
 *   monthly gross 75,000 · employer PF 12% × 25,000 = 3,000/month
 *   Code wages = max(30,000, 50% × 75,000) = 37,500
 *   annual: gross 9,00,000 + employer PF 36,000 + ESI 0 + LWF 100
 *           + gratuity 15/26 × 37,500 = 21,635  →  annual CTC 9,57,735
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

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { default: payrollRoutes }   = await import('../modules/payroll/payroll.routes.js');
const { default: salaryRoutes }    = await import('../modules/payroll/salaryStructure.routes.js');
const { default: settingsRoutes }  = await import('../modules/admin/settings-status.routes.js');
const { default: incrementRoutes } = await import('../modules/performance/routes/increments.routes.js');
const { default: recruitmentRoutes } = await import('../modules/recruitment/routes/recruitment.routes.js');
const { CTC_RULE_KEYS }            = await import('../modules/payroll/ctcService.js');

const app = buildApp(
  ['/api/payroll', verifyToken, payrollRoutes],
  ['/api/salary-structures', verifyToken, salaryRoutes],
  ['/api/settings', verifyToken, settingsRoutes],
  ['/api/performance/increments', verifyToken, incrementRoutes],
  ['/api/recruitment', verifyToken, recruitmentRoutes],
);

const PREFIX = 'ZZCTCPRO';
let co, other, approver, payer;   // payer: PC-01 D2/Q1 — finance_manager, never the preparer
const E = {};
let structureId;
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);

const STANDARD = [
  { name: 'Basic', type: 'earning', value: 40, calculation_type: 'percentage_of_ctc' },
  { name: 'HRA', type: 'earning', value: 40, calculation_type: 'percentage_of_basic' },
  { name: 'Conveyance', type: 'earning', value: 1600, calculation_type: 'fixed' },
  { name: 'Medical', type: 'earning', value: 1250, calculation_type: 'fixed' },
  { name: 'Special Allowance', type: 'earning', value: 0, calculation_type: 'balancing' },
];
const POLICY = {
  version: 'TEST-A2-ESI', include: { employer_pf: true, employer_esi: true, employer_lwf: true, gratuity: true },
  gratuity: { base: 'code_wages', from: 'joining', days_per_year: 15, divisor: 26 },
  rules_basis: 'effective_date', residual: 'report', maker_checker: true,
};

async function sweep(companyId) {
  const emps = `(SELECT id FROM employees WHERE company_id = $1)`;
  // Parallel suites delete from the same tables (employees, journals); Postgres
  // aborts one side of a deadlock (40P01). Retry so the sweep never stops halfway
  // and leaves this suite's companies behind.
  const q = async (sql) => {
    for (let attempt = 1; ; attempt++) {
      try { return await pool.query(sql, [companyId]); } catch (e) {
        if (e.code !== '40P01' || attempt >= 4) throw e;
        await new Promise(r => { setTimeout(r, 200 * attempt); });
      }
    }
  };
  await q(`DELETE FROM increment_recommendations WHERE company_id = $1 OR employee_id IN ${emps}`);
  await q(`DELETE FROM salary_revision_proposals WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps})`);
  await q(`DELETE FROM journal_entries WHERE reference_type = 'salary_disbursement' AND split_part(reference_id, '-', 1)::int IN ${emps}`);
  await q(`DELETE FROM journal_lines WHERE company_id = $1`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payslip_email_log WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_transactions WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM tds_deductees WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_runs WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM employee_salary_assignments WHERE employee_id IN ${emps}`);
  await q(`DELETE FROM payroll_statutory_rules WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
  await q(`DELETE FROM employees WHERE company_id = $1`);
  await q(`DELETE FROM offer_letters WHERE company_id = $1`);
  await q(`DELETE FROM candidates WHERE company_id = $1`);
  await q(`DELETE FROM salary_structures WHERE company_id = $1`);
}

async function addEmployee(company, code, fields = {}) {
  const f = { first_name: code, last_name: 'Ctc', status: 'Active', joining_date: '2026-04-01',
    pan_number: 'ABCDE1234F', account_number: '123456789012', ifsc_code: 'HDFC0001234', uan_number: '100200300400', ...fields };
  const cols = Object.keys(f);
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [company.companyId, code, ...cols.map(c => f[c])]);
  return r.id;
}

/** Record every statutory rule (and the CTC policy) a date depends on, as an authorised user would. */
async function confirmForDate(who, date, keys) {
  const r = await call(who, 'get', `/api/payroll/statutory-rules?date=${date}`);
  for (const k of keys) {
    const a = r.body.data.applied[k];
    if (a.status === 'verified' && a.origin !== 'built-in') continue;
    if (a.status === 'verified') continue;
    const res = await call(who, 'post', '/api/payroll/statutory-rules')
      .send({ rule_key: k, effective_from: a.effective_from, value: r.body.data.resolved[k], source_reference: `CTC test confirmation ${k}` });
    if (res.status !== 201) throw new Error(`confirm ${k}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  await pool.query(`UPDATE companies SET state = 'Karnataka', tan = 'BLRZ12345A' WHERE id = ANY($1)`, [[co.companyId, other.companyId]]);
  // a second authorised user in `co` for maker-checker
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active, role) VALUES ($1, $2, 'x', $3, true, 'admin') RETURNING id`,
    [`${co.code} approver`, `${co.code.toLowerCase()}.approver@test.invalid`, co.companyId]);
  const { rows: [role] } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = 'admin' LIMIT 1`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [u.id, role.id]);
  approver = { token: () => jwt.sign({ userId: u.id, role: 'admin', company_id: co.companyId, employee_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  payer = await addUser(pool, co, { label: 'payer', roleCode: 'finance_manager' });
  const { rows: [s] } = await pool.query(
    `INSERT INTO salary_structures (name, description, is_default, components, company_id) VALUES ('CTC test structure', 'fixture', true, $1, $2) RETURNING id`,
    [JSON.stringify(STANDARD), co.companyId]);
  structureId = s.id;
  E.X = await addEmployee(co, 'EMP001');
  E.Y = await addEmployee(co, 'EMP002');
  await pool.query(`INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary) VALUES ($1, $2, '2026-04-01', 30000)`, [E.Y, structureId]);
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

describe('CTC service through the API (preview — no write)', () => {
  it('₹30,000 monthly Basic → ₹75,000 monthly gross and the A2 annual CTC, component by component', async () => {
    const r = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, employee_id: E.X, effective_from: '2026-10-01', basic_monthly: 30000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body.breakdown;
    expect(b.monthly.gross).toBe(75000);
    expect(b.monthly.employer).toMatchObject({ pf: 3000, esi: 0 });
    expect(b.annual).toEqual({ gross: 900000, employer_pf: 36000, employer_esi: 0, employer_lwf: 100, gratuity: 21635, ctc: 957735 });
    // reconciles exactly: no component counted twice, gratuity outside gross
    expect(b.annual.gross + b.annual.employer_pf + b.annual.employer_esi + b.annual.employer_lwf + b.annual.gratuity).toBe(b.annual.ctc);
    expect(b.monthly_ctc_equivalent).toBe(79811);
  });

  it('annual CTC → monthly Basic round-trips; the rounding gap is reported, not absorbed', async () => {
    const exact = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, employee_id: E.X, effective_from: '2026-10-01', annual_ctc: 957735 });
    expect(exact.body).toMatchObject({ basic_monthly: 30000, rounding_residual: 0 });
    const ten = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, employee_id: E.X, effective_from: '2026-10-01', annual_ctc: 1000000 });
    expect(ten.body.breakdown.annual.ctc + ten.body.rounding_residual).toBe(1000000);
    expect(ten.body.rounding_residual).toBeGreaterThanOrEqual(0);
  });

  it('monthly and annual inputs cannot be confused', async () => {
    const monthlyAsAnnual = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, effective_from: '2026-10-01', annual_ctc: 50000 });
    expect(monthlyAsAnnual.status).toBe(422);
    expect(monthlyAsAnnual.body.message).toMatch(/looks like a MONTHLY figure/);
    const annualAsMonthly = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, effective_from: '2026-10-01', basic_monthly: 900000 });
    expect(annualAsMonthly.status).toBe(422);
    const both = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, effective_from: '2026-10-01', basic_monthly: 30000, annual_ctc: 957735 });
    expect(both.status).toBe(400);
  });

  it('an unrecorded CTC policy or unverified rule blocks finalisation instead of producing a final figure', async () => {
    const r = await call(co, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, effective_from: '2026-10-01', basic_monthly: 30000 });
    expect(r.body.finalisable).toBe(false);
    expect(r.body.blockers.map(b => b.code)).toContain('CTC_POLICY_NOT_RECORDED');
  });
});

describe('proposal workflow', () => {
  let pid;
  it('is refused while the company has CTC mode off', async () => {
    const r = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.X, structure_id: structureId, effective_from: '2026-10-01', annual_ctc: 957735 });
    expect(r.status).toBe(409);
  });

  it('switching CTC mode on blocks the direct Assign path', async () => {
    expect((await call(co, 'post', '/api/settings/payroll').send({ ctc_mode: true, statutory_state: 'Karnataka', pay_day_of_month: 25, payroll_cutoff_day: 20 })).status).toBe(200);
    const direct = await call(co, 'post', `/api/salary-structures/${structureId}/assign`).send({ employee_id: E.X, basic_salary: 30000, effective_from: '2026-10-01' });
    expect(direct.status).toBe(409);
    expect(direct.body.code).toBe('CTC_MODE');
  });

  it('a draft proposal is invisible to payroll', async () => {
    const r = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.X, structure_id: structureId, effective_from: '2026-10-01', annual_ctc: 957735 });
    expect(r.status).toBe(201);
    pid = r.body.proposal.id;
    expect(r.body.proposal).toMatchObject({ status: 'draft', entry_mode: 'annual_ctc' });
    expect(Number(r.body.proposal.basic_monthly)).toBe(30000);
    const elig = await call(co, 'get', '/api/payroll/eligibility?month=10&year=2026');
    expect(elig.body.data.employees.find(e => e.employee_id === E.X)).toMatchObject({ eligible: false });
    expect((await pool.query('SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1', [E.X])).rows).toHaveLength(0);
  });

  it('maker-checker: the preparer cannot approve; finalisation needs the policy and rules recorded', async () => {
    expect((await call(co, 'post', `/api/salary-structures/proposals/${pid}/approve`)).status).toBe(403);
    const blocked = await call(approver, 'post', `/api/salary-structures/proposals/${pid}/approve`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.blockers.map(b => b.code)).toContain('CTC_POLICY_NOT_RECORDED');
    const pol = await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'ctc.definition', effective_from: '2025-04-01', value: POLICY, source_reference: 'CTC test policy approval' });
    expect(pol.status).toBe(201);
    const badPol = await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'ctc.definition', effective_from: '2025-05-01', value: { version: 'x' }, source_reference: 'bad' });
    expect(badPol.status).toBe(400);
    await confirmForDate(co, '2026-10-01', CTC_RULE_KEYS);
  });

  it('approval writes ONE revision with the approved breakdown and updates the current Basic', async () => {
    const r = await call(approver, 'post', `/api/salary-structures/proposals/${pid}/approve`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { rows: [a] } = await pool.query('SELECT * FROM employee_salary_assignments WHERE employee_id = $1', [E.X]);
    expect({ entry_mode: a.entry_mode, ctc_policy_version: a.ctc_policy_version, company_id: a.company_id, proposal_id: a.proposal_id }).toMatchObject({ entry_mode: 'annual_ctc', ctc_policy_version: 'TEST-A2-ESI', company_id: co.companyId, proposal_id: pid });
    expect(Number(a.annual_ctc)).toBe(957735);
    expect(a.breakdown.monthly.gross).toBe(75000);
    const { rows: [e] } = await pool.query('SELECT basic_salary FROM employees WHERE id = $1', [E.X]);
    expect(Number(e.basic_salary)).toBe(30000);
    expect((await call(approver, 'post', `/api/salary-structures/proposals/${pid}/approve`)).status).toBe(409);
  });

  it('payroll pays the APPROVED components even after the structure is edited', async () => {
    await call(co, 'put', `/api/salary-structures/${structureId}`).send({ components: STANDARD.map(c => (c.name === 'HRA' ? { ...c, value: 50 } : c)) });
    const g = await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.X });
    expect(g.body.data.count).toBe(1);
    const slip = g.body.data.data[0];
    expect(slip).toMatchObject({ gross: 75000, hra: 12000, salary_source: 'approved_breakdown' });
    // a legacy Basic revision on the same (edited) structure IS recomputed: HRA 50%
    const gy = await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026, employee_id: E.Y });
    expect(gy.body.data.data[0]).toMatchObject({ hra: 15000, salary_source: 'structure' });
    await call(co, 'put', `/api/salary-structures/${structureId}`).send({ components: STANDARD });
  });

  it('approval is refused when the structure moved money between components after the draft, even with equal totals', async () => {
    const r = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.Y, structure_id: structureId, effective_from: '2026-12-01', basic_monthly: 31000 });
    expect(r.status).toBe(201);
    await call(co, 'put', `/api/salary-structures/${structureId}`).send({ components: STANDARD.map(c => (c.name === 'Conveyance' ? { ...c, value: 2600 } : c)) });
    const moved = await call(approver, 'post', `/api/salary-structures/proposals/${r.body.proposal.id}/approve`);
    await call(co, 'put', `/api/salary-structures/${structureId}`).send({ components: STANDARD });
    expect(moved.status).toBe(409);
    expect((await pool.query('SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1 AND effective_from = $2', [E.Y, '2026-12-01'])).rows).toHaveLength(0);
    const rej = await call(approver, 'post', `/api/salary-structures/proposals/${r.body.proposal.id}/reject`).send({ note: 'split changed' });
    expect(rej.status).toBe(200);
    expect((await call(approver, 'post', `/api/salary-structures/proposals/${r.body.proposal.id}/approve`)).status).toBe(409);
  });

  it('arrears still compare the two Basics when a CTC revision is in force', async () => {
    const r = await call(co, 'get', `/api/payroll/arrears/compute?employee_id=${E.X}&from_month=10&from_year=2026&to_month=10&to_year=2026&old_basic=28000&new_basic=30000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.total_arrear).toBe(5000);
  });

  it('payroll approval, payment, payslip and ledger stay consistent for a CTC revision', async () => {
    await call(co, 'post', '/api/payroll/generate').send({ month: 10, year: 2026 });
    const ready = await call(co, 'get', '/api/payroll/release-readiness?month=10&year=2026');
    const rk = ready.body.data.blockers.filter(b => b.code.startsWith('RULE_')).map(b => b.key);
    await confirmForDate(co, '2026-10-31', rk);
    const ap = await call(approver, 'post', '/api/payroll/approve').send({ month: 10, year: 2026 });   // a different user than the preparer
    expect(ap.status).toBe(200);
    const ps = (await call(co, 'get', `/api/payroll/payslips?employee_id=${E.X}&month=10&year=2026`)).body.data;
    expect(ps.contract).toMatchObject({ annual_ctc: 957735 });
    expect(ps.gross).toBe(75000);
    expect(ps.ctc_monthly).toBe(78000);                       // employer cost of the month, not the contract
    expect(ps.deductions.reduce((s, d) => s + d.amount, 0)).toBe(ps.total_deductions);
    expect((await call(payer, 'post', `/api/payroll/${E.X}/mark-paid`).send({ month: 10, year: 2026, reference: 'CTCUTRX0000001', value_date: new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) })).status).toBe(200);
    const { rows: [gl] } = await pool.query(
      `SELECT SUM(jl.debit)::numeric d FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.company_id = $1 AND je.reference_type = 'payroll_run'`, [co.companyId]);
    const { rows: [runs] } = await pool.query(
      `SELECT SUM(pr.ctc_monthly)::numeric c FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id WHERE e.company_id = $1 AND pr.month = 10 AND pr.year = 2026`, [co.companyId]);
    expect(Number(gl.d)).toBe(Number(runs.c));
  });
});

describe('offer conversion', () => {
  let offerId;
  it('converts an accepted offer once, into a draft for the hired employee', async () => {
    const { rows: [cand] } = await pool.query(
      `INSERT INTO candidates (company_id, full_name, email) VALUES ($1, 'Offer Ctc', 'offer.ctc@test.invalid') RETURNING id`, [co.companyId]);
    const { rows: [o] } = await pool.query(
      `INSERT INTO offer_letters (candidate_id, offered_salary, offer_status, company_id, joining_date) VALUES ($1, 900000, 'accepted', $2, '2026-11-01') RETURNING id`,
      [cand.id, co.companyId]);
    offerId = o.id;
    const before = await call(co, 'post', `/api/recruitment/offers/${offerId}/salary-proposal`);
    expect(before.status).toBe(409);                         // not hired yet
    E.Z = await addEmployee(co, 'EMP003', { source_candidate_id: cand.id, joining_date: '2026-11-01' });
    const first = await call(co, 'post', `/api/recruitment/offers/${offerId}/salary-proposal`);
    expect(first.status).toBe(201);
    expect(first.body.proposal).toMatchObject({ source_type: 'offer', source_id: String(offerId), status: 'draft' });
    expect(first.body.preview.breakdown.annual.ctc + first.body.preview.rounding_residual).toBe(900000);
    expect((await call(co, 'post', `/api/recruitment/offers/${offerId}/salary-proposal`)).status).toBe(409);
  });

  it('cannot be converted from another company', async () => {
    const r = await call(other, 'post', `/api/recruitment/offers/${offerId}/salary-proposal`);
    expect(r.status).toBe(404);
  });
});

describe('increments on annual CTC', () => {
  it('a future-dated increment becomes a proposal and, once approved, leaves today\'s salary unchanged', async () => {
    const rec = await call(co, 'post', '/api/performance/increments/recommendations').send({ employee_id: E.X, recommended_increment_pct: 10, effective_date: '2027-04-01' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(Number(rec.body.current_annual_ctc)).toBe(957735);
    expect(Number(rec.body.new_annual_ctc)).toBe(1053509);   // 9,57,735 × 1.10, rounded
    await pool.query(`UPDATE increment_recommendations SET status = 'approved', final_new_ctc = recommended_new_ctc WHERE id = $1`, [rec.body.id]);
    const push = await call(co, 'post', `/api/performance/increments/recommendations/${rec.body.id}/push-payroll`);
    expect(push.status).toBe(201);
    expect(push.body.proposal).toMatchObject({ source_type: 'increment', status: 'draft' });
    await confirmForDate(co, '2027-04-01', CTC_RULE_KEYS);
    const ok = await call(approver, 'post', `/api/salary-structures/proposals/${push.body.proposal.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.in_force_today).toBe(false);
    const { rows } = await pool.query(`SELECT effective_from::text, basic_salary FROM employee_salary_assignments WHERE employee_id = $1 ORDER BY effective_from`, [E.X]);
    expect(rows.map(r => r.effective_from)).toEqual(['2026-10-01', '2027-04-01']);
    expect(Number(rows[0].basic_salary)).toBe(30000);        // previous revision preserved
    const { rows: [e] } = await pool.query('SELECT basic_salary FROM employees WHERE id = $1', [E.X]);
    expect(Number(e.basic_salary)).toBe(30000);              // current salary untouched until April
    expect((await call(co, 'post', `/api/performance/increments/recommendations/${rec.body.id}/push-payroll`)).status).toBe(409);
  });
});

describe('shared templates and company structures', () => {
  it('a company cannot edit a shared template, can copy it, and cannot see another company\'s structures', async () => {
    const list = (await call(co, 'get', '/api/salary-structures')).body;
    const shared = list.find(s => s.shared);
    expect(shared).toBeTruthy();
    expect((await call(co, 'put', `/api/salary-structures/${shared.id}`).send({ description: 'tamper' })).status).toBe(403);
    const copy = await call(co, 'post', `/api/salary-structures/${shared.id}/copy`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ company_id: co.companyId, template_id: shared.id, is_default: false });
    const otherList = (await call(other, 'get', '/api/salary-structures')).body.map(s => s.id);
    expect(otherList).not.toContain(structureId);
    expect(otherList).not.toContain(copy.body.id);
    const peek = await call(other, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, effective_from: '2026-10-01', basic_monthly: 30000 });
    expect(peek.status).toBe(404);
  });

  it('another company can neither propose for nor approve this company\'s employees', async () => {
    await call(other, 'post', '/api/settings/payroll').send({ ctc_mode: true, pay_day_of_month: 25, payroll_cutoff_day: 20 });
    expect((await call(other, 'post', '/api/salary-structures/proposals').send({ employee_id: E.Y, effective_from: '2026-12-01', basic_monthly: 31000 })).status).toBe(404);
    const { rows: [p] } = await pool.query(`SELECT id FROM salary_revision_proposals WHERE company_id = $1 AND status = 'draft' LIMIT 1`, [co.companyId]);
    expect((await call(other, 'post', `/api/salary-structures/proposals/${p.id}/approve`)).status).toBe(404);
  });
});

describe('Phase 3 validation (PAYROLL_DATA_FLOW_AUDIT.md Part 6)', () => {
  const preview = (who, body) => call(who, 'post', '/api/salary-structures/ctc-preview').send({ structure_id: structureId, ...body });

  it('rules follow the effective date: the PF ceiling moves from ₹15,000 to ₹25,000 on 17-Sep-2026, not on the 1st', async () => {
    const before = (await preview(co, { employee_id: E.X, effective_from: '2026-09-16', basic_monthly: 30000 })).body.breakdown;
    const after = (await preview(co, { employee_id: E.X, effective_from: '2026-09-17', basic_monthly: 30000 })).body.breakdown;
    expect(before.monthly.employer.pf).toBe(1800);              // 12% × 15,000
    expect(after.monthly.employer.pf).toBe(3000);               // 12% × 25,000
    expect(after.annual.ctc - before.annual.ctc).toBe(12 * 1200);
    expect(before.annual.gratuity).toBe(after.annual.gratuity); // Code wages are not capped by the PF ceiling
  });

  it('monthly gross, take-home, employer cost and annual CTC are separate figures that reconcile', async () => {
    const b = (await preview(co, { employee_id: E.X, effective_from: '2026-10-01', basic_monthly: 30000 })).body.breakdown;
    const m = b.monthly;
    expect(m.take_home_before_tds).toBe(m.gross - m.employee.pf - m.employee.esi - m.employee.pt);
    expect(m.employee.pf).toBe(3000);
    expect(b.annual.gross).toBe(12 * m.gross);
    expect(b.annual.employer_pf).toBe(12 * m.employer.pf);
    expect(b.monthly_ctc_equivalent).toBe(Math.round(b.annual.ctc / 12));
    expect(new Set([m.gross, m.take_home_before_tds, b.monthly_ctc_equivalent, b.annual.ctc]).size).toBe(4);
  });

  it('an ESI-covered salary carries employer ESI and still reconciles to the rupee', async () => {
    const r = (await preview(co, { employee_id: E.X, effective_from: '2026-10-01', annual_ctc: 250000 })).body;
    const a = r.breakdown.annual;
    expect(r.breakdown.esi_covered).toBe(true);
    expect(a.employer_esi).toBe(12 * r.breakdown.monthly.employer.esi);
    expect(a.employer_esi).toBeGreaterThan(0);
    expect(a.gross + a.employer_pf + a.employer_esi + a.employer_lwf + a.gratuity).toBe(a.ctc);
    expect(a.ctc + r.rounding_residual).toBe(250000);
  });

  it('a proposal is refused for a date that already has a revision, or inside an approved payroll month', async () => {
    const clash = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.X, structure_id: structureId, effective_from: '2027-04-01', basic_monthly: 31000 });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/never overwritten/);
    const closed = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.X, structure_id: structureId, effective_from: '2026-10-01', basic_monthly: 31000 });
    expect(closed.status).toBe(422);
    expect(closed.body.message).toMatch(/already approved/);
  });

  it('a policy change between draft and approval is refused, not applied silently', async () => {
    E.W = await addEmployee(co, 'EMP004');
    const d = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.W, structure_id: structureId, effective_from: '2027-01-01', annual_ctc: 957735 });
    expect(d.status).toBe(201);
    const noGratuity = { ...POLICY, version: 'TEST-NO-GRATUITY', include: { ...POLICY.include, gratuity: false } };
    expect((await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'ctc.definition', effective_from: '2027-01-01', value: noGratuity, source_reference: 'CTC test policy change' })).status).toBe(201);
    await confirmForDate(co, '2027-01-01', CTC_RULE_KEYS);
    const r = await call(approver, 'post', `/api/salary-structures/proposals/${d.body.proposal.id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.was.annual_ctc).not.toBe(r.body.now.annual_ctc);
    expect((await pool.query('SELECT 1 FROM employee_salary_assignments WHERE employee_id = $1', [E.W])).rows).toHaveLength(0);
    // restore the tested policy for any later date
    await call(co, 'post', '/api/payroll/statutory-rules').send({ rule_key: 'ctc.definition', effective_from: '2027-01-02', value: POLICY, source_reference: 'CTC test policy restore' });
  });

  it('"in force today" uses the database date — the same one that updates the current Basic', async () => {
    const today = (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
    await confirmForDate(co, today, CTC_RULE_KEYS);
    const d = await call(co, 'post', '/api/salary-structures/proposals').send({ employee_id: E.W, structure_id: structureId, effective_from: today, basic_monthly: 32000 });
    expect(d.status).toBe(201);
    const r = await call(approver, 'post', `/api/salary-structures/proposals/${d.body.proposal.id}/approve`);
    expect(r.status).toBe(200);
    const { rows: [e] } = await pool.query('SELECT basic_salary FROM employees WHERE id = $1', [E.W]);
    expect(r.body.in_force_today).toBe(true);
    expect(Number(e.basic_salary)).toBe(32000);
  });

  it('a rejected offer proposal can be prepared again; a live one cannot', async () => {
    const { rows: [p] } = await pool.query(`SELECT id, source_id FROM salary_revision_proposals WHERE company_id = $1 AND source_type = 'offer' AND status = 'draft'`, [co.companyId]);
    expect((await call(co, 'post', `/api/recruitment/offers/${p.source_id}/salary-proposal`)).status).toBe(409);
    expect((await call(approver, 'post', `/api/salary-structures/proposals/${p.id}/reject`).send({ note: 'redo' })).status).toBe(200);
    const again = await call(co, 'post', `/api/recruitment/offers/${p.source_id}/salary-proposal`);
    expect(again.status).toBe(201);
    expect(again.body.proposal.id).not.toBe(p.id);
  });

  it('another company cannot recommend, push or read this company\'s increments', async () => {
    expect((await call(other, 'post', '/api/performance/increments/recommendations').send({ employee_id: E.X, recommended_increment_pct: 5, effective_date: '2027-06-01' })).status).not.toBe(201);
    const { rows: [rec] } = await pool.query(`SELECT id FROM increment_recommendations WHERE company_id = $1 LIMIT 1`, [co.companyId]);
    const before = (await pool.query('SELECT COUNT(*)::int n FROM salary_revision_proposals')).rows[0].n;
    const pp = await call(other, 'post', `/api/performance/increments/recommendations/${rec.id}/push-payroll`);
    expect([400, 403, 404]).toContain(pp.status);          // route answers 400 "not found or not approved"
    expect((await pool.query('SELECT COUNT(*)::int n FROM salary_revision_proposals')).rows[0].n).toBe(before);
  });
});
