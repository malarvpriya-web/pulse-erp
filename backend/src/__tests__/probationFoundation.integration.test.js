/**
 * Probation foundation — tenant isolation and one date rule, against the live
 * database.
 *
 *   - /probation: every read and write is scoped to the caller's company; a
 *     caller with no company context is refused; recipients are resolved by id
 *     inside the company, and super-admin copies stay inside it.
 *   - Policy: six months / fourteen days by default, per-company overrides.
 *   - Add / Edit Employee: the stored probation_end_date follows the shared
 *     rule, and survives unrelated edits.
 *   - Daily reminder job: a date window (a missed run is caught up), company
 *     scope, durable once-per-end-date de-duplication, safe under concurrency.
 *   - Leave and the dashboard alert read the STORED date, never a recalculated
 *     joining_date + 90 / 165..180 days.
 *
 * Fixtures live in three registry tenants (testTenantIds.contract.test.js) and
 * are deleted in afterAll. ⚠ Do not run this while a Playwright crawl is going.
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
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { default: probationRouter } = await import('../probation/probation.routes.js');
const { default: leavesRouter } = await import('../modules/leaves/routes/leaves.routes.js');
const { getDashboardAlerts } = await import('../modules/dashboard/dashboard.controller.js');
const { addEmployee, updateEmployee } = await import('../employees/employee.service.js');
const { runProbationCheck } = await import('../jobs/probation.cron.js');
const { probationEndDate } = await import('../shared/probationDates.js');

const OWN = 999960;
const FOREIGN = 999961;
const LONELY = 999962;          // a company with a probationer and nobody to tell
const COMPANIES = [OWN, FOREIGN, LONELY];
const PW = 'Zz-Prob-Test-9!';
const fx = { tok: {}, emp: {}, user: {}, log: {} };

const app = express();
app.use(express.json());
app.use('/api/probation', probationRouter);
app.use('/api/leaves', verifyToken, leavesRouter);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });

/** Date arithmetic on calendar dates, in UTC. */
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const emailLike = `zz.prob.%@example.com`;
async function cleanup() {
  const c = COMPANIES;
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  const users = `SELECT id FROM users WHERE email LIKE '${emailLike}' OR employee_id IN (${emps})`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM probation_notifications WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM probation_reminder_log WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`, [c]);
  await pool.query(`DELETE FROM users WHERE email LIKE '${emailLike}' OR employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`DELETE FROM hr_onboarding_checklist_progress WHERE employee_id IN (${emps})`, [c]);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = ANY($1::int[])`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let dept; let desig; let today;
let seq = 0;
async function emp(key, cid, { status = 'Active', joining = '2026-01-15', end = null, managerKey = null } = {}) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, probation_end_date, reporting_manager_id)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [cid, `EMP96${String(seq).padStart(4, '0')}`, key, `zz.prob.emp.${key}@example.com`, dept, desig,
      status, joining, end, managerKey ? fx.emp[managerKey] : null])).rows[0].id;
  return fx.emp[key];
}
async function login(key, role, cid, employeeId = null) {
  const email = `zz.prob.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, cid, employeeId])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}
const notificationsFor = async (userKey, employeeId) => (await pool.query(
  `SELECT notification_type, module_name, title FROM notifications
    WHERE user_id = $1 AND reference_id = $2 ORDER BY id`, [fx.user[userKey], employeeId])).rows;
const ledger = async (employeeId) => (await pool.query(
  `SELECT reminder_kind, probation_end_date::text AS end_date, recipient_count, company_id
     FROM probation_reminder_log WHERE employee_id = $1 ORDER BY id`, [employeeId])).rows;
const row = async (id) => (await pool.query(
  `SELECT status, probation_end_date::text AS end, probation_months, confirmation_date FROM employees WHERE id = $1`,
  [id])).rows[0];

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES
    ($1,'ZZ Prob Own','ZZPBO'), ($2,'ZZ Prob Foreign','ZZPBF'), ($3,'ZZ Prob Lonely','ZZPBL')`, COMPANIES);
  dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  today = (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;

  // FOREIGN has its own policy; OWN and LONELY have none (defaults).
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at)
     VALUES ($1, 'recruitment', '{"probation_months": 3, "probation_review_reminder_days": 10, "offer_validity_days": 7}'::jsonb, NOW())`,
    [FOREIGN]);

  await emp('mgr', OWN);
  await emp('subject', OWN, { status: 'Probation', end: '2026-11-30', managerKey: 'mgr' });
  await emp('undated', OWN, { status: 'Probation', end: null });
  await emp('activeRecent', OWN, { status: 'Active', joining: addDays(today, -30) });
  await emp('fMgr', FOREIGN);
  await emp('fSubject', FOREIGN, { status: 'Probation', end: '2026-11-30', managerKey: 'fMgr' });
  await emp('lonely', LONELY, { status: 'Probation', end: '2026-11-30' });

  await login('hr', 'hr', OWN);
  await login('super', 'super_admin', OWN);
  await login('mgr', 'employee', OWN, fx.emp.mgr);
  await login('fHr', 'hr', FOREIGN);
  await login('fSuper', 'super_admin', FOREIGN);
  await login('globalSuper', 'super_admin', null);
  await login('noCompanyHr', 'hr', null);

  // One legacy log row per company, as the old screen wrote them.
  const log = async (key, employeeId) => {
    fx.log[key] = (await pool.query(
      `INSERT INTO probation_notifications (employee_id, notified_to, notified_role, notification_type)
       VALUES ($1, 'Someone', 'Manager', 'probation_due') RETURNING id`, [employeeId])).rows[0].id;
  };
  await log('own', fx.emp.subject);
  await log('foreign', fx.emp.fSubject);
}, 60000);

afterAll(cleanup);

/* ───────────────────────────── /probation isolation ───────────────────────────── */

describe('GET /probation is company-scoped', () => {
  it('returns only the caller company\'s records', async () => {
    const own = await request(app).get('/api/probation').set(as('hr'));
    expect(own.status).toBe(200);
    const ids = own.body.map((r) => r.id);
    expect(ids).toContain(fx.log.own);
    expect(ids).not.toContain(fx.log.foreign);

    const foreign = await request(app).get('/api/probation').set(as('fHr'));
    expect(foreign.body.map((r) => r.id)).toContain(fx.log.foreign);
    expect(foreign.body.map((r) => r.id)).not.toContain(fx.log.own);
  });

  it('refuses every route to a caller with no company context', async () => {
    for (const [method, url, body] of [
      ['get', '/api/probation'],
      ['get', '/api/probation/settings'],
      ['put', '/api/probation/settings', { probation_months: 6 }],
      ['get', '/api/probation/calculate?joining_date=2026-01-15'],
      ['post', '/api/probation', { employee_id: fx.emp.subject, notified_to_employee_id: fx.emp.mgr }],
      ['put', `/api/probation/${fx.log.own}`, { decision: 'confirmed' }],
    ]) {
      const res = await request(app)[method](url).set(as('noCompanyHr')).send(body);
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(403);
    }
    // ...and a global super admin is not a company either.
    expect((await request(app).get('/api/probation').set(as('globalSuper'))).status).toBe(403);
  });

  it('cannot record a decision on another company\'s record', async () => {
    const byId = await request(app).put(`/api/probation/${fx.log.foreign}`).set(as('hr'))
      .send({ decision: 'confirmed', performance_rating: 5, comments: 'cross-tenant' });
    expect(byId.status).toBe(404);
    const byEmp = await request(app).put(`/api/probation/by-employee/${fx.emp.fSubject}`).set(as('hr'))
      .send({ decision: 'confirmed' });
    expect(byEmp.status).toBe(404);
    const { rows: [r] } = await pool.query(`SELECT decision, status FROM probation_notifications WHERE id = $1`, [fx.log.foreign]);
    expect(r).toEqual({ decision: null, status: 'pending' });
  });

  it('records a decision on its own record', async () => {
    const res = await request(app).put(`/api/probation/${fx.log.own}`).set(as('hr'))
      .send({ decision: 'extended', performance_rating: 3, comments: 'own' });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('extended');
  });
});

describe('POST /probation resolves recipients inside the company', () => {
  it('refuses a foreign employee, a foreign recipient and a bare name', async () => {
    const foreignEmp = await request(app).post('/api/probation').set(as('hr'))
      .send({ employee_id: fx.emp.fSubject, notified_to_employee_id: fx.emp.mgr });
    expect(foreignEmp.status).toBe(404);
    const foreignRecipient = await request(app).post('/api/probation').set(as('hr'))
      .send({ employee_id: fx.emp.subject, notified_to_employee_id: fx.emp.fMgr });
    expect(foreignRecipient.status).toBe(400);
    const byName = await request(app).post('/api/probation').set(as('hr'))
      .send({ employee_id: fx.emp.subject, notified_to: 'Zz mgr' });
    expect(byName.status).toBe(400);
    expect(await notificationsFor('fSuper', fx.emp.subject)).toHaveLength(0);
  });

  it('notifies the chosen colleague and THIS company\'s super admins only', async () => {
    const res = await request(app).post('/api/probation').set(as('hr'))
      .send({ employee_id: fx.emp.subject, notified_to_employee_id: fx.emp.mgr, notification_type: 'approval' });
    expect(res.status).toBe(200);
    expect(res.body.recipient_has_login).toBe(true);
    expect(res.body.delivered_to).toBe(2);
    expect(await notificationsFor('mgr', fx.emp.subject)).toHaveLength(1);
    expect(await notificationsFor('super', fx.emp.subject)).toHaveLength(1);
    expect(await notificationsFor('fSuper', fx.emp.subject)).toHaveLength(0);
    expect(await notificationsFor('globalSuper', fx.emp.subject)).toHaveLength(0);
    expect(await notificationsFor('fHr', fx.emp.subject)).toHaveLength(0);
  });
});

/* ───────────────────────────── policy ───────────────────────────── */

describe('probation policy', () => {
  it('defaults to six months and fourteen days when a company has none', async () => {
    const res = await request(app).get('/api/probation/settings').set(as('hr'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ probation_months: 6, reminder_days: 14, months_is_default: true, reminder_days_is_default: true });
  });

  it('reads each company\'s own values', async () => {
    const res = await request(app).get('/api/probation/settings').set(as('fHr'));
    expect(res.body).toMatchObject({ probation_months: 3, reminder_days: 10, months_is_default: false });
  });

  it('saves for the caller\'s company only, merging into the existing document', async () => {
    const bad = await request(app).put('/api/probation/settings').set(as('fHr')).send({ probation_months: 0 });
    expect(bad.status).toBe(400);
    const res = await request(app).put('/api/probation/settings').set(as('fHr')).send({ probation_months: 4 });
    expect(res.status).toBe(200);
    expect(res.body.probation_months).toBe(4);
    const { rows: [s] } = await pool.query(`SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'recruitment'`, [FOREIGN]);
    expect(s.settings).toMatchObject({ probation_months: 4, probation_review_reminder_days: 10, offer_validity_days: 7 });
    expect((await request(app).get('/api/probation/settings').set(as('hr'))).body.probation_months).toBe(6);
    await request(app).put('/api/probation/settings').set(as('fHr')).send({ probation_months: 3 });
  });

  it('an invalid stored value falls back to the default rather than being used', async () => {
    await pool.query(
      `INSERT INTO company_settings (company_id, module, settings, updated_at)
       VALUES ($1, 'recruitment', '{"probation_months": "half a year", "probation_review_reminder_days": -4}'::jsonb, NOW())`, [LONELY]);
    const { getProbationPolicy } = await import('../shared/probationDates.js');
    expect(await getProbationPolicy(pool, LONELY)).toMatchObject({ probation_months: 6, reminder_days: 14, months_is_default: true });
    await pool.query(`DELETE FROM company_settings WHERE company_id = $1`, [LONELY]);
  });

  it('/calculate previews exactly what a write stores', async () => {
    const r = await request(app).get('/api/probation/calculate?joining_date=2026-08-31&months=6').set(as('hr'));
    expect(r.body.probation_end_date).toBe('2027-02-28');
    const d = await request(app).get('/api/probation/calculate?joining_date=2026-08-31').set(as('fHr'));
    expect(d.body).toMatchObject({ probation_months: 3, probation_end_date: '2026-11-30' });
    expect((await request(app).get('/api/probation/calculate?joining_date=2026-02-30').set(as('hr'))).status).toBe(400);
  });
});

/* ───────────────────────────── Add / Edit Employee ───────────────────────────── */

describe('Add / Edit Employee persist the probation date', () => {
  let n = 0;
  const base = (cid, extra = {}) => {
    n += 1;
    return {
      company_id: cid, first_name: `ZzProbHire${n}`, last_name: 'Probe',
      company_email: `zz.prob.hire${n}@example.com`, department: dept, designation: desig,
      status: 'Probation', joining_date: '2026-01-31', ...extra,
    };
  };

  it('a Probation hire gets the company default (6 months), by the calendar-month rule', async () => {
    const e = await addEmployee(base(OWN));
    expect(await row(e.id)).toMatchObject({ end: '2026-07-30', probation_months: 6 });
  });

  it('a company\'s configured period applies (3 months)', async () => {
    const e = await addEmployee(base(FOREIGN));
    // 31-Jan + 3 months: 30-Apr exists, so the day before the anniversary
    expect(await row(e.id)).toMatchObject({ end: '2026-04-30', probation_months: 3 });
  });

  it('month-end and leap-year joining dates', async () => {
    const a = await addEmployee(base(OWN, { joining_date: '2026-08-31' }));
    expect((await row(a.id)).end).toBe('2027-02-28');
    const b = await addEmployee(base(OWN, { joining_date: '2027-08-31' }));
    expect((await row(b.id)).end).toBe('2028-02-29');
  });

  it('an Active hire with no probation fields gets no probation date (no hidden +90 days)', async () => {
    const e = await addEmployee(base(OWN, { status: 'Active' }));
    expect(await row(e.id)).toMatchObject({ end: null, probation_months: null });
  });

  it('an explicit end date is stored as given; a bad one is a 400', async () => {
    const e = await addEmployee(base(OWN, { probation_end_date: '2026-09-30' }));
    expect(await row(e.id)).toMatchObject({ end: '2026-09-30', probation_months: null });
    await expect(addEmployee(base(OWN, { probation_months: '0' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(addEmployee(base(OWN, { probation_end_date: '2025-12-31' }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('an explicit end date survives unrelated edits — including a joining-date change', async () => {
    const e = await addEmployee(base(OWN, { probation_end_date: '2026-09-30' }));
    await updateEmployee(e.id, { first_name: 'Renamed', status: 'Probation', department: dept }, OWN);
    expect((await row(e.id)).end).toBe('2026-09-30');
    await updateEmployee(e.id, { joining_date: '2026-02-15' }, OWN);
    expect((await row(e.id)).end).toBe('2026-09-30');
    // blank probation fields (an untouched form) are "not sent", never "clear"
    await updateEmployee(e.id, { probation_months: '', probation_end_date: '' }, OWN);
    expect((await row(e.id)).end).toBe('2026-09-30');
  });

  it('a new period recalculates from the joining date being saved; an end date alone keeps the period', async () => {
    const e = await addEmployee(base(OWN));
    await updateEmployee(e.id, { probation_months: '3' }, OWN);
    expect(await row(e.id)).toMatchObject({ end: '2026-04-30', probation_months: 3 });
    await updateEmployee(e.id, { joining_date: '2026-03-01', probation_months: '6' }, OWN);
    expect(await row(e.id)).toMatchObject({ end: '2026-08-31', probation_months: 6 });
    await updateEmployee(e.id, { probation_end_date: '2026-09-15' }, OWN);
    expect(await row(e.id)).toMatchObject({ end: '2026-09-15', probation_months: 6 });
  });

  it('never touches status or confirmation_date', async () => {
    const e = await addEmployee(base(OWN));
    await updateEmployee(e.id, { probation_months: '12' }, OWN);
    expect(await row(e.id)).toMatchObject({ status: 'Probation', confirmation_date: null });
  });
});

/* ───────────────────────────── reminder job ───────────────────────────── */

describe('daily reminder job', () => {
  const E = '2026-11-30';

  it('sends nothing before the window opens', async () => {
    // (Other OWN probationers created above have PAST end dates and rightly
    // get their single "ended" reminder here; the subject must get nothing.)
    const c = await runProbationCheck({ asOf: addDays(E, -20), companyId: OWN });
    expect(c).toMatchObject({ due_soon: 0, failed: 0 });
    expect(await ledger(fx.emp.subject)).toHaveLength(0);
    expect(await notificationsFor('hr', fx.emp.subject)).toHaveLength(0);
  });

  it('a run that missed the first days of the window still sends "due soon" — once', async () => {
    // The window opened at E-14; no run happened until E-10.
    const c = await runProbationCheck({ asOf: addDays(E, -10), companyId: OWN });
    expect(c.due_soon).toBe(1);
    expect(await ledger(fx.emp.subject)).toEqual([
      { reminder_kind: 'due_soon', end_date: E, recipient_count: 3, company_id: OWN },
    ]);
    for (const who of ['hr', 'super', 'mgr']) {
      const got = (await notificationsFor(who, fx.emp.subject)).filter((x) => x.notification_type === 'probation_warning');
      expect(got, who).toHaveLength(1);
      expect(got[0].module_name).toBe('probation');
    }
    for (const who of ['fHr', 'fSuper', 'globalSuper']) {
      expect(await notificationsFor(who, fx.emp.subject), who).toHaveLength(0);
    }
  });

  it('repeated runs inside the window send nothing new', async () => {
    const c1 = await runProbationCheck({ asOf: addDays(E, -9), companyId: OWN });
    const c2 = await runProbationCheck({ asOf: addDays(E, -9), companyId: OWN });
    expect(c1).toMatchObject({ due_soon: 0, ended: 0, failed: 0 });
    expect(c2).toMatchObject({ due_soon: 0, ended: 0, failed: 0 });
    expect(c2.duplicate).toBe(c1.duplicate);
    expect(c1.duplicate).toBeGreaterThanOrEqual(1);
    expect(await ledger(fx.emp.subject)).toHaveLength(1);
    expect((await notificationsFor('hr', fx.emp.subject)).filter((x) => x.notification_type === 'probation_warning')).toHaveLength(1);
  });

  it('on and after the end date, one "ended" reminder', async () => {
    const c = await runProbationCheck({ asOf: addDays(E, 3), companyId: OWN });
    expect(c.ended).toBe(1);
    await runProbationCheck({ asOf: addDays(E, 4), companyId: OWN });
    expect((await ledger(fx.emp.subject)).map((r) => r.reminder_kind)).toEqual(['due_soon', 'ended']);
    expect((await notificationsFor('hr', fx.emp.subject)).filter((x) => x.notification_type === 'probation_due')).toHaveLength(1);
  });

  it('a run that missed the WHOLE window sends only "ended", never a stale "due soon"', async () => {
    const id = await emp('missedAll', OWN, { status: 'Probation', end: '2026-06-30' });
    await runProbationCheck({ asOf: '2026-07-05', companyId: OWN });
    expect((await ledger(id)).map((r) => r.reminder_kind)).toEqual(['ended']);
  });

  it('skips an employee with no stored end date — it does not invent one', async () => {
    await runProbationCheck({ asOf: addDays(E, 3), companyId: OWN });
    expect(await ledger(fx.emp.undated)).toHaveLength(0);
  });

  it('a changed end date (e.g. corrected) is a new reminder, not a suppressed one', async () => {
    const id = await emp('moved', OWN, { status: 'Probation', end: '2026-12-10' });
    await runProbationCheck({ asOf: '2026-12-01', companyId: OWN });
    await pool.query(`UPDATE employees SET probation_end_date = '2027-01-10' WHERE id = $1`, [id]);
    await runProbationCheck({ asOf: '2027-01-01', companyId: OWN });
    expect((await ledger(id)).map((r) => `${r.reminder_kind}:${r.end_date}`))
      .toEqual(['due_soon:2026-12-10', 'due_soon:2027-01-10']);
  });

  it('uses each company\'s own reminder lead time', async () => {
    // FOREIGN: 10 days. At E-12 it is outside FOREIGN's window.
    expect((await runProbationCheck({ asOf: addDays(E, -12), companyId: FOREIGN })).due_soon).toBe(0);
    expect((await runProbationCheck({ asOf: addDays(E, -10), companyId: FOREIGN })).due_soon).toBe(1);
    expect(await notificationsFor('fHr', fx.emp.fSubject)).toHaveLength(1);
    expect(await notificationsFor('hr', fx.emp.fSubject)).toHaveLength(0);
    expect(await notificationsFor('super', fx.emp.fSubject)).toHaveLength(0);
  });

  it('with nobody to notify, writes no ledger row — and sends once someone exists', async () => {
    const c = await runProbationCheck({ asOf: addDays(E, -5), companyId: LONELY });
    expect(c).toMatchObject({ no_recipient: 1, due_soon: 0 });
    expect(await ledger(fx.emp.lonely)).toHaveLength(0);
    await login('lonelyHr', 'hr', LONELY);
    expect((await runProbationCheck({ asOf: addDays(E, -4), companyId: LONELY })).due_soon).toBe(1);
    expect(await notificationsFor('lonelyHr', fx.emp.lonely)).toHaveLength(1);
  });

  it('two simultaneous runs send each reminder exactly once', async () => {
    const id = await emp('race', OWN, { status: 'Probation', end: '2027-03-31' });
    const runs = await Promise.all([
      runProbationCheck({ asOf: '2027-03-25', companyId: OWN }),
      runProbationCheck({ asOf: '2027-03-25', companyId: OWN }),
    ]);
    expect(runs.reduce((s, r) => s + r.due_soon, 0)).toBe(1);
    expect(await ledger(id)).toHaveLength(1);
    expect(await notificationsFor('hr', id)).toHaveLength(1);
  }, 20000);
});

/* ───────────────────────────── consumers ───────────────────────────── */

describe('leave reads the stored end date', () => {
  it('no joining_date + 90 days fallback: a recent Active hire with no end date is not on probation', async () => {
    const res = await request(app).get(`/api/leaves/probation-status?employee_id=${fx.emp.activeRecent}`).set(as('hr'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ in_probation: false, probation_end: null });
  });

  it('a probationer reports the stored date', async () => {
    const res = await request(app).get(`/api/leaves/probation-status?employee_id=${fx.emp.subject}`).set(as('hr'));
    expect(res.body).toEqual({ in_probation: true, probation_end: '2026-11-30' });
  });

  it('does not read another company\'s employee', async () => {
    const res = await request(app).get(`/api/leaves/probation-status?employee_id=${fx.emp.fSubject}`).set(as('hr'));
    expect(res.body).toEqual({ in_probation: false, probation_end: null });
  });
});

describe('dashboard alert reads the stored end date', () => {
  const alertsFor = async (cid) => {
    const res = { body: null, code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await getDashboardAlerts({ scope: { company_id: cid }, query: {}, user: { id: fx.user.hr } }, res);
    expect(res.code).toBe(200);
    return res.body.alerts.filter((a) => a.type === 'probation');
  };
  // Fixtures above carry fixed calendar dates, so count relative to a baseline
  // rather than assuming none of them falls inside today's window.
  const countOf = (alerts) => (alerts[0] ? Number(alerts[0].message.split(' ')[0]) : 0);

  it('counts probations whose STORED end date is inside the company window — not joining + 165..180', async () => {
    const before = countOf(await alertsFor(OWN));
    // Joined 170 days ago (inside the old rule's 165..180 window) but ends in 60 days: NOT due.
    await emp('oldRule', OWN, { status: 'Probation', joining: addDays(today, -170), end: addDays(today, 60) });
    expect(countOf(await alertsFor(OWN))).toBe(before);
    // Joined 100 days ago (outside the old rule) and ends in 5 days: due.
    await emp('dueSoon', OWN, { status: 'Probation', joining: addDays(today, -100), end: addDays(today, 5) });
    const a = await alertsFor(OWN);
    expect(countOf(a)).toBe(before + 1);
    expect(a[0].message).toMatch(/ending in ≤14 days$/);
  });

  it("uses each company's own lead time in the alert", async () => {
    await emp('fDue', FOREIGN, { status: 'Probation', joining: addDays(today, -100), end: addDays(today, 12) });
    // FOREIGN reminds 10 days ahead: 12 days out is not yet due there.
    const before = countOf(await alertsFor(FOREIGN));
    await emp('fDue2', FOREIGN, { status: 'Probation', joining: addDays(today, -100), end: addDays(today, 9) });
    const a = await alertsFor(FOREIGN);
    expect(countOf(a)).toBe(before + 1);
    expect(a[0].message).toMatch(/ending in ≤10 days$/);
  });
});

it('the shared rule is what Add Employee stored (sanity)', () => {
  expect(probationEndDate('2026-01-31', 6)).toBe('2026-07-30');
});
