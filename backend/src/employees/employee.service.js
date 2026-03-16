import pool from "../config/db.js";

export const addEmployee = async (data) => {
  console.log("📥 addEmployee service received:");
  console.log("   Data type:", typeof data);
  console.log("   Data keys:", data ? Object.keys(data).slice(0, 20) : "NO DATA");
  console.log("   employee_code value:", data.employee_code);
  console.log("   notes value:", data.notes);
  
  if (!data) {
    throw new Error("Request body is empty");
  }

  // Extract only the fields that are being sent
  const {
    office_id,
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
    location,
    joining_date,
    employment_type,
    skill_type,
    zone,
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
    permissions,
    photo_file,
    pan_file,
    aadhaar_file,
    cancelled_cheque_file,
    bank_statement_file,
    resume_file,
    offer_letter_file
  } = data;

  const perms = permissions ? JSON.parse(permissions) : {};

  if (!first_name || !company_email) {
    throw new Error("First name and company email are required");
  }

  try {
    console.log("✅ Attempting insert...");
    const query = `
      INSERT INTO employees (
        office_id, first_name, last_name, company_email, personal_email,
        phone, company_phone, gender, blood_group, dob, marital_status, 
        father_name, mother_name, spouse_name, anniversary_date,
        current_address, permanent_address, highest_qualification, basic_qualification,
        department, designation, employee_role, reporting_manager, location, joining_date,
        employment_type, skill_type, zone, status, 
        previous_company_1, previous_role_1, previous_years_1, 
        previous_company_2, previous_role_2, previous_years_2,
        bank_name, branch_name, account_number, ifsc_code, nominee_name,
        emergency_name, emergency_phone, emergency_relationship,
        pan_number, aadhaar_number, pf_number, uan_number, esic_number, notes,
        photo_url, pan_file, aadhaar_file, cancelled_cheque_file, 
        bank_statement_file, resume_file, offer_letter_file,
        employee_view, employee_add, employee_edit, employee_delete,
        finance_view, finance_edit, finance_approve,
        project_view, project_add, project_edit,
        report_view, report_export
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, 
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, 
        $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, 
        $58, $59, $60, $61, $62, $63, $64, $65, $66, $67, $68
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
      location || "",
      joining_date || null,
      employment_type || "",
      skill_type || "",
      zone || "",
      "Probation",
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
      perms.employee_view || false,
      perms.employee_add || false,
      perms.employee_edit || false,
      perms.employee_delete || false,
      perms.finance_view || false,
      perms.finance_edit || false,
      perms.finance_approve || false,
      perms.project_view || false,
      perms.project_add || false,
      perms.project_edit || false,
      perms.report_view || false,
      perms.report_export || false
    ];

    const result = await pool.query(query, values);
    console.log("✅ Employee inserted successfully with ID:", result.rows[0].id);
    return result.rows[0];
  } catch (err) {
    console.error("❌ Full insert failed:", err.message);
    console.error("❌ Full error:", err);
    throw new Error(`Failed to add employee: ${err.message}`);
  }
};

export const getEmployees = async () => {
  const result = await pool.query("SELECT * FROM employees ORDER BY id DESC");
  return result.rows;
};

export const getNextEmployeeCode = async () => {
  const result = await pool.query("SELECT office_id FROM employees ORDER BY id DESC LIMIT 1");
  
  if (result.rows.length === 0) {
    return "EMP001";
  }
  
  const lastCode = result.rows[0].office_id;
  if (!lastCode || !lastCode.startsWith("EMP")) {
    return "EMP001";
  }
  
  const lastNumber = parseInt(lastCode.substring(3));
  const nextNumber = lastNumber + 1;
  return `EMP${String(nextNumber).padStart(3, "0")}`;
};

export const updateEmployee = async (id, data) => {
  console.log("📝 updateEmployee service received:");
  console.log("   Employee ID:", id, "(type:", typeof id, ")");
  console.log("   Data:", JSON.stringify(data));
  console.log("   Data keys:", Object.keys(data));
  console.log("   Data length:", Object.keys(data).length);
  
  if (!data) {
    throw new Error("Request body is empty");
  }

  // If only status is being updated
  if (Object.keys(data).length === 1 && data.status) {
    console.log("✅ Status-only update detected:", data.status);
    try {
      const query = `UPDATE employees SET status = $1 WHERE id = $2 RETURNING *`;
      console.log("   Executing query:", query);
      console.log("   With values:", [data.status, id]);
      const result = await pool.query(query, [data.status, id]);
      console.log("   Query result rows:", result.rows.length);
      if (result.rows.length === 0) {
        throw new Error("Employee not found with ID: " + id);
      }
      console.log("✅ Status updated successfully:", result.rows[0].status);
      return result.rows[0];
    } catch (err) {
      console.error("❌ Status update failed:", err.message);
      console.error("❌ Full error:", err);
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
    reporting_manager,
    location,
    joining_date,
    employment_type,
    skill_type,
    zone,
    status,
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
    esic_number
  } = data;

  try {
    console.log("✅ Attempting full update with all available fields...");
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
        father_name = COALESCE($10, father_name),
        mother_name = COALESCE($11, mother_name),
        spouse_name = COALESCE($12, spouse_name),
        anniversary_date = COALESCE($13, anniversary_date),
        current_address = COALESCE($14, current_address),
        permanent_address = COALESCE($15, permanent_address),
        highest_qualification = COALESCE($16, highest_qualification),
        basic_qualification = COALESCE($17, basic_qualification),
        department = COALESCE($18, department),
        designation = COALESCE($19, designation),
        reporting_manager = COALESCE($20, reporting_manager),
        location = COALESCE($21, location),
        joining_date = COALESCE($22, joining_date),
        employment_type = COALESCE($23, employment_type),
        skill_type = COALESCE($24, skill_type),
        zone = COALESCE($25, zone),
        status = COALESCE($26, status),
        previous_company_1 = COALESCE($27, previous_company_1),
        previous_role_1 = COALESCE($28, previous_role_1),
        previous_years_1 = COALESCE($29, previous_years_1),
        previous_company_2 = COALESCE($30, previous_company_2),
        previous_role_2 = COALESCE($31, previous_role_2),
        previous_years_2 = COALESCE($32, previous_years_2),
        bank_name = COALESCE($33, bank_name),
        branch_name = COALESCE($34, branch_name),
        account_number = COALESCE($35, account_number),
        ifsc_code = COALESCE($36, ifsc_code),
        nominee_name = COALESCE($37, nominee_name),
        emergency_name = COALESCE($38, emergency_name),
        emergency_phone = COALESCE($39, emergency_phone),
        emergency_relationship = COALESCE($40, emergency_relationship),
        pan_number = COALESCE($41, pan_number),
        aadhaar_number = COALESCE($42, aadhaar_number),
        pf_number = COALESCE($43, pf_number),
        uan_number = COALESCE($44, uan_number),
        esic_number = COALESCE($45, esic_number)
      WHERE id = $46
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
      reporting_manager || null,
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
      id
    ];

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      throw new Error("Employee not found");
    }
    console.log("✅ Employee updated successfully with ID:", result.rows[0].id);
    return result.rows[0];
  } catch (err) {
    console.error("❌ Update failed:", err.message);
    throw new Error(`Failed to update employee: ${err.message}`);
  }
};

export const deleteEmployee = async (id) => {
  await pool.query("DELETE FROM employees WHERE id = $1", [id]);
};