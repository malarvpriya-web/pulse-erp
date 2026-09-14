/**
 * The identity columns the supply chain could not work without.
 *
 * The 2026-09-11 SCA audit found the planning spine severed in four places, and
 * every one of them was a missing identifier rather than missing logic:
 *
 *   sales_order_items had NO item column at all — only a varchar item_code and a
 *     free-text description. mrpEngine.service.js matched demand to items by
 *     lowercasing those two strings, which is why a live MRP run reported four
 *     unmatched demand lines and zero planned orders. Demand could not reach
 *     planning because nothing said which item was being demanded.
 *
 *   material_issue_logs had NO batch column. The system recorded that ten units
 *     of an item went to a production order but never which lot, so genealogy
 *     fell back to listing every batch of that item as if it were the source —
 *     inference presented as provenance. Four distinct batches of item 1 all
 *     resolved to the same production order. A supplier-lot recall was
 *     impossible. work_centre_id and operation_id are added at the same time:
 *     the audit asked for machine and operation on the trace and neither was
 *     recorded anywhere (issued_by already carried the operator).
 *
 *   pick_lists had NO company_id, and GET /warehouse/pick-lists filtered on
 *     WHERE 1=1 — every tenant could read every other tenant's picking work.
 *     abc_analysis_cache had the same hole: a single global cache row served
 *     whichever tenant asked last.
 *
 *   inventory_items carried BOTH reorder_point and reorder_level. reorder_level
 *     held the real values; reorder_point was 0.000 on every row. Consumers that
 *     read reorder_point raw evaluated "current_stock < 0" and could never
 *     return a row — the Stockout Risk panel had been silently empty forever.
 *     reorder_level becomes the single source of truth here; the raw readers are
 *     fixed in the same pass.
 *
 * FKs are ON DELETE SET NULL, never CASCADE: losing a batch row must not delete
 * the history of what was issued from it, which is the whole point of a trace.
 */

export async function up(knex) {
  // ── Demand identity ────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS item_id INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_item_id_fkey') THEN
        ALTER TABLE sales_order_items
          ADD CONSTRAINT sales_order_items_item_id_fkey
          FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
      END IF;
    END $$;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_soi_item ON sales_order_items(item_id) WHERE item_id IS NOT NULL`);

  // Allocation and backorder are tracked on the line, alongside fulfilled_qty.
  await knex.raw(`ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS allocated_qty   NUMERIC(15,3) DEFAULT 0`);
  await knex.raw(`ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS backordered_qty NUMERIC(15,3) DEFAULT 0`);

  // ── Traceability identity ──────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE material_issue_logs ADD COLUMN IF NOT EXISTS batch_id       INTEGER`);
  await knex.raw(`ALTER TABLE material_issue_logs ADD COLUMN IF NOT EXISTS work_centre_id INTEGER`);
  await knex.raw(`ALTER TABLE material_issue_logs ADD COLUMN IF NOT EXISTS operation_id   INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_issue_logs_batch_id_fkey') THEN
        ALTER TABLE material_issue_logs
          ADD CONSTRAINT material_issue_logs_batch_id_fkey
          FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL;
      END IF;
    END $$;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mil_batch ON material_issue_logs(batch_id) WHERE batch_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_mil_item  ON material_issue_logs(item_id)`);

  await knex.raw(`ALTER TABLE material_reservations ADD COLUMN IF NOT EXISTS batch_id INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_reservations_batch_id_fkey') THEN
        ALTER TABLE material_reservations
          ADD CONSTRAINT material_reservations_batch_id_fkey
          FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL;
      END IF;
    END $$;`);

  // A finished batch needs to know which order produced it for the downstream
  // leg of the trace. production_order_id already exists on inventory_batches.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_batches_prod_order ON inventory_batches(production_order_id) WHERE production_order_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_batches_item ON inventory_batches(item_id)`);

  // ── Tenant scoping ─────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE pick_lists ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pick_lists_company_id_fkey') THEN
        ALTER TABLE pick_lists
          ADD CONSTRAINT pick_lists_company_id_fkey
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
      END IF;
    END $$;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pick_lists_company ON pick_lists(company_id)`);

  // Backfill from the owning sales order where one is linked — the only
  // defensible source. Rows with no order stay NULL rather than guessing, and
  // NULL is already the "visible to super_admin only" state in this codebase.
  await knex.raw(`
    UPDATE pick_lists pl SET company_id = so.company_id
      FROM sales_orders so
     WHERE so.id = pl.sales_order_id AND pl.company_id IS NULL AND so.company_id IS NOT NULL`);

  await knex.raw(`ALTER TABLE abc_analysis_cache ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_abc_cache_company ON abc_analysis_cache(company_id, computed_at DESC)`);
  // Existing cache rows were computed across all tenants, so they cannot be
  // attributed to one. Delete rather than mislabel; the next run rebuilds them.
  await knex.raw(`DELETE FROM abc_analysis_cache WHERE company_id IS NULL`);

  // ── One reorder column, not two ────────────────────────────────────────────
  // Carry anything that only ever set reorder_point across before dropping it.
  await knex.raw(`
    UPDATE inventory_items
       SET reorder_level = reorder_point
     WHERE COALESCE(reorder_level,0) = 0 AND COALESCE(reorder_point,0) > 0`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS reorder_point`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS reorder_point NUMERIC(15,3) DEFAULT 0`);
  await knex.raw(`DROP INDEX IF EXISTS idx_abc_cache_company`);
  await knex.raw(`ALTER TABLE abc_analysis_cache DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_pick_lists_company`);
  await knex.raw(`ALTER TABLE pick_lists DROP CONSTRAINT IF EXISTS pick_lists_company_id_fkey`);
  await knex.raw(`ALTER TABLE pick_lists DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE material_reservations DROP CONSTRAINT IF EXISTS material_reservations_batch_id_fkey`);
  await knex.raw(`ALTER TABLE material_reservations DROP COLUMN IF EXISTS batch_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_mil_batch`);
  await knex.raw(`ALTER TABLE material_issue_logs DROP CONSTRAINT IF EXISTS material_issue_logs_batch_id_fkey`);
  await knex.raw(`ALTER TABLE material_issue_logs DROP COLUMN IF EXISTS operation_id`);
  await knex.raw(`ALTER TABLE material_issue_logs DROP COLUMN IF EXISTS work_centre_id`);
  await knex.raw(`ALTER TABLE material_issue_logs DROP COLUMN IF EXISTS batch_id`);
  await knex.raw(`ALTER TABLE sales_order_items DROP COLUMN IF EXISTS backordered_qty`);
  await knex.raw(`ALTER TABLE sales_order_items DROP COLUMN IF EXISTS allocated_qty`);
  await knex.raw(`DROP INDEX IF EXISTS idx_soi_item`);
  await knex.raw(`ALTER TABLE sales_order_items DROP CONSTRAINT IF EXISTS sales_order_items_item_id_fkey`);
  await knex.raw(`ALTER TABLE sales_order_items DROP COLUMN IF EXISTS item_id`);
}
