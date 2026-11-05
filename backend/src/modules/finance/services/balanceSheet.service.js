/**
 * balanceSheet.service.js — ONE dated balance sheet, computed from the posted GL.
 *
 * Finance audit finding F10: "calculate a dated snapshot once, use it for page,
 * API and export... never plug equity to manufacture balance."
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * There were three balance sheets and they did not agree:
 *
 *  1. GET /finance/accounting/balance-sheet — GL based, as at a date, with real
 *     equity accounts and retained earnings. Broadly correct; this service is
 *     that computation, lifted out so others can share it.
 *
 *  2. GET /statements/balance-sheet — a hybrid. Inventory, GST, TDS and salary
 *     came from the GL as at fyEnd, but AR, AP and cash were read from the
 *     CURRENT state of invoices, bills and bank_accounts with no as-of
 *     predicate at all. Picking last year in the FY selector changed half the
 *     statement and left the other half at today's values. Worse:
 *
 *       equity = totalAssets - currentLiab - nonCurrentLiab
 *
 *     Equity was not computed, it was PLUGGED — so the statement always
 *     balanced, whatever was wrong with it, and `balanced: true` meant nothing.
 *     Long-term liabilities were hardcoded to 0, and AP summed `bills.amount`
 *     (the invoiced total) rather than what was still unpaid, overstating it by
 *     everything already settled.
 *
 *  3. GET /statements/export/balance-sheet — the CSV. Same current-state reads,
 *     same plugged equity, and it silently DROPPED inventory, GST input credit,
 *     GST/TDS/salary payable. The downloaded file and the screen it came from
 *     disagreed on both the totals and the line items.
 *
 * All three now call computeBalanceSheet(). A figure that appears on the page,
 * in the API and in the CSV is the same figure, computed once, as at one date.
 *
 * ── HOW BALANCES ARE DERIVED ────────────────────────────────────────────────
 * Per account: opening_balance, plus posted journal movement dated on or before
 * as_of_date, signed by the account's normal side. Grouping is by account code
 * range, matching the seeded chart:
 *
 *   1001-1099  current assets        2001-2099  current liabilities
 *   1100-1199  fixed assets          2100-2199  long-term liabilities
 *   3xxx       equity
 *
 * Retained earnings for prior years is the net of Revenue and Expense movement
 * over the PREVIOUS Indian financial year (Apr-Mar), derived from as_of_date.
 */

const DEBIT_NORMAL = ['Asset', 'Expense'];

/**
 * @param {object} executor  pool or transaction client
 * @param {object} opts
 * @param {string} opts.asOfDate   'YYYY-MM-DD'
 * @param {number|null} opts.companyId  from companyOf(req); null = global scope
 */
export async function computeBalanceSheet(executor, { asOfDate, companyId = null }) {
  const [asOfYearStr, asOfMonthStr] = String(asOfDate).split('-');
  const asOfYear = parseInt(asOfYearStr, 10);
  const asOfMonth = parseInt(asOfMonthStr, 10);
  if (!Number.isFinite(asOfYear) || !Number.isFinite(asOfMonth) || asOfMonth < 1 || asOfMonth > 12) {
    const e = new Error('Invalid as_of_date. Expected format YYYY-MM-DD.');
    e.status = 400;
    throw e;
  }

  const { rows: accounts } = await executor.query(
    `SELECT id, code, name, account_type, sub_type, COALESCE(opening_balance, 0) AS opening_balance
       FROM chart_of_accounts
      WHERE is_active = true
        AND ($1::int IS NULL OR company_id = $1::int OR company_id IS NULL)
      ORDER BY code`,
    [companyId]
  );

  const { rows: movements } = await executor.query(
    `SELECT jl.account_id,
            SUM(jl.debit)  AS total_debit,
            SUM(jl.credit) AS total_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.status = 'posted'
        AND je.entry_date <= $1
        AND je.deleted_at IS NULL
        AND ($2::int IS NULL OR je.company_id = $2::int)
      GROUP BY jl.account_id`,
    [asOfDate, companyId]
  );
  const movMap = new Map(movements.map(m => [String(m.account_id), m]));

  const balanceOf = (acc) => {
    const mov = movMap.get(String(acc.id)) || { total_debit: 0, total_credit: 0 };
    const dr = parseFloat(mov.total_debit) || 0;
    const cr = parseFloat(mov.total_credit) || 0;
    const opening = parseFloat(acc.opening_balance) || 0;
    return DEBIT_NORMAL.includes(acc.account_type)
      ? opening + dr - cr
      : opening - dr + cr;
  };

  const inRange = (acc, lo, hi) => acc.code >= lo && acc.code <= hi;
  const withBalance = (list, transform = (a, b) => b) =>
    list.map(a => ({
      id: a.id, code: a.code, name: a.name,
      account_type: a.account_type, sub_type: a.sub_type,
      balance: transform(a, balanceOf(a)),
    }));

  const assets = accounts.filter(a => a.account_type === 'Asset');
  const liabilities = accounts.filter(a => a.account_type === 'Liability');

  const currentAssets = withBalance(assets.filter(a => inRange(a, '1001', '1099')));
  // Accumulated depreciation accounts are typed Asset, so balanceOf() already
  // returns a NEGATIVE natural balance that reduces fixed assets correctly.
  //
  // The inherited code special-cased code 1101 with `-getBalance(a)`, which
  // flipped that negative to a positive and ADDED accumulated depreciation to
  // fixed assets instead of deducting it — overstating assets by twice the
  // accumulated depreciation. Verified on live data: 1101 has a natural balance
  // of -27,500 and the flip contributed +27,500, a 55,000 overstatement, which
  // was exactly the residual left once the missing current-year profit below was
  // accounted for. Its sibling contra accounts 1111 and 1113 were never flipped,
  // so the special case was inconsistent as well as wrong.
  const fixedAssets = withBalance(assets.filter(a => inRange(a, '1100', '1199')));
  const currentLiabilities = withBalance(liabilities.filter(a => inRange(a, '2001', '2099')));
  const longTermLiabilities = withBalance(liabilities.filter(a => inRange(a, '2100', '2199')));
  const equityAccounts = withBalance(accounts.filter(a => a.account_type === 'Equity'));

  // Retained earnings: net Revenue less Expense over the PREVIOUS Indian FY.
  const currentFyStartYear = asOfMonth >= 4 ? asOfYear : asOfYear - 1;
  const prevYearStart = `${currentFyStartYear - 1}-04-01`;
  const prevYearEnd = `${currentFyStartYear}-03-31`;
  const { rows: retainedRows } = await executor.query(
    `SELECT
       COALESCE(SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_profit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
      AND je.status = 'posted'
      AND je.entry_date BETWEEN $1 AND $2
      AND je.deleted_at IS NULL
     JOIN chart_of_accounts coa ON coa.id = jl.account_id
    WHERE coa.account_type IN ('Revenue','Expense')
      AND ($3::int IS NULL OR je.company_id = $3::int)`,
    [prevYearStart, prevYearEnd, companyId]
  );
  const retained_earnings = parseFloat(retainedRows[0]?.net_profit) || 0;

  // Profit for the CURRENT year, from the FY start up to as_of_date.
  //
  // This was missing entirely. Retained earnings covered only the PREVIOUS
  // financial year, so everything earned since 1 April sat in the revenue and
  // expense accounts and reached neither side of the balance sheet — assets grew
  // with each sale while equity did not. On live data that left a 1,560,000 hole.
  // It never showed up before because equity was plugged as assets minus
  // liabilities, which absorbed the gap and reported balanced: true regardless.
  const currentFyStart = `${currentFyStartYear}-04-01`;
  const { rows: currentRows } = await executor.query(
    `SELECT
       COALESCE(SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_profit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
      AND je.status = 'posted'
      AND je.entry_date BETWEEN $1 AND $2
      AND je.deleted_at IS NULL
     JOIN chart_of_accounts coa ON coa.id = jl.account_id
    WHERE coa.account_type IN ('Revenue','Expense')
      AND ($3::int IS NULL OR je.company_id = $3::int)`,
    [currentFyStart, asOfDate, companyId]
  );
  const current_year_earnings = parseFloat(currentRows[0]?.net_profit) || 0;

  const sum = (list) => list.reduce((s, a) => s + a.balance, 0);
  const total_current_assets = sum(currentAssets);
  const total_fixed_assets = sum(fixedAssets);
  const total_assets = total_current_assets + total_fixed_assets;

  const total_current_liabilities = sum(currentLiabilities);
  const total_long_term_liabilities = sum(longTermLiabilities);
  // Equity is SUMMED from the equity accounts plus retained earnings. It is
  // never derived as assets-minus-liabilities: a plugged figure guarantees the
  // sheet balances and so destroys the only check the sheet exists to provide.
  const total_equity = sum(equityAccounts) + retained_earnings + current_year_earnings;
  const total_liabilities_equity = total_current_liabilities + total_long_term_liabilities + total_equity;

  const variance = total_assets - total_liabilities_equity;
  const balanced = total_assets === 0 && total_liabilities_equity === 0
    ? true
    : Math.abs(variance) <= 1;

  return {
    as_of_date: asOfDate,
    current_assets: currentAssets,
    total_current_assets,
    fixed_assets: fixedAssets,
    total_fixed_assets,
    total_assets,
    current_liabilities: currentLiabilities,
    total_current_liabilities,
    long_term_liabilities: longTermLiabilities,
    total_long_term_liabilities,
    equity_accounts: equityAccounts,
    retained_earnings,
    current_year_earnings,
    total_equity,
    total_liabilities_equity,
    variance,
    balanced,
  };
}

export default { computeBalanceSheet };
