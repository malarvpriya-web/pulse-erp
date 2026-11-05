/**
 * employeeStatus — the canonical employment-status vocabulary.
 *
 * Before this existed the same question ("is this person still employed?") was
 * answered by three independent hardcoded lists that did not agree:
 *
 *   1. `getEmployees()`        excluded notice_period / 'notice period' but NOT 'Notice'
 *   2. `getEmployeeAnalytics()` counted only ('active','probation') as headcount,
 *                               so 'Notice' fell into a nameless 'Other' bucket that
 *                               appeared in the donut but not in the total
 *   3. `EmployeesData.jsx`      counted 'Notice' AND 'Inactive' as staff
 *
 * With one live employee sitting at status 'Notice', the Employees Dashboard
 * reported Total = 32 while its own Employment Status donut summed to 34 and
 * the All Employees page it links to reported 33. Three pages, three answers,
 * same question.
 *
 * `POST /employees/:id/offboard` writes the capitalised 'Notice' deliberately
 * and documents the intent: someone serving notice is still employed (payroll
 * and attendance still run for them). That is the reading encoded here.
 *
 * The frontend mirror is `frontend/src/features/employees/employeeStatus.js`.
 * `src/__tests__/employeeStatusVocabulary.contract.test.js` parses both files
 * and fails if they drift apart — a vocabulary in two copies is only safe when
 * something checks that they still agree.
 */

/** Confirmed, fully-employed. */
export const ACTIVE_STATUSES = ['active'];

/** Employed, inside the probation window. */
export const PROBATION_STATUSES = ['probation'];

/**
 * Employed, serving notice. Still counted in headcount — payroll, attendance
 * and leave all still apply until the last working day actually arrives.
 * Three spellings because the offboard route, the exit module and older
 * hand-edited rows each wrote their own.
 */
export const NOTICE_STATUSES = ['notice', 'notice_period', 'notice period'];

/** No longer employed. The ONLY statuses that leave current headcount. */
export const EXITED_STATUSES = [
  'left', 'inactive', 'terminated', 'resigned',
  'ex-employee', 'ex employee', 'exited', 'relieved', 'absconded',
];

/** Everything that counts as "on the payroll today". */
export const CURRENT_STATUSES = [
  ...ACTIVE_STATUSES, ...PROBATION_STATUSES, ...NOTICE_STATUSES,
];

/**
 * ── READ vocabulary vs WRITE vocabulary ─────────────────────────────────────
 *
 * The arrays above are the READ vocabulary: every spelling that may already
 * sit in `employees.status`, including the three spellings of notice and the
 * nine spellings of "gone". They exist because history is messy and a report
 * must not drop a real person over a synonym.
 *
 * `WRITABLE_STATUSES` is the WRITE vocabulary: the only values a UI or an API
 * caller may SET. It is deliberately much smaller — the point of a canonical
 * vocabulary is that no NEW synonym can be created. Before this existed,
 * `PATCH /employees/:id/status` took `{ status }` straight from the body into
 * an UPDATE with no validation at all, so any string became an employment
 * status; 'Inactive', 'Left', 'terminated' and 'resigned' were all reachable
 * from the UI and all mean exactly one thing.
 *
 * 'Inactive' is NOT writable. It is an exited status that the All Employees row
 * dropdown used to offer, which meant HR could retire someone with one click
 * and no last working day, no exit reason and no exit_request — a departure
 * that no report could date. Leaving is `Left`, and it goes through the
 * Terminate flow (or `POST /employees/:id/offboard`) which captures those.
 *
 * `terminated` is written only by `deleteEmployee`'s soft delete, which also
 * stamps `deleted_at`; it is not offerable either.
 */
export const WRITABLE_STATUSES = ['Active', 'Probation', 'Notice', 'Left'];

/**
 * Statuses a bulk action may apply. `Left` is excluded on purpose: a bulk
 * status change carries no exit date or reason, so bulk-terminating would
 * create N undateable departures in one click.
 */
export const BULK_WRITABLE_STATUSES = ['Active', 'Probation', 'Notice'];

/** Human label per writable status. 'Notice' alone reads as a noun, not a state. */
export const STATUS_LABELS = {
  Active:    'Active',
  Probation: 'Probation',
  Notice:    'On Notice',
  Left:      'Exited',
};

/**
 * The status an employee ends up in once their last working day has passed.
 *
 * ⚠ There were THREE copies of a `separation_type -> status` mapping — in
 * `exitStatusSync.cron.js`, in `hr.routes.js`'s offboarding-complete handler,
 * and implicitly in `exit.routes.js`'s F&F handler (which hardcoded lowercase
 * 'left'). Between them they wrote 'terminated', 'left' and 'resigned' as three
 * different employment statuses for one state: gone.
 *
 * They are collapsed to `'Left'`. The REASON someone left is not employment
 * status and does not belong in this column — it is `exit_requests.separation_type`,
 * which is where all three of those mappings read it FROM. Storing it twice is
 * what let the two copies drift (one mapped 'retirement' to 'left', the other
 * mapped it to 'resigned').
 *
 * Nothing reads the distinction: a sweep of every hardcoded exited-status list in
 * the repo found ~15 of them and every one is an "exclude the departed" filter
 * that lists several spellings side by side. None branches on which.
 *
 * The three legacy spellings stay in `EXITED_STATUSES` so existing rows still
 * read correctly. Nothing new is written in them.
 */
export const EXIT_STATUS = 'Left';

/** The status of someone serving notice. Still counted in headcount. */
export const NOTICE_STATUS = 'Notice';

/**
 * The canonical spelling of a writable status, or null when the value is not
 * one. Case-insensitive on input so 'notice' and 'NOTICE' both normalise to
 * 'Notice' rather than being rejected as unknown — but 'notice_period', which
 * is a legacy READ spelling, is deliberately NOT accepted as a write.
 */
export function canonicalWritableStatus(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return WRITABLE_STATUSES.find(w => w.toLowerCase() === s) ?? null;
}

/** Donut/legend buckets, in display order. 'Exited' is never current. */
export const STATUS_BUCKETS = ['Active', 'Probation', 'Notice', 'Other', 'Exited'];

const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** A fixed vocabulary rendered as a SQL IN-list. Never takes user input. */
export const sqlList = (arr) => arr.map(quote).join(', ');

/**
 * Normalised status for a column. A NULL or blank status reads as 'active':
 * that is what `getEmployees()` has always assumed, and dropping those rows
 * from headcount would hide real people.
 */
export const statusExpr = (col = 'status') =>
  `LOWER(COALESCE(NULLIF(TRIM(${col}), ''), 'active'))`;

/** True for someone who has left. */
export const isExitedSql = (col = 'status') =>
  `${statusExpr(col)} IN (${sqlList(EXITED_STATUSES)})`;

/**
 * True for someone still employed.
 *
 * Deliberately the negation of `isExitedSql`, not a positive IN-list: an
 * unrecognised status is far more likely to be a live employee spelled oddly
 * than a departure, and silently dropping people from headcount is the worse
 * failure. It also makes the two predicates incapable of disagreeing.
 */
export const isCurrentSql = (col = 'status') =>
  `${statusExpr(col)} NOT IN (${sqlList(EXITED_STATUSES)})`;

/** The display bucket for a status column. Pairs with STATUS_BUCKETS. */
export const bucketSql = (col = 'status') => `CASE
    WHEN ${statusExpr(col)} IN (${sqlList(EXITED_STATUSES)})    THEN 'Exited'
    WHEN ${statusExpr(col)} IN (${sqlList(PROBATION_STATUSES)}) THEN 'Probation'
    WHEN ${statusExpr(col)} IN (${sqlList(NOTICE_STATUSES)})    THEN 'Notice'
    WHEN ${statusExpr(col)} IN (${sqlList(ACTIVE_STATUSES)})    THEN 'Active'
    ELSE 'Other'
  END`;

/** JS-side bucket, for code paths that already hold the row. */
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

export default {
  ACTIVE_STATUSES, PROBATION_STATUSES, NOTICE_STATUSES,
  EXITED_STATUSES, CURRENT_STATUSES, STATUS_BUCKETS,
  WRITABLE_STATUSES, BULK_WRITABLE_STATUSES, STATUS_LABELS, EXIT_STATUS, NOTICE_STATUS,
  canonicalWritableStatus,
  sqlList, statusExpr, isExitedSql, isCurrentSql, bucketSql,
  bucketOf, isExited, isCurrent,
};
