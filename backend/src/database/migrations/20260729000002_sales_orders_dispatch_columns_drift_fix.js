/**
 * Schema-drift fix, found while building Priority 6 (Installation Module).
 *
 * `20260609000010_fulfilment_dispatch_columns.js` added `sales_orders.
 * dispatched_at`/`delivered_at` and shows as [applied] in the migration
 * ledger (2026-06-11), but neither column exists on the live table —
 * confirmed via information_schema, not assumed. `PUT /orders/:id/dispatch`
 * (sales.routes.js) has been 500ing on every real call as a result: "column
 * \"dispatched_at\" of relation \"sales_orders\" does not exist". Several
 * read-side analytics queries (avg_dispatch_days, avg_delivery_days) were
 * silently degrading via their own try/catch instead of erroring loudly.
 *
 * Root cause not fully diagnosed (ledger/live-schema drift of this kind has
 * hit this project before — see MODULE_FEATURE_CONNECTION_MANUAL.md and
 * project memory on baseline bootstrap); this migration just closes the gap
 * directly rather than fighting the ledger, since ADD COLUMN IF NOT EXISTS
 * is safe to re-run regardless of what the ledger believes already happened.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE sales_orders
      ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE sales_orders
      DROP COLUMN IF EXISTS dispatched_at,
      DROP COLUMN IF EXISTS delivered_at
  `);
}
