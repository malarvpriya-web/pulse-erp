/**
 * ctcService.js — THE contractual CTC calculation (PAYROLL_DATA_FLOW_AUDIT.md
 * Part 4). Pure functions; every screen and API that shows or stores a CTC
 * calls these. Nothing else derives a CTC.
 *
 * Approved direction (2026-10-21, in session): CTC = annual gross + employer PF
 * + employer ESI (when covered) + employer LWF + gratuity accrual on Code wages
 * from joining; contract basis = statutory rules in force on the revision's
 * effective date, held for 12 months. These are encoded as the built-in
 * `ctc.definition` policy below with status 'approval_required': a company can
 * PREVIEW with it, but nothing is finalised until the company records its own
 * policy version with an approval reference (POST /payroll/statutory-rules,
 * key 'ctc.definition'). Open choices (rounding residual, maker-checker) are
 * explicit fields of that policy — never silently assumed.
 *
 * Contract figures come from the payroll engine itself (computePayroll on a
 * full, ordinary month), so a contract and a payroll run cannot disagree about
 * gross or employer PF/ESI for the same inputs.
 */
import { computePayroll, computeLWF, periodEndDate } from './payrollEngine.js';
import { resolveRules } from './statutoryRules.js';

export const POLICY_KEY = 'ctc.definition';

export const BUILT_IN_POLICY = [{
  effective_from: '2025-04-01',
  status: 'approval_required',
  source: 'Direction agreed in session 2026-10-21 (A2 + ESI, gratuity on Code wages, effective-date basis); Finance confirmation pending',
  value: {
    version: 'A2-ESI-2026-10-21',
    include: { employer_pf: true, employer_esi: true, employer_lwf: true, gratuity: true },
    gratuity: { base: 'code_wages', from: 'joining', days_per_year: 15, divisor: 26 },
    rules_basis: 'effective_date',
    rounding: 'component_rupee',
    // Q-C4 unresolved: the gap between a requested CTC and the nearest whole-
    // rupee Basic is RECORDED, not absorbed into any component.
    residual: 'report',
    // Q-C8 unresolved: the restrictive option until the company records its own.
    maker_checker: true,
  },
}];

// Statutory rules a contract CTC depends on. All must be verified (or recorded
// by the company) for a CTC to be finalised.
export const CTC_RULE_KEYS = ['pf.employee_rate', 'pf.employer_rate', 'pf.eps_rate', 'pf.wage_ceiling',
  'pf.wage_floor_pct', 'pf.wage_floor_basis', 'pf.eps_age_limit', 'esi.wage_threshold', 'esi.wage_basis',
  'esi.employee_rate', 'esi.employer_rate', 'lwf.rates'];

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** Company policy in force on a date: latest company/global DB version, else built-in. */
export function resolvePolicy(onDate, dbVersions = []) {
  const date = iso(onDate);
  const rows = dbVersions.filter(r => r.rule_key === POLICY_KEY && iso(r.effective_from) <= date)
    .sort((a, b) => (iso(a.effective_from) === iso(b.effective_from)
      ? (a.company_id == null ? 1 : -1)
      : (iso(a.effective_from) < iso(b.effective_from) ? 1 : -1)));
  if (rows[0]) {
    return { value: rows[0].value, origin: rows[0].company_id == null ? 'global' : 'company',
      status: 'approved', effective_from: iso(rows[0].effective_from), source: rows[0].source_reference };
  }
  const b = BUILT_IN_POLICY.filter(v => v.effective_from <= date).pop();
  return { value: b.value, origin: 'built-in', status: b.status, effective_from: b.effective_from, source: b.source };
}

/**
 * Contract breakdown for a monthly Basic.
 * @param emp       { state, work_state, dob } — the employee (or the company's
 *                  state for a candidate); joining/exit are ignored (contract,
 *                  not a payroll month)
 * @param settings  normalised payroll settings (pf_enabled, esi_enabled,
 *                  pf_restrict_to_ceiling, component toggles, …)
 * @param asOf      'YYYY-MM-DD' — the revision's effective date
 */
export function contractBreakdown({ basicMonthly, structureComponents, emp = {}, settings = {}, rules, policy, asOf }) {
  const date = iso(asOf);
  const month = Number(date.slice(5, 7)), year = Number(date.slice(0, 4));
  const r = rules || resolveRules(periodEndDate(month, year)).values;
  const p = policy || BUILT_IN_POLICY[0].value;
  const slip = computePayroll(
    { id: emp.id ?? 0, office_id: emp.office_id ?? null, basic_salary: basicMonthly, state: emp.state, work_state: emp.work_state, dob: emp.dob, joining_date: null, exit_date: null },
    { ...settings, month, year, rules: r, structureComponents,
      lop_days: 0, overtime_hours: 0, night_shift_days: 0, bonus: 0, arrears: null, recoveries: [], ytd: null, tds_auto_calculate: false },
  );
  const state = emp.state || emp.work_state;
  let lwfEmployerAnnual = 0, lwfEmployeeAnnual = 0;
  for (let m = 1; m <= 12; m++) {
    const l = computeLWF(state, m, r['lwf.rates']);
    lwfEmployerAnnual += l.lwf_employer; lwfEmployeeAnnual += l.lwf_employee;
  }
  const g = p.gratuity || {};
  const gratuityBase = g.base === 'basic' ? slip.basic : slip.pf_wage;   // pf_wage = Code wages (uncapped)
  const gratuityAnnual = Math.round(gratuityBase * (g.days_per_year ?? 15) / (g.divisor ?? 26));

  const inc = p.include || {};
  const annual = {
    gross: slip.gross * 12,
    employer_pf: inc.employer_pf ? slip.employer_contributions.pf_total * 12 : 0,
    employer_esi: inc.employer_esi ? slip.employer_contributions.esi * 12 : 0,
    employer_lwf: inc.employer_lwf ? lwfEmployerAnnual : 0,
    gratuity: inc.gratuity ? gratuityAnnual : 0,
  };
  annual.ctc = annual.gross + annual.employer_pf + annual.employer_esi + annual.employer_lwf + annual.gratuity;

  return {
    as_of: date,
    policy_version: p.version,
    monthly: {
      components: slip.earning_lines.map(l => ({ name: l.name, amount: l.full_month })),
      gross: slip.gross,
      basic: slip.basic,
      code_wages: slip.pf_wage,
      employer: { pf: slip.employer_contributions.pf_total, eps: slip.eps, epf: slip.epf_employer, esi: slip.employer_contributions.esi },
      employee: { pf: slip.employee_pf, esi: slip.employee_esi, pt: slip.professional_tax },
      take_home_before_tds: slip.gross - slip.employee_pf - slip.employee_esi - slip.professional_tax,
    },
    annual,
    annual_lwf_employee: lwfEmployeeAnnual,
    gratuity_base_monthly: gratuityBase,
    esi_covered: slip.esi_applicable,
    // display only — never stored or paid as a salary
    monthly_ctc_equivalent: Math.round(annual.ctc / 12),
  };
}

/**
 * Largest whole-rupee monthly Basic whose contract CTC does not exceed the
 * requested annual CTC. CTC rises with Basic EXCEPT at the ESI coverage limit,
 * where employer ESI stops and CTC drops — so the covered and uncovered ranges
 * are searched separately and the larger qualifying Basic wins.
 */
export function solveFromAnnualCtc(targetAnnualCtc, ctx) {
  const target = Number(targetAnnualCtc);
  if (!(target > 0)) throw Object.assign(new Error('Annual CTC must be greater than zero'), { status: 400 });
  const at = (b) => contractBreakdown({ ...ctx, basicMonthly: b });
  const hi = Math.max(1, Math.ceil(target / 12));
  // last Basic still ESI-covered (coverage is monotone: true … true false …)
  let lo = 1, top = hi, lastCovered = 0;
  if (at(1).esi_covered) {
    while (lo <= top) { const mid = Math.floor((lo + top) / 2); if (at(mid).esi_covered) { lastCovered = mid; lo = mid + 1; } else top = mid - 1; }
  }
  const maxWithin = (a, b) => {           // CTC is non-decreasing inside [a, b]
    let best = 0;
    while (a <= b) { const mid = Math.floor((a + b) / 2); if (at(mid).annual.ctc <= target) { best = mid; a = mid + 1; } else b = mid - 1; }
    return best;
  };
  const inUncovered = maxWithin(lastCovered + 1, hi);
  const inCovered = lastCovered ? maxWithin(1, lastCovered) : 0;
  const basic = Math.max(inUncovered, inCovered);
  if (!basic) throw Object.assign(new Error('Annual CTC is too small for this salary structure'), { status: 422 });
  const breakdown = at(basic);
  return { basicMonthly: basic, breakdown, requested_annual_ctc: target, rounding_residual: Math.round((target - breakdown.annual.ctc) * 100) / 100 };
}

/** What stops a CTC from being finalised: policy not recorded, rules unverified. */
export function finalisationBlockers({ policy, rulesApplied }) {
  const blockers = [];
  if (policy.origin === 'built-in') {
    blockers.push({ code: 'CTC_POLICY_NOT_RECORDED', message: `The company has not recorded its CTC definition (${POLICY_KEY}). The built-in direction (${policy.value.version}) is a proposal pending Finance confirmation.` });
  }
  for (const k of CTC_RULE_KEYS) {
    const a = rulesApplied?.[k];
    if (a && a.status !== 'verified') blockers.push({ code: a.status === 'decision_required' ? 'RULE_DECISION' : 'RULE_UNVERIFIED', key: k, message: `${k} is ${a.status.replace('_', ' ')}` });
  }
  return blockers;
}
