/**
 * Internship vocabularies and the SQL that classifies an internship.
 *
 * The status / frequency / document-type lists mirror the CHECK constraints in
 * 20261013000002_internships.js. `internshipVocabulary.contract.test.js` reads
 * the LIVE constraints and asserts they equal these arrays, so the API cannot
 * accept a value the column refuses (a 500 the user reads as "save failed").
 *
 * Every "which internships are X" question — the summary cards, the register's
 * quick filters, the reports — is answered from VIEW_SQL / DURATION_BUCKET_SQL
 * below, so a card and the list it opens cannot count different populations.
 */

export const INTERN_STATUSES = [
  'Applied', 'Selected', 'Onboarding', 'Active', 'Completed', 'Cancelled', 'Terminated',
];

/** Statuses that are over. A closed internship is never "starting" or "ending". */
export const CLOSED_STATUSES = ['Completed', 'Cancelled', 'Terminated'];

/**
 * ── Allowed status transitions ──────────────────────────────────────────────
 *
 *   Applied    → Selected, Cancelled
 *   Selected   → Onboarding, Active, Cancelled, Applied (correction)
 *   Onboarding → Active, Cancelled, Terminated, Selected (correction)
 *   Active     → Terminated            (and → Completed, ONLY via POST /:id/complete)
 *   Completed  → (none)                terminal; certificate actions do not change status
 *   Cancelled  → (none)                terminal
 *   Terminated → (none)                terminal
 *
 * Keeping the same status is always allowed (editing other fields). These are
 * the moves the general create/update form may make. Completion is not in this
 * map at all: it needs an HR-approved mentor evaluation recommending completion
 * and is recorded by its own action, with its own audit event. The database
 * enforces the same two rules for Completed (trg_interns_completion_guard), so
 * a script cannot reach or leave Completed either.
 */
export const STATUS_TRANSITIONS = {
  Applied:    ['Selected', 'Cancelled'],
  Selected:   ['Onboarding', 'Active', 'Cancelled', 'Applied'],
  Onboarding: ['Active', 'Cancelled', 'Terminated', 'Selected'],
  Active:     ['Terminated'],
  Completed:  [],
  Cancelled:  [],
  Terminated: [],
};

/** Statuses a NEW internship may be created in. Never Completed. */
export const INITIAL_STATUSES = ['Applied', 'Selected', 'Onboarding', 'Active'];

/** May the general form move an internship from `from` to `to`? */
export const canTransition = (from, to) => from === to || (STATUS_TRANSITIONS[from] || []).includes(to);

/**
 * ── Mentor evaluation vocabulary ─────────────────────────────────────────────
 * Mirrors the CHECK constraints in 20261013000006. The recommendation is the
 * mentor's view on EMPLOYMENT. Either of the first two means the internship
 * itself was served, so it may be completed (and certified); Extend and Need
 * Further Review keep it open. Only the first permits conversion to employee.
 */
export const RECOMMENDATIONS = ['Recommended for Employment', 'Not Recommended', 'Extend Internship', 'Need Further Review'];
export const COMPLETING_RECOMMENDATIONS = ['Recommended for Employment', 'Not Recommended'];
export const EMPLOYMENT_RECOMMENDATION = 'Recommended for Employment';

/** The six 1..5 ratings. Every one is required to submit. */
export const RATING_FIELDS = [
  { key: 'technical_skills',      label: 'Technical Skills' },
  { key: 'communication',         label: 'Communication' },
  { key: 'teamwork',              label: 'Teamwork' },
  { key: 'discipline_attendance', label: 'Discipline / Attendance' },
  { key: 'learning_ability',      label: 'Learning Ability' },
  { key: 'overall_performance',   label: 'Overall Performance' },
];
export const RATING_SCALE = [
  { value: 1, label: 'Poor' }, { value: 2, label: 'Below expectations' }, { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds expectations' }, { value: 5, label: 'Outstanding' },
];

/**
 * Where the mentor evaluation REQUEST stands, derived from the evaluation row
 * (aliased `ev`) so it can never disagree with it:
 *   Draft      created by HR, not sent yet
 *   Sent       sent to the mentor (or returned to them by HR for revision)
 *   Reminder   sent, and at least one reminder since
 *   Received   the mentor's evaluation is in (online or as a returned document)
 *   Completed  HR approved it
 */
export const REQUEST_STATUSES = ['Draft', 'Sent', 'Reminder', 'Received', 'Completed'];
export const REQUEST_STATUS_SQL = `CASE
  WHEN ev.status = 'Approved' THEN 'Completed'
  WHEN ev.status = 'Submitted' THEN 'Received'
  WHEN ev.request_sent_at IS NULL THEN 'Draft'
  WHEN ev.reminder_count > 0 THEN 'Reminder'
  ELSE 'Sent' END`;

export const STIPEND_FREQUENCIES = ['Monthly', 'Weekly', 'One-time', 'Unpaid'];

/** key → stored doc_type. The key is the multipart field suffix the form sends. */
export const INTERN_DOC_TYPES = {
  college_id:         'College ID',
  institution_letter: 'Institution Letter',
  offer_letter:       'Offer Letter',
  id_proof:           'ID Proof',
  resume:             'Resume',
  nda:                'NDA',
  certificate:        'Certificate',
  other:              'Other',
  mentor_evaluation:  'Mentor Evaluation',
};

/**
 * Document types the GENERAL create/update form may upload. The certificate is
 * deliberately absent: a certificate file is attached only by the certificate
 * issuance action, which checks eligibility, numbers it and audits it.
 */
export const GENERAL_DOC_KEYS = Object.keys(INTERN_DOC_TYPES).filter(k => !['certificate', 'mentor_evaluation'].includes(k));
// (The returned mentor evaluation is attached to its evaluation, from the
// Evaluation tab — never through the general form.)

/** "Starting soon" / "Ending soon" look this many days ahead (today included). */
export const SOON_DAYS = 14;

/** Longest internship the API accepts. Longer than this is a data-entry error. */
export const MAX_DURATION_DAYS = 731;

const q = (v) => `'${v.replace(/'/g, "''")}'`;
const inList = (arr) => arr.map(q).join(', ');

/**
 * ── Completion stage ─────────────────────────────────────────────────────────
 *
 *   Active → Evaluation Requested → Evaluation Received → Completed → Certificate Issued
 *   Evaluation Pending: Active, past its end date, and no evaluation received.
 *
 * DERIVED, not stored: `interns.status` stays Active until HR completes it, and
 * the stage reads the latest evaluation and the certificate, so nothing can be
 * "Received" in one place and "Requested" in another. Nothing here completes an
 * internship because its end date passed — that only makes it Pending.
 * Statuses outside the flow (Applied, Selected, Onboarding, Cancelled,
 * Terminated) are their own stage.
 */
export const COMPLETION_STAGES = ['Active', 'Evaluation Requested', 'Evaluation Received', 'Evaluation Pending',
  'Completed', 'Certificate Issued'];
const LATEST_EVAL = (col) => `(SELECT ${col} FROM intern_evaluations lev WHERE lev.intern_id = i.id ORDER BY lev.id DESC LIMIT 1)`;
export const COMPLETION_STAGE_SQL = `CASE
  WHEN i.status = 'Completed' AND i.certificate_issued THEN 'Certificate Issued'
  WHEN i.status = 'Completed' THEN 'Completed'
  WHEN i.status <> 'Active' THEN i.status
  WHEN ${LATEST_EVAL('lev.status')} IN ('Submitted', 'Approved') THEN 'Evaluation Received'
  WHEN i.end_date < CURRENT_DATE THEN 'Evaluation Pending'
  WHEN ${LATEST_EVAL('lev.request_sent_at')} IS NOT NULL OR ${LATEST_EVAL('lev.status')} IN ('Draft', 'Returned')
    THEN 'Evaluation Requested'
  ELSE 'Active' END`;

/**
 * Named populations, as SQL predicates over an `interns` row aliased `i`.
 */
export const VIEW_SQL = {
  active:        `i.status = 'Active'`,
  starting_soon: `i.status IN ('Selected','Onboarding','Active')
                  AND i.start_date >= CURRENT_DATE AND i.start_date < CURRENT_DATE + ${SOON_DAYS}`,
  ending_soon:   `i.status = 'Active'
                  AND i.end_date >= CURRENT_DATE AND i.end_date < CURRENT_DATE + ${SOON_DAYS}`,
  // Past its end date but nobody has closed it. Nothing changes status by
  // itself — completion records a date and a certificate decision, which only
  // HR can make — so this is the queue that tells them to.
  awaiting_completion: `i.status NOT IN (${inList(CLOSED_STATUSES)}) AND i.end_date < CURRENT_DATE`,
  completed:     `i.status = 'Completed'`,
  evaluation_pending: `(${COMPLETION_STAGE_SQL}) = 'Evaluation Pending'`,
  converted:     `i.converted_employee_id IS NOT NULL`,
  current:       `i.status IN ('Onboarding','Active')`,
  all:           `TRUE`,
};

export const DURATION_BUCKETS = ['Up to 1 month', '1–3 months', '3–6 months', 'Over 6 months'];

export const DURATION_BUCKET_SQL = `CASE
  WHEN i.duration_days <= 31  THEN ${q(DURATION_BUCKETS[0])}
  WHEN i.duration_days <= 92  THEN ${q(DURATION_BUCKETS[1])}
  WHEN i.duration_days <= 184 THEN ${q(DURATION_BUCKETS[2])}
  ELSE ${q(DURATION_BUCKETS[3])} END`;

/**
 * Monthly-equivalent stipend, for the spend summary. One-time is spread over the
 * internship's length; Unpaid and blank are zero.
 */
export const MONTHLY_STIPEND_SQL = `CASE
  WHEN i.stipend IS NULL OR i.stipend_frequency IS NULL OR i.stipend_frequency = 'Unpaid' THEN 0
  WHEN i.stipend_frequency = 'Monthly' THEN i.stipend
  WHEN i.stipend_frequency = 'Weekly'  THEN i.stipend * 52 / 12
  WHEN i.stipend_frequency = 'One-time' THEN i.stipend * 30.4375 / GREATEST(i.duration_days, 1)
  ELSE 0 END`;

/** Whole-internship stipend cost (committed spend). */
export const TOTAL_STIPEND_SQL = `CASE
  WHEN i.stipend IS NULL OR i.stipend_frequency IS NULL OR i.stipend_frequency = 'Unpaid' THEN 0
  WHEN i.stipend_frequency = 'One-time' THEN i.stipend
  WHEN i.stipend_frequency = 'Monthly'  THEN i.stipend * i.duration_days / 30.4375
  WHEN i.stipend_frequency = 'Weekly'   THEN i.stipend * i.duration_days / 7.0
  ELSE 0 END`;
