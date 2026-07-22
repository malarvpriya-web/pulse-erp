import express from 'express';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import {
  listPayroll,
  getPayrollSummary,
  getEmployeePayslip,
  getPayslipByQuery,
  generatePayroll,
  runPayroll,
  markPaid,
  getPayrollTrend,
  getForm16,
  getCompliance,
  computeSlip,
  generatePdfData,
  streamPayslipPdf,
  emailPayslip,
  bulkGenerateSlips,
  getMyPayslips,
  saveSlip,
  getPayrollHistory,
} from './payroll.controller.js';

const router = express.Router();

// Roles that can access any employee's payroll data
const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'manager', 'finance_manager'];

// Self-service guard for the PayslipViewer page: HR_ROLES may look up any
// employee's payslip; every other authenticated role (finance, employee, ...)
// may only reach their own record. Mirrors the ownEmployeeId anti-spoof
// pattern used by travel/service-desk self-service routes.
async function ownPayslipOrForbidden(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (HR_ROLES.includes(role)) return next();

  let ownId = req.user?.employee_id ?? null;
  if (ownId == null) {
    const userId = req.user?.userId ?? req.user?.id;
    if (userId) {
      const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
      ownId = rows[0]?.employee_id ?? null;
    }
  }
  if (ownId == null) return res.status(403).json({ success: false, message: 'No employee record linked to this account' });

  const requestedId = req.params.id ?? req.query.employee_id ?? req.body?.employee_id ?? null;
  if (requestedId != null && String(requestedId) !== String(ownId)) {
    return res.status(403).json({ success: false, message: 'You may only view your own payslip' });
  }
  if (req.query && !req.query.employee_id) req.query.employee_id = String(ownId);
  if (req.body && requestedId == null) req.body.employee_id = ownId;
  next();
}

// ── Validation middleware ─────────────────────────────────────────────────────
const validateGenerate = (req, res, next) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required' });
  }
  if (month < 1 || month > 12) {
    return res.status(400).json({ success: false, message: 'month must be between 1 and 12' });
  }
  if (year < 2000 || year > 2100) {
    return res.status(400).json({ success: false, message: 'year is out of valid range' });
  }
  next();
};

const validateMarkPaid = (req, res, next) => {
  const { month, year } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required' });
  }
  if (!req.params.id || isNaN(Number(req.params.id))) {
    return res.status(400).json({ success: false, message: 'valid employee id is required' });
  }
  next();
};

// ── Read ──────────────────────────────────────────────────────────────────────
// List/summary/trend: HR roles only — employees use /my-payslips
router.get('/',                   verifyToken, allowRoles(...HR_ROLES), listPayroll);
router.get('/summary',            verifyToken, allowRoles(...HR_ROLES), getPayrollSummary);
router.get('/trend',              verifyToken, allowRoles(...HR_ROLES), getPayrollTrend);
router.get('/compliance',         verifyToken, allowRoles(...HR_ROLES), getCompliance);
// Employee self-service: no allowRoles — controller filters by JWT userId
router.get('/my-payslips',        verifyToken, getMyPayslips);
router.get('/employee/:id',       verifyToken, allowRoles(...HR_ROLES), getEmployeePayslip);
// PayslipViewer self-service: HR_ROLES can look up any employee, everyone
// else is scoped to their own record by ownPayslipOrForbidden.
router.get('/payslips',           verifyToken, ownPayslipOrForbidden, getPayslipByQuery);
router.get('/payslips/:id',       verifyToken, allowRoles(...HR_ROLES), getEmployeePayslip);
router.get('/form16/:employeeId',   verifyToken, allowRoles(...HR_ROLES), getForm16);
router.get('/payslip-pdf/:id',      verifyToken, allowRoles(...HR_ROLES), streamPayslipPdf);
router.get('/history/:employeeId',  verifyToken, allowRoles(...HR_ROLES), getPayrollHistory);

// ── Approval workflow ─────────────────────────────────────────────────────────
// POST /payroll/approve — Finance Head approves a period; status pending→approved
const FINANCE_ROLES = ['admin', 'super_admin', 'finance_manager', 'payroll_admin'];
router.post('/approve', verifyToken, allowRoles(...FINANCE_ROLES), async (req, res) => {
  const { month, year } = req.body;
  if (!month || !year) return res.status(400).json({ message: 'month and year are required' });
  const cid = req.scope?.company_id ?? null;
  try {
    // payroll_runs has no company_id column of its own — scope through the
    // employee it belongs to (payroll_runs.employee_id -> employees.company_id),
    // the same pattern payroll.controller.js uses everywhere else. The previous
    // version filtered on a nonexistent payroll_runs.company_id column, which
    // made this endpoint fail on every call.
    const { rows: approvedRows } = await pool.query(
      `UPDATE payroll_runs pr
          SET status = 'approved', approved_by = $1, approved_at = NOW()
        WHERE pr.month = $2 AND pr.year = $3
          AND pr.status = 'pending'
          AND ($4::integer IS NULL OR EXISTS (
                SELECT 1 FROM employees e WHERE e.id = pr.employee_id AND e.company_id = $4
              ))
        RETURNING pr.id, pr.employee_id, pr.gross, pr.net_pay, pr.employer_pf, pr.employer_esi`,
      [req.user?.userId ?? null, parseInt(month), parseInt(year), cid]
    );
    const rowCount = approvedRows.length;
    if (rowCount === 0) return res.status(400).json({ message: 'No pending payroll records found for this period (already approved or paid).' });
    logAudit({ userId: req.user?.userId, module: 'Payroll', recordId: null, recordType: 'payroll_run', action: 'approve', newData: { month: parseInt(month), year: parseInt(year), approved_count: rowCount }, req });
    // Notify HR team (non-blocking)
    import('../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', {
        module: 'Payroll',
        recordId: null,
        submitterId: req.user?.id ?? req.user?.userId,
        recipientIds: [],
        comments: `Payroll for ${month}/${year} approved (${rowCount} record(s))`,
      }).catch(() => {});
    }).catch(() => {});

    // Post the approved period to the General Ledger. Previously nothing ever
    // called this — payroll's biggest expense line never reached the books.
    // Non-blocking / best-effort: a GL posting failure must not undo the
    // payroll approval that already committed above.
    let gl = null;
    try {
      const { postPayrollJournal } = await import('../finance/services/payrollJournal.service.js');
      const totals = approvedRows.reduce((acc, r) => ({
        gross: acc.gross + parseFloat(r.gross || 0),
        net: acc.net + parseFloat(r.net_pay || 0),
        pf: acc.pf + parseFloat(r.employer_pf || 0),
        esi: acc.esi + parseFloat(r.employer_esi || 0),
      }), { gross: 0, net: 0, pf: 0, esi: 0 });
      gl = await postPayrollJournal({
        payroll_run_id: `${year}-${String(month).padStart(2, '0')}`,
        payroll_month: `${year}-${String(month).padStart(2, '0')}`,
        gross_salary: totals.gross,
        net_salary: totals.net,
        pf_employer: totals.pf,
        esi_employer: totals.esi,
        companyId: cid,
        userId: req.user?.userId ?? null,
      });
    } catch (glErr) {
      console.error('[POST /payroll/approve] GL posting skipped:', glErr.message);
    }

    res.json({ success: true, message: `${rowCount} payroll record(s) approved for ${month}/${year}`, approved_count: rowCount, gl_posting: gl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Write ─────────────────────────────────────────────────────────────────────
router.post('/generate',                verifyToken, allowRoles(...HR_ROLES), validateGenerate, generatePayroll);
router.post('/run',                     verifyToken, allowRoles(...HR_ROLES), validateGenerate, runPayroll);
router.post('/compute-slip',            verifyToken, allowRoles(...HR_ROLES), computeSlip);
router.post('/save-slip',               verifyToken, allowRoles(...HR_ROLES), saveSlip);
router.post('/generate-pdf-data/:id',   verifyToken, allowRoles(...HR_ROLES), generatePdfData);
router.post('/email-payslip',           verifyToken, ownPayslipOrForbidden, emailPayslip);
router.post('/bulk-generate',           verifyToken, allowRoles(...HR_ROLES), bulkGenerateSlips);
router.post('/:id/mark-paid',           verifyToken, allowRoles(...HR_ROLES), validateMarkPaid, markPaid);

// ── Reports & Exports ─────────────────────────────────────────────────────────

// GET /payroll/register?month=&year= — full payroll register CSV
router.get('/register', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = req.scope?.company_id ?? null;
  const monthName = ['','January','February','March','April','May','June',
    'July','August','September','October','November','December'][m];

  try {
    const { rows } = await pool.query(`
      SELECT
        e.office_id          AS emp_code,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.department, e.designation,
        pr.basic, pr.hra,
        COALESCE(pr.conveyance_allowance, 0) AS conveyance,
        COALESCE(pr.medical_allowance, 0)    AS medical,
        COALESCE(pr.special_allowance, 0)    AS special,
        COALESCE(pr.overtime_pay, 0)         AS overtime,
        COALESCE(pr.bonus, 0)                AS bonus,
        pr.gross,
        pr.employee_pf, pr.employer_pf,
        COALESCE(pr.eps, 0)                  AS eps,
        pr.employee_esi, pr.employer_esi,
        pr.professional_tax,
        COALESCE(pr.lwf_employee, 0)         AS lwf_employee,
        pr.tds,
        COALESCE(pr.loan_deduction, 0)       AS loan_deduction,
        pr.total_deductions,
        pr.net_pay,
        pr.lop_days,
        pr.status,
        COALESCE(pr.payment_mode, '')        AS payment_mode,
        e.account_number AS bank_account, e.ifsc_code
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND ($3::integer IS NULL OR e.company_id = $3)
      ORDER BY e.department, e.first_name
    `, [m, y, cid]);

    if (!rows.length) return res.status(404).json({ message: 'No payroll data found. Generate payroll first.' });

    const headers = [
      'Emp Code','Employee Name','Department','Designation',
      'Basic','HRA','Conveyance','Medical','Special Allowance','Overtime','Bonus','Gross Pay',
      'Emp PF','Emr PF','EPS','Emp ESI','Emr ESI','Prof Tax','LWF','TDS','Loan Deduction',
      'Total Deductions','Net Pay','LOP Days','Status','Payment Mode','Bank Account','IFSC Code'
    ];
    const csvRows = rows.map(r => [
      r.emp_code, `"${r.employee_name}"`, r.department, `"${r.designation || ''}"`,
      r.basic, r.hra, r.conveyance, r.medical, r.special, r.overtime, r.bonus, r.gross,
      r.employee_pf, r.employer_pf, r.eps, r.employee_esi, r.employer_esi,
      r.professional_tax, r.lwf_employee, r.tds, r.loan_deduction,
      r.total_deductions, r.net_pay, r.lop_days, r.status, r.payment_mode,
      r.bank_account || '', r.ifsc_code || '',
    ].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Payroll_Register_${monthName}_${y}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /payroll/dept-cost?month=&year= — department-wise cost report
router.get('/dept-cost', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = req.scope?.company_id ?? null;

  try {
    const { rows } = await pool.query(`
      SELECT
        e.department,
        COUNT(*)::INT                         AS employee_count,
        ROUND(SUM(pr.gross))::NUMERIC         AS total_gross,
        ROUND(SUM(pr.net_pay))::NUMERIC       AS total_net,
        ROUND(SUM(pr.employee_pf + pr.employer_pf))::NUMERIC AS total_pf,
        ROUND(SUM(pr.employee_esi + pr.employer_esi))::NUMERIC AS total_esi,
        ROUND(SUM(pr.tds))::NUMERIC           AS total_tds,
        ROUND(SUM(pr.professional_tax))::NUMERIC AS total_pt,
        ROUND(SUM(COALESCE(pr.lwf_employee,0) + COALESCE(pr.lwf_employer,0)))::NUMERIC AS total_lwf,
        ROUND(SUM(pr.gross + pr.employer_pf + pr.employer_esi))::NUMERIC AS total_ctc
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND ($3::integer IS NULL OR e.company_id = $3)
      GROUP BY e.department
      ORDER BY total_gross DESC
    `, [m, y, cid]);

    const grandTotal = rows.reduce((acc, r) => ({
      employee_count: acc.employee_count + r.employee_count,
      total_gross:    acc.total_gross    + parseFloat(r.total_gross    || 0),
      total_net:      acc.total_net      + parseFloat(r.total_net      || 0),
      total_pf:       acc.total_pf       + parseFloat(r.total_pf       || 0),
      total_esi:      acc.total_esi      + parseFloat(r.total_esi      || 0),
      total_tds:      acc.total_tds      + parseFloat(r.total_tds      || 0),
      total_ctc:      acc.total_ctc      + parseFloat(r.total_ctc      || 0),
    }), { employee_count: 0, total_gross: 0, total_net: 0, total_pf: 0, total_esi: 0, total_tds: 0, total_ctc: 0 });

    res.json({ month: m, year: y, departments: rows, grand_total: grandTotal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Statutory Filing Exports ──────────────────────────────────────────────────

// GET /payroll/pf-ecr?month=&year= — EPFO ECR 2.0 text file
router.get('/pf-ecr', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = req.scope?.company_id ?? null;

  try {
    const { rows } = await pool.query(`
      SELECT
        pr.employee_id,
        pr.gross              AS gross_wages,
        pr.basic              AS epf_wages,
        pr.employee_pf,
        COALESCE(pr.eps, 0)          AS eps,
        COALESCE(pr.epf_employer, 0) AS epf_employer,
        pr.lop_days           AS ncp_days,
        e.first_name, e.last_name,
        COALESCE(e.uan_number, '')   AS uan,
        e.office_id           AS employee_code
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND ($3::integer IS NULL OR e.company_id = $3)
      ORDER BY e.first_name, e.last_name
    `, [m, y, cid]);

    if (!rows.length) return res.status(404).json({ message: 'No payroll data found for this period. Run payroll generation first.' });

    const monthName = ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'][m];
    const fileName = `PF_ECR_${monthName}_${y}.txt`;

    // EPFO ECR 2.0 format (pipe-delimited, header first)
    const header = `UAN~Member Name~Gross Wages~EPF Wages~EPS Wages~ECR Wages~EDLI Wages~Gross PF Contri~EPF Contri~EPS Contri~EDLI Contri~NCP Days~Refund of Advances`;
    const lines = rows.map(r => {
      const epfWages  = parseFloat(r.epf_wages || 0);
      const gross     = parseFloat(r.gross_wages || 0);
      const empPF     = parseFloat(r.employee_pf || 0);
      const eps       = parseFloat(r.eps || 0);
      const epfEmpr   = parseFloat(r.epf_employer || 0);
      const edli      = Math.round(epfWages * 0.005);     // 0.5% employer EDLI
      const grossPF   = empPF + epfEmpr + eps;
      const ncp       = Math.round(parseFloat(r.ncp_days || 0));
      const uan       = r.uan || `UAN_PENDING_${r.employee_code || r.employee_id}`;
      const name      = `${r.first_name || ''} ${r.last_name || ''}`.trim();
      return `${uan}~${name}~${gross}~${epfWages}~${epfWages}~${epfWages}~${epfWages}~${grossPF}~${epfEmpr}~${eps}~${edli}~${ncp}~0`;
    });

    const content = [header, ...lines].join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /payroll/esi-challan?month=&year= — ESI challan CSV
router.get('/esi-challan', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const m   = parseInt(req.query.month) || new Date().getMonth() + 1;
  const y   = parseInt(req.query.year)  || new Date().getFullYear();
  const cid = req.scope?.company_id ?? null;

  try {
    const { rows } = await pool.query(`
      SELECT
        pr.employee_id,
        pr.gross            AS gross_wages,
        pr.employee_esi,
        pr.employer_esi,
        e.first_name, e.last_name,
        e.office_id         AS employee_code,
        COALESCE(e.esic_ip_number, '') AS ip_number
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE pr.month = $1 AND pr.year = $2
        AND pr.employee_esi > 0
        AND ($3::integer IS NULL OR e.company_id = $3)
      ORDER BY e.first_name, e.last_name
    `, [m, y, cid]);

    if (!rows.length) return res.status(404).json({ message: 'No ESI-applicable employees for this period.' });

    const monthName = ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'][m];
    const fileName = `ESI_Challan_${monthName}_${y}.csv`;

    const totEmpESI  = rows.reduce((s, r) => s + parseFloat(r.employee_esi || 0), 0);
    const totEmrESI  = rows.reduce((s, r) => s + parseFloat(r.employer_esi || 0), 0);
    const totESI     = totEmpESI + totEmrESI;

    const csvLines = [
      `ESI Challan - ${monthName} ${y}`,
      ``,
      `IP Number,Employee Code,Employee Name,Gross Wages,Employee ESI (0.75%),Employer ESI (3.25%),Total ESI`,
      ...rows.map(r => {
        const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        return `${r.ip_number || 'PENDING'},${r.employee_code || r.employee_id},"${name}",${parseFloat(r.gross_wages || 0).toFixed(2)},${parseFloat(r.employee_esi || 0).toFixed(2)},${parseFloat(r.employer_esi || 0).toFixed(2)},${(parseFloat(r.employee_esi || 0) + parseFloat(r.employer_esi || 0)).toFixed(2)}`;
      }),
      ``,
      `TOTAL,,,${rows.reduce((s, r) => s + parseFloat(r.gross_wages || 0), 0).toFixed(2)},${totEmpESI.toFixed(2)},${totEmrESI.toFixed(2)},${totESI.toFixed(2)}`,
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Statutory Bonus (Payment of Bonus Act 1965) ───────────────────────────────
// GET /payroll/statutory-bonus?year=&department=
// Bonus Act: eligible employees earn ≤ ₹21,000/month; bonus = 8.33% of wages (min)
// Wage basis: basic salary (no DA in this model). Bonus year = Apr to Mar.
router.get('/statutory-bonus', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const bonusYear = parseInt(req.query.year) || new Date().getFullYear();
  const dept      = req.query.department;
  const cid       = req.scope?.company_id ?? null;
  // FY: Apr (bonusYear) → Mar (bonusYear+1)
  const fyStart   = bonusYear, fyEnd = bonusYear + 1;

  try {
    // Aggregate annual wages from payroll_runs for the FY
    let q = `
      SELECT
        pr.employee_id,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.office_id  AS emp_code,
        e.department, e.designation,
        e.joining_date,
        COUNT(DISTINCT pr.month || '-' || pr.year)::INT AS months_worked,
        ROUND(AVG(pr.basic))::NUMERIC                    AS avg_basic,
        ROUND(SUM(pr.basic))::NUMERIC                    AS annual_basic_wages
      FROM payroll_runs pr
      JOIN employees e ON e.id = pr.employee_id
      WHERE (
        (pr.year = $1 AND pr.month >= 4)
        OR (pr.year = $2 AND pr.month <= 3)
      )
      AND ($3::integer IS NULL OR e.company_id = $3)
    `;
    const params = [fyStart, fyEnd, cid];
    if (dept) { params.push(dept); q += ` AND e.department = $${params.length}`; }
    q += ` GROUP BY pr.employee_id, e.first_name, e.last_name, e.office_id, e.department, e.designation, e.joining_date`;

    const { rows } = await pool.query(q, params);

    const BONUS_WAGE_CEILING = 21000;    // gross eligibility ceiling
    const MIN_BONUS_PCT      = 8.33 / 100;
    const MAX_BONUS_PCT      = 20.00 / 100;
    const BONUS_CALC_CEILING = 7000;     // wage ceiling for bonus calculation

    const result = rows.map(r => {
      const avgBasic    = parseFloat(r.avg_basic || 0);
      const eligible    = avgBasic <= BONUS_WAGE_CEILING;
      const calcWage    = Math.min(avgBasic, BONUS_CALC_CEILING);
      const minBonus    = eligible ? Math.round(calcWage * 12 * MIN_BONUS_PCT) : 0;
      const maxBonus    = eligible ? Math.round(calcWage * 12 * MAX_BONUS_PCT) : 0;
      return {
        employee_id:    r.employee_id,
        employee_name:  r.employee_name,
        emp_code:       r.emp_code,
        department:     r.department,
        designation:    r.designation,
        months_worked:  r.months_worked,
        avg_basic:      avgBasic,
        eligible:       eligible,
        reason:         eligible ? null : `Average basic ₹${avgBasic.toLocaleString('en-IN')} exceeds ₹21,000 ceiling`,
        bonus_wage:     eligible ? calcWage : 0,
        min_bonus:      minBonus,
        max_bonus:      maxBonus,
        recommended_bonus: minBonus, // 8.33% minimum
      };
    });

    const eligibleCount  = result.filter(r => r.eligible).length;
    const totalMinBonus  = result.reduce((s, r) => s + r.min_bonus, 0);
    const totalMaxBonus  = result.reduce((s, r) => s + r.max_bonus, 0);

    res.json({
      financial_year: `${fyStart}-${fyEnd}`,
      total_employees: result.length,
      eligible_count:  eligibleCount,
      total_min_bonus: totalMinBonus,
      total_max_bonus: totalMaxBonus,
      bonus_wage_ceiling: BONUS_WAGE_CEILING,
      calc_wage_ceiling:  BONUS_CALC_CEILING,
      employees: result,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Arrears / Retro Pay ───────────────────────────────────────────────────────

// GET /payroll/arrears/compute — preview arrears for a salary revision (no DB write)
router.get('/arrears/compute', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { employee_id, from_month, from_year, to_month, to_year, old_basic, new_basic } = req.query;
  if (!employee_id || !from_month || !from_year || !old_basic || !new_basic) {
    return res.status(400).json({ message: 'employee_id, from_month, from_year, old_basic, new_basic required' });
  }
  const fmN = parseInt(from_month), fyN = parseInt(from_year);
  const tmN = parseInt(to_month) || new Date().getMonth() + 1;
  const tyN = parseInt(to_year)  || new Date().getFullYear();
  const oldB = parseFloat(old_basic), newB = parseFloat(new_basic);
  if (newB <= oldB) return res.status(400).json({ message: 'new_basic must be greater than old_basic' });

  // Build month range
  const months = [];
  let cur = new Date(fyN, fmN - 1, 1);
  const end = new Date(tyN, tmN - 1, 1);
  while (cur <= end) {
    months.push({ month: cur.getMonth() + 1, year: cur.getFullYear() });
    cur.setMonth(cur.getMonth() + 1);
  }

  const basicDiff    = newB - oldB;
  const hraRatio     = 0.40; // standard HRA at 40% of basic
  const grossDiff    = basicDiff * (1 + hraRatio + 0.15); // basic + HRA + special (~55% of basic added)
  const pfDiff       = Math.min(newB, 15000) > Math.min(oldB, 15000)
    ? Math.round((Math.min(newB, 15000) - Math.min(oldB, 15000)) * 0.12) : 0;
  const monthlyNet   = Math.round(grossDiff - pfDiff);
  const totalArrear  = monthlyNet * months.length;
  const tdsOnArrear  = Math.round(totalArrear * 0.10); // 10% TDS on arrears (approx)
  const netArrear    = totalArrear - tdsOnArrear;

  res.json({
    employee_id: parseInt(employee_id),
    from: `${from_month}/${from_year}`, to: `${tmN}/${tyN}`,
    months_count: months.length,
    old_basic: oldB, new_basic: newB,
    basic_diff: basicDiff,
    monthly_gross_diff: Math.round(grossDiff),
    monthly_pf_diff: pfDiff,
    monthly_net_arrear: monthlyNet,
    total_arrear: totalArrear,
    tds_on_arrear: tdsOnArrear,
    net_arrear: netArrear,
    month_breakdown: months.map(m => ({ ...m, net_arrear: monthlyNet })),
  });
});

// GET /payroll/arrears — list arrears
router.get('/arrears', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const { employee_id, status } = req.query;
  try {
    let q = `
      SELECT a.*,
             TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
             e.office_id AS employee_code, e.department
        FROM payroll_arrears a
        JOIN employees e ON e.id = a.employee_id
       WHERE ($1::integer IS NULL OR a.company_id = $1)
    `;
    const params = [cid];
    if (employee_id) { params.push(parseInt(employee_id)); q += ` AND a.employee_id = $${params.length}`; }
    if (status)      { params.push(status);                q += ` AND a.status = $${params.length}`; }
    q += ' ORDER BY a.created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /payroll/arrears — create and approve an arrears entry
router.post('/arrears', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { employee_id, arrear_type = 'salary_revision', from_month, from_year,
          to_month, to_year, old_basic, new_basic, arrear_amount,
          tds_on_arrear = 0, reason } = req.body;
  if (!employee_id || !from_month || !from_year || !arrear_amount) {
    return res.status(400).json({ message: 'employee_id, from_month, from_year, arrear_amount required' });
  }
  const cid = req.scope?.company_id ?? null;
  try {
    const net = parseFloat(arrear_amount) - parseFloat(tds_on_arrear || 0);
    const { rows } = await pool.query(`
      INSERT INTO payroll_arrears
        (employee_id, company_id, arrear_type, from_month, from_year, to_month, to_year,
         old_basic, new_basic, arrear_amount, tds_on_arrear, net_arrear, reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [employee_id, cid, arrear_type, from_month, from_year,
       to_month || from_month, to_year || from_year,
       old_basic || 0, new_basic || 0,
       parseFloat(arrear_amount), parseFloat(tds_on_arrear || 0), net,
       reason, req.user?.id ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /payroll/arrears/:id/approve — approve and mark paid_in_month
router.put('/arrears/:id/approve', verifyToken, allowRoles(...FINANCE_ROLES), async (req, res) => {
  const { paid_in_month, paid_in_year } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE payroll_arrears
         SET status = 'approved', approved_by = $1, approved_at = NOW(),
             paid_in_month = $2, paid_in_year = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [req.user?.id ?? null, paid_in_month, paid_in_year, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Arrear not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Loan / Advance management ─────────────────────────────────────────────────
router.get('/loan-advances', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*,
              TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
              e.office_id AS employee_code
         FROM payroll_loans l
         LEFT JOIN employees e ON e.id = l.employee_id
        WHERE l.status = 'active'
        ORDER BY l.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/loan-advances', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const { employee_id, loan_type = 'loan', principal_amount, emi_amount, start_date, reason } = req.body;
  if (!employee_id || !principal_amount || !emi_amount)
    return res.status(400).json({ message: 'employee_id, principal_amount, emi_amount required' });
  try {
    const months = Math.ceil(parseFloat(principal_amount) / parseFloat(emi_amount));
    const schedule = [];
    let balance = parseFloat(principal_amount);
    const sd = new Date(start_date || new Date());
    for (let i = 0; i < months; i++) {
      const d = new Date(sd); d.setMonth(d.getMonth() + i);
      const payment = Math.min(parseFloat(emi_amount), balance);
      balance = Math.max(0, balance - payment);
      schedule.push({ month: i + 1, date: d.toISOString().split('T')[0], emi: payment, balance });
    }
    const { rows } = await pool.query(
      `INSERT INTO payroll_loans (employee_id, loan_type, principal_amount, emi_amount,
         outstanding_balance, start_date, reason, emi_schedule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [employee_id, loan_type, principal_amount, emi_amount, principal_amount,
       start_date || new Date().toISOString().split('T')[0], reason, JSON.stringify(schedule)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/loan-advances/:id/close', verifyToken, allowRoles(...HR_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid loan id' });
  try {
    const { rows } = await pool.query(
      `UPDATE payroll_loans SET status='closed', outstanding_balance=0, updated_at=NOW()
        WHERE id=$1 RETURNING id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Loan not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;