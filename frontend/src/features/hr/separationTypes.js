// The exit types the server accepts — the F&F engine's KNOWN_SEPARATIONS
// (backend/src/modules/hr/settlementEngine.js), checked on every create and
// edit by modules/hr/exitCase.js (§274). Keep the two lists identical: a type
// the engine does not know was silently settled as a resignation.
export const SEPARATION_OPTIONS = [
  { value: 'resignation',     label: 'Resignation' },
  { value: 'termination',     label: 'Termination' },
  { value: 'retrenchment',    label: 'Retrenchment' },
  { value: 'retirement',      label: 'Retirement' },
  { value: 'contract_expiry', label: 'Contract end' },
  { value: 'absconding',      label: 'Absconding' },
  { value: 'death',           label: 'Death' },
  { value: 'disablement',     label: 'Disablement' },
];

const LABELS = Object.fromEntries(SEPARATION_OPTIONS.map((o) => [o.value, o.label]));

/** Display label for a stored separation_type (legacy values shown as stored). */
export const separationLabel = (v) => LABELS[v] || (v ? String(v).replace(/_/g, ' ') : '—');
