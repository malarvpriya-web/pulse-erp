/**
 * Two recruitment columns that could not do their job.
 *
 * 1. candidate_stage_history.moved_by records WHO moved a candidate through the
 *    pipeline — and is a foreign key to employees(id). Several callers pass
 *    `req.user.employee_id`, which is NULL for any account without an employee
 *    record. On this database that includes BOTH admin logins, so every stage
 *    move made by an administrator was written with no actor at all: the
 *    candidate's history showed the transition and an empty "moved by" column.
 *
 *    An audit trail that drops the actor for privileged users is exactly
 *    backwards. `moved_by_user_id` records the acting login unconditionally;
 *    `moved_by` keeps its existing meaning (the employee, where there is one) so
 *    nothing that already reads it changes.
 *
 * 2. candidates.overall_rating has existed all along and is written by nothing.
 *    Interview ratings live in interview_notes, one row per interview, so
 *    "candidates rated 4 or better" could not be asked without a correlated
 *    subquery no caller wrote. This backfills the column from the notes already
 *    recorded and the repository now maintains it whenever a note is saved,
 *    which is what makes rating usable as a search filter.
 */

export async function up(knex) {
  // ── 1. Actor on stage history ─────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE candidate_stage_history
      ADD COLUMN IF NOT EXISTS moved_by_user_id INTEGER
  `);
  await knex.raw(`
    ALTER TABLE candidate_stage_history
      DROP CONSTRAINT IF EXISTS candidate_stage_history_moved_by_user_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE candidate_stage_history
      ADD CONSTRAINT candidate_stage_history_moved_by_user_id_fkey
      FOREIGN KEY (moved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  `);

  // Where an employee actor WAS recorded, derive the login that belongs to it so
  // existing history gains an actor rather than staying blank.
  await knex.raw(`
    UPDATE candidate_stage_history h
       SET moved_by_user_id = u.id
      FROM users u
     WHERE h.moved_by IS NOT NULL
       AND h.moved_by_user_id IS NULL
       AND u.employee_id = h.moved_by
  `);

  // ── 2. Backfill overall_rating from the notes that already exist ──────────
  await knex.raw(`
    UPDATE candidates c
       SET overall_rating = agg.avg_rating
      FROM (
        SELECT candidate_id, ROUND(AVG(rating)::numeric, 2) AS avg_rating
          FROM interview_notes
         WHERE rating IS NOT NULL
         GROUP BY candidate_id
      ) agg
     WHERE agg.candidate_id = c.id
       AND c.overall_rating IS DISTINCT FROM agg.avg_rating
  `);

  // Rating and location are both search predicates now; neither had an index.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_overall_rating
      ON candidates (company_id, overall_rating)
     WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_location
      ON candidates (company_id, LOWER(location))
     WHERE deleted_at IS NULL
  `);
  // Skill filtering scans candidates.skills on every Resume Database query.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_skills_gin
      ON candidates USING GIN (skills)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_skills_gin`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_location`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_overall_rating`);
  await knex.raw(`
    ALTER TABLE candidate_stage_history
      DROP CONSTRAINT IF EXISTS candidate_stage_history_moved_by_user_id_fkey
  `);
  await knex.raw(`
    ALTER TABLE candidate_stage_history DROP COLUMN IF EXISTS moved_by_user_id
  `);
}
