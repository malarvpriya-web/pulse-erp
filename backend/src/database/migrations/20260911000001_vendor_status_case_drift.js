/**
 * One vendor state, one spelling.
 *
 * `vendors.status` was written three different ways:
 *
 *   'active'    the column default, every test fixture, and the vendor master UI
 *   'Active'    hard-coded in vendor-approval.routes.js, the route that creates a
 *               vendor when a registration is APPROVED
 *   'Inactive'  hard-coded in vendor.repository.js's soft delete
 *
 * The approval one is the damaging case. `VendorManagement.jsx` renders the
 * status chip with `v.status === 'active' ? 'Active' : ... : 'Inactive'` and
 * builds its active-vendor picker with `vendors.filter(v => v.status ===
 * 'active')`. So a supplier that had been through the full four-stage SCM →
 * Quality → Finance → Management approval — the ones most likely to be ordered
 * from — displayed as **Inactive** and was absent from the active list, which
 * then read "No active vendors."
 *
 * Case drift also splits aggregates: filters that LOWER() stay correct, but
 * GROUP BY does not, so one state is reported twice with its rows and its value
 * divided between the spellings. Same defect class as the opportunity-stage
 * drift in project_opportunity_stage_vocabulary_closed_won.
 *
 * Found by `scripts/check-status-vocabulary.mjs`, which flagged
 * `vendors.status: active | Active` during a parallel test run — the approval
 * suite creates such a vendor and deletes it, so the drift was only ever visible
 * for the seconds that row existed. The writers are fixed in the same change;
 * this normalises anything they already wrote.
 */

export async function up(knex) {
  // Idempotent and spelling-agnostic: fold every casing onto the lower-case
  // canonical rather than naming the two we happen to know about.
  const { rows } = await knex.raw(`
    UPDATE vendors
       SET status = LOWER(status), updated_at = NOW()
     WHERE status IS NOT NULL
       AND status <> LOWER(status)
    RETURNING id, status
  `);
  if (rows?.length) {
    console.log(`[20260911000001] normalised vendors.status on ${rows.length} row(s) to lower case`);
  }
}

/**
 * No down. Restoring a capitalised spelling would recreate the split this
 * exists to remove, and there is no record of which rows carried which casing —
 * the information the down migration would need is exactly what was wrong.
 */
export async function down() {
  // intentionally empty
}
