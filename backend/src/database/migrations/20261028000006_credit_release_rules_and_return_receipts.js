/**
 * 20261028000006 — what a credit note releases, what a return received, and
 * the rule that ties them together.
 *
 * Phase 3G (approved decisions 2, 3, 8).
 *
 *   credit_note_items.released_qty   the EXACT quantity of the original
 *       invoice line this credit gives back to be invoiced again. Until now the
 *       credit line's `quantity` was taken as the release, so a price-only
 *       credit (quantity 10 at a lower price) released 10 units. NULL = releases
 *       nothing. Only notes of reason 'sales_return' (goods came back) or
 *       'other' (a quantity billing correction) may release; price_revision,
 *       post_sale_discount and deficiency_of_service never do.
 *   sales_return_items.received_qty  what physically came back on the line.
 *       The receipt recorded only restocked_qty, so a scrapped or failed line's
 *       quantity was lost. NULL = not yet received.
 *   sales_returns.closed_without_receipt / close_reason / closed_by
 *       the one supported non-receipt closure (a withdrawn return), recorded.
 *
 *   so_item_returned_qty(order, item)   units of an item that came back on an
 *       order's returns (received_qty; restocked_qty for lines received before
 *       this migration, the only quantity they recorded).
 *   pick_line_invoiced_qty(line, exclude)  now counts released_qty, on issued
 *       and posted notes of a releasing reason only.
 *
 * Triggers (the database's own enforcement, whatever the caller):
 *   invoice_items_fulfilment_guard  + the order-item rule: net invoiced across
 *       an order's pick lines of an item may not exceed what shipped less what
 *       came back — a returned unit is never billable again, and a released
 *       one only if it is still with the customer.
 *   credit_note_items_release_guard  a release names a pick-linked line of the
 *       note's own original invoice, is within the line's credited quantity,
 *       on a note of a releasing reason, added while the note is a draft.
 *   credit_notes_issue_guard  on issue: releases never exceed what each line
 *       billed (all issued notes together), and sales-return releases never
 *       exceed what came back for the order item; the invoice lines are
 *       locked so concurrent issues serialise. Once issued, a note cannot be
 *       un-issued here (cancellation of issued notes awaits a finance/tax
 *       decision) and its reason cannot change.
 *
 * Additive. Existing rows: released_qty / received_qty NULL; nothing released
 * by existing notes (none was posted — the issue route could not post, see
 * 20261028000001). Rollback: down() restores the 20261028000001 functions and
 * trigger and drops what this adds.
 */
const RELEASE_REASONS = `('sales_return', 'other')`;

const INVOICED_V2 = `
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
    $fn$`;

const GUARD_V2 = `
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
    $fn$ LANGUAGE plpgsql`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE credit_note_items
      ADD COLUMN IF NOT EXISTS released_qty numeric(15,4)
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_note_items_released_qty_positive') THEN
        ALTER TABLE credit_note_items ADD CONSTRAINT credit_note_items_released_qty_positive
          CHECK (released_qty IS NULL OR released_qty > 0);
      END IF;
    END $$`);
  await knex.raw(`
    ALTER TABLE sales_return_items
      ADD COLUMN IF NOT EXISTS received_qty numeric(15,4)
  `);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_return_items_received_qty_valid') THEN
        ALTER TABLE sales_return_items ADD CONSTRAINT sales_return_items_received_qty_valid
          CHECK (received_qty IS NULL OR (received_qty >= 0 AND received_qty <= quantity));
      END IF;
    END $$`);
  await knex.raw(`
    ALTER TABLE sales_returns
      ADD COLUMN IF NOT EXISTS closed_without_receipt boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS close_reason text,
      ADD COLUMN IF NOT EXISTS closed_by integer
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION so_item_returned_qty(p_so integer, p_item integer)
    RETURNS numeric LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(SUM(COALESCE(ri.received_qty,
               CASE WHEN r.received_at IS NOT NULL THEN ri.restocked_qty END, 0)), 0)
        FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
       WHERE r.sales_order_id = p_so AND ri.item_id = p_item
    $fn$`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION pick_line_invoiced_qty(p_line integer, p_exclude_item integer DEFAULT NULL)
    RETURNS numeric LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(SUM(ii.quantity - LEAST(ii.quantity, COALESCE(cr.q, 0))), 0)
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        LEFT JOIN LATERAL (
          SELECT SUM(cni.released_qty) AS q
            FROM credit_note_items cni
            JOIN credit_notes cn ON cn.id = cni.credit_note_id
           WHERE cni.original_item_id = ii.id
             AND cni.released_qty IS NOT NULL
             AND cn.original_invoice_id = ii.invoice_id
             AND cn.company_id IS NOT DISTINCT FROM i.company_id
             AND cn.reason IN ${RELEASE_REASONS}
             AND cn.status = 'issued'
             AND cn.posted_journal_entry_id IS NOT NULL
             AND cn.deleted_at IS NULL
        ) cr ON true
       WHERE ii.pick_list_line_id = p_line
         AND ii.id IS DISTINCT FROM p_exclude_item
         AND LOWER(COALESCE(i.status, '')) <> 'cancelled'
    $fn$`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION invoice_items_fulfilment_guard() RETURNS trigger AS $fn$
    DECLARE
      line     record;
      inv      record;
      billed   numeric;
      agg      record;
    BEGIN
      IF NEW.pick_list_line_id IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT l.id, l.item_id, l.picked_qty, p.company_id, p.status, p.sales_order_id
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
      -- The order-item rule: what is invoiced (net of releases) across all of
      -- the order's dispatched pick lines of this item never exceeds what
      -- shipped less what came back.
      IF line.sales_order_id IS NOT NULL THEN
        SELECT COALESCE(SUM(l.picked_qty), 0) AS shipped,
               COALESCE(SUM(pick_line_invoiced_qty(l.id, NEW.id)), 0) AS invoiced
          INTO agg
          FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id
         WHERE p.sales_order_id = line.sales_order_id AND l.item_id = line.item_id
           AND LOWER(COALESCE(p.status, '')) = 'dispatched';
        IF agg.invoiced + COALESCE(NEW.quantity, 0)
           > agg.shipped - so_item_returned_qty(line.sales_order_id, line.item_id) THEN
          RAISE EXCEPTION 'item % of sales order % would be invoiced beyond what shipped less what was returned',
            line.item_id, line.sales_order_id USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION credit_note_items_release_guard() RETURNS trigger AS $fn$
    DECLARE
      cn  record;
      ii  record;
    BEGIN
      IF NEW.released_qty IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT id, reason, status, original_invoice_id INTO cn FROM credit_notes WHERE id = NEW.credit_note_id;
      IF cn.reason NOT IN ${RELEASE_REASONS} THEN
        RAISE EXCEPTION 'a % credit note credits price only and cannot release quantity', cn.reason USING ERRCODE = '23514';
      END IF;
      IF cn.status <> 'draft' THEN
        RAISE EXCEPTION 'quantity releases are set while a credit note is a draft' USING ERRCODE = '23514';
      END IF;
      IF NEW.original_item_id IS NULL THEN
        RAISE EXCEPTION 'a quantity release must name the original invoice line' USING ERRCODE = '23514';
      END IF;
      SELECT id, invoice_id, pick_list_line_id INTO ii FROM invoice_items WHERE id = NEW.original_item_id;
      IF ii.id IS NULL OR ii.invoice_id IS DISTINCT FROM cn.original_invoice_id THEN
        RAISE EXCEPTION 'invoice line % is not a line of the credit note''s original invoice', NEW.original_item_id USING ERRCODE = '23514';
      END IF;
      IF ii.pick_list_line_id IS NULL THEN
        RAISE EXCEPTION 'invoice line % bills no shipped goods, so it has no quantity to release', NEW.original_item_id USING ERRCODE = '23514';
      END IF;
      IF NEW.released_qty > COALESCE(NEW.quantity, 0) THEN
        RAISE EXCEPTION 'a release cannot exceed the quantity the line credits' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_note_items_release_guard ON credit_note_items`);
  await knex.raw(`
    CREATE TRIGGER trg_credit_note_items_release_guard
      BEFORE INSERT OR UPDATE OF released_qty, original_item_id, quantity ON credit_note_items
      FOR EACH ROW EXECUTE FUNCTION credit_note_items_release_guard()
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION credit_notes_issue_guard() RETURNS trigger AS $fn$
    DECLARE
      r record;
    BEGIN
      IF OLD.status = 'issued' AND NEW.status IS DISTINCT FROM 'issued' THEN
        RAISE EXCEPTION 'an issued credit note cannot be cancelled or reopened (awaiting a finance/tax decision on cancellation)'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.status = 'issued' AND NEW.reason IS DISTINCT FROM OLD.reason THEN
        RAISE EXCEPTION 'an issued credit note''s reason cannot change' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'issued' AND OLD.status IS DISTINCT FROM 'issued' THEN
        IF EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id AND released_qty IS NOT NULL)
           AND NEW.reason NOT IN ${RELEASE_REASONS} THEN
          RAISE EXCEPTION 'a % credit note credits price only and cannot release quantity', NEW.reason USING ERRCODE = '23514';
        END IF;
        -- Serialise against every other note releasing on the same lines.
        PERFORM 1 FROM invoice_items
          WHERE id IN (SELECT original_item_id FROM credit_note_items WHERE credit_note_id = NEW.id AND released_qty IS NOT NULL)
          ORDER BY id FOR UPDATE;
        FOR r IN
          SELECT ii.id, ii.quantity,
                 (SELECT COALESCE(SUM(c2.released_qty), 0) FROM credit_note_items c2 JOIN credit_notes n2 ON n2.id = c2.credit_note_id
                   WHERE c2.original_item_id = ii.id AND (n2.id = NEW.id OR (n2.status = 'issued' AND n2.deleted_at IS NULL))) AS released
            FROM invoice_items ii
           WHERE ii.id IN (SELECT original_item_id FROM credit_note_items WHERE credit_note_id = NEW.id AND released_qty IS NOT NULL)
        LOOP
          IF r.released > r.quantity THEN
            RAISE EXCEPTION 'invoice line % would release % of the % it billed', r.id, r.released, r.quantity USING ERRCODE = '23514';
          END IF;
        END LOOP;
        IF NEW.reason = 'sales_return' THEN
          FOR r IN
            SELECT p.sales_order_id AS so, l.item_id,
                   (SELECT COALESCE(SUM(c2.released_qty), 0)
                      FROM credit_note_items c2 JOIN credit_notes n2 ON n2.id = c2.credit_note_id
                      JOIN invoice_items i2 ON i2.id = c2.original_item_id
                      JOIN pick_list_lines l2 ON l2.id = i2.pick_list_line_id
                      JOIN pick_lists p2 ON p2.id = l2.pick_list_id
                     WHERE n2.reason = 'sales_return' AND (n2.id = NEW.id OR (n2.status = 'issued' AND n2.deleted_at IS NULL))
                       AND p2.sales_order_id = p.sales_order_id AND l2.item_id = l.item_id) AS released
              FROM credit_note_items c
              JOIN invoice_items ii ON ii.id = c.original_item_id
              JOIN pick_list_lines l ON l.id = ii.pick_list_line_id
              JOIN pick_lists p ON p.id = l.pick_list_id
             WHERE c.credit_note_id = NEW.id AND c.released_qty IS NOT NULL
             GROUP BY p.sales_order_id, l.item_id
          LOOP
            IF r.released > so_item_returned_qty(r.so, r.item_id) THEN
              RAISE EXCEPTION 'a sales-return credit would release % of item % on order %, more than came back',
                r.released, r.item_id, r.so USING ERRCODE = '23514';
            END IF;
          END LOOP;
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_issue_guard ON credit_notes`);
  await knex.raw(`
    CREATE TRIGGER trg_credit_notes_issue_guard
      BEFORE UPDATE OF status, reason ON credit_notes
      FOR EACH ROW EXECUTE FUNCTION credit_notes_issue_guard()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_issue_guard ON credit_notes`);
  await knex.raw(`DROP FUNCTION IF EXISTS credit_notes_issue_guard()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_note_items_release_guard ON credit_note_items`);
  await knex.raw(`DROP FUNCTION IF EXISTS credit_note_items_release_guard()`);
  await knex.raw(GUARD_V2);
  await knex.raw(INVOICED_V2);
  await knex.raw(`DROP FUNCTION IF EXISTS so_item_returned_qty(integer, integer)`);
  await knex.raw(`
    ALTER TABLE sales_returns
      DROP COLUMN IF EXISTS closed_by,
      DROP COLUMN IF EXISTS close_reason,
      DROP COLUMN IF EXISTS closed_without_receipt
  `);
  await knex.raw(`ALTER TABLE sales_return_items DROP CONSTRAINT IF EXISTS sales_return_items_received_qty_valid`);
  await knex.raw(`ALTER TABLE sales_return_items DROP COLUMN IF EXISTS received_qty`);
  await knex.raw(`ALTER TABLE credit_note_items DROP CONSTRAINT IF EXISTS credit_note_items_released_qty_positive`);
  await knex.raw(`ALTER TABLE credit_note_items DROP COLUMN IF EXISTS released_qty`);
}
