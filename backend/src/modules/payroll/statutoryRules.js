/**
 * statutoryRules.js — effective-dated statutory payroll parameters.
 *
 * Every rate, ceiling and slab table the engine uses lives here as a list of
 * VERSIONS, each with the date it took effect. A payroll period is computed with
 * the version in force on the period's last day, so a change in law is a new
 * row with a new date — never an edit that silently rewrites past months.
 *
 * These built-in versions are the floor. `payroll_statutory_rules` (migration
 * 20261020000001) holds versions added at runtime — globally (company_id NULL)
 * or for one company — so the next notification does not need a deploy.
 * Resolution: the latest effective_from <= the date wins; on the same date a
 * company row beats a global row, which beats a built-in one.
 *
 * STATUS (2026-10-20 primary-source pass, PAYROLL_DATA_FLOW_AUDIT.md §R1):
 *   verified           checked against a primary government source (`evidence`)
 *   unverified         taken from secondary commentary or not re-checked
 *   decision_required  the law/guidance leaves a choice the company must make
 * A built-in version that is not `verified` BLOCKS payroll approval for any
 * period it applies to (payrollReleaseGate.js) until an authorised user records
 * a company (or global) version for that rule, on or after that date, with its
 * source — the recorded version is the company's confirmation and wins over the
 * built-in. Recording the same value changes no calculation.
 */

const NEW_REGIME_SLABS_2025 = [
  { min: 0,       max: 400000,   rate: 0.00 },
  { min: 400000,  max: 800000,   rate: 0.05 },
  { min: 800000,  max: 1200000,  rate: 0.10 },
  { min: 1200000, max: 1600000,  rate: 0.15 },
  { min: 1600000, max: 2000000,  rate: 0.20 },
  { min: 2000000, max: 2400000,  rate: 0.25 },
  { min: 2400000, max: null,     rate: 0.30 },   // null = no upper bound (JSON-safe Infinity)
];

const OLD_REGIME_SLABS = [
  { min: 0,       max: 250000,  rate: 0.00 },
  { min: 250000,  max: 500000,  rate: 0.05 },
  { min: 500000,  max: 1000000, rate: 0.20 },
  { min: 1000000, max: null,    rate: 0.30 },
];

// Professional Tax: monthly gross → PT per month. Carried over unchanged from
// the engine's previous hard-coded table; overridable per state by a new version.
// Tamil Nadu urban local bodies (town panchayats, municipalities, corporations):
// Tamil Nadu Urban Local Bodies Rules 2023 r.275(2) table, in force 13-Apr-2023,
// "till such time as the next general revision of tax is carried out by the
// Council" — a council may have revised it (Chennai did). Deducted from the
// August and January pay bills (r.277(2)). Village panchayats levy their own
// rates (TN Panchayats Act 1994 Ch. IX-A, "published by the Inspector") — not
// in this table; the release gate blocks a TN village-panchayat jurisdiction.
const TN_ULB_PT_2023 = {
  basis: 'half_year', deduct_months: [8, 1],
  slabs: [
    { min: 0, max: 21000, pt: 0 }, { min: 21001, max: 30000, pt: 135 }, { min: 30001, max: 45000, pt: 315 },
    { min: 45001, max: 60000, pt: 690 }, { min: 60001, max: 75000, pt: 1025 }, { min: 75001, max: null, pt: 1250 },
  ],
};
const KA_PT_2023 = [{ min: 0, max: 24999, pt: 0 }, { min: 25000, max: null, pt: 200 }];
const KA_PT_2025 = [{ min: 0, max: 24999, pt: 0 }, { min: 25000, max: null, pt: 200, month_pt: { 2: 300 } }];

const PT_SLABS = {
  MH: [{ min: 0, max: 7500, pt: 0 }, { min: 7501, max: 10000, pt: 175 }, { min: 10001, max: null, pt: 200 }],
  KA: [{ min: 0, max: 14999, pt: 0 }, { min: 15000, max: null, pt: 200 }],
  TN: [{ min: 0, max: 20999, pt: 0 }, { min: 21000, max: null, pt: 208 }],
  TS: [{ min: 0, max: 14999, pt: 0 }, { min: 15000, max: null, pt: 200 }],
  AP: [{ min: 0, max: 14999, pt: 0 }, { min: 15000, max: null, pt: 200 }],
  KL: [
    { min: 0, max: 1999, pt: 0 }, { min: 2000, max: 2999, pt: 20 }, { min: 3000, max: 4999, pt: 30 },
    { min: 5000, max: 7499, pt: 50 }, { min: 7500, max: 9999, pt: 75 }, { min: 10000, max: 12499, pt: 100 },
    { min: 12500, max: 16666, pt: 125 }, { min: 16667, max: null, pt: 208 },
  ],
  GJ: [{ min: 0, max: 5999, pt: 0 }, { min: 6000, max: 8999, pt: 80 }, { min: 9000, max: 11999, pt: 150 }, { min: 12000, max: null, pt: 200 }],
  WB: [
    { min: 0, max: 9999, pt: 0 }, { min: 10000, max: 14999, pt: 110 }, { min: 15000, max: 24999, pt: 130 },
    { min: 25000, max: 39999, pt: 150 }, { min: 40000, max: null, pt: 200 },
  ],
};

const V = 'verified', U = 'unverified', D = 'decision_required';

export const BUILT_IN_RULES = {
  // ── Provident Fund (Code on Social Security, 2020 — Chapter III) ──────────
  'pf.employee_rate': [{ effective_from: '2014-09-01', value: 12, status: V,
    source: 'EPF contribution rate 12% of wages',
    evidence: 'PIB (MoLE) PRID 2311548, Sep-2026: "an employee contributes 12 per cent… The employer also contributes an equivalent 12 per cent"' }],
  'pf.employer_rate': [{ effective_from: '2014-09-01', value: 12, status: V,
    source: 'EPF employer contribution 12% of wages',
    evidence: 'PIB (MoLE) PRID 2311548, Sep-2026' }],
  'pf.eps_rate': [{ effective_from: '2014-09-01', value: 8.33, status: V,
    source: 'EPS share 8.33% of the employer 12%, on wages up to the ceiling',
    evidence: 'PIB (MoLE) PRID 2311548; EPFO Imphal via PIB PRID 2314111: "maximum contribution towards EPS shall be calculated at 8.33% of ₹25,000"' }],
  'pf.wage_ceiling': [
    { effective_from: '2014-09-01', value: 15000, status: U,
      source: 'EPF Scheme 1952 para 2(f) as amended w.e.f. 1-Sep-2014',
      evidence: 'Not re-checked in the primary-source pass; relevant only to months before 29-May-2026' },
    { effective_from: '2026-05-29', value: 15000, status: V,
      source: 'S.O. 2702(E), MoLE, Gazette of India Extraordinary No. 2609, 29-May-2026 — CoSS s.2(89), Chapter III',
      evidence: 'Gazette text read: "notifies rupees fifteen thousand (₹15,000) per month as the wage ceiling for the purposes of Chapter III"' },
    { effective_from: '2026-09-17', value: 25000, status: V,
      source: 'S.O. 5109(E), MoLE, Gazette of India Extraordinary No. 4918, 17-Sep-2026 — CoSS s.2(89); supersedes S.O. 2702(E)',
      evidence: 'Gazette text read: "₹25,000 per month as the wage ceiling for the purposes of Chapter III… with effect from the date of publication". No part-month or wage-month transition clause.' },
  ],
  // CoSS s.2(88) first proviso: where payments under exclusions (a)–(i) exceed
  // one-half of all remuneration, the excess is deemed wages. null = no deeming.
  'pf.wage_floor_pct': [
    { effective_from: '2014-09-01', value: null, status: U,
      source: 'EPF&MP Act 1952 s.2(b) basic wages — no deeming', evidence: 'Pre-Code; not re-checked' },
    { effective_from: '2025-11-21', value: 50, status: V,
      source: 'Code on Social Security 2020 s.2(88) first proviso; in effect 21-Nov-2025',
      evidence: 'Act text read (MoLE copy). MoLE FAQs on Labour Codes 16-Mar-2026, Q7: "The definition of wages has come into effect from 21.11.2025."' },
  ],
  // WHAT counts as "all remuneration" for the 50% test. The statute lists
  // exclusions (a)–(i) — including bonus (a) and employer PF/pension
  // contribution (c) — and MoLE FAQ (16-Mar-2026) answers that "statutory
  // components such as employer PF and pension contributions and statutory
  // bonus are included for arriving at 50%" while ESI and gratuity are not, and
  // that overtime forms part of it. The engine's original basis left employer
  // PF and bonus out. Both bases are implemented; the company chooses.
  'pf.wage_floor_basis': [
    { effective_from: '2014-09-01', value: 'gross_excl_employer_contributions', status: V,
      source: 'Not applicable before the Code — no 50% deeming', evidence: 'pf.wage_floor_pct is null before 21-Nov-2025, so the basis has no effect' },
    { effective_from: '2025-11-21', value: 'gross_excl_employer_contributions', status: D,
    options: ['gross_excl_employer_contributions', 'include_employer_pf_and_statutory_bonus'],
    source: 'CoSS s.2(88) proviso; MoLE FAQs 16-Mar-2026 (Code on Wages Q1)',
    evidence: 'MoLE FAQ includes employer PF/pension contribution and statutory bonus in the 50% computation; current default excludes them — decision required' },
  ],
  'pf.eps_age_limit': [{ effective_from: '2014-09-01', value: 58, status: V,
    source: 'EPS 1995 — pension contribution stops at 58; Code on Social Security 2020 s.2(82) proviso',
    evidence: 'Act text read (CoSS, Gazette copy): s.2(82) "Provided that for the purposes of Chapter III, the age of superannuation shall be fifty-eight years". ' +
      'NOT covered: EPS membership of new joiners above the wage ceiling (EPFO FAQ, pre-Code Rs 15,000) — Pulse has no per-employee EPS-membership field (PAYROLL_DATA_FLOW_AUDIT.md Part 6)' }],

  // ── ESI ───────────────────────────────────────────────────────────────────
  'esi.wage_threshold': [{ effective_from: '2017-01-01', value: 21000, status: V,
    source: 'ESI coverage wage limit Rs 21,000/month',
    evidence: 'MoLE FAQs on Labour Codes 16-Mar-2026, Q12: "At present, Rs 21,000 per month wages notified for ESI coverage will be applicable"' }],
  // Which wage the ESI coverage test and contribution use. MoLE FAQ Q12: "With
  // effect from 21.11.2025, the definition of wages under the CoSS, 2020 shall
  // apply" — i.e. Code wages, not gross pay. The engine's original basis was
  // gross pay; both are implemented and the company chooses.
  'esi.wage_basis': [
    { effective_from: '2017-01-01', value: 'gross', status: U,
      source: 'ESI Act 1948 s.2(22) wages (pre-Code)', evidence: 'Not re-checked in the primary-source pass' },
    { effective_from: '2025-11-21', value: 'gross', status: D,
    options: ['gross', 'code_wages'],
    source: 'CoSS s.2(88); MoLE FAQs 16-Mar-2026 Q12',
    evidence: 'MoLE FAQ points to Code wages; current default is gross pay — decision required (changes who is covered)' },
  ],
  // Both shares are "rounded to the next higher rupee" (r.19(1)) — payrollEngine.js.
  'esi.employee_rate': [
    { effective_from: '2019-07-01', value: 0.75, status: V,
      source: 'ESIC, esic.gov.in/contribution (reviewed 04-Apr-2025)',
      evidence: 'Page text: "the employee’s contribution rate (w.e.f. 01.07.2019) is 0.75% of the wages"' },
    { effective_from: '2026-05-08', value: 0.75, status: V,
      source: 'Social Security (Central) Rules 2026 r.19(1)(b), G.S.R. 344(E), 8-May-2026 (labour.gov.in copy)',
      evidence: 'Rule text read: "employee’s contribution, a sum (rounded to the next higher rupee) equal to three-fourth per cent. of the wages payable"' },
  ],
  'esi.employer_rate': [
    { effective_from: '2019-07-01', value: 3.25, status: V,
      source: 'ESIC, esic.gov.in/contribution (reviewed 04-Apr-2025)',
      evidence: 'Page text: "that of employer’s is 3.25% of the wages paid/payable"' },
    { effective_from: '2026-05-08', value: 3.25, status: V,
      source: 'Social Security (Central) Rules 2026 r.19(1)(a), G.S.R. 344(E), 8-May-2026 (labour.gov.in copy)',
      evidence: 'Rule text read: "employer’s contribution, a sum (rounded to the next higher rupee) equal to three and one-fourth per cent. of the wages payable"' },
  ],

  // ── Income tax on salary ──────────────────────────────────────────────────
  'tax.new': [{
    effective_from: '2025-04-01',
    value: { slabs: NEW_REGIME_SLABS_2025, standard_deduction: 75000, rebate_limit: 1200000, rebate_max: 60000, marginal_relief: true, cess_pct: 4 },
    status: U,
    source: 'Income-tax Act 2025 s.202 (tax year 2026-27) / Finance Act 2025',
    evidence: 'Act text read (Income-tax Act 2025 as enacted, e-Gazette 265620.pdf): s.202(1) table 4L/8L/12L/16L/20L/24L at nil/5/10/15/20/25/30%; ' +
      's.156(2) rebate 100% or ₹60,000 up to ₹12L with marginal relief above; s.19(1) Table Sl.2 standard deduction ₹75,000 under s.202(1); s.202(2)(a)(iv) no PT deduction. ' +
      'Cess 4%: Finance Bill 2026 cl.2 (as introduced). STILL UNVERIFIED — the ENACTED Finance Act 2026 / the Act "as amended by FA 2026" (incometaxindia.gov.in refuses scripted download; a person can download it)',
  }],
  'tax.old': [{
    effective_from: '2023-04-01',
    value: { slabs: OLD_REGIME_SLABS, standard_deduction: 50000, rebate_limit: 500000, rebate_max: 12500, marginal_relief: false, cess_pct: 4 },
    status: U,
    source: 'Optional regime — Income-tax Act 2025 s.202(4) option',
    evidence: 'Option under s.202(4) verified (Finance Bill 2026 Memorandum). s.156(1) ₹12,500 up to ₹5L and s.19 standard deduction ₹50,000: Act text read. ' +
      'Slabs 2.5L/5L/10L nil/5/20/30%: Finance Bill 2026 First Schedule Part III Para A(I) (as introduced) — enacted text not read. ' +
      'NOT MODELLED: senior-citizen slabs (₹3L at 60–79, ₹5L at 80+, Para A(II)/(III))',
  }],

  // ── Overtime ──────────────────────────────────────────────────────────────
  'ot.max_multiplier': [{ effective_from: '1948-04-01', value: 2, status: V,
    source: 'Factories Act 1948 s.59; OSH Code 2020 s.27 — twice the ordinary rate; MoLE Additional FAQs on Labour Codes 16-Mar-2026 Q24',
    evidence: 'FAQ text read: "a worker shall in respect of such overtime work be entitled to wages at the rate of twice the normal rate of wages". Eligibility (Q5: employees whose minimum wage is fixed under the Code on Wages) is not modelled' }],

  // ── State levies ──────────────────────────────────────────────────────────
  // A slab may carry month_pt: { <month 1-12>: amount } for a month that differs.
  'pt.slabs': [
    { effective_from: '2020-04-01', value: PT_SLABS, status: U,
      source: 'State PT Acts — table carried from engine v1', evidence: 'No state notification checked' },
    { effective_from: '2023-04-01', status: U,
      value: { ...PT_SLABS, KA: KA_PT_2023 },
      source: 'Karnataka Tax on Professions… (Amendment) Act 2023, DPAL 06 SHASANA 2023 (14-Mar-2023), Schedule entry 1',
      evidence: 'KA VERIFIED — Act schedule read (gst.karnataka.gov.in): "salary or wage… for a month is Rs. 25,000-00 and above: Rs. 200-00 per month"; ' +
        'ptax.karnataka.gov.in FAQ: below ₹25,000 exempt w.e.f. 01/04/2023. Other states NOT checked — rule stays unverified' },
    { effective_from: '2023-04-13', status: U,
      value: { ...PT_SLABS, KA: KA_PT_2023, TN: TN_ULB_PT_2023 },
      source: 'Tamil Nadu Urban Local Bodies Rules 2023 r.275(2) and r.277(2) (tnurbantree.tn.gov.in/wp-content/uploads/2023/07/Rules-2023.pdf), in force 13-Apr-2023',
      evidence: 'TN VERIFIED for urban local bodies — Rules text read: half-yearly table Nil ≤21,000 / 135 / 315 / 690 / 1,025 / 1,250 "till such time as the next general revision of tax is carried out by the Council"; ' +
        'deduction "from the respective pay bill for the month of August and January"; payment by 30 Sep / 31 Mar. Liability on the first day of the half-year: tnurbanepay.tn.gov.in/ProfessionalTax.pdf. ' +
        'NOT verified: whether the specific council has revised the table; village-panchayat rates. Other states not checked' },
    { effective_from: '2025-04-15', status: U,
      value: { ...PT_SLABS, KA: KA_PT_2025, TN: TN_ULB_PT_2023 },
      source: 'Karnataka Tax on Professions… (Amendment) Act 2025, DPAL 08 SHASANA 2025 (15-Apr-2025)',
      evidence: 'KA: Commercial Taxes Dept portal notice (ptax.karnataka.gov.in): "PT for Feb-2026 to be deducted at Rs. 300.00 per employee instead of Rs. 200.00 as per Notification No: DPAL 08 SHASANA 2025"; ' +
        'Act text itself not obtained. The 2026 Amendment Act (No. 22 of 2026) only adds return provisos. Other states NOT checked — rule stays unverified' },
  ],
  // months: [] = every month; otherwise only in the listed months.
  'lwf.rates': [
    { effective_from: '2020-04-01', status: U,
      value: { MH: { employee: 6, employer: 12, months: [6, 12] }, KA: { employee: 20, employer: 40, months: [12] }, TN: { employee: 10, employer: 20, months: [3, 9] } },
      source: 'State LWF Acts — table carried from engine v1, KA corrected to annual', evidence: 'No state notification checked' },
    { effective_from: '2022-12-02', status: U,
      value: { MH: { employee: 6, employer: 12, months: [6, 12] }, KA: { employee: 20, employer: 40, months: [12] }, TN: { employee: 20, employer: 40, months: [12] } },
      source: 'Tamil Nadu Labour Welfare Fund Rules 1973 r.11-A as amended by G.O. Ms. No. 161, Labour Welfare and Skill Development (G2), 2-Dec-2022 (TN Gazette Extraordinary No. 538)',
      evidence: 'TN amounts VERIFIED — Gazette text read (stationeryprinting.tn.gov.in/extraordinary/2022/538_Ex_III_1a.pdf): rule 11-A "rupees ten" → "rupees twenty" (employee; Government), "rupees twenty" → "rupees forty" (employer), in force on publication. ' +
        'NOT read in primary text (India Code / Board site refuse scripted access): r.12 timing (before 31 January; employee share from staff on the rolls on 31 December — December wage month assumed), employee exclusions (managerial; supervisors above a wage limit), coverage (shops 5+ persons). MH not checked' },
    { effective_from: '2025-01-10', status: U,
      value: { MH: { employee: 6, employer: 12, months: [6, 12] }, KA: { employee: 50, employer: 100, months: [12] }, TN: { employee: 20, employer: 40, months: [12] } },
      source: 'Karnataka LWF (Amendment) Act 2024, DPAL 60 SHASANA 2024 (10-Jan-2025) — new s.7A',
      evidence: 'KA amounts VERIFIED — KLWB press note 05-12-2025 (klwb.karnataka.gov.in, scanned, read): ₹50 per worker + ₹100 employer for calendar year 2025, paid 1–15 January. ' +
        'NOT verified: the wage month of the deduction (December assumed) and applicability (commercial/IT establishments need 50+ employees). MH/TN not checked' },
  ],
};

export const RULE_KEYS = Object.keys(BUILT_IN_RULES);

/**
 * Shape of a half-yearly PT entry ({ basis: 'half_year', deduct_months, slabs }).
 * Nothing is defaulted: the deduction months and every slab must be given.
 * Slabs start at 0, are contiguous (next min = previous max + 1), end open
 * (max null), and carry a non-negative tax.
 */
export function halfYearPtProblems(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['must be an object { basis, deduct_months, slabs }'];
  const p = [];
  if (e.basis !== 'half_year') p.push("basis must be 'half_year'");
  if (!Array.isArray(e.deduct_months) || !e.deduct_months.length || e.deduct_months.some(m => !Number.isInteger(m) || m < 1 || m > 12)) {
    p.push('deduct_months must list the pay-bill months (1–12) in which the half-year tax is deducted');
  }
  const sl = e.slabs;
  if (!Array.isArray(sl) || !sl.length) { p.push('slabs must be a non-empty list'); return p; }
  if (sl[0]?.min !== 0) p.push('the first slab must start at 0');
  sl.forEach((s, i) => {
    if (!s || typeof s !== 'object') { p.push(`slab ${i + 1} is not an object`); return; }
    if (!(Number.isFinite(s.pt) && s.pt >= 0)) p.push(`slab ${i + 1}: pt must be a number ≥ 0`);
    const last = i === sl.length - 1;
    if (last && s.max != null) p.push('the last slab must be open-ended (max null)');
    if (!last && !(Number.isFinite(s.max) && s.max >= s.min)) p.push(`slab ${i + 1}: max must be a number ≥ min`);
    if (!last && sl[i + 1]?.min !== s.max + 1) p.push(`slab ${i + 2} must start at ${s.max + 1}`);
  });
  return p;
}

/**
 * A village panchayat's PT table recorded by the company: a half-yearly entry
 * that DECLARES itself as that panchayat's (local_body / local_body_name), so
 * an urban table can never be used for a panchayat by accident.
 */
export function panchayatPtProblems(e, settingsName) {
  const p = halfYearPtProblems(e);
  if (e?.local_body !== 'village_panchayat') p.push("local_body must be 'village_panchayat' (the table must declare whose rates it is)");
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm(e?.local_body_name)) p.push('local_body_name is required');
  else if (norm(e.local_body_name) !== norm(settingsName)) p.push(`local_body_name "${e.local_body_name}" does not match Payroll Settings → PT local body name "${settingsName || ''}"`);
  return p;
}

const toDateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const PRIORITY = { company: 3, global: 2, 'built-in': 1 };

/**
 * Resolve every rule for a date.
 * @param {string|Date} onDate      'YYYY-MM-DD' — the last day of the wage period
 * @param {Array}       dbVersions  rows from payroll_statutory_rules
 * @returns {{ values, applied }} applied[key] = { effective_from, source,
 *          origin, status, evidence } — the version that answered.
 */
export function resolveRules(onDate, dbVersions = []) {
  const date = toDateStr(onDate);
  const values = {};
  const applied = {};
  for (const key of RULE_KEYS) {
    const candidates = [
      ...BUILT_IN_RULES[key].map(v => ({ ...v, origin: 'built-in' })),
      ...dbVersions
        .filter(r => r.rule_key === key)
        .map(r => ({
          effective_from: toDateStr(r.effective_from),
          value: r.value,
          source: r.source_reference,
          origin: r.company_id == null ? 'global' : 'company',
          // A recorded version is an authorised person's confirmation.
          status: V,
          evidence: `Recorded by user ${r.created_by ?? '?'}: ${r.source_reference}`,
        })),
    ].filter(v => v.effective_from <= date);
    candidates.sort((a, b) =>
      a.effective_from === b.effective_from
        ? PRIORITY[b.origin] - PRIORITY[a.origin]
        : (a.effective_from < b.effective_from ? 1 : -1));
    const win = candidates[0];
    if (!win) throw new Error(`No statutory rule '${key}' in force on ${date}`);
    values[key] = win.value;
    applied[key] = {
      effective_from: win.effective_from, source: win.source || null, origin: win.origin,
      status: win.status || U, evidence: win.evidence || null, options: win.options || null,
    };
  }
  return { values, applied };
}

/** The value of ONE rule in force on a date, or undefined if none yet. */
export function resolveRule(key, onDate, dbVersions = []) {
  const date = toDateStr(onDate);
  const c = versionsOf(key, dbVersions).filter(v => v.effective_from <= date)
    .sort((a, b) => (a.effective_from === b.effective_from ? PRIORITY[b.origin] - PRIORITY[a.origin] : (a.effective_from < b.effective_from ? 1 : -1)));
  return c[0]?.value;
}

/** All versions of every rule (built-in + DB), for transition checks. */
export function versionsOf(key, dbVersions = []) {
  return [
    ...BUILT_IN_RULES[key].map(v => ({ ...v, origin: 'built-in' })),
    ...dbVersions.filter(r => r.rule_key === key).map(r => ({
      effective_from: toDateStr(r.effective_from), value: r.value, origin: r.company_id == null ? 'global' : 'company',
      status: V, source: r.source_reference,
    })),
  ];
}

export async function loadRuleRows(pool, companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT rule_key, effective_from, value, company_id, source_reference, created_by
         FROM payroll_statutory_rules
        WHERE company_id IS NULL OR company_id = $1`,
      [companyId ?? null]
    );
    return rows;
  } catch (e) {
    // Table missing (migration not yet run) → built-ins only, never a guess.
    if (e.code !== '42P01') throw e;
    return [];
  }
}

/** Load DB versions for a company (its own + global) and resolve. */
export async function loadRules(pool, companyId, onDate) {
  return resolveRules(onDate, await loadRuleRows(pool, companyId));
}
