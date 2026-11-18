/**
 * integration.attendanceConsolidation.test.js — §278 (owner, 2026-11-18).
 *
 * Pins what the attendance consolidation changed, against the REAL database:
 *   · Attendance Settings live in ONE row per company; saving working days
 *     rewrites weekend_days, so the two can no longer disagree.
 *   · Regularization: 3 per employee per month (Settings), one open request per
 *     day, hours worked shown, an HR decision is recorded once as HR, and a
 *     decided request cannot be decided again.
 *   · Overtime is OFF by default: recordOvertime() makes no request until it
 *     is switched on.
 *   · Shift change: "this day only" approves into a date override; "from this
 *     date" changes the shift assignment.
 *   · A machine punch (CSV import) is marked Late against the employee's shift.
 *
 * Fixture tenant 999801 (ZZATC); every row is created here and removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { default: attendanceRtr } = await import('../modules/attendance/routes/attendance.routes.js');
const { default: biometricRtr } = await import('../modules/hr/biometric.routes.js');
const { recordOvertime } = await import('../shared/attendanceRules.js');
const { resolveEmployeeShift } = await import('../shared/shiftResolve.js');

const CO = 999801;
const ids = { emp: null, shiftA: null, shiftB: null };

function appAs(roles, employeeId = null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: -428011, id: -428011, roles, role: roles[0], company_id: CO, employee_id: employeeId };
    req.scope = { company_id: CO };
    next();
  });
  a.use('/api/attendance', attendanceRtr);
  a.use('/api', biometricRtr);
  return a;
}
const admin = () => appAs(['admin']);
const self = () => appAs(['employee'], ids.emp);

const monthDay = (d) => {
  // Working days of the PREVIOUS month, so "future date" never applies.
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const x = new Date(first); x.setDate(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM employees WHERE company_id = $1`, [CO]);
  const emp = rows.map((r) => r.id);
  if (emp.length) {
    for (const t of ['attendance_regularization_requests', 'attendance_ot_records', 'attendance_records', 'shift_change_requests',
      'hr_shift_assignments', 'hr_shift_date_overrides', 'biometric_logs', 'attendance_audit_logs']) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::int[])`, [emp]);
    }
    await pool.query(`DELETE FROM notifications WHERE reference_id::text = ANY($1::text[]) AND module_name = 'attendance'`, [emp.map(String)]).catch(() => {});
  }
  await pool.query(`DELETE FROM attendance_audit_logs WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM hr_shifts WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_policies WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_general_settings WHERE company_id = $1`, [CO]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZATC Attendance Tenant', 'ZZATC') ON CONFLICT (id) DO NOTHING`, [CO]);
  await cleanup();
  ids.emp = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, department, joining_date)
     VALUES ($1, 'EMP9998011', 'Zara', 'ZZATC', 'Active', 'ZZATC Ops', '2024-01-01') RETURNING id`, [CO])).rows[0].id;
  const mkShift = async (name, start, end) => (await pool.query(
    `INSERT INTO hr_shifts (name, start_time, end_time, grace_minutes, company_id) VALUES ($1, $2, $3, 10, $4) RETURNING id`,
    [name, start, end, CO])).rows[0].id;
  ids.shiftA = await mkShift('ZZATC Day', '09:00', '17:30');
  ids.shiftB = await mkShift('ZZATC Night', '21:00', '05:30');
  await pool.query(`INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, is_active, company_id) VALUES ($1, $2, '2024-01-01', true, $3)`,
    [ids.emp, ids.shiftA, CO]);
});

afterAll(async () => {
  await cleanup();
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
});

describe('Attendance Settings — one row per company', () => {
  it('saves to the company row and keeps weekend_days the complement of working_days', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings').send({
      working_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      full_day_hours: 8, break_duration: 30, regularization_monthly_limit: 3, ot_enabled: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.weekend_days).toEqual(['sunday']);
    expect(res.body.break_duration).toBe(30);
    // a second save updates the same row
    await request(admin()).put('/api/attendance/general-settings').send({ grace_minutes: 10 });
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM attendance_general_settings WHERE company_id = $1`, [CO]);
    expect(rows[0].n).toBe(1);
    const { rows: g } = await pool.query(`SELECT COUNT(*)::int n FROM attendance_general_settings WHERE company_id IS NULL`);
    expect(g[0].n).toBeLessThanOrEqual(1);
  });

  it('refuses a week with no working day', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings').send({ working_days: [] });
    expect(res.status).toBe(400);
  });
});

describe('Regularization — limit, duplicates, hours, decisions', () => {
  const ask = (date, extra = {}) => request(self()).post('/api/attendance/regularize')
    .send({ employee_id: ids.emp, date, check_in: '09:00', check_out: '17:45', reason: 'ZZATC test', ...extra });

  it('allows 3 a month, then refuses the 4th; one open request per day', async () => {
    const r1 = await ask(monthDay(3));
    expect(r1.status).toBe(200);
    expect(Number(r1.body.requested_hours)).toBeCloseTo(8.75, 2);
    expect((await ask(monthDay(3))).status).toBe(409);            // same day, still pending
    expect((await ask(monthDay(4))).status).toBe(200);
    expect((await ask(monthDay(5))).status).toBe(200);
    const r4 = await ask(monthDay(6));
    expect(r4.status).toBe(409);
    expect(r4.body.error).toBe('regularization_limit');
    const quota = await request(self()).get(`/api/attendance/regularize/quota/${ids.emp}?date=${monthDay(6)}`);
    expect(quota.body).toMatchObject({ limit: 3, used: 3 });
  });

  it('an HR approval is recorded once, as HR, corrects the day, and cannot be repeated', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT id FROM attendance_regularization_requests WHERE employee_id = $1 AND date = $2`, [ids.emp, monthDay(3)]);
    const ok = await request(admin()).put(`/api/attendance/regularize/${r.id}/approve`).send({ remarks: 'checked' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.manager_actioned_at).toBeNull();
    expect(ok.body.hr_actioned_at).not.toBeNull();
    const { rows: [att] } = await pool.query(
      `SELECT to_char(check_in_time,'HH24:MI') cin, to_char(check_out_time,'HH24:MI') cout, total_hours::float h, source
         FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [ids.emp, monthDay(3)]);
    expect(att).toMatchObject({ cin: '09:00', cout: '17:45', source: 'regularization' });
    expect(att.h).toBeCloseTo(8.75, 2);
    expect((await request(admin()).put(`/api/attendance/regularize/${r.id}/approve`).send({})).status).toBe(409);
    expect((await request(admin()).put(`/api/attendance/regularize/${r.id}/reject`).send({ remarks: 'x' })).status).toBe(409);
  });

  it('a rejection needs a reason and frees the allowance', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT id FROM attendance_regularization_requests WHERE employee_id = $1 AND date = $2`, [ids.emp, monthDay(4)]);
    expect((await request(admin()).put(`/api/attendance/regularize/${r.id}/reject`).send({})).status).toBe(400);
    expect((await request(admin()).put(`/api/attendance/regularize/${r.id}/reject`).send({ remarks: 'no proof' })).status).toBe(200);
    expect((await ask(monthDay(6))).status).toBe(200);           // the rejected one no longer counts
  });
});

describe('Overtime is off until switched on', () => {
  it('makes no overtime request while off, and a pending one when on', async () => {
    const day = monthDay(10);
    expect(await recordOvertime(pool, { companyId: CO, employeeId: ids.emp, date: day, otHours: 2 })).toBe(0);
    let { rows } = await pool.query(`SELECT * FROM attendance_ot_records WHERE employee_id = $1`, [ids.emp]);
    expect(rows).toHaveLength(0);
    await pool.query(`UPDATE attendance_general_settings SET ot_enabled = true WHERE company_id = $1`, [CO]);
    expect(await recordOvertime(pool, { companyId: CO, employeeId: ids.emp, date: day, otHours: 2 })).toBe(2);
    ({ rows } = await pool.query(`SELECT status, ot_hours::float h FROM attendance_ot_records WHERE employee_id = $1`, [ids.emp]));
    expect(rows).toEqual([{ status: 'pending', h: 2 }]);
    await pool.query(`UPDATE attendance_general_settings SET ot_enabled = false WHERE company_id = $1`, [CO]);
  });
});

describe('Shift change — one day vs from a date', () => {
  it('"this day only" becomes a date override for that day alone', async () => {
    const day = '2030-03-12'; const next = '2030-03-13';
    const req = await request(self()).post('/api/attendance/shift-change-requests')
      .send({ employee_id: ids.emp, request_date: day, requested_shift_id: ids.shiftB, change_type: 'day', reason: 'ZZATC swap' });
    expect(req.status).toBe(201);
    expect(req.body.current_shift_id).toBe(ids.shiftA);
    // the requester cannot see or approve another employee's request; HR approves
    const ok = await request(admin()).put(`/api/attendance/shift-change-requests/${req.body.id}/approve`).send({});
    expect(ok.status).toBe(200);
    expect((await resolveEmployeeShift(ids.emp, day)).shift.id).toBe(ids.shiftB);
    expect((await resolveEmployeeShift(ids.emp, next)).shift.id).toBe(ids.shiftA);
  });

  it('"from this date" changes the assignment', async () => {
    const req = await request(self()).post('/api/attendance/shift-change-requests')
      .send({ employee_id: ids.emp, request_date: '2030-04-01', requested_shift_id: ids.shiftB, change_type: 'permanent', reason: 'ZZATC move' });
    expect(req.status).toBe(201);
    expect((await request(admin()).put(`/api/attendance/shift-change-requests/${req.body.id}/approve`).send({})).status).toBe(200);
    expect((await resolveEmployeeShift(ids.emp, '2030-04-15')).shift.id).toBe(ids.shiftB);
  });

  it('a request needs a reason, and the list only shows the caller their own', async () => {
    expect((await request(self()).post('/api/attendance/shift-change-requests')
      .send({ employee_id: ids.emp, request_date: '2030-05-01', requested_shift_id: ids.shiftA })).status).toBe(400);
    const mine = await request(self()).get('/api/attendance/shift-change-requests');
    expect(mine.status).toBe(200);
    expect(mine.body.every((r) => r.employee_id === ids.emp)).toBe(true);
  });
});

describe('Machine punches are marked late against the shift', () => {
  it('09:31 on a 09:00 shift with 10 min grace is Late by 31 min', async () => {
    const day = monthDay(12);
    const res = await request(admin()).post('/api/biometric/logs/import')
      .send({ csv_data: `employee_id,punch_time,punch_type\nEMP9998011,${day} 09:31,in\n` });
    expect(res.status).toBe(200);
    const { rows: [att] } = await pool.query(
      `SELECT status, late_minutes FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [ids.emp, day]);
    expect(att).toEqual({ status: 'late', late_minutes: 31 });
  });
});

describe('Team attendance is scoped to the caller (§278.1)', () => {
  it('a non-admin cannot read another manager team; their own works', async () => {
    const other = await request(self()).get('/api/attendance/team/1?date=2030-01-07');
    expect(other.status).toBe(403);
    const mine = await request(self()).get(`/api/attendance/team/${ids.emp}?date=2030-01-07`);
    expect(mine.status).toBe(200);
  });

  it('My Attendance summary carries the punctuality figures', async () => {
    const d = monthDay(12);
    const res = await request(self()).get(`/api/attendance/employee/${ids.emp}?month=${Number(d.slice(5, 7))}&year=${d.slice(0, 4)}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ late: 1, late_minutes_total: 31 });
    expect(res.body.summary).toHaveProperty('within_grace');
    expect(res.body.summary).toHaveProperty('avg_check_in');
  });
});

