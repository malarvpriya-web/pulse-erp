import * as service from "./employee.service.js";
import { uploadFile } from "../services/StorageService.js";
import { logAudit } from "../services/AuditService.js";

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
      company_id: req.scope?.company_id ?? null,
    });
    // Keep the auto-created login's temporary password out of the audit trail.
    const empRecord = { ...emp };
    delete empRecord.login;
    logAudit({ userId: req.user?.id, module: 'employees', recordId: emp.id, recordType: 'employee', action: 'create', newData: empRecord });
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getEmployees = async (req, res) => {
  try {
    const employees = await service.getEmployees({
      ...(req.query || {}),
      company_id: req.scope?.company_id ?? null,
      callerRole: req.user?.role,
    });
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getEmployee = async (req, res) => {
  try {
    const callerRole = req.user?.role;
    const isSelf = String(req.user?.employee_id) === String(req.params.id);
    const emp = await service.getEmployeeById(req.params.id, callerRole, isSelf);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    if (req.scope?.company_id != null && emp.company_id !== req.scope.company_id) {
      return res.status(404).json({ error: "Employee not found" });
    }
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getNextEmployeeCode = async (req, res) => {
  try {
    const code = await service.getNextEmployeeCode();
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const oldEmp = await service.getEmployeeById(req.params.id);
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
    res.status(500).json({ error: err.message });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const oldEmp = await service.getEmployeeById(req.params.id);
    if (!oldEmp) return res.status(404).json({ error: 'Employee not found' });
    if (companyId != null && oldEmp.company_id !== companyId)
      return res.status(404).json({ error: 'Employee not found' });
    await service.deleteEmployee(req.params.id, companyId);
    logAudit({ userId: req.user?.id, module: 'employees', recordId: req.params.id, recordType: 'employee', action: 'delete', oldData: oldEmp });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getEmployeeAnalytics = async (req, res) => {
  try {
    const { fy_start, fy_end } = req.query;
    const data = await service.getEmployeeAnalytics({
      fy_start,
      fy_end,
      company_id: req.scope?.company_id ?? null,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getExEmployees = async (req, res) => {
  try {
    const { exit_date_from, exit_date_to } = req.query;
    const data = await service.getExEmployees({
      exit_date_from,
      exit_date_to,
      company_id: req.scope?.company_id ?? null,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
