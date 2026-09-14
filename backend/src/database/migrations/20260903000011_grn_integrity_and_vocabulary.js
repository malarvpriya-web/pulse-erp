/**
 * Goods receipt: repair the inventory rows a non-transactional write left
 * behind, close the hole that produced them, and put the GRN status column on
 * the vocabulary the rest of the product actually reads.
 *
 * ── 1. PHANTOM INVENTORY BATCHES ─────────────────────────────────────────────
 * grn.service.createGRN() runs inside a transaction, but it called
 * `advancedInventoryRepo.createBatch()` — which issues its INSERT on the shared
 * POOL, not on the transaction's client. Every batch it wrote therefore
 * committed immediately and independently of the receipt that caused it, so a
 * GRN that rolled back for any reason (an over-receipt rejection, a failed line,
 * a lost connection) left its inventory behind.
 *
 * This database has four of them: inventory_batches 3, 4, 5 and 6, pointing at
 * goods_receipt_notes 2, 3, 4 and 5 — none of which exist. Together they claim
 * 29 units of item 1 as `quantity_available`, stock that was never received
 * against any receipt that survived. `inventory_batches.grn_id` has no foreign
 * key, which is why nothing objected.
 *
 * They are soft-deleted, not dropped: v_batch_stock filters `deleted_at IS NULL`
 * so the phantom quantity leaves every stock figure immediately, while the row
 * (and its batch_number, which names the GRN it came from) stays available for
 * anyone reconciling the correction. `inventory_items.current_stock` is NOT
 * adjusted — these batches never reached the stock ledger (stock_ledger holds
 * zero rows with reference_type 'grn'), so current_stock never counted them and
 * touching it would introduce the very error this repairs.
 *
 * The FK is then added so an orphan batch is unrepresentable, and the service
 * now threads the transaction client through createBatch().
 *
 * ── 2. GRN STATUS SPOKE A VOCABULARY NO SCREEN READS ─────────────────────────
 * `goods_receipt_notes.status` DEFAULTS to 'draft' and grn.repository.create()
 * never sets one, so every receipt the application has ever raised is 'draft'.
 * GoodsReceipt.jsx keys on 'pending' | 'partial' | 'received' | 'rejected':
 *
 *   - its KPI strip and every status tab count `g.status === '<key>'`, so the
 *     header reads "All (4) · Pending (0) · Partial (0) · Received (0) ·
 *     Rejected (0)" above four visible rows, and clicking any tab returns
 *     "No receipts match your filters";
 *   - the badge helper falls back to the Pending colour for an unknown status,
 *     so the drift is invisible on screen — the rows LOOK pending;
 *   - the Confirm button renders only `if (g.status === 'pending')`. It has
 *     therefore never appeared on a single GRN the app created, which means the
 *     receipt could not be confirmed from the UI at all.
 *
 * This is the same failure as purchase_requests.status ('pending' vs
 * 'pending_approval', migration 20260902000003): a COLUMN DEFAULT quietly
 * defining a workflow the application does not speak.
 *
 * Existing rows are moved onto the canonical vocabulary, the default is changed,
 * and a CHECK constraint is added so the column can only ever hold a value some
 * screen understands. The seeded row GRN-01523-SEED00523 carries status 'active'
 * and quality_status 'active' — neither is a value any code path produces or
 * reads — and is normalised with the rest.
 *
 * ── 3. RECEIPT IDEMPOTENCY ───────────────────────────────────────────────────
 * `idempotency_key` + a partial unique index per company gives a retried POST
 * /grn a way to return the receipt it already created instead of booking the
 * goods a second time. `vendor_dc_number` / `vendor_dc_date` record the
 * supplier's delivery challan — the real-world document a receipt is made
 * against, and the natural business key a storekeeper can use to spot a
 * duplicate.
 */

/** The statuses GoodsReceipt.jsx renders, filters and counts. */
const GRN_STATUSES = ['pending', 'partial', 'received', 'rejected', 'cancelled'];

/** What quality.routes.js's rollupQualityStatus() actually writes, plus the initial state. */
const GRN_QUALITY_STATUSES = ['not_required', 'pending', 'in_progress', 'passed', 'failed'];

export async function up(knex) {
  // ── 1. Phantom batches ─────────────────────────────────────────────────────
  const { rows: orphans } = await knex.raw(`
    SELECT b.id, b.grn_id, b.item_id, b.batch_number, b.quantity_available
      FROM inventory_batches b
     WHERE b.grn_id IS NOT NULL
       AND b.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM goods_receipt_notes g WHERE g.id = b.grn_id)
  `);

  if (orphans.length) {
    await knex.raw(`
      UPDATE inventory_batches
         SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1)
    `, [orphans.map(o => o.id)]);
    const qty = orphans.reduce((s, o) => s + Number(o.quantity_available || 0), 0);
    console.log(
      `[20260903000011] soft-deleted ${orphans.length} orphaned inventory batch(es) claiming ` +
      `${qty} unit(s) of phantom available stock, left behind by receipts that rolled back: ` +
      orphans.map(o => `#${o.id} (${o.batch_number}, grn ${o.grn_id})`).join(', ')
    );
  }

  // The FK is what stops this recurring even if a future writer forgets the
  // transaction client. ON DELETE RESTRICT, not CASCADE: deleting a receipt must
  // not silently delete the stock booked against it — that decision belongs to
  // a reversal, not to a row delete.
  await knex.raw(`
    UPDATE inventory_batches SET grn_id = NULL
     WHERE grn_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM goods_receipt_notes g WHERE g.id = inventory_batches.grn_id)
  `);
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_grn_id_fkey`);
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD CONSTRAINT inventory_batches_grn_id_fkey
      FOREIGN KEY (grn_id) REFERENCES goods_receipt_notes(id) ON DELETE RESTRICT
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inventory_batches_grn ON inventory_batches(grn_id) WHERE grn_id IS NOT NULL`);

  // ── 2. Status vocabulary ───────────────────────────────────────────────────
  // 'draft' and 'active' both mean "this receipt has been booked and nobody has
  // confirmed it yet", which is what 'pending' names in the UI.
  const { rows: moved } = await knex.raw(`
    UPDATE goods_receipt_notes
       SET status = 'pending', updated_at = NOW()
     WHERE COALESCE(status, '') NOT IN (${GRN_STATUSES.map((_, i) => `$${i + 1}`).join(',')})
    RETURNING id, grn_number, status
  `, GRN_STATUSES);

  const { rows: qMoved } = await knex.raw(`
    UPDATE goods_receipt_notes
       SET quality_status = 'not_required', updated_at = NOW()
     WHERE COALESCE(quality_status, '') NOT IN (${GRN_QUALITY_STATUSES.map((_, i) => `$${i + 1}`).join(',')})
    RETURNING id
  `, GRN_QUALITY_STATUSES);

  await knex.raw(`ALTER TABLE goods_receipt_notes ALTER COLUMN status SET DEFAULT 'pending'`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ALTER COLUMN quality_status SET DEFAULT 'not_required'`);

  await knex.raw(`ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS goods_receipt_notes_status_check`);
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      ADD CONSTRAINT goods_receipt_notes_status_check
      CHECK (status IS NULL OR status IN (${GRN_STATUSES.map(s => `'${s}'`).join(',')}))
  `);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS goods_receipt_notes_quality_status_check`);
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      ADD CONSTRAINT goods_receipt_notes_quality_status_check
      CHECK (quality_status IS NULL OR quality_status IN (${GRN_QUALITY_STATUSES.map(s => `'${s}'`).join(',')}))
  `);

  // ── 3. Idempotency + the supplier's own delivery document ──────────────────
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120)`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS vendor_dc_number VARCHAR(80)`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS vendor_dc_date DATE`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_notes_idempotency_key_uq
        ON goods_receipt_notes (company_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL
  `);

  // ── 4. One three-way match per (company, PO, supplier invoice) ─────────────
  // Nothing stopped the same vendor invoice being matched against the same order
  // twice, and each match could then be approved into its own payable bill. The
  // approval route now checks for a duplicate bill before writing, but the match
  // register itself should not be able to hold the duplicate either.
  const { rows: dupMatches } = await knex.raw(`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
               PARTITION BY company_id, po_id, LOWER(TRIM(vendor_invoice_no))
               ORDER BY (match_status = 'approved') DESC, id
             ) AS rn
        FROM three_way_matches
       WHERE vendor_invoice_no IS NOT NULL AND TRIM(vendor_invoice_no) <> ''
    ) t WHERE rn > 1
  `);
  if (dupMatches.length) {
    console.warn(
      `[20260903000011] ${dupMatches.length} duplicate three-way match row(s) found ` +
      `(same company + PO + supplier invoice). Kept the approved/earliest of each; ` +
      `the rest are left in place but the unique index below is created as a partial ` +
      `index excluding them so history is not rewritten: ids ${dupMatches.map(d => d.id).join(', ')}`
    );
  }
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS three_way_matches_invoice_uq
        ON three_way_matches (company_id, po_id, LOWER(TRIM(vendor_invoice_no)))
     WHERE vendor_invoice_no IS NOT NULL AND TRIM(vendor_invoice_no) <> ''
           ${dupMatches.length ? `AND id <> ALL(ARRAY[${dupMatches.map(d => d.id).join(',')}])` : ''}
  `);

  console.log(
    `[20260903000011] ${moved.length} goods receipt(s) moved onto the canonical status vocabulary; ` +
    `${qMoved.length} quality_status value(s) normalised; ` +
    `status default is now 'pending'; idempotency_key and vendor DC columns added.`
  );
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS three_way_matches_invoice_uq`);
  await knex.raw(`DROP INDEX IF EXISTS goods_receipt_notes_idempotency_key_uq`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS vendor_dc_date`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS vendor_dc_number`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS idempotency_key`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS goods_receipt_notes_quality_status_check`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS goods_receipt_notes_status_check`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ALTER COLUMN status SET DEFAULT 'draft'`);
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_grn_id_fkey`);
  // The soft-deleted phantom batches are deliberately NOT restored: bringing 29
  // units of stock that was never received back into the available figure would
  // be re-introducing the corruption, not reversing a change.
}
