/**
 * A lot must be able to say it failed inspection.
 *
 * inventory_batches.status was constrained to exactly three values:
 *
 *   CHECK (status IN ('active', 'depleted', 'expired'))
 *
 * All three describe AVAILABILITY. None describes QUALITY, so there was no way
 * to record that a lot had been quarantined pending inspection or rejected
 * outright — the state could be held on the GRN, but not on the physical lot
 * that the shop floor actually draws from. "Rejected material cannot be
 * consumed" was therefore unenforceable at the point it matters: the issue.
 *
 * The audit's finding was that QC status never blocked consumption. The hold at
 * goods receipt is real and works (grn.service.js withholds the batch and the
 * ledger row together until IQC passes), but once a lot exists there was no
 * expressible state between "active" and "gone".
 *
 * Three quality states are added. They are deliberately distinct:
 *   quarantine  held pending inspection — may still become active
 *   rejected    failed inspection — must never be issued or shipped
 *   hold        blocked for a non-quality reason (engineering change, recall)
 *
 * 'available' is accepted as a synonym for 'active' because several call sites
 * write it and were silently violating the constraint.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_status_check`);
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD CONSTRAINT inventory_batches_status_check
      CHECK (status IS NULL OR status IN
        ('active','available','depleted','expired','quarantine','rejected','hold'))`);

  // Quality provenance on the lot itself, so a block carries its reason and
  // author rather than being an unexplained status change.
  await knex.raw(`ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS quality_status   VARCHAR(16)`);
  await knex.raw(`ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS blocked_reason   TEXT`);
  await knex.raw(`ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS blocked_by       INTEGER`);
  await knex.raw(`ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS blocked_at       TIMESTAMPTZ`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_batches_blocked
                    ON inventory_batches(item_id, status)
                  WHERE status IN ('quarantine','rejected','hold')`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_batches_blocked`);
  for (const c of ['blocked_at', 'blocked_by', 'blocked_reason', 'quality_status']) {
    await knex.raw(`ALTER TABLE inventory_batches DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_status_check`);
  await knex.raw(`UPDATE inventory_batches SET status = 'active'
                   WHERE status IN ('available','quarantine','rejected','hold')`);
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD CONSTRAINT inventory_batches_status_check
      CHECK (status IN ('active','depleted','expired'))`);
}
