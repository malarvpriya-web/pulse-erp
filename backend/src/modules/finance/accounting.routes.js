// backend/src/modules/finance/accounting.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { nextAccountingJournalNumber } from '../../shared/docNumber.js';
import { numberToWordsINR } from '../../shared/numberToWordsINR.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const cid = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };

// ─── Helper: check transaction lock date ─────────────────────────────────────
async function checkLockDate(companyId, entryDate) {
  try {
    const { rows } = await pool.query(
      `SELECT settings->>'lock_date' AS lock_date
       FROM company_settings
       WHERE company_id = $1 AND module = 'finance'
       LIMIT 1`,
      [companyId ?? 0]
    );
    const lockDate = rows[0]?.lock_date;
    if (lockDate && entryDate && entryDate <= lockDate) {
      return `This period is locked (lock date: ${lockDate}). Contact your finance admin to unlock.`;
    }
  } catch {
    // ignore — don't block if settings table unavailable
  }
  return null;
}

// ─── Helper: validate debit/credit balance ────────────────────────────────────
function validateBalance(lines) {
  const sumDebit = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
  const sumCredit = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
  return Math.abs(sumDebit - sumCredit) <= 0.01;
}

// ─── Helper: generate next entry number ───────────────────────────────────────
async function getNextEntryNumber() {
  return nextAccountingJournalNumber();
}

// ─── POST /journal-entries ─────────────────────────────────────────────────────
router.post('/journal-entries', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { entry_date, date, description, entry_type, reference_type, reference_id, lines } = req.body;
    const effectiveDate = entry_date || date;
    // entry_type is NOT NULL in the schema with no default — always supply a value.
    const effectiveEntryType = entry_type || 'manual';
    const companyId = cid(req);

    if (!lines || lines.length === 0) {
      return res.status(400).json({ error: 'At least one journal line is required.' });
    }
    if (!effectiveDate) {
      return res.status(400).json({ error: 'Entry date is required.' });
    }

    const lockErr = await checkLockDate(companyId, effectiveDate);
    if (lockErr) return res.status(403).json({ error: lockErr, code: 'PERIOD_LOCKED' });

    // Enforce require_narration setting: all lines must have narration if enabled
    try {
      const { rows: settRows } = await pool.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'finance' LIMIT 1`,
        [companyId ?? 0]
      );
      const requireNarration = settRows[0]?.settings?.require_narration === true
        || settRows[0]?.settings?.require_narration === 'true';
      if (requireNarration) {
        const missing = lines.filter(l => !l.narration || !String(l.narration).trim());
        if (missing.length > 0) {
          return res.status(400).json({
            error: 'Narration is required for all journal lines (Finance Settings: Require Narration is ON).',
            code: 'NARRATION_REQUIRED',
          });
        }
      }
    } catch { /* don't block if settings unavailable */ }

    // Validate all account_ids exist
    for (const line of lines) {
      const { rows } = await pool.query('SELECT id, code, name FROM chart_of_accounts WHERE id=$1 AND is_active=true', [line.account_id]);
      if (rows.length === 0) {
        return res.status(400).json({ error: `Account ID ${line.account_id} not found or inactive.` });
      }
      line._account_code = rows[0].code;
      line._account_name = rows[0].name;
    }

    if (!validateBalance(lines)) {
      const sumDebit = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
      const sumCredit = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
      return res.status(400).json({ error: `Journal entry is not balanced. Debit: ${sumDebit}, Credit: ${sumCredit}` });
    }

    const entry_number = await getNextEntryNumber();
    const totalDebit = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: entryRows } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, reference_type, reference_id, status, total_debit, total_credit, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING *`,
        [entry_number, effectiveDate, description, effectiveEntryType, reference_type || null, reference_id || null, totalDebit, totalCredit, companyId]
      );
      const entry = entryRows[0];

      const insertedLines = [];
      for (const line of lines) {
        const { rows: lineRows } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [entry.id, line.account_id, line._account_code, line._account_name,
           parseFloat(line.debit || 0), parseFloat(line.credit || 0),
           line.narration || null, line.cost_centre || null, line.project_id || null, companyId]
        );
        insertedLines.push(lineRows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /journal-entries]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /journal-entries/:id/post ───────────────────────────────────────────
router.post('/journal-entries/:id/post', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: entries } = await pool.query('SELECT * FROM journal_entries WHERE id=$1', [id]);
    if (entries.length === 0) return res.status(404).json({ error: 'Journal entry not found.' });
    const entry = entries[0];
    if (entry.status !== 'draft') return res.status(400).json({ error: `Cannot post entry with status '${entry.status}'.` });

    const postLockErr = await checkLockDate(entry.company_id, entry.entry_date?.toISOString?.().split('T')[0] ?? entry.entry_date);
    if (postLockErr) return res.status(403).json({ error: postLockErr, code: 'PERIOD_LOCKED' });

    const { rows: lines } = await pool.query('SELECT * FROM journal_lines WHERE entry_id=$1', [id]);
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Entry lines are not balanced. Cannot post.' });
    }

    // Check period is open for entry_date — only enforced when periods are configured for this company
    const { rows: periodCount } = await pool.query(
      `SELECT COUNT(*) FROM accounting_periods WHERE ($1::int IS NULL OR company_id = $1)`,
      [entry.company_id ?? null]
    );
    if (parseInt(periodCount[0].count) > 0) {
      const { rows: periods } = await pool.query(
        `SELECT * FROM accounting_periods
         WHERE start_date <= $1 AND end_date >= $1 AND status='open'
           AND ($2::int IS NULL OR company_id = $2)`,
        [entry.entry_date, entry.company_id ?? null]
      );
      if (periods.length === 0) {
        return res.status(400).json({ error: `No open accounting period found for date ${entry.entry_date}. Please open the period first.` });
      }
    }

    const { rows: updated } = await pool.query(
      `UPDATE journal_entries SET status='posted', posted_at=NOW() WHERE id=$1 RETURNING *`,
      [id]
    );
    res.json({ ...updated[0], lines });
  } catch (err) {
    console.error('[POST /journal-entries/:id/post]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /journal-entries/:id/reverse ────────────────────────────────────────
router.post('/journal-entries/:id/reverse', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: entries } = await pool.query('SELECT * FROM journal_entries WHERE id=$1', [id]);
    if (entries.length === 0) return res.status(404).json({ error: 'Journal entry not found.' });
    const original = entries[0];
    if (original.status !== 'posted') return res.status(400).json({ error: `Can only reverse posted entries. Current status: '${original.status}'.` });

    const { rows: originalLines } = await pool.query('SELECT * FROM journal_lines WHERE entry_id=$1', [id]);

    const reversalNumber = await getNextEntryNumber();
    const reversalDescription = `Reversal of ${original.description || original.entry_number}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: reversalRows } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, reference_type, reference_id, status, reversal_of_id, total_debit, total_credit, company_id)
         VALUES ($1, NOW()::date, $2, $3, $4, $5, 'posted', $6, $7, $8, $9) RETURNING *`,
        [reversalNumber, reversalDescription, original.entry_type || 'reversal', original.reference_type, original.reference_id, original.id, original.total_credit, original.total_debit, original.company_id]
      );
      const reversal = reversalRows[0];

      const reversalLines = [];
      for (const line of originalLines) {
        const { rows: lineRows } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [reversal.id, line.account_id, line.account_code, line.account_name,
           parseFloat(line.credit), parseFloat(line.debit),
           `Reversal: ${line.narration || ''}`, line.cost_centre, line.project_id, original.company_id]
        );
        reversalLines.push(lineRows[0]);
      }

      await client.query(`UPDATE journal_entries SET status='reversed', posted_at=NOW() WHERE id=$1`, [id]);
      await client.query('COMMIT');
      res.status(201).json({ ...reversal, lines: reversalLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /journal-entries/:id/reverse]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /journal-entries ──────────────────────────────────────────────────────
router.get('/journal-entries', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { date_from, date_to, account_id, status, reference_type, limit = 50, offset = 0 } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    const companyId = cid(req);
    if (companyId) { where.push(`je.company_id = $${idx++}`); params.push(companyId); }
    if (date_from) { where.push(`je.entry_date >= $${idx++}`); params.push(date_from); }
    if (date_to) { where.push(`je.entry_date <= $${idx++}`); params.push(date_to); }
    if (status) { where.push(`je.status = $${idx++}`); params.push(status); }
    if (reference_type) { where.push(`je.reference_type = $${idx++}`); params.push(reference_type); }
    if (account_id) { where.push(`je.id IN (SELECT entry_id FROM journal_lines WHERE account_id = $${idx++})`); params.push(account_id); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const { rows: entries } = await pool.query(
      `SELECT je.* FROM journal_entries je ${whereClause} ORDER BY je.entry_date DESC, je.id DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    if (entries.length === 0) {
      return res.json({ entries: [], total: 0 });
    }

    // Fetch lines for all entries
    const entryIds = entries.map(e => e.id);
    const { rows: allLines } = await pool.query(
      `SELECT * FROM journal_lines WHERE entry_id = ANY($1)`,
      [entryIds]
    );
    const linesByEntry = allLines.reduce((acc, l) => {
      if (!acc[l.entry_id]) acc[l.entry_id] = [];
      acc[l.entry_id].push(l);
      return acc;
    }, {});

    const result = entries.map(e => ({ ...e, lines: linesByEntry[e.id] || [] }));
    res.json({ entries: result, total: result.length });
  } catch (err) {
    console.error('[GET /journal-entries]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /trial-balance ────────────────────────────────────────────────────────
router.get('/trial-balance', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const date_from = req.query.date_from || `${currentYear}-04-01`;
    const date_to = req.query.date_to || today;
    const companyId = cid(req);

    const { rows: accounts } = await pool.query(
      `SELECT * FROM chart_of_accounts WHERE is_active=true ${companyId ? 'AND (company_id = $1 OR company_id IS NULL)' : ''} ORDER BY code`,
      companyId ? [companyId] : []
    );
    if (accounts.length === 0) {
      return res.json({
        accounts_by_type: {}, grand_total_debit: 0, grand_total_credit: 0,
        grand_total_opening_debit: 0, grand_total_opening_credit: 0,
        grand_total_closing_debit: 0, grand_total_closing_credit: 0,
        balanced: true, integrity_basis: 'closing_balances',
        date_range: { date_from: req.query.date_from, date_to: req.query.date_to }
      });
    }

    const jeCidFilter = companyId ? `AND je.company_id = ${companyId}` : '';
    const { rows: openingMovements } = await pool.query(
      `SELECT jl.account_id,
              COALESCE(SUM(jl.debit), 0) AS opening_debit,
              COALESCE(SUM(jl.credit), 0) AS opening_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.status='posted' AND je.entry_date < $1 ${jeCidFilter}
       GROUP BY jl.account_id`,
      [date_from]
    );
    const openingMovMap = openingMovements.reduce((acc, m) => { acc[m.account_id] = m; return acc; }, {});

    const { rows: movements } = await pool.query(
      `SELECT jl.account_id,
              COALESCE(SUM(jl.debit), 0) AS movement_debit,
              COALESCE(SUM(jl.credit), 0) AS movement_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE je.status='posted' AND je.entry_date BETWEEN $1 AND $2 ${jeCidFilter}
       GROUP BY jl.account_id`,
      [date_from, date_to]
    );
    const movMap = movements.reduce((acc, m) => { acc[m.account_id] = m; return acc; }, {});

    const accountsByType = {};
    let grand_total_debit = 0;
    let grand_total_credit = 0;
    let grand_total_opening_debit = 0;
    let grand_total_opening_credit = 0;
    let grand_total_closing_debit = 0;
    let grand_total_closing_credit = 0;

    for (const acc of accounts) {
      const mov = movMap[acc.id] || { movement_debit: 0, movement_credit: 0 };
      const openMov = openingMovMap[acc.id] || { opening_debit: 0, opening_credit: 0 };
      const mDr = parseFloat(mov.movement_debit) || 0;
      const mCr = parseFloat(mov.movement_credit) || 0;
      const preDr = parseFloat(openMov.opening_debit) || 0;
      const preCr = parseFloat(openMov.opening_credit) || 0;
      const baseOpening = parseFloat(acc.opening_balance) || 0;
      const isDebitNormal = ['Asset', 'Expense'].includes(acc.account_type);

      const opening_balance = isDebitNormal
        ? baseOpening + preDr - preCr
        : baseOpening - preDr + preCr;

      const opening_dr = opening_balance > 0 ? opening_balance : 0;
      const opening_cr = opening_balance < 0 ? Math.abs(opening_balance) : 0;

      const closing_balance = isDebitNormal
        ? opening_balance + mDr - mCr
        : opening_balance - mDr + mCr;

      const closing_dr = closing_balance > 0 ? closing_balance : 0;
      const closing_cr = closing_balance < 0 ? Math.abs(closing_balance) : 0;

      grand_total_debit += mDr;
      grand_total_credit += mCr;
      grand_total_opening_debit += opening_dr;
      grand_total_opening_credit += opening_cr;
      grand_total_closing_debit += closing_dr;
      grand_total_closing_credit += closing_cr;

      if (!accountsByType[acc.account_type]) accountsByType[acc.account_type] = [];
      accountsByType[acc.account_type].push({
        id: acc.id,
        account_code: acc.code,
        account_name: acc.name,
        account_type: acc.account_type,
        opening_dr,
        opening_cr,
        movement_debit: mDr,
        movement_credit: mCr,
        closing_dr,
        closing_cr,
      });
    }

    const balanced = Math.abs(grand_total_closing_debit - grand_total_closing_credit) <= 0.01;
    res.json({
      accounts_by_type: accountsByType,
      grand_total_debit,
      grand_total_credit,
      grand_total_opening_debit,
      grand_total_opening_credit,
      grand_total_closing_debit,
      grand_total_closing_credit,
      balanced,
      integrity_basis: 'closing_balances',
      date_range: { date_from, date_to }
    });
  } catch (err) {
    console.error('[GET /trial-balance]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /profit-loss ──────────────────────────────────────────────────────────
router.get('/profit-loss', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const period_from = req.query.period_from || `${currentYear}-04-01`;
    const period_to = req.query.period_to || today;
    const { compare_from, compare_to } = req.query;
    const companyId = cid(req);
    const jeCidFilter = companyId ? `AND je.company_id = ${parseInt(companyId)}` : '';
    const coaCidFilter = companyId ? `AND (coa.company_id = ${parseInt(companyId)} OR coa.company_id IS NULL)` : '';

    async function computePL(from, to) {
      const { rows } = await pool.query(
        `SELECT coa.id, coa.code AS account_code, coa.name AS account_name, coa.account_type, coa.sub_type,
                COALESCE(SUM(p.total_debit),0) AS total_debit,
                COALESCE(SUM(p.total_credit),0) AS total_credit
         FROM chart_of_accounts coa
         LEFT JOIN (
           SELECT jl.account_id,
                  SUM(jl.debit) AS total_debit,
                  SUM(jl.credit) AS total_credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE je.status='posted' AND je.entry_date BETWEEN $1 AND $2 ${jeCidFilter}
           GROUP BY jl.account_id
         ) p ON p.account_id = coa.id
         WHERE coa.account_type IN ('Revenue','Expense') ${coaCidFilter}
         GROUP BY coa.id, coa.code, coa.name, coa.account_type, coa.sub_type
         ORDER BY coa.code`,
        [from, to]
      );

      const revenue_accounts = [];
      const expense_accounts = [];
      let total_revenue = 0, cogs = 0, total_opex = 0, other_income = 0;

      for (const r of rows) {
        const dr = parseFloat(r.total_debit);
        const cr = parseFloat(r.total_credit);
        if (r.account_type === 'Revenue') {
          const net = cr - dr;
          if (r.sub_type === 'other') {
            other_income += net;
          } else {
            total_revenue += net;
          }
          revenue_accounts.push({ ...r, net_amount: net });
        } else {
          const net = dr - cr;
          if (r.sub_type === 'cogs') {
            cogs += net;
          } else {
            total_opex += net;
          }
          expense_accounts.push({ ...r, net_amount: net });
        }
      }

      const gross_profit = total_revenue - cogs;
      const operating_profit = gross_profit - total_opex;
      const net_profit = operating_profit + other_income;
      return { revenue_accounts, total_revenue, cogs, gross_profit, operating_expenses: expense_accounts.filter(e => e.sub_type !== 'cogs'), total_opex, operating_profit, other_income, net_profit };
    }

    const current = await computePL(period_from, period_to);

    // Monthly chart for last 12 months
    const { rows: monthly } = await pool.query(
      `SELECT DATE_TRUNC('month', je.entry_date) AS month,
              SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END) AS revenue,
              SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END) AS expense
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id AND je.status='posted'
       JOIN chart_of_accounts coa ON coa.id=jl.account_id
       WHERE je.entry_date >= NOW() - INTERVAL '12 months' ${jeCidFilter}
       GROUP BY 1 ORDER BY 1`
    );
    const monthly_chart = monthly.map(m => ({
      month: new Date(m.month).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      revenue: parseFloat(m.revenue) || 0,
      expense: parseFloat(m.expense) || 0,
      profit: (parseFloat(m.revenue) || 0) - (parseFloat(m.expense) || 0),
    }));

    let comparison = null;
    if (compare_from && compare_to) {
      comparison = await computePL(compare_from, compare_to);
    }

    res.json({ ...current, comparison, monthly_chart, period_range: { from: period_from, to: period_to } });
  } catch (err) {
    console.error('[GET /profit-loss]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /balance-sheet ────────────────────────────────────────────────────────
router.get('/balance-sheet', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const as_of_date = req.query.as_of_date || new Date().toISOString().split('T')[0];
    const companyId = cid(req);
    const coaCidFilter = companyId ? `AND (company_id = ${parseInt(companyId)} OR company_id IS NULL)` : '';
    const jeCidFilter = companyId ? `AND je.company_id = ${parseInt(companyId)}` : '';

    const { rows: accounts } = await pool.query(`SELECT * FROM chart_of_accounts WHERE is_active=true ${coaCidFilter} ORDER BY code`);
    const { rows: movements } = await pool.query(
      `SELECT jl.account_id,
              SUM(jl.debit) AS total_debit,
              SUM(jl.credit) AS total_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE je.status='posted' AND je.entry_date <= $1 ${jeCidFilter}
       GROUP BY jl.account_id`,
      [as_of_date]
    );
    const movMap = movements.reduce((acc, m) => { acc[m.account_id] = m; return acc; }, {});

    function getBalance(acc) {
      const mov = movMap[acc.id] || { total_debit: 0, total_credit: 0 };
      const dr = parseFloat(mov.total_debit) || 0;
      const cr = parseFloat(mov.total_credit) || 0;
      const opening = parseFloat(acc.opening_balance) || 0;
      if (['Asset', 'Expense'].includes(acc.account_type)) {
        return opening + dr - cr;
      } else {
        return opening - dr + cr;
      }
    }

    const currentAssets = accounts.filter(a => a.account_type === 'Asset' && a.code >= '1001' && a.code <= '1099').map(a => ({ ...a, balance: getBalance(a) }));
    const fixedAssets = accounts.filter(a => a.account_type === 'Asset' && a.code >= '1100' && a.code <= '1199').map(a => ({ ...a, balance: a.code === '1101' ? -getBalance(a) : getBalance(a) }));
    const currentLiabilities = accounts.filter(a => a.account_type === 'Liability' && a.code >= '2001' && a.code <= '2099').map(a => ({ ...a, balance: getBalance(a) }));
    const longTermLiabilities = accounts.filter(a => a.account_type === 'Liability' && a.code >= '2100' && a.code <= '2199').map(a => ({ ...a, balance: getBalance(a) }));
    const equityAccounts = accounts.filter(a => a.account_type === 'Equity').map(a => ({ ...a, balance: getBalance(a) }));

    // Retained earnings from previous FY (India FY Apr-Mar), derived from as_of_date
    const [asOfYearStr, asOfMonthStr] = String(as_of_date).split('-');
    const asOfYear = parseInt(asOfYearStr, 10);
    const asOfMonth = parseInt(asOfMonthStr, 10);
    if (!Number.isFinite(asOfYear) || !Number.isFinite(asOfMonth) || asOfMonth < 1 || asOfMonth > 12) {
      return res.status(400).json({ error: 'Invalid as_of_date. Expected format YYYY-MM-DD.' });
    }
    const currentFyStartYear = asOfMonth >= 4 ? asOfYear : asOfYear - 1;
    const prevFyStartYear = currentFyStartYear - 1;
    const prevYearStart = `${prevFyStartYear}-04-01`;
    const prevYearEnd = `${currentFyStartYear}-03-31`;
    const { rows: retainedRows } = await pool.query(
      `SELECT
         SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END) -
         SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END) AS net_profit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id AND je.status='posted' AND je.entry_date BETWEEN $1 AND $2
       JOIN chart_of_accounts coa ON coa.id=jl.account_id
       WHERE coa.account_type IN ('Revenue','Expense') ${jeCidFilter}`,
      [prevYearStart, prevYearEnd]
    );
    const retained_earnings = parseFloat(retainedRows[0]?.net_profit) || 0;

    const total_current_assets = currentAssets.reduce((s, a) => s + a.balance, 0);
    const total_fixed_assets = fixedAssets.reduce((s, a) => s + a.balance, 0);
    const total_assets = total_current_assets + total_fixed_assets;

    const total_current_liabilities = currentLiabilities.reduce((s, a) => s + a.balance, 0);
    const total_long_term_liabilities = longTermLiabilities.reduce((s, a) => s + a.balance, 0);
    const total_equity = equityAccounts.reduce((s, a) => s + a.balance, 0) + retained_earnings;
    const total_liabilities_equity = total_current_liabilities + total_long_term_liabilities + total_equity;
    const balanced = total_assets === 0 && total_liabilities_equity === 0
      ? true
      : Math.abs(total_assets - total_liabilities_equity) <= 1;

    res.json({
      as_of_date,
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
      total_equity,
      total_liabilities_equity,
      balanced,
    });
  } catch (err) {
    console.error('[GET /balance-sheet]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /general-ledger/:accountId ───────────────────────────────────────────
router.get('/general-ledger/:accountId', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { accountId } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const date_from = req.query.date_from || `${currentYear}-04-01`;
    const date_to = req.query.date_to || today;
    const companyId = cid(req);
    const jeCidFilter = companyId ? `AND je.company_id = ${parseInt(companyId)}` : '';

    const { rows: accRows } = await pool.query('SELECT * FROM chart_of_accounts WHERE id=$1', [accountId]);
    if (accRows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const account = accRows[0];

    // Opening balance = account opening_balance + transactions before date_from
    const { rows: preTx } = await pool.query(
      `SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE jl.account_id=$1 AND je.status='posted' AND je.entry_date < $2 ${jeCidFilter}`,
      [accountId, date_from]
    );
    const baseOpening = parseFloat(account.opening_balance) || 0;
    const preDr = parseFloat(preTx[0].dr) || 0;
    const preCr = parseFloat(preTx[0].cr) || 0;
    let opening_balance;
    if (['Asset', 'Expense'].includes(account.account_type)) {
      opening_balance = baseOpening + preDr - preCr;
    } else {
      opening_balance = baseOpening - preDr + preCr;
    }

    const { rows: txRows } = await pool.query(
      `SELECT jl.*, je.entry_date, je.entry_number, je.description AS je_description, je.reference_type, je.reference_id
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id
       WHERE jl.account_id=$1 AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 ${jeCidFilter}
       ORDER BY je.entry_date, je.id`,
      [accountId, date_from, date_to]
    );

    let running = opening_balance;
    const isDebitNormal = ['Asset', 'Expense'].includes(account.account_type);
    const getIndicator = (balance) => {
      if (Math.abs(balance) <= 0.01) {
        return isDebitNormal ? 'DR' : 'CR';
      }
      if (isDebitNormal) {
        return balance > 0 ? 'DR' : 'CR';
      }
      return balance > 0 ? 'CR' : 'DR';
    };
    const transactions = txRows.map(tx => {
      const dr = parseFloat(tx.debit) || 0;
      const cr = parseFloat(tx.credit) || 0;
      if (isDebitNormal) {
        running = running + dr - cr;
      } else {
        running = running - dr + cr;
      }
      return {
        ...tx,
        running_balance: running,
        balance_indicator: getIndicator(running),
      };
    });

    const closing_balance = running;
    res.json({ account, opening_balance, transactions, closing_balance, date_range: { date_from, date_to } });
  } catch (err) {
    console.error('[GET /general-ledger/:accountId]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chart-of-accounts ────────────────────────────────────────────────────
router.get('/chart-of-accounts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM chart_of_accounts
       WHERE is_active = true
         ${companyId ? 'AND (company_id = $1 OR company_id IS NULL)' : ''}
       ORDER BY code`,
      companyId ? [companyId] : []
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /periods ──────────────────────────────────────────────────────────────
router.get('/periods', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM accounting_periods ORDER BY start_date DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /periods/:id/close ───────────────────────────────────────────────────
router.post('/periods/:id/close', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: periods } = await pool.query('SELECT * FROM accounting_periods WHERE id=$1', [id]);
    if (periods.length === 0) return res.status(404).json({ error: 'Period not found.' });
    const period = periods[0];
    if (period.status !== 'open') return res.status(400).json({ error: `Period is already ${period.status}.` });

    // Check no draft entries in this period
    const { rows: drafts } = await pool.query(
      `SELECT COUNT(*) FROM journal_entries WHERE status='draft' AND entry_date BETWEEN $1 AND $2`,
      [period.start_date, period.end_date]
    );
    if (parseInt(drafts[0].count) > 0) {
      return res.status(400).json({ error: `Cannot close period: ${drafts[0].count} draft journal entries exist within this period.` });
    }

    const { rows: summary } = await pool.query(
      `SELECT
         COALESCE(SUM(je.total_debit),0) AS total_debits,
         COALESCE(SUM(je.total_credit),0) AS total_credits,
         SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END) -
         SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END) AS net_income
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id=je.id
       JOIN chart_of_accounts coa ON coa.id=jl.account_id
       WHERE je.status='posted' AND je.entry_date BETWEEN $1 AND $2`,
      [period.start_date, period.end_date]
    );

    const periodSummary = {
      total_debits: parseFloat(summary[0].total_debits) || 0,
      total_credits: parseFloat(summary[0].total_credits) || 0,
      net_income: parseFloat(summary[0].net_income) || 0,
    };

    const userId = req.user?.userId ?? req.user?.id ?? null;
    const { rows: updated } = await pool.query(
      `UPDATE accounting_periods SET status='closed', closed_by=$1, closed_at=NOW(), period_summary=$2 WHERE id=$3 RETURNING *`,
      [userId, JSON.stringify(periodSummary), id]
    );
    res.json(updated[0]);
  } catch (err) {
    console.error('[POST /periods/:id/close]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /journal-entries/:id ─────────────────────────────────────────────────
router.put('/journal-entries/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { entry_date, description, lines } = req.body;
    const companyId = cid(req);

    const { rows: entries } = await pool.query('SELECT * FROM journal_entries WHERE id=$1', [id]);
    if (entries.length === 0) return res.status(404).json({ error: 'Journal entry not found.' });
    const entry = entries[0];
    if (companyId && parseInt(entry.company_id) !== parseInt(companyId)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (entry.status !== 'draft') {
      return res.status(400).json({ error: `Only draft entries can be edited. Current status: '${entry.status}'.` });
    }
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'At least one line is required.' });

    for (const line of lines) {
      const { rows } = await pool.query(
        'SELECT id, code, name FROM chart_of_accounts WHERE id=$1 AND is_active=true',
        [line.account_id]
      );
      if (rows.length === 0) return res.status(400).json({ error: `Account ${line.account_id} not found or inactive.` });
      line._account_code = rows[0].code;
      line._account_name = rows[0].name;
    }

    if (!validateBalance(lines)) {
      const sumDebit  = lines.reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
      const sumCredit = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
      return res.status(400).json({ error: `Entry not balanced. Debit: ${sumDebit}, Credit: ${sumCredit}` });
    }

    const totalDebit  = lines.reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        `UPDATE journal_entries SET entry_date=$1, description=$2, total_debit=$3, total_credit=$4 WHERE id=$5 RETURNING *`,
        [entry_date || entry.entry_date, description || entry.description, totalDebit, totalCredit, id]
      );
      await client.query('DELETE FROM journal_lines WHERE entry_id=$1', [id]);
      const insertedLines = [];
      for (const line of lines) {
        const { rows: lr } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, line.account_id, line._account_code, line._account_name,
           parseFloat(line.debit || 0), parseFloat(line.credit || 0), line.narration || null, companyId]
        );
        insertedLines.push(lr[0]);
      }
      await client.query('COMMIT');
      res.json({ ...updated[0], lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[PUT /journal-entries/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /journal-entries/:id ──────────────────────────────────────────────
router.delete('/journal-entries/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = cid(req);

    const { rows: entries } = await pool.query('SELECT * FROM journal_entries WHERE id=$1', [id]);
    if (entries.length === 0) return res.status(404).json({ error: 'Journal entry not found.' });
    const entry = entries[0];
    if (companyId && parseInt(entry.company_id) !== parseInt(companyId)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (entry.status !== 'draft') {
      return res.status(400).json({ error: `Only draft entries can be deleted. Current status: '${entry.status}'.` });
    }

    await pool.query('DELETE FROM journal_lines WHERE entry_id=$1', [id]);
    await pool.query('DELETE FROM journal_entries WHERE id=$1', [id]);
    res.json({ message: 'Draft entry deleted successfully.' });
  } catch (err) {
    console.error('[DELETE /journal-entries/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auto-entries/from-invoice/:invoiceId ────────────────────────────────
router.post('/auto-entries/from-invoice/:invoiceId', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const companyId = cid(req);
    const { rows: invoices } = await pool.query(
      `SELECT id, invoice_number, invoice_date, subtotal, tax_amount, total_amount
       FROM invoices
       WHERE id = $1`,
      [invoiceId]
    );
    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const invoice = invoices[0];
    const base_amount = parseFloat(invoice.subtotal) || 0;
    const tax_amount = parseFloat(invoice.tax_amount) || 0;
    const total_amount = parseFloat(invoice.total_amount) || (base_amount + tax_amount);

    const { rows: accounts } = await pool.query(
      `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('1002','4001','2002')`
    );
    const accMap = accounts.reduce((m, a) => { m[a.code] = a; return m; }, {});
    if (!accMap['1002'] || !accMap['4001'] || !accMap['2002']) {
      return res.status(400).json({ error: 'Required chart of accounts for invoice auto-entry is not configured (1002, 4001, 2002).' });
    }

    const lines = [
      { account_id: accMap['1002'].id, _account_code: '1002', _account_name: accMap['1002'].name, debit: total_amount, credit: 0, narration: `Invoice ${invoice.invoice_number || invoiceId} - Accounts Receivable` },
      { account_id: accMap['4001'].id, _account_code: '4001', _account_name: accMap['4001'].name, debit: 0, credit: base_amount, narration: `Invoice ${invoice.invoice_number || invoiceId} - Revenue` },
    ];
    if (tax_amount > 0) {
      lines.push({ account_id: accMap['2002'].id, _account_code: '2002', _account_name: accMap['2002'].name, debit: 0, credit: tax_amount, narration: `Invoice ${invoice.invoice_number || invoiceId} - GST Payable` });
    }
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Auto-generated invoice journal is not balanced.' });
    }

    const entry_number = await getNextEntryNumber();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: entryRows } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, description, reference_type, reference_id, status, total_debit, total_credit, company_id)
         VALUES ($1, $2, $3, 'invoice', $4, 'draft', $5, $6, $7) RETURNING *`,
        [entry_number, invoice.invoice_date || new Date().toISOString().split('T')[0], `Auto-entry: Invoice ${invoice.invoice_number || invoiceId}`, parseInt(invoice.id), total_amount, total_amount, companyId]
      );
      const entry = entryRows[0];
      const insertedLines = [];
      for (const line of lines) {
        const { rows: lr } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [entry.id, line.account_id, line._account_code, line._account_name, line.debit, line.credit, line.narration]
        );
        insertedLines.push(lr[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /auto-entries/from-invoice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auto-entries/from-payment/:paymentId ────────────────────────────────
router.post('/auto-entries/from-payment/:paymentId', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { paymentId } = req.params;
    const companyId = cid(req);
    const { rows: payments } = await pool.query(
      `SELECT id, payment_number, payment_date, amount
       FROM payments
       WHERE id = $1`,
      [paymentId]
    );
    if (payments.length === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    const payment = payments[0];
    const amount = parseFloat(payment.amount) || 0;
    if (amount <= 0) {
      return res.status(400).json({ error: 'Payment amount must be greater than zero for auto-entry.' });
    }

    const { rows: accounts } = await pool.query(
      `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('1001','1002')`
    );
    const accMap = accounts.reduce((m, a) => { m[a.code] = a; return m; }, {});
    if (!accMap['1001'] || !accMap['1002']) {
      return res.status(400).json({ error: 'Required chart of accounts for payment auto-entry is not configured (1001, 1002).' });
    }
    const lines = [
      { account_id: accMap['1001'].id, code: '1001', name: accMap['1001'].name, debit: amount, credit: 0, narration: `Payment ${payment.payment_number || paymentId} received` },
      { account_id: accMap['1002'].id, code: '1002', name: accMap['1002'].name, debit: 0, credit: amount, narration: `Accounts Receivable cleared: Payment ${payment.payment_number || paymentId}` },
    ];
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Auto-generated payment journal is not balanced.' });
    }

    const entry_number = await getNextEntryNumber();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: entryRows } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, description, reference_type, reference_id, status, total_debit, total_credit, company_id)
         VALUES ($1, $2, $3, 'payment', $4, 'draft', $5, $6, $7) RETURNING *`,
        [entry_number, payment.payment_date || new Date().toISOString().split('T')[0], `Auto-entry: Payment ${payment.payment_number || paymentId}`, parseInt(payment.id), amount, amount, companyId]
      );
      const entry = entryRows[0];
      const insertedLines = [];
      for (const line of lines) {
        const { rows: lr } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [entry.id, line.account_id, line.code, line.name, line.debit, line.credit, line.narration]
        );
        insertedLines.push(lr[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /auto-entries/from-payment]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auto-entries/from-bill/:billId ─────────────────────────────────────
router.post('/auto-entries/from-bill/:billId', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { billId } = req.params;
    const companyId = cid(req);
    const { rows: bills } = await pool.query(
      `SELECT id, bill_number, bill_date, subtotal, tax_amount, total_amount
       FROM bills
       WHERE id = $1`,
      [billId]
    );
    if (bills.length === 0) {
      return res.status(404).json({ error: 'Bill not found.' });
    }
    const bill = bills[0];
    const base_amount = parseFloat(bill.subtotal) || 0;
    const tax_amount = parseFloat(bill.tax_amount) || 0;
    const total_amount = parseFloat(bill.total_amount) || (base_amount + tax_amount);

    const { rows: accounts } = await pool.query(
      `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('5001','1040','2001')`
    );
    const accMap = accounts.reduce((m, a) => { m[a.code] = a; return m; }, {});
    if (!accMap['5001'] || !accMap['2001']) {
      return res.status(400).json({ error: 'Required chart of accounts for bill auto-entry is not configured (5001, 2001).' });
    }
    const lines = [
      { account_id: accMap['5001'].id, code: '5001', name: accMap['5001'].name, debit: base_amount, credit: 0, narration: `Bill ${bill.bill_number || billId} - Expense/Purchase` },
      ...(accMap['1040'] && tax_amount > 0 ? [{ account_id: accMap['1040'].id, code: '1040', name: accMap['1040'].name, debit: tax_amount, credit: 0, narration: `Bill ${bill.bill_number || billId} - GST Input Tax Credit` }] : []),
      { account_id: accMap['2001'].id, code: '2001', name: accMap['2001'].name, debit: 0, credit: total_amount, narration: `Bill ${bill.bill_number || billId} - Accounts Payable` },
    ];
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Auto-generated bill journal is not balanced.' });
    }

    const entry_number = await getNextEntryNumber();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: entryRows } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, description, reference_type, reference_id, status, total_debit, total_credit, company_id)
         VALUES ($1, $2, $3, 'bill', $4, 'draft', $5, $6, $7) RETURNING *`,
        [entry_number, bill.bill_date || new Date().toISOString().split('T')[0], `Auto-entry: Bill ${bill.bill_number || billId}`, parseInt(bill.id), total_amount, total_amount, companyId]
      );
      const entry = entryRows[0];
      const insertedLines = [];
      for (const line of lines) {
        const { rows: lr } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [entry.id, line.account_id, line.code, line.name, line.debit, line.credit, line.narration]
        );
        insertedLines.push(lr[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /auto-entries/from-bill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /year-end-close ─────────────────────────────────────────────────────
// Closes the financial year: transfers net P&L to Retained Earnings (3002) and locks all FY periods.
router.post('/year-end-close', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { financial_year } = req.body; // e.g. "2025-26"
    if (!financial_year) return res.status(400).json({ error: 'financial_year is required (e.g. "2025-26")' });

    const [startYearStr, endYearShort] = financial_year.split('-');
    const startYear = parseInt(startYearStr, 10);
    if (isNaN(startYear)) return res.status(400).json({ error: 'Invalid financial_year format. Use "YYYY-YY" e.g. "2025-26"' });
    const fyStart = `${startYear}-04-01`;
    const fyEnd   = `${startYear + 1}-03-31`;
    const companyId = cid(req);
    const userId = req.user?.userId ?? req.user?.id ?? null;
    const jeCidFilter = companyId ? `AND je.company_id = ${parseInt(companyId)}` : '';
    const coaCidFilter = companyId ? `AND (coa.company_id = ${parseInt(companyId)} OR coa.company_id IS NULL)` : '';

    // Check no open draft entries in this FY
    const { rows: drafts } = await pool.query(
      `SELECT COUNT(*) FROM journal_entries WHERE status='draft' AND entry_date BETWEEN $1 AND $2 ${jeCidFilter ? jeCidFilter.replace('AND ', 'AND ') : ''}`,
      [fyStart, fyEnd]
    );
    if (parseInt(drafts[0].count) > 0) {
      return res.status(400).json({ error: `${drafts[0].count} draft journal entries exist in FY ${financial_year}. Post or delete them before closing the year.` });
    }

    // Calculate net P&L for the FY
    const { rows: plRows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN coa.account_type='Revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN coa.account_type='Expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_profit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted' AND je.entry_date BETWEEN $1 AND $2 ${jeCidFilter}
       JOIN chart_of_accounts coa ON coa.id = jl.account_id ${coaCidFilter}
       WHERE coa.account_type IN ('Revenue', 'Expense')`,
      [fyStart, fyEnd]
    );
    const netProfit = parseFloat(plRows[0]?.net_profit) || 0;

    // Look up account IDs for 3002 (Retained Earnings) and 3004 (Current Year P/L)
    const { rows: accts } = await pool.query(
      `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('3002','3004') AND is_active = true ${coaCidFilter ? coaCidFilter.replace('AND (', 'AND (') : ''}`
    );
    const acctMap = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
    if (!acctMap['3002']) return res.status(400).json({ error: 'Account 3002 (Retained Earnings) not found in Chart of Accounts. Add it before year-end close.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create closing journal entry: transfer P&L to Retained Earnings
      // If net profit > 0: DR 3004 (Current Year P/L) / CR 3002 (Retained Earnings)
      // If net loss < 0:   DR 3002 (Retained Earnings) / CR 3004 (Current Year P/L)
      const entryNumber = await nextAccountingJournalNumber(client);
      const absProfit = Math.abs(netProfit);
      const { rows: [je] } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, entry_type, description, reference_type, status, total_debit, total_credit, company_id, created_by)
         VALUES ($1, $2, 'YearEndClose', $3, 'year_end_close', 'posted', $4, $4, $5, $6) RETURNING *`,
        [
          entryNumber,
          fyEnd,
          `Year-end closing entry — FY ${financial_year} (Net ${netProfit >= 0 ? 'Profit' : 'Loss'}: ₹${absProfit.toFixed(2)})`,
          absProfit,
          companyId,
          userId,
        ]
      );

      if (netProfit !== 0) {
        const re = acctMap['3002'];
        const pl = acctMap['3004'];
        // Debit side
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
           VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
          [je.id, netProfit > 0 ? (pl?.id ?? null) : re.id,
           netProfit > 0 ? '3004' : '3002',
           netProfit > 0 ? (pl?.name ?? 'Current Year Profit/Loss') : re.name,
           absProfit,
           `Year-end close FY ${financial_year}`, companyId]
        );
        // Credit side
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
           VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
          [je.id, netProfit > 0 ? re.id : (pl?.id ?? null),
           netProfit > 0 ? '3002' : '3004',
           netProfit > 0 ? re.name : (pl?.name ?? 'Current Year Profit/Loss'),
           absProfit,
           `Year-end close FY ${financial_year}`, companyId]
        );
      }

      // Close all open periods in this FY
      await client.query(
        `UPDATE accounting_periods SET status='closed', closed_by=$1, closed_at=NOW()
         WHERE start_date >= $2 AND end_date <= $3 AND status='open'`,
        [userId, fyStart, fyEnd]
      );

      // Reset Current Year P/L account opening_balance to 0 (new FY starts fresh)
      if (acctMap['3004']) {
        await client.query(
          `UPDATE chart_of_accounts SET opening_balance = 0 WHERE id = $1`,
          [acctMap['3004'].id]
        );
      }

      // Add net profit to Retained Earnings opening_balance
      await client.query(
        `UPDATE chart_of_accounts SET opening_balance = COALESCE(opening_balance, 0) + $1 WHERE id = $2`,
        [netProfit, acctMap['3002'].id]
      );

      await client.query('COMMIT');
      res.json({
        success: true,
        financial_year,
        net_profit: netProfit,
        journal_entry_number: je.entry_number,
        message: `Year-end close complete for FY ${financial_year}. Net ${netProfit >= 0 ? 'profit' : 'loss'} of ₹${absProfit.toFixed(2)} transferred to Retained Earnings.`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /year-end-close]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /opening-balances ────────────────────────────────────────────────────
// Sets opening balances when migrating from a legacy system.
// Accepts an array of { account_id, balance } and:
//   1. Updates chart_of_accounts.opening_balance for each account
//   2. Creates a single "Opening Balance" journal entry so the GL has an audit trail
//
// Balance sign convention: positive = debit-normal accounts carry debit balance,
// credit-normal accounts carry credit balance. Pass a negative value to indicate
// the opposite (e.g., a contra-asset with a credit balance sends a negative number).
router.post('/opening-balances', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { as_of_date, balances, description } = req.body;
    if (!as_of_date) return res.status(400).json({ error: 'as_of_date is required' });
    if (!Array.isArray(balances) || balances.length === 0) {
      return res.status(400).json({ error: 'balances must be a non-empty array of { account_id, balance }' });
    }

    // Resolve accounts and build JE lines
    const lines = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const entry of balances) {
      const { account_id, balance } = entry;
      if (!account_id || balance === undefined || balance === null) continue;

      const { rows } = await pool.query(
        'SELECT id, code, name, account_type FROM chart_of_accounts WHERE id=$1 AND is_active=true',
        [account_id]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: `Account ID ${account_id} not found or inactive.` });
      }
      const acc = rows[0];
      const bal = parseFloat(balance);
      const isDebitNormal = ['Asset', 'Expense'].includes(acc.account_type);

      // Translate signed balance into a debit or credit line
      let debit = 0;
      let credit = 0;
      if (isDebitNormal) {
        if (bal >= 0) { debit = bal; } else { credit = Math.abs(bal); }
      } else {
        if (bal >= 0) { credit = bal; } else { debit = Math.abs(bal); }
      }

      totalDebit  += debit;
      totalCredit += credit;
      lines.push({ account_id: acc.id, _account_code: acc.code, _account_name: acc.name, debit, credit, abs_balance: Math.abs(bal) });
    }

    // The TB must balance — the difference goes to Retained Earnings (3001)
    const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
    if (Math.abs(diff) > 0.01) {
      const { rows: reRows } = await pool.query(
        `SELECT id, code, name FROM chart_of_accounts WHERE code='3001' AND is_active=true LIMIT 1`
      );
      if (reRows.length === 0) {
        return res.status(400).json({
          error: `Opening balances are out of balance by ₹${diff}. Add account 3001 (Retained Earnings) to the chart of accounts, or include it in the balances array to absorb the difference.`,
        });
      }
      const re = reRows[0];
      if (diff > 0) {
        // More debits than credits → credit Retained Earnings
        totalCredit += diff;
        lines.push({ account_id: re.id, _account_code: re.code, _account_name: re.name, debit: 0, credit: diff, abs_balance: diff });
      } else {
        // More credits than debits → debit Retained Earnings
        const absDiff = Math.abs(diff);
        totalDebit += absDiff;
        lines.push({ account_id: re.id, _account_code: re.code, _account_name: re.name, debit: absDiff, credit: 0, abs_balance: absDiff });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update opening_balance on each account
      for (const line of lines) {
        await client.query(
          `UPDATE chart_of_accounts SET opening_balance = $1 WHERE id = $2`,
          [line.abs_balance, line.account_id]
        );
      }

      // 2. Create an audit-trail journal entry
      const entry_number = await getNextEntryNumber();
      const { rows: entryRows } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, entry_type, description, reference_type, status, total_debit, total_credit)
         VALUES ($1,$2,'OpeningBalance',$3,'opening_balance','posted',$4,$5) RETURNING *`,
        [entry_number, as_of_date, description || `Opening balances as of ${as_of_date}`, totalDebit, totalCredit]
      );
      const entry = entryRows[0];

      const insertedLines = [];
      for (const line of lines) {
        const { rows: lr } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [entry.id, line.account_id, line._account_code, line._account_name,
           line.debit, line.credit, 'Opening balance migration']
        );
        insertedLines.push(lr[0]);
      }

      await client.query('COMMIT');
      res.status(201).json({
        message: `Opening balances set for ${lines.length} accounts.`,
        journal_entry: { ...entry, lines: insertedLines },
        as_of_date,
        total_debit: totalDebit,
        total_credit: totalCredit,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /opening-balances]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /payroll-journal ────────────────────────────────────────────────────
// Creates a journal entry from a completed payroll run.
// DR: 5010 (Salaries), 5011 (PF Employer), 5012 (ESI Employer)
// CR: 2040 (Salary Payable)
router.post('/payroll-journal', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { payroll_run_id, payroll_month, net_salary, pf_employer, esi_employer, gross_salary } = req.body;
    if (!payroll_run_id || !payroll_month) {
      return res.status(400).json({ error: 'payroll_run_id and payroll_month are required' });
    }
    const companyId = cid(req);
    const userId = req.user?.userId ?? req.user?.id ?? null;

    const grossAmt = parseFloat(gross_salary || net_salary || 0);
    const pfAmt    = parseFloat(pf_employer || 0);
    const esiAmt   = parseFloat(esi_employer || 0);
    const totalExp = grossAmt + pfAmt + esiAmt;
    const salaryPayable = parseFloat(net_salary || grossAmt);

    if (totalExp <= 0) return res.status(400).json({ error: 'Salary amounts must be greater than zero' });

    // Check if journal already posted for this payroll run
    const { rows: existing } = await pool.query(
      `SELECT id FROM journal_entries WHERE reference_type = 'payroll_run' AND reference_id = $1`,
      [String(payroll_run_id)]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: `Journal entry already exists for payroll run ${payroll_run_id}`, journal_entry_id: existing[0].id });
    }

    const { rows: accts } = await pool.query(
      `SELECT id, code, name FROM chart_of_accounts WHERE code IN ('5010','5011','5012','2040') AND is_active = true`
    );
    const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
    if (!am['5010'] || !am['2040']) {
      return res.status(400).json({ error: 'Required accounts 5010 (Salaries) and 2040 (Salary Payable) not found in COA' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entryNumber = await nextAccountingJournalNumber(client);
      const { rows: [je] } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, entry_type, description, reference_type, reference_id, status, total_debit, total_credit, company_id, created_by)
         VALUES ($1, $2, 'Payroll', $3, 'payroll_run', $4, 'posted', $5, $6, $7, $8) RETURNING *`,
        [
          entryNumber,
          (() => { const [y,m] = payroll_month.split('-').map(Number); return `${payroll_month}-${String(new Date(y,m,0).getDate()).padStart(2,'0')}`; })(), // last day of payroll month
          `Payroll journal — ${payroll_month}`,
          String(payroll_run_id),
          totalExp, salaryPayable,
          companyId, userId,
        ]
      );
      const insertLine = (code, debit, credit, narration) => {
        const a = am[code];
        if (!a || (debit === 0 && credit === 0)) return Promise.resolve();
        return client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [je.id, a.id, code, a.name, debit, credit, narration, companyId]
        );
      };
      await insertLine('5010', grossAmt, 0, `Gross salary — ${payroll_month}`);
      if (pfAmt > 0 && am['5011'])  await insertLine('5011', pfAmt, 0,   `PF employer contribution — ${payroll_month}`);
      if (esiAmt > 0 && am['5012']) await insertLine('5012', esiAmt, 0,  `ESI employer contribution — ${payroll_month}`);
      await insertLine('2040', 0, salaryPayable, `Salary payable — ${payroll_month}`);

      await client.query('COMMIT');
      res.status(201).json({
        success: true,
        journal_entry: { id: je.id, entry_number: je.entry_number, status: 'posted' },
        summary: { gross_salary: grossAmt, pf_employer: pfAmt, esi_employer: esiAmt, salary_payable: salaryPayable },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /payroll-journal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /project-profit-loss/:projectId ───────────────────────────────────────
router.get('/project-profit-loss/:projectId', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { from_date, to_date } = req.query;
    const companyId = cid(req);
    const now = new Date();
    const fyStart = from_date || `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
    const fyEnd   = to_date   || now.toISOString().split('T')[0];

    const { rows: projectRows } = await pool.query(
      `SELECT id, name, status FROM projects WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [projectId, companyId]
    );
    if (projectRows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const { rows } = await pool.query(`
      SELECT
        coa.code,
        coa.name       AS account_name,
        coa.account_type,
        coa.sub_type,
        COALESCE(SUM(jl.debit),  0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        COALESCE(SUM(jl.debit - jl.credit), 0) AS net
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
      WHERE jl.project_id = $1
        AND je.status = 'posted'
        AND DATE(je.entry_date) BETWEEN $2 AND $3
        AND jl.company_id = $4
      GROUP BY coa.code, coa.name, coa.account_type, coa.sub_type
      ORDER BY coa.account_type, coa.code
    `, [projectId, fyStart, fyEnd, companyId]);

    const income  = rows.filter(r => r.account_type === 'Revenue');
    const expense = rows.filter(r => r.account_type === 'Expense');
    const totalIncome  = income.reduce((s, r) => s + parseFloat(r.net), 0);
    const totalExpense = expense.reduce((s, r) => s + parseFloat(r.net), 0);

    res.json({
      project: projectRows[0],
      period: { from_date: fyStart, to_date: fyEnd },
      summary: { totalIncome, totalExpense, netProfit: totalIncome - Math.abs(totalExpense) },
      income,
      expense,
    });
  } catch (err) {
    console.error('[GET /project-profit-loss]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /trial-balance/export — Trial Balance CSV download ────────────────────
router.get('/trial-balance/export', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { as_of_date } = req.query;
    const companyId = cid(req);
    const asOf = as_of_date || new Date().toISOString().split('T')[0];

    const { rows } = await pool.query(`
      SELECT
        coa.code,
        coa.name,
        coa.account_type,
        COALESCE(SUM(jl.debit),  0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit,
        COALESCE(SUM(jl.debit - jl.credit), 0) AS net_balance
      FROM chart_of_accounts coa
      LEFT JOIN journal_lines jl ON jl.account_id = coa.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
        AND je.status = 'posted'
        AND DATE(je.entry_date) <= $1
        AND jl.company_id = $2
      WHERE coa.is_active = true AND coa.company_id = $2
      GROUP BY coa.code, coa.name, coa.account_type
      ORDER BY coa.code
    `, [asOf, companyId]);

    const lines = [
      `"Account Code","Account Name","Type","Total Debit","Total Credit","Net Balance"`,
      ...rows.map(r =>
        `"${r.code}","${r.name}","${r.account_type}","${r.total_debit}","${r.total_credit}","${r.net_balance}"`
      ),
    ];
    const totalDebit  = rows.reduce((s, r) => s + parseFloat(r.total_debit), 0);
    const totalCredit = rows.reduce((s, r) => s + parseFloat(r.total_credit), 0);
    lines.push(`"","TOTAL","","${totalDebit}","${totalCredit}","${totalDebit - totalCredit}"`);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trial-balance-${asOf}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /profit-loss/export — P&L CSV download ────────────────────────────────
router.get('/profit-loss/export', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const companyId = cid(req);
    const now = new Date();
    const fyStart = from_date || `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
    const fyEnd   = to_date   || now.toISOString().split('T')[0];

    const { rows } = await pool.query(`
      SELECT
        coa.code,
        coa.name,
        coa.account_type,
        coa.sub_type,
        COALESCE(SUM(jl.debit  - jl.credit), 0) AS net
      FROM chart_of_accounts coa
      LEFT JOIN journal_lines jl ON jl.account_id = coa.id
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
        AND je.status = 'posted'
        AND DATE(je.entry_date) BETWEEN $1 AND $2
        AND jl.company_id = $3
      WHERE coa.account_type IN ('Revenue','Expense')
        AND coa.is_active = true AND coa.company_id = $3
      GROUP BY coa.code, coa.name, coa.account_type, coa.sub_type
      ORDER BY coa.account_type, coa.code
    `, [fyStart, fyEnd, companyId]);

    const lines = [
      `"Account Code","Account Name","Type","Sub Type","Net Amount"`,
      ...rows.map(r =>
        `"${r.code}","${r.name}","${r.account_type}","${r.sub_type || ''}","${r.net}"`
      ),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="profit-loss-${fyStart}-to-${fyEnd}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TALLY PARITY: Contra Voucher · Day Book · Cash/Bank Book
// ═══════════════════════════════════════════════════════════════════════════════

// A cash/bank account is identified by its sub_type in the chart of accounts.
const CASH_BANK_SUBTYPES = ['cash', 'bank'];

// ─── POST /contra — Contra Voucher (cash↔bank / inter-bank transfer) ───────────
// Tally's Contra voucher moves funds between two cash/bank accounts only.
// Posts a balanced journal entry: DR destination (money in), CR source (money out).
router.post('/contra', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { entry_date, date, from_account_id, to_account_id, amount, narration, reference_number } = req.body;
    const effectiveDate = entry_date || date;
    const companyId = cid(req);
    const amt = parseFloat(amount);

    if (!from_account_id || !to_account_id) {
      return res.status(400).json({ error: 'from_account_id and to_account_id are required.' });
    }
    if (String(from_account_id) === String(to_account_id)) {
      return res.status(400).json({ error: 'Source and destination accounts must be different.' });
    }
    if (!effectiveDate) return res.status(400).json({ error: 'Entry date is required.' });
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }

    const lockErr = await checkLockDate(companyId, effectiveDate);
    if (lockErr) return res.status(403).json({ error: lockErr, code: 'PERIOD_LOCKED' });

    // Both accounts must exist, be active, and be cash/bank accounts
    const { rows: accts } = await pool.query(
      `SELECT id, code, name, sub_type FROM chart_of_accounts
       WHERE id IN ($1,$2) AND is_active = true AND deleted_at IS NULL`,
      [from_account_id, to_account_id]
    );
    const fromAcct = accts.find(a => String(a.id) === String(from_account_id));
    const toAcct   = accts.find(a => String(a.id) === String(to_account_id));
    if (!fromAcct) return res.status(400).json({ error: `Source account ${from_account_id} not found or inactive.` });
    if (!toAcct)   return res.status(400).json({ error: `Destination account ${to_account_id} not found or inactive.` });

    for (const a of [fromAcct, toAcct]) {
      if (!CASH_BANK_SUBTYPES.includes(String(a.sub_type || '').toLowerCase())) {
        return res.status(400).json({
          error: `"${a.name}" is not a cash/bank account. Contra vouchers can only transfer between cash and bank accounts.`,
          code: 'NOT_CASH_BANK_ACCOUNT',
        });
      }
    }

    const entryNumber = await getNextEntryNumber();
    const desc = narration || `Contra: ${fromAcct.name} → ${toAcct.name}`;
    // reference_id is INT — a cheque/UTR string can't go there, so fold it into the description.
    const fullDesc = reference_number ? `${desc} [Ref: ${reference_number}]` : desc;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [entry] } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, entry_type, description, reference_type, status, total_debit, total_credit, company_id, created_by, posted_at)
         VALUES ($1,$2,'Contra',$3,'contra','posted',$4,$4,$5,$6,NOW()) RETURNING *`,
        [entryNumber, effectiveDate, fullDesc, amt, companyId, req.user?.userId ?? req.user?.id ?? null]
      );

      // DR destination (money received), CR source (money paid out)
      const { rows: lines } = await client.query(
        `INSERT INTO journal_lines
           (entry_id, account_id, account_code, account_name, debit, credit, narration, company_id)
         VALUES ($1,$2,$3,$4,$5,0,$6,$7),
                ($1,$8,$9,$10,0,$5,$6,$7)
         RETURNING *`,
        [entry.id, toAcct.id, toAcct.code, toAcct.name, amt, desc, companyId,
         fromAcct.id, fromAcct.code, fromAcct.name]
      );

      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /contra]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: derive a Tally-style voucher-type label for a journal entry ───────
function voucherTypeLabel(entry) {
  const t = String(entry.entry_type || entry.reference_type || '').toLowerCase();
  const map = {
    contra: 'Contra', payment: 'Payment', receipt: 'Receipt',
    invoice: 'Sales', sales: 'Sales', bill: 'Purchase', purchase: 'Purchase',
    credit_note: 'Credit Note', creditnote: 'Credit Note',
    debit_note: 'Debit Note', debitnote: 'Debit Note',
    rcm: 'Journal', rcm_self_invoice: 'Journal',
    depreciation: 'Journal', accrual: 'Journal', adjustment: 'Journal',
    reversal: 'Journal', opening: 'Journal', expense_claim: 'Payment',
    expenseapproval: 'Journal', payroll: 'Journal', manual: 'Journal',
  };
  return map[t] || 'Journal';
}

// ─── GET /day-book — chronological register of all vouchers for a period ───────
// Mirrors Tally's Day Book: every voucher (posted by default) in date order,
// each with its debit/credit legs and a derived voucher type.
router.get('/day-book', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const date_from = req.query.date_from || today;
    const date_to   = req.query.date_to   || date_from;
    const voucher_type = req.query.voucher_type ? String(req.query.voucher_type).toLowerCase() : null;
    const includeDrafts = req.query.include_drafts === 'true';
    const companyId = cid(req);

    const params = [date_from, date_to];
    let idx = 3;
    let where = `je.entry_date BETWEEN $1 AND $2`;
    where += includeDrafts ? ` AND je.status IN ('draft','posted')` : ` AND je.status = 'posted'`;
    if (companyId) { where += ` AND je.company_id = $${idx++}`; params.push(companyId); }

    const { rows: entries } = await pool.query(
      `SELECT je.id, je.entry_number, je.entry_date, je.entry_type, je.reference_type,
              je.reference_id, je.description, je.status, je.total_debit, je.total_credit
       FROM journal_entries je
       WHERE ${where}
       ORDER BY je.entry_date, je.id`,
      params
    );

    let vouchers = [];
    if (entries.length) {
      const ids = entries.map(e => e.id);
      const { rows: allLines } = await pool.query(
        `SELECT entry_id, account_id, account_code, account_name, debit, credit, narration
         FROM journal_lines WHERE entry_id = ANY($1) ORDER BY entry_id, id`,
        [ids]
      );
      const linesByEntry = allLines.reduce((acc, l) => {
        (acc[l.entry_id] = acc[l.entry_id] || []).push(l);
        return acc;
      }, {});
      vouchers = entries.map(e => ({
        ...e,
        voucher_type: voucherTypeLabel(e),
        amount: parseFloat(e.total_debit) || 0,
        lines: linesByEntry[e.id] || [],
      }));
    }

    if (voucher_type) vouchers = vouchers.filter(v => v.voucher_type.toLowerCase() === voucher_type);

    const summary = vouchers.reduce((acc, v) => {
      acc.total_vouchers += 1;
      acc.total_amount   += v.amount;
      acc.by_type[v.voucher_type] = (acc.by_type[v.voucher_type] || 0) + v.amount;
      return acc;
    }, { total_vouchers: 0, total_amount: 0, by_type: {} });

    res.json({ date_range: { date_from, date_to }, summary, vouchers });
  } catch (err) {
    console.error('[GET /day-book]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /cash-bank-book — Cash Book / Bank Book ───────────────────────────────
// book=cash|bank|both (default both), or a specific account_id.
// Returns per-account opening balance, dated transactions with running balance,
// and closing balance — the Tally Cash Book / Bank Book view.
router.get('/cash-bank-book', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const date_from = req.query.date_from || `${currentYear}-04-01`;
    const date_to   = req.query.date_to   || today;
    const book      = (req.query.book || 'both').toLowerCase(); // cash | bank | both
    const account_id = req.query.account_id || null;
    const companyId = cid(req);

    // Resolve which cash/bank accounts to include
    const acctParams = [];
    let acctWhere = `is_active = true AND deleted_at IS NULL`;
    if (companyId) { acctParams.push(companyId); acctWhere += ` AND (company_id = $${acctParams.length} OR company_id IS NULL)`; }
    if (account_id) {
      acctParams.push(account_id); acctWhere += ` AND id = $${acctParams.length}`;
    } else {
      const subs = book === 'cash' ? ['cash'] : book === 'bank' ? ['bank'] : CASH_BANK_SUBTYPES;
      acctParams.push(subs); acctWhere += ` AND LOWER(sub_type) = ANY($${acctParams.length})`;
    }
    const { rows: accounts } = await pool.query(
      `SELECT id, code, name, account_type, sub_type, COALESCE(opening_balance,0) AS opening_balance
       FROM chart_of_accounts WHERE ${acctWhere} ORDER BY sub_type, code`,
      acctParams
    );

    if (accounts.length === 0) {
      return res.json({ date_range: { date_from, date_to }, book, books: [], grand_totals: { opening: 0, inflow: 0, outflow: 0, closing: 0 } });
    }

    const jeCidFilter = companyId ? `AND je.company_id = ${parseInt(companyId)}` : '';
    const books = [];
    const grand = { opening: 0, inflow: 0, outflow: 0, closing: 0 };

    for (const acct of accounts) {
      // Opening = account opening_balance + net (DR-CR) of posted txns before date_from
      const { rows: [pre] } = await pool.query(
        `SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = $1 AND je.status = 'posted' AND je.entry_date < $2 ${jeCidFilter}`,
        [acct.id, date_from]
      );
      // Cash & bank are Asset (debit-normal): balance = opening + DR - CR
      const opening = parseFloat(acct.opening_balance) + parseFloat(pre.dr) - parseFloat(pre.cr);

      const { rows: txns } = await pool.query(
        `SELECT je.entry_date, je.entry_number, je.entry_type, je.reference_type, je.description AS je_description,
                jl.debit, jl.credit, jl.narration
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = $1 AND je.status = 'posted' AND je.entry_date BETWEEN $2 AND $3 ${jeCidFilter}
         ORDER BY je.entry_date, je.id`,
        [acct.id, date_from, date_to]
      );

      let running = opening;
      let inflow = 0, outflow = 0;
      const transactions = txns.map(t => {
        const dr = parseFloat(t.debit) || 0;
        const cr = parseFloat(t.credit) || 0;
        inflow += dr; outflow += cr;
        running = running + dr - cr;
        return {
          entry_date: t.entry_date,
          entry_number: t.entry_number,
          voucher_type: voucherTypeLabel(t),
          particulars: t.narration || t.je_description || '',
          inflow: dr, outflow: cr,
          running_balance: running,
          balance_indicator: running >= 0 ? 'DR' : 'CR',
        };
      });

      books.push({
        account: { id: acct.id, code: acct.code, name: acct.name, sub_type: acct.sub_type },
        opening_balance: opening,
        transactions,
        totals: { inflow, outflow },
        closing_balance: running,
      });
      grand.opening += opening; grand.inflow += inflow; grand.outflow += outflow; grand.closing += running;
    }

    res.json({ date_range: { date_from, date_to }, book, books, grand_totals: grand });
  } catch (err) {
    console.error('[GET /cash-bank-book]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /cash-bank-accounts — helper: list cash/bank accounts for pickers ─────
router.get('/cash-bank-accounts', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [CASH_BANK_SUBTYPES];
    let where = `is_active = true AND deleted_at IS NULL AND LOWER(sub_type) = ANY($1)`;
    if (companyId) { params.push(companyId); where += ` AND (company_id = $${params.length} OR company_id IS NULL)`; }
    const { rows } = await pool.query(
      `SELECT id, code, name, sub_type FROM chart_of_accounts WHERE ${where} ORDER BY sub_type, code`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TALLY PARITY: Interest Calculation on overdue receivables / payables
// ═══════════════════════════════════════════════════════════════════════════════

// Shared handler — kind = 'receivable' (invoices) | 'payable' (bills)
async function interestHandler(kind, req, res) {
  try {
    const companyId = cid(req);
    const asOf      = req.query.as_of_date || new Date().toISOString().split('T')[0];
    const rate      = parseFloat(req.query.rate);          // annual % (required)
    const graceDays = parseInt(req.query.grace_days) || 0;
    const minAmount = parseFloat(req.query.min_amount) || 0;
    const basisDays = parseInt(req.query.basis_days) || 365; // 365 or 360

    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ error: 'A non-negative annual interest rate (rate) is required, e.g. rate=18.' });
    }

    const params = [asOf];
    const alias = kind === 'receivable' ? 'i' : 'b';
    let companyClause = '';
    if (companyId != null) { params.push(companyId); companyClause = `AND ${alias}.company_id = $${params.length}`; }

    const sql = kind === 'receivable'
      ? `SELECT i.id, i.invoice_number AS doc_number,
                TO_CHAR(i.invoice_date,'YYYY-MM-DD') AS doc_date,
                TO_CHAR(COALESCE(i.due_date, i.invoice_date),'YYYY-MM-DD') AS due_date,
                COALESCE(p.name, i.party_name) AS party_name,
                (i.total_amount - COALESCE(i.paid_amount,0))::NUMERIC AS balance,
                ($1::date - COALESCE(i.due_date, i.invoice_date)) AS overdue_days
         FROM invoices i
         LEFT JOIN parties p ON p.id = COALESCE(i.customer_id, i.party_id)
         WHERE i.deleted_at IS NULL
           AND LOWER(COALESCE(i.status,'draft')) NOT IN ('paid','cancelled','void','draft')
           AND (i.total_amount - COALESCE(i.paid_amount,0)) > 0
           ${companyClause}
         ORDER BY overdue_days DESC`
      : `SELECT b.id, b.bill_number AS doc_number,
                TO_CHAR(b.bill_date,'YYYY-MM-DD') AS doc_date,
                TO_CHAR(COALESCE(b.due_date, b.bill_date),'YYYY-MM-DD') AS due_date,
                COALESCE(pt.name, b.party_name) AS party_name,
                (COALESCE(b.net_payable, b.total_amount) - COALESCE(b.paid_amount,0))::NUMERIC AS balance,
                ($1::date - COALESCE(b.due_date, b.bill_date)) AS overdue_days
         FROM bills b
         LEFT JOIN parties pt ON pt.id = b.party_id
         WHERE b.deleted_at IS NULL
           AND LOWER(COALESCE(b.status,'pending')) NOT IN ('paid','cancelled','rejected','draft')
           AND (COALESCE(b.net_payable, b.total_amount) - COALESCE(b.paid_amount,0)) > 0
           ${companyClause}
         ORDER BY overdue_days DESC`;

    const { rows } = await pool.query(sql, params);

    const items = [];
    let totalBalance = 0, totalInterest = 0, overdueCount = 0;
    for (const r of rows) {
      const balance = parseFloat(r.balance) || 0;
      if (balance < minAmount) continue;
      const rawDays = parseInt(r.overdue_days) || 0;
      const chargeableDays = Math.max(0, rawDays - graceDays);
      const interest = Math.round((balance * (rate / 100) * chargeableDays / basisDays) * 100) / 100;
      if (chargeableDays > 0) overdueCount++;
      totalBalance += balance;
      totalInterest += interest;
      items.push({
        id: r.id,
        doc_number: r.doc_number,
        party_name: r.party_name || '—',
        doc_date: r.doc_date,
        due_date: r.due_date,
        balance,
        overdue_days: rawDays,
        chargeable_days: chargeableDays,
        interest,
      });
    }

    res.json({
      kind,
      as_of_date: asOf,
      params: { rate, grace_days: graceDays, min_amount: minAmount, basis_days: basisDays },
      summary: {
        documents: items.length,
        overdue_documents: overdueCount,
        total_outstanding: Math.round(totalBalance * 100) / 100,
        total_interest: Math.round(totalInterest * 100) / 100,
      },
      items,
    });
  } catch (err) {
    console.error(`[GET /interest/${kind}]`, err.message);
    res.status(500).json({ error: err.message });
  }
}

router.get('/interest/receivables', requirePermission('finance', 'view'), (req, res) => interestHandler('receivable', req, res));
router.get('/interest/payables',    requirePermission('finance', 'view'), (req, res) => interestHandler('payable', req, res));

// ═══════════════════════════════════════════════════════════════════════════════
// TALLY PARITY: Cheque Printing / Payment Advice
// ═══════════════════════════════════════════════════════════════════════════════

// POST /cheque/print-data — normalized print payload (amount in words) for a cheque
// / payment advice. Accepts a stored payment_id, or ad-hoc { payee, amount, date }.
router.post('/cheque/print-data', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    let { payment_id, payee, amount, date, bank_name, reference } = req.body;

    if (payment_id) {
      const params = [payment_id];
      let clause = '';
      if (companyId != null) { params.push(companyId); clause = `AND p.company_id = $2`; }
      const { rows: [p] } = await pool.query(
        `SELECT p.amount, p.payment_date, p.reference_number, pt.name AS party_name
         FROM payments p LEFT JOIN parties pt ON pt.id = p.party_id
         WHERE p.id = $1 ${clause}`, params
      );
      if (!p) return res.status(404).json({ error: 'Payment not found' });
      payee     = payee     || p.party_name;
      amount    = amount    ?? p.amount;
      date      = date      || (p.payment_date && new Date(p.payment_date).toISOString().split('T')[0]);
      reference = reference || p.reference_number;
    }

    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'A positive amount is required.' });
    if (!payee) return res.status(400).json({ error: 'A payee name is required.' });

    const printDate = date || new Date().toISOString().split('T')[0];
    const d = new Date(printDate);
    res.json({
      payee,
      amount: amt,
      amount_in_words: numberToWordsINR(amt),
      date: printDate,
      date_boxes: {
        dd: String(d.getDate()).padStart(2, '0'),
        mm: String(d.getMonth() + 1).padStart(2, '0'),
        yyyy: String(d.getFullYear()),
      },
      bank_name: bank_name || '',
      reference: reference || '',
      account_payee: true,
    });
  } catch (err) {
    console.error('[POST /cheque/print-data]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TALLY PARITY: Advanced Vouchers — Memorandum · Optional · Recurring
// ═══════════════════════════════════════════════════════════════════════════════

// Memorandum & Optional vouchers are stored as journal entries with a non-posted
// status, so ledger / trial-balance / statements (which filter status='posted')
// automatically exclude them from the books — matching Tally behaviour.
const SPECIAL_STATUSES = ['memorandum', 'optional'];

router.post('/vouchers/special', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const { entry_date, date, description, status, lines } = req.body;
    const effectiveDate = entry_date || date;
    const companyId = cid(req);

    if (!SPECIAL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${SPECIAL_STATUSES.join(', ')}.` });
    }
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'At least one voucher line is required.' });
    if (!effectiveDate) return res.status(400).json({ error: 'Entry date is required.' });

    for (const line of lines) {
      const { rows } = await pool.query('SELECT id, code, name FROM chart_of_accounts WHERE id=$1 AND is_active=true', [line.account_id]);
      if (rows.length === 0) return res.status(400).json({ error: `Account ID ${line.account_id} not found or inactive.` });
      line._account_code = rows[0].code;
      line._account_name = rows[0].name;
    }
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Voucher is not balanced (total debit must equal total credit).' });
    }

    const entry_number = await getNextEntryNumber();
    const totalDebit = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [entry] } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, status, total_debit, total_credit, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,
        [entry_number, effectiveDate, status, description || null, status, totalDebit, companyId]
      );
      const insertedLines = [];
      for (const line of lines) {
        const { rows: [lr] } = await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [entry.id, line.account_id, line._account_code, line._account_name,
           parseFloat(line.debit || 0), parseFloat(line.credit || 0),
           line.narration || null, line.cost_centre || null, line.project_id || null, companyId]
        );
        insertedLines.push(lr);
      }
      await client.query('COMMIT');
      res.status(201).json({ ...entry, lines: insertedLines });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /vouchers/special]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/vouchers/special', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const type = req.query.type;
    const companyId = cid(req);
    const statuses = SPECIAL_STATUSES.includes(type) ? [type] : SPECIAL_STATUSES;
    const params = [statuses];
    let where = `je.status = ANY($1)`;
    if (companyId) { params.push(companyId); where += ` AND je.company_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT je.* FROM journal_entries je WHERE ${where} ORDER BY je.entry_date DESC, je.id DESC LIMIT 200`,
      params
    );
    res.json({ vouchers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert a memorandum/optional voucher into a regular draft entry (Tally: convert).
router.post('/journal-entries/:id/convert', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const { rows: [entry] } = await pool.query('SELECT * FROM journal_entries WHERE id=$1', [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Voucher not found.' });
    if (!SPECIAL_STATUSES.includes(entry.status)) {
      return res.status(400).json({ error: `Only memorandum/optional vouchers can be converted. Current status: '${entry.status}'.` });
    }
    const lockErr = await checkLockDate(entry.company_id, entry.entry_date?.toISOString?.().split('T')[0] ?? entry.entry_date);
    if (lockErr) return res.status(403).json({ error: lockErr, code: 'PERIOD_LOCKED' });
    const { rows: [updated] } = await pool.query(
      `UPDATE journal_entries SET status='draft', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recurring vouchers ─────────────────────────────────────────────────────────
function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr);
  if (frequency === 'weekly')    d.setDate(d.getDate() + 7);
  else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
  else if (frequency === 'yearly')    d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1); // monthly default
  return d.toISOString().split('T')[0];
}

router.get('/recurring-vouchers', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [];
    let where = `is_active = true`;
    if (companyId) { params.push(companyId); where += ` AND (company_id = $${params.length} OR company_id IS NULL)`; }
    const { rows } = await pool.query(
      `SELECT * FROM recurring_vouchers WHERE ${where} ORDER BY next_run_date NULLS LAST, name`, params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recurring-vouchers', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, description, frequency = 'monthly', next_run_date, source_entry_id } = req.body;
    let lines = req.body.lines;

    if (!name) return res.status(400).json({ error: 'A template name is required.' });

    // Copy lines from an existing journal entry when a source is supplied
    if (source_entry_id) {
      const { rows: srcLines } = await pool.query(
        `SELECT account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id
         FROM journal_lines WHERE entry_id = $1`, [source_entry_id]
      );
      if (srcLines.length === 0) return res.status(400).json({ error: 'Source entry has no lines.' });
      lines = srcLines;
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'Provide lines or a source_entry_id to build the template.' });
    }
    if (!validateBalance(lines)) {
      return res.status(400).json({ error: 'Template lines are not balanced.' });
    }

    const total = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
    const { rows: [row] } = await pool.query(
      `INSERT INTO recurring_vouchers (company_id, name, description, frequency, next_run_date, total_amount, lines, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, name, description || null, frequency, next_run_date || null, total,
       JSON.stringify(lines), req.user?.userId ?? req.user?.id ?? null]
    );
    res.status(201).json(row);
  } catch (err) {
    console.error('[POST /recurring-vouchers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a draft journal entry from the template and advance the schedule.
router.post('/recurring-vouchers/:id/generate', requirePermission('finance', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows: [tpl] } = await pool.query('SELECT * FROM recurring_vouchers WHERE id=$1', [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'Recurring template not found.' });

    const lines = Array.isArray(tpl.lines) ? tpl.lines : JSON.parse(tpl.lines || '[]');
    if (lines.length === 0) return res.status(400).json({ error: 'Template has no lines.' });

    // Normalize dates: pg returns DATE columns as JS Date objects, req.body as strings.
    const toDateStr = v => v == null ? null : (v.toISOString ? v.toISOString().split('T')[0] : String(v).split('T')[0]);
    const entryDate = toDateStr(req.body.entry_date) || toDateStr(tpl.next_run_date) || new Date().toISOString().split('T')[0];

    const lockErr = await checkLockDate(companyId, entryDate);
    if (lockErr) return res.status(403).json({ error: lockErr, code: 'PERIOD_LOCKED' });

    const entry_number = await getNextEntryNumber();
    const totalDebit = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [entry] } = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, entry_type, description, reference_type, status, total_debit, total_credit, company_id)
         VALUES ($1,$2,'recurring',$3,'recurring','draft',$4,$4,$5) RETURNING *`,
        [entry_number, entryDate, `Recurring: ${tpl.name}`, totalDebit, companyId]
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [entry.id, l.account_id, l.account_code, l.account_name,
           parseFloat(l.debit || 0), parseFloat(l.credit || 0),
           l.narration || null, l.cost_centre || null, l.project_id || null, companyId]
        );
      }
      const nextRun = advanceDate(toDateStr(tpl.next_run_date) || entryDate, tpl.frequency);
      await client.query(
        `UPDATE recurring_vouchers SET last_generated_date=$1, next_run_date=$2, updated_at=NOW() WHERE id=$3`,
        [entryDate, nextRun, tpl.id]
      );
      await client.query('COMMIT');
      res.status(201).json({ entry, next_run_date: nextRun });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /recurring-vouchers/:id/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recurring-vouchers/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE recurring_vouchers SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING id`, [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    res.json({ message: 'Template deactivated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
