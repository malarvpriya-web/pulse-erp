/**
 * Three related Recruitment schema fixes.
 *
 * 1. CREATE `interview_notes` — a P0. Four live code paths write to or read from
 *    this table (recruitment.repository.js createInterviewNote/findInterviewNotes,
 *    recruitment.routes.js POST /interviews/:id/submit-feedback, and
 *    CandidateDetail.jsx's "Add Interview Feedback" form) but the table exists
 *    NOWHERE — not in baseline.sql, not in any migration, and not in the live
 *    database. Every interview-feedback submission therefore 500'd.
 *
 *    The damage was wider than lost feedback: submit-feedback is a 7-step
 *    sequence and the insert is step 4, so steps 5-7 never ran either. Completing
 *    an interview did not mark it completed and did not advance the candidate to
 *    the next stage. The whole "interview → outcome → next stage" transition was
 *    dead, silently, for every user.
 *
 *    Column set is taken from the four call sites verbatim. `rating` is
 *    numeric(2,1) because CandidateDetail.jsx's input is `step="0.1"` min 1 max 5.
 *    `recommendation` covers both vocabularies in use: the form offers
 *    strong_hire/hire/hold/reject, while submit-feedback writes hire/reject.
 *    No company_id column — scoping is via the candidate, exactly as
 *    createInterviewNote()'s own ownership check already assumes.
 *
 * 2. DROP the dead `interviews` table (singular). Verified before writing:
 *    0 rows, zero FK references from any other table, referenced by no view, and
 *    referenced in application code only by database/seeds/masterSeed.js. All live
 *    interview code uses `interview_schedules`. Keeping a fully-constrained,
 *    similarly-named twin beside the live table is the "table twins = drift
 *    smell" pattern this codebase has been bitten by repeatedly — someone will
 *    eventually write a query against the wrong one. `down()` recreates it.
 *
 * No settings seeding is needed for the Expiring Offers fix: the key already
 * exists as company_settings(module='recruitment').settings->>'offer_validity_days'
 * and RecruitmentSettings.jsx already writes it — company 1 has it set to 7. The
 * bug was purely that talent.routes.js ignored it and hardcoded 14, so the
 * configured value never took effect. That fix is in the route, not the schema.
 */

export async function up(knex) {
  // ── 1. interview_notes ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS interview_notes (
      id              SERIAL PRIMARY KEY,
      candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      interviewer_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      interview_round VARCHAR(100),
      rating          NUMERIC(2,1) CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
      comments        TEXT,
      recommendation  VARCHAR(20) CHECK (
                        recommendation IS NULL OR
                        recommendation IN ('strong_hire','hire','hold','reject')),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS interview_notes_candidate_idx
      ON interview_notes (candidate_id, created_at DESC)
  `);

  // ── 2. drop the dead twin ─────────────────────────────────────────────────
  // Guarded: only drops if genuinely empty, so this can never destroy real data
  // even if some environment did start using it.
  await knex.raw(`
    DO $$
    DECLARE n bigint;
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='interviews') THEN
        EXECUTE 'SELECT COUNT(*) FROM interviews' INTO n;
        IF n = 0 THEN
          DROP TABLE interviews CASCADE;
        ELSE
          RAISE NOTICE 'interviews table not dropped: % row(s) present', n;
        END IF;
      END IF;
    END $$;
  `);

}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS interview_notes_candidate_idx`);
  await knex.raw(`DROP TABLE IF EXISTS interview_notes`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS interviews (
      id SERIAL PRIMARY KEY,
      company_id integer NOT NULL,
      candidate_id integer NOT NULL,
      job_opening_id integer,
      interview_level integer NOT NULL,
      interview_type character varying(50),
      interviewer_id integer NOT NULL,
      assigned_by integer,
      scheduled_date date,
      scheduled_time time without time zone,
      duration_minutes integer,
      meeting_link character varying(500),
      location character varying(255),
      status character varying(30),
      outcome character varying(30),
      rating integer CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
      feedback text,
      rejection_reason text,
      strengths text,
      areas_of_improvement text,
      completed_at timestamptz,
      created_at timestamptz DEFAULT NOW()
    )
  `);
}
