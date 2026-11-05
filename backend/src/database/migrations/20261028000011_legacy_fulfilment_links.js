/**
 * 20261028000011 — legacy fulfilment links.
 *
 * Decision (account holder, 2026-10-28): "Link as reconciled" for the 24
 * SO-REF orders. Those orders' stock left before pick lists carried
 * fulfilment, through a stock_ledger issue that references the order
 * (reference_type 'sales_order'). This table records, per order line, WHICH
 * existing ledger issue fulfilled it — the evidence the reconciliation
 * report verified — so the order reads as reconciled instead of open.
 *
 * It creates no stock movement and changes no invoicing or return rule:
 * invoicing and returns still count only pick-list fulfilment, so linked
 * orders stay unbillable and unreturnable (as decided).
 *
 * The database accepts a link only when (legacy_fulfilment_link_guard):
 *   - the ledger row is an issue (quantity_out > 0, quantity_in = 0) with
 *     reference_type 'sales_order' and reference_id = the line's own order;
 *   - same item as the order line, same company as the order and the link;
 *   - its quantity equals the link's quantity, which equals the ordered quantity.
 * One link per ledger row and per order line (unique). Links are not edited
 * (UPDATE refused); the evidence they record does not change.
 *
 * Rollback: down() drops the table and guard.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS legacy_fulfilment_links (
      id                   serial PRIMARY KEY,
      company_id           integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sales_order_item_id  integer NOT NULL REFERENCES sales_order_items(id) ON DELETE CASCADE,
      stock_ledger_id      integer NOT NULL REFERENCES stock_ledger(id),
      quantity             numeric(15,4) NOT NULL CHECK (quantity > 0),
      evidence             text NOT NULL,
      approved_by          text NOT NULL CHECK (length(btrim(approved_by)) > 0),
      created_by           integer,
      created_at           timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT ux_legacy_fulfilment_ledger UNIQUE (stock_ledger_id),
      CONSTRAINT ux_legacy_fulfilment_line   UNIQUE (sales_order_item_id)
    )
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION legacy_fulfilment_link_guard() RETURNS trigger AS $fn$
    DECLARE
      soi record;
      sl  record;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'a legacy fulfilment link records evidence and is not edited' USING ERRCODE = '23514';
      END IF;
      SELECT s.id, s.item_id, s.quantity, so.id AS order_id, so.company_id
        INTO soi FROM sales_order_items s JOIN sales_orders so ON so.id = s.order_id WHERE s.id = NEW.sales_order_item_id;
      SELECT * INTO sl FROM stock_ledger WHERE id = NEW.stock_ledger_id FOR SHARE;
      IF sl.id IS NULL OR sl.reference_type IS DISTINCT FROM 'sales_order' OR sl.reference_id IS DISTINCT FROM soi.order_id THEN
        RAISE EXCEPTION 'stock ledger row % is not an issue referencing sales order %', NEW.stock_ledger_id, soi.order_id
          USING ERRCODE = '23514';
      END IF;
      IF COALESCE(sl.quantity_in, 0) <> 0 OR COALESCE(sl.quantity_out, 0) <= 0 THEN
        RAISE EXCEPTION 'stock ledger row % is not a stock issue', NEW.stock_ledger_id USING ERRCODE = '23514';
      END IF;
      IF sl.item_id IS DISTINCT FROM soi.item_id THEN
        RAISE EXCEPTION 'stock ledger row % is item %, the order line is item %', sl.id, sl.item_id, soi.item_id USING ERRCODE = '23514';
      END IF;
      IF sl.company_id IS DISTINCT FROM soi.company_id OR NEW.company_id IS DISTINCT FROM soi.company_id THEN
        RAISE EXCEPTION 'the link, the order and the stock issue must belong to one company' USING ERRCODE = '23514';
      END IF;
      IF sl.quantity_out <> NEW.quantity OR NEW.quantity <> soi.quantity THEN
        RAISE EXCEPTION 'the stock issue (%), the link (%) and the ordered quantity (%) must agree', sl.quantity_out, NEW.quantity, soi.quantity
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_legacy_fulfilment_link_guard ON legacy_fulfilment_links`);
  await knex.raw(`
    CREATE TRIGGER trg_legacy_fulfilment_link_guard
      BEFORE INSERT OR UPDATE ON legacy_fulfilment_links
      FOR EACH ROW EXECUTE FUNCTION legacy_fulfilment_link_guard()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS legacy_fulfilment_links`);
  await knex.raw(`DROP FUNCTION IF EXISTS legacy_fulfilment_link_guard()`);
}
