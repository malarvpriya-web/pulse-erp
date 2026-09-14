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

// Display labels. Keys === candidates.current_stage values.
export const STAGE_LABELS = {
  applied:      'Applied',
  screening:    'Screening',
  '1st_level':  '1st Interview',
  '2nd_level':  '2nd Interview',
  offer:        'Offer',
  hired:        'Hired',
  not_suitable: 'Not Suitable',
  maybe:        'Maybe',
  future_use:   'Future Use',
  rejected:     'Rejected',
};

// Stages a candidate actively progresses through — the Kanban columns.
export const ACTIVE_STAGES = ['applied', 'screening', '1st_level', '2nd_level', 'offer', 'hired'];

// Terminal / parked stages, shown separately from the main flow.
export const DEADEND_STAGES = ['maybe', 'future_use', 'not_suitable', 'rejected'];

export const ALL_STAGES = [...ACTIVE_STAGES, ...DEADEND_STAGES];

/**
 * Canonical stage colours. Previously five files each defined their own palette
 * with genuinely different hex values for the same stage, so one candidate
 * appeared in three different colours depending on the page. One palette now.
 */
export const STAGE_COLORS = {
  applied:      { bg: '#E6F1FB', color: '#2563EB' },
  screening:    { bg: '#F5F3FF', color: '#6C47FF' },
  '1st_level':  { bg: '#FAEEDA', color: '#6d28d9' },
  '2nd_level':  { bg: '#FFF3E0', color: '#6d28d9' },
  offer:        { bg: '#F0FDF4', color: '#059669' },
  hired:        { bg: '#E8FBF0', color: '#047857' },
  maybe:        { bg: '#F3F4F6', color: '#6b7280' },
  future_use:   { bg: '#F3F4F6', color: '#6b7280' },
  not_suitable: { bg: '#FEF2F2', color: '#dc2626' },
  rejected:     { bg: '#FEF2F2', color: '#b91c1c' },
};

export const stageLabel = (key) => STAGE_LABELS[key] || key || '—';
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

/* ── Candidate sources ──────────────────────────────────────────────────── */
/**
 * One list, used by BOTH the add-candidate form and every colour lookup, so a
 * source can never be selectable-but-uncoloured or coloured-but-unselectable.
 */
export const SOURCE_LABELS = {
  manual:     'Manual Entry',
  website:    'Website',
  linkedin:   'LinkedIn',
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
export const SELECTABLE_SOURCES = ['manual', 'website', 'linkedin', 'referral', 'job_portal', 'campus', 'agency', 'walk_in'];

export const sourceOptions = () =>
  SELECTABLE_SOURCES.map(value => ({ value, label: SOURCE_LABELS[value] }));

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
