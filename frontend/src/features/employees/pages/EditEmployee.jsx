import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "./AddEmployee.css";

export default function EditEmployee({ employee, setPage }) {
  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [managers, setManagers] = useState([]);
  const [openSection, setOpenSection] = useState("basic");

  // Form states - initialize from employee data
  const [firstName, setFirstName] = useState(employee?.first_name || "");
  const [lastName, setLastName] = useState(employee?.last_name || "");
  const [companyEmail, setCompanyEmail] = useState(employee?.company_email || "");
  const [personalEmail, setPersonalEmail] = useState(employee?.personal_email || "");
  const [phone, setPhone] = useState(employee?.phone || "");
  const [gender, setGender] = useState(employee?.gender || "");
  const [bloodGroup, setBloodGroup] = useState(employee?.blood_group || "");
  const [dob, setDob] = useState(employee?.dob ? employee.dob.split("T")[0] : "");

  // Family
  const [fatherName, setFatherName] = useState(employee?.father_name || "");
  const [motherName, setMotherName] = useState(employee?.mother_name || "");
  const [spouseName, setSpouseName] = useState(employee?.spouse_name || "");

  // Address
  const [currentAddress, setCurrentAddress] = useState(employee?.current_address || "");
  const [permanentAddress, setPermanentAddress] = useState(employee?.permanent_address || "");

  // Education
  const [highestQualification, setHighestQualification] = useState(employee?.highest_qualification || "");
  const [basicQualification, setBasicQualification] = useState(employee?.basic_qualification || "");

  // Job
  const [department, setDepartment] = useState(employee?.department || "");
  const [designation, setDesignation] = useState(employee?.designation || "");
  const [reportingManager, setReportingManager] = useState(employee?.reporting_manager || "");
  const [location, setLocation] = useState(employee?.location || "");
  const [employmentType, setEmploymentType] = useState(employee?.employment_type || "");
  const [skillType, setSkillType] = useState(employee?.skill_type || "");
  const [zone, setZone] = useState(employee?.zone || "");
  const [joiningDate, setJoiningDate] = useState(employee?.joining_date ? employee.joining_date.split("T")[0] : "");

  // Experience
  const [previousCompany1, setPreviousCompany1] = useState(employee?.previous_company_1 || "");
  const [previousRole1, setPreviousRole1] = useState(employee?.previous_role_1 || "");
  const [previousYears1, setPreviousYears1] = useState(employee?.previous_years_1 || "");

  const [previousCompany2, setPreviousCompany2] = useState(employee?.previous_company_2 || "");
  const [previousRole2, setPreviousRole2] = useState(employee?.previous_role_2 || "");
  const [previousYears2, setPreviousYears2] = useState(employee?.previous_years_2 || "");

  // Bank
  const [bankName, setBankName] = useState(employee?.bank_name || "");
  const [branchName, setBranchName] = useState(employee?.branch_name || "");
  const [accountNumber, setAccountNumber] = useState(employee?.account_number || "");
  const [ifscCode, setIfscCode] = useState(employee?.ifsc_code || "");
  const [nomineeName, setNomineeName] = useState(employee?.nominee_name || "");

  // Emergency
  const [emergencyName, setEmergencyName] = useState(employee?.emergency_name || "");
  const [emergencyPhone, setEmergencyPhone] = useState(employee?.emergency_phone || "");
  const [emergencyRelationship, setEmergencyRelationship] = useState(employee?.emergency_relationship || "");

  // Compliance
  const [panNumber, setPanNumber] = useState(employee?.pan_number || "");
  const [aadhaarNumber, setAadhaarNumber] = useState(employee?.aadhaar_number || "");
  const [pfNumber, setPfNumber] = useState(employee?.pf_number || "");
  const [uanNumber, setUanNumber] = useState(employee?.uan_number || "");
  const [esicNumber, setEsicNumber] = useState(employee?.esic_number || "");

  const toggleSection = (section) => {
    setOpenSection(openSection === section ? "" : section);
  };

  useEffect(() => {
    api.get("/employees")
      .then(res => setManagers(res.data))
      .catch(err => console.error("Managers fetch failed:", err));
  }, []);

  const handleSaveChanges = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setSuccessMessage("");
    setErrorMessage("");

    try {
      if (!firstName || !companyEmail) {
        setErrorMessage("First name and company email are required");
        setIsSaving(false);
        return;
      }

      const formData = new FormData();
      formData.append("first_name", firstName);
      formData.append("last_name", lastName);
      formData.append("company_email", companyEmail);
      formData.append("personal_email", personalEmail);
      formData.append("phone", phone);
      formData.append("gender", gender);
      formData.append("blood_group", bloodGroup);
      formData.append("dob", dob);

      formData.append("father_name", fatherName);
      formData.append("mother_name", motherName);
      formData.append("spouse_name", spouseName);

      formData.append("current_address", currentAddress);
      formData.append("permanent_address", permanentAddress);

      formData.append("highest_qualification", highestQualification);
      formData.append("basic_qualification", basicQualification);

      formData.append("department", department);
      formData.append("designation", designation);
      formData.append("reporting_manager", reportingManager);
      formData.append("location", location);
      formData.append("employment_type", employmentType);
      formData.append("skill_type", skillType);
      formData.append("zone", zone);
      formData.append("joining_date", joiningDate);

      formData.append("previous_company_1", previousCompany1);
      formData.append("previous_role_1", previousRole1);
      formData.append("previous_years_1", previousYears1);
      formData.append("previous_company_2", previousCompany2);
      formData.append("previous_role_2", previousRole2);
      formData.append("previous_years_2", previousYears2);

      formData.append("bank_name", bankName);
      formData.append("branch_name", branchName);
      formData.append("account_number", accountNumber);
      formData.append("ifsc_code", ifscCode);
      formData.append("nominee_name", nomineeName);

      formData.append("emergency_name", emergencyName);
      formData.append("emergency_phone", emergencyPhone);
      formData.append("emergency_relationship", emergencyRelationship);

      formData.append("pan_number", panNumber);
      formData.append("aadhaar_number", aadhaarNumber);
      formData.append("pf_number", pfNumber);
      formData.append("uan_number", uanNumber);
      formData.append("esic_number", esicNumber);

      const response = await api.put(`/employees/${employee.id}`, formData);

      console.log("✅ Employee updated successfully:", response.data);
      setSuccessMessage("✅ Employee updated successfully!");

      setTimeout(() => {
        setPage("EmployeesData");
      }, 1500);
    } catch (error) {
      console.error("❌ Update failed:", error);
      const errorMsg = error.response?.data?.error || error.message || "Failed to update employee";
      setErrorMessage(`❌ Update failed: ${errorMsg}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="add-employee-container">
      <div className="add-employee-header">
        <h2>✏️ Edit Employee</h2>
        <button
          onClick={() => setPage("EmployeesData")}
          style={{
            background: "#6b7280",
            color: "white",
            border: "none",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: "600"
          }}
        >
          ← Back
        </button>
      </div>

      {successMessage && (
        <div style={{
          background: "#d1fae5",
          color: "#065f46",
          padding: "12px",
          borderRadius: "6px",
          marginBottom: "16px",
          fontWeight: "600"
        }}>
          {successMessage}
        </div>
      )}

      {errorMessage && (
        <div style={{
          background: "#fee2e2",
          color: "#991b1b",
          padding: "12px",
          borderRadius: "6px",
          marginBottom: "16px",
          fontWeight: "600"
        }}>
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSaveChanges} className="employee-form">
        {/* BASIC INFO */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("basic")} className="section-title">
            👤 Basic Information {openSection === "basic" ? "▼" : "▶"}
          </h3>
          {openSection === "basic" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="First Name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="email"
                  placeholder="Company Email"
                  value={companyEmail}
                  onChange={(e) => setCompanyEmail(e.target.value)}
                  required
                />
                <input
                  type="email"
                  placeholder="Personal Email"
                  value={personalEmail}
                  onChange={(e) => setPersonalEmail(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="tel"
                  placeholder="Phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <select value={gender} onChange={(e) => setGender(e.target.value)}>
                  <option value="">Select Gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="form-row">
                <input
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                />
                <select value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)}>
                  <option value="">Select Blood Group</option>
                  <option value="A+">A+</option>
                  <option value="A-">A-</option>
                  <option value="B+">B+</option>
                  <option value="B-">B-</option>
                  <option value="O+">O+</option>
                  <option value="O-">O-</option>
                  <option value="AB+">AB+</option>
                  <option value="AB-">AB-</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* FAMILY */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("family")} className="section-title">
            👨‍👩‍👧‍👦 Family Information {openSection === "family" ? "▼" : "▶"}
          </h3>
          {openSection === "family" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Father Name"
                  value={fatherName}
                  onChange={(e) => setFatherName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Mother Name"
                  value={motherName}
                  onChange={(e) => setMotherName(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Spouse Name"
                  value={spouseName}
                  onChange={(e) => setSpouseName(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* ADDRESS */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("address")} className="section-title">
            📍 Address {openSection === "address" ? "▼" : "▶"}
          </h3>
          {openSection === "address" && (
            <div className="section-content">
              <textarea
                placeholder="Current Address"
                value={currentAddress}
                onChange={(e) => setCurrentAddress(e.target.value)}
                rows="3"
              />
              <textarea
                placeholder="Permanent Address"
                value={permanentAddress}
                onChange={(e) => setPermanentAddress(e.target.value)}
                rows="3"
              />
            </div>
          )}
        </div>

        {/* EDUCATION */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("education")} className="section-title">
            🎓 Education {openSection === "education" ? "▼" : "▶"}
          </h3>
          {openSection === "education" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Highest Qualification"
                  value={highestQualification}
                  onChange={(e) => setHighestQualification(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Basic Qualification"
                  value={basicQualification}
                  onChange={(e) => setBasicQualification(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* JOB */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("job")} className="section-title">
            💼 Job Details {openSection === "job" ? "▼" : "▶"}
          </h3>
          {openSection === "job" && (
            <div className="section-content">
              <div className="form-row">
                <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                  <option value="">Select Department</option>
                  <option value="HR">HR</option>
                  <option value="Finance">Finance</option>
                  <option value="Engineering">Engineering</option>
                  <option value="Sales">Sales</option>
                  <option value="Marketing">Marketing</option>
                  <option value="Operations">Operations</option>
                </select>
                <input
                  type="text"
                  placeholder="Designation"
                  value={designation}
                  onChange={(e) => setDesignation(e.target.value)}
                />
              </div>
              <div className="form-row">
                <select value={reportingManager} onChange={(e) => setReportingManager(e.target.value)}>
                  <option value="">Select Reporting Manager</option>
                  {managers.map(m => (
                    <option key={m.id} value={m.first_name}>{m.first_name} {m.last_name}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
                <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
                  <option value="">Select Employment Type</option>
                  <option value="Permanent">Permanent</option>
                  <option value="Contract">Contract</option>
                  <option value="Temporary">Temporary</option>
                </select>
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Skill Type"
                  value={skillType}
                  onChange={(e) => setSkillType(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Zone"
                  value={zone}
                  onChange={(e) => setZone(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* EXPERIENCE */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("experience")} className="section-title">
            📋 Previous Experience {openSection === "experience" ? "▼" : "▶"}
          </h3>
          {openSection === "experience" && (
            <div className="section-content">
              <h4>Previous Company 1</h4>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Company Name"
                  value={previousCompany1}
                  onChange={(e) => setPreviousCompany1(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Role"
                  value={previousRole1}
                  onChange={(e) => setPreviousRole1(e.target.value)}
                />
                <input
                  type="number"
                  placeholder="Years"
                  value={previousYears1}
                  onChange={(e) => setPreviousYears1(e.target.value)}
                />
              </div>
              <h4>Previous Company 2</h4>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Company Name"
                  value={previousCompany2}
                  onChange={(e) => setPreviousCompany2(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Role"
                  value={previousRole2}
                  onChange={(e) => setPreviousRole2(e.target.value)}
                />
                <input
                  type="number"
                  placeholder="Years"
                  value={previousYears2}
                  onChange={(e) => setPreviousYears2(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* BANK */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("bank")} className="section-title">
            🏦 Bank Details {openSection === "bank" ? "▼" : "▶"}
          </h3>
          {openSection === "bank" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Bank Name"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Branch Name"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Account Number"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="IFSC Code"
                  value={ifscCode}
                  onChange={(e) => setIfscCode(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Nominee Name"
                  value={nomineeName}
                  onChange={(e) => setNomineeName(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* EMERGENCY */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("emergency")} className="section-title">
            🆘 Emergency Contact {openSection === "emergency" ? "▼" : "▶"}
          </h3>
          {openSection === "emergency" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Emergency Contact Name"
                  value={emergencyName}
                  onChange={(e) => setEmergencyName(e.target.value)}
                />
                <input
                  type="tel"
                  placeholder="Emergency Phone"
                  value={emergencyPhone}
                  onChange={(e) => setEmergencyPhone(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Relationship"
                  value={emergencyRelationship}
                  onChange={(e) => setEmergencyRelationship(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* COMPLIANCE */}
        <div className="form-section">
          <h3 onClick={() => toggleSection("compliance")} className="section-title">
            📄 Compliance {openSection === "compliance" ? "▼" : "▶"}
          </h3>
          {openSection === "compliance" && (
            <div className="section-content">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="PAN Number"
                  value={panNumber}
                  onChange={(e) => setPanNumber(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Aadhaar Number"
                  value={aadhaarNumber}
                  onChange={(e) => setAadhaarNumber(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="PF Number"
                  value={pfNumber}
                  onChange={(e) => setPfNumber(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="UAN Number"
                  value={uanNumber}
                  onChange={(e) => setUanNumber(e.target.value)}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="ESIC Number"
                  value={esicNumber}
                  onChange={(e) => setEsicNumber(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* ACTION BUTTONS */}
        <div className="form-actions">
          <button
            type="submit"
            disabled={isSaving}
            style={{
              background: isSaving ? "#ccc" : "#10b981",
              color: "white",
              border: "none",
              padding: "12px 24px",
              borderRadius: "6px",
              cursor: isSaving ? "not-allowed" : "pointer",
              fontSize: "16px",
              fontWeight: "600"
            }}
          >
            {isSaving ? "⏳ Saving..." : "💾 Save Changes"}
          </button>
          <button
            type="button"
            onClick={() => setPage("EmployeesData")}
            style={{
              background: "#6b7280",
              color: "white",
              border: "none",
              padding: "12px 24px",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "16px",
              fontWeight: "600"
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
