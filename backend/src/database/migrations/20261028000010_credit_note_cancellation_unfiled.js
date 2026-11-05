/**
 * 20261028000010 — an issued credit note may be cancelled while it is not yet
 * filed in GSTR-1.
 *
 * Decision (account holder, 2026-10-28): "Cancel if not yet filed". Until now
 * an issued note could not be cancelled at all (credit_notes_issue_guard,
 * 20261028000006/7). Now:
 *   - an issued note NOT reported in GSTR-1 (gstr1_filed = false) may be
 *     cancelled — with a reason, by whoever recorded, and, if it was posted,
 *     only together with a POSTED journal that reverses its journal
 *     (cancellation_journal_entry_id → an entry whose reversal_of_id is the
 *     note's posted_journal_entry_id);
 *   - a filed note stays uncancellable (that is a GSTR-1 amendment, outside
 *     the system);
 *   - cancelling takes back the quantity the note released. That is refused
 *     if the released quantity has since been invoiced again: no pick line may
 *     end up invoiced beyond what it shipped, and no order item beyond what
 *     shipped less what came back (checked AFTER the update, when the note no
 *     longer counts as a release);
 *   - marking a note filed is one-way and only for issued notes.
 *
 * Columns: cancelled_at, cancelled_by, cancel_reason,
 * cancellation_journal_entry_id (FK journal_entries, NO ACTION),
 * gstr1_filed_at, gstr1_filed_by. Existing rows untouched.
 *
 * Rollback: down() restores the 20261028000007 guard (no cancellation of issued
 * notes) and drops the cancel guard and columns — refusing if any issued note
 * has been cancelled under this rule.
 */
const RELEASE_REASONS = `('sales_return', 'quantity_correction')`;

const issueGuard = (allowUnfiledCancel) => `
    CREATE OR REPLACE FUNCTION credit_notes_issue_guard() RETURNS trigger AS $fn$
    DECLARE
      r record;
    BEGIN
      IF OLD.status = 'issued' AND NEW.status IS DISTINCT FROM 'issued' THEN
        ${allowUnfiledCancel ? `
        IF NEW.status <> 'cancelled' THEN
          RAISE EXCEPTION 'an issued credit note cannot be reopened' USING ERRCODE = '23514';
        END IF;
        IF COALESCE(OLD.gstr1_filed, false) THEN
          RAISE EXCEPTION 'credit note % is filed in GSTR-1; cancelling it is a GSTR-1 amendment, not a cancellation', OLD.credit_note_number
            USING ERRCODE = '23514';
        END IF;
        IF length(btrim(COALESCE(NEW.cancel_reason, ''))) = 0 THEN
          RAISE EXCEPTION 'cancelling an issued credit note needs a reason' USING ERRCODE = '23514';
        END IF;
        IF OLD.posted_journal_entry_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.id = NEW.cancellation_journal_entry_id
                AND je.reversal_of_id = OLD.posted_journal_entry_id
                AND je.status = 'posted' AND je.deleted_at IS NULL) THEN
          RAISE EXCEPTION 'cancelling posted credit note % needs a posted journal reversing its journal', OLD.credit_note_number
            USING ERRCODE = '23514';
        END IF;` : `
        RAISE EXCEPTION 'an issued credit note cannot be cancelled or reopened (awaiting a finance/tax decision on cancellation)'
          USING ERRCODE = '23514';`}
      END IF;
      IF OLD.status = 'issued' AND NEW.reason IS DISTINCT FROM OLD.reason THEN
        RAISE EXCEPTION 'an issued credit note''s reason cannot change' USING ERRCODE = '23514';
      END IF;
      ${allowUnfiledCancel ? `
      IF COALESCE(OLD.gstr1_filed, false) AND NOT COALESCE(NEW.gstr1_filed, false) THEN
        RAISE EXCEPTION 'a credit note filed in GSTR-1 cannot be un-filed' USING ERRCODE = '23514';
      END IF;
      IF COALESCE(NEW.gstr1_filed, false) AND NOT COALESCE(OLD.gstr1_filed, false) AND NEW.status <> 'issued' THEN
        RAISE EXCEPTION 'only an issued credit note can be filed in GSTR-1' USING ERRCODE = '23514';
      END IF;` : ''}
      IF NEW.status = 'issued' AND OLD.status IS DISTINCT FROM 'issued' THEN
        IF EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id AND released_qty IS NOT NULL)
           AND NEW.reason NOT IN ${RELEASE_REASONS} THEN
          RAISE EXCEPTION 'a % credit note credits price only and cannot release quantity', NEW.reason USING ERRCODE = '23514';
        END IF;
        IF NEW.reason = 'quantity_correction' THEN
          IF NOT EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id) THEN
            RAISE EXCEPTION 'a quantity correction must name the invoice lines it corrects' USING ERRCODE = '23514';
          END IF;
          IF EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id
                      AND (original_item_id IS NULL OR released_qty IS NULL OR released_qty <> quantity)) THEN
            RAISE EXCEPTION 'every line of a quantity correction names its invoice line and releases exactly the quantity it credits'
              USING ERRCODE = '23514';
          END IF;
        END IF;
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
    $fn$ LANGUAGE plpgsql`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE credit_notes
      ADD COLUMN IF NOT EXISTS cancelled_at                  timestamptz,
      ADD COLUMN IF NOT EXISTS cancelled_by                  integer,
      ADD COLUMN IF NOT EXISTS cancel_reason                 text,
      ADD COLUMN IF NOT EXISTS cancellation_journal_entry_id uuid REFERENCES journal_entries(id),
      ADD COLUMN IF NOT EXISTS gstr1_filed_at                timestamptz,
      ADD COLUMN IF NOT EXISTS gstr1_filed_by                integer
  `);
  await knex.raw(issueGuard(true));

  // After the update the cancelled note no longer counts as a release, so the
  // invariants can be read directly: nothing it released may still be billed.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION credit_notes_cancel_guard() RETURNS trigger AS $fn$
    DECLARE
      r record;
    BEGIN
      IF NOT (OLD.status = 'issued' AND NEW.status = 'cancelled') THEN
        RETURN NULL;
      END IF;
      FOR r IN
        SELECT DISTINCT l.id, l.picked_qty, p.sales_order_id AS so, l.item_id
          FROM credit_note_items c
          JOIN invoice_items ii ON ii.id = c.original_item_id
          JOIN pick_list_lines l ON l.id = ii.pick_list_line_id
          JOIN pick_lists p ON p.id = l.pick_list_id
         WHERE c.credit_note_id = NEW.id AND c.released_qty IS NOT NULL
      LOOP
        IF pick_line_invoiced_qty(r.id) > COALESCE(r.picked_qty, 0) THEN
          RAISE EXCEPTION 'credit note % released quantity on pick line % that has been invoiced again; cancelling it would bill more than shipped',
            NEW.credit_note_number, r.id USING ERRCODE = '23514';
        END IF;
        IF r.so IS NOT NULL AND (
             SELECT COALESCE(SUM(pick_line_invoiced_qty(l2.id)), 0)
               FROM pick_list_lines l2 JOIN pick_lists p2 ON p2.id = l2.pick_list_id
              WHERE p2.sales_order_id = r.so AND l2.item_id = r.item_id AND LOWER(COALESCE(p2.status, '')) = 'dispatched')
           > (SELECT COALESCE(SUM(l3.picked_qty), 0)
                FROM pick_list_lines l3 JOIN pick_lists p3 ON p3.id = l3.pick_list_id
               WHERE p3.sales_order_id = r.so AND l3.item_id = r.item_id AND LOWER(COALESCE(p3.status, '')) = 'dispatched')
             - so_item_returned_qty(r.so, r.item_id) THEN
          RAISE EXCEPTION 'cancelling credit note % would leave item % of order % invoiced beyond what shipped less what came back',
            NEW.credit_note_number, r.item_id, r.so USING ERRCODE = '23514';
        END IF;
      END LOOP;
      RETURN NULL;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_cancel_guard ON credit_notes`);
  await knex.raw(`
    CREATE TRIGGER trg_credit_notes_cancel_guard
      AFTER UPDATE OF status ON credit_notes
      FOR EACH ROW EXECUTE FUNCTION credit_notes_cancel_guard()
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_issue_guard ON credit_notes`);
  await knex.raw(`
    CREATE TRIGGER trg_credit_notes_issue_guard
      BEFORE UPDATE OF status, reason, gstr1_filed ON credit_notes
      FOR EACH ROW EXECUTE FUNCTION credit_notes_issue_guard()
  `);
}

export async function down(knex) {
  const { rows: [c] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM credit_notes WHERE cancellation_journal_entry_id IS NOT NULL OR (status = 'cancelled' AND cancel_reason IS NOT NULL)`);
  if (c.n > 0) throw new Error(`${c.n} issued credit note(s) were cancelled under this rule; cannot restore the no-cancellation guard`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_cancel_guard ON credit_notes`);
  await knex.raw(`DROP FUNCTION IF EXISTS credit_notes_cancel_guard()`);
  await knex.raw(issueGuard(false));
  await knex.raw(`DROP TRIGGER IF EXISTS trg_credit_notes_issue_guard ON credit_notes`);
  await knex.raw(`
    CREATE TRIGGER trg_credit_notes_issue_guard
      BEFORE UPDATE OF status, reason ON credit_notes
      FOR EACH ROW EXECUTE FUNCTION credit_notes_issue_guard()
  `);
  await knex.raw(`
    ALTER TABLE credit_notes
      DROP COLUMN IF EXISTS gstr1_filed_by,
      DROP COLUMN IF EXISTS gstr1_filed_at,
      DROP COLUMN IF EXISTS cancellation_journal_entry_id,
      DROP COLUMN IF EXISTS cancel_reason,
      DROP COLUMN IF EXISTS cancelled_by,
      DROP COLUMN IF EXISTS cancelled_at
  `);
}
