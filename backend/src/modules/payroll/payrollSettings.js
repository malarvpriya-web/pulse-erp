/**
 * payrollSettings.js — ONE reading of company_settings(module='payroll').
 *
 * Two screens write the same JSON blob under different keys:
 *   Payroll Center → Settings   pay_day_of_month, payroll_cutoff_day,
 *                               professional_tax, pf_enabled, esi_enabled,
 *                               tds_auto_calculate, pay_frequency
 *   Settings → Setup Wizard     pay_day, cutoff_day, pt.enabled, pf.enabled,
 *                               esi.enabled, tds_auto, frequency
 * The engine read the first set, the wizard the second, and the Payslip
 * Generator read neither (it ran on engine defaults). Company 1 on 2026-10-20:
 * professional_tax=false but pt.enabled=true; pay_day_of_month=25 but
 * pay_day=1; payroll_cutoff_day=29 but cutoff_day=25. The salary structure and
 * the Payslip Generator showed PT while Payroll Settings said it was off.
 *
 * Rule: the Payroll Settings key is canonical. A wizard key is used only when
 * the canonical one is absent. Every disagreement is reported as a conflict so
 * the screen can show it, and saving through normalizeForSave() writes both
 * copies with the same value so they cannot drift again.
 */

const PAIRS = [
  // [canonical key, read legacy value, write legacy value]
  ['pay_day_of_month',   s => s.pay_day,         (s, v) => { s.pay_day = v; }],
  ['payroll_cutoff_day', s => s.cutoff_day,      (s, v) => { s.cutoff_day = v; }],
  ['professional_tax',   s => s.pt?.enabled,     (s, v) => { s.pt = { ...(s.pt || {}), enabled: v }; }],
  ['pf_enabled',         s => s.pf?.enabled,     (s, v) => { s.pf = { ...(s.pf || {}), enabled: v }; }],
  ['esi_enabled',        s => s.esi?.enabled,    (s, v) => { s.esi = { ...(s.esi || {}), enabled: v }; }],
  ['tds_auto_calculate', s => s.tds_auto,        (s, v) => { s.tds_auto = v; }],
  ['pay_frequency',      s => s.frequency,       (s, v) => { s.frequency = v; }],
];

export const PAYROLL_SETTING_DEFAULTS = {
  pay_frequency: 'Monthly',
  pay_day_of_month: 25,
  payroll_cutoff_day: 20,
  pay_in_following_month: false,
  working_days: 26,
  regime: 'new',
  pf_enabled: true,
  pf_restrict_to_ceiling: true,
  esi_enabled: true,
  professional_tax: true,
  tds_auto_calculate: true,
  enable_hra: true,
  enable_conveyance: true,
  enable_medical_allowance: true,
  enable_special_allowance: true,
  round_net_pay: 1,
  // CTC-driven salary entry (PAYROLL_DATA_FLOW_AUDIT.md Part 4). OFF by default;
  // while off, salary proposals cannot be created or approved and every
  // existing path behaves exactly as before.
  ctc_mode: false,
  // Statutory jurisdiction (PAYROLL_DATA_FLOW_AUDIT.md Part 7). EMPTY by default:
  // approval is blocked until an authorised user records the state whose PT/LWF
  // rules apply and, where PT is levied by the local body (Tamil Nadu), its type
  // and name. Every employee in the run must resolve to the same state.
  statutory_state: null,
  pt_local_body: null,        // municipal_corporation | municipality | town_panchayat | village_panchayat
  pt_local_body_name: null,
};

const BOOL_KEYS = new Set(['pf_enabled', 'esi_enabled', 'professional_tax', 'tds_auto_calculate',
  'pf_restrict_to_ceiling', 'pay_in_following_month', 'enable_hra', 'enable_conveyance',
  'enable_medical_allowance', 'enable_special_allowance', 'ctc_mode']);
const INT_KEYS = new Set(['pay_day_of_month', 'payroll_cutoff_day', 'working_days', 'round_net_pay']);

function coerce(key, v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (BOOL_KEYS.has(key)) return v === true || v === 'true' || v === 1 || v === '1';
  if (INT_KEYS.has(key)) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; }
  return v;
}

/** @returns {{ settings: Object, conflicts: Array<{key, value, legacy_value}> }} */
export function normalizePayrollSettings(raw = {}) {
  const src = raw || {};
  const settings = { ...PAYROLL_SETTING_DEFAULTS };
  for (const [k, v] of Object.entries(src)) {
    const c = coerce(k, v);
    if (c !== undefined && typeof v !== 'object') settings[k] = c;
  }
  const conflicts = [];
  for (const [key, readLegacy] of PAIRS) {
    const canonical = coerce(key, src[key]);
    const legacy = coerce(key, readLegacy(src));
    if (canonical === undefined && legacy !== undefined) settings[key] = legacy;
    else if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
      conflicts.push({ key, value: canonical, legacy_value: legacy });
    }
  }
  return { settings, conflicts };
}

/** Validation of the pay cycle. Returns a list of error strings (empty = valid). */
export function validatePayCycle(s) {
  const errors = [];
  const pay = s.pay_day_of_month, cut = s.payroll_cutoff_day;
  if (!(pay >= 1 && pay <= 31)) errors.push('Pay day must be between 1 and 31');
  if (!(cut >= 1 && cut <= 31)) errors.push('Payroll cutoff day must be between 1 and 31');
  if (errors.length) return errors;
  if (!s.pay_in_following_month && cut >= pay) {
    errors.push(`Cutoff day (${cut}) must be before pay day (${pay}) when salary is paid in the same month — ` +
      'attendance has to be frozen before the payroll it feeds. Move the cutoff earlier, or set ' +
      '"Pay in following month".');
  }
  if (s.pay_in_following_month && pay > 7) {
    // Code on Wages 2019 s.17: monthly wages are due before the expiry of the
    // seventh day of the succeeding month.
    errors.push(`Pay day ${pay} of the following month is later than the 7th — the statutory limit for monthly wages`);
  }
  return errors;
}

/** Merge a save request into the stored blob and write both key families. */
export function normalizeForSave(body = {}, existing = {}) {
  const merged = { ...(existing || {}), ...(body || {}) };
  for (const [key, readLegacy, writeLegacy] of PAIRS) {
    const bodyCanon = coerce(key, body?.[key]);
    const bodyLegacy = coerce(key, readLegacy(body || {}));
    const exCanon = coerce(key, existing?.[key]);
    // Whichever copy THIS request changed wins; the canonical one on a tie.
    let value;
    if (bodyCanon !== undefined && bodyCanon !== exCanon) value = bodyCanon;
    else if (bodyLegacy !== undefined && bodyLegacy !== coerce(key, readLegacy(existing || {}))) value = bodyLegacy;
    else value = bodyCanon ?? exCanon ?? bodyLegacy ?? coerce(key, readLegacy(existing || {}));
    if (value === undefined) continue;
    merged[key] = value;
    writeLegacy(merged, value);
  }
  return merged;
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const clampDay = (y, m, d) => Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate());

/**
 * Pay-cycle dates for a wage month, and where `today` sits in it.
 *   attendance cutoff → attendance/leave for the month is frozen
 *   pay date          → salary must be in employees' accounts
 * "Overdue" means the pay date has passed and the run is not approved/paid —
 * it is never derived from the cutoff. (The Payslip Generator banner used the
 * cutoff, so with cutoff 29 it called September "overdue" on 30 Sep while the
 * configured pay day, the 25th, had passed five days earlier unremarked.)
 */
export function payCycleFor(settings, month, year, { runStatus = null, today = new Date() } = {}) {
  const s = settings;
  const cutoff = iso(year, month, clampDay(year, month, s.payroll_cutoff_day));
  const pm = s.pay_in_following_month ? (month === 12 ? 1 : month + 1) : month;
  const py = s.pay_in_following_month && month === 12 ? year + 1 : year;
  const payDate = iso(py, pm, clampDay(py, pm, s.pay_day_of_month));
  const t = today.toISOString().slice(0, 10);
  const finalised = runStatus === 'approved' || runStatus === 'paid';
  let state;
  if (runStatus === 'paid') state = 'paid';
  else if (finalised) state = t > payDate ? 'approved_unpaid_overdue' : 'approved';
  else if (t > payDate) state = 'overdue';
  else if (t > cutoff) state = 'cutoff_passed';
  else state = 'open';
  return {
    attendance_cutoff_date: cutoff,
    pay_date: payDate,
    state,
    errors: validatePayCycle(s),
  };
}
