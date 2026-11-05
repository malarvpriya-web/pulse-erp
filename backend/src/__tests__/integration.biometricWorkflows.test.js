/**
 * Biometric & Access Control — the workflows, end to end against the real
 * database (MODULE_FEATURE_CONNECTION_MANUAL.md §197).
 *
 * integration.biometricAuthz.test.js pins WHO may call each route. This file
 * pins WHAT each route does: CSV import into biometric_logs AND
 * attendance_records, device sync processing, punch-log / gate-pass / visitor
 * filters, every gate-pass and visitor transition, the dashboard counts, and
 * that none of it crosses a tenant.
 *
 * Isolation. Everything runs in fixture tenant 999943 (ZZBAW) with a foreign
 * tenant 999919, both registered with testTenantIds.contract.test.js by
 * appearing here. No Manifest (company 1) row is read or written. Cleanup
 * deletes by ids captured at creation — never by company.
 *
 * ⚠ Device sync is exercised through a SIMULATED driver (`deviceDriver.read`
 * replaced by a fake returning fixed logs). That proves our processing of
 * whatever a device returns — matching, de-duplication, attendance, status —
 * and nothing about a physical ZKTeco unit. No socket is opened by this file.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Same bootstrap as integration.biometricAuthz.test.js: setup.js presets a
// placeholder DB_PASSWORD, so the real one is read from backend/.env.
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const routes = await import('../modules/hr/biometric.routes.js');
const { default: biometricRtr, deviceDriver } = routes;

const CO = 999943;        // fixture tenant: ZZBAW
const FOREIGN = 999919;   // foreign tenant: ZZBAF
const PROBE_USER_ID = -424243;

const ids = {
  emp: {}, foreignEmp: null, device: null, deviceNoIp: null, foreignDevice: null,
  leave: null, gatePasses: [], visitors: [], foreignPass: null, foreignVisitor: null,
};

let actingEmployeeId = null;
function appAs(roles, companyId = CO, employeeId = undefined) {
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use((req, _res, next) => {
    const emp = employeeId === undefined ? actingEmployeeId : employeeId;
    req.user  = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0], company_id: companyId, employee_id: emp };
    req.scope = { company_id: companyId };
    next();
  });
  a.use('/api', biometricRtr);
  return a;
}
const hr = () => appAs(['hr']);
const attendanceAdmin = () => appAs(['manager']);

const realDriver = { read: deviceDriver.read, available: deviceDriver.available };
afterEach(() => { deviceDriver.read = realDriver.read; deviceDriver.available = realDriver.available; });

/** Company-timezone dates/times, computed by the database the routes use. */
async function istDay(offsetDays) {
  const { rows } = await pool.query(
    `SELECT to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') AS d`, [offsetDays]);
  return rows[0].d;
}

const track = (list, res) => { if (res.body?.id != null) list.push(res.body.id); return res; };
const postPass = async (body, app = hr()) => track(ids.gatePasses, await request(app).post('/api/gate-passes').send(body));
const postVisitor = async (body, app = hr()) => track(ids.visitors, await request(app).post('/api/visitors').send(body));
const importCsv = (csv, extra = {}) =>
  request(attendanceAdmin()).post('/api/biometric/logs/import').send({ csv_data: csv, ...extra });
const attendanceOf = async (empId, day) =>
  (await pool.query(
    `SELECT to_char(check_in_time, 'HH24:MI') AS cin, to_char(check_out_time, 'HH24:MI') AS cout,
            status, source, total_hours::float AS total_hours, ot_hours::float AS ot_hours
       FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [empId, day])).rows[0];
const logCount = async (empId) =>
  (await pool.query('SELECT COUNT(*)::int n FROM biometric_logs WHERE employee_id = $1', [empId])).rows[0].n;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZBAW Workflow Tenant', 'ZZBAW'), ($2, 'ZZBAF Foreign Tenant', 'ZZBAF')
     ON CONFLICT (id) DO NOTHING`, [CO, FOREIGN]);

  // Leftovers from an interrupted earlier run, found by the fixture's own
  // unique office codes only.
  const { rows: stale } = await pool.query(
    `SELECT id FROM employees WHERE office_id = ANY($1::text[])`,
    [['EMP9994301', 'EMP9994302', 'EMP9994303', 'EMP9994304', 'EMP9994305', 'EMP9994306', 'EMP9994307', 'EMP9994308', 'EMP9991901']]);
  await pool.query(`DELETE FROM department_heads WHERE company_id = $1 AND head_employee_id IN (
                      SELECT id FROM employees WHERE office_id ~ '^EMP99943')`, [CO]);
  for (const { id } of stale) await deleteEmployeeFixture(id);
  // …and the rows an interrupted run leaves that hang off no employee: the
  // fixture devices, the foreign visitor and visitor-only passes. Matched on
  // the fixture tenant AND the fixture's own name prefix, never on company alone.
  const FIX = [CO, FOREIGN];
  await pool.query(
    `DELETE FROM biometric_logs WHERE device_id IN (
       SELECT id FROM biometric_devices WHERE company_id = ANY($1::int[]) AND device_name ~ '^ZZBA[WF] ')`, [FIX]);
  await pool.query(`DELETE FROM biometric_devices WHERE company_id = ANY($1::int[]) AND device_name ~ '^ZZBA[WF] '`, [FIX]);
  await pool.query(`DELETE FROM visitors WHERE company_id = ANY($1::int[]) AND name ~* '^ZZBA[WF] '`, [FIX]);
  await pool.query(`DELETE FROM gate_passes WHERE company_id = ANY($1::int[]) AND (visitor_name ~* '^ZZBA[WF] ' OR purpose ~* '^ZZBA[WF] ')`, [FIX]);

  const mk = async (company, code, first, status) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, department)
     VALUES ($1, $2, $3, 'ZZBAW', $4, 'ZZBAW Ops') RETURNING id`, [company, code, first, status])).rows[0].id;
  ids.emp.active   = await mk(CO, 'EMP9994301', 'Asha', 'Active');
  ids.emp.second   = await mk(CO, 'EMP9994302', 'Bala', 'Active');
  ids.emp.left     = await mk(CO, 'EMP9994303', 'Chitra', 'Left');
  ids.emp.onLeave  = await mk(CO, 'EMP9994304', 'Deepa', 'Probation');
  ids.foreignEmp   = await mk(FOREIGN, 'EMP9991901', 'Foreign', 'Active');
  actingEmployeeId = ids.emp.second;

  // Approver fixtures (§198): an Engineering head in THIS tenant only
  // (department_heads is company-scoped), a reporting manager, two holders.
  const mkIn = async (code, first, dept, managerId = null) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, status, department, reporting_manager_id)
     VALUES ($1, $2, $3, 'ZZBAW', 'Active', $4, $5) RETURNING id`, [CO, code, first, dept, managerId])).rows[0].id;
  ids.emp.mgr      = await mkIn('EMP9994307', 'Mohan', 'General');
  ids.emp.engHead  = await mkIn('EMP9994306', 'Hema', 'Engineering');
  ids.emp.engStaff = await mkIn('EMP9994305', 'Eswar', 'Engineering', ids.emp.mgr);
  ids.emp.genStaff = await mkIn('EMP9994308', 'Gita', 'General', ids.emp.mgr);
  const { rows: [eng] } = await pool.query(`SELECT id FROM master_departments WHERE LOWER(name) = 'engineering' LIMIT 1`);
  ids.engDept = eng.id;
  ids.deptHead = (await pool.query(
    `INSERT INTO department_heads (company_id, department_id, head_employee_id, assigned_at) VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [CO, eng.id, ids.emp.engHead])).rows[0].id;
  // The fixture tenant must have no General head, so Gita falls to her manager.
  const { rows: gh } = await pool.query(
    `SELECT 1 FROM department_heads dh JOIN master_departments d ON d.id = dh.department_id
      WHERE dh.company_id = $1 AND dh.ended_at IS NULL AND LOWER(d.name) = 'general'`, [CO]);
  expect(gh, 'fixture tenant must have no General head').toEqual([]);

  const dev = async (company, name, ip) => (await pool.query(
    `INSERT INTO biometric_devices (company_id, device_name, ip_address, port) VALUES ($1, $2, $3, 4370) RETURNING id`,
    [company, name, ip])).rows[0].id;
  ids.device        = await dev(CO, 'ZZBAW Gate', '192.0.2.43');      // TEST-NET-1: never dialled here
  ids.deviceNoIp    = await dev(CO, 'ZZBAW Unconfigured', null);
  ids.foreignDevice = await dev(FOREIGN, 'ZZBAF Gate', '192.0.2.19');

  const today = await istDay(0);
  const { rows: lt } = await pool.query('SELECT id FROM leave_types ORDER BY id LIMIT 1');
  ids.leave = (await pool.query(
    `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, status, company_id)
     VALUES ($1, $2, $3, $3, 'approved', $4) RETURNING id`, [ids.emp.onLeave, lt[0].id, today, CO])).rows[0].id;

  // A payroll-frozen January 2026 for the fixture tenant.
  await pool.query(
    `INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, is_frozen, source)
     VALUES ($1, '2026-01-05', 'present', $2, true, 'manual')`, [ids.emp.second, CO]);

  ids.foreignPass = (await pool.query(
    `INSERT INTO gate_passes (employee_id, visitor_name, purpose, status, company_id)
     VALUES ($1, 'ZZBAF Pass', 'foreign', 'pending', $2) RETURNING id`, [ids.foreignEmp, FOREIGN])).rows[0].id;
  ids.foreignVisitor = (await pool.query(
    `INSERT INTO visitors (name, phone, company_id) VALUES ('ZZBAF Visitor', '9000000019', $1) RETURNING id`,
    [FOREIGN])).rows[0].id;
});

async function deleteEmployeeFixture(id) {
  // Only fixture employees report to a fixture manager.
  await pool.query('UPDATE employees SET reporting_manager_id = NULL WHERE reporting_manager_id = $1', [id]);
  await pool.query('DELETE FROM biometric_logs     WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM attendance_records WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM leave_applications WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM gate_passes        WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM visitors           WHERE host_employee_id = $1', [id]);
  await pool.query('DELETE FROM employees          WHERE id = $1', [id]);
}

afterAll(async () => {
  // Exact captured ids, batched. Each step runs even if an earlier one fails,
  // so one error cannot strand the rest; the first error is rethrown at the end.
  const steps = [
    ['DELETE FROM gate_passes WHERE id = ANY($1::int[])', [...ids.gatePasses, ids.foreignPass].filter(Boolean)],
    ['DELETE FROM visitors WHERE id = ANY($1::int[])', [...ids.visitors, ids.foreignVisitor].filter(Boolean)],
    ['DELETE FROM biometric_logs WHERE device_id = ANY($1::int[])', [ids.device, ids.deviceNoIp, ids.foreignDevice].filter(Boolean)],
    ['DELETE FROM biometric_devices WHERE id = ANY($1::int[])', [ids.device, ids.deviceNoIp, ids.foreignDevice].filter(Boolean)],
  ];
  let firstError = null;
  try { if (ids.deptHead) await pool.query('DELETE FROM department_heads WHERE id = $1', [ids.deptHead]); } catch (e) { firstError ??= e; }
  for (const [sql, list] of steps) {
    try { if (list.length) await pool.query(sql, [list]); } catch (e) { firstError ??= e; }
  }
  for (const id of [...Object.values(ids.emp), ids.foreignEmp].filter(Boolean)) {
    try { await deleteEmployeeFixture(id); } catch (e) { firstError ??= e; }
  }
  if (firstError) throw firstError;
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
describe('CSV import → biometric_logs and attendance_records', () => {
  let day;
  beforeAll(async () => { day = await istDay(-2); });

  it('requires all three columns and names the missing one', async () => {
    const res = await importCsv(`employee_id,punch_time\nEMP9994301,${day} 09:05`);
    expect(res.status).toBe(400);
    expect(res.body.missing_columns).toEqual(['punch_type']);
  });

  it('a dry run reports every row outcome and writes NOTHING', async () => {
    const before = await logCount(ids.emp.active);
    const csv = [
      'Employee_ID,Punch_Time,Punch_Type',
      `EMP9994301,${day} 09:05,in`,
      `emp9994301,${day} 18:30:00,OUT`,          // code is case-insensitive
      `EMP9994301,${day} 18:30,out`,             // same instant again → duplicate in file
      `EMP9994302,${day} 25:00,in`,              // invalid hour
      `EMP9994302,31/02/2026 09:00,in`,          // invalid calendar date
      `EMP9994302,${day} 09:00,lunch`,           // invalid punch type
      `EMP0000000,${day} 09:00,in`,              // unknown employee
      `EMP9991901,${day} 09:00,in`,              // FOREIGN tenant's employee
      `EMP9994302,2099-01-01 09:00,in`,          // future
      ',,',                                       // blank line is ignored
    ].join('\r\n');
    const res = await importCsv(csv, { dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.total_rows).toBe(9);
    expect(res.body.valid_rows).toBe(2);
    expect(res.body.attendance_updated).toBe(2);
    expect(res.body.duplicates_in_file).toBe(1);
    expect(res.body.invalid_rows).toBe(6);
    const text = res.body.errors.join(' | ');
    expect(text).toMatch(/Row 3: duplicate of an earlier row/);
    expect(text).toMatch(/Row 4: punch_time .* is not a valid date\/time/);
    expect(text).toMatch(/Row 5: punch_time .* is not a valid date\/time/);
    expect(text).toMatch(/Row 6: punch_type "lunch" must be in or out/);
    expect(text).toMatch(/Row 7: unknown employee EMP0000000/);
    expect(text).toMatch(/Row 8: unknown employee EMP9991901/);
    expect(text).toMatch(/Row 9: .* is in the future/);
    expect(await logCount(ids.emp.active), 'a dry run must roll back').toBe(before);
    expect(await attendanceOf(ids.emp.active, day)).toBeUndefined();
  });

  it('commits valid punches to biometric_logs AND the day\'s attendance record', async () => {
    const csv = `employee_id,punch_time,punch_type\nEMP9994301,${day} 09:05,in\nEMP9994301,${day} 18:30,out\n`;
    const res = await importCsv(csv, { device_id: ids.device });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dry_run: false, imported: 2, attendance_updated: 2, duplicates: 0 });

    const { rows } = await pool.query(
      `SELECT punch_type, device_id, company_id, processed, raw_data->>'source' AS source
         FROM biometric_logs WHERE employee_id = $1 ORDER BY punch_time`, [ids.emp.active]);
    expect(rows).toEqual([
      { punch_type: 'in',  device_id: ids.device, company_id: CO, processed: true, source: 'csv_import' },
      { punch_type: 'out', device_id: ids.device, company_id: CO, processed: true, source: 'csv_import' },
    ]);
    const att = await attendanceOf(ids.emp.active, day);
    expect(att).toMatchObject({ cin: '09:05', cout: '18:30', status: 'present', source: 'biometric' });
    expect(att.total_hours).toBeCloseTo(9.42, 2);
    // 09:05–18:30 is 9.42 h on site; a full day is 8 h + 30 min break = 8.5 h (§198).
    expect(att.ot_hours, 'OT beyond the 8.5 h on-site day').toBeCloseTo(0.92, 2);
  });

  it('⚠⚠ re-importing the same file duplicates nothing', async () => {
    const before = await logCount(ids.emp.active);
    const csv = `employee_id,punch_time,punch_type\nEMP9994301,${day} 09:05,in\nEMP9994301,${day} 18:30,out\n`;
    const res = await importCsv(csv, { device_id: ids.device });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, duplicates: 2, attendance_updated: 0 });
    expect(await logCount(ids.emp.active)).toBe(before);
  });

  it('merges into an existing record: earliest in, latest out; promotes only from absent', async () => {
    const d2 = await istDay(-3);
    await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, check_in_time, check_out_time, status, company_id, source)
       VALUES ($1, $2, '08:50', '17:00', 'absent', $3, 'manual')`, [ids.emp.second, d2, CO]);
    const res = await importCsv(`employee_id,punch_time,punch_type\nEMP9994302,${d2} 09:30,in\nEMP9994302,${d2} 19:00,out`);
    expect(res.body.attendance_updated).toBe(2);
    const att = await attendanceOf(ids.emp.second, d2);
    expect(att).toMatchObject({ cin: '08:50', cout: '19:00', status: 'present', source: 'manual' });

    // A leave day keeps its status — a punch is never allowed to erase leave.
    const d3 = await istDay(-4);
    await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, source)
       VALUES ($1, $2, 'on_leave', $3, 'leave_sync')`, [ids.emp.second, d3, CO]);
    await importCsv(`employee_id,punch_time,punch_type\nEMP9994302,${d3} 10:00,in`);
    expect((await attendanceOf(ids.emp.second, d3)).status).toBe('on_leave');
  });

  it('⚠⚠ a payroll-frozen month is logged but attendance is NOT touched', async () => {
    const res = await importCsv('employee_id,punch_time,punch_type\nEMP9994301,2026-01-20 09:00,in');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, attendance_updated: 0, attendance_locked: 1 });
    expect(await attendanceOf(ids.emp.active, '2026-01-20')).toBeUndefined();
    const { rows } = await pool.query(
      `SELECT processed FROM biometric_logs WHERE employee_id = $1 AND punch_time = '2026-01-20 09:00+05:30'`, [ids.emp.active]);
    expect(rows).toEqual([{ processed: false }]);
  });

  it('⚠ dates a punch by the COMPANY timezone, not UTC (00:00–05:30 IST)', async () => {
    const res = await importCsv([
      'employee_id,punch_time,punch_type',
      'EMP9994301,2026-09-20 00:30,in',            // no offset → company zone
      'EMP9994302,2026-09-19T20:00:00Z,in',        // 01:30 IST on the 20th
      'EMP9994302,20/09/2026 18:15,out',           // DD/MM/YYYY
    ].join('\n'));
    expect(res.body.errors).toEqual([]);
    expect((await attendanceOf(ids.emp.active, '2026-09-20')).cin).toBe('00:30');
    expect(await attendanceOf(ids.emp.active, '2026-09-19')).toBeUndefined();
    expect(await attendanceOf(ids.emp.second, '2026-09-20')).toMatchObject({ cin: '01:30', cout: '18:15' });
  });

  it('refuses a value that matches two different employees through different keys', async () => {
    await pool.query('UPDATE employees SET biometric_user_id = $1 WHERE id = $2', [String(ids.emp.active), ids.emp.second]);
    try {
      const res = await importCsv(`employee_id,punch_time,punch_type\n${ids.emp.active},${day} 11:00,in`, { dry_run: true });
      expect(res.body.valid_rows).toBe(0);
      expect(res.body.errors[0]).toMatch(/matches more than one employee/);
    } finally {
      await pool.query('UPDATE employees SET biometric_user_id = NULL WHERE id = $1', [ids.emp.second]);
    }
  });

  it('refuses an oversized file with 413 and a foreign device with 404', async () => {
    const big = 'employee_id,punch_time,punch_type\n' + 'x'.repeat(2_000_001);
    expect((await importCsv(big)).status).toBe(413);
    expect((await importCsv(`employee_id,punch_time,punch_type\nEMP9994301,${day} 09:00,in`, { device_id: ids.foreignDevice })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device sync — processing, with a SIMULATED driver (no hardware)', () => {
  const sync = (id) => request(attendanceAdmin()).post(`/api/biometric/devices/${id}/sync`).send({});
  const deviceRow = async (id) => (await pool.query(
    'SELECT status, last_sync, status_checked_at, last_error FROM biometric_devices WHERE id = $1', [id])).rows[0];

  it('⚠⚠ an unreachable device is a 502 and "offline" — never a success', async () => {
    deviceDriver.read = async () => { const e = new Error('connect ETIMEDOUT 192.0.2.43:4370'); throw e; };
    const before = await deviceRow(ids.device);
    const res = await sync(ids.device);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ synced: false, status: 'offline' });
    expect(res.body.message).toMatch(/No punches were imported/);
    const after = await deviceRow(ids.device);
    expect(after.status).toBe('offline');
    expect(after.last_error).toMatch(/ETIMEDOUT/);
    expect(after.status_checked_at).not.toBeNull();
    expect(after.last_sync, 'a failed sync must not move last_sync').toEqual(before.last_sync);
  });

  it('a device with no IP is "not configured" (422), and a missing SDK is 503', async () => {
    let called = 0;
    deviceDriver.read = async () => { called++; return { users: [], logs: [] }; };
    const r1 = await sync(ids.deviceNoIp);
    expect(r1.status).toBe(422);
    expect(r1.body.status).toBe('not_configured');
    deviceDriver.available = () => false;
    const r2 = await sync(ids.device);
    expect(r2.status).toBe(503);
    expect(r2.body.code).toBe('SDK_NOT_INSTALLED');
    expect(called, 'neither may reach the driver').toBe(0);
  });

  it('processes what the device returned: matched, unmatched and duplicate punches', async () => {
    const day = await istDay(-5);
    const at = (hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
    deviceDriver.read = async () => ({
      users: [{ userId: 'EMP9994302', name: 'Bala ZZBAW' }, { userId: '777', name: 'Nobody Known' }],
      logs: [
        { deviceUserId: 'EMP9994302', attTime: at('09:10'), inOutStatus: 0 },
        { deviceUserId: 'EMP9994302', attTime: at('09:10'), inOutStatus: 0 },   // repeated by the device
        { deviceUserId: 'EMP9994302', attTime: at('18:20'), inOutStatus: 1 },
        { deviceUserId: '777',        attTime: at('09:15'), inOutStatus: 0 },
        { deviceUserId: 'EMP9994302', attTime: at('12:00'), inOutStatus: 9 },   // unknown status → skipped
      ],
    });
    const res = await sync(ids.device);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ synced: true, total_logs: 5, processed: 2, duplicates: 1, unmatched: 1, skipped: 1 });
    expect(await attendanceOf(ids.emp.second, day)).toMatchObject({ cin: '09:10', cout: '18:20', source: 'biometric' });
    const { rows } = await pool.query(
      `SELECT employee_id, company_id FROM biometric_logs WHERE device_id = $1 AND raw_data->>'devUserId' = '777'`, [ids.device]);
    expect(rows, 'an unmatched punch is kept for later mapping').toEqual([{ employee_id: null, company_id: CO }]);
    const dev = await deviceRow(ids.device);
    expect(dev.status).toBe('online');
    expect(dev.last_error).toBeNull();
    expect(Date.now() - new Date(dev.last_sync).getTime()).toBeLessThan(60_000);

    const again = await sync(ids.device);
    expect(again.body).toMatchObject({ processed: 0, duplicates: 4, unmatched: 0 });
  });

  it('⚠ Test on a REACHABLE port answers 200 and records the check (it was a 500)', async () => {
    // A listener this test owns on loopback — a TCP port test, not a device.
    const net = await import('node:net');
    const server = net.createServer((s) => s.end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { rows: [d] } = await pool.query(
      `INSERT INTO biometric_devices (company_id, device_name, ip_address, port) VALUES ($1, 'ZZBAW Loopback', '127.0.0.1', $2) RETURNING id`,
      [CO, port]);
    try {
      const res = await request(attendanceAdmin()).post(`/api/biometric/devices/${d.id}/test`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ connected: true, status: 'online' });
      expect(res.body.message).toMatch(/network port only/);
      const row = (await pool.query('SELECT status, status_checked_at, last_error FROM biometric_devices WHERE id = $1', [d.id])).rows[0];
      expect(row.status).toBe('online');
      expect(row.status_checked_at).not.toBeNull();
      expect(row.last_error).toBeNull();
    } finally {
      server.close();
      await pool.query('DELETE FROM biometric_devices WHERE id = $1', [d.id]);
    }
  });

  it('a foreign tenant\'s device 404s before the driver is called', async () => {
    let called = 0;
    deviceDriver.read = async () => { called++; return { users: [], logs: [] }; };
    expect((await sync(ids.foreignDevice)).status).toBe(404);
    expect(called).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Recent Punch Log filters', () => {
  const logs = (qs) => request(hr()).get(`/api/biometric/logs?${qs}`);
  let from;
  beforeAll(async () => { from = await istDay(-6); });

  it('filters by date range, employee, punch type, device, department and search', async () => {
    const to = await istDay(0);
    const all = await logs(`from=${from}&to=${to}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(6);
    for (const r of all.body.rows) expect([ids.emp.active, ids.emp.second, null]).toContain(r.employee_id);

    const one = await logs(`from=${from}&to=${to}&employee_id=${ids.emp.active}`);
    expect(one.body.total).toBe(2);
    expect(one.body.rows.every(r => r.employee_id === ids.emp.active)).toBe(true);

    const outs = await logs(`from=${from}&to=${to}&punch_type=out`);
    expect(outs.body.rows.length).toBeGreaterThan(0);
    expect(outs.body.rows.every(r => r.punch_type === 'out')).toBe(true);
    expect(outs.body.total).toBeLessThan(all.body.total);

    const byDevice = await logs(`from=${from}&to=${to}&device_id=${ids.device}`);
    expect(byDevice.body.rows.every(r => r.device_id === ids.device)).toBe(true);

    expect((await logs(`from=${from}&to=${to}&department=ZZBAW%20Ops`)).body.rows.every(r => r.department === 'ZZBAW Ops')).toBe(true);
    const search = await logs(`from=${from}&to=${to}&q=EMP9994302`);
    expect(search.body.rows.length).toBeGreaterThan(0);
    expect(search.body.rows.every(r => r.emp_code === 'EMP9994302')).toBe(true);
    const unmatched = await logs(`from=${from}&to=${to}&q=777`);
    expect(unmatched.body.rows.map(r => r.device_user_id)).toContain('777');
  });

  it('pages, returns an empty set honestly, and rejects bad input', async () => {
    const to = await istDay(0);
    const p1 = await logs(`from=${from}&to=${to}&page_size=2&page=1`);
    const p2 = await logs(`from=${from}&to=${to}&page_size=2&page=2`);
    expect(p1.body.rows).toHaveLength(2);
    expect(p2.body.rows[0].id).not.toBe(p1.body.rows[0].id);
    const empty = await logs('from=2001-01-01&to=2001-01-02');
    expect(empty.body).toMatchObject({ rows: [], total: 0 });
    expect((await logs('from=2026-13-01')).status).toBe(400);
    expect((await logs('from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await logs('punch_type=sideways')).status).toBe(400);
  });

  it('never shows another tenant\'s punches', async () => {
    const res = await request(appAs(['hr'], FOREIGN)).get(`/api/biometric/logs?from=${from}&to=${await istDay(0)}`);
    expect(res.body.rows.filter(r => [ids.emp.active, ids.emp.second].includes(r.employee_id))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gate passes — lifecycle, filters, tenancy', () => {
  const soon  = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const act = (id, verb, body = {}, app = hr()) => request(app).put(`/api/gate-passes/${id}/${verb}`).send(body);
  const list = (qs = '', app = hr()) => request(app).get(`/api/gate-passes?${qs}`);

  it('refuses a pass that would be born expired', async () => {
    const res = await postPass({ employee_id: ids.emp.active, valid_from: soon(-5), valid_to: soon(-1) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already in the past/);
  });

  it('pending → approved/active (numbered, approver = caller) → completed', async () => {
    const created = await postPass({ employee_id: ids.emp.active, purpose: 'ZZBAW bank visit', valid_from: soon(-1), valid_to: soon(3) });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');

    const approved = await act(created.body.id, 'approve', { approved_by: 1 });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', effective_status: 'active', approved_by: ids.emp.second });
    expect(approved.body.pass_number).toMatch(/^GP-\d{4}-\d{4,}$/);
    expect(approved.body.approved_at).not.toBeNull();

    const again = await act(created.body.id, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.current_status).toBe('active');

    const done = await act(created.body.id, 'complete');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', effective_status: 'completed', completed_by: ids.emp.second });
    expect((await act(created.body.id, 'cancel', { reason: 'late' })).status).toBe(409);
  });

  it('cancel needs a reason; a cancelled pass cannot be approved or completed', async () => {
    const p = await postPass({ visitor_name: 'ZZBAW Courier', valid_to: soon(2) });
    expect((await act(p.body.id, 'cancel', {})).status).toBe(400);
    const c = await act(p.body.id, 'cancel', { reason: 'not needed' });
    expect(c.body).toMatchObject({ status: 'cancelled', cancel_reason: 'not needed', cancelled_by: ids.emp.second });
    expect((await act(p.body.id, 'approve')).status).toBe(409);
    expect((await act(p.body.id, 'complete')).status).toBe(409);
    expect((await act(p.body.id, 'cancel', { reason: 'again' })).status).toBe(409);
  });

  it('an approved pass whose window has not opened reads "approved" and cannot complete; pending cannot complete', async () => {
    const future = await postPass({ employee_id: ids.emp.active, valid_from: soon(24), valid_to: soon(30) });
    expect((await act(future.body.id, 'complete')).status, 'pending cannot complete').toBe(409);
    const a = await act(future.body.id, 'approve');
    expect(a.body.effective_status).toBe('approved');
    const c = await act(future.body.id, 'complete');
    expect(c.status).toBe(409);
    expect(c.body.message).toMatch(/not started/);
  });

  it('an elapsed window reads "expired" whatever is stored, and cannot be approved', async () => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO gate_passes (employee_id, purpose, valid_from, valid_to, status, company_id)
       VALUES ($1, 'ZZBAW old', NOW() - interval '3 days', NOW() - interval '2 days', 'pending', $2) RETURNING id`,
      [ids.emp.active, CO]);
    ids.gatePasses.push(row.id);
    const res = await list('status=expired');
    expect(res.body.rows.map(r => r.id)).toContain(row.id);
    expect(res.body.rows.every(r => r.effective_status === 'expired')).toBe(true);
    expect((await act(row.id, 'approve')).status).toBe(409);
  });

  it('filters by search, status, employee and date range — and the result set changes', async () => {
    const all = await list('page_size=100');
    // bank visit (completed), courier (cancelled), future (approved), old (expired)
    expect(all.body.total).toBe(4);
    const completed = await list('status=completed');
    expect(completed.body.total).toBe(1);
    expect(completed.body.total).toBe(all.body.counts.completed);
    const pn = completed.body.rows[0].pass_number;
    expect((await list(`q=${encodeURIComponent(pn)}`)).body.rows.map(r => r.pass_number)).toEqual([pn]);
    expect((await list('q=Courier')).body.rows.every(r => /Courier/.test(r.visitor_name))).toBe(true);
    const mine = await list(`employee_id=${ids.emp.active}`);
    expect(mine.body.rows.every(r => r.employee_id === ids.emp.active)).toBe(true);
    expect(mine.body.total).toBeLessThan(all.body.total);
    const ahead = await list(`from=${await istDay(1)}&to=${await istDay(2)}`);
    expect(ahead.body.rows.length).toBeGreaterThan(0);
    expect(ahead.body.total).toBeLessThan(all.body.total);
    expect((await list('q=no-such-pass-zz')).body).toMatchObject({ rows: [], total: 0 });
    expect((await list('status=lost')).status).toBe(400);
  });

  it('⚠⚠ another tenant\'s pass is invisible and every transition 404s, leaving it unchanged', async () => {
    const all = await list('page_size=100');
    expect(all.body.rows.map(r => r.id)).not.toContain(ids.foreignPass);
    for (const verb of ['approve', 'complete', 'cancel']) {
      expect((await act(ids.foreignPass, verb, { reason: 'x' })).status, verb).toBe(404);
    }
    const { rows } = await pool.query('SELECT status, approved_by FROM gate_passes WHERE id = $1', [ids.foreignPass]);
    expect(rows[0]).toEqual({ status: 'pending', approved_by: null });
  });

  it('read-only payroll_admin cannot approve, cancel or complete', async () => {
    const p = await postPass({ visitor_name: 'ZZBAW RO probe', valid_to: soon(2) });
    for (const verb of ['approve', 'cancel', 'complete']) {
      expect((await act(p.body.id, verb, { reason: 'x' }, appAs(['payroll_admin']))).status, verb).toBe(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('visitors — check-in/out, filters, counts, tenancy', () => {
  const checkout = (id, app = hr()) => request(app).put(`/api/visitors/${id}/checkout`).send({});
  const list = (qs = '') => request(hr()).get(`/api/visitors?${qs}`);

  it('validates the contact number', async () => {
    for (const phone of ['abc', '12345', '98400-1369x', '+91 98400 13696 0000 1']) {
      const res = await postVisitor({ name: 'ZZBAW Phone Probe', phone });
      expect(res.status, phone).toBe(400);
    }
    expect((await postVisitor({ name: 'ZZBAW Phone OK', phone: '+91 98400-13697' })).status).toBe(201);
  });

  it('⚠⚠ check-in → no second check-in while inside → check-out once → may return', async () => {
    const v = await postVisitor({ name: 'ZZBAW Ravi', company: 'Acme', phone: '9840013601', host_employee_id: ids.emp.active, purpose: 'audit' });
    expect(v.status).toBe(201);
    expect(v.body.check_out_time).toBeNull();

    const dup = await postVisitor({ name: 'Ravi K', phone: '+91 98400 13601' });   // same number, other format
    expect(dup.status).toBe(409);
    expect(dup.body.visitor_id).toBe(v.body.id);

    const out = await checkout(v.body.id);
    expect(out.status).toBe(200);
    expect(out.body.check_out_time).not.toBeNull();
    const second = await checkout(v.body.id);
    expect(second.status).toBe(409);
    const { rows } = await pool.query('SELECT check_out_time FROM visitors WHERE id = $1', [v.body.id]);
    expect(rows[0].check_out_time.toISOString(), 'a repeated check-out must not move the time')
      .toBe(new Date(out.body.check_out_time).toISOString());

    expect((await postVisitor({ name: 'ZZBAW Ravi', company: 'Acme', phone: '9840013601' })).status, 'a new visit after leaving').toBe(201);
  });

  it('without a phone, the same name and company is the same visitor', async () => {
    expect((await postVisitor({ name: 'ZZBAW Walk In', company: 'Beta' })).status).toBe(201);
    expect((await postVisitor({ name: 'zzbaw walk in', company: 'BETA' })).status).toBe(409);
    expect((await postVisitor({ name: 'ZZBAW Walk In', company: 'Gamma' })).status).toBe(201);
  });

  it('two simultaneous check-ins for one person produce exactly one visit', async () => {
    const body = { name: 'ZZBAW Race', phone: '9840013699' };
    const [a, b] = await Promise.all([postVisitor(body), postVisitor(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('filters change the result set; inside_total and the dashboard card agree with the rows', async () => {
    const all = await list('page_size=100');
    const inside = await list('status=inside&page_size=100');
    const outside = await list('status=checked_out&page_size=100');
    expect(inside.body.total + outside.body.total).toBe(all.body.total);
    expect(inside.body.rows.every(r => r.check_out_time === null && r.inside === true)).toBe(true);
    expect(outside.body.rows.every(r => r.check_out_time !== null)).toBe(true);
    expect(inside.body.total).toBe(all.body.inside_total);

    const host = await list(`host_employee_id=${ids.emp.active}`);
    expect(host.body.rows.length).toBeGreaterThan(0);
    expect(host.body.rows.every(r => r.host_employee_id === ids.emp.active)).toBe(true);
    expect((await list('q=Acme')).body.rows.every(r => r.company === 'Acme')).toBe(true);
    expect((await list('q=Asha')).body.rows.every(r => r.host_name?.startsWith('Asha'))).toBe(true);
    expect((await list(`from=${await istDay(0)}&to=${await istDay(0)}`)).body.total).toBe(all.body.total);
    expect((await list('from=2001-01-01&to=2001-01-01')).body).toMatchObject({ rows: [], total: 0 });
    expect((await list('status=gone')).status).toBe(400);

    const dash = await request(hr()).get('/api/biometric/dashboard');
    expect(dash.body.visitors_inside).toBe(all.body.inside_total);
    expect(all.body.rows.map(r => r.id)).not.toContain(ids.foreignVisitor);
  });

  it('records a printed badge; another tenant\'s visitor 404s on every action', async () => {
    const v = await postVisitor({ name: 'ZZBAW Badge', phone: '9840013655' });
    const b = await request(hr()).put(`/api/visitors/${v.body.id}/badge`).send({});
    expect(b.body.badge_printed).toBe(true);
    expect((await request(hr()).put(`/api/visitors/${ids.foreignVisitor}/badge`).send({})).status).toBe(404);
    expect((await checkout(ids.foreignVisitor)).status).toBe(404);
    const { rows } = await pool.query('SELECT check_out_time, badge_printed FROM visitors WHERE id = $1', [ids.foreignVisitor]);
    expect(rows[0]).toEqual({ check_out_time: null, badge_printed: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('dashboard — the population behind each card', () => {
  it('counts current employees only, sets aside approved leave, and reads the configured shift', async () => {
    // A punch three minutes ago for Asha, in company time.
    const { rows: [t] } = await pool.query(
      `SELECT to_char(NOW() AT TIME ZONE 'Asia/Kolkata' - interval '3 minutes', 'YYYY-MM-DD HH24:MI:SS') AS ts,
              to_char(NOW() AT TIME ZONE 'Asia/Kolkata' - interval '3 minutes', 'HH24:MI:SS') AS hms`);
    const imp = await importCsv(`employee_id,punch_time,punch_type\nEMP9994301,${t.ts},in`);
    expect(imp.body.errors).toEqual([]);

    const res = await request(hr()).get('/api/biometric/dashboard');
    expect(res.status).toBe(200);
    const d = res.body;
    // Asha, Bala, Deepa + the four approver fixtures (Mohan, Hema, Eswar,
    // Gita) — Chitra has Left, the foreign employee is another tenant.
    expect(d.total_employees).toBe(7);
    expect(d.on_leave).toBe(1);
    expect(d.punched_in_today).toBe(t.ts.slice(0, 10) === d.date ? 1 : 0);
    if (d.non_working_day) {
      expect(d.not_yet_punched).toBeNull();
    } else {
      expect(d.expected).toBe(6);                       // 7 current − Deepa on leave
      expect(d.not_yet_punched).toBe(6 - d.punched_in_today);
    }
    const secs = (hms) => hms.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0);
    const lateAfter = secs(d.rules.work_start) + d.rules.grace_minutes * 60;
    expect(d.late_arrivals).toBe(d.punched_in_today && secs(t.hms) > lateAfter ? 1 : 0);
  });
});

describe('employee options for the pickers', () => {
  it('lists current employees of the caller\'s tenant only, and is HR-gated', async () => {
    const res = await request(hr()).get('/api/biometric/employees/options');
    expect(res.status).toBe(200);
    expect(res.body.map(e => e.emp_code).sort()).toEqual(
      ['EMP9994301', 'EMP9994302', 'EMP9994304', 'EMP9994305', 'EMP9994306', 'EMP9994307', 'EMP9994308']);
    expect((await request(appAs(['employee'])).get('/api/biometric/employees/options')).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §198 — the gate-pass approver comes from the holder's department
// ─────────────────────────────────────────────────────────────────────────────
describe('gate-pass approver: department head, else reporting manager, else HR', () => {
  const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const passFor = async (employeeId) => {
    const res = await postPass({ employee_id: employeeId, purpose: 'ZZBAW approver probe', valid_to: soon(4) });
    expect(res.status).toBe(201);
    return res.body.id;
  };
  const listRow = async (id, app = hr()) =>
    (await request(app).get('/api/gate-passes?page_size=100')).body.rows.find(r => r.id === id);
  const approve = (id, app) => request(app).put(`/api/gate-passes/${id}/approve`).send({});

  it('an Engineering pass waits for the Engineering head — HR cannot approve over them', async () => {
    const id = await passFor(ids.emp.engStaff);
    const row = await listRow(id);
    expect(row).toMatchObject({ approver_kind: 'department_head', approver_employee_id: ids.emp.engHead, can_approve: false });
    expect(row.approver_name).toMatch(/^Hema/);

    const byHr = await approve(id, hr());
    expect(byHr.status).toBe(403);
    expect(byHr.body.code).toBe('NOT_THE_APPROVER');
    expect(byHr.body.message).toMatch(/Hema .*Department head/);

    // The head holds no hr grant at all — a plain employee login.
    const byHead = await approve(id, appAs(['employee'], CO, ids.emp.engHead));
    expect(byHead.status).toBe(200);
    expect(byHead.body).toMatchObject({ status: 'approved', approved_by: ids.emp.engHead });
  });

  it('no head in the department → the reporting manager approves', async () => {
    const id = await passFor(ids.emp.genStaff);
    expect(await listRow(id)).toMatchObject({ approver_kind: 'reporting_manager', approver_employee_id: ids.emp.mgr });
    expect((await approve(id, appAs(['employee'], CO, ids.emp.engHead))).status, 'another employee').toBe(403);
    const ok = await approve(id, appAs(['manager'], CO, ids.emp.mgr));
    expect(ok.status).toBe(200);
    expect(ok.body.approved_by).toBe(ids.emp.mgr);
  });

  it("a head's own pass skips themselves; no head and no manager → HR; never self-approval", async () => {
    const own = await passFor(ids.emp.engHead);
    expect((await listRow(own)).approver_kind, 'the head has no manager').toBe('hr');
    expect((await approve(own, appAs(['employee'], CO, ids.emp.engHead))).status, 'not by the holder').toBe(403);

    const hrSelf = await passFor(ids.emp.second);           // Bala — the acting HR user
    const r = await approve(hrSelf, hr());
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/your own gate pass/);
    expect((await approve(own, hr())).status, 'HR approves when nobody else can').toBe(200);
  });

  it('the designated approver can reject (cancel) a pending pass; nobody else outside HR can', async () => {
    const id = await passFor(ids.emp.engStaff);
    const cancel = (app, body = { reason: 'not needed' }) => request(app).put(`/api/gate-passes/${id}/cancel`).send(body);
    expect((await cancel(appAs(['employee'], CO, ids.emp.genStaff))).status).toBe(403);
    expect((await cancel(appAs(['employee'], CO, ids.emp.engHead), {})).status, 'reason still required').toBe(400);
    const ok = await cancel(appAs(['employee'], CO, ids.emp.engHead));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'cancelled', cancelled_by: ids.emp.engHead });
  });

  it("the Approval Center lists the pass for its approver only, with the module's own endpoints", async () => {
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const src = SOURCE_BY_TYPE.gate;
    const id = await passFor(ids.emp.engStaff);
    const row = (await src.pending(CO)).find(r => r.source_id === String(id));
    expect(row, 'a pending pass appears in the inbox').toBeTruthy();
    expect(src.stage(row)).toBe('Department head');
    expect(src.canAct({ employeeId: ids.emp.engHead, perms: { hr: null } }, row)).toBe(true);
    expect(src.canAct({ employeeId: ids.emp.second, perms: { hr: { can_edit: true } } }, row), 'HR over a head').toBe(false);
    expect(src.actions(row).approve).toMatchObject({ method: 'put', url: `/gate-passes/${id}/approve` });
    expect(src.actions(row).reject).toMatchObject({ url: `/gate-passes/${id}/cancel`, commentKey: 'reason', commentRequired: true });
    expect((await src.pending(FOREIGN)).map(r => r.source_id)).not.toContain(String(id));
    const mine = await src.mine({ employeeId: ids.emp.engStaff });
    expect(mine.find(r => r.source_id === String(id))).toMatchObject({ raw_status: 'pending' });
    expect(mine.find(r => r.source_id === String(id)).current_approver).toMatch(/^Hema/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §198 — device setup needs only the address
// ─────────────────────────────────────────────────────────────────────────────
describe('device registration needs only the connection', () => {
  const created = [];
  afterAll(async () => {
    if (created.length) await pool.query('DELETE FROM biometric_devices WHERE id = ANY($1::int[])', [created]);
  });
  const register = async (body) => {
    const res = await request(attendanceAdmin()).post('/api/biometric/devices').send(body);
    if (res.body?.id) created.push(res.body.id);
    return res;
  };

  it('an IP address alone registers a device, with port 4370 and a name filled in', async () => {
    const res = await register({ ip_address: '192.0.2.77' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ip_address: '192.0.2.77', port: 4370, device_name: 'Device 192.0.2.77', attendance_direction: 'both', company_id: CO });
    expect(res.body.status_checked_at, 'a new device is not verified').toBeNull();
  });

  it('rejects a bad address or port with 400 naming the field', async () => {
    const empty = await register({});
    expect(empty.status, JSON.stringify(empty.body)).toBe(400);
    expect(empty.body.message).toMatch(/ip_address is required/);
    expect((await register({ ip_address: '999.1.1.1' })).body.message).toMatch(/IPv4 address/);
    expect((await register({ ip_address: '192.0.2.78', port: 70000 })).body.message).toMatch(/port must be/);
    expect((await register({ ip_address: '192.0.2.78', attendance_direction: 'sideways' })).status).toBe(400);
  });

  it('changing the address clears the old verification', async () => {
    const { body: d } = await register({ ip_address: '192.0.2.79', device_name: 'ZZBAW Edit' });
    await pool.query('UPDATE biometric_devices SET status_checked_at = NOW(), status = $2 WHERE id = $1', [d.id, 'online']);
    const same = await request(attendanceAdmin()).put(`/api/biometric/devices/${d.id}`).send({ ip_address: '192.0.2.79', device_name: 'ZZBAW Edit 2' });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.status_checked_at, 'rename keeps the check').not.toBeNull();
    const moved = await request(attendanceAdmin()).put(`/api/biometric/devices/${d.id}`).send({ ip_address: '192.0.2.80' });
    expect(moved.body.status_checked_at, 'new address → not verified').toBeNull();
    expect(moved.body.device_name).toBe('Device 192.0.2.80');
  });

  it('Test connection before saving: probes the typed address and stores nothing', async () => {
    const net = await import('node:net');
    const server = net.createServer((s) => s.end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const before = (await pool.query('SELECT COUNT(*)::int n FROM biometric_devices')).rows[0].n;
    try {
      const ok = await request(attendanceAdmin()).post('/api/biometric/devices/probe').send({ ip_address: '127.0.0.1', port: server.address().port });
      expect(ok.status).toBe(200);
      expect(ok.body.connected).toBe(true);
      expect((await request(attendanceAdmin()).post('/api/biometric/devices/probe').send({ ip_address: 'not an ip' })).status).toBe(400);
      expect((await request(appAs(['payroll_admin'])).post('/api/biometric/devices/probe').send({ ip_address: '127.0.0.1' })).status, 'gated like registering').toBe(403);
    } finally { server.close(); }
    expect((await pool.query('SELECT COUNT(*)::int n FROM biometric_devices')).rows[0].n).toBe(before);
  });
});

describe('the working day: 8 h + 30 min break = 8.5 h on site (§198)', () => {
  it('every OT path reads one threshold from Attendance Settings', async () => {
    const rules = await import('../shared/attendanceRules.js');
    const rule = await rules.getShiftRule(CO);
    const { rows: [s] } = await pool.query(
      `SELECT full_day_hours::float AS w, break_duration AS b FROM attendance_general_settings
        WHERE company_id = $1 OR company_id IS NULL ORDER BY (company_id IS NULL), id LIMIT 1`, [CO]);
    expect(rule).toEqual({ workHours: s.w, breakMinutes: s.b, spanHours: s.w + s.b / 60 });
    expect(await rules.getFullDayHours(CO)).toBe(rule.spanHours);
    // No path keeps its own number.
    for (const f of ['../modules/attendance/routes/attendance.routes.js', '../modules/attendance/routes/offlineSync.routes.js', '../jobs/attendance.cron.js']) {
      const src = readFileSync(resolve(here, f), 'utf8');
      expect(src, f).not.toMatch(/totalHours\s*-\s*9\b|fullDayHours\s*=\s*9\b/);
      expect(src, f).toMatch(/getFullDayHours\(/);
    }
  });
});
