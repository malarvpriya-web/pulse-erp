/**
 * 20260719000002_service_engineer_inventory_view.js
 *
 * Grants `service_engineer` read-only access to the inventory module.
 *
 * Why: a service engineer on a customer site could raise tickets, log
 * maintenance and read IoT telemetry, but not check whether a spare part was in
 * stock — `inventory.can_view` was false. Surfaced by
 * scripts/security/pilot-readiness.mjs as the single blocked capability across
 * the whole pilot cohort (54 of 55 passed).
 *
 * Scope: `can_view` ONLY. Engineers consume stock information; they do not
 * adjust stock, which stays with store_keeper and procurement. Granting the
 * narrowest thing that unblocks the job.
 *
 * This is config that must reach production, hence a migration rather than a
 * one-off UPDATE. Idempotent: only flips the flag when a row already exists and
 * is false, so re-running is safe and it will not resurrect a row an
 * administrator has since deleted.
 */

export async function up(knex) {
  const { rows } = await knex.raw(
    `UPDATE role_permissions rp
        SET can_view = true
       FROM roles r
      WHERE r.id = rp.role_id
        AND LOWER(r.code) = 'service_engineer'
        AND rp.module = 'inventory'
        AND rp.can_view = false
      RETURNING rp.id`
  );
  console.log(rows.length
    ? '[service_engineer_inventory] granted inventory.can_view'
    : '[service_engineer_inventory] no change (already granted, or row absent)');
}

export async function down(knex) {
  await knex.raw(
    `UPDATE role_permissions rp
        SET can_view = false
       FROM roles r
      WHERE r.id = rp.role_id
        AND LOWER(r.code) = 'service_engineer'
        AND rp.module = 'inventory'`
  );
}
