/**
 * 20261028000004 — credit-note numbers are unique per company.
 *
 * Two generators numbered credit notes, both CN-<year>-<nnnn>:
 *   creditNotes.routes.js   COUNT(*) + 1 over every company's notes of the year
 *                           — so a deleted or skipped number produced a
 *                           collision, and two simultaneous creates the same one;
 *   fulfilment.routes.js    nextval of a sequence it CREATEd inside the request
 *                           (absent from this database until first used),
 *                           independent of the first — so the two collided.
 * Both now call creditNoteNumber.service.js: per company and year, MAX + 1
 * under a transaction advisory lock.
 *
 * credit_notes_credit_note_number_key made numbers unique across ALL
 * companies, which per-company numbering cannot satisfy (company B's first
 * note is CN-2026-0001 too). It becomes unique per company
 * (COALESCE(company_id, 0) — notes without a company stay unique among
 * themselves). Every existing number was globally unique, so it is certainly
 * unique per company; the new index is created before the old key is dropped.
 * Existing numbers are untouched. Nothing references the old key.
 *
 * Rollback: down() restores the global key — which fails once two companies
 * share a number, by design.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_notes_company_number
      ON credit_notes (COALESCE(company_id, 0), credit_note_number)
  `);
  await knex.raw(`ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS credit_notes_credit_note_number_key`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_credit_note_number_key UNIQUE (credit_note_number)
  `);
  await knex.raw(`DROP INDEX IF EXISTS ux_credit_notes_company_number`);
}
