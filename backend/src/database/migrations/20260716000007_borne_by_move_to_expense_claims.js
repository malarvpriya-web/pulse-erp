/**
 * 20260716000007_borne_by_move_to_expense_claims.js
 *
 * Relocates the company/personal cost split onto expense_claims.
 *
 * 20260716000006 put borne_by on travel_expense_items, which turns out to be
 * the dead half of a duplicate table family: it has never held a row, nothing
 * in Finance reads it, and the live claim form (/reimbursement/claims) writes
 * to expense_claims instead. Finance already posts journal entries against
 * expense_claims and it already carries advance_adjusted/net_payable, so the
 * split belongs there.
 *
 * borne_by = who carries the cost:
 *   'company'  — reimbursable, counts toward Payable
 *   'personal' — employee's own (e.g. a personal meal on a company trip);
 *                counts toward Total but is never Payable
 *
 * Existing rows backfill to 'company': everything captured before the split
 * existed went through reimbursement, which is company-borne by definition.
 * The column on travel_expense_items is dropped — it was never populated, so
 * there is nothing to migrate across.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[borne_by_move] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('expense_claims add borne_by',
    `ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS borne_by VARCHAR(10) DEFAULT 'company'`);

  await safe('backfill expense_claims.borne_by',
    `UPDATE expense_claims SET borne_by = 'company' WHERE borne_by IS NULL`);

  await safe('drop stale check',
    `ALTER TABLE expense_claims DROP CONSTRAINT IF EXISTS chk_ec_borne_by`);

  await safe('add borne_by check',
    `ALTER TABLE expense_claims
       ADD CONSTRAINT chk_ec_borne_by CHECK (borne_by IN ('company', 'personal'))`);

  // Supports the per-trip company/personal rollup on the advances grid.
  await safe('index claims by trip + split',
    `CREATE INDEX IF NOT EXISTS idx_ec_travel_request_borne_by
       ON expense_claims(travel_request_id, borne_by)`);

  // Unwind 20260716000006 — the column was never populated.
  await safe('drop travel_expense_items check',
    `ALTER TABLE travel_expense_items DROP CONSTRAINT IF EXISTS chk_tei_borne_by`);
  await safe('drop travel_expense_items index',
    `DROP INDEX IF EXISTS idx_tei_borne_by`);
  await safe('drop travel_expense_items.borne_by',
    `ALTER TABLE travel_expense_items DROP COLUMN IF EXISTS borne_by`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`ALTER TABLE expense_claims DROP CONSTRAINT IF EXISTS chk_ec_borne_by`);
  await safe(`DROP INDEX IF EXISTS idx_ec_travel_request_borne_by`);
  await safe(`ALTER TABLE expense_claims DROP COLUMN IF EXISTS borne_by`);
  // Restore what 20260716000006 created, so its own down() stays meaningful.
  await safe(`ALTER TABLE travel_expense_items ADD COLUMN IF NOT EXISTS borne_by VARCHAR(10) DEFAULT 'company'`);
}
