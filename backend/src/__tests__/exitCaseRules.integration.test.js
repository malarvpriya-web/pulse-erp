/**
 * Exit case rules (§274) — the real exit router against the database, auth
 * stubbed (the router reads req.user.role and req.scope.company_id):
 *   - Initiate: one open exit per employee (409 EXIT_ALREADY_OPEN, and the
 *     partial unique index holds it at the database too); a deleted or departed
 *     employee is refused; exit type / dates validated; notice days default to
 *     the employee's contract; resignation date stored; clearance starts empty
 *     even when an old row was fully ticked; the reporting manager is notified.
 *   - GET /active and GET /requests hide exits of deleted employees.
 *   - PUT /requests/:id edits the details while F&F is draft, reports that a
 *     settlement needs recalculating, refuses once F&F is approved, refuses
 *     'cancelled' (withdraw is the path), and stays company-scoped.
 *   - POST /requests follows the same rules.
 * Companies are auto-numbered and tagged; everything is removed in afterAll.
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
const { default: router } = await import('../modules/hr/exit.routes.js');

const TAG = 'ZZXCASE';
const fx = { A: null, B: null, actor: null };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: fx.actor, userId: fx.actor, role: req.get('x-role') || 'hr_manager' };
  req.scope = { company_id: Number(req.get('x-company')) };
  next();
});
app.use('/api/exit', router);
const as = (company) => ({ 'x-role': 'hr_manager', 'x-company': String(company) });
const initiate = (body, company = fx.A) => request(app).post('/api/exit/initiate').set(as(company)).send(body);
const edit = (id, body, company = fx.A) => request(app).put(`/api/exit/requests/${id}`).set(as(company)).send(body);

async function cleanup() {
  const cos = `SELECT id FROM companies WHERE code LIKE '${TAG}%'`;
  const emps = `SELECT id FROM employees WHERE company_id IN (${cos})`;
  const users = `SELECT id FROM users WHERE email LIKE 'zz.xcase.%@example.com'`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM holidays WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM fnf_settlements WHERE employee_id IN (${emps})`);
  await pool.query(`DELETE FROM exit_clearance WHERE employee_id IN (${emps})`);
  await pool.query(`DELETE FROM exit_requests WHERE employee_id IN (${emps})`);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.xcase.%@example.com'`);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM employees WHERE company_id IN (${cos})`);
  await pool.query(`DELETE FROM companies WHERE code LIKE '${TAG}%'`);
}

let seq = 0;
async function employee(company, { status = 'Active', notice = 30, manager = null, deleted = false } = {}) {
  seq += 1;
  return (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, joining_date,
                            employment_type, notice_period_days, reporting_manager_id, deleted_at)
     VALUES ($1,$2,'Zz',$3,$4,$5,'2024-01-01','Permanent',$6,$7,$8) RETURNING id`,
    [company, `EMP274${String(seq).padStart(3, '0')}`, `Xcase${seq}`, `zz.xcase.emp${seq}@example.com`, status,
      notice, manager, deleted ? new Date() : null])).rows[0].id;
}
async function login(company, employeeId, role = 'employee') {
  seq += 1;
  return (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,'x',$3,true,$4,$5) RETURNING id`,
    [`Zz Xcase ${seq}`, `zz.xcase.u${seq}@example.com`, role, company, employeeId])).rows[0].id;
}

beforeAll(async () => {
  await cleanup();
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ('ZZ Exit Case A', '${TAG}A'), ('ZZ Exit Case B', '${TAG}B') RETURNING id, code`);
  fx.A = rows.find(r => r.code.endsWith('A')).id;
  fx.B = rows.find(r => r.code.endsWith('B')).id;
  fx.actor = await login(fx.A, null, 'hr_manager');
});
afterAll(async () => {
  await new Promise(r => setTimeout(r, 400)); // fire-and-forget audit/notification writes
  await cleanup();
});

describe('POST /exit/initiate', () => {
  it('starts an exit: Notice, contract notice by default, resignation date stored, manager notified, clearance fresh', async () => {
    const mgr = await employee(fx.A);
    const mgrUser = await login(fx.A, mgr);
    const emp = await employee(fx.A, { manager: mgr, notice: 45 });
    // An old, fully ticked clearance row (a previous exit) must not pre-clear this one.
    await pool.query(`INSERT INTO exit_clearance (employee_id, noc_hr, noc_finance, noc_manager, access_revoked) VALUES ($1,true,true,true,true)`, [emp]);

    const res = await initiate({ employee_id: emp, separation_type: 'Contract Expiry', last_working_date: '2026-12-31', resignation_date: '2026-11-15', reason: 'Fixed term ends' });
    expect(res.status).toBe(201);
    expect(res.body.separation_type).toBe('contract_expiry');
    expect(res.body.notice_period).toBe(45);
    expect(res.body.notified).toBe(1);

    const { rows: [row] } = await pool.query(
      `SELECT e.status, to_char(er.resignation_date,'YYYY-MM-DD') rd, ec.noc_hr, ec.access_revoked
         FROM employees e JOIN exit_requests er ON er.employee_id = e.id JOIN exit_clearance ec ON ec.employee_id = e.id
        WHERE e.id = $1`, [emp]);
    expect(row).toEqual({ status: 'Notice', rd: '2026-11-15', noc_hr: false, access_revoked: false });

    await new Promise(r => setTimeout(r, 200));
    const { rows: notes } = await pool.query(`SELECT title FROM notifications WHERE user_id = $1`, [mgrUser]);
    expect(notes.map(n => n.title)).toEqual([expect.stringMatching(/^Exit recorded: Zz Xcase/)]);
  });

  it('refuses a second open exit, and the database refuses it too', async () => {
    const emp = await employee(fx.A);
    expect((await initiate({ employee_id: emp, last_working_date: '2026-12-31' })).status).toBe(201);
    // Status back to Active so only the open-exit rule can stop it.
    await pool.query(`UPDATE employees SET status = 'Active' WHERE id = $1`, [emp]);
    const again = await initiate({ employee_id: emp, last_working_date: '2027-01-15' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EXIT_ALREADY_OPEN');
    await expect(pool.query(
      `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, status) VALUES ($1,'resignation','2027-01-15','active')`, [emp]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('refuses deleted, departed and other-company employees', async () => {
    const gone = await employee(fx.A, { deleted: true });
    expect((await initiate({ employee_id: gone, last_working_date: '2026-12-31' })).status).toBe(404);
    const left = await employee(fx.A, { status: 'Left' });
    const r = await initiate({ employee_id: left, last_working_date: '2026-12-31' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMPLOYEE_ALREADY_LEFT');
    const other = await employee(fx.B);
    expect((await initiate({ employee_id: other, last_working_date: '2026-12-31' })).status).toBe(404);
  });

  it('validates the exit type and dates', async () => {
    const emp = await employee(fx.A);
    const cases = [
      [{ separation_type: 'attrition', last_working_date: '2026-12-31' }, 'SEPARATION_TYPE_INVALID'],
      [{ last_working_date: '' }, 'LWD_REQUIRED'],
      [{ last_working_date: '2026-12-31', resignation_date: '2027-01-02' }, 'RESIGNATION_AFTER_LWD'],
      [{ last_working_date: '2026-12-31', notice_period: -1 }, 'NOTICE_PERIOD_INVALID'],
    ];
    for (const [body, code] of cases) {
      const res = await initiate({ employee_id: emp, ...body });
      expect([res.status, res.body.code]).toEqual([400, code]);
    }
    const { rows } = await pool.query(`SELECT 1 FROM exit_requests WHERE employee_id = $1`, [emp]);
    expect(rows).toHaveLength(0);
  });
});

describe('lists hide deleted employees', () => {
  it('GET /active and GET /requests skip an exit whose employee was deleted', async () => {
    const emp = await employee(fx.A);
    const { body } = await initiate({ employee_id: emp, last_working_date: '2026-12-31' });
    const ids = async () => ({
      active: (await request(app).get('/api/exit/active').set(as(fx.A))).body.map(r => r.id),
      all: (await request(app).get('/api/exit/requests').set(as(fx.A))).body.map(r => r.id),
    });
    expect((await ids()).active).toContain(body.id);
    await pool.query(`UPDATE employees SET deleted_at = NOW() WHERE id = $1`, [emp]);
    const after = await ids();
    expect(after.active).not.toContain(body.id);
    expect(after.all).not.toContain(body.id);
  });
});

describe('PUT /exit/requests/:id', () => {
  it('edits the details while F&F is draft and says when a settlement must be recalculated', async () => {
    const emp = await employee(fx.A);
    const { body: er } = await initiate({ employee_id: emp, last_working_date: '2026-12-31' });
    await pool.query(
      `INSERT INTO fnf_settlements (exit_request_id, employee_id, company_id, version, separation_type, last_working_date, total_payable, total_recoverable, net_payable, lines, rules)
       VALUES ($1,$2,$3,1,'resignation','2026-12-31',0,0,0,'[]','{}')`, [er.id, emp, fx.A]);

    const res = await edit(er.id, { separation_type: 'termination', last_working_date: '2027-01-10', resignation_date: '2026-12-01', notice_period: 40, reason: 'Corrected' });
    expect(res.status).toBe(200);
    expect(res.body.fnf_recompute_needed).toBe(true);
    const { rows: [row] } = await pool.query(
      `SELECT separation_type, to_char(last_working_date,'YYYY-MM-DD') lwd, to_char(resignation_date,'YYYY-MM-DD') rd, notice_period, reason
         FROM exit_requests WHERE id = $1`, [er.id]);
    expect(row).toEqual({ separation_type: 'termination', lwd: '2027-01-10', rd: '2026-12-01', notice_period: 40, reason: 'Corrected' });

    // Moving the last working day before the stored resignation date is refused.
    const bad = await edit(er.id, { last_working_date: '2026-11-20' });
    expect([bad.status, bad.body.code]).toEqual([400, 'RESIGNATION_AFTER_LWD']);
  });

  it('refuses edits once F&F is approved, refuses cancel, and is company-scoped', async () => {
    const emp = await employee(fx.A);
    const { body: er } = await initiate({ employee_id: emp, last_working_date: '2026-12-31' });
    expect((await edit(er.id, { status: 'cancelled' })).body.code).toBe('USE_WITHDRAW');
    expect((await edit(er.id, { last_working_date: '2027-01-31' }, fx.B)).status).toBe(404);
    await pool.query(`UPDATE exit_requests SET fnf_status = 'approved' WHERE id = $1`, [er.id]);
    const locked = await edit(er.id, { last_working_date: '2027-01-31' });
    expect([locked.status, locked.body.code]).toEqual([409, 'FNF_APPROVED']);
    // Remarks are not exit details and stay editable.
    expect((await edit(er.id, { remarks: 'Handover done' })).status).toBe(200);
  });
});

describe('notice period default (§275)', () => {
  it('an exit with no notice given uses the company default when the employee record has none', async () => {
    const emp = await employee(fx.A, { notice: null });
    const res = await initiate({ employee_id: emp, last_working_date: '2027-02-28' });
    expect(res.status).toBe(201);
    expect(res.body.notice_period).toBe(90);   // workforce policy default; this test company sets none
  });
});

describe('exit status job (§275)', () => {
  it('ends employment the day AFTER the last working day and records the exit date', async () => {
    const { runExitStatusSync } = await import('../jobs/exitStatusSync.cron.js');
    const emp = await employee(fx.A);
    await initiate({ employee_id: emp, last_working_date: '2026-12-31' });

    // On the last working day itself: still employed.
    await runExitStatusSync({ today: '2026-12-31', onlyEmployeeIds: [emp] });
    let { rows: [row] } = await pool.query(`SELECT status, to_char(exit_date,'YYYY-MM-DD') exit_date FROM employees WHERE id = $1`, [emp]);
    expect(row).toEqual({ status: 'Notice', exit_date: null });

    // The next morning: Left, with the exit date.
    const r = await runExitStatusSync({ today: '2027-01-01', onlyEmployeeIds: [emp] });
    expect(r.updated).toBe(1);
    ({ rows: [row] } = await pool.query(`SELECT status, to_char(exit_date,'YYYY-MM-DD') exit_date FROM employees WHERE id = $1`, [emp]));
    expect(row).toEqual({ status: 'Left', exit_date: '2026-12-31' });
  });

  it('skips a deleted employee', async () => {
    const { runExitStatusSync } = await import('../jobs/exitStatusSync.cron.js');
    const emp = await employee(fx.A);
    await initiate({ employee_id: emp, last_working_date: '2026-12-31' });
    await pool.query(`UPDATE employees SET deleted_at = NOW() WHERE id = $1`, [emp]);
    expect((await runExitStatusSync({ today: '2027-01-05', onlyEmployeeIds: [emp] })).updated).toBe(0);
  });
});

describe('F&F due date and overdue reminder (§276)', () => {
  it('wages are due 2 working days after the last day, skipping Sundays and company holidays', async () => {
    const { fnfDueDates, addWorkingDays } = await import('../modules/hr/fnfDue.js');
    expect(addWorkingDays('2026-10-02', 2)).toBe('2026-10-05');          // Fri → Sat 3, (Sun 4 skipped), Mon 5
    await pool.query(`INSERT INTO holidays (name, date, type, company_id) VALUES ('ZZ Xcase holiday', '2026-10-05', 'public', $1)`, [fx.A]);
    const d = await fnfDueDates(pool, { companyId: fx.A, lwd: '2026-10-02' });
    expect(d).toMatchObject({ wages_due: '2026-10-06', gratuity_due: '2026-11-01', working_days: 2 });
  });

  it('reminds Finance and HR once a day when the settlement is late, and not before', async () => {
    const { runFnfOverdueReminder, FNF_OVERDUE_TYPE } = await import('../jobs/fnfOverdueReminder.cron.js');
    const { syncPrimaryRole } = await import('../services/userRoles.js');
    const hrUser = await login(fx.A, null, 'hr_manager');
    await syncPrimaryRole(hrUser, 'hr_manager', fx.A);
    const emp = await employee(fx.A);
    await initiate({ employee_id: emp, last_working_date: '2026-10-01' });   // Thu → due Sat 3 Oct

    expect((await runFnfOverdueReminder({ today: '2026-10-03', onlyEmployeeIds: [emp] })).sent).toBe(0);   // due today, not late
    const first = await runFnfOverdueReminder({ today: '2026-10-10', onlyEmployeeIds: [emp] });
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const { rows: [n] } = await pool.query(`SELECT title, message FROM notifications WHERE user_id = $1 AND notification_type = $2`, [hrUser, FNF_OVERDUE_TYPE]);
    expect(n.title).toMatch(/^F&F overdue: Zz Xcase/);
    expect(n.message).toMatch(/due by 03 Oct 26 \(2 working days\) and are 7 days late. Settlement: not yet calculated/);
    expect((await runFnfOverdueReminder({ today: '2026-10-10', onlyEmployeeIds: [emp] })).sent).toBe(0);   // once a day
  });

  it('Active Exits shows the due date and days late', async () => {
    const emp = await employee(fx.A);
    const { body: er } = await initiate({ employee_id: emp, last_working_date: '2026-10-01' });
    const row = (await request(app).get('/api/exit/active').set(as(fx.A))).body.find(r => r.id === er.id);
    expect(row).toMatchObject({ fnf_due_date: '2026-10-03', gratuity_due_date: '2026-10-31', employee_status: 'Notice' });
    expect(row.fnf_days_late).toBeGreaterThan(0);
  });
});

describe('relieving and experience letters (§276)', () => {
  const letter = (emp, kind) => request(app).get(`/api/exit/employee/${emp}/letter/${kind}`).set(as(fx.A))
    .buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  const leave = async (over = {}) => {
    const { runExitStatusSync } = await import('../jobs/exitStatusSync.cron.js');
    const emp = await employee(fx.A);
    await pool.query(`UPDATE employees SET designation = 'Design Engineer', department = 'Engineering' WHERE id = $1`, [emp]);
    await initiate({ employee_id: emp, last_working_date: '2026-12-31', resignation_date: '2026-10-02', ...over });
    return { emp, gone: () => runExitStatusSync({ today: '2027-01-01', onlyEmployeeIds: [emp] }) };
  };

  it('is refused until the employee has left, then served as a PDF', async () => {
    const { emp, gone } = await leave();
    const early = await letter(emp, 'relieving');
    expect([early.status, JSON.parse(early.body.toString()).code]).toEqual([409, 'NOT_LEFT_YET']);
    await gone();
    for (const kind of ['relieving', 'experience']) {
      const r = await letter(emp, kind);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/pdf/);
      expect(r.body.subarray(0, 4).toString()).toBe('%PDF');
    }
    expect((await letter(emp, 'reference')).status).toBe(400);
  });

  it('says the right things', async () => {
    const { exitLetterContent } = await import('../modules/hr/exitLetters.js');
    const { emp, gone } = await leave();
    await gone();
    const rel = await exitLetterContent(pool, { companyId: fx.A, employeeId: emp, kind: 'relieving', signatoryUserId: fx.actor, todayIso: '2027-01-02' });
    expect(rel.body).toMatch(/resignation dated 02 October 2026/);
    expect(rel.body).toMatch(/close of working hours on 31 December 2026/);
    expect(rel.body).not.toMatch(/full and final/);   // F&F not paid
    expect(rel.letterDate).toBe('02 January 2027');
    const exp = await exitLetterContent(pool, { companyId: fx.A, employeeId: emp, kind: 'experience', signatoryUserId: fx.actor, todayIso: '2027-01-02' });
    expect(exp.body).toMatch(/from 01 January 2024 to 31 December 2026/);
    expect(exp.body).toMatch(/held the position of Design Engineer in the Engineering department/);
    expect(exp.toLabel).toBeNull();
  });

  it('no relieving letter for absconding; an experience letter is still given', async () => {
    const { emp, gone } = await leave({ separation_type: 'absconding' });
    await gone();
    const r = await letter(emp, 'relieving');
    expect([r.status, JSON.parse(r.body.toString()).code]).toEqual([409, 'ABSCONDED']);
    expect((await letter(emp, 'experience')).status).toBe(200);
  });

  it('another company cannot get one', async () => {
    const { emp, gone } = await leave();
    await gone();
    expect((await request(app).get(`/api/exit/employee/${emp}/letter/experience`).set(as(fx.B))).status).toBe(404);
  });
});

describe('POST /exit/requests', () => {
  it('applies the same rules as Initiate', async () => {
    const emp = await employee(fx.A);
    const first = await request(app).post('/api/exit/requests').set(as(fx.A)).send({ employee_id: emp, last_working_date: '2026-12-31' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('pending');
    const second = await request(app).post('/api/exit/requests').set(as(fx.A)).send({ employee_id: emp, last_working_date: '2026-12-31' });
    expect([second.status, second.body.code]).toEqual([409, 'EXIT_ALREADY_OPEN']);
  });
});
