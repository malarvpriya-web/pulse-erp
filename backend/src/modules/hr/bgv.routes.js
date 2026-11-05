// ──────────────────────────────────────────────────────────────────────────────
// bgv.routes.js — Employee Background Verification.
//
// Mounted at /api/bgv (and /api/v1/bgv). Every route in this file is gated by
// `requirePermission('bgv', …)` and scoped by joining `employees`.
//
// ── One source of truth for case status ───────────────────────────────────────
// `bgv_cases` has no status column. The case's status is DERIVED from its checks
// by CHECK_ROLLUP + CASE_STATUS, below, and every consumer — the employee list,
// the dashboard KPIs, the detail page, the exports and the compact summary the
// View Employee tab shows — is built from those two constants. That is
// deliberate: the recurring defect in this codebase is two endpoints answering
// the same question differently because each computed it its own way
// ([[project_ceo_dashboard_cross_section_consistency]],
// [[project_employees_dashboard_rebuild_2026-09-27]]). If these are wrong they
// are wrong everywhere at once, which is a bug you can find.
//
// ── Tenant scoping ───────────────────────────────────────────────────────────
// bgv_cases / bgv_checks / bgv_check_contacts / bgv_documents carry NO
// company_id. Authorization always walks to `employees.company_id`, via
// caseScopeSql() / checkScopeSql(). companyOf(req) — never req.user.company_id,
// never a body field. See [[project_company_of_scope_helper]].
//
// ── Status is not Result ─────────────────────────────────────────────────────
// `status` says where the work is, `result` says what it found. They are never
// collapsed, and setting status='Completed' while result is still 'Pending' is
// refused (STATUS_NEEDS_RESULT) — closing a check forces someone to state the
// outcome rather than letting "Completed" be read as "Clear".
// ──────────────────────────────────────────────────────────────────────────────
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import pool from '../../config/db.js';
import { verifyToken, requirePermission, permissionFor } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { logAudit } from '../../services/AuditService.js';
import { uploadFile, LOCAL_UPLOAD_DIR } from '../../services/StorageService.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { toCsv, sendCsv } from '../../shared/csv.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Vocabularies. Mirrored from the CHECK constraints in
// 20260930000010_bgv_foundation.js — a value this file accepts that the column
// rejects is a 500 the user reads as "save failed for no reason", so the two
// lists are asserted equal by bgvVocabulary.contract.test.js rather than left to
// agree by hand.
// ─────────────────────────────────────────────────────────────────────────────
export const CHECK_STATUSES   = ['Pending', 'Initiated', 'In Progress', 'Completed', 'Cancelled'];
export const CHECK_RESULTS    = ['Pending', 'Clear', 'Discrepancy', 'Unable to Verify'];
export const PAYMENT_STATUSES = ['Pending', 'Invoiced', 'Paid', 'Waived'];
export const CONTACT_METHODS  = ['Phone', 'Email', 'Portal', 'Visit', 'Other'];
export const CONTACT_RESPONSES = ['Pending', 'Received', 'No Response', 'Discrepancy'];
export const CONTACT_TYPES    = ['Previous Employer', 'College', 'Reference', 'Address Contact', 'Agency', 'Other'];

/**
 * ── APPLICABILITY ────────────────────────────────────────────────────────────
 * Mirrors the CHECK constraint in 20260930000013_bgv_check_applicability.js.
 *
 *   Required        counted in the progress denominator; blocks closure.
 *   Optional        applies and blocks closure, but is not in the headline.
 *   Not Applicable  a recorded DECISION, not work. Never pending, never blocks
 *                   closure, never in the denominator.
 */
export const APPLICABILITY = ['Required', 'Optional', 'Not Applicable'];

/** The two states that mean "this applies to this employee". */
export const APPLICABLE = ['Required', 'Optional'];

/**
 * ── VERIFICATION PROFILES ────────────────────────────────────────────────────
 *
 * HR was expected to create verification checks one at a time, which is not how
 * anyone actually runs BGV: you decide the SET of checks for a person once, from
 * what kind of hire they are, and then work through it. So a profile is a
 * starting checklist, not a rule — every row is editable before anything is
 * created, and 'custom' starts from nothing.
 *
 * ⚠ The profiles live HERE, server-side, and the frontend fetches them from
 * GET /bgv/profiles. A copy in the page would be a second answer to "what does a
 * fresher need verified" that drifts the first time someone edits one of them —
 * the ~148-vocabulary problem modules/master/vocabularies.js exists to stop.
 *
 * ⚠ FRESHER PRE-SELECTS Employment Verification as **Not Applicable**, rather
 * than leaving it out. Leaving it out loses the record that it was considered;
 * creating it Required leaves a check that can never be satisfied sitting in
 * everyone's pending queue forever. "Not applicable" is the true answer for
 * someone with no previous employer, and recording it is what lets an auditor
 * asking "did you verify their employment?" get "there was none to verify"
 * instead of silence. HR can still switch it to Required.
 *
 * `selected` is "create this row at all"; `applicability` is what to create it
 * as. They are separate because a type nobody selected should leave no trace,
 * while a type selected as Not Applicable should leave exactly one.
 */
const PROFILE_DEFAULTS = {
  fresher: {
    label: 'Fresher',
    description: 'First job — no previous employer to verify.',
    checks: {
      'Identity Verification':   'Required',
      'Address Verification':    'Required',
      'Education Verification':  'Required',
      'Criminal/Court Check':    'Required',
      // The point of the profile, said out loud.
      'Employment Verification': 'Not Applicable',
      'Reference Check':         'Optional',
    },
  },
  experienced: {
    label: 'Experienced',
    description: 'Has prior employment — employment history is verified.',
    checks: {
      'Identity Verification':   'Required',
      'Address Verification':    'Required',
      'Education Verification':  'Required',
      'Employment Verification': 'Required',
      'Criminal/Court Check':    'Required',
      'Reference Check':         'Optional',
      'Professional Reference':  'Optional',
    },
  },
  custom: {
    label: 'Custom',
    description: 'Start from nothing and choose every check yourself.',
    checks: {},
  },
};

export const PROFILE_KEYS = Object.keys(PROFILE_DEFAULTS);

/**
 * A profile's checklist, over the check types that actually exist in the master.
 *
 * ⚠ Built from the LIVE `BGV_CHECK_TYPE` vocabulary rather than from the keys
 * above, so a type a tenant added in Master Data appears in every profile
 * (unselected) instead of being invisible to the checklist — and a type they
 * deactivated stops being offered. A hardcoded list here would have quietly made
 * the master read-only.
 *
 * A profile naming a type the master does not hold is returned too, flagged
 * `missing_from_master`, because silently dropping it would turn a renamed
 * vocabulary value into a check that stopped being offered with no explanation.
 */
export function profileChecklist(profileKey, masterTypes) {
  const profile = PROFILE_DEFAULTS[profileKey];
  if (!profile) return null;

  const seen = new Set();
  const rows = masterTypes.map((type) => {
    seen.add(type.toLowerCase());
    const applicability = profile.checks[type] ?? null;
    return {
      check_type: type,
      // Unselected rows carry a sensible applicability for the moment HR ticks
      // them, rather than an empty control.
      applicability: applicability ?? 'Required',
      selected: applicability !== null && applicability !== undefined,
      missing_from_master: false,
    };
  });

  for (const [type, applicability] of Object.entries(profile.checks)) {
    if (seen.has(type.toLowerCase())) continue;
    rows.push({ check_type: type, applicability, selected: true, missing_from_master: true });
  }

  return { key: profileKey, label: profile.label, description: profile.description, checks: rows };
}

/** The derived case statuses. Every KPI card and the list filter use this list. */
export const CASE_STATUSES = ['Not Started', 'Initiated', 'In Progress', 'Completed', 'Discrepancy', 'Closed'];

/**
 * ── Why the five SQL constants below are EXPORTED ────────────────────────────
 * bgvIntegration.integration.test.js runs them against the real database. It
 * used to lift them out of this file with a regex, which is a copy by another
 * name: it kept passing after the text it was scraping changed shape. Exporting
 * them means the test executes the same string production executes, which is the
 * only version of "one source of truth" that a test can actually hold you to.
 * Nothing outside the tests imports them.
 */

/**
 * Per-case rollup of the checks below it.
 *
 * A LATERAL rather than a GROUP BY because the outer query joins `employees` as
 * well, and a GROUP BY over a multi-child join is how a count silently doubles —
 * [[project_sql_fanout_multi_child_join]]. `missing_reports` counts checks with
 * no row in bgv_documents, which is what the "Pending Reports" KPI means.
 *
 * `total_cost` uses SUM over a NULLable total_amount, so a check whose cost has
 * not been captured contributes nothing rather than a zero that reads as free.
 */
export const CHECK_ROLLUP = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int                                                          AS total,
           -- ── APPLICABILITY ────────────────────────────────────────────────
           -- A 'Not Applicable' check is a recorded DECISION, not outstanding
           -- work: a fresher has no previous employer, so Employment
           -- Verification for them is not pending, it does not block closure,
           -- and it is not in the progress denominator. Every aggregate below
           -- that means "work" therefore filters it out, and the three that
           -- describe the checklist itself count it deliberately.
           COUNT(*) FILTER (WHERE ch.applicability = 'Required')::int             AS required_total,
           COUNT(*) FILTER (WHERE ch.applicability = 'Optional')::int             AS optional_total,
           COUNT(*) FILTER (WHERE ch.applicability = 'Not Applicable')::int       AS not_applicable,
           COUNT(*) FILTER (WHERE ch.applicability IN ('Required','Optional'))::int AS applicable_total,

           -- The headline figure: "4 / 6 Required Checks Completed".
           -- ⚠ Cancelled counts as RESOLVED, not completed. A cancelled check is
           -- finished work (HR abandoned it, with a reason on the check) so it
           -- must not hold the case open — but it did not verify anything, so it
           -- must not inflate the completion figure either.
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.status = 'Completed')::int                   AS required_completed,
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.status IN ('Initiated','In Progress'))::int  AS required_in_progress,
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.status = 'Pending')::int                     AS required_pending,
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.status = 'Cancelled')::int                   AS required_cancelled,
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.result = 'Discrepancy')::int                 AS required_discrepancies,

           -- ⚠ open_applicable is the closure guard's population: an APPLICABLE
           -- check that is neither Completed nor Cancelled. Required and Optional
           -- both count — an Optional check someone started is real work — while
           -- Not Applicable never does.
           --
           -- ⚠ NO BACKTICKS anywhere in this template literal, comments
           -- included. One in a SQL comment here ends the JS string and the file
           -- stops parsing; it has broken the boot in this repo before.
           -- [[project_backtick_in_sql_comment_breaks_boot]]
           COUNT(*) FILTER (WHERE ch.applicability IN ('Required','Optional')
                              AND ch.status IN ('Pending','Initiated','In Progress'))::int AS open_applicable,

           -- ⚠⚠ open_required is the CLOSURE GUARD's population, and it is
           -- narrower than open_applicable on purpose.
           --
           -- Only an unresolved REQUIRED check blocks a case. An Optional one
           -- does not: HR may skip it, and holding the whole case open for work
           -- nobody decided was necessary is how a case stays open forever over
           -- a nice-to-have reference check. open_applicable still reports the
           -- Optional ones so the page can show them as outstanding — being
           -- visible and being blocking are different things.
           COUNT(*) FILTER (WHERE ch.applicability = 'Required'
                              AND ch.status IN ('Pending','Initiated','In Progress'))::int AS open_required,
           COUNT(*) FILTER (WHERE ch.applicability = 'Optional'
                              AND ch.status IN ('Pending','Initiated','In Progress'))::int AS open_optional,

           COUNT(*) FILTER (WHERE ch.status = 'Completed')::int                   AS completed,
           COUNT(*) FILTER (WHERE ch.status = 'Cancelled')::int                   AS cancelled,
           -- pending now means "applicable and unresolved", which is what every
           -- caller already believed it meant. Before applicability existed the
           -- two were the same thing; they are not any more, and a Not Applicable
           -- check showing in a "Pending" column is the misleading 0/1 the brief
           -- called out.
           COUNT(*) FILTER (WHERE ch.applicability IN ('Required','Optional')
                              AND ch.status IN ('Pending','Initiated','In Progress'))::int AS pending,
           COUNT(*) FILTER (WHERE ch.applicability IN ('Required','Optional')
                              AND ch.status IN ('Initiated','In Progress'))::int   AS working,
           COUNT(*) FILTER (WHERE ch.result = 'Discrepancy')::int                 AS discrepancies,
           COUNT(*) FILTER (WHERE ch.result = 'Unable to Verify')::int            AS unable_to_verify,
           COUNT(*) FILTER (WHERE ch.result = 'Clear')::int                       AS clear,
           -- A report is only outstanding for a check that applies and was not
           -- cancelled. Chasing a report for a Not Applicable check is chasing
           -- paperwork for work nobody did.
           COUNT(*) FILTER (
             WHERE ch.applicability IN ('Required','Optional')
               AND ch.status <> 'Cancelled'
               AND NOT EXISTS (SELECT 1 FROM bgv_documents d WHERE d.check_id = ch.id AND d.deleted_at IS NULL)
           )::int                                                                 AS missing_reports,
           COUNT(*) FILTER (
             WHERE ch.applicability IN ('Required','Optional')
               AND ch.status NOT IN ('Completed','Cancelled')
               AND ch.expected_date IS NOT NULL
               AND ch.expected_date < CURRENT_DATE
           )::int                                                                 AS overdue,
           -- Cost is NOT filtered by applicability: a check ruled Not Applicable
           -- after an agency had already been paid still cost money, and a spend
           -- report that hid it would not reconcile against the invoices.
           SUM(ch.total_amount)                                                   AS total_cost,
           SUM(ch.total_amount) FILTER (WHERE ch.payment_status IN ('Pending','Invoiced')) AS unpaid_cost,
           MIN(ch.request_date)                                                   AS first_request_date,
           MAX(ch.completed_date)                                                 AS last_completed_date,
           MAX(GREATEST(ch.updated_at, ch.created_at))                            AS last_check_change
      FROM bgv_checks ch
     WHERE ch.case_id = c.id
  ) k ON true`;

/**
 * The case's status, from its checks.
 *
 * Order matters and each branch is a decision:
 *   Closed       an explicit HR act — the only STORED lifecycle fact.
 *   Not Started  a case row with no checks is not "initiated", it is an empty
 *                folder. Employees with no case row at all also land here,
 *                because `k.total` is 0 across the LEFT JOIN.
 *   Discrepancy  ANY discrepancy outranks "all done". A case that finished with
 *                a finding must not read as Completed — that is the whole point
 *                of keeping result separate from status.
 *   Completed    every check is Completed or Cancelled.
 *   In Progress  something is actually being worked or has finished.
 *   Initiated    checks exist but all are still Pending.
 */
export const CASE_STATUS = `
  CASE
    WHEN c.id IS NULL                                  THEN 'Not Started'
    WHEN c.closed_at IS NOT NULL                       THEN 'Closed'
    WHEN COALESCE(k.total, 0) = 0                      THEN 'Not Started'
    WHEN k.discrepancies > 0                           THEN 'Discrepancy'
    WHEN k.completed + k.cancelled = k.total           THEN 'Completed'
    WHEN k.working > 0 OR k.completed > 0              THEN 'In Progress'
    ELSE 'Initiated'
  END`;

/**
 * The columns every case-shaped response returns. One list so the employee list,
 * the detail page and the exports cannot describe the same case differently.
 */
export const CASE_SELECT = `
  e.id                        AS employee_id,
  e.office_id                 AS employee_code,
  TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
  e.department, e.designation, e.joining_date, e.status AS employment_status,
  c.id                        AS case_id,
  c.initiated_on, c.closed_at, c.closure_remarks, c.remarks,
  c.reopened_at, c.reopen_reason,
  c.primary_agency_id,
  ag.agency_name              AS primary_agency_name,
  ${CASE_STATUS}              AS bgv_status,
  COALESCE(k.total, 0)        AS checks_total,
  COALESCE(k.completed, 0)    AS checks_completed,
  COALESCE(k.pending, 0)      AS checks_pending,
  -- ── The progress breakdown the brief asked for, so no screen has to derive
  -- it and none of them can derive it differently ──────────────────────────
  COALESCE(k.required_total, 0)          AS required_total,
  COALESCE(k.required_completed, 0)      AS required_completed,
  COALESCE(k.required_in_progress, 0)    AS required_in_progress,
  COALESCE(k.required_pending, 0)        AS required_pending,
  COALESCE(k.required_cancelled, 0)      AS required_cancelled,
  COALESCE(k.required_discrepancies, 0)  AS required_discrepancies,
  COALESCE(k.optional_total, 0)          AS optional_total,
  COALESCE(k.not_applicable, 0)          AS not_applicable,
  COALESCE(k.applicable_total, 0)        AS applicable_total,
  COALESCE(k.open_applicable, 0)         AS open_applicable,
  COALESCE(k.open_required, 0)           AS open_required,
  COALESCE(k.open_optional, 0)           AS open_optional,
  -- Completion over REQUIRED checks only, and NULL — not 0 — when there are
  -- none. Zero percent of nothing is not "no progress", it is "nothing
  -- required", and a progress bar sitting at zero for a case with no required
  -- checks is the same class of lie as the 0/1 count this replaces.
  CASE WHEN COALESCE(k.required_total, 0) = 0 THEN NULL
       ELSE ROUND(100.0 * k.required_completed / k.required_total)::int
  END                                    AS required_completion_pct,
  COALESCE(k.cancelled, 0)    AS checks_cancelled,
  COALESCE(k.discrepancies, 0) AS checks_discrepancy,
  COALESCE(k.unable_to_verify, 0) AS checks_unable,
  COALESCE(k.clear, 0)        AS checks_clear,
  COALESCE(k.missing_reports, 0) AS reports_missing,
  COALESCE(k.overdue, 0)      AS checks_overdue,
  k.total_cost, k.unpaid_cost,
  k.first_request_date, k.last_completed_date,
  GREATEST(COALESCE(k.last_check_change, c.updated_at), COALESCE(c.updated_at, k.last_check_change)) AS last_updated`;

/**
 * The FROM/JOIN spine shared by the list, the KPI counts and the exports.
 *
 * Driven from `employees`, LEFT JOIN to the case: the list has to show an
 * employee whose BGV has not been started, or the "Not Started" KPI would have
 * no population to open and would be exactly the fake filter the brief forbids.
 *
 * $1 is always the caller's company. Written as
 * `($1::int IS NULL OR e.company_id = $1::int)` — a genuinely global super-admin
 * scope, never a forgotten predicate; see [[project_company_of_scope_helper]].
 */
export const CASE_FROM = `
  FROM employees e
  LEFT JOIN bgv_cases c   ON c.employee_id = e.id
  LEFT JOIN bgv_agencies ag ON ag.id = c.primary_agency_id
  ${CHECK_ROLLUP}
  WHERE e.deleted_at IS NULL
    AND ($1::int IS NULL OR e.company_id = $1::int)`;

// ── Scope predicates for the single-record routes ────────────────────────────
// Each is a full subquery so it can be dropped into any statement without the
// caller having to get a join right. `$n` is the company binding.

/**
 * A verification check's contact, resolved.
 *
 * ── THE AGENCY MASTER IS THE SINGLE SOURCE OF TRUTH ──────────────────────────
 * `bgv_checks.contact_person / contact_email / contact_phone` are an OVERRIDE,
 * not a copy. NULL means "whoever the agency master says", so a check normally
 * stores no contact at all and updating the agency's phone number updates every
 * check that uses it — which is the whole point of having a master.
 *
 * This replaced three free-text fields HR had to retype on every single check
 * even though they had just picked the agency from the master two fields above.
 * That is not merely tedious: a retyped contact is a second copy that goes stale
 * the moment the agency changes hands, and then the record says who we used to
 * call. Exactly the drift the vocabulary registry exists to prevent
 * ([[project_master_data_vocabulary_registry]]) — the same mistake in the shape
 * of a contact card rather than a dropdown.
 *
 * `effective_*` is computed HERE rather than in each consumer so the detail page,
 * the folder view and any future export cannot disagree about which contact a
 * check actually used. `contact_is_override` tells the UI whether to draw the
 * read-only agency contact or the overridden one.
 */
export const CHECK_CONTACT_SELECT = `
  ag.contact_person AS agency_contact_person,
  ag.email          AS agency_contact_email,
  ag.phone          AS agency_contact_phone,
  COALESCE(ch.contact_person, ag.contact_person) AS effective_contact_person,
  COALESCE(ch.contact_email,  ag.email)          AS effective_contact_email,
  COALESCE(ch.contact_phone,  ag.phone)          AS effective_contact_phone,
  (ch.contact_person IS NOT NULL
   OR ch.contact_email IS NOT NULL
   OR ch.contact_phone IS NOT NULL)              AS contact_is_override`;

/** A bgv_cases.id the caller may touch. */
export const caseScopeSql = (n) => `
  id IN (SELECT c.id FROM bgv_cases c
           JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
          WHERE ($${n}::int IS NULL OR e.company_id = $${n}::int))`;

/** A bgv_checks.id the caller may touch. */
export const checkScopeSql = (n) => `
  id IN (SELECT ch.id FROM bgv_checks ch
           JOIN bgv_cases c  ON c.id = ch.case_id
           JOIN employees e  ON e.id = c.employee_id AND e.deleted_at IS NULL
          WHERE ($${n}::int IS NULL OR e.company_id = $${n}::int))`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers. ⚠ ALL declared before the first router.<verb>() call. A route
// registered above a `const` helper it uses is a TDZ error that kills the server
// at boot and that eslint cannot see —
// [[project_master_data_governance_2026-09-29]].
// ─────────────────────────────────────────────────────────────────────────────

const bad = (res, message, code) => res.status(400).json(code ? { message, code } : { message });

const intId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A date the client sent, or null.
 *
 * `''` from an untouched date input must become NULL, not the string '' (which
 * Postgres rejects for a DATE) — and the literal string 'null' must too.
 * FormData stringifies everything, so an untouched picker arrives as "null" and
 * beats every truthiness guard; that is the defect that stopped every employee
 * being saved from the Add Employee form
 * ([[project_view_employee_review_2026-09-30]]).
 */
const dateOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
};

const textOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
};

/** A money field: null when not captured, a number when it is. Never NaN. */
const moneyOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  const n = Number(s);
  // ⚠ NOT `Number(v) ?? fallback` — that never falls through, because NaN is
  // not nullish, and NaN into a NUMERIC column is a 500.
  // [[project_pulse01_env_write_rbac_killswitch]] found five of those.
  return Number.isFinite(n) ? n : null;
};

const oneOf = (v, list, fallback = null) => {
  const s = String(v ?? '').trim();
  return list.find(x => x.toLowerCase() === s.toLowerCase()) ?? fallback;
};

const actor = (req) => req.user?.userId ?? req.user?.id ?? null;

/**
 * Is this agency one the caller may reference?
 *
 * Called on every write that accepts an agency_id. The FK alone is not enough:
 * it proves the agency EXISTS, not that it belongs to this tenant, and an
 * attacker-supplied id from another company would otherwise attach their vendor
 * to our checks and pull it into our spend reports. Returns true for a null id
 * (no agency chosen is legitimate).
 */
async function agencyInScope(agencyId, companyId, db = pool) {
  if (agencyId == null) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM bgv_agencies
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int)`,
    [agencyId, companyId]
  );
  return rows.length > 0;
}

/**
 * ── SENSITIVE DISCREPANCY DETAIL ─────────────────────────────────────────────
 * May this caller read what a discrepancy actually FOUND?
 *
 * `bgv:view` is the right to run background verification. This is the right to
 * read the finding — the free-text remarks, the follow-up notes, the contact
 * notes and the report itself — on a check that came back Discrepancy. Seeded to
 * super_admin / admin / hr / hr_manager, and explicitly NOT to hr_exec, the
 * "HR operations" tier. See 20260930000011_bgv_sensitive_permission.js.
 *
 * ⚠ Resolved through permissionFor(), like every other gate in this file, so a
 * user-level override in `permissions` beats the role default exactly as it does
 * elsewhere. A hardcoded role list here would be a second, divergent answer to a
 * question the matrix already answers.
 *
 * ⚠ Cached on the request. It is consulted once per check, once per folder and
 * once per contact row, and permissionFor() already memoises per request — this
 * is belt and braces so a 40-check case cannot turn into 40 lookups if that
 * memoisation ever changes.
 */
async function canSeeSensitive(req) {
  if (req._bgvSensitive !== undefined) return req._bgvSensitive;
  let allowed = false;
  try {
    const perm = await permissionFor(req, 'bgv_sensitive');
    allowed = perm?.can_view === true;
  } catch { allowed = false; }
  req._bgvSensitive = allowed;
  return allowed;
}

/**
 * Is this check's detail sensitive?
 *
 * Only a Discrepancy result restricts anything. 'Unable to Verify' deliberately
 * does NOT: it means the agency could not reach the source, which is an
 * operational fact the HR executive chasing it has to be able to read — treating
 * it as a finding would hide ordinary follow-up work behind a permission and
 * leave the check looking abandoned.
 */
export const isSensitiveCheck = (row) => row?.result === 'Discrepancy';

/** What a check looks like to a caller who may not read its findings. */
const REDACTED = 'Restricted — visible to HR Manager / Admin only';

/**
 * Strip the findings from a check row, in place of a caller without the grant.
 *
 * The check still reports its type, agency, dates, cost, status AND result — so
 * a normal HR user sees that it came back Discrepancy and stops chasing it. Only
 * the narrative and the paperwork are withheld, and the row says so rather than
 * returning an empty string that reads as "nothing was written".
 */
export function redactCheck(row) {
  if (!isSensitiveCheck(row)) return { ...row, detail_restricted: false };
  return {
    ...row,
    remarks:        row.remarks        ? REDACTED : null,
    followup_notes: row.followup_notes ? REDACTED : null,
    cost_remarks:   row.cost_remarks   ? REDACTED : null,
    detail_restricted: true,
  };
}

/** The agency's own contact card, for the de-duplication rule below. */
async function agencyContact(agencyId, companyId, db = pool) {
  if (agencyId == null) return null;
  const { rows } = await db.query(
    `SELECT contact_person, email, phone FROM bgv_agencies
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int)`,
    [agencyId, companyId]
  );
  return rows[0] ?? null;
}

/**
 * Collapse a per-check contact that merely REPEATS the agency's into NULL.
 *
 * "Do not create duplicate agency/contact records." The UI sends no contact at
 * all when HR has not pressed "Use different contact", but the API is also
 * reachable directly and a client can round-trip the read-only values straight
 * back — which would silently mint the duplicate copy the master exists to
 * prevent, and freeze it at today's value.
 *
 * So the rule lives on the server: a submitted contact field equal to the
 * agency's (case- and whitespace-insensitively, because a copy-paste picks up
 * stray spaces) is stored as NULL, i.e. "use the master". Only a genuinely
 * DIFFERENT contact is kept as an override.
 *
 * Returns the three fields as they should be stored.
 */
export function dedupeContact({ contact_person, contact_email, contact_phone }, agency) {
  if (!agency) return { contact_person, contact_email, contact_phone };
  const same = (a, b) =>
    a != null && b != null &&
    String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  return {
    contact_person: same(contact_person, agency.contact_person) ? null : contact_person,
    contact_email:  same(contact_email,  agency.email)          ? null : contact_email,
    contact_phone:  same(contact_phone,  agency.phone)          ? null : contact_phone,
  };
}

/**
 * The case a caller names, with its employee, or null.
 *
 * Every per-case route resolves through here so the tenant check happens once
 * and in one place, rather than being a predicate each handler has to remember.
 */
async function loadCase(caseId, companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT c.*, e.company_id, e.office_id,
            TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
       FROM bgv_cases c
       JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
      WHERE c.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)`,
    [caseId, companyId]
  );
  return rows[0] ?? null;
}

/** The check a caller names, with its case and employee, or null. */
async function loadCheck(checkId, companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT ch.*, c.employee_id, c.closed_at AS case_closed_at, e.company_id
       FROM bgv_checks ch
       JOIN bgv_cases c ON c.id = ch.case_id
       JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
      WHERE ch.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)`,
    [checkId, companyId]
  );
  return rows[0] ?? null;
}

/**
 * Does the stored file actually exist?
 *
 * The brief: if the physical file is missing, say "File not in storage" — never
 * a misleading "On file". Five of one employee's five document columns pointed
 * at files that were not on disk ([[project_view_employee_review_2026-09-30]]),
 * and the only way to find out was to click and get an error. So the list
 * endpoint answers it, rather than the page guessing.
 *
 * Only meaningful for the local provider: with S3/R2 the URL is absolute and the
 * bytes are not on this box, so `null` means "not checked here" and the UI says
 * nothing rather than asserting either answer.
 */
function fileOnDisk(fileUrl) {
  const s = String(fileUrl || '');
  if (!s.startsWith('/uploads/')) return null;
  try {
    return fs.existsSync(path.join(LOCAL_UPLOAD_DIR, path.basename(s)));
  } catch {
    return null;
  }
}

/** Build the optional filter clauses the list, the KPIs and the exports share. */
function listFilters(query, startIndex) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  const add = (sql, ...vals) => { clauses.push(sql); params.push(...vals); i += vals.length; };

  // "Search should work by employee name / employee ID."
  const search = textOrNull(query.search);
  if (search) {
    add(`(LOWER(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))) LIKE $${i}
          OR LOWER(COALESCE(e.office_id,'')) LIKE $${i})`, `%${search.toLowerCase()}%`);
  }
  if (intId(query.employee_id))  add(`e.id = $${i}`, intId(query.employee_id));
  if (textOrNull(query.department))  add(`e.department = $${i}`, textOrNull(query.department));
  if (textOrNull(query.designation)) add(`e.designation = $${i}`, textOrNull(query.designation));
  if (dateOrNull(query.joined_from)) add(`e.joining_date >= $${i}::date`, dateOrNull(query.joined_from));
  if (dateOrNull(query.joined_to))   add(`e.joining_date <= $${i}::date`, dateOrNull(query.joined_to));

  // Agency matches the case's primary agency OR any check's agency — a case can
  // use more than one vendor, and a filter that only read the primary would hide
  // every employee whose Education check went to a second agency.
  if (intId(query.agency_id)) {
    add(`(c.primary_agency_id = $${i}
          OR EXISTS (SELECT 1 FROM bgv_checks ch2 WHERE ch2.case_id = c.id AND ch2.agency_id = $${i}))`,
      intId(query.agency_id));
  }
  if (textOrNull(query.check_type)) {
    add(`EXISTS (SELECT 1 FROM bgv_checks ch3 WHERE ch3.case_id = c.id AND ch3.check_type = $${i})`,
      textOrNull(query.check_type));
  }
  // A check-level status/result filter, distinct from the case status below:
  // "show me everyone who has a Failed/Discrepancy check".
  if (oneOf(query.check_status, CHECK_STATUSES)) {
    add(`EXISTS (SELECT 1 FROM bgv_checks ch4 WHERE ch4.case_id = c.id AND ch4.status = $${i})`,
      oneOf(query.check_status, CHECK_STATUSES));
  }
  if (oneOf(query.check_result, CHECK_RESULTS)) {
    add(`EXISTS (SELECT 1 FROM bgv_checks ch5 WHERE ch5.case_id = c.id AND ch5.result = $${i})`,
      oneOf(query.check_result, CHECK_RESULTS));
  }
  // Date range over BGV activity, not over the employee record.
  if (dateOrNull(query.from)) add(`EXISTS (SELECT 1 FROM bgv_checks ch6 WHERE ch6.case_id = c.id
        AND COALESCE(ch6.request_date, ch6.created_at::date) >= $${i}::date)`, dateOrNull(query.from));
  if (dateOrNull(query.to))   add(`EXISTS (SELECT 1 FROM bgv_checks ch7 WHERE ch7.case_id = c.id
        AND COALESCE(ch7.request_date, ch7.created_at::date) <= $${i}::date)`, dateOrNull(query.to));

  if (moneyOrNull(query.cost_min) != null) add(`COALESCE(k.total_cost, 0) >= $${i}`, moneyOrNull(query.cost_min));
  if (moneyOrNull(query.cost_max) != null) add(`COALESCE(k.total_cost, 0) <= $${i}`, moneyOrNull(query.cost_max));

  if (String(query.current_only ?? 'true') !== 'false') clauses.push(isCurrentSql('e.status'));

  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params, nextIndex: i };
}

/**
 * Filters applied AFTER the rollup, because they read the derived case status.
 *
 * Kept separate from listFilters so it is obvious which predicates can go in the
 * WHERE clause and which have to wrap the whole thing — putting `bgv_status` in
 * the inner WHERE is a "column does not exist" 500, and putting it in a HAVING
 * over a LATERAL is not available either.
 */
function derivedFilters(query, startIndex) {
  const clauses = [];
  const params = [];
  let i = startIndex;
  const status = oneOf(query.status, CASE_STATUSES);
  if (status) { clauses.push(`bgv_status = $${i}`); params.push(status); i += 1; }
  // "Employees Under BGV" — at least one check exists.
  //
  // ⚠ This filter exists because the KPI needed it. The card originally carried
  // an EMPTY filter, so it counted 1 and opened a list of 32: the exact "fake
  // filter that doesn't actually change the population" the brief forbids. Found
  // by driving the real API and asserting every card against the list its own
  // filter produces (bgvKpiFilters.integration.test.js now does that
  // permanently), not by reading the code.
  if (String(query.has_checks ?? '') === 'true')  clauses.push(`checks_total > 0`);
  if (String(query.has_checks ?? '') === 'false') clauses.push(`checks_total = 0`);
  // The "Pending Reports" KPI's population: at least one non-cancelled check
  // with no report attached.
  if (String(query.pending_reports ?? '') === 'true') clauses.push(`reports_missing > 0`);
  if (String(query.overdue ?? '') === 'true')         clauses.push(`checks_overdue > 0`);
  if (String(query.unpaid ?? '') === 'true')          clauses.push(`COALESCE(unpaid_cost, 0) > 0`);
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params, nextIndex: i };
}

/** The full employee-BGV list statement, filters and all. */
function buildListQuery(req, { limit = 500 } = {}) {
  const companyId = companyOf(req);
  const f = listFilters(req.query, 2);
  const d = derivedFilters(req.query, f.nextIndex);
  const sql = `
    WITH rows AS (
      SELECT ${CASE_SELECT}
      ${CASE_FROM}${f.sql}
    )
    SELECT * FROM rows${d.sql}
     ORDER BY last_updated DESC NULLS LAST, employee_name
     LIMIT ${Number(limit)}`;
  return { sql, params: [companyId, ...f.params, ...d.params], companyId };
}

const SORTABLE = new Set([
  'employee_name', 'employee_code', 'department', 'designation', 'joining_date',
  'bgv_status', 'checks_total', 'checks_completed', 'checks_pending', 'total_cost', 'last_updated',
]);

// Auth applies to the whole router. `verifyToken` first so requirePermission
// always has a req.user to work from.
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────────────────────
// Agencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /bgv/agencies
 *
 * `?active=true` for the pickers, no filter for the management screen — a
 * deactivated agency must stay visible and recoverable there, which is the gap
 * [[project_master_data_governance_2026-09-29]] found (deactivated values were
 * invisible AND unrecoverable).
 */
router.get('/agencies', requirePermission('bgv', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  const activeOnly = String(req.query.active ?? '') === 'true';
  try {
    const { rows } = await pool.query(
      `SELECT a.*,
              (SELECT COUNT(*)::int FROM bgv_checks ch WHERE ch.agency_id = a.id) AS checks_count,
              (SELECT SUM(ch.total_amount) FROM bgv_checks ch WHERE ch.agency_id = a.id) AS total_billed
         FROM bgv_agencies a
        WHERE ($1::int IS NULL OR a.company_id = $1::int)
          ${activeOnly ? 'AND a.is_active = true' : ''}
        ORDER BY a.is_active DESC, LOWER(a.agency_name)`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/agencies', requirePermission('bgv', 'add'), async (req, res) => {
  const companyId = companyOf(req);
  // A scoped caller with no company cannot create a tenant record, and a global
  // super-admin has no tenant to file it under. Refused rather than written with
  // a NULL company_id, which would make the agency visible to every tenant.
  if (companyId == null) return bad(res, 'No company in scope — cannot create an agency.');

  const agency_name = textOrNull(req.body?.agency_name);
  if (!agency_name) return bad(res, 'Agency name is required');

  const services = Array.isArray(req.body?.services)
    ? req.body.services.map(s => String(s).trim()).filter(Boolean)
    : [];

  try {
    const { rows } = await pool.query(
      `INSERT INTO bgv_agencies
         (company_id, agency_name, contact_person, email, phone, address, website,
          gstin, services, is_active, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12)
       RETURNING *`,
      [companyId, agency_name,
       textOrNull(req.body?.contact_person), textOrNull(req.body?.email), textOrNull(req.body?.phone),
       textOrNull(req.body?.address), textOrNull(req.body?.website),
       textOrNull(req.body?.gstin)?.toUpperCase() ?? null,
       JSON.stringify(services),
       req.body?.is_active === false ? false : true,
       textOrNull(req.body?.notes), actor(req)]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_agency',
               action: 'create', newData: rows[0], req, company_id: companyId });
    res.status(201).json(rows[0]);
  } catch (err) {
    // 23505 on ux_bgv_agencies_company_name — the case-insensitive duplicate.
    if (err.code === '23505') {
      return res.status(409).json({ message: `An agency named "${agency_name}" already exists.` });
    }
    res.status(500).json({ message: err.message });
  }
});

router.put('/agencies/:id', requirePermission('bgv', 'edit'), captureBefore('bgv_agencies'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid agency id');
  const companyId = companyOf(req);

  const services = req.body?.services === undefined
    ? null
    : JSON.stringify((Array.isArray(req.body.services) ? req.body.services : [])
        .map(s => String(s).trim()).filter(Boolean));

  try {
    const { rows } = await pool.query(
      `UPDATE bgv_agencies SET
         agency_name    = COALESCE($1, agency_name),
         contact_person = $2, email = $3, phone = $4, address = $5, website = $6,
         gstin          = $7,
         services       = COALESCE($8::jsonb, services),
         is_active      = COALESCE($9, is_active),
         notes          = $10,
         updated_by     = $11,
         updated_at     = NOW()
       WHERE id = $12 AND ($13::int IS NULL OR company_id = $13::int)
       RETURNING *`,
      [textOrNull(req.body?.agency_name),
       textOrNull(req.body?.contact_person), textOrNull(req.body?.email), textOrNull(req.body?.phone),
       textOrNull(req.body?.address), textOrNull(req.body?.website),
       textOrNull(req.body?.gstin)?.toUpperCase() ?? null,
       services,
       typeof req.body?.is_active === 'boolean' ? req.body.is_active : null,
       textOrNull(req.body?.notes), actor(req), id, companyId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Agency not found' });
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_agency',
               action: 'update', oldData: req._auditBefore ?? null, newData: rows[0], req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Another agency already has that name.' });
    res.status(500).json({ message: err.message });
  }
});

/**
 * DELETE /bgv/agencies/:id — deactivate, never destroy.
 *
 * `bgv_checks.agency_id` is ON DELETE SET NULL, so a hard delete would silently
 * detach every historical check from the vendor that performed it and from the
 * invoice that paid for it, leaving spend-by-agency permanently short. The
 * agency is deactivated instead: it stops being offered, and every past check
 * still names it. Same rule the master-data governance pass settled on.
 */
router.delete('/agencies/:id', requirePermission('bgv', 'delete'), captureBefore('bgv_agencies'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid agency id');
  const companyId = companyOf(req);
  try {
    const { rows } = await pool.query(
      `UPDATE bgv_agencies SET is_active = false, updated_by = $1, updated_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3::int)
        RETURNING id, agency_name, is_active`,
      [actor(req), id, companyId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Agency not found' });
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_agency',
               action: 'deactivate', oldData: req._auditBefore ?? null, newData: rows[0], req, company_id: companyId });
    res.json({ message: `${rows[0].agency_name} deactivated`, agency: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /bgv/dashboard
 *
 * Every KPI here is a COUNT over the same CTE the employee list serves, and each
 * one names the list filter that reproduces it (`filter` in the response). The
 * frontend uses that string to navigate, so a card and the list it opens cannot
 * disagree about the population — "Do not create fake filters that don't
 * actually change the population."
 */
router.get('/dashboard', requirePermission('bgv', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  const f = listFilters(req.query, 2);
  const params = [companyId, ...f.params];
  const cte = `
    WITH rows AS (
      SELECT ${CASE_SELECT}
      ${CASE_FROM}${f.sql}
    )`;
  try {
    const [kpi, byAgency, byType, byMonth, byDept] = await Promise.all([
      pool.query(`${cte}
        SELECT COUNT(*)::int                                                     AS employees_total,
               COUNT(*) FILTER (WHERE checks_total > 0)::int                     AS under_bgv,
               COUNT(*) FILTER (WHERE bgv_status = 'Not Started')::int           AS not_started,
               COUNT(*) FILTER (WHERE bgv_status = 'Initiated')::int             AS initiated,
               COUNT(*) FILTER (WHERE bgv_status = 'In Progress')::int           AS in_progress,
               COUNT(*) FILTER (WHERE bgv_status = 'Completed')::int             AS completed,
               COUNT(*) FILTER (WHERE bgv_status = 'Discrepancy')::int           AS discrepancy,
               COUNT(*) FILTER (WHERE bgv_status = 'Closed')::int                AS closed,
               COUNT(*) FILTER (WHERE reports_missing > 0)::int                  AS pending_reports,
               COUNT(*) FILTER (WHERE checks_overdue > 0)::int                   AS overdue,
               SUM(total_cost)                                                   AS total_spend,
               SUM(unpaid_cost)                                                  AS pending_payments
          FROM rows`, params),

      // Spend rollups read bgv_checks directly, scoped by the same employee join
      // the CTE uses. They are per-CHECK, not per-employee, so they cannot be
      // derived from `rows` without double counting a case with two agencies.
      pool.query(`${cte}
        SELECT COALESCE(ag.agency_name, '(no agency recorded)') AS label,
               COUNT(*)::int AS checks,
               SUM(ch.total_amount) AS amount,
               SUM(ch.total_amount) FILTER (WHERE ch.payment_status IN ('Pending','Invoiced')) AS unpaid
          FROM bgv_checks ch
          JOIN rows r ON r.case_id = ch.case_id
          LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
         GROUP BY 1 ORDER BY amount DESC NULLS LAST`, params),

      pool.query(`${cte}
        SELECT ch.check_type AS label, COUNT(*)::int AS checks, SUM(ch.total_amount) AS amount
          FROM bgv_checks ch JOIN rows r ON r.case_id = ch.case_id
         GROUP BY 1 ORDER BY amount DESC NULLS LAST`, params),

      // Bucketed on the date the spend was INCURRED (the request), falling back
      // to when the row was written. Not on payment_date: an unpaid check still
      // belongs to the month it was ordered in, and bucketing by payment would
      // make every unpaid check vanish from the trend.
      pool.query(`${cte}
        SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(ch.request_date, ch.created_at::date)), 'YYYY-MM') AS label,
               COUNT(*)::int AS checks, SUM(ch.total_amount) AS amount
          FROM bgv_checks ch JOIN rows r ON r.case_id = ch.case_id
         GROUP BY 1 ORDER BY 1`, params),

      pool.query(`${cte}
        SELECT COALESCE(NULLIF(TRIM(r.department), ''), '(no department)') AS label,
               COUNT(DISTINCT r.employee_id)::int AS employees,
               SUM(r.total_cost) AS amount
          FROM rows r WHERE r.checks_total > 0
         GROUP BY 1 ORDER BY amount DESC NULLS LAST`, params),
    ]);

    const k = kpi.rows[0];
    res.json({
      kpis: [
        { key: 'under_bgv',       label: 'Employees Under BGV', value: k.under_bgv,       filter: { has_checks: 'true' } },
        { key: 'not_started',     label: 'Not Started',         value: k.not_started,     filter: { status: 'Not Started' } },
        { key: 'in_progress',     label: 'In Progress',         value: k.in_progress,     filter: { status: 'In Progress' } },
        { key: 'completed',       label: 'Completed',           value: k.completed,       filter: { status: 'Completed' } },
        { key: 'discrepancy',     label: 'Discrepancy',         value: k.discrepancy,     filter: { status: 'Discrepancy' } },
        { key: 'pending_reports', label: 'Pending Reports',     value: k.pending_reports, filter: { pending_reports: 'true' } },
      ],
      counts: k,
      spend: {
        total:            k.total_spend,
        pending_payments: k.pending_payments,
        by_agency:        byAgency.rows,
        by_check_type:    byType.rows,
        by_month:         byMonth.rows,
        by_department:    byDept.rows,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Employee BGV list
// ─────────────────────────────────────────────────────────────────────────────

router.get('/cases', requirePermission('bgv', 'view'), async (req, res) => {
  const { sql, params } = buildListQuery(req);
  const sort = SORTABLE.has(String(req.query.sort)) ? String(req.query.sort) : null;
  const dir  = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // Whitelisted column name, interpolated — a bound parameter cannot be an
  // ORDER BY target, and SORTABLE is a closed Set so nothing from the query
  // string reaches the statement.
  const ordered = sort
    ? sql.replace(/ORDER BY[\s\S]*?LIMIT/, `ORDER BY ${sort} ${dir} NULLS LAST, employee_name LIMIT`)
    : sql;
  try {
    const { rows } = await pool.query(ordered, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * GET /bgv/employees/:employeeId
 *
 * Keyed on the EMPLOYEE, not the case, because a page has to open for an
 * employee whose BGV has not been started yet — the case is then null and the
 * page offers "Start BGV" rather than 404ing on a record that does not exist.
 */
router.get('/employees/:employeeId', requirePermission('bgv', 'view'), async (req, res) => {
  const employeeId = intId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee id');
  const companyId = companyOf(req);
  try {
    const { rows } = await pool.query(
      `WITH rows AS (
         SELECT ${CASE_SELECT}
         ${CASE_FROM} AND e.id = $2
       )
       SELECT * FROM rows`,
      [companyId, employeeId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    const summary = rows[0];

    if (!summary.case_id) return res.json({ ...summary, checks: [], documents: [] });

    const [checks, docs] = await Promise.all([
      pool.query(
        `SELECT ch.*, ag.agency_name,
                ${CHECK_CONTACT_SELECT},
                (SELECT COUNT(*)::int FROM bgv_documents d WHERE d.check_id = ch.id AND d.deleted_at IS NULL) AS document_count,
                (SELECT COUNT(*)::int FROM bgv_check_contacts t WHERE t.check_id = ch.id) AS contact_count
           FROM bgv_checks ch
           LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
          WHERE ch.case_id = $1
          ORDER BY ch.created_at, ch.id`,
        [summary.case_id]
      ),
      pool.query(
        `SELECT d.*, ch.check_type, ch.id AS check_id, u.name AS uploaded_by_name
           FROM bgv_documents d
           JOIN bgv_checks ch ON ch.id = d.check_id
           LEFT JOIN users u ON u.id = d.uploaded_by
          WHERE ch.case_id = $1 AND d.deleted_at IS NULL
          ORDER BY ch.check_type, d.uploaded_at DESC`,
        [summary.case_id]
      ),
    ]);

    logAudit({ userId: actor(req), module: 'bgv', recordId: summary.case_id, recordType: 'bgv_case',
               action: 'view', req, company_id: companyId });

    // ── Sensitive-detail redaction ──────────────────────────────────────────
    // The discrepancy COUNT and each check's result stay visible; the narrative
    // and the reports do not. Applied on the way out, once, so no branch of this
    // handler can forget it.
    const sensitive = await canSeeSensitive(req);
    const restrictedCheckIds = new Set(
      checks.rows.filter(isSensitiveCheck).map(c => c.id));

    res.json({
      ...summary,
      checks: sensitive ? checks.rows : checks.rows.map(redactCheck),
      documents: docs.rows
        .filter(d => sensitive || !restrictedCheckIds.has(d.check_id))
        .map(d => ({ ...d, file_present: fileOnDisk(d.file_url) })),
      // Said out loud so the page can explain the gap instead of silently
      // showing fewer files than the check's own document_count claims.
      sensitive_visible: sensitive,
      restricted_checks: sensitive ? 0 : restrictedCheckIds.size,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * GET /bgv/employees/:employeeId/summary
 *
 * The compact strip the View Employee → Background Verification tab shows
 * ("In Progress · 3/5 checks · ₹4,500"). Built from the SAME CASE_SELECT as the
 * full page, so the tab cannot say something the BGV page contradicts.
 */
router.get('/employees/:employeeId/summary', requirePermission('bgv', 'view'), async (req, res) => {
  const employeeId = intId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee id');
  try {
    const { rows } = await pool.query(
      `WITH rows AS (
         SELECT ${CASE_SELECT}
         ${CASE_FROM} AND e.id = $2
       ) SELECT * FROM rows`,
      [companyOf(req), employeeId]
    );
    if (!rows.length) return res.status(404).json({ message: 'Employee not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /bgv/employees/:employeeId/case — open the employee's BGV case.
 *
 * ON CONFLICT DO NOTHING against ux_bgv_cases_employee, then read the row back.
 * A double-click therefore returns the SAME case rather than either a 500 or a
 * second case that splits the employee's checks and spend across two records.
 *
 * ⚠ Not `ON CONFLICT DO UPDATE`: that reads idempotent and is not — see
 * [[project_batch01_tenant_idempotency_forensic]], where an additive DO UPDATE
 * credited 6.25 days for 5 runs of a 1.25-day grant.
 */
router.post('/employees/:employeeId/case', requirePermission('bgv', 'add'), async (req, res) => {
  const employeeId = intId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee id');
  const companyId = companyOf(req);

  try {
    // The employee must be inside the caller's tenant BEFORE anything is written.
    const { rows: emp } = await pool.query(
      `SELECT id, company_id FROM employees
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)`,
      [employeeId, companyId]
    );
    if (!emp.length) return res.status(404).json({ message: 'Employee not found' });

    const agencyId = intId(req.body?.primary_agency_id);
    if (!(await agencyInScope(agencyId, companyId))) return bad(res, 'Unknown verification agency');

    await pool.query(
      `INSERT INTO bgv_cases (employee_id, primary_agency_id, initiated_on, remarks, created_by, updated_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $5)
       ON CONFLICT (employee_id) DO NOTHING`,
      [employeeId, agencyId, dateOrNull(req.body?.initiated_on), textOrNull(req.body?.remarks), actor(req)]
    );
    const { rows } = await pool.query(`SELECT * FROM bgv_cases WHERE employee_id = $1`, [employeeId]);
    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_case',
               action: 'create', newData: rows[0], req, company_id: emp[0].company_id });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/cases/:id', requirePermission('bgv', 'edit'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid case id');
  const companyId = companyOf(req);
  try {
    const existing = await loadCase(id, companyId);
    if (!existing) return res.status(404).json({ message: 'BGV case not found' });

    const agencyId = req.body?.primary_agency_id === undefined ? undefined : intId(req.body.primary_agency_id);
    if (agencyId !== undefined && !(await agencyInScope(agencyId, companyId))) {
      return bad(res, 'Unknown verification agency');
    }

    const { rows } = await pool.query(
      `UPDATE bgv_cases SET
         primary_agency_id = CASE WHEN $1 THEN $2 ELSE primary_agency_id END,
         initiated_on      = COALESCE($3::date, initiated_on),
         remarks           = COALESCE($4, remarks),
         updated_by        = $5,
         updated_at        = NOW()
       WHERE ${caseScopeSql(7)} AND id = $6
       RETURNING *`,
      [agencyId !== undefined, agencyId ?? null, dateOrNull(req.body?.initiated_on),
       textOrNull(req.body?.remarks), actor(req), id, companyId]
    );
    if (!rows.length) return res.status(404).json({ message: 'BGV case not found' });
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_case',
               action: 'update', oldData: existing, newData: rows[0], req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/cases/:id/close  ·  /reopen
 *
 * "Closed" is the one status that is stored, because no arrangement of the
 * checks below implies it: a case whose every check came back Clear can still be
 * held open pending a re-check, and a case with an accepted discrepancy is
 * legitimately closed.
 *
 * ⚠ AN OPEN CHECK BLOCKS CLOSURE OUTRIGHT. There is no `force` escape and no
 * confirm-anyway path: every check must be Completed or Cancelled first.
 *
 * This replaced a `force: true` override. The override was wrong for the same
 * reason "Completed" must not imply "Clear": a closed case is the record HR, an
 * auditor and a client rely on to mean "this person's background was verified",
 * and a case closed over a Pending employment check does not mean that. Leaving a
 * way to do it anyway put the decision behind a confirm dialog, where it reads as
 * a warning rather than as the missing work it actually is. Cancelling a check
 * HR has genuinely abandoned is the honest way to close it — and it is recorded
 * on the check, where the reason belongs, instead of buried in a case audit row.
 */
router.post('/cases/:id/close', requirePermission('bgv', 'edit'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid case id');
  const companyId = companyOf(req);
  try {
    const existing = await loadCase(id, companyId);
    if (!existing) return res.status(404).json({ message: 'BGV case not found' });
    if (existing.closed_at) return bad(res, 'This BGV case is already closed.');

    // Named, not just counted: "3 checks are still open" sends HR hunting, while
    // "Employment Verification is In Progress" tells them what to finish.
    // ⚠⚠ `applicability = 'Required'` — ONLY a required check blocks.
    //
    // Two states deliberately do not:
    //   Not Applicable  a recorded decision, not work. Pre-selecting Employment
    //                   Verification as Not Applicable for a fresher is the
    //                   point of that profile; blocking on it would make their
    //                   case permanently uncloseable.
    //   Optional        real work, but work nobody decided was necessary. HR may
    //                   skip it (POST /checks/:id/skip, with a reason). Holding
    //                   the case open for an optional reference check is how a
    //                   case stays open forever over a nice-to-have.
    //
    // This replaced `applicability IN ('Required','Optional')`. The earlier rule
    // blocked on Optional too, which made "optional" mean nothing.
    const { rows: open } = await pool.query(
      `SELECT check_type, status, applicability FROM bgv_checks
        WHERE case_id = $1
          AND applicability = 'Required'
          AND status IN ('Pending','Initiated','In Progress')
        ORDER BY check_type`,
      [id]
    );
    if (open.length > 0) {
      return res.status(409).json({
        code: 'OPEN_CHECKS',
        open_checks: open.length,
        checks: open,
        message:
          `${open.length} required verification check${open.length === 1 ? '' : 's'} ` +
          `${open.length === 1 ? 'is' : 'are'} still open: ` +
          `${open.map(o => `${o.check_type} (${o.status})`).join(', ')}. ` +
          'Complete or cancel each one before closing the case.',
      });
    }

    const { rows } = await pool.query(
      `UPDATE bgv_cases
          SET closed_at = NOW(), closed_by = $1, closure_remarks = $2, updated_by = $1, updated_at = NOW()
        WHERE ${caseScopeSql(4)} AND id = $3
        RETURNING *`,
      [actor(req), textOrNull(req.body?.closure_remarks), id, companyId]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_case', action: 'close',
               oldData: existing,
               newData: rows[0], req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/cases/:id/reopen
 *
 * ── Why this needs MORE than bgv:edit ───────────────────────────────────────
 * A closed BGV case is the record HR, an auditor and a client rely on to mean
 * "this person's background was verified and the file is settled". Reopening it
 * puts a settled record back in play, and the same judgement that decides
 * whether a discrepancy may be read decides whether a closed file may be
 * unsettled — so it takes `bgv_sensitive`, not the ordinary edit grant.
 *
 * ⚠ Checked HERE rather than by swapping requirePermission('bgv','edit') for
 * requirePermission('bgv_sensitive','view'): the caller still needs bgv:edit
 * (this writes to the case), and BOTH have to hold. Replacing the gate would
 * have let a reader with no edit grant reopen a case.
 *
 * ── And a mandatory reason ──────────────────────────────────────────────────
 * Refused without one. "Reopened" with no reason is the least useful audit row
 * there is — it records that the record changed and nothing about why, which is
 * the only part anyone will want later. Stored on the case (so the page can show
 * it) AND written to audit_logs (which is immutable).
 */
router.post('/cases/:id/reopen', requirePermission('bgv', 'edit'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid case id');
  const companyId = companyOf(req);

  if (!(await canSeeSensitive(req))) {
    return res.status(403).json({
      error: 'Forbidden',
      code: 'BGV_SENSITIVE_REQUIRED',
      message: 'Reopening a closed BGV case is restricted to HR Manager / Admin roles.',
    });
  }

  const reason = textOrNull(req.body?.reason ?? req.body?.reopen_reason);
  if (!reason) {
    return bad(res, 'A reason is required to reopen a closed BGV case.', 'REOPEN_REASON_REQUIRED');
  }
  if (reason.length < 5) {
    // A one-character reason is a way round the requirement, not a reason.
    return bad(res, 'Give a reason of at least 5 characters.', 'REOPEN_REASON_REQUIRED');
  }

  try {
    const existing = await loadCase(id, companyId);
    if (!existing) return res.status(404).json({ message: 'BGV case not found' });
    if (!existing.closed_at) return bad(res, 'This BGV case is not closed.');

    const { rows } = await pool.query(
      `UPDATE bgv_cases
          SET closed_at = NULL, closed_by = NULL,
              reopened_at = NOW(), reopened_by = $1, reopen_reason = $4,
              updated_by = $1, updated_at = NOW()
        WHERE ${caseScopeSql(3)} AND id = $2
        RETURNING *`,
      [actor(req), id, companyId, reason]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_case', action: 'reopen',
               oldData: existing,
               // The reason is named explicitly in the audit payload as well as
               // being part of the row, so an audit reader never has to diff two
               // snapshots to find it.
               newData: { ...rows[0], reopen_reason: reason },
               req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// The checklist workflow
// ─────────────────────────────────────────────────────────────────────────────

/** The active BGV_CHECK_TYPE vocabulary, in its master order. */
async function masterCheckTypes(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT value FROM master_values
      WHERE type = 'BGV_CHECK_TYPE' AND is_active = true
        AND (company_id IS NULL OR company_id = $1::int)
      ORDER BY sort_order NULLS LAST, value`,
    [companyId]
  );
  return rows.map(r => r.value);
}

/**
 * GET /bgv/profiles
 *
 * The checklists behind "Fresher / Experienced / Custom", over the check types
 * this tenant's master actually holds. The page renders these as checkboxes; it
 * does not know what a fresher needs, because that answer lives in one place.
 */
router.get('/profiles', requirePermission('bgv', 'view'), async (req, res) => {
  try {
    const types = await masterCheckTypes(companyOf(req));
    res.json({
      check_types: types,
      applicability: APPLICABILITY,
      profiles: PROFILE_KEYS.map(k => profileChecklist(k, types)),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * Create several checks in one action.
 *
 * Shared by POST /cases/:id/checks/bulk and POST /employees/:id/start so the two
 * cannot disagree about what a checklist submission means.
 *
 * ── Duplicates ──────────────────────────────────────────────────────────────
 * A type the case already carries is SKIPPED, not created and not an error.
 * The brief: "Do not create duplicate checks for the same employee unless the
 * existing workflow explicitly supports repeated verification." Repeating a
 * verification IS supported — a re-check after a discrepancy is resolved is
 * ordinary work — so the rule cannot live in the schema, or the legitimate case
 * becomes impossible. It lives here, on the CHECKLIST path, which is the one
 * that would otherwise double every check on a second click. The single-check
 * endpoint still allows a deliberate repeat.
 *
 * Skipped rows come back named, so the UI can say "3 created, 2 already present"
 * rather than silently doing less than the user asked.
 *
 * ⚠ One transaction. A checklist that creates four of six checks and then fails
 * leaves HR to work out which four, and the profile they picked no longer
 * describes the case.
 */
async function createChecksBulk({ caseId, companyId, rows, userId, req }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ⚠ ANY existing check of that type, resolved or not — deliberately
    // stricter than the database's partial unique index, which only forbids two
    // ACTIVE ones.
    //
    // The checklist is for setting a case up, and "already on this case" is the
    // honest answer there whatever state the earlier check is in. Re-running a
    // verification is a different act with its own endpoint
    // (POST /checks/:id/reverify), which links the new check to the one it
    // supersedes. Letting the checklist quietly open a second check of a
    // resolved type would produce two unrelated rows and lose that chain.
    const { rows: existing } = await client.query(
      `SELECT LOWER(BTRIM(check_type)) AS t, status FROM bgv_checks WHERE case_id = $1`, [caseId]);
    const have = new Map(existing.map(r => [r.t, r.status]));

    const created = [];
    const skipped = [];
    for (const row of rows) {
      const check_type = textOrNull(row?.check_type);
      if (!check_type) { skipped.push({ check_type: null, reason: 'no verification type given' }); continue; }

      const key = check_type.trim().toLowerCase();
      if (have.has(key)) {
        const status = have.get(key);
        skipped.push({
          check_type,
          // Says WHICH case it is, so the UI can tell "still running" from
          // "already done — use Re-verify".
          reason: ['Completed', 'Cancelled'].includes(status)
            ? `this case already has a ${status.toLowerCase()} ${check_type} check — use Re-verify to run it again`
            : `this case already has an open ${check_type} check`,
          existing_status: status,
        });
        continue;
      }
      const applicability = oneOf(row?.applicability, APPLICABILITY, 'Required');

      const agencyId = intId(row?.agency_id);
      if (!(await agencyInScope(agencyId, companyId, client))) {
        await client.query('ROLLBACK');
        return { error: 'Unknown verification agency' };
      }
      const contact = dedupeContact({
        contact_person: textOrNull(row?.contact_person),
        contact_email:  textOrNull(row?.contact_email),
        contact_phone:  textOrNull(row?.contact_phone),
      }, await agencyContact(agencyId, companyId, client));

      const { rows: [made] } = await client.query(
        `INSERT INTO bgv_checks
           (case_id, check_type, applicability, agency_id,
            contact_person, contact_email, contact_phone,
            request_date, expected_date, status, result, remarks, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending','Pending',$10,$11,$11)
         RETURNING *`,
        [caseId, check_type, applicability, agencyId,
         contact.contact_person, contact.contact_email, contact.contact_phone,
         dateOrNull(row?.request_date), dateOrNull(row?.expected_date),
         textOrNull(row?.remarks), userId]
      );
      have.set(key, made.status);
      created.push(made);
    }

    await client.query('COMMIT');

    // Audited per check, with the same recordType the single path uses, so an
    // audit query cannot tell a checklist-created check from a hand-made one —
    // they are the same kind of record.
    for (const c of created) {
      logAudit({ userId, module: 'bgv', recordId: c.id, recordType: 'bgv_check',
                 action: 'create', newData: c, req, company_id: companyId });
    }
    return { created, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // ⚠ Released in `finally`, and no second pool.connect() is taken while this
    // one is held — asking the pool for another connection mid-transaction is
    // how a 6-connection pool deadlocks under 8 concurrent callers and reports a
    // bare 500 that reads as a flake.
    // [[project_batch01_tenant_idempotency_forensic]]
    client.release();
  }
}

/** POST /bgv/cases/:id/checks/bulk — add a checklist to an existing case. */
router.post('/cases/:id/checks/bulk', requirePermission('bgv', 'add'), async (req, res) => {
  const caseId = intId(req.params.id);
  if (!caseId) return bad(res, 'Invalid case id');
  const companyId = companyOf(req);
  const rows = Array.isArray(req.body?.checks) ? req.body.checks : null;
  if (!rows || rows.length === 0) return bad(res, 'Select at least one verification check.');

  try {
    const kase = await loadCase(caseId, companyId);
    if (!kase) return res.status(404).json({ message: 'BGV case not found' });
    if (kase.closed_at) return bad(res, 'This BGV case is closed. Reopen it to add checks.');

    const out = await createChecksBulk({ caseId, companyId, rows, userId: actor(req), req });
    if (out.error) return bad(res, out.error);
    res.status(201).json(out);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/employees/:employeeId/start
 *
 * Open the case AND create the selected checklist, in one action — which is what
 * "start BGV for this person" actually means. Previously HR opened a case and
 * then created each check one at a time.
 *
 * The case creation is the same ON CONFLICT DO NOTHING as POST .../case, so
 * starting BGV twice returns the same case and the checklist de-duplicates
 * against what is already there.
 */
router.post('/employees/:employeeId/start', requirePermission('bgv', 'add'), async (req, res) => {
  const employeeId = intId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee id');
  const companyId = companyOf(req);

  const rows = Array.isArray(req.body?.checks) ? req.body.checks : null;
  if (!rows || rows.length === 0) return bad(res, 'Select at least one verification check.');

  const profile = req.body?.profile == null ? null : String(req.body.profile);
  if (profile !== null && !PROFILE_KEYS.includes(profile)) {
    return bad(res, `Unknown profile. Expected one of: ${PROFILE_KEYS.join(', ')}`);
  }

  try {
    const { rows: emp } = await pool.query(
      `SELECT id, company_id FROM employees
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)`,
      [employeeId, companyId]
    );
    if (!emp.length) return res.status(404).json({ message: 'Employee not found' });

    const agencyId = intId(req.body?.primary_agency_id);
    if (!(await agencyInScope(agencyId, companyId))) return bad(res, 'Unknown verification agency');

    await pool.query(
      `INSERT INTO bgv_cases (employee_id, primary_agency_id, initiated_on, remarks, created_by, updated_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $5)
       ON CONFLICT (employee_id) DO NOTHING`,
      [employeeId, agencyId, dateOrNull(req.body?.initiated_on), textOrNull(req.body?.remarks), actor(req)]
    );
    const { rows: [kase] } = await pool.query(
      `SELECT * FROM bgv_cases WHERE employee_id = $1`, [employeeId]);
    if (kase.closed_at) return bad(res, 'This BGV case is closed. Reopen it to add checks.');

    const out = await createChecksBulk({
      caseId: kase.id, companyId, rows, userId: actor(req), req });
    if (out.error) return bad(res, out.error);

    logAudit({ userId: actor(req), module: 'bgv', recordId: kase.id, recordType: 'bgv_case',
               action: 'create', newData: { ...kase, profile, checks_created: out.created.length },
               req, company_id: emp[0].company_id });

    res.status(201).json({ case: kase, profile, ...out });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

router.post('/cases/:id/checks', requirePermission('bgv', 'add'), async (req, res) => {
  const caseId = intId(req.params.id);
  if (!caseId) return bad(res, 'Invalid case id');
  const companyId = companyOf(req);

  const check_type = textOrNull(req.body?.check_type);
  if (!check_type) return bad(res, 'Verification type is required');

  const status = oneOf(req.body?.status, CHECK_STATUSES, 'Pending');
  const result = oneOf(req.body?.result, CHECK_RESULTS, 'Pending');
  const applicability = oneOf(req.body?.applicability, APPLICABILITY, 'Required');
  if (status === 'Completed' && result === 'Pending') {
    return bad(res, 'A completed check needs a result — Clear, Discrepancy or Unable to Verify.', 'STATUS_NEEDS_RESULT');
  }

  try {
    const kase = await loadCase(caseId, companyId);
    if (!kase) return res.status(404).json({ message: 'BGV case not found' });

    const agencyId = intId(req.body?.agency_id);
    if (!(await agencyInScope(agencyId, companyId))) return bad(res, 'Unknown verification agency');

    // A contact that merely repeats the agency master is stored as NULL, i.e.
    // "use the master". See dedupeContact().
    const contact = dedupeContact({
      contact_person: textOrNull(req.body?.contact_person),
      contact_email:  textOrNull(req.body?.contact_email),
      contact_phone:  textOrNull(req.body?.contact_phone),
    }, await agencyContact(agencyId, companyId));

    const { rows } = await pool.query(
      `INSERT INTO bgv_checks
         (case_id, check_type, agency_id, contact_person, contact_email, contact_phone,
          request_date, expected_date, completed_date, status, result, remarks,
          amount, tax_amount, invoice_number, payment_date, payment_status, cost_remarks,
          followup_on, followup_owner, followup_notes, created_by, updated_by, applicability)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22,$23)
       RETURNING *`,
      [caseId, check_type, agencyId,
       contact.contact_person, contact.contact_email, contact.contact_phone,
       dateOrNull(req.body?.request_date), dateOrNull(req.body?.expected_date), dateOrNull(req.body?.completed_date),
       status, result, textOrNull(req.body?.remarks),
       moneyOrNull(req.body?.amount), moneyOrNull(req.body?.tax_amount),
       textOrNull(req.body?.invoice_number), dateOrNull(req.body?.payment_date),
       oneOf(req.body?.payment_status, PAYMENT_STATUSES, 'Pending'), textOrNull(req.body?.cost_remarks),
       dateOrNull(req.body?.followup_on), textOrNull(req.body?.followup_owner), textOrNull(req.body?.followup_notes),
       actor(req), applicability]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_check',
               action: 'create', newData: rows[0], req, company_id: companyId });
    res.status(201).json(rows[0]);
  } catch (err) {
    // ⚠ ux_bgv_checks_one_active_per_type. Duplicate protection used to live only
    // in the bulk endpoint's pre-check, which left this path — and any direct API
    // caller — able to add a second ACTIVE check of the same type, and left two
    // concurrent requests able to race past a read-then-write guard. The index
    // closes both; this turns its 23505 into an answer HR can act on.
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_ACTIVE_CHECK',
        message:
          `This case already has an open ${check_type} check. Finish or cancel it first — ` +
          'or use Re-verify, which opens a fresh check and keeps the previous result.',
      });
    }
    res.status(500).json({ message: err.message });
  }
});

/**
 * PATCH /bgv/checks/:id
 *
 * The status/result invariant is enforced against the MERGED row, not against
 * the body: a PATCH that sets only `status: 'Completed'` on a check whose stored
 * result is still 'Pending' has to be refused too, and a body-only check would
 * wave it through.
 */
router.patch('/checks/:id', requirePermission('bgv', 'edit'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);

  try {
    const existing = await loadCheck(id, companyId);
    if (!existing) return res.status(404).json({ message: 'Verification check not found' });

    /** Did the caller MENTION this field? Absent means "leave it alone". */
    const has = (k) => req.body?.[k] !== undefined;

    const status = req.body?.status === undefined ? existing.status : oneOf(req.body.status, CHECK_STATUSES);
    const result = req.body?.result === undefined ? existing.result : oneOf(req.body.result, CHECK_RESULTS);
    if (!status) return bad(res, `Status must be one of: ${CHECK_STATUSES.join(', ')}`);
    if (!result) return bad(res, `Result must be one of: ${CHECK_RESULTS.join(', ')}`);
    if (status === 'Completed' && result === 'Pending') {
      return bad(res, 'A completed check needs a result — Clear, Discrepancy or Unable to Verify.', 'STATUS_NEEDS_RESULT');
    }

    const paymentStatus = req.body?.payment_status === undefined
      ? existing.payment_status
      : oneOf(req.body.payment_status, PAYMENT_STATUSES);
    if (!paymentStatus) return bad(res, `Payment status must be one of: ${PAYMENT_STATUSES.join(', ')}`);

    /**
     * ⚠⚠ A REDACTED FIELD MAY NOT BE WRITTEN BACK.
     *
     * A caller without `bgv_sensitive` receives the REDACTED placeholder in
     * remarks / followup_notes / cost_remarks on a Discrepancy check. Posting
     * that value back overwrote the real finding with the string
     * "Restricted — visible to HR Manager / Admin only" — silent destruction of
     * exactly the data the redaction exists to protect.
     *
     * The frontend already drops those fields from its payload. That is NOT a
     * guard: this endpoint is reachable directly, and an audit drive proved the
     * finding could be destroyed with one PATCH. The rule has to live here.
     *
     * REFUSED, not silently ignored: a caller who thinks they saved a note and
     * did not is worse off than one told they may not. Other fields on the same
     * check — dates, cost, agency, status, result — stay editable, because an HR
     * executive still has to run the check they cannot read the findings of.
     */
    const SENSITIVE_TEXT = ['remarks', 'followup_notes', 'cost_remarks'];
    const touchedSensitive = SENSITIVE_TEXT.filter(k => req.body?.[k] !== undefined);
    if (touchedSensitive.length && isSensitiveCheck(existing) && !(await canSeeSensitive(req))) {
      return res.status(403).json({
        error: 'Forbidden',
        code: 'BGV_SENSITIVE_REQUIRED',
        fields: touchedSensitive,
        message:
          'The findings on a check that returned a discrepancy are restricted to ' +
          'HR Manager / Admin roles, and cannot be edited by this role. Every other ' +
          'field on this check is still editable.',
      });
    }

    const applicability = req.body?.applicability === undefined
      ? existing.applicability
      : oneOf(req.body.applicability, APPLICABILITY);
    if (!applicability) return bad(res, `Applicability must be one of: ${APPLICABILITY.join(', ')}`);

    const agencyId = req.body?.agency_id === undefined ? undefined : intId(req.body.agency_id);
    if (agencyId !== undefined && !(await agencyInScope(agencyId, companyId))) {
      return bad(res, 'Unknown verification agency');
    }

    // ── Contact override, de-duplicated against the agency that will be in
    // effect AFTER this PATCH ────────────────────────────────────────────────
    // ⚠ Resolved against the INCOMING agency when the request changes it, not
    // the stored one. Moving a check from agency A to agency B and sending B's
    // contact card would otherwise be compared against A, kept as an "override",
    // and then frozen — so the check would keep showing B's contact as it was on
    // the day of the move rather than as B's master says today.
    const effectiveAgencyId = agencyId !== undefined ? agencyId : existing.agency_id;
    const agencyCard = await agencyContact(effectiveAgencyId, companyId);
    const patchContact = dedupeContact({
      contact_person: has('contact_person') ? textOrNull(req.body.contact_person) : existing.contact_person,
      contact_email:  has('contact_email')  ? textOrNull(req.body.contact_email)  : existing.contact_email,
      contact_phone:  has('contact_phone')  ? textOrNull(req.body.contact_phone)  : existing.contact_phone,
    }, agencyCard);

    // Completing a check with no completed_date supplied dates it today —
    // otherwise the turnaround-time column and the case's last_completed_date
    // are blank for work that demonstrably finished.
    const completedDate = dateOrNull(req.body?.completed_date)
      ?? (status === 'Completed' ? (existing.completed_date ?? new Date().toISOString().slice(0, 10)) : existing.completed_date);

    // `$1 ? $2 : col` per field rather than COALESCE, because COALESCE cannot
    // express "clear this value" — a null in the body would read as "leave it
    // alone" and an optional date could never be un-set.
    // [[project_recruitment_redesign_2026-09-27]]
    const { rows } = await pool.query(
      `UPDATE bgv_checks SET
         check_type     = COALESCE($1, check_type),
         agency_id      = CASE WHEN $2 THEN $3 ELSE agency_id END,
         contact_person = CASE WHEN $4 THEN $5 ELSE contact_person END,
         contact_email  = CASE WHEN $6 THEN $7 ELSE contact_email END,
         contact_phone  = CASE WHEN $8 THEN $9 ELSE contact_phone END,
         request_date   = CASE WHEN $10 THEN $11::date ELSE request_date END,
         expected_date  = CASE WHEN $12 THEN $13::date ELSE expected_date END,
         completed_date = $14::date,
         status         = $15,
         result         = $16,
         applicability  = $39,
         remarks        = CASE WHEN $17 THEN $18 ELSE remarks END,
         amount         = CASE WHEN $19 THEN $20 ELSE amount END,
         tax_amount     = CASE WHEN $21 THEN $22 ELSE tax_amount END,
         invoice_number = CASE WHEN $23 THEN $24 ELSE invoice_number END,
         payment_date   = CASE WHEN $25 THEN $26::date ELSE payment_date END,
         payment_status = $27,
         cost_remarks   = CASE WHEN $28 THEN $29 ELSE cost_remarks END,
         followup_on    = CASE WHEN $30 THEN $31::date ELSE followup_on END,
         followup_owner = CASE WHEN $32 THEN $33 ELSE followup_owner END,
         followup_notes = CASE WHEN $34 THEN $35 ELSE followup_notes END,
         updated_by     = $36,
         updated_at     = NOW()
       WHERE ${checkScopeSql(38)} AND id = $37
       RETURNING *`,
      [textOrNull(req.body?.check_type),
       agencyId !== undefined, agencyId ?? null,
       // Always true: dedupeContact() has already resolved what should be
       // stored (the override, or NULL meaning "use the agency master"), so
       // these three are written on every PATCH rather than only when the body
       // mentions them — moving a check to a different agency has to re-resolve
       // them even if the caller said nothing about the contact.
       //
       // ⚠ The CASE WHEN shape is kept rather than collapsed to `= $5`, because
       // dropping $4/$6/$8 from the statement while still BINDING them is a
       // "could not determine data type of parameter $4" error, not dead weight.
       // [[project_pg_unreferenced_param_bind_error]]
       true, patchContact.contact_person,
       true, patchContact.contact_email,
       true, patchContact.contact_phone,
       has('request_date'),   dateOrNull(req.body?.request_date),
       has('expected_date'),  dateOrNull(req.body?.expected_date),
       completedDate,
       status, result,
       has('remarks'),        textOrNull(req.body?.remarks),
       has('amount'),         moneyOrNull(req.body?.amount),
       has('tax_amount'),     moneyOrNull(req.body?.tax_amount),
       has('invoice_number'), textOrNull(req.body?.invoice_number),
       has('payment_date'),   dateOrNull(req.body?.payment_date),
       paymentStatus,
       has('cost_remarks'),   textOrNull(req.body?.cost_remarks),
       has('followup_on'),    dateOrNull(req.body?.followup_on),
       has('followup_owner'), textOrNull(req.body?.followup_owner),
       has('followup_notes'), textOrNull(req.body?.followup_notes),
       actor(req), id, companyId, applicability]
    );
    if (!rows.length) return res.status(404).json({ message: 'Verification check not found' });

    // A status or result change is recorded as its own audit action, not folded
    // into a generic 'update': "who marked this Discrepancy, and when" is the
    // question this module will actually be asked.
    const statusChanged = existing.status !== rows[0].status || existing.result !== rows[0].result;
    const applicabilityChanged = existing.applicability !== rows[0].applicability;
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_check',
               // Ruling a check Not Applicable removes it from the pending queue
               // and from the closure guard, so it is a decision worth naming in
               // the audit trail rather than folding into a generic 'update'.
               action: applicabilityChanged ? 'applicability_change'
                     : statusChanged ? 'status_change' : 'update',
               oldData: existing, newData: rows[0], req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * DELETE /bgv/checks/:id
 *
 * Refused once the check carries a report or a contact-history entry: those are
 * the evidence trail, and ON DELETE CASCADE would take them with it. Cancel the
 * check instead (status='Cancelled'), which keeps everything and removes it from
 * the pending counts.
 */
router.delete('/checks/:id', requirePermission('bgv', 'delete'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);
  try {
    const existing = await loadCheck(id, companyId);
    if (!existing) return res.status(404).json({ message: 'Verification check not found' });

    const { rows: [counts] } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM bgv_documents d WHERE d.check_id = $1 AND d.deleted_at IS NULL) AS docs,
              (SELECT COUNT(*)::int FROM bgv_check_contacts t WHERE t.check_id = $1) AS contacts`,
      [id]
    );
    if (counts.docs > 0 || counts.contacts > 0) {
      return res.status(409).json({
        code: 'HAS_EVIDENCE',
        message: `This check has ${counts.docs} report(s) and ${counts.contacts} contact record(s). Cancel it instead of deleting — deleting would destroy the trail.`,
      });
    }

    const { rowCount } = await pool.query(
      `DELETE FROM bgv_checks WHERE ${checkScopeSql(2)} AND id = $1`, [id, companyId]
    );
    if (!rowCount) return res.status(404).json({ message: 'Verification check not found' });
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_check',
               action: 'delete', oldData: existing, req, company_id: companyId });
    res.json({ message: 'Check deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/checks/:id/skip
 *
 * ── Why a dedicated action and not just a status change ─────────────────────
 * Optional checks no longer block closure, so HR can close a case with one left
 * Pending. That would be worse than blocking: the case reads as settled while a
 * check sits visibly outstanding and nothing says why. Skipping makes it an ACT
 * — Cancelled, with who, when and why on the row and in the audit log.
 *
 * ⚠ A REASON IS MANDATORY. "Cancelled" with no reason is the least useful row in
 * the module: it records that work stopped and nothing about whether that was a
 * decision or an oversight. Same judgement as the reopen reason.
 *
 * ⚠ A REQUIRED check cannot be skipped through here. Skipping it would be a way
 * round the closure guard — which is the whole point of Required. To stop doing
 * a required check, HR must first change its applicability (an audited
 * `applicability_change`), which is a visible decision rather than a quiet one.
 *
 * ⚠ The skip reason goes in `skip_reason`, NOT `remarks`. `remarks` holds what a
 * check FOUND and is gated behind `bgv_sensitive` for a Discrepancy; a reason for
 * not doing a check is operational and must stay readable by the HR executive
 * who wrote it.
 */
router.post('/checks/:id/skip', requirePermission('bgv', 'edit'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);

  const reason = textOrNull(req.body?.reason ?? req.body?.skip_reason);
  if (!reason || reason.length < 5) {
    return bad(res, 'A reason of at least 5 characters is required to skip a check.',
      'SKIP_REASON_REQUIRED');
  }

  try {
    const existing = await loadCheck(id, companyId);
    if (!existing) return res.status(404).json({ message: 'Verification check not found' });
    if (existing.case_closed_at) return bad(res, 'This BGV case is closed. Reopen it to change a check.');

    if (existing.applicability === 'Required') {
      return res.status(409).json({
        code: 'CANNOT_SKIP_REQUIRED',
        message:
          'A required check cannot be skipped — that would bypass the closure guard. ' +
          'Change it to Optional or Not Applicable first, which is recorded as its own decision.',
      });
    }
    if (['Completed', 'Cancelled'].includes(existing.status)) {
      return bad(res, `This check is already ${existing.status.toLowerCase()}.`);
    }

    const { rows } = await pool.query(
      `UPDATE bgv_checks
          SET status = 'Cancelled',
              skipped_at = NOW(), skipped_by = $1, skip_reason = $4,
              updated_by = $1, updated_at = NOW()
        WHERE ${checkScopeSql(3)} AND id = $2
        RETURNING *`,
      [actor(req), id, companyId, reason]
    );
    if (!rows.length) return res.status(404).json({ message: 'Verification check not found' });

    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_check',
               action: 'skip', oldData: existing,
               // Named in the payload as well as being on the row, so an audit
               // reader never has to diff two snapshots to find it.
               newData: { ...rows[0], skip_reason: reason },
               req, company_id: companyId });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/checks/:id/reverify
 *
 * Re-run a verification that has already been resolved.
 *
 * ── Why an explicit action rather than "just add another check" ─────────────
 * The duplicate guard (ux_bgv_checks_one_active_per_type) forbids two OPEN checks
 * of the same type on one case, which is what an accidental duplicate looks like.
 * A re-verification is the legitimate case the guard must not break: the previous
 * check is resolved, and a NEW one is opened.
 *
 * Doing it through its own endpoint buys three things a bare POST does not:
 *   · it REFUSES while the previous check is still open, so "re-verify" can never
 *     be the way someone accidentally creates the duplicate;
 *   · it links the new check to the old one (`supersedes_check_id`), so the chain
 *     is readable instead of two unrelated rows of the same type;
 *   · nothing is overwritten. The earlier result, its remarks, its contact
 *     history and its documents all stay exactly where they are — a
 *     re-verification is a second attempt on the record, not a correction of the
 *     first.
 *
 * The new check starts Pending/Pending with the same type, applicability and
 * agency, and carries NONE of the previous result, cost or paperwork. Copying the
 * old cost forward would double-count the spend; copying the old result forward
 * would be the "Completed means Clear" conflation in another costume.
 */
router.post('/checks/:id/reverify', requirePermission('bgv', 'add'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);

  const reason = textOrNull(req.body?.reason);
  if (!reason || reason.length < 5) {
    return bad(res, 'A reason of at least 5 characters is required to re-verify a check.',
      'REVERIFY_REASON_REQUIRED');
  }

  try {
    const previous = await loadCheck(id, companyId);
    if (!previous) return res.status(404).json({ message: 'Verification check not found' });
    if (previous.case_closed_at) return bad(res, 'This BGV case is closed. Reopen it to re-verify.');

    if (!['Completed', 'Cancelled'].includes(previous.status)) {
      return res.status(409).json({
        code: 'PREVIOUS_STILL_OPEN',
        message:
          `${previous.check_type} is still ${previous.status} — finish or cancel it before ` +
          're-verifying. Re-verification opens a SECOND check of the same type, and two ' +
          'open checks of one type is what an accidental duplicate looks like.',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO bgv_checks
         (case_id, check_type, applicability, agency_id,
          contact_person, contact_email, contact_phone,
          request_date, status, result, remarks,
          supersedes_check_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,'Pending','Pending',$8,$9,$10,$10)
       RETURNING *`,
      [previous.case_id, previous.check_type, previous.applicability, previous.agency_id,
       previous.contact_person, previous.contact_email, previous.contact_phone,
       `Re-verification of check #${previous.id}: ${reason}`,
       previous.id, actor(req)]
    );

    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_check',
               action: 'reverify',
               newData: { ...rows[0], supersedes_check_id: previous.id, reason },
               req, company_id: companyId });
    res.status(201).json({ check: rows[0], supersedes: previous.id });
  } catch (err) {
    // The partial unique index is the backstop: if two re-verify calls race, one
    // of them loses here rather than both inserting.
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_ACTIVE_CHECK',
        message: 'This case already has an open check of that type.',
      });
    }
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Contact / communication history — append only
// ─────────────────────────────────────────────────────────────────────────────

router.get('/checks/:id/contacts', requirePermission('bgv', 'view'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  try {
    const check = await loadCheck(id, companyOf(req));
    if (!check) return res.status(404).json({ message: 'Verification check not found' });
    const { rows } = await pool.query(
      `SELECT t.*, u.name AS logged_by_name
         FROM bgv_check_contacts t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.check_id = $1
        ORDER BY COALESCE(t.contacted_on, t.created_at::date) DESC, t.id DESC`,
      [id]
    );
    // Who we contacted and what came back stays visible — that is the audit
    // trail an HR executive needs to chase the check. The NOTES under a
    // discrepancy do not: that is where the finding gets written down.
    if (isSensitiveCheck(check) && !(await canSeeSensitive(req))) {
      return res.json(rows.map(r => ({
        ...r,
        notes: r.notes ? REDACTED : null,
        detail_restricted: true,
      })));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * POST /bgv/checks/:id/contacts — log one contact ATTEMPT.
 *
 * There is no PATCH and no DELETE for this table by design. "This should create
 * a history rather than overwriting previous contact attempts": a second call to
 * the same previous employer is a second row, so "we rang them three times and
 * got nothing" stays readable a year later.
 */
router.post('/checks/:id/contacts', requirePermission('bgv', 'add'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);

  const contact_type = textOrNull(req.body?.contact_type);
  if (!contact_type) return bad(res, 'Contact type is required');
  const method   = oneOf(req.body?.method, CONTACT_METHODS, 'Phone');
  const response = oneOf(req.body?.response, CONTACT_RESPONSES, 'Pending');

  try {
    const check = await loadCheck(id, companyId);
    if (!check) return res.status(404).json({ message: 'Verification check not found' });
    const { rows } = await pool.query(
      `INSERT INTO bgv_check_contacts
         (check_id, contact_type, contact_person, organization, phone, email,
          contacted_on, method, response, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),$8,$9,$10,$11)
       RETURNING *`,
      [id, contact_type,
       textOrNull(req.body?.contact_person), textOrNull(req.body?.organization),
       textOrNull(req.body?.phone), textOrNull(req.body?.email),
       dateOrNull(req.body?.contacted_on), method, response, textOrNull(req.body?.notes), actor(req)]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_check_contact',
               action: 'create', newData: rows[0], req, company_id: companyId });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports / documents
//
// Bytes go through StorageService.uploadFile() — the same writer the rest of the
// app uses — and are served ONLY by GET /api/files/:filename, which authenticates,
// checks the employee/company/BGV relationship and audit-logs the read. There is
// no /uploads path to a BGV report. secureFiles.routes.js carries the matching
// bgv_documents ownership branch.
// ─────────────────────────────────────────────────────────────────────────────

/** GET /bgv/cases/:id/documents — the folder view, grouped by check type. */
router.get('/cases/:id/documents', requirePermission('bgv', 'view'), async (req, res) => {
  const caseId = intId(req.params.id);
  if (!caseId) return bad(res, 'Invalid case id');
  try {
    const kase = await loadCase(caseId, companyOf(req));
    if (!kase) return res.status(404).json({ message: 'BGV case not found' });

    // Every check is a folder, including the ones with nothing in them yet —
    // an empty folder is the honest answer to "where is the Education report?",
    // and hiding it would make a missing report look like a missing check.
    const { rows } = await pool.query(
      `SELECT ch.id AS check_id, ch.check_type, ch.status, ch.result,
              ag.agency_name,
              d.id AS document_id, d.document_type, d.document_name, d.file_url,
              d.file_size, d.notes, d.uploaded_at, u.name AS uploaded_by_name
         FROM bgv_checks ch
         LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
         LEFT JOIN bgv_documents d ON d.check_id = ch.id AND d.deleted_at IS NULL
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE ch.case_id = $1
        ORDER BY ch.check_type, d.uploaded_at DESC NULLS LAST`,
      [caseId]
    );

    const sensitive = await canSeeSensitive(req);

    const folders = [];
    const byCheck = new Map();
    for (const r of rows) {
      if (!byCheck.has(r.check_id)) {
        const folder = {
          check_id: r.check_id, check_type: r.check_type, status: r.status,
          result: r.result, agency_name: r.agency_name, files: [],
          // ⚠ `restricted` is NOT the same as an empty folder, and the page must
          // not draw them the same way. "No report attached yet" is a job to do;
          // "you may not see this report" is a permission. Conflating them would
          // send an HR executive chasing an agency that already delivered.
          restricted: !sensitive && isSensitiveCheck(r),
        };
        byCheck.set(r.check_id, folder);
        folders.push(folder);
      }
      // A restricted folder reports its file COUNT but not the files, so the
      // page can say "2 reports, restricted" rather than implying there are none.
      if (byCheck.get(r.check_id).restricted) {
        if (r.document_id) {
          byCheck.get(r.check_id).restricted_file_count =
            (byCheck.get(r.check_id).restricted_file_count || 0) + 1;
        }
        continue;
      }
      if (r.document_id) {
        byCheck.get(r.check_id).files.push({
          id: r.document_id, document_type: r.document_type, document_name: r.document_name,
          file_url: r.file_url, file_size: r.file_size, notes: r.notes,
          uploaded_at: r.uploaded_at, uploaded_by_name: r.uploaded_by_name,
          filename: r.file_url ? String(r.file_url).split('/').pop() : null,
          // "If the physical file is missing from storage, clearly show 'File
          // not in storage'. Do not show a misleading 'On file' status."
          file_present: fileOnDisk(r.file_url),
        });
      }
    }
    res.json({ case_id: caseId, folders, sensitive_visible: sensitive });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/checks/:id/documents', requirePermission('bgv', 'add'), upload.single('file'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid check id');
  const companyId = companyOf(req);

  try {
    // Tenant checked BEFORE the bytes are written. A refused insert that has
    // already put the file on disk leaves an orphaned report in storage.
    const check = await loadCheck(id, companyId);
    if (!check) return res.status(404).json({ message: 'Verification check not found' });
    if (!req.file) return bad(res, 'No file was attached');

    const document_name = textOrNull(req.body?.document_name) || req.file.originalname;

    let file_url;
    try {
      file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (uploadErr) {
      console.error('[bgv/documents] StorageService upload failed:', uploadErr.message);
      // Never insert the row anyway. A document record with no document behind
      // it lists as uploaded and opens nothing — the exact defect the employee
      // Documents tab shipped with.
      return res.status(502).json({ message: 'The file could not be stored. Nothing was saved — please try again.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO bgv_documents (check_id, document_type, document_name, file_url, file_size, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, textOrNull(req.body?.document_type) || 'Verification Report', document_name,
       file_url, req.file.size, textOrNull(req.body?.notes), actor(req)]
    );
    logAudit({ userId: actor(req), module: 'bgv', recordId: rows[0].id, recordType: 'bgv_document',
               action: 'create', newData: { ...rows[0], check_type: check.check_type }, req, company_id: companyId });
    res.status(201).json({ ...rows[0], file_present: fileOnDisk(file_url) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/documents/:id', requirePermission('bgv', 'delete'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return bad(res, 'Invalid document id');
  const companyId = companyOf(req);
  try {
    // ── RETIRED, NOT DELETED ────────────────────────────────────────────────
    // A verification report is evidence. Two things are retained, deliberately:
    //
    //   the FILE      — nothing in this module ever calls StorageService's
    //                   deleteFile(), and a bgvDocumentRetention contract test
    //                   asserts that no unlink/deleteFile call exists anywhere in
    //                   the BGV code at all.
    //   the RECORD    — soft-deleted, so the file stays JOINED to the employee,
    //                   the check, the agency and the uploader. A hard delete
    //                   kept the bytes and threw away the only thing that said
    //                   what they were: an unnamed file in uploads/ that no query
    //                   could tie back to anything.
    //
    // Access to a retired report is unchanged: same tenant scope, same bgv:view,
    // and for a discrepancy the same bgv_sensitive:view. Retention that widened
    // access would be worse than deletion.
    const { rows } = await pool.query(
      `UPDATE bgv_documents
          SET deleted_at = NOW(), deleted_by = $3
        WHERE id = $1
          AND deleted_at IS NULL
          AND check_id IN (SELECT ch.id FROM bgv_checks ch
                             JOIN bgv_cases c ON c.id = ch.case_id
                             JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
                            WHERE ($2::int IS NULL OR e.company_id = $2::int))
        RETURNING *`,
      [id, companyId, actor(req)]
    );
    if (!rows.length) return res.status(404).json({ message: 'Document not found' });
    logAudit({ userId: actor(req), module: 'bgv', recordId: id, recordType: 'bgv_document',
               action: 'retire', oldData: rows[0], req, company_id: companyId });
    res.json({
      message: 'Document removed from this check. The stored file is retained for audit.',
      retained: true,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /bgv/costs — the per-check spend ledger behind the cost screen.
 *
 * Respects every filter the employee list takes, so the Costs tab and the
 * Employees tab are always looking at the same population.
 */
router.get('/costs', requirePermission('bgv', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  const f = listFilters(req.query, 2);
  try {
    const { rows } = await pool.query(
      `WITH rows AS (
         SELECT ${CASE_SELECT}
         ${CASE_FROM}${f.sql}
       )
       SELECT ch.id AS check_id, r.employee_id, r.employee_code, r.employee_name,
              r.department, ch.check_type, ag.agency_name,
              ch.amount, ch.tax_amount, ch.total_amount,
              ch.invoice_number, ch.payment_date, ch.payment_status, ch.cost_remarks,
              ch.request_date, ch.completed_date, ch.status, ch.result
         FROM bgv_checks ch
         JOIN rows r ON r.case_id = ch.case_id
         LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
        ORDER BY ch.total_amount DESC NULLS LAST, ch.id
        LIMIT 2000`,
      [companyId, ...f.params]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports / exports
//
// Every export runs the SAME filters the screen was showing — "Filters applied
// on screen should be respected in exports" — because each one is built from
// listFilters()/derivedFilters(), not from its own WHERE clause.
//
// CSV is written by shared/csv.js, which neutralises formula leads. A BGV export
// carries agency names, employee names and free-text remarks: all typed by
// someone other than the person who opens the file, which is the whole
// precondition for spreadsheet formula injection.
// ─────────────────────────────────────────────────────────────────────────────

const REPORTS = {
  employees: {
    name: 'bgv-employees',
    header: ['Employee ID', 'Employee Name', 'Department', 'Designation', 'Joining Date',
             'BGV Status', 'Agency', 'Checks Total', 'Completed', 'Pending', 'Discrepancies',
             'Reports Missing', 'Total Cost', 'Unpaid', 'Last Updated'],
    row: (r) => [r.employee_code, r.employee_name, r.department, r.designation, r.joining_date,
                 r.bgv_status, r.primary_agency_name, r.checks_total, r.checks_completed,
                 r.checks_pending, r.checks_discrepancy, r.reports_missing,
                 r.total_cost, r.unpaid_cost, r.last_updated],
  },
  pending: {
    name: 'bgv-pending-verifications',
    header: ['Employee ID', 'Employee Name', 'Department', 'BGV Status', 'Checks Pending',
             'Overdue', 'Reports Missing', 'Agency', 'Last Updated'],
    row: (r) => [r.employee_code, r.employee_name, r.department, r.bgv_status, r.checks_pending,
                 r.checks_overdue, r.reports_missing, r.primary_agency_name, r.last_updated],
    post: (rows) => rows.filter(r => r.checks_pending > 0 || r.reports_missing > 0),
  },
  discrepancy: {
    name: 'bgv-discrepancies',
    header: ['Employee ID', 'Employee Name', 'Department', 'BGV Status', 'Discrepancies',
             'Unable to Verify', 'Checks Total', 'Agency', 'Last Updated'],
    row: (r) => [r.employee_code, r.employee_name, r.department, r.bgv_status, r.checks_discrepancy,
                 r.checks_unable, r.checks_total, r.primary_agency_name, r.last_updated],
    post: (rows) => rows.filter(r => r.checks_discrepancy > 0 || r.checks_unable > 0),
  },
};

router.get('/reports/:kind', requirePermission('bgv', 'export'), async (req, res) => {
  const kind = String(req.params.kind || '');
  const companyId = companyOf(req);

  // ⚠ Gating the screen and leaving the export open is the
  // [[project_pulse01_env_write_rbac_killswitch]] failure — a gated endpoint
  // with an ungated alias behind it. The Discrepancy Report names every employee
  // with a finding, so it needs the same grant the detail does.
  if (kind === 'discrepancy' && !(await canSeeSensitive(req))) {
    return res.status(403).json({
      error: 'Forbidden',
      code: 'BGV_SENSITIVE_REQUIRED',
      message: 'The Discrepancy Report is restricted to HR Manager / Admin roles.',
    });
  }

  // ── Cost and agency reports read the check ledger, not the case list ───────
  if (kind === 'cost' || kind === 'agency') {
    const f = listFilters(req.query, 2);
    const cte = `WITH rows AS (SELECT ${CASE_SELECT} ${CASE_FROM}${f.sql})`;
    try {
      if (kind === 'cost') {
        const { rows } = await pool.query(
          `${cte}
           SELECT r.employee_code, r.employee_name, r.department, ch.check_type,
                  ag.agency_name, ch.amount, ch.tax_amount, ch.total_amount,
                  ch.invoice_number, ch.payment_status, ch.payment_date, ch.request_date
             FROM bgv_checks ch JOIN rows r ON r.case_id = ch.case_id
             LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
            ORDER BY r.employee_name, ch.check_type`,
          [companyId, ...f.params]
        );
        return sendCsv(res, 'bgv-cost', toCsv(
          ['Employee ID', 'Employee Name', 'Department', 'Verification Type', 'Agency',
           'Amount', 'Tax', 'Total', 'Invoice No', 'Payment Status', 'Payment Date', 'Request Date'],
          rows.map(r => [r.employee_code, r.employee_name, r.department, r.check_type, r.agency_name,
                         r.amount, r.tax_amount, r.total_amount, r.invoice_number,
                         r.payment_status, r.payment_date, r.request_date])));
      }
      const { rows } = await pool.query(
        `${cte}
         SELECT COALESCE(ag.agency_name, '(no agency recorded)') AS agency_name,
                ag.contact_person, ag.email, ag.phone,
                COUNT(*)::int AS checks,
                COUNT(DISTINCT r.employee_id)::int AS employees,
                COUNT(*) FILTER (WHERE ch.status = 'Completed')::int AS completed,
                COUNT(*) FILTER (WHERE ch.result = 'Discrepancy')::int AS discrepancies,
                SUM(ch.total_amount) AS total_amount,
                SUM(ch.total_amount) FILTER (WHERE ch.payment_status IN ('Pending','Invoiced')) AS unpaid
           FROM bgv_checks ch JOIN rows r ON r.case_id = ch.case_id
           LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
          GROUP BY 1, 2, 3, 4 ORDER BY total_amount DESC NULLS LAST`,
        [companyId, ...f.params]
      );
      return sendCsv(res, 'bgv-agency', toCsv(
        ['Agency', 'Contact Person', 'Email', 'Phone', 'Checks', 'Employees',
         'Completed', 'Discrepancies', 'Total Amount', 'Unpaid'],
        rows.map(r => [r.agency_name, r.contact_person, r.email, r.phone, r.checks, r.employees,
                       r.completed, r.discrepancies, r.total_amount, r.unpaid])));
    } catch (err) { return res.status(500).json({ message: err.message }); }
  }

  const spec = REPORTS[kind];
  if (!spec) {
    return bad(res, `Unknown report. Available: ${[...Object.keys(REPORTS), 'cost', 'agency'].join(', ')}`);
  }
  const { sql, params } = buildListQuery(req, { limit: 5000 });
  try {
    const { rows } = await pool.query(sql, params);
    const list = spec.post ? spec.post(rows) : rows;
    logAudit({ userId: actor(req), module: 'bgv', recordId: null, recordType: 'bgv_report',
               action: 'export', newData: { report: kind, rows: list.length, filters: req.query },
               req, company_id: companyId });
    sendCsv(res, spec.name, toCsv(spec.header, list.map(spec.row)));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
