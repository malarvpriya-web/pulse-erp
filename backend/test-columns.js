const columns = [
  "office_id", "first_name", "last_name", "company_email", "personal_email",
  "phone", "company_phone", "gender", "blood_group", "dob", "marital_status", 
  "father_name", "mother_name", "spouse_name", "anniversary_date",
  "current_address", "permanent_address", "highest_qualification", "basic_qualification",
  "department", "designation", "employee_role", "reporting_manager", "location", "joining_date",
  "employment_type", "skill_type", "zone", "status", 
  "previous_company_1", "previous_role_1", "previous_years_1", 
  "previous_company_2", "previous_role_2", "previous_years_2",
  "bank_name", "branch_name", "account_number", "ifsc_code", "nominee_name",
  "emergency_name", "emergency_phone", "emergency_relationship",
  "pan_number", "aadhaar_number", "pf_number", "uan_number", "esic_number", "notes",
  "photo_url", "pan_file", "aadhaar_file", "cancelled_cheque_file", 
  "bank_statement_file", "resume_file", "offer_letter_file",
  "employee_view", "employee_add", "employee_edit", "employee_delete",
  "finance_view", "finance_edit", "finance_approve",
  "project_view", "project_add", "project_edit",
  "report_view", "report_export"
];

console.log("Total columns:", columns.length);
console.log("Columns:", columns.join(", "));
