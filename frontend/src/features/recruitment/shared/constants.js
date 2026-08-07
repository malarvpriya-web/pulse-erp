// Canonical candidate pipeline stage labels.
// Extracted from CandidateDetail.jsx and RecruitmentDashboard.jsx, which
// defined byte-identical copies independently.
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

// Interview-question category badge styling. Extracted from
// InterviewQuestionBank.jsx and InterviewScheduler.jsx's "Suggested
// Questions" panel, which defined byte-identical copies independently.
export const CAT_STYLE = {
  HR:             { bg: '#dbeafe', color: '#1d4ed8' },
  Technical:      { bg: '#ede9fe', color: '#6d28d9' },
  Behavioural:    { bg: '#fce7f3', color: '#9d174d' },
  Situational:    { bg: '#fef3c7', color: '#92400e' },
  'Cultural Fit': { bg: '#d1fae5', color: '#065f46' },
  Domain:         { bg: '#f0fdf4', color: '#15803d' },
};

// Interview-question difficulty badge styling. Same source pages as
// CAT_STYLE above. InterviewScheduler.jsx's copy omitted `label` (it renders
// the raw value instead), so this canonical version's extra field is unused
// there but never wrong.
export const DIFF_STYLE = {
  easy:   { bg: '#dcfce7', color: '#15803d', label: 'Easy' },
  medium: { bg: '#fef3c7', color: '#92400e', label: 'Medium' },
  hard:   { bg: '#fee2e2', color: '#b91c1c', label: 'Hard' },
};
