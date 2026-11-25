/**
 * Leaves sample data (Leaves review, 2026-11-23 — owner: keep 1–2 "(Sample)"
 * rows on every page). Idempotent: adds nothing when the samples exist.
 *
 * Only on the three "(Sample)" employees (EMP041 Karthik, EMP042 Priya,
 * EMP043 Suresh; manager EMP002), never on real staff. Every reason starts
 * "(Sample)" — delete later by that marker.
 *
 *   Balances  : Sick 7, Casual 7 for each; 1 day Compensatory Off for Karthik
 *   Requests  : one in every state — waiting for the manager, for the
 *               department head (Comp Off), for HR; approved; Loss of Pay;
 *               rejected with a reason; cancelled; a half day
 *   Encashment: one waiting for approval, one cancelled (no payroll effect)
 *
 * Usage (from backend/): node scripts/samples/leaves-sample-data.mjs
 */
import pool from '../../src/config/db.js';

const CO = 1;
const YEAR = 2026;
const SAMPLE_BASIC = 30000;   // the sample employees have no salary; stated here so the claim has a value

const { rows: emps } = await pool.query(
  `SELECT id, office_id, reporting_manager_id FROM employees
    WHERE company_id = $1 AND office_id IN ('EMP041','EMP042','EMP043') AND name ILIKE '%(Sample)%' ORDER BY office_id`, [CO]);
if (emps.length !== 3) throw new Error('The three (Sample) employees EMP041–043 are missing — run attendance-sample-data.mjs first');
const [karthik, priya, suresh] = emps;
const { rows: typeRows } = await pool.query(
  `SELECT id, UPPER(leave_code) AS code FROM leave_types WHERE company_id = $1 AND deleted_at IS NULL`, [CO]);
const T = Object.fromEntries(typeRows.map(t => [t.code, t.id]));
for (const c of ['SICK', 'CASUAL', 'EL', 'LOP', 'COMPENSATO']) if (!T[c]) throw new Error(`Leave type ${c} missing`);

const { rows: [have] } = await pool.query(
  `SELECT COUNT(*)::int AS n FROM leave_applications WHERE employee_id = ANY($1::int[]) AND reason ILIKE '(Sample)%'`, [emps.map(e => e.id)]);
if (have.n > 0) { console.log(`Samples already present (${have.n}) — nothing added.`); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Balances
  const bal = async (emp, type, days) => client.query(
    `INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
     VALUES ($1, $2, $3, $4, 0) ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`, [emp, type, YEAR, days]);
  for (const e of emps) { await bal(e.id, T.SICK, 7); await bal(e.id, T.CASUAL, 7); }
  await bal(karthik.id, T.COMPENSATO, 1);

  const mgr = karthik.reporting_manager_id;
  // [employee, type, start, end, days, status, manager, l2, hr, reason, extra]
  const plan = [
    [karthik, 'CASUAL', '2026-12-02', '2026-12-02', 1,   'pending',   'pending',  null,       'pending',  'Family function at home'],
    [priya,   'SICK',   '2026-11-26', '2026-11-27', 2,   'pending',   'pending',  null,       'pending',  'Fever — doctor advised two days rest'],
    [suresh,  'EL',     '2026-12-08', '2026-12-10', 3,   'pending',   'approved', null,       'pending',  'Visiting native place', { mc: 'OK, hand over the AMC visits to Ravi' }],
    [karthik, 'COMPENSATO', '2026-12-04', '2026-12-04', 1, 'pending', 'approved', 'pending',  'pending',  'Comp off for the Sunday dispatch on 16 Nov', { mc: 'Approved — department head to confirm' }],
    [karthik, 'EL',     '2026-11-05', '2026-11-06', 2,   'approved',  'approved', null,       'approved', 'Cousin\'s wedding', { mc: 'Enjoy', hc: 'Approved' }],
    [priya,   'LOP',    '2026-11-10', '2026-11-10', 1,   'approved',  'approved', null,       'approved', 'Extra day after travel, unpaid', { lop: true, mc: 'OK as unpaid', hc: 'Approved as Loss of Pay' }],
    [priya,   'CASUAL', '2026-11-13', '2026-11-13', 1,   'rejected',  'rejected', null,       'pending',  'Personal work', { mc: 'Line audit that day — please pick another date' }],
    [suresh,  'SICK',   '2026-11-18', '2026-11-18', 1,   'cancelled', 'pending',  null,       'pending',  'Not well', { wr: 'Felt better, came to work' }],
    [suresh,  'CASUAL', '2026-12-01', '2026-12-01', 0.5, 'pending',   'pending',  null,       'pending',  'Bank work in the morning', { half: 'AM' }],
  ];
  const markOnLeave = (empId, s, e) => client.query(`
    UPDATE attendance_records
       SET status = 'on_leave', check_in_time = NULL, check_out_time = NULL, total_hours = 0,
           late_minutes = 0, early_leave_minutes = 0, ot_hours = 0, source = 'leave_sync',
           remarks = '(Sample) on approved leave', updated_at = NOW()
     WHERE employee_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
       AND deleted_at IS NULL AND remarks LIKE '(Sample)%'`, [empId, s, e]);
  let n = 0;
  for (const [emp, code, s, e, days, status, ms, l2, hs, reason, x = {}] of plan) {
    const { rows: [app] } = await client.query(`
      INSERT INTO leave_applications
        (employee_id, leave_type_id, start_date, end_date, number_of_days, reason, manager_id,
         manager_status, l2_status, hr_status, status, is_lop, lop_days, half_day, half_day_session,
         manager_comments, manager_approved_at, hr_comments, hr_approved_at, withdrawal_reason,
         company_id, applied_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, NOW() - INTERVAL '3 days')
      RETURNING id`,
      [emp.id, T[code], s, e, days, `(Sample) ${reason}`, mgr,
        ms, l2, hs, status, !!x.lop, x.lop ? days : 0, !!x.half, x.half || null,
        x.mc ? `(Sample) ${x.mc}` : null, ms !== 'pending' ? new Date() : null,
        x.hc ? `(Sample) ${x.hc}` : null, hs === 'approved' ? new Date() : null,
        x.wr ? `(Sample) ${x.wr}` : null, CO]);
    const hist = (lvl, act, c) => client.query(
      `INSERT INTO leave_approval_history (leave_application_id, approver_id, approval_level, action, comments) VALUES ($1,$2,$3,$4,$5)`,
      [app.id, lvl === 0 ? emp.id : mgr, lvl, act, c]);
    if (ms !== 'pending') await hist(1, ms, x.mc ? `(Sample) ${x.mc}` : null);
    if (hs === 'approved') await hist(3, 'approved', x.hc ? `(Sample) ${x.hc}` : null);
    if (status === 'cancelled') await hist(0, 'cancelled', x.wr ? `(Sample) ${x.wr}` : null);
    // An approved leave's working days are leave in attendance, not the sample
    // punches attendance-sample-data.mjs laid down (2026-11-24: they said
    // "present" on the very days of the approved sample leave).
    if (status === 'approved' && !x.half) await markOnLeave(emp.id, s, e);
    // Approving a leave adds its days to leave_balances.used_days
    // (incrementUsedBalance); F&F and year-end carry-forward read that column.
    // Inserting the approved row directly left EL "0 used" (2026-11-25).
    if (status === 'approved' && !x.lop) await client.query(`
      INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
      VALUES ($1, $2, $3, 0, $4)
      ON CONFLICT (employee_id, leave_type_id, year)
      DO UPDATE SET used_days = COALESCE(leave_balances.used_days, 0) + EXCLUDED.used_days, updated_at = NOW()`,
      [emp.id, T[code], YEAR, days]);
    n++;
  }

  // Encashment claims — pending and cancelled only, so nothing reaches payroll.
  const rate = Number((SAMPLE_BASIC / 26).toFixed(2));
  const claim = (emp, days, status, reason) => client.query(`
    INSERT INTO leave_encashments (employee_id, leave_type_id, year, days_encashed, rate_per_day, gross_amount, tds_amount, net_amount,
                                   encashment_month, encashment_year, reason, status, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$10,$6 - $10,12,$3,$7,$8,$9)`,
    [emp.id, T.EL, YEAR, days, rate, Number((days * rate).toFixed(2)), `(Sample) ${reason}`, status, CO,
      Number((days * rate * 0.20).toFixed(2))]);   // 20% TDS — the Leave Settings default
  await claim(karthik, 2, 'pending', 'Year-end encashment of unused Earned Leave');
  await claim(priya, 1, 'cancelled', 'Asked by mistake — days kept for December leave');

  await client.query('COMMIT');
  console.log({ sample_applications: n, sample_encashments: 2, balances: 'Sick 7 + Casual 7 each; Comp Off 1 for Karthik' });
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED, nothing added:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
