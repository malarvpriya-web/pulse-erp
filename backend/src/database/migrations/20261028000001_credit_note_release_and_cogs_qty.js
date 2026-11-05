/**
 * 20261028000001 — credit notes that release invoiced quantity; COGS once per unit.
 *
 * Phase 3F. An invoice line that bills shipped goods names its pick line
 * (20261027000003) and the pick line can be invoiced only up to its picked
 * quantity. A posted credit note against that invoice line gives quantity back,
 * so it can be invoiced again — and nothing may count a unit's cost twice.
 *
 *   credit_notes.posted_journal_entry_id  the journal the credit note was posted
 *       with. credit_notes.journal_entry_id is INTEGER while journal_entries.id
 *       is a UUID, so that column can never hold a real journal (the five dev
 *       rows hold 1..5, pointing at nothing). It is left untouched; "posted"
 *       means status 'issued' AND this column set.
 *   credit_note_items.original_item_id → invoice_items(id)
 *       The column existed with no FK. NOT VALID: existing rows are not checked
 *       (nor changed); every new or updated row is.
 *   invoice_items.cogs_qty  units of this line whose cost was recognised (COGS
 *       journal). Re-invoicing a released quantity bills the customer again but
 *       must not expense the same goods again. NULL on older linked lines means
 *       their whole quantity was costed.
 *   invoice_items.sales_order_item_id  the order line a sales-order invoice line
 *       bills — what stops a service line being invoiced twice.
 *
 *   pick_line_invoiced_qty(line, exclude_item)  the ONE definition of how much
 *       of a pick line is invoiced: lines on invoices not cancelled, less what
 *       posted credit notes released against those same lines (a credit note of
 *       the same company, raised against that invoice, never releasing more
 *       than the line billed). The invoice service and the trigger both use it.
 *
 * The fulfilment guard trigger is replaced to use the function; everything it
 * checked before it still checks.
 *
 * Additive. Rollback: down() restores the 20261027000003 trigger function and
 * drops what this adds.
 */
const GUARD_V1 = `
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
    $fn$ LANGUAGE plpgsql`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE credit_notes
      ADD COLUMN IF NOT EXISTS posted_journal_entry_id uuid REFERENCES journal_entries(id)
  `);
  await knex.raw(`
    ALTER TABLE invoice_items
      ADD COLUMN IF NOT EXISTS cogs_qty            numeric(15,4),
      ADD COLUMN IF NOT EXISTS sales_order_item_id integer REFERENCES sales_order_items(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_invoice_items_so_item
      ON invoice_items (sales_order_item_id) WHERE sales_order_item_id IS NOT NULL
  `);
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'credit_note_items_original_item_fkey'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE credit_note_items
        ADD CONSTRAINT credit_note_items_original_item_fkey
        FOREIGN KEY (original_item_id) REFERENCES invoice_items(id) ON DELETE SET NULL NOT VALID
    `);
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_credit_note_items_original_item
      ON credit_note_items (original_item_id) WHERE original_item_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION pick_line_invoiced_qty(p_line integer, p_exclude_item integer DEFAULT NULL)
    RETURNS numeric LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(SUM(ii.quantity - LEAST(ii.quantity, COALESCE(cr.q, 0))), 0)
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        LEFT JOIN LATERAL (
          SELECT SUM(cni.quantity) AS q
            FROM credit_note_items cni
            JOIN credit_notes cn ON cn.id = cni.credit_note_id
           WHERE cni.original_item_id = ii.id
             AND cn.original_invoice_id = ii.invoice_id
             AND cn.company_id IS NOT DISTINCT FROM i.company_id
             AND cn.status = 'issued'
             AND cn.posted_journal_entry_id IS NOT NULL
             AND cn.deleted_at IS NULL
        ) cr ON true
       WHERE ii.pick_list_line_id = p_line
         AND ii.id IS DISTINCT FROM p_exclude_item
         AND LOWER(COALESCE(i.status, '')) <> 'cancelled'
    $fn$
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
      billed := pick_line_invoiced_qty(NEW.pick_list_line_id, NEW.id);
      IF billed + COALESCE(NEW.quantity, 0) > COALESCE(line.picked_qty, 0) THEN
        RAISE EXCEPTION 'pick line % would be invoiced beyond its shipped quantity', NEW.pick_list_line_id USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
}

export async function down(knex) {
  await knex.raw(GUARD_V1);
  await knex.raw(`DROP FUNCTION IF EXISTS pick_line_invoiced_qty(integer, integer)`);
  await knex.raw(`DROP INDEX IF EXISTS ix_credit_note_items_original_item`);
  await knex.raw(`ALTER TABLE credit_note_items DROP CONSTRAINT IF EXISTS credit_note_items_original_item_fkey`);
  await knex.raw(`DROP INDEX IF EXISTS ix_invoice_items_so_item`);
  await knex.raw(`
    ALTER TABLE invoice_items
      DROP COLUMN IF EXISTS sales_order_item_id,
      DROP COLUMN IF EXISTS cogs_qty
  `);
  await knex.raw(`ALTER TABLE credit_notes DROP COLUMN IF EXISTS posted_journal_entry_id`);
}
