/**
 * settlementRules.js — dated rules for the Full & Final settlement (manual §253).
 *
 * Same idea as payroll/statutoryRules.js, with its own list on purpose: every built-in
 * rule there that is not verified blocks payroll approval, and these must not. A version
 * recorded in payroll_statutory_rules wins over a built-in and counts as the company's
 * confirmation.
 *
 * STATUS, as read on 05 Nov 2026:
 *   unverified         taken from secondary commentary; the Gazette text was not read
 *   decision_required  the law leaves it to the company or the appointment letter
 * Nothing here is legal or tax advice. The settlement lists every rule it used that is
 * not confirmed, so nobody can take a figure as checked when it is not.
 */
const U = 'unverified', D = 'decision_required';

export const SETTLEMENT_RULES = {
  'settlement.gratuity': [{
    effective_from: '2025-11-21', status: U,
    value: {
      min_years: 5, fixed_term_min_years: 1, no_minimum_on: ['death', 'disablement'],
      part_year_months: 6, days_per_year: 15, divisor: 26, ceiling: 2000000, payment_days: 30,
    },
    source: 'Code on Social Security 2020, gratuity chapter; commentary: Angel One, Bajaj Finserv, KPMG flash alert 2025-267. Check the Gazette text and whether the 4 years 240 days reading applies.',
  }],
  'settlement.bonus': [{
    effective_from: '2025-11-21', status: U,
    value: { wage_eligibility: 21000, calculation_wage: 7000, rate_pct: 8.33, max_pct: 20, min_days: 30 },
    source: 'Code on Wages 2019 s.26; S.O. 4710(E) and S.O. 4711(E) of 25 Aug 2026, read through SCC Online. Whether the Central minimum wage replaces 7,000 for this employer is not settled, and the rate above 8.33% depends on allocable surplus.',
  }],
  'settlement.wage_payment': [{
    effective_from: '2025-11-21', status: U,
    value: { working_days: 2 },
    source: 'Code on Wages 2019 s.17(2), read through commentary. Central rules reported as notified 8 May 2026; Tamil Nadu rules not confirmed.',
  }],
  'settlement.day_rate': [{
    effective_from: '2025-11-21', status: D,
    value: { base: 'code_wages', divisor: 26 },
    options: ['code_wages', 'basic'],
    source: 'Company decision. Code wages match the CTC gratuity base (ctcService); divide by 26 follows the gratuity formula.',
  }],
  'settlement.notice': [{
    effective_from: '2025-11-21', status: D,
    value: { recover_on: ['resignation', 'absconding'], pay_in_lieu_on: ['termination', 'retrenchment'] },
    source: 'Company decision, subject to the appointment letter and standing orders. The number of days comes from the exit or the employee record; no default is assumed.',
  }],
  'settlement.tax': [{
    effective_from: '2025-11-21', status: U,
    value: { gratuity_exempt_limit: 2000000, leave_exempt_limit: 2500000, leave_exempt_on: ['resignation', 'retirement', 'retrenchment', 'termination', 'death', 'disablement'] },
    source: 'Income-tax Act 2025 and commentary. Limits are lifetime limits and earlier claims are not known to Pulse. The statutory least-of formula for leave is not applied.',
  }],
  // §276: retrenchment compensation. Before this, a retrenched worker's F&F
  // had no compensation line at all — only notice pay in lieu.
  'settlement.retrenchment': [{
    effective_from: '2025-11-21', status: U,
    value: {
      applies_on: ['retrenchment'], min_years: 1, days_per_year: 15, divisor: 26, part_year_months: 6,
      tax_exempt_limit: 500000, reskilling_days: 15,
    },
    source: 'Industrial Relations Code 2020 s.70(b): 15 days\' average pay for every completed year of continuous service, or part of a year over six months, after at least one year; s.83: the employer also pays 15 days\' wages last drawn into the Worker Re-skilling Fund. Income-tax: exempt up to Rs 5 lakh. Due to a "worker" only (managerial and higher-paid supervisory staff are not workers). Read through commentary; adviser to confirm, including the average-pay period.',
  }],
  'settlement.gl': [{
    effective_from: '2025-11-21', status: D,
    value: {
      salary_expense: null, leave_expense: null, bonus_expense: null, gratuity_expense: null, notice_recovery_income: null,
      asset_recovery_income: null, statutory_payable: null, tds_payable: null, loan_receivable: null, advance_receivable: null,
      retrenchment_expense: null,
    },
    source: 'Finance decision: the account code for each kind of line. Payment is refused until the codes it needs are set.',
  }],
  'settlement.leave': [{
    effective_from: '2025-11-21', status: D,
    value: { max_days_at_exit: null, recover_negative: false, prorate_allocation: true },
    source: 'Company decision. The yearly allowance is pro-rated to months worked; the yearly encashment cap applies during service and is not applied at exit. OSH Code and Tamil Nadu rules at exit not confirmed.',
  }],
};

export const SETTLEMENT_RULE_KEYS = Object.keys(SETTLEMENT_RULES);

const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The version in force on a date; a recorded version wins and counts as confirmed. */
export function resolveSettlementRules(onDate, dbRows = []) {
  const date = day(onDate);
  const values = {}, applied = {};
  for (const key of SETTLEMENT_RULE_KEYS) {
    const candidates = [
      ...SETTLEMENT_RULES[key].map((v) => ({ ...v, rank: 0 })),
      ...dbRows.filter((r) => r.rule_key === key).map((r) => ({
        effective_from: day(r.effective_from), value: r.value, source: r.source_reference, status: 'confirmed', rank: r.company_id == null ? 1 : 2,
      })),
    ].filter((v) => v.effective_from <= date);
    // A separation before the first version still needs a rule: use the earliest, and it stays unconfirmed.
    const pool = candidates.length ? candidates : SETTLEMENT_RULES[key].map((v) => ({ ...v, rank: 0 }));
    pool.sort((a, b) => (a.effective_from === b.effective_from ? b.rank - a.rank : (a.effective_from < b.effective_from ? 1 : -1)));
    const win = pool[0];
    // A version recorded before a field was added (settlement.gl gained
    // retrenchment_expense, §276) reads the new field as the built-in default,
    // so it still validates when edited and the screen shows every field.
    const builtValue = SETTLEMENT_RULES[key][0].value;
    const missing = win.rank > 0 && win.value && typeof win.value === 'object' && !Array.isArray(win.value)
      ? Object.keys(builtValue).filter((k) => !(k in win.value)) : [];
    values[key] = missing.length
      ? { ...win.value, ...Object.fromEntries(missing.map((k) => [k, typeof builtValue[k] === 'string' || builtValue[k] == null ? null : builtValue[k]])) }
      : win.value;
    applied[key] = { effective_from: win.effective_from, status: win.status, source: win.source };
  }
  return { values, applied };
}

/** What is wrong with a value being recorded for a rule, or null. */
export function settlementRuleProblem(key, value) {
  const built = SETTLEMENT_RULES[key]?.[0]?.value;
  if (!built) return `Unknown settlement rule ${key}.`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'The value must be an object.';
  const need = Object.keys(built), have = Object.keys(value);
  const missing = need.filter((k) => !have.includes(k)), extra = have.filter((k) => !need.includes(k));
  if (missing.length) return `Missing: ${missing.join(', ')}.`;
  if (extra.length) return `Not part of this rule: ${extra.join(', ')}.`;
  for (const k of need) {
    const was = built[k], now = value[k];
    if (typeof was === 'number' && !(typeof now === 'number' && now >= 0)) return `${k} must be a number, not negative.`;
    if (Array.isArray(was) && !(Array.isArray(now) && now.every((x) => typeof x === 'string'))) return `${k} must be a list of text values.`;
    if (typeof was === 'boolean' && typeof now !== 'boolean') return `${k} must be true or false.`;
    if (was === null && !(now === null || typeof now === 'number' || typeof now === 'string')) return `${k} must be a value or empty.`;
  }
  return null;
}

/** Every rule with what is in force and whether it is confirmed, for the rules screen. */
export function settlementRuleList(onDate, dbRows = []) {
  const { values, applied } = resolveSettlementRules(onDate, dbRows);
  return SETTLEMENT_RULE_KEYS.map((key) => ({ key, value: values[key], ...applied[key], options: SETTLEMENT_RULES[key][0].options ?? null }));
}

/** Rules a settlement relied on that nobody has confirmed. */
export function unconfirmedRules(applied) {
  return Object.entries(applied).filter(([, a]) => a.status !== 'confirmed').map(([key, a]) => ({ key, status: a.status, source: a.source }));
}
