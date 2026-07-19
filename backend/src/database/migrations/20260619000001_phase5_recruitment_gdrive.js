/**
 * 20260619000001_phase5_recruitment_gdrive.js
 *
 * Phase 5 — Recruitment Google Drive + Hired→Employee flow.
 *
 * Fixes:
 *  1. job_openings — add job_title, department, location, employment_type,
 *     experience_min/max, salary_min/max, description, requirements, benefits.
 *     Make opening_date nullable (so POST /openings without it doesn't fail).
 *  2. candidates — ensure applied_job_id, full_name, current_stage,
 *     source_agency_id exist (UUID-based schema may already have them).
 *  3. employees — add source_candidate_id (Phase 51 auto-creation link),
 *     employment_type (used in auto-creation INSERT).
 *  4. CHECK constraint on candidates.current_stage for all valid pipeline stages.
 *
 * Every statement uses SAVEPOINT so a pre-existing column/constraint never
 * aborts the whole transaction.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_p5_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = (err.message || '').split('\n')[0];
      if (!/already exists|does not exist|duplicate column|duplicate key|violates check/i.test(msg)) {
        throw err;
      }
      console.warn(`[phase5_recruitment_gdrive] skip (${label}): ${msg}`);
    }
  };

  // ── 1. job_openings: add missing content columns ────────────────────────
  await safe('job_openings job_title',      `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS job_title        VARCHAR(255)`);
  await safe('job_openings department',     `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS department       VARCHAR(100)`);
  await safe('job_openings location',       `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS location         VARCHAR(255)`);
  await safe('job_openings employment_type',`ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS employment_type  VARCHAR(50)`);
  await safe('job_openings experience_min', `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS experience_min   INTEGER DEFAULT 0`);
  await safe('job_openings experience_max', `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS experience_max   INTEGER`);
  await safe('job_openings salary_min',     `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS salary_min       NUMERIC(14,2)`);
  await safe('job_openings salary_max',     `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS salary_max       NUMERIC(14,2)`);
  await safe('job_openings description',    `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS description      TEXT`);
  await safe('job_openings requirements',   `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS requirements     TEXT`);
  await safe('job_openings benefits',       `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS benefits         TEXT`);

  // Make opening_date nullable so INSERT without it doesn't error
  await safe('job_openings opening_date nullable',
    `ALTER TABLE job_openings ALTER COLUMN opening_date DROP NOT NULL`);

  // Default opening_date to CURRENT_DATE when not supplied
  await safe('job_openings opening_date default',
    `ALTER TABLE job_openings ALTER COLUMN opening_date SET DEFAULT CURRENT_DATE`);

  // ── 2. candidates: ensure UUID-schema columns exist ─────────────────────
  // These exist when recruitment-schema.sql was the baseline; safe if already present.
  await safe('candidates full_name',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS full_name VARCHAR(255)`);
  await safe('candidates applied_job_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS applied_job_id INTEGER`);
  await safe('candidates current_stage',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS current_stage VARCHAR(100) DEFAULT 'applied'`);
  await safe('candidates overall_status',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS overall_status VARCHAR(30) DEFAULT 'active'`);
  await safe('candidates source_agency_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS source_agency_id INTEGER`);
  await safe('candidates hired_at',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ`);
  await safe('candidates deleted_at',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);

  // Normalize existing stage values to lowercase before adding CHECK constraint
  await safe('candidates stage lowercase',
    `UPDATE candidates SET current_stage = LOWER(current_stage) WHERE current_stage IS NOT NULL`);

  // CHECK constraint on current_stage (drop old one first, add new)
  await safe('candidates stage check drop',
    `ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_pipeline_stage_check`);
  await safe('candidates stage check drop2',
    `ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_current_stage_check`);
  await safe('candidates stage check add',
    `ALTER TABLE candidates ADD CONSTRAINT candidates_current_stage_check
     CHECK (current_stage IN (
       'applied','screening','1st_level','2nd_level','offer','hired',
       'not_suitable','maybe','future_use','rejected'
     ))`);

  // ── 3. employees: add columns needed by hire + auto-creation ────────────
  await safe('employees source_candidate_id',
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS source_candidate_id INTEGER`);
  await safe('employees employment_type',
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type VARCHAR(50) DEFAULT 'Full-time'`);
  await safe('employees status',
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'Active'`);

  // ── 4. Indexes ───────────────────────────────────────────────────────────
  await safe('idx job_openings job_title',
    `CREATE INDEX IF NOT EXISTS idx_job_openings_title ON job_openings(job_title)`);
  await safe('idx candidates current_stage',
    `CREATE INDEX IF NOT EXISTS idx_candidates_current_stage ON candidates(current_stage) WHERE deleted_at IS NULL`);
  await safe('idx employees source_candidate',
    `CREATE INDEX IF NOT EXISTS idx_employees_source_candidate ON employees(source_candidate_id)`);

  console.log('[migration 20260619000001] Phase 5 recruitment + Drive columns applied.');
}

export async function down(knex) {
  // Column drops are destructive — left intentionally empty for safety.
  // To rollback manually:
  //   ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_current_stage_check;
}
