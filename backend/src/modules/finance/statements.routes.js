/**
 * statements.routes.js — Financial Statements API
 * Endpoints: income-statement, balance-sheet, cash-flow, breakeven-analysis, ratios
 * Mounted at /api/statements (or /api/v1/statements) in server.js
 */

import { Router } from 'express';
import pool from './db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = Router();

const n = (v) => parseFloat(v || 0);
const pct = (num, den) => den > 0 ? parseFloat(((num / den) * 100).toFixed(1)) : 0;

// ── safe query helpers ───────────────────────────────────────────────────────
const q1 = async (sql, p = []) => {
  try { return (await pool.query(sql, p)).rows[0] || {}; } catch { return {}; }
};
const qN = async (sql, p = []) => {
  try { return (await pool.query(sql, p)).rows; } catch { return []; }
};

// ── date range from FY params ────────────────────────────────────────────────
function fyRange(query) {
  const now = new Date();
  const fyStart = query.fyStart || `${now.getFullYear()}-04-01`;
  const fyEnd   = query.fyEnd   || `${now.getFullYear() + 1}-03-31`;
  return { fyStart, fyEnd };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/income-statement
// ────────────────────────────────────────────────────────────────────────────
router.get('/income-statement', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const [revRow, expRow, cogsRow, monthRows, monthCogsRows] = await Promise.all([
      // Revenue from invoices within FY
      q1(`SELECT
            COALESCE(SUM(CASE WHEN status IN ('paid','partially_paid','approved') THEN total_amount ELSE 0 END),0) AS revenue,
            COALESCE(SUM(CASE WHEN status IN ('paid','partially_paid') THEN total_amount ELSE 0 END),0) AS collected
          FROM invoices
          WHERE DATE(invoice_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),

      // Operating expenses (bills + expenses) — excludes COGS-type entries
      q1(`SELECT
            COALESCE((SELECT SUM(total_amount) FROM bills    WHERE DATE(bill_date)   BETWEEN $1 AND $2 AND status NOT IN ('draft','rejected') AND company_id = $3), 0) AS bills_total,
            COALESCE((SELECT SUM(amount)       FROM expenses WHERE DATE(created_at)  BETWEEN $1 AND $2 AND status NOT IN ('draft','rejected') AND company_id = $3), 0) AS expense_total
          `, [fyStart, fyEnd, cid]),

      // COGS from GL — debit movements on accounts with sub_type = 'cogs' (account 5001)
      q1(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS cogs
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted'
            AND DATE(je.entry_date) BETWEEN $1 AND $2
            AND (coa.sub_type = 'cogs' OR coa.code = '5001')
            AND jl.company_id = $3`, [fyStart, fyEnd, cid]),

      // Monthly trend — revenue
      qN(`SELECT TO_CHAR(DATE_TRUNC('month', inv.invoice_date), 'Mon-YY') AS period,
                 DATE_TRUNC('month', inv.invoice_date) AS month_ts,
                 COALESCE(SUM(CASE WHEN inv.status IN ('paid','partially_paid','approved') THEN inv.total_amount ELSE 0 END),0) AS revenue
          FROM invoices inv
          WHERE DATE(inv.invoice_date) BETWEEN $1 AND $2 AND inv.company_id = $3
          GROUP BY DATE_TRUNC('month', inv.invoice_date)
          ORDER BY month_ts`, [fyStart, fyEnd, cid]),

      // Monthly COGS from GL
      qN(`SELECT TO_CHAR(DATE_TRUNC('month', je.entry_date), 'Mon-YY') AS period,
                 DATE_TRUNC('month', je.entry_date) AS month_ts,
                 COALESCE(SUM(jl.debit - jl.credit), 0) AS cogs
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted'
            AND DATE(je.entry_date) BETWEEN $1 AND $2
            AND (coa.sub_type = 'cogs' OR coa.code = '5001')
            AND jl.company_id = $3
          GROUP BY DATE_TRUNC('month', je.entry_date)
          ORDER BY month_ts`, [fyStart, fyEnd, cid]),
    ]);

    const revenue  = n(revRow.revenue);
    const opEx     = n(expRow.bills_total) + n(expRow.expense_total);
    // COGS from actual GL journal entries — accurate for manufacturing companies
    const cogs         = Math.max(0, n(cogsRow.cogs));
    const grossProfit  = revenue - cogs;
    const grossMargin  = pct(grossProfit, revenue);
    const ebitda       = grossProfit - opEx;
    const ebitdaMargin = pct(ebitda, revenue);
    const netProfit    = ebitda;
    const netMargin    = pct(netProfit, revenue);

    // Build a month→COGS lookup for trend lines
    const cogsByMonth = Object.fromEntries(monthCogsRows.map(r => [r.period, n(r.cogs)]));

    const breakdown = [
      { label: 'Revenue',         value: revenue },
      { label: 'COGS',            value: -cogs },
      { label: 'Gross Profit',    value: grossProfit },
      { label: 'Operating Exp.',  value: -opEx },
      { label: 'EBITDA',          value: ebitda },
      { label: 'Net Profit',      value: netProfit },
    ];

    const trend = monthRows.map(r => {
      const rev      = n(r.revenue);
      const montCogs = cogsByMonth[r.period] ?? 0;
      const gp       = rev - montCogs;
      const np       = gp - (opEx / Math.max(monthRows.length, 1));
      return { period: r.period, revenue: rev, cogs: montCogs, grossProfit: gp, netProfit: np };
    });

    res.json({
      summary:    { revenue, grossProfit, grossMargin, ebitda, ebitdaMargin, netProfit, netMargin },
      breakdown,
      trend,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/balance-sheet
// ────────────────────────────────────────────────────────────────────────────
router.get('/balance-sheet', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const [arRow, apRow, cashRow, fixedRow, invRow, gstItcRow, gstPayRow, tdsPayRow, salaryPayRow] = await Promise.all([
      // Accounts Receivable
      q1(`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ar
          FROM invoices WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),

      // Accounts Payable
      q1(`SELECT COALESCE(SUM(amount),0) AS ap
          FROM bills WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),

      // Cash (bank accounts balances)
      q1(`SELECT COALESCE(SUM(current_balance),0) AS cash FROM bank_accounts WHERE company_id = $1`, [cid]),

      // Fixed Assets
      q1(`SELECT
            COALESCE(SUM(cost),0)                       AS gross_assets,
            COALESCE(SUM(accumulated_depreciation),0)   AS accum_dep
          FROM fixed_assets WHERE status != 'disposed' AND company_id = $1`, [cid]),

      // Inventory (GL account 1030 Finished Goods + 1031 WIP + 1032 Raw Materials)
      q1(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS inventory
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted' AND DATE(je.entry_date) <= $1
            AND coa.code IN ('1030','1031','1032')
            AND jl.company_id = $2`, [fyEnd, cid]),

      // GST Input Tax Credit (ITC) — net balance in ITC accounts 1020/1021/1022
      q1(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS gst_itc
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted' AND DATE(je.entry_date) <= $1
            AND coa.code IN ('1020','1021','1022')
            AND jl.company_id = $2`, [fyEnd, cid]),

      // GST Payable — credit balance in GST output accounts 2010/2011/2012
      q1(`SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS gst_payable
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted' AND DATE(je.entry_date) <= $1
            AND coa.code IN ('2010','2011','2012')
            AND jl.company_id = $2`, [fyEnd, cid]),

      // TDS Payable — credit balance in TDS payable account 2030
      q1(`SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS tds_payable
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted' AND DATE(je.entry_date) <= $1
            AND coa.code = '2030'
            AND jl.company_id = $2`, [fyEnd, cid]),

      // Salary Payable — credit balance in account 2040
      q1(`SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS salary_payable
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          JOIN chart_of_accounts coa ON coa.id = jl.account_id
          WHERE je.status = 'posted' AND DATE(je.entry_date) <= $1
            AND coa.code = '2040'
            AND jl.company_id = $2`, [fyEnd, cid]),
    ]);

    const ar           = n(arRow.ar);
    const ap           = n(apRow.ap);
    const cash         = n(cashRow.cash);
    const netFixed     = n(fixedRow.gross_assets) - n(fixedRow.accum_dep);
    const inventory    = Math.max(0, n(invRow.inventory));
    const gstItc       = Math.max(0, n(gstItcRow.gst_itc));
    const gstPayable   = Math.max(0, n(gstPayRow.gst_payable));
    const tdsPayable   = Math.max(0, n(tdsPayRow.tds_payable));
    const salaryPayable= Math.max(0, n(salaryPayRow.salary_payable));

    const currentAssets    = cash + ar + inventory + gstItc;
    const nonCurrentAssets = netFixed;
    const totalAssets      = currentAssets + nonCurrentAssets;

    const currentLiab    = ap + gstPayable + tdsPayable + salaryPayable;
    const nonCurrentLiab = 0;   // no long-term debt table yet
    const equity         = totalAssets - currentLiab - nonCurrentLiab;

    const totalLiab  = currentLiab + nonCurrentLiab + Math.max(equity, 0);
    const balanced   = Math.abs(totalAssets - totalLiab) < 1;
    const variance   = totalAssets - totalLiab;

    const currentAssetItems = [
      { name: 'Cash & Bank',          value: cash },
      { name: 'Accounts Receivable',  value: ar },
    ];
    if (inventory > 0)  currentAssetItems.push({ name: 'Inventory',          value: inventory });
    if (gstItc > 0)     currentAssetItems.push({ name: 'GST Input Tax Credit', value: gstItc });

    const currentLiabItems = [
      { name: 'Accounts Payable',     value: ap },
    ];
    if (gstPayable > 0)    currentLiabItems.push({ name: 'GST Payable',     value: gstPayable });
    if (tdsPayable > 0)    currentLiabItems.push({ name: 'TDS Payable',     value: tdsPayable });
    if (salaryPayable > 0) currentLiabItems.push({ name: 'Salary Payable',  value: salaryPayable });

    res.json({
      balanced,
      variance,
      ratios: {
        currentRatio:   currentLiab > 0 ? parseFloat((currentAssets / currentLiab).toFixed(2)) : null,
        debtToEquity:   equity > 0       ? parseFloat((currentLiab / equity).toFixed(2)) : null,
        workingCapital: currentAssets - currentLiab,
      },
      assets: {
        total: totalAssets,
        current: {
          total: currentAssets,
          items: currentAssetItems,
        },
        nonCurrent: {
          total: nonCurrentAssets,
          items: [
            { name: 'Fixed Assets (Net)',   value: netFixed },
          ],
        },
      },
      liabilities: {
        total: totalLiab,
        current: {
          total: currentLiab,
          items: currentLiabItems,
        },
        nonCurrent: {
          total: nonCurrentLiab,
          items: [],
        },
        equity: {
          total: Math.max(equity, 0),
          items: [
            { name: 'Retained Earnings',    value: Math.max(equity, 0) },
          ],
        },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/cash-flow
// ────────────────────────────────────────────────────────────────────────────
router.get('/cash-flow', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const [receiptsRow, paymentsRow, expRow, assetRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM receipts  WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM payments  WHERE DATE(payment_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses  WHERE DATE(created_at)   BETWEEN $1 AND $2 AND status = 'approved' AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(cost),0)   AS total FROM fixed_assets WHERE DATE(purchase_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
    ]);

    const inflow   = n(receiptsRow.total);
    const outflow  = n(paymentsRow.total) + n(expRow.total);
    const capex    = n(assetRow.total);
    const opTotal  = inflow - outflow;
    const invTotal = -capex;
    const finTotal = 0;  // no financing data yet

    res.json({
      operating: {
        total: opTotal,
        items: [
          { name: 'Cash Receipts from Customers', value: inflow },
          { name: 'Cash Paid for Operations',     value: -outflow },
        ],
      },
      investing: {
        total: invTotal,
        items: [
          { name: 'Capital Expenditure',          value: -capex },
        ],
      },
      financing: {
        total: finTotal,
        items: [],
      },
      netCashChange: opTotal + invTotal + finTotal,
      freeCashFlow:  opTotal - capex,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/funds-flow
// Sources & applications of funds between two dates (working-capital basis).
// Built from GL movement per account, classified by account_type + sub_type.
// ────────────────────────────────────────────────────────────────────────────
const CURRENT_ASSET_SUB = ['cash', 'bank', 'receivable', 'advance', 'inventory', 'prepaid', 'gst_itc'];
const CURRENT_LIAB_SUB  = ['payable', 'gst_payable', 'tds_payable', 'statutory', 'accrual', 'advance'];
const FIXED_ASSET_SUB   = ['fixed_asset'];
const LONGTERM_LIAB_SUB = ['loan'];

router.get('/funds-flow', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const from = req.query.from_date || fyStart;
    const to   = req.query.to_date   || fyEnd;
    const cid  = companyOf(req);

    // Per-account net movement (debit − credit) for POSTED entries within the period.
    // je matched in the ON clause; CASE gates out non-matching (null) entries.
    const rows = await qN(`
      SELECT coa.account_type, coa.sub_type, coa.code, coa.name,
             COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_debit
      FROM chart_of_accounts coa
      LEFT JOIN journal_lines jl ON jl.account_id = coa.id AND jl.company_id = $3
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
        AND je.status = 'posted' AND DATE(je.entry_date) BETWEEN $1 AND $2
      WHERE coa.is_active = true AND (coa.company_id = $3 OR coa.company_id IS NULL)
      GROUP BY coa.account_type, coa.sub_type, coa.code, coa.name
    `, [from, to, cid]);

    let netProfit = 0, depreciation = 0;
    let assetPurchase = 0, assetSale = 0;
    let borrowing = 0, loanRepayment = 0;
    let capitalRaised = 0, capitalWithdrawn = 0;
    let deltaCA = 0, deltaCL = 0;
    const wcAssets = [], wcLiabs = [];

    for (const r of rows) {
      const m = Math.round(n(r.net_debit)); // net-debit movement (Asset ↑ = +, Liab/Equity ↑ = −)
      if (Math.abs(m) < 1) continue;
      const type = r.account_type;
      const sub  = String(r.sub_type || '').toLowerCase();

      if (type === 'Revenue' || type === 'Expense') {
        netProfit -= m;                       // revenue (credit) adds, expense (debit) subtracts
        if (sub === 'depreciation') depreciation += m; // non-cash add-back
        continue;
      }
      if (type === 'Asset' && FIXED_ASSET_SUB.includes(sub)) {
        if (m > 0) assetPurchase += m; else assetSale += -m;
        continue;
      }
      if (type === 'Liability' && LONGTERM_LIAB_SUB.includes(sub)) {
        if (m < 0) borrowing += -m; else loanRepayment += m;
        continue;
      }
      if (type === 'Equity') {
        if (sub === 'retained') continue;     // profit already captured in FFO
        if (m < 0) capitalRaised += -m; else capitalWithdrawn += m;
        continue;
      }
      if (type === 'Asset' && CURRENT_ASSET_SUB.includes(sub)) {
        deltaCA += m; wcAssets.push({ name: r.name, change: m }); continue;
      }
      if (type === 'Liability' && CURRENT_LIAB_SUB.includes(sub)) {
        deltaCL += -m; wcLiabs.push({ name: r.name, change: -m }); continue; // liab ↑ = −m
      }
      // Other non-current assets (e.g. unclassified) treated as application when increasing
      if (type === 'Asset') { if (m > 0) assetPurchase += m; else assetSale += -m; }
      else if (type === 'Liability') { if (m < 0) borrowing += -m; else loanRepayment += m; }
    }

    const fundsFromOperations = netProfit + depreciation;

    const sources = [
      { name: 'Funds from Operations', value: fundsFromOperations, detail: `Net profit ${inrLite(netProfit)} + depreciation ${inrLite(depreciation)}` },
      { name: 'Long-term Borrowings', value: borrowing },
      { name: 'Capital Introduced',   value: capitalRaised },
      { name: 'Sale of Fixed Assets', value: assetSale },
    ].filter(s => Math.abs(s.value) > 0.5);

    const applications = [
      { name: 'Purchase of Fixed Assets', value: assetPurchase },
      { name: 'Repayment of Borrowings',  value: loanRepayment },
      { name: 'Capital / Drawings Out',   value: capitalWithdrawn },
    ].filter(a => Math.abs(a.value) > 0.5);

    const totalSources      = sources.reduce((s, x) => s + x.value, 0);
    const totalApplications = applications.reduce((s, x) => s + x.value, 0);
    const netFunds          = totalSources - totalApplications;      // = increase in working capital
    const netWorkingCapital = deltaCA - deltaCL;

    res.json({
      period: { from, to },
      fundsFromOperations,
      netProfit,
      depreciation,
      sources,
      applications,
      totalSources,
      totalApplications,
      netIncreaseInFunds: netFunds,
      workingCapital: {
        increaseInCurrentAssets: deltaCA,
        increaseInCurrentLiabilities: deltaCL,
        netIncrease: netWorkingCapital,
        assets: wcAssets,
        liabilities: wcLiabs,
      },
      reconciliation: {
        sourcesLessApplications: netFunds,
        netWorkingCapitalChange: netWorkingCapital,
        difference: Math.round(netFunds - netWorkingCapital),
        reconciled: Math.abs(netFunds - netWorkingCapital) < 1,
      },
      note: 'Funds Flow on a working-capital basis. Sources − Applications should equal the net increase in working capital; residual differences arise from opening balances and non-GL entries.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function inrLite(v) { return `₹${Math.round(v).toLocaleString('en-IN')}`; }

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/breakeven-analysis
// ────────────────────────────────────────────────────────────────────────────
router.get('/breakeven-analysis', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const [revRow, expRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN total_amount ELSE 0 END),0) AS revenue
          FROM invoices WHERE DATE(invoice_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT
            COALESCE(SUM(amount),0) AS total_exp
          FROM expenses
          WHERE DATE(created_at) BETWEEN $1 AND $2 AND status = 'approved' AND company_id = $3`, [fyStart, fyEnd, cid]),
    ]);

    const revenue      = n(revRow.revenue);
    const totalExpense = n(expRow.total_exp);

    // Approximate: 40% fixed, 60% variable (of total operating expenses + COGS)
    const totalCost    = revenue * 0.50 + totalExpense;  // COGS + OpEx
    const fixedCost    = totalCost * 0.40;
    const variableCost = totalCost * 0.60;
    const contribution = revenue - variableCost;
    const cmRatio      = pct(contribution, revenue);
    const breakevenRevenue = cmRatio > 0 ? parseFloat((fixedCost / (cmRatio / 100)).toFixed(0)) : 0;
    const marginOfSafety   = revenue > 0 && breakevenRevenue > 0
      ? parseFloat(((revenue - breakevenRevenue) / revenue * 100).toFixed(1))
      : 0;
    const operatingLeverage = contribution > 0
      ? parseFloat((contribution / (contribution - fixedCost)).toFixed(2))
      : null;

    // Generate chart data: 0% to 160% of breakeven revenue
    const bep = breakevenRevenue || revenue || 100000;
    const chartData = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6].map(factor => {
      const rev  = Math.round(bep * factor);
      const vc   = cmRatio > 0 ? Math.round(rev * (1 - cmRatio / 100)) : Math.round(rev * 0.6);
      return {
        revenue:   rev,
        totalCost: Math.round(fixedCost + vc),
        fixedCost: Math.round(fixedCost),
      };
    });

    res.json({
      revenue,
      fixedCost:      Math.round(fixedCost),
      variableCost:   Math.round(variableCost),
      contribution:   Math.round(contribution),
      cmRatio,
      breakevenRevenue,
      marginOfSafety,
      operatingLeverage,
      chartData,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/ratios
// ────────────────────────────────────────────────────────────────────────────
router.get('/ratios', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const [arRow, apRow, cashRow, fixedRow, revRow, expRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ar FROM invoices WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS ap FROM bills WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(current_balance),0) AS cash FROM bank_accounts WHERE company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(cost - COALESCE(accumulated_depreciation,0)),0) AS net FROM fixed_assets WHERE status != 'disposed' AND company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(CASE WHEN status NOT IN ('draft','cancelled') THEN total_amount ELSE 0 END),0) AS revenue FROM invoices WHERE DATE(invoice_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE DATE(created_at) BETWEEN $1 AND $2 AND status='approved' AND company_id = $3`, [fyStart, fyEnd, cid]),
    ]);

    const ar       = n(arRow.ar);
    const ap       = n(apRow.ap);
    const cash     = n(cashRow.cash);
    const netFixed = n(fixedRow.net);
    const revenue  = n(revRow.revenue);
    const expenses = n(expRow.expenses);

    const currentAssets = cash + ar;
    const totalAssets   = Math.max(currentAssets + netFixed, 1);
    const equity        = Math.max(currentAssets + netFixed - ap, 1);
    const cogs          = revenue * 0.50;
    const grossProfit   = revenue - cogs;
    const netProfit     = grossProfit - expenses;

    // Safe ratio helpers — return null (→ N/A) when denominator is zero
    const sd  = (num, den) => den > 0 ? parseFloat((num / den).toFixed(2)) : null;
    const sp  = (num, den) => den > 0 ? parseFloat(((num / den) * 100).toFixed(1)) : null;
    const fmt = (v) => parseFloat((v || 0).toFixed(2));

    // Derive good/watch/risk status relative to benchmark
    const ratioStatus = (value, benchmark, lowerBetter = false) => {
      if (value === null || value === undefined) return 'neutral';
      if (lowerBetter) {
        if (value <= benchmark)        return 'good';
        if (value <= benchmark * 1.5)  return 'watch';
        return 'risk';
      }
      if (value >= benchmark)          return 'good';
      if (value >= benchmark * 0.6)    return 'watch';
      return 'risk';
    };

    const _cr  = sd(currentAssets, ap);
    const _qr  = sd(cash + ar, ap);
    const _csr = sd(cash, ap);
    const _gm  = sp(grossProfit, revenue);
    const _nm  = sp(netProfit, revenue);
    const _roa = sp(netProfit, totalAssets);
    const _roe = sp(netProfit, equity);
    const _art = ar > 0 ? parseFloat((revenue / ar).toFixed(1)) : null;
    const _at  = sd(revenue, totalAssets);
    const _de  = sd(ap, equity);
    const _er  = sp(equity, totalAssets);

    const ratios = {
      liquidity: [
        {
          name: 'Current Ratio', value: _cr, benchmark: 2.0, unit: 'x',
          status: ratioStatus(_cr, 2.0),
          description: 'Measures short-term obligation coverage.',
          components: { 'Current Assets': fmt(currentAssets), 'Current Liabilities (AP)': fmt(ap) },
        },
        {
          name: 'Quick Ratio', value: _qr, benchmark: 1.0, unit: 'x',
          status: ratioStatus(_qr, 1.0),
          description: 'Liquidity excluding inventory.',
          components: { 'Cash & Bank': fmt(cash), 'Accounts Receivable': fmt(ar), 'Current Liabilities (AP)': fmt(ap) },
        },
        {
          name: 'Cash Ratio', value: _csr, benchmark: 0.5, unit: 'x',
          status: ratioStatus(_csr, 0.5),
          description: 'Strictest liquidity — cash only vs. liabilities.',
          components: { 'Cash & Bank': fmt(cash), 'Current Liabilities (AP)': fmt(ap) },
        },
      ],
      profitability: [
        {
          name: 'Gross Margin', value: _gm, benchmark: 40, unit: '%',
          status: ratioStatus(_gm, 40),
          description: 'Profit after cost of goods sold.',
          components: { 'Revenue': fmt(revenue), 'Est. COGS (50%)': fmt(cogs), 'Gross Profit': fmt(grossProfit) },
        },
        {
          name: 'Net Margin', value: _nm, benchmark: 10, unit: '%',
          status: ratioStatus(_nm, 10),
          description: 'Bottom-line profit percentage.',
          components: { 'Net Profit': fmt(netProfit), 'Revenue': fmt(revenue) },
        },
        {
          name: 'ROA', value: _roa, benchmark: 5, unit: '%',
          status: ratioStatus(_roa, 5),
          description: 'Return generated on total assets.',
          components: { 'Net Profit': fmt(netProfit), 'Total Assets': fmt(totalAssets) },
        },
        {
          name: 'ROE', value: _roe, benchmark: 15, unit: '%',
          status: ratioStatus(_roe, 15),
          description: "Return generated on shareholders' equity.",
          components: { 'Net Profit': fmt(netProfit), 'Equity': fmt(equity) },
        },
      ],
      efficiency: [
        {
          name: 'AR Turnover', value: _art, benchmark: 8, unit: 'x',
          status: ratioStatus(_art, 8),
          description: 'How fast receivables are collected.',
          components: { 'Revenue': fmt(revenue), 'Accounts Receivable': fmt(ar) },
        },
        {
          name: 'Asset Turnover', value: _at, benchmark: 1, unit: 'x',
          status: ratioStatus(_at, 1),
          description: 'Revenue generated per rupee of assets.',
          components: { 'Revenue': fmt(revenue), 'Total Assets': fmt(totalAssets) },
        },
      ],
      leverage: [
        {
          name: 'Debt/Equity', value: _de, benchmark: 2.0, unit: 'x',
          status: ratioStatus(_de, 2.0, true),
          description: 'Financial leverage — debt vs. shareholder equity.',
          components: { 'Total Debt (AP)': fmt(ap), 'Equity': fmt(equity) },
        },
        {
          name: 'Equity Ratio', value: _er, benchmark: 50, unit: '%',
          status: ratioStatus(_er, 50),
          description: 'Proportion of assets financed by equity.',
          components: { 'Equity': fmt(equity), 'Total Assets': fmt(totalAssets) },
        },
      ],
    };

    res.json({ ratios });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /statements/export/income-statement  — CSV download
// GET /statements/export/balance-sheet     — CSV download
// GET /statements/export/cash-flow         — CSV download
// ────────────────────────────────────────────────────────────────────────────

function toCSV(rows) {
  if (!rows || rows.length === 0) return 'No data';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(','))
  ];
  return lines.join('\r\n');
}

router.get('/export/income-statement', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);
    // Re-use the income-statement logic but return CSV
    const [revRow, expRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(CASE WHEN status IN ('paid','partially_paid','approved') THEN total_amount ELSE 0 END),0) AS revenue,
                 COALESCE(SUM(CASE WHEN status IN ('paid','partially_paid') THEN total_amount ELSE 0 END),0) AS collected
          FROM invoices WHERE DATE(invoice_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE((SELECT SUM(total_amount) FROM bills    WHERE DATE(bill_date)  BETWEEN $1 AND $2 AND status NOT IN ('draft','rejected') AND company_id = $3), 0) AS bills_total,
                 COALESCE((SELECT SUM(amount)       FROM expenses WHERE DATE(created_at) BETWEEN $1 AND $2 AND status NOT IN ('draft','rejected') AND company_id = $3), 0) AS expense_total
          `, [fyStart, fyEnd, cid]),
    ]);
    const revenue  = n(revRow.revenue);
    const opEx     = n(expRow.bills_total) + n(expRow.expense_total);
    const cogs     = revenue * 0.50;
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - opEx;
    const rows = [
      { Item: 'Revenue',          Amount: revenue.toFixed(2) },
      { Item: 'COGS (Est.)',      Amount: (-cogs).toFixed(2) },
      { Item: 'Gross Profit',     Amount: grossProfit.toFixed(2) },
      { Item: 'Operating Expenses',Amount: (-opEx).toFixed(2) },
      { Item: 'Net Profit',       Amount: netProfit.toFixed(2) },
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="income-statement-${fyStart}.csv"`);
    res.send(toCSV(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export/balance-sheet', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyEnd } = fyRange(req.query);
    const cid = companyOf(req);
    const [arRow, apRow, cashRow, fixedRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ar FROM invoices WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS ap FROM bills WHERE status NOT IN ('paid','cancelled','draft') AND company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(current_balance),0) AS cash FROM bank_accounts WHERE company_id = $1`, [cid]),
      q1(`SELECT COALESCE(SUM(cost),0) AS gross, COALESCE(SUM(accumulated_depreciation),0) AS dep FROM fixed_assets WHERE status != 'disposed' AND company_id = $1`, [cid]),
    ]);
    const ar = n(arRow.ar); const ap = n(apRow.ap); const cash = n(cashRow.cash);
    const netFixed = n(fixedRow.gross) - n(fixedRow.dep);
    const equity = Math.max(0, cash + ar + netFixed - ap);
    const rows = [
      { Section: 'ASSETS', Item: 'Cash & Bank',            Amount: cash.toFixed(2) },
      { Section: 'ASSETS', Item: 'Accounts Receivable',    Amount: ar.toFixed(2) },
      { Section: 'ASSETS', Item: 'Fixed Assets (Net)',      Amount: netFixed.toFixed(2) },
      { Section: 'ASSETS', Item: 'TOTAL ASSETS',           Amount: (cash + ar + netFixed).toFixed(2) },
      { Section: 'LIABILITIES', Item: 'Accounts Payable',  Amount: ap.toFixed(2) },
      { Section: 'EQUITY', Item: 'Retained Earnings',      Amount: equity.toFixed(2) },
      { Section: 'TOTAL', Item: 'TOTAL LIAB + EQUITY',     Amount: (ap + equity).toFixed(2) },
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="balance-sheet-${fyEnd}.csv"`);
    res.send(toCSV(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export/cash-flow', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);
    const [receiptsRow, paymentsRow, expRow, assetRow] = await Promise.all([
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM receipts  WHERE DATE(receipt_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM payments  WHERE DATE(payment_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses  WHERE DATE(created_at)   BETWEEN $1 AND $2 AND status = 'approved' AND company_id = $3`, [fyStart, fyEnd, cid]),
      q1(`SELECT COALESCE(SUM(cost),0)   AS total FROM fixed_assets WHERE DATE(purchase_date) BETWEEN $1 AND $2 AND company_id = $3`, [fyStart, fyEnd, cid]),
    ]);
    const inflow  = n(receiptsRow.total);
    const outflow = n(paymentsRow.total) + n(expRow.total);
    const capex   = n(assetRow.total);
    const rows = [
      { Activity: 'Operating', Item: 'Cash Receipts from Customers', Amount: inflow.toFixed(2) },
      { Activity: 'Operating', Item: 'Cash Paid for Operations',     Amount: (-outflow).toFixed(2) },
      { Activity: 'Operating', Item: 'Net Operating Cash Flow',      Amount: (inflow - outflow).toFixed(2) },
      { Activity: 'Investing', Item: 'Capital Expenditure',          Amount: (-capex).toFixed(2) },
      { Activity: 'Net',       Item: 'Net Change in Cash',           Amount: (inflow - outflow - capex).toFixed(2) },
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="cash-flow-${fyStart}.csv"`);
    res.send(toCSV(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /statements/sales-register — GST Sales Register (for audit/GSTR reconciliation) ──
router.get('/sales-register', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const rows = await qN(`
      SELECT
        i.invoice_number,
        DATE(i.invoice_date)  AS invoice_date,
        p.name               AS customer_name,
        p.gstin              AS customer_gstin,
        i.place_of_supply,
        i.taxable_amount,
        COALESCE(i.cgst, 0)  AS cgst,
        COALESCE(i.sgst, 0)  AS sgst,
        COALESCE(i.igst, 0)  AS igst,
        COALESCE(i.cgst, 0) + COALESCE(i.sgst, 0) + COALESCE(i.igst, 0) AS total_gst,
        i.total_amount,
        i.status
      FROM invoices i
      LEFT JOIN parties p ON p.id = i.party_id
      WHERE DATE(i.invoice_date) BETWEEN $1 AND $2
        AND i.company_id = $3
        AND i.status NOT IN ('draft','cancelled')
      ORDER BY i.invoice_date, i.invoice_number
    `, [fyStart, fyEnd, cid]);

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-register-${fyStart}-to-${fyEnd}.csv"`);
      return res.send(toCSV(rows));
    }

    res.json({
      period: { from: fyStart, to: fyEnd },
      count: rows.length,
      total_sales: rows.reduce((s, r) => s + n(r.total_amount), 0),
      total_gst: rows.reduce((s, r) => s + n(r.total_gst), 0),
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /statements/purchase-register — GST Purchase Register ─────────────────
router.get('/purchase-register', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { fyStart, fyEnd } = fyRange(req.query);
    const cid = companyOf(req);

    const rows = await qN(`
      SELECT
        b.bill_number,
        DATE(b.bill_date)    AS bill_date,
        p.name               AS supplier_name,
        p.gstin              AS supplier_gstin,
        b.taxable_amount,
        COALESCE(b.cgst, 0)  AS cgst,
        COALESCE(b.sgst, 0)  AS sgst,
        COALESCE(b.igst, 0)  AS igst,
        COALESCE(b.cgst, 0) + COALESCE(b.sgst, 0) + COALESCE(b.igst, 0) AS total_gst,
        b.total_amount       AS amount,
        b.tds_amount,
        b.status
      FROM bills b
      LEFT JOIN parties p ON p.id = b.supplier_id
      WHERE DATE(b.bill_date) BETWEEN $1 AND $2
        AND b.company_id = $3
        AND b.status NOT IN ('draft','cancelled')
      ORDER BY b.bill_date, b.bill_number
    `, [fyStart, fyEnd, cid]);

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="purchase-register-${fyStart}-to-${fyEnd}.csv"`);
      return res.send(toCSV(rows));
    }

    res.json({
      period: { from: fyStart, to: fyEnd },
      count: rows.length,
      total_purchases: rows.reduce((s, r) => s + n(r.amount), 0),
      total_gst: rows.reduce((s, r) => s + n(r.total_gst), 0),
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /statements/customer-outstanding ─────────────────────────────────────
router.get('/customer-outstanding', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const rows = await qN(`
      SELECT
        p.name      AS customer_name,
        p.gstin     AS gstin,
        p.phone,
        COUNT(i.id) AS invoice_count,
        COALESCE(SUM(i.total_amount), 0)                                  AS total_billed,
        COALESCE(SUM(COALESCE(i.amount_paid, 0)), 0)                      AS total_paid,
        COALESCE(SUM(i.total_amount - COALESCE(i.amount_paid, 0)), 0)     AS outstanding,
        COALESCE(SUM(CASE WHEN i.due_date < CURRENT_DATE THEN i.total_amount - COALESCE(i.amount_paid,0) ELSE 0 END), 0) AS overdue,
        MIN(i.due_date)                                                    AS oldest_due
      FROM invoices i
      JOIN parties p ON p.id = i.party_id
      WHERE i.status NOT IN ('paid','cancelled','draft')
        AND i.company_id = $1
      GROUP BY p.id, p.name, p.gstin, p.phone
      HAVING SUM(i.total_amount - COALESCE(i.amount_paid, 0)) > 0
      ORDER BY outstanding DESC
    `, [cid]);

    res.json({
      count: rows.length,
      total_outstanding: rows.reduce((s, r) => s + n(r.outstanding), 0),
      total_overdue: rows.reduce((s, r) => s + n(r.overdue), 0),
      customers: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /statements/supplier-outstanding ─────────────────────────────────────
router.get('/supplier-outstanding', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const rows = await qN(`
      SELECT
        p.name      AS supplier_name,
        p.gstin     AS gstin,
        p.phone,
        COUNT(b.id) AS bill_count,
        COALESCE(SUM(b.amount), 0)                                                        AS total_billed,
        COALESCE(SUM(CASE WHEN b.due_date < CURRENT_DATE THEN b.amount ELSE 0 END), 0)   AS overdue,
        COALESCE(SUM(b.amount), 0)                                                        AS outstanding,
        MIN(b.due_date)                                                                   AS oldest_due
      FROM bills b
      JOIN parties p ON p.id = b.supplier_id
      WHERE b.status NOT IN ('paid','cancelled','draft')
        AND b.company_id = $1
      GROUP BY p.id, p.name, p.gstin, p.phone
      ORDER BY outstanding DESC
    `, [cid]);

    res.json({
      count: rows.length,
      total_outstanding: rows.reduce((s, r) => s + n(r.outstanding), 0),
      total_overdue: rows.reduce((s, r) => s + n(r.overdue), 0),
      suppliers: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
