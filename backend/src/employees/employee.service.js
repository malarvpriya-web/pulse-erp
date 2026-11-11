import { normalizePayrollSettings } from '../modules/payroll/payrollSettings.js';
import { createProposal } from '../modules/payroll/salaryProposals.service.js';
import pool from "../config/db.js";
import { normalizeLoginEmail, LOGIN_EMAIL_KEY } from "../shared/loginEmail.js";
import { unrevealedInitialPasswordHash } from "../shared/initialPassword.js";
import { validatePAN } from "../utils/gst.js";
import { syncPrimaryRole } from "../services/userRoles.js";
import { initOnboardingChecklist } from "../modules/hr/onboarding.service.js";
import { resolveRange } from "../shared/dashboardFilters.js";
import { getWorkforcePolicy, dobProblem, localTodayIso } from "../shared/workforcePolicy.js";
import {
  bucketSql, isExitedSql, isCurrentSql, statusExpr,
  canonicalWritableStatus, WRITABLE_STATUSES,
} from "../shared/employeeStatus.js";
import { nextEmployeeCode, assertCodeAvailable } from "../shared/employeeCode.js";
import { lockConvertibleIntern, linkConversion } from "../modules/hr/internConversion.js";
import { assertValidManager } from "../shared/employeeHierarchy.js";
import { cleanText, isNullishText } from "../shared/nullish.js";
import {
  getProbationPolicy, resolveProbationWrite, DEFAULT_PROBATION_MONTHS,
} from "../shared/probationDates.js";

// The initial password of an auto-created employee login is a per-account
// random secret nobody ever sees — see shared/initialPassword.js, which admin
// bulk user import uses too. It replaced a SHARED default ('Welcome@123' /
// DEFAULT_EMPLOYEE_PASSWORD), which is no longer read anywhere here.

function toIntOrNull(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/**
 * Creates a login account (users row) for a freshly-added employee so they can
 * sign in. Runs inside the caller's transaction. Prefers personal_email (which
 * the Add Employee form leaves optional) but falls back to company_email (the
 * one email field that's actually required) so an employee who was only given
 * a company email still gets a usable login. Skips silently if neither email
 * is present or an account already exists for that email. Returns the login
 * descriptor (or null when skipped).
 *
 * ⚠ The descriptor carries NO password. It used to return the temporary
 * password, and POST /employees sent it back in the response body for Add
 * Employee to display — a credential in an HTTP response, in browser memory
 * and dev tools, and one hop from any proxy or client-side logger. The new
 * employee sets their own password through the sign-in page's "Forgot
 * password?" flow (one-time code to this email). The initial password is a
 * per-account random value nobody knows (unrevealedInitialPassword), and
 * must_change_password stays set as a second line of defence.
 *
 * An EXISTING account for the address is never touched — not its password,
 * roles, scope or link — which is what the early return below guarantees.
 */
export async function createEmployeeLogin(client, emp) {
  const email = normalizeLoginEmail(emp.personal_email || emp.company_email || "");
  if (!email) return null;

  const { rows: existing } = await client.query(
    `SELECT id FROM users WHERE ${LOGIN_EMAIL_KEY} = $1 LIMIT 1`,
    [email]
  );
  if (existing.length) return null; // don't clobber an existing account

  const name = `${emp.first_name || ""} ${emp.last_name || ""}`.trim() || email;
  const hash = await unrevealedInitialPasswordHash();

  // ON CONFLICT on the case-insensitive login index: an account created for
  // the same address between the check above and this INSERT (any case) means
  // "skip the login", exactly like the check — it must not abort the hire's
  // whole transaction with a unique violation.
  const { rows: [user] } = await client.query(
    `INSERT INTO users (name, email, password_hash, role, department, is_active, company_id, employee_id, must_change_password)
     VALUES ($1, $2, $3, 'employee', $4, true, $5, $6, true)
     ON CONFLICT ((LOWER(BTRIM(email)))) DO NOTHING
     RETURNING id`,
    [name, email, hash, emp.department || null, emp.company_id ?? null, emp.id]
  );
  if (!user) return null;

  // Roles live in user_roles; users.role above is only the primary-role mirror.
  // Without this the new login would hold no effective permissions at all.
  await syncPrimaryRole(user.id, 'employee', emp.company_id ?? null, null, client);

  // Primary scope so the login token resolves the right company/branch and the
  // employee isn't blocked by scope-guarded endpoints.
  if (emp.company_id != null) {
    await client.query(
      `INSERT INTO user_scope (user_id, company_id, branch_id, is_primary)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, company_id, branch_id) DO NOTHING`,
      [user.id, emp.company_id, emp.branch_id ?? null]
    );
  }

  return { email, created: true };
}

/**
 * Mandatory fields for a NEW employee master record.
 *
 * Department and designation were accepted blank, which is how 24 of the 34
 * live rows in company 1 reached the All Employees register with Department and
 * Role rendering as em-dashes. They are not decoration: department drives the
 * dashboard's department stack, the departmental approval routes and payroll
 * cost-centre allocation; designation drives the org chart and the grade/band
 * ladder. A row missing either is not a usable employee master record.
 *
 * Status is here too because the COLUMN DEFAULT is `'Probation'`, so every
 * creation path that omitted status silently filed the new hire as a
 * probationer — eleven single-employee tenants in the live database read
 * 'Probation' for exactly that reason. Requiring it makes the default
 * unreachable through the API instead of leaving it as a trap.
 */
export const REQUIRED_ON_CREATE = [
  // Last name was required by the Add Employee form (its label has carried the
  // asterisk all along) and by NOTHING on this side, so a direct POST could
  // create a half-named person the form could not have produced. It is safe to
  // require: all 46 live employee rows already have one, so this closes a
  // front/back disagreement rather than inventing a mandatory field.
  ['last_name',    'Last name'],
  ['department',   'Department'],
  ['designation',  'Role / Designation'],
  ['status',       'Employment status'],
  // Joining date is CRITICAL rather than cosmetic, and getEmployeeAnalytics
  // already classifies it that way: without it the employee is absent from
  // every hiring window, lands in the tenure chart's 'Not recorded' bucket,
  // has no probation clock and no service-length calculation. It is also
  // always known at the moment of hire, which is the only moment this list
  // applies to -- an existing row without one is left alone.
  ['joining_date', 'Joining date'],
];

/**
 * Same shape the Add Employee form checks. Validated server-side too because
 * `company_email` becomes the login identity (`createEmployeeLogin` keys the
 * `users` row on it), and the API accepted literally any non-empty string --
 * including 'null', which cleanText would have turned into a NULL required field.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A client-input error, not a server fault. `respondError` (shared/pgErrors.js)
 * honours `statusCode`, so tagging the throw is all it takes to stop these
 * surfacing as 500s — a rejected master value, a missing required field and a
 * duplicate employee code are all things the caller can fix and retry.
 */
function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * ZONE — resolve `employees.zone_id` from the zone master.
 *
 * ── Why both columns ────────────────────────────────────────────────────────
 * `employees` carries BOTH `zone` (varchar) and `zone_id` (FK -> master_zones).
 * `zone_id` was NULL on all 46 rows while the text column held the value: the
 * column and the FK existed and nothing had ever written them, the same dead
 * FK `branch_id` turned out to be. Backfilled by migration
 * 20260929000003; this is what stops NEW rows re-creating the gap.
 *
 * The FK matters because `holidays.zone_id` is a real consumer — the Holiday
 * Calendar assigns holidays per zone and can only use master rows with an id.
 * A zone that exists only as text on an employee cannot be given a holiday.
 *
 * ⚠ `master_zones` is a SHARED table (no company_id column, like departments
 * and designations — verified against information_schema). So there is no
 * tenant check to make here, and adding one would be wrong: it would refuse
 * every zone for every tenant. The check is existence + active.
 *
 * Accepts either the id or the name, because the picker sends a name today and
 * the row id once it has one. Returns the master row, so the caller writes a
 * `zone` text that came from the master rather than from the request.
 */
export async function resolveZone(client, zoneId, zoneName) {
  const rawId = String(zoneId ?? '').trim();
  if (rawId) {
    const id = parseInt(rawId, 10);
    if (!Number.isInteger(id)) throw badRequest(`"${zoneId}" is not a valid zone.`);
    const { rows } = await client.query(
      `SELECT id, name FROM master_zones WHERE id = $1 AND is_active = true LIMIT 1`, [id]);
    if (!rows.length) throw badRequest('The selected zone does not exist.');
    return rows[0];
  }
  const name = String(zoneName ?? '').trim();
  if (!name) return null;                      // Zone is optional.
  // A name with no matching master row is NOT an error: the zone master is
  // shared and only an admin may add to it, so refusing here would block a hire
  // over a value HR cannot create. The text is kept and zone_id stays null,
  // exactly as before — GET /master/zones surfaces it as an `unmanaged` option
  // so an admin can promote it.
  const { rows } = await client.query(
    `SELECT id, name FROM master_zones
      WHERE is_active = true AND LOWER(BTRIM(name)) = LOWER(BTRIM($1)) LIMIT 1`, [name]);
  return rows[0] || null;
}

/**
 * LOCATION — resolve and tenant-check `employees.branch_id`.
 *
 * ── How Location is modelled ────────────────────────────────────────────────
 * `branches` is the location master: company-scoped (it has a real company_id,
 * unlike master_departments/designations/zones, which are shared tables), with
 * name / code / city / state / branch_type, an admin CRUD API at /branches,
 * and an existing FK from `employees.branch_id`.
 *
 * ⚠ That FK was NULL on all 46 live employee rows — the column and the table
 * existed, and nothing ever wrote the link, because the only Location control
 * on either employee form was a free-text <input> writing the `location`
 * VARCHAR beside it. That column now holds 'Srivil', 'Srivi' and 'czxzx'. The
 * classic "empty column with zero writers" this codebase has hit before; see
 * [[project_empty_table_seed_probe_10_tables]].
 *
 * ── What is stored ──────────────────────────────────────────────────────────
 * BOTH. `branch_id` is the canonical value and the thing to join on.
 * `location` keeps the branch's display name, because several readers already
 * render it as a plain string (EmployeeProfile's two Location rows, the All
 * Employees column, the employee export) and rewriting them is not this pass.
 * Derived from the branch rather than accepted from the client, so the two
 * cannot disagree.
 *
 * ── Why the ownership check ─────────────────────────────────────────────────
 * `branch_id` was read straight off the request body and inserted. Nothing
 * checked whose branch it was, and GET /branches was itself unscoped — so the
 * ids to send were being handed out. Cross-tenant by construction.
 *
 * @param {import('pg').PoolClient} client  inside the caller's transaction
 * @param {*}  branchId        raw value from the request; blank/absent is fine
 * @param {number|null} companyId
 * @returns {Promise<{id:number,name:string}|null>} the branch, or null when none
 */
export async function assertValidBranch(client, branchId, companyId) {
  const raw = String(branchId ?? '').trim();
  if (!raw) return null;                      // Location is optional.
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id)) {
    throw badRequest(`"${branchId}" is not a valid location.`);
  }
  const { rows } = await client.query(
    `SELECT id, name FROM branches
      WHERE id = $1
        AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2)
      LIMIT 1`,
    [id, companyId ?? null],
  );
  if (!rows.length) {
    // Deliberately does NOT distinguish "no such branch" from "another
    // company's branch": the difference is exactly the fact a prober wants.
    throw badRequest('The selected location does not exist in this company.');
  }
  return rows[0];
}

/**
 * WORKFORCE CATEGORY — resolve and tenant-check `employees.workforce_category_id`.
 *
 * An FK to a master_values row of type WORKFORCE_CATEGORY (migration
 * 20261013000001). Valid means: that type, and shared (company_id NULL) or the
 * employee's own company. Same shape as assertValidBranch, including the one
 * error for "no such category" and "another company's category".
 *
 * Active is required for a NEW assignment only. Re-saving the category an
 * employee already has is allowed even after it was deactivated: Edit Employee
 * sends every field, and retiring a category must not make every employee
 * filed under it impossible to edit.
 *
 * The database trigger checks type and company too; this runs first so the
 * caller gets a 400 with a sentence instead of a constraint error.
 *
 * @param {import('pg').PoolClient} client
 * @param {*}  raw         from the request; blank, null or 'null' means none
 * @param {number|null} companyId
 * @param {number|null=} currentId  the employee's stored category (update path)
 * @returns {Promise<{id:number,name:string}|null>}
 */
export async function assertValidWorkforceCategory(client, raw, companyId, currentId = null) {
  const text = String(raw ?? '').trim();
  if (!text || isNullishText(text)) return null;          // optional; blank clears
  if (!/^\d+$/.test(text)) throw badRequest(`"${raw}" is not a valid workforce category.`);
  const id = parseInt(text, 10);
  const { rows } = await client.query(
    `SELECT id, value AS name, is_active FROM master_values
      WHERE id = $1
        AND type = 'WORKFORCE_CATEGORY'
        AND (company_id IS NULL OR ($2::int IS NOT NULL AND company_id = $2))
      LIMIT 1`,
    [id, companyId ?? null],
  );
  if (!rows.length) {
    throw badRequest('The selected workforce category does not exist in this company.');
  }
  if (!rows[0].is_active && id !== currentId) {
    throw badRequest(`"${rows[0].name}" is no longer an active workforce category.`);
  }
  return { id: rows[0].id, name: rows[0].name };
}

/**
 * A numeric form field, validated once for both the create and the update path.
 *
 * A number input POSTs '' when untouched and `Number('')` is 0, so a plain
 * `Number(x)` records a salary of zero rather than "not stated". Blank stays
 * blank here; anything present must be a real number in a believable range.
 *
 * The range is not pedantry. `previous_years_2` held **123** on a live employee
 * record — the profile's Total Experience dutifully added it up and displayed
 * "124 years" — and nothing anywhere rejected it on the way in. The column is a
 * plain integer, so the database was never going to.
 */
function numericField(value, label, { min, max, integer = false }) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`"${value}" is not a valid ${label.toLowerCase()}.`);
  if (integer && !Number.isInteger(n)) throw badRequest(`${label} must be a whole number.`);
  if (n < min || n > max) throw badRequest(`${label} must be between ${min} and ${max}. Got ${n}.`);
  return n;
}

// 0 is allowed — an unpaid intern is a real record. The ceiling is a typo
// catcher, not a policy: 10 crore is an absurd basic salary, 1000000000 is a
// slipped keypress.
const SALARY_RANGE = { min: 0, max: 100000000 };
// Nobody has 60 years of prior service, and 123 is what a keyboard mash looks
// like in an integer column.
const YEARS_RANGE = { min: 0, max: 60, integer: true };

/**
 * Probation fields for a NEW employee. Returns
 * { probation_months, probation_end_date } (both possibly null).
 *
 * Applies when the hire is filed as Probation, or whenever the request sends a
 * period or end date. Otherwise nothing is written. Bad input is a 400, never a
 * silently substituted default.
 */
async function probationFieldsForCreate({ status, joining_date, probation_months, probation_end_date, company_id }) {
  const sent = (v) => v !== undefined && v !== null && String(v).trim() !== '' && !isNullishText(String(v));
  const monthsSent = sent(probation_months);
  const endSent = sent(probation_end_date);
  const onProbation = String(status ?? '').trim().toLowerCase() === 'probation';
  if (!onProbation && !monthsSent && !endSent) return { probation_months: null, probation_end_date: null };

  const policyMonths = company_id != null
    ? (await getProbationPolicy(pool, company_id)).probation_months
    : DEFAULT_PROBATION_MONTHS;
  try {
    const r = resolveProbationWrite({
      joiningDate: joining_date,
      months: monthsSent ? probation_months : undefined,
      endDate: endSent ? probation_end_date : undefined,
      defaultMonths: policyMonths,
    });
    return { probation_months: r.probation_months ?? null, probation_end_date: r.probation_end_date ?? null };
  } catch (e) {
    if (e instanceof RangeError) throw badRequest(e.message);
    throw e;
  }
}

export const addEmployee = async (data) => {
  if (!data) {
    throw badRequest("Request body is empty");
  }

  // Extract only the fields that are being sent
  const {
    company_id,
    office_id: providedOfficeId,
    first_name,
    last_name,
    company_email,
    personal_email,
    phone,
    company_phone,
    gender,
    blood_group,
    dob,
    marital_status,
    father_name,
    mother_name,
    spouse_name,
    anniversary_date,
    current_address,
    permanent_address,
    highest_qualification,
    basic_qualification,
    department,
    designation,
    employee_role,
    reporting_manager,
    reporting_manager_id,
    location,
    joining_date,
    employment_type,
    skill_type,
    zone,
    zone_id,
    status,
    is_field_employee,
    previous_company_1,
    previous_role_1,
    previous_years_1,
    previous_company_2,
    previous_role_2,
    previous_years_2,
    bank_name,
    branch_name,
    account_number,
    ifsc_code,
    nominee_name,
    emergency_name,
    emergency_phone,
    emergency_relationship,
    pan_number,
    aadhaar_number,
    pf_number,
    uan_number,
    esic_number,
    notes,
    photo_file,
    pan_file,
    aadhaar_file,
    cancelled_cheque_file,
    bank_statement_file,
    resume_file,
    offer_letter_file,
    grade,
    band,
    branch_id,
    passport_number,
    driving_license_number,
    notice_period_days,
    basic_salary,
    special_allowance,
    workforce_category_id,
    // Convert to Employee: the internship this hire comes from, and the HR user
    // doing it (set by the controller, never from the body). See
    // modules/hr/internConversion.js.
    from_intern_id,
    converted_by_user_id,
    // Probation — see probationFieldsForCreate above.
    probation_months,
    probation_end_date,
  } = data;
  // Reassigned by a conversion (the intern's stored files) — see below.
  let photoFile = photo_file;
  let resumeFile = resume_file;
  const fromInternId = String(from_intern_id ?? '').trim() === '' || String(from_intern_id) === 'null'
    ? null : Number(from_intern_id);
  if (fromInternId != null && !(Number.isInteger(fromInternId) && fromInternId > 0)) {
    throw badRequest('from_intern_id must be an intern id.');
  }

  if (!first_name || !company_email) {
    throw badRequest("First name and company email are required");
  }

  // Blank-but-present counts as missing. `department: ''` is exactly what the
  // Add Employee form POSTs for an untouched picker, and `''` sailed through
  // every truthiness guard in this function.
  const missing = REQUIRED_ON_CREATE
    .filter(([key]) => !String(data[key] ?? '').trim())
    .map(([, label]) => label);
  if (missing.length) {
    throw badRequest(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for an employee record.`,
    );
  }

  // One canonical spelling, decided here rather than stored as whatever the
  // caller typed. See shared/employeeStatus.js — WRITABLE_STATUSES is a much
  // shorter list than the spellings the READ vocabulary has to tolerate.
  const canonicalStatus = canonicalWritableStatus(status);
  if (!canonicalStatus) {
    throw badRequest(
      `"${status}" is not a valid employment status. Expected one of: ${WRITABLE_STATUSES.join(', ')}.`,
    );
  }

  for (const [field, label] of [['company_email', 'Company email'], ['personal_email', 'Personal email']]) {
    const value = String(data[field] ?? '').trim();
    // personal_email is optional, so only a NON-EMPTY value is checked.
    if (!value && field === 'personal_email') continue;
    if (!EMAIL_RE.test(value)) {
      throw badRequest(`"${value}" is not a valid ${label.toLowerCase()} address.`);
    }
  }

  // A duplicate company email is a duplicate person. There is no unique index on
  // the column (the only unique index on this table besides the PK is
  // source_candidate_id), so without this nothing stopped one.
  const dupeEmail = await pool.query(
    `SELECT id, office_id FROM employees
      WHERE LOWER(company_email) = LOWER($1)
        AND ($2::int IS NULL OR company_id = $2)
      LIMIT 1`,
    [String(company_email).trim(), company_id ?? null],
  );
  if (dupeEmail.rows.length) {
    const held = dupeEmail.rows[0].office_id || `#${dupeEmail.rows[0].id}`;
    throw badRequest(`${company_email} already belongs to employee ${held}.`, 409);
  }

  // Compensation and prior-experience figures — same rule on create and update,
  // see numericField() above the module's exports.
  const basicSalary = numericField(basic_salary, 'Basic salary', SALARY_RANGE);
  const specialAllowance = numericField(special_allowance, 'Special allowance', SALARY_RANGE);
  const prevYears1 = numericField(previous_years_1, 'Years at company 1', YEARS_RANGE);
  const prevYears2 = numericField(previous_years_2, 'Years at company 2', YEARS_RANGE);

  // A malformed date must be a 400 from here, not a 500 out of Postgres' date
  // parser. `new Date('YYYY-MM-DD')` is UTC midnight, so compare against a UTC
  // "today" -- comparing against local now makes a same-day hire look like a
  // future one for anyone east of UTC, which is everyone using this deployment.
  const joined = new Date(`${String(joining_date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(joined.getTime())) {
    throw badRequest(`"${joining_date}" is not a valid joining date. Expected YYYY-MM-DD.`);
  }
  const todayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (joined > todayUtc) {
    // Not refused: a confirmed future start date is a real thing HR records
    // ahead of time. Only an implausible one is.
    const yearsAhead = (joined - todayUtc) / (365.2425 * 864e5);
    if (yearsAhead > 2) {
      throw badRequest(`Joining date ${String(joining_date).slice(0, 10)} is more than two years in the future.`);
    }
  }

  // DATE OF BIRTH — plausible against the company's age limits (editable on
  // Workforce Analytics → Settings). Optional: a blank DOB is not refused.
  if (String(dob ?? '').trim()) {
    const problem = dobProblem(dob, await getWorkforcePolicy(pool, company_id ?? null));
    if (problem) throw badRequest(problem);
  }

  // PROBATION — the one server-side rule (shared/probationDates.js), replacing
  // a hidden joining_date + 90 days that the form never showed and that three
  // other readers contradicted. Calculated for a hire filed as Probation, or
  // for any status when the request names a period or an end date explicitly;
  // an explicit end date is stored as given. The company's configured period
  // (default 6 months) applies when none is sent. A hire filed as Active with
  // no probation fields gets no probation date at all — it used to get one
  // silently, which leave then read as "still on probation".
  const probation = await probationFieldsForCreate({
    status, joining_date, probation_months, probation_end_date, company_id,
  });

  // Validate PAN format when provided (5 letters, 4 digits, 1 letter). Empty is allowed.
  if (pan_number && String(pan_number).trim() && !validatePAN(pan_number)) {
    throw Object.assign(new Error("Invalid PAN format. Expected 10 characters, e.g. ABCDE1234F."), { status: 400 });
  }

  // ⚠ company_id is passed now. The employees-fallback inside
  // validateMasterValue used to query `employees` with NO tenant predicate, so
  // any string ANY tenant had ever stored in `department`/`designation` was an
  // accepted value here — a validator strictly wider than the picker it is
  // supposed to mirror.
  await validateMasterValue(department, 'master_departments', company_id ?? null);
  await validateMasterValue(designation, 'master_designations', company_id ?? null);
  await validateMasterValue(grade, 'master_grades', company_id ?? null);
  await validateMasterValue(band, 'master_bands', company_id ?? null);

  // Filled by assertValidBranch inside the transaction: the branch row behind
  // `branch_id`, whose name becomes the denormalised `location` text.
  let resolvedBranch = null;
  // Same for the zone master row behind `zone_id` / `zone`.
  let resolvedZone = null;
  // The WORKFORCE_CATEGORY row behind `workforce_category_id`.
  let resolvedCategory = null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // CONVERSION. Locked and checked before anything is written, so an intern
    // that is not (or no longer) convertible creates no employee at all. The
    // stored photo / résumé FILES are reused when HR did not upload new ones.
    let conversion = null;
    if (fromInternId != null) {
      conversion = await lockConvertibleIntern(client, fromInternId, company_id ?? null);
      if (!photoFile && conversion.photo_url) photoFile = conversion.photo_url;
      if (!resumeFile && conversion.resume_file) resumeFile = conversion.resume_file;
    }

    // Employee ID is minted server-side, inside this transaction, under a
    // company-scoped advisory lock. See shared/employeeCode.js for why the
    // generator this replaces handed out a code that was already in use: it
    // read the globally-last row with no company filter, that row belonged to
    // another tenant and had a NULL office_id, so it restarted from 'EMP001' —
    // which employee id=1 has held since February.
    //
    // A caller-supplied code goes through the same check under the same lock.
    // The old code's only duplicate check lived in the caller-supplied branch,
    // so the auto-generated path — the one every UI hire uses — was the single
    // path nothing checked at all.
    // A brand-new row cannot be in a cycle, so this checks the two things that
    // CAN be wrong at creation: the manager exists, and the manager is in this
    // company. A cross-tenant manager edge would make one company's org-chart
    // walk cross into another's — `GET /employees/direct-reports` joins on this
    // column with no company predicate on the manager side.
    await assertValidManager(client, {
      employeeId: null,
      managerId: reporting_manager_id,
      companyId: company_id ?? null,
      label: `${first_name || ''} ${last_name || ''}`.trim() || 'This employee',
    });

    // LOCATION. `branch_id` was accepted straight off the request body and
    // written to the column with no check at all, so a POST naming another
    // tenant's branch filed this employee at that tenant's site — and
    // `GET /branches` used to hand out every tenant's branch ids, so the value
    // to send was not even a guess. Verified here, inside the same transaction.
    resolvedBranch = await assertValidBranch(client, branch_id, company_id ?? null);

    // ZONE. Writes `zone_id` alongside the text so a new row cannot re-create
    // the dead-FK state the migration just cleaned up.
    resolvedZone = await resolveZone(client, zone_id, zone);

    // WORKFORCE CATEGORY. Optional; type- and tenant-checked like the branch.
    resolvedCategory = await assertValidWorkforceCategory(client, workforce_category_id, company_id ?? null);

    let office_id;
    if (String(providedOfficeId ?? '').trim()) {
      office_id = await assertCodeAvailable(client, providedOfficeId, company_id ?? null);
    } else {
      const minted = await nextEmployeeCode(client, company_id ?? null);
      office_id = await assertCodeAvailable(client, minted, company_id ?? null);
    }

    const query = `
      INSERT INTO employees (
        office_id, first_name, last_name, company_email, personal_email,
        phone, company_phone, gender, blood_group, dob, marital_status,
        father_name, mother_name, spouse_name, anniversary_date,
        current_address, permanent_address, highest_qualification, basic_qualification,
        department, designation, employee_role, reporting_manager, reporting_manager_id, location, joining_date,
        employment_type, skill_type, zone, status,
        previous_company_1, previous_role_1, previous_years_1,
        previous_company_2, previous_role_2, previous_years_2,
        bank_name, branch_name, account_number, ifsc_code, nominee_name,
        emergency_name, emergency_phone, emergency_relationship,
        pan_number, aadhaar_number, pf_number, uan_number, esic_number, notes,
        photo_url, pan_file, aadhaar_file, cancelled_cheque_file,
        bank_statement_file, resume_file, offer_letter_file,
        company_id, probation_end_date,
        grade, band, branch_id, passport_number, driving_license_number, notice_period_days,
        is_field_employee,
        -- Appended LAST on purpose: this INSERT takes 60+ POSITIONAL
        -- parameters, and adding a column in the middle silently shifts every
        -- $n after it onto the wrong column.
        zone_id, basic_salary, workforce_category_id, probation_months
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43,
        $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57,
        $58, $59, $60, $61, $62, $63, $64, $65, $66, $67, $68, $69, $70
      )
      RETURNING *;
    `;

    const values = [
      office_id,
      first_name,
      last_name || "",
      company_email,
      personal_email || "",
      phone || "",
      company_phone || "",
      gender || "",
      blood_group || "",
      dob || null,
      marital_status || "",
      father_name || "",
      mother_name || "",
      spouse_name || "",
      anniversary_date || null,
      current_address || "",
      permanent_address || "",
      highest_qualification || "",
      basic_qualification || "",
      department || "",
      designation || "",
      employee_role || null,
      // cleanText, not `|| ""`: the string "null" is truthy, and that is
      // literally what three live rows hold in this column. See shared/nullish.js.
      cleanText(reporting_manager) || "",
      toIntOrNull(reporting_manager_id),
      // The branch's own name when one was picked, so `location` and `branch_id`
      // cannot drift; the typed value only when no branch was chosen.
      resolvedBranch ? resolvedBranch.name : (location || ""),
      joining_date || null,
      // NULL, not "". An untouched picker POSTs the empty string, and `|| ""`
      // wrote it straight through — so "not recorded" was stored two ways, only
      // one of which survives an IS NOT NULL or a truthiness check. Migration
      // 20260929000003 cleaned the four rows that had already accumulated;
      // without this the create path kept making new ones.
      cleanText(employment_type),
      skill_type || "",
      // From the master row when one matched, so `zone` and `zone_id` cannot
      // disagree; the typed text only when the zone master has no such row.
      resolvedZone ? resolvedZone.name : (zone || ""),
      canonicalStatus,
      previous_company_1 || "",
      previous_role_1 || "",
      prevYears1 ?? 0,
      previous_company_2 || "",
      previous_role_2 || "",
      prevYears2 ?? 0,
      bank_name || "",
      branch_name || "",
      account_number || "",
      ifsc_code || "",
      nominee_name || "",
      emergency_name || "",
      emergency_phone || "",
      emergency_relationship || "",
      pan_number || "",
      aadhaar_number || "",
      pf_number || "",
      uan_number || "",
      esic_number || "",
      notes || "",
      photoFile || null,
      pan_file || null,
      aadhaar_file || null,
      cancelled_cheque_file || null,
      bank_statement_file || null,
      resumeFile || null,
      offer_letter_file || null,
      company_id ?? null,
      // Probation end date: probationFieldsForCreate (shared/probationDates.js).
      probation.probation_end_date ?? null,
      grade || null,
      band || null,
      toIntOrNull(branch_id),
      passport_number || null,
      driving_license_number || null,
      toIntOrNull(notice_period_days),
      is_field_employee === true || is_field_employee === 'true',
      // $67 — see the column list above.
      resolvedZone ? resolvedZone.id : null,
      // $68. `employees.basic_salary` is the FALLBACK payroll reads when an
      // employee has no salary assignment:
      //   COALESCE(esa.basic_salary, e.basic_salary, 0)  -- payroll.service.js
      // It is not a second source of truth — `employee_salary_assignments` is
      // canonical and wins — but leaving it NULL while the assignment says
      // 55000 puts the two out of step from day one. The increment path already
      // writes both (increments.routes.js UPDATEs this column after each
      // approved increment); this makes the hire path agree with it.
      basicSalary,
      // $69 — the validated id, never the raw request value.
      resolvedCategory ? resolvedCategory.id : null,
      // $70 — the period the end date was calculated from; null when HR gave
      // an explicit end date only, or when no probation applies.
      probation.probation_months ?? null,
    ];

    const result = await client.query(query, values);
    const emp = result.rows[0];
    if (conversion) {
      await linkConversion(client, { ...conversion, employee: emp, userId: converted_by_user_id });
      emp.source_intern_id = conversion.intern.id;
    }

    // Auto-provision a login account so the employee can sign in with their
    // personal email. Kept in the same transaction so an employee is never left
    // without a usable login.
    const login = await createEmployeeLogin(client, emp);

    // New hires were invisible to payroll until HR remembered to add a salary
    // assignment by hand — payroll.service.js's LEFT JOIN LATERAL just returns
    // NULL basic_salary/structure_id for anyone with no row here. Auto-enroll
    // on the company's default salary_structures template (if one is marked
    // is_default).
    //
    // The figure comes from the form when HR entered one. It used to be left to
    // the column's own DEFAULT of 30000, which is how 83 of 85 rows in this
    // table came to hold exactly 30000: Add Employee had no salary field, and
    // the only screen that could set one (HR → Salary Structure → Assign) 500'd
    // on every call until 2026-09-30. A column default is not a salary, and it
    // is indistinguishable from one once it is in the table.
    //
    // This is the SAME row the Assign screen later upserts — one revision per
    // employee per effective date — so entering a salary at hire and correcting
    // it afterwards touches one record, not two.
    try {
      // The company's own default structure first, else the shared template.
      const { rows: defStruct } = await client.query(
        `SELECT id FROM salary_structures
          WHERE is_default = true AND (company_id = $1 OR company_id IS NULL)
          ORDER BY company_id NULLS LAST, id LIMIT 1`, [emp.company_id]
      );
      const effectiveFrom = joining_date || new Date().toISOString().slice(0, 10);
      const { rows: payrollCfg } = await client.query(
        `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [emp.company_id]);
      const ctcModeOn = normalizePayrollSettings(payrollCfg[0]?.settings || {}).settings.ctc_mode;
      if (basicSalary != null && ctcModeOn) {
        // CTC mode: salary entered at hire becomes a DRAFT proposal that an
        // approver finalises (PAYROLL_DATA_FLOW_AUDIT.md Part 4) — never a
        // revision written straight into payroll's table. In a savepoint, so
        // a proposal problem cannot abort the hire itself.
        await client.query('SAVEPOINT hire_salary_proposal');
        try {
          await createProposal({ company_id: emp.company_id, employee_id: emp.id, structure_id: defStruct[0]?.id ?? null,
            effective_from: String(effectiveFrom).slice(0, 10), basic_monthly: basicSalary, source_type: 'manual', client });
          await client.query('RELEASE SAVEPOINT hire_salary_proposal');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT hire_salary_proposal');
          console.error('[addEmployee] salary proposal not created:', e.message);
        }
      } else if (basicSalary != null) {
        await client.query(
          `INSERT INTO employee_salary_assignments
             (employee_id, structure_id, effective_from, basic_salary, special_allowance)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (employee_id, effective_from) DO NOTHING`,
          [emp.id, defStruct[0]?.id ?? null, effectiveFrom, basicSalary, specialAllowance ?? 0]
        );
      }
      // No salary stated → no revision row. This branch used to INSERT one
      // anyway and let the column DEFAULT of 30000 stand in — a salary nobody
      // set, which payroll then paid (EMP037, EMP039). The default is dropped
      // in migration 20261020000001; payroll lists this employee as "not
      // eligible — no salary revision" until HR records one, which is the
      // honest state of the data. Not an INSERT that fails NOT NULL either:
      // inside this transaction that would abort the whole hire.
    } catch (e) {
      console.error('[addEmployee] payroll auto-enrollment failed:', e.message);
    }

    // Auto-init the onboarding checklist (previously required a separate
    // manual POST /onboarding/progress/:employee_id/init call HR had to
    // remember to make - see AUTOMATION_OPPORTUNITY_AUDIT.md section 9.1).
    try {
      await initOnboardingChecklist(client, company_id ?? null, emp.id);
    } catch (e) {
      console.error('[addEmployee] onboarding checklist init failed:', e.message);
    }

    await client.query("COMMIT");
    return login ? { ...emp, login } : emp;
  } catch (err) {
    await client.query("ROLLBACK");
    // Carry the classification through the re-wrap: without this a 400 from
    // validateMasterValue re-emerged as an unclassified 500.
    const wrapped = new Error(`Failed to add employee: ${err.message}`);
    if (err.statusCode) wrapped.statusCode = err.statusCode;
    if (err.code) wrapped.code = err.code;
    if (err.constraint) wrapped.constraint = err.constraint;
    if (err.detail) wrapped.detail = err.detail;
    throw wrapped;
  } finally {
    client.release();
  }
};

const HR_PII_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'HR', 'Admin', 'SuperAdmin'];

const SALARY_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin',
                      'finance_manager', 'HR', 'Admin', 'SuperAdmin'];

// Salary/bank block — stripped for anyone outside SALARY_ROLES. This is NOT
// the gate on the master Basic: HR_PII_ROLES return before it (hr_exec read
// every Basic that way). Basic goes out only to payroll:view holders or the
// employee themself — employee.controller.js withSalaryMasking (PC-01).
const SALARY_FIELDS = ['basic_salary', 'bank_name', 'branch_name', 'account_number',
                       'ifsc_code', 'nominee_name', 'pf_number', 'uan_number', 'esic_number'];

// Dropped outright for non-HR callers: identity documents, home/family details,
// emergency contacts and the uploaded-document paths. These live on the
// `employees` row only because HR maintains them there — no picker, roster,
// team view or directory has ever needed them, so there is nothing to degrade
// by removing them rather than blanking them.
const PII_DROP_FIELDS = [
  'dob', 'personal_email', 'blood_group',
  'father_name', 'mother_name', 'spouse_name', 'anniversary_date', 'marital_status',
  'emergency_name', 'emergency_phone', 'emergency_relationship',
  'passport_number', 'driving_license_number',
  'pan_file', 'aadhaar_file', 'cancelled_cheque_file', 'bank_statement_file',
  'resume_file', 'offer_letter_file',
  'notes',
];

// Roles are many-to-many (user_roles), so callers pass the whole set from
// rolesOf(req). A bare string is still accepted for the legacy single-role
// call sites. Comparison is case-insensitive because older user rows store
// mixed-case codes ('HR', 'Admin').
function holdsRole(role, allowed) {
  const held = (Array.isArray(role) ? role : [role])
    .filter(Boolean)
    .map(r => String(r).toLowerCase());
  const want = allowed.map(r => r.toLowerCase());
  return held.some(r => want.includes(r));
}

function maskPII(emp, role, isSelf = false) {
  if (!emp) return emp;
  if (holdsRole(role, HR_PII_ROLES)) return emp;
  // Self sees their own record in full EXCEPT `notes`: that is HR's free-text
  // remark about the employee (Edit Employee → Notes), and nothing marks it as
  // meant for the employee. Same rule as GET /notes/:employeeId (HR only).
  if (isSelf) {
    const { notes: _hrNote, ...own } = emp;
    return own;
  }
  const out = { ...emp };
  // Aadhaar: show only last 4 digits
  if (out.aadhaar_number) out.aadhaar_number = `XXXX XXXX ${String(out.aadhaar_number).slice(-4)}`;
  // PAN: mask first 6 characters, show last 4 (10-char total preserved)
  if (out.pan_number)     out.pan_number     = `XXXXXX${String(out.pan_number).slice(-4)}`;
  // Bank account: mask all but last 4
  if (out.account_number) out.account_number = `XXXX${String(out.account_number).slice(-4)}`;
  // Address PII — redact for non-HR callers
  if (out.current_address)   out.current_address   = '[RESTRICTED]';
  if (out.permanent_address) out.permanent_address = '[RESTRICTED]';
  // Salary — strip for non-salary-role callers
  if (!holdsRole(role, SALARY_ROLES)) {
    for (const f of SALARY_FIELDS) delete out[f];
  }
  for (const f of PII_DROP_FIELDS) delete out[f];
  return out;
}

// ── Who may read ANOTHER employee's record ───────────────────────────────────
// Everyone else is a directory-tier caller: for a colleague they get the
// company-phonebook projection below and nothing more. maskPII alone left them
// the personal phone (which the directory itself withholds), the last four
// digits of PAN and Aadhaar, exit reason, previous employers, grade/band and
// the biometric id. These are the roles that hold the Employees menu or an HR
// / salary seat — the ones whose screens actually read a colleague's record.
// Self is always allowed in full (see getEmployee in the controller).
const FULL_RECORD_ROLES = [...new Set([...HR_PII_ROLES, ...SALARY_ROLES, 'manager', 'department_head'])];

export function holdsFullRecordAccess(role) {
  return holdsRole(role, FULL_RECORD_ROLES);
}

// ── GET /employees for a directory-tier caller: a picker row ────────────────
// The list is mostly read by PICKERS — assignee, delegate, owner, team, target
// owner (ApplyLeave, LeaveCalendar, AssignTasks, InstallationRequests, CAPA,
// SalesTargets, CRM pursuits, WorkCentres, ApprovalDelegation, …). Those read
// names, codes, department, designation, status and the org/attendance keys
// below. They never needed the personal phone, the masked PAN/Aadhaar, gender,
// qualifications, previous employers, exit reason, grade/band or the biometric
// id, all of which maskPII still left in. Record-tier callers
// (FULL_RECORD_ROLES — the Employees menu, HR and salary seats) keep the full
// maskPII'd rows: All Employees, HR dashboards and payroll read those.
const PICKER_FIELDS = [
  'id', 'office_id', 'name', 'first_name', 'last_name',
  'designation', 'department', 'sub_department', 'company_email', 'status',
  'photo_url', 'location', 'joining_date',
  'reporting_manager', 'reporting_manager_id',
  'company_id', 'branch_id', 'zone_id', 'work_centre_id', 'default_shift_id', 'is_field_employee',
];
function toPickerRow(emp) {
  const out = {};
  for (const f of PICKER_FIELDS) if (f in emp) out[f] = emp[f];
  return out;
}

/**
 * The company phonebook projection — the ONE definition of what
 * GET /employees/directory returns, and what GET /employees/:id returns to a
 * directory-tier caller asking about someone else. Current staff only, one
 * company. `phone` is the personal number and is returned only when
 * `canSeePhone`; `id` narrows to a single row.
 */
export const getDirectoryEntries = async ({ companyId = null, canSeePhone = false, id = null } = {}) => {
  const { rows } = await pool.query(
    `SELECT
       e.id,
       e.office_id,
       TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
       e.first_name,
       e.last_name,
       e.designation,
       e.department,
       e.company_email,
       CASE WHEN $2::boolean THEN e.phone ELSE NULL END AS phone,
       e.status,
       e.photo_url,
       e.joining_date,
       e.location,
       e.reporting_manager,
       TO_CHAR(e.dob,          'MM-DD') AS birth_md,
       TO_CHAR(e.joining_date, 'MM-DD') AS anniversary_md,
       EXISTS (
         SELECT 1 FROM leave_applications la
         WHERE la.employee_id = e.id
           AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
           AND (la.hr_status = 'approved' OR la.manager_status = 'approved')
       ) AS on_leave_today
     FROM employees e
     -- isCurrentSql, not a hand-written list. This was a FIFTH copy of the
     -- vocabulary and it disagreed with the canonical one in both directions:
     -- it excluded 'notice_period' and 'notice period' (who ARE still
     -- employed) while letting the capitalised 'Notice' through, so which
     -- of three equivalent spellings a row happened to hold decided whether
     -- that person appeared in the company phonebook at all. It also missed
     -- 'exited', 'relieved' and 'absconded' entirely.
     WHERE ${isCurrentSql('e.status')}
       AND e.deleted_at IS NULL
       AND ($1::int IS NULL OR e.company_id = $1)
       AND ($3::int IS NULL OR e.id = $3)
     ORDER BY e.first_name, e.last_name`,
    [companyId, canSeePhone === true, id]
  );
  return rows;
};

/**
 * Unmasked read, for internal use only — tenant-scope checks and the `oldData`
 * side of an audit entry. Never hand the result to a client: every HTTP path
 * goes through getEmployeeById(), which masks.
 */
export const getEmployeeRecord = async (id) => {
  const { rows } = await pool.query(`SELECT * FROM employees WHERE id = $1`, [id]);
  return rows[0] || null;
};

export const getEmployeeById = async (id, callerRole, isSelf = false) => {
  const emp = maskPII(await getEmployeeRecord(id), callerRole, isSelf);
  // The category's NAME, alongside the id the record stores. Edit Employee
  // needs it to label a category that has since been deactivated (and so is
  // missing from the picker's list); View Employee can show it directly.
  // Added here rather than in getEmployeeRecord, whose raw row is the `oldData`
  // side of audit diffs and must stay exactly the table's columns.
  if (emp && emp.workforce_category_id != null) {
    const { rows } = await pool.query(
      `SELECT value, is_active FROM master_values WHERE id = $1 AND type = 'WORKFORCE_CATEGORY'`,
      [emp.workforce_category_id]);
    emp.workforce_category_name = rows[0]?.value ?? null;
    emp.workforce_category_active = rows[0]?.is_active ?? null;
  } else if (emp) {
    emp.workforce_category_name = null;
  }
  // "Previously an Intern: INTxxx" — the internship this hire was converted
  // from (internConversion.js). Same company by construction; checked anyway.
  if (emp && emp.source_intern_id != null) {
    const { rows } = await pool.query(
      `SELECT intern_code FROM interns WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2`,
      [emp.source_intern_id, emp.company_id ?? null]);
    emp.source_intern_code = rows[0]?.intern_code ?? null;
  } else if (emp) {
    emp.source_intern_code = null;
  }
  return emp;
};

/**
 * Validates that a dept / designation / grade / band exists in its master
 * table IF the master has been configured.
 *
 * Silently passes when the master table is empty, absent, or the query fails —
 * an unseeded master must not block every hire.
 *
 * @param {string}      value
 * @param {string}      table      one of the master_* tables
 * @param {number|null} companyId  the CALLER's company. Required: it scopes the
 *   employees-derived fallback below. Passing `undefined` is a caller that
 *   forgot, and is treated as "no company" rather than "every company".
 */
export async function validateMasterValue(value, table, companyId = null) {
  if (!value) return;
  const needle = String(value).trim().toLowerCase();
  if (!needle) return;
  let rejected = false;
  try {
    const countRes = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE is_active = true`);
    if (!countRes?.rows?.[0]) return; // table or pool not available — skip
    if (parseInt(countRes.rows[0].n, 10) === 0) return; // master not yet configured — skip
    // Case/whitespace-insensitive match so trivial differences don't block a save.
    const { rows } = await pool.query(
      `SELECT id FROM ${table} WHERE LOWER(TRIM(name)) = $1 AND is_active = true`,
      [needle]
    );
    if (rows.length > 0) return;

    // Departments/designations: the picker (GET /master/:type) also surfaces
    // values already in use by employees even when they're absent from the
    // master list, so the dropdown can legitimately offer a value that isn't
    // in the master table. Mirror that fallback here so a valid dropdown
    // choice (or an employee's existing value) never fails validation on save.
    const EMPLOYEE_FALLBACK_COLS = {
      master_departments: 'department',
      master_designations: 'designation',
    };
    const empCol = EMPLOYEE_FALLBACK_COLS[table];
    if (empCol) {
      // ⚠ SCOPED TO ONE COMPANY, matching GET /master/:type exactly (see
      // employeeDerivedValues in master.routes.js). Unscoped, this accepted any
      // designation string any tenant had ever stored — so the validator was
      // strictly wider than the dropdown, and a value the picker would never
      // offer still saved. It is also a tenant boundary: one company's job
      // titles are not another company's vocabulary.
      const { rows: empRows } = await pool.query(
        `SELECT 1 FROM employees
          WHERE LOWER(TRIM(COALESCE(${empCol},''))) = $1
            AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2)
          LIMIT 1`,
        [needle, companyId ?? null]
      );
      if (empRows.length > 0) return;
    }

    rejected = true;
  } catch {
    // DB / table-not-found / mock errors — skip validation silently. The throw
    // below sits OUTSIDE this catch on purpose: it used to be inside, which
    // meant the only way to tell a validation failure from a database fault was
    // to sniff the error message for 'is not a valid'.
    return;
  }

  if (rejected) {
    // Singular: the message is user-facing now that it surfaces as a 400, and
    // "is not a valid grades" read as a typo.
    const noun = table.replace('master_', '').replace(/ies$/, 'y').replace(/s$/, '');
    throw badRequest(`"${value}" is not a valid ${noun}. Select a value from the master list.`);
  }
}

export const getEmployees = async ({ status, department, designation, employment_type, company_id, callerRole, callerEmployeeId, page, limit } = {}) => {
  const conditions = [];
  const values = [];
  let i = 1;

  if (company_id != null) {
    values.push(company_id);
    conditions.push(`company_id = $${i++}`);
  }

  // A soft-deleted record is not a person. deleteEmployee() stamps deleted_at
  // AND flips status to 'terminated', so these were already filtered out of the
  // default branch below by accident — but not out of `?status=all`, which the
  // All Employees page calls, nor out of an explicit `?status=terminated`.
  conditions.push(`deleted_at IS NULL`);

  if (status) {
    const statusLower = String(status).trim().toLowerCase();
    if (statusLower === 'all') {
      // Explicit "all" — no status filter; return every employee regardless of status
    } else if (statusLower === "probation") {
      // Probation is a STATUS, not an employment type.
      //
      // This branch used to match `status='probation' OR employment_type=
      // 'probation'`, excluding a hand-written list of ex-statuses that named
      // 'notice_period' but not 'Notice'. The one live employee sitting at
      // status 'Notice' with employment_type 'Probation' therefore came back
      // in this list, while the On Probation KPI — which counts
      // status='probation', as the status donut must for the breakdown to
      // reconcile — did not count them. The card read 2 and the list beneath
      // it showed 3. The KPI's definition is the one that has to hold, so the
      // employment_type arm goes.
      conditions.push(`${statusExpr()} = 'probation'`);
    } else {
      values.push(statusLower);
      conditions.push(`LOWER(COALESCE(status,'')) = $${i++}`);
    }
  } else {
    // Default to current staff. `isExitedSql` is the single canonical answer to
    // "has this person left?" — see shared/employeeStatus.js for why there is
    // exactly one copy of that list now.
    conditions.push(`NOT (${isExitedSql()})`);
  }

  if (department) {
    values.push(String(department).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(department,'')) = $${i++}`);
  }

  if (designation) {
    values.push(String(designation).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(designation,'')) = $${i++}`);
  }

  if (employment_type) {
    values.push(String(employment_type).trim().toLowerCase());
    conditions.push(`LOWER(COALESCE(employment_type,'')) = $${i++}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Bounded fetch: cap results to avoid unbounded full-table scans. Honors explicit
  // page/limit; otherwise returns up to DEFAULT_MAX rows (safe for SME headcounts).
  const DEFAULT_MAX = 2000;
  const lim     = Math.min(DEFAULT_MAX, Math.max(1, parseInt(limit) || DEFAULT_MAX));
  const pageNum = Math.max(1, parseInt(page) || 1);
  const offset  = (pageNum - 1) * lim;
  values.push(lim, offset);
  const result = await pool.query(
    `SELECT * FROM employees ${where} ORDER BY id DESC LIMIT $${i++} OFFSET $${i++}`,
    values
  );
  // Same redaction the single-record path applies. This list used to strip only
  // the salary/bank block, so every authenticated caller — a plain employee
  // included — could read PAN, Aadhaar, home addresses, date of birth, family
  // and emergency contacts and the uploaded-document paths for the whole
  // company. Route both paths through maskPII so they cannot drift apart again.
  if (!holdsFullRecordAccess(callerRole)) return result.rows.map(toPickerRow);
  const selfId = callerEmployeeId != null ? String(callerEmployeeId) : null;
  return result.rows.map(emp =>
    maskPII(emp, callerRole, selfId != null && String(emp.id) === selfId)
  );
};

/**
 * Who belongs on the Ex-Employees page.
 *
 * This was a FOURTH hardcoded copy of the status vocabulary, and it disagreed
 * with the canonical one: it listed 'notice_period' and 'notice period' as
 * EXITED, while shared/employeeStatus.js counts anyone serving notice as still
 * employed (payroll and attendance still run for them — the reading
 * `POST /employees/:id/offboard` documents and relies on). An employee at
 * 'notice_period' therefore appeared on All Employees AND on Ex-Employees at the
 * same time, and was counted in headcount by one page and as a departure by the
 * other. It also tested `LOWER(e.status)` bare, so a NULL status made the whole
 * predicate NULL rather than false.
 */
const EX_STATUSES = isExitedSql('e.status');

export const getExEmployees = async ({ exit_date_from, exit_date_to, company_id, callerRole } = {}) => {
  const conditions = [EX_STATUSES];
  const values = [];
  let idx = 1;

  if (company_id != null) {
    values.push(company_id);
    conditions.push(`e.company_id = $${idx++}`);
  }

  if (exit_date_from) {
    conditions.push(`COALESCE(er.last_working_date, e.exit_date) >= $${idx++}::date`);
    values.push(exit_date_from);
  }
  if (exit_date_to) {
    conditions.push(`COALESCE(er.last_working_date, e.exit_date) <= $${idx++}::date`);
    values.push(exit_date_to);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows } = await pool.query(`
    SELECT
      e.*,
      COALESCE(er.last_working_date, e.exit_date)  AS effective_exit_date,
      COALESCE(er.separation_type, '')              AS separation_type,
      COALESCE(er.reason, e.exit_reason, '')        AS effective_exit_reason,
      er.fnf_status,
      er.interview_done,
      ec.exit_interview_done                        AS clearance_interview_done
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT * FROM exit_requests
      WHERE employee_id = e.id
        AND status NOT IN ('rejected','cancelled')
      ORDER BY created_at DESC
      LIMIT 1
    ) er ON true
    LEFT JOIN exit_clearance ec ON ec.employee_id = e.id
    ${where}
    ORDER BY COALESCE(er.last_working_date, e.exit_date) DESC NULLS LAST
  `, values);

  // `e.*` carries the whole employee row, salary and bank block included — this
  // list applied no redaction at all, so it leaked strictly more than the
  // active-employee list did. Same maskPII as every other read path; there is
  // no self case here, since the caller is by definition not an ex-employee.
  return rows.map(row => maskPII(row, callerRole));
};

/**
 * The code the Add Employee form PREFILLS. Advisory, not a reservation: the
 * authoritative mint happens inside addEmployee's transaction, so two HR users
 * with the form open at once both see the same suggestion and the second one's
 * save is renumbered rather than rejected.
 *
 * Company-scoped. Unscoped, this returned a code belonging to a different
 * tenant's numbering — and on live data returned 'EMP001', already in use.
 */
export const getNextEmployeeCode = async (company_id = null) => {
  const client = await pool.connect();
  try {
    // nextEmployeeCode takes pg_advisory_xact_lock, which is a no-op outside a
    // transaction — wrap it so the lock it relies on actually exists.
    await client.query('BEGIN');
    const code = await nextEmployeeCode(client, company_id ?? null);
    await client.query('COMMIT');
    return code;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Fields an UPDATE may not blank out.
 *
 * The same fields `REQUIRED_ON_CREATE` names (plus first name and company
 * email), but enforced only when SENT: an edit that never mentions
 * department is fine, including on the 24 legacy rows that have none — HR must
 * be able to correct a phone number on an incomplete record without being made
 * to complete it first. What is refused is an edit that CLEARS a value that is
 * there, or that submits a blank for one of these while also claiming to set it.
 * Without this, `PUT /employees/:id` with `{ department: '' }` was a silent
 * downgrade of a complete record to an incomplete one.
 */
const NOT_CLEARABLE = [
  ['first_name',    'First name'],
  ['last_name',     'Last name'],
  ['company_email', 'Company email'],
  ['department',    'Department'],
  ['designation',   'Role / Designation'],
  ['status',        'Employment status'],
  ['joining_date',  'Joining date'],
];

/**
 * Plain columns Edit Employee may set or clear. Derived columns are NOT here:
 * `location` follows `branch_id`, `zone` follows `zone_id`, and
 * `reporting_manager` follows `reporting_manager_id` — each is written from
 * its master row so the label and the key cannot disagree. `office_id` is not
 * here either: the Employee ID is minted by the server and read-only on both
 * forms.
 */
const UPDATABLE_TEXT = [
  'first_name', 'last_name', 'company_email', 'personal_email', 'phone', 'company_phone',
  'gender', 'blood_group', 'marital_status',
  'father_name', 'mother_name', 'spouse_name',
  'current_address', 'permanent_address',
  'highest_qualification', 'basic_qualification',
  'department', 'designation', 'grade', 'band', 'employee_role',
  'employment_type', 'skill_type', 'status',
  'previous_company_1', 'previous_role_1', 'previous_company_2', 'previous_role_2',
  'bank_name', 'branch_name', 'account_number', 'ifsc_code', 'nominee_name',
  'emergency_name', 'emergency_phone', 'emergency_relationship',
  'pan_number', 'aadhaar_number', 'pf_number', 'uan_number', 'esic_number',
  'notes', 'exit_reason',
];
const UPDATABLE_DATES = ['dob', 'anniversary_date', 'joining_date', 'exit_date'];

/** Upload field name → employees column. Photo is the one whose names differ. */
const FILE_COLUMNS = {
  photo_file: 'photo_url',
  pan_file: 'pan_file',
  aadhaar_file: 'aadhaar_file',
  cancelled_cheque_file: 'cancelled_cheque_file',
  bank_statement_file: 'bank_statement_file',
  resume_file: 'resume_file',
  offer_letter_file: 'offer_letter_file',
};

/**
 * True when a submitted value is the MASK maskPII() rendered, not real data.
 *
 * Every role that may PUT today is also one maskPII leaves unmasked, so this
 * should never fire — but a form that round-trips what it was shown would
 * otherwise write `XXXX XXXX 1234` over a real Aadhaar the moment the two role
 * lists drift. A placeholder is read as "unchanged", never stored.
 */
function isMaskPlaceholder(field, value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  switch (field) {
    case 'aadhaar_number':    return /^X{4} X{4} \d{4}$/.test(v);
    case 'pan_number':        return /^X{6}[A-Z0-9]{4}$/i.test(v) && v.startsWith('XXXXXX');
    case 'account_number':    return /^X{4}\S{1,4}$/.test(v);
    case 'current_address':
    case 'permanent_address': return v === '[RESTRICTED]';
    default:                  return false;
  }
}

export const updateEmployee = async (id, data, company_id = null) => {
  if (!data) {
    throw badRequest("Request body is empty");
  }

  const blanked = NOT_CLEARABLE
    .filter(([key]) => key in data && !String(data[key] ?? '').trim())
    .map(([, label]) => label);
  if (blanked.length) {
    throw badRequest(
      `${blanked.join(', ')} cannot be cleared — ${blanked.length === 1 ? 'it is' : 'they are'} required on an employee record.`,
    );
  }

  // Same canonical check the create path applies. This is the route the All
  // Employees Terminate modal uses (`PUT` with status 'Left'), so an unvalidated
  // status here would reintroduce the synonyms WRITABLE_STATUSES exists to stop.
  if ('status' in data && data.status != null) {
    const canon = canonicalWritableStatus(data.status);
    if (!canon) {
      throw badRequest(
        `"${data.status}" is not a valid employment status. Expected one of: ${WRITABLE_STATUSES.join(', ')}.`,
      );
    }
    data = { ...data, status: canon };
  }

  // 'null'/'undefined' arriving as text never becomes stored data again.
  // See shared/nullish.js — three live rows hold the literal string 'null' in
  // reporting_manager, and the Manager column rendered it.
  if ('reporting_manager' in data) {
    data = { ...data, reporting_manager: cleanText(data.reporting_manager) };
  }

  // Reporting manager: no self-reference, no cycle, same tenant.
  //
  // This path had NO manager validation at all, which is how employee 1 (a CEO)
  // came to be their own manager. `orgChartRepository.wouldCreateCycle` guarded
  // the Org Chart screen's bulk and upsert routes but not this one and not
  // `PUT /orgchart/reporting-manager`, so two of the four write paths were open.
  //
  // ⚠ Checked against `pool`, not inside a transaction — this function is a
  // single UPDATE with no BEGIN, so check and write are not atomic. Two
  // simultaneous assignments can each pass and together close a loop. That is a
  // narrower window than the one it replaces (no check at all) and closing it
  // properly means making this function transactional, which is a bigger change
  // than this pass should carry. `findHierarchyDefects` is the backstop that
  // reports a loop if one ever lands.
  if ('reporting_manager_id' in data && data.reporting_manager_id != null && data.reporting_manager_id !== '') {
    await assertValidManager(pool, {
      employeeId: Number(id),
      managerId: data.reporting_manager_id,
      companyId: company_id ?? null,
    });
  }

  if (data.department)  await validateMasterValue(data.department, 'master_departments', company_id ?? null);
  if (data.designation) await validateMasterValue(data.designation, 'master_designations', company_id ?? null);
  if (data.grade)       await validateMasterValue(data.grade, 'master_grades', company_id ?? null);
  if (data.band)        await validateMasterValue(data.band, 'master_bands', company_id ?? null);

  // The same range guard the create path applies. Without it an edit was still
  // a way in for the 123-year prior-service figure this rule exists to stop —
  // a validator that only covers one of the two writers is not a validator.
  // A blank field is null, not zero: on a key that is present it clears the
  // figure ("not stated"), it never records 0 years.
  const prevYears1Update = numericField(data.previous_years_1, 'Years at company 1', YEARS_RANGE);
  const prevYears2Update = numericField(data.previous_years_2, 'Years at company 2', YEARS_RANGE);


  // Format guards — the same rules addEmployee applies, run only on the fields
  // this request actually sends. An edit used to accept any string for an
  // email or PAN because only the create path checked them, so Edit Employee
  // could write a record Add Employee would have refused.
  for (const [field, label] of [['company_email', 'company email'], ['personal_email', 'personal email']]) {
    if (!(field in data)) continue;
    const value = String(data[field] ?? '').trim();
    if (!value) continue;                       // blank: NOT_CLEARABLE decides
    if (!EMAIL_RE.test(value)) throw badRequest(`"${value}" is not a valid ${label} address.`);
  }
  if ('pan_number' in data && String(data.pan_number ?? '').trim()
      && !isMaskPlaceholder('pan_number', data.pan_number) && !validatePAN(data.pan_number)) {
    throw badRequest('Invalid PAN format. Expected 10 characters, e.g. ABCDE1234F.');
  }
  if ('joining_date' in data && String(data.joining_date ?? '').trim()) {
    const joined = new Date(`${String(data.joining_date).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(joined.getTime())) {
      throw badRequest(`"${data.joining_date}" is not a valid joining date. Expected YYYY-MM-DD.`);
    }
    const todayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    if ((joined - todayUtc) / (365.2425 * 864e5) > 2) {
      throw badRequest(`Joining date ${String(data.joining_date).slice(0, 10)} is more than two years in the future.`);
    }
  }
  // DATE OF BIRTH — checked only when it CHANGES. Edit Employee sends every
  // field on every save, so checking an unchanged value would lock a record
  // that already holds a bad date (EMP003: 27 Feb 2026) — HR could not save a
  // phone number without first fixing the DOB. A new value must be plausible.
  if ('dob' in data && String(data.dob ?? '').trim()) {
    const sent = String(data.dob).trim().slice(0, 10);
    const { rows: [cur] } = await pool.query(
      `SELECT TO_CHAR(dob, 'YYYY-MM-DD') AS dob FROM employees
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [id, company_id ?? null],
    );
    if (!cur || cur.dob !== sent) {
      const problem = dobProblem(data.dob, await getWorkforcePolicy(pool, company_id ?? null), localTodayIso());
      if (problem) throw badRequest(problem);
    }
  }
  if ('company_email' in data && String(data.company_email ?? '').trim()) {
    const dupe = await pool.query(
      `SELECT id, office_id FROM employees
        WHERE LOWER(TRIM(company_email)) = LOWER(TRIM($1))
          AND id <> $2
          AND ($3::int IS NULL OR company_id = $3)
        LIMIT 1`,
      [String(data.company_email).trim(), id, company_id ?? null],
    );
    if (dupe.rows.length) {
      const held = dupe.rows[0].office_id || `#${dupe.rows[0].id}`;
      throw badRequest(`${String(data.company_email).trim()} already belongs to employee ${held}.`, 409);
    }
  }

  // ── COMPENSATION — a correction to ONE named revision, never a new one ─────
  //
  // Edit Employee used to show the hire salary read-only, so a mistyped first
  // salary could only be "fixed" by booking a second revision on top of it —
  // which leaves the wrong figure in the history as though it had been paid.
  // `employee_salary_assignments` is unique on (employee_id, effective_from):
  // a revision IS its effective date. Correcting one therefore updates that
  // row in place, and the client names it by id (`salary_revision_id`) so the
  // server never has to guess which of several revisions was on screen.
  //
  // A NEW revision with its own effective date (an increment) is still made in
  // Payroll → Salary Structure → Assign. This path cannot create one, except
  // the very first when the employee has no revision at all.
  const touchesSalary = 'basic_salary' in data || 'special_allowance' in data;
  let basicIn = null;
  let allowanceIn = null;
  if (touchesSalary) {
    basicIn = numericField(data.basic_salary, 'Basic salary', SALARY_RANGE);
    allowanceIn = numericField(data.special_allowance, 'Special allowance', SALARY_RANGE);
    if ('basic_salary' in data && basicIn == null) {
      throw badRequest('Basic salary cannot be cleared. Correct it to the right figure instead.');
    }
  }

  // ── What is written, and how ──────────────────────────────────────────────
  //
  // A key PRESENT in the request is SET — a blank clears it. A key ABSENT is
  // left alone. This replaces 61 `col = COALESCE($n, col)` assignments, under
  // which nothing could ever be cleared: deleting a wrong spouse name or a
  // stale second employer in Edit Employee saved "successfully" and the old
  // value came straight back. Partial callers (the Terminate modal, bulk
  // department change) only send the keys they mean to change, so they are
  // unaffected.
  const sets = [];
  const values = [];
  const set = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
  const has = (k) => k in data && !isMaskPlaceholder(k, data[k]);

  for (const col of UPDATABLE_TEXT) {
    if (!has(col)) continue;
    set(col, cleanText(data[col] == null ? null : String(data[col])));
  }
  for (const col of UPDATABLE_DATES) {
    if (!has(col)) continue;
    set(col, cleanText(data[col] == null ? null : String(data[col]).slice(0, 10)));
  }
  if ('previous_years_1' in data) set('previous_years_1', prevYears1Update);
  if ('previous_years_2' in data) set('previous_years_2', prevYears2Update);
  if ('is_field_employee' in data && data.is_field_employee != null && data.is_field_employee !== '') {
    set('is_field_employee', data.is_field_employee === true || data.is_field_employee === 'true');
  }

  // Documents. A freshly uploaded file replaces the stored one; a key named in
  // `remove_files` clears it; anything else is left exactly as it was. The file
  // on disk is not deleted — the audit entry's oldData still names it.
  const removeFiles = new Set(
    (Array.isArray(data.remove_files) ? data.remove_files : String(data.remove_files ?? '').split(','))
      .map(s => String(s).trim()).filter(Boolean),
  );
  for (const [key, col] of Object.entries(FILE_COLUMNS)) {
    if (typeof data[key] === 'string' && data[key] && !isNullishText(data[key])) set(col, data[key]);
    else if (removeFiles.has(key)) set(col, null);
  }

  const client = await pool.connect();
  let salaryCorrection = null;
  try {
    await client.query('BEGIN');

    const { rows: [current] } = await client.query(
      `SELECT id, joining_date::text AS joining_date, company_id, workforce_category_id FROM employees
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [id, company_id ?? null],
    );
    if (!current) throw badRequest('Employee not found', 404);

    // WORKFORCE CATEGORY — select, change or clear. Absent from the body means
    // "leave it"; blank means "clear". Checked against the EMPLOYEE's company
    // (not only the caller's), so a global admin cannot file a company-A
    // employee under company B's category either.
    if ('workforce_category_id' in data) {
      const category = await assertValidWorkforceCategory(
        client, data.workforce_category_id, current.company_id ?? company_id ?? null,
        current.workforce_category_id);
      set('workforce_category_id', category ? category.id : null);
    }

    // PROBATION — written ONLY when the request names probation_months or
    // probation_end_date with a value. Edit Employee sends every other field on
    // every save, so a saved end date (including one HR set by hand) survives
    // any unrelated edit untouched, and the server never recalculates it on its
    // own — not even when the joining date changes; the form shows that
    // recalculation and sends it, so the person saving sees the new date first.
    // An explicit end date is stored as given; a period alone is calculated
    // from the joining date being saved (or the stored one) by the shared rule.
    if ('probation_months' in data || 'probation_end_date' in data) {
      let probation;
      try {
        probation = resolveProbationWrite({
          joiningDate: ('joining_date' in data && String(data.joining_date ?? '').trim())
            ? data.joining_date : current.joining_date,
          months: data.probation_months,
          endDate: data.probation_end_date,
        });
      } catch (e) {
        if (e instanceof RangeError) throw badRequest(e.message);
        throw e;
      }
      if (probation.touched) {
        set('probation_end_date', probation.probation_end_date);
        if (probation.probation_months !== undefined) set('probation_months', probation.probation_months);
      }
    }

    // Reporting manager: the name is DERIVED from the id, not taken from the
    // client, so the two columns cannot disagree. Clearing the id clears both —
    // previously the form omitted both keys when the picker was set to None,
    // and COALESCE kept the old manager.
    if ('reporting_manager_id' in data) {
      const mgrId = toIntOrNull(cleanText(data.reporting_manager_id == null ? null : String(data.reporting_manager_id)));
      if (mgrId == null) {
        set('reporting_manager_id', null);
        set('reporting_manager', null);
      } else {
        const { rows: [mgr] } = await client.query(
          `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
             FROM employees WHERE id = $1`, [mgrId]);
        set('reporting_manager_id', mgrId);
        set('reporting_manager', mgr?.name || null);
      }
    } else if ('reporting_manager' in data) {
      set('reporting_manager', data.reporting_manager);   // already cleanText'd above
    }

    // LOCATION — branch_id was silently IGNORED by this path: Edit Employee
    // sent it, the UPDATE had no column for it, and only the `location` text
    // changed, so the FK and the label drifted apart on every edit. Same
    // tenant check as the create path; `location` is derived from the branch.
    if ('branch_id' in data) {
      const branch = await assertValidBranch(client, data.branch_id, company_id ?? null);
      set('branch_id', branch ? branch.id : null);
      set('location', branch ? branch.name : null);
    } else if ('location' in data) {
      set('location', cleanText(data.location == null ? null : String(data.location)));
    }

    // ZONE — same story: zone_id was ignored. Resolved through the master so
    // the text and the id come from one row.
    if ('zone_id' in data || 'zone' in data) {
      const zoneName = cleanText(data.zone == null ? null : String(data.zone));
      const resolved = await resolveZone(client, data.zone_id, zoneName);
      set('zone_id', resolved ? resolved.id : null);
      set('zone', resolved ? resolved.name : zoneName);
    }

    let emp;
    if (sets.length) {
      values.push(id);
      const idParam = values.length;
      values.push(company_id ?? null);
      const coParam = values.length;
      const result = await client.query(
        `UPDATE employees SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${idParam} AND ($${coParam}::int IS NULL OR company_id = $${coParam})
          RETURNING *`,
        values,
      );
      emp = result.rows[0];
    } else {
      emp = (await client.query(`SELECT * FROM employees WHERE id = $1`, [id])).rows[0];
    }
    if (!emp) throw badRequest('Employee not found', 404);

    // A corrected joining date carries the HIRE revision with it — but only
    // that one, only when it still sits on the old joining date, only when it
    // stays the earliest revision, and only when the new date is free. Without
    // this, moving a joining date earlier left the months in between with no
    // salary at all for payroll to find.
    if ('joining_date' in data && emp.joining_date && current.joining_date) {
      await client.query(
        `WITH hire AS (
           SELECT id FROM employee_salary_assignments
            WHERE employee_id = $1 ORDER BY effective_from ASC, id ASC LIMIT 1
         )
         UPDATE employee_salary_assignments a
            SET effective_from = $2::date, updated_at = NOW()
           FROM hire
          WHERE a.id = hire.id
            AND a.effective_from = $3::date
            AND $2::date <> $3::date
            AND NOT EXISTS (SELECT 1 FROM employee_salary_assignments x
                             WHERE x.employee_id = $1 AND x.effective_from = $2::date)
            AND $2::date < COALESCE((SELECT MIN(effective_from) FROM employee_salary_assignments y
                                      WHERE y.employee_id = $1 AND y.id <> hire.id), 'infinity'::date)`,
        [id, String(data.joining_date).slice(0, 10), current.joining_date],
      );
    }

    if (touchesSalary) {
      const revId = toIntOrNull(data.salary_revision_id);
      if (revId) {
        const { rows: [before] } = await client.query(
          `SELECT id, effective_from::text AS effective_from, basic_salary, special_allowance
             FROM employee_salary_assignments WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
          [revId, id],
        );
        if (!before) throw badRequest('That salary revision does not belong to this employee.');
        const { rows: [after] } = await client.query(
          `UPDATE employee_salary_assignments
              SET basic_salary = COALESCE($1, basic_salary),
                  special_allowance = COALESCE($2, special_allowance),
                  updated_at = NOW()
            WHERE id = $3
            RETURNING id, effective_from::text AS effective_from, basic_salary, special_allowance`,
          [basicIn, allowanceIn, revId],
        );
        salaryCorrection = { before, after };
      } else {
        const { rows: [{ n }] } = await client.query(
          `SELECT COUNT(*)::int AS n FROM employee_salary_assignments WHERE employee_id = $1`, [id]);
        if (n > 0) {
          throw badRequest('This employee already has salary revisions. Name the one being corrected (salary_revision_id).');
        }
        if (basicIn == null) throw badRequest('Basic salary is required to record a salary.');
        const { rows: defStruct } = await client.query(
          `SELECT id FROM salary_structures WHERE is_default = true ORDER BY id LIMIT 1`);
        const { rows: [after] } = await client.query(
          `INSERT INTO employee_salary_assignments
             (employee_id, structure_id, effective_from, basic_salary, special_allowance)
           VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5)
           RETURNING id, effective_from::text AS effective_from, basic_salary, special_allowance`,
          [id, defStruct[0]?.id ?? null, emp.joining_date ? String(emp.joining_date).slice(0, 10) : null,
           basicIn, allowanceIn ?? 0],
        );
        salaryCorrection = { before: null, after };
      }

      // `employees.basic_salary` is payroll's FALLBACK; keep it equal to the
      // revision in force today (latest on or before today, else the earliest).
      const { rows: [synced] } = await client.query(
        `UPDATE employees e
            SET basic_salary = (
              SELECT a.basic_salary FROM employee_salary_assignments a
               WHERE a.employee_id = e.id
               ORDER BY (a.effective_from <= CURRENT_DATE) DESC,
                        CASE WHEN a.effective_from <= CURRENT_DATE THEN a.effective_from END DESC NULLS LAST,
                        a.effective_from ASC
               LIMIT 1)
          WHERE e.id = $1 AND ($2::int IS NULL OR e.company_id = $2)
          RETURNING *`,
        [id, company_id ?? null],
      );
      if (synced) emp = synced;
    }

    await client.query('COMMIT');
    return salaryCorrection ? { ...emp, salary_correction: salaryCorrection } : emp;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const wrapped = new Error(err.statusCode ? err.message : `Failed to update employee: ${err.message}`);
    if (err.statusCode) wrapped.statusCode = err.statusCode;
    if (err.code) wrapped.code = err.code;
    if (err.constraint) wrapped.constraint = err.constraint;
    if (err.detail) wrapped.detail = err.detail;
    throw wrapped;
  } finally {
    client.release();
  }
};

export const deleteEmployee = async (id, company_id = null) => {
  const scopeClause = company_id != null ? 'AND company_id = $2' : '';
  const params = company_id != null ? [id, company_id] : [id];
  const result = await pool.query(
    `UPDATE employees SET status = 'terminated', deleted_at = NOW()
     WHERE id = $1 AND status != 'terminated' ${scopeClause}
     RETURNING id`,
    params
  );
  if (!result.rows.length) {
    throw new Error('Employee not found or already terminated');
  }
};

/**
 * Tenure buckets. ASCII hyphens, deliberately: these labels are DATA — they
 * travel to the browser and become the X axis of the tenure chart. The previous
 * copies held a double-encoded en dash, so the X axis literally rendered the
 * mojibake on screen. Mirrored in frontend employeeStatus.js.
 */
const TENURE_BUCKETS = ['0-1 yr', '1-3 yrs', '3-5 yrs', '5-10 yrs', '10+ yrs', 'Not recorded'];

/** Hard ceiling on the trend series, so `period=all` at a 40-year-old company
 *  cannot return a 500-point chart. */
const MAX_TREND_MONTHS = 120;

/**
 * Shared row source for every analytics query.
 *
 * $1 = company_id (null = unscoped), $2 = department (null = all).
 *
 * `eff_exit` is the one place a leaving date is decided. The old exits query
 * used `COALESCE(exit_date, updated_at)`, which dated a departure by whenever
 * the row was last touched — the single live ex-employee was filed under the
 * month someone edited their record (Jul 26) rather than their actual last
 * working day (Aug 26). exit_requests.last_working_date is the real answer and
 * now sits between the two.
 *
 * `extended` adds the Workforce Analytics columns (wf_*) and a branch join;
 * `where` appends further predicates, numbered by the caller from $3. With
 * neither, the SQL is exactly what the Employees Dashboard has always run —
 * Workforce Analytics extends this source rather than keeping a second one, so
 * the two pages cannot disagree about who is employed here.
 */
const empSource = ({ extended = false, where = '' } = {}) => `
  WITH emp AS (
    SELECT
      e.id,
      ${bucketSql('e.status')}                                     AS bucket,
      e.joining_date,
      COALESCE(NULLIF(TRIM(e.department),  ''), 'Unassigned')      AS department,
      COALESCE(NULLIF(TRIM(e.gender),      ''), 'Not specified')   AS gender,
      COALESCE(NULLIF(TRIM(e.skill_type),  ''), 'Not specified')   AS skill,
      COALESCE(e.exit_date, x.lwd, e.updated_at::date)             AS eff_exit${extended ? WORKFORCE_COLUMNS : ''}
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT MAX(er.last_working_date) AS lwd${extended ? WORKFORCE_EXIT_REASON : ''}
        FROM exit_requests er
       WHERE er.employee_id = e.id
         AND LOWER(COALESCE(er.status, '')) NOT IN ('rejected', 'cancelled')
    ) x ON TRUE${extended ? WORKFORCE_BRANCH_JOIN : ''}
    WHERE e.deleted_at IS NULL
      AND ($1::int  IS NULL OR e.company_id = $1)
      AND ($2::text IS NULL OR COALESCE(NULLIF(TRIM(e.department), ''), 'Unassigned') = $2)${where}
  )
`;

/**
 * A text column as a chart label: NULL, blank, and the literal strings
 * 'null'/'undefined' (which a form has written here before) are all
 * 'Not recorded'; anything else is the trimmed value.
 */
const NOT_RECORDED = 'Not recorded';
const labelSql = (col) => `CASE
        WHEN ${col} IS NULL OR LOWER(TRIM(${col})) IN ('', 'null', 'undefined') THEN '${NOT_RECORDED}'
        ELSE TRIM(${col})
      END`;

/**
 * Workforce Analytics columns. Defined here, beside the source they extend.
 *
 * `known_exit` is eff_exit WITHOUT the updated_at fallback. eff_exit stays as it
 * is because the Employees Dashboard's numbers depend on it; Workforce
 * Analytics reports an exit with neither an exit_date nor a last working day as
 * "Exit date unknown" instead of filing it under the month the record was last
 * edited.
 *
 * The exit reason follows Ex-Employees: the exit request's reason first, then
 * employees.exit_reason.
 *
 * Prior experience is NULL — not 0 — when neither previous-employment field is
 * filled: an empty form and a fresher are indistinguishable in this schema, and
 * reporting both as "0 years" would invent a fact.
 */
const WORKFORCE_COLUMNS = `,
      ${labelSql('e.department')}            AS wf_department,
      ${labelSql('e.designation')}           AS wf_designation,
      ${labelSql('e.employment_type')}       AS wf_employment_type,
      ${labelSql('e.gender')}                AS wf_gender,
      ${labelSql('e.skill_type')}            AS wf_skill_type,
      ${labelSql('e.highest_qualification')} AS wf_qualification,
      e.branch_id                            AS wf_branch_id,
      CASE WHEN e.branch_id IS NULL THEN '${NOT_RECORDED}'
           ELSE COALESCE(NULLIF(TRIM(b.name), ''), 'Unknown branch')
      END                                    AS wf_branch,
      CASE WHEN e.dob <= CURRENT_DATE THEN e.dob END AS wf_dob,
      e.dob                                  AS wf_dob_raw,
      CASE WHEN e.previous_years_1 IS NULL AND e.previous_years_2 IS NULL THEN NULL
           ELSE COALESCE(e.previous_years_1, 0) + COALESCE(e.previous_years_2, 0)
      END                                    AS wf_prior_years,
      COALESCE(e.exit_date, x.lwd)           AS known_exit,
      COALESCE(x.er_reason, NULLIF(TRIM(e.exit_reason), ''), '${NOT_RECORDED}') AS wf_exit_reason,
      CASE WHEN e.workforce_category_id IS NULL THEN '${NOT_RECORDED}'
           ELSE COALESCE(NULLIF(TRIM(wc.value), ''), 'Unknown category')
      END                                    AS wf_workforce_category`;

const WORKFORCE_EXIT_REASON = `,
             (ARRAY_AGG(NULLIF(TRIM(er.reason), '') ORDER BY er.created_at DESC)
                FILTER (WHERE NULLIF(TRIM(er.reason), '') IS NOT NULL))[1] AS er_reason`;

// Same company as the employee: a branch_id pointing at another tenant's branch
// must not surface that tenant's branch name.
const WORKFORCE_BRANCH_JOIN = `
    LEFT JOIN branches b ON b.id = e.branch_id AND b.company_id = e.company_id
    LEFT JOIN master_values wc ON wc.id = e.workforce_category_id
                              AND wc.type = 'WORKFORCE_CATEGORY'
                              AND (wc.company_id IS NULL OR wc.company_id = e.company_id)`;

/** AGE()-based tenure in whole years, used by both the KPI and the chart. */
const TENURE_YEARS = `EXTRACT(YEAR FROM AGE(NOW(), joining_date))`;

/**
 * Label an explicit range that happens to be exactly an Indian financial year,
 * so the legacy `?fy_start=&fy_end=` callers still read "FY27" rather than
 * "2026-04-01 to 2027-03-31".
 */
function fyLabelFor(from, to) {
  if (!from || !to) return null;
  const m = /^(\d{4})-04-01$/.exec(String(from).slice(0, 10));
  const n = /^(\d{4})-03-31$/.exec(String(to).slice(0, 10));
  if (!m || !n) return null;
  if (Number(n[1]) !== Number(m[1]) + 1) return null;
  return `FY${n[1].slice(-2)}`;
}

/**
 * Employee analytics for the Employees Dashboard and the HR Dashboard.
 *
 * ── What the period moves, and what it must not ────────────────────────────
 * Per the dashboard filter contract: ACTIVITY follows the selected period,
 * POPULATION does not. Headcount, the status donut, gender, skill, tenure and
 * the department stack all answer "who works here right now" — narrowing to
 * last quarter must not make two thirds of the workforce disappear. Hiring,
 * exits, the attrition rate and the trend series are activity, and are scoped.
 * `period_scoped` / `point_in_time` name which is which so the UI can caption
 * each card honestly instead of implying the whole page moved.
 *
 * ── Reconciliation ─────────────────────────────────────────────────────────
 * Every population breakdown is built from the same `emp` CTE and restricted to
 * the same non-exited set, so statusBreakdown, deptBreakdown, genderBreakdown,
 * skillBreakdown and tenureGroups each sum to exactly `summary.total`. The
 * previous version could not: the department query carried `LIMIT 12` against
 * 14 live departments, tenure silently dropped anyone with no joining_date, and
 * the status donut included the exited and unlabelled rows that the total left
 * out — Total read 32 while the donut beside it summed to 34.
 */
export const getEmployeeAnalytics = async ({
  period, from, to, fy_start, fy_end, department, company_id,
} = {}) => {
  // fy_start/fy_end are the pre-2026-09 dashboard's spelling of from/to. An
  // explicit pair wins over a preset, which is what resolveRange already does.
  const range = resolveRange(
    { period, from: from || fy_start, to: to || fy_end },
    { defaultPeriod: 'fytd' },
  );

  const cid = company_id ?? null;
  const deptRaw = department == null ? '' : String(department).trim();
  const dept = deptRaw && deptRaw.toLowerCase() !== 'all' ? deptRaw : null;
  const popParams = [cid, dept];

  // ── Population (point-in-time) ────────────────────────────────────────────

  const summaryRes = await pool.query(`
    ${empSource()}
    SELECT
      COUNT(*) FILTER (WHERE bucket <> 'Exited')                          AS total,
      COUNT(*) FILTER (WHERE bucket =  'Active')                          AS active,
      COUNT(*) FILTER (WHERE bucket =  'Probation')                       AS probation,
      COUNT(*) FILTER (WHERE bucket =  'Notice')                          AS notice,
      COUNT(*) FILTER (WHERE bucket =  'Other')                           AS other,
      COUNT(*) FILTER (WHERE bucket =  'Exited')                          AS exited_all_time,
      COUNT(*) FILTER (WHERE bucket <> 'Exited' AND joining_date IS NULL) AS tenure_unknown,
      ROUND(AVG(
        ${TENURE_YEARS} + EXTRACT(MONTH FROM AGE(NOW(), joining_date)) / 12.0
      ) FILTER (WHERE bucket <> 'Exited' AND joining_date IS NOT NULL), 1) AS avg_tenure,
      -- Months as well as years. "0.2 yrs" is not a number an HR manager
      -- reasons with, and it cannot be derived from the rounded years above:
      -- 0.2 could be anything from 1.8 to 2.9 months.
      ROUND(AVG(
        (CURRENT_DATE - joining_date) / 30.4375
      ) FILTER (WHERE bucket <> 'Exited' AND joining_date IS NOT NULL), 1) AS avg_tenure_months
    FROM emp
  `, popParams);
  const r = summaryRes.rows[0] || {};
  const num = (v) => parseInt(v, 10) || 0;

  const total = num(r.total);

  // Current staff only, so the donut reconciles with `total`; empty buckets
  // dropped so there are no zero-width slices to hover.
  const statusBreakdown = [
    { status: 'Active',    count: num(r.active) },
    { status: 'Probation', count: num(r.probation) },
    { status: 'Notice',    count: num(r.notice) },
    { status: 'Other',     count: num(r.other) },
  ].filter(s => s.count > 0);

  const genderRes = await pool.query(`
    ${empSource()}
    SELECT gender, COUNT(*)::int AS count
      FROM emp WHERE bucket <> 'Exited'
     GROUP BY 1 ORDER BY count DESC, gender
  `, popParams);
  const genderBreakdown = genderRes.rows.map(x => ({ gender: x.gender, count: x.count }));

  // ── Records needing attention (point-in-time) ─────────────────────────────
  // Every gap here is one the dashboard itself has to work around: a missing
  // joining_date lands the employee in the tenure chart's 'Not recorded'
  // bucket and out of every hiring window; a probation with no end date never
  // raises a confirmation. Counting them is how they stop being invisible.
  //
  // Reads the RAW columns, not the CTE's COALESCEd aliases — `department` is
  // already defaulted to 'Unassigned' in `emp`, so testing that alias for NULL
  // would report zero for ever.
  const dqRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE e.joining_date IS NULL)                       AS missing_joining_date,
      -- Bank account + IFSC: payroll approval and payment refuse an employee
      -- without them (payrollEligibility.validateStatutoryProfile), so a
      -- missing one is CRITICAL. Address is mandatory master data (§202).
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.account_number), '') IS NULL
                          OR NULLIF(TRIM(e.ifsc_code), '') IS NULL)     AS missing_bank_details,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.current_address), '') IS NULL) AS missing_address,
      -- Informational (§204, Phase 1): details on record that no second HR
      -- person has approved — everything entered before the maker-checker.
      -- NOT part of critical / any-gap: nothing is blocked on it yet.
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.account_number), '') IS NOT NULL
                         AND e.bank_verified_at IS NULL)                AS unverified_bank_details,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.department),  '') IS NULL)      AS missing_department,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.skill_type),  '') IS NULL)      AS missing_skill_type,
      COUNT(*) FILTER (WHERE NULLIF(TRIM(e.designation), '') IS NULL)      AS missing_designation,
      COUNT(*) FILTER (WHERE ${statusExpr('e.status')} = 'probation'
                         AND e.probation_end_date IS NULL)                 AS missing_probation_end,
      -- Two severities, because they are not the same problem.
      -- CRITICAL: the gap breaks a workflow. No joining_date means the person
      -- is absent from every hiring window and lands in the tenure chart's
      -- 'Not recorded' bucket; a probation with no end date never raises a
      -- confirmation, so nobody is ever prompted to confirm them.
      COUNT(*) FILTER (WHERE
             e.joining_date IS NULL
          OR (${statusExpr('e.status')} = 'probation' AND e.probation_end_date IS NULL)
          OR NULLIF(TRIM(e.account_number), '') IS NULL
          OR NULLIF(TRIM(e.ifsc_code), '') IS NULL
      )                                                                    AS critical_gap,
      -- INCOMPLETE: master data that only degrades reporting. Kept separate
      -- so a seeding artefact (28 of 33 rows have no skill_type) cannot bury
      -- the two records that actually block something.
      COUNT(*) FILTER (WHERE
             NULLIF(TRIM(e.department),  '') IS NULL
          OR NULLIF(TRIM(e.skill_type),  '') IS NULL
          OR NULLIF(TRIM(e.designation), '') IS NULL
      )                                                                    AS incomplete_gap,
      COUNT(*) FILTER (WHERE
             e.joining_date IS NULL
          OR NULLIF(TRIM(e.department),  '') IS NULL
          OR NULLIF(TRIM(e.skill_type),  '') IS NULL
          OR NULLIF(TRIM(e.designation), '') IS NULL
          OR (${statusExpr('e.status')} = 'probation' AND e.probation_end_date IS NULL)
          OR NULLIF(TRIM(e.account_number), '') IS NULL
          OR NULLIF(TRIM(e.ifsc_code), '') IS NULL
          OR NULLIF(TRIM(e.current_address), '') IS NULL
      )                                                                    AS any_gap
    FROM employees e
    WHERE e.deleted_at IS NULL
      AND NOT (${isExitedSql('e.status')})
      AND ($1::int  IS NULL OR e.company_id = $1)
      AND ($2::text IS NULL OR COALESCE(NULLIF(TRIM(e.department), ''), 'Unassigned') = $2)
  `, popParams);
  const dq = dqRes.rows[0] || {};
  const dataQuality = {
    // Employees with at least one gap — NOT the sum of the fields below, since
    // one record can be missing several things.
    recordsNeedingAttention: parseInt(dq.any_gap, 10) || 0,
    critical:             parseInt(dq.critical_gap, 10) || 0,
    incomplete:           parseInt(dq.incomplete_gap, 10) || 0,
    missingJoiningDate:   parseInt(dq.missing_joining_date, 10) || 0,
    missingDepartment:    parseInt(dq.missing_department, 10) || 0,
    missingSkillType:     parseInt(dq.missing_skill_type, 10) || 0,
    missingDesignation:   parseInt(dq.missing_designation, 10) || 0,
    missingProbationEnd:  parseInt(dq.missing_probation_end, 10) || 0,
    missingBankDetails:   parseInt(dq.missing_bank_details, 10) || 0,
    missingAddress:       parseInt(dq.missing_address, 10) || 0,
    unverifiedBankDetails: parseInt(dq.unverified_bank_details, 10) || 0,
  };

  const skillRes = await pool.query(`
    ${empSource()}
    SELECT skill, COUNT(*)::int AS count
      FROM emp WHERE bucket <> 'Exited'
     GROUP BY 1 ORDER BY count DESC, skill
  `, popParams);
  const skillBreakdown = skillRes.rows.map(x => ({ skill: x.skill, count: x.count }));

  // No LIMIT. The old query capped at 12 against 14 live departments, so the
  // chart silently summed to 30 while the KPI above it read 32 — the exact
  // "contradictory numbers" failure this endpoint exists to prevent.
  const deptRes = await pool.query(`
    ${empSource()}
    SELECT department,
           COUNT(*)::int                                     AS count,
           COUNT(*) FILTER (WHERE bucket = 'Active')::int     AS active,
           COUNT(*) FILTER (WHERE bucket = 'Probation')::int  AS probation,
           COUNT(*) FILTER (WHERE bucket = 'Notice')::int     AS notice,
           COUNT(*) FILTER (WHERE bucket = 'Other')::int      AS other
      FROM emp WHERE bucket <> 'Exited'
     GROUP BY 1 ORDER BY count DESC, department
  `, popParams);
  const deptBreakdown = deptRes.rows.map(x => ({
    department: x.department,
    count:      x.count,
    active:     x.active,
    probation:  x.probation,
    notice:     x.notice,
    other:      x.other,
  }));

  // 'Not recorded' is a real bucket, not an omission: one current employee has
  // no joining_date, and dropping them made the tenure chart sum to 31 against
  // a headcount of 32 with nothing on screen to explain the gap.
  const tenureRes = await pool.query(`
    ${empSource()}
    SELECT CASE
             WHEN joining_date IS NULL THEN 'Not recorded'
             WHEN ${TENURE_YEARS} < 1  THEN '0-1 yr'
             WHEN ${TENURE_YEARS} < 3  THEN '1-3 yrs'
             WHEN ${TENURE_YEARS} < 5  THEN '3-5 yrs'
             WHEN ${TENURE_YEARS} < 10 THEN '5-10 yrs'
             ELSE '10+ yrs'
           END AS tenure_bucket,
           COUNT(*)::int AS count
      FROM emp WHERE bucket <> 'Exited'
     GROUP BY 1
  `, popParams);
  const tenureMap = Object.fromEntries(tenureRes.rows.map(x => [x.tenure_bucket, x.count]));
  const tenureGroups = TENURE_BUCKETS
    .map(b => ({ bucket: b, count: tenureMap[b] || 0 }))
    // 'Not recorded' is noise when empty; the five real buckets always show.
    .filter(g => g.bucket !== 'Not recorded' || g.count > 0);

  // ── Period bounds ─────────────────────────────────────────────────────────
  // `period=all` must resolve to the first day of real activity, never a fake
  // epoch: the trend series emits one point per month between the bounds, so a
  // 1970 lower bound would return 670 months of zeros.
  let rangeFrom = range.from;
  let rangeTo   = range.to;
  if (!rangeFrom || !rangeTo) {
    const boundsRes = await pool.query(`
      ${empSource()}
      SELECT MIN(LEAST(joining_date,
                       CASE WHEN bucket = 'Exited' THEN eff_exit END))  AS lo,
             GREATEST(MAX(GREATEST(joining_date,
                                   CASE WHEN bucket = 'Exited' THEN eff_exit END)),
                      CURRENT_DATE)                                     AS hi
        FROM emp
    `, popParams);
    const b = boundsRes.rows[0] || {};
    const todayIso = new Date().toISOString().slice(0, 10);
    rangeFrom = rangeFrom || (b.lo ? String(b.lo).slice(0, 10) : todayIso);
    rangeTo   = rangeTo   || (b.hi ? String(b.hi).slice(0, 10) : todayIso);
  }
  const perParams = [cid, dept, rangeFrom, rangeTo];

  // ── Activity (period-scoped) ──────────────────────────────────────────────

  const activityRes = await pool.query(`
    ${empSource()}
    SELECT
      COUNT(*) FILTER (
        WHERE joining_date BETWEEN $3::date AND $4::date)                   AS hires,
      COUNT(*) FILTER (
        WHERE bucket = 'Exited' AND eff_exit BETWEEN $3::date AND $4::date) AS exits,
      -- Headcount on the first day of the window and on the last, which is
      -- what an attrition rate has to divide by. An employee with no
      -- joining_date is treated as already present rather than as never having
      -- joined, so they are neither lost from the denominator nor counted as a
      -- new hire.
      COUNT(*) FILTER (
        WHERE COALESCE(joining_date, DATE '1900-01-01') < $3::date
          AND (bucket <> 'Exited' OR eff_exit >= $3::date))                 AS headcount_start,
      COUNT(*) FILTER (
        WHERE COALESCE(joining_date, DATE '1900-01-01') <= $4::date
          AND (bucket <> 'Exited' OR eff_exit > $4::date))                  AS headcount_end
    FROM emp
  `, perParams);
  const a = activityRes.rows[0] || {};
  const hires          = num(a.hires);
  const exits          = num(a.exits);
  const headcountStart = num(a.headcount_start);
  const headcountEnd   = num(a.headcount_end);
  const avgHeadcount   = (headcountStart + headcountEnd) / 2;
  // exits / average headcount over the window. The old figure was
  // all-time-exits / (current + all-time-exits), which is not an attrition rate
  // in any period and never changed when the FY selector moved.
  const attritionRate = avgHeadcount > 0
    ? Number(((exits / avgHeadcount) * 100).toFixed(1))
    : 0;

  // ── Trend: one row per month in the window, zeros included ────────────────
  // The old query grouped by the months that happened to contain a hire, so on
  // FY27 the chart drew three points (Jun, Jul, Aug) and read as though the
  // financial year were three months long — April, May and September had no
  // hires and therefore no row at all. generate_series makes the axis the
  // period, not the data, which is also why nothing here hardcodes a month.
  //
  // Two correlated subqueries rather than two LEFT JOINs: joining hires and
  // exits onto the same month row fans out into their cross product.
  const trendRes = await pool.query(`
    ${empSource()}, months AS (
      SELECT generate_series(
               DATE_TRUNC('month', $3::date),
               DATE_TRUNC('month', $4::date),
               INTERVAL '1 month') AS m
    )
    SELECT TO_CHAR(m, 'YYYY-MM') AS month_key,
           TO_CHAR(m, 'Mon YY')  AS month,
           (SELECT COUNT(*) FROM emp h
             WHERE DATE_TRUNC('month', h.joining_date) = months.m)::int AS hires,
           (SELECT COUNT(*) FROM emp z
             WHERE z.bucket = 'Exited'
               AND DATE_TRUNC('month', z.eff_exit) = months.m)::int     AS exits
      FROM months
     ORDER BY m
  `, perParams);

  // Cap from the OLD end. `LIMIT ${MAX}` on the query would have kept the
  // FIRST 120 months and dropped the most recent ones — on a company with a
  // long history, `period=all` would have rendered a trend that stopped years
  // ago while claiming to be all time. The KPIs still count the whole window;
  // only the chart is trimmed, and `trendTruncated` says so.
  const allMonths = trendRes.rows.map(x => ({
    monthKey: x.month_key,
    month:    x.month,
    hires:    x.hires,
    exits:    x.exits,
  }));
  const trendTruncated = allMonths.length > MAX_TREND_MONTHS;
  const hiringTrend = trendTruncated ? allMonths.slice(-MAX_TREND_MONTHS) : allMonths;

  // Legacy shapes, still read by HRDashboard.jsx. Same numbers, split back into
  // the two arrays it expects. `hiringTrend` is the one to use in new code: it
  // carries a sortable monthKey and pairs the two series by month rather than
  // matching on a formatted label.
  const newHiresMonthly  = hiringTrend.map(m => ({ month: m.month, monthKey: m.monthKey, hires: m.hires }));
  const attritionMonthly = hiringTrend.map(m => ({ month: m.month, monthKey: m.monthKey, exits: m.exits }));

  return {
    period: {
      key:   range.period,
      label: fyLabelFor(rangeFrom, rangeTo) || range.label,
      from:  rangeFrom,
      to:    rangeTo,
      isAll: range.isAll,
      // The chart shows the last MAX_TREND_MONTHS of the window; the KPIs
      // still cover all of it.
      trendTruncated,
      trendMonths: hiringTrend.length,
    },
    period_scoped: ['newHires', 'exits', 'attritionRate', 'hiringTrend',
                    'newHiresMonthly', 'attritionMonthly'],
    point_in_time: ['total', 'active', 'probation', 'notice', 'avgTenure',
                    'statusBreakdown', 'deptBreakdown', 'genderBreakdown',
                    'skillBreakdown', 'tenureGroups', 'dataQuality'],
    summary: {
      total,
      active:    num(r.active),
      probation: num(r.probation),
      notice:    num(r.notice),
      other:     num(r.other),
      // All-time departures. `left` is the legacy name HRDashboard reads.
      exited:    num(r.exited_all_time),
      left:      num(r.exited_all_time),
      avgTenure: parseFloat(r.avg_tenure) || 0,
      avgTenureMonths: parseFloat(r.avg_tenure_months) || 0,
      tenureUnknown: num(r.tenure_unknown),
      // Period-scoped.
      newHires: hires,
      exits,
      attritionRate,
      headcountStart,
      headcountEnd,
      avgHeadcount,
    },
    statusBreakdown,
    genderBreakdown,
    skillBreakdown,
    tenureGroups,
    deptBreakdown,
    dataQuality,
    hiringTrend,
    newHiresMonthly,
    attritionMonthly,
  };
};

// ── Workforce Analytics ─────────────────────────────────────────────────────

/** Status filter values: the display buckets bucketSql produces. */
export const WORKFORCE_STATUSES = ['Active', 'Probation', 'Notice', 'Other', 'Exited'];

/**
 * Below this many recorded values a breakdown is flagged `lowSample`. The
 * flag is advice for the UI; the counts are always returned.
 */
export const WORKFORCE_MIN_SAMPLE = 5;

/** Text filters: query key → the employees column it matches (as labelled). */
const WORKFORCE_TEXT_FILTERS = {
  department:      'e.department',
  designation:     'e.designation',
  employment_type: 'e.employment_type',
  gender:          'e.gender',
  skill_type:      'e.skill_type',
};

const AGE_BANDS = ['Under 25', '25-29', '30-34', '35-39', '40-44', '45-49', '50+', NOT_RECORDED];
const EXPERIENCE_BANDS = TENURE_BUCKETS;   // same labels and cut points as tenure

/** A 400 the route can return as-is. */
function workforceBadRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  return err;
}

/**
 * Validate and normalise the filter query. Unknown values are rejected rather
 * than ignored: a filter the server silently dropped would render the whole
 * company under a heading that names a department.
 */
export function parseWorkforceFilters(query = {}) {
  const pick = (k) => {
    const raw = query[k];
    if (raw == null) return null;
    const v = String(raw).trim();
    if (v === '' || v.toLowerCase() === 'all') return null;
    if (v.length > 200) throw workforceBadRequest(`${k} is too long`);
    return v;
  };

  const filters = {};
  for (const k of Object.keys(WORKFORCE_TEXT_FILTERS)) {
    const v = pick(k);
    if (v != null) filters[k] = v;
  }

  // `location` is accepted as an alias: the page calls it Location, the
  // canonical column is branch_id. Legacy free-text `employees.location` is not
  // used — Add/Edit Employee write branch_id.
  const branch = pick('branch_id') ?? pick('location');
  if (branch != null) {
    if (branch === NOT_RECORDED) filters.branch_id = NOT_RECORDED;
    else if (/^\d+$/.test(branch)) filters.branch_id = parseInt(branch, 10);
    else throw workforceBadRequest(`branch_id must be a branch id or "${NOT_RECORDED}"`);
  }

  const status = pick('status');
  if (status != null) {
    const canonical = WORKFORCE_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
    if (!canonical) throw workforceBadRequest(`status must be one of ${WORKFORCE_STATUSES.join(', ')}`);
    filters.status = canonical;
  }
  return filters;
}

/**
 * Company-scoped workforce analytics for the Workforce Analytics page.
 *
 * Built on empSource({ extended: true }) — the Employees Dashboard's source —
 * so headcount here and there is the same number.
 *
 * WHO IS COUNTED
 *   Composition breakdowns cover current staff (status bucket ≠ Exited), as the
 *   dashboard does. A `status` filter replaces that default: status=Exited
 *   describes the people who have left.
 *
 * WHAT THE PERIOD MOVES
 *   Only joiningTrend and exits. Composition is "as of today", per the
 *   dashboard filter contract.
 *
 * Salary is deliberately absent: this endpoint is gated on hr:view, and
 * compensation needs payroll:view.
 *
 * @param {object} p
 * @param {number|null} p.company_id  REQUIRED. null only for a global
 *        super-admin scope; undefined throws — a forgotten scope must not
 *        silently become "every company".
 */
/**
 * The filtered Workforce Analytics row source, shared by the charts and the
 * exports so the two can never count different people.
 *
 * @returns {{ src: string, params: any[], population: string }}
 *   `src` is the WITH clause; `params` its bindings; `population` the predicate
 *   for "who the composition covers" (current staff, unless a status filter
 *   replaces that default).
 */
function workforceSource(company_id, filters = {}) {
  if (company_id === undefined) {
    throw new Error('workforceSource: company_id is required (null = global scope)');
  }
  const cid = company_id ?? null;

  // ── Filter predicates, numbered after empSource's $1 (company) and $2 ──────
  // $2 is empSource's legacy department slot, which labels blanks 'Unassigned'.
  // Workforce Analytics labels them 'Not recorded', so $2 is left NULL and
  // department is filtered below with the same labelSql as the chart.
  const params = [cid, null];
  let where = '';
  for (const [key, col] of Object.entries(WORKFORCE_TEXT_FILTERS)) {
    if (filters[key] == null) continue;
    params.push(filters[key]);
    where += `\n      AND ${labelSql(col)} = $${params.length}`;
  }
  if (filters.branch_id === NOT_RECORDED) {
    where += `\n      AND e.branch_id IS NULL`;
  } else if (filters.branch_id != null) {
    params.push(filters.branch_id);
    where += `\n      AND e.branch_id = $${params.length}::int`;
  }
  if (filters.status) {
    params.push(filters.status);
    where += `\n      AND ${bucketSql('e.status')} = $${params.length}`;
  }
  const src = empSource({ extended: true, where });
  const population = filters.status ? 'TRUE' : `bucket <> 'Exited'`;
  return { src, params, population };
}

/**
 * The period the joins/exits figures cover. `period=all` resolves to the real
 * activity bounds of the filtered rows, never an epoch.
 */
async function workforcePeriod(src, params, { period, from, to }) {
  // ── Period ────────────────────────────────────────────────────────────────
  const range = resolveRange({ period, from, to }, { defaultPeriod: 'fytd' });
  let rangeFrom = range.from;
  let rangeTo   = range.to;
  if (!rangeFrom || !rangeTo) {
    // period=all: real activity bounds, never an epoch (see getEmployeeAnalytics).
    const boundsRes = await pool.query(`
      ${src}
      SELECT MIN(LEAST(joining_date, CASE WHEN bucket = 'Exited' THEN known_exit END)) AS lo,
             GREATEST(MAX(GREATEST(joining_date, CASE WHEN bucket = 'Exited' THEN known_exit END)),
                      CURRENT_DATE) AS hi
        FROM emp
    `, params);
    const b = boundsRes.rows[0] || {};
    const todayIso = new Date().toISOString().slice(0, 10);
    rangeFrom = rangeFrom || (b.lo ? toIsoDate(b.lo) : todayIso);
    rangeTo   = rangeTo   || (b.hi ? toIsoDate(b.hi) : todayIso);
  }
  // An inverted from/to is already swapped by resolveRange (shared convention).
  return { range, rangeFrom, rangeTo };
}

export const getWorkforceAnalytics = async ({
  company_id, filters = {}, period, from, to, policy = null,
} = {}) => {
  if (company_id === undefined) {
    throw new Error('getWorkforceAnalytics: company_id is required (null = global scope)');
  }
  // Company-editable limits (Workforce Analytics → Settings). Validated
  // integers, so they are safe to inline in the SQL below.
  const pol = policy || await getWorkforcePolicy(pool, company_id);
  const minAge = Math.trunc(Number(pol.min_employee_age));
  const maxAge = Math.trunc(Number(pol.max_employee_age));
  const minSample = Math.trunc(Number(pol.analytics_min_sample)) || WORKFORCE_MIN_SAMPLE;
  if (![minAge, maxAge].every(Number.isInteger)) throw new Error('workforce policy ages must be integers');

  const { src, params, population } = workforceSource(company_id, filters);
  const { range, rangeFrom, rangeTo } = await workforcePeriod(src, params, { period, from, to });

  // ── Composition (point-in-time) ───────────────────────────────────────────
  // A date of birth outside the company's age limits (or in the future) is not
  // an age: EMP003's 27 Feb 2026 was charted as "Under 25". It is counted as
  // not recorded and listed under dataIssues.implausibleDob so HR can fix it.
  const ageYears = `EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob))`;
  const dobImplausible = `(wf_dob_raw IS NOT NULL AND (wf_dob_raw > CURRENT_DATE
        OR ${ageYears} < ${minAge} OR ${ageYears} > ${maxAge}))`;
  const ageBand = `CASE
        WHEN wf_dob IS NULL OR ${dobImplausible} THEN '${NOT_RECORDED}'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 25 THEN 'Under 25'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 30 THEN '25-29'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 35 THEN '30-34'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 40 THEN '35-39'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 45 THEN '40-44'
        WHEN EXTRACT(YEAR FROM AGE(CURRENT_DATE, wf_dob)) < 50 THEN '45-49'
        ELSE '50+' END`;
  // Total experience = prior employment + time here. Unknown unless BOTH are
  // known: prior years alone would undercount, tenure alone would ignore a
  // career before this company.
  const expYears = `(wf_prior_years + (CURRENT_DATE - joining_date) / 365.25)`;
  const expBand = `CASE
        WHEN wf_prior_years IS NULL OR joining_date IS NULL OR joining_date > CURRENT_DATE
          THEN '${NOT_RECORDED}'
        WHEN ${expYears} < 1  THEN '0-1 yr'
        WHEN ${expYears} < 3  THEN '1-3 yrs'
        WHEN ${expYears} < 5  THEN '3-5 yrs'
        WHEN ${expYears} < 10 THEN '5-10 yrs'
        ELSE '10+ yrs' END`;

  const DIMS = {
    department:     'wf_department',
    status:         'bucket',
    designation:    'wf_designation',
    employmentType: 'wf_employment_type',
    location:       'wf_branch',
    gender:         'wf_gender',
    skillType:      'wf_skill_type',
    qualification:  'wf_qualification',
    age:            ageBand,
    experience:     expBand,
    // Assigned by HR on the employee record (workforce_category_id); never
    // inferred from designation. Unassigned employees are 'Not recorded'.
    workforceCategory: 'wf_workforce_category',
  };
  const compRes = await pool.query(`
    ${src}, pop AS (SELECT * FROM emp WHERE ${population})
    ${Object.entries(DIMS).map(([dim, expr]) =>
      // Location groups by id as well as name, so two branches that share a
      // name stay two buckets, each carrying the id its filter needs.
      dim === 'location'
        ? `SELECT '${dim}'::text AS dim, (${expr})::text AS value, wf_branch_id AS branch_id, COUNT(*)::int AS count
             FROM pop GROUP BY 2, 3`
        : `SELECT '${dim}'::text AS dim, (${expr})::text AS value, NULL::int AS branch_id, COUNT(*)::int AS count
             FROM pop GROUP BY 2`).join('\n    UNION ALL\n    ')}
    UNION ALL
    SELECT '_total', NULL, NULL, COUNT(*)::int FROM pop
    UNION ALL
    SELECT '_joiningDate', NULL, NULL, COUNT(joining_date)::int FROM pop
  `, params);

  const total = compRes.rows.find(r => r.dim === '_total')?.count ?? 0;
  const joiningRecorded = compRes.rows.find(r => r.dim === '_joiningDate')?.count ?? 0;

  const ORDER = { age: AGE_BANDS, experience: EXPERIENCE_BANDS };
  const breakdown = (dim) => {
    const rows = compRes.rows.filter(r => r.dim === dim);
    let buckets = rows.map(r => ({
      value: r.value,
      count: r.count,
      // Location buckets carry the branch id: that is what the filter takes.
      ...(dim === 'location' ? { branchId: r.value === NOT_RECORDED ? null : r.branch_id } : {}),
    }));
    if (ORDER[dim]) {
      buckets = ORDER[dim]
        .map(v => buckets.find(b => b.value === v) || { value: v, count: 0 })
        // An empty 'Not recorded' is noise; empty real bands are the axis.
        .filter(b => b.value !== NOT_RECORDED || b.count > 0);
    } else {
      buckets.sort((a, b) =>
        (a.value === NOT_RECORDED) - (b.value === NOT_RECORDED)
        || b.count - a.count || String(a.value).localeCompare(String(b.value)));
    }
    const notRecorded = buckets.find(b => b.value === NOT_RECORDED)?.count ?? 0;
    const recorded = total - notRecorded;
    return {
      total, recorded, notRecorded,
      lowSample: recorded < minSample,
      buckets,
    };
  };
  const breakdowns = Object.fromEntries(Object.keys(DIMS).map(d => [d, breakdown(d)]));

  const implausibleRes = await pool.query(`
    ${src}, pop AS (SELECT * FROM emp WHERE ${population})
    SELECT id FROM pop WHERE ${dobImplausible} ORDER BY id
  `, params);
  const implausibleIds = implausibleRes.rows.map(r => r.id);

  const fromIdx = params.length + 1;
  const toIdx   = params.length + 2;
  const perParams = [...params, rangeFrom, rangeTo];

  // ── Movement (period-scoped) ──────────────────────────────────────────────
  // Correlated subqueries per month, as in getEmployeeAnalytics: two LEFT JOINs
  // onto the same month row would fan out into their cross product.
  const trendRes = await pool.query(`
    ${src}, months AS (
      SELECT generate_series(DATE_TRUNC('month', $${fromIdx}::date),
                             DATE_TRUNC('month', $${toIdx}::date),
                             INTERVAL '1 month') AS m
    )
    SELECT TO_CHAR(m, 'YYYY-MM') AS month_key,
           TO_CHAR(m, 'Mon YY')  AS month,
           (SELECT COUNT(*) FROM emp h
             WHERE h.joining_date >= GREATEST(months.m, $${fromIdx}::date)
               AND h.joining_date <= LEAST((months.m + INTERVAL '1 month - 1 day')::date, $${toIdx}::date))::int AS joins,
           (SELECT COUNT(*) FROM emp z
             WHERE z.bucket = 'Exited'
               AND z.known_exit >= GREATEST(months.m, $${fromIdx}::date)
               AND z.known_exit <= LEAST((months.m + INTERVAL '1 month - 1 day')::date, $${toIdx}::date))::int AS exits
      FROM months ORDER BY m
  `, perParams);
  const allMonths = trendRes.rows.map(x => ({
    monthKey: x.month_key, month: x.month, joins: x.joins, exits: x.exits,
  }));
  const trendTruncated = allMonths.length > MAX_TREND_MONTHS;
  const months = trendTruncated ? allMonths.slice(-MAX_TREND_MONTHS) : allMonths;

  const exitRes = await pool.query(`
    ${src}
    SELECT wf_exit_reason AS reason,
           COUNT(*) FILTER (WHERE known_exit BETWEEN $${fromIdx}::date AND $${toIdx}::date)::int AS in_period,
           COUNT(*) FILTER (WHERE known_exit IS NULL)::int AS date_unknown,
           COUNT(*)::int AS all_time
      FROM emp WHERE bucket = 'Exited'
     GROUP BY 1
  `, perParams);
  const byReason = (key) => exitRes.rows
    .filter(r => r[key] > 0)
    .map(r => ({ reason: r.reason, count: r[key] }))
    .sort((a, b) =>
      (a.reason === NOT_RECORDED) - (b.reason === NOT_RECORDED)
      || b.count - a.count || a.reason.localeCompare(b.reason));
  const sumOf = (key) => exitRes.rows.reduce((n, r) => n + r[key], 0);
  const exitedAllTime = sumOf('all_time');
  const exitDateUnknown = sumOf('date_unknown');
  const reasonNotRecorded = exitRes.rows.find(r => r.reason === NOT_RECORDED)?.all_time ?? 0;

  const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
  const field = (key, label, recorded, of) => ({
    field: key, label, recorded, total: of, pct: pct(recorded, of),
    lowSample: recorded < minSample,
  });

  return {
    filters,
    period: {
      key: range.period,
      label: range.label,
      from: rangeFrom,
      to: rangeTo,
      isAll: range.isAll,
      trendTruncated,
      trendMonths: months.length,
    },
    population: {
      basis: filters.status ? `status:${filters.status}` : 'current',
      total,
    },
    minSample,
    policy: {
      min_employee_age: minAge,
      max_employee_age: maxAge,
      analytics_min_sample: minSample,
    },
    dataIssues: {
      // Current population only (the same people the Age card counts).
      implausibleDob: { count: implausibleIds.length, ids: implausibleIds, minAge, maxAge },
    },
    period_scoped: ['joiningTrend', 'exits'],
    point_in_time: ['breakdowns', 'completeness'],
    breakdowns,
    // Totals cover the whole window even when the chart series is trimmed to
    // the last MAX_TREND_MONTHS (trendTruncated says so).
    joiningTrend: {
      months: months.map(m => ({ monthKey: m.monthKey, month: m.month, joins: m.joins })),
      total: allMonths.reduce((n, m) => n + m.joins, 0),
    },
    exits: {
      inPeriod: allMonths.reduce((n, m) => n + m.exits, 0),
      byMonth: months.map(m => ({ monthKey: m.monthKey, month: m.month, exits: m.exits })),
      byReason: byReason('in_period'),
      // Exits with neither an exit_date nor a last working day on an exit
      // request. They cannot be placed in any period, so they are reported
      // here and never filed under the month the record was last edited.
      dateUnknown: { count: exitDateUnknown, byReason: byReason('date_unknown') },
      allTime: exitedAllTime,
    },
    completeness: [
      field('department',     'Department',      breakdowns.department.recorded,     total),
      field('designation',    'Designation',     breakdowns.designation.recorded,    total),
      field('employmentType', 'Employment Type', breakdowns.employmentType.recorded, total),
      field('location',       'Location',        breakdowns.location.recorded,       total),
      field('gender',         'Gender',          breakdowns.gender.recorded,         total),
      field('skillType',      'Skill Type',      breakdowns.skillType.recorded,      total),
      field('qualification',  'Qualification',   breakdowns.qualification.recorded,  total),
      field('age',            'Date of Birth',   breakdowns.age.recorded,            total),
      field('experience',     'Experience',      breakdowns.experience.recorded,     total),
      field('joiningDate',    'Joining Date',    joiningRecorded,                    total),
      field('exitDate',       'Exit Date',       exitedAllTime - exitDateUnknown,    exitedAllTime),
      field('exitReason',     'Exit Reason',     exitedAllTime - reasonNotRecorded,  exitedAllTime),
      field('workforceCategory', 'Workforce Category', breakdowns.workforceCategory.recorded, total),
    ],
  };
};

// ── Workforce Analytics exports ─────────────────────────────────────────────
//
// Built on workforceSource(), so an export lists exactly the people the page
// counted under the same filters. Columns are deliberately narrow: no contact
// details, ID numbers (PAN/Aadhaar/UAN…), bank details, salary, file links,
// file contents or notes. Formula quoting and Aadhaar masking are applied by
// the frontend's shared CSV writer (features/employees/csvExport.js).

export const WORKFORCE_EXPORT_COLUMNS = {
  headcount: ['Emp Code', 'Employee', 'Department', 'Designation', 'Employment Type',
              'Workforce Category', 'Skill Type', 'Location', 'Status', 'Joining Date'],
  attrition: ['Emp Code', 'Employee', 'Department', 'Designation', 'Joining Date',
              'Exit Date', 'Exit Date Source', 'Period', 'Exit Reason', 'Status'],
  documents: ['Emp Code', 'Employee', 'Department', 'Document Type', 'Document Name',
              'Expiry Date', 'Days Left', 'Expiry Status', 'Document Status'],
};

/** Document-expiry windows. A window must be chosen explicitly — there is no default. */
export const DOCUMENT_EXPIRY_WINDOWS = {
  expired:       { label: 'Expired',                         sql: `d.expiry_date < CURRENT_DATE` },
  next30:        { label: 'Expiring in the next 30 days',    sql: `d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30` },
  next60:        { label: 'Expiring in the next 60 days',    sql: `d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60` },
  next90:        { label: 'Expiring in the next 90 days',    sql: `d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90` },
  expired_or_30: { label: 'Expired or expiring in 30 days',  sql: `d.expiry_date <= CURRENT_DATE + 30` },
};

const dateOrBlank = (d) => (d ? toIsoDate(d) : '');

/**
 * Headcount: the composition population (current staff, or the status the
 * filter names) — the same people the charts count. The period does NOT apply:
 * headcount is "as of today", exactly like the composition charts.
 */
export async function getWorkforceHeadcountExport({ company_id, filters = {} } = {}) {
  const { src, params, population } = workforceSource(company_id, filters);
  const { rows } = await pool.query(`
    ${src}
    SELECT x.office_id,
           TRIM(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')) AS employee,
           emp.wf_department, emp.wf_designation, emp.wf_employment_type,
           emp.wf_workforce_category, emp.wf_skill_type, emp.wf_branch,
           emp.bucket, emp.joining_date
      FROM emp
      JOIN employees x ON x.id = emp.id
     WHERE ${population}
     ORDER BY emp.wf_department, employee, x.id
  `, params);
  return {
    report: 'headcount',
    columns: WORKFORCE_EXPORT_COLUMNS.headcount,
    rows: rows.map(r => [r.office_id ?? '', r.employee, r.wf_department, r.wf_designation,
      r.wf_employment_type, r.wf_workforce_category, r.wf_skill_type, r.wf_branch,
      r.bucket, dateOrBlank(r.joining_date)]),
    total: rows.length,
    filters,
  };
}

/**
 * Attrition: exits dated inside the period, PLUS every exit with no recorded
 * date. An undated exit cannot be placed in any period, so it is listed with
 * Exit Date 'Unknown' and Period 'Date unknown — not placed in any period'
 * rather than dated by updated_at (which records the last edit, not the exit).
 */
export async function getWorkforceAttritionExport({ company_id, filters = {}, period, from, to } = {}) {
  const { src, params } = workforceSource(company_id, filters);
  const { range, rangeFrom, rangeTo } = await workforcePeriod(src, params, { period, from, to });
  const fromIdx = params.length + 1;
  const toIdx = params.length + 2;
  const { rows } = await pool.query(`
    ${src}
    SELECT x.office_id,
           TRIM(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')) AS employee,
           emp.wf_department, emp.wf_designation, emp.joining_date,
           emp.known_exit, (x.exit_date IS NOT NULL) AS has_exit_date,
           emp.wf_exit_reason, NULLIF(TRIM(x.status), '') AS status
      FROM emp
      JOIN employees x ON x.id = emp.id
     WHERE emp.bucket = 'Exited'
       AND (emp.known_exit BETWEEN $${fromIdx}::date AND $${toIdx}::date OR emp.known_exit IS NULL)
     ORDER BY emp.known_exit DESC NULLS LAST, employee, x.id
  `, [...params, rangeFrom, rangeTo]);
  const source = (r) => (r.has_exit_date ? 'Exit date'
    : r.known_exit ? 'Last working day (exit request)'
      : 'Unknown — no exit date or last working day recorded');
  return {
    report: 'attrition',
    columns: WORKFORCE_EXPORT_COLUMNS.attrition,
    rows: rows.map(r => [r.office_id ?? '', r.employee, r.wf_department, r.wf_designation,
      dateOrBlank(r.joining_date),
      r.known_exit ? toIsoDate(r.known_exit) : 'Unknown',
      source(r),
      r.known_exit ? 'In period' : 'Date unknown — not placed in any period',
      r.wf_exit_reason, r.status ?? NOT_RECORDED]),
    total: rows.length,
    dateUnknown: rows.filter(r => !r.known_exit).length,
    period: { key: range.period, label: range.label, from: rangeFrom, to: rangeTo },
    filters,
  };
}

/**
 * Document expiry: documents of the filtered population whose expiry falls in
 * an explicitly chosen window. Scoped twice — the employee's company (through
 * the source) AND the document's own company_id. Documents are hard-deleted, so
 * a deleted one cannot appear; documents of soft-deleted employees are excluded
 * by the source. File links, file contents and notes are never selected.
 */
export async function getWorkforceDocumentExpiryExport({ company_id, filters = {}, window } = {}) {
  const w = DOCUMENT_EXPIRY_WINDOWS[window];
  if (!w) {
    throw workforceBadRequest(`window must be one of: ${Object.keys(DOCUMENT_EXPIRY_WINDOWS).join(', ')}`);
  }
  const { src, params, population } = workforceSource(company_id, filters);
  const { rows } = await pool.query(`
    ${src}
    SELECT x.office_id,
           TRIM(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')) AS employee,
           emp.wf_department,
           NULLIF(TRIM(d.document_type), '') AS document_type,
           NULLIF(TRIM(d.document_name), '') AS document_name,
           d.expiry_date, (d.expiry_date - CURRENT_DATE) AS days_left,
           NULLIF(TRIM(d.status), '') AS status
      FROM employee_documents d
      JOIN emp ON emp.id = d.employee_id
      JOIN employees x ON x.id = d.employee_id
     WHERE ${population}
       AND d.expiry_date IS NOT NULL
       AND ($1::int IS NULL OR d.company_id = $1)
       AND ${w.sql}
     ORDER BY d.expiry_date, employee, d.id
  `, params);
  return {
    report: 'documents',
    window: { key: window, label: w.label },
    columns: WORKFORCE_EXPORT_COLUMNS.documents,
    rows: rows.map(r => [r.office_id ?? '', r.employee, r.wf_department,
      r.document_type ?? NOT_RECORDED, r.document_name ?? '', toIsoDate(r.expiry_date),
      Number(r.days_left), Number(r.days_left) < 0 ? 'Expired' : 'Expiring',
      r.status ?? 'pending']),
    total: rows.length,
    filters,
  };
}

/** A pg DATE (a JS Date at local midnight) as YYYY-MM-DD, without a UTC shift. */
function toIsoDate(d) {
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
