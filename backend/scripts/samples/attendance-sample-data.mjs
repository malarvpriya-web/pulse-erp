/**
 * attendance-sample-data.mjs — Attendance junk cleanup + "(Sample)" data (§278).
 *
 *   node scripts/samples/attendance-sample-data.mjs
 *
 * Owner, 2026-11-18: "If we delete the sample data, we can't understand how
 * the pages and charts are working … add attendance for the 3 employees, add
 * a few more employees also … later I can delete it."
 *
 * 1. JUNK (deleted; every row was backed up to _backups/attendance_2026-11-18/
 *    first): the "SEED …" rows with impossible values (89× overtime, 100–200
 *    LOP days on real employees, 1-metre geo fences, a 1-minute lunch logged
 *    09:30–18:30 …), the five fake punch machines and their logs, and every
 *    attendance row of the terminated test / pilot employees.
 * 2. SAMPLES (kept until the owner deletes them):
 *    · 3 employees "… (Sample)" (joined 2024, so the 2-year charts have data):
 *      a machine operator, a quality inspector (machine punchers) and a field
 *      service engineer (punches from the app).
 *    · "General Shift (Sample)" 09:00–17:30 and "Night Shift (Sample)", every
 *      current employee assigned to General.
 *    · Attendance for every working day since joining (EMP001–003 since Feb
 *      2026 — present / late only, so their payroll has no LOP; the samples
 *      since 2024 with a few absences and half days). remarks = '(Sample)'.
 *    · One punch machine "Main Gate Punch Machine" with NO IP address — the
 *      owner enters it on Attendance → Punch Machines; automatic sync starts
 *      then. Today's punches come in through the real CSV import.
 *    · Through the real API: regularizations (one pending, one approved by the
 *      manager), shift changes (one pending, one approved), one pending
 *      overtime request, one late warning, one geo fence for field staff,
 *      work-centre attendance, two contract workers with attendance.
 * Idempotent: does nothing when "General Shift (Sample)" already exists.
 * Remove later: rows whose name / remarks / reason contain "(Sample)", the
 *   three "(Sample)" employees (their attendance cascades), and the two
 *   "(Sample)" shifts.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '../..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const API = process.env.ATT_SAMPLE_API || 'http://localhost:5000/api/v1';
const CO = 1;

const mint = (email) => {
  const out = execSync('node scripts/e2e-mint-token.mjs', { cwd: BACKEND, env: { ...process.env, E2E_LOGIN_EMAIL: email }, encoding: 'utf8' });
  const a = JSON.parse(out.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0]);
  if (a.user.email.toLowerCase() !== email.toLowerCase()) throw new Error(`minted ${a.user.email}, wanted ${email}`);
  return a.token;
};
async function call(token, method, url, body) {
  const r = await fetch(API + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
// Deterministic "random" per employee-day, so a re-run produces the same history.
const rnd = (a, b) => { let h = 2166136261; for (const c of `${a}|${b}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };

const db = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await db.connect();
const log = (...a) => console.log(...a);
try {
  const { rows: done } = await db.query(`SELECT id FROM hr_shifts WHERE name = 'General Shift (Sample)' AND deleted_at IS NULL LIMIT 1`);
  if (done.length) { log('Attendance sample data already present — nothing done.'); process.exit(0); }

  const { rows: [sa] } = await db.query(`SELECT u.id, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.is_active AND LOWER(r.code) = 'super_admin' ORDER BY u.id LIMIT 1`);
  const HR = mint(sa.email);
  const { rows: [nu] } = await db.query(`SELECT email FROM users WHERE employee_id = 2 AND is_active ORDER BY id LIMIT 1`);
  const NATESH = nu ? mint(nu.email) : HR;

  // ── 1. Junk cleanup ─────────────────────────────────────────────────────
  const junk = [
    ['attendance_regularization_requests', `status = 'active'`],
    ['attendance_ot_records', `multiplier >= 10`],
    ['attendance_break_records', `created_at::date = '2026-08-20'`],
    ['attendance_late_warnings', `month LIKE 'SEED%'`],
    ['attendance_offline_queue', `device_id LIKE 'SEED%'`],
    ['attendance_geo_rules', `name LIKE 'SEED%'`],
    ['attendance_workflow_config', `workflow_type LIKE '%SEED%'`],
    ['shift_change_requests', `status = 'active'`],
    ['hr_shift_date_overrides', `created_at::date = '2026-08-20'`],
    ['hr_shift_rotations', `team LIKE 'SEED%'`],
    ['hr_shift_assignments', `note LIKE 'SEED%' OR employee_id IN (SELECT id FROM employees WHERE LOWER(status) = 'terminated')`],
    ['work_centre_attendance', `work_centre_name LIKE 'SEED%'`],
    ['contract_labour_attendance', `created_at::date = '2026-08-20'`],
    ['contract_labour', `contractor_company LIKE 'SEED%' OR employee_name = 'test1'`],
    ['biometric_logs', `raw_data->>'seed' = 'SEED'`],
    ['biometric_devices', `ip_address IN ('192.168.1.101','192.168.1.102','192.168.1.103','192.168.1.104','192.168.1.105')`],
    ['payroll_attendance_summary', `lop_days >= 100`],
    ['face_locked_accounts', `TRUE`],
    ['attendance_records', `employee_id IN (SELECT id FROM employees WHERE LOWER(status) = 'terminated')`],
    ['hr_shifts', `name LIKE 'SEED%' OR name = 'QA General 0930'`],
  ];
  await db.query('BEGIN');
  const removed = {};
  for (const [t, where] of junk) {
    const r = await db.query(`DELETE FROM ${t} WHERE ${where}`);
    removed[t] = r.rowCount;
  }
  if (Object.values(removed).some((n) => n > 0)) await db.query(`INSERT INTO audit_logs (user_id, module_name, action_type, reference_type, old_data_json, new_data_json, company_id)
                  VALUES ($1, 'attendance', 'junk_cleanup', 'attendance_tables', $2, $3, $4)`,
  [sa.id, JSON.stringify({ deleted: removed, backup: '_backups/attendance_2026-11-18/' }), JSON.stringify({ section: '§278' }), CO]);
  await db.query('COMMIT');
  log('Junk removed:', removed);

  // ── 2a. Sample employees (direct: the add-employee API needs real bank
  //        proof and would raise three bank approvals for fake people) ──────
  const people = [
    { code: 'EMP041', first: 'Karthik', last: 'Raja (Sample)', dept: 'Production', desg: 'Machine Operator', join: '2024-09-02', field: false },
    { code: 'EMP042', first: 'Divya', last: 'Shankar (Sample)', dept: 'Quality', desg: 'Quality Inspector', join: '2024-09-02', field: false },
    { code: 'EMP043', first: 'Suresh', last: 'Babu (Sample)', dept: 'Service', desg: 'Field Service Engineer', join: '2025-01-06', field: true },
  ];
  for (const p of people) {
    const { rows: [e] } = await db.query(`
      INSERT INTO employees (office_id, first_name, last_name, department, designation, status, employment_type,
                             joining_date, company_id, company_email, is_field_employee, reporting_manager, reporting_manager_id)
      VALUES ($1,$2,$3,$4,$5,'Active','Full-time',$6,$7,$8,$9,'Natesh Mayavel',2) RETURNING id`,
    [p.code, p.first, p.last, p.dept, p.desg, p.join, CO,
      `${p.first.toLowerCase()}.sample@example.com`, p.field]);
    p.id = e.id;
    await db.query(`INSERT INTO org_relationships (employee_id, manager_id, department, position_level, role, display_order, is_active, company_id)
                    VALUES ($1, 2, $2, 3, 'member', 9, true, $3)`, [p.id, p.dept, CO]);
  }
  const [karthik, divya, suresh] = people;
  log('Sample employees:', people.map((p) => `${p.code} #${p.id}`).join(', '));

  // ── 2b. Shifts (API) and assignments ────────────────────────────────────
  const general = await call(HR, 'POST', '/hr/shifts', { name: 'General Shift (Sample)', start: '09:00', end: '17:30', grace_minutes: 10, color: '#6B3FDB', weekly_off: ['saturday', 'sunday'], break_duration: 30, half_day_hours: 4, ot_eligible: true });
  const night = await call(HR, 'POST', '/hr/shifts', { name: 'Night Shift (Sample)', start: '21:00', end: '05:30', grace_minutes: 10, color: '#0E9F8E', weekly_off: ['saturday', 'sunday'], is_night_shift: true, break_duration: 30, half_day_hours: 4, ot_eligible: true });
  const generalId = general.id ?? general.shift?.id; const nightId = night.id ?? night.shift?.id;
  const everyone = [1, 2, 3, ...people.map((p) => p.id)];
  for (const id of everyone) {
    await call(HR, 'POST', '/hr/shift-assignments', { employee_id: id, shift_id: generalId, effective_from: '2024-01-01', note: '(Sample) default shift' });
  }

  // ── 2c. Attendance history (working days, since joining, until yesterday)
  const { rows: hol } = await db.query(`SELECT date::text AS d FROM holidays WHERE company_id = $1 OR company_id IS NULL`, [CO]);
  const holidays = new Set(hol.map((h) => h.d));
  const { rows: real } = await db.query(`SELECT id, joining_date::text AS j FROM employees WHERE id IN (1,2,3)`);
  const plan = [...real.map((r) => ({ id: r.id, join: r.j, real: true, field: false })), ...people.map((p) => ({ id: p.id, join: p.join, real: false, field: p.field }))];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = addDays(today, -1);
  // Karthik: a missed punch-out last Tuesday (pending regularization) and a
  // late day the Thursday before (approved regularization).
  let missedOut = addDays(today, -1); while (missedOut.getDay() !== 2) missedOut = addDays(missedOut, -1);
  const lateFix = addDays(missedOut, -5);
  let rows = 0;
  for (const p of plan) {
    for (let d = new Date(`${p.join}T00:00:00`); d <= yesterday; d = addDays(d, 1)) {
      const dow = d.getDay(); const key = ymd(d);
      if (dow === 0 || dow === 6 || holidays.has(key)) continue;
      const r = rnd(p.id, key);
      let status = 'present'; let inM = 525 + Math.floor(rnd(key, p.id) * 23);      // 08:45–09:08
      let outM = 1050 + Math.floor(rnd(p.id * 7, key) * 50);                        // 17:30–18:20
      if (!p.real && r < 0.025) status = 'absent';
      else if (!p.real && r < 0.05) { status = 'half_day'; inM = 540; outM = 810; }
      else if (r < 0.15) { status = 'late'; inM = 552 + Math.floor(rnd(key, p.id * 3) * 30); }   // 09:12–09:41
      if (rnd(key, 'ot' + p.id) < 0.05 && status !== 'half_day') outM = 1170;      // 19:30
      let checkOut = status === 'absent' ? null : hm(outM);
      if (p.id === karthik.id && key === ymd(missedOut)) checkOut = null;
      if (p.id === karthik.id && key === ymd(lateFix)) { status = 'late'; inM = 575; }
      const checkIn = status === 'absent' ? null : hm(inM);
      const total = checkIn && checkOut ? (outM - inM) / 60 : null;
      await db.query(`
        INSERT INTO attendance_records (employee_id, attendance_date, check_in_time, check_out_time, total_hours, status,
                                        late_minutes, ot_hours, work_mode, check_in_location, source, remarks, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'(Sample)',$12)
        ON CONFLICT (employee_id, attendance_date) DO NOTHING`,
      [p.id, key, checkIn, checkOut, total?.toFixed(2) ?? null, status,
        checkIn ? Math.max(0, inM - 540) : 0, total ? Math.max(0, total - 8.5).toFixed(2) : 0,   // minutes after 09:00 — inside grace on a present day
        p.field ? 'field' : 'office', p.field && checkIn ? '13.0827,80.2707' : null,
        p.field ? 'mobile' : 'biometric', CO]);
      rows++;
    }
  }
  log(`Attendance history rows: ${rows}`);

  // ── 2d. The punch machine (no IP yet) and today's punches via CSV import ──
  const { rows: [dev] } = await db.query(`
    INSERT INTO biometric_devices (device_name, device_type, location, ip_address, port, status, attendance_direction, company_id)
    VALUES ('Main Gate Punch Machine', 'face', 'Main entrance', NULL, 4370, 'offline', 'both', $1) RETURNING id`, [CO]).catch(async () =>
    db.query(`INSERT INTO biometric_devices (device_name, device_type, location, ip_address, port, status, attendance_direction, company_id)
              VALUES ('Main Gate Punch Machine', 'fingerprint', 'Main entrance', NULL, 4370, 'offline', 'both', $1) RETURNING id`, [CO]));
  const t = ymd(today);
  const csv = ['employee_id,punch_time,punch_type',
    `EMP002,${t} 09:02,in`, `EMP003,${t} 08:58,in`,
    `${karthik.code},${t} 08:55,in`, `${divya.code},${t} 09:24,in`].join('\n');
  const imp = await call(HR, 'POST', '/biometric/logs/import', { csv_data: csv, device_id: dev.id, dry_run: false });
  await db.query(`UPDATE attendance_records SET remarks = '(Sample)' WHERE attendance_date = $1 AND employee_id = ANY($2::int[])`, [t, [2, 3, karthik.id, divya.id]]);
  log('Today\'s punches imported:', imp.imported ?? imp);

  // ── 2e. Requests and records through the API ────────────────────────────
  const reg1 = await call(HR, 'POST', '/attendance/regularize', { employee_id: karthik.id, date: ymd(lateFix), check_in: '09:00', check_out: '17:35', reason: '(Sample) Gate punch machine was not reading faces at 9 AM — security register shows 08:58' });
  await call(NATESH, 'PUT', `/attendance/regularize/${reg1.id}/approve`, { remarks: 'Checked the security register — correct' }).catch(() => call(HR, 'PUT', `/attendance/regularize/${reg1.id}/approve`, { remarks: 'Checked the security register — correct' }));
  await call(HR, 'POST', '/attendance/regularize', { employee_id: karthik.id, date: ymd(missedOut), check_out: '17:40', reason: '(Sample) Forgot to punch out — left with the evening dispatch at 17:40' });

  let nextMon = addDays(today, 1); while (nextMon.getDay() !== 1) nextMon = addDays(nextMon, 1);
  let fri = addDays(today, 1); while (fri.getDay() !== 5) fri = addDays(fri, 1);
  const sc1 = await call(HR, 'POST', '/attendance/shift-change-requests', { employee_id: divya.id, request_date: ymd(fri), requested_shift_id: nightId, change_type: 'day', reason: '(Sample) Night inspection of the export batch' });
  await call(NATESH, 'PUT', `/attendance/shift-change-requests/${sc1.id}/approve`, { remarks: 'OK for the export batch' }).catch(() => call(HR, 'PUT', `/attendance/shift-change-requests/${sc1.id}/approve`, { remarks: 'OK for the export batch' }));
  await call(HR, 'POST', '/attendance/shift-change-requests', { employee_id: divya.id, request_date: ymd(nextMon), requested_shift_id: nightId, change_type: 'permanent', reason: '(Sample) Move to the night quality team from next week' });

  let lastFri = addDays(today, -1); while (lastFri.getDay() !== 5) lastFri = addDays(lastFri, -1);
  await call(HR, 'POST', '/attendance/overtime', { employee_id: karthik.id, attendance_date: ymd(lastFri), ot_hours: 1.5, ot_type: 'weekday', reason: '(Sample) Urgent dispatch — stayed till 19:00' }).catch((e) => log('OT sample skipped:', e.message));
  const lastMonth = addDays(new Date(today.getFullYear(), today.getMonth(), 1), -1);
  await call(HR, 'POST', '/attendance/late-arrivals/warning', { employee_id: divya.id, employee_name: `${divya.first} ${divya.last}`, department: divya.dept, month: ymd(lastMonth).slice(0, 7), late_count: 4, warning_text: '(Sample) You arrived late 4 times last month. Please be on time from now on.' }).catch((e) => log('Late warning skipped:', e.message));
  await call(HR, 'POST', '/attendance/geo-rules', { name: 'Head Office (Sample)', location_name: 'Head Office, Chennai', lat: 13.0827, lng: 80.2707, radius_meters: 200, rule_type: 'office', is_mandatory: false, applicable_to: 'all' }).catch((e) => log('Geo rule skipped:', e.message));
  await call(HR, 'POST', '/attendance/work-centre', { employee_id: karthik.id, work_centre_id: 1, work_centre_name: 'Cutting Section', shift_id: generalId, date: ymd(addDays(missedOut, -1)), check_in: '09:00', check_out: '17:30', units_produced: 120, remarks: '(Sample)' }).catch((e) => log('Work-centre sample skipped:', e.message));
  const cl1 = await call(HR, 'POST', '/attendance/contract-labour', { contractor_company: 'Sri Balaji Manpower (Sample)', employee_name: 'Murugan K (Sample)', employee_code: 'CL-101', designation: 'Helper', shift_id: generalId, contract_start: '2026-06-01', contract_expiry: '2027-05-31', safety_certified: true, pf_member: true, esi_covered: true }).catch((e) => { log('Contract worker skipped:', e.message); return null; });
  await call(HR, 'POST', '/attendance/contract-labour', { contractor_company: 'Sri Balaji Manpower (Sample)', employee_name: 'Lakshmi R (Sample)', employee_code: 'CL-102', designation: 'Packer', shift_id: generalId, contract_start: '2026-01-01', contract_expiry: ymd(addDays(today, 20)), safety_certified: false }).catch((e) => log('Contract worker skipped:', e.message));
  if (cl1?.id) await call(HR, 'POST', '/attendance/contract-labour/attendance', { contract_id: cl1.id, date: t, check_in: '08:50', status: 'present', remarks: '(Sample)' }).catch((e) => log('Contract attendance skipped:', e.message));

  log('Attendance sample data created.');
} catch (err) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.end();
}
