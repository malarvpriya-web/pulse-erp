/**
 * integration.attendanceRules.test.js — §278.3 (owner, 2026-11-19).
 *
 * Pins, against the real database:
 *   · Saving Attendance Settings no longer fails on the policy-type check
 *     (the field-staff clock-in window is a 'clock_window' policy).
 *   · Late-coming penalty rules: editable list, validated, applied without
 *     charging the same morning twice, and added to LOP by Payroll Sync.
 *   · Regularization: only the employee asks, on the same day by default.
 *   · Team monthly summary: late bands, leave, geo, penalty days, team only.
 *   · Punch reminders: before shift start, once a day, not after punching.
 *   · Punctuality score for a performance review.
 *
 * Fixture tenant 999805 (ZZATR); every row is created here and removed in afterAll.
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
const { applyRules, normaliseRules } = await import('../shared/attendancePenalties.js');
const { runPunchReminders } = await import('../jobs/attendanceReminders.cron.js');
const { punctualityFor, ratingFor, leaveRatingFor } = await import('../shared/attendancePunctuality.js');
const { autoGrantHolidayCompOff } = await import('../shared/compOff.js');

const CO = 999805;
const ids = { mgr: null, emp: null, other: null, userEmp: null };
const RULES = [
  { id: 'r1', kind: 'late_count', count: 3, minutes: 15, deduct_days: 0.5, active: true },
  { id: 'r2', kind: 'late_each', count: 1, minutes: 60, deduct_days: 0.5, active: true },
  { id: 'r3', kind: 'early_count', count: 3, minutes: 30, deduct_days: 0.5, active: true },
];

function appAs(roles, employeeId = null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: -428051, id: -428051, roles, role: roles[0], company_id: CO, employee_id: employeeId };
    req.scope = { company_id: CO };
    next();
  });
  a.use('/api/attendance', attendanceRtr);
  return a;
}
const admin = () => appAs(['admin']);

const pad = (n) => String(n).padStart(2, '0');
const prev = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return { m: d.getMonth() + 1, y: d.getFullYear() }; })();
const prevDay = (n) => `${prev.y}-${pad(prev.m)}-${pad(n)}`;
const weekdaysOfPrev = () => {
  const out = []; const last = new Date(prev.y, prev.m, 0).getDate();
  for (let d = 1; d <= last; d++) { const w = new Date(prev.y, prev.m - 1, d).getDay(); if (w !== 0 && w !== 6) out.push(prevDay(d)); }
  return out;
};

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM employees WHERE company_id = $1`, [CO]);
  const emp = rows.map((r) => r.id);
  if (emp.length) {
    for (const t of ['attendance_regularization_requests', 'attendance_records', 'attendance_audit_logs', 'payroll_attendance_summary', 'attendance_reminders_sent']) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::int[])`, [emp]).catch(() => {});
    }
    await pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE employee_id = ANY($1::int[]))`, [emp]);
    await pool.query(`DELETE FROM users WHERE employee_id = ANY($1::int[])`, [emp]);
  }
  await pool.query(`DELETE FROM attendance_audit_logs WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM payroll_attendance_summary WHERE company_id = $1`, [CO]);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_policies WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_general_settings WHERE company_id = $1`, [CO]);
}

const mkEmp = async (code, first) => (await pool.query(
  `INSERT INTO employees (company_id, office_id, first_name, last_name, status, department, joining_date)
   VALUES ($1, $2, $3, 'ZZATR', 'Active', 'ZZATR Ops', '2024-01-01') RETURNING id`, [CO, code, first])).rows[0].id;
const att = (e, date, status, late = 0, early = 0) => pool.query(
  `INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, check_in_time, check_out_time, late_minutes, early_leave_minutes, source)
   VALUES ($1, $2, $3, $4, '09:00', '18:00', $5, $6, 'biometric')
   ON CONFLICT (employee_id, attendance_date) DO UPDATE SET status = $3, late_minutes = $5, early_leave_minutes = $6`,
  [e, date, status, CO, late, early]);

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZATR Rules Tenant', 'ZZATR') ON CONFLICT (id) DO NOTHING`, [CO]);
  await cleanup();
  ids.mgr = await mkEmp('EMP9998051', 'Mala');
  ids.emp = await mkEmp('EMP9998052', 'Esha');
  ids.other = await mkEmp('EMP9998053', 'Omar');
  await pool.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [ids.mgr, ids.emp]);
  ids.userEmp = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, employee_id, company_id)
     VALUES ('Esha ZZATR', 'esha.zzatr@example.invalid', 'x', 'employee', true, $1, $2) RETURNING id`, [ids.emp, CO])).rows[0].id;
});

afterAll(async () => {
  await cleanup();
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
});

describe('Attendance Settings — the save error and the penalty rules', () => {
  it('saves the field-staff clock-in window (was: violates attendance_policies_policy_type_check)', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings')
      .send({ clock_window_early_minutes: 20, clock_window_late_minutes: 25, grace_minutes: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ clock_window_early_minutes: 20, clock_window_late_minutes: 25 });
  });

  it('saves, returns and replaces the penalty rule list', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings').send({ penalty_rules: RULES });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.penalty_rules).toHaveLength(3);
    const res2 = await request(admin()).put('/api/attendance/general-settings').send({ penalty_rules: RULES.slice(0, 2) });
    expect(res2.body.penalty_rules.map((r) => r.id)).toEqual(['r1', 'r2']);
    await request(admin()).put('/api/attendance/general-settings').send({ penalty_rules: RULES });
  });

  it('refuses a bad rule', async () => {
    const bad = await request(admin()).put('/api/attendance/general-settings')
      .send({ penalty_rules: [{ kind: 'late_count', count: 3, minutes: 15, deduct_days: 0.3 }] });
    expect(bad.status).toBe(400);
    expect(() => normaliseRules([{ kind: 'nap', minutes: 5, count: 1, deduct_days: 1 }])).toThrow();
  });

  it('an employee cannot change the rules', async () => {
    const res = await request(appAs(['employee'], ids.emp)).put('/api/attendance/general-settings').send({ penalty_rules: [] });
    expect(res.status).toBe(403);
  });
});

describe('penalty arithmetic (owner’s three rules)', () => {
  const d = (date, status, late = 0, early = 0) => ({ date, status, late_minutes: late, early_leave_minutes: early });

  it('3 lates > 15 min = half a day; 6 = a full day', () => {
    const days = [1, 2, 3, 4, 5, 6].map((i) => d(`2026-01-0${i}`, 'late', 20));
    expect(applyRules(RULES, days.slice(0, 2)).days).toBe(0);
    expect(applyRules(RULES, days.slice(0, 3)).days).toBe(0.5);
    expect(applyRules(RULES, days).days).toBe(1);
  });

  it('a 70-minute late is half a day by itself and is not counted again in the 3-lates rule', () => {
    const days = [d('2026-01-01', 'late', 70), d('2026-01-02', 'late', 20), d('2026-01-03', 'late', 20)];
    const r = applyRules(RULES, days);
    expect(r.days).toBe(0.5);                      // only r2; the two 20-min lates are not yet 3
    expect(r.lines.find((l) => l.rule_id === 'r2').occurrences).toBe(1);
  });

  it('leaving 30+ min early 3 times = half a day; absent days never count', () => {
    const days = [d('2026-01-01', 'present', 0, 40), d('2026-01-02', 'present', 0, 35), d('2026-01-03', 'present', 0, 31),
      d('2026-01-04', 'absent', 90, 90)];
    expect(applyRules(RULES, days).days).toBe(0.5);
  });

  it('an inactive rule is skipped', () => {
    const off = RULES.map((r) => ({ ...r, active: r.id !== 'r1' }));
    expect(applyRules(off, [1, 2, 3].map((i) => d(`2026-01-0${i}`, 'late', 20))).days).toBe(0);
  });
});

describe('Payroll Sync adds the penalty to loss of pay', () => {
  it('3 lates over 15 min + one over 60 min → 1 day penalty, stored and in lop_days', async () => {
    const wd = weekdaysOfPrev();
    for (const [i, date] of wd.entries()) {
      const late = i < 3 ? 20 : i === 3 ? 75 : 0;
      await att(ids.emp, date, late ? 'late' : 'present', late);
    }
    const res = await request(admin()).post('/api/attendance/payroll-sync')
      .send({ month: prev.m, year: prev.y, force: true, employee_ids: [ids.emp] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows: [s] } = await pool.query(
      `SELECT lop_days, penalty_lop_days, penalty_detail FROM payroll_attendance_summary WHERE employee_id = $1 AND month = $2 AND year = $3`,
      [ids.emp, prev.m, prev.y]);
    expect(Number(s.penalty_lop_days)).toBe(1);
    expect(Number(s.lop_days)).toBeGreaterThanOrEqual(1);
    expect(s.penalty_detail.map((l) => l.rule_id).sort()).toEqual(['r1', 'r2']);
  });

  it('the employee sees it in My Attendance; a colleague cannot', async () => {
    const mine = await request(appAs(['employee'], ids.emp)).get(`/api/attendance/penalties/${ids.emp}?month=${prev.m}&year=${prev.y}`);
    expect(mine.status).toBe(200);
    expect(mine.body.penalty_days).toBe(1);
    expect(mine.body.rules).toHaveLength(3);
    expect((await request(appAs(['employee'], ids.other)).get(`/api/attendance/penalties/${ids.emp}`)).status).toBe(403);
  });

  it('the monthly report shows the penalty column', async () => {
    const res = await request(admin()).get(`/api/attendance/monthly-report?month=${prev.m}&year=${prev.y}`);
    const row = res.body.records.find((r) => Number(r.employee_id) === ids.emp);
    expect(row.penalty_days).toBe(1);
  });
});

describe('Regularization — the employee, on the same day', () => {
  const today = () => new Date().toLocaleDateString('en-CA');
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA'); };
  const body = (date) => ({ employee_id: ids.emp, date, check_in: '09:00', check_out: '18:00', reason: 'ZZATR forgot' });

  it('refuses yesterday by default (same day only)', async () => {
    const res = await request(appAs(['employee'], ids.emp)).post('/api/attendance/regularize').send(body(yesterday()));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('regularization_window');
  });

  it('HR or a manager cannot raise one for the employee', async () => {
    expect((await request(admin()).post('/api/attendance/regularize').send(body(today()))).status).toBe(403);
    expect((await request(appAs(['manager'], ids.mgr)).post('/api/attendance/regularize').send(body(today()))).status).toBe(403);
  });

  it('the employee can ask for today, and it waits for the manager first', async () => {
    const res = await request(appAs(['employee'], ids.emp)).post('/api/attendance/regularize').send(body(today()));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.approval_level).toBe('manager');
    const s = await request(admin()).get('/api/attendance/general-settings');
    expect(s.body.regularization_window_days).toBe(0);
  });
});

describe('Team monthly summary', () => {
  it('the manager sees their report with the late bands, not the unrelated colleague', async () => {
    await att(ids.other, prevDay(15), 'late', 40);
    const res = await request(appAs(['employee'], ids.mgr)).get(`/api/attendance/team-summary?month=${prev.m}&year=${prev.y}`);
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.employee_id)).toEqual([ids.emp]);
    const m = res.body.members[0];
    expect(m).toMatchObject({ late_15_30: 3, late_over_30: 1, penalty_days: 1 });
    const all = await request(admin()).get(`/api/attendance/team-summary?month=${prev.m}&year=${prev.y}`);
    expect(all.body.members.length).toBe(3);
    const mine = await request(appAs(['employee'], ids.other)).get(`/api/attendance/team-summary?month=${prev.m}&year=${prev.y}`);
    expect(mine.body.members).toHaveLength(0);
  });
});

describe('Punch reminders', () => {
  // A Wednesday that is not a holiday for this tenant.
  const wed = (() => { const d = new Date(); d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7)); return d; })();
  const at = (h, m) => { const d = new Date(wed); d.setHours(h, m, 0, 0); return d; };

  it('office staff get no reminder (they punch on the machine)', async () => {
    await pool.query(`UPDATE employees SET is_field_employee = false WHERE id = $1`, [ids.emp]);
    expect((await runPunchReminders(at(8, 46), { companyIds: [CO] })).punch_in).toBe(0);
  });

  it('field staff: reminded 15 min before the 09:00 start, once, and not after punching', async () => {
    const day = wed.toLocaleDateString('en-CA');
    await pool.query(`UPDATE employees SET is_field_employee = true WHERE id = $1`, [ids.emp]);
    await pool.query(`DELETE FROM attendance_reminders_sent WHERE employee_id = $1`, [ids.emp]);
    await pool.query(`DELETE FROM holidays WHERE date = $1::date AND company_id = $2`, [day, CO]);
    expect((await runPunchReminders(at(8, 30), { companyIds: [CO] })).punch_in).toBe(0);   // too early
    expect((await runPunchReminders(at(8, 46), { companyIds: [CO] })).punch_in).toBe(1);   // the one with a login
    expect((await runPunchReminders(at(8, 50), { companyIds: [CO] })).punch_in).toBe(0);   // already sent today
    const { rows } = await pool.query(`SELECT title, message FROM notifications WHERE user_id = $1`, [ids.userEmp]);
    expect(rows[0].title).toBe('Punch in reminder');
    expect(rows[0].message).toContain('09:00');
    // punch-out at 18:00 after punching in
    await att(ids.emp, day, 'present');
    await pool.query(`UPDATE attendance_records SET check_out_time = NULL WHERE employee_id = $1 AND attendance_date = $2`, [ids.emp, day]);
    expect((await runPunchReminders(at(18, 5), { companyIds: [CO] })).punch_out).toBe(1);
    await pool.query(`DELETE FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [ids.emp, day]);
  });
});

describe('Punctuality rating for a performance review (the company table)', () => {
  it('always on time = 5; the rating follows the % bands, and the table is editable', async () => {
    const wd = weekdaysOfPrev();
    for (const date of wd) await att(ids.other, date, 'present');
    const perfect = await punctualityFor(ids.other, wd[0], wd[wd.length - 1], CO);
    expect(perfect.score).toBe(5);
    expect(perfect.punctuality_pct).toBe(100);
    const scored = await punctualityFor(ids.emp, wd[0], wd[wd.length - 1], CO);
    expect(scored.late_15_30 + scored.late_over_30).toBe(4);
    expect(scored.score).toBe(ratingFor(scored.punctuality_pct));          // default table
    expect(scored.punctuality_pct).toBeLessThan(95);
    // HR loosens the table: 75 % on time is now a 5.
    const res = await request(admin()).put('/api/attendance/general-settings')
      .send({ punctuality_bands: [{ min_pct: 75, rating: 5 }, { min_pct: 50, rating: 3 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.punctuality_bands.at(-1)).toEqual({ min_pct: 0, rating: 1 });      // floor added
    expect((await punctualityFor(ids.emp, wd[0], wd[wd.length - 1], CO)).score).toBe(5);
    expect((await request(admin()).put('/api/attendance/general-settings')
      .send({ punctuality_bands: [{ min_pct: 120, rating: 9 }] })).status).toBe(400);
  });
});

describe('Leave rating for a performance review (the company table)', () => {
  it('days off = approved leave (no weekly offs) + absent days; the rating follows the editable table', async () => {
    expect(leaveRatingFor(0)).toBe(5);
    expect(leaveRatingFor(6)).toBe(5);
    expect(leaveRatingFor(6.5)).toBe(4);
    expect(leaveRatingFor(40)).toBe(1);
    const wd = weekdaysOfPrev();
    await att(ids.other, wd[0], 'absent');
    await pool.query(`INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, status, company_id)
                      VALUES ($1, (SELECT id FROM leave_types ORDER BY id LIMIT 1), $2, $3, 'approved', $4)`, [ids.other, wd[1], wd[2], CO]);
    try {
      const a = await punctualityFor(ids.other, wd[0], wd[wd.length - 1], CO);
      expect(a.leave_days).toBe(2);
      expect(a.days_off).toBe(3);
      expect(a.leave_rating).toBe(5);
      const res = await request(admin()).put('/api/attendance/general-settings')
        .send({ leave_rating_bands: [{ max_days: 2, rating: 5 }, { max_days: null, rating: 2 }] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await punctualityFor(ids.other, wd[0], wd[wd.length - 1], CO)).leave_rating).toBe(2);
      expect((await request(admin()).put('/api/attendance/general-settings')
        .send({ leave_rating_bands: [{ max_days: 5, rating: 7 }] })).status).toBe(400);
    } finally {
      await pool.query(`DELETE FROM leave_applications WHERE employee_id = $1`, [ids.other]);
    }
  });
});

describe('Report numbers are settings', () => {
  it('late-warning count and early-exit minutes save and drive the Early Exit report', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings').send({ late_warning_count: 5, early_exit_minutes: 25 });
    expect(res.body).toMatchObject({ late_warning_count: 5, early_exit_minutes: 25 });
    const rep = await request(admin()).get(`/api/attendance/reports/early-exit?month=${prev.m}&year=${prev.y}`);
    expect(rep.body.min_early_minutes).toBe(25);
    expect((await request(admin()).put('/api/attendance/general-settings').send({ late_warning_count: 0 })).status).toBe(400);
  });

  it('a late warning shows the employee’s current name after a rename', async () => {
    await pool.query(`INSERT INTO attendance_late_warnings (company_id, employee_id, employee_name, department, month, late_count, warning_text)
                      VALUES ($1, $2, 'Old Name', 'Old Dept', '2026-01', 4, 'ZZATR')`, [CO, ids.emp]);
    const res = await request(admin()).get('/api/attendance/late-arrivals/warnings');
    const w = res.body.find((r) => Number(r.employee_id) === ids.emp);
    expect(w.employee_name).toContain('Esha');
    expect(w.department).toBe('ZZATR Ops');
    await pool.query(`DELETE FROM attendance_late_warnings WHERE company_id = $1`, [CO]);
  });
});

describe('Late bands on Live Workforce', () => {
  it('saves the minutes and the live board returns them', async () => {
    const res = await request(admin()).put('/api/attendance/general-settings').send({ late_bands: [30, 10, 15, 15] });
    expect(res.body.late_bands).toEqual([10, 15, 30]);
    const live = await request(admin()).get('/api/attendance/live-dashboard');
    expect(live.body.late_bands).toEqual([10, 15, 30]);
    expect((await request(admin()).put('/api/attendance/general-settings').send({ late_bands: [] })).status).toBe(400);
  });
});

describe('Comp off — only for the employees HR chooses', () => {
  it('HR sets the list; an employee cannot', async () => {
    const put = await request(admin()).put('/api/attendance/comp-off-eligibility').send({ employee_ids: [ids.emp] });
    expect(put.status).toBe(200);
    const list = (await request(admin()).get('/api/attendance/comp-off-eligibility')).body;
    expect(list.filter((e) => e.comp_off_eligible).map((e) => e.id)).toEqual([ids.emp]);
    expect((await request(appAs(['employee'], ids.emp)).get('/api/attendance/comp-off-eligibility')).status).toBe(403);
  });

  it('a holiday worked in full grants comp off to a chosen employee only, and only when switched on', async () => {
    const date = prevDay(28);
    const { rows: [h] } = await pool.query(
      `INSERT INTO holidays (name, date, company_id, type) VALUES ('ZZATR Holiday', $1, $2, 'Public') RETURNING id`, [date, CO]);
    try {
      const args = { companyId: CO, date, hours: 9, fullDayHours: 8 };
      expect(await autoGrantHolidayCompOff(pool, { ...args, employeeId: ids.emp, enabled: false })).toBe(false);   // switched off
      expect(await autoGrantHolidayCompOff(pool, { ...args, employeeId: ids.other, enabled: true })).toBe(false);  // not chosen
      expect(await autoGrantHolidayCompOff(pool, { ...args, employeeId: ids.emp, enabled: true })).toBe(true);
      expect(await autoGrantHolidayCompOff(pool, { ...args, employeeId: ids.emp, enabled: true })).toBe(false);    // once
    } finally {
      await pool.query(`DELETE FROM compensatory_off WHERE company_id = $1`, [CO]);
      await pool.query(`DELETE FROM holidays WHERE id = $1`, [h.id]);
    }
  });
});

describe('Contract labour → Finance', () => {
  it('sends the month per contractor (man-days, hours) and keeps the statement', async () => {
    const { rows: [w] } = await pool.query(`
      INSERT INTO contract_labour (company_id, contractor_company, employee_name, is_active)
      VALUES ($1, 'ZZATR Manpower', 'Worker ZZATR', true) RETURNING id`, [CO]);
    try {
      for (const [d, st, hrs] of [[3, 'present', 8], [4, 'half_day', 4], [5, 'late', 8], [6, 'absent', 0]]) {
        await pool.query(`INSERT INTO contract_labour_attendance (company_id, contract_id, attendance_date, status, hours_worked)
                          VALUES ($1, $2, $3, $4, $5)`, [CO, w.id, prevDay(d), st, hrs]);
      }
      const res = await request(admin()).post('/api/attendance/contract-labour/send-to-finance').send({ month: prev.m, year: prev.y });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.statements[0]).toMatchObject({ contractor_company: 'ZZATR Manpower', workers: 1 });
      expect(Number(res.body.statements[0].present_days)).toBe(2.5);
      expect(Number(res.body.statements[0].hours)).toBe(20);
      const again = await request(admin()).post('/api/attendance/contract-labour/send-to-finance').send({ month: prev.m, year: prev.y });
      expect(again.status).toBe(200);
      const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM contract_labour_finance_statements WHERE company_id = $1`, [CO]);
      expect(rows[0].n).toBe(1);                                     // replaced, not duplicated
      expect((await request(appAs(['manager'], ids.mgr)).post('/api/attendance/contract-labour/send-to-finance')
        .send({ month: prev.m, year: prev.y })).status).toBe(403);
    } finally {
      await pool.query(`DELETE FROM contract_labour_finance_statements WHERE company_id = $1`, [CO]);
      await pool.query(`DELETE FROM contract_labour_attendance WHERE company_id = $1`, [CO]);
      await pool.query(`DELETE FROM contract_labour WHERE company_id = $1`, [CO]);
    }
  });
});
