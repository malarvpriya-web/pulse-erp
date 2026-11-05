/**
 * 20260930000012 — BGV report records are retired, never erased.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * `DELETE /bgv/documents/:id` already left the stored FILE on disk — a
 * verification report is evidence, and a mistaken click must not be the thing
 * that destroys it. But it hard-deleted the ROW, and the row is the only thing
 * that said what the file was: which employee, which check, which agency, who
 * uploaded it and when. So "the bytes are retained" was true and nearly useless:
 * what survived was an unnamed file in `uploads/` that no query could tie back
 * to anything.
 *
 * The audit entry did capture the row as `old_data_json`, so it was technically
 * recoverable by reading the audit log. That is not a retention mechanism, it is
 * a forensic exercise — and it would not survive an audit-log retention policy.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * A soft delete. `deleted_at` / `deleted_by` retire the record from every active
 * view while the file AND its metadata stay joined, so an auditor can still
 * answer "what is this file and whose check did it belong to" years later.
 *
 * This is also what the brief actually asked for: "If a document record can be
 * removed from the active view, make sure this does not accidentally delete the
 * underlying evidence file." Removed from the view, not from the record.
 *
 * ── Access control is UNCHANGED ─────────────────────────────────────────────
 * A retired report is still reachable through GET /api/files/:name, and still
 * only with the same company scope, the same `bgv:view` grant and — for a
 * discrepancy — the same `bgv_sensitive:view` grant. Retention that quietly
 * widened access would be worse than deletion. `secureFiles.bgvDocumentOwner()`
 * therefore does NOT filter on deleted_at: the record's job after retirement is
 * precisely to keep answering "who does this file belong to".
 */
export async function up(knex) {
  // ⚠ pg shim, not knex: bindings are $1/$2.
  await knex.raw(`
    ALTER TABLE bgv_documents
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by INTEGER
  `);

  // Partial index: every active-view query filters `deleted_at IS NULL`, and a
  // retired report is a rare row nobody lists.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bgv_documents_active
      ON bgv_documents (check_id) WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  // ⚠ Rolling this back RESTORES the retired records to the active view rather
  // than deleting them. Dropping the column cannot distinguish a retired report
  // from a live one, and guessing wrong in the destructive direction would lose
  // evidence — which is the whole point of the column.
  await knex.raw(`DROP INDEX IF EXISTS idx_bgv_documents_active`);
  await knex.raw(`
    ALTER TABLE bgv_documents
      DROP COLUMN IF EXISTS deleted_at,
      DROP COLUMN IF EXISTS deleted_by
  `);
}
