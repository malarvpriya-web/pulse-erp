import pool from '../db.js';
import { nextJournalEntryNumber } from '../../../shared/docNumber.js';
import {
  assertBalanced,
  assertAccountsUsable,
  assertNotLocked,
  assertPeriodOpen,
} from '../services/postingGuards.js';

// NOTE: There were historically two child ledger tables under journal_entries —
// `journal_entry_lines` (minimal columns, written by the auto-posting services)
// and `journal_lines` (richer: account_code/account_name/narration/cost_centre/
// project_id/company_id, written by manual journal entries, reversals, payroll
// journal, credit/debit notes, and read by accounting.routes.js's Trial Balance/
// P&L/Balance Sheet). Reports only ever read one side, so postings never showed
// up as a complete, agreeing financial picture. This repository now writes and
// reads `journal_lines` exclusively so every posting path shares one ledger.
class JournalRepository {
  /**
   * Create a journal entry.
   *
   * COMPANY ATTRIBUTION
   * -------------------
   * `company_id` was not in the column list, so every entry written through this
   * repository — invoices, receipts, payments, bills, COGS, depreciation: nine
   * call sites — landed with a NULL company. That is not cosmetic: every
   * company-scoped financial report filters `je.company_id = $n`, so those
   * entries were invisible to the tenant that created them. The CFO dashboard
   * reported "no journal entries posted for this period" while nine posted
   * entries sat in the table (see ANALYTICS_AI_FINAL_HARDENING_REPORT.md §3.5).
   *
   * Callers should pass `company_id` from `companyOf(req)`. When they cannot,
   * it is derived from the source document rather than left null — every
   * reference table this posts against carries a company_id of its own, and an
   * entry attributed to the wrong tenant would be worse than one attributed to
   * none, so the derivation only ever reads the row it is already referencing.
   */
  async createEntry(client, data) {
    const {
      entry_number, entry_date, entry_type, reference_type, reference_id,
      description, created_by,
    } = data;

    const companyId = data.company_id
      ?? await this.#deriveCompanyId(client, reference_type, reference_id);

    const result = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, entry_type, reference_type, reference_id,
          description, created_by, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [entry_number, entry_date, entry_type, reference_type, reference_id,
       description, created_by, companyId ?? null]
    );
    return result.rows[0];
  }

  /**
   * Best-effort company for an entry whose caller did not supply one.
   *
   * Maps reference_type to the table it points at and reads that row's
   * company_id. Returns null when the reference type is unknown or the lookup
   * fails — a null company is the pre-existing behaviour, so this can only
   * improve attribution, never corrupt it.
   */
  async #deriveCompanyId(client, referenceType, referenceId) {
    if (!referenceType || referenceId == null) return null;
    const SOURCE = {
      invoice:             'invoices',
      bill:                'bills',
      receipt:             'receipts',
      payment:             'payments',
      payment_transaction: 'payment_transactions',
      fixed_asset:         'fixed_assets',
      depreciation:        'fixed_assets',
      asset_disposal:      'fixed_assets',
      sales_order:         'sales_orders',
      purchase_order:      'purchase_orders',
    };
    const table = SOURCE[String(referenceType).toLowerCase()];
    if (!table) return null;
    try {
      const { rows } = await client.query(
        `SELECT company_id FROM ${table} WHERE id = $1`, [referenceId]);
      return rows[0]?.company_id ?? null;
    } catch {
      return null;   // unknown table/column — fall back to the old behaviour
    }
  }

  /**
   * Create a journal line.
   *
   * COMPANY ATTRIBUTION
   * -------------------
   * A line used to store whatever `company_id` the caller happened to pass, and
   * invoice/COGS services set it on the header but not the line — so the line
   * landed NULL under a correctly attributed entry. That split matters because
   * the reports disagree about which column to filter: statements.routes.js and
   * funds-flow filter `jl.company_id`, while accounting.routes.js filters
   * `je.company_id`. The same valid posting therefore appeared in one report and
   * vanished from the other.
   *
   * A line belongs to whatever company its entry belongs to — there is no case
   * where they legitimately differ — so an unsupplied company is inherited from
   * the header rather than stored as NULL.
   */
  async createLine(client, data) {
    const {
      journal_entry_id, account_id, account_code, description,
      debit, credit, cost_centre, project_id,
    } = data;

    let companyId = data.company_id ?? null;
    if (companyId == null && journal_entry_id != null) {
      const { rows } = await client.query(
        'SELECT company_id FROM journal_entries WHERE id = $1',
        [journal_entry_id]
      );
      companyId = rows[0]?.company_id ?? null;
    }

    // Resolve account_id (and the canonical code/name) from the chart-of-accounts
    // code when only the code is provided. chart_of_accounts stores the code in
    // `code`, not `account_code` — resolve both here so callers never need to know.
    //
    // Both lookups are company-qualified. Account codes are not globally unique:
    // an unqualified `WHERE code = $1 LIMIT 1` could resolve to another tenant's
    // account of the same code and post this line against it. NULL-company rows
    // are the shared chart and stay eligible; a company's own row wins ordering.
    let resolvedAccountId = account_id || null;
    let resolvedCode = account_code || null;
    let resolvedName = null;
    if (resolvedAccountId) {
      const { rows } = await client.query(
        `SELECT code, name FROM chart_of_accounts
          WHERE id = $1
            AND ($2::int IS NULL OR company_id = $2::int OR company_id IS NULL)
          LIMIT 1`,
        [resolvedAccountId, companyId]
      );
      if (rows[0]) { resolvedCode = rows[0].code; resolvedName = rows[0].name; }
    } else if (account_code) {
      const { rows } = await client.query(
        `SELECT id, code, name FROM chart_of_accounts
          WHERE code = $1
            AND ($2::int IS NULL OR company_id = $2::int OR company_id IS NULL)
          ORDER BY company_id NULLS LAST
          LIMIT 1`,
        [account_code, companyId]
      );
      if (rows[0]) { resolvedAccountId = rows[0].id; resolvedCode = rows[0].code; resolvedName = rows[0].name; }
    }

    const result = await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, account_code, account_name, narration, debit, credit, cost_centre, project_id, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [journal_entry_id, resolvedAccountId, resolvedCode, resolvedName, description || null,
       debit || 0, credit || 0, cost_centre || null, project_id || null, companyId]
    );
    return result.rows[0];
  }

  /**
   * Post an entry to the general ledger.
   *
   * This is the chokepoint: the invoice, bill, receipt, payment-batch, COGS,
   * depreciation, invoice-payment and payroll services all post through here,
   * and it used to set status='posted' and sum the totals without validating
   * anything. Every control the manual route advertised — balanced lines, a
   * resolvable active account, an unlocked period, an open period — was
   * therefore bypassed by every automatic posting in the system.
   *
   * The guards live in postingGuards.js so the manual route and this path
   * enforce one definition rather than two that drift. They run on the caller's
   * transaction client, so a rejected posting rolls back with the rest of the
   * work rather than leaving a half-written document behind.
   */
  async postEntry(client, entryId) {
    const { rows: entries } = await client.query(
      'SELECT id, company_id, entry_date, status FROM journal_entries WHERE id = $1',
      [entryId]
    );
    const entry = entries[0];
    if (!entry) {
      const e = new Error(`Journal entry ${entryId} not found.`);
      e.status = 404;
      throw e;
    }
    // Idempotency: posting is not repeatable. Without this a retried caller
    // re-stamped posted_at and re-summed totals on a live ledger entry.
    if (entry.status !== 'draft') {
      const e = new Error(`Cannot post entry with status '${entry.status}'.`);
      e.status = 400;
      e.code = 'NOT_DRAFT';
      throw e;
    }

    const { rows: lines } = await client.query(
      'SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1',
      [entryId]
    );

    assertBalanced(lines);
    await assertAccountsUsable(client, lines, entry.company_id);
    await assertNotLocked(client, entry.company_id, entry.entry_date);
    await assertPeriodOpen(client, entry.company_id, entry.entry_date);

    const result = await client.query(
      `UPDATE journal_entries
       SET is_posted = true, status = 'posted', posted_at = CURRENT_TIMESTAMP,
           total_debit  = (SELECT COALESCE(SUM(debit),  0) FROM journal_lines WHERE entry_id = $1),
           total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_lines WHERE entry_id = $1)
       WHERE id = $1 AND status = 'draft' RETURNING *`,
      [entryId]
    );
    return result.rows[0];
  }

  /**
   * General ledger for one account.
   *
   * `companyId` is required for tenant safety and optional only in the sense
   * that null means a genuine global scope (a super admin with no company).
   * Callers must pass companyOf(req); omitting it reads every tenant's postings.
   */
  async getGeneralLedger(accountId, startDate, endDate, companyId = null) {
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
       AND ($4::int IS NULL OR je.company_id = $4::int)
       ORDER BY je.entry_date, je.entry_number`,
      [accountId, startDate, endDate, companyId]
    );
    return result.rows;
  }

  /**
   * Trial balance totals per account.
   *
   * Movement is aggregated in a derived table BEFORE it meets the chart of
   * accounts — the same shape accounting.routes.js's /profit-loss uses. The
   * previous two-LEFT-JOIN form could not express this filter safely:
   *
   *  - putting the entry predicates in WHERE drops accounts with no movement,
   *    silently turning the LEFT JOIN into an inner one;
   *  - putting them in the ON clause keeps the account, but a line whose entry
   *    failed the predicate still contributes its debit/credit to the SUM,
   *    because the line joined even though the entry did not.
   *
   * Aggregating first sidesteps both, and removes the multi-child-join fan-out
   * risk that has bitten period-close totals in this codebase before.
   */
  async getTrialBalance(startDate, endDate, companyId = null) {
    const result = await pool.query(
      `SELECT
        coa.code,
        coa.name,
        coa.account_type,
        COALESCE(m.total_debit, 0)  AS total_debit,
        COALESCE(m.total_credit, 0) AS total_credit
       FROM chart_of_accounts coa
       LEFT JOIN (
         SELECT jl.account_id,
                SUM(jl.debit)  AS total_debit,
                SUM(jl.credit) AS total_credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         WHERE je.entry_date BETWEEN $1 AND $2
           AND (je.is_posted = true OR je.status = 'posted')
           AND je.deleted_at IS NULL
           AND ($3::int IS NULL OR je.company_id = $3::int)
         GROUP BY jl.account_id
       ) m ON m.account_id = coa.id
       WHERE ($3::int IS NULL OR coa.company_id = $3::int OR coa.company_id IS NULL)
         AND (COALESCE(m.total_debit, 0) != 0 OR COALESCE(m.total_credit, 0) != 0)
       ORDER BY coa.code`,
      [startDate, endDate, companyId]
    );
    return result.rows;
  }

  async getNextEntryNumber(client) {
    return nextJournalEntryNumber(client);
  }
}

export default new JournalRepository();
