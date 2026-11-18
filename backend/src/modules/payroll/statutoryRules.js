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
// Finance Act 2026, First Schedule Part III Paragraph A items (II) and (III):
// residents aged 60–79 / 80 and over at any time in the tax year (old regime).
const OLD_REGIME_AGE_SLABS = [
  { min_age: 60, slabs: [{ min: 0, max: 300000, rate: 0 }, { min: 300000, max: 500000, rate: 0.05 }, { min: 500000, max: 1000000, rate: 0.20 }, { min: 1000000, max: null, rate: 0.30 }] },
  { min_age: 80, slabs: [{ min: 0, max: 500000, rate: 0 }, { min: 500000, max: 1000000, rate: 0.20 }, { min: 1000000, max: null, rate: 0.30 }] },
];
// Paragraph F Table 1 (individuals): rate of surcharge by total income. Income
// under s.202 (the new regime) stops at 25% (s.2(12)(b) Table, Sl. No. 10).
const SURCHARGE_OLD_2026 = [{ min: 5000000, rate: 10 }, { min: 10000000, rate: 15 }, { min: 20000000, rate: 25 }, { min: 50000000, rate: 37 }];
const SURCHARGE_NEW_2026 = [{ min: 5000000, rate: 10 }, { min: 10000000, rate: 15 }, { min: 20000000, rate: 25 }];

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

const V = 'verified', U = 'unverified', D = 'decision_required', S = 'company_setting';

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

  // Employer-only PF charges. Company settings: they never change an employee's
  // pay and never block approval, but they are part of what is remitted to EPFO.
  'pf.edli_rate': [{ effective_from: '2014-09-01', value: 0.5, status: S,
    source: 'EDLI employer contribution 0.5% of wages up to the ceiling',
    evidence: 'Published EPFO rate summaries and adviser notes (2026); confirm against the current EPFO rate sheet' }],
  'pf.admin_rate': [{ effective_from: '2018-06-01', value: 0.5, status: S,
    source: 'EPF administrative charge 0.5% of EPF wages',
    evidence: 'Published EPFO rate summaries and adviser notes (2026); confirm against the current EPFO rate sheet' }],
  'pf.admin_min_monthly': [{ effective_from: '2018-06-01', value: 500, status: S,
    source: 'EPF administrative charge: minimum per establishment per month',
    evidence: 'Adviser notes (2026); confirm against the current EPFO rate sheet' }],

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
      'Cess 4%: Finance Bill 2026 cl.2 (as introduced). STILL UNVERIFIED for this version — tax years before 2026-27 were not re-read',
  }, {
    effective_from: '2026-04-01',
    value: { slabs: NEW_REGIME_SLABS_2025, standard_deduction: 75000, rebate_limit: 1200000, rebate_max: 60000, marginal_relief: true, cess_pct: 4, surcharge: SURCHARGE_NEW_2026 },
    status: V,
    source: 'Income-tax Act 2025 s.202(1), s.156(2), s.19(1) (Act 30 of 2025); Finance Act 2026 (No. 4 of 2026), Gazette of India Extraordinary Part II Section 1 No. 9, 30-Mar-2026 (CG-DL-E-31032026-271439) s.2(16)',
    evidence: 'Act text read (e-Gazette 265620.pdf): s.202(1) table, s.156(2) rebate, s.19(1) standard deduction. Enacted Finance Act 2026 read (e-Gazette 271439.pdf): s.2(16) cess 4%; s.56 omits only s.202(2)(a)(iii) (s.144), and no clause amends s.19 or s.156. ' +
      'Surcharge (2026-11-09): enacted text read (271439.pdf p.25–26, s.2(12)(b) Table Sl. No. 10, income under s.202): 10% above ₹50,00,000, 15% above ₹1,00,00,000, 25% above ₹2,00,00,000; marginal relief per Part III Paragraph F Table 2. No amending Act after 30-Mar-2026 was searched for',
  }],
  'tax.old': [{
    effective_from: '2023-04-01',
    value: { slabs: OLD_REGIME_SLABS, standard_deduction: 50000, rebate_limit: 500000, rebate_max: 12500, marginal_relief: false, cess_pct: 4 },
    status: U,
    source: 'Optional regime — Income-tax Act 2025 s.202(4) option',
    evidence: 'Option under s.202(4) verified (Finance Bill 2026 Memorandum). s.156(1) ₹12,500 up to ₹5L and s.19 standard deduction ₹50,000: Act text read. ' +
      'Slabs 2.5L/5L/10L nil/5/20/30%: Finance Bill 2026 First Schedule Part III Para A(I) (as introduced) — enacted text not read. ' +
      'NOT MODELLED: senior-citizen slabs (₹3L at 60–79, ₹5L at 80+, Para A(II)/(III)). Tax years before 2026-27 were not re-read',
  }, {
    effective_from: '2026-04-01',
    value: { slabs: OLD_REGIME_SLABS, standard_deduction: 50000, rebate_limit: 500000, rebate_max: 12500, marginal_relief: false, cess_pct: 4, surcharge: SURCHARGE_OLD_2026, age_slabs: OLD_REGIME_AGE_SLABS },
    status: V,
    source: 'Finance Act 2026 (No. 4 of 2026), Gazette of India Extraordinary Part II Section 1 No. 9, 30-Mar-2026 (CG-DL-E-31032026-271439), First Schedule Part III Para A(I); Income-tax Act 2025 s.202(4), s.156(1), s.19',
    evidence: 'Enacted text read (e-Gazette 271439.pdf): Part III Para A(I) nil to ₹2,50,000, 5% to ₹5,00,000, 20% to ₹10,00,000, 30% above; s.2(16) cess 4%; no clause amends s.19 or s.156. Act text read (265620.pdf): s.156(1), s.19. ' +
      'Senior-citizen slabs and surcharge (2026-11-09): enacted text read (271439.pdf p.96–100, Part III Paragraph A items (II)–(III) and Paragraph F Tables 1–2): 60–79 nil to ₹3,00,000; 80+ nil to ₹5,00,000; surcharge 10% / 15% / 25% / 37% above ₹50L / ₹1Cr / ₹2Cr / ₹5Cr with marginal relief. No amending Act after 30-Mar-2026 was searched for',
  }],

  // ── Perquisites ───────────────────────────────────────────────────────────
  // A loan below the benchmark rate is taxable (Income-tax Rules 2026, rule 15
  // Table IV): the SBI rate on 1 April for that kind of loan. Its rates change
  // each year, so they are the company's entry. Blocks approval only for a
  // payroll that has such a loan (payroll.service.js periodReadiness).
  'perq.loan': [{ effective_from: '2014-04-01', status: U,
    value: { exempt_limit: 20000, sbi_rates: { loan: null, advance: null } },
    source: 'Income-tax Rules 1962, rule 3(7)(i) — interest-free or concessional loans',
    evidence: 'Not re-read: SBI rate on 1 April less the rate charged; nil when loans total ₹20,000 or less; medical loans exempt' },
  { effective_from: '2026-04-01', status: U,
    value: { exempt_limit: 200000, sbi_rates: { loan: null, advance: null } },
    source: 'Income-tax Rules 2026, rule 15 Table IV — interest-free or concessional loans',
    evidence: 'Secondary sources only (Vialto, Khaitan & Co, Taxscan, Mar–Apr 2026): perquisite = SBI rate on 1 April for the same kind of loan, on the maximum monthly balance, less interest charged; nil when loans total ₹2,00,000 or less; medical loans exempt. Rules text not read. Enter the SBI rates for this tax year with their source' }],

  // ── Overtime ──────────────────────────────────────────────────────────────
  'ot.max_multiplier': [{ effective_from: '1948-04-01', value: 2, status: V,
    source: 'Factories Act 1948 s.59; OSH Code 2020 s.27 — twice the ordinary rate; MoLE Additional FAQs on Labour Codes 16-Mar-2026 Q24',
    evidence: 'FAQ text read: "a worker shall in respect of such overtime work be entitled to wages at the rate of twice the normal rate of wages". Eligibility (Q5: employees whose minimum wage is fixed under the Code on Wages) is not modelled' }],

  // The lowest full-month gross the company may pay for its scheduled employment.
  // Null = not recorded: a warning on the release check, not a blocker. It is a
  // figure from the State notification for the company's own schedule.
  'wages.minimum_monthly': [{ effective_from: '2020-04-01', value: null, status: S,
    source: 'No minimum wage recorded', evidence: 'Enter the figure from the notification for your scheduled employment' }],

  // ── Bonus ─────────────────────────────────────────────────────────────────
  // Company settings, not statutory confirmations: they never block approval
  // (COMPANY_SETTING_KEYS). The figures below feed the statutory bonus report only.
  'bonus.statutory': [{ effective_from: '2020-04-01', status: S,
    value: { wage_eligibility: 21000, calc_ceiling: 7000, min_pct: 8.33, max_pct: 20 },
    source: 'Figures carried unchanged from the statutory bonus report',
    evidence: 'Not checked against a primary source. Settlement rule settlement.bonus holds its own figures for a final settlement' }],
  // Paid through monthly payroll in the listed months. type: fixed (rupees),
  // pct_basic or pct_gross (percent of the month's earned Basic or regular gross).
  'bonus.plans': [{ effective_from: '2020-04-01', status: S,
    value: { plans: [] },
    source: 'No bonus plan recorded', evidence: 'The company enters its own plans' }],
  // Yearly sales incentive (modules/sales/salesIncentive.service.js). Each salesperson's
  // yearly target is set in Sales → Targets; at the end of the financial year the
  // achievement % picks one slab. type: pct_salary (% of the year's Basic or gross,
  // salary_basis), pct_sales (% of the sales achieved) or fixed (rupees).
  // pay_month: the payroll month it is normally added to (4 = April, after March).
  'incentive.sales': [{ effective_from: '2020-04-01', status: S,
    value: { salary_basis: 'basic', pay_month: 4, slabs: [] },
    source: 'No incentive slabs recorded', evidence: 'The company enters its own slabs' }],

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

// The company's own settings: never a release blocker, whatever their status.
export const COMPANY_SETTING_KEYS = ['bonus.statutory', 'bonus.plans', 'incentive.sales', 'pf.edli_rate', 'pf.admin_rate', 'pf.admin_min_monthly', 'wages.minimum_monthly'];
export const BONUS_PLAN_TYPES = ['fixed', 'pct_basic', 'pct_gross'];
export const INCENTIVE_SLAB_TYPES = ['pct_salary', 'pct_sales', 'fixed'];

/** The values a decision rule may take, or null when the rule is not a choice. */
export function decisionOptions(key) {
  return BUILT_IN_RULES[key]?.find(v => v.options)?.options ?? null;
}

// jsonb does not keep key order, so a recorded value is compared by content.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
export const sameValue = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const NUMBER_RULES = {
  'pf.employee_rate': { max: 100 }, 'pf.employer_rate': { max: 100 }, 'pf.eps_rate': { max: 100 },
  'pf.wage_ceiling': { min: 1 }, 'pf.wage_floor_pct': { max: 100, nullable: true }, 'pf.eps_age_limit': { min: 1, max: 120 },
  'esi.wage_threshold': { min: 1 }, 'esi.employee_rate': { max: 100 }, 'esi.employer_rate': { max: 100 },
  'ot.max_multiplier': { min: 1, max: 10 },
  'pf.edli_rate': { max: 100 }, 'pf.admin_rate': { max: 100 }, 'pf.admin_min_monthly': {},
  'wages.minimum_monthly': { nullable: true },
};
const isAmount = (n) => Number.isFinite(n) && n >= 0;

// Bands start at 0 and end open. Tax bands share their boundary (next min = max);
// PT bands are whole rupees (next min = max + 1).
function bandProblems(slabs, step, amountOk, amountName) {
  if (!Array.isArray(slabs) || !slabs.length) return ['needs at least one band'];
  const p = [];
  if (slabs[0]?.min !== 0) p.push('the first band must start at 0');
  slabs.forEach((s, i) => {
    if (!s || typeof s !== 'object') { p.push(`band ${i + 1} is not an object`); return; }
    if (!amountOk(s[amountName])) p.push(`band ${i + 1}: ${amountName} is not valid`);
    const last = i === slabs.length - 1;
    if (last && s.max != null) p.push('the last band must have no upper limit');
    if (!last && !(Number.isFinite(s.max) && s.max > s.min)) p.push(`band ${i + 1}: the upper limit must be above where the band starts`);
    if (!last && slabs[i + 1]?.min !== s.max + step) p.push(`band ${i + 2} must start at ${s.max + step}`);
  });
  return p;
}

/**
 * What is wrong with a value someone typed, as messages. Values reach the engine
 * unchecked, where NaN or a gap between bands silently produces wrong pay.
 */
export function ruleValueProblems(key, v) {
  const options = decisionOptions(key);
  if (options) return options.includes(v) ? [] : [`must be one of: ${options.join(', ')}`];
  const num = NUMBER_RULES[key];
  if (num) {
    if (v === null && num.nullable) return [];
    const lo = num.min ?? 0;
    if (!Number.isFinite(v) || v < lo || (num.max != null && v > num.max)) return [`must be a number from ${lo}${num.max != null ? ` to ${num.max}` : ' upward'}`];
    return [];
  }
  const isObject = v && typeof v === 'object' && !Array.isArray(v);
  if (key === 'bonus.statutory') {
    if (!isObject) return ['must be an object'];
    const p = [];
    for (const f of ['wage_eligibility', 'calc_ceiling']) if (!(isAmount(v[f]) && v[f] > 0)) p.push(`${f} must be a number above 0`);
    for (const f of ['min_pct', 'max_pct']) if (!(isAmount(v[f]) && v[f] <= 100)) p.push(`${f} must be a number from 0 to 100`);
    if (!p.length && v.min_pct > v.max_pct) p.push('min_pct cannot be above max_pct');
    return p;
  }
  if (key === 'bonus.plans') {
    if (!isObject || !Array.isArray(v.plans)) return ['must be an object with a list of plans'];
    const names = new Set();
    return v.plans.flatMap((plan, i) => {
      const name = String(plan?.name ?? '').trim(), at = `plan ${i + 1}`, p = [];
      if (!name) p.push(`${at}: name is required`);
      else if (names.has(name.toLowerCase())) p.push(`${at}: the name "${name}" is used twice`);
      names.add(name.toLowerCase());
      if (!BONUS_PLAN_TYPES.includes(plan?.type)) p.push(`${at}: type must be one of ${BONUS_PLAN_TYPES.join(', ')}`);
      if (!isAmount(plan?.amount)) p.push(`${at}: amount must be a number of 0 or more`);
      else if (plan.type !== 'fixed' && plan.amount > 100) p.push(`${at}: a percentage cannot be above 100`);
      if (!Array.isArray(plan?.months) || !plan.months.length || plan.months.some(m => !Number.isInteger(m) || m < 1 || m > 12)) p.push(`${at}: months must list the pay months from 1 to 12`);
      if (typeof plan?.active !== 'boolean') p.push(`${at}: active must be yes or no`);
      // Optional, for a final settlement (settlementEngine festivalBonusLines).
      for (const f of ['prorate_on_exit', 'counts_as_statutory']) if (plan?.[f] != null && typeof plan[f] !== 'boolean') p.push(`${at}: ${f} must be yes or no`);
      if (plan?.min_service_months != null && !(Number.isInteger(plan.min_service_months) && plan.min_service_months >= 0 && plan.min_service_months <= 120)) p.push(`${at}: minimum service must be whole months from 0 to 120`);
      return p;
    });
  }
  if (key === 'incentive.sales') {
    if (!isObject || !Array.isArray(v.slabs)) return ['must be an object with a list of slabs'];
    const p = [];
    if (!['basic', 'gross'].includes(v.salary_basis)) p.push('salary_basis must be basic or gross');
    if (!(Number.isInteger(v.pay_month) && v.pay_month >= 1 && v.pay_month <= 12)) p.push('pay_month must be a month from 1 to 12');
    const sorted = [...v.slabs].sort((a, b) => Number(a?.from_pct) - Number(b?.from_pct));
    sorted.forEach((sl, i) => {
      const at = `slab ${i + 1}`;
      if (!(isAmount(sl?.from_pct) && sl.from_pct <= 1000)) p.push(`${at}: from % must be a number from 0 to 1000`);
      if (sl?.to_pct != null && !(isAmount(sl.to_pct) && sl.to_pct > sl.from_pct)) p.push(`${at}: to % must be above from %, or blank for no upper limit`);
      if (!INCENTIVE_SLAB_TYPES.includes(sl?.type)) p.push(`${at}: type must be one of ${INCENTIVE_SLAB_TYPES.join(', ')}`);
      if (!isAmount(sl?.amount)) p.push(`${at}: amount must be a number of 0 or more`);
      else if (sl.type !== 'fixed' && sl.amount > 100) p.push(`${at}: a percentage cannot be above 100`);
      const nxt = sorted[i + 1];
      if (nxt && (sl?.to_pct == null || Number(sl.to_pct) > Number(nxt.from_pct))) p.push(`${at} overlaps slab ${i + 2}`);
    });
    return p;
  }
  if (key === 'perq.loan') {
    if (!isObject) return ['must be an object'];
    const p = [];
    if (!isAmount(v.exempt_limit)) p.push('exempt_limit must be a number of 0 or more');
    for (const k of ['loan', 'advance']) {
      const r = v.sbi_rates?.[k];
      if (r != null && !(isAmount(r) && r <= 100)) p.push(`sbi_rates.${k} must be a percentage from 0 to 100, or empty`);
    }
    return p;
  }
  if (key === 'tax.new' || key === 'tax.old') {
    if (!isObject) return ['must be an object'];
    const p = bandProblems(v.slabs, 0, r => Number.isFinite(r) && r >= 0 && r <= 1, 'rate');
    if (v.surcharge != null && (!Array.isArray(v.surcharge) || v.surcharge.some(b => !isAmount(b?.min) || !(isAmount(b?.rate) && b.rate <= 100)))) p.push('surcharge must be a list of { min, rate } bands');
    if (v.age_slabs != null && (!Array.isArray(v.age_slabs) || v.age_slabs.some(b => !Number.isInteger(b?.min_age) || bandProblems(b.slabs, 0, r => Number.isFinite(r) && r >= 0 && r <= 1, 'rate').length))) p.push('age_slabs must list { min_age, slabs } with valid slabs');
    for (const f of ['standard_deduction', 'rebate_limit', 'rebate_max']) if (!isAmount(v[f])) p.push(`${f} must be a number of 0 or more`);
    if (!(isAmount(v.cess_pct) && v.cess_pct <= 100)) p.push('cess_pct must be a number from 0 to 100');
    if (typeof v.marginal_relief !== 'boolean') p.push('marginal_relief must be yes or no');
    return p;
  }
  if (key === 'pt.slabs') {
    if (!isObject) return ['must be an object keyed by state code'];
    return Object.entries(v).flatMap(([state, e]) =>
      (Array.isArray(e) ? bandProblems(e, 1, isAmount, 'pt') : halfYearPtProblems(e)).map(m => `${state}: ${m}`));
  }
  if (key === 'lwf.rates') {
    if (!isObject) return ['must be an object keyed by state code'];
    return Object.entries(v).flatMap(([state, e]) => {
      const p = [];
      if (!isAmount(e?.employee)) p.push('employee must be a number of 0 or more');
      if (!isAmount(e?.employer)) p.push('employer must be a number of 0 or more');
      if (!Array.isArray(e?.months) || e.months.some(m => !Number.isInteger(m) || m < 1 || m > 12)) p.push('months must list wage months from 1 to 12');
      return p.map(m => `${state}: ${m}`);
    });
  }
  return [];
}

// What is still unconfirmed in a state-wide table, by state. The version-level
// evidence narrates whichever state changed last, which tells a company in
// another state nothing about what it must check. Status stays per version:
// these only say what the blocker asks this company to confirm.
export const STATE_RULE_GAPS = {
  'pt.slabs': {
    TN: 'Tamil Nadu: the urban table is read from the Urban Local Bodies Rules 2023 r.275(2) and applies "till such time as the next general revision of tax is carried out by the Council". Confirm with your municipality that its council has not revised the table.',
    KA: 'Karnataka: the February ₹300 rate is from a Commercial Taxes portal notice citing DPAL 08 SHASANA 2025; the Amendment Act text itself was not obtained.',
  },
  'lwf.rates': {
    TN: 'Tamil Nadu: ₹20 employee / ₹40 employer read from G.O. Ms. No. 161 of 2-Dec-2022 (r.11-A). Rule 12 was NOT read: Pulse deducts in December wages, assuming payment by 31 January, while at least one published reading of r.12 says payment is due by 31 July on June wages. Confirm the wage month, the employee exclusions and coverage from the Rules or the Labour Welfare Board.',
    KA: 'Karnataka: ₹50 / ₹100 read from the KLWB press note of 05-12-2025. Not verified: the wage month of the deduction (December assumed) and applicability (commercial/IT establishments need 50+ employees).',
  },
};

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
      `SELECT rule_key, effective_from, value, company_id, source_reference, created_by, created_at
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
