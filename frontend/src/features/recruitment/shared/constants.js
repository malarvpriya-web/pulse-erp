/* ============================================================================
 * RECRUITMENT — CANONICAL FRONTEND ENUMS
 * ============================================================================
 * Single source of truth for every stage / status / source vocabulary in the
 * module. Before this, the 10-value pipeline-stage enum existed as FOUR
 * independent hand-maintained copies (AllCandidates, CandidatePipeline,
 * ResumeDatabase, plus this file) and the candidate-source list as two that had
 * already drifted apart — RecruiterDashboard could colour a `walk_in` source
 * that no form could produce, while `campus`/`agency` had no colour at all.
 *
 * The stage keys here MUST stay in sync with the DB: `candidates_current_stage_check`
 * (baseline.sql) is the authority and will reject anything not in this list.
 * ========================================================================== */

/* ── Pipeline stages ────────────────────────────────────────────────────── */

/**
 * Display labels. Keys === candidates.current_stage values.
 *
 * ── THE KEYS ARE THE DATABASE, THE LABELS ARE THE BRIEF ─────────────────────
 * The 2026-09-27 redesign relabelled five of these and added three new keys.
 * Only `shortlisted`, `assessment` and `selected` are new VALUES (migration
 * 20260927000001 widened the CHECK on both candidates.current_stage and
 * candidate_applications.stage to accept them). Everything else is a label
 * change over an unchanged key — which is why nothing had to be migrated and why
 * the hire automation, which matches on the literal string 'hired', is
 * unaffected by "Hired" becoming "Joined".
 *
 * The four parked stages are relabelled to the brief's own words because the old
 * ones were the problem it names: "Rejected" and "Not Suitable" read as the same
 * verdict, and §2 requires that being wrong for one role is visibly NOT being
 * rejected by Manifest.
 */
export const STAGE_LABELS = {
  applied:      'Applied',
  screening:    'Screening',
  shortlisted:  'Shortlisted',
  assessment:   'Technical Assessment',
  '1st_level':  'Interview',
  '2nd_level':  'Final Interview',
  offer:        'Offer',
  selected:     'Selected',
  hired:        'Joined',
  not_suitable: 'Not Suitable for Current Role',
  maybe:        'Hold / Review',
  future_use:   'Future Opportunity',
  rejected:     'Rejected from Manifest',
};

/**
 * Short labels, for places where the full sentence will not fit — a Kanban
 * column head, a table badge, a chip in a drawer.
 *
 * A separate map rather than truncating STAGE_LABELS at render time: "Not
 * Suitable for Current Role" truncated to a column width reads "Not Suitable
 * for…", which is the exact ambiguity the long label exists to remove.
 */
export const STAGE_LABELS_SHORT = {
  ...STAGE_LABELS,
  assessment:   'Assessment',
  not_suitable: 'Not Suitable (Role)',
  future_use:   'Future Opp.',
  rejected:     'Rejected',
};

// Stages a candidate actively progresses through — the Kanban columns, in the
// order §7 lists them.
export const ACTIVE_STAGES = [
  'applied', 'screening', 'shortlisted', 'assessment',
  '1st_level', '2nd_level', 'offer', 'selected', 'hired',
];

// Parked stages, shown separately from the main flow. NOT "dead end": three of
// the four are explicitly recoverable states, which is the whole point of §2.
// The name is kept for the call sites that already import it.
export const DEADEND_STAGES = ['maybe', 'future_use', 'not_suitable', 'rejected'];

export const ALL_STAGES = [...ACTIVE_STAGES, ...DEADEND_STAGES];

/** Stages that mean "still in play" — the work queue's and the list's default. */
export const LIVE_STAGES = ACTIVE_STAGES.filter(s => s !== 'hired');

/**
 * Canonical stage colours. Previously five files each defined their own palette
 * with genuinely different hex values for the same stage, so one candidate
 * appeared in three different colours depending on the page. One palette now.
 */
export const STAGE_COLORS = {
  applied:      { bg: '#E6F1FB', color: '#2563EB' },
  screening:    { bg: '#F5F3FF', color: '#6C47FF' },
  shortlisted:  { bg: '#EFEAFD', color: '#5B34D6' },
  assessment:   { bg: '#FAEEDA', color: '#92610A' },
  '1st_level':  { bg: '#E0E7FF', color: '#4338CA' },
  '2nd_level':  { bg: '#FFF3E0', color: '#9A5B0A' },
  offer:        { bg: '#F0FDF4', color: '#059669' },
  selected:     { bg: '#DCFCE7', color: '#15803D' },
  hired:        { bg: '#E8FBF0', color: '#047857' },
  // The four parked stages are deliberately NOT all red. 'future_use' and
  // 'maybe' are recoverable states and colouring them like a rejection is how a
  // recruiter comes to treat them as one — the visual equivalent of the label
  // problem §2 is about. Only 'rejected' is red; 'not_suitable' is amber,
  // because it is a verdict about a ROLE, not about the person.
  maybe:        { bg: '#F1F5F9', color: '#475569' },
  future_use:   { bg: '#ECFEFF', color: '#0E7490' },
  not_suitable: { bg: '#FEF3C7', color: '#92400E' },
  rejected:     { bg: '#FEF2F2', color: '#B91C1C' },
};

export const stageLabel = (key) => STAGE_LABELS[key] || key || '—';
export const stageLabelShort = (key) => STAGE_LABELS_SHORT[key] || STAGE_LABELS[key] || key || '—';
export const stageColor = (key) => STAGE_COLORS[key] || STAGE_COLORS.maybe;

/** Kanban column descriptors — `[{ key, title, bg, color }]`. */
export const stageColumns = (keys = ACTIVE_STAGES) =>
  keys.map(key => ({ key, title: STAGE_LABELS[key], ...STAGE_COLORS[key] }));

/** `<select>` options, with a leading "All" entry for filter bars. */
export const stageOptions = ({ includeAll = true, keys = ALL_STAGES } = {}) => [
  ...(includeAll ? [{ value: 'all', label: 'All Stages' }] : []),
  ...keys.map(value => ({ value, label: STAGE_LABELS[value] })),
];

/* ── Candidate overall status ───────────────────────────────────────────── */

export const STATUS_LABELS = {
  active:    'Active',
  hired:     'Hired',
  rejected:  'Rejected',
  withdrawn: 'Withdrawn',
};

export const STATUS_COLORS = {
  active:    { bg: '#dbeafe', color: '#1d4ed8' },
  hired:     { bg: '#dcfce7', color: '#15803d' },
  rejected:  { bg: '#fee2e2', color: '#dc2626' },
  withdrawn: { bg: '#f3f4f6', color: '#6b7280' },
};

export const statusOptions = ({ includeAll = true } = {}) => [
  ...(includeAll ? [{ value: 'all', label: 'All Status' }] : []),
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

/* -- Candidate DISPOSITION: what this person is to Manifest (S4) ----------- */
/**
 * Distinct from `overall_status`, and the distinction is the point.
 *
 * `overall_status` (above) answers "is this APPLICATION still live?" --
 * active/hired/rejected/withdrawn. `disposition` answers "what is this PERSON to
 * Manifest?" They are different questions and the brief's S3 architecture
 * separates them: a candidate can be `not_suitable` for the Power Electronics
 * application while their disposition is still `active`, which is exactly the
 * outcome S2 requires the system to be able to express.
 *
 * S4: "DO NOT use 'Rejected' as the only possible negative state." There are
 * four non-positive states here and only one of them is a rejection.
 */
export const DISPOSITION_LABELS = {
  new:                    'New',
  active:                 'Active',
  in_screening:           'In Screening',
  talent_bank:            'Talent Bank',
  future_opportunity:     'Future Opportunity',
  hired:                  'Hired',
  inactive:               'Inactive',
  blacklisted:            'Blacklisted',
  rejected_from_manifest: 'Rejected from Manifest',
};

export const DISPOSITION_COLORS = {
  new:                    { bg: '#E6F1FB', color: '#2563EB' },
  active:                 { bg: '#EFEAFD', color: '#4B2DCE' },
  in_screening:           { bg: '#F5F3FF', color: '#6C47FF' },
  // Talent Bank and Future Opportunity read as POSITIVE, retained states. They
  // are the two the brief cares most about not looking like failures.
  talent_bank:            { bg: '#ECFDF5', color: '#047857' },
  future_opportunity:     { bg: '#ECFEFF', color: '#0E7490' },
  hired:                  { bg: '#E8FBF0', color: '#047857' },
  inactive:               { bg: '#F1F5F9', color: '#475569' },
  blacklisted:            { bg: '#1F2937', color: '#F9FAFB' },
  rejected_from_manifest: { bg: '#FEF2F2', color: '#B91C1C' },
};

export const dispositionLabel = (d) => DISPOSITION_LABELS[d] || d || '—';
export const dispositionColor = (d) => DISPOSITION_COLORS[d] || DISPOSITION_COLORS.new;

/** Dispositions a recruiter may set by hand. 'hired' is set by the hire flow. */
export const SELECTABLE_DISPOSITIONS = [
  'new', 'active', 'in_screening', 'talent_bank', 'future_opportunity',
  'inactive', 'blacklisted', 'rejected_from_manifest',
];

export const dispositionOptions = ({ includeAll = true } = {}) => [
  ...(includeAll ? [{ value: 'all', label: 'Any candidate status' }] : []),
  ...SELECTABLE_DISPOSITIONS.map(value => ({ value, label: DISPOSITION_LABELS[value] })),
];

/** Dispositions that mean the person has been deliberately kept (S17, S18). */
export const RETAINED_DISPOSITIONS = ['talent_bank', 'future_opportunity'];

/* -- Candidate classification (S4, S26) ----------------------------------- */

export const CLASSIFICATION_LABELS = {
  local:          'Local Talent',
  regional:       'Regional Talent',
  national:       'National Talent',
  specialist:     'Specialist Talent',
  fresh_graduate: 'Fresh Graduate',
  experienced:    'Experienced',
  future_talent:  'Future Talent',
};
export const classificationOptions = ({ includeAll = true } = {}) => [
  ...(includeAll ? [{ value: 'all', label: 'Any classification' }] : []),
  ...Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => ({ value, label })),
];

/* -- Relocation (S26) ----------------------------------------------------- */
/**
 * The same six answers S13's Q9 offers, plus 'unknown'.
 *
 * ONE vocabulary for the screening question and the profile field, because the
 * screening endpoint writes Q9's answer straight onto
 * candidates.willing_to_relocate. Two lists would let the answer and the field
 * disagree about the same fact.
 *
 * 'unknown' is the default and is never inferred. S26: "Do not infer
 * personal/family circumstances. Only store information voluntarily provided."
 */
export const RELOCATION_LABELS = {
  unknown:              'Not discussed',
  already_local:        'Already lives nearby',
  willing:              'Can relocate',
  willing_with_support: 'Can relocate, with support',
  needs_information:    'Possibly — needs more information',
  not_currently:        'Not currently',
  no:                   'No',
};
export const RELOCATION_COLORS = {
  already_local:        { bg: '#E8FBF0', color: '#047857' },
  willing:              { bg: '#ECFDF5', color: '#059669' },
  willing_with_support: { bg: '#FEF3C7', color: '#92400E' },
  needs_information:    { bg: '#F1F5F9', color: '#475569' },
  not_currently:        { bg: '#FEF2F2', color: '#B91C1C' },
  no:                   { bg: '#FEF2F2', color: '#B91C1C' },
  unknown:              { bg: '#F3F4F6', color: '#6B7280' },
};
export const relocationLabel = (r) => RELOCATION_LABELS[r] || RELOCATION_LABELS.unknown;
export const relocationColor = (r) => RELOCATION_COLORS[r] || RELOCATION_COLORS.unknown;
export const relocationOptions = () =>
  Object.entries(RELOCATION_LABELS).map(([value, label]) => ({ value, label }));

/** The three answers that mean "they can be at the Srivilliputtur site". */
export const RELOCATION_WILLING = ['already_local', 'willing', 'willing_with_support'];

/* -- Notes (S9) ----------------------------------------------------------- */

export const NOTE_TYPE_LABELS = {
  recruiter:  'Recruiter Note',
  screening:  'Screening Note',
  interview:  'Interview Note',
  technical:  'Technical Note',
  management: 'Management Note',
  followup:   'Follow-up Note',
  general:    'General Note',
};
export const NOTE_TYPE_COLORS = {
  recruiter:  { bg: '#EFEAFD', color: '#4B2DCE' },
  screening:  { bg: '#F5F3FF', color: '#6C47FF' },
  interview:  { bg: '#E0E7FF', color: '#4338CA' },
  technical:  { bg: '#FAEEDA', color: '#92610A' },
  management: { bg: '#FCE7F3', color: '#9D174D' },
  followup:   { bg: '#ECFEFF', color: '#0E7490' },
  general:    { bg: '#F3F4F6', color: '#6B7280' },
};
export const noteTypeLabel = (t) => NOTE_TYPE_LABELS[t] || t || 'Note';
export const noteTypeColor = (t) => NOTE_TYPE_COLORS[t] || NOTE_TYPE_COLORS.general;
export const NOTE_TYPES = Object.keys(NOTE_TYPE_LABELS);

export const NOTE_VISIBILITY_LABELS = {
  internal: 'Recruitment team',
  shared:   'Team + hiring manager',
  private:  'Only me',
};

/* -- Stage 1 screening (S10-S15) ------------------------------------------ */

/** S11 eligibility verdicts. 'not_assessed' is a real answer, not a blank. */
export const FIT_OPTIONS = [
  { value: 'not_assessed',  label: 'Not assessed' },
  { value: 'meets',         label: 'Meets requirement' },
  { value: 'partial',       label: 'Partially meets' },
  { value: 'does_not_meet', label: 'Does not meet' },
];
export const NOTICE_FIT_OPTIONS = [
  { value: 'not_assessed',     label: 'Not assessed' },
  { value: 'acceptable',       label: 'Acceptable' },
  { value: 'needs_discussion', label: 'Needs discussion' },
  { value: 'not_acceptable',   label: 'Not acceptable' },
];
export const LOCATION_FIT_OPTIONS = [
  { value: 'not_assessed',                label: 'Not assessed' },
  { value: 'local',                       label: 'Local' },
  { value: 'regional',                    label: 'Regional' },
  { value: 'relocation_possible',         label: 'Relocation possible' },
  { value: 'relocation_support_required', label: 'Relocation support required' },
  { value: 'not_willing',                 label: 'Not willing to relocate' },
];
export const SALARY_FIT_OPTIONS = [
  { value: 'not_assessed',  label: 'Not assessed' },
  { value: 'within_range',  label: 'Within range' },
  { value: 'negotiable',    label: 'Negotiable' },
  { value: 'above_range',   label: 'Above range' },
  { value: 'not_discussed', label: 'Not discussed' },
];

export const FIT_COLORS = {
  meets:                       { bg: '#E8FBF0', color: '#047857' },
  acceptable:                  { bg: '#E8FBF0', color: '#047857' },
  within_range:                { bg: '#E8FBF0', color: '#047857' },
  local:                       { bg: '#E8FBF0', color: '#047857' },
  regional:                    { bg: '#ECFDF5', color: '#059669' },
  relocation_possible:         { bg: '#ECFDF5', color: '#059669' },
  partial:                     { bg: '#FEF3C7', color: '#92400E' },
  needs_discussion:            { bg: '#FEF3C7', color: '#92400E' },
  negotiable:                  { bg: '#FEF3C7', color: '#92400E' },
  relocation_support_required: { bg: '#FEF3C7', color: '#92400E' },
  does_not_meet:               { bg: '#FEF2F2', color: '#B91C1C' },
  not_acceptable:              { bg: '#FEF2F2', color: '#B91C1C' },
  above_range:                 { bg: '#FEF2F2', color: '#B91C1C' },
  not_willing:                 { bg: '#FEF2F2', color: '#B91C1C' },
  not_assessed:                { bg: '#F3F4F6', color: '#6B7280' },
  not_discussed:               { bg: '#F3F4F6', color: '#6B7280' },
};
export const fitColor = (v) => FIT_COLORS[v] || FIT_COLORS.not_assessed;

/**
 * S12's competencies, in the order the brief lists them, each with the S14
 * weight it carries.
 *
 * `weight: 0` on adaptability is not a placeholder. S12 asks for the rating and
 * S14's 100-point table does not include it, so it is recorded and displayed but
 * does not move the score. Inventing a weight would mean the number on screen is
 * not the number the brief specifies; hiding the rating would lose an assessment
 * a recruiter took the trouble to make.
 */
export const COMPETENCIES = [
  { key: 'learning_mindset', label: 'Learning Mindset',        weight: 15 },
  { key: 'ownership',        label: 'Ownership',               weight: 10 },
  { key: 'teamwork',         label: 'Teamwork',                weight: 10 },
  { key: 'patience',         label: 'Patience / Perseverance', weight: 10 },
  { key: 'problem_solving',  label: 'Problem Solving',         weight: 15 },
  { key: 'communication',    label: 'Communication',           weight: 5 },
  { key: 'adaptability',     label: 'Adaptability',            weight: 0 },
];

/** S10's B and I: rated on the same 1-5 scale, scored in their own sections. */
export const JUDGEMENTS = [
  { key: 'relevant_knowledge', label: 'Relevant Knowledge', weight: 15 },
  { key: 'career_alignment',   label: 'Career Alignment',   weight: 5 },
];

/** S12's scale, spelled out. A number with no meaning attached is not a rating. */
export const RATING_SCALE = [
  { value: 1, label: 'Poor evidence' },
  { value: 2, label: 'Weak evidence' },
  { value: 3, label: 'Acceptable' },
  { value: 4, label: 'Strong' },
  { value: 5, label: 'Very strong evidence' },
];

/** S14's section labels, keyed by the score_breakdown keys the API returns. */
export const SCORE_SECTIONS = [
  { key: 'eligibility',        label: 'Basic Eligibility',         weight: 10 },
  { key: 'relevant_knowledge', label: 'Relevant Knowledge',        weight: 15 },
  { key: 'learning_mindset',   label: 'Learning Mindset',          weight: 15 },
  { key: 'problem_solving',    label: 'Problem Solving',           weight: 15 },
  { key: 'ownership',          label: 'Ownership',                 weight: 10 },
  { key: 'teamwork',           label: 'Teamwork',                  weight: 10 },
  { key: 'patience',           label: 'Patience / Perseverance',   weight: 10 },
  { key: 'communication',      label: 'Communication',             weight: 5 },
  { key: 'career_alignment',   label: 'Career Alignment',          weight: 5 },
  { key: 'location_alignment', label: 'Location / Role Alignment', weight: 5 },
];

/**
 * S15's Stage-1 outcomes, in the order the brief lists them.
 *
 * `tone` drives the button colour, and it is the argument of S2 rendered as UI:
 * only ONE of these seven is styled as a rejection. "Not suitable for the current
 * role" is a neutral routing decision, and Talent Bank / Future Opportunity are
 * positive retention outcomes, so a recruiter reaching for them is not reaching
 * for a red button.
 */
export const SCREENING_DECISIONS = [
  { value: 'proceed',                     label: 'Proceed to Stage 2',            tone: 'go',      hint: 'Worth Manifest investing more time.' },
  { value: 'hold',                        label: 'Hold / Review',                 tone: 'neutral', hint: 'Undecided — come back to this one.' },
  { value: 'not_suitable_current_role',   label: 'Not Suitable for Current Role', tone: 'warn',    hint: 'Wrong for THIS role. Stays in the system.' },
  { value: 'consider_other_roles',        label: 'Consider Other Roles',          tone: 'route',   hint: 'Name the departments that suit them better.' },
  { value: 'talent_bank',                 label: 'Add to Talent Bank',            tone: 'keep',    hint: 'Keep for future openings in chosen categories.' },
  { value: 'future_opportunity',          label: 'Future Opportunity',            tone: 'keep',    hint: 'Set a date to come back to them.' },
  { value: 'reject_from_manifest',        label: 'Reject from Manifest',          tone: 'stop',    hint: 'Requires a reason. Use sparingly.' },
];
export const DECISION_TONES = {
  go:      { bg: '#E8FBF0', color: '#047857', border: '#A7F3D0' },
  neutral: { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
  warn:    { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
  route:   { bg: '#EFEAFD', color: '#4B2DCE', border: '#DDD3FB' },
  keep:    { bg: '#ECFEFF', color: '#0E7490', border: '#A5F3FC' },
  stop:    { bg: '#FEF2F2', color: '#B91C1C', border: '#FECACA' },
};
export const decisionLabel = (d) =>
  SCREENING_DECISIONS.find(x => x.value === d)?.label || String(d || '—').replace(/_/g, ' ');
export const decisionTone = (d) =>
  DECISION_TONES[SCREENING_DECISIONS.find(x => x.value === d)?.tone] || DECISION_TONES.neutral;

export const SUITABILITY_LABELS = {
  strong:       'Strong fit',
  potential:    'Potential',
  not_suitable: 'Not suitable',
};
export const SUITABILITY_COLORS = {
  strong:       { bg: '#E8FBF0', color: '#047857' },
  potential:    { bg: '#EFEAFD', color: '#4B2DCE' },
  not_suitable: { bg: '#F3F4F6', color: '#6B7280' },
};

/* -- Activity timeline (S21) ---------------------------------------------- */
/**
 * Event type -> tone + dot colour. An unknown type renders with the default, and
 * that is deliberate: `candidate_activity.event_type` has no CHECK constraint
 * (see migration 20260927000001 for why), so a new event type must degrade to a
 * plain row rather than disappearing from the timeline.
 */
export const ACTIVITY_TONES = {
  application_received:       { tone: 'info',  dot: '#2563EB' },
  resume_uploaded:            { tone: 'info',  dot: '#2563EB' },
  note_added:                 { tone: 'note',  dot: '#6C47FF' },
  note_removed:               { tone: 'muted', dot: '#94A3B8' },
  screening_started:          { tone: 'info',  dot: '#6C47FF' },
  screening_completed:        { tone: 'key',   dot: '#047857' },
  stage_change:               { tone: 'key',   dot: '#4338CA' },
  disposition_change:         { tone: 'key',   dot: '#4B2DCE' },
  recruiter_assigned:         { tone: 'info',  dot: '#0E7490' },
  suitability_recorded:       { tone: 'route', dot: '#4B2DCE' },
  suitability_converted:      { tone: 'route', dot: '#4B2DCE' },
  recommended_for_role:       { tone: 'route', dot: '#4B2DCE' },
  talent_bank_added:          { tone: 'keep',  dot: '#0E7490' },
  future_opportunity_created: { tone: 'keep',  dot: '#0E7490' },
  recontact_due:              { tone: 'warn',  dot: '#92400E' },
  recontacted:                { tone: 'keep',  dot: '#0E7490' },
  recontact_cancelled:        { tone: 'muted', dot: '#94A3B8' },
  interview_scheduled:        { tone: 'info',  dot: '#4338CA' },
  interview_feedback_added:   { tone: 'key',   dot: '#4338CA' },
  offer_drafted:              { tone: 'key',   dot: '#059669' },
  offer_accepted:             { tone: 'key',   dot: '#047857' },
  tag_added:                  { tone: 'muted', dot: '#94A3B8' },
  tag_removed:                { tone: 'muted', dot: '#94A3B8' },
  correction:                 { tone: 'warn',  dot: '#92400E' },
};
export const activityTone = (t) => ACTIVITY_TONES[t] || { tone: 'muted', dot: '#94A3B8' };

/* ── Candidate sources ──────────────────────────────────────────────────── */
/**
 * One list, used by BOTH the add-candidate form and every colour lookup, so a
 * source can never be selectable-but-uncoloured or coloured-but-unselectable.
 */
export const SOURCE_LABELS = {
  manual:     'Manual Entry',
  website:    'Website',
  linkedin:   'LinkedIn',
  naukri:     'Naukri',
  indeed:     'Indeed',
  referral:   'Referral',
  job_portal: 'Job Portal',
  campus:     'Campus',
  agency:     'Agency',
  walk_in:    'Walk-in',
  resume_db:  'Resume Database',
};

export const SOURCE_COLORS = {
  website:    { bg: '#dbeafe', color: '#1d4ed8' },
  linkedin:   { bg: '#e0e7ff', color: '#4338ca' },
  naukri:     { bg: '#e0f2fe', color: '#0369a1' },
  indeed:     { bg: '#eef2ff', color: '#3730a3' },
  referral:   { bg: '#fce7f3', color: '#9d174d' },
  job_portal: { bg: '#ede9fe', color: '#5b21b6' },
  campus:     { bg: '#f3e8ff', color: '#6B3FDB' },
  agency:     { bg: '#ede9fe', color: '#6d28d9' },
  walk_in:    { bg: '#ecfeff', color: '#0e7490' },
  resume_db:  { bg: '#f0fdf4', color: '#15803d' },
  manual:     { bg: '#f3f4f6', color: '#6b7280' },
};

export const sourceLabel = (s) => SOURCE_LABELS[(s || '').toLowerCase()] || s || '—';
export const sourceColor = (s) => SOURCE_COLORS[(s || '').toLowerCase()] || SOURCE_COLORS.manual;

// Sources a human can pick when adding a candidate by hand. `resume_db` is
// excluded: it is set by the Resume Database upload path, not chosen in a form.
export const SELECTABLE_SOURCES = [
  'manual', 'website', 'linkedin', 'naukri', 'indeed',
  'referral', 'job_portal', 'campus', 'agency', 'walk_in',
];

// Sources that a Recruitment Settings toggle governs. Those three toggles
// promised to "show X as a sourcing channel in candidate records" and were read
// by nothing at all — this map is what makes the promise true. Anything not
// listed here is always offered.
export const SOURCE_SETTING_KEYS = {
  linkedin: 'integrate_linkedin',
  naukri:   'integrate_naukri',
  indeed:   'integrate_indeed',
};

/**
 * The source list for a picker, filtered by the company's channel toggles.
 *
 * Defaults to ON for an unset toggle: these three sources were always offered
 * before the toggles were wired, so treating "not configured" as OFF would
 * silently remove LinkedIn from every existing tenant's form.
 */
export const sourceOptions = (settings) =>
  SELECTABLE_SOURCES
    .filter((value) => {
      const key = SOURCE_SETTING_KEYS[value];
      if (!key || !settings) return true;
      return settings[key] === undefined || settings[key] === null
        ? true
        : settings[key] === true || settings[key] === 'true';
    })
    .map(value => ({ value, label: SOURCE_LABELS[value] }));

/* ── Job opening / requisition status ───────────────────────────────────── */

export const OPENING_STATUS = {
  draft:            { label: 'Draft',            bg: '#f3f4f6', color: '#6b7280' },
  pending_approval: { label: 'Pending Approval', bg: '#ede9fe', color: '#5b21b6' },
  open:             { label: 'Open',             bg: '#dcfce7', color: '#15803d' },
  on_hold:          { label: 'On Hold',          bg: '#ede9fe', color: '#5b21b6' },
  closed:           { label: 'Closed',           bg: '#fee2e2', color: '#dc2626' },
  cancelled:        { label: 'Cancelled',        bg: '#f3f4f6', color: '#6b7280' },
};
export const openingStatus = (s) => OPENING_STATUS[(s || '').toLowerCase()] || OPENING_STATUS.draft;

export const REQUISITION_STATUS = {
  draft:            { label: 'Draft',            bg: '#f3f4f6', color: '#6b7280' },
  pending_approval: { label: 'Pending Approval', bg: '#ede9fe', color: '#5b21b6' },
  approved:         { label: 'Approved',         bg: '#dcfce7', color: '#15803d' },
  open:             { label: 'Open',             bg: '#dbeafe', color: '#1d4ed8' },
  closed:           { label: 'Closed',           bg: '#f3f4f6', color: '#6b7280' },
};
export const requisitionStatus = (s) => REQUISITION_STATUS[(s || '').toLowerCase()] || REQUISITION_STATUS.draft;

/* ── Offer status ───────────────────────────────────────────────────────── */

export const OFFER_STATUS = {
  draft:            { label: 'Draft',            bg: '#f3f4f6', color: '#6b7280' },
  pending_approval: { label: 'Pending Approval', bg: '#ede9fe', color: '#5b21b6' },
  sent:             { label: 'Sent',             bg: '#dbeafe', color: '#1d4ed8' },
  accepted:         { label: 'Accepted',         bg: '#dcfce7', color: '#15803d' },
  declined:         { label: 'Declined',         bg: '#fee2e2', color: '#dc2626' },
  withdrawn:        { label: 'Withdrawn',        bg: '#f3f4f6', color: '#6b7280' },
};
export const offerStatus = (s) => OFFER_STATUS[(s || '').toLowerCase()] || OFFER_STATUS.draft;

/* ── Interview rounds ───────────────────────────────────────────────────── */
export const INTERVIEW_ROUNDS = [
  'HR Round', 'Technical Round 1', 'Technical Round 2', 'Technical Round 3',
  'Managerial Round', 'Final Round', 'Assignment', 'Reference Check',
];

export const INTERVIEW_MODES = [
  { value: 'video', label: 'Video Call' },
  { value: 'in_person', label: 'In Person' },
  { value: 'phone', label: 'Phone' },
];

/* ── Interview question bank badges ─────────────────────────────────────── */

export const CAT_STYLE = {
  HR:             { bg: '#dbeafe', color: '#1d4ed8' },
  Technical:      { bg: '#ede9fe', color: '#6d28d9' },
  Behavioural:    { bg: '#fce7f3', color: '#9d174d' },
  Situational:    { bg: '#ede9fe', color: '#5b21b6' },
  'Cultural Fit': { bg: '#d1fae5', color: '#065f46' },
  Domain:         { bg: '#f0fdf4', color: '#15803d' },
};
export const QUESTION_CATEGORIES = Object.keys(CAT_STYLE);

export const DIFF_STYLE = {
  easy:   { bg: '#dcfce7', color: '#15803d', label: 'Easy' },
  medium: { bg: '#ede9fe', color: '#5b21b6', label: 'Medium' },
  hard:   { bg: '#fee2e2', color: '#b91c1c', label: 'Hard' },
};
export const QUESTION_DIFFICULTIES = Object.keys(DIFF_STYLE);

/* ── Candidate list response ────────────────────────────────────────────── */
/**
 * GET /recruitment/candidates is paginated and returns
 * `{ rows, total, limit, offset }`. It used to return a bare array, and five
 * pages read `res.data` directly — each with its own `Array.isArray(...) ? ... : []`
 * guard that would now silently produce an empty list.
 *
 * One unwrapper, tolerant of both shapes, so the contract can change again
 * without hunting call sites.
 */
export const candidateRows = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.candidates)) return data.candidates;
  return [];
};

export const candidateTotal = (data, fallbackRows) =>
  (typeof data?.total === 'number' ? data.total : (fallbackRows?.length ?? 0));
