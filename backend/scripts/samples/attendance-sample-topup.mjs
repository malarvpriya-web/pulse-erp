/**
 * Attendance sample top-up (owner, 2026-11-19: "at least keep 10 samples, then
 * only it is easy to understand how each page looks with data").
 *
 * Runs after attendance-sample-data.mjs. For every attendance page whose
 * sample rows are fewer than 10, adds "(Sample)" rows up to 10 — always on the
 * three "(Sample)" employees (EMP041 Karthik, EMP042, EMP043 Suresh, field)
 * and sample contract workers, never on real staff. Idempotent: run it again
 * and it adds nothing. Delete later by the "(Sample)" marker.
 *
 *   Regularization · Overtime · Shift change · Late warnings · Geo violations
 *   Contract labour (workers + attendance) · Work-centre logs · Delegation
 *
 * Usage: node scripts/samples/attendance-sample-topup.mjs   (from backend/)
 */
import pool from '../../src/config/db.js';

const CO = 1;
const TARGET = 10;
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toLocaleDateString('en-CA'); };
const workday = (n) => { // n-th working day back (Mon–Fri), n >= 1
  const d = new Date(); let k = 0;
  while (k < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) k++; }
  return d.toLocaleDateString('en-CA');
};
const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
const need = (have) => Math.max(0, TARGET - have);

const { rows: emps } = await pool.query(
  `SELECT id, office_id, name, department FROM employees
    WHERE company_id = $1 AND office_id IN ('EMP041','EMP042','EMP043') AND name ILIKE '%(Sample)%' ORDER BY office_id`, [CO]);
if (emps.length !== 3) throw new Error('Run attendance-sample-data.mjs first: the three (Sample) employees are missing');
const [karthik, priya, suresh] = emps;
const { rows: shifts } = await pool.query(`SELECT id, name FROM hr_shifts WHERE company_id = $1 AND name ILIKE '%(Sample)%' ORDER BY id`, [CO]);
const dayShift = shifts.find((s) => /General/i.test(s.name))?.id; const nightShift = shifts.find((s) => /Night/i.test(s.name))?.id;
// The deciding user on decided samples: the first active super admin (looked up
// by role, so no e-mail address sits in this public file).
const { rows: [admin] } = await pool.query(`
  SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
   WHERE LOWER(r.code) = 'super_admin' AND u.is_active = TRUE ORDER BY u.id LIMIT 1`);
const out = {};

// Regularization — pending / approved / rejected
{
  const n = need(await count(`SELECT COUNT(*) n FROM attendance_regularization_requests WHERE company_id = $1 AND reason ILIKE '%(Sample)%'`, [CO]));
  const plan = ['pending', 'approved', 'approved', 'rejected', 'pending', 'approved', 'approved', 'rejected', 'pending', 'approved'];
  const reasons = ['Forgot to punch out after the evening shift', 'Machine did not read my face at 09:00', 'Went to the customer site first, then office',
    'Power cut — machine was off in the morning', 'Punched on the wrong machine', 'Left for the hospital, came back at 14:00',
    'Badge reader error at the main gate', 'Worked late on the dispatch, forgot to punch out', 'Came in through the back gate', 'Training at the vendor site'];
  for (let i = 0; i < n; i++) {
    const e = [karthik, priya][i % 2]; const st = plan[i];
    await pool.query(`
      INSERT INTO attendance_regularization_requests
        (employee_id, date, check_in, check_out, reason, status, company_id, approval_level,
         manager_id, manager_remarks, manager_actioned_at, hr_id, hr_remarks, hr_actioned_at)
      VALUES ($1, $2, '09:00', '17:45', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING`,
    [e.id, workday(i + 3), `(Sample) ${reasons[i]}`, st, CO, st === 'pending' ? 'manager' : 'done',
      st === 'pending' ? null : admin?.id, st === 'pending' ? null : (st === 'approved' ? '(Sample) OK' : '(Sample) No proof'),
      st === 'pending' ? null : new Date(), st === 'approved' ? admin?.id : null, st === 'approved' ? '(Sample) Approved by HR' : null,
      st === 'approved' ? new Date() : null]);
  }
  out.regularization = n;
}

// Overtime
{
  const n = need(await count(`SELECT COUNT(*) n FROM attendance_ot_records WHERE company_id = $1 AND reason ILIKE '%(Sample)%'`, [CO]));
  const plan = ['pending', 'approved', 'rejected', 'approved', 'pending', 'approved', 'pending', 'approved', 'rejected', 'approved'];
  for (let i = 0; i < n; i++) {
    const e = [karthik, priya][i % 2]; const st = plan[i];
    await pool.query(`
      INSERT INTO attendance_ot_records (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, reason, status,
                                         approved_by, approved_at, rejection_remarks)
      VALUES ($1, $2, $3, $4, 'weekday', 2, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING`,
    [CO, e.id, workday(i + 2), [1, 1.5, 2, 2.5, 3][i % 5], `(Sample) ${['Urgent dispatch', 'Machine breakdown', 'Month-end stock count', 'Customer audit prep', 'Night quality check'][i % 5]}`,
      st, st === 'approved' ? priya.id === e.id ? karthik.id : priya.id : null, st === 'approved' ? new Date() : null,
      st === 'rejected' ? '(Sample) Not pre-approved' : null]);
  }
  out.overtime = n;
}

// Shift change — this day only / from this date
if (dayShift && nightShift) {
  const n = need(await count(`SELECT COUNT(*) n FROM shift_change_requests WHERE company_id = $1 AND reason ILIKE '%(Sample)%'`, [CO]));
  const plan = ['pending', 'approved', 'rejected', 'pending', 'approved', 'pending', 'rejected', 'approved', 'pending', 'approved'];
  for (let i = 0; i < n; i++) {
    const e = [karthik, priya, suresh][i % 3]; const st = plan[i];
    await pool.query(`
      INSERT INTO shift_change_requests (company_id, employee_id, request_date, current_shift_id, requested_shift_id, reason, status,
                                         reviewed_by, review_remarks, reviewed_at, change_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [CO, e.id, day(-(i + 3)), dayShift, nightShift, `(Sample) ${['Night inspection of the export batch', 'Child care in the mornings', 'Training course in the day', 'Covering for a colleague on leave', 'Moving to the night quality team'][i % 5]}`,
      st, st === 'pending' ? null : admin?.id, st === 'pending' ? null : (st === 'approved' ? '(Sample) OK' : '(Sample) No cover available'),
      st === 'pending' ? null : new Date(), i % 4 === 3 ? 'permanent' : 'day']);
  }
  out.shift_change = n;
}

// Late-arrival warnings
{
  const n = need(await count(`SELECT COUNT(*) n FROM attendance_late_warnings WHERE company_id = $1 AND warning_text ILIKE '%(Sample)%'`, [CO]));
  for (let i = 0; i < n; i++) {
    const e = [karthik, priya][i % 2];
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1 - Math.floor(i / 2));
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const late = 3 + (i % 4);
    await pool.query(`
      INSERT INTO attendance_late_warnings (company_id, employee_id, employee_name, department, issued_by, month, late_count, warning_text, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [CO, e.id, e.name, e.department, admin?.id, month, late,
      `(Sample) You arrived late ${late} times in ${month}. Please be on time; repeated late coming is cut from salary.`, i % 3 === 0 ? 'acknowledged' : 'issued']);
  }
  out.late_warnings = n;
}

// Geo violations — field employee punching outside the fence
{
  const n = need(await count(`SELECT COUNT(*) n FROM attendance_audit_logs WHERE company_id = $1 AND action = 'clock_in_geo_blocked' AND reason ILIKE '%(Sample)%'`, [CO]));
  for (let i = 0; i < n; i++) {
    const dist = 350 + i * 140;
    await pool.query(`
      INSERT INTO attendance_audit_logs (company_id, employee_id, action, after_data, performed_by, reason, performed_at)
      VALUES ($1, $2, 'clock_in_geo_blocked', $3::jsonb, $2, '(Sample) outside the fence', ($4::date + TIME '09:05'))`,
    [CO, suresh.id, JSON.stringify({ rule_name: 'Head Office (Sample)', distance_m: dist, radius_m: 200, location: `13.0${8 + (i % 2)}${i},80.27${i}` }), workday(i + 1)]);
  }
  out.geo_violations = n;
}

// Contract labour — workers, then attendance
{
  const n = need(await count(`SELECT COUNT(*) n FROM contract_labour WHERE company_id = $1 AND employee_name ILIKE '%(Sample)%'`, [CO]));
  const names = ['Murugan K', 'Selvi P', 'Ramesh V', 'Kavitha S', 'Arjun M', 'Lakshmi N', 'Vijay R', 'Meena T', 'Sathish B', 'Revathi D'];
  for (let i = 0; i < n; i++) {
    await pool.query(`
      INSERT INTO contract_labour (company_id, contractor_company, employee_name, employee_code, designation, shift_id,
                                   contract_start, contract_expiry, safety_certified, compliance_ok, is_active, pf_member, esi_covered, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true, $10, true, '(Sample)')`,
    [CO, i % 2 ? 'Sri Balaji Manpower (Sample)' : 'Kaveri Labour Services (Sample)', `${names[i]} (Sample)`, `CL-2${String(i).padStart(2, '0')}`,
      ['Helper', 'Packer', 'Loader', 'Welder helper', 'Cleaner'][i % 5], dayShift || null, day(200 + i * 10), day(-(30 + i * 45)), i % 3 !== 0, i % 2 === 0]);
  }
  out.contract_workers = n;
  const m = need(await count(`SELECT COUNT(*) n FROM contract_labour_attendance WHERE company_id = $1 AND remarks ILIKE '%(Sample)%'`, [CO]));
  const { rows: workers } = await pool.query(`SELECT id FROM contract_labour WHERE company_id = $1 AND employee_name ILIKE '%(Sample)%' ORDER BY id LIMIT 10`, [CO]);
  for (let i = 0; i < m && workers.length; i++) {
    const late = i % 4 === 1 ? 20 : 0;
    await pool.query(`
      INSERT INTO contract_labour_attendance (company_id, contract_id, attendance_date, check_in, check_out, hours_worked, status, late_minutes, remarks)
      VALUES ($1, $2, $3, $4, '17:30', $5, $6, $7, '(Sample)') ON CONFLICT DO NOTHING`,
    [CO, workers[i % workers.length].id, workday(1 + Math.floor(i / workers.length)), late ? '09:20' : '08:55', late ? 8.2 : 8.6, late ? 'late' : 'present', late]);
  }
  out.contract_attendance = m;
}

// Work-centre logs
{
  const n = need(await count(`SELECT COUNT(*) n FROM work_centre_attendance WHERE company_id = $1 AND remarks ILIKE '%(Sample)%'`, [CO]));
  const { rows: wcs } = await pool.query(`SELECT id, name FROM work_centres WHERE company_id = $1 ORDER BY id LIMIT 6`, [CO]);
  for (let i = 0; i < n && wcs.length; i++) {
    const e = [karthik, priya][i % 2]; const wc = wcs[i % wcs.length];
    await pool.query(`
      INSERT INTO work_centre_attendance (company_id, employee_id, work_centre_id, work_centre_name, shift_id, attendance_date,
                                          check_in, check_out, hours_worked, units_produced, remarks)
      VALUES ($1, $2, $3, $4, $5, $6, '09:00', '17:30', 8, $7, '(Sample)') ON CONFLICT DO NOTHING`,
    [CO, e.id, wc.id, wc.name, dayShift || null, workday(i + 1), 80 + i * 9]);
  }
  out.work_centre = n;
}

// Approval delegation — between sample employees only (neither manages anyone,
// so these hand off nothing real).
{
  const n = Math.max(0, 2 - await count(`SELECT COUNT(*) n FROM attendance_approval_delegations WHERE reason ILIKE '%(Sample)%'`));
  const plan = [
    [karthik.id, priya.id, day(2), day(-12), true, '(Sample) Karthik on annual leave — Priya decides'],
    [suresh.id, karthik.id, day(60), day(45), false, '(Sample) Suresh at a customer site last month'],
  ];
  for (const [from, to, f, t, active, reason] of plan.slice(0, n)) {
    await pool.query(`
      INSERT INTO attendance_approval_delegations (company_id, delegator_id, delegate_id, from_date, to_date, delegation_type, reason, is_active, created_by)
      VALUES ($1, $2, $3, $4, $5, 'all', $6, $7, $8)`, [CO, from, to, f, t, reason, active, admin?.id]);
  }
  out.delegations = n;
}

console.log('Added (Sample) rows:', out);
await pool.end();
