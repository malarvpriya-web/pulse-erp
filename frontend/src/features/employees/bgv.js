// ──────────────────────────────────────────────────────────────────────────────
// bgv.js — the BGV vocabularies, badge colours and money formatting, in ONE
// place for both BGV pages and the View Employee tab.
//
// ⚠ The status / result / payment lists MIRROR the CHECK constraints in
// backend/src/database/migrations/20260930000010_bgv_foundation.js and the
// exported lists in backend/src/modules/hr/bgv.routes.js. A value offered here
// that the column rejects is a save that fails with a bare 500, which is the
// [[project_item_master_type_vocabulary_drift]] failure (filter options plural,
// stored values singular — every pick emptied the table). The frontend list is
// asserted against the backend's by bgv.vocabulary.test.jsx.
//
// ── Status is not Result ─────────────────────────────────────────────────────
// Two separate axes, deliberately. `status` says where the work is, `result`
// says what it found, and no screen may render one as the other: a Completed
// check with a Discrepancy result must never read as "cleared".
// ──────────────────────────────────────────────────────────────────────────────

/** Where the verification work is. */
export const CHECK_STATUSES = ['Pending', 'Initiated', 'In Progress', 'Completed', 'Cancelled'];

/** What the verification found. `Pending` means "not answered yet". */
export const CHECK_RESULTS = ['Pending', 'Clear', 'Discrepancy', 'Unable to Verify'];

export const PAYMENT_STATUSES = ['Pending', 'Invoiced', 'Paid', 'Waived'];

/**
 * ── APPLICABILITY ────────────────────────────────────────────────────────────
 * Does this verification apply to this employee?
 *
 *   Required        counted in the progress denominator; blocks case closure.
 *   Optional        applies and blocks closure, but is not in the headline
 *                   figure. Cancel it to finish it without doing it.
 *   Not Applicable  a recorded DECISION, not work. Never pending, never blocks
 *                   closure, never in the denominator — a fresher has no
 *                   previous employer, so Employment Verification for them is
 *                   "not applicable", not "pending forever".
 *
 * Mirrors the CHECK constraint in 20260930000013 and APPLICABILITY in
 * bgv.routes.js; asserted equal by the contract tests.
 */
export const APPLICABILITY = ['Required', 'Optional', 'Not Applicable'];

/** The two states that mean "this is real work". */
export const APPLICABLE = ['Required', 'Optional'];

/** The statuses that mean a check is neither completed nor cancelled. */
const UNRESOLVED = ['Pending', 'Initiated', 'In Progress'];

/**
 * True when this check counts as outstanding BGV work.
 *
 * Includes Optional: an Optional check that is still running IS work, and the
 * page should show it. It just does not BLOCK closure — see `blocksClosure`.
 */
export const isOutstanding = (check) =>
  APPLICABLE.includes(check?.applicability) && UNRESOLVED.includes(check?.status);

/**
 * True when this check PREVENTS the case being closed.
 *
 * ⚠ REQUIRED only, and this is deliberately narrower than `isOutstanding`.
 *
 *   Required        blocks. That is what "required" means.
 *   Optional        does NOT block. HR may skip it (with a reason). Holding a
 *                   whole case open for an optional reference check is how a
 *                   case stays open forever over a nice-to-have.
 *   Not Applicable  never blocks — it is a recorded decision, not work.
 *
 * Two separate predicates because the page needs both answers and they are
 * different: "is there outstanding work" (show it) and "can this be closed"
 * (enable the button). Collapsing them is what made Optional mean nothing.
 */
export const blocksClosure = (check) =>
  check?.applicability === 'Required' && UNRESOLVED.includes(check?.status);

/**
 * The progress line: "4 / 6 Required Checks Completed".
 *
 * ⚠ Replaces a bare `${completed}/${total} checks` that counted EVERY check,
 * including ones ruled Not Applicable — so a fresher whose four required checks
 * were all done read as "4/5", and a case with one Not Applicable check and
 * nothing else read as "0/1". Both are the misleading count the brief called
 * out. The denominator is Required only.
 */
export const requiredProgressLabel = (c) => {
  const total = Number(c?.required_total ?? 0);
  if (total === 0) return 'No required checks';
  return `${Number(c?.required_completed ?? 0)} / ${total} required checks completed`;
};

/**
 * Completion percentage over REQUIRED checks, or null when there are none.
 *
 * ⚠ null, not 0. A progress bar at zero for a case with nothing required says
 * "no progress" when the truth is "nothing to do" — the same class of lie as
 * rendering an uncaptured cost as ₹0.
 */
export const requiredPct = (c) => {
  const total = Number(c?.required_total ?? 0);
  if (!total) return null;
  const pct = c?.required_completion_pct;
  return pct == null ? Math.round((Number(c?.required_completed ?? 0) / total) * 100) : Number(pct);
};

export const CONTACT_TYPES = ['Previous Employer', 'College', 'Reference', 'Address Contact', 'Agency', 'Other'];
export const CONTACT_METHODS = ['Phone', 'Email', 'Portal', 'Visit', 'Other'];
export const CONTACT_RESPONSES = ['Pending', 'Received', 'No Response', 'Discrepancy'];

/**
 * The DERIVED case statuses. There is no `bgv_cases.status` column — the backend
 * computes these from the checks (CASE_STATUS in bgv.routes.js). This list is
 * what the filter dropdown offers and what the KPI cards map onto, so a card and
 * the list it opens always describe the same population.
 */
export const CASE_STATUSES = ['Not Started', 'Initiated', 'In Progress', 'Completed', 'Discrepancy', 'Closed'];

/** Badge palette. Uses the canonical status tokens from global-overrides.css. */
const BADGE = {
  // case status
  'Not Started':      { bg: '#f3f4f6', color: '#4b5563' },
  'Initiated':        { bg: '#ede9fe', color: '#5b21b6' },
  'In Progress':      { bg: '#dbeafe', color: '#1d4ed8' },
  'Completed':        { bg: '#dcfce7', color: '#166534' },
  'Discrepancy':      { bg: '#fee2e2', color: '#991b1b' },
  'Closed':           { bg: '#e5e7eb', color: '#374151' },
  // check status / result (the overlap is intentional — same word, same colour)
  'Pending':          { bg: '#f3f4f6', color: '#4b5563' },
  'Cancelled':        { bg: '#e5e7eb', color: '#6b7280' },
  'Clear':            { bg: '#dcfce7', color: '#166534' },
  'Unable to Verify': { bg: '#fef3c7', color: '#92400e' },
  // payment status
  'Invoiced':         { bg: '#fef3c7', color: '#92400e' },
  'Paid':             { bg: '#dcfce7', color: '#166534' },
  'Waived':           { bg: '#e5e7eb', color: '#374151' },
  // contact response
  'Received':         { bg: '#dcfce7', color: '#166534' },
  'No Response':      { bg: '#fef3c7', color: '#92400e' },
  // applicability — deliberately NOT the status palette. 'Required' must not
  // look like a warning and 'Not Applicable' must not look like a failure; they
  // describe scope, not outcome.
  'Required':         { bg: '#ede9fe', color: '#5b21b6' },
  'Optional':         { bg: '#f1f5f9', color: '#475569' },
  'Not Applicable':   { bg: '#f8fafc', color: '#94a3b8' },
};

export const badgeFor = (value) => BADGE[value] || { bg: '#f3f4f6', color: '#4b5563' };

/**
 * Money, where NULL is NOT zero.
 *
 * ⚠ Do NOT use `utils/format.js`'s `fmt()` here. It is `₹${Number(v ?? 0)}`,
 * which renders an uncaptured cost as ₹0 — and "we have not been billed yet" and
 * "this check was free" are different facts that an HR person reading a spend
 * report has to be able to tell apart. That conflation is exactly what
 * [[project_tco_freight_inputs_never_captured]] cost: a DEFAULT 0 made
 * "unmeasured" and "free" the same value and no report could separate them.
 * Null renders as an em-dash. Zero renders as ₹0.
 */
export function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** A date column: 'YYYY-MM-DD' in, 'DD MMM YYYY' out, em-dash for nothing. */
export function shortDate(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined') return '—';
  const d = new Date(s.length > 10 ? s : `${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** 'YYYY-MM' → 'Sep 2026', for the spend-by-month chart. */
export function monthLabel(v) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return String(v ?? '—');
  return new Date(Number(m[1]), Number(m[2]) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/**
 * "3/5 checks completed" — the one phrasing, so the list, the detail summary and
 * the View Employee tab cannot count differently.
 */
export const progressLabel = (c) =>
  `${Number(c?.checks_completed ?? 0)}/${Number(c?.checks_total ?? 0)} checks completed`;

/**
 * Is this check's paperwork done? Used for the "Pending Reports" signal.
 * A cancelled check needs no report.
 */
/**
 * Does this check still owe a report?
 *
 * ⚠ A MISSING applicability is treated as applicable. The column is NOT NULL
 * with DEFAULT 'Required', so every row from the API carries one — but if a
 * stale payload ever lacks it, the fail-safe direction is to SHOW the
 * outstanding report rather than hide it. Requiring the field strictly meant an
 * older response silently reported no missing reports at all.
 */
export const needsReport = (check) =>
  (check?.applicability == null || APPLICABLE.includes(check.applicability))
  && check?.status !== 'Cancelled'
  && Number(check?.document_count ?? 0) === 0;

export default {
  CHECK_STATUSES, CHECK_RESULTS, PAYMENT_STATUSES, CASE_STATUSES,
  CONTACT_TYPES, CONTACT_METHODS, CONTACT_RESPONSES,
  APPLICABILITY, APPLICABLE, isOutstanding, blocksClosure,
  badgeFor, money, shortDate, monthLabel, progressLabel, needsReport,
  requiredProgressLabel, requiredPct,
};
