/**
 * 20261105000002 — DB-01C2: document-number sequences belong to a migration.
 * MODULE_FEATURE_CONNECTION_MANUAL.md §240.
 *
 * POST /delivery/deliveries and POST /crm/opportunities/:id/create-quotation each
 * ran CREATE SEQUENCE IF NOT EXISTS inside the request. The check for CREATE on the
 * schema comes first, so under a role with no DDL rights the statement fails even
 * when the sequence exists, and both routes returned HTTP 500.
 *
 * delivery_note_number_seq was in no schema source at all: it appeared on the first
 * delivery note. Both are created here if absent. An existing sequence keeps its
 * value, because that value decides the next document number.
 *
 * The application role gets USAGE where it exists, and nothing more.
 *
 * down() deliberately does nothing: dropping a sequence restarts its numbering and
 * would reissue document numbers.
 */
const MIGRATION = '20261105000002_document_number_sequences';

export async function up(knex) {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS delivery_note_number_seq`);
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS quotation_number_seq`);
  await knex.raw(`
    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN
        GRANT USAGE ON SEQUENCE delivery_note_number_seq, quotation_number_seq TO pulse_app;
      END IF;
    END
    $grant$`);
}

export async function down() {
  console.log(`[${MIGRATION}] down: the sequences are kept, because dropping them would reissue document numbers`);
}
