/**
 * 20260909000001_sequence_enrollment_integrity.js
 *
 * `sequence_enrollments.sequence_id` had NO foreign key, and it showed: all five
 * seeded enrolments name sequence_id 1–5 while `email_sequences` holds only
 * 21–25. Every one of them was an orphan pointing at a journey that has never
 * existed — which is why the sequences screen could report "5 active enrolments"
 * that no runner would ever touch.
 *
 * It is not only stale seed data. Deleting a sequence through
 * DELETE /crm/email-sequences/:id stranded its enrolments the same way, so the
 * orphan set grew every time somebody removed a journey. Confirmed by producing
 * three more of them while verifying the runner (§156).
 *
 * ON DELETE CASCADE rather than RESTRICT: an enrolment in a journey that no
 * longer exists has no meaning and nothing can act on it. The delete ROUTE is
 * separately hardened to refuse while live enrolments remain, so the cascade is
 * a backstop against orphans, not the normal path — what protects the history is
 * the route, and `crm_emails` keeps the record of what was actually sent
 * regardless, because it has no FK to the enrolment.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  const { rows: [before] } = await knex.raw(`
    SELECT COUNT(*)::int AS orphans
      FROM sequence_enrollments e
      LEFT JOIN email_sequences s ON s.id = e.sequence_id
     WHERE s.id IS NULL
  `);

  // Quarantine before constraining: an orphan cannot be repaired (there is no
  // journey to point it at) and the FK cannot be added while one exists. They
  // are recorded in the event log first so the deletion is not silent.
  await knex.raw(`
    INSERT INTO sequence_enrollment_events
      (enrollment_id, sequence_id, company_id, event, detail)
    SELECT e.id, e.sequence_id, e.company_id, 'stopped',
           'Removed 2026-09-09: enrolment referenced sequence ' || e.sequence_id ||
           ', which does not exist. No step could ever have been sent.'
      FROM sequence_enrollments e
      LEFT JOIN email_sequences s ON s.id = e.sequence_id
     WHERE s.id IS NULL
  `);

  await knex.raw(`
    DELETE FROM sequence_enrollments e
     WHERE NOT EXISTS (SELECT 1 FROM email_sequences s WHERE s.id = e.sequence_id)
  `);

  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_sequence_id_fkey'
      ) THEN
        ALTER TABLE sequence_enrollments
          ADD CONSTRAINT sequence_enrollments_sequence_id_fkey
          FOREIGN KEY (sequence_id) REFERENCES email_sequences(id) ON DELETE CASCADE;
      END IF;
    END
    $do$;
  `);

  const { rows: [after] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM sequence_enrollments`);
  console.log(`[sequence_enrollment_integrity] removed ${before.orphans} orphans, ${after.n} enrolments remain, FK added`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE sequence_enrollments
      DROP CONSTRAINT IF EXISTS sequence_enrollments_sequence_id_fkey
  `);
}
