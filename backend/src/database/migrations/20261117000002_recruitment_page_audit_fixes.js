/**
 * 20261117000002_recruitment_page_audit_fixes.js — RECRUITMENT_MODULE_PAGE_AUDIT_2026-11-17.md.
 *
 * Jobs (B5/B6)
 *   job_openings.number_of_positions / skills_required — the opening form always
 *   collected both, and nothing stored them: positions only existed on a linked
 *   requisition (none were linked, so every job counted as 1) and skills were
 *   squashed into `requirements` with experience and salary text. Backfilled from
 *   the linked requisition where there is one.
 *   job_requisitions.priority — the page used to invent priority from the head
 *   count (3+ = High). It is now entered.
 *
 * Interviews (B2, missing features 2 and 6)
 *   interview_schedules.interview_round / job_opening_id / panel_employee_ids /
 *   question_ids — the round was guessed from the candidate's stage, the
 *   interviewer was free text in `notes`, and ticked questions were thrown away.
 *   interview_notes.interview_id — feedback now belongs to the interview it was
 *   given for, so Candidate Detail can show it per round.
 *
 * Offers (B9, offer letter PDF)
 *   offer_letters.designation / offer_no — the letter needs both. offer_no uses
 *   the existing seq_ofr / nextOfferNumber() (OFR-0001).
 *
 * Agency fees (missing feature 7)
 *   recruitment_agency_fees — one row per hire sourced through an agency.
 *
 * Dead duplicates (D10, D11)
 *   job_offers, onboarding_records, onboarding_tasks — no code reads them; their
 *   5 rows each pointed at candidate ids that do not exist.
 *   recruitment_agencies.contact_name / commission_pct / specialization — old
 *   twins of contact_person / fee_percentage / specializations; nothing reads them.
 *   candidates: candidate_role, l1_outcome, l2_outcome, l1_interviewer_id,
 *   l2_interviewer_id, opening_id, offer_id, agency_id, expected_salary — old
 *   twins (applied_job_id, source_agency_id, expected_ctc, interview_notes) that
 *   nothing reads or writes. No CASCADE: a dependent view would stop this.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  // ── Jobs ──────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE job_openings
    ADD COLUMN IF NOT EXISTS number_of_positions integer,
    ADD COLUMN IF NOT EXISTS skills_required text`);
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_openings_positions_check') THEN
      ALTER TABLE job_openings ADD CONSTRAINT job_openings_positions_check
        CHECK (number_of_positions IS NULL OR number_of_positions BETWEEN 1 AND 9999);
    END IF; END $$`);
  await knex.raw(`UPDATE job_openings jo SET number_of_positions = jr.number_of_positions
                    FROM job_requisitions jr
                   WHERE jr.id = jo.requisition_id AND jo.number_of_positions IS NULL
                     AND jr.number_of_positions BETWEEN 1 AND 9999`);

  await knex.raw(`ALTER TABLE job_requisitions ADD COLUMN IF NOT EXISTS priority varchar(10) NOT NULL DEFAULT 'medium'`);
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_requisitions_priority_check') THEN
      ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_priority_check
        CHECK (priority IN ('low', 'medium', 'high'));
    END IF; END $$`);

  // ── Interviews ────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE interview_schedules
    ADD COLUMN IF NOT EXISTS interview_round varchar(20),
    ADD COLUMN IF NOT EXISTS job_opening_id integer REFERENCES job_openings(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS panel_employee_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS question_ids jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_schedules_round_check') THEN
      ALTER TABLE interview_schedules ADD CONSTRAINT interview_schedules_round_check
        CHECK (interview_round IS NULL OR interview_round IN ('1st_level', '2nd_level', 'technical', 'hr', 'final'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_schedules_panel_is_array') THEN
      ALTER TABLE interview_schedules ADD CONSTRAINT interview_schedules_panel_is_array
        CHECK (jsonb_typeof(panel_employee_ids) = 'array' AND jsonb_typeof(question_ids) = 'array');
    END IF; END $$`);
  // Old rows saved the browser's 'offline'/'online'; the API vocabulary is
  // video / in_person / phone.
  await knex.raw(`UPDATE interview_schedules SET interview_mode = 'in_person' WHERE interview_mode = 'offline'`);
  await knex.raw(`UPDATE interview_schedules SET interview_mode = 'video' WHERE interview_mode = 'online'`);

  await knex.raw(`ALTER TABLE interview_notes
    ADD COLUMN IF NOT EXISTS interview_id uuid REFERENCES interview_schedules(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS interview_notes_interview_idx ON interview_notes (interview_id)`);

  // ── Offers ────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE offer_letters
    ADD COLUMN IF NOT EXISTS designation varchar(200),
    ADD COLUMN IF NOT EXISTS offer_no varchar(20)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS offer_letters_offer_no_uniq
                    ON offer_letters (company_id, offer_no) WHERE offer_no IS NOT NULL`);

  // ── Agency fees ───────────────────────────────────────────────────────────
  await knex.raw(`CREATE TABLE IF NOT EXISTS recruitment_agency_fees (
    id             serial PRIMARY KEY,
    company_id     integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agency_id      integer REFERENCES recruitment_agencies(id) ON DELETE SET NULL,
    candidate_id   integer REFERENCES candidates(id) ON DELETE SET NULL,
    employee_id    integer REFERENCES employees(id) ON DELETE SET NULL,
    offer_id       uuid REFERENCES offer_letters(id) ON DELETE SET NULL,
    annual_ctc     numeric(14,2),
    fee_percentage numeric(6,2),
    fee_amount     numeric(14,2),
    status         varchar(12) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'invoiced', 'paid', 'waived')),
    invoice_no     varchar(60),
    paid_on        date,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
  )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS recruitment_agency_fees_candidate_uniq
                    ON recruitment_agency_fees (company_id, candidate_id) WHERE candidate_id IS NOT NULL`);

  // ── Dead duplicates ───────────────────────────────────────────────────────
  await knex.raw(`DROP TABLE IF EXISTS onboarding_tasks`);
  await knex.raw(`DROP TABLE IF EXISTS onboarding_records`);
  await knex.raw(`DROP TABLE IF EXISTS job_offers`);
  await knex.raw(`ALTER TABLE recruitment_agencies
    DROP COLUMN IF EXISTS contact_name,
    DROP COLUMN IF EXISTS commission_pct,
    DROP COLUMN IF EXISTS specialization`);
  await knex.raw(`ALTER TABLE candidates
    DROP COLUMN IF EXISTS candidate_role,
    DROP COLUMN IF EXISTS l1_outcome,
    DROP COLUMN IF EXISTS l2_outcome,
    DROP COLUMN IF EXISTS l1_interviewer_id,
    DROP COLUMN IF EXISTS l2_interviewer_id,
    DROP COLUMN IF EXISTS opening_id,
    DROP COLUMN IF EXISTS offer_id,
    DROP COLUMN IF EXISTS agency_id,
    DROP COLUMN IF EXISTS expected_salary`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS candidate_role varchar(255),
    ADD COLUMN IF NOT EXISTS l1_outcome varchar(50),
    ADD COLUMN IF NOT EXISTS l2_outcome varchar(50),
    ADD COLUMN IF NOT EXISTS l1_interviewer_id integer,
    ADD COLUMN IF NOT EXISTS l2_interviewer_id integer,
    ADD COLUMN IF NOT EXISTS opening_id integer,
    ADD COLUMN IF NOT EXISTS offer_id integer,
    ADD COLUMN IF NOT EXISTS agency_id integer,
    ADD COLUMN IF NOT EXISTS expected_salary numeric`);
  await knex.raw(`ALTER TABLE recruitment_agencies
    ADD COLUMN IF NOT EXISTS contact_name varchar(255),
    ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2),
    ADD COLUMN IF NOT EXISTS specialization varchar(255)`);
  // job_offers / onboarding_records / onboarding_tasks are not recreated: they
  // held no live data and nothing reads them.
  await knex.raw(`DROP TABLE IF EXISTS recruitment_agency_fees`);
  await knex.raw(`DROP INDEX IF EXISTS offer_letters_offer_no_uniq`);
  await knex.raw(`ALTER TABLE offer_letters DROP COLUMN IF EXISTS offer_no, DROP COLUMN IF EXISTS designation`);
  await knex.raw(`DROP INDEX IF EXISTS interview_notes_interview_idx`);
  await knex.raw(`ALTER TABLE interview_notes DROP COLUMN IF EXISTS interview_id`);
  await knex.raw(`ALTER TABLE interview_schedules
    DROP CONSTRAINT IF EXISTS interview_schedules_round_check,
    DROP CONSTRAINT IF EXISTS interview_schedules_panel_is_array,
    DROP COLUMN IF EXISTS question_ids,
    DROP COLUMN IF EXISTS panel_employee_ids,
    DROP COLUMN IF EXISTS job_opening_id,
    DROP COLUMN IF EXISTS interview_round`);
  await knex.raw(`ALTER TABLE job_requisitions DROP CONSTRAINT IF EXISTS job_requisitions_priority_check, DROP COLUMN IF EXISTS priority`);
  await knex.raw(`ALTER TABLE job_openings DROP CONSTRAINT IF EXISTS job_openings_positions_check,
    DROP COLUMN IF EXISTS skills_required, DROP COLUMN IF EXISTS number_of_positions`);
}
