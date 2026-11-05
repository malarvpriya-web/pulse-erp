/**
 * 20261027000003 — an invoice line can bill the fulfilment line it ships.
 *
 * Approved (Phase 3E, decision 2). Until now an invoice line could not say
 * which goods it billed: invoice_items had no item and no link to fulfilment,
 * so a line carrying item_id was refused outright (STOCK_LINE rule) and
 * warehouse-fulfilled sales were invoiced with no COGS at all.
 *
 *   invoice_items.pick_list_line_id  the pick-list line whose shipped goods this
 *                                    line bills. The pick line is where the
 *                                    stock left the ledger (stock_ledger
 *                                    reference 'pick_list') and it carries the
 *                                    item, batch, serial and sales-order line;
 *                                    package lines point back to it.
 *   invoice_items.item_id            the item billed (must equal the pick line's)
 *   invoice_items.unit_cost          the VERIFIED fulfilment cost per unit used
 *                                    for the COGS journal (FIFO cost of the pick)
 *
 * The invoice service enforces the full contract inside one transaction (pick
 * lines locked FOR UPDATE). The trigger below is the database's own backstop
 * for what must never be violated whatever the caller:
 *   - the pick line's list belongs to the invoice's company, and is dispatched
 *   - the item matches the pick line
 *   - the line's quantity plus everything already invoiced against the pick
 *     line (on invoices not cancelled) never exceeds picked_qty
 * It locks the pick line row, so two concurrent inserts serialise.
 *
 * Additive only: three nullable columns, two indexes, one trigger. Existing
 * rows keep NULLs and are untouched by the trigger (it fires only for rows
 * that name a pick line).
 *
 * Rollback: down() drops the trigger, function, indexes and columns. Any
 * invoice lines linked in the meantime lose their link (their COGS journals
 * remain posted).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE invoice_items
      ADD COLUMN IF NOT EXISTS item_id           integer REFERENCES inventory_items(id),
      ADD COLUMN IF NOT EXISTS pick_list_line_id integer REFERENCES pick_list_lines(id),
      ADD COLUMN IF NOT EXISTS unit_cost         numeric(15,4)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_items_invoice_pick_line
      ON invoice_items (invoice_id, pick_list_line_id) WHERE pick_list_line_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_invoice_items_pick_line
      ON invoice_items (pick_list_line_id) WHERE pick_list_line_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION invoice_items_fulfilment_guard() RETURNS trigger AS $fn$
    DECLARE
      line   record;
      inv    record;
      billed numeric;
    BEGIN
      IF NEW.pick_list_line_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT l.id, l.item_id, l.picked_qty, p.company_id, p.status
        INTO line
        FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id
       WHERE l.id = NEW.pick_list_line_id
         FOR UPDATE OF l;
      SELECT company_id INTO inv FROM invoices WHERE id = NEW.invoice_id;
      IF line.company_id IS DISTINCT FROM inv.company_id THEN
        RAISE EXCEPTION 'invoice line names pick line % of another company', NEW.pick_list_line_id USING ERRCODE = '23514';
      END IF;
      IF LOWER(COALESCE(line.status, '')) <> 'dispatched' THEN
        RAISE EXCEPTION 'pick line % is not dispatched', NEW.pick_list_line_id USING ERRCODE = '23514';
      END IF;
      IF NEW.item_id IS DISTINCT FROM line.item_id THEN
        RAISE EXCEPTION 'invoice line item does not match pick line %', NEW.pick_list_line_id USING ERRCODE = '23514';
      END IF;
      SELECT COALESCE(SUM(ii.quantity), 0) INTO billed
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE ii.pick_list_line_id = NEW.pick_list_line_id
         AND ii.id IS DISTINCT FROM NEW.id
         AND LOWER(COALESCE(i.status, '')) <> 'cancelled';
      IF billed + COALESCE(NEW.quantity, 0) > COALESCE(line.picked_qty, 0) THEN
        RAISE EXCEPTION 'pick line % would be invoiced beyond its shipped quantity', NEW.pick_list_line_id USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_invoice_items_fulfilment_guard ON invoice_items`);
  await knex.raw(`
    CREATE TRIGGER trg_invoice_items_fulfilment_guard
      BEFORE INSERT OR UPDATE OF pick_list_line_id, item_id, quantity ON invoice_items
      FOR EACH ROW EXECUTE FUNCTION invoice_items_fulfilment_guard()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_invoice_items_fulfilment_guard ON invoice_items`);
  await knex.raw(`DROP FUNCTION IF EXISTS invoice_items_fulfilment_guard()`);
  await knex.raw(`DROP INDEX IF EXISTS ix_invoice_items_pick_line`);
  await knex.raw(`DROP INDEX IF EXISTS ux_invoice_items_invoice_pick_line`);
  await knex.raw(`
    ALTER TABLE invoice_items
      DROP COLUMN IF EXISTS unit_cost,
      DROP COLUMN IF EXISTS pick_list_line_id,
      DROP COLUMN IF EXISTS item_id
  `);
}
