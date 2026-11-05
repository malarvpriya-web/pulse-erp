/**
 * 20260926000010_advanced_inventory_tenant_views.js
 *
 * Give the three Advanced Inventory views a tenant column, so the reads that go
 * through them can be scoped at all.
 *
 * WHY THIS IS A MIGRATION AND NOT A REPOSITORY CHANGE
 * --------------------------------------------------
 * `advancedInventory.repository.js` reads `v_batch_stock`, `v_stock_summary` and
 * `v_material_consumption_by_project`. None of the three exposed a company
 * column, so there was nothing to filter on: `getBatches`, `getStockSummary`,
 * `getStockAgingReport` and `getMaterialConsumptionByProject` each returned
 * EVERY tenant's rows to any authenticated caller holding `inventory:view`, and
 * no amount of care in the repository could have changed that. The alternative —
 * re-joining `inventory_items` in four places purely to recover a column the
 * view already had in hand — puts the tenant rule in four places instead of one.
 *
 * WHERE THE TENANT COMES FROM
 * ---------------------------
 * `inventory_items.company_id`, in all three. That is the authoritative owner of
 * every row underneath:
 *
 *   - `inventory_batches` has its own `company_id`, but it is nullable and is
 *     populated by `createBatch()` with a COALESCE onto the item's company
 *     anyway — so the item is the source either way, and using it avoids a view
 *     that disagrees with itself when the two columns drift.
 *   - `purchase_suggestions`, `inventory_reservations`, `inventory_allocations`
 *     and `stock_alerts` have NO company column at all. Their tenancy is
 *     transitive through the item, so scoping every Advanced Inventory read the
 *     same way keeps ONE rule across the module rather than one rule per table.
 *
 * Measured before writing (2026-09-26): 0 of 46 live `inventory_items` and 0 of
 * 20 live `warehouses` carry a NULL `company_id`. So the standard
 * `($1::int IS NULL OR company_id = $1)` predicate the callers now use hides no
 * row that is visible today — this closes a leak without narrowing legitimate
 * access. (If a NULL-company item is ever created, it becomes invisible to
 * company-scoped users, which is the convention everywhere else in this codebase
 * and the safe direction to fail.)
 *
 * ADDITIVE, DELIBERATELY
 * ----------------------
 * `CREATE OR REPLACE VIEW` may only APPEND columns, never reorder or retype
 * existing ones, so every column each view already had is reproduced here in its
 * original position and type and `company_id` is added at the end. Existing
 * readers — `warehouse.routes.js`, `scmPlanning.routes.js`, the KPI service and
 * the rest — see exactly what they saw before. Nothing is dropped, so there is
 * no CASCADE and no dependent view to rebuild.
 *
 * ⚠ `v_stock_summary` CROSS JOINs items against warehouses, which is how it
 * produces a row per item per warehouse including the empty combinations. That
 * cross join is ALREADY cross-tenant: it pairs company A's item with company B's
 * warehouse. Scoping on the item alone would still emit those pairs. The join is
 * therefore constrained to same-company pairs here, which is a behaviour change
 * and is the point: `getStockSummary()` was listing warehouses the caller cannot
 * see, against items in a different company, with a stock balance of zero
 * because no ledger row could ever join. Those rows were noise at best and a
 * warehouse-name disclosure at worst.
 */

export async function up(knex) {
  // ── v_batch_stock ──────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW v_batch_stock AS
    SELECT ib.id,
           ib.item_id,
           ib.warehouse_id,
           ib.batch_number,
           ib.received_date,
           ib.expiry_date,
           ib.supplier_id,
           ib.grn_id,
           ib.quantity_received,
           ib.quantity_available,
           ib.quantity_consumed,
           ib.quantity_reserved,
           ib.rate,
           ib.status,
           ib.deleted_at,
           ib.created_at,
           ib.updated_at,
           ii.item_code,
           ii.item_name,
           ii.unit_of_measure,
           w.warehouse_name,
           CURRENT_DATE - ib.received_date AS age_days,
           ib.quantity_available * ib.rate AS stock_value,
           CASE
             WHEN ib.quantity_available <= 0::numeric THEN 'depleted'::text
             WHEN ib.expiry_date IS NOT NULL
              AND ib.expiry_date <= (CURRENT_DATE + '30 days'::interval) THEN 'expiring_soon'::text
             ELSE 'active'::text
           END AS stock_status,
           ii.company_id
      FROM inventory_batches ib
      JOIN inventory_items ii ON ib.item_id = ii.id
      JOIN warehouses w       ON ib.warehouse_id = w.id
     WHERE ib.deleted_at IS NULL
  `);

  // ── v_stock_summary ───────────────────────────────────────────────────────
  // The CROSS JOIN is now same-tenant only; see the header note.
  await knex.raw(`
    CREATE OR REPLACE VIEW v_stock_summary AS
    SELECT ii.id,
           ii.item_code,
           ii.item_name,
           ii.item_type,
           ii.unit_of_measure,
           ii.reorder_level,
           w.id AS warehouse_id,
           w.warehouse_name,
           COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) AS balance,
           COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) AS current_stock,
           COALESCE(avg(NULLIF(sl.rate, 0::numeric)), 0::numeric)      AS avg_rate,
           CASE
             WHEN COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) <= 0::numeric
               THEN 'out_of_stock'::text
             WHEN COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) <= ii.reorder_level
               THEN 'low_stock'::text
             ELSE 'in_stock'::text
           END AS stock_status,
           ii.company_id
      FROM inventory_items ii
      JOIN warehouses w
        ON (ii.company_id IS NULL OR w.company_id IS NULL OR w.company_id = ii.company_id)
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
     WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
     GROUP BY ii.id, ii.item_code, ii.item_name, ii.item_type, ii.unit_of_measure,
              ii.reorder_level, w.id, w.warehouse_name, ii.company_id
  `);

  // ── v_material_consumption_by_project ─────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW v_material_consumption_by_project AS
    SELECT ri.project_id,
           p.project_name,
           ii.id AS item_id,
           ii.item_code,
           ii.item_name,
           sum(rii.quantity)                  AS total_qty,
           sum(rii.quantity * rii.rate)       AS total_value,
           count(DISTINCT ri.id)              AS issue_count,
           max(ri.issue_date)                 AS last_issue_date,
           ii.company_id
      FROM rm_issue_items rii
      JOIN rm_issues ri       ON rii.issue_id = ri.id AND ri.deleted_at IS NULL
      JOIN inventory_items ii ON rii.item_id = ii.id
      LEFT JOIN projects p    ON p.id = ri.project_id AND p.deleted_at IS NULL
     WHERE ri.project_id IS NOT NULL
     GROUP BY ri.project_id, p.project_name, ii.id, ii.item_code, ii.item_name, ii.company_id
  `);
}

/**
 * Down restores the three views exactly as they were before this migration —
 * including `v_stock_summary`'s unconstrained CROSS JOIN, because rolling back
 * means rolling back, not leaving a half-applied boundary in place.
 */
export async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW v_material_consumption_by_project AS
    SELECT ri.project_id, p.project_name, ii.id AS item_id, ii.item_code, ii.item_name,
           sum(rii.quantity) AS total_qty, sum(rii.quantity * rii.rate) AS total_value,
           count(DISTINCT ri.id) AS issue_count, max(ri.issue_date) AS last_issue_date
      FROM rm_issue_items rii
      JOIN rm_issues ri       ON rii.issue_id = ri.id AND ri.deleted_at IS NULL
      JOIN inventory_items ii ON rii.item_id = ii.id
      LEFT JOIN projects p    ON p.id = ri.project_id AND p.deleted_at IS NULL
     WHERE ri.project_id IS NOT NULL
     GROUP BY ri.project_id, p.project_name, ii.id, ii.item_code, ii.item_name
  `);

  // A view cannot lose a column via CREATE OR REPLACE, so these two are dropped
  // and rebuilt. Nothing else in the schema depends on them (checked via
  // pg_depend), so no CASCADE is needed.
  await knex.raw(`DROP VIEW IF EXISTS v_batch_stock`);
  await knex.raw(`
    CREATE VIEW v_batch_stock AS
    SELECT ib.id, ib.item_id, ib.warehouse_id, ib.batch_number, ib.received_date, ib.expiry_date,
           ib.supplier_id, ib.grn_id, ib.quantity_received, ib.quantity_available,
           ib.quantity_consumed, ib.quantity_reserved, ib.rate, ib.status, ib.deleted_at,
           ib.created_at, ib.updated_at, ii.item_code, ii.item_name, ii.unit_of_measure,
           w.warehouse_name,
           CURRENT_DATE - ib.received_date AS age_days,
           ib.quantity_available * ib.rate AS stock_value,
           CASE
             WHEN ib.quantity_available <= 0::numeric THEN 'depleted'::text
             WHEN ib.expiry_date IS NOT NULL
              AND ib.expiry_date <= (CURRENT_DATE + '30 days'::interval) THEN 'expiring_soon'::text
             ELSE 'active'::text
           END AS stock_status
      FROM inventory_batches ib
      JOIN inventory_items ii ON ib.item_id = ii.id
      JOIN warehouses w       ON ib.warehouse_id = w.id
     WHERE ib.deleted_at IS NULL
  `);

  await knex.raw(`DROP VIEW IF EXISTS v_stock_summary`);
  await knex.raw(`
    CREATE VIEW v_stock_summary AS
    SELECT ii.id, ii.item_code, ii.item_name, ii.item_type, ii.unit_of_measure, ii.reorder_level,
           w.id AS warehouse_id, w.warehouse_name,
           COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) AS balance,
           COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) AS current_stock,
           COALESCE(avg(NULLIF(sl.rate, 0::numeric)), 0::numeric)      AS avg_rate,
           CASE
             WHEN COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) <= 0::numeric
               THEN 'out_of_stock'::text
             WHEN COALESCE(sum(sl.quantity_in - sl.quantity_out), 0::numeric) <= ii.reorder_level
               THEN 'low_stock'::text
             ELSE 'in_stock'::text
           END AS stock_status
      FROM inventory_items ii
      CROSS JOIN warehouses w
      LEFT JOIN stock_ledger sl ON ii.id = sl.item_id AND w.id = sl.warehouse_id
     WHERE ii.deleted_at IS NULL AND w.deleted_at IS NULL
     GROUP BY ii.id, ii.item_code, ii.item_name, ii.item_type, ii.unit_of_measure,
              ii.reorder_level, w.id, w.warehouse_name
  `);
}
