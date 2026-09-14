import * as service from "./employee.service.js";
import { uploadFile } from "../services/StorageService.js";
import { logAudit } from "../services/AuditService.js";
import { rolesOf } from "../middlewares/auth.middleware.js";
import { companyOf } from "../shared/scope.js";
// respondError classifies the error instead of blanket-500ing it: an explicit
// err.statusCode wins, and Postgres constraint violations map to 4xx. Rejecting
// a value that isn't in the master is the caller's mistake, not a server fault.
import { respondError } from "../shared/pgErrors.js";

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

export const addEmployee = async (req, res) => {
  try {
    const fileFields = await processUploadedFiles(req.files);
    const emp = await service.addEmployee({
      ...req.body,
      ...fileFields,
      company_id: companyOf(req),
    });
    // Keep the auto-created login's temporary password out of the audit trail.
    const empRecord = { ...emp };
    delete empRecord.login;
    logAudit({ userId: req.user?.id, module: 'employees', recordId: emp.id, recordType: 'employee', action: 'create', newData: empRecord });
    res.json(emp);
  } catch (err) {
    respondError(res, err);
  }
};

export const getEmployees = async (req, res) => {
  try {
    const employees = await service.getEmployees({
      ...(req.query || {}),
      company_id: companyOf(req),
      // rolesOf(), not req.user.role: roles are many-to-many, so gating on the
      // primary claim alone hides fields from someone whose HR grant is a
      // secondary role. callerEmployeeId keeps the caller's OWN row unmasked,
      // matching what GET /employees/:id already does for self.
      callerRole: rolesOf(req),
      callerEmployeeId: req.user?.employee_id ?? null,
    });
    res.json(employees);
  } catch (err) {
    respondError(res, err);
  }
};

export const getEmployee = async (req, res) => {
  try {
    const callerRole = rolesOf(req);
    const isSelf = req.user?.employee_id != null &&
                   String(req.user.employee_id) === String(req.params.id);
    const emp = await service.getEmployeeById(req.params.id, callerRole, isSelf);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const companyId = companyOf(req);
    if (companyId != null && emp.company_id !== companyId) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json(emp);
  } catch (err) {
    respondError(res, err);
  }
};

export const getNextEmployeeCode = async (req, res) => {
  try {
    const code = await service.getNextEmployeeCode();
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
    const fileFields = await processUploadedFiles(req.files);
    const emp = await service.updateEmployee(req.params.id, { ...req.body, ...fileFields }, companyId);
    logAudit({
      userId: req.user?.id,
      module: 'employees',
      recordId: req.params.id,
      recordType: 'employee',
      action: 'update',
      oldData: oldEmp,
      newData: emp,
    });
    res.json(emp);
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
    const { fy_start, fy_end } = req.query;
    const data = await service.getEmployeeAnalytics({
      fy_start,
      fy_end,
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
    res.json(data);
  } catch (err) {
    respondError(res, err);
  }
};
