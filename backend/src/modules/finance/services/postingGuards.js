/**
 * postingGuards.js — the checks that must hold before anything reaches the GL.
 *
 * WHY THIS EXISTS
 * ---------------
 * There were two ways to post a journal entry and they enforced different rules:
 *
 *   - POST /accounting/journal-entries/:id/post validated debit=credit, checked
 *     the transaction lock date, and required an open accounting period.
 *   - journalRepo.postEntry() — called directly by the invoice, bill, receipt,
 *     payment-batch, COGS, depreciation, invoice-payment and payroll services,
 *     ten call sites in all — set status='posted' and summed the totals. It
 *     validated nothing.
 *
 * So every control the manual path advertised was bypassed by every automatic
 * posting in the system. A locked period stopped an accountant keying a journal
 * and did not stop an invoice posting into that same period.
 *
 * These helpers are the single definition of those rules. journalRepo.postEntry
 * runs them, so the automatic paths are governed by exactly what the manual path
 * enforces, and they take the caller's transaction client so a failed check
 * rolls back with the rest of the work.
 */

/**
 * Transaction lock date for a company, or null when none is configured.
 *
 * FAILS CLOSED. The previous copy of this in accounting.routes.js swallowed
 * every error and returned "no lock" — so if company_settings was unreachable,
 * mis-migrated, or the JSON key changed, the lock silently stopped applying and
 * posting into a closed period succeeded. An error checking a financial control
 * is not permission to skip it.
 */
export async function assertNotLocked(executor, companyId, entryDate) {
  if (!entryDate) return;
  let lockDate;
  try {
    const { rows } = await executor.query(
      `SELECT settings->>'lock_date' AS lock_date
         FROM company_settings
        WHERE company_id = $1 AND module = 'finance'
        LIMIT 1`,
      [companyId ?? 0]
    );
    lockDate = rows[0]?.lock_date ?? null;
  } catch (err) {
    const e = new Error(
      `Could not verify the transaction lock date, so this entry was not posted: ${err.message}`
    );
    e.status = 503;
    e.code = 'LOCK_CHECK_UNAVAILABLE';
    throw e;
  }

  const d = normaliseDate(entryDate);
  if (lockDate && d && d <= lockDate) {
    const e = new Error(`This period is locked (lock date: ${lockDate}). Contact your finance admin to unlock.`);
    e.status = 403;
    e.code = 'PERIOD_LOCKED';
    throw e;
  }
}

/**
 * Require an open accounting period covering entryDate — but only when the
 * company actually uses periods. A company with no periods configured is not
 * blocked, which is the behaviour the manual route already had.
 */
export async function assertPeriodOpen(executor, companyId, entryDate) {
  if (!entryDate) return;
  const { rows: count } = await executor.query(
    `SELECT COUNT(*)::int AS n FROM accounting_periods
      WHERE ($1::int IS NULL OR company_id = $1::int)`,
    [companyId ?? null]
  );
  if (count[0].n === 0) return;

  const { rows: open } = await executor.query(
    `SELECT id FROM accounting_periods
      WHERE start_date <= $1 AND end_date >= $1 AND status = 'open'
        AND ($2::int IS NULL OR company_id = $2::int)
      LIMIT 1`,
    [entryDate, companyId ?? null]
  );
  if (open.length === 0) {
    const e = new Error(`No open accounting period found for date ${normaliseDate(entryDate)}. Please open the period first.`);
    e.status = 400;
    e.code = 'PERIOD_NOT_OPEN';
    throw e;
  }
}

/**
 * Debits must equal credits, and there must be something to post.
 *
 * Compared in paise as integers. Summing floats and testing `=== 0` fails on
 * ordinary amounts (0.1 + 0.2), and the tolerance form used elsewhere hides a
 * genuine one-paise break, so the sum is rounded to the minor unit first.
 */
export function assertBalanced(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    const e = new Error('Cannot post an entry with no lines.');
    e.status = 400;
    e.code = 'NO_LINES';
    throw e;
  }
  const paise = (v) => Math.round(parseFloat(v || 0) * 100);
  const debit = lines.reduce((s, l) => s + paise(l.debit), 0);
  const credit = lines.reduce((s, l) => s + paise(l.credit), 0);
  if (debit !== credit) {
    const e = new Error(
      `Entry lines are not balanced: debits ${(debit / 100).toFixed(2)} vs credits ${(credit / 100).toFixed(2)}.`
    );
    e.status = 400;
    e.code = 'UNBALANCED';
    throw e;
  }
  if (debit === 0) {
    const e = new Error('Cannot post an entry whose debits and credits are both zero.');
    e.status = 400;
    e.code = 'ZERO_VALUE';
    throw e;
  }
}

/**
 * Every line must resolve to an account that exists, is active, and belongs to
 * this company (or to the shared NULL-company chart).
 *
 * journal_lines.account_id is nullable in the live schema, so a line could be
 * posted pointing at nothing — it would carry an amount into the totals and
 * then be invisible to every report that joins chart_of_accounts.
 */
export async function assertAccountsUsable(executor, lines, companyId) {
  const ids = [...new Set(lines.map(l => l.account_id).filter(v => v != null))];
  const missing = lines.filter(l => l.account_id == null);
  if (missing.length) {
    const e = new Error(
      `${missing.length} line(s) have no account_id. Every posted line must name a chart-of-accounts account.`
    );
    e.status = 400;
    e.code = 'LINE_WITHOUT_ACCOUNT';
    throw e;
  }
  if (ids.length === 0) return;

  const { rows } = await executor.query(
    `SELECT id, code, is_active FROM chart_of_accounts
      WHERE id = ANY($1::uuid[])
        AND ($2::int IS NULL OR company_id = $2::int OR company_id IS NULL)`,
    [ids, companyId ?? null]
  );
  const found = new Map(rows.map(r => [String(r.id), r]));

  const unknown = ids.filter(id => !found.has(String(id)));
  if (unknown.length) {
    const e = new Error(
      `Account(s) not found for this company: ${unknown.join(', ')}. A journal cannot post against another company's chart.`
    );
    e.status = 400;
    e.code = 'ACCOUNT_NOT_FOUND';
    throw e;
  }
  const inactive = rows.filter(r => r.is_active === false).map(r => r.code);
  if (inactive.length) {
    const e = new Error(`Account(s) are inactive and cannot be posted to: ${inactive.join(', ')}.`);
    e.status = 400;
    e.code = 'ACCOUNT_INACTIVE';
    throw e;
  }
}

/** DATE columns come back as 'YYYY-MM-DD' strings; Date objects do not. */
function normaliseDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

export { normaliseDate };
