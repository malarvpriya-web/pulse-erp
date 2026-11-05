/**
 * 20261028000007 — an explicit reason for a quantity correction; a recorded
 * path for historical return quantities.
 *
 * Phase 3H.
 *
 * 1. credit_notes.reason gains 'quantity_correction' — a credit for quantity
 *    billed in error that the customer does NOT return. It and 'sales_return'
 *    (goods came back) are now the only reasons that release invoiced
 *    quantity; 'other' no longer does (it was ambiguous: anything from a
 *    goodwill credit to a quantity error). price_revision, post_sale_discount,
 *    deficiency_of_service and other credit price only.
 *    A quantity_correction note must consist of release lines: every line
 *    names the original invoice line, and its released quantity IS the
 *    credited quantity (released_qty = quantity) — checked on issue.
 *    History: no credit note had released quantity under 'other' when this
 *    was written (checked 2026-10-28); the migration refuses to run if any
 *    exists, rather than silently un-releasing it. No existing reason is
 *    changed.
 *
 * 2. sales_return_receipt_corrections — the audited record of a received
 *    quantity filled in for a line received before received_qty existed
 *    (20261028000006). One row per corrected line (unique), with the
 *    evidence it rests on and who recorded it; the line's received_qty is
 *    set from it by POST /scm/returns/:id/lines/:lineId/receipt-correction,
 *    which never moves stock and never overwrites a recorded quantity.
 *
 * Rollback: down() restores the 20261028000006 functions and reason list
 * (refusing if any quantity_correction note exists) and drops the table.
 */
const fnInvoiced = (reasons) => `
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
             AND cn.reason IN ${reasons}
             AND cn.status = 'issued'
             AND cn.posted_journal_entry_id IS NOT NULL
             AND cn.deleted_at IS NULL
        ) cr ON true
       WHERE ii.pick_list_line_id = p_line
         AND ii.id IS DISTINCT FROM p_exclude_item
         AND LOWER(COALESCE(i.status, '')) <> 'cancelled'
    $fn$`;

const fnItemGuard = (reasons) => `
    CREATE OR REPLACE FUNCTION credit_note_items_release_guard() RETURNS trigger AS $fn$
    DECLARE
      cn  record;
      ii  record;
    BEGIN
      IF NEW.released_qty IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT id, reason, status, original_invoice_id INTO cn FROM credit_notes WHERE id = NEW.credit_note_id;
      IF cn.reason NOT IN ${reasons} THEN
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
    $fn$ LANGUAGE plpgsql`;

// The issue guard: as 20261028000006, with the release reasons parameterised
// and (when withCorrectionRule) a quantity_correction note required to be
// release lines only, each releasing exactly what it credits.
const fnIssueGuard = (reasons, withCorrectionRule) => `
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
           AND NEW.reason NOT IN ${reasons} THEN
          RAISE EXCEPTION 'a % credit note credits price only and cannot release quantity', NEW.reason USING ERRCODE = '23514';
        END IF;
        ${withCorrectionRule ? `IF NEW.reason = 'quantity_correction' THEN
          IF NOT EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id) THEN
            RAISE EXCEPTION 'a quantity correction must name the invoice lines it corrects' USING ERRCODE = '23514';
          END IF;
          IF EXISTS (SELECT 1 FROM credit_note_items WHERE credit_note_id = NEW.id
                      AND (original_item_id IS NULL OR released_qty IS NULL OR released_qty <> quantity)) THEN
            RAISE EXCEPTION 'every line of a quantity correction names its invoice line and releases exactly the quantity it credits'
              USING ERRCODE = '23514';
          END IF;
        END IF;` : ''}
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

const OLD_REASONS = `('sales_return', 'other')`;
const NEW_REASONS = `('sales_return', 'quantity_correction')`;

async function reasonCheckName(knex) {
  const { rows } = await knex.raw(`
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'credit_notes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%reason%'`);
  return rows.map(r => r.conname);
}

export async function up(knex) {
  const { rows: [legacy] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM credit_note_items cni JOIN credit_notes cn ON cn.id = cni.credit_note_id
     WHERE cni.released_qty IS NOT NULL AND cn.reason NOT IN ('sales_return')`);
  if (legacy.n > 0) {
    throw new Error(`${legacy.n} credit-note line(s) release quantity under a reason other than sales_return; `
      + 'classify them (quantity_correction or price-only) before this migration — nothing was changed');
  }
  for (const name of await reasonCheckName(knex)) {
    await knex.raw(`ALTER TABLE credit_notes DROP CONSTRAINT ${name}`);
  }
  await knex.raw(`
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_reason_check
      CHECK (reason IN ('sales_return', 'quantity_correction', 'price_revision', 'deficiency_of_service', 'post_sale_discount', 'other'))
  `);
  await knex.raw(fnInvoiced(NEW_REASONS));
  await knex.raw(fnItemGuard(NEW_REASONS));
  await knex.raw(fnIssueGuard(NEW_REASONS, true));

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_return_receipt_corrections (
      id                    serial PRIMARY KEY,
      company_id            integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      return_id             integer NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
      return_item_id        integer NOT NULL REFERENCES sales_return_items(id) ON DELETE CASCADE,
      received_qty          numeric(15,4) NOT NULL CHECK (received_qty >= 0),
      previous_received_qty numeric(15,4),
      evidence_type         varchar(40) NOT NULL
                            CHECK (evidence_type IN ('receipt_document', 'stock_ledger', 'non_receipt_confirmation')),
      evidence_reference    text NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
      note                  text,
      corrected_by          integer,
      corrected_at          timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT ux_return_receipt_correction_line UNIQUE (return_item_id)
    )
  `);
}

export async function down(knex) {
  const { rows: [qc] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM credit_notes WHERE reason = 'quantity_correction'`);
  if (qc.n > 0) throw new Error(`${qc.n} quantity_correction credit note(s) exist; cannot remove the reason`);
  await knex.raw(`DROP TABLE IF EXISTS sales_return_receipt_corrections`);
  await knex.raw(fnIssueGuard(OLD_REASONS, false));
  await knex.raw(fnItemGuard(OLD_REASONS));
  await knex.raw(fnInvoiced(OLD_REASONS));
  for (const name of await reasonCheckName(knex)) {
    await knex.raw(`ALTER TABLE credit_notes DROP CONSTRAINT ${name}`);
  }
  await knex.raw(`
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_reason_check
      CHECK (reason IN ('sales_return', 'price_revision', 'deficiency_of_service', 'post_sale_discount', 'other'))
  `);
}
