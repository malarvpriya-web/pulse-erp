/**
 * 20261103000003 — v_sales_order_open_allocation: what each sales order still
 * needs, and how much of it is still reserved, per order and item.
 *
 * WHY
 * Order-promise allocations (inventory_allocations, allocation_source
 * 'order_promise') were never released: stock leaves at PICK (pick-list
 * 'dispatch' postings), but the allocation stayed, so promising and MRP kept
 * subtracting stock that had already gone. And nothing ever wrote
 * sales_order_items.fulfilled_qty, so MRP counted every open order line at its
 * full quantity even after it was picked. This view derives both figures from
 * the records that already exist, so nothing has to be "released" by a writer
 * and no historical row is changed.
 *
 * DEFINITIONS (per company, order and item)
 *   ordered_qty     SUM(sales_order_items.quantity) for the item on the order.
 *                   Several lines of one item are summed once.
 *   picked_out_qty  net stock the order's pick lists hold out for the item:
 *                   SUM(quantity_out - quantity_in) over stock_ledger rows with
 *                   reference_type 'pick_list' — exactly what reconcileStock()
 *                   treats as posted. Corrections and cancellations post
 *                   quantity_in on the SAME pick list, so they net out of their
 *                   own order only. Historical over-posted lists are counted as
 *                   the ledger records them, which is what current_stock (and so
 *                   MRP on-hand) already reflects.
 *   legacy_shipped_qty  approved legacy_fulfilment_links: stock that left before
 *                   pick lists, through an issue referencing the order. The
 *                   table's own guard only accepts reference_type 'sales_order'
 *                   rows; this re-checks it, so a link can never count a
 *                   pick-list posting a second time.
 *   allocated_qty   SUM of the order's 'order_promise' allocations for the item.
 *   order_active    not soft-deleted, and not delivered / completed / closed /
 *                   cancelled.
 *   open_demand_qty  active: GREATEST(ordered - shipped, 0); otherwise 0.
 *   open_alloc_qty   active: LEAST(GREATEST(allocated - shipped, 0), open_demand);
 *                    otherwise 0. The cap also neutralises allocations stacked
 *                    by repeated promises before this fix, without touching them.
 *   where shipped = GREATEST(picked_out, 0) + legacy_shipped.
 *
 * Every quantity is aggregated in its own CTE and joined 1:1 on
 * (company, order, item), so no join can multiply another's rows.
 *
 * TENANCY
 *   ordered      company of the ORDER.
 *   picked_out   pick list's company must equal the order's, and each ledger
 *                row's company must equal the pick list's.
 *   legacy       link, order and ledger row must agree on company, order, item.
 *   allocated    the allocation's item must belong to the order's company.
 *
 * Indexes for the three lookups the view makes (none existed). The ledger one is
 * partial (pick-list rows only) to keep it small.
 */
const VIEW = `
CREATE OR REPLACE VIEW v_sales_order_open_allocation AS
WITH ordered AS (
  SELECT so.company_id, soi.order_id AS sales_order_id, soi.item_id,
         SUM(COALESCE(soi.quantity, 0)) AS ordered_qty
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.order_id
   WHERE soi.item_id IS NOT NULL
   GROUP BY so.company_id, soi.order_id, soi.item_id
), picked AS (
  SELECT pl.company_id, pl.sales_order_id, sl.item_id,
         SUM(COALESCE(sl.quantity_out, 0) - COALESCE(sl.quantity_in, 0)) AS qty
    FROM stock_ledger sl
    JOIN pick_lists pl ON pl.id = sl.reference_id
   WHERE sl.reference_type = 'pick_list'
     AND pl.sales_order_id IS NOT NULL
     AND sl.company_id IS NOT DISTINCT FROM pl.company_id
   GROUP BY pl.company_id, pl.sales_order_id, sl.item_id
), legacy AS (
  SELECT so.company_id, so.id AS sales_order_id, soi.item_id, SUM(k.quantity) AS qty
    FROM legacy_fulfilment_links k
    JOIN sales_order_items soi ON soi.id = k.sales_order_item_id
    JOIN sales_orders so       ON so.id = soi.order_id AND so.company_id = k.company_id
    JOIN stock_ledger sl       ON sl.id = k.stock_ledger_id
                              AND sl.reference_type = 'sales_order'
                              AND sl.reference_id = so.id
                              AND sl.item_id = soi.item_id
   GROUP BY so.company_id, so.id, soi.item_id
), allocated AS (
  SELECT so.company_id, so.id AS sales_order_id, a.item_id, SUM(COALESCE(a.quantity, 0)) AS qty
    FROM inventory_allocations a
    JOIN sales_orders so    ON so.id = a.reference_id
    JOIN inventory_items ii ON ii.id = a.item_id AND ii.company_id IS NOT DISTINCT FROM so.company_id
   WHERE a.allocation_source = 'order_promise' AND a.reference_type = 'sales_order'
   GROUP BY so.company_id, so.id, a.item_id
), joined AS (
  SELECT o.company_id, o.sales_order_id, o.item_id, o.ordered_qty,
         COALESCE(p.qty, 0) AS picked_out_qty,
         COALESCE(l.qty, 0) AS legacy_shipped_qty,
         COALESCE(a.qty, 0) AS allocated_qty,
         GREATEST(COALESCE(p.qty, 0), 0) + COALESCE(l.qty, 0) AS shipped_qty,
         (so.deleted_at IS NULL
           AND LOWER(COALESCE(so.order_status, '')) NOT IN ('delivered', 'completed', 'closed', 'cancelled')) AS order_active
    FROM ordered o
    JOIN sales_orders so ON so.id = o.sales_order_id
    LEFT JOIN picked p    ON p.sales_order_id = o.sales_order_id AND p.item_id = o.item_id
                         AND p.company_id IS NOT DISTINCT FROM o.company_id
    LEFT JOIN legacy l    ON l.sales_order_id = o.sales_order_id AND l.item_id = o.item_id
                         AND l.company_id IS NOT DISTINCT FROM o.company_id
    LEFT JOIN allocated a ON a.sales_order_id = o.sales_order_id AND a.item_id = o.item_id
                         AND a.company_id IS NOT DISTINCT FROM o.company_id
)
SELECT company_id, sales_order_id, item_id, ordered_qty, picked_out_qty, legacy_shipped_qty,
       shipped_qty, allocated_qty, order_active,
       CASE WHEN order_active THEN GREATEST(ordered_qty - shipped_qty, 0) ELSE 0 END AS open_demand_qty,
       CASE WHEN order_active
            THEN LEAST(GREATEST(allocated_qty - shipped_qty, 0), GREATEST(ordered_qty - shipped_qty, 0))
            ELSE 0 END AS open_alloc_qty
  FROM joined`;

export async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_pick_list_ref
                    ON stock_ledger (reference_id, item_id) WHERE reference_type = 'pick_list'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pick_lists_sales_order ON pick_lists (sales_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inv_alloc_order_promise
                    ON inventory_allocations (reference_id, item_id) WHERE allocation_source = 'order_promise'`);
}

export async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS v_sales_order_open_allocation`);
  await knex.raw(`DROP INDEX IF EXISTS idx_inv_alloc_order_promise`);
  await knex.raw(`DROP INDEX IF EXISTS idx_pick_lists_sales_order`);
  await knex.raw(`DROP INDEX IF EXISTS idx_stock_ledger_pick_list_ref`);
}
