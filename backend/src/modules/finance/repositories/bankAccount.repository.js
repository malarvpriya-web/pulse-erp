import pool from '../db.js';

// Older databases created bank_accounts before chart_account_id existed (the
// module_tables migration uses CREATE TABLE IF NOT EXISTS and won't backfill an
// existing table). Separately, some schema lineages declare chart_account_id as
// INTEGER while chart_of_accounts.id is UUID (or vice-versa), which makes the
// join `coa.id = ba.chart_account_id` throw a type-mismatch error at runtime.
// We therefore only enable the GL-derived balance when the column exists AND its
// type matches chart_of_accounts.id; otherwise we degrade to the stored value.
let _hasChartLink;
export async function hasChartAccountLink() {
  if (_hasChartLink === undefined) {
    try {
      const { rows: [t] } = await pool.query(
        `SELECT
           (SELECT data_type FROM information_schema.columns
              WHERE table_name = 'bank_accounts'    AND column_name = 'chart_account_id') AS link_type,
           (SELECT data_type FROM information_schema.columns
              WHERE table_name = 'chart_of_accounts' AND column_name = 'id')              AS coa_id_type`
      );
      const linkType = t?.link_type || null;
      const coaIdType = t?.coa_id_type || null;
      _hasChartLink = !!linkType && !!coaIdType && linkType === coaIdType;
      if (linkType && coaIdType && linkType !== coaIdType) {
        console.warn(
          `[bankAccount] bank_accounts.chart_account_id (${linkType}) does not match ` +
          `chart_of_accounts.id (${coaIdType}); falling back to stored balances.`
        );
      }
    } catch {
      _hasChartLink = false;
    }
  }
  return _hasChartLink;
}

/**
 * Replace the stored (often stale) current_balance with a book balance derived
 * the same way GET /balance-sheet computes it — chart_of_accounts.opening_balance
 * plus net posted movement from the legacy `journal_lines` ledger — so the Bank
 * Accounts page agrees with the Balance Sheet. Falls back to the stored value
 * for accounts with no GL mapping (chart_account_id IS NULL). Keeps the raw
 * value as `stored_balance` for reference/reconciliation.
 */
function withDerivedBalance(row) {
  if (!row) return row;
  const stored = row.current_balance;
  const hasGl = row.chart_account_id != null;
  const derived = hasGl
    ? parseFloat(row.coa_opening_balance || 0) + parseFloat(row.gl_movement || 0)
    : parseFloat(stored || 0);
  const { coa_opening_balance, gl_movement, ...rest } = row;
  return {
    ...rest,
    current_balance: derived,
    stored_balance: stored,
    balance_source: hasGl ? 'ledger' : 'stored',
  };
}

class BankAccountRepository {
  async create(data) {
    const {
      account_name, account_number, bank_name, branch, ifsc_code,
      account_type, currency, opening_balance, opening_date,
      chart_account_id, company_id, is_primary, od_limit,
      swift_code, micr_code, account_number_last4,
    } = data;
    const rawNum = (account_number || '').replace(/\D/g, '');
    const last4  = account_number_last4
      || (rawNum.length >= 4 ? rawNum.slice(-4) : rawNum || null);
    const result = await pool.query(
      `INSERT INTO bank_accounts (
         account_name, account_number, account_number_last4, bank_name, branch, ifsc_code,
         account_type, currency, opening_balance, current_balance, opening_date,
         chart_account_id, company_id, is_primary, od_limit, swift_code, micr_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        account_name, account_number, last4, bank_name, branch, ifsc_code,
        account_type || 'current', currency || 'INR',
        parseFloat(opening_balance || 0), opening_date || null,
        chart_account_id || null, company_id ?? null,
        is_primary || false, od_limit || null,
        swift_code || null, micr_code || null,
      ]
    );
    return result.rows[0];
  }

  async update(id, data) {
    const allowed = [
      'account_name','account_number','bank_name','branch','ifsc_code',
      'account_type','currency','opening_balance','opening_date',
      'chart_account_id','is_primary','od_limit','swift_code','micr_code','is_active',
    ];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return this.findById(id);
    params.push(id);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    const result = await pool.query(
      `UPDATE bank_accounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return result.rows[0];
  }

  async softDelete(id) {
    const result = await pool.query(
      `UPDATE bank_accounts SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0];
  }

  // Returns accounts with MTD inflow/outflow and unreconciled count
  async findAll(filters = {}) {
    let where = 'WHERE ba.deleted_at IS NULL';
    const params = [];

    if (filters.company_id != null) {
      params.push(filters.company_id);
      where += ` AND ba.company_id = $${params.length}`;
    }
    if (filters.is_active !== undefined) {
      params.push(filters.is_active === 'true' || filters.is_active === true);
      where += ` AND ba.is_active = $${params.length}`;
    }

    // GL-derived balance columns only when the schema has chart_account_id.
    const linked = await hasChartAccountLink();
    const glSelect = linked
      ? `, coa.opening_balance AS coa_opening_balance, COALESCE(glm.mv, 0) AS gl_movement`
      : '';
    const glJoins = linked
      ? `LEFT JOIN chart_of_accounts coa ON coa.id = ba.chart_account_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS mv
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE jl.account_id = ba.chart_account_id
             AND je.status = 'posted'
             AND je.entry_date <= CURRENT_DATE
         ) glm ON true`
      : '';

    const result = await pool.query(
      `SELECT
         ba.*,
         COALESCE(uc.cnt, 0)                        AS unreconciled_count,
         COALESCE(mtd.inflow,  0)                   AS mtd_inflow,
         COALESCE(mtd.outflow, 0)                   AS mtd_outflow${glSelect}
       FROM bank_accounts ba
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt
         FROM bank_transactions bt
         WHERE bt.bank_account_id = ba.id AND bt.reconciled = false
       ) uc ON true
       LEFT JOIN LATERAL (
         SELECT
           SUM(CASE WHEN bt.transaction_type = 'Credit' THEN bt.amount ELSE 0 END) AS inflow,
           SUM(CASE WHEN bt.transaction_type = 'Debit'  THEN bt.amount ELSE 0 END) AS outflow
         FROM bank_transactions bt
         WHERE bt.bank_account_id = ba.id
           AND DATE_TRUNC('month', bt.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)
       ) mtd ON true
       ${glJoins}
       ${where}
       ORDER BY ba.is_primary DESC, ba.account_name`,
      params
    );
    return linked ? result.rows.map(withDerivedBalance) : result.rows;
  }

  async findById(id) {
    const linked = await hasChartAccountLink();
    if (!linked) {
      const r = await pool.query(
        'SELECT * FROM bank_accounts WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      return r.rows[0];
    }
    const result = await pool.query(
      `SELECT ba.*, coa.opening_balance AS coa_opening_balance,
              COALESCE(glm.mv, 0) AS gl_movement
       FROM bank_accounts ba
       LEFT JOIN chart_of_accounts coa ON coa.id = ba.chart_account_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS mv
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_id = ba.chart_account_id
           AND je.status = 'posted'
           AND je.entry_date <= CURRENT_DATE
       ) glm ON true
       WHERE ba.id = $1 AND ba.deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ? withDerivedBalance(result.rows[0]) : result.rows[0];
  }

  async updateBalance(client, id, amount, type) {
    const operator = type === 'credit' ? '+' : '-';
    const result = await client.query(
      `UPDATE bank_accounts
       SET current_balance = current_balance ${operator} $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [amount, id]
    );
    return result.rows[0];
  }

  async createTransaction(client, data) {
    const {
      bank_account_id, transaction_date, transaction_type,
      amount, reference_number, description, journal_entry_id,
    } = data;

    const account = await this.findById(bank_account_id);
    const balance_after = transaction_type === 'Credit'
      ? parseFloat(account.current_balance) + parseFloat(amount)
      : parseFloat(account.current_balance) - parseFloat(amount);

    const result = await client.query(
      `INSERT INTO bank_transactions
         (bank_account_id, transaction_date, transaction_type, amount,
          balance_after, reference_number, description, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [bank_account_id, transaction_date, transaction_type, amount,
       balance_after, reference_number, description, journal_entry_id]
    );

    await this.updateBalance(client, bank_account_id, amount,
      transaction_type === 'Credit' ? 'credit' : 'debit');

    return result.rows[0];
  }

  async getTransactions(bankAccountId, startDate, endDate) {
    const result = await pool.query(
      `SELECT * FROM bank_transactions
       WHERE bank_account_id = $1
         AND transaction_date BETWEEN $2 AND $3
       ORDER BY transaction_date DESC, created_at DESC`,
      [bankAccountId, startDate, endDate]
    );
    return result.rows;
  }

  async getUnreconciledTransactions(bankAccountId) {
    const result = await pool.query(
      `SELECT * FROM bank_transactions
       WHERE bank_account_id = $1 AND reconciled = false
       ORDER BY transaction_date`,
      [bankAccountId]
    );
    return result.rows;
  }

  // ── Reconciliation ───────────────────────────────────────────────────────────

  async importStatementLines(bankAccountId, lines) {
    if (!lines?.length) return [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = [];
      for (const line of lines) {
        const r = await client.query(
          `INSERT INTO bank_statement_lines
             (bank_account_id, stmt_date, description, debit, credit, balance, ref_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            bankAccountId, line.date, line.description,
            parseFloat(line.debit || 0), parseFloat(line.credit || 0),
            line.balance != null ? parseFloat(line.balance) : null,
            line.ref_number || null,
          ]
        );
        inserted.push(r.rows[0]);
      }
      await client.query('COMMIT');
      return inserted;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getStatementLines(bankAccountId) {
    const result = await pool.query(
      `SELECT * FROM bank_statement_lines
       WHERE bank_account_id = $1
       ORDER BY stmt_date DESC`,
      [bankAccountId]
    );
    return result.rows;
  }

  // Auto-match: amount + date tolerance ±3 days
  async autoMatch(bankAccountId) {
    const stmtLines = await pool.query(
      `SELECT * FROM bank_statement_lines
       WHERE bank_account_id = $1 AND reconciled = false`,
      [bankAccountId]
    );
    let matched = 0;
    for (const line of stmtLines.rows) {
      const amount = parseFloat(line.credit) > 0 ? line.credit : line.debit;
      const txnType = parseFloat(line.credit) > 0 ? 'Debit' : 'Credit'; // bank credit = book debit
      const txn = await pool.query(
        `SELECT * FROM bank_transactions
         WHERE bank_account_id = $1
           AND transaction_type = $2
           AND ABS(amount - $3) < 0.01
           AND ABS(transaction_date - $4::date) <= 3
           AND reconciled = false
         ORDER BY ABS(transaction_date - $4::date)
         LIMIT 1`,
        [bankAccountId, txnType, amount, line.stmt_date]
      );
      if (txn.rows.length) {
        const t = txn.rows[0];
        await pool.query(
          `UPDATE bank_statement_lines SET reconciled=true, matched_txn_id=$1 WHERE id=$2`,
          [t.id, line.id]
        );
        await pool.query(
          `UPDATE bank_transactions SET reconciled=true, matched_stmt_id=$1 WHERE id=$2`,
          [line.id, t.id]
        );
        matched++;
      }
    }
    return { matched };
  }

  async completeReconciliation(bankAccountId) {
    const result = await pool.query(
      `UPDATE bank_accounts
       SET last_reconciled_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [bankAccountId]
    );
    return result.rows[0];
  }

  async manualMatch(statementLineId, transactionId) {
    await pool.query(
      `UPDATE bank_statement_lines SET reconciled=true, matched_txn_id=$1 WHERE id=$2`,
      [transactionId, statementLineId]
    );
    await pool.query(
      `UPDATE bank_transactions SET reconciled=true, matched_stmt_id=$1 WHERE id=$2`,
      [statementLineId, transactionId]
    );
    return { matched: true };
  }
}

export default new BankAccountRepository();
