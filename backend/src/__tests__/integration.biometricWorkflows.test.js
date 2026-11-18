/**
 * Biometric & Access Control — the workflows, end to end against the real
 * database (MODULE_FEATURE_CONNECTION_MANUAL.md §197).
 *
 * integration.biometricAuthz.test.js pins WHO may call each route. This file
 * pins WHAT each route does: CSV import into biometric_logs AND
 * attendance_records, device sync processing, punch-log
 * filters, the dashboard counts, Gate Pass & Visitors (hr/gateAccess.routes.js,
 * §272: person and material passes, visitors, notifications, history), and
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
const { default: gateRtr } = await import('../modules/hr/gateAccess.routes.js');

const CO = 999943;        // fixture tenant: ZZBAW
const FOREIGN = 999919;   // foreign tenant: ZZBAF
const PROBE_USER_ID = -424243;

const ids = {
  emp: {}, foreignEmp: null, device: null, deviceNoIp: null, foreignDevice: null,
  leave: null, gatePasses: [], visitors: [], foreignPass: null, foreignVisitor: null, users: {},
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
  a.use('/api', gateRtr);
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
const postPass = async (body, app) => track(ids.gatePasses, await request(app).post('/api/gate-passes').send(body));
const postVisitor = async (body, app) => track(ids.visitors, await request(app).post('/api/visitors').send(body));
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

  // Logins for the gate-pass approver fixtures, so notifications have a recipient (§272).
  for (const key of ['engHead', 'mgr', 'engStaff']) {
    ids.users[key] = (await pool.query(
      'INSERT INTO users (email, employee_id, is_active) VALUES ($1, $2, true) RETURNING id',
      [`zzbaw.${key.toLowerCase()}@e2e.invalid`, ids.emp[key]])).rows[0].id;
  }
  // A foreign tenant's pass and visitor, to be refused.
  ids.foreignPass = (await pool.query(
    `INSERT INTO gate_passes (employee_id, pass_type, category, purpose, status, company_id, pass_number)
     VALUES ($1, 'person', 'official', 'ZZBAF foreign', 'pending', $2, 'ZZBAF-1') RETURNING id`, [ids.foreignEmp, FOREIGN])).rows[0].id;
  ids.foreignVisitor = (await pool.query(
    `INSERT INTO visitors (name, phone, company_id, check_in_time) VALUES ('ZZBAF Visitor', '9000000019', $1, NOW()) RETURNING id`,
    [FOREIGN])).rows[0].id;
});

async function deleteEmployeeFixture(id) {
  // Only fixture employees report to a fixture manager.
  await pool.query('UPDATE employees SET reporting_manager_id = NULL WHERE reporting_manager_id = $1', [id]);
  await pool.query('DELETE FROM biometric_logs     WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM attendance_records WHERE employee_id = $1', [id]);
  await pool.query('DELETE FROM leave_applications WHERE employee_id = $1', [id]);
  const GP_REF = '$1 IN (employee_id, requested_by, approved_by, cancelled_by, completed_by, out_by, in_by)';
  const V_REF = '$1 IN (host_employee_id, pre_registered_by, checked_in_by, checked_out_by, cancelled_by)';
  await pool.query(`DELETE FROM access_events WHERE entity_type = 'gate_pass' AND entity_id IN (SELECT id FROM gate_passes WHERE ${GP_REF})`, [id]);
  await pool.query(`DELETE FROM gate_passes WHERE ${GP_REF}`, [id]);
  await pool.query(`DELETE FROM access_events WHERE entity_type = 'visitor' AND entity_id IN (SELECT id FROM visitors WHERE ${V_REF})`, [id]);
  await pool.query(`DELETE FROM visitors WHERE ${V_REF}`, [id]);
  await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE employee_id = $1)', [id]);
  await pool.query(`DELETE FROM users WHERE employee_id = $1 AND email LIKE 'zzbaw.%@e2e.invalid'`, [id]);
  await pool.query('DELETE FROM employees          WHERE id = $1', [id]);
}

afterAll(async () => {
  // Exact captured ids, batched. Each step runs even if an earlier one fails,
  // so one error cannot strand the rest; the first error is rethrown at the end.
  const steps = [
    ["DELETE FROM access_events WHERE entity_type = 'gate_pass' AND entity_id = ANY($1::int[])", [...ids.gatePasses, ids.foreignPass].filter(Boolean)],
    ["DELETE FROM access_events WHERE entity_type = 'visitor' AND entity_id = ANY($1::int[])", [...ids.visitors, ids.foreignVisitor].filter(Boolean)],
    ['DELETE FROM notifications WHERE user_id = ANY($1::int[])', Object.values(ids.users)],
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

// ═════════════════════════════════════════════════════════════════════════════
// Gate Pass & Visitors — hr/gateAccess.routes.js (§272)
//
// Fixtures above: Hema heads Engineering; Eswar (Engineering) and Gita
// (General, no head here) report to Mohan; Bala's department (ZZBAW Ops) has no
// head and Bala has no manager, so Bala's passes fall to HR. Hema, Mohan and
// Eswar have logins, so their notifications can be read back. The gate desk
// below is Mohan holding the `hr` role (gate_access view/add/edit/approve/export).
// ═════════════════════════════════════════════════════════════════════════════
const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const asEmployee = (empId) => appAs(['employee'], CO, empId);
const desk = () => appAs(['hr'], CO, ids.emp.mgr);
const act = (app, id, verb, body = {}) => request(app).put(`/api/gate-passes/${id}/${verb}`).send(body);
const personPass = (over = {}) => ({ category: 'official', purpose: 'ZZBAW client visit', valid_from: soon(-0.05), valid_to: soon(4), ...over });
const notesFor = async (userId, refId) => (await pool.query(
  'SELECT title, link FROM notifications WHERE user_id = $1 AND reference_id = $2 ORDER BY id', [userId, refId])).rows;

describe('gate access — who may do what (§272)', () => {
  it('an employee with no grant sees only their own passes, and none of the register', async () => {
    const app = asEmployee(ids.emp.engStaff);
    const list = await request(app).get('/api/gate-passes');
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe('mine');
    for (const path of ['/api/gate-access/summary', '/api/gate-passes/export', '/api/visitors/export', '/api/visitors/lookup?phone=9876543210']) {
      expect((await request(app).get(path)).status, path).toBe(403);
    }
    expect((await request(app).post('/api/visitors').send({ name: 'ZZBAW Walk-in' })).status).toBe(403);
  });

  it('payroll_admin keeps hr:view but holds no gate_access — the register is not theirs', async () => {
    const res = await request(appAs(['payroll_admin'], CO, ids.emp.active)).get('/api/gate-passes');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('mine');
    expect((await request(appAs(['payroll_admin'])).get('/api/gate-access/summary')).status).toBe(403);
  });

  it('the gate desk reads the whole register', async () => {
    const res = await request(desk()).get('/api/gate-passes');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    expect((await request(desk()).get('/api/gate-access/summary')).status).toBe(200);
  });

  it('every route refuses an unauthenticated request', async () => {
    const a = express(); a.use(express.json()); a.use('/api', gateRtr);
    for (const [m, p] of [['get', '/api/gate-passes'], ['post', '/api/gate-passes'], ['put', '/api/gate-passes/1/approve'],
      ['get', '/api/visitors'], ['post', '/api/visitors'], ['get', '/api/gate-access/summary']]) {
      expect((await request(a)[m](p).send({})).status, `${m} ${p}`).toBe(401);
    }
  });

  it("⚠⚠ another tenant's pass and visitor are 404 on every read and action, and stay unchanged", async () => {
    for (const [m, p] of [['get', `/api/gate-passes/${ids.foreignPass}`], ['put', `/api/gate-passes/${ids.foreignPass}/approve`],
      ['put', `/api/gate-passes/${ids.foreignPass}/cancel`], ['put', `/api/gate-passes/${ids.foreignPass}/out`],
      ['put', `/api/gate-passes/${ids.foreignPass}`], ['get', `/api/visitors/${ids.foreignVisitor}`],
      ['put', `/api/visitors/${ids.foreignVisitor}/checkout`], ['put', `/api/visitors/${ids.foreignVisitor}`]]) {
      expect((await request(desk())[m](p).send({ reason: 'ZZBAW probe' })).status, `${m} ${p}`).toBe(404);
    }
    const { rows: [p] } = await pool.query('SELECT status FROM gate_passes WHERE id = $1', [ids.foreignPass]);
    expect(p.status).toBe('pending');
    const { rows: [v] } = await pool.query('SELECT check_out_time FROM visitors WHERE id = $1', [ids.foreignVisitor]);
    expect(v.check_out_time).toBeNull();
  });
});

describe('person gate passes (§272)', () => {
  it('validates: type, reason and window are required; a window already over is refused', async () => {
    const app = asEmployee(ids.emp.engStaff);
    const res = await postPass({}, app);
    expect(res.status).toBe(400);
    const all = res.body.errors.join(' ');
    expect(all).toMatch(/type of pass/);
    expect(all).toMatch(/reason/);
    expect(all).toMatch(/leaves/);
    const past = await postPass(personPass({ valid_from: soon(-3), valid_to: soon(-1) }), app);
    expect(past.status).toBe(400);
    expect(past.body.message).toMatch(/past/);
  });

  it("an employee requests their OWN pass — never someone else's", async () => {
    const app = asEmployee(ids.emp.engStaff);
    expect((await postPass(personPass({ employee_id: ids.emp.genStaff }), app)).status).toBe(403);
    const res = await postPass(personPass(), app);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ employee_id: ids.emp.engStaff, requested_by: ids.emp.engStaff, effective_status: 'pending' });
    expect(res.body.pass_number).toMatch(/^GP-\d{4}-\d{5}$/);
    expect(res.body.awaiting).toMatchObject({ kind: 'department_head' });
    expect(res.body.awaiting.name).toMatch(/Hema/);
  });

  it('the department head is notified and approves; HR cannot approve over them; the holder is told', async () => {
    const id = (await postPass(personPass({ purpose: 'ZZBAW bank visit' }), asEmployee(ids.emp.engStaff))).body.id;
    const headNotes = await notesFor(ids.users.engHead, id);
    expect(headNotes).toHaveLength(1);
    expect(headNotes[0].link).toBe('/ApprovalCenter');
    expect(headNotes[0].title).toMatch(/waiting for your approval/);
    const hrTry = await act(desk(), id, 'approve');
    expect(hrTry.status).toBe(403);
    expect(hrTry.body.code).toBe('NOT_THE_APPROVER');
    const ok = await act(asEmployee(ids.emp.engHead), id, 'approve');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ effective_status: 'approved', approved_by: ids.emp.engHead });
    expect((await notesFor(ids.users.engStaff, id)).map(n => n.title).join(' ')).toMatch(/approved/);
  });

  it('the gate records the actual out and in, and only the gate desk may', async () => {
    const id = (await postPass(personPass(), asEmployee(ids.emp.engStaff))).body.id;
    await act(asEmployee(ids.emp.engHead), id, 'approve');
    expect((await act(asEmployee(ids.emp.engStaff), id, 'out')).status).toBe(403);
    const out = await act(desk(), id, 'out', { vehicle_number: 'tn01ab1234' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ effective_status: 'out', out_by: ids.emp.mgr, vehicle_number: 'TN01AB1234' });
    expect(out.body.out_at).toBeTruthy();
    expect((await act(desk(), id, 'out')).status).toBe(409);
    expect((await act(desk(), id, 'cancel', { reason: 'ZZBAW too late' })).status).toBe(409);
    const back = await act(desk(), id, 'in');
    expect(back.status).toBe(200);
    expect(back.body.effective_status).toBe('completed');
    expect(back.body.in_at).toBeTruthy();
    const detail = await request(asEmployee(ids.emp.engStaff)).get(`/api/gate-passes/${id}`);
    expect(detail.body.events.map(e => e.action)).toEqual(['created', 'approved', 'out', 'returned']);
  });

  it('a pass cannot go out before its window opens (30-minute grace)', async () => {
    const id = (await postPass(personPass({ valid_from: soon(3), valid_to: soon(5) }), asEmployee(ids.emp.engStaff))).body.id;
    await act(asEmployee(ids.emp.engHead), id, 'approve');
    const res = await act(desk(), id, 'out');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/starts at/);
  });

  it('a pending pass can be edited by its requester, and not once it is decided', async () => {
    const app = asEmployee(ids.emp.engStaff);
    const created = (await postPass(personPass(), app)).body;
    const edit = await request(app).put(`/api/gate-passes/${created.id}`).send({ ...personPass(), category: 'medical', purpose: 'ZZBAW clinic' });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ category: 'medical', purpose: 'ZZBAW clinic' });
    expect((await request(asEmployee(ids.emp.genStaff)).put(`/api/gate-passes/${created.id}`).send(personPass())).status).toBe(404);
    await act(asEmployee(ids.emp.engHead), created.id, 'approve');
    expect((await request(app).put(`/api/gate-passes/${created.id}`).send(personPass())).status).toBe(409);
    const ev = (await request(app).get(`/api/gate-passes/${created.id}`)).body.events.find(e => e.action === 'edited');
    expect(ev.data.fields).toEqual(expect.arrayContaining(['category', 'purpose']));
  });

  it('withdraw (holder) and reject (approver) both need a reason and say which they were', async () => {
    const app = asEmployee(ids.emp.engStaff);
    const a = (await postPass(personPass(), app)).body.id;
    expect((await act(app, a, 'cancel', {})).status).toBe(400);
    expect((await act(app, a, 'cancel', { reason: 'ZZBAW not needed' })).body.effective_status).toBe('cancelled');
    const b = (await postPass(personPass(), app)).body.id;
    expect((await act(asEmployee(ids.emp.engHead), b, 'cancel', { reason: 'ZZBAW busy day' })).status).toBe(200);
    expect((await notesFor(ids.users.engStaff, b)).map(n => n.title).join(' ')).toMatch(/rejected/);
    const events = async (id) => (await request(app).get(`/api/gate-passes/${id}`)).body.events.map(e => e.action);
    expect(await events(a)).toContain('withdrawn');
    expect(await events(b)).toContain('rejected');
    const c = (await postPass(personPass(), app)).body.id;
    expect((await act(asEmployee(ids.emp.genStaff), c, 'cancel', { reason: 'ZZBAW not mine' })).status).toBe(404);
  });

  it('a pass out past its time reads overdue; the desk closes it with a reason', async () => {
    const id = (await postPass(personPass(), asEmployee(ids.emp.engStaff))).body.id;
    await act(asEmployee(ids.emp.engHead), id, 'approve');
    await act(desk(), id, 'out');
    await pool.query(`UPDATE gate_passes SET valid_to = NOW() - interval '1 minute' WHERE id = $1`, [id]);
    const list = await request(desk()).get('/api/gate-passes?status=overdue&page_size=100');
    expect(list.body.rows.map(r => r.id)).toContain(id);
    expect(list.body.counts.overdue).toBeGreaterThanOrEqual(1);
    expect((await act(desk(), id, 'close', {})).status).toBe(400);
    const closed = await act(desk(), id, 'close', { reason: 'ZZBAW not returning today' });
    expect(closed.body).toMatchObject({ effective_status: 'completed', close_reason: 'ZZBAW not returning today' });
  });

  it('the HR fallback needs gate_access:approve, and nobody approves their own pass', async () => {
    const res = await postPass(personPass(), asEmployee(ids.emp.second));
    expect(res.body.awaiting.kind).toBe('hr');
    // Not the approver and no register grant: the pass is not theirs to see.
    expect((await act(appAs(['employee'], CO, ids.emp.mgr), res.body.id, 'approve')).status).toBe(404);
    expect((await act(appAs(['hr'], CO, ids.emp.second), res.body.id, 'approve')).status).toBe(403);
    expect((await act(desk(), res.body.id, 'approve')).status).toBe(200);
  });

  it('the Approval Center lists a pending pass for its approver only, on the module endpoints', async () => {
    const id = (await postPass(personPass({ purpose: 'ZZBAW inbox probe' }), asEmployee(ids.emp.engStaff))).body.id;
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const src = SOURCE_BY_TYPE.gate;
    expect(src).toMatchObject({ page: 'GatePassVisitors', myPage: 'MyGatePasses' });
    const r = (await src.pending(CO)).find(x => x.source_id === String(id));
    expect(r.request_title).toMatch(/^Gate pass · GP-/);
    expect(src.canAct({ employeeId: ids.emp.engHead, perms: {} }, r)).toBe(true);
    expect(src.canAct({ employeeId: ids.emp.mgr, perms: { gate_access: { can_approve: true } } }, r)).toBe(false);
    expect(src.actions(r)).toMatchObject({ approve: { url: `/gate-passes/${id}/approve` }, reject: { url: `/gate-passes/${id}/cancel` } });
    expect((await src.pending(FOREIGN)).find(x => x.source_id === String(id))).toBeUndefined();
  });

  it('the employee list is their own; the desk filters the register', async () => {
    const mine = await request(asEmployee(ids.emp.engStaff)).get('/api/gate-passes?page_size=100');
    expect(mine.body.rows.length).toBeGreaterThan(0);
    expect(mine.body.rows.every(r => r.employee_id === ids.emp.engStaff || r.requested_by === ids.emp.engStaff)).toBe(true);
    const byEmp = await request(desk()).get(`/api/gate-passes?employee_id=${ids.emp.second}&page_size=100`);
    expect(byEmp.body.rows.length).toBeGreaterThan(0);
    expect(byEmp.body.rows.every(r => r.employee_id === ids.emp.second)).toBe(true);
    const cat = await request(desk()).get('/api/gate-passes?category=medical&page_size=100');
    expect(cat.body.rows.length).toBeGreaterThan(0);
    expect(cat.body.rows.every(r => r.category === 'medical')).toBe(true);
    expect((await request(desk()).get('/api/gate-passes?status=bogus')).status).toBe(400);
  });
});

describe('material gate passes (§272)', () => {
  const goods = (over = {}) => ({
    pass_type: 'material', purpose: 'ZZBAW repair', destination: 'ZZBAW Vendor, Chennai', returnable: true,
    expected_return_at: soon(48), vehicle_number: 'tn02cd5678', carried_by: 'ZZBAW Transport',
    items: [{ description: 'ZZBAW Motor 5HP', quantity: 2, unit: 'Nos', item_code: 'MTR-5' }, { description: 'ZZBAW Cable', quantity: 12.5, unit: 'm' }],
    ...over,
  });
  const mohan = () => appAs(['employee'], CO, ids.emp.mgr);

  it('validates goods, destination and the return date', async () => {
    const app = asEmployee(ids.emp.genStaff);
    const r = await postPass({ pass_type: 'material', purpose: 'ZZBAW x' }, app);
    expect(r.status).toBe(400);
    const all = r.body.errors.join(' ');
    expect(all).toMatch(/returnable/);
    expect(all).toMatch(/destination/);
    expect(all).toMatch(/at least one item/);
    expect((await postPass(goods({ expected_return_at: '' }), app)).body.message).toMatch(/due back/);
    expect((await postPass(goods({ items: [{ description: 'ZZBAW x', quantity: 0 }] }), app)).body.message).toMatch(/quantity/);
  });

  it('non-returnable goods: the manager approves, and the pass completes when they leave', async () => {
    const res = await postPass(goods({ returnable: false, expected_return_at: null }), asEmployee(ids.emp.genStaff));
    expect(res.status).toBe(201);
    expect(res.body.pass_number).toMatch(/^MGP-\d{4}-\d{5}$/);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.awaiting.kind).toBe('reporting_manager');
    expect(await notesFor(ids.users.mgr, res.body.id)).toHaveLength(1);
    expect((await act(mohan(), res.body.id, 'approve')).status).toBe(200);
    const out = await act(desk(), res.body.id, 'out');
    expect(out.body.effective_status).toBe('completed');
    expect(out.body.out_at).toBeTruthy();
    expect(out.body.can_return).toBe(false);
  });

  it('returnable goods come back line by line; the pass completes when all are back', async () => {
    const res = await postPass(goods(), asEmployee(ids.emp.genStaff));
    const id = res.body.id;
    await act(mohan(), id, 'approve');
    await act(desk(), id, 'out');
    const [motor, cable] = res.body.items;
    expect((await act(desk(), id, 'in')).status).toBe(409);
    const over = await act(desk(), id, 'return', { items: [{ item_id: motor.id, quantity: 3 }] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/only 2/);
    const part = await act(desk(), id, 'return', { items: [{ item_id: motor.id, quantity: 1 }] });
    expect(part.body.effective_status).toBe('out');
    expect(part.body.items.find(i => i.id === motor.id).returned_quantity).toBe(1);
    const rest = await act(desk(), id, 'return', { items: [{ item_id: motor.id, quantity: 1 }, { item_id: cable.id, quantity: 12.5 }] });
    expect(rest.body.effective_status).toBe('completed');
    expect(rest.body.in_at).toBeTruthy();
    const ev = (await request(desk()).get(`/api/gate-passes/${id}`)).body.events.map(e => e.action);
    expect(ev).toEqual(['created', 'approved', 'out', 'items_returned', 'all_returned']);
    expect((await act(desk(), id, 'return', { items: [{ item_id: cable.id, quantity: 1 }] })).status).toBe(409);
  });

  it('the register filters by type, searches the goods, and exports CSV with them', async () => {
    const list = await request(desk()).get('/api/gate-passes?pass_type=material&page_size=100');
    expect(list.body.rows.length).toBeGreaterThan(0);
    expect(list.body.rows.every(r => r.pass_type === 'material')).toBe(true);
    const search = await request(desk()).get(`/api/gate-passes?q=${encodeURIComponent('Motor 5HP')}&page_size=100`);
    expect(search.body.rows.length).toBeGreaterThan(0);
    const csv = await request(desk()).get('/api/gate-passes/export?pass_type=material');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    expect(csv.text).toMatch(/Pass No\./);
    expect(csv.text).toMatch(/ZZBAW Motor 5HP × 2 Nos/);
  });
});

describe('visitors (§272, §273 — security approves entry)', () => {
  const vis = (over = {}) => ({
    name: 'ZZBAW Ravi', company: 'ZZBAW Supplies', phone: '98400 11223', host_employee_id: ids.emp.engStaff, purpose: 'ZZBAW audit', ...over,
  });
  const put = (app, id, verb, body = {}) => request(app).put(`/api/visitors/${id}${verb ? `/${verb}` : ''}`).send(body);
  // The Security / Gate Desk role (migration 20261112000004): gate_access view/add/edit + gate_security approve.
  const guard = () => appAs(['security'], CO, ids.emp.active);
  /** Register at the desk, approve as security, check in. */
  const inside = async (over) => {
    const r = await postVisitor(vis(over), desk());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await put(guard(), r.body.id, 'approve')).status).toBe(200);
    const c = await put(desk(), r.body.id, 'check-in');
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    return c.body;
  };

  it('the security role holds exactly the gate grants; HR does not approve visitor entry', async () => {
    const { rows } = await pool.query(
      `SELECT p.module, p.can_view, p.can_add, p.can_edit, p.can_approve, p.can_export
         FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE LOWER(r.code) = 'security' AND (p.can_view OR p.can_add OR p.can_edit OR p.can_approve OR p.can_export)
        ORDER BY p.module`);
    expect(rows).toEqual([
      { module: 'gate_access', can_view: true, can_add: true, can_edit: true, can_approve: false, can_export: false },
      { module: 'gate_security', can_view: true, can_add: false, can_edit: false, can_approve: true, can_export: false },
    ]);
    const { rows: hrSec } = await pool.query(
      `SELECT BOOL_OR(p.can_approve) AS ap FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE LOWER(r.code) IN ('hr', 'hr_manager', 'hr_exec') AND p.module = 'gate_security'`);
    expect(hrSec[0].ap).toBe(false);
    // …and the guard is not the HR fallback approver of employee passes.
    const pass = await postPass(personPass(), asEmployee(ids.emp.second));
    expect((await act(guard(), pass.body.id, 'approve')).status).toBe(403);
  });

  it('a walk-in waits for security: no check-in before approval; security is notified, approves, the pass is numbered', async () => {
    const reg = await postVisitor(vis({ name: 'ZZBAW Walk', phone: '9840099010' }), desk());
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ effective_status: 'pending_approval', check_in_time: null, pass_number: null });
    const early = await put(desk(), reg.body.id, 'check-in');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_APPROVED');
    expect((await put(desk(), reg.body.id, 'approve')).status).toBe(403);       // HR is not security
    const ok = await put(guard(), reg.body.id, 'approve');
    expect(ok.status).toBe(200);
    expect(ok.body.effective_status).toBe('approved');
    expect(ok.body.pass_number).toMatch(/^VP-\d{4}-\d{5}$/);
    expect(ok.body.approved_by).toBe(ids.emp.active);
    expect((await notesFor(ids.users.engStaff, reg.body.id)).map(n => n.title).join(' ')).toMatch(/approved — pass VP-/);
    expect((await put(guard(), reg.body.id, 'approve')).status).toBe(409);
    const inn = await put(desk(), reg.body.id, 'check-in');
    expect(inn.body.effective_status).toBe('inside');
    const ev = (await request(desk()).get(`/api/visitors/${reg.body.id}`)).body.events.map(e => e.action);
    expect(ev).toEqual(['registered', 'entry_approved', 'checked_in']);
    await put(desk(), reg.body.id, 'checkout');
  });

  it('security rejects with a reason; a rejected visitor cannot be checked in; the host is told', async () => {
    const reg = (await postVisitor(vis({ name: 'ZZBAW Refused', phone: '9840099011' }), desk())).body;
    expect((await put(guard(), reg.id, 'reject')).status).toBe(400);
    const rj = await put(guard(), reg.id, 'reject', { reason: 'ZZBAW no appointment' });
    expect(rj.body).toMatchObject({ effective_status: 'rejected', reject_reason: 'ZZBAW no appointment' });
    expect((await put(desk(), reg.id, 'check-in')).status).toBe(409);
    expect((await notesFor(ids.users.engStaff, reg.id)).map(n => n.title).join(' ')).toMatch(/not approved/);
  });

  it('security at the gate can approve and check in at once; nobody else can', async () => {
    expect((await postVisitor({ ...vis({ name: 'ZZBAW Fast', phone: '9840099012' }), approve_and_check_in: true }, desk())).status).toBe(403);
    const v = await postVisitor({ ...vis({ name: 'ZZBAW Fast', phone: '9840099012' }), approve_and_check_in: true }, guard());
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ effective_status: 'inside', checked_in_by: ids.emp.active });
    expect(v.body.pass_number).toMatch(/^VP-/);
    expect((await notesFor(ids.users.engStaff, v.body.id)).map(n => n.title).join(' ')).toMatch(/has arrived/);
    await put(desk(), v.body.id, 'checkout');
  });

  it('an employee pre-registers their OWN visitor; security approves ahead; the desk checks them in and the host is told', async () => {
    const host = asEmployee(ids.emp.engStaff);
    expect((await postVisitor({ ...vis(), pre_register: true, expected_at: soon(2), host_employee_id: ids.emp.genStaff }, host)).status).toBe(403);
    const pre = await postVisitor({ ...vis({ host_employee_id: '' }), pre_register: true, expected_at: soon(2) }, host);
    expect(pre.status).toBe(201);
    expect(pre.body).toMatchObject({ effective_status: 'pending_approval', host_employee_id: ids.emp.engStaff, check_in_time: null });
    expect((await put(host, pre.body.id, 'approve')).status).toBe(403);
    expect((await put(guard(), pre.body.id, 'approve')).status).toBe(200);
    expect((await put(host, pre.body.id, 'check-in')).status).toBe(403);
    const inn = await put(desk(), pre.body.id, 'check-in', { id_type: 'Aadhaar', id_number: '1234 5678 9012' });
    expect(inn.status).toBe(200);
    expect(inn.body).toMatchObject({ effective_status: 'inside', id_number: 'XXXXXXXX9012', checked_in_by: ids.emp.mgr });
    expect((await notesFor(ids.users.engStaff, pre.body.id)).map(n => n.title).join(' ')).toMatch(/has arrived/);
    const { rows: [raw] } = await pool.query('SELECT id_number FROM visitors WHERE id = $1', [pre.body.id]);
    expect(raw.id_number).not.toMatch(/1234|5678/);
    const mine = await request(host).get('/api/visitors?page_size=100');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.scope).toBe('mine');
    expect(mine.body.rows.map(r => r.id)).toContain(pre.body.id);
    await put(desk(), pre.body.id, 'checkout');
  });

  it('a host who changes an approved visit before arrival sends it back to security', async () => {
    const host = asEmployee(ids.emp.genStaff);
    const pre = (await postVisitor({ name: 'ZZBAW Change', pre_register: true, expected_at: soon(3) }, host)).body;
    await put(guard(), pre.id, 'approve');
    const purpose = await put(host, pre.id, null, { purpose: 'ZZBAW new agenda' });
    expect(purpose.body.effective_status).toBe('approved');            // not an identity change
    const moved = await put(host, pre.id, null, { name: 'ZZBAW Changed Person' });
    expect(moved.body.effective_status).toBe('pending_approval');
    expect((await request(desk()).get(`/api/visitors/${pre.id}`)).body.events.map(e => e.note)).toContain('Changed after approval — back to security');
    await put(host, pre.id, 'cancel', { reason: 'ZZBAW done' });
  });

  it('the Approval Center lists visitors waiting for entry to security only', async () => {
    const reg = (await postVisitor(vis({ name: 'ZZBAW Inbox', phone: '9840099013' }), desk())).body;
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const src = SOURCE_BY_TYPE.visitor;
    const r = (await src.pending(CO)).find(x => x.source_id === String(reg.id));
    expect(r.request_title).toMatch(/^Visitor · ZZBAW Inbox \(ZZBAW Supplies\)/);
    expect(src.canAct({ perms: { gate_security: { can_approve: true } } }, r)).toBe(true);
    expect(src.canAct({ perms: { gate_access: { can_approve: true }, hr: { can_edit: true } } }, r)).toBe(false);
    expect(src.actions(r)).toMatchObject({ approve: { url: `/visitors/${reg.id}/approve` }, reject: { url: `/visitors/${reg.id}/reject` } });
    expect((await src.pending(FOREIGN)).find(x => x.source_id === String(reg.id))).toBeUndefined();
    await put(guard(), reg.id, 'reject', { reason: 'ZZBAW tidy' });
  });

  it('ID numbers are checked against their type and never stored in full; email is checked', async () => {
    const bad = await postVisitor(vis({ id_type: 'Aadhaar', id_number: '12345' }), desk());
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/12 digits/);
    const pan = await postVisitor(vis({ name: 'ZZBAW Pan', phone: '9840099001', id_type: 'PAN', id_number: 'abcde1234f' }), desk());
    expect(pan.status).toBe(201);
    expect(pan.body.id_number).toBe('XXXXXX234F');
    expect((await postVisitor(vis({ name: 'ZZBAW NoType', phone: '9840099002', id_number: '123456789012' }), desk())).body.message).toMatch(/ID type/);
    expect((await postVisitor(vis({ name: 'ZZBAW Mail', phone: '9840099007', email: 'not-an-email' }), desk())).body.message).toMatch(/email/);
    await put(guard(), pan.body.id, 'reject', { reason: 'ZZBAW tidy' });
  });

  it("one open visit per person; check-out is the desk's, once; the person may return", async () => {
    const v = await inside({ name: 'ZZBAW Dup', phone: '9840099003' });
    const again = (await postVisitor(vis({ name: 'ZZBAW Dup again', phone: '+91 98400 99003' }), desk())).body;
    await put(guard(), again.id, 'approve');
    expect((await put(desk(), again.id, 'check-in')).status).toBe(409);
    expect((await put(asEmployee(ids.emp.engStaff), v.id, 'checkout')).status).toBe(403);
    const out = await put(desk(), v.id, 'checkout');
    expect(out.body).toMatchObject({ effective_status: 'checked_out', checked_out_by: ids.emp.mgr });
    expect((await put(desk(), v.id, 'checkout')).status).toBe(409);
    expect((await put(desk(), v.id, null, { purpose: 'ZZBAW late edit' })).status).toBe(409);
    expect((await put(desk(), again.id, 'check-in')).status).toBe(200);
    await put(desk(), again.id, 'checkout');
  });

  it('an inside visitor can be edited; a badge is recorded; the history lists every step', async () => {
    const v = await inside({ name: 'ZZBAW Edit', phone: '9840099004' });
    const ed = await put(desk(), v.id, null, { purpose: 'ZZBAW changed', visitor_count: 3, vehicle_number: 'tn09xy0001' });
    expect(ed.status).toBe(200);
    expect(ed.body).toMatchObject({ purpose: 'ZZBAW changed', visitor_count: 3, vehicle_number: 'TN09XY0001', effective_status: 'inside' });
    expect((await put(desk(), v.id, 'badge')).body.badge_printed).toBe(true);
    await put(desk(), v.id, 'checkout');
    expect((await put(desk(), v.id, 'badge')).status).toBe(409);
    const d = await request(desk()).get(`/api/visitors/${v.id}`);
    expect(d.body.events.map(e => e.action)).toEqual(['registered', 'entry_approved', 'checked_in', 'edited', 'badge_printed', 'checked_out']);
  });

  it('an expected visit can be cancelled with a reason, and then not approved or checked in', async () => {
    const host = asEmployee(ids.emp.genStaff);
    const pre = (await postVisitor({ name: 'ZZBAW Cancel', pre_register: true, expected_at: soon(5) }, host)).body;
    expect(pre.host_employee_id).toBe(ids.emp.genStaff);
    expect((await put(host, pre.id, 'cancel')).status).toBe(400);
    expect((await put(host, pre.id, 'cancel', { reason: 'ZZBAW meeting moved' })).body.effective_status).toBe('cancelled');
    expect((await put(guard(), pre.id, 'approve')).status).toBe(409);
    expect((await put(desk(), pre.id, 'check-in')).status).toBe(409);
  });

  it('overstay, awaiting-security and the summary agree with the rows', async () => {
    const v = await inside({ name: 'ZZBAW Night', phone: '9840099005' });
    await pool.query(`UPDATE visitors SET check_in_time = NOW() - interval '2 days' WHERE id = $1`, [v.id]);
    const over = await request(desk()).get('/api/visitors?status=overstay&page_size=100');
    expect(over.body.rows.map(r => r.id)).toContain(v.id);
    expect(over.body.rows.every(r => r.overstay)).toBe(true);
    const sum = await request(desk()).get('/api/gate-access/summary');
    expect(sum.body.overstay).toBe(over.body.total);
    const inside_ = await request(desk()).get('/api/visitors?status=inside&page_size=100');
    expect(sum.body.inside).toBe(inside_.body.total);
    const waiting = await request(desk()).get('/api/visitors?status=pending_approval&page_size=100');
    expect(sum.body.awaiting_security).toBe(waiting.body.total);
    await put(desk(), v.id, 'checkout');
  });

  it('a returning visitor is found by phone, with only the masked ID on file', async () => {
    const lk = await request(desk()).get('/api/visitors/lookup?phone=9840099001');
    expect(lk.body).toMatchObject({ found: true, name: 'ZZBAW Pan', id_type: 'PAN', id_number_on_file: 'XXXXXX234F' });
    expect((await request(desk()).get('/api/visitors/lookup?phone=9000000019')).body.found).toBe(false);
  });

  it('a photo is stored for the visit — images only', async () => {
    const v = await inside({ name: 'ZZBAW Photo', phone: '9840099006' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const bad = await request(desk()).put(`/api/visitors/${v.id}/photo`)
      .attach('photo_file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(bad.status).toBe(415);
    const ok = await request(desk()).put(`/api/visitors/${v.id}/photo`)
      .attach('photo_file', png, { filename: 'face.png', contentType: 'image/png' });
    expect(ok.status).toBe(200);
    expect(ok.body.photo_url).toBeTruthy();
    const { deleteFile } = await import('../services/StorageService.js');
    await deleteFile(ok.body.photo_url).catch(() => {});
    await put(desk(), v.id, 'checkout');
  });

  it('the visitor CSV carries the visitor pass and the masked ID only', async () => {
    const csv = await request(desk()).get('/api/visitors/export');
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/Visitor pass/);
    expect(csv.text).toMatch(/ID \(masked\)/);
    expect(csv.text).toMatch(/XXXXXX234F/);
    expect(csv.text).not.toMatch(/ABCDE1234F/);
  });
});

describe('goods leaving with a visitor (§273 — host approves, security releases)', () => {
  const vis = (over = {}) => ({ name: 'ZZBAW Supplier', company: 'ZZBAW Parts', phone: '9840099020', host_employee_id: ids.emp.genStaff, ...over });
  const put = (app, id, verb, body = {}) => request(app).put(`/api/visitors/${id}${verb ? `/${verb}` : ''}`).send(body);
  const guard = () => appAs(['security'], CO, ids.emp.active);
  const goods = (visitorId, over = {}) => ({
    pass_type: 'material', visitor_id: visitorId, purpose: 'ZZBAW returned part', destination: 'ZZBAW Parts, Chennai', returnable: false,
    items: [{ description: 'ZZBAW Faulty relay', quantity: 4, unit: 'Nos' }], ...over,
  });
  const visitorInside = async (phone) => {
    const r = await postVisitor(vis({ phone }), desk());
    await put(guard(), r.body.id, 'approve');
    return (await put(desk(), r.body.id, 'check-in')).body;
  };

  it('needs a visitor who is inside, and is goods only', async () => {
    const pre = (await postVisitor({ name: 'ZZBAW Not yet', pre_register: true, expected_at: soon(4) }, asEmployee(ids.emp.genStaff))).body;
    expect((await postPass(goods(pre.id), asEmployee(ids.emp.genStaff))).status).toBe(409);
    const v = await visitorInside('9840099021');
    expect((await postPass({ ...personPass(), visitor_id: v.id }, desk())).status).toBe(400);
    expect((await postPass(goods(v.id), asEmployee(ids.emp.engStaff))).status).toBe(404);   // not their visitor
    await put(guard(), pre.id, 'reject', { reason: 'ZZBAW tidy' });
    await put(desk(), v.id, 'checkout');
  });

  it('raised by the host: approved at once; the visitor cannot leave until security releases the goods', async () => {
    const v = await visitorInside('9840099022');
    const gp = await postPass(goods(v.id), asEmployee(ids.emp.genStaff));
    expect(gp.status, JSON.stringify(gp.body)).toBe(201);
    expect(gp.body).toMatchObject({ effective_status: 'approved', employee_id: ids.emp.genStaff, approved_by: ids.emp.genStaff, visitor_id: v.id, is_visitor_goods: true });
    expect(gp.body.carried_by).toBe('ZZBAW Supplier (ZZBAW Parts)');
    const blocked = await put(desk(), v.id, 'checkout');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('GOODS_OPEN');
    const out = await act(guard(), gp.body.id, 'out');
    expect(out.body.effective_status).toBe('completed');
    const d = await request(desk()).get(`/api/visitors/${v.id}`);
    expect(d.body.goods_passes.map(g => g.pass_number)).toEqual([gp.body.pass_number]);
    expect((await put(desk(), v.id, 'checkout')).status).toBe(200);
  });

  it('raised at the gate: the host is notified and approves — not the department chain, not HR', async () => {
    // Gita's own passes go to her manager Mohan; her VISITOR's goods go to Gita.
    const v = await visitorInside('9840099023');
    const gp = await postPass(goods(v.id, { returnable: true, expected_return_at: soon(24) }), desk());
    expect(gp.status).toBe(201);
    expect(gp.body.effective_status).toBe('pending');
    expect(gp.body.awaiting).toMatchObject({ kind: 'host' });
    expect(gp.body.awaiting.name).toMatch(/Gita/);
    expect((await act(appAs(['employee'], CO, ids.emp.mgr), gp.body.id, 'approve')).status).toBe(403);   // raised it at the desk, so sees it — but is not the host
    expect((await act(desk(), gp.body.id, 'approve')).status).toBe(403);
    const ok = await act(asEmployee(ids.emp.genStaff), gp.body.id, 'approve');
    expect(ok.status).toBe(200);
    expect(ok.body.approved_by).toBe(ids.emp.genStaff);
    const { SOURCE_BY_TYPE } = await import('../modules/approvals/approvals.sources.js');
    const g2 = await postPass(goods(v.id), desk());
    const r = (await SOURCE_BY_TYPE.gate.pending(CO)).find(x => x.source_id === String(g2.body.id));
    expect(r.request_title).toMatch(/^Visitor goods · MGP-/);
    expect(SOURCE_BY_TYPE.gate.canAct({ employeeId: ids.emp.genStaff, perms: {} }, r)).toBe(true);
    // The host can also refuse it — recorded as a rejection.
    expect((await act(asEmployee(ids.emp.genStaff), g2.body.id, 'cancel', { reason: 'ZZBAW not ours' })).status).toBe(200);
    expect((await request(desk()).get(`/api/gate-passes/${g2.body.id}`)).body.events.map(e => e.action)).toContain('rejected');
    await act(guard(), gp.body.id, 'out');
    expect((await put(desk(), v.id, 'checkout')).status).toBe(200);   // returnable goods out: the visitor may leave
  });
});
