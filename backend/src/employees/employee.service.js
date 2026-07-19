import pool from "../config/db.js";
import bcrypt from "bcryptjs";
import { validatePAN } from "../utils/gst.js";
import { syncPrimaryRole } from "../services/userRoles.js";

// Initial password every auto-created employee login gets. Employees should
// change it after their first sign-in. Overridable per-deployment via env.
const DEFAULT_EMPLOYEE_PASSWORD = process.env.DEFAULT_EMPLOYEE_PASSWORD || "Welcome@123";

function toIntOrNull(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/**
 * Creates a login account (users row) for a freshly-added employee so they can
 * sign in with their company email. Runs inside the caller's transaction.
 * Skips silently if the employee has no company_email or an account already
 * exists for that email. Returns the login descriptor (or null when skipped).
 */
async function createEmployeeLogin(client, emp) {
  const email = (emp.company_email || "").trim();
  if (!email) return null;

  const { rows: existing } = await client.query(
    "SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email]
  );
  if (existing.length) return null; // don't clobber an existing account

  const name = `${emp.first_name || ""} ${emp.last_name || ""}`.trim() || email;
  const hash = await bcrypt.hash(DEFAULT_EMPLOYEE_PASSWORD, 10);

  const { rows: [user] } = await client.query(
    `INSERT INTO users (name, email, password_hash, role, department, is_active, company_id, employee_id, must_change_password)
     VALUES ($1, $2, $3, 'employee', $4, true, $5, $6, true)
     RETURNING id`,
    [name, email, hash, emp.department || null, emp.company_id ?? null, emp.id]
  );

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

  return { email, password: DEFAULT_EMPLOYEE_PASSWORD, created: true };
}

function computeNextCode(lastCode) {
  if (!lastCode || !lastCode.startsWith("EMP")) return "EMP001";
  const n = parseInt(lastCode.substring(3), 10);
  return `EMP${String(n + 1).padStart(3, "0")}`;
}

export const addEmployee = async (data) => {
  if (!data) {
    throw new Error("Request body is empty");
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
  } = data;

  if (!first_name || !company_email) {
    throw new Error("First name and company email are required");
  }

  // Validate PAN format when provided (5 letters, 4 digits, 1 letter). Empty is allowed.
  if (pan_number && String(pan_number).trim() && !validatePAN(pan_number)) {
    throw Object.assign(new Error("Invalid PAN format. Expected 10 characters, e.g. ABCDE1234F."), { status: 400 });
  }

  await validateMasterValue(department, 'master_departments');
  await validateMasterValue(designation, 'master_designations');
  await validateMasterValue(grade, 'master_grades');
  await validateMasterValue(band, 'master_bands');

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Advisory lock serialises all concurrent addEmployee calls so no two
    // transactions can race to claim the same office_id — whether auto-generated
    // or caller-supplied.
    await client.query("SELECT pg_advisory_xact_lock(88001)");
    let office_id = providedOfficeId;
    if (!office_id) {
      const codeRes = await client.query(
        "SELECT office_id FROM employees ORDER BY id DESC LIMIT 1"
      );
      office_id = computeNextCode(codeRes.rows[0]?.office_id);
    } else {
      const dupeCheck = await client.query(
        "SELECT 1 FROM employees WHERE LOWER(office_id) = LOWER($1)",
        [office_id]
      );
      if (dupeCheck.rows.length > 0) {
        throw new Error(`Employee code ${office_id} is already in use`);
      }
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
        is_field_employee
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43,
        $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57,
        $58, $59, $60, $61, $62, $63, $64, $65, $66
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
      reporting_manager || "",
      toIntOrNull(reporting_manager_id),
      location || "",
      joining_date || null,
      employment_type || "",
      skill_type || "",
      zone || "",
      status || 'Active',
      previous_company_1 || "",
      previous_role_1 || "",
      previous_years_1 || 0,
      previous_company_2 || "",
      previous_role_2 || "",
      previous_years_2 || 0,
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
      photo_file || null,
      pan_file || null,
      aadhaar_file || null,
      cancelled_cheque_file || null,
      bank_statement_file || null,
      resume_file || null,
      offer_letter_file || null,
      company_id ?? null,
      // auto-compute 90-day probation end date from joining_date
      joining_date
        ? new Date(new Date(joining_date).getTime() + 90 * 86400000).toISOString().slice(0, 10)
        : null,
      grade || null,
      band || null,
      toIntOrNull(branch_id),
      passport_number || null,
      driving_license_number || null,
      toIntOrNull(notice_period_days),
      is_field_employee === true || is_field_employee === 'true',
    ];

    const result = await client.query(query, values);
    const emp = result.rows[0];

    // Auto-provision a login account so the employee can sign in with their
    // company email. Kept in the same transaction so an employee is never left
    // without a usable login.
    const login = await createEmployeeLogin(client, emp);

    await client.query("COMMIT");
    return login ? { ...emp, login } : emp;
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Failed to add employee: ${err.message}`);
  } finally {
    client.release();
  }
};

const HR_PII_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'HR', 'Admin', 'SuperAdmin'];

const SALARY_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin',
                      'finance_manager', 'HR', 'Admin', 'SuperAdmin'];

function maskPII(emp, role, isSelf = false) {
  if (!emp) return emp;
  if (isSelf) return emp;
  if (HR_PII_ROLES.includes(role)) return emp;
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
  if (!SALARY_ROLES.includes(role)) {
    delete out.basic_salary;
    delete out.bank_name;
    delete out.branch_name;
    delete out.account_number;
    delete out.ifsc_code;
    delete out.nominee_name;
    delete out.pf_number;
    delete out.uan_number;
    delete out.esic_number;
  }
  return out;
}

export const getEmployeeById = async (id, callerRole, isSelf = false) => {
  const { rows } = await pool.query(`SELECT * FROM employees WHERE id = $1`, [id]);
  return maskPII(rows[0] || null, callerRole, isSelf);
};

// Validates that dept/designation exists in master table IF the master has been configured.
// Silently passes when: master table is empty, table doesn't exist, or DB query fails.
async function validateMasterValue(value, table) {
  if (!value) return;
  const needle = String(value).trim().toLowerCase();
  if (!needle) return;
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
      const { rows: empRows } = await pool.query(
        `SELECT 1 FROM employees WHERE LOWER(TRIM(COALESCE(${empCol},''))) = $1 LIMIT 1`,
        [needle]
      );
      if (empRows.length > 0) return;
    }

    throw new Error(`"${value}" is not a valid ${table.replace('master_', '')}. Select a value from the master list.`);
  } catch (err) {
    if (err.message?.includes('is not a valid')) throw err; // re-throw our own validation errors
    // DB / table-not-found / mock errors — skip validation silently
  }
}

export const getEmployees = async ({ status, department, designation, employment_type, company_id, callerRole, page, limit } = {}) => {
  const conditions = [];
  const values = [];
  let i = 1;

  if (company_id != null) {
    values.push(company_id);
    conditions.push(`company_id = $${i++}`);
  }

  if (status) {
    const statusLower = String(status).trim().toLowerCase();
    if (statusLower === 'all') {
      // Explicit "all" — no status filter; return every employee regardless of status
    } else if (statusLower === "probation") {
      // For probation, include either explicit status or contract/employment type.
      values.push(statusLower);
      values.push(statusLower);
      conditions.push(
        `(LOWER(COALESCE(status,'')) = $${i++} OR LOWER(COALESCE(employment_type,'')) = $${i++})` +
        ` AND LOWER(COALESCE(status,'')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period','notice period')`
      );
    } else {
      values.push(statusLower);
      conditions.push(`LOWER(COALESCE(status,'')) = $${i++}`);
    }
  } else {
    // BUG 2 fix: default to active employees — exclude ex-employees from all non-scoped queries
    conditions.push(`LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period','notice period')`);
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
  // Strip salary/bank fields for non-salary roles on bulk list
  if (!SALARY_ROLES.includes(callerRole)) {
    return result.rows.map(emp => {
      const out = { ...emp };
      delete out.basic_salary;
      delete out.bank_name;
      delete out.branch_name;
      delete out.account_number;
      delete out.ifsc_code;
      delete out.nominee_name;
      delete out.pf_number;
      delete out.uan_number;
      delete out.esic_number;
      return out;
    });
  }
  return result.rows;
};

const EX_STATUSES = `LOWER(e.status) IN ('left','terminated','resigned','inactive','ex-employee','notice_period','notice period')`;

export const getExEmployees = async ({ exit_date_from, exit_date_to, company_id } = {}) => {
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

  return rows;
};

export const getNextEmployeeCode = async () => {
  const result = await pool.query("SELECT office_id FROM employees ORDER BY id DESC LIMIT 1");
  return computeNextCode(result.rows[0]?.office_id);
};

export const updateEmployee = async (id, data, company_id = null) => {
  if (!data) {
    throw new Error("Request body is empty");
  }

  if (data.department)  await validateMasterValue(data.department, 'master_departments');
  if (data.designation) await validateMasterValue(data.designation, 'master_designations');
  if (data.grade)       await validateMasterValue(data.grade, 'master_grades');
  if (data.band)        await validateMasterValue(data.band, 'master_bands');

  // If only status is being updated
  if (Object.keys(data).length === 1 && data.status) {
    try {
      const result = await pool.query(
        `UPDATE employees SET status = $1 WHERE id = $2 RETURNING *`,
        [data.status, id]
      );
      if (result.rows.length === 0) {
        throw new Error("Employee not found with ID: " + id);
      }
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to update status: ${err.message}`);
    }
  }

  // Extract all possible fields
  const {
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
    exit_date,
    exit_reason,
  } = data;

  try {
    const query = `
      UPDATE employees
      SET
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        company_email = COALESCE($3, company_email),
        personal_email = COALESCE($4, personal_email),
        phone = COALESCE($5, phone),
        company_phone = COALESCE($6, company_phone),
        gender = COALESCE($7, gender),
        blood_group = COALESCE($8, blood_group),
        dob = COALESCE($9, dob),
        marital_status = COALESCE($10, marital_status),
        father_name = COALESCE($11, father_name),
        mother_name = COALESCE($12, mother_name),
        spouse_name = COALESCE($13, spouse_name),
        anniversary_date = COALESCE($14, anniversary_date),
        current_address = COALESCE($15, current_address),
        permanent_address = COALESCE($16, permanent_address),
        highest_qualification = COALESCE($17, highest_qualification),
        basic_qualification = COALESCE($18, basic_qualification),
        department = COALESCE($19, department),
        designation = COALESCE($20, designation),
        employee_role = COALESCE($21, employee_role),
        reporting_manager = COALESCE($22, reporting_manager),
        reporting_manager_id = COALESCE($23, reporting_manager_id),
        location = COALESCE($24, location),
        joining_date = COALESCE($25, joining_date),
        employment_type = COALESCE($26, employment_type),
        skill_type = COALESCE($27, skill_type),
        zone = COALESCE($28, zone),
        status = COALESCE($29, status),
        previous_company_1 = COALESCE($30, previous_company_1),
        previous_role_1 = COALESCE($31, previous_role_1),
        previous_years_1 = COALESCE($32, previous_years_1),
        previous_company_2 = COALESCE($33, previous_company_2),
        previous_role_2 = COALESCE($34, previous_role_2),
        previous_years_2 = COALESCE($35, previous_years_2),
        bank_name = COALESCE($36, bank_name),
        branch_name = COALESCE($37, branch_name),
        account_number = COALESCE($38, account_number),
        ifsc_code = COALESCE($39, ifsc_code),
        nominee_name = COALESCE($40, nominee_name),
        emergency_name = COALESCE($41, emergency_name),
        emergency_phone = COALESCE($42, emergency_phone),
        emergency_relationship = COALESCE($43, emergency_relationship),
        pan_number = COALESCE($44, pan_number),
        aadhaar_number = COALESCE($45, aadhaar_number),
        pf_number = COALESCE($46, pf_number),
        uan_number = COALESCE($47, uan_number),
        esic_number = COALESCE($48, esic_number),
        notes = COALESCE($49, notes),
        photo_url = COALESCE($50, photo_url),
        pan_file = COALESCE($51, pan_file),
        aadhaar_file = COALESCE($52, aadhaar_file),
        cancelled_cheque_file = COALESCE($53, cancelled_cheque_file),
        bank_statement_file = COALESCE($54, bank_statement_file),
        resume_file = COALESCE($55, resume_file),
        offer_letter_file = COALESCE($56, offer_letter_file),
        exit_date = COALESCE($57, exit_date),
        exit_reason = COALESCE($58, exit_reason),
        is_field_employee = COALESCE($59, is_field_employee)
      WHERE id = $60
        ${company_id != null ? 'AND company_id = $61' : ''}
      RETURNING *;
    `;

    const values = [
      first_name || null,
      last_name || null,
      company_email || null,
      personal_email || null,
      phone || null,
      company_phone || null,
      gender || null,
      blood_group || null,
      dob || null,
      marital_status || null,
      father_name || null,
      mother_name || null,
      spouse_name || null,
      anniversary_date || null,
      current_address || null,
      permanent_address || null,
      highest_qualification || null,
      basic_qualification || null,
      department || null,
      designation || null,
      employee_role || null,
      reporting_manager || null,
      toIntOrNull(reporting_manager_id),
      location || null,
      joining_date || null,
      employment_type || null,
      skill_type || null,
      zone || null,
      status || null,
      previous_company_1 || null,
      previous_role_1 || null,
      previous_years_1 || null,
      previous_company_2 || null,
      previous_role_2 || null,
      previous_years_2 || null,
      bank_name || null,
      branch_name || null,
      account_number || null,
      ifsc_code || null,
      nominee_name || null,
      emergency_name || null,
      emergency_phone || null,
      emergency_relationship || null,
      pan_number || null,
      aadhaar_number || null,
      pf_number || null,
      uan_number || null,
      esic_number || null,
      notes || null,
      photo_file || null,
      pan_file || null,
      aadhaar_file || null,
      cancelled_cheque_file || null,
      bank_statement_file || null,
      resume_file || null,
      offer_letter_file || null,
      exit_date || null,
      exit_reason || null,
      is_field_employee === undefined || is_field_employee === null
        ? null
        : (is_field_employee === true || is_field_employee === 'true'),
      id,
    ];
    if (company_id != null) values.push(company_id);

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      throw new Error("Employee not found");
    }
    return result.rows[0];
  } catch (err) {
    throw new Error(`Failed to update employee: ${err.message}`);
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

export const getEmployeeAnalytics = async ({ fy_start, fy_end, company_id } = {}) => {
  // Scope filter — applied to every query on the employees table.
  // When company_id is null (single-tenant), no filter is added.
  const hasCid = company_id != null;
  const cidPar = hasCid ? [company_id] : [];
  const cidWhere = hasCid ? `WHERE company_id = $1` : ``;
  const cidAnd   = hasCid ? `AND company_id = $1`  : ``;

  // Summary counts
  const summaryRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE LOWER(status) IN ('active', 'probation'))        AS total,
      COUNT(*) FILTER (WHERE LOWER(status) = 'active')                        AS active,
      COUNT(*) FILTER (WHERE LOWER(status) IN ('left','inactive','terminated','resigned','ex-employee')) AS left_count,
      COUNT(*) FILTER (WHERE LOWER(status) = 'probation')                     AS probation,
      ROUND(AVG(
        EXTRACT(YEAR FROM AGE(NOW(), joining_date))
        + EXTRACT(MONTH FROM AGE(NOW(), joining_date)) / 12.0
      ) FILTER (WHERE joining_date IS NOT NULL
             AND LOWER(status) IN ('active', 'probation')), 1)                AS avg_tenure
    FROM employees ${cidWhere}
  `, cidPar);
  const row = summaryRes.rows[0];
  const summary = {
    total:     parseInt(row.total) || 0,
    active:    parseInt(row.active) || 0,
    left:      parseInt(row.left_count) || 0,
    probation: parseInt(row.probation) || 0,
    avgTenure: parseFloat(row.avg_tenure) || 0,
  };

  // Status breakdown — group raw statuses into 3 logical buckets for the donut chart
  const statusRes = await pool.query(`
    SELECT
      CASE
        WHEN LOWER(status) = 'active'                                        THEN 'Active'
        WHEN LOWER(status) = 'probation'                                     THEN 'Probation'
        WHEN LOWER(status) IN ('left','inactive','terminated','resigned','ex-employee') THEN 'Left'
        ELSE 'Other'
      END AS status,
      COUNT(*) AS count
    FROM employees ${cidWhere}
    GROUP BY 1
    ORDER BY count DESC
  `, cidPar);
  const statusBreakdown = statusRes.rows.map(r => ({ status: r.status, count: parseInt(r.count) }));

  // Gender breakdown — current employees only
  const genderRes = await pool.query(`
    SELECT COALESCE(NULLIF(gender,''), 'Not specified') AS gender, COUNT(*) AS count
    FROM employees
    WHERE LOWER(status) IN ('active', 'probation') ${cidAnd}
    GROUP BY gender ORDER BY count DESC
  `, cidPar);
  const genderBreakdown = genderRes.rows.map(r => ({ gender: r.gender, count: parseInt(r.count) }));

  // Skill type breakdown — current employees only
  const skillRes = await pool.query(`
    SELECT COALESCE(NULLIF(skill_type,''), 'Not specified') AS skill, COUNT(*) AS count
    FROM employees
    WHERE LOWER(status) IN ('active', 'probation') ${cidAnd}
    GROUP BY skill_type ORDER BY count DESC
  `, cidPar);
  const skillBreakdown = skillRes.rows.map(r => ({ skill: r.skill, count: parseInt(r.count) }));

  // Tenure buckets — current employees only
  const tenureRes = await pool.query(`
    SELECT
      CASE
        WHEN EXTRACT(YEAR FROM AGE(NOW(), joining_date)) < 1  THEN '0–1 yr'
        WHEN EXTRACT(YEAR FROM AGE(NOW(), joining_date)) < 3  THEN '1–3 yrs'
        WHEN EXTRACT(YEAR FROM AGE(NOW(), joining_date)) < 5  THEN '3–5 yrs'
        WHEN EXTRACT(YEAR FROM AGE(NOW(), joining_date)) < 10 THEN '5–10 yrs'
        ELSE '10+ yrs'
      END AS bucket,
      COUNT(*) AS count
    FROM employees
    WHERE joining_date IS NOT NULL
      AND LOWER(status) IN ('active', 'probation') ${cidAnd}
    GROUP BY bucket
    ORDER BY MIN(joining_date)
  `, cidPar);
  const bucketOrder = ['0–1 yr','1–3 yrs','3–5 yrs','5–10 yrs','10+ yrs'];
  const tenureMap = {};
  tenureRes.rows.forEach(r => { tenureMap[r.bucket] = parseInt(r.count); });
  const tenureGroups = bucketOrder.map(b => ({ bucket: b, count: tenureMap[b] || 0 }));

  // Department breakdown
  const deptRes = await pool.query(`
    SELECT
      COALESCE(NULLIF(department,''), 'Unassigned') AS department,
      COUNT(*)                                            AS count,
      COUNT(*) FILTER (WHERE LOWER(status) = 'active')  AS active
    FROM employees
    WHERE LOWER(status) IN ('active', 'probation') ${cidAnd}
    GROUP BY department ORDER BY count DESC LIMIT 12
  `, cidPar);
  const deptBreakdown = deptRes.rows.map(r => ({
    department: r.department,
    count:  parseInt(r.count),
    active: parseInt(r.active),
  }));

  // New hires — scoped to FY if provided, else last 12 months
  const hiresStart = fy_start || null;
  const hiresEnd   = fy_end   || null;
  let hiresRes;
  if (hiresStart && hiresEnd) {
    const hiresParams = [hiresStart, hiresEnd, ...(hasCid ? [company_id] : [])];
    const hiresCid    = hasCid ? `AND company_id = $3` : '';
    hiresRes = await pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', joining_date), 'Mon YY') AS month,
               COUNT(*) AS hires
        FROM employees
        WHERE joining_date >= $1::date AND joining_date <= $2::date ${hiresCid}
        GROUP BY DATE_TRUNC('month', joining_date)
        ORDER BY DATE_TRUNC('month', joining_date)
      `, hiresParams);
  } else {
    hiresRes = await pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', joining_date), 'Mon YY') AS month,
               COUNT(*) AS hires
        FROM employees
        WHERE joining_date >= NOW() - INTERVAL '12 months' ${cidAnd}
        GROUP BY DATE_TRUNC('month', joining_date)
        ORDER BY DATE_TRUNC('month', joining_date)
      `, cidPar);
  }
  const newHiresMonthly = hiresRes.rows.map(r => ({ month: r.month, hires: parseInt(r.hires) }));

  // Exits by month — employees who left in the last 12 months
  // Uses exit_date when present, falls back to updated_at for older records
  const exitsRes = await pool.query(`
    SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(exit_date, updated_at)), 'Mon YY') AS month,
           COUNT(*) AS exits
    FROM employees
    WHERE LOWER(status) IN ('left','inactive','terminated','resigned','ex-employee')
      AND COALESCE(exit_date, updated_at) >= NOW() - INTERVAL '12 months'
      ${cidAnd}
    GROUP BY DATE_TRUNC('month', COALESCE(exit_date, updated_at))
    ORDER BY DATE_TRUNC('month', COALESCE(exit_date, updated_at))
  `, cidPar);
  const attritionMonthly = exitsRes.rows.map(r => ({ month: r.month, exits: parseInt(r.exits) }));

  return {
    summary,
    statusBreakdown,
    genderBreakdown,
    skillBreakdown,
    tenureGroups,
    deptBreakdown,
    newHiresMonthly,
    attritionMonthly,
  };
};
