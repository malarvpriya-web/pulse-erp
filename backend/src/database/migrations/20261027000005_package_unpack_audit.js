/**
 * 20261027000005 — who unpacked a package, and when.
 *
 * Unpacking (pickListWorkflow.unpackPickList) keeps the package and its lines
 * as history — status 'unpacked' — rather than deleting them; these columns
 * record the act itself.
 *
 * Also corrects package_lines.serial_prior_customer_id (20261027000004) from
 * text to uuid, the type of serial_numbers.customer_id it copies. Nothing has
 * written the column yet; the USING cast fails loudly rather than silently if
 * a non-uuid value were ever present.
 *
 * Additive. Rollback: down() drops the three columns and returns the type.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE packages
      ADD COLUMN IF NOT EXISTS unpacked_at      timestamptz,
      ADD COLUMN IF NOT EXISTS unpacked_by      integer,
      ADD COLUMN IF NOT EXISTS unpacked_by_name varchar(255)
  `);
  await knex.raw(`
    ALTER TABLE package_lines
      ALTER COLUMN serial_prior_customer_id TYPE uuid USING serial_prior_customer_id::uuid
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE package_lines
      ALTER COLUMN serial_prior_customer_id TYPE text USING serial_prior_customer_id::text
  `);
  await knex.raw(`
    ALTER TABLE packages
      DROP COLUMN IF EXISTS unpacked_by_name,
      DROP COLUMN IF EXISTS unpacked_by,
      DROP COLUMN IF EXISTS unpacked_at
  `);
}
