/**
 * Request schemas for recruitment.routes.js — see shared/requestSchema.js for the
 * validator and why it is dependency-free.
 *
 * Two rules were followed when writing these, both aimed at not breaking input that
 * works today:
 *
 *  - `max` on a string mirrors the live column width taken from information_schema,
 *    not from a migration file (migrations in this repo have drifted from the live
 *    schema more than once). Over-tightening here would reject rows Postgres accepts.
 *  - A field is only an `enum` where the vocabulary was actually verified — against
 *    the DB CHECK constraint (candidates.current_stage, interview_notes.recommendation)
 *    or against the frontend's canonical constants.js, which is the de-facto authority
 *    for the status columns Postgres left as bare varchars. Free-text columns like
 *    `employment_type` and `experience_required` stay length-checked strings, because
 *    no verified vocabulary exists for them and inventing one would reject valid input.
 *
 * `required` is only set where every existing UI path already sends the field, so
 * turning it on changes a 500 into a 400 rather than rejecting a working request.
 */

/* ── Verified vocabularies ─────────────────────────────────────────────────── */

// candidates_current_stage_check, read from pg_constraint (live DB).
export const CANDIDATE_STAGES = [
  'applied', 'screening', '1st_level', '2nd_level', 'offer',
  'hired', 'not_suitable', 'maybe', 'future_use', 'rejected',
];

// interview_notes_recommendation_check. Covers both vocabularies in use: the
// CandidateDetail form writes strong_hire/hire/hold/reject, submit-feedback writes
// hire/reject. See migration 20260812000005.
export const INTERVIEW_RECOMMENDATIONS = ['strong_hire', 'hire', 'hold', 'reject'];

// The status columns below are bare varchars in Postgres with no CHECK, so these
// lists are the only thing standing between a typo and a permanently unrenderable
// badge. Mirrors frontend/src/features/recruitment/shared/constants.js.
export const REQUISITION_STATUSES = ['draft', 'pending_approval', 'approved', 'open', 'closed'];
export const OPENING_STATUSES     = ['draft', 'pending_approval', 'open', 'on_hold', 'closed', 'cancelled'];
export const OFFER_STATUSES       = ['draft', 'pending_approval', 'sent', 'accepted', 'declined', 'withdrawn'];
export const CANDIDATE_STATUSES   = ['active', 'hired', 'rejected', 'withdrawn'];
export const CANDIDATE_SOURCES    = [
  'manual', 'website', 'linkedin', 'referral', 'job_portal',
  'campus', 'agency', 'walk_in', 'resume_db',
];
export const INTERVIEW_MODES    = ['video', 'in_person', 'phone'];
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled'];

/* ── Requisitions ──────────────────────────────────────────────────────────── */

export const requisitionSchema = {
  job_title:           { type: 'string', required: true, max: 200 },
  department:          { type: 'string', max: 100 },
  employment_type:     { type: 'string', max: 50 },
  number_of_positions: { type: 'int', min: 1, max: 9999 },
  job_description:     { type: 'string' },
  skills_required:     { type: 'string' },
  experience_required: { type: 'string', max: 100 },
  location:            { type: 'string', max: 200 },
  salary_range:        { type: 'string', max: 100 },
  requested_by:        { type: 'int', min: 1 },
  // 'approved' stays in the list on purpose. The route's own guard rejects it with a
  // specific message ("must be approved through the Approval Center"); excluding it
  // here would pre-empt that with a vaguer enum error.
  status:              { type: 'enum', values: REQUISITION_STATUSES },
};

/* ── Job openings ──────────────────────────────────────────────────────────── */

export const openingSchema = {
  requisition_id:  { type: 'int', min: 1 },
  job_title:       { type: 'string', required: true, max: 200 },
  department:      { type: 'string', max: 100 },
  location:        { type: 'string', max: 200 },
  employment_type: { type: 'string', max: 50 },
  experience_min:  { type: 'int', min: 0, max: 60, label: 'Minimum experience' },
  experience_max:  { type: 'int', min: 0, max: 60, label: 'Maximum experience' },
  salary_min:      { type: 'number', min: 0, label: 'Minimum salary' },
  salary_max:      { type: 'number', min: 0, label: 'Maximum salary' },
  description:     { type: 'string' },
  requirements:    { type: 'string' },
  benefits:        { type: 'string' },
  status:          { type: 'enum', values: OPENING_STATUSES },
  posted_date:     { type: 'date' },
  closing_date:    { type: 'date' },
};

/* ── Candidates ────────────────────────────────────────────────────────────── */

export const candidateSchema = {
  full_name:           { type: 'string', required: true, max: 255 },
  // Nullable in the schema, so not required — but when supplied it feeds the
  // duplicate guard and candidates_company_email_uniq, and a malformed address
  // silently breaks every triggerEmail() sent to this candidate.
  email:               { type: 'email', max: 255 },
  phone:               { type: 'string', max: 30 },
  source:              { type: 'enum', values: CANDIDATE_SOURCES },
  applied_job_id:      { type: 'int', min: 1, label: 'Job opening' },
  source_agency_id:    { type: 'int', min: 1, label: 'Agency' },
  current_company:     { type: 'string', max: 200 },
  current_designation: { type: 'string', max: 255 },
  experience_years:    { type: 'number', min: 0, max: 60 },
  notice_period_days:  { type: 'int', min: 0, max: 365 },
  expected_ctc:        { type: 'number', min: 0, label: 'Expected CTC' },
  skills:              { type: 'array' },
  notes:               { type: 'string' },
  current_stage:       { type: 'enum', values: CANDIDATE_STAGES, label: 'Stage' },
  overall_status:      { type: 'enum', values: CANDIDATE_STATUSES, label: 'Status' },
};

export const moveStageSchema = {
  new_stage: { type: 'enum', values: CANDIDATE_STAGES, required: true, label: 'Stage' },
  moved_by:  { type: 'int', min: 1 },
  notes:     { type: 'string' },
};

/* ── Interviews ────────────────────────────────────────────────────────────── */

export const interviewSchema = {
  candidate_id:   { type: 'int', min: 1, required: true },
  interview_date: { type: 'date', required: true },
  interview_time: { type: 'time' },
  interview_mode: { type: 'enum', values: INTERVIEW_MODES, label: 'Mode' },
  meeting_link:   { type: 'string', max: 500 },
  interviewer_id: { type: 'int', min: 1 },
  status:         { type: 'enum', values: INTERVIEW_STATUSES },
  notes:          { type: 'string' },
};

// PUT /interviews/:id is used for cancel ({status:'cancelled'}) and reschedule, so
// candidate_id/interview_date are not required on the update path — validatePatch()
// drops `required` for exactly this reason.

export const interviewNoteSchema = {
  candidate_id:     { type: 'int', min: 1, required: true },
  interviewer_id:   { type: 'int', min: 1 },
  interview_round:  { type: 'string', max: 100 },
  rating:           { type: 'number', min: 1, max: 5 },
  comments:         { type: 'string' },
  recommendation:   { type: 'enum', values: INTERVIEW_RECOMMENDATIONS },
};

export const submitFeedbackSchema = {
  outcome:          { type: 'enum', values: ['selected', 'rejected'], required: true },
  rejection_reason: { type: 'string' },
  rating:           { type: 'number', min: 1, max: 5 },
  comments:         { type: 'string' },
};

/* ── Offers ────────────────────────────────────────────────────────────────── */

export const offerSchema = {
  candidate_id:      { type: 'int', min: 1, required: true },
  job_opening_id:    { type: 'int', min: 1 },
  offered_salary:    { type: 'number', min: 0 },
  joining_date:      { type: 'date' },
  // Per-offer override of the company-wide offer_validity_days setting
  // (company_settings module='recruitment'). Added with the column in
  // migration 20260813000001.
  offer_expiry_date: { type: 'date', label: 'Offer expiry date' },
  offer_status:      { type: 'enum', values: OFFER_STATUSES, label: 'Status' },
  notes:             { type: 'string' },
};

/* ── Email templates ───────────────────────────────────────────────────────── */

// Column notes from information_schema: template_name and subject are `text`
// (no width), template_type is varchar(100). The write path is
// createEmailTemplate(), which mirrors template_name/template_type into the
// name/category/stage_trigger columns triggerEmail() actually matches on — so a
// blank template_type produces a template that can never fire, which is why it
// is required here rather than merely length-checked.
export const emailTemplateSchema = {
  template_name:  { type: 'string', required: true, label: 'Template name' },
  template_type:  { type: 'string', required: true, max: 100, label: 'Trigger' },
  subject:        { type: 'string' },
  body_html:      { type: 'string', label: 'Body' },
  is_active:      { type: 'bool' },
  // variables_json is deliberately unlisted: it is a jsonb column whose shape was
  // not verified against a caller, and guessing between array-of-strings and
  // object-map would risk rejecting whatever the UI actually sends.
};
