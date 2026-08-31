/**
 * kpi-reconcile.mjs — recompute every headline Analytics & AI KPI straight from
 * the database and compare it with what the API serves.
 *
 * The point is independence: each expectation below is written from the source
 * tables, not by calling the same helper the endpoint calls. A shared helper
 * that is wrong would otherwise reconcile perfectly with itself.
 *
 * Emits a fenced JSON report: { checks: [{name, api, db, match, note}], mismatches }
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;
// Default to the same base the rest of the E2E suite drives (PULSE_API, which
// CI sets to the app under test) rather than a private port. The old default of
// :5099 was a port nothing starts: the Playwright case that runs this probe
// passed only when someone happened to have a server there, and failed with
// ECONNREFUSED the moment they did not — a harness dependency that looked like
// a product failure. PROBE_API still overrides, for pointing at a scratch
// instance deliberately.
const API = process.env.PROBE_API || process.env.PULSE_API || 'http://localhost:5000/api/v1';
const EMAIL = process.env.RECON_EMAIL || 'superadmin@manifest.in';

const { rows: [u] } = await pool.query(
  'SELECT id, email, role, employee_id, company_id FROM users WHERE email=$1', [EMAIL]);
const { rows: rr } = await pool.query(
  'SELECT LOWER(r.code) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [u.id]);
const TOKEN = jwt.sign({
  userId: u.id, email: u.email, role: u.role, roles: rr.map((x) => x.c),
  employeeId: u.employee_id, company_id: u.company_id,
}, process.env.JWT_SECRET, { expiresIn: '2h' });
const CID = u.company_id;

const get = async (p) => {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const num = (v) => (v == null ? null : Number(v));

/** Company filter for a super admin bound to a company; global scope otherwise. */
const CF = CID != null ? 'AND company_id = $1' : '';
const CP = CID != null ? [CID] : [];

const checks = [];
const add = (name, api, db, note = '') => {
  const match = api === db || (api == null && db == null)
    || (typeof api === 'number' && typeof db === 'number' && Math.abs(api - db) < 0.01);
  checks.push({ name, api, db, match, note });
};

// ── Revenue YTD ───────────────────────────────────────────────────────────────
// FY_START, not date_trunc('year') — the Indian financial year starts 1 April.
{
  const { body } = await get('/analytics/ceo/kpis');
  const r = await one(
    `SELECT COALESCE(SUM(total_amount),0)::float AS v FROM invoices
      WHERE LOWER(status) IN ('paid','partially_paid','partial')
        AND COALESCE(invoice_date, created_at) >= DATE_TRUNC('year', NOW() - INTERVAL '3 months') + INTERVAL '3 months'
        ${CF}`, CP);
  add('revenue YTD (/analytics/ceo/kpis)', num(body?.kpis?.revenue?.value), num(r.v),
    'invoices with a paid status since 1 April');
}

// ── Receivables ───────────────────────────────────────────────────────────────
{
  const { body } = await get('/dashboard/cfo?period=YTD');
  const r = await one(
    `SELECT COALESCE(SUM(total_amount),0)::float AS v FROM invoices
      WHERE LOWER(status) NOT IN ('paid','cancelled') AND deleted_at IS NULL ${CF}`, CP);
  add('AR (/dashboard/cfo)', num(body?.kpis?.ar), num(r.v), 'invoiced and not collected');
}

// ── Headcount ─────────────────────────────────────────────────────────────────
// `total` and `active` answer different questions and this used to compare one
// against the other's SQL. It agreed only for as long as nobody had left the
// company; the first exited employee made a correct endpoint look wrong. Both
// are now reconciled against their own definition.
{
  const { body } = await get('/analytics/headcount');
  const d = body?.data ?? body ?? {};

  const onPayroll = await one(
    `SELECT COUNT(*)::int AS v FROM employees
      WHERE LOWER(status) IN ('active','probation','notice','confirmed') ${CF}`, CP);
  add('headcount on payroll (/analytics/headcount .active)',
    num(d.active ?? d.headcount_on_payroll), num(onPayroll.v),
    'EMPLOYEE_ACTIVE — notice period included');

  const everyone = await one(`SELECT COUNT(*)::int AS v FROM employees WHERE 1=1 ${CF}`, CP);
  add('employee records total (/analytics/headcount .total)',
    num(d.total), num(everyone.v),
    'every employee record, exited included');
}

// ── Open tickets ──────────────────────────────────────────────────────────────
{
  const { body } = await get('/dashboard/operations');
  const r = await one(
    `SELECT COUNT(*)::int AS v FROM support_tickets
      WHERE (status IS NULL OR LOWER(status) NOT IN ('resolved','closed','cancelled'))
        AND deleted_at IS NULL ${CF}`, CP);
  add('open tickets (/dashboard/operations)', num(body?.open_tickets), num(r.v));
}

// ── Active projects ───────────────────────────────────────────────────────────
{
  const { body } = await get('/dashboard/project-health');
  const r = await one(
    `SELECT COUNT(*)::int AS v FROM projects
      WHERE status NOT IN ('completed','cancelled') ${CF}`, CP);
  add('active projects (/dashboard/project-health)', num(body?.active_projects), num(r.v));
}

// ── Work centre in-progress orders ────────────────────────────────────────────
// The defect that started this: production_orders.completed_at has never
// existed, so the whole KPI block was null and rendered as zeros.
{
  const { body } = await get('/analytics/manufacturing/work-centre');
  const r = await one(
    `SELECT COUNT(*)::int AS v FROM production_orders
      WHERE status NOT IN ('completed','cancelled') ${CF}`, CP);
  add('production orders in progress (/analytics/manufacturing/work-centre)',
    num(body?.kpi?.in_progress), num(r.v));
}

// ── Sales pipeline total ──────────────────────────────────────────────────────
{
  const { body } = await get('/dashboard/sales');
  const apiTotal = (body?.stages ?? []).reduce((s, x) => s + Number(x.value || 0), 0);
  const r = await one(
    `SELECT COALESCE(SUM(expected_value),0)::float AS v FROM opportunities
      WHERE deleted_at IS NULL ${CF}`, CP);
  add('pipeline value (/dashboard/sales)', Math.round(apiTotal), Math.round(num(r.v)));
}

// ── Top customers ─────────────────────────────────────────────────────────────
{
  const { body } = await get('/dashboard/top-customers');
  const r = await one(
    `SELECT COUNT(*)::int AS v FROM (
       SELECT party_name FROM invoices
        WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '12 months'
          AND party_name IS NOT NULL AND party_name != '' ${CF}
        GROUP BY party_name ORDER BY COALESCE(SUM(total_amount),0) DESC LIMIT 5) x`, CP);
  add('top customers rows (/dashboard/top-customers)', body?.customers?.length ?? null, num(r.v));
}

// ── Overdue invoice detail list ───────────────────────────────────────────────
// invoices.client_name does not exist; the query was wrapped in safeQuery, so
// this list was empty while fifteen invoices were overdue.
{
  const { body } = await get('/dashboard/cash?detail=true');
  const r = await one(
    `SELECT LEAST(COUNT(*),10)::int AS v FROM invoices
      WHERE status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE ${CF}`, CP);
  add('overdue invoice rows (/dashboard/cash?detail=true)',
    body?.detail?.top_overdue_invoices?.length ?? null, num(r.v));
}

// ── AI predictions: every panel must be computed, not errored ─────────────────
{
  const { body } = await get('/ai/predictions');
  const d = body?.data ?? {};
  for (const panel of ['revenue_forecast', 'attrition_risk', 'stockout_risk', 'lead_conversion']) {
    add(`/ai/predictions ${panel} computed`, d[panel]?.error ?? null, null,
      d[panel]?.error ? 'panel failed to compute' : 'ok');
  }
  // Employees with no department are grouped as 'Unassigned' rather than
  // dropped, so the expectation must count that bucket too — COUNT(DISTINCT
  // department) skips NULL and would assert the old, lossy behaviour.
  const att = await one(
    `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(department), ''), 'Unassigned'))::int AS v
       FROM employees
      WHERE LOWER(status) IN ('active','probation','notice','confirmed') ${CF}`, CP);
  add('/ai/predictions attrition_risk departments', d.attrition_risk?.data?.length ?? null, num(att.v),
    'includes the Unassigned bucket');
  const leads = await one(
    `SELECT LEAST(COUNT(*),5)::int AS v FROM leads
      WHERE LOWER(status) NOT IN ('lost','won') AND deleted_at IS NULL ${CF}`, CP);
  add('/ai/predictions lead_conversion rows', d.lead_conversion?.data?.length ?? null, num(leads.v));
}

// ── Honesty contracts: unmeasured must not read as measured ──────────────────
{
  const { body } = await get('/dashboard/cfo?period=YTD');
  // glPosted means "posted P&L lines exist for THIS company in THIS period",
  // not "the journal_lines table has any rows at all". Every journal_entries row
  // presently carries a NULL company_id, so a company-scoped CFO legitimately
  // sees an empty ledger while nine posted entries exist — the endpoint now says
  // exactly that instead of "no journal entries posted".
  const posted = await one(
    `SELECT COUNT(jl.id)::int AS v
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE LOWER(je.status) = 'posted'
        AND coa.account_type IN ('Revenue','Expense')
        ${CID != null ? 'AND je.company_id = $1' : ''}`, CP).catch(() => ({ v: 0 }));
  const glPosted = Number(posted?.v || 0) > 0;
  add('CFO glPosted flag matches the ledger', body?.accounting?.glPosted ?? null, glPosted,
    "scoped to the caller's company, as the endpoint is");

  const unattributed = await one(
    `SELECT COUNT(jl.id)::int AS v
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE LOWER(je.status) = 'posted'
        AND coa.account_type IN ('Revenue','Expense')
        AND je.company_id IS NULL
        -- Same YTD window the endpoint used: the Indian financial year opens
        -- 1 April, and four of the nine posted entries are dated 31 March, so
        -- an all-time count would not reconcile against a period figure.
        AND je.entry_date >= DATE_TRUNC('year', NOW() - INTERVAL '3 months') + INTERVAL '3 months'
        AND je.entry_date <= CURRENT_DATE`).catch(() => ({ v: 0 }));
  if (!glPosted) {
    add('CFO explains WHY the ledger is empty', body?.accounting?.unattributedLedgerLines ?? null,
      num(unattributed.v),
      'posted lines that belong to no company — a data gap, not an empty ledger');
  } else {
    // With a posted, attributed ledger the accrual figures are real numbers and
    // must reconcile, not merely be non-null. Recomputed here straight from
    // journal_lines x chart_of_accounts over the same FY window the endpoint
    // uses, so a sign error or a mis-bucketed sub_type shows up as a mismatch.
    const FY = `je.entry_date >= DATE_TRUNC('year', NOW() - INTERVAL '3 months') + INTERVAL '3 months'
                AND je.entry_date <= CURRENT_DATE`;
    const gl = await one(
      // Mirrors the endpoint's bucketing exactly: operating revenue EXCLUDES
      // accounts with sub_type='other', which are carried separately as other
      // income and added back after operating profit. Lumping them together
      // made this expectation disagree on revenue while still agreeing on net
      // profit — the signature of a difference in classification, not arithmetic.
      `SELECT
         COALESCE(SUM(CASE WHEN coa.account_type='Revenue' AND COALESCE(coa.sub_type,'') <> 'other'
                           THEN jl.credit - jl.debit ELSE 0 END),0)::float AS revenue,
         COALESCE(SUM(CASE WHEN coa.account_type='Revenue' AND COALESCE(coa.sub_type,'') = 'other'
                           THEN jl.credit - jl.debit ELSE 0 END),0)::float AS other_income,
         COALESCE(SUM(CASE WHEN coa.account_type='Expense' AND coa.sub_type='cogs'
                           THEN jl.debit - jl.credit ELSE 0 END),0)::float AS cogs,
         COALESCE(SUM(CASE WHEN coa.account_type='Expense'
                           AND COALESCE(coa.sub_type,'') NOT IN ('cogs')
                           THEN jl.debit - jl.credit ELSE 0 END),0)::float AS opex
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE LOWER(je.status) = 'posted'
          AND coa.account_type IN ('Revenue','Expense')
          AND ${FY}
          ${CID != null ? 'AND je.company_id = $1' : ''}`, CP);

    add('CFO glRevenue matches the ledger', num(body?.accounting?.glRevenue), num(gl.revenue));
    add('CFO cogs matches the ledger', num(body?.accounting?.cogs), num(gl.cogs));
    // netProfit = (revenue - cogs) - opex + other income. With no other-income
    // accounts posted this reduces to gross profit less opex.
    add('CFO netProfit matches the ledger',
      num(body?.kpis?.netProfit),
      num(gl.revenue) - num(gl.cogs) - num(gl.opex) + num(gl.other_income),
      'operating profit + other income, from journal_lines');
    add('CFO has no unattributed ledger lines left',
      num(body?.accounting?.unattributedLedgerLines), 0,
      'every posted entry now carries a company_id');
  }
  // With nothing posted, net profit and EBITDA must be null rather than derived.
  if (!glPosted) {
    add('CFO netProfit is null when nothing is posted', body?.kpis?.netProfit ?? null, null);
    add('CFO ebitda is null when nothing is posted', body?.kpis?.ebitda ?? null, null);
  }
}

const mismatches = checks.filter((c) => !c.match);
console.log('---REPORT_BEGIN---');
console.log(JSON.stringify({ company: CID, checks, mismatches: mismatches.length }));
console.log('---REPORT_END---');
if (!process.argv.includes('--json')) {
  console.error('');
  for (const c of checks) {
    console.error(`${c.match ? 'MATCH  ' : 'DIFFER '} ${c.name}\n         api=${JSON.stringify(c.api)} db=${JSON.stringify(c.db)}${c.note ? '  (' + c.note + ')' : ''}`);
  }
  console.error(`\n${checks.length - mismatches.length}/${checks.length} reconciled`);
}
await pool.end();
process.exit(mismatches.length ? 1 : 0);
