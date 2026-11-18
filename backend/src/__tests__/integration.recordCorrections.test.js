/**
 * Record corrections + My Details (2026-11-11).
 *
 * Employees no longer edit their own record. They read it on My Details
 * (GET /home/my-record — own row only, identity and bank numbers masked) and,
 * finding a mistake, raise a 'Record correction' ticket to HR or Finance
 * (POST /servicedesk/corrections). The people who maintain that data resolve
 * it (POST /servicedesk/corrections/:id/resolve) — HR with hr:edit,
 * Finance with it_declarations:add — never the requester; the
 * answer is posted on the ticket and the employee is notified. The Approval
 * Center lists it (source `corr`) for exactly those people.
 *
 * Real routers and database; two throwaway companies — all removed afterwards.
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
const { default: homeRoutes }  = await import('../home/home.routes.js');
const { default: servicedeskRoutes } = await import('../modules/servicedesk/routes/servicedesk.routes.js');
const { SOURCE_BY_TYPE }       = await import('../modules/approvals/approvals.sources.js');

const app = buildApp(
  ['/api/home', homeRoutes],
  ['/api/servicedesk', verifyToken, servicedeskRoutes],
);

const PREFIX = 'ZZRECCOR';
let co, other, emp, empB, hr, fin, sales, otherHr, unlinked;
const E = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const link = (u, employeeId) => pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, u.userId]);

async function sweep(companyId) {
  await pool.query(`UPDATE users SET employee_id = NULL WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM notifications WHERE notification_type = 'record_correction' AND user_id IN (SELECT id FROM users WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM support_tickets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [companyId]);
}
async function addEmployee(company, code, extra = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, blood_group, pan_number, account_number, notes)
     VALUES ($1, $2, $2, 'Fixture', 'Active', '2025-04-01', $3, $4, $5, $6) RETURNING id`,
    [company.companyId, code, extra.blood_group ?? null, extra.pan ?? null, extra.account ?? null, extra.notes ?? null]);
  return r.id;
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  E.A = await addEmployee(co, 'EMP001', { blood_group: 'B+', pan: 'ABCDE1234F', account: '123456789012', notes: 'HR private note' });
  E.B = await addEmployee(co, 'EMP002');
  E.H = await addEmployee(co, 'EMP003');
  emp = await addUser(pool, co, { label: 'emp', roleCode: 'employee' }); await link(emp, E.A);
  empB = await addUser(pool, co, { label: 'empb', roleCode: 'employee' }); await link(empB, E.B);
  hr = await addUser(pool, co, { label: 'hr', roleCode: 'hr_manager' }); await link(hr, E.H);
  fin = await addUser(pool, co, { label: 'fin', roleCode: 'finance_manager' });
  sales = await addUser(pool, co, { label: 'sales', roleCode: 'sales_exec' });
  otherHr = await addUser(pool, other, { label: 'hr', roleCode: 'hr_manager' });
  unlinked = await addUser(pool, co, { label: 'nolink', roleCode: 'employee' });
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
}, 60000);

const field = (body, section, label) => body.sections.find(s => s.key === section).fields.find(f => f.label === label).value;

describe('My Details — GET /home/my-record', () => {
  it('returns the caller\'s own record only, with identity and bank numbers masked and HR notes left out', async () => {
    const r = await call(emp, 'get', '/api/home/my-record');
    expect(r.status).toBe(200);
    expect(field(r.body, 'personal', 'Blood group')).toBe('B+');
    expect(field(r.body, 'job', 'Employee code')).toBe('EMP001');
    expect(field(r.body, 'statutory', 'PAN')).toBe('XXXXXX234F');
    expect(field(r.body, 'bank', 'Account number')).toBe('XXXXXXXX9012');
    const text = JSON.stringify(r.body);
    for (const secret of ['ABCDE1234F', '123456789012', 'HR private note']) expect(text).not.toContain(secret);
    // someone else's record cannot be asked for
    const b = await call(empB, 'get', `/api/home/my-record?employee_id=${E.A}`);
    expect(field(b.body, 'job', 'Employee code')).toBe('EMP002');
  });

  it('a login with no employee gets { linked: false }', async () => {
    expect((await call(unlinked, 'get', '/api/home/my-record')).body).toEqual({ linked: false });
  });
});

describe('Record corrections', () => {
  const raise = (who, body) => call(who, 'post', '/api/servicedesk/corrections').send(body);
  const resolveAs = (who, id, body) => call(who, 'post', `/api/servicedesk/corrections/${id}/resolve`).send(body);
  let hrTicket, finTicket;

  it('an employee raises one to HR or Finance; the ticket says who and what', async () => {
    expect((await raise(emp, { to: 'IT', field: 'x', correct_value: 'y' })).status).toBe(400);
    expect((await raise(emp, { to: 'HR', field: '' , correct_value: 'y' })).status).toBe(400);
    expect((await raise(emp, { to: 'HR', field: 'Blood group' })).status).toBe(400);
    expect((await raise(unlinked, { to: 'HR', field: 'Blood group', correct_value: 'O+' })).status).toBe(403);
    const r = await raise(emp, { to: 'HR', section: 'Personal', field: 'Blood group', current_value: 'B+', correct_value: 'O+' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ category: 'Record correction', team: 'HR Support', status: 'Open', requester_email: `${co.code.toLowerCase()}.emp@test.invalid` });
    expect(r.body.description).toContain('Should be: O+');
    hrTicket = r.body.id;
    const f = await raise(emp, { to: 'Finance', field: '80C — PPF', details: 'Amount should be 1,50,000' });
    expect(f.body.team).toBe('Finance');
    finTicket = f.body.id;
  });

  it('the Approval Center offers it to the people who maintain that data — never the requester', async () => {
    const src = SOURCE_BY_TYPE.corr;
    const rows = await src.pending(co.companyId);
    const hrRow = rows.find(r => r.source_id === String(hrTicket));
    const finRow = rows.find(r => r.source_id === String(finTicket));
    const ctx = (perms, linkedEmployeeId = null) => ({ perms, linkedEmployeeId });
    expect(src.canAct(ctx({ hr: { can_edit: true } }), hrRow)).toBe(true);
    expect(src.canAct(ctx({ hr: { can_edit: true } }), finRow)).toBe(false);
    expect(src.canAct(ctx({ employees: { can_view: true } }), hrRow)).toBe(false);
    expect(src.canAct(ctx({ it_declarations: { can_add: true } }), finRow)).toBe(true);
    expect(src.canAct(ctx({ payroll: { can_edit: true } }), finRow)).toBe(false);   // hr_manager holds payroll:edit
    expect(src.canAct(ctx({ hr: { can_edit: true } }, E.A), hrRow)).toBe(false);     // own request
    expect(src.actions(hrRow).approve).toMatchObject({ url: `/servicedesk/corrections/${hrTicket}/resolve`, body: { outcome: 'done' }, label: 'Mark corrected' });
    expect(src.actions(hrRow).reject).toMatchObject({ body: { outcome: 'declined' }, commentRequired: true, label: 'Decline' });
    expect(rows.every(r => r.company_id === co.companyId)).toBe(true);
  });

  it('only the right team resolves it, in its own company, never their own', async () => {
    for (const [n, who] of Object.entries({ emp, empB, sales, otherHr })) expect((await resolveAs(who, hrTicket, { outcome: 'done' })).status, n).toBe(404);
    expect((await resolveAs(fin, hrTicket, { outcome: 'done' })).status).toBe(404);              // HR's, not Finance's
    expect((await resolveAs(hr, finTicket, { outcome: 'done' })).status).toBe(404);              // Finance's, not HR's
    expect((await resolveAs(hr, hrTicket, { outcome: 'maybe' })).status).toBe(400);
    expect((await resolveAs(hr, hrTicket, { outcome: 'declined' })).status).toBe(400);          // a decline needs a reason
    const { body: own } = await raise(hr, { to: 'HR', field: 'Mobile', correct_value: '9999999999' });
    expect((await resolveAs(hr, own.id, { outcome: 'done' })).status).toBe(403);
  });

  it('resolving answers on the ticket and notifies the employee; it cannot be resolved twice', async () => {
    const r = await resolveAs(hr, hrTicket, { outcome: 'done', note: 'Updated to O+.' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Resolved');
    expect((await resolveAs(hr, hrTicket, { outcome: 'done' })).status).toBe(409);
    const d = await resolveAs(fin, finTicket, { outcome: 'declined', note: 'Proof shows ₹1,20,000.' });
    expect(d.body.status).toBe('Closed');
    const mine = await call(emp, 'get', '/api/servicedesk/corrections/mine');
    expect(mine.body.map(t => [t.id, t.status, t.reply])).toEqual(expect.arrayContaining([
      [hrTicket, 'Resolved', 'Corrected. Updated to O+.'],
      [finTicket, 'Closed', 'Not changed. Proof shows ₹1,20,000.'],
    ]));
    // another employee sees none of them
    expect((await call(empB, 'get', '/api/servicedesk/corrections/mine')).body).toEqual([]);
    const { rows: notes } = await pool.query(
      `SELECT title FROM notifications WHERE user_id = $1 AND notification_type = 'record_correction' ORDER BY id`, [emp.userId]);
    expect(notes.map(n => n.title)).toEqual(['Your record was corrected', 'Your correction request was declined']);
    // the conversation row names the resolver's EMPLOYEE (ticket_conversations.created_by → employees)
    const { rows: [c] } = await pool.query(`SELECT created_by FROM ticket_conversations WHERE ticket_id = $1`, [hrTicket]);
    expect(c.created_by).toBe(E.H);
  });
});
