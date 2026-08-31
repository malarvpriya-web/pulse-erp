/**
 * Recruitment data-integrity constraints — closes the gaps found by the
 * 2026-08-12 live-data audit, where the module's core business rules existed
 * only in application code (or nowhere at all).
 *
 * 1. Candidate uniqueness. `candidates` had no unique constraint on email, and
 *    createCandidate() does a bare INSERT with no pre-check — so the same person
 *    could accumulate any number of candidate rows, forking their pipeline,
 *    interview and offer history across records with no error shown. Scoped per
 *    company (a person can legitimately be a candidate at two tenants) and
 *    case/whitespace-insensitive, since "A@b.com " and "a@b.com" are the same
 *    mailbox. Partial on deleted_at IS NULL so a soft-deleted candidate doesn't
 *    permanently block re-applying.
 *
 * 2. Missing foreign keys. `interview_schedules` and `offer_letters` — the two
 *    tables every live interview/offer write path actually uses — had ZERO
 *    foreign keys; candidate_id/interviewer_id/job_opening_id were bare integers,
 *    so a bad id silently produced a dangling row instead of an error. (A fully
 *    constrained but entirely dead `interviews` table exists alongside them; it
 *    is referenced only by a seed script and is left untouched here.)
 *
 * 3. `candidates.applied_job_id` — the column every live query joins on — had no
 *    FK either. The only FK'd column, `opening_id`, is abandoned by the write
 *    path. ON DELETE SET NULL matches the existing candidates_opening_id_fkey.
 *
 * 4. `employees.source_candidate_id` gets a partial unique index so a candidate
 *    cannot be hired into two employee records. hireCandidate() now guards this
 *    in application code too, but the DB is the backstop that also covers a
 *    genuine concurrent double-submit.
 *
 * Verified against the live DB before writing: zero orphaned rows on every
 * relationship below, zero duplicate candidate emails, zero duplicate hires.
 */

export async function up(knex) {
  // 1. Candidate email uniqueness, per company, case/whitespace-insensitive.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidates_company_email_uniq
      ON candidates (company_id, LOWER(TRIM(email)))
      WHERE deleted_at IS NULL AND email IS NOT NULL AND TRIM(email) <> ''
  `);

  // 2. interview_schedules foreign keys.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_schedules_candidate_id_fkey') THEN
        ALTER TABLE interview_schedules
          ADD CONSTRAINT interview_schedules_candidate_id_fkey
          FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_schedules_interviewer_id_fkey') THEN
        ALTER TABLE interview_schedules
          ADD CONSTRAINT interview_schedules_interviewer_id_fkey
          FOREIGN KEY (interviewer_id) REFERENCES employees(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_schedules_company_id_fkey') THEN
        ALTER TABLE interview_schedules
          ADD CONSTRAINT interview_schedules_company_id_fkey
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // 3. offer_letters foreign keys.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offer_letters_candidate_id_fkey') THEN
        ALTER TABLE offer_letters
          ADD CONSTRAINT offer_letters_candidate_id_fkey
          FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offer_letters_job_opening_id_fkey') THEN
        ALTER TABLE offer_letters
          ADD CONSTRAINT offer_letters_job_opening_id_fkey
          FOREIGN KEY (job_opening_id) REFERENCES job_openings(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offer_letters_company_id_fkey') THEN
        ALTER TABLE offer_letters
          ADD CONSTRAINT offer_letters_company_id_fkey
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // 4. candidates.applied_job_id — the column live code actually uses.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidates_applied_job_id_fkey') THEN
        ALTER TABLE candidates
          ADD CONSTRAINT candidates_applied_job_id_fkey
          FOREIGN KEY (applied_job_id) REFERENCES job_openings(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  // 5. One employee per source candidate.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS employees_source_candidate_uniq
      ON employees (source_candidate_id)
      WHERE source_candidate_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS employees_source_candidate_uniq`);
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_applied_job_id_fkey`);
  await knex.raw(`ALTER TABLE offer_letters DROP CONSTRAINT IF EXISTS offer_letters_company_id_fkey`);
  await knex.raw(`ALTER TABLE offer_letters DROP CONSTRAINT IF EXISTS offer_letters_job_opening_id_fkey`);
  await knex.raw(`ALTER TABLE offer_letters DROP CONSTRAINT IF EXISTS offer_letters_candidate_id_fkey`);
  await knex.raw(`ALTER TABLE interview_schedules DROP CONSTRAINT IF EXISTS interview_schedules_company_id_fkey`);
  await knex.raw(`ALTER TABLE interview_schedules DROP CONSTRAINT IF EXISTS interview_schedules_interviewer_id_fkey`);
  await knex.raw(`ALTER TABLE interview_schedules DROP CONSTRAINT IF EXISTS interview_schedules_candidate_id_fkey`);
  await knex.raw(`DROP INDEX IF EXISTS candidates_company_email_uniq`);
}
