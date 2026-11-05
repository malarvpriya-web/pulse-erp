/**
 * 20261027000006 — a serial belongs to one LIVE package line, not one line ever.
 *
 * uq_package_lines_serial (20260915000019, "A packed unit belongs to one
 * package line") is unique on serial_id across every package line. Unpacking
 * (pickListWorkflow.unpackPickList) keeps a package's lines as history, so
 * under that index a serial once packed and unpacked could never be packed
 * again.
 *
 * package_lines.unpacked marks a line whose package was unpacked; the unique
 * index now covers only lines that are not. The rule it enforces — one live
 * package line per serial — is unchanged. Every existing line is live and was
 * already unique under the stricter index, so the new index cannot fail on
 * existing data; it is created before the old one is dropped.
 *
 * Rollback: down() restores the all-lines index — which fails once a serial
 * has been re-packed after an unpack (it then has two lines), by design.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE package_lines ADD COLUMN IF NOT EXISTS unpacked boolean NOT NULL DEFAULT false`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_package_lines_serial_live
      ON package_lines (serial_id) WHERE serial_id IS NOT NULL AND NOT unpacked
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_package_lines_serial`);
}

export async function down(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_package_lines_serial
      ON package_lines (serial_id) WHERE serial_id IS NOT NULL
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_package_lines_serial_live`);
  await knex.raw(`ALTER TABLE package_lines DROP COLUMN IF EXISTS unpacked`);
}
