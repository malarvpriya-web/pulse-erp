import * as service from './payroll.service.js';
import pool from '../shared/db.js';
import { computePayroll, getMonthName } from './payrollEngine.js';
import { logAudit } from '../../services/AuditService.js';
import { sendPayslipEmail, isEmailConfigured } from '../../utils/mailer.js';
import PDFDocument from 'pdfkit';

export const listPayroll = async (req, res) => {
  try {
    const result = await service.listPayroll({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json({ success: true, data: result.data, pagination: result.pagination, message: 'Payroll list retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPayrollSummary = async (req, res) => {
  try {
    const data = await service.getSummary({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json({ success: true, data, message: 'Summary retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getEmployeePayslip = async (req, res) => {
  try {
    const data = await service.getEmployeePayslip(req.params.id, req.query);
    if (!data) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data, message: 'Payslip retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Reshape a flat computePayroll object into the {earnings, deductions, employee} shape
// that PayslipViewer.jsx expects.
function shapePayslip(slip, emp = {}) {
  if (!slip) return null;
  const earnings = [
    { label: 'Basic Salary',         amount: slip.basic                || 0 },
    { label: 'HRA',                   amount: slip.hra                  || 0 },
    { label: 'Conveyance Allowance',  amount: slip.conveyance_allowance || 0 },
    { label: 'Medical Allowance',     amount: slip.medical_allowance    || 0 },
    { label: 'Special Allowance',     amount: slip.special_allowance    || 0 },
  ];
  if ((slip.overtime_pay || 0) > 0) earnings.push({ label: 'Overtime Pay',  amount: slip.overtime_pay });
  if ((slip.bonus        || 0) > 0) earnings.push({ label: 'Bonus',         amount: slip.bonus });

  const deductions = [
    { label: 'Provident Fund (Employee)', amount: slip.employee_pf       || 0 },
    { label: 'Provident Fund (Employer)', amount: slip.employer_pf       || 0 },
  ];
  if ((slip.employee_esi    || 0) > 0) deductions.push({ label: 'ESI (Employee)',      amount: slip.employee_esi });
  if ((slip.employer_esi    || 0) > 0) deductions.push({ label: 'ESI (Employer)',      amount: slip.employer_esi });
  if ((slip.professional_tax || 0) > 0) deductions.push({ label: 'Professional Tax',   amount: slip.professional_tax });
  if ((slip.tds              || 0) > 0) deductions.push({ label: 'TDS (Income Tax)',   amount: slip.tds });
  if ((slip.loan_deduction   || 0) > 0) deductions.push({ label: 'Loan Deduction',     amount: slip.loan_deduction });
  if ((slip.advance_deduction || 0) > 0) deductions.push({ label: 'Advance Recovery',  amount: slip.advance_deduction });

  return {
    ...slip,
    earnings:   earnings.filter(e => e.amount > 0),
    deductions: deductions.filter(d => d.amount > 0),
    employee: {
      id:          slip.employee_id || emp.id,
      name:        slip.name        || emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
      designation: slip.designation || emp.designation,
      department:  slip.department  || emp.department,
      pan:         emp.pan_number   || slip.pan || null,
      bank:        emp.bank_account ? `****${String(emp.bank_account).slice(-4)}` : null,
      dob:         emp.date_of_birth || emp.dob || null,
      email:       emp.work_email   || emp.email || null,
      phone:       emp.phone        || emp.mobile || null,
    },
  };
}

// GET /payroll/payslips?employee_id=X&month=M&year=Y  (called by PayslipViewer)
export const getPayslipByQuery = async (req, res) => {
  try {
    const { employee_id, month, year } = req.query;
    if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id is required' });

    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';

    // Fetch employee record for personal details (pan, bank, dob, email, phone)
    const { rows: empRows } = await pool.query(
      `SELECT id, first_name, last_name, name, department, designation,
              pan_number, account_number AS bank_account, dob AS date_of_birth,
              company_email AS email, personal_email AS work_email, phone, phone AS mobile
       FROM employees WHERE id = $1 ${empCidFilter} LIMIT 1`,
      cid != null ? [employee_id, cid] : [employee_id]
    ).catch(() => ({ rows: [] }));
    const emp = empRows[0] || {};

    // Try saved per-employee payroll_runs row first
    const { rows: runRows } = await pool.query(
      `SELECT * FROM payroll_runs
        WHERE employee_id = $1 AND month = $2 AND year = $3
        LIMIT 1`,
      [employee_id, m, y]
    ).catch(() => ({ rows: [] }));

    if (runRows.length) {
      // Reconstruct slip from saved run columns
      const run = runRows[0];

      // breakdown columns (basic/hra/special_allowance) were added after the initial
      // payroll schema migration — older saved runs will have NULL/0 for these.
      // When that happens, fetch the full employee record and re-derive the breakdown
      // from the payroll engine so payslip line items display correctly.
      let basicAmt    = parseFloat(run.basic            || 0);
      let hraAmt      = parseFloat(run.hra              || 0);
      let convAmt     = parseFloat(run.conveyance_allowance || 0);
      let medAmt      = parseFloat(run.medical_allowance || 0);
      let specialAmt  = parseFloat(run.special_allowance || 0);

      if (basicAmt === 0 && parseFloat(run.gross || 0) > 0) {
        const { rows: empFull } = await pool.query(
          'SELECT * FROM employees WHERE id = $1', [employee_id]
        ).catch(() => ({ rows: [] }));
        if (empFull.length) {
          const computed = computePayroll(empFull[0], { month: m, year: y });
          basicAmt   = computed.basic;
          hraAmt     = computed.hra;
          convAmt    = computed.conveyance_allowance;
          medAmt     = computed.medical_allowance;
          specialAmt = computed.special_allowance;
        }
      }

      const savedSlip = {
        employee_id:          run.employee_id,
        month: m, year: y,
        payroll_period:       run.period_label,
        name:                 emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        department:           emp.department,
        designation:          emp.designation,
        basic:                basicAmt,
        hra:                  hraAmt,
        conveyance_allowance: convAmt  || 1600,
        medical_allowance:    medAmt   || 1250,
        special_allowance:    specialAmt,
        overtime_pay:         parseFloat(run.overtime_pay  || 0),
        overtime_hours:       parseFloat(run.overtime_hours || 0),
        bonus:                0,
        gross:                parseFloat(run.gross        || 0),
        employee_pf:          parseFloat(run.employee_pf  || 0),
        employer_pf:          parseFloat(run.employer_pf  || 0),
        employee_esi:         parseFloat(run.employee_esi || 0),
        employer_esi:         parseFloat(run.employer_esi || 0),
        professional_tax:     parseFloat(run.professional_tax || 0),
        tds:                  parseFloat(run.tds           || 0),
        total_deductions:     parseFloat(run.total_deductions || 0),
        net_pay:              parseFloat(run.net_pay       || 0),
        status:               run.status,
      };
      return res.json({ success: true, data: shapePayslip(savedSlip, emp), message: 'Payslip retrieved' });
    }

    // Fall back to on-the-fly computation
    const { rows: empFull } = await pool.query('SELECT * FROM employees WHERE id = $1', [employee_id]);
    if (!empFull.length) return res.status(404).json({ success: false, message: 'Employee not found' });

    const slip = computePayroll(empFull[0], { month: m, year: y });
    res.json({ success: true, data: shapePayslip(slip, empFull[0]), message: 'Payslip retrieved (computed)' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const generatePayroll = async (req, res) => {
  try {
    const data = await service.generatePayroll({ ...req.body, company_id: req.scope?.company_id ?? null });
    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'payroll',
      recordId: null,
      recordType: 'payroll_run',
      action: 'create',
      newData: { month: req.body.month, year: req.body.year, count: data.count, department: req.body.department ?? 'All' },
      req,
    });
    res.json({ success: true, data, message: data.message || 'Payroll generated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Alias: POST /payroll/run → same as /payroll/generate
export const runPayroll = generatePayroll;

export const markPaid = async (req, res) => {
  try {
    const data = await service.markPaid(req.params.id, req.body);
    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'payroll',
      recordId: req.params.id,
      recordType: 'payroll_run',
      action: 'update',
      oldData: { status: 'pending' },
      newData: { status: 'paid', month: req.body.month, year: req.body.year, payment_mode: req.body.payment_mode ?? 'bank_transfer' },
      req,
    });
    res.json({ success: true, data, message: 'Marked as paid' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPayrollTrend = async (req, res) => {
  try {
    const data = await service.getPayrollTrend();
    res.json({ success: true, data, message: 'Trend retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getForm16 = async (req, res) => {
  try {
    const data = await service.getForm16(req.params.employeeId);
    if (!data) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data, message: 'Form 16 retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getCompliance = async (req, res) => {
  try {
    const data = await service.getCompliance(req.query);
    res.json({ success: true, data, message: 'Compliance data retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const computeSlip = async (req, res) => {
  try {
    const { employee_id, month, year, lop_days = 0, bonus = 0, loan_deduction = 0, advance_deduction = 0 } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';
    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter}`,
      cid != null ? [employee_id, cid] : [employee_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    const empStatus = (rows[0].status || '').toLowerCase();
    if (!['active', 'probation'].includes(empStatus)) {
      return res.status(422).json({ error: `Cannot generate payslip — employee status is "${rows[0].status || 'unknown'}"` });
    }
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const slip = computePayroll(rows[0], {
      month: m, year: y,
      lop_days: parseFloat(lop_days) || 0,
      bonus: parseFloat(bonus) || 0,
    });
    const loan = parseFloat(loan_deduction) || 0;
    const adv  = parseFloat(advance_deduction) || 0;
    res.json({
      ...slip,
      loan_deduction: loan,
      advance_deduction: adv,
      total_deductions: slip.total_deductions + loan + adv,
      net_pay: slip.net_pay - loan - adv,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const generatePdfData = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year, lop_days = 0, bonus = 0, loan_deduction = 0, advance_deduction = 0 } = req.body;
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';
    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter}`,
      cid != null ? [id, cid] : [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    const empStatus = (rows[0].status || '').toLowerCase();
    if (!['active', 'probation'].includes(empStatus)) {
      return res.status(422).json({ error: `Cannot generate payslip — employee status is "${rows[0].status || 'unknown'}"` });
    }
    const emp = rows[0];
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const slip = computePayroll(emp, {
      month: m, year: y,
      lop_days: parseFloat(lop_days) || 0,
      bonus: parseFloat(bonus) || 0,
    });
    const loan = parseFloat(loan_deduction) || 0;
    const adv  = parseFloat(advance_deduction) || 0;

    const earnings = [
      { name: 'Basic Salary',           monthly: slip.basic,                ytd: slip.basic * m },
      { name: 'HRA',                    monthly: slip.hra,                  ytd: slip.hra * m },
      { name: 'Conveyance Allowance',   monthly: slip.conveyance_allowance, ytd: slip.conveyance_allowance * m },
      { name: 'Medical Allowance',      monthly: slip.medical_allowance,    ytd: slip.medical_allowance * m },
      { name: 'Special Allowance',      monthly: slip.special_allowance,    ytd: slip.special_allowance * m },
    ];
    if (slip.bonus > 0)        earnings.push({ name: 'Bonus',    monthly: slip.bonus,        ytd: slip.bonus });
    if (slip.overtime_pay > 0) earnings.push({ name: 'Overtime', monthly: slip.overtime_pay, ytd: slip.overtime_pay });

    const deductions = [
      { name: 'PF (Employee)', monthly: slip.employee_pf, ytd: slip.employee_pf * m },
    ];
    if ((slip.employer_pf    || 0) > 0) deductions.push({ name: 'PF (Employer)',      monthly: slip.employer_pf,      ytd: slip.employer_pf * m });
    if ((slip.employee_esi   || 0) > 0) deductions.push({ name: 'ESI (Employee)',      monthly: slip.employee_esi,     ytd: slip.employee_esi * m });
    if ((slip.employer_esi   || 0) > 0) deductions.push({ name: 'ESI (Employer)',      monthly: slip.employer_esi,     ytd: slip.employer_esi * m });
    if ((slip.professional_tax||0) > 0) deductions.push({ name: 'Professional Tax',    monthly: slip.professional_tax, ytd: slip.professional_tax * m });
    if ((slip.tds            || 0) > 0) deductions.push({ name: 'TDS (Income Tax)',    monthly: slip.tds,              ytd: slip.tds * m });
    if (loan > 0)                       deductions.push({ name: 'Loan Deduction',      monthly: loan,                  ytd: loan });
    if (adv  > 0)                       deductions.push({ name: 'Advance Recovery',    monthly: adv,                   ytd: adv });

    res.json({
      company: {
        name:    process.env.COMPANY_NAME    || 'Manifest Technologies Pvt. Ltd.',
        address: process.env.COMPANY_ADDRESS || 'Chennai, Tamil Nadu',
        gstin:   process.env.COMPANY_GSTIN   || 'PENDING',
      },
      employee: {
        name:        emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        code:        emp.office_id || `EMP${String(emp.id).padStart(4, '0')}`,
        designation: slip.designation || emp.designation || '—',
        department:  slip.department  || emp.department  || '—',
        pan:         emp.pan_number   || '—',
        bank_account: emp.bank_account || '—',
      },
      period: {
        period_label: slip.payroll_period,
        working_days: slip.working_days,
        lop_days:     slip.lop_days,
      },
      earnings,
      deductions,
      gross:            slip.gross,
      total_deductions: slip.total_deductions + loan + adv,
      net_pay:          slip.net_pay - loan - adv,
      ytd:              { gross: slip.gross * m, tds: slip.tds * m },
      form16_summary: {
        tax_regime:             slip.tax_regime,
        annual_taxable_income:  slip.annual_taxable_income,
        annual_tax:             slip.annual_tax,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const emailPayslip = async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Email service is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.',
      });
    }

    const { employee_id, month, year } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? 'AND company_id = $2' : '';

    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter}`,
      cid != null ? [employee_id, cid] : [employee_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = rows[0];
    const empStatus = (emp.status || '').toLowerCase();
    if (!['active', 'probation'].includes(empStatus)) {
      return res.status(422).json({ error: 'Cannot send payslip to an inactive or terminated employee' });
    }
    const recipient = emp.work_email || emp.email;
    if (!recipient) return res.status(422).json({ error: 'Employee has no email address on file' });

    const empName = emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim();

    // Prefer saved payroll run; fall back to on-the-fly computation
    const { rows: runRows } = await pool.query(
      `SELECT gross, net_pay, total_deductions FROM payroll_runs
       WHERE employee_id = $1 AND month = $2 AND year = $3 LIMIT 1`,
      [employee_id, m, y]
    ).catch(() => ({ rows: [] }));

    let gross, netPay, totalDeductions;
    if (runRows.length) {
      ({ gross, net_pay: netPay, total_deductions: totalDeductions } = runRows[0]);
    } else {
      const slip = computePayroll(emp, { month: m, year: y });
      gross = slip.gross; netPay = slip.net_pay; totalDeductions = slip.total_deductions;
    }

    const periodLabel = `${getMonthName(m)} ${y}`;

    try {
      await sendPayslipEmail(recipient, { empName, month: m, year: y, periodLabel, gross, netPay, totalDeductions });
    } catch (mailErr) {
      await pool.query(
        `INSERT INTO payslip_email_log (employee_id, month, year, sent_to, sent_at, status, error)
         VALUES ($1,$2,$3,$4,NOW(),'failed',$5)
         ON CONFLICT (employee_id, month, year) DO UPDATE
           SET sent_to=$4, sent_at=NOW(), status='failed', error=$5`,
        [employee_id, m, y, recipient, mailErr.message]
      ).catch(() => null);
      return res.status(502).json({ success: false, error: `Failed to send email: ${mailErr.message}` });
    }

    await pool.query(
      `INSERT INTO payslip_email_log (employee_id, month, year, sent_to, sent_at, status)
       VALUES ($1,$2,$3,$4,NOW(),'sent')
       ON CONFLICT (employee_id, month, year) DO UPDATE
         SET sent_to=$4, sent_at=NOW(), status='sent', error=NULL`,
      [employee_id, m, y, recipient]
    ).catch(() => null);

    res.json({
      success: true,
      sent_to: recipient,
      message: `Payslip for ${periodLabel} sent to ${empName} (${recipient})`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getMyPayslips = async (req, res) => {
  try {
    const { email, employee_id } = req.user;
    const data = await service.getMyPayslipList(email, employee_id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /payroll/payslip-pdf/:id?month=M&year=Y
// Streams a PDF payslip directly to the client using pdfkit.
export const streamPayslipPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const m = parseInt(req.query.month) || new Date().getMonth() + 1;
    const y = parseInt(req.query.year)  || new Date().getFullYear();
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';

    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter}`,
      cid != null ? [id, cid] : [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = rows[0];

    // Prefer saved payroll run for official figures
    const { rows: runRows } = await pool.query(
      `SELECT * FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3 LIMIT 1`,
      [id, m, y]
    ).catch(() => ({ rows: [] }));

    let slip;
    if (runRows.length) {
      const run = runRows[0];
      slip = {
        ...computePayroll(emp, { month: m, year: y }),
        gross:            parseFloat(run.gross),
        net_pay:          parseFloat(run.net_pay),
        total_deductions: parseFloat(run.total_deductions),
        employee_pf:      parseFloat(run.employee_pf),
        employer_pf:      parseFloat(run.employer_pf),
        employee_esi:     parseFloat(run.employee_esi || 0),
        employer_esi:     parseFloat(run.employer_esi || 0),
        professional_tax: parseFloat(run.professional_tax || 0),
        tds:              parseFloat(run.tds || 0),
        loan_deduction:   parseFloat(run.loan_deduction || 0),
        advance_deduction: parseFloat(run.advance_deduction || 0),
        bonus:            parseFloat(run.bonus || 0),
        overtime_pay:     parseFloat(run.overtime_pay || 0),
      };
    } else {
      slip = computePayroll(emp, { month: m, year: y });
      // Allow query-param overrides for live-preview PDF
      const qLoan    = parseFloat(req.query.loan_deduction    || 0);
      const qAdvance = parseFloat(req.query.advance_deduction || 0);
      if (qLoan    > 0) slip.loan_deduction    = qLoan;
      if (qAdvance > 0) slip.advance_deduction = qAdvance;
    }

    const empName    = emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
    const periodLabel = `${getMonthName(m)} ${y}`;
    const companyName = process.env.COMPANY_NAME    || 'Manifest Technologies Pvt. Ltd.';
    const companyAddr = process.env.COMPANY_ADDRESS || 'Chennai, Tamil Nadu';
    const fmt = (n) => `Rs.${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip_${empName.replace(/\s+/g, '_')}_${m}_${y}.pdf"`);
    doc.pipe(res);

    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(18).fillColor('#7c3aed').text(companyName, { align: 'center' });
    doc.fontSize(10).fillColor('#555').text(companyAddr, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(13).fillColor('#111').text(`Pay Slip — ${periodLabel}`, { align: 'center' });
    doc.moveTo(50, doc.y + 6).lineTo(545, doc.y + 6).strokeColor('#7c3aed').stroke();
    doc.moveDown(1);

    // ── Employee Details ──────────────────────────────────────────────────────
    const detailY = doc.y;
    doc.fontSize(10).fillColor('#111');
    const left = [
      ['Employee Name', empName],
      ['Designation',   slip.designation || emp.designation || '—'],
      ['Department',    slip.department  || emp.department  || '—'],
    ];
    const right = [
      ['Employee Code', emp.office_id || `EMP${String(emp.id).padStart(4, '0')}`],
      ['PAN',           emp.pan_number || '—'],
      ['Working Days',  String(slip.working_days || 26)],
    ];
    left.forEach(([k, v], i) => {
      doc.text(`${k}: `, 50, detailY + i * 18, { continued: true }).fillColor('#555').text(v).fillColor('#111');
    });
    right.forEach(([k, v], i) => {
      doc.text(`${k}: `, 310, detailY + i * 18, { continued: true }).fillColor('#555').text(v).fillColor('#111');
    });
    doc.y = detailY + left.length * 18 + 12;

    // ── Earnings & Deductions Table ───────────────────────────────────────────
    const tableTop = doc.y;
    const col = { e_label: 50, e_amt: 230, d_label: 295, d_amt: 475 };

    // Table header
    doc.rect(50, tableTop, 495, 18).fill('#7c3aed');
    doc.fontSize(10).fillColor('#fff');
    doc.text('Earnings',   col.e_label, tableTop + 4, { width: 170 });
    doc.text('Amount',     col.e_amt,   tableTop + 4, { width: 60, align: 'right' });
    doc.text('Deductions', col.d_label, tableTop + 4, { width: 170 });
    doc.text('Amount',     col.d_amt,   tableTop + 4, { width: 60, align: 'right' });

    const earnings = [
      ['Basic Salary',          slip.basic],
      ['HRA',                   slip.hra],
      ['Conveyance Allowance',  slip.conveyance_allowance || 1600],
      ['Medical Allowance',     slip.medical_allowance   || 1250],
      ['Special Allowance',     slip.special_allowance],
    ].filter(([, v]) => v > 0);
    if ((slip.bonus        || 0) > 0) earnings.push(['Bonus',        slip.bonus]);
    if ((slip.overtime_pay || 0) > 0) earnings.push(['Overtime Pay', slip.overtime_pay]);

    const deductions = [
      ['Provident Fund (Emp)', slip.employee_pf],
      ['Provident Fund (Emr)', slip.employer_pf],
    ].filter(([, v]) => v > 0);
    if ((slip.employee_esi    || 0) > 0) deductions.push(['ESI (Employee)',  slip.employee_esi]);
    if ((slip.employer_esi    || 0) > 0) deductions.push(['ESI (Employer)',  slip.employer_esi]);
    if ((slip.professional_tax|| 0) > 0) deductions.push(['Professional Tax',slip.professional_tax]);
    if ((slip.tds             || 0) > 0) deductions.push(['TDS (Income Tax)',slip.tds]);
    if ((slip.loan_deduction  || 0) > 0) deductions.push(['Loan Deduction',  slip.loan_deduction]);
    if ((slip.advance_deduction||0) > 0) deductions.push(['Advance Recovery', slip.advance_deduction]);

    const rows2 = Math.max(earnings.length, deductions.length);
    for (let i = 0; i < rows2; i++) {
      const rowY = tableTop + 18 + i * 18;
      if (i % 2 === 1) doc.rect(50, rowY, 495, 18).fill('#f5f3ff');
      doc.fillColor('#111').fontSize(10);
      if (earnings[i]) {
        doc.text(earnings[i][0],   col.e_label, rowY + 4, { width: 170 });
        doc.text(fmt(earnings[i][1]), col.e_amt, rowY + 4, { width: 60, align: 'right' });
      }
      if (deductions[i]) {
        doc.text(deductions[i][0],   col.d_label, rowY + 4, { width: 170 });
        doc.text(fmt(deductions[i][1]), col.d_amt, rowY + 4, { width: 60, align: 'right' });
      }
    }

    // Totals row
    const totY = tableTop + 18 + rows2 * 18;
    doc.rect(50, totY, 495, 20).fill('#e9d5ff');
    doc.fillColor('#5b21b6').fontSize(10).font('Helvetica-Bold');
    doc.text('Gross Pay', col.e_label, totY + 5, { width: 170 });
    doc.text(fmt(slip.gross), col.e_amt, totY + 5, { width: 60, align: 'right' });
    doc.text('Total Deductions', col.d_label, totY + 5, { width: 170 });
    doc.text(fmt(slip.total_deductions), col.d_amt, totY + 5, { width: 60, align: 'right' });

    // Net pay
    const netY = totY + 24;
    doc.rect(50, netY, 495, 24).fill('#166534');
    doc.fillColor('#fff').fontSize(12).font('Helvetica-Bold');
    doc.text('Net Pay', col.e_label, netY + 6, { width: 250 });
    doc.text(fmt(slip.net_pay), 310, netY + 6, { width: 235, align: 'right' });

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(9).fillColor('#9ca3af');
    doc.text(
      'This is a computer-generated document and does not require a signature.',
      50, netY + 36, { align: 'center', width: 495 }
    );

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

export const bulkGenerateSlips = async (req, res) => {
  try {
    const { month, year } = req.body;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const cid = req.scope?.company_id ?? null;
    const cidFilter = cid != null ? `AND company_id = $1` : '';
    const cidParams = cid != null ? [cid] : [];
    const { rows: emps } = await pool.query(`
      SELECT id, office_id, first_name, last_name, name, department, designation,
             basic_salary, email, work_email,
             EXTRACT(YEAR FROM AGE(NOW(), joining_date)) AS years_of_service
      FROM employees
      WHERE LOWER(status) IN ('active','probation') AND deleted_at IS NULL ${cidFilter}
      ORDER BY first_name
    `, cidParams);
    if (!emps.length) return res.json({ processed: 0, total: 0, results: [] });
    const results = emps.map(emp => {
      try {
        const slip = computePayroll(emp, { month: m, year: y });
        return {
          employee_id: emp.id,
          name: emp.name || `${emp.first_name} ${emp.last_name}`,
          department: emp.department,
          net_pay: slip.net_pay,
          gross: slip.gross,
          status: 'ok',
        };
      } catch (e) {
        return {
          employee_id: emp.id,
          name: emp.name || `${emp.first_name} ${emp.last_name}`,
          department: emp.department,
          net_pay: 0, gross: 0,
          status: 'error', error: e.message,
        };
      }
    });
    const processed = results.filter(r => r.status === 'ok').length;
    res.json({ processed, total: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /payroll/save-slip — persist a single computed payslip (with overrides) to payroll_runs
export const saveSlip = async (req, res) => {
  try {
    const { employee_id, month, year, lop_days = 0, bonus = 0, loan_deduction = 0, advance_deduction = 0 } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';
    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter} AND LOWER(status) IN ('active','probation')`,
      cid != null ? [employee_id, cid] : [employee_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found or not active' });
    const emp = rows[0];
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const lopF  = parseFloat(lop_days) || 0;
    const bonF  = parseFloat(bonus) || 0;
    const loanF = parseFloat(loan_deduction) || 0;
    const advF  = parseFloat(advance_deduction) || 0;

    const slip = computePayroll(emp, { month: m, year: y, lop_days: lopF, bonus: bonF });
    const periodLabel = `${getMonthName(m)} ${y}`;
    const periodStart = new Date(y, m - 1, 1).toISOString().split('T')[0];
    const periodEnd   = new Date(y, m, 0).toISOString().split('T')[0];
    const netPay      = slip.net_pay - loanF - advF;
    const totalDed    = slip.total_deductions + loanF + advF;

    await pool.query(
      `INSERT INTO payroll_runs
         (period_label, period_start, period_end, status,
          employee_id, month, year,
          gross, net_pay, total_deductions,
          employee_pf, employer_pf, employee_esi, employer_esi,
          tds, professional_tax, ctc_monthly,
          tax_regime, annual_taxable_income, annual_tax,
          basic, hra, conveyance_allowance, medical_allowance, special_allowance,
          lop_days, bonus, loan_deduction, advance_deduction,
          generated_at)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
       ON CONFLICT (employee_id, month, year)
       WHERE employee_id IS NOT NULL AND month IS NOT NULL AND year IS NOT NULL
       DO UPDATE SET
         period_label=EXCLUDED.period_label, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
         gross=EXCLUDED.gross, net_pay=EXCLUDED.net_pay, total_deductions=EXCLUDED.total_deductions,
         employee_pf=EXCLUDED.employee_pf, employer_pf=EXCLUDED.employer_pf,
         employee_esi=EXCLUDED.employee_esi, employer_esi=EXCLUDED.employer_esi,
         tds=EXCLUDED.tds, professional_tax=EXCLUDED.professional_tax, ctc_monthly=EXCLUDED.ctc_monthly,
         tax_regime=EXCLUDED.tax_regime, annual_taxable_income=EXCLUDED.annual_taxable_income, annual_tax=EXCLUDED.annual_tax,
         basic=EXCLUDED.basic, hra=EXCLUDED.hra,
         conveyance_allowance=EXCLUDED.conveyance_allowance, medical_allowance=EXCLUDED.medical_allowance,
         special_allowance=EXCLUDED.special_allowance,
         lop_days=EXCLUDED.lop_days, bonus=EXCLUDED.bonus,
         loan_deduction=EXCLUDED.loan_deduction, advance_deduction=EXCLUDED.advance_deduction,
         generated_at=NOW()
       WHERE payroll_runs.status != 'paid'`,
      [
        periodLabel, periodStart, periodEnd,
        emp.id, m, y,
        slip.gross, netPay, totalDed,
        slip.employee_pf, slip.employer_pf, slip.employee_esi, slip.employer_esi,
        slip.tds, slip.professional_tax, slip.ctc_monthly,
        slip.tax_regime, slip.annual_taxable_income, slip.annual_tax,
        slip.basic, slip.hra, slip.conveyance_allowance, slip.medical_allowance, slip.special_allowance,
        lopF, bonF, loanF, advF,
      ]
    );

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'payroll',
      recordId: emp.id,
      recordType: 'payslip',
      action: 'create',
      newData: { employee_id: emp.id, month: m, year: y, net_pay: netPay, period_label: periodLabel },
      req,
    });

    res.json({ success: true, message: `Payslip for ${periodLabel} saved`, period_label: periodLabel, net_pay: netPay });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /payroll/history/:employeeId — last 12 months of payslips for an employee
export const getPayrollHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const cid = req.scope?.company_id ?? null;
    const empCidFilter = cid != null ? `AND company_id = $2` : '';
    const { rows: empRows } = await pool.query(
      `SELECT * FROM employees WHERE id = $1 ${empCidFilter} LIMIT 1`,
      cid != null ? [employeeId, cid] : [employeeId]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = empRows[0];

    const now  = new Date();
    const periods = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return { month: d.getMonth() + 1, year: d.getFullYear() };
    });
    const years = [...new Set(periods.map(p => p.year))];

    const { rows: runs } = await pool.query(
      `SELECT month, year, gross, net_pay, total_deductions,
              basic, hra, employee_pf, tds, professional_tax,
              lop_days, bonus, loan_deduction, advance_deduction,
              status, period_label, generated_at
       FROM payroll_runs
       WHERE employee_id = $1 AND year = ANY($2)
       ORDER BY year DESC, month DESC`,
      [emp.id, years]
    ).catch(() => ({ rows: [] }));

    const runMap = Object.fromEntries(runs.map(r => [`${r.year}-${r.month}`, r]));

    const history = periods.map(({ month, year }) => {
      const run = runMap[`${year}-${month}`];
      const label = `${getMonthName(month)} ${year}`;
      if (run) {
        return {
          month, year, period_label: run.period_label || label,
          gross:            Math.round(parseFloat(run.gross    || 0)),
          net_pay:          Math.round(parseFloat(run.net_pay  || 0)),
          total_deductions: Math.round(parseFloat(run.total_deductions || 0)),
          lop_days:         parseFloat(run.lop_days || 0),
          bonus:            parseFloat(run.bonus || 0),
          loan_deduction:   parseFloat(run.loan_deduction || 0),
          advance_deduction: parseFloat(run.advance_deduction || 0),
          status:           run.status || 'pending',
          generated_at:     run.generated_at,
          saved:            true,
        };
      }
      try {
        const slip = computePayroll(emp, { month, year });
        return {
          month, year, period_label: label,
          gross:    Math.round(slip.gross),
          net_pay:  Math.round(slip.net_pay),
          total_deductions: Math.round(slip.total_deductions),
          lop_days: 0, bonus: 0, loan_deduction: 0, advance_deduction: 0,
          status: 'not_generated',
          generated_at: null,
          saved: false,
        };
      } catch {
        return { month, year, period_label: label, gross: 0, net_pay: 0, total_deductions: 0, status: 'error', saved: false };
      }
    });

    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
