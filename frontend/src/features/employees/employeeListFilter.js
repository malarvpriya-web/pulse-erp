// PATH: frontend/src/features/employees/employeeListFilter.js
/**
 * The drill-down contract between the Employees Dashboard and the pages it
 * links to.
 *
 * Before this, every "View all →" and every KPI card called
 * `setPage('EmployeesData')` with no filter at all: clicking Expiring Docs (1)
 * or On Probation (2) dropped you on the unfiltered list of 33 people and left
 * you to find them yourself. The one exception, HRDashboard, wrote a bare
 * status string to `sessionStorage.employeeStatusFilter` — enough for a status
 * but not for "joined in this period" or "in this tenure band".
 *
 * A filter is written immediately before `setPage`, consumed exactly once by
 * the destination on mount, and shown to the user as a removable chip so a
 * filtered list can never be mistaken for the whole list.
 *
 * Supported keys (all optional; omitted = unfiltered):
 *   status       'Active' | 'Probation' | 'Notice' | 'All'
 *   department   department name, as the dashboard chart labels it
 *   gender       gender value
 *   skill        skill_type value
 *   tenure       one of TENURE_BUCKETS
 *   joinedFrom   YYYY-MM-DD   inclusive
 *   joinedTo     YYYY-MM-DD   inclusive
 *   expiry       'expiring' | 'expired' | 'any'   (EmployeeDocuments only)
 *   missing      'joining_date' | 'probation_end' | 'department' | 'skill_type'
 *                | 'designation' | 'critical' | 'any'  — data-quality gaps
 *   ids          explicit employee ids, for a population the list page cannot
 *                express as a predicate (whose birthday falls in the window,
 *                whose work anniversary is due)
 *   wf           Workforce Analytics dimensions, matched EXACTLY as
 *                GET /analytics/workforce labels them (see workforceLabel):
 *                { department, designation, employmentType, gender, skillType,
 *                  qualification } → the chart's value, 'Not recorded' for blanks;
 *                { branchId } → a branch id, or null for "no location".
 *                Separate from `department`/`gender`/`skill` above, which keep
 *                the Employees Dashboard's own labels ('Unassigned',
 *                'Not specified') — two pages, two vocabularies, never mixed.
 *   label        human sentence for the chip, e.g. "Joined in FY27"
 *   origin       page key that set it, for the "Back to dashboard" link
 */

/** Workforce Analytics' label for a blank value. */
export const NOT_RECORDED = 'Not recorded';

/**
 * A text value as Workforce Analytics labels it — the frontend twin of the
 * backend's labelSql(): NULL, blank, whitespace and the literal strings
 * 'null'/'undefined' (any case) are 'Not recorded'; anything else is trimmed.
 * The drill-through only lists the people the chart counted if the two agree.
 */
export function workforceLabel(value) {
  const t = String(value ?? '').trim();
  return (!t || ['null', 'undefined'].includes(t.toLowerCase())) ? NOT_RECORDED : t;
}

/** `wf` key → the employee column it matches. */
const WF_TEXT_FIELDS = {
  department:     'department',
  designation:    'designation',
  employmentType: 'employment_type',
  gender:         'gender',
  skillType:      'skill_type',
  qualification:  'highest_qualification',
};

function matchesWorkforce(emp, wf) {
  for (const [key, col] of Object.entries(WF_TEXT_FIELDS)) {
    if (wf[key] != null && workforceLabel(emp[col]) !== wf[key]) return false;
  }
  if (wf.branchId !== undefined) {
    if (wf.branchId === null) { if (emp.branch_id != null) return false; }
    else if (String(emp.branch_id ?? '') !== String(wf.branchId)) return false;
  }
  return true;
}

const KEY = 'pulse.employeeListFilter';

/** Legacy single-value key still written by HRDashboard's KPI band. */
const LEGACY_STATUS_KEY = 'employeeStatusFilter';

/**
 * Stash a filter for the next page. Call immediately before `setPage`.
 * Returns the filter so it can be inlined in a click handler.
 */
export function setEmployeeListFilter(filter) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(filter || {}));
  } catch {
    // Private mode / quota. The destination simply shows the unfiltered list,
    // which is the pre-existing behaviour — never a crash on a nav click.
  }
  return filter;
}

/**
 * Read the pending filter WITHOUT clearing it.
 *
 * ⚠ Destination pages read this from a `useState` initialiser, and React
 * StrictMode double-invokes initialisers in development. A read-and-clear
 * there would hand the filter to the first invocation and `null` to the
 * second — the one React keeps — so every drill-down would land unfiltered in
 * dev and work in production. Peek here, clear from a mount effect with
 * `clearEmployeeListFilter()`, which is idempotent.
 */
export function peekEmployeeListFilter() {
  let out = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) out = JSON.parse(raw);

    // Fold in the legacy key so HRDashboard's existing KPI band keeps working
    // without having to be migrated in the same change.
    const legacy = sessionStorage.getItem(LEGACY_STATUS_KEY);
    if (legacy) out = { status: legacy, label: `Status: ${legacy}`, ...(out || {}) };
  } catch {
    return null;
  }
  if (!out || typeof out !== 'object') return null;
  // An object carrying only a label is not a filter — it would render a chip
  // that narrows nothing, which is worse than no chip.
  if (Array.isArray(out.ids) && out.ids.length === 0) {
    // An EMPTY id list is a real filter meaning "nobody", not an absent one.
    // Treating it as unfiltered would drop the user on all 33 employees under
    // a chip promising birthdays.
    return out;
  }
  const hasCriteria = ['status', 'department', 'gender', 'skill', 'tenure',
    'joinedFrom', 'joinedTo', 'expiry', 'missing', 'ids']
    .some(k => out[k] != null && out[k] !== '' && out[k] !== 'All'
               && !(Array.isArray(out[k]) && out[k].length === 0));
  return hasCriteria ? out : null;
}

/** Drop the pending filter so a later visit to the page starts clean. */
export function clearEmployeeListFilter() {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(LEGACY_STATUS_KEY);
  } catch { /* nothing to clean up */ }
}

/**
 * The data-quality gaps the dashboard's "Needs attention" tile can drill into.
 * Mirrors the `dataQuality` block the analytics endpoint computes, so the tile
 * and the list it opens count the same records — the SQL there and these
 * predicates have to stay in step, and `employeeDataQuality.contract.test.js`
 * is what checks that they do.
 */
export const MISSING_FIELD_TESTS = {
  joining_date:  (e) => !e.joining_date,
  department:    (e) => !String(e.department  || '').trim(),
  designation:   (e) => !String(e.designation || '').trim(),
  skill_type:    (e) => !String(e.skill_type  || '').trim(),
  // Only meaningful while the employee is actually on probation.
  probation_end: (e) => String(e.status || '').trim().toLowerCase() === 'probation'
                        && !e.probation_end_date,
  // Payroll approval and payment refuse an employee without both (§202).
  bank_details:  (e) => !String(e.account_number || '').trim() || !String(e.ifsc_code || '').trim(),
  address:       (e) => !String(e.current_address || '').trim(),
};

/** Gaps that block a workflow, as opposed to merely degrading reporting. */
export const CRITICAL_MISSING = ['joining_date', 'probation_end', 'bank_details'];

/**
 * The fields that make an employee a complete MASTER RECORD, as opposed to the
 * broader set of gaps the dashboard's "Records needing attention" counts.
 *
 * Two definitions of "incomplete" existed for the same employee: this page's
 * (Employee ID, Department, Role) and MISSING_FIELD_TESTS above (joining date,
 * department, designation, skill_type, probation end). Neither was wrong, but
 * neither said which question it was answering, and they gave different counts
 * for the same row.
 *
 * This one is defined as: **the row would fail `POST /employees` today.** It is
 * exactly `REQUIRED_ON_CREATE` in backend/src/employees/employee.service.js plus
 * `office_id`, which is mandatory but server-generated rather than submitted.
 * `employeeRequiredFields.contract.test.js` parses this array and the backend's
 * and fails if they drift.
 *
 * `skill_type` is deliberately NOT here: it is not required to create an
 * employee, 27 live rows lack it as a seeding artefact, and folding that into
 * this count would bury the records that actually block something. The dashboard
 * still counts it under its own, wider question — which is why the two numbers
 * differ, and why each now names what it measures.
 */
export const MANDATORY_FIELDS = [
  ['office_id',    'Employee ID'],
  // Required by the Add Employee form all along (its label carries the
  // asterisk) but by nothing on the server, so a direct POST could create a
  // half-named person the form could not produce. Added to REQUIRED_ON_CREATE
  // in the 2026-09-29 Add Employee pass; all 46 live rows already have one, so
  // no existing record becomes incomplete by adding it here.
  ['last_name',    'Last name'],
  ['department',   'Department'],
  ['designation',  'Role'],
  ['status',       'Status'],
  ['joining_date', 'Joining date'],
];

/**
 * Sentinel-aware blankness test. Mirrors `isBlank` in displayValue.js — the
 * string 'null' is PRESENT and truthy but carries no information, and a row whose
 * department is the text 'null' is as incomplete as one whose department is NULL.
 */
const NULLISH_TEXT = new Set(['null', 'undefined', 'nan', 'n/a', 'na', '-', '--']);
function fieldIsBlank(value) {
  if (value == null) return true;
  const s = String(value).trim();
  return !s || NULLISH_TEXT.has(s.toLowerCase());
}

/** Human labels for every mandatory field this row is missing. */
export function missingMandatoryFields(emp) {
  return MANDATORY_FIELDS.filter(([k]) => fieldIsBlank(emp?.[k])).map(([, label]) => label);
}

export function hasMissingField(emp, which) {
  if (which === 'critical') return CRITICAL_MISSING.some(k => MISSING_FIELD_TESTS[k](emp));
  if (which === 'any') return Object.values(MISSING_FIELD_TESTS).some(fn => fn(emp));
  const fn = MISSING_FIELD_TESTS[which];
  return fn ? fn(emp) : true;
}

/** Does this employee row satisfy the filter? Used by the list pages. */
export function matchesEmployeeFilter(emp, f, tenureBucketOf) {
  if (!f) return true;
  // An explicit id list wins over everything: it IS the population.
  if (Array.isArray(f.ids) && !f.ids.map(String).includes(String(emp.id))) return false;
  if (f.missing && !hasMissingField(emp, f.missing)) return false;
  if (f.department && (emp.department || 'Unassigned') !== f.department) return false;
  if (f.gender && (emp.gender || 'Not specified') !== f.gender) return false;
  if (f.skill && (emp.skill_type || 'Not specified') !== f.skill) return false;
  if (f.tenure && tenureBucketOf && tenureBucketOf(emp.joining_date) !== f.tenure) return false;
  if (f.wf && !matchesWorkforce(emp, f.wf)) return false;
  if (f.joinedFrom || f.joinedTo) {
    // No joining_date cannot satisfy a joined-between filter — it is unknown,
    // not in range. Returning it would inflate a "new hires" drill-down with
    // people whose start date nobody recorded.
    if (!emp.joining_date) return false;
    const d = String(emp.joining_date).slice(0, 10);
    if (f.joinedFrom && d < f.joinedFrom) return false;
    if (f.joinedTo && d > f.joinedTo) return false;
  }
  return true;
}

/** Short human summary of a filter, for the chip. */
export function describeEmployeeFilter(f) {
  if (!f) return '';
  if (f.label) return f.label;
  const bits = [];
  if (f.status && f.status !== 'All') bits.push(f.status);
  if (f.department) bits.push(f.department);
  if (f.gender) bits.push(f.gender);
  if (f.skill) bits.push(f.skill);
  if (f.tenure) bits.push(`Tenure ${f.tenure}`);
  if (f.joinedFrom || f.joinedTo) bits.push(`Joined ${f.joinedFrom || '…'} – ${f.joinedTo || '…'}`);
  if (f.missing) bits.push(MISSING_LABELS[f.missing] || `Missing ${f.missing}`);
  return bits.join(' · ') || 'Filtered';
}

const MISSING_LABELS = {
  joining_date:  'Missing joining date',
  probation_end: 'Probation with no end date',
  department:    'Missing department',
  designation:   'Missing designation',
  skill_type:    'Missing skill type',
  critical:      'Records blocking a workflow',
  any:           'Records with incomplete data',
};

export default {
  setEmployeeListFilter,
  peekEmployeeListFilter,
  clearEmployeeListFilter,
  matchesEmployeeFilter,
  describeEmployeeFilter,
  hasMissingField,
  MISSING_FIELD_TESTS,
  CRITICAL_MISSING,
  MANDATORY_FIELDS,
  missingMandatoryFields,
};
