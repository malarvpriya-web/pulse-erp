import pool from '../db.js';
import { nextJournalEntryNumber } from '../../../shared/docNumber.js';

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
    const { journal_entry_id, account_id, account_code, description, debit, credit } = data;

    // Resolve account_id from the chart-of-accounts code if only the code is
    // provided. chart_of_accounts stores the code in `code` (aliased account_code
    // elsewhere); journal_entry_lines only persists account_id, not the code.
    let resolvedAccountId = account_id || null;
    if (!resolvedAccountId && account_code) {
      const { rows } = await client.query(
        'SELECT id FROM chart_of_accounts WHERE code = $1 LIMIT 1',
        [account_code]
      );
      resolvedAccountId = rows[0]?.id || null;
    }

    const result = await client.query(
      `INSERT INTO journal_entry_lines
         (journal_entry_id, account_id, description, debit, credit)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [journal_entry_id, resolvedAccountId, description, debit, credit]
    );
    return result.rows[0];
  }

  async postEntry(client, entryId) {
    const result = await client.query(
      `UPDATE journal_entries
       SET is_posted = true, status = 'posted', posted_at = CURRENT_TIMESTAMP,
           total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_entry_lines WHERE journal_entry_id = $1),
           total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = $1)
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
        jel.description as line_description,
        jel.debit,
        jel.credit,
        je.reference_type,
        je.reference_id
       FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE jel.account_id = $1
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
        COALESCE(SUM(jel.debit), 0) as total_debit,
        COALESCE(SUM(jel.credit), 0) as total_credit
       FROM chart_of_accounts coa
       LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
       LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE (je.entry_date BETWEEN $1 AND $2 OR je.entry_date IS NULL)
       AND (je.is_posted = true OR je.status = 'posted' OR je.id IS NULL)
       AND je.deleted_at IS NULL
       GROUP BY coa.id, coa.code, coa.name, coa.account_type
       HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0
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
