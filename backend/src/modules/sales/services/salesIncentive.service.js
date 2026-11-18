/**
 * salesIncentive.service.js — yearly sales target, achievement and incentive.
 *
 * TARGET    Sales → Targets: one ANNUAL row per salesperson per financial year
 *           (sales_targets.period_type = 'annual', period_year = the FY's first year,
 *           so 2026 = Apr 2026 – Mar 2027). Each person's target is set separately;
 *           nothing is raised automatically from last year. A MONTHLY row for a month
 *           of that year, when one exists, is that month's target; the months without
 *           one share what is left of the yearly target equally.
 * ACHIEVED  Worked out from sales orders, never typed: the orders the person created
 *           (sales_orders.created_by is a users.id → users.employee_id), in a status
 *           that counts as a sale, by order date, at the value before GST (subtotal).
 * INCENTIVE Payroll Center → Settings → Sales incentive ('incentive.sales'): slabs on
 *           the achievement %. One slab applies to the whole year:
 *             pct_salary  % of the year's salary (12 × the full-month Basic or gross
 *                         in force at the end of the year — salary_basis)
 *             pct_sales   % of the sales achieved
 *             fixed       rupees
 *           Paid once a year: Payroll adds it as a one-time earning ("Sales incentive
 *           FY 2026-27") in the month chosen, normally April. It then goes through the
 *           month's approval like any other earning.
 */
import pool from '../../../config/db.js';
import { computePayroll } from '../../payroll/payrollEngine.js';
import { fetchPayrollSettings, PayrollHttpError } from '../../payroll/payroll.service.js';
import { loadRuleRows, resolveRules } from '../../payroll/statutoryRules.js';
import { addAdjustment } from '../../payroll/payrollAdjustments.service.js';

/** Order statuses that count as a sale achieved. */
export const ACHIEVED_STATUSES = ['confirmed', 'dispatched', 'delivered', 'invoiced', 'completed'];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(num(n));
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today's date in the business time zone, as YYYY-MM-DD. */
export function businessToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }).format(now);
}
/** The financial year (its first calendar year) a date falls in. */
export function fyOf(isoDate) {
  const y = Number(isoDate.slice(0, 4)), m = Number(isoDate.slice(5, 7));
  return m >= 4 ? y : y - 1;
}
export const fyLabel = (fy) => `FY ${fy}-${String(fy + 1).slice(2)}`;
/** The 12 months of a financial year, April first. */
export function fyMonths(fy) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1, y = m >= 4 ? fy : fy + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { month: m, year: y, label: `${MONTHS[m - 1]} ${y}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}`, days: last };
  });
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** The slab an achievement % falls in: from_pct inclusive, to_pct exclusive (blank = no limit). */
export function slabFor(pct, slabs = []) {
  const sorted = [...(slabs || [])].sort((a, b) => num(a.from_pct) - num(b.from_pct));
  return sorted.find((s) => pct >= num(s.from_pct) && (s.to_pct == null || pct < num(s.to_pct))) || null;
}

/** What one slab pays. annualSalary is null when no salary is on record. */
export function incentiveAmount(slab, { achieved, annualSalary }) {
  if (!slab) return { amount: 0, basis: 'No slab covers this achievement.' };
  if (slab.type === 'fixed') return { amount: round(slab.amount), basis: `Fixed ₹${round(slab.amount).toLocaleString('en-IN')}.` };
  if (slab.type === 'pct_sales') return { amount: round((achieved * num(slab.amount)) / 100), basis: `${slab.amount}% of sales ₹${round(achieved).toLocaleString('en-IN')}.` };
  if (annualSalary == null) return { amount: 0, basis: 'No salary is on record, so a % of salary cannot be worked out.' };
  return { amount: round((annualSalary * num(slab.amount)) / 100), basis: `${slab.amount}% of the year's salary ₹${round(annualSalary).toLocaleString('en-IN')}.` };
}

/** The company's incentive setting in force on a date. */
export async function incentiveRule(companyId, onDate) {
  const rows = await loadRuleRows(pool, companyId);
  return resolveRules(onDate, rows).values['incentive.sales'] || { salary_basis: 'basic', pay_month: 4, slabs: [] };
}

/** Sales achieved per employee and month inside [from, to]. Map employeeId → Map 'YYYY-MM' → amount. */
async function achievedByMonth(companyId, from, to, employeeIds = null) {
  const { rows } = await pool.query(
    `SELECT u.employee_id, to_char(so.order_date, 'YYYY-MM') AS ym, SUM(COALESCE(so.subtotal, so.total_amount, 0)) AS amount
       FROM sales_orders so
       JOIN users u ON u.id = so.created_by
      WHERE so.company_id = $1 AND so.deleted_at IS NULL
        AND LOWER(so.order_status) = ANY($2::text[])
        AND so.order_date BETWEEN $3::date AND $4::date
        AND u.employee_id IS NOT NULL
        AND ($5::int[] IS NULL OR u.employee_id = ANY($5::int[]))
      GROUP BY 1, 2`,
    [companyId, ACHIEVED_STATUSES, from, to, employeeIds]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.employee_id)) out.set(r.employee_id, new Map());
    out.get(r.employee_id).set(r.ym, num(r.amount));
  }
  return out;
}

/** Annual and monthly targets of a financial year. Map employeeId → { annual, monthly: Map month → amount }. */
async function targetsFor(companyId, fy, employeeIds = null) {
  const { rows } = await pool.query(
    `SELECT owner_id, LOWER(period_type) AS period_type, period_value, target_amount, id
       FROM sales_targets
      WHERE company_id = $1 AND period_year = $2 AND owner_id IS NOT NULL
        AND LOWER(period_type) IN ('annual', 'monthly')
        AND ($3::int[] IS NULL OR owner_id = ANY($3::int[]))
      ORDER BY updated_at DESC NULLS LAST, id DESC`,
    [companyId, fy, employeeIds]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.owner_id)) out.set(r.owner_id, { annual: null, annual_id: null, monthly: new Map() });
    const t = out.get(r.owner_id);
    if (r.period_type === 'annual') { if (t.annual == null) { t.annual = num(r.target_amount); t.annual_id = r.id; } }
    else if (!t.monthly.has(Number(r.period_value))) t.monthly.set(Number(r.period_value), num(r.target_amount));
  }
  return out;
}

/** Month-by-month targets: a month's own target, else an equal share of what is left of the year. */
export function monthlyPlan(fy, annual, monthlyOverrides = new Map()) {
  const months = fyMonths(fy);
  const fixed = months.filter((m) => monthlyOverrides.has(m.month));
  const fixedTotal = fixed.reduce((s, m) => s + monthlyOverrides.get(m.month), 0);
  const rest = months.length - fixed.length;
  const share = annual != null && rest > 0 ? Math.max(0, annual - fixedTotal) / rest : 0;
  return months.map((m) => ({ ...m, target: round(monthlyOverrides.has(m.month) ? monthlyOverrides.get(m.month) : share) }));
}

/** 12 × the full-month Basic or regular gross in force on a date, or null with no salary on record. */
async function annualSalary(companyId, employeeId, onDate, basis) {
  const { rows: [e] } = await pool.query(
    `SELECT e.id, e.office_id, e.dob, e.basic_salary AS master_basic,
            (SELECT b.state FROM branches b WHERE b.id = e.branch_id) AS state,
            (SELECT c.state FROM companies c WHERE c.id = e.company_id) AS work_state,
            esa.basic_salary, esa.breakdown, COALESCE(ss.components, ds.components) AS components
       FROM employees e
       LEFT JOIN LATERAL (SELECT basic_salary, structure_id, breakdown FROM employee_salary_assignments
                           WHERE employee_id = e.id AND effective_from <= $2::date
                           ORDER BY effective_from DESC, created_at DESC LIMIT 1) esa ON true
       LEFT JOIN salary_structures ss ON ss.id = esa.structure_id
       LEFT JOIN LATERAL (SELECT components FROM salary_structures
                           WHERE is_default = true AND (company_id = $3 OR company_id IS NULL)
                           ORDER BY company_id NULLS LAST, id LIMIT 1) ds ON true
      WHERE e.id = $1 AND e.company_id = $3`,
    [employeeId, onDate, companyId]);
  const basic = num(e?.basic_salary) || num(e?.master_basic);
  if (!e || !(basic > 0)) return null;
  if (basis === 'basic') return basic * 12;
  const month = Number(onDate.slice(5, 7)), year = Number(onDate.slice(0, 4));
  const settings = await fetchPayrollSettings(companyId);
  const rules = resolveRules(onDate, await loadRuleRows(pool, companyId)).values;
  const slip = computePayroll(
    { id: e.id, office_id: e.office_id, basic_salary: basic, dob: e.dob, state: e.state, work_state: e.work_state, revision_breakdown: e.breakdown ?? null, joining_date: null, exit_date: null },
    { ...settings, month, year, rules, structureComponents: e.components ?? null, recoveries: [], arrears: null, lop_days: 0, bonus_plans: null, bonus: 0 });
  const regular = num(slip.gross) - num(slip.bonus) - num(slip.overtime_pay) - num(slip.arrears_amount) - num(slip.night_shift_allowance) - num(slip.other_earnings);
  return regular > 0 ? regular * 12 : null;
}

/**
 * One person's yearly target view: the year split by month with what was achieved,
 * the days left, and what the incentive would be on the sales so far.
 * Returns null when the person has no annual target for the year.
 */
export async function targetView({ companyId, employeeId, fy = null, today = businessToday() }) {
  const year = fy ?? fyOf(today);
  const targets = (await targetsFor(companyId, year, [employeeId])).get(employeeId);
  if (!targets || targets.annual == null) return null;
  const months = fyMonths(year);
  const achieved = (await achievedByMonth(companyId, months[0].from, months[11].to, [employeeId])).get(employeeId) || new Map();
  const plan = monthlyPlan(year, targets.annual, targets.monthly).map((m) => {
    const a = round(achieved.get(`${m.year}-${pad(m.month)}`) || 0);
    const state = today > m.to ? 'past' : today >= m.from ? 'current' : 'future';
    return {
      month: m.month, year: m.year, label: m.label, target: m.target, achieved: a,
      pct: m.target > 0 ? Math.round((a / m.target) * 1000) / 10 : null, state,
      days_left: state === 'current' ? daysBetween(today, m.to) : state === 'future' ? m.days : 0,
    };
  });
  const total = plan.reduce((s, m) => s + m.achieved, 0);
  const pct = targets.annual > 0 ? Math.round((total / targets.annual) * 1000) / 10 : null;
  const end = months[11].to;
  const rule = await incentiveRule(companyId, end);
  const slab = pct == null ? null : slabFor(pct, rule.slabs);
  const salary = slab?.type === 'pct_salary' ? await annualSalary(companyId, employeeId, today < end ? today : end, rule.salary_basis) : null;
  const inc = incentiveAmount(slab, { achieved: total, annualSalary: salary });
  const current = plan.find((m) => m.state === 'current');
  return {
    fy: year, fy_label: fyLabel(year), from: months[0].from, to: end, today,
    annual_target: round(targets.annual), achieved: total, pct,
    remaining: Math.max(0, round(targets.annual) - total),
    // Days after today up to 31 March (the whole year before it starts).
    days_left_in_year: today > end ? 0 : today < months[0].from ? daysBetween(months[0].from, end) + 1 : daysBetween(today, end),
    days_left_in_month: current ? current.days_left : 0,
    months: plan,
    incentive: {
      slabs_set: (rule.slabs || []).length > 0,
      slab: slab ? { from_pct: slab.from_pct, to_pct: slab.to_pct ?? null, type: slab.type, amount: slab.amount } : null,
      amount_so_far: inc.amount, basis: inc.basis, final: today > end,
    },
  };
}

/** Every salesperson with an annual target in a year: target, achieved, %, slab and incentive. */
export async function incentiveReport({ companyId, fy }) {
  const year = Number(fy);
  if (!(year >= 2000 && year <= 2100)) throw new PayrollHttpError(400, 'Choose a financial year');
  const months = fyMonths(year);
  const end = months[11].to;
  const targets = await targetsFor(companyId, year);
  const ids = [...targets.entries()].filter(([, t]) => t.annual != null).map(([id]) => id);
  const rule = await incentiveRule(companyId, end);
  if (!ids.length) return { fy: year, fy_label: fyLabel(year), rule, rows: [], year_closed: businessToday() > end };
  const achieved = await achievedByMonth(companyId, months[0].from, end, ids);
  const { rows: people } = await pool.query(
    `SELECT id, office_id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, status
       FROM employees WHERE id = ANY($1::int[]) AND company_id = $2 AND deleted_at IS NULL`, [ids, companyId]);
  const label = `Sales incentive ${fyLabel(year)}`;
  const { rows: already } = await pool.query(
    `SELECT employee_id, month, year, amount FROM payroll_adjustments
      WHERE company_id = $1 AND employee_id = ANY($2::int[]) AND kind = 'earning' AND label = $3 AND is_test = false`,
    [companyId, ids, label]);
  const paidBy = new Map(already.map((a) => [a.employee_id, a]));
  const today = businessToday();
  const rows = [];
  for (const p of people) {
    const t = targets.get(p.id);
    const total = round([...(achieved.get(p.id) || new Map()).values()].reduce((s, v) => s + v, 0));
    const pct = t.annual > 0 ? Math.round((total / t.annual) * 1000) / 10 : null;
    const slab = pct == null ? null : slabFor(pct, rule.slabs);
    const salary = slab?.type === 'pct_salary' ? await annualSalary(companyId, p.id, today < end ? today : end, rule.salary_basis) : null;
    const inc = incentiveAmount(slab, { achieved: total, annualSalary: salary });
    const added = paidBy.get(p.id);
    rows.push({
      employee_id: p.id, employee_code: p.office_id, name: p.name, status: p.status,
      target: round(t.annual), achieved: total, pct,
      slab: slab ? { from_pct: slab.from_pct, to_pct: slab.to_pct ?? null, type: slab.type, amount: slab.amount } : null,
      amount: inc.amount, basis: inc.basis,
      added_to_payroll: added ? { month: added.month, year: added.year, amount: num(added.amount) } : null,
    });
  }
  rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  return { fy: year, fy_label: fyLabel(year), label, rule, rows, year_closed: today > end };
}

/**
 * Add each person's incentive for the year to payroll as a one-time earning in the
 * chosen month. Anyone already given it for this year is skipped, so pressing it twice
 * pays nothing twice. Only after the year has ended: the achievement is final then.
 */
export async function addIncentivesToPayroll({ companyId, fy, month, year, userId, employeeIds = null }) {
  const report = await incentiveReport({ companyId, fy });
  if (!report.year_closed) throw new PayrollHttpError(409, `${report.fy_label} has not ended yet, so the achievement is not final. Add the incentive after 31 March.`);
  if (!(report.rule.slabs || []).length) throw new PayrollHttpError(409, 'No incentive slabs are set. Enter them in Payroll Center → Settings → Sales incentive first.');
  const added = [], skipped = [];
  for (const r of report.rows) {
    if (employeeIds && !employeeIds.includes(r.employee_id)) continue;
    if (r.added_to_payroll) { skipped.push({ ...r, why: 'already added' }); continue; }
    if (!(r.amount > 0)) { skipped.push({ ...r, why: 'nothing payable' }); continue; }
    try {
      const row = await addAdjustment({
        company_id: companyId, employee_id: r.employee_id, month, year, kind: 'earning', label: report.label, amount: r.amount,
        reason: `${r.pct}% of target ₹${r.target.toLocaleString('en-IN')} achieved (₹${r.achieved.toLocaleString('en-IN')}). ${r.basis}`.slice(0, 500),
        userId,
      });
      added.push({ ...r, adjustment_id: row.id });
    } catch (e) {
      skipped.push({ ...r, why: e.message });
    }
  }
  return { fy_label: report.fy_label, added, skipped };
}

/** For a final settlement: what the year's incentive would be on sales up to the last working day. */
export async function incentiveAtExit({ companyId, employeeId, lwd }) {
  const view = await targetView({ companyId, employeeId, fy: fyOf(lwd), today: lwd });
  if (!view) return null;
  return { fy_label: view.fy_label, target: view.annual_target, achieved: view.achieved, pct: view.pct, amount: view.incentive.amount_so_far, basis: view.incentive.basis };
}
