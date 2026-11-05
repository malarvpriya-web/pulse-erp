/**
 * 20261105000001 — DB-01C2: every database has legacy_bin_location_archive.
 * MODULE_FEATURE_CONNECTION_MANUAL.md §239.
 *
 * 20260915000016a creates this table only when bin_locations still exists. The
 * baseline snapshot predates the cutover, so a fresh install gets an empty table;
 * a database that was already cut over when 016a arrived gets none. Neither is
 * wrong, but it leaves two schemas for one migration history.
 *
 * This creates the table where it is absent, with 016a's exact definition, so
 * fresh and existing databases match. 016a is not edited: where it has run it
 * never runs again, and editing it would only break its checksum.
 *
 * It never removes anything. An archive that already exists, with whatever rows it
 * holds, is left exactly as it is, because those rows are the only copy of legacy
 * bins that the cutover then dropped.
 *
 * Privileges: nothing at runtime reads or writes this table. Where the application
 * role exists it gets SELECT only, and no right on the sequence; where it does not
 * exist there is nothing to grant.
 *
 * down() deliberately does nothing. It cannot tell a table this migration created
 * from one 016a filled with real rows, and 016a's own policy is never to drop the
 * archive. Rolling back removes only the ledger row, and up() can run again safely.
 */
const MIGRATION = '20261105000001_legacy_bin_archive_parity';

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS legacy_bin_location_archive (
      id               BIGSERIAL    PRIMARY KEY,
      bin_location_id  INTEGER      NOT NULL,
      row_data         JSONB        NOT NULL,
      blank_fields     TEXT[]       NOT NULL,
      reason           TEXT         NOT NULL,
      archived_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      migration        VARCHAR(80)  NOT NULL DEFAULT '20260915000016a_legacy_bin_blank_row_shelf',
      CONSTRAINT uq_legacy_bin_location_archive UNIQUE (bin_location_id, migration)
    )
  `);
  await knex.raw(`
    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN
        REVOKE ALL ON legacy_bin_location_archive FROM pulse_app;
        REVOKE ALL ON SEQUENCE legacy_bin_location_archive_id_seq FROM pulse_app;
        GRANT SELECT ON legacy_bin_location_archive TO pulse_app;
      END IF;
    END
    $grant$`);
}

export async function down() {
  console.log(`[${MIGRATION}] down: the archive is kept, by policy; only the ledger row is removed`);
}
