// PATH: frontend/src/features/employees/employeeStatus.js
/**
 * Frontend mirror of `backend/src/shared/employeeStatus.js`.
 *
 * Keep the five arrays below byte-identical to the backend's. They are the
 * reason the Employees Dashboard, the All Employees page and the Employment
 * Status donut used to report three different totals for the same workforce.
 *
 * `backend/src/__tests__/employeeStatusVocabulary.contract.test.js` parses this
 * file and the backend one and fails the build if they drift.
 */

export const ACTIVE_STATUSES = ['active'];

export const PROBATION_STATUSES = ['probation'];

export const NOTICE_STATUSES = ['notice', 'notice_period', 'notice period'];

export const EXITED_STATUSES = [
  'left', 'inactive', 'terminated', 'resigned',
  'ex-employee', 'ex employee', 'exited', 'relieved', 'absconded',
];

export const CURRENT_STATUSES = [
  ...ACTIVE_STATUSES, ...PROBATION_STATUSES, ...NOTICE_STATUSES,
];

/**
 * WRITE vocabulary — the only statuses a control on this page may SET.
 * Mirrors `WRITABLE_STATUSES` in the backend module; the contract test compares
 * them. The arrays above are the READ vocabulary: every spelling that may
 * already exist in the column. Offering a read-only synonym as a write option
 * is how 'Inactive', 'Left', 'terminated' and 'resigned' all ended up meaning
 * the same thing in the same dropdown.
 *
 * 'Inactive' is absent deliberately: it was offerable from the row dropdown,
 * so a single click retired someone with no last working day and no exit
 * reason. Leaving goes through Terminate, which captures both.
 */
export const WRITABLE_STATUSES = ['Active', 'Probation', 'Notice', 'Left'];

/** Statuses a BULK action may apply — no 'Left': bulk carries no exit date. */
export const BULK_WRITABLE_STATUSES = ['Active', 'Probation', 'Notice'];

export const STATUS_LABELS = {
  Active:    'Active',
  Probation: 'Probation',
  Notice:    'On Notice',
  Left:      'Exited',
};

/** Canonical spelling of a writable status, or null. */
export function canonicalWritableStatus(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return WRITABLE_STATUSES.find(w => w.toLowerCase() === s) ?? null;
}

export const STATUS_BUCKETS = ['Active', 'Probation', 'Notice', 'Other', 'Exited'];

/** Colour per bucket — shared by the donut, the department stack and the badges. */
export const BUCKET_COLORS = {
  Active:    '#16a34a',
  Probation: '#6d28d9',
  Notice:    '#f59e0b',
  Other:     '#94a3b8',
  Exited:    '#dc2626',
};

/**
 * The display bucket for a raw status value. A blank status reads as Active —
 * the same assumption the API makes, so a row with no status is not silently
 * dropped from one surface and counted by another.
 */
export function bucketOf(status) {
  const s = String(status ?? '').trim().toLowerCase() || 'active';
  if (EXITED_STATUSES.includes(s)) return 'Exited';
  if (PROBATION_STATUSES.includes(s)) return 'Probation';
  if (NOTICE_STATUSES.includes(s)) return 'Notice';
  if (ACTIVE_STATUSES.includes(s)) return 'Active';
  return 'Other';
}

export const isExited = (status) => bucketOf(status) === 'Exited';
export const isCurrent = (status) => !isExited(status);

/** Tenure buckets — must match `TENURE_BUCKETS` in the analytics service. */
export const TENURE_BUCKETS = ['0-1 yr', '1-3 yrs', '3-5 yrs', '5-10 yrs', '10+ yrs', 'Not recorded'];

/**
 * Years of service for an employee row, or null when joining_date is missing.
 * Mirrors the SQL `AGE(NOW(), joining_date)` bucketing so a drill-down from the
 * tenure chart lands on exactly the rows the bar counted.
 */
export function tenureBucketOf(joiningDate) {
  if (!joiningDate) return 'Not recorded';
  const start = new Date(joiningDate);
  if (Number.isNaN(start.getTime())) return 'Not recorded';
  const years = (Date.now() - start.getTime()) / (365.2425 * 24 * 60 * 60 * 1000);
  if (years < 1) return '0-1 yr';
  if (years < 3) return '1-3 yrs';
  if (years < 5) return '3-5 yrs';
  if (years < 10) return '5-10 yrs';
  return '10+ yrs';
}

export default {
  ACTIVE_STATUSES, PROBATION_STATUSES, NOTICE_STATUSES,
  EXITED_STATUSES, CURRENT_STATUSES, STATUS_BUCKETS, BUCKET_COLORS,
  WRITABLE_STATUSES, BULK_WRITABLE_STATUSES, STATUS_LABELS, canonicalWritableStatus,
  TENURE_BUCKETS, bucketOf, isExited, isCurrent, tenureBucketOf,
};
