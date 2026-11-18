/**
 * The self-filling timesheet (2026-11-11), through the REAL router, service and
 * Approval Center source on the REAL test database.
 *
 *   - a week is pre-filled from attendance: punch → that, no punch → standard
 *     day, leave → 0, half-day leave → half, holiday / weekend → 0
 *   - each day is split across the employee's projects by allocation, in ¼ h
 *   - the employee saves / submits the week in one call; a submitted week is
 *     locked; booking to a project they are not on is refused
 *   - a team lead on the plain employee role (no timesheets grant) approves
 *     their report's week — from the Approval Center item, one per week
 *   - Monday's job submits an untouched week from the pre-fill, once
 *
 * Fixed weeks in 2031 so no real data is in the way. Self-cleaning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (pw) process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: timesheetsRouter } = await import('../modules/timesheets/routes/timesheets.routes.js');
const svc = await import('../modules/timesheets/autoTimesheet.service.js');
const { SOURCE_BY_TYPE, buildContext } = await import('../modules/approvals/approvals.sources.js');
const { createIsolatedCompany, dropIsolatedCompany } = await import('./helpers/isolatedCompany.js');

const WEEK = '2031-03-03';      // Monday
const WEEK2 = '2031-03-10';
const fx = {};

function appAs({ userId, roles, employeeId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, role: roles[0], roles, employee_id: employeeId, company_id: fx.co.companyId };
    req.scope = { company_id: fx.co.companyId };
    next();
  });
  app.use('/api/timesheets', timesheetsRouter);
  return app;
}
const fakeReq = (employeeId, roles) => ({
  user: { userId: 990000100, role: roles[0], roles, employee_id: employeeId },
  scope: { company_id: fx.co.companyId },
});

async function employee(label, managerId = null) {
  const { rows: [e] } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date, reporting_manager_id)
     VALUES ($1, $2, 'Zz', $3, $4, 'Active', 'QA', '2020-01-01', $5) RETURNING id`,
    [fx.co.companyId, `EMP976${String(Date.now() % 1000).padStart(3, '0')}${label.length}`, label,
     `${fx.co.code.toLowerCase()}.${label}@test.invalid`, managerId]);
  return e.id;
}

beforeAll(async () => {
  fx.co = await createIsolatedCompany(pool, 'ZZTSA');
  const c = fx.co.companyId;
  fx.lead = await employee('lead');
  fx.me = await employee('member', fx.lead);
  const proj = async (code, status = 'active') => (await pool.query(
    `INSERT INTO projects (project_code, project_name, status, company_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${fx.co.code}-${code}`, `ZZTSA ${code}`, status, c])).rows[0].id;
  fx.pA = await proj('A'); fx.pB = await proj('B'); fx.pOther = await proj('X');
  await pool.query(
    `INSERT INTO project_members (company_id, project_id, employee_id, role_in_project, allocation_pct, is_billable)
     VALUES ($1, $2, $4, 'member', 60, true), ($1, $3, $4, 'member', 40, true)`, [c, fx.pA, fx.pB, fx.me]);
  // Mon: punched 9.5 h. Tue: nothing (standard day). Wed: approved leave.
  // Thu: approved half-day leave. Fri: company holiday. Sat/Sun: weekend.
  await pool.query(
    `INSERT INTO attendance_records (employee_id, attendance_date, total_hours, status, company_id)
     VALUES ($1, '2031-03-03', 9.5, 'present', $2)`, [fx.me, c]);
  const { rows: [lt] } = await pool.query(`SELECT id FROM leave_types ORDER BY id LIMIT 1`);
  await pool.query(
    `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, number_of_days, status, half_day, company_id, reason)
     VALUES ($1, $2, '2031-03-05', '2031-03-05', 1, 'approved', false, $3, 'ZZTSA'),
            ($1, $2, '2031-03-06', '2031-03-06', 0.5, 'approved', true, $3, 'ZZTSA')`, [fx.me, lt.id, c]);
  await pool.query(`INSERT INTO holidays (name, date, company_id) VALUES ('ZZTSA Holiday', '2031-03-07', $1)`, [c]);
  fx.asMe = appAs({ userId: 990000101, roles: ['employee'], employeeId: fx.me });
  fx.asLead = appAs({ userId: 990000102, roles: ['employee'], employeeId: fx.lead });
});

afterAll(async () => {
  if (!fx.co) return;
  const c = fx.co.companyId;
  await pool.query(`DELETE FROM timesheet_entries WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM project_members WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM projects WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM attendance_records WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM leave_applications WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM holidays WHERE company_id = $1`, [c]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [c]);
  await dropIsolatedCompany(pool, c);
});

describe('pre-fill from attendance', () => {
  it('gives each day its hours and reason', async () => {
    const res = await request(fx.asMe).get(`/api/timesheets/timesheets/my-week?week_start=2031-03-05`);
    expect(res.status).toBe(200);
    expect(res.body.week_start).toBe(WEEK);
    const full = res.body.full_day_hours;
    const byDate = Object.fromEntries(res.body.days.map(d => [d.date, d]));
    expect(byDate['2031-03-03']).toMatchObject({ hours: 9.5, source: 'punch' });
    expect(byDate['2031-03-04']).toMatchObject({ hours: full, source: 'standard' });
    expect(byDate['2031-03-05']).toMatchObject({ hours: 0, source: 'leave' });
    expect(byDate['2031-03-06']).toMatchObject({ hours: full / 2, source: 'half_leave' });
    expect(byDate['2031-03-07']).toMatchObject({ hours: 0, source: 'holiday' });
    expect(byDate['2031-03-08'].source).toBe('weekend');
    expect(byDate['2031-03-09'].source).toBe('weekend');
    expect(res.body.status).toBe('not_started');
    expect(res.body.projects.map(p => p.id).sort()).toEqual([fx.pA, fx.pB].sort());
  });

  it('splits a day across projects by allocation, in quarter hours, losing nothing', () => {
    const split = svc.splitHours(9.5, [{ id: 1, allocation_pct: 60 }, { id: 2, allocation_pct: 40 }]);
    expect(split).toEqual({ 1: 5.75, 2: 3.75 });
    expect(svc.splitHours(8, [{ id: 7, allocation_pct: 100 }])).toEqual({ 7: 8 });
    expect(svc.splitHours(0, [{ id: 7, allocation_pct: 100 }])).toEqual({});
  });
});

describe('days that have not happened yet', () => {
  // The test clock is pinned to 2099-12-31, so a week in 2100 is all future.
  it('are pre-filled as 0 and cannot be booked', async () => {
    const res = await request(fx.asMe).get('/api/timesheets/timesheets/my-week?week_start=2100-01-04');
    expect(res.body.days.every(d => d.source === 'future' && d.hours === 0)).toBe(true);
    const put = await request(fx.asMe).put('/api/timesheets/timesheets/my-week')
      .send({ week_start: '2100-01-04', rows: [{ work_date: '2100-01-04', project_id: fx.pA, hours: 4 }] });
    expect(put.status).toBe(400);
    expect(put.body.code).toBe('FUTURE_DATE');
  });
});

describe('save and submit the week', () => {
  it('refuses a project the employee is not on', async () => {
    const res = await request(fx.asMe).put('/api/timesheets/timesheets/my-week')
      .send({ week_start: WEEK, rows: [{ work_date: '2031-03-04', project_id: fx.pOther, hours: 2 }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ON_PROJECT');
  });

  it('refuses a date outside the week', async () => {
    const res = await request(fx.asMe).put('/api/timesheets/timesheets/my-week')
      .send({ week_start: WEEK, rows: [{ work_date: '2031-03-12', project_id: fx.pA, hours: 2 }] });
    expect(res.status).toBe(400);
  });

  it('saves a draft, then submits, then locks the week', async () => {
    const rows = [
      { work_date: '2031-03-03', project_id: fx.pA, hours: 5.75 },
      { work_date: '2031-03-03', project_id: fx.pB, hours: 3.75 },
      { work_date: '2031-03-04', project_id: fx.pA, hours: 8 },
    ];
    const draft = await request(fx.asMe).put('/api/timesheets/timesheets/my-week').send({ week_start: WEEK, rows });
    expect(draft.status).toBe(200);
    expect(draft.body.status).toBe('draft');
    expect(draft.body.entries).toHaveLength(3);

    const sub = await request(fx.asMe).put('/api/timesheets/timesheets/my-week').send({ week_start: WEEK, rows, submit: true });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('submitted');
    // Re-saving replaced the drafts; it did not add a second copy.
    const { rows: live } = await pool.query(
      `SELECT count(*)::int n FROM timesheet_entries WHERE employee_id = $1 AND deleted_at IS NULL`, [fx.me]);
    expect(live[0].n).toBe(3);

    const again = await request(fx.asMe).put('/api/timesheets/timesheets/my-week').send({ week_start: WEEK, rows });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WEEK_LOCKED');
  });
});

describe('approval by the team lead, from the Approval Center', () => {
  it('lists the week as ONE item the lead can act on, and the member cannot', async () => {
    const items = await SOURCE_BY_TYPE.ts.pending(fx.co.companyId);
    const mine = items.filter(r => Number(r.requester_emp_id) === fx.me);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0].amount)).toBe(17.5);
    fx.item = mine[0];
    const leadCtx = await buildContext(fakeReq(fx.lead, ['employee']));
    const meCtx = await buildContext(fakeReq(fx.me, ['employee']));
    expect(SOURCE_BY_TYPE.ts.canAct(leadCtx, fx.item)).toBe(true);
    expect(SOURCE_BY_TYPE.ts.canAct(meCtx, fx.item)).toBe(false);
  });

  it('the member cannot approve their own week', async () => {
    const res = await request(fx.asMe).post('/api/timesheets/timesheets/approve').send({ ids: fx.item.entry_ids });
    expect(res.status).toBe(403);
  });

  it('the lead (employee role, no grant) rejects with a reason, the member corrects and resubmits, the lead approves', async () => {
    const { body, url } = SOURCE_BY_TYPE.ts.actions(fx.item).reject;
    const rej = await request(fx.asLead).post(`/api${url}`).send({ ...body, reason: 'Tue was on project B' });
    expect(rej.status).toBe(200);
    const week = await request(fx.asMe).get(`/api/timesheets/timesheets/my-week?week_start=${WEEK}`);
    expect(week.body.status).toBe('rejected');
    expect(week.body.rejection_reason).toBe('Tue was on project B');

    const fixed = await request(fx.asMe).put('/api/timesheets/timesheets/my-week').send({ week_start: WEEK, submit: true, rows: [
      { work_date: '2031-03-03', project_id: fx.pA, hours: 5.75 },
      { work_date: '2031-03-03', project_id: fx.pB, hours: 3.75 },
      { work_date: '2031-03-04', project_id: fx.pB, hours: 8 },
    ] });
    expect(fixed.status).toBe(200);
    expect(fixed.body.status).toBe('submitted');

    const [item] = (await SOURCE_BY_TYPE.ts.pending(fx.co.companyId)).filter(r => Number(r.requester_emp_id) === fx.me);
    const ok = await request(fx.asLead).post(`/api${SOURCE_BY_TYPE.ts.actions(item).approve.url}`)
      .send(SOURCE_BY_TYPE.ts.actions(item).approve.body);
    expect(ok.status).toBe(200);
    const done = await request(fx.asMe).get(`/api/timesheets/timesheets/my-week?week_start=${WEEK}`);
    expect(done.body.status).toBe('approved');
    const { rows } = await pool.query(
      `SELECT DISTINCT approved_by FROM timesheet_entries WHERE employee_id = $1 AND deleted_at IS NULL`, [fx.me]);
    expect(rows.map(r => r.approved_by)).toEqual([fx.lead]);
  });

  it('someone who leads nobody is refused', async () => {
    const outsider = await employee('outsider');
    const app = appAs({ userId: 990000103, roles: ['employee'], employeeId: outsider });
    const res = await request(app).post('/api/timesheets/timesheets/approve').send({ ids: [1] });
    expect(res.status).toBe(403);
  });
});

describe("Monday's automatic submit", () => {
  it('submits an untouched week from the pre-fill, once', async () => {
    const first = await svc.autoSubmitWeek(fx.co.companyId, WEEK2);
    expect(first.submitted).toBe(1);
    expect(first.prefilled).toBe(1);
    const week = await request(fx.asMe).get(`/api/timesheets/timesheets/my-week?week_start=${WEEK2}`);
    expect(week.body.status).toBe('submitted');
    // Five working days with no punch, all standard days, split 60/40.
    const total = week.body.entries.reduce((s, e) => s + e.hours_worked, 0);
    expect(total).toBe(5 * week.body.full_day_hours);

    const second = await svc.autoSubmitWeek(fx.co.companyId, WEEK2);
    expect(second.submitted).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('leaves an approved week alone', async () => {
    const r = await svc.autoSubmitWeek(fx.co.companyId, WEEK);
    expect(r.submitted).toBe(0);
    const { rows } = await pool.query(
      `SELECT DISTINCT status FROM timesheet_entries WHERE employee_id = $1 AND deleted_at IS NULL AND work_date < '2031-03-10'`, [fx.me]);
    expect(rows.map(x => x.status)).toEqual(['approved']);
  });
});

describe('menu eligibility', () => {
  it('true for someone on a project, false for someone on none', async () => {
    expect(await svc.onAProject(fx.me, fx.co.companyId, WEEK)).toBe(true);
    expect(await svc.onAProject(fx.lead, fx.co.companyId, WEEK)).toBe(false);
  });
});
