/**
 * payrollEngine.js — Indian payroll computation engine
 * Handles: Basic, HRA, Allowances, PF, ESI, PT, TDS, Gratuity
 * Compliant with Indian statutory requirements FY 2025-26
 */

// ── Tax Slabs FY 2025-26 (New Regime - Default) ──────────────────────────────
const NEW_REGIME_SLABS = [
  { min: 0,       max: 400000,  rate: 0.00 },
  { min: 400000,  max: 800000,  rate: 0.05 },
  { min: 800000,  max: 1200000, rate: 0.10 },
  { min: 1200000, max: 1600000, rate: 0.15 },
  { min: 1600000, max: 2000000, rate: 0.20 },
  { min: 2000000, max: 2400000, rate: 0.25 },
  { min: 2400000, max: Infinity,rate: 0.30 },
];

const OLD_REGIME_SLABS = [
  { min: 0,       max: 250000,  rate: 0.00 },
  { min: 250000,  max: 500000,  rate: 0.05 },
  { min: 500000,  max: 1000000, rate: 0.20 },
  { min: 1000000, max: Infinity,rate: 0.30 },
];

// Labour Welfare Fund rates by state
// Each entry: { employee, employer, months } where months = [] means every month
const LWF_RATES = {
  MH: { employee: 6,  employer: 12, months: [6, 12] },  // June and December only
  KA: { employee: 20, employer: 40, months: [] },         // every month
  TN: { employee: 10, employer: 20, months: [3, 9] },     // March and September only
};

// Professional Tax slabs by state (monthly gross salary → PT per month)
const PT_SLABS = {
  MH: [ // Maharashtra
    { min: 0,     max: 7500,     pt: 0   },
    { min: 7501,  max: 10000,    pt: 175 },
    { min: 10001, max: Infinity, pt: 200 },
  ],
  KA: [ // Karnataka
    { min: 0,     max: 14999,    pt: 0   },
    { min: 15000, max: Infinity, pt: 200 },
  ],
  TN: [ // Tamil Nadu
    { min: 0,     max: 20999,    pt: 0   },
    { min: 21000, max: Infinity, pt: 208 }, // ₹2,500/yr split across 6 months
  ],
  TS: [ // Telangana
    { min: 0,     max: 14999,    pt: 0   },
    { min: 15000, max: Infinity, pt: 200 },
  ],
  AP: [ // Andhra Pradesh
    { min: 0,     max: 14999,    pt: 0   },
    { min: 15000, max: Infinity, pt: 200 },
  ],
  KL: [ // Kerala
    { min: 0,     max: 1999,     pt: 0   },
    { min: 2000,  max: 2999,     pt: 20  },
    { min: 3000,  max: 4999,     pt: 30  },
    { min: 5000,  max: 7499,     pt: 50  },
    { min: 7500,  max: 9999,     pt: 75  },
    { min: 10000, max: 12499,    pt: 100 },
    { min: 12500, max: 16666,    pt: 125 },
    { min: 16667, max: Infinity, pt: 208 },
  ],
  GJ: [ // Gujarat
    { min: 0,     max: 5999,     pt: 0   },
    { min: 6000,  max: 8999,     pt: 80  },
    { min: 9000,  max: 11999,    pt: 150 },
    { min: 12000, max: Infinity, pt: 200 },
  ],
  WB: [ // West Bengal
    { min: 0,     max: 9999,     pt: 0   },
    { min: 10000, max: 14999,    pt: 110 },
    { min: 15000, max: 24999,    pt: 130 },
    { min: 25000, max: 39999,    pt: 150 },
    { min: 40000, max: Infinity, pt: 200 },
  ],
  // HR (Haryana) abolished PT in 2010 — returns null → 0
};

// Normalize state code: accept full names and abbreviations.
// Returns null for states that do not levy PT (Delhi, UP, Rajasthan, etc.)
function normalizeState(state) {
  if (!state) return null;
  const s = String(state).trim().toUpperCase();
  const MAP = {
    'MAHARASHTRA': 'MH', 'MH': 'MH',
    'KARNATAKA': 'KA', 'KA': 'KA',
    'TAMIL NADU': 'TN', 'TAMILNADU': 'TN', 'TN': 'TN',
    'TELANGANA': 'TS', 'TS': 'TS',
    'ANDHRA PRADESH': 'AP', 'AP': 'AP',
    'KERALA': 'KL', 'KL': 'KL',
    'GUJARAT': 'GJ', 'GJ': 'GJ',
    'WEST BENGAL': 'WB', 'WB': 'WB',
  };
  return MAP[s] ?? null;
}

export function computeIncomeTax(annualTaxableIncome, regime = 'new') {
  const slabs = regime === 'old' ? OLD_REGIME_SLABS : NEW_REGIME_SLABS;
  let tax = 0;
  for (const slab of slabs) {
    if (annualTaxableIncome <= slab.min) break;
    const taxable = Math.min(annualTaxableIncome, slab.max) - slab.min;
    tax += taxable * slab.rate;
  }
  // Rebate u/s 87A FY 2025-26: if taxable income ≤ 12L (new) or 5L (old), tax = 0
  const rebateLimit = regime === 'new' ? 1200000 : 500000;
  if (annualTaxableIncome <= rebateLimit) tax = 0;
  // Health & Education Cess 4%
  tax = tax + tax * 0.04;
  return Math.round(tax);
}

export function computePT(monthlySalary, state) {
  const code = normalizeState(state);
  if (!code || !PT_SLABS[code]) return 0;
  const slabs = PT_SLABS[code];
  for (const slab of slabs) {
    if (monthlySalary >= slab.min && monthlySalary <= slab.max) return slab.pt;
  }
  return slabs[slabs.length - 1].pt;
}

// Returns { employee, employer } LWF amounts for given state + payroll month.
// Returns zeros for states without LWF or months when LWF is not deducted.
export function computeLWF(state, month) {
  const code = normalizeState(state);
  if (!code || !LWF_RATES[code]) return { lwf_employee: 0, lwf_employer: 0 };
  const rate = LWF_RATES[code];
  if (rate.months.length > 0 && !rate.months.includes(month)) {
    return { lwf_employee: 0, lwf_employer: 0 };
  }
  return { lwf_employee: rate.employee, lwf_employer: rate.employer };
}

/**
 * Compute earning amounts from salary structure components.
 * Used by computePayroll when an employee has a structure assigned.
 * Basic component uses the actual basic salary; CTC is derived from it when
 * the Basic component is percentage_of_ctc (e.g. 40% → CTC = basic / 0.4).
 */
function computeEarningsFromComponents(components, effectiveBasic, basicMonthly, lop_days, working_days) {
  const basicComp  = components.find(c => c.name === 'Basic' && c.type === 'earning');
  const basicRatio = basicComp?.calculation_type === 'percentage_of_ctc'
    ? (parseFloat(basicComp.value) || 40) / 100 : null;
  const lopFactor     = working_days > 0 ? Math.max(0, 1 - lop_days / working_days) : 1;
  const ctcEffective  = basicRatio > 0 ? (basicMonthly / basicRatio) * lopFactor : null;

  const lines = [];
  let runningGross = 0;

  for (const c of components) {
    if (c.type !== 'earning') continue;
    let amount = 0;
    if (c.name === 'Basic') {
      amount = effectiveBasic;
    } else if (c.calculation_type === 'fixed') {
      amount = parseFloat(c.value) || 0;
    } else if (c.calculation_type === 'percentage_of_basic') {
      amount = Math.round(effectiveBasic * (parseFloat(c.value) || 0) / 100);
    } else if (c.calculation_type === 'percentage_of_ctc') {
      amount = ctcEffective ? Math.round(ctcEffective * (parseFloat(c.value) || 0) / 100) : 0;
    } else if (c.calculation_type === 'percentage_of_gross') {
      amount = Math.round(runningGross * (parseFloat(c.value) || 0) / 100);
    }
    if (c.calculation_type !== 'balancing') runningGross += amount;
    lines.push({ name: c.name, calculation_type: c.calculation_type, amount });
  }

  // Second pass: balancing components (e.g. Special Allowance = CTC − other earnings)
  for (const l of lines) {
    if (l.calculation_type === 'balancing') {
      l.amount = ctcEffective ? Math.max(0, ctcEffective - runningGross) : 0;
      runningGross += l.amount;
    }
  }

  return { lines, gross: runningGross };
}

/**
 * Main computation function
 * @param {Object} emp    - employee record from DB (must have basic_salary)
 * @param {Object} config - payroll config (month, year, lop_days, structureComponents, settings, etc.)
 * @returns {Object} complete payroll computation
 */
export function computePayroll(emp, config = {}) {
  const {
    month = new Date().getMonth() + 1,
    year = new Date().getFullYear(),
    lop_days = 0,
    overtime_hours = 0,
    ot_multiplier  = 1.5,
    bonus = 0,
    night_shift_days = 0,
    night_shift_rate = 200,   // ₹200 per night shift day (overridable via company_settings)
    // Old regime IT declarations (annual amounts, sourced from it_declarations table)
    deduction_80d        = 0, // Health insurance premium (u/s 80D), max ₹25,000 (₹50,000 for senior)
    deduction_nps_80ccd  = 0, // NPS additional contribution (u/s 80CCD(1B)), max ₹50,000
    lta_claimed          = 0, // Leave Travel Allowance claimed
    state: configState,
    // Settings from company_settings table (all have safe defaults matching DB defaults)
    working_days    = 26,
    regime          = 'new',
    pf_enabled      = true,
    esi_enabled     = true,
    professional_tax: pt_enabled = true,
    tds_auto_calculate = true,
    enable_hra              = true,
    enable_conveyance       = true,
    enable_medical_allowance = true,
    enable_special_allowance = true,
    round_net_pay   = 1,
    structureComponents,    // optional: salary_structures.components JSONB array
  } = config;

  // Default work state: fall back to the company's home state (Karnataka) rather
  // than Maharashtra so Professional Tax is computed on the correct state slab
  // when an employee record has no state set. Override via config.state /
  // emp.state / emp.work_state or the PAYROLL_DEFAULT_STATE env var.
  const state = configState || emp.state || emp.work_state || process.env.PAYROLL_DEFAULT_STATE || 'KA';

  // ── Basic Salary ──────────────────────────────────────────────────────────
  const basicMonthly = parseFloat(emp.basic_salary || emp.ctc_monthly * 0.4 || 50000);

  const lopDeduction = lop_days > 0
    ? Math.round((basicMonthly / working_days) * lop_days)
    : 0;

  const effectiveBasic = basicMonthly - lopDeduction;

  // ── Earnings ─────────────────────────────────────────────────────────────
  let hra, conveyanceAllowance, medicalAllowance, specialAllowance, grossEarnings;

  if (structureComponents?.length) {
    // Component-driven: use the employee's assigned salary structure
    const { lines, gross } = computeEarningsFromComponents(
      structureComponents, effectiveBasic, basicMonthly, lop_days, working_days
    );
    const get = name => lines.find(l => l.name === name)?.amount ?? 0;
    hra                 = enable_hra              ? get('HRA')                                              : 0;
    conveyanceAllowance = enable_conveyance       ? (get('Conveyance') || get('Conveyance Allowance') || 0) : 0;
    medicalAllowance    = enable_medical_allowance? (get('Medical')    || get('Medical Allowance')    || 0) : 0;
    specialAllowance    = enable_special_allowance? get('Special Allowance')                               : 0;
    grossEarnings       = effectiveBasic + hra + conveyanceAllowance + medicalAllowance + specialAllowance;
  } else {
    // Legacy hardcoded fallback when no structure is assigned
    hra                 = enable_hra              ? Math.round(effectiveBasic * 0.40) : 0;
    conveyanceAllowance = enable_conveyance       ? 1600 : 0;
    medicalAllowance    = enable_medical_allowance? 1250 : 0;
    specialAllowance    = enable_special_allowance? Math.round(effectiveBasic * 0.15) : 0;
    grossEarnings       = effectiveBasic + hra + conveyanceAllowance + medicalAllowance + specialAllowance;
  }

  const overtimePay        = Math.round((basicMonthly / (working_days * 8)) * overtime_hours * ot_multiplier);
  const nightShiftAllowance = Math.round((parseFloat(night_shift_days) || 0) * (parseFloat(night_shift_rate) || 200));
  grossEarnings += overtimePay + nightShiftAllowance + (parseFloat(bonus) || 0);

  // ── Deductions (each conditional on its statutory toggle) ─────────────────

  // PF: employee 12%; employer split into EPS 8.33% + EPF 3.67% (both capped at ₹15,000 wage)
  const pfBasic      = Math.min(effectiveBasic, 15000);
  const employeePF   = pf_enabled ? Math.round(pfBasic * 0.12)         : 0;
  const eps          = pf_enabled ? Math.round(pfBasic * 8.33 / 100)   : 0; // Employees' Pension Scheme
  const epfEmployer  = pf_enabled ? Math.round(pfBasic * 0.12) - eps   : 0; // 3.67% to EPF account
  const employerPF   = eps + epfEmployer;                                    // total 12%

  // ESI: employee 0.75%, employer 3.25% (only if gross ≤ ₹21,000)
  const esiApplicable = esi_enabled && grossEarnings <= 21000;
  const employeeESI   = esiApplicable ? Math.round(grossEarnings * 0.0075) : 0;
  const employerESI   = esiApplicable ? Math.round(grossEarnings * 0.0325) : 0;

  // Professional Tax (state-based slab)
  const professionalTax = pt_enabled ? computePT(grossEarnings, state) : 0;

  // LWF (state-specific, only in applicable months)
  const { lwf_employee, lwf_employer } = computeLWF(state, month);

  // TDS — annualise and compute monthly
  const annualGross = grossEarnings * 12;
  const standardDeduction = regime === 'new' ? 75000 : 50000;

  let additionalDeductions = 0;
  if (regime === 'old') {
    const pf80C      = Math.min(effectiveBasic * 12 * 0.12, 150000);       // PF u/s 80C (max ₹1.5L)
    const hraExempt  = Math.min(hra * 12, annualGross * 0.10);             // HRA exemption (simplified)
    const d80D       = Math.min(parseFloat(deduction_80d)       || 0, 25000);  // 80D health insurance
    const dNPS       = Math.min(parseFloat(deduction_nps_80ccd) || 0, 50000);  // 80CCD(1B) NPS
    const ltaExempt  = Math.min(parseFloat(lta_claimed)         || 0, hra * 2); // LTA (simplified cap)
    additionalDeductions = pf80C + hraExempt + d80D + dNPS + ltaExempt;
  }

  const annualTaxableIncome = Math.max(0, annualGross - standardDeduction - additionalDeductions);
  const annualTax    = tds_auto_calculate ? computeIncomeTax(annualTaxableIncome, regime) : 0;
  const monthlyTDS   = tds_auto_calculate ? Math.round(annualTax / 12) : 0;

  // ── Net Pay ───────────────────────────────────────────────────────────────
  const totalDeductions = employeePF + employeeESI + professionalTax + monthlyTDS + lwf_employee;
  const rawNetPay = grossEarnings - totalDeductions;

  // Apply rounding to nearest ₹N (1 = no rounding beyond integer)
  const roundTo = Math.max(1, parseInt(round_net_pay) || 1);
  const netPay  = Math.round(rawNetPay / roundTo) * roundTo;

  // ── Gratuity (informational — not deducted from salary) ───────────────────
  // Gratuity = (Basic * 15 / 26) per year of service
  const yearsOfService = parseFloat(emp.years_of_service || 0);
  const gratuity = yearsOfService >= 5
    ? Math.round((effectiveBasic * 15 / 26) * yearsOfService)
    : 0;

  // ── CTC Breakup ───────────────────────────────────────────────────────────
  const ctcMonthly = grossEarnings + employerPF + employerESI;
  const ctcAnnual = ctcMonthly * 12;

  return {
    // Employee info
    employee_id: emp.id || emp.employee_id,
    employee_code: emp.office_id || emp.employee_code,
    name: emp.name || `${emp.first_name} ${emp.last_name}`,
    department: emp.department,
    designation: emp.designation || emp.role,
    month, year,
    payroll_period: `${getMonthName(month)} ${year}`,
    working_days,
    lop_days,

    // Earnings
    basic: Math.round(effectiveBasic),
    hra: Math.round(hra),
    conveyance_allowance: conveyanceAllowance,
    medical_allowance: medicalAllowance,
    special_allowance: Math.round(specialAllowance),
    overtime_pay: Math.round(overtimePay),
    night_shift_allowance: nightShiftAllowance,
    bonus: Math.round(bonus),
    gross: Math.round(grossEarnings),

    // Deductions
    employee_pf: employeePF,
    employer_pf: employerPF,
    eps,
    epf_employer: epfEmployer,
    employee_esi: employeeESI,
    employer_esi: employerESI,
    professional_tax: professionalTax,
    lwf_employee,
    lwf_employer,
    tds: monthlyTDS,
    total_deductions: totalDeductions,

    // Net
    net_pay: Math.round(netPay),

    // Compliance
    annual_taxable_income: Math.round(annualTaxableIncome),
    annual_tax: annualTax,
    tax_regime: regime,
    esi_applicable: esiApplicable,
    pf_applicable: true,

    // CTC
    ctc_monthly: Math.round(ctcMonthly),
    ctc_annual: Math.round(ctcAnnual),
    gratuity_provision: Math.round(gratuity),

    // Status
    status: 'pending',
    generated_at: new Date().toISOString(),
  };
}

export function getMonthName(month) {
  return ['', 'January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'][month];
}

export function computeBulkPayroll(employees, config = {}) {
  return employees.map(emp => {
    try {
      return { ...computePayroll(emp, config), error: null };
    } catch (err) {
      return { employee_id: emp.id, error: err.message };
    }
  });
}

// Indian financial year runs Apr 1 – Mar 31. For a given date, FY label is
// [Y, Y+1] when month >= April, else [Y-1, Y]. Prefer deriving from the payroll
// records themselves (their month/year) over the wall-clock date.
export function indianFinancialYear(month, year) {
  const m = parseInt(month), y = parseInt(year);
  if (!m || !y) {
    const d = new Date();
    return indianFinancialYear(d.getMonth() + 1, d.getFullYear());
  }
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

export function generateForm16Summary(emp, payrollRecords) {
  const annualGross = payrollRecords.reduce((s, r) => s + r.gross, 0);
  const annualTDS = payrollRecords.reduce((s, r) => s + r.tds, 0);
  const annualPF = payrollRecords.reduce((s, r) => s + r.employee_pf, 0);
  const lastRecord = payrollRecords[payrollRecords.length - 1];

  return {
    employee_name: lastRecord?.name,
    employee_pan: emp.pan_number || 'PENDING',
    employee_code: emp.office_id,
    financial_year: indianFinancialYear(lastRecord?.month, lastRecord?.year),
    gross_salary: annualGross,
    standard_deduction: lastRecord?.tax_regime === 'new' ? 75000 : 50000,
    pf_deduction: annualPF,
    taxable_income: lastRecord?.annual_taxable_income || 0,
    tax_payable: lastRecord?.annual_tax || 0,
    tds_deducted: annualTDS,
    tax_regime: lastRecord?.tax_regime || 'new',
  };
}