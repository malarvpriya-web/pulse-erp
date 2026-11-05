/**
 * Request schemas for the candidate-intelligence endpoints.
 *
 * Same shape and same reasons as recruitment.schemas.js: reject input the
 * database would accept but the application should not, and name the field when
 * a type is wrong instead of letting pgErrors return a generic 400.
 *
 * The enums here mirror the migration's CHECK constraints. Duplicating a
 * vocabulary is a drift risk and the alternative was worse: reading the constraint
 * definitions out of pg_constraint at boot would make request validation depend on
 * a live database round trip. The migration stays the authority — it rejects
 * anything that slips past this layer — and this layer exists to produce a sentence
 * a recruiter can act on rather than a constraint name.
 *
 * The STAGE list is the exception and is IMPORTED rather than declared. It was a
 * local copy, and that is exactly how the module came to accept the three new
 * stages on the bulk path while rejecting them with a 400 on the single-candidate
 * path — the two copies had drifted within a day of each other. Where a vocabulary
 * is already exported from recruitment.schemas.js, import it.
 */

// The one stage vocabulary for the whole module.
import { CANDIDATE_STAGES as STAGES } from './recruitment.schemas.js';

const NOTE_TYPES = ['recruiter', 'screening', 'interview', 'technical', 'management', 'followup', 'general'];
const VISIBILITIES = ['internal', 'private', 'shared'];
const FIT = ['not_assessed', 'meets', 'partial', 'does_not_meet'];
const NOTICE_FIT = ['not_assessed', 'acceptable', 'needs_discussion', 'not_acceptable'];
const LOCATION_FIT = [
  'not_assessed', 'local', 'regional', 'relocation_possible',
  'relocation_support_required', 'not_willing',
];
const SALARY_FIT = ['not_assessed', 'within_range', 'negotiable', 'above_range', 'not_discussed'];
const DECISIONS = [
  'proceed', 'hold', 'not_suitable_current_role', 'consider_other_roles',
  'talent_bank', 'future_opportunity', 'reject_from_manifest',
];
const SUITABILITY = ['strong', 'potential', 'not_suitable'];
const DISPOSITIONS = [
  'new', 'active', 'in_screening', 'talent_bank', 'future_opportunity',
  'hired', 'inactive', 'blacklisted', 'rejected_from_manifest',
];

export const noteSchema = {
  // 4000 rather than unbounded: the column is TEXT, but a note is a note. A
  // pasted résumé belongs in the résumé field, and an unbounded body is how a
  // timeline becomes unrenderable.
  body:           { type: 'string', required: true, min: 1, max: 4000, label: 'Note' },
  note_type:      { type: 'enum', values: NOTE_TYPES },
  visibility:     { type: 'enum', values: VISIBILITIES },
  is_pinned:      { type: 'bool' },
  application_id: { type: 'int', min: 1 },
};

export const screeningSaveSchema = {
  application_id:    { type: 'int', min: 1 },
  qualification_fit: { type: 'enum', values: FIT },
  experience_fit:    { type: 'enum', values: FIT },
  skills_fit:        { type: 'enum', values: FIT },
  notice_fit:        { type: 'enum', values: NOTICE_FIT },
  location_fit:      { type: 'enum', values: LOCATION_FIT },
  salary_fit:        { type: 'enum', values: SALARY_FIT },

  // §12's scale is 1-5 and the bounds are enforced here as well as in the
  // database, because "Learning mindset must be between 1 and 5" is a usable
  // message and "candidate_screenings_learning_check" is not.
  learning_mindset:   { type: 'int', min: 1, max: 5, label: 'Learning mindset' },
  ownership:          { type: 'int', min: 1, max: 5 },
  teamwork:           { type: 'int', min: 1, max: 5 },
  patience:           { type: 'int', min: 1, max: 5, label: 'Patience / perseverance' },
  problem_solving:    { type: 'int', min: 1, max: 5, label: 'Problem solving' },
  communication:      { type: 'int', min: 1, max: 5 },
  adaptability:       { type: 'int', min: 1, max: 5 },
  relevant_knowledge: { type: 'int', min: 1, max: 5, label: 'Relevant knowledge' },
  career_alignment:   { type: 'int', min: 1, max: 5, label: 'Career alignment' },

  learning_mindset_evidence: { type: 'string', max: 2000 },
  ownership_evidence:        { type: 'string', max: 2000 },
  teamwork_evidence:         { type: 'string', max: 2000 },
  patience_evidence:         { type: 'string', max: 2000 },
  problem_solving_evidence:  { type: 'string', max: 2000 },
  communication_evidence:    { type: 'string', max: 2000 },
  adaptability_evidence:     { type: 'string', max: 2000 },
  role_alignment_note:       { type: 'string', max: 2000 },
  summary_note:              { type: 'string', max: 4000 },

  responses: { type: 'array' },

  // Field names to set back to NULL. §12's ratings are optional and NULL means
  // "not yet rated", so un-rating has to be expressible — a COALESCE-based upsert
  // cannot say it with a value alone. The repository checks each name against its
  // own column allowlist before using it.
  clear: { type: 'array' },
};

export const screeningDecisionSchema = {
  decision:        { type: 'enum', values: DECISIONS, required: true, label: 'Decision' },
  override_reason: { type: 'string', max: 2000 },
  reject_reason:   { type: 'string', max: 2000 },
  summary_note:    { type: 'string', max: 4000 },

  suitable_departments: { type: 'array' },
  pool_ids:             { type: 'array' },
  tags:                 { type: 'array' },

  // Only read for decision = 'future_opportunity'; the route enforces that a
  // date is present in that case, which a per-field `required` cannot express.
  recontact_on:       { type: 'date' },
  recontact_reason:   { type: 'string', max: 60 },
  potential_role:     { type: 'string', max: 200 },
  department:         { type: 'string', max: 120 },
  preferred_location: { type: 'string', max: 160 },
};

export const suitabilitySchema = {
  departments: { type: 'array', required: true, label: 'Departments' },
  reason:      { type: 'string', max: 2000 },
  identified_from_job_id: { type: 'int', min: 1 },
};

export const suitabilityEntrySchema = {
  department:  { type: 'string', required: true, max: 120, label: 'Department' },
  role_title:  { type: 'string', max: 200 },
  suitability: { type: 'enum', values: SUITABILITY },
  reason:      { type: 'string', max: 2000 },
  notes:       { type: 'string', max: 2000 },
};

export const recontactSchema = {
  recontact_on:       { type: 'date', required: true, label: 'Recontact date' },
  reason:             { type: 'string', max: 60 },
  reason_note:        { type: 'string', max: 2000 },
  potential_role:     { type: 'string', max: 200 },
  department:         { type: 'string', max: 120 },
  preferred_location: { type: 'string', max: 160 },
  owner_user_id:      { type: 'int', min: 1 },
};

export const recontactCompleteSchema = {
  status:       { type: 'enum', values: ['done', 'cancelled'] },
  outcome_note: { type: 'string', max: 2000 },
  reengage:     { type: 'bool' },
};

export const talentBankSchema = {
  pool_ids: { type: 'array', required: true, label: 'Talent pools' },
  tags:     { type: 'array' },
  reason:   { type: 'string', max: 2000 },
};

export const bulkSchema = {
  candidate_ids: { type: 'array', required: true, label: 'Candidates' },
  action: {
    type: 'enum', required: true, label: 'Action',
    values: ['stage', 'disposition', 'recruiter', 'add_tag', 'remove_tag', 'talent_bank'],
  },
  // Not typed: `value` is a stage key for one action, an integer for another and
  // an array of pool ids for a third. The route validates it against the chosen
  // action, which is the only place the two are known together.
};

export const BULK_VALUE_RULES = {
  stage:       { type: 'enum', values: STAGES },
  disposition: { type: 'enum', values: DISPOSITIONS },
  recruiter:   { type: 'int', min: 1, nullable: true },
  add_tag:     { type: 'string', max: 60 },
  remove_tag:  { type: 'string', max: 60 },
  talent_bank: { type: 'array' },
};

export const candidateProfileSchema = {
  photo_url:                   { type: 'string', max: 500 },
  recruiter_id:                { type: 'int', min: 1 },
  disposition:                 { type: 'enum', values: DISPOSITIONS },
  classification: {
    type: 'enum',
    values: ['local', 'regional', 'national', 'specialist', 'fresh_graduate', 'experienced', 'future_talent'],
  },
  current_city:                { type: 'string', max: 120 },
  current_state:               { type: 'string', max: 120 },
  native_place:                { type: 'string', max: 160 },
  preferred_locations:         { type: 'array' },
  willing_to_relocate: {
    type: 'enum',
    values: ['unknown', 'already_local', 'willing', 'willing_with_support', 'needs_information', 'not_currently', 'no'],
  },
  relocation_support_required: { type: 'bool' },
  relocation_note:             { type: 'string', max: 2000 },
  preferred_work_arrangement:  { type: 'string', max: 40 },
  expected_joining_location:   { type: 'string', max: 160 },
  relevant_experience_years:   { type: 'number', min: 0, max: 60 },
};

export const VOCABULARIES = {
  NOTE_TYPES, VISIBILITIES, FIT, NOTICE_FIT, LOCATION_FIT, SALARY_FIT,
  DECISIONS, SUITABILITY, DISPOSITIONS, STAGES,
};
