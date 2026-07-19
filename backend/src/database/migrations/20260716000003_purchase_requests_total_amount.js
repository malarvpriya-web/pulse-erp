/**
 * 20260716000003_purchase_requests_total_amount.js
 *
 * The live purchase_requests table is missing two columns the code assumes:
 *   - total_amount : drives amount-based approval routing (L1/L2/CFO) and all PR
 *     value reporting. It appears in the base CREATE TABLE migration but the live
 *     table (created via an earlier path) never had it, so PR headers had no value
 *     and every PR routed as 'auto' (approval-limit bypass).
 *   - updated_at   : already referenced by prRepo.updateStatus / recomputeTotal.
 *
 * This adds both idempotently and backfills total_amount from existing line items
 * so historical PRs get a correct value.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[pr_total_amount] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('pr add total_amount',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) DEFAULT 0`);
  await safe('pr add updated_at',
    `ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // Backfill header value from line items for existing requisitions.
  await safe('pr backfill total_amount from line items', `
    UPDATE purchase_requests pr
       SET total_amount = COALESCE((
             SELECT SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0))
             FROM purchase_request_items WHERE pr_id = pr.id
           ), 0)
     WHERE COALESCE(pr.total_amount, 0) = 0
  `);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  // Leave updated_at in place (pre-existing code depends on it); only drop the column this migration is named for.
  await safe(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS total_amount`);
}
