/**
 * integration.attendanceAccess.test.js — §278.2 (go-live check, 2026-11-18).
 *
 * The attendance router sits behind login only. Before this pass most GET
 * routes never asked whose records they returned, so a plain employee could
 * read every colleague's punches, late arrivals, overtime, live board and
 * audit log; and approval followed the LOGIN ROLE, so a reporting manager who
 * held only `employee` saw none of their team's requests and got 403.
 *
 * Pins, against the real database:
 *   · reads: HR/admin → everyone; a reporting manager → self + team;
 *     anyone else → self only;
 *   · decisions: a reporting manager decides their team whatever their role,
 *     never someone else's team, never their own request;
 *   · auto-absent only runs when today's machine punches actually arrived.
 *
 * Fixture tenant 999804 (ZZATA); every row is created here and removed in afterAll.
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
const { todaysPunchesArrived } = await import('../jobs/attendance.cron.js');

const CO = 999804;
const ids = { mgr: null, rep: null, other: null, otRep: null, otOther: null, otMgr: null, device: null };
let today;

function appAs(roles, employeeId = null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: -428041, id: -428041, roles, role: roles[0], company_id: CO, employee_id: employeeId };
    req.scope = { company_id: CO };
    next();
  });
  a.use('/api/attendance', attendanceRtr);
  return a;
}
const admin = () => appAs(['admin']);
const mgr = () => appAs(['employee'], ids.mgr);       // a reporting manager with only the employee role
const rep = () => appAs(['employee'], ids.rep);
const other = () => appAs(['employee'], ids.other);
const unlinked = () => appAs(['employee'], null);

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM employees WHERE company_id = $1`, [CO]);
  const emp = rows.map((r) => r.id);
  if (emp.length) {
    for (const t of ['attendance_regularization_requests', 'attendance_ot_records', 'attendance_records', 'biometric_logs', 'attendance_audit_logs']) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::int[])`, [emp]);
    }
    await pool.query(`DELETE FROM org_relationships WHERE employee_id = ANY($1::int[])`, [emp]);
    await pool.query(`DELETE FROM notifications WHERE module_name = 'attendance' AND reference_id::text IN (
      SELECT id::text FROM attendance_regularization_requests WHERE company_id = $1)`, [CO]).catch(() => {});
  }
  await pool.query(`DELETE FROM biometric_logs WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM biometric_devices WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_audit_logs WHERE company_id = $1`, [CO]);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM employees WHERE company_id = $1`, [CO]);
  await pool.query(`DELETE FROM attendance_general_settings WHERE company_id = $1`, [CO]);
}

const mkEmp = async (code, first) => (await pool.query(
  `INSERT INTO employees (company_id, office_id, first_name, last_name, status, department, joining_date)
   VALUES ($1, $2, $3, 'ZZATA', 'Active', 'ZZATA Ops', '2024-01-01') RETURNING id`, [CO, code, first])).rows[0].id;
const mkOt = async (employeeId) => (await pool.query(
  `INSERT INTO attendance_ot_records (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, reason, status)
   VALUES ($1, $2, $3::date - 1, 1.5, 'weekday', 2, 'ZZATA test', 'pending') RETURNING id`, [CO, employeeId, today])).rows[0].id;

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZATA Access Tenant', 'ZZATA') ON CONFLICT (id) DO NOTHING`, [CO]);
  await cleanup();
  today = (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
  // Corrections up to a week back (the default is same day only, §278.3).
  await pool.query(`INSERT INTO attendance_general_settings (company_id, regularization_window_days) VALUES ($1, 7)`, [CO]);
  ids.mgr = await mkEmp('EMP9998041', 'Mani');
  ids.rep = await mkEmp('EMP9998042', 'Ravi');
  ids.other = await mkEmp('EMP9998043', 'Olga');
  // Department name unique to this tenant, and nobody heads it.
  await pool.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [ids.mgr, ids.rep]);
  for (const e of [ids.mgr, ids.rep, ids.other]) {
    await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, check_in_time, late_minutes, source)
       VALUES ($1, $2, 'late', $3, '09:30', 30, 'biometric')`, [e, today, CO]);
  }
  ids.otRep = await mkOt(ids.rep);
  ids.otOther = await mkOt(ids.other);
  ids.otMgr = await mkOt(ids.mgr);
  await pool.query(
    `INSERT INTO attendance_audit_logs (company_id, employee_id, action, after_data) VALUES ($1, $2, 'zzata_test', '{}')`,
    [CO, ids.rep]);
});

afterAll(async () => {
  await cleanup();
  await pool.query(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
});

const idsIn = (rows, key = 'employee_id') => rows.map((r) => Number(r[key])).sort((a, b) => a - b);

describe('one employee’s attendance — self, manager or HR only', () => {
  for (const path of ['/today/:id', '/summary/:id', '/breaks/:id', '/employee/:id?month=1&year=2026']) {
    it(`GET ${path}`, async () => {
      const url = (id) => `/api/attendance${path.replace(':id', id)}`;
      expect((await request(other()).get(url(ids.rep))).status).toBe(403);   // a colleague
      expect((await request(rep()).get(url(ids.rep))).status).toBe(200);    // self
      expect((await request(mgr()).get(url(ids.rep))).status).toBe(200);    // reporting manager, employee role
      expect((await request(mgr()).get(url(ids.other))).status).toBe(403);  // not their team
      expect((await request(admin()).get(url(ids.other))).status).toBe(200);
      expect((await request(unlinked()).get(url(ids.rep))).status).toBe(403);
    });
  }
});

describe('lists — HR all, manager team, employee self', () => {
  it('GET /date/:date', async () => {
    const all = (await request(admin()).get(`/api/attendance/date/${today}`)).body;
    expect(idsIn(all)).toEqual([ids.mgr, ids.rep, ids.other].sort((a, b) => a - b));
    expect(idsIn((await request(other()).get(`/api/attendance/date/${today}`)).body)).toEqual([ids.other]);
    expect(idsIn((await request(mgr()).get(`/api/attendance/date/${today}`)).body)).toEqual([ids.mgr, ids.rep].sort((a, b) => a - b));
  });

  it('GET /live-dashboard', async () => {
    const res = await request(other()).get(`/api/attendance/live-dashboard?date=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.people.map((p) => p.id)).toEqual([ids.other]);
    expect(res.body.presence.total_employees).toBe(1);
    expect((await request(admin()).get(`/api/attendance/live-dashboard?date=${today}`)).body.people).toHaveLength(3);
  });

  it('GET /late-arrivals and the CSV export', async () => {
    expect(idsIn((await request(other()).get('/api/attendance/late-arrivals')).body)).toEqual([ids.other]);
    expect((await request(admin()).get('/api/attendance/late-arrivals')).body).toHaveLength(3);
    const csv = (await request(other()).get('/api/attendance/late-arrivals/export')).text;
    expect(csv).toContain('Olga');
    expect(csv).not.toContain('Ravi');
  });

  it('GET /overtime and /overtime/stats', async () => {
    expect(idsIn((await request(other()).get('/api/attendance/overtime')).body)).toEqual([ids.other]);
    expect(idsIn((await request(mgr()).get('/api/attendance/overtime')).body)).toEqual([ids.mgr, ids.rep].sort((a, b) => a - b));
    expect((await request(admin()).get('/api/attendance/overtime')).body).toHaveLength(3);
    const d = new Date(`${today}T00:00:00`); d.setDate(d.getDate() - 1);
    const q = `?month=${d.getMonth() + 1}&year=${d.getFullYear()}`;
    expect((await request(other()).get(`/api/attendance/overtime/stats${q}`)).body.total_records).toBe(1);
    expect((await request(admin()).get(`/api/attendance/overtime/stats${q}`)).body.total_records).toBe(3);
  });

  it('GET /audit-logs', async () => {
    const mine = (await request(other()).get('/api/attendance/audit-logs?action=zzata_test')).body;
    expect(mine).toHaveLength(0);
    expect((await request(mgr()).get('/api/attendance/audit-logs?action=zzata_test')).body).toHaveLength(1);
  });

  it('contract labour and work-centre logs are for managers / HR roles only', async () => {
    expect((await request(other()).get('/api/attendance/contract-labour')).status).toBe(403);
    expect((await request(other()).get(`/api/attendance/work-centre?date=${today}`)).status).toBe(403);
    expect((await request(appAs(['manager'], ids.mgr)).get('/api/attendance/contract-labour')).status).toBe(200);
  });

  it('every analytics / report route still answers (scoped SQL is valid)', async () => {
    const d = new Date(`${today}T00:00:00`);
    const mq = `month=${d.getMonth() + 1}&year=${d.getFullYear()}`;
    const paths = [
      `/analytics/heatmap?${mq}`, '/analytics/absenteeism?period=12m', `/analytics/department-absenteeism?${mq}`,
      `/analytics/overtime-cost?${mq}`, `/analytics/shift-efficiency?${mq}`, `/analytics/top-absentees?${mq}`,
      `/analytics/perfect-attendance?${mq}`, `/reports/leave-reconciliation?${mq}`, `/reports/early-exit?${mq}`,
      `/monthly-report?${mq}`, '/late-arrivals/warnings', `/geo-violations?from_date=${today}&to_date=${today}`,
      '/approval-delegations', '/regularize/stats', '/shift-change-requests',
    ];
    for (const p of paths) {
      for (const who of [other, mgr, admin]) {
        const res = await request(who()).get(`/api/attendance${p}`);
        expect(res.status, `${p}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      }
    }
    const body = (await request(other()).get(`/api/attendance/monthly-report?${mq}`)).body;
    const rows = body.records;
    expect(idsIn(rows)).toEqual([ids.other]);
  });

  it('an unlinked non-HR login gets 403, not the company', async () => {
    expect((await request(unlinked()).get('/api/attendance/late-arrivals')).status).toBe(403);
    expect((await request(unlinked()).get(`/api/attendance/live-dashboard?date=${today}`)).status).toBe(403);
  });
});

describe('decisions follow the reporting line, not the login role', () => {
  it('a reporting manager with only the employee role decides their report’s overtime', async () => {
    const res = await request(mgr()).put(`/api/attendance/overtime/${ids.otRep}/reject`).send({ remarks: 'ZZATA no' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  it('but not someone else’s team', async () => {
    const res = await request(mgr()).put(`/api/attendance/overtime/${ids.otOther}/reject`).send({ remarks: 'ZZATA no' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_YOUR_REPORT');
  });

  it('and never their own request', async () => {
    const res = await request(mgr()).put(`/api/attendance/overtime/${ids.otMgr}/reject`).send({ remarks: 'ZZATA no' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL');
  });

  it('someone with no team cannot decide at all', async () => {
    const res = await request(other()).put(`/api/attendance/overtime/${ids.otOther}/reject`).send({ remarks: 'ZZATA no' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ATTENDANCE_ROLE_REQUIRED');
  });

  it('the manager’s regularization queue shows their report’s request', async () => {
    const d = new Date(`${today}T00:00:00`); d.setDate(d.getDate() - 2);
    const day = d.toLocaleDateString('en-CA');
    const ask = await request(rep()).post('/api/attendance/regularize')
      .send({ employee_id: ids.rep, date: day, check_in: '09:00', check_out: '17:45', reason: 'ZZATA forgot' });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const list = (await request(mgr()).get('/api/attendance/regularize/list?status=pending')).body;
    expect(list.map((r) => Number(r.employee_id))).toContain(ids.rep);
    const theirs = (await request(other()).get('/api/attendance/regularize/list?status=pending')).body;
    expect(theirs.map((r) => Number(r.employee_id))).not.toContain(ids.rep);
  });
});

describe('auto-absent — only when today’s punches reached Pulse', () => {
  it('a machine that never synced today does not count', async () => {
    ids.device = (await pool.query(
      `INSERT INTO biometric_devices (device_name, ip_address, company_id, last_sync)
       VALUES ('ZZATA gate', '10.0.0.99', $1, NOW() - INTERVAL '2 days') RETURNING id`, [CO])).rows[0].id;
    expect(await todaysPunchesArrived(CO, today)).toBe(false);
  });

  it('a sync today with no punches still does not count', async () => {
    await pool.query(`UPDATE biometric_devices SET last_sync = NOW() WHERE id = $1`, [ids.device]);
    expect(await todaysPunchesArrived(CO, today)).toBe(false);
  });

  it('a sync today plus a punch today counts', async () => {
    await pool.query(
      `INSERT INTO biometric_logs (employee_id, device_id, punch_time, punch_type, company_id)
       VALUES ($1, $2, ($3::date + TIME '09:05'), 'in', $4)`, [ids.rep, ids.device, today, CO]);
    expect(await todaysPunchesArrived(CO, today)).toBe(true);
  });
});
