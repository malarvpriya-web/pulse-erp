import pool from '../db.js';
import { nextJournalEntryNumber } from '../../../shared/docNumber.js';

// NOTE: There were historically two child ledger tables under journal_entries —
// `journal_entry_lines` (minimal columns, written by the auto-posting services)
// and `journal_lines` (richer: account_code/account_name/narration/cost_centre/
// project_id/company_id, written by manual journal entries, reversals, payroll
// journal, credit/debit notes, and read by accounting.routes.js's Trial Balance/
// P&L/Balance Sheet). Reports only ever read one side, so postings never showed
// up as a complete, agreeing financial picture. This repository now writes and
// reads `journal_lines` exclusively so every posting path shares one ledger.
class JournalRepository {
  async createEntry(client, data) {
    const { entry_number, entry_date, entry_type, reference_type, reference_id, description, created_by } = data;
    const result = await client.query(
      `INSERT INTO journal_entries (entry_number, entry_date, entry_type, reference_type, reference_id, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [entry_number, entry_date, entry_type, reference_type, reference_id, description, created_by]
    );
    return result.rows[0];
  }

  async createLine(client, data) {
    const {
      journal_entry_id, account_id, account_code, description,
      debit, credit, cost_centre, project_id, company_id,
    } = data;

    // Resolve account_id (and the canonical code/name) from the chart-of-accounts
    // code when only the code is provided. chart_of_accounts stores the code in
    // `code`, not `account_code` — resolve both here so callers never need to know.
    let resolvedAccountId = account_id || null;
    let resolvedCode = account_code || null;
    let resolvedName = null;
    if (resolvedAccountId) {
      const { rows } = await client.query(
        'SELECT code, name FROM chart_of_accounts WHERE id = $1 LIMIT 1',
        [resolvedAccountId]
      );
      if (rows[0]) { resolvedCode = rows[0].code; resolvedName = rows[0].name; }
    } else if (account_code) {
      const { rows } = await client.query(
        'SELECT id, code, name FROM chart_of_accounts WHERE code = $1 LIMIT 1',
        [account_code]
      );
      if (rows[0]) { resolvedAccountId = rows[0].id; resolvedCode = rows[0].code; resolvedName = rows[0].name; }
    }

    const result = await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, account_code, account_name, narration, debit, credit, cost_centre, project_id, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [journal_entry_id, resolvedAccountId, resolvedCode, resolvedName, description || null,
       debit || 0, credit || 0, cost_centre || null, project_id || null, company_id || null]
    );
    return result.rows[0];
  }

  async postEntry(client, entryId) {
    const result = await client.query(
      `UPDATE journal_entries
       SET is_posted = true, status = 'posted', posted_at = CURRENT_TIMESTAMP,
           total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_lines WHERE entry_id = $1),
           total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_lines WHERE entry_id = $1)
       WHERE id = $1 RETURNING *`,
      [entryId]
    );
    return result.rows[0];
  }

  async getGeneralLedger(accountId, startDate, endDate) {
    const result = await pool.query(
      `SELECT
        je.entry_date,
        je.entry_number,
        je.description as entry_description,
        jl.narration as line_description,
        jl.debit,
        jl.credit,
        je.reference_type,
        je.reference_id
       FROM journal_lines jl
       JOIN journal_entries je ON jl.entry_id = je.id
       WHERE jl.account_id = $1
       AND je.entry_date BETWEEN $2 AND $3
       AND (je.is_posted = true OR je.status = 'posted')
       AND je.deleted_at IS NULL
       ORDER BY je.entry_date, je.entry_number`,
      [accountId, startDate, endDate]
    );
    return result.rows;
  }

  async getTrialBalance(startDate, endDate) {
    const result = await pool.query(
      `SELECT
        coa.code,
        coa.name,
        coa.account_type,
        COALESCE(SUM(jl.debit), 0) as total_debit,
        COALESCE(SUM(jl.credit), 0) as total_credit
       FROM chart_of_accounts coa
       LEFT JOIN journal_lines jl ON coa.id = jl.account_id
       LEFT JOIN journal_entries je ON jl.entry_id = je.id
       WHERE (je.entry_date BETWEEN $1 AND $2 OR je.entry_date IS NULL)
       AND (je.is_posted = true OR je.status = 'posted' OR je.id IS NULL)
       AND je.deleted_at IS NULL
       GROUP BY coa.id, coa.code, coa.name, coa.account_type
       HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
       ORDER BY coa.code`,
      [startDate, endDate]
    );
    return result.rows;
  }

  async getNextEntryNumber(client) {
    return nextJournalEntryNumber(client);
  }
}

export default new JournalRepository();
