/**
 * candidate_applications — one candidate, many jobs.
 *
 * `candidates.applied_job_id` is a single scalar, so a candidate could hold
 * exactly one application. That is the structural reason the audit marked
 * "recommend this candidate for another opening" as NOT IMPLEMENTED rather than
 * missing an endpoint: the only way to point a candidate at a second job was to
 * overwrite the column, which silently destroyed the first application's
 * identity while leaving its interviews, notes and offer attached to a record
 * that now claims to be about a different role.
 *
 * This table is the relationship that was missing. Each row is one candidate
 * being considered for one opening, carrying its OWN stage and status — because
 * "shortlisted for Service Engineer, rejected for Electrical Engineer" is an
 * ordinary outcome that a single column on `candidates` cannot express.
 *
 * ── WHY candidates.applied_job_id STAYS ─────────────────────────────────────
 * It is not dropped and not deprecated. Roughly forty call sites read it —
 * the pipeline board, the dashboard, vacancy aging, the offer flow — and
 * rewriting all of them in the same change that introduces the table would make
 * one reviewable migration into a module rewrite. It keeps its meaning as the
 * candidate's PRIMARY application (the one the pipeline views follow), and the
 * repository keeps the two in step: creating a candidate against a job writes
 * both, and the primary application's stage moves write through to
 * `candidates.current_stage`. Secondary applications live only here.
 *
 * ── BACKFILL ────────────────────────────────────────────────────────────────
 * Every candidate with an applied_job_id gets a row marked `is_primary`, taking
 * its stage and status from the candidate. Candidates with no opening (the
 * speculative Resume Database intake) get no row — they have not applied to
 * anything, which is exactly what the talent pool is for.
 */

const STAGES = `'applied','screening','1st_level','2nd_level','offer','hired','not_suitable','maybe','future_use','rejected'`;
const STATUSES = `'active','hired','rejected','withdrawn'`;

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_applications (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      job_opening_id  INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,

      -- Per-application, not per-candidate. This is the whole point of the table.
      stage           VARCHAR(30) NOT NULL DEFAULT 'applied',
      status          VARCHAR(20) NOT NULL DEFAULT 'active',

      -- 'applied' = the candidate came in against this job.
      -- 'recommended' = a recruiter put them forward for it after assessing
      -- them for something else. Keeping the distinction means source-effectiveness
      -- reporting is not polluted by internal redirection.
      origin          VARCHAR(20) NOT NULL DEFAULT 'applied',

      -- The application the legacy candidates.applied_job_id mirrors.
      is_primary      BOOLEAN NOT NULL DEFAULT false,

      recommended_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      recommended_from_job_id INTEGER REFERENCES job_openings(id) ON DELETE SET NULL,
      notes           TEXT,

      applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT candidate_applications_stage_check  CHECK (stage  IN (${STAGES})),
      CONSTRAINT candidate_applications_status_check CHECK (status IN (${STATUSES})),
      CONSTRAINT candidate_applications_origin_check CHECK (origin IN ('applied','recommended'))
    )
  `);

  // The constraint that makes "avoid creating duplicate candidate profiles" a
  // guarantee rather than an intention: the same person cannot be recorded twice
  // against the same opening, whatever route the second attempt arrives by.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_applications_unique
      ON candidate_applications (candidate_id, job_opening_id)
  `);

  // At most one primary per candidate — the row candidates.applied_job_id mirrors.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_applications_one_primary
      ON candidate_applications (candidate_id) WHERE is_primary
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_applications_opening
      ON candidate_applications (company_id, job_opening_id, stage)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_applications_candidate
      ON candidate_applications (candidate_id)
  `);

  // ── Backfill ──────────────────────────────────────────────────────────────
  // Joined to job_openings so a candidate pointing at a deleted opening is
  // skipped rather than failing the FK. `applied_at` takes the candidate's own
  // created_at, so vacancy-aging style reporting sees the real date.
  await knex.raw(`
    INSERT INTO candidate_applications
      (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary, applied_at)
    SELECT c.company_id, c.id, c.applied_job_id,
           COALESCE(NULLIF(c.current_stage, ''), 'applied'),
           COALESCE(NULLIF(c.overall_status, ''), 'active'),
           'applied', true, COALESCE(c.created_at, NOW())
      FROM candidates c
      JOIN job_openings jo ON jo.id = c.applied_job_id
     WHERE c.applied_job_id IS NOT NULL
       AND c.deleted_at IS NULL
       AND c.company_id IS NOT NULL
    ON CONFLICT (candidate_id, job_opening_id) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS candidate_applications`);
}
