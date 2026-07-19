/**
 * 20260716000006_travel_expense_borne_by.js
 *
 * Travel: company vs personal expense split.
 *
 * borne_by records who carries the cost of an expense line — the company, or
 * the employee personally (e.g. a personal meal on a company trip). Personal
 * lines count toward the trip's Total but are never Payable.
 *
 * Existing rows backfill to 'company': every line captured before this split
 * existed went through reimbursement, which is company-borne by definition.
 * The backfill runs before the CHECK so the constraint can't trip on NULLs.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[travel_expense_borne_by] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('travel_expense_items add borne_by',
    `ALTER TABLE travel_expense_items ADD COLUMN IF NOT EXISTS borne_by VARCHAR(10) DEFAULT 'company'`);

  await safe('backfill borne_by',
    `UPDATE travel_expense_items SET borne_by = 'company' WHERE borne_by IS NULL`);

  await safe('drop stale check',
    `ALTER TABLE travel_expense_items DROP CONSTRAINT IF EXISTS chk_tei_borne_by`);

  await safe('add borne_by check',
    `ALTER TABLE travel_expense_items
       ADD CONSTRAINT chk_tei_borne_by CHECK (borne_by IN ('company', 'personal'))`);

  await safe('index borne_by',
    `CREATE INDEX IF NOT EXISTS idx_tei_borne_by ON travel_expense_items(borne_by)`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`ALTER TABLE travel_expense_items DROP CONSTRAINT IF EXISTS chk_tei_borne_by`);
  await safe(`DROP INDEX IF EXISTS idx_tei_borne_by`);
  await safe(`ALTER TABLE travel_expense_items DROP COLUMN IF EXISTS borne_by`);
}
