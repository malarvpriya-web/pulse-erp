import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "./AddEmployee.css";
import "./EmployeesData.css";

export default function AddEmployee({ setPage, employee, setSelectedEmployee }) {

  // Helper to format date from database
  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  console.log("Employee data:", employee);
  console.log("File fields:", {
    photo_url: employee?.photo_url,
    pan_file: employee?.pan_file,
    aadhaar_file: employee?.aadhaar_file,
    cancelled_cheque_file: employee?.cancelled_cheque_file,
    bank_statement_file: employee?.bank_statement_file,
    resume_file: employee?.resume_file,
    offer_letter_file: employee?.offer_letter_file
  });

  const [notes,setNotes] = useState(employee?.notes || "");
  const [openSection, setOpenSection] = useState("basic");
  const [managers, setManagers]=useState([]);
  const [showMessage, setShowMessage] = useState(false);
  const [message, setMessage] = useState("");

  const toggleSection = (section) => setOpenSection(section);

  const sectionOrder = [
    "basic","family","address","education","job","experience","bank","compliance","emergency","docs","permissions","notes"
  ];

  const goToNextSection = (currentSection) => {
    const currentIndex = sectionOrder.indexOf(currentSection);
    const nextSection = sectionOrder[currentIndex + 1];
    if (nextSection) setOpenSection(nextSection);
  };

  const handleLastFieldTab = (e, sectionName) => {
    if (e.key === "Tab" && !e.shiftKey) goToNextSection(sectionName);
  };

  // 🔐 Permissions State
  const [permissions,setPermissions] = useState({
    employee_view: employee?.employee_view || false,
    employee_add: employee?.employee_add || false,
    employee_edit: employee?.employee_edit || false,
    employee_delete: employee?.employee_delete || false,
    finance_view: employee?.finance_view || false,
    finance_edit: employee?.finance_edit || false,
    finance_approve: employee?.finance_approve || false,
    project_view: employee?.project_view || false,
    project_add: employee?.project_add || false,
    project_edit: employee?.project_edit || false,
    report_view: employee?.report_view || false,
    report_export: employee?.report_export || false
  });

  // 👨‍💼 Fetch managers safely
 useEffect(()=>{

  api.get("/employees")
    .then(res => setManagers(res.data))
    .catch(err => console.error("Managers error:", err.response?.data || err));

  if (!employee) {
    api.get("/employees/next-code")
      .then(res => {
        console.log("Next code response:", res.data);
        setEmployeeCode(res.data.code);
      })
      .catch(err => {
        console.error("Code fetch error:", err.response?.data || err);
      });
  }

},[employee]);

 // 🆔 Employee Code from backend
const [employeeCode, setEmployeeCode] = useState(employee?.office_id || ""); 
  // BASIC
  const [firstName,setFirstName]=useState(employee?.first_name || "");
  const [lastName,setLastName]=useState(employee?.last_name || "");
  const [companyEmail,setCompanyEmail]=useState(employee?.company_email || "");
  const [personalEmail,setPersonalEmail]=useState(employee?.personal_email || "");
  const [phone,setPhone]=useState(employee?.phone || "");
  const [companyPhone,setCompanyPhone]=useState(employee?.company_phone || "");
  const [gender,setGender]=useState(employee?.gender || "");
  const [bloodGroup,setBloodGroup]=useState(employee?.blood_group || "");
  const [dob,setDob]=useState(formatDate(employee?.dob));
  const [maritalStatus,setMaritalStatus]=useState(employee?.marital_status || "");

  // FAMILY
  const [fatherName,setFatherName]=useState(employee?.father_name || "");
  const [motherName,setMotherName]=useState(employee?.mother_name || "");
  const [spouseName,setSpouseName]=useState(employee?.spouse_name || "");
  const [anniversaryDate,setAnniversaryDate]=useState(formatDate(employee?.anniversary_date));

  // ADDRESS
  const [currentAddress,setCurrentAddress]=useState(employee?.current_address || "");
  const [permanentAddress,setPermanentAddress]=useState(employee?.permanent_address || "");

  // EDUCATION
  const [highestQualification,setHighestQualification]=useState(employee?.highest_qualification || "");
  const [basicQualification,setBasicQualification]=useState(employee?.basic_qualification || "");

  // JOB
  const [department,setDepartment] = useState(employee?.department || "");
  const [designation,setDesignation]=useState(employee?.designation || "");
  const [employeeRole,setEmployeeRole]=useState(employee?.employee_role || "");
  const [reportingManager,setReportingManager]=useState(employee?.reporting_manager || "");
  const [location,setLocation]=useState(employee?.location || "");
  const [employmentType,setEmploymentType]=useState(employee?.employment_type || "");
  const [skillType,setSkillType]=useState(employee?.skill_type || "");
  const [zone,setZone]=useState(employee?.zone || "");

  const today = new Date().toISOString().split("T")[0];
  const [joiningDate,setJoiningDate] = useState(employee?.joining_date ? formatDate(employee.joining_date) : today);

  // EXPERIENCE
  const [previousCompany1,setPreviousCompany1]=useState(employee?.previous_company_1 || "");
  const [previousRole1,setPreviousRole1]=useState(employee?.previous_role_1 || "");
  const [previousYears1,setPreviousYears1]=useState(employee?.previous_years_1 || "");
  const [previousCompany2,setPreviousCompany2]=useState(employee?.previous_company_2 || "");
  const [previousRole2,setPreviousRole2]=useState(employee?.previous_role_2 || "");
  const [previousYears2,setPreviousYears2]=useState(employee?.previous_years_2 || "");

  // BANK
  const [bankName,setBankName]=useState(employee?.bank_name || "");
  const [branchName,setBranchName]=useState(employee?.branch_name || "");
  const [accountNumber,setAccountNumber]=useState(employee?.account_number || "");
  const [ifscCode,setIfscCode]=useState(employee?.ifsc_code || "");
  const [nomineeName,setNomineeName]=useState(employee?.nominee_name || "");

  // EMERGENCY
  const [emergencyName,setEmergencyName]=useState(employee?.emergency_name || "");
  const [emergencyPhone,setEmergencyPhone]=useState(employee?.emergency_phone || "");
  const [emergencyRelationship,setEmergencyRelationship]=useState(employee?.emergency_relationship || "");

  // COMPLIANCE
  const [panNumber,setPanNumber]=useState(employee?.pan_number || "");
  const [aadhaarNumber,setAadhaarNumber]=useState(employee?.aadhaar_number || "");
  const [pfNumber,setPfNumber]=useState(employee?.pf_number || "");
  const [uanNumber,setUanNumber]=useState(employee?.uan_number || "");
  const [esicNumber,setEsicNumber]=useState(employee?.esic_number || "");

  // FILES
  const [photoFile,setPhotoFile]=useState(null);
  const [panFile,setPanFile]=useState(null);
  const [aadhaarFile,setAadhaarFile]=useState(null);
  const [chequeFile,setChequeFile]=useState(null);
  const [bankFile,setBankFile]=useState(null);
  const [resumeFile,setResumeFile]=useState(null);
  const [offerLetterFile,setOfferLetterFile]=useState(null);

  const departments = ["HR","Finance","Sales","Production","IT"];
  const employeeRoles = ["Employee","Manager","Department Head"];
  const employmentTypes = ["Permanent","Probation","Contract"];
  const skillTypes = ["Skilled","Semi Skilled","Unskilled"];
  const zones = ["North","South","East","West","HO"];
  const relationships = ["Father","Mother","Spouse","Brother","Sister","Friend"];
  const qualifications = ["PhD","Post Graduate","Graduate","Diploma","12th","10th"];

  // 💾 SAVE EMPLOYEE
  const addEmployee = async ()=>{
    try{
      
      // Required validation
      if (!firstName || !lastName || !companyEmail) {
        alert("Please fill mandatory fields.");
        return;
      }

      const formData = new FormData();

      const fields = {
        office_id:employeeCode,
        first_name:firstName,
        last_name:lastName,
        company_email:companyEmail,
        personal_email:personalEmail,
        phone,
        company_phone:companyPhone,
        gender,
        blood_group:bloodGroup,
        dob,
        marital_status:maritalStatus,
        father_name:fatherName,
        mother_name:motherName,
        spouse_name:spouseName,
        anniversary_date:anniversaryDate,
        current_address:currentAddress,
        permanent_address:permanentAddress,
        highest_qualification:highestQualification,
        basic_qualification:basicQualification,
        department,
        designation,
        reporting_manager:reportingManager,
        location,
        joining_date:joiningDate,
        employment_type:employmentType,
        skill_type:skillType,
        zone,
        previous_company_1:previousCompany1,
        previous_role_1:previousRole1,
        previous_years_1:previousYears1,
        previous_company_2:previousCompany2,
        previous_role_2:previousRole2,
        previous_years_2:previousYears2,
        bank_name:bankName,
        branch_name:branchName,
        account_number:accountNumber,
        ifsc_code:ifscCode,
        nominee_name:nomineeName,
        emergency_name:emergencyName,
        emergency_phone:emergencyPhone,
        emergency_relationship:emergencyRelationship,
        pan_number:panNumber,
        aadhaar_number:aadhaarNumber,
        pf_number:pfNumber,
        uan_number:uanNumber,
        esic_number:esicNumber,
        notes
      };

      if (employeeRole) {
        fields.employee_role = employeeRole;
      }

      Object.entries(fields).forEach(([k,v])=>formData.append(k,v));
      formData.append("permissions", JSON.stringify(permissions));

      if(photoFile) formData.append("photo_file",photoFile);
      if(panFile) formData.append("pan_file",panFile);
      if(aadhaarFile) formData.append("aadhaar_file",aadhaarFile);
      if(chequeFile) formData.append("cancelled_cheque_file",chequeFile);
      if(bankFile) formData.append("bank_statement_file",bankFile);
      if(resumeFile) formData.append("resume_file",resumeFile);
      if(offerLetterFile) formData.append("offer_letter_file",offerLetterFile);

      if (employee) {
        await api.put(`/employees/${employee.id}`, formData);
        setMessage("✅ Employee Updated Successfully!");
      } else {
        await api.post("/employees", formData);
        setMessage("✅ Employee Added Successfully!");
      }
      
      setShowMessage(true);
      setTimeout(() => {
        setSelectedEmployee(null);
        setPage("EmployeesData");
      }, 1500);

    }catch(err){
      setMessage("❌ " + (err.response?.data?.message || "Error saving employee"));
      setShowMessage(true);
      setTimeout(() => setShowMessage(false), 3000);
    }
  };

  return (
    <div className="add-employee-page">
      {showMessage && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'white',
          padding: '30px 50px',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          zIndex: 9999,
          fontSize: '18px',
          fontWeight: '600',
          textAlign: 'center'
        }}>
          {message}
        </div>
      )}
      <div className="page-container">
        <div className="page-header">
          <h1>{employee ? "Edit Employee" : "Add Employee"}</h1>
          <button className="add-page-back-btn" onClick={()=>{setSelectedEmployee(null); setPage("EmployeesData");}}>
            ← Back
          </button>
        </div>

        <form onSubmit={(e)=>{ e.preventDefault(); addEmployee(); }} className="add-employee-form">
          <div className="form-wrapper">
        {/* BASIC INFO */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("basic")}>
    <h2>Basic Information</h2>
  </div>

  {openSection === "basic" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Employee ID</label><input value={employeeCode || "Auto-generated"} disabled /></div>
        <div><label>First Name *</label><input value={firstName} onChange={e=>setFirstName(e.target.value)} /></div>
        <div><label>Last Name *</label><input value={lastName} onChange={e=>setLastName(e.target.value)} /></div>
        <div><label>Company Email *</label><input value={companyEmail} onChange={e=>setCompanyEmail(e.target.value)} /></div>
        <div><label>Personal Email</label><input value={personalEmail} onChange={e=>setPersonalEmail(e.target.value)} /></div>

        <div>
          <label>Personal Phone</label>
          <input type="tel" pattern="[0-9]*" inputMode="numeric" value={phone}
            onChange={e=>setPhone(e.target.value)} />
        </div>

        <div>
          <label>Company Phone</label>
          <input type="tel" pattern="[0-9]*" inputMode="numeric" value={companyPhone}
            onChange={e=>setCompanyPhone(e.target.value)} />
        </div>

        <div><label>DOB</label><input type="date" value={dob} onChange={e=>setDob(e.target.value)} /></div>

        <div>
          <label>Gender</label>
          <div style={{ display: "flex", gap: "15px", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <input type="radio" name="gender" value="Male"
                checked={gender==="Male"} onChange={e=>setGender(e.target.value)} /> Male
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <input type="radio" name="gender" value="Female"
                checked={gender==="Female"} onChange={e=>setGender(e.target.value)} /> Female
            </label>
          </div>
        </div>

        <div>
          <label>Blood Group</label>
          <select value={bloodGroup} onChange={e=>setBloodGroup(e.target.value)}>
            <option value="" disabled>-- Select Blood Group --</option>
            <option>A+</option><option>A-</option>
            <option>B+</option><option>B-</option>
            <option>O+</option><option>O-</option>
            <option>AB+</option><option>AB-</option>
          </select>
        </div>

        <div>
          <label>Marital Status</label>
          <select value={maritalStatus} onChange={e=>setMaritalStatus(e.target.value)}
                  onKeyDown={(e)=>handleLastFieldTab(e,"basic")}>
            <option value="" disabled>-- Select Marital Status --</option>
            <option>Single</option>
            <option>Married</option>
            <option>Divorced</option>
            <option>Widowed</option>
          </select>
        </div>
      </div>
    </div>
  )}
</div>

{/* FAMILY */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("family")}>
    <h2>Family Information</h2>
  </div>

  {openSection === "family" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Father Name</label><input value={fatherName} onChange={e=>setFatherName(e.target.value)} /></div>
        <div><label>Mother Name</label><input value={motherName} onChange={e=>setMotherName(e.target.value)} /></div>
        <div><label>Spouse Name</label><input value={spouseName} onChange={e=>setSpouseName(e.target.value)} /></div>
        <div><label>Anniversary Date</label>
          <input type="date" value={anniversaryDate} onChange={e=>setAnniversaryDate(e.target.value)}
                 onKeyDown={(e)=>handleLastFieldTab(e,"family")} />
        </div>
      </div>
    </div>
  )}
</div>

{/* ADDRESS */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("address")}>
    <h2>Address</h2>
  </div>

  {openSection === "address" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Current Address</label><textarea value={currentAddress} onChange={e=>setCurrentAddress(e.target.value)} /></div>
        <div><label>Permanent Address</label>
          <textarea value={permanentAddress} onChange={e=>setPermanentAddress(e.target.value)}
                    onKeyDown={(e)=>handleLastFieldTab(e,"address")} />
        </div>
      </div>
    </div>
  )}
</div>

{/* EDUCATION */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("education")}>
    <h2>Education</h2>
  </div>

  {openSection === "education" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div>
          <label>Highest Qualification</label>
          <select value={highestQualification} onChange={e=>setHighestQualification(e.target.value)}>
            <option value="" disabled>-- Select Qualification --</option>
            {qualifications.map(q => <option key={q}>{q}</option>)}
          </select>
        </div>
        <div>
          <label>Basic Qualification</label>
          <select value={basicQualification} onChange={e=>setBasicQualification(e.target.value)}
                  onKeyDown={(e)=>handleLastFieldTab(e,"education")}>
            <option value="" disabled>-- Select Qualification --</option>
            {qualifications.map(q => <option key={q}>{q}</option>)}
          </select>
        </div>
      </div>
    </div>
  )}
</div>

{/* JOB */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("job")}>
    <h2>Job Information</h2>
  </div>

  {openSection === "job" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div>
          <label>Department</label>
          <select value={department} onChange={e=>setDepartment(e.target.value)}>
            <option value="" disabled>-- Select Department --</option>
            {departments.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>

        <div><label>Designation</label><input value={designation} onChange={e=>setDesignation(e.target.value)} /></div>

        <div>
          <label>Role</label>
          <select value={employeeRole} onChange={e=>setEmployeeRole(e.target.value)}>
            <option value="" disabled>-- Select Role --</option>
            {employeeRoles.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>

        <div>
          <label>Reporting Manager</label>
          <select value={reportingManager} onChange={e=>setReportingManager(e.target.value)}>
            <option value="" disabled>-- Select Manager --</option>
            {managers.map(m => (
              <option key={m.id} value={`${m.first_name} ${m.last_name}`}>{m.first_name} {m.last_name}</option>
            ))}
          </select>
        </div>

        <div><label>Location</label><input value={location} onChange={e=>setLocation(e.target.value)} /></div>

        <div>
          <label>Employment Type</label>
          <select value={employmentType} onChange={e=>setEmploymentType(e.target.value)}>
            <option value="" disabled>-- Select Type --</option>
            {employmentTypes.map(e => <option key={e}>{e}</option>)}
          </select>
        </div>

        <div>
          <label>Skill Type</label>
          <select value={skillType} onChange={e=>setSkillType(e.target.value)}>
            <option value="" disabled>-- Select Skill --</option>
            {skillTypes.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <label>Zone</label>
          <select value={zone} onChange={e=>setZone(e.target.value)}>
            <option value="" disabled>-- Select Zone --</option>
            {zones.map(z => <option key={z}>{z}</option>)}
          </select>
        </div>

        <div>
          <label>Joining Date</label>
          <input type="date" value={joiningDate}
            onChange={e=>setJoiningDate(e.target.value)}
            onKeyDown={(e)=>handleLastFieldTab(e,"job")} />
        </div>
      </div>
    </div>
  )}
</div>

{/* EXPERIENCE */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("experience")}>
    <h2>Previous Experience</h2>
  </div>

  {openSection === "experience" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Company 1</label><input value={previousCompany1} onChange={e=>setPreviousCompany1(e.target.value)} /></div>
        <div><label>Role 1</label><input value={previousRole1} onChange={e=>setPreviousRole1(e.target.value)} /></div>
        <div><label>Years 1</label><input type="number" value={previousYears1} onChange={e=>setPreviousYears1(e.target.value)} /></div>
        <div><label>Company 2</label><input value={previousCompany2} onChange={e=>setPreviousCompany2(e.target.value)} /></div>
        <div><label>Role 2</label><input value={previousRole2} onChange={e=>setPreviousRole2(e.target.value)} /></div>
        <div><label>Years 2</label>
          <input type="number" value={previousYears2} onChange={e=>setPreviousYears2(e.target.value)}
                 onKeyDown={(e)=>handleLastFieldTab(e,"experience")} />
        </div>
      </div>
    </div>
  )}
</div>

{/* BANK */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("bank")}>
    <h2>Bank Details</h2>
  </div>

  {openSection === "bank" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Bank Name</label><input value={bankName} onChange={e=>setBankName(e.target.value)} /></div>
        <div><label>Branch</label><input value={branchName} onChange={e=>setBranchName(e.target.value)} /></div>
        <div><label>Account Number</label><input value={accountNumber} onChange={e=>setAccountNumber(e.target.value)} /></div>
        <div><label>IFSC</label><input value={ifscCode} onChange={e=>setIfscCode(e.target.value)} /></div>
        <div><label>Nominee</label>
          <input value={nomineeName} onChange={e=>setNomineeName(e.target.value)}
                 onKeyDown={(e)=>handleLastFieldTab(e,"bank")} />
        </div>
      </div>
    </div>
  )}
</div>

{/* COMPLIANCE */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("compliance")}>
    <h2>Compliance Documents</h2>
  </div>

  {openSection === "compliance" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>PAN Number</label><input value={panNumber} onChange={e=>setPanNumber(e.target.value)} /></div>
        <div><label>Aadhaar Number</label><input value={aadhaarNumber} onChange={e=>setAadhaarNumber(e.target.value)} /></div>
        <div><label>PF Number</label><input value={pfNumber} onChange={e=>setPfNumber(e.target.value)} /></div>
        <div><label>UAN Number</label><input value={uanNumber} onChange={e=>setUanNumber(e.target.value)} /></div>
        <div><label>ESIC Number</label>
          <input value={esicNumber} onChange={e=>setEsicNumber(e.target.value)}
                 onKeyDown={(e)=>handleLastFieldTab(e,"compliance")} />
        </div>
      </div>
    </div>
  )}
</div>
{/* EMERGENCY */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("emergency")}>
    <h2>Emergency Contact</h2>
  </div>

  {openSection === "emergency" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Name</label><input value={emergencyName} onChange={e=>setEmergencyName(e.target.value)} /></div>
        <div><label>Phone</label><input value={emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} /></div>
        <div>
          <label>Relationship</label>
          <select value={emergencyRelationship} onChange={(e)=>setEmergencyRelationship(e.target.value)}
                  onKeyDown={(e)=>handleLastFieldTab(e,"emergency")}>
            <option value="" disabled>-- Select Relationship --</option>
            {relationships.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
    </div>
  )}
</div>

{/* DOCUMENTS */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("docs")}>
    <h2>Upload Documents</h2>
  </div>

  {openSection === "docs" && (
    <div className="accordion-body upload-grid">
      <div className="upload-box">
        <span>Photo {(employee?.photo_url || photoFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" accept="image/*" onChange={e=>setPhotoFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>PAN {(employee?.pan_file || panFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setPanFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>Aadhaar {(employee?.aadhaar_file || aadhaarFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setAadhaarFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>Cheque {(employee?.cancelled_cheque_file || chequeFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setChequeFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>Bank Statement {(employee?.bank_statement_file || bankFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setBankFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>Resume {(employee?.resume_file || resumeFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setResumeFile(e.target.files[0])}/>
      </div>
      <div className="upload-box">
        <span>Offer Letter {(employee?.offer_letter_file || offerLetterFile) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setOfferLetterFile(e.target.files[0])} onKeyDown={(e)=>handleLastFieldTab(e,"docs")} />
      </div>
    </div>
  )}
</div>

{/* SYSTEM PERMISSIONS */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("permissions")}>
    <h2>System Permissions</h2>
  </div>

  {openSection === "permissions" && (
    <div className="accordion-body">
      <div className="permission-cards">

        <div className="permission-card">
          <h3>Employee</h3>
          <label><input type="checkbox"
            checked={permissions.employee_view}
            onChange={(e)=>setPermissions({...permissions, employee_view:e.target.checked})}/> View</label>
          <label><input type="checkbox"
            checked={permissions.employee_add}
            onChange={(e)=>setPermissions({...permissions, employee_add:e.target.checked})}/> Add</label>
          <label><input type="checkbox"
            checked={permissions.employee_edit}
            onChange={(e)=>setPermissions({...permissions, employee_edit:e.target.checked})}/> Edit</label>
          <label><input type="checkbox"
            checked={permissions.employee_delete}
            onChange={(e)=>setPermissions({...permissions, employee_delete:e.target.checked})}/> Delete</label>
        </div>

        <div className="permission-card">
          <h3>Finance</h3>
          <label><input type="checkbox"
            checked={permissions.finance_view}
            onChange={(e)=>setPermissions({...permissions, finance_view:e.target.checked})}/> View</label>
          <label><input type="checkbox"
            checked={permissions.finance_edit}
            onChange={(e)=>setPermissions({...permissions, finance_edit:e.target.checked})}/> Edit</label>
          <label><input type="checkbox"
            checked={permissions.finance_approve}
            onChange={(e)=>setPermissions({...permissions, finance_approve:e.target.checked})}/> Approve</label>
        </div>

        <div className="permission-card">
          <h3>Projects</h3>
          <label><input type="checkbox"
            checked={permissions.project_view}
            onChange={(e)=>setPermissions({...permissions, project_view:e.target.checked})}/> View</label>
          <label><input type="checkbox"
            checked={permissions.project_add}
            onChange={(e)=>setPermissions({...permissions, project_add:e.target.checked})}/> Add</label>
          <label><input type="checkbox"
            checked={permissions.project_edit}
            onChange={(e)=>setPermissions({...permissions, project_edit:e.target.checked})}/> Edit</label>
        </div>

        <div className="permission-card">
          <h3>Reports</h3>
          <label><input type="checkbox"
            checked={permissions.report_view}
            onChange={(e)=>setPermissions({...permissions, report_view:e.target.checked})}/> View</label>
          <label><input type="checkbox"
            checked={permissions.report_export}
            onChange={(e)=>setPermissions({...permissions, report_export:e.target.checked})}/> Export</label>
        </div>

      </div>
    </div>
  )}
</div>

{/* NOTES */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("notes")}>
    <h2>Notes</h2>
  </div>

  {openSection === "notes" && (
    <div className="accordion-body">
      <textarea
        className="notes-textarea"
        placeholder="Add remarks, onboarding notes, role details..."
        rows="5"
        value={notes}
        onChange={(e)=>setNotes(e.target.value)}
      />
    </div>
  )}
</div>
</div>
<button type="submit" className="save-btn">Save</button>

</form>
</div>
</div>
);
}