/**
 * settlementEngine.js — the Full & Final calculation (manual §253). No database, no clock.
 *
 * Takes what fnf.service.js read and returns one line per component: what it is, how it was
 * worked out, which way the money goes, and how it is treated for tax. A rule that cannot
 * be applied becomes a warning, never a silent zero.
 *
 * The old engine reported a "PF balance" and "TDS on PF". The PF corpus is held by EPFO and
 * Pulse has no such figure, so they are gone. Tax on the settlement is not computed here:
 * the tax notes say how each line is treated, and the adviser confirms them.
 */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const utc = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY) + 1; // both ends included

/** Complete years and left-over months between two dates. */
export function serviceSpan(joining, lwd) {
  const j = new Date(utc(joining)), l = new Date(utc(lwd) + DAY); // the last working day counts as served
  let months = (l.getUTCFullYear() - j.getUTCFullYear()) * 12 + (l.getUTCMonth() - j.getUTCMonth());
  if (l.getUTCDate() < j.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  // Days left over after the whole months: "more than six months" needs them.
  const anchor = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + months, j.getUTCDate()));
  return { years: Math.floor(months / 12), months: months % 12, extra_days: Math.max(0, Math.round((l - anchor) / DAY)), days: Math.max(0, daysBetween(joining, lwd)) };
}

const FIXED_TERM = /fixed|contract/i;
const NOT_EMPLOYEE = /intern|apprentice|trainee/i;

export const KNOWN_SEPARATIONS = ['resignation', 'termination', 'retrenchment', 'retirement', 'death', 'disablement', 'absconding', 'contract_expiry'];

function normaliseSeparation(raw, warnings) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (KNOWN_SEPARATIONS.includes(s)) return s;
  warnings.push({ code: 'SEPARATION_TYPE_UNKNOWN', message: `Exit type "${raw ?? 'blank'}" is not recognised, so it was treated as a resignation. Check notice and gratuity.` });
  return 'resignation';
}

function gratuityLine({ employee, separation, span, wage, r, options, warnings }) {
  const label = 'Gratuity';
  const none = (basis) => ({ code: 'GRATUITY', label, direction: 'payable', quantity: null, rate: null, amount: 0, basis, tax: 'None payable.' });
  if (options.forfeit_gratuity_reason) return none(`Forfeited: ${options.forfeit_gratuity_reason}`);
  const type = employee.employment_type ?? '';
  if (NOT_EMPLOYEE.test(type)) return none(`Not payable: employment type is ${type}.`);

  const fixedTerm = FIXED_TERM.test(type);
  const noMinimum = r.no_minimum_on.includes(separation);
  const need = fixedTerm ? r.fixed_term_min_years : r.min_years;
  if (!noMinimum && span.years < need) {
    if (!fixedTerm && span.years === need - 1 && span.months >= 8) {
      warnings.push({ code: 'GRATUITY_NEAR_THRESHOLD', message: `Service is ${span.years} years ${span.months} months. Some rulings count a final part-year of 240 working days towards ${need} years. Ask the adviser.` });
    }
    return none(`Not payable: ${span.years} years ${span.months} months of service, ${need} needed${fixedTerm ? ' for a fixed-term employee' : ''}.`);
  }

  // A fixed-term employee is paid pro rata; otherwise a part-year over the limit counts as a year.
  const years = fixedTerm
    ? round2(span.days / 365)
    : span.years + (span.months > r.part_year_months || (span.months === r.part_year_months && span.extra_days > 0) ? 1 : 0);
  const computed = (r.days_per_year / r.divisor) * wage * years;
  const amount = round2(Math.min(computed, r.ceiling));
  if (computed > r.ceiling) warnings.push({ code: 'GRATUITY_CEILING', message: `Gratuity worked out above the ceiling of ${r.ceiling} and was capped.` });
  if (separation === 'termination') warnings.push({ code: 'GRATUITY_FORFEITURE', message: 'A termination for certain misconduct can forfeit gratuity. If it applies, enter the reason and recalculate.' });
  return {
    code: 'GRATUITY', label, direction: 'payable', quantity: years, rate: round2((r.days_per_year / r.divisor) * wage), amount,
    basis: `${r.days_per_year}/${r.divisor} × monthly wage ${round2(wage)} × ${years} years${fixedTerm ? ' (fixed term, pro rata)' : ''}. Due within ${r.payment_days} days.`,
    tax: 'Exempt up to the Rs 20 lakh lifetime limit for a non-government employee; the excess is taxable salary. Adviser to confirm under the Income-tax Act 2025.',
  };
}

/**
 * Retrenchment compensation (IR Code s.70(b), rule settlement.retrenchment):
 * days_per_year / divisor × monthly wage for every completed year of service,
 * a final part-year over part_year_months counting as a year, once min_years
 * is served. Only for the separations in applies_on; otherwise no line at all.
 * The Worker Re-skilling Fund contribution (s.83) is the employer's, paid to
 * the fund, so it is a warning with the amount, not a line of this settlement.
 */
function retrenchmentLine({ separation, span, wage, r, warnings }) {
  if (!r || !r.applies_on.includes(separation)) return null;
  const label = 'Retrenchment compensation';
  const dayRate = wage / r.divisor;
  if (r.reskilling_days > 0 && wage > 0) {
    warnings.push({ code: 'RESKILLING_FUND', message: `Also pay ${round2(r.reskilling_days * dayRate)} (${r.reskilling_days} days' wages) into the Worker Re-skilling Fund. It is the employer's contribution and is not part of this settlement.` });
  }
  warnings.push({ code: 'RETRENCHMENT_WORKER', message: 'Retrenchment compensation is due to a "worker" under the Industrial Relations Code. Managerial staff, and supervisory staff above the notified wage, are not workers. Check before paying.' });
  if (span.years < r.min_years) {
    return { code: 'RETRENCHMENT', label, direction: 'payable', quantity: 0, rate: round2(r.days_per_year * dayRate), amount: 0,
      basis: `Not payable: ${span.years} years ${span.months} months of continuous service, ${r.min_years} needed.`, tax: 'None payable.' };
  }
  const years = span.years + (span.months > r.part_year_months || (span.months === r.part_year_months && span.extra_days > 0) ? 1 : 0);
  return {
    code: 'RETRENCHMENT', label, direction: 'payable', quantity: years, rate: round2(r.days_per_year * dayRate),
    amount: round2(r.days_per_year * dayRate * years),
    basis: `${r.days_per_year}/${r.divisor} × monthly wage ${round2(wage)} × ${years} years (a part-year over ${r.part_year_months} months counts).`,
    tax: `Exempt up to Rs ${r.tax_exempt_limit.toLocaleString('en-IN')}; the excess is taxable salary. Adviser to confirm.`,
  };
}

function bonusLine({ lwd, joining, wage, bonusPaidInYear, r, options, warnings }) {
  const label = 'Statutory bonus';
  const none = (basis) => ({ code: 'BONUS', label, direction: 'payable', quantity: null, rate: null, amount: 0, basis, tax: 'None payable.' });
  if (options.bonus_disqualified_reason) return none(`Disqualified: ${options.bonus_disqualified_reason}`);
  const y = Number(lwd.slice(0, 4)), m = Number(lwd.slice(5, 7));
  const fyStart = `${m >= 4 ? y : y - 1}-04-01`;
  const from = joining > fyStart ? joining : fyStart;
  const workedDays = Math.max(0, daysBetween(from, lwd));
  if (wage > r.wage_eligibility) return none(`Not payable: monthly wage ${round2(wage)} is above the ${r.wage_eligibility} limit.`);
  if (workedDays < r.min_days) return none(`Not payable: ${workedDays} days in the accounting year from ${fyStart}, at least ${r.min_days} needed.`);
  const base = Math.min(wage, r.calculation_wage);
  const months = round2(workedDays / (365 / 12));
  const due = round2(base * months * (r.rate_pct / 100));
  const amount = Math.max(0, round2(due - bonusPaidInYear));
  warnings.push({ code: 'BONUS_DISQUALIFICATION', message: 'Bonus can be lost for fraud, violent behaviour, theft or sabotage. If it applies, enter the reason and recalculate. Prior years unpaid are not included.' });
  return {
    code: 'BONUS', label, direction: 'payable', quantity: months, rate: round2(base * (r.rate_pct / 100)), amount,
    basis: `${r.rate_pct}% × wage ${base} × ${months} months from ${from}${bonusPaidInYear ? `, less ${round2(bonusPaidInYear)} already paid this year` : ''}.`,
    tax: 'Taxable as salary.',
  };
}

/**
 * The company's own bonus plans (Payroll Center → Settings → Bonus plans, e.g. a Diwali
 * bonus) for someone who leaves before the plan's next pay month. The plan pays in its
 * months through monthly payroll; a person who has gone by then gets the share of the
 * period they worked: the period runs from the month after the plan's previous pay month
 * up to and including its next one (12 months for a once-a-year plan).
 * Per plan: prorate_on_exit (default yes) and min_service_months (default 0). The share is
 * worked out on the full-month Basic or regular gross on the last working day.
 */
export function festivalBonusLines({ plans = [], lwd, joining, wage, warnings }) {
  const lines = [];
  if (!Array.isArray(plans) || !plans.length) return lines;
  const ly = Number(lwd.slice(0, 4)), lm = Number(lwd.slice(5, 7));
  const idx = (y, m) => y * 12 + (m - 1);
  const ymd = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
  const lwdIdx = idx(ly, lm);
  for (const p of plans) {
    if (!p?.active || p.prorate_on_exit === false) continue;
    const months = [...new Set((p.months || []).map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
    if (!months.length) continue;
    const label = `${p.name} (share on leaving)`;
    const none = (basis) => ({ code: 'FESTIVAL_BONUS', label, direction: 'payable', quantity: null, rate: null, amount: 0, basis, tax: 'None payable.' });
    // The next pay month on or after the last month worked, and the one before it.
    let next = null;
    for (let i = lwdIdx; i < lwdIdx + 12 && next == null; i += 1) if (months.includes((i % 12) + 1)) next = i;
    let prev = null;
    for (let i = next - 1; i >= next - 12 && prev == null; i -= 1) if (months.includes(((i % 12) + 12) % 12 + 1)) prev = i;
    const periodStart = ymd(prev + 1);
    const periodMonths = next - prev;
    if (!joining) { lines.push(none('Not worked out: no joining date.')); continue; }
    if (joining > lwd) continue;
    const minMonths = Number(p.min_service_months) || 0;
    const served = serviceSpan(joining, lwd);
    if (served.years * 12 + served.months < minMonths) {
      lines.push(none(`Not payable: ${served.years * 12 + served.months} months of service, the plan needs ${minMonths}.`));
      continue;
    }
    const from = joining > periodStart ? joining : periodStart;
    const worked = round2(Math.max(0, daysBetween(from, lwd)) / (365 / 12));
    const share = Math.min(1, worked / periodMonths);
    const base = p.type === 'fixed' ? Number(p.amount) || 0
      : round2((p.type === 'pct_basic' ? Number(wage?.basic) || 0 : Number(wage?.gross) || 0) * (Number(p.amount) || 0) / 100);
    if (p.type !== 'fixed' && !wage) { lines.push(none('Not worked out: no salary on record.')); continue; }
    const amount = Math.round(base * share);
    const what = p.type === 'fixed' ? `${base}` : `${p.amount}% of ${p.type === 'pct_basic' ? 'Basic' : 'gross'} ${p.type === 'pct_basic' ? wage.basic : wage.gross} = ${base}`;
    lines.push({
      code: 'FESTIVAL_BONUS', label, direction: 'payable', quantity: worked, rate: base, amount,
      basis: `${what} × ${worked} of ${periodMonths} months worked from ${from} (the plan pays in ${months.join(', ')}; next due ${ymd(next).slice(0, 7)}).`,
      tax: 'Taxable as salary.',
      counts_as_statutory: p.counts_as_statutory !== false,
    });
  }
  if (lines.some((l) => l.amount > 0)) warnings.push({ code: 'FESTIVAL_BONUS_SHARE', message: 'A share of the company bonus plan is included because the employee leaves before it is paid. Remove it with a recalculation if the plan does not pay leavers.' });
  return lines;
}

/**
 * The yearly sales incentive for a leaver. It is never paid automatically: HR decides
 * (pay an amount, or not pay, with a reason) and Finance is told. `si` is
 * { suggested: { fy_label, target, achieved, pct, amount, basis } | null,
 *   decision: 'pay' | 'not_pay' | null, amount, reason }.
 */
export function salesIncentiveLine(si, warnings) {
  if (!si) return null;
  const s = si.suggested;
  const label = `Sales incentive${s?.fy_label ? ` ${s.fy_label}` : ''}`;
  const earned = s ? `${s.pct}% of the ₹${Number(s.target).toLocaleString('en-IN')} target achieved; the slabs give ₹${Number(s.amount).toLocaleString('en-IN')}` : 'no target on record';
  if (si.decision === 'pay') {
    const amount = Math.max(0, Math.round(Number(si.amount) || 0));
    return { code: 'SALES_INCENTIVE', label, direction: 'payable', quantity: null, rate: null, amount,
      basis: `HR decided to pay ₹${amount.toLocaleString('en-IN')}: ${si.reason}. (${earned}.)`, tax: 'Taxable as salary.' };
  }
  if (si.decision === 'not_pay') {
    return { code: 'SALES_INCENTIVE', label, direction: 'payable', quantity: null, rate: null, amount: 0,
      basis: `HR decided not to pay: ${si.reason}. (${earned}.)`, tax: 'None payable.' };
  }
  if (s && s.amount > 0) {
    warnings.push({ code: 'SALES_INCENTIVE_UNDECIDED', message: `${label} is not included: ${earned} (${s.basis}). HR to decide whether to pay it; Finance is told of the decision.` });
  }
  return null;
}

function noticeLine({ exit, employee, separation, lwd, dayRate, options, r, warnings }) {
  const label = 'Notice period';
  const required = exit.notice_period ?? employee.notice_period_days ?? null;
  const none = (basis) => ({ code: 'NOTICE', label, direction: 'recoverable', quantity: 0, rate: dayRate, amount: 0, basis, tax: 'None.' });
  const recovers = r.recover_on.includes(separation), paysInLieu = r.pay_in_lieu_on.includes(separation);
  if (!recovers && !paysInLieu) return none(`No notice amount for ${separation.replace(/_/g, ' ')}.`);
  if (required == null) {
    warnings.push({ code: 'NOTICE_DAYS_UNKNOWN', message: 'No notice period is recorded on the exit or the employee, so nothing was recovered or paid. Enter it from the appointment letter.' });
    return none('Notice period not recorded.');
  }
  const start = options.notice_start ?? null;
  const served = paysInLieu ? 0 : (start ? Math.max(0, daysBetween(start, lwd)) : null);
  let shortfall;
  if (served == null) {
    warnings.push({ code: 'NOTICE_START_UNKNOWN', message: 'The date notice started is not recorded, so the exit\'s creation date was used. Enter the resignation date if it differs.' });
    shortfall = Math.max(0, required - Math.max(0, daysBetween(exit.created_at, lwd) - 1));
  } else {
    shortfall = Math.max(0, required - served);
  }
  const waived = Math.min(shortfall, Number(options.waive_notice_days) || 0);
  const days = shortfall - waived;
  const waiver = waived ? `, ${waived} waived: ${options.waive_reason}` : '';
  if (paysInLieu) {
    return {
      code: 'NOTICE', label: 'Pay in lieu of notice', direction: 'payable', quantity: days, rate: dayRate, amount: round2(days * dayRate),
      basis: `${required} days required, none served by the employee's choice${waiver}. × day rate ${dayRate}.`, tax: 'Taxable as salary.',
    };
  }
  return {
    code: 'NOTICE', label: 'Notice shortfall', direction: 'recoverable', quantity: days, rate: dayRate, amount: round2(days * dayRate),
    basis: `${required} days required, ${shortfall} short${waiver}. × day rate ${dayRate}.`, tax: 'Treatment of a recovery differs by reading. Adviser to confirm.',
  };
}

/** Whole months worked in the calendar year up to the last working day. */
function monthsWorkedInYear(joining, lwd) {
  const jan1 = `${lwd.slice(0, 4)}-01-01`;
  const from = joining && joining > jan1 ? joining : jan1;
  const s = serviceSpan(from, lwd);
  return s.years * 12 + s.months;
}

function leaveLines({ leave, dayRate, joining, lwd, r, warnings }) {
  const lines = [];
  for (const l of leave) {
    // The year's allowance is credited up front, so someone leaving mid-year has earned part of it.
    const credited = Number(l.allocated_days || 0);
    const quota = Number(l.annual_quota || 0);
    const months = monthsWorkedInYear(joining, lwd);
    const earned = r.prorate_allocation && quota > 0 ? Math.min(credited, round2((quota * months) / 12)) : credited;
    let days = round2(Number(l.opening_balance || 0) + earned + Number(l.carried_forward_days || 0) - Number(l.used_days || 0) - Number(l.encashed_days || 0));
    if (days < 0) {
      if (r.recover_negative) {
        lines.push({ code: 'LEAVE_NEGATIVE', label: `${l.leave_name}, taken in excess`, direction: 'recoverable', quantity: -days, rate: dayRate, amount: round2(-days * dayRate), basis: `${-days} days over the balance × day rate ${dayRate}.`, tax: 'Reduces taxable salary.' });
      } else {
        warnings.push({ code: 'LEAVE_NEGATIVE', message: `${l.leave_name} balance is ${days} days. Not recovered under the current rule.` });
      }
      continue;
    }
    const capped = r.max_days_at_exit == null ? days : Math.min(days, r.max_days_at_exit);
    lines.push({
      code: 'LEAVE', label: `${l.leave_name} encashment`, direction: 'payable', quantity: capped, rate: dayRate, amount: round2(capped * dayRate),
      basis: `${capped} days${capped < days ? ` of ${days}` : ''} × day rate ${dayRate}, balance for ${l.year}${earned < credited ? `, with ${earned} of ${credited} days earned by ${months} months worked` : ''}.`,
      tax: 'On resignation or retirement, exempt within the Rs 25 lakh lifetime limit and the statutory formula; otherwise taxable. Adviser to confirm.',
    });
  }
  return lines;
}

/** TDS on the whole settlement: tax on the year's income including it, less what was already deducted. */
function settlementTaxLine({ lines, separation, tax, r, retrenchment }) {
  const amt = (code) => lines.filter((l) => l.code === code && l.direction === 'payable').reduce((s, l) => s + l.amount, 0);
  const leave = amt('LEAVE');
  const leaveTaxable = r.leave_exempt_on.includes(separation) ? Math.max(0, leave - r.leave_exempt_limit) : leave;
  const gratuityTaxable = Math.max(0, amt('GRATUITY') - r.gratuity_exempt_limit);
  const retrenchmentTaxable = Math.max(0, amt('RETRENCHMENT') - Number(retrenchment?.tax_exempt_limit ?? 0));
  const fromSettlement = amt('FINAL_SALARY') + amt('NOTICE') + amt('BONUS') + amt('FESTIVAL_BONUS') + amt('SALES_INCENTIVE') + leaveTaxable + gratuityTaxable + retrenchmentTaxable;
  const income = Math.max(0, Number(tax.ytd_gross) + fromSettlement - Number(tax.standard_deduction));
  const due = Math.max(0, round2(tax.taxOf(income) - Number(tax.ytd_tds)));
  return {
    code: 'SETTLEMENT_TDS', label: 'TDS on settlement', direction: 'recoverable', quantity: null, rate: null, amount: due,
    basis: `Tax on ${round2(income)} for the year, including ${round2(fromSettlement)} taxable from this settlement, less ${round2(tax.ytd_tds)} already deducted. Income from a previous employer and other declarations are not included.`,
    tax: 'Deposit under section 192 or its successor. Adviser to confirm.',
  };
}

/**
 * @param input.exit      { separation_type, last_working_date, notice_period, created_at }
 * @param input.employee  { joining_date, employment_type, notice_period_days }
 * @param input.wage      { gross, basic, code_wages } for a full month, or null when no salary is on record
 * @param input.finalSlip the payslip for the last month up to the last working day, or null
 * @param input.finalRun  { id, status } of that month's payroll run, if any
 * @param input.leave     encashable leave_balances rows with leave_name
 * @param input.loans     [{ id, loan_type, outstanding_balance }]
 * @param input.advanceOutstanding, input.bonusPaidInYear, input.options
 * @param input.tax       { ytd_gross, ytd_tds, standard_deduction, taxOf(income) }, or null to use the monthly estimate
 */
export function computeSettlement(input, rules) {
  const { exit, employee, wage, finalSlip, finalRun, leave = [], loans = [], advanceOutstanding = 0, bonusPaidInYear = 0, options = {}, tax = null } = input;
  const warnings = [];
  const lwd = String(exit.last_working_date).slice(0, 10);
  const joining = employee.joining_date ? String(employee.joining_date).slice(0, 10) : null;
  const separation = normaliseSeparation(exit.separation_type, warnings);
  if (!joining) warnings.push({ code: 'JOINING_DATE_MISSING', message: 'No joining date is recorded, so service could not be worked out. Gratuity and bonus are shown as nil.' });
  if (!wage) warnings.push({ code: 'SALARY_MISSING', message: 'No salary is recorded, so wage-based lines are nil. Add a salary revision first.' });

  const span = joining ? serviceSpan(joining, lwd) : { years: 0, months: 0, extra_days: 0, days: 0 };
  const dr = rules['settlement.day_rate'];
  const monthlyWage = wage ? (dr.base === 'basic' ? wage.basic : wage.code_wages) : 0;
  const dayRate = round2(monthlyWage / dr.divisor);

  const lines = [];

  // Final wages
  const paidInPayroll = finalRun && ['approved', 'paid', 'processed'].includes(String(finalRun.status).toLowerCase());
  if (paidInPayroll) {
    lines.push({ code: 'FINAL_SALARY', label: 'Final month salary', direction: 'payable', quantity: null, rate: null, amount: 0, basis: `Already in payroll run ${finalRun.id} (${finalRun.status}).`, tax: 'Taxed in that run.' });
  } else if (finalSlip) {
    if (finalRun) warnings.push({ code: 'FINAL_RUN_DRAFT', message: `Payroll run ${finalRun.id} for the last month is still ${finalRun.status}. Do not also approve it, or the salary is paid twice.` });
    lines.push({
      code: 'FINAL_SALARY', label: 'Final month salary', direction: 'payable', quantity: finalSlip.paid_days, rate: null, amount: round2(finalSlip.gross),
      basis: `${finalSlip.paid_days} of ${finalSlip.days_in_month} days${finalSlip.lop_days ? `, ${finalSlip.lop_days} loss of pay` : ''}, from the payroll engine. Attendance loss of pay is applied only when entered.`,
      tax: 'Taxable as salary.',
    });
    const statutory = round2((finalSlip.employee_pf || 0) + (finalSlip.employee_esi || 0) + (finalSlip.professional_tax || 0) + (finalSlip.lwf_employee || 0));
    if (statutory > 0) lines.push({ code: 'FINAL_STATUTORY', label: 'PF, ESI, PT and LWF on final salary', direction: 'recoverable', quantity: null, rate: null, amount: statutory, basis: 'From the payroll engine.', tax: 'Statutory deduction.' });
    if (!tax && finalSlip.tds > 0) lines.push({ code: 'FINAL_TDS', label: 'TDS on final salary', direction: 'recoverable', quantity: null, rate: null, amount: round2(finalSlip.tds), basis: 'Monthly estimate from the payroll engine. It does not yet include the settlement lines.', tax: 'Adviser to confirm the final figure.' });
  }

  lines.push(...leaveLines({ leave, dayRate, joining, lwd, r: rules['settlement.leave'], warnings }));
  // A company bonus (Diwali etc.) counts towards the statutory bonus unless its plan says
  // otherwise — the customary-bonus adjustment — so the two are not paid twice.
  const festival = options.bonus_disqualified_reason ? [] : festivalBonusLines({ plans: input.bonusPlans, lwd, joining, wage, warnings });
  lines.push(...festival);
  const festivalTowardsStatutory = festival.filter((l) => l.counts_as_statutory).reduce((s, l) => s + l.amount, 0);
  lines.push(joining
    ? bonusLine({ lwd, joining, wage: monthlyWage, bonusPaidInYear: (Number(bonusPaidInYear) || 0) + festivalTowardsStatutory, r: rules['settlement.bonus'], options, warnings })
    : { code: 'BONUS', label: 'Statutory bonus', direction: 'payable', quantity: null, rate: null, amount: 0, basis: 'Not worked out: no joining date.', tax: 'None payable.' });
  lines.push(joining
    ? gratuityLine({ employee, separation, span, wage: monthlyWage, r: rules['settlement.gratuity'], options, warnings })
    : { code: 'GRATUITY', label: 'Gratuity', direction: 'payable', quantity: null, rate: null, amount: 0, basis: 'Not worked out: no joining date.', tax: 'None payable.' });
  lines.push(noticeLine({ exit, employee, separation, lwd, dayRate, options, r: rules['settlement.notice'], warnings }));
  const incentive = salesIncentiveLine(input.salesIncentive, warnings);
  if (incentive) lines.push(incentive);
  if (joining) {
    const retrench = retrenchmentLine({ separation, span, wage: monthlyWage, r: rules['settlement.retrenchment'], warnings });
    if (retrench) lines.push(retrench);
  }

  // Recoveries
  for (const loan of loans) {
    const owed = round2(loan.outstanding_balance);
    if (owed > 0) lines.push({ code: 'LOAN', label: `${loan.loan_type || 'Loan'} outstanding`, direction: 'recoverable', quantity: null, rate: null, amount: owed, basis: `Loan ${loan.id} balance.`, tax: 'Not a tax item.', source_id: loan.id });
  }
  if (Number(advanceOutstanding) > 0) lines.push({ code: 'TRAVEL_ADVANCE', label: 'Travel advance outstanding', direction: 'recoverable', quantity: null, rate: null, amount: round2(advanceOutstanding), basis: 'Advances not yet settled.', tax: 'Not a tax item.' });

  if (Number(options.asset_recovery_amount) > 0) lines.push({ code: 'ASSET_RECOVERY', label: 'Assets not returned', direction: 'recoverable', quantity: null, rate: null, amount: round2(options.asset_recovery_amount), basis: `Agreed value: ${options.asset_recovery_reason}.`, tax: 'Not a tax item.' });
  if (tax) lines.push(settlementTaxLine({ lines, separation, tax, r: rules['settlement.tax'], retrenchment: rules['settlement.retrenchment'] }));

  const totalPayable = round2(lines.filter((l) => l.direction === 'payable').reduce((s, l) => s + l.amount, 0));
  const totalRecoverable = round2(lines.filter((l) => l.direction === 'recoverable').reduce((s, l) => s + l.amount, 0));
  const netPayable = round2(totalPayable - totalRecoverable);
  if (netPayable < 0) warnings.push({ code: 'EMPLOYEE_OWES', message: `The employee owes ${-netPayable}. Decide whether to collect or write it off.` });

  return {
    separation, last_working_date: lwd,
    service: { years: span.years, months: span.months },
    day_rate: dayRate, monthly_wage: round2(monthlyWage),
    wage_payment_days: rules['settlement.wage_payment'].working_days,
    lines, warnings,
    total_payable: totalPayable, total_recoverable: totalRecoverable, net_payable: netPayable,
  };
}
