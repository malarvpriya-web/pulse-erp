import pool from '../shared/db.js';
import {
  computePayroll,
  computeBulkPayroll,
  generateForm16Summary,
  getMonthName,
} from './payrollEngine.js';

const ACTIVE_STATUSES = `LOWER(status) IN ('active', 'probation')`;

const BASE_FIELDS = `
  id, office_id, first_name, last_name, department, designation,
  basic_salary, account_number, ifsc_code, bank_name, state, work_state,
  EXTRACT(YEAR FROM AGE(NOW(), joining_date)) as years_of_service
`;

export async function listPayroll({ month, year, department, page, limit: limitParam, company_id } = {}) {
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year)  || new Date().getFullYear();
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(limitParam) || 200));
  const offset   = (pageNum - 1) * pageSize;

  const params = [];
  let q = `SELECT ${BASE_FIELDS} FROM employees WHERE ${ACTIVE_STATUSES}`;
  if (company_id != null) {
    params.push(company_id);
    q += ` AND company_id = $${params.length}`;
  }
  if (department && department !== 'All') {
    params.push(department);
    q += ` AND department = $${params.length}`;
  }

  // Count query for pagination metadata
  const countQ = q.replace(`SELECT ${BASE_FIELDS}`, 'SELECT COUNT(*)::INT AS total');
  const { rows: countRows } = await pool.query(countQ, params).catch(() => ({ rows: [{ total: 0 }] }));
  const total = countRows[0]?.total || 0;

  params.push(pageSize, offset);
  q += ` ORDER BY department, first_name LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(q, params);
  if (!rows.length) return [];

  // Pull saved payroll_runs for this period so we overlay the persisted
  // status and authoritative amounts onto the computed results.
  const { rows: runs } = await pool.query(
    `SELECT employee_id, status,
            gross, net_pay, total_deductions,
            employee_pf, employer_pf, employee_esi, employer_esi,
            tds, professional_tax, ctc_monthly,
            overtime_pay, overtime_hours
     FROM payroll_runs WHERE month = $1 AND year = $2`,
    [m, y]
  ).catch(() => ({ rows: [] }));

  const runMap = Object.fromEntries(runs.map(r => [String(r.employee_id), r]));

  const computed = computeBulkPayroll(rows, { month: m, year: y });
  const data = computed.map(slip => {
    if (slip.error) return slip;
    const run = runMap[String(slip.employee_id)];
    if (!run) return slip;
    return {
      ...slip,
      gross:            parseFloat(run.gross            ?? slip.gross),
      net_pay:          parseFloat(run.net_pay          ?? slip.net_pay),
      total_deductions: parseFloat(run.total_deductions ?? slip.total_deductions),
      employee_pf:      parseFloat(run.employee_pf      ?? slip.employee_pf),
      employer_pf:      parseFloat(run.employer_pf      ?? slip.employer_pf),
      employee_esi:     parseFloat(run.employee_esi     ?? slip.employee_esi),
      employer_esi:     parseFloat(run.employer_esi     ?? slip.employer_esi),
      tds:              parseFloat(run.tds              ?? slip.tds),
      professional_tax: parseFloat(run.professional_tax ?? slip.professional_tax),
      ctc_monthly:      parseFloat(run.ctc_monthly      ?? slip.ctc_monthly),
      overtime_pay:     parseFloat(run.overtime_pay     ?? slip.overtime_pay ?? 0),
      overtime_hours:   parseFloat(run.overtime_hours   ?? 0),
      status:           run.status || 'pending',
    };
  });
  return {
    data,
    pagination: { page: pageNum, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
  };
}

export async function getSummary({ month, year, company_id } = {}) {
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year)  || new Date().getFullYear();
  const cidFilter = company_id != null ? 'AND employee_id IN (SELECT id FROM employees WHERE company_id = $3)' : '';
  const cidParams = company_id != null ? [m, y, company_id] : [m, y];

  // Try fetching from saved runs first
  const { rows: saved } = await pool.query(`
    SELECT
      COUNT(DISTINCT employee_id)::INT        AS total_employees,
      ROUND(SUM(gross)::NUMERIC, 2)           AS total_gross,
      ROUND(SUM(net_pay)::NUMERIC, 2)         AS total_net,
      ROUND(SUM(total_deductions)::NUMERIC, 2) AS total_deductions,
      ROUND(SUM(employee_pf + employer_pf)::NUMERIC, 2) AS total_pf,
      ROUND(SUM(employee_esi + employer_esi)::NUMERIC, 2) AS total_esi,
      ROUND(SUM(tds)::NUMERIC, 2)             AS total_tds,
      ROUND(SUM(professional_tax)::NUMERIC, 2) AS total_pt,
      ROUND(SUM(ctc_monthly)::NUMERIC, 2)     AS ctc_monthly,
      COUNT(CASE WHEN status = 'paid' THEN 1 END)::INT AS paid_count
    FROM payroll_runs
    WHERE month = $1 AND year = $2 ${cidFilter}
  `, cidParams).catch(() => ({ rows: [] }));

  if (saved.length && saved[0].total_employees > 0) {
    const s = saved[0];
    return {
      ...s,
      total_gross:      parseFloat(s.total_gross),
      total_net:        parseFloat(s.total_net),
      total_deductions: parseFloat(s.total_deductions),
      total_pf:         parseFloat(s.total_pf),
      total_esi:        parseFloat(s.total_esi),
      total_tds:        parseFloat(s.total_tds),
      total_pt:         parseFloat(s.total_pt),
      ctc_monthly:      parseFloat(s.ctc_monthly),
      pending_count:    s.total_employees - s.paid_count,
      processing_count: 0,
      month: m, year: y,
      payroll_period: `${getMonthName(m)} ${y}`,
      source: 'saved_records'
    };
  }

  // Fallback: Compute on the fly (Dynamic Preview)
  const { rows: emps } = await pool.query(
    `SELECT ${BASE_FIELDS} FROM employees WHERE ${ACTIVE_STATUSES}`
  );
  if (!emps.length) {
    return { total_employees: 0, total_gross: 0, total_net: 0, total_deductions: 0, paid_count: 0, pending_count: 0 };
  }
  const computed = computeBulkPayroll(emps, { month: m, year: y }).filter(r => !r.error);
  const totals = computed.reduce((acc, r) => ({
    total_gross:      acc.total_gross      + r.gross,
    total_net:        acc.total_net        + r.net_pay,
    total_deductions: acc.total_deductions + r.total_deductions,
    total_pf:         acc.total_pf         + r.employee_pf + r.employer_pf,
    total_esi:        acc.total_esi        + r.employee_esi + r.employer_esi,
    total_tds:        acc.total_tds        + r.tds,
    total_pt:         acc.total_pt         + r.professional_tax,
    ctc_monthly:      acc.ctc_monthly      + r.ctc_monthly,
  }), { total_gross: 0, total_net: 0, total_deductions: 0, total_pf: 0, total_esi: 0, total_tds: 0, total_pt: 0, ctc_monthly: 0 });

  return {
    total_employees: computed.length,
    paid_count: 0, pending_count: computed.length, processing_count: 0,
    month: m, year: y,
    payroll_period: `${getMonthName(m)} ${y}`,
    ...totals,
    source: 'dynamic_preview'
  };
}

export async function markPaid(employeeId, { month, year, payment_mode = 'bank_transfer', reference } = {}) {
  const m = parseInt(month);
  const y = parseInt(year);

  // Mark salary as paid
  await pool.query(`
    UPDATE payroll_runs
    SET status = 'paid', generated_at = NOW(), payment_mode = $4, payment_reference = $5
    WHERE employee_id = $1 AND month = $2 AND year = $3
  `, [employeeId, m, y, payment_mode, reference || null]);

  // Sync Section 192 TDS to tds_transactions ─────────────────────────────────
  // Fetch the payroll record to get TDS amount
  try {
    const { rows: [run] } = await pool.query(
      `SELECT tds, gross, net_pay FROM payroll_runs WHERE employee_id=$1 AND month=$2 AND year=$3 LIMIT 1`,
      [employeeId, m, y]
    );
    const tdsAmount = parseFloat(run?.tds || 0);
    if (tdsAmount <= 0) return { success: true, message: 'Marked as paid' };

    // Fetch employee name and PAN
    const { rows: [emp] } = await pool.query(
      `SELECT first_name, last_name, pan_number FROM employees WHERE id=$1`, [employeeId]
    );

    // Indian FY and quarter derived from payroll month
    const fyStartYear = m >= 4 ? y : y - 1;
    const fy = `${fyStartYear}-${fyStartYear + 1}`;
    let quarter;
    if (m >= 4 && m <= 6)  quarter = 'Q1';
    else if (m >= 7 && m <= 9)  quarter = 'Q2';
    else if (m >= 10 && m <= 12) quarter = 'Q3';
    else quarter = 'Q4';

    // Salary payment date: last day of the payroll month
    const paymentDate = new Date(y, m, 0).toISOString().split('T')[0]; // last day of month

    // Upsert a deductee row for this employee (section 192)
    const { rows: [deductee] } = await pool.query(
      `INSERT INTO tds_deductees
         (party_name, pan, deductee_type, section, threshold_limit, rate_with_pan, rate_without_pan, employee_id)
       VALUES ($1,$2,'individual','192',250000,0,20,$3)
       ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL DO UPDATE
         SET party_name=EXCLUDED.party_name, pan=EXCLUDED.pan
       RETURNING id`,
      [emp ? `${emp.first_name} ${emp.last_name}` : `Employee ${employeeId}`,
       emp?.pan_number || null, employeeId]
    );

    // Skip if TDS for this month/year already recorded
    const { rows: existing } = await pool.query(
      `SELECT id FROM tds_transactions
       WHERE employee_id=$1 AND payroll_month=$2 AND payroll_year=$3 AND section='192' LIMIT 1`,
      [employeeId, m, y]
    );
    if (existing.length > 0) return { success: true, message: 'Marked as paid' };

    await pool.query(
      `INSERT INTO tds_transactions
         (deductee_id, section, payment_date, payment_amount, tds_rate, tds_amount,
          surcharge, education_cess, total_tds, quarter, financial_year,
          employee_id, payroll_month, payroll_year)
       VALUES ($1,'192',$2,$3,0,$4,0,0,$4,$5,$6,$7,$8,$9)`,
      [deductee.id, paymentDate, parseFloat(run.gross),
       tdsAmount, quarter, fy, employeeId, m, y]
    );
  } catch (tdsErr) {
    // Non-fatal: log but don't fail the salary payment
    console.error(`[payroll] TDS sync failed for employee ${employeeId}:`, tdsErr.message);
  }

  return { success: true, message: 'Marked as paid' };
}

export async function getPayrollTrend() {
  // Directly query the database for 6-month historical aggregates
  const { rows } = await pool.query(`
    WITH RecentMonths AS (
      SELECT 
        EXTRACT(YEAR FROM gs)::INT as r_year,
        EXTRACT(MONTH FROM gs)::INT as r_month,
        TO_CHAR(gs, 'Mon') as r_label
      FROM generate_series(
        DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
        DATE_TRUNC('month', CURRENT_DATE),
        INTERVAL '1 month'
      ) gs
    )
    SELECT 
      rm.r_label as month,
      COALESCE(SUM(pr.gross), (SELECT SUM(basic_salary) FROM employees WHERE ${ACTIVE_STATUSES})) as gross,
      COALESCE(SUM(pr.net_pay), (SELECT SUM(basic_salary) * 0.85 FROM employees WHERE ${ACTIVE_STATUSES})) as net
    FROM RecentMonths rm
    LEFT JOIN payroll_runs pr ON pr.year = rm.r_year AND pr.month = rm.r_month
    GROUP BY rm.r_year, rm.r_month, rm.r_label
    ORDER BY rm.r_year ASC, rm.r_month ASC
  `);

  return rows.map(r => ({
    month: r.month,
    gross: Math.round(parseFloat(r.gross || 0)),
    net:   Math.round(parseFloat(r.net || 0)),
  }));
}

export async function getEmployeePayslip(employeeId, { month, year } = {}) {
  const { rows } = await pool.query(`SELECT * FROM employees WHERE id = $1`, [employeeId]);
  if (!rows.length) return null;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year)  || new Date().getFullYear();
  return computePayroll(rows[0], { month: m, year: y });
}

// Default payroll settings — used when no company_settings row exists yet
const DEFAULT_PAYROLL_SETTINGS = {
  working_days: 26, regime: 'new',
  pf_enabled: true, esi_enabled: true, professional_tax: true, tds_auto_calculate: true,
  enable_hra: true, enable_conveyance: true, enable_medical_allowance: true, enable_special_allowance: true,
  round_net_pay: 1,
};

async function fetchPayrollSettings(company_id) {
  try {
    const cid = company_id != null ? company_id : 0;
    const { rows } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`,
      [cid]
    );
    return rows.length ? { ...DEFAULT_PAYROLL_SETTINGS, ...rows[0].settings } : DEFAULT_PAYROLL_SETTINGS;
  } catch {
    return DEFAULT_PAYROLL_SETTINGS;
  }
}

export async function generatePayroll({ month, year, department, employee_id, company_id } = {}) {
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year)  || new Date().getFullYear();

  // Fetch company payroll settings so the engine honours toggles and rates
  const payrollSettings = await fetchPayrollSettings(company_id);

  // Fetch active employees joined with their latest salary assignment + structure components
  const params = [];
  let q = `
    SELECT e.id, e.office_id, e.first_name, e.last_name, e.department, e.designation,
           e.company_email AS email, e.personal_email AS work_email, e.pan_number, e.account_number AS bank_account, e.joining_date,
           e.status AS emp_status, e.state, e.work_state,
           COALESCE(esa.basic_salary, e.basic_salary, 0) AS basic_salary,
           EXTRACT(YEAR FROM AGE(NOW(), e.joining_date)) AS years_of_service,
           ss.components AS structure_components
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT basic_salary, structure_id
      FROM employee_salary_assignments
      WHERE employee_id = e.id
      ORDER BY effective_from DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) esa ON true
    LEFT JOIN salary_structures ss ON ss.id = esa.structure_id
    WHERE ${ACTIVE_STATUSES.replace(/\bstatus\b/g, 'e.status')} AND e.deleted_at IS NULL
  `;
  if (employee_id) {
    params.push(parseInt(employee_id));
    q += ` AND e.id = $${params.length}`;
  }
  if (department && department !== 'All') {
    params.push(department);
    q += ` AND e.department = $${params.length}`;
  }
  if (company_id != null) {
    params.push(company_id);
    q += ` AND e.company_id = $${params.length}`;
  }
  q += ' ORDER BY e.department, e.first_name';
  const { rows: emps } = await pool.query(q, params);

  if (!emps.length) return { message: 'No active employees found', count: 0 };

  // Batch-fetch approved OT hours + weighted multiplier per employee for this month
  const { rows: otRows } = await pool.query(`
    SELECT employee_id,
           SUM(ot_hours)                                              AS total_hours,
           SUM(ot_hours * multiplier) / NULLIF(SUM(ot_hours), 0)     AS weighted_multiplier
      FROM attendance_ot_records
     WHERE EXTRACT(MONTH FROM attendance_date) = $1
       AND EXTRACT(YEAR  FROM attendance_date) = $2
       AND status IN ('approved', 'auto_approved')
       AND ($3::integer IS NULL OR company_id = $3)
     GROUP BY employee_id
  `, [m, y, company_id ?? null]).catch(() => ({ rows: [] }));
  const otMap = Object.fromEntries(otRows.map(r => [String(r.employee_id), r]));

  // Batch-fetch LOP days + night shift days from payroll_attendance_summary
  const { rows: lopRows } = await pool.query(`
    SELECT employee_id, lop_days, COALESCE(night_shift_days, 0) AS night_shift_days
      FROM payroll_attendance_summary
     WHERE month = $1 AND year = $2
       AND ($3::integer IS NULL OR company_id = $3)
  `, [m, y, company_id ?? null]).catch(() => ({ rows: [] }));
  const lopMap   = Object.fromEntries(lopRows.map(r => [String(r.employee_id), parseFloat(r.lop_days || 0)]));
  const nightMap = Object.fromEntries(lopRows.map(r => [String(r.employee_id), parseInt(r.night_shift_days || 0)]));

  // Batch-fetch active loan EMI per employee (auto-deduction)
  const empIds = emps.map(e => e.id);
  const { rows: loanRows } = await pool.query(`
    SELECT employee_id, emi_amount
      FROM payroll_loans
     WHERE status = 'active'
       AND outstanding_balance > 0
       AND start_date <= MAKE_DATE($1, $2, 1)
       AND employee_id = ANY($3::int[])
  `, [y, m, empIds]).catch(() => ({ rows: [] }));
  const loanMap = Object.fromEntries(loanRows.map(r => [String(r.employee_id), parseFloat(r.emi_amount || 0)]));

  // Batch-fetch IT declarations for old-regime TDS (annual amounts per employee)
  const fy = m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
  const { rows: declRows } = await pool.query(`
    SELECT employee_id, declaration_type, SUM(amount) AS total_amount
      FROM it_declarations
     WHERE financial_year = $1 AND status IN ('approved', 'submitted')
       AND employee_id = ANY($2::int[])
     GROUP BY employee_id, declaration_type
  `, [fy, empIds]).catch(() => ({ rows: [] }));
  const declMap = {};
  for (const d of declRows) {
    const key = String(d.employee_id);
    if (!declMap[key]) declMap[key] = {};
    declMap[key][d.declaration_type.toLowerCase()] = parseFloat(d.total_amount || 0);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    for (const emp of emps) {
      let slip;
      const otData   = otMap[String(emp.id)];
      const otHours  = parseFloat(otData?.total_hours || 0);
      const otMult   = parseFloat(otData?.weighted_multiplier || 1.5);
      const loanEmi  = loanMap[String(emp.id)] || 0;
      const nightDays = nightMap[String(emp.id)] || 0;
      try {
        const empDecl = declMap[String(emp.id)] || {};
        slip = computePayroll(emp, {
          month: m, year: y, ...payrollSettings,
          overtime_hours:      otHours,
          ot_multiplier:       otMult,
          lop_days:            lopMap[String(emp.id)] ?? 0,
          night_shift_days:    nightDays,
          night_shift_rate:    payrollSettings.night_shift_rate || 200,
          deduction_80d:       empDecl['80d']       || 0,
          deduction_nps_80ccd: empDecl['80ccd']     || 0,
          lta_claimed:         empDecl['lta']        || 0,
          structureComponents: emp.structure_components || null,
        });
      } catch (calcErr) {
        results.push({ employee_id: emp.id, status: 'error', error: calcErr.message });
        continue;
      }

      // Apply auto-EMI loan deduction
      if (loanEmi > 0) {
        slip.loan_deduction = loanEmi;
        slip.net_pay        = Math.max(0, slip.net_pay - loanEmi);
        slip.total_deductions = slip.total_deductions + loanEmi;
      }

      // Guard: net_pay must not be negative
      if (slip.net_pay < 0) {
        results.push({ employee_id: emp.id, status: 'error', error: 'Net pay is negative — check deductions' });
        continue;
      }

      const periodStart = new Date(y, m - 1, 1).toISOString().split('T')[0];
      const periodEnd   = new Date(y, m, 0).toISOString().split('T')[0];
      const periodLabel = `${getMonthName(m)} ${y}`;

      // Upsert one row per employee per month/year into payroll_runs.
      // On conflict (same employee + month + year), update only if not already paid.
      await client.query(
        `INSERT INTO payroll_runs
           (period_label, period_start, period_end, status,
            employee_id, month, year,
            gross, net_pay, total_deductions,
            employee_pf, employer_pf, eps, epf_employer,
            employee_esi, employer_esi,
            tds, professional_tax, lwf_employee, lwf_employer,
            ctc_monthly, tax_regime, annual_taxable_income, annual_tax,
            basic, hra, conveyance_allowance, medical_allowance, special_allowance,
            lop_days, bonus, overtime_pay, overtime_hours, loan_deduction,
            generated_at)
         VALUES ($1,$2,$3,'pending',
                 $4,$5,$6,
                 $7,$8,$9,
                 $10,$11,$12,$13,
                 $14,$15,
                 $16,$17,$18,$19,
                 $20,$21,$22,$23,
                 $24,$25,$26,$27,$28,
                 $29,$30,$31,$32,$33,
                 NOW())
         ON CONFLICT (employee_id, month, year)
         WHERE employee_id IS NOT NULL AND month IS NOT NULL AND year IS NOT NULL
         DO UPDATE SET
           period_label          = EXCLUDED.period_label,
           period_start          = EXCLUDED.period_start,
           period_end            = EXCLUDED.period_end,
           gross                 = EXCLUDED.gross,
           net_pay               = EXCLUDED.net_pay,
           total_deductions      = EXCLUDED.total_deductions,
           employee_pf           = EXCLUDED.employee_pf,
           employer_pf           = EXCLUDED.employer_pf,
           eps                   = EXCLUDED.eps,
           epf_employer          = EXCLUDED.epf_employer,
           employee_esi          = EXCLUDED.employee_esi,
           employer_esi          = EXCLUDED.employer_esi,
           tds                   = EXCLUDED.tds,
           professional_tax      = EXCLUDED.professional_tax,
           lwf_employee          = EXCLUDED.lwf_employee,
           lwf_employer          = EXCLUDED.lwf_employer,
           ctc_monthly           = EXCLUDED.ctc_monthly,
           tax_regime            = EXCLUDED.tax_regime,
           annual_taxable_income = EXCLUDED.annual_taxable_income,
           annual_tax            = EXCLUDED.annual_tax,
           basic                 = EXCLUDED.basic,
           hra                   = EXCLUDED.hra,
           conveyance_allowance  = EXCLUDED.conveyance_allowance,
           medical_allowance     = EXCLUDED.medical_allowance,
           special_allowance     = EXCLUDED.special_allowance,
           lop_days              = EXCLUDED.lop_days,
           bonus                 = EXCLUDED.bonus,
           overtime_pay          = EXCLUDED.overtime_pay,
           overtime_hours        = EXCLUDED.overtime_hours,
           loan_deduction        = EXCLUDED.loan_deduction,
           generated_at          = NOW()
         WHERE payroll_runs.status != 'paid'`,
        [
          periodLabel, periodStart, periodEnd,
          emp.id, m, y,
          slip.gross, slip.net_pay, slip.total_deductions,
          slip.employee_pf, slip.employer_pf, slip.eps || 0, slip.epf_employer || 0,
          slip.employee_esi, slip.employer_esi,
          slip.tds, slip.professional_tax, slip.lwf_employee || 0, slip.lwf_employer || 0,
          slip.ctc_monthly, slip.tax_regime, slip.annual_taxable_income, slip.annual_tax,
          slip.basic, slip.hra, slip.conveyance_allowance, slip.medical_allowance, slip.special_allowance,
          slip.lop_days || 0, slip.bonus || 0, slip.overtime_pay || 0, otHours || 0, slip.loan_deduction || 0,
        ]
      );

      results.push({ ...slip, status: 'pending' });
    }

    await client.query('COMMIT');
    const saved = results.filter(r => !r.error);
    const errors = results.filter(r => r.error);
    return {
      message: `Payroll generated for ${saved.length} employees${errors.length ? ` (${errors.length} errors)` : ''}`,
      count:   saved.length,
      errors:  errors.length ? errors : undefined,
      data:    saved,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getMyPayslipList(email, employeeId) {
  const { rows } = await pool.query(
    `SELECT * FROM employees
     WHERE id = $1
        OR (company_email IS NOT NULL AND LOWER(company_email) = LOWER($2))
        OR (personal_email IS NOT NULL AND LOWER(personal_email) = LOWER($2))
     LIMIT 1`,
    [parseInt(employeeId) || 0, email || '']
  );
  if (!rows.length) return [];

  const emp = rows[0];
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();

  // Build list of (month, year) for the last 12 months
  const periods = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return { month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
  });

  // Bulk-fetch saved payroll_runs for all relevant years in one query
  const years = [...new Set(periods.map(p => p.year))];
  const { rows: runs } = await pool.query(
    `SELECT month, year, gross, net_pay, total_deductions,
            employee_pf, employer_pf, employee_esi, employer_esi,
            tds, professional_tax, ctc_monthly, status, period_label
     FROM payroll_runs
     WHERE employee_id = $1 AND year = ANY($2)`,
    [emp.id, years]
  ).catch(() => ({ rows: [] }));

  const runMap = Object.fromEntries(runs.map(r => [`${r.year}-${r.month}`, r]));

  return periods.map(({ month, year, label }) => {
    const run = runMap[`${year}-${month}`];
    const base = {
      month, year,
      period_label:  label,
      employee_id:   emp.id,
      employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
      department:    emp.department,
      designation:   emp.designation,
    };

    if (run) {
      return {
        ...base,
        net_pay:   Math.round(parseFloat(run.net_pay  || 0)),
        gross_pay: Math.round(parseFloat(run.gross    || 0)),
        status:    run.status || 'pending',
        slip:      run,
      };
    }

    try {
      const slip = computePayroll(emp, { month, year });
      return {
        ...base,
        net_pay:   Math.round(parseFloat(slip.net_pay) || 0),
        gross_pay: Math.round(parseFloat(slip.gross)   || 0),
        status:    'pending',
        slip,
      };
    } catch {
      return { ...base, net_pay: 0, gross_pay: 0, status: 'pending', slip: null };
    }
  });
}

export async function getForm16(employeeId) {
  const { rows } = await pool.query(`SELECT * FROM employees WHERE id = $1`, [employeeId]);
  if (!rows.length) return null;
  const emp = rows[0];

  // Form 16 covers Apr–Mar of the previous financial year
  const now = new Date();
  const fyEndYear   = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fyStartYear = fyEndYear - 1;

  // Build list of FY months: Apr(4)..Mar(3) bridging two calendar years
  const fyMonths = [
    ...Array.from({ length: 9 }, (_, i) => ({ month: i + 4, year: fyStartYear })),  // Apr–Dec
    ...Array.from({ length: 3 }, (_, i) => ({ month: i + 1, year: fyEndYear })),     // Jan–Mar
  ];

  // Fetch all saved payroll_runs for both years in one query
  const years = [fyStartYear, fyEndYear];
  const { rows: runs } = await pool.query(
    `SELECT month, year, gross, net_pay, total_deductions,
            employee_pf, employer_pf, employee_esi, employer_esi,
            tds, professional_tax, ctc_monthly, tax_regime,
            annual_taxable_income, annual_tax, basic, hra,
            conveyance_allowance, medical_allowance, special_allowance
     FROM payroll_runs
     WHERE employee_id = $1 AND year = ANY($2)`,
    [emp.id, years]
  ).catch(() => ({ rows: [] }));

  const runMap = Object.fromEntries(runs.map(r => [`${r.year}-${r.month}`, r]));

  // Build 12 monthly slips: use persisted run if available, else compute
  const records = fyMonths.map(({ month, year }) => {
    const saved = runMap[`${year}-${month}`];
    if (saved) {
      return {
        ...computePayroll(emp, { month, year }),
        gross:            parseFloat(saved.gross || 0),
        net_pay:          parseFloat(saved.net_pay || 0),
        total_deductions: parseFloat(saved.total_deductions || 0),
        employee_pf:      parseFloat(saved.employee_pf || 0),
        employer_pf:      parseFloat(saved.employer_pf || 0),
        employee_esi:     parseFloat(saved.employee_esi || 0),
        employer_esi:     parseFloat(saved.employer_esi || 0),
        tds:              parseFloat(saved.tds || 0),
        professional_tax: parseFloat(saved.professional_tax || 0),
        ctc_monthly:      parseFloat(saved.ctc_monthly || 0),
        tax_regime:       saved.tax_regime || 'new',
        annual_taxable_income: parseFloat(saved.annual_taxable_income || 0),
        annual_tax:       parseFloat(saved.annual_tax || 0),
      };
    }
    return computePayroll(emp, { month, year });
  });

  return generateForm16Summary(emp, records);
}

export async function getCompliance({ month, year } = {}) {
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year)  || new Date().getFullYear();

  const { rows } = await pool.query(`
    SELECT
      COUNT(DISTINCT employee_id)::INT AS total_employees,
      ROUND(SUM(employee_pf)::NUMERIC, 2) as emp_pf,
      ROUND(SUM(employer_pf)::NUMERIC, 2) as emr_pf,
      ROUND(SUM(employee_esi)::NUMERIC, 2) as emp_esi,
      ROUND(SUM(employer_esi)::NUMERIC, 2) as emr_esi,
      ROUND(SUM(professional_tax)::NUMERIC, 2) as pt,
      ROUND(SUM(tds)::NUMERIC, 2) as tds,
      COUNT(CASE WHEN employee_esi > 0 THEN 1 END)::INT as esi_eligible
    FROM payroll_runs
    WHERE month = $1 AND year = $2
  `, [m, y]);

  if (rows.length && rows[0].total_employees > 0) {
    const r = rows[0];
    return {
      period:          `${getMonthName(m)} ${y}`,
      total_employees: r.total_employees,
      esi_eligible:    r.esi_eligible,
      pf_contribution: {
        employee: parseFloat(r.emp_pf),
        employer: parseFloat(r.emr_pf),
        total:    parseFloat(r.emp_pf) + parseFloat(r.emr_pf),
      },
      esi_contribution: {
        employee: parseFloat(r.emp_esi),
        employer: parseFloat(r.emr_esi),
        total:    parseFloat(r.emp_esi) + parseFloat(r.emr_esi),
      },
      professional_tax: parseFloat(r.pt),
      tds_deducted:     parseFloat(r.tds),
    };
  }

  // Fallback if not generated
  return {
    period: `${getMonthName(m)} ${y}`,
    total_employees: 0,
    esi_eligible: 0,
    pf_contribution: { employee: 0, employer: 0, total: 0 },
    esi_contribution: { employee: 0, employer: 0, total: 0 },
    professional_tax: 0,
    tds_deducted: 0,
    note: "Payroll not generated for this period"
  };
}
