/**
 * 20260927000001_recruitment_candidate_intelligence.js
 *
 * The structural half of the Recruitment redesign: everything the module needed
 * a TABLE or a COLUMN for before a screen could be built on it.
 *
 * Every statement here is additive. No column is dropped, no vocabulary is
 * narrowed, no existing row is rewritten except where a backfill fills in a
 * value that was previously NULL. That is deliberate — roughly forty call sites
 * read `candidates`, and the 114-test recruitment regression suite passes
 * against the current shape.
 *
 * ── WHY `disposition` RATHER THAN WIDENING `overall_status` ──────────────────
 * The brief (§4) asks for a candidate state of New / Active / In Screening /
 * Talent Bank / Future Opportunity / Hired / Inactive / Blacklisted / Rejected
 * from Manifest, and says explicitly that "Rejected" must not be the only
 * negative state.
 *
 * `candidates.overall_status` looks like the place for it, and it is not. That
 * column answers a different question — "is this APPLICATION still live?"
 * (active/hired/rejected/withdrawn) — it is derived from the primary
 * application's stage in both directions by the repository, and four of the
 * existing tests assert exactly that derivation. Widening it would put two
 * vocabularies with different meanings in one column, which is how this codebase
 * has produced its worst data defects: a value that reads as a status but
 * answers a different question.
 *
 * So the candidate-level state gets its own column. `overall_status` keeps its
 * meaning and, for the first time, gets the CHECK constraint it never had —
 * with exactly its four existing values, so it is a lock, not a change.
 *
 * ── WHY NO `candidate_status_history` TABLE ─────────────────────────────────
 * The brief's §28 lists one. `candidate_activity` here records every event with
 * an actor and a timestamp, status changes included. Two tables would mean a
 * recruiter reading a candidate's history has to read two lists and merge them
 * in their head, and would mean two places to forget to write to. One timeline.
 *
 * ── WHY NO `candidate_education` / `candidate_skills` TABLES ────────────────
 * Also listed in §28, and also already answered: migration 20260917000036 put
 * qualification/specialisation/institution/graduation_year on `candidates` with
 * indexes, and `skills` is an indexed jsonb array with a type CHECK. A recruiter
 * filters on the highest relevant qualification, not a full academic history.
 * Nothing here forecloses a history table later.
 *
 * ── DEFECTS CLOSED IN PASSING ───────────────────────────────────────────────
 * D-2  WITHDRAWN — not a defect. See section 2 below: the unique index already
 *      existed; the audit looked in pg_constraint, which does not list it.
 * D-3  There was no column recording when a candidate last MOVED, so the work
 *      queue measured staleness from created_at while claiming otherwise.
 *      `last_activity_at` is that column, backfilled from the stage history.
 * D-5  overall_status had no CHECK. Now it has one.
 * D-7  candidate_stage_history and interview_notes had no company_id — tenant
 *      scoping depended entirely on remembering to join through candidates.
 */

// ── Vocabularies ────────────────────────────────────────────────────────────

// Stage keys. The first ten are the existing set, untouched. `shortlisted`,
// `assessment` and `selected` are the three steps the brief's §7 pipeline has
// that this one did not; adding them to the CHECK is additive, and no stored row
// changes. Labels are the frontend's business (shared/constants.js) — `hired`
// stays the key and simply reads "Joined", which is why the hire automation,
// which matches on the literal 'hired', is unaffected.
const STAGES = `
  'applied','screening','shortlisted','assessment','1st_level','2nd_level',
  'offer','selected','hired','not_suitable','maybe','future_use','rejected'
`;

// §4's candidate-level disposition. 'new' is the default because a candidate who
// has just arrived has not yet been dispositioned by anybody.
const DISPOSITIONS = `
  'new','active','in_screening','talent_bank','future_opportunity',
  'hired','inactive','blacklisted','rejected_from_manifest'
`;

// The four values overall_status has actually held since it was created. Locking
// them in, not changing them.
const OVERALL_STATUSES = `'active','hired','rejected','withdrawn'`;

const NOTE_TYPES = `
  'recruiter','screening','interview','technical','management','followup','general'
`;

// 'internal'  — any holder of recruitment:view (the default; a recruiter note)
// 'private'   — the author only
// 'shared'    — additionally visible to the hiring manager on the requisition
const NOTE_VISIBILITIES = `'internal','private','shared'`;

// §11's eligibility verdicts. 'not_assessed' is a real answer, and the default:
// a half-finished screening must be able to say "I have not looked at this yet"
// rather than defaulting to a verdict nobody gave.
const FIT_VERDICTS = `'not_assessed','meets','partial','does_not_meet'`;
const NOTICE_VERDICTS = `'not_assessed','acceptable','needs_discussion','not_acceptable'`;
const LOCATION_VERDICTS = `
  'not_assessed','local','regional','relocation_possible',
  'relocation_support_required','not_willing'
`;
const SALARY_VERDICTS = `'not_assessed','within_range','negotiable','above_range','not_discussed'`;

// §15's Stage-1 outcomes.
const SCREENING_DECISIONS = `
  'proceed','hold','not_suitable_current_role','consider_other_roles',
  'talent_bank','future_opportunity','reject_from_manifest'
`;

// §26's candidate classification.
const CLASSIFICATIONS = `
  'local','regional','national','specialist','fresh_graduate','experienced','future_talent'
`;

// §4/§26 relocation. 'unknown' is the default — never inferred.
const RELOCATION = `
  'unknown','already_local','willing','willing_with_support','needs_information','not_currently','no'
`;

const SUITABILITY = `'strong','potential','not_suitable'`;

export async function up(knex) {
  // ────────────────────────────────────────────────────────────────────────
  // 1. candidates — the master profile gains the fields §4 and §26 ask for
  // ────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE candidates
      -- §4 "Candidate ID". The integer PK is a database key, not something a
      -- recruiter reads out over the phone. Filled by the repository from
      -- seq_cand, the same pattern as employee_code/requisition_number.
      ADD COLUMN IF NOT EXISTS candidate_code              VARCHAR(24),
      ADD COLUMN IF NOT EXISTS photo_url                   TEXT,

      -- §6 column + filter, §22 bulk action, §23 "My Recruitment Work". None of
      -- the three could be answered at all: the module had no concept of a
      -- candidate belonging to a recruiter. FK users, not employees, because the
      -- question is "which LOGIN is accountable" — see the actor note on
      -- candidate_activity below.
      ADD COLUMN IF NOT EXISTS recruiter_id                INTEGER
        REFERENCES users(id) ON DELETE SET NULL,

      -- D-3. When did anything last happen to this candidate. The work queue's
      -- "waiting more than 3 days" is this column, not created_at.
      ADD COLUMN IF NOT EXISTS last_activity_at            TIMESTAMPTZ,

      -- §4's candidate-level state. See the header for why this is not
      -- overall_status.
      ADD COLUMN IF NOT EXISTS disposition                 VARCHAR(30) DEFAULT 'new',

      -- §26 location intelligence. Separate city/state because "candidates in
      -- Tamil Nadu" and "candidates in Madurai" are different questions and one
      -- free-text "location" line can answer neither reliably. (No backticks in
      -- SQL inside a template literal: one closes the literal and the file stops
      -- parsing, which is a boot failure, not a syntax warning.)
      ADD COLUMN IF NOT EXISTS current_city                VARCHAR(120),
      ADD COLUMN IF NOT EXISTS current_state               VARCHAR(120),
      ADD COLUMN IF NOT EXISTS native_place                VARCHAR(160),
      ADD COLUMN IF NOT EXISTS preferred_locations         JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS willing_to_relocate         VARCHAR(30) DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS relocation_support_required BOOLEAN,

      -- §26 "Only store information voluntarily provided by the candidate." One
      -- free-text field the candidate's own words go into, rather than a set of
      -- structured columns about family circumstances that would invite a
      -- recruiter to infer and record things §26 forbids inferring.
      ADD COLUMN IF NOT EXISTS relocation_note             TEXT,
      ADD COLUMN IF NOT EXISTS preferred_work_arrangement  VARCHAR(40),
      ADD COLUMN IF NOT EXISTS expected_joining_location   VARCHAR(160),

      -- §4 distinguishes total from relevant experience. experience_years is the
      -- total and stays that; this is the part that counts for the role.
      ADD COLUMN IF NOT EXISTS relevant_experience_years   NUMERIC(5,1),
      ADD COLUMN IF NOT EXISTS classification              VARCHAR(30)
  `);

  await knex.raw(`
    CREATE SEQUENCE IF NOT EXISTS seq_cand START WITH 1 INCREMENT BY 1 NO CYCLE
  `);

  // Existing candidates get a code, so the column is not half-populated the
  // moment a screen starts displaying it. setval afterwards so the sequence
  // continues from the highest code issued rather than re-issuing them.
  await knex.raw(`
    UPDATE candidates
       SET candidate_code = 'CAND-' || LPAD(id::text, 5, '0')
     WHERE candidate_code IS NULL
  `);
  await knex.raw(`
    SELECT setval('seq_cand', GREATEST((SELECT COALESCE(MAX(id), 0) FROM candidates) + 1, 1), false)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_code_company
      ON candidates (company_id, candidate_code) WHERE candidate_code IS NOT NULL
  `);

  // last_activity_at, backfilled from the best evidence available: the most
  // recent stage move, else the candidate's own updated_at, else created_at.
  // COALESCE order matters — a stage move is a real recruiter action, updated_at
  // can be a column edit.
  await knex.raw(`
    UPDATE candidates c
       SET last_activity_at = COALESCE(
             (SELECT MAX(h.moved_date) FROM candidate_stage_history h WHERE h.candidate_id = c.id),
             c.updated_at,
             c.created_at
           )
     WHERE c.last_activity_at IS NULL
  `);

  // disposition, derived once from where each candidate already sits. A
  // candidate parked in future_use IS a future opportunity; one marked
  // not_suitable is still active as a person (that is the entire point of §35)
  // and so becomes 'active', not a negative state.
  await knex.raw(`
    UPDATE candidates
       SET disposition = CASE
             WHEN current_stage = 'hired'      THEN 'hired'
             WHEN current_stage = 'future_use' THEN 'future_opportunity'
             WHEN current_stage = 'rejected'   THEN 'rejected_from_manifest'
             WHEN current_stage = 'screening'  THEN 'in_screening'
             WHEN current_stage = 'applied'    THEN 'new'
             ELSE 'active'
           END
     WHERE disposition IS NULL OR disposition = 'new'
  `);

  for (const [name, def] of [
    ['candidates_disposition_check',    `disposition IS NULL OR disposition IN (${DISPOSITIONS})`],
    ['candidates_classification_check', `classification IS NULL OR classification IN (${CLASSIFICATIONS})`],
    ['candidates_relocate_check',       `willing_to_relocate IS NULL OR willing_to_relocate IN (${RELOCATION})`],
    ['candidates_preferred_locations_is_array',
      `preferred_locations IS NULL OR jsonb_typeof(preferred_locations) = 'array'`],
    // D-5. Exactly the four values already stored.
    ['candidates_overall_status_check', `overall_status IS NULL OR overall_status IN (${OVERALL_STATUSES})`],
  ]) {
    await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw(`ALTER TABLE candidates ADD CONSTRAINT ${name} CHECK (${def})`);
  }

  // P2 — the three added stage keys, on both tables that carry a stage.
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_current_stage_check`);
  await knex.raw(`
    ALTER TABLE candidates ADD CONSTRAINT candidates_current_stage_check
      CHECK (current_stage IN (${STAGES}))
  `);
  await knex.raw(`ALTER TABLE candidate_applications DROP CONSTRAINT IF EXISTS candidate_applications_stage_check`);
  await knex.raw(`
    ALTER TABLE candidate_applications ADD CONSTRAINT candidate_applications_stage_check
      CHECK (stage IN (${STAGES}))
  `);

  // Indexes for the filters the list screen now offers.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_recruiter
      ON candidates (company_id, recruiter_id) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_disposition
      ON candidates (company_id, disposition) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_last_activity
      ON candidates (company_id, last_activity_at DESC) WHERE deleted_at IS NULL
  `);
  // §6 requires searching by phone. The list's free-text search did not cover it.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates (company_id, phone)
      WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_city
      ON candidates (company_id, LOWER(current_city)) WHERE deleted_at IS NULL
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 2. candidate_applications uniqueness — ALREADY DONE, deliberately left alone
  // ────────────────────────────────────────────────────────────────────────
  // The audit for this change recorded "candidate_applications has no unique
  // constraint on (candidate_id, job_opening_id)" as a High-severity finding, and
  // that finding was WRONG. It came from querying pg_constraint, which does not
  // list a unique INDEX created with CREATE UNIQUE INDEX rather than ALTER TABLE
  // ... ADD CONSTRAINT. Migration 20260917000034 created exactly that:
  //
  //   candidate_applications_unique  UNIQUE (candidate_id, job_opening_id)
  //
  // which is why recommendCandidateForJobs()'s `ON CONFLICT (candidate_id,
  // job_opening_id) DO NOTHING` works at all — that clause needs a matching
  // unique index and would otherwise raise every time it ran.
  //
  // The first draft of this migration added a second index over the same two
  // columns. Two identical unique indexes cost two B-tree writes per insert and
  // buy nothing, so nothing is added here. The note stays because the next person
  // to audit this table with pg_constraint will reach the same wrong conclusion.
  // Check pg_indexes as well.

  // ────────────────────────────────────────────────────────────────────────
  // 3. D-7 — tenant columns on the two child tables that lacked them
  // ────────────────────────────────────────────────────────────────────────
  for (const table of ['candidate_stage_history', 'interview_notes']) {
    await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
    `);
    await knex.raw(`
      UPDATE ${table} t SET company_id = c.company_id
        FROM candidates c WHERE c.id = t.candidate_id AND t.company_id IS NULL
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_${table}_company ON ${table} (company_id, candidate_id)
    `);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4. candidate_notes — §9
  // ────────────────────────────────────────────────────────────────────────
  // `application_id` is nullable and that is the important part: a note about a
  // person ("strong electrical fundamentals, no AHF experience") belongs to the
  // Candidate Master and must still be there when they apply for something else
  // two years later (§9's closing line, §35). A note about one interview for one
  // opening belongs to that application. Both are real; the column distinguishes
  // them instead of forcing every note to be one or the other.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_notes (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      application_id INTEGER REFERENCES candidate_applications(id) ON DELETE SET NULL,

      note_type      VARCHAR(20)  NOT NULL DEFAULT 'recruiter',
      body           TEXT         NOT NULL,
      visibility     VARCHAR(20)  NOT NULL DEFAULT 'internal',
      is_pinned      BOOLEAN      NOT NULL DEFAULT FALSE,

      author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- Set the first time a note is edited. A note whose text has been changed
      -- after the fact is a different kind of evidence from one that has not,
      -- and the reader is entitled to know which they are looking at.
      edited_at      TIMESTAMPTZ,
      edited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,

      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ,

      CONSTRAINT candidate_notes_type_check       CHECK (note_type  IN (${NOTE_TYPES})),
      CONSTRAINT candidate_notes_visibility_check CHECK (visibility IN (${NOTE_VISIBILITIES})),
      -- An empty note is not a note. Cheaper to refuse here than to render a
      -- blank card on the timeline forever.
      CONSTRAINT candidate_notes_body_check       CHECK (LENGTH(TRIM(body)) > 0)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_notes_candidate
      ON candidate_notes (company_id, candidate_id, is_pinned DESC, created_at DESC)
      WHERE deleted_at IS NULL
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 5. candidate_activity — §21, §34
  // ────────────────────────────────────────────────────────────────────────
  // Append-only. There is no UPDATE or DELETE route anywhere in the module for
  // this table, and §34's "immutable to normal users" is enforced by that
  // absence: the only writer is the repository's recordActivity() helper.
  //
  // `event_type` is a free VARCHAR with no CHECK, unlike every other vocabulary
  // in this migration. That is intentional and the reason is the opposite of
  // laziness: a CHECK here would mean that adding an event type to the timeline
  // requires a migration, and the predictable result is that the next feature
  // silently stops recording rather than shipping a migration — which is exactly
  // how this module ended up with no timeline at all. A wrong event_type renders
  // as an unknown row; a missing event is invisible.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_activity (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      application_id INTEGER REFERENCES candidate_applications(id) ON DELETE SET NULL,

      event_type     VARCHAR(40) NOT NULL,
      -- One human-readable line, composed at write time. Composing it at READ
      -- time from detail-jsonb would mean a historical event silently re-words
      -- itself when the code that renders it changes, which defeats the purpose
      -- of an audit trail.
      summary        TEXT        NOT NULL,
      detail         JSONB       NOT NULL DEFAULT '{}'::jsonb,

      actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- Denormalised deliberately: a user row can be deleted (the FK above is ON
      -- DELETE SET NULL) and an audit trail that forgets who did something the
      -- moment they leave is not an audit trail.
      actor_name     VARCHAR(160),

      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_activity_candidate
      ON candidate_activity (company_id, candidate_id, created_at DESC)
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 6. screening_questions / screening_responses — §13
  // ────────────────────────────────────────────────────────────────────────
  // A table rather than a constant array because §13's nine questions are
  // Manifest's questions today, and the next role or the next year will want a
  // tenth. company_id is nullable: a NULL row is a platform default every tenant
  // sees, so the seeded nine exist once rather than once per company.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS screening_questions (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      code        VARCHAR(20)  NOT NULL,
      prompt      TEXT         NOT NULL,
      -- 'text' | 'single_choice'. Q9 (the Durganagar location question) is the
      -- only choice question in the seeded set, and its options are §13's exact
      -- six — which is why options lives here and not in code.
      answer_type VARCHAR(20)  NOT NULL DEFAULT 'text',
      options     JSONB        NOT NULL DEFAULT '[]'::jsonb,
      -- Which competency this question is evidence FOR, so the screening
      -- workspace can show the question next to the rating it informs instead of
      -- making the recruiter hold the mapping in their head.
      competency  VARCHAR(40),
      sort_order  INTEGER      NOT NULL DEFAULT 0,
      is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT screening_questions_answer_type_check
        CHECK (answer_type IN ('text','single_choice')),
      CONSTRAINT screening_questions_options_is_array
        CHECK (jsonb_typeof(options) = 'array')
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_screening_questions_code
      ON screening_questions (COALESCE(company_id, 0), code)
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 7. candidate_screenings — §10 to §15
  // ────────────────────────────────────────────────────────────────────────
  // One screening per application, not per candidate: §3's whole architecture is
  // that a person assessed for Power Electronics and later for Testing has been
  // assessed TWICE, and both assessments matter. application_id is nullable for
  // the speculative case (a résumé-database profile screened before any opening
  // exists), and the unique index below handles both shapes.
  //
  // Scores are STORED, not derived on read. §14's weighting is a business rule
  // that will change, and a screening completed in September must keep the score
  // it was completed with — recomputing it under next year's weights would
  // silently rewrite history. score_breakdown holds the per-section arithmetic so
  // §14's "show the breakdown" needs no recomputation either.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_screenings (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id        INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      application_id      INTEGER REFERENCES candidate_applications(id) ON DELETE CASCADE,

      -- 'draft' while the recruiter is part-way through (§31 wants incremental
      -- saves), 'completed' once an outcome is recorded.
      status              VARCHAR(20) NOT NULL DEFAULT 'draft',

      -- §11 eligibility
      qualification_fit   VARCHAR(20) NOT NULL DEFAULT 'not_assessed',
      experience_fit      VARCHAR(20) NOT NULL DEFAULT 'not_assessed',
      skills_fit          VARCHAR(20) NOT NULL DEFAULT 'not_assessed',
      notice_fit          VARCHAR(20) NOT NULL DEFAULT 'not_assessed',
      location_fit        VARCHAR(40) NOT NULL DEFAULT 'not_assessed',
      salary_fit          VARCHAR(20) NOT NULL DEFAULT 'not_assessed',

      -- §12 competencies, 1-5. NULL means "not yet rated" — distinct from 1,
      -- which is a real and damning rating. A NOT NULL DEFAULT 1 here would have
      -- meant every unfinished screening libelled the candidate.
      learning_mindset          SMALLINT,
      ownership                 SMALLINT,
      teamwork                  SMALLINT,
      patience                  SMALLINT,
      problem_solving           SMALLINT,
      communication             SMALLINT,
      adaptability              SMALLINT,

      -- §12 "For every rating, provide optional evidence/comment."
      learning_mindset_evidence TEXT,
      ownership_evidence        TEXT,
      teamwork_evidence         TEXT,
      patience_evidence         TEXT,
      problem_solving_evidence  TEXT,
      communication_evidence    TEXT,
      adaptability_evidence     TEXT,

      -- §11's two remaining judgements, and §10's I/J.
      relevant_knowledge        SMALLINT,
      career_alignment          SMALLINT,
      role_alignment_note       TEXT,

      -- §14. total_score NULL until enough is filled in to mean anything.
      total_score         SMALLINT,
      score_breakdown     JSONB NOT NULL DEFAULT '{}'::jsonb,

      -- §14 "The score is decision support." recommendation is what the score
      -- suggests; decision is what the human chose; override_reason is required
      -- by the API when they differ. Storing all three is the only way to answer
      -- "did we ever overrule the scorecard, and why" later.
      recommendation      VARCHAR(40),
      decision            VARCHAR(40),
      override_reason     TEXT,
      -- §15 "If Reject from Manifest is selected, require a reason."
      reject_reason       TEXT,
      summary_note        TEXT,

      screened_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT candidate_screenings_status_check CHECK (status IN ('draft','completed')),
      CONSTRAINT candidate_screenings_qual_check   CHECK (qualification_fit IN (${FIT_VERDICTS})),
      CONSTRAINT candidate_screenings_exp_check    CHECK (experience_fit    IN (${FIT_VERDICTS})),
      CONSTRAINT candidate_screenings_skills_check CHECK (skills_fit        IN (${FIT_VERDICTS})),
      CONSTRAINT candidate_screenings_notice_check CHECK (notice_fit        IN (${NOTICE_VERDICTS})),
      CONSTRAINT candidate_screenings_loc_check    CHECK (location_fit      IN (${LOCATION_VERDICTS})),
      CONSTRAINT candidate_screenings_sal_check    CHECK (salary_fit        IN (${SALARY_VERDICTS})),
      CONSTRAINT candidate_screenings_decision_check
        CHECK (decision IS NULL OR decision IN (${SCREENING_DECISIONS})),
      CONSTRAINT candidate_screenings_recommendation_check
        CHECK (recommendation IS NULL OR recommendation IN (${SCREENING_DECISIONS})),
      CONSTRAINT candidate_screenings_score_check
        CHECK (total_score IS NULL OR total_score BETWEEN 0 AND 100),
      -- One CHECK per rating rather than one combined: a combined constraint
      -- reports "candidate_screenings_ratings_check" and leaves the recruiter to
      -- guess which of seven fields was wrong.
      CONSTRAINT candidate_screenings_learning_check   CHECK (learning_mindset   IS NULL OR learning_mindset   BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_ownership_check  CHECK (ownership          IS NULL OR ownership          BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_teamwork_check   CHECK (teamwork           IS NULL OR teamwork           BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_patience_check   CHECK (patience           IS NULL OR patience           BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_problem_check    CHECK (problem_solving    IS NULL OR problem_solving    BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_comms_check      CHECK (communication      IS NULL OR communication      BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_adapt_check      CHECK (adaptability       IS NULL OR adaptability       BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_knowledge_check  CHECK (relevant_knowledge IS NULL OR relevant_knowledge BETWEEN 1 AND 5),
      CONSTRAINT candidate_screenings_career_check     CHECK (career_alignment   IS NULL OR career_alignment   BETWEEN 1 AND 5)
    )
  `);
  // Two partial indexes rather than one UNIQUE(candidate_id, application_id):
  // in Postgres, NULL != NULL, so a plain unique constraint would let a
  // candidate accumulate unlimited speculative screenings.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_screenings_per_application
      ON candidate_screenings (application_id) WHERE application_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_screenings_speculative
      ON candidate_screenings (candidate_id) WHERE application_id IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_screenings_candidate
      ON candidate_screenings (company_id, candidate_id, created_at DESC)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS screening_responses (
      id            SERIAL PRIMARY KEY,
      screening_id  INTEGER NOT NULL REFERENCES candidate_screenings(id) ON DELETE CASCADE,
      question_id   INTEGER NOT NULL REFERENCES screening_questions(id) ON DELETE CASCADE,
      answer_text   TEXT,
      answer_choice VARCHAR(80),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT screening_responses_unique UNIQUE (screening_id, question_id)
    )
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 8. candidate_role_suitability — §16, §27
  // ────────────────────────────────────────────────────────────────────────
  // NOT the same thing as candidate_applications, and the difference is the
  // reason this table has to exist. An application is "being considered for
  // opening #12" and requires an opening to exist. A suitability is "this person
  // suits Testing" and must be recordable when Manifest has no Testing vacancy
  // posted — which is the normal case, and precisely §16's scenario.
  //
  // `job_opening_id` is therefore nullable. When an opening for that department
  // does open, POST .../convert turns the suitability into a real application and
  // stamps `converted_application_id`, so the trail from "we thought of them for
  // this" to "we put them forward" is one row, not two unrelated ones.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_role_suitability (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id   INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,

      department     VARCHAR(120) NOT NULL,
      role_title     VARCHAR(200),
      job_opening_id INTEGER REFERENCES job_openings(id) ON DELETE SET NULL,

      suitability    VARCHAR(20) NOT NULL DEFAULT 'potential',
      -- §16's worked example is a sentence of reasoning, and it is the part a
      -- recruiter reading this in eight months actually needs. Required.
      reason         TEXT,
      notes          TEXT,

      -- Where the judgement came from: the application they were assessed for.
      identified_from_job_id INTEGER REFERENCES job_openings(id) ON DELETE SET NULL,
      identified_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      identified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      status         VARCHAR(20) NOT NULL DEFAULT 'open',
      converted_application_id INTEGER REFERENCES candidate_applications(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT candidate_role_suitability_check  CHECK (suitability IN (${SUITABILITY})),
      CONSTRAINT candidate_role_suitability_status CHECK (status IN ('open','actioned','closed'))
    )
  `);
  // One live judgement per candidate per department. Re-recording the same
  // department is an UPDATE of the existing opinion, not a second opinion —
  // otherwise "Testing: potential" and "Testing: not suitable" coexist and the
  // UI has to pick one arbitrarily.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_role_suitability_unique
      ON candidate_role_suitability (candidate_id, LOWER(department))
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_role_suitability_dept
      ON candidate_role_suitability (company_id, LOWER(department), status)
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 9. candidate_recontact — §18
  // ────────────────────────────────────────────────────────────────────────
  // §18 asks the system to "create a reminder/task for the recruiter". It does
  // NOT get a row in `tasks`: that table requires a project_id and is the
  // project-management work breakdown, so a recruitment reminder there would be
  // an orphan in someone's Gantt chart. `recontact_on` IS the reminder — the work
  // queue reads it, and a cron notifies on the day.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_recontact (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id       INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,

      reason             VARCHAR(60),
      reason_note        TEXT,
      potential_role     VARCHAR(200),
      department         VARCHAR(120),
      preferred_location VARCHAR(160),
      recontact_on       DATE NOT NULL,

      -- Who should be reminded. Defaults to the candidate's recruiter at write
      -- time; nullable so a reminder survives that person leaving.
      owner_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,

      status             VARCHAR(20) NOT NULL DEFAULT 'pending',
      -- Set by the cron so one reminder fires once, not every night until acted on.
      notified_at        TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      completed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      outcome_note       TEXT,

      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT candidate_recontact_status_check
        CHECK (status IN ('pending','done','cancelled'))
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_recontact_due
      ON candidate_recontact (company_id, status, recontact_on)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_recontact_candidate
      ON candidate_recontact (candidate_id, status)
  `);

  // ────────────────────────────────────────────────────────────────────────
  // 10. talent_pool_members — §17 "Allow multiple tags per candidate"
  // ────────────────────────────────────────────────────────────────────────
  // The table had (pool_id, candidate_id, added_at, notes, added_by) and nothing
  // recording WHY a candidate is in a pool or where the decision came from.
  await knex.raw(`
    ALTER TABLE talent_pool_members
      ADD COLUMN IF NOT EXISTS company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS tags         JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS reason       TEXT,
      ADD COLUMN IF NOT EXISTS source_stage VARCHAR(30)
  `);
  await knex.raw(`
    UPDATE talent_pool_members m SET company_id = c.company_id
      FROM candidates c WHERE c.id = m.candidate_id AND m.company_id IS NULL
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members DROP CONSTRAINT IF EXISTS talent_pool_members_tags_is_array
  `);
  await knex.raw(`
    ALTER TABLE talent_pool_members ADD CONSTRAINT talent_pool_members_tags_is_array
      CHECK (tags IS NULL OR jsonb_typeof(tags) = 'array')
  `);

  // §17's categories need a home on the pool itself so the Talent Bank can group
  // by them without parsing pool names.
  await knex.raw(`
    ALTER TABLE talent_pools
      ADD COLUMN IF NOT EXISTS category   VARCHAR(60),
      ADD COLUMN IF NOT EXISTS is_seeded  BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

export async function down(knex) {
  // Dropped in reverse dependency order. The candidates columns are left in
  // place on purpose: they hold recruiter-entered data (relocation preferences,
  // ownership, dispositions) that a rollback of the SCHEMA has no business
  // destroying. Re-running up() is idempotent, so nothing is stranded.
  for (const t of [
    'screening_responses', 'candidate_screenings', 'screening_questions',
    'candidate_recontact', 'candidate_role_suitability',
    'candidate_activity', 'candidate_notes',
  ]) {
    await knex.raw(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
