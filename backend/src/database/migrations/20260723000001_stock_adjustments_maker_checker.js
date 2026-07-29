/**
 * 20260723000001_stock_adjustments_maker_checker.js
 *
 * stock_adjustments had no status/approval columns at all — a schema-level
 * gap, not just missing route logic. Unlike Cycle Count (which posts to
 * stock_ledger only from a separate `/submit` endpoint gated on
 * `requirePermission('inventory','approve')`), a Stock Adjustment posted to
 * the ledger immediately on creation with a single 'inventory add' permission
 * — no maker-checker at all for a "correct the books" operation.
 *
 * Adds the columns needed for the same maker/checker split: the creator
 * records an adjustment request (status='pending'); a separate approver
 * (inventory:approve) posts it to stock via the shared postStock() helper,
 * or rejects it. Additive-only, defaults keep existing rows valid.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_stockadj_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending'`);
  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS created_by INTEGER`);
  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS approved_by INTEGER`);
  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
  await safe(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await safe(`ALTER TABLE stock_adjustments ADD CONSTRAINT chk_stock_adjustments_status CHECK (status IN ('pending','approved','rejected'))`);

  // Existing rows all had immediate effect on the ledger under the old
  // single-step flow — mark them approved so history doesn't read as an
  // unreviewed backlog.
  await safe(`UPDATE stock_adjustments SET status = 'approved' WHERE status = 'pending' AND created_at < NOW()`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE stock_adjustments DROP CONSTRAINT IF EXISTS chk_stock_adjustments_status`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS rejection_reason`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS approved_at`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS approved_by`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS created_by`);
  await knex.raw(`ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS status`);
}
