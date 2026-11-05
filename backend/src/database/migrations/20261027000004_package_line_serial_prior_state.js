/**
 * 20261027000004 — what a serial was before it was packed.
 *
 * Packing a pick list (pickListWorkflow.packPickList) sets each packed serial's
 * status to 'packed', its package_id to the new package and fills its
 * customer_id — overwriting all three. Unpacking must put them back EXACTLY,
 * and nothing recorded what they were, so an unpack could only guess.
 *
 * These columns record the serial's state at the moment it was packed, on the
 * package line that packed it:
 *   serial_prior_status       serial_numbers.status before packing
 *   serial_prior_package_id   serial_numbers.package_id before packing
 *   serial_prior_customer_id  serial_numbers.customer_id before packing
 *   serial_prior_recorded     true once the three above were captured — the
 *                             only reliable way to tell "prior value was NULL"
 *                             from "never recorded" (lines packed before this
 *                             migration stay false, and are NOT unpacked)
 *
 * Additive: nullable columns plus a boolean defaulting to false. Existing
 * package lines are untouched and simply cannot be unpacked automatically.
 *
 * Rollback: down() drops the columns; unpack then refuses every serial line.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE package_lines
      ADD COLUMN IF NOT EXISTS serial_prior_status      varchar(50),
      ADD COLUMN IF NOT EXISTS serial_prior_package_id  integer,
      ADD COLUMN IF NOT EXISTS serial_prior_customer_id text,
      ADD COLUMN IF NOT EXISTS serial_prior_recorded    boolean NOT NULL DEFAULT false
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE package_lines
      DROP COLUMN IF EXISTS serial_prior_recorded,
      DROP COLUMN IF EXISTS serial_prior_customer_id,
      DROP COLUMN IF EXISTS serial_prior_package_id,
      DROP COLUMN IF EXISTS serial_prior_status
  `);
}
