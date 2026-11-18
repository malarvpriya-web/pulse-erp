/**
 * 20261111000008_close_legacy_probation_log.js
 *
 * probation_notifications is now a plain log of reminders sent. Decisions on
 * it were retired on 2026-11-11: PUT /probation/:id and
 * /probation/by-employee/:id answer 410, and the decision is recorded on the
 * probation REVIEW (POST /probation-reviews/:id/decide), which updates the
 * employee.
 *
 * So no log row can be "pending a decision" any more. Most of the pending rows
 * were spam: the old Probation page posted a probation_due alert on every page
 * load (146 such rows on the dev database). This closes every pending row and
 * marks it, so the change can be undone exactly.
 *
 * Rows that already carry a decision are left as they are: they are history.
 */
const MARK = '[closed 2026-11-11: probation decisions moved to probation reviews]';

export async function up(knex) {
  await knex.raw(
    `UPDATE probation_notifications
        SET status = 'closed',
            remarks = CASE WHEN COALESCE(remarks, '') = '' THEN $1::text ELSE remarks || ' ' || $1::text END
      WHERE status = 'pending' AND decision IS NULL`,
    [MARK],
  );
}

export async function down(knex) {
  await knex.raw(
    `UPDATE probation_notifications
        SET status = 'pending',
            remarks = NULLIF(BTRIM(REPLACE(remarks, $1::text, '')), '')
      WHERE status = 'closed' AND remarks LIKE $2`,
    [MARK, `%${MARK}%`],
  );
}
