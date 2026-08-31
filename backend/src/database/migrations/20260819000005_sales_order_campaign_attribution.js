/**
 * sales_orders.campaign_id — marketing attribution.
 *
 * The Marketing module has three endpoints that attribute revenue to campaigns
 * (`/campaign-roi`, `/orders-won-lost`, and the ROI roll-up), all of which join
 * or filter on `sales_orders.campaign_id`. That column has never existed, so
 * every one of them threw 42703 at runtime: marketing ROI could not be measured
 * at all, and the endpoints reported the error as a bare 500.
 *
 * The link is a real business need — "which campaign produced this order" — and
 * there is no existing column carrying it (no campaign reference anywhere on
 * sales_orders, quotations, or leads). So it is added rather than remapped.
 *
 * Nullable by design: most orders arrive without a campaign, and attribution is
 * something Marketing sets after the fact.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE sales_orders
      ADD COLUMN IF NOT EXISTS campaign_id integer
        REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_orders_campaign
      ON sales_orders (campaign_id) WHERE campaign_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_sales_orders_campaign;`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS campaign_id;`);
}
