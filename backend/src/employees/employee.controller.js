import * as service from "./employee.service.js";
import { uploadFile } from "../services/StorageService.js";
import { logAudit } from "../services/AuditService.js";
import { rolesOf, permissionFor, can } from "../middlewares/auth.middleware.js";
import { validateStatutoryProfile } from "../modules/payroll/payrollEligibility.js";
import pool from "../config/db.js";
import { notifyWorkflowEvent } from "../services/WorkflowNotificationService.js";
import * as bankChange from "./bankChange.service.js";
import { withSalaryMasking } from "./salaryVisibility.js";
import { companyOf } from "../shared/scope.js";
import { readScope } from "../shared/employeeAccess.js";
// respondError classifies the error instead of blanket-500ing it: an explicit
// err.statusCode wins, and Postgres constraint violations map to 4xx. Rejecting
// a value that isn't in the master is the caller's mistake, not a server fault.
import { respondError } from "../shared/pgErrors.js";
import { assertDateParams } from "../shared/dashboardFilters.js";

async function processUploadedFiles(reqFiles) {
  const fields = {};
  if (!reqFiles || typeof reqFiles !== 'object') return fields;
  for (const [fieldname, files] of Object.entries(reqFiles)) {
    for (const file of files) {
      fields[fieldname] = await uploadFile(file.buffer, file.originalname, file.mimetype);
    }
  }
  return fields;
}

/**
 * Credential-shaped keys that must never appear in an employee response.
 * Exact names, not a substring match: `must_change_password` is a legitimate
 * flag a client may read, and is not a credential.
 */
const CREDENTIAL_KEY = /^(password|password_hash|temp_password|temporary_password|otp|dev_otp)$/i;

/**
 * A copy of `value` with every credential-shaped key removed, at any depth.
 *
 * The real fix is at the source — createEmployeeLogin no longer returns a
 * password. This is the backstop on the way out, so a service that starts
 * returning one again (or a nested object that carries one) is stripped here
 * instead of shipped. Exported for its test.
 */
export function withoutCredentials(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 6) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(v => withoutCredentials(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(k)) continue;
    out[k] = withoutCredentials(v, depth + 1);
  }
  return out;
}

// ── Bank details (§202, maker-checker §204) ─────────────────────────────────
// Employees cannot change bank details (Self-Service refuses them). An HR user
// holding employee_bank:add (propose only) or :edit enters new or changed
// details on Add / Edit Employee; they do NOT reach the employees row. They
// become a PENDING request (bankChange.service.js) that a DIFFERENT HR user
// with employee_bank:edit approves — only then is the row written, stamped
// bank_verified_at / _by, and the company's Accounts / Finance users notified
// (name and code only; nothing changes in another system, no payment).
// Unmasked account numbers are shown only to employee_bank:view holders and to
// the employee themself.
const BANK_KEYS = ["account_number", "ifsc_code", "bank_name", "branch_name"];
const norm = (v) => String(v ?? "").trim().replace(/\s+/g, "").toUpperCase();
const isMaskedAccount = (v) => /^X{4}\S{1,4}$/.test(String(v ?? "").trim());

/** Stored form: IFSC upper-case, account number without spaces (the bank file uses the raw value). */
function normaliseBank(body) {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  if (typeof out.ifsc_code === "string") out.ifsc_code = out.ifsc_code.trim().toUpperCase();
  if (typeof out.account_number === "string" && !isMaskedAccount(out.account_number)) out.account_number = out.account_number.replace(/\s+/g, "");
  return out;
}

/** Bank keys this body would change on `before` ({} for a new employee). */
function bankChanges(body, before = {}) {
  return BANK_KEYS.filter(k => k in (body || {})
    && !(k === "account_number" && isMaskedAccount(body[k]))
    && norm(body[k]) !== norm(before[k]));
}

const canProposeBank = async (req) => (await can(req, "employee_bank", "add")) || (await can(req, "employee_bank", "edit"));
const withoutBankKeys = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => !BANK_KEYS.includes(k)));
const pickBank = (body, keys) => Object.fromEntries(keys.map(k => [k, String(body[k] ?? "").trim()]));

/** Format of the account number / IFSC being saved — the rule payroll pays on. */
function bankFormatErrors(body) {
  const probe = {
    account_number: "account_number" in body && !isMaskedAccount(body.account_number) ? body.account_number : "000000000",
    ifsc_code: "ifsc_code" in body ? body.ifsc_code : "AAAA0000000",
  };
  return validateStatutoryProfile(probe, {})
    .filter(i => i.severity === "error" && ["account_number", "ifsc_code"].includes(i.field)
      && String(probe[i.field] ?? "").trim() !== "")
    .map(i => i.message);
}

/** The company's Accounts / Finance users: holders of finance:edit by role. */
async function notifyAccountsOfBankChange(req, emp, { verifiedOnly = false } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'finance' AND rp.can_edit = true
        WHERE u.is_active = true AND u.company_id = $1 AND u.id <> $2`,
      [emp.company_id, req.user?.userId ?? req.user?.id ?? -1]);
    if (!rows.length) return;
    const name = `${emp.first_name || ""} ${emp.last_name || ""}`.trim();
    notifyWorkflowEvent("bank_details_changed", {
      module: "Employee", recordId: emp.id, recipientUserIds: rows.map(r => r.id),
      context: { employeeLabel: [name, emp.office_id && `(${emp.office_id})`].filter(Boolean).join(" "), action: verifiedOnly ? "verified" : "changed" },
    });
  } catch { /* a notification must never undo a saved change */ }
}

/** Mask the account number unless the caller holds employee_bank:view or it is their own row. */
async function withBankMasking(req, payload) {
  if (await can(req, "employee_bank", "view")) return payload;
  const own = req.user?.employee_id != null ? String(req.user.employee_id) : null;
  const mask = (e) => (e && typeof e === "object" && e.account_number && String(e.id) !== own && !isMaskedAccount(e.account_number))
    ? { ...e, account_number: `XXXX${String(e.account_number).slice(-4)}` } : e;
  if (Array.isArray(payload)) return payload.map(mask);
  if (payload && typeof payload === "object") {
    const out = mask(payload);
    for (const k of ["data", "employees", "rows"]) if (Array.isArray(out[k])) out[k] = out[k].map(mask);
    return out;
  }
  return payload;
}

/** Every employee-record response: salary first (salaryVisibility.js), then bank masking. */
const maskForCaller = async (req, payload) => withBankMasking(req, await withSalaryMasking(req, payload));

// Salary fields on an employee write. A correction rewrites the salary revision
// in force (and the master Basic); the first one creates a revision. Both are
// salary changes, so they take payroll:edit like Salary Structures does.
const SALARY_WRITE_KEYS = ["basic_salary", "special_allowance", "salary_revision_id"];

// Mandatory on Add Employee: payroll cannot pay without them, and only HR can
// enter them. Paths that create an employee without this form surface on the
// readiness checkpoints instead (Employees dashboard data quality, the payroll
// approval / payment bank check).
const REQUIRED_BANK_ON_CREATE = [
  ["account_number", "Bank account number"],
  ["ifsc_code", "IFSC code"],
  ["current_address", "Current address"],
];

export const addEmployee = async (req, res) => {
  try {
    // Convert to Employee also changes the internship record, so it needs the
    // internships edit grant on top of the HR role this route already requires.
    const fromIntern = String(req.body?.from_intern_id ?? '').trim();
    if (fromIntern && fromIntern !== 'null') {
      let perm = null;
      try { perm = await permissionFor(req, 'internships'); } catch { perm = null; }
      if (perm?.can_edit !== true) {
        return res.status(403).json({ error: 'Converting an intern needs the Internships edit permission.' });
      }
    }
    // PC-01 closure decision 5: the first salary is a salary change too. HR
    // without payroll:edit may still create the employee — with no salary;
    // Payroll records it in Salary Structures. A value is refused, never dropped.
    // An empty field (the form's blank input) is no value.
    const salarySent = SALARY_WRITE_KEYS.filter(k => String(req.body?.[k] ?? "").trim() !== "");
    if (salarySent.length && !(await can(req, "payroll", "edit"))) {
      return res.status(403).json({ code: "SALARY_PERMISSION", fields: salarySent, error: "Setting the salary needs payroll edit permission. Nothing was saved — create the employee without a salary; Payroll records it in Salary Structures." });
    }
    for (const k of SALARY_WRITE_KEYS) if (k in (req.body || {}) && !salarySent.includes(k)) delete req.body[k];
    req.body = normaliseBank(req.body);
    const missing = REQUIRED_BANK_ON_CREATE.filter(([k]) => !String(req.body?.[k] ?? "").trim()).map(([, l]) => l);
    if (missing.length) {
      return res.status(400).json({ code: "REQUIRED_FIELDS", error: `Required before the employee can be created: ${missing.join(", ")}.`, missing });
    }
    const newBank = bankChanges(req.body);
    if (newBank.length && !(await canProposeBank(req))) {
      return res.status(403).json({ code: "BANK_DETAILS_PERMISSION", error: "Entering bank details needs the HR bank-details permission. Ask an HR manager to add this employee." });
    }
    const formatErrors = bankFormatErrors(req.body);
    if (formatErrors.length) return res.status(400).json({ code: "BANK_DETAILS_INVALID", error: formatErrors.join("; ") });
    const fileFields = await processUploadedFiles(req.files);
    // The bank details go to a pending request, not onto the new row.
    const emp = await service.addEmployee({
      ...withoutBankKeys(req.body),
      ...fileFields,
      company_id: companyOf(req),
      converted_by_user_id: req.user?.userId ?? req.user?.id ?? null,
    });
    // The audit entry records the employee row, not the login descriptor.
    const empRecord = withoutCredentials(emp);
    delete empRecord.login;
    logAudit({ userId: req.user?.id, module: 'employees', recordId: emp.id, recordType: 'employee', action: 'create', newData: empRecord });
    let bankRequest = null;
    if (newBank.length) {
      try {
        bankRequest = await bankChange.propose({
          employeeId: emp.id, companyId: emp.company_id ?? companyOf(req), current: {},
          changes: pickBank(req.body, newBank), requestedBy: req.user?.userId ?? req.user?.id ?? null, source: "create",
        });
        logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'employees', recordId: emp.id, recordType: 'employee_bank_details',
          action: 'propose', newData: { request_id: bankRequest.id, fields_changed: newBank } });
      } catch (e) {
        bankRequest = { status: "failed", error: e.message };
      }
    }
    // `login` stays — { email, created } is what Add Employee shows HR — but
    // nothing credential-shaped leaves in this response, at any depth.
    res.json({ ...(await withSalaryMasking(req, withoutCredentials(emp))), ...(bankRequest ? { bank_change_request: bankRequest } : {}) });
  } catch (err) {
    respondError(res, err);
  }
};

export const getEmployees = async (req, res) => {
  try {
    // A caller whose company cannot be resolved is refused, not given the
    // "global" list a null company would otherwise mean (super admin only).
    const scope = readScope(req);
    if (scope.refused) return res.status(403).json({ error: "Your account has no company assignment" });
    const employees = await service.getEmployees({
      ...(req.query || {}),
      company_id: scope.companyId,
      // rolesOf(), not req.user.role: roles are many-to-many, so gating on the
      // primary claim alone hides fields from someone whose HR grant is a
      // secondary role. callerEmployeeId keeps the caller's OWN row unmasked,
      // matching what GET /employees/:id already does for self.
      callerRole: rolesOf(req),
      callerEmployeeId: req.user?.employee_id ?? null,
    });
    res.json(await maskForCaller(req, employees));
  } catch (err) {
    respondError(res, err);
  }
};

export const getEmployee = async (req, res) => {
  try {
    const callerRole = rolesOf(req);
    const isSelf = req.user?.employee_id != null &&
                   String(req.user.employee_id) === String(req.params.id);
    // A directory-tier caller (an ordinary employee, or any role outside the
    // Employees menu and the HR / salary seats) asking about SOMEONE ELSE gets
    // the company-phonebook row — the very projection GET /employees/directory
    // returns them, personal phone withheld — and never the employee record.
    // Org Chart opens Employee Profile for every role it is shown to, so this
    // is a narrowing, not a 403: the profile still renders the public fields.
    if (!isSelf && !service.holdsFullRecordAccess(callerRole)) {
      const scope = readScope(req);
      if (scope.refused) return res.status(403).json({ error: "Your account has no company assignment" });
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || String(id) !== String(req.params.id).trim()) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const [entry] = await service.getDirectoryEntries({ companyId: scope.companyId, canSeePhone: false, id });
      if (!entry) return res.status(404).json({ error: "Employee not found" });
      return res.json({ ...entry, directory_view: true });
    }
    const emp = await service.getEmployeeById(req.params.id, callerRole, isSelf);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const companyId = companyOf(req);
    if (companyId != null && emp.company_id !== companyId) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json(await maskForCaller(req, emp));
  } catch (err) {
    respondError(res, err);
  }
};

export const getNextEmployeeCode = async (req, res) => {
  try {
    // companyOf(req), not unscoped: the numbering is per company. Unscoped, this
    // read the globally-last employees row — which on live data belonged to
    // another tenant and carried a NULL office_id, so the endpoint suggested
    // 'EMP001', a code company 1's employee id=1 already held.
    const code = await service.getNextEmployeeCode(companyOf(req));
    res.json({ code });
  } catch (err) {
    respondError(res, err);
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const oldEmp = await service.getEmployeeRecord(req.params.id);
    if (!oldEmp) return res.status(404).json({ error: 'Employee not found' });
    if (companyId != null && oldEmp.company_id !== companyId)
      return res.status(404).json({ error: 'Employee not found' });
    if (SALARY_WRITE_KEYS.some(k => k in (req.body || {})) && !(await can(req, "payroll", "edit"))) {
      return res.status(403).json({ code: "SALARY_PERMISSION", error: "Correcting the salary needs payroll edit permission. Nothing was saved — leave the salary unchanged, or ask Payroll to correct it in Salary Structures." });
    }
    // Bank account, IFSC and address are mandatory: an edit may not CLEAR one
    // that is on record. A record that never had one stays editable (the
    // readiness checkpoints list it), so unrelated edits are not blocked.
    req.body = normaliseBank(req.body);
    const cleared = REQUIRED_BANK_ON_CREATE
      .filter(([k]) => k in (req.body || {}) && !String(req.body[k] ?? "").trim() && String(oldEmp[k] ?? "").trim())
      .map(([, l]) => l);
    if (cleared.length) {
      return res.status(400).json({ code: "REQUIRED_FIELDS", error: `${cleared.join(", ")} cannot be cleared — required for payroll payment.`, missing: cleared });
    }
    const changedBank = bankChanges(req.body, oldEmp);
    if (changedBank.length) {
      if (!(await canProposeBank(req))) {
        return res.status(403).json({ code: "BANK_DETAILS_PERMISSION", error: "Changing bank details needs the HR bank-details permission. Nothing was saved — undo the bank change, or ask an HR manager to make it." });
      }
      const formatErrors = bankFormatErrors(req.body);
      if (formatErrors.length) return res.status(400).json({ code: "BANK_DETAILS_INVALID", error: formatErrors.join("; ") });
      // One pending change at a time — refused before anything else is saved.
      if (await bankChange.pendingFor(oldEmp.id)) {
        return res.status(409).json({ code: "BANK_CHANGE_PENDING", error: "A bank-detail change for this employee is already awaiting approval. Nothing was saved — approve, reject or withdraw it first (HR → Bank Detail Approvals)." });
      }
    }
    const fileFields = await processUploadedFiles(req.files);
    // Bank keys never reach the row here: a change becomes a pending request.
    const { salary_correction: salaryCorrection, ...emp } =
      await service.updateEmployee(req.params.id, { ...withoutBankKeys(req.body), ...fileFields }, companyId);
    // A salary correction rewrites a revision in place, so the before/after
    // figures have to be on record somewhere — this entry is that record.
    if (salaryCorrection) {
      logAudit({
        userId: req.user?.id,
        module: 'employees',
        recordId: salaryCorrection.after?.id,
        recordType: 'salary_revision',
        action: salaryCorrection.before ? 'update' : 'create',
        oldData: salaryCorrection.before,
        newData: { ...salaryCorrection.after, employee_id: Number(req.params.id) },
      });
    }
    logAudit({
      userId: req.user?.id,
      module: 'employees',
      recordId: req.params.id,
      recordType: 'employee',
      action: 'update',
      oldData: oldEmp,
      newData: emp,
    });
    let bankRequest = null;
    if (changedBank.length) {
      try {
        bankRequest = await bankChange.propose({
          employeeId: oldEmp.id, companyId: oldEmp.company_id, current: oldEmp,
          changes: pickBank(req.body, changedBank), requestedBy: req.user?.userId ?? req.user?.id ?? null, source: "edit",
        });
        // Which fields changed and who proposed them; values are masked by logAudit.
        logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'employees', recordId: req.params.id, recordType: 'employee_bank_details',
          action: 'propose', newData: { request_id: bankRequest.id, fields_changed: changedBank } });
      } catch (e) {
        bankRequest = { status: "failed", error: e.message };
      }
    }
    res.json({ ...(await maskForCaller(req, emp)), ...(bankRequest ? { bank_change_request: bankRequest } : {}) });
  } catch (err) {
    respondError(res, err);
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const oldEmp = await service.getEmployeeRecord(req.params.id);
    if (!oldEmp) return res.status(404).json({ error: 'Employee not found' });
    if (companyId != null && oldEmp.company_id !== companyId)
      return res.status(404).json({ error: 'Employee not found' });
    await service.deleteEmployee(req.params.id, companyId);
    logAudit({ userId: req.user?.id, module: 'employees', recordId: req.params.id, recordType: 'employee', action: 'delete', oldData: oldEmp });
    res.json({ message: "Deleted" });
  } catch (err) {
    respondError(res, err);
  }
};

export const getEmployeeAnalytics = async (req, res) => {
  try {
    // A malformed from/to must be a 400, not a 500 from Postgres' date parser.
    // resolveRange would silently fall back to the default period, which is
    // worse: the page would render a window the user did not ask for and say
    // nothing about it.
    const bad = assertDateParams(req.query, ['from', 'to', 'fy_start', 'fy_end']);
    if (bad) return res.status(bad.status).json(bad.body);

    const { period, from, to, fy_start, fy_end, department } = req.query;
    const data = await service.getEmployeeAnalytics({
      period,
      from,
      to,
      // Legacy spelling, still sent by anything that predates the shared
      // period vocabulary.
      fy_start,
      fy_end,
      department,
      company_id: companyOf(req),
    });
    res.json(data);
  } catch (err) {
    respondError(res, err);
  }
};

export const getExEmployees = async (req, res) => {
  try {
    const { exit_date_from, exit_date_to } = req.query;
    const data = await service.getExEmployees({
      exit_date_from,
      exit_date_to,
      company_id: companyOf(req),
      callerRole: rolesOf(req),
    });
    res.json(await withSalaryMasking(req, data));
  } catch (err) {
    respondError(res, err);
  }
};

// ── Bank-detail change requests (maker-checker, §204) ───────────────────────
const bankErr = (res, err) => (err instanceof bankChange.BankChangeError
  ? res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) })
  : respondError(res, err));

/** GET /employees/bank-change-requests?status=pending|approved|rejected|withdrawn|all */
export const listBankChangeRequests = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: "Company context required" });
    if (!(await canProposeBank(req))) return res.status(403).json({ error: "Bank-detail approvals need the HR bank-details permission" });
    const status = String(req.query.status || "pending");
    if (!["pending", "approved", "rejected", "withdrawn", "all"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const uid = req.user?.userId ?? req.user?.id ?? null;
    const reviewer = await can(req, "employee_bank", "edit");
    // A propose-only holder (employee_bank:add without :edit) sees ONLY the
    // requests it made, numbers masked, with no decision actions (§206).
    const rows = await bankChange.list({
      companyId, status,
      showFull: reviewer && await can(req, "employee_bank", "view"),
      onlyRequestedBy: reviewer ? null : uid,
    });
    res.json(rows.map(r => ({
      ...r,
      can_decide: reviewer && r.status === "pending" && Number(r.requested_by) !== Number(uid),
      can_withdraw: r.status === "pending" && (reviewer || Number(r.requested_by) === Number(uid)),
    })));
  } catch (err) { bankErr(res, err); }
};

/** POST /employees/bank-change-requests/:id/approve — a different HR reviewer; then Accounts is told. */
export const approveBankChangeRequest = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: "Company context required" });
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: "Invalid request id" });
    if (!(await can(req, "employee_bank", "edit"))) return res.status(403).json({ error: "Approving bank details needs the HR bank-details permission" });
    const uid = req.user?.userId ?? req.user?.id ?? null;
    const { request, employee } = await bankChange.approve({ id: Number(req.params.id), companyId, reviewerUserId: uid });
    logAudit({ userId: uid, module: 'employees', recordId: employee.id, recordType: 'employee_bank_details', action: 'approve',
      newData: { request_id: request.id, fields_changed: request.fields_changed, requested_by: request.requested_by, verified_by: uid } });
    await notifyAccountsOfBankChange(req, employee, { verifiedOnly: request.source === "verify" });
    res.json({ id: request.id, status: "approved", employee_id: employee.id, source: request.source });
  } catch (err) { bankErr(res, err); }
};

/** POST /employees/bank-change-requests/:id/reject {reason} — reviewer, not the maker. */
export const rejectBankChangeRequest = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: "Company context required" });
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: "Invalid request id" });
    const uid = req.user?.userId ?? req.user?.id ?? null;
    const r = await bankChange.close({ id: Number(req.params.id), companyId, userId: uid, status: "rejected",
      reason: req.body?.reason, isReviewer: await can(req, "employee_bank", "edit") });
    logAudit({ userId: uid, module: 'employees', recordId: r.employee_id, recordType: 'employee_bank_details', action: 'reject',
      newData: { request_id: r.id, reason: req.body?.reason ?? null } });
    res.json({ id: r.id, status: "rejected" });
  } catch (err) { bankErr(res, err); }
};

/** POST /employees/bank-change-requests/:id/withdraw — the maker, or a reviewer. */
export const withdrawBankChangeRequest = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: "Company context required" });
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: "Invalid request id" });
    if (!(await canProposeBank(req))) return res.status(403).json({ error: "Bank-detail changes need the HR bank-details permission" });
    const uid = req.user?.userId ?? req.user?.id ?? null;
    const r = await bankChange.close({ id: Number(req.params.id), companyId, userId: uid, status: "withdrawn",
      reason: req.body?.reason, isReviewer: await can(req, "employee_bank", "edit") });
    logAudit({ userId: uid, module: 'employees', recordId: r.employee_id, recordType: 'employee_bank_details', action: 'withdraw',
      newData: { request_id: r.id } });
    res.json({ id: r.id, status: "withdrawn" });
  } catch (err) { bankErr(res, err); }
};

/** POST /employees/:id/bank-verification-request — "verify as-is" (§206): the
 *  details already on record go to a second HR person unchanged. Same grant
 *  as proposing a change; the details must be valid and not yet verified. */
export const requestBankVerification = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) return res.status(400).json({ error: "Company context required" });
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: "Invalid employee id" });
    if (!(await canProposeBank(req))) return res.status(403).json({ error: "Requesting verification needs the HR bank-details permission" });
    const uid = req.user?.userId ?? req.user?.id ?? null;
    const r = await bankChange.requestVerification({ employeeId: Number(req.params.id), companyId, requestedBy: uid });
    logAudit({ userId: uid, module: 'employees', recordId: req.params.id, recordType: 'employee_bank_details', action: 'request_verification',
      newData: { request_id: r.id } });
    res.status(201).json({ bank_change_request: r });
  } catch (err) { bankErr(res, err); }
};
