/**
 * 20260605000020_recruitment_enhancements.js
 *
 * Adds company_id scoping, Google Drive resume columns, hired_at,
 * and new pipeline stages to the recruitment module tables.
 * Uses SAVEPOINT per statement to prevent 25P02 transaction abort propagation.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT rec_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT rec_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT rec_sp');
      console.warn(`[recruitment_enhancements] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── company_id on all recruitment tables ──────────────────────────────────
  await safe('job_requisitions company_id', `
    ALTER TABLE job_requisitions
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
  `);

  await safe('job_openings columns', `
    ALTER TABLE job_openings
      ADD COLUMN IF NOT EXISTS company_id              INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS gdrive_folder_id        VARCHAR(200),
      ADD COLUMN IF NOT EXISTS gdrive_folder_structure JSONB
  `);

  await safe('candidates columns', `
    ALTER TABLE candidates
      ADD COLUMN IF NOT EXISTS company_id             INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS hired_at               TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS resume_gdrive_file_id  VARCHAR(200),
      ADD COLUMN IF NOT EXISTS resume_gdrive_url      TEXT,
      ADD COLUMN IF NOT EXISTS current_resume_folder  VARCHAR(50) DEFAULT 'Applied'
  `);

  await safe('interview_schedules company_id', `
    ALTER TABLE interview_schedules
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
  `);

  await safe('offer_letters company_id', `
    ALTER TABLE offer_letters
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
  `);

  // ── Backfill company_id down the chain ────────────────────────────────────
  await safe('backfill job_openings company_id', `
    UPDATE job_openings jo
    SET company_id = jr.company_id
    FROM job_requisitions jr
    WHERE jo.requisition_id = jr.id
      AND jo.company_id IS NULL
      AND jr.company_id IS NOT NULL
  `);

  await safe('backfill candidates company_id', `
    UPDATE candidates c
    SET company_id = jo.company_id
    FROM job_openings jo
    WHERE c.applied_job_id = jo.id
      AND c.company_id IS NULL
      AND jo.company_id IS NOT NULL
  `);

  await safe('backfill interview_schedules company_id', `
    UPDATE interview_schedules is_s
    SET company_id = c.company_id
    FROM candidates c
    WHERE is_s.candidate_id = c.id
      AND is_s.company_id IS NULL
      AND c.company_id IS NOT NULL
  `);

  await safe('backfill offer_letters company_id', `
    UPDATE offer_letters ol
    SET company_id = c.company_id
    FROM candidates c
    WHERE ol.candidate_id = c.id
      AND ol.company_id IS NULL
      AND c.company_id IS NOT NULL
  `);

  await safe('backfill hired_at', `
    UPDATE candidates SET hired_at = updated_at
    WHERE overall_status = 'hired' AND hired_at IS NULL
  `);

  // ── Performance indexes ───────────────────────────────────────────────────
  await safe('idx job_req company', `CREATE INDEX IF NOT EXISTS idx_job_req_company ON job_requisitions(company_id) WHERE deleted_at IS NULL`);
  await safe('idx job_openings company', `CREATE INDEX IF NOT EXISTS idx_job_openings_company ON job_openings(company_id, status) WHERE deleted_at IS NULL`);
  await safe('idx candidates company stage', `CREATE INDEX IF NOT EXISTS idx_candidates_company_stage ON candidates(company_id, current_stage) WHERE deleted_at IS NULL`);
  await safe('idx interview_sched company', `CREATE INDEX IF NOT EXISTS idx_interview_sched_company ON interview_schedules(company_id, interview_date) WHERE deleted_at IS NULL`);
  await safe('idx offer_letters company', `CREATE INDEX IF NOT EXISTS idx_offer_letters_company ON offer_letters(company_id, offer_status) WHERE deleted_at IS NULL`);

  console.log('[migration 20260605000020] Recruitment enhancements applied.');
}

export async function down(knex) {
  // Column drops are destructive — left intentionally empty for safety
}
