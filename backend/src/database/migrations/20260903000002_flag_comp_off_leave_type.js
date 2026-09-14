/**
 * 20260903000002_flag_comp_off_leave_type.js
 *
 * Flags the existing "Compensatory Off" leave type with is_comp_off_type.
 *
 * The comp-off approval path resolves where to post the credit with
 *   SELECT id FROM leave_types WHERE is_comp_off_type = true AND is_active ...
 * and no seeded leave type has ever carried that flag — every database has a
 * leave type literally named "Compensatory Off" with is_comp_off_type = false.
 *
 * The old approve route credited inside `if (ltRows.length)` and then answered
 * `{ credited: true }` regardless, so approving a comp off set credited = true
 * on the record, told the employee their leave balance had gone up, and moved
 * no balance at all. The nightly expiry job reversed the same nothing. The
 * route now refuses to approve when the flag is missing rather than lying about
 * it, which makes this backfill the difference between comp off working and
 * comp off being un-approvable.
 *
 * Matched on leave_code / leave_name rather than id because the id differs per
 * database. Scoped per company: each tenant gets at most one flagged type, and
 * a company that already has one is left alone.
 */

const CODE_MATCH = `(
     UPPER(COALESCE(leave_code, '')) LIKE 'COMP%'
  OR LOWER(COALESCE(leave_name, '')) LIKE '%compensatory%'
  OR LOWER(COALESCE(leave_name, '')) LIKE '%comp off%'
  OR LOWER(COALESCE(leave_name, '')) LIKE '%comp-off%'
)`;

export async function up(knex) {
  // One per company, lowest id wins, and only where the company has none flagged.
  await knex.raw(`
    UPDATE leave_types lt
       SET is_comp_off_type = true,
           updated_at       = NOW()
     WHERE lt.id IN (
       SELECT DISTINCT ON (COALESCE(company_id, 0)) id
         FROM leave_types
        WHERE is_active = true
          AND deleted_at IS NULL
          AND is_comp_off_type = false
          AND ${CODE_MATCH}
          AND COALESCE(company_id, 0) NOT IN (
                SELECT COALESCE(company_id, 0) FROM leave_types
                 WHERE is_comp_off_type = true AND deleted_at IS NULL
              )
        ORDER BY COALESCE(company_id, 0), id
     )
  `);
}

export async function down(knex) {
  // Only unflag rows that look like the ones up() would have picked; a type an
  // admin flagged by hand should survive a rollback.
  await knex.raw(`
    UPDATE leave_types
       SET is_comp_off_type = false,
           updated_at       = NOW()
     WHERE is_comp_off_type = true
       AND ${CODE_MATCH}
  `);
}
