/**
 * 20260716000008_expense_claims_created_by.js
 *
 * expense_claims is missing created_by, but travel-reimbursement.routes.js
 * references it in seven places. The consequences were total, not cosmetic:
 *
 *   - POST /reimbursement/claims  → 500 on every create (INSERT names the column)
 *   - GET  /reimbursement/claims  → 500 for the employee role (ownership filter)
 *   - GET/PUT /claims/:id, submit → 500 for the employee role (ownership checks)
 *
 * That is why expense_claims holds only 8 legacy seed rows and not one of the
 * 283 travel requests has a claim against it — the write path has never worked.
 *
 * Every sibling table (travel_advances, travel_requests, travel_expense_items)
 * already carries created_by; expense_claims is the outlier. Nullable, because
 * the 8 pre-existing rows have no recoverable creator.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[expense_claims_created_by] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('expense_claims add created_by',
    `ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS created_by INTEGER`);

  // Ownership lookups filter on it for every employee-role request.
  await safe('index created_by',
    `CREATE INDEX IF NOT EXISTS idx_ec_created_by ON expense_claims(created_by)`);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`DROP INDEX IF EXISTS idx_ec_created_by`);
  await safe(`ALTER TABLE expense_claims DROP COLUMN IF EXISTS created_by`);
}
