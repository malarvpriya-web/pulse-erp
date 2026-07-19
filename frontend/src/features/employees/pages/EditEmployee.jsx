import { useState, useEffect } from "react";
import api from "@/services/api/client";
import ResultDialog from "@/components/ResultDialog";
import "./AddEmployee.css";
import "./EmployeesData.css";
import { useToast } from '@/context/ToastContext';

export default function EditEmployee({ employee, setPage, setSelectedEmployee }) {

  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const toast = useToast();
  const [notes, setNotes] = useState(employee?.notes || "");
  const [openSection, setOpenSection] = useState("basic");
  const [managers, setManagers] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(false);

  const toggleSection = (section) => setOpenSection(section);

  const sectionOrder = [
    "basic","family","address","education","job","experience","bank","compliance","emergency","assets","docs","notes"
  ];

  const goToNextSection = (currentSection) => {
    const currentIndex = sectionOrder.indexOf(currentSection);
    const nextSection = sectionOrder[currentIndex + 1];
    if (nextSection) {
      setOpenSection(nextSection);
      setTimeout(() => {
        const el = document.querySelector('.accordion-body input:not([disabled]), .accordion-body select, .accordion-body textarea');
        if (el) el.focus();
      }, 40);
    }
  };

  const handleLastFieldTab = (e, sectionName) => {
    if (e.key === "Tab" && !e.shiftKey) goToNextSection(sectionName);
  };

  // 🆔 Employee Code (read-only on edit)
  const [employeeCode] = useState(employee?.office_id || "");
  const today = new Date().toISOString().split("T")[0];

  const [departments,   setDepartments]  = useState([]);
  const [zones,         setZones]        = useState([]);
  const [designationList, setDesignations] = useState([]);
  const [shifts, setShifts] = useState([]);

  // SHIFT — persisted as an hr_shift_assignment after the employee is saved.
  const [shiftId, setShiftId] = useState("");
  const [originalShiftId, setOriginalShiftId] = useState("");
  const [existingShiftAssignmentId, setExistingShiftAssignmentId] = useState(null);

  // ASSETS — laptop / SIM / phone etc. Each row with an asset_name is created
  // via POST /employee-assets after the employee record is saved.
  const ASSET_TYPES = ['Laptop','Desktop','Mobile','SIM Card','Tablet','Monitor','Keyboard','Mouse','Headset','Access Card','Vehicle','Tools','Other'];
  const blankAsset = () => ({ asset_type: 'Laptop', asset_name: '', asset_tag: '', serial_number: '' });
  const [assetRows, setAssetRows] = useState([blankAsset()]);
  const [existingAssets, setExistingAssets] = useState([]);

  // 👨‍💼 Fetch managers + master data
  useEffect(() => {
    const EX_STATUSES_LOWER = new Set(['left','terminated','resigned','ex-employee','notice_period','notice period','inactive']);
    api.get("/employees")
      .then(res => setManagers(
        (Array.isArray(res.data) ? res.data : [])
          .filter(e => !EX_STATUSES_LOWER.has((e.status || '').toLowerCase()))
      ))
      .catch(() => {});

    api.get('/admin/config/departments')
      .then(res => setDepartments(Array.isArray(res.data) ? res.data.map(d => d.name || d) : []))
      .catch(() => setDepartments([]));

    api.get('/admin/config/zones')
      .then(res => setZones(Array.isArray(res.data) ? res.data.map(z => z.name || z) : []))
      .catch(() => setZones([]));

    api.get('/admin/config/designations')
      .then(res => setDesignations(Array.isArray(res.data) ? res.data.map(d => d.name || d) : []))
      .catch(() => setDesignations([]));

    // Shift master for the Job Information shift picker
    api.get('/hr/shifts')
      .then(res => setShifts(Array.isArray(res.data) ? res.data : []))
      .catch(() => setShifts([]));

    // Preload the employee's current shift + allocated assets so they show in the
    // form and a shift change can retire the old assignment.
    if (employee?.id) {
      api.get('/hr/shift-assignments')
        .then(res => {
          const mine = (Array.isArray(res.data) ? res.data : [])
            .filter(a => Number(a.employee_id) === Number(employee.id));
          if (mine.length) {
            setShiftId(String(mine[0].shift_id));
            setOriginalShiftId(String(mine[0].shift_id));
            setExistingShiftAssignmentId(mine[0].id);
          }
        })
        .catch(() => {});
      api.get(`/employee-assets?employee_id=${employee.id}`)
        .then(res => setExistingAssets(Array.isArray(res.data) ? res.data : []))
        .catch(() => {});
    }
  }, [employee?.id]);

  // BASIC
  const [firstName,    setFirstName]    = useState(employee?.first_name    || "");
  const [lastName,     setLastName]     = useState(employee?.last_name     || "");
  const [companyEmail, setCompanyEmail] = useState(employee?.company_email || "");
  const [personalEmail,setPersonalEmail]= useState(employee?.personal_email|| "");
  const [phone,        setPhone]        = useState(employee?.phone         || "");
  const [companyPhone, setCompanyPhone] = useState(employee?.company_phone || "");
  const [gender,       setGender]       = useState(employee?.gender        || "");
  const [bloodGroup,   setBloodGroup]   = useState(employee?.blood_group   || "");
  const [dob,          setDob]          = useState(formatDate(employee?.dob));
  const [maritalStatus,setMaritalStatus]= useState(employee?.marital_status|| "");

  // FAMILY
  const [fatherName,      setFatherName]      = useState(employee?.father_name       || "");
  const [motherName,      setMotherName]      = useState(employee?.mother_name       || "");
  const [spouseName,      setSpouseName]      = useState(employee?.spouse_name       || "");
  const [anniversaryDate, setAnniversaryDate] = useState(formatDate(employee?.anniversary_date));

  // ADDRESS
  const [currentAddress,   setCurrentAddress]   = useState(employee?.current_address   || "");
  const [permanentAddress,  setPermanentAddress]  = useState(employee?.permanent_address  || "");

  // EDUCATION
  const [highestQualification, setHighestQualification] = useState(employee?.highest_qualification || "");
  const [basicQualification,   setBasicQualification]   = useState(employee?.basic_qualification   || "");

  // JOB
  const [department,          setDepartment]          = useState(employee?.department       || "");
  const [designation,         setDesignation]         = useState(employee?.designation      || "");
  const [employeeRole,        setEmployeeRole]        = useState(employee?.employee_role    || "");
  const [reportingManagerId,  setReportingManagerId]  = useState(employee?.reporting_manager_id ? String(employee.reporting_manager_id) : "");
  const [reportingManagerName,setReportingManagerName]= useState(employee?.reporting_manager || "");
  const [status,              setStatus]              = useState(employee?.status            || "Active");
  const [location,            setLocation]            = useState(employee?.location          || "");
  const [employmentType,  setEmploymentType]  = useState(employee?.employment_type  || "");
  const [skillType,       setSkillType]       = useState(employee?.skill_type       || "");
  const [isFieldEmployee, setIsFieldEmployee] = useState(employee?.is_field_employee === true);
  const [zone,            setZone]            = useState(employee?.zone             || "");
  const [joiningDate,     setJoiningDate]     = useState(formatDate(employee?.joining_date));

  // EXPERIENCE
  const [isFresher,        setIsFresher]        = useState(false);
  const [previousCompany1, setPreviousCompany1] = useState(employee?.previous_company_1 || "");
  const [previousRole1,    setPreviousRole1]    = useState(employee?.previous_role_1    || "");
  const [previousYears1,   setPreviousYears1]   = useState(employee?.previous_years_1   || "");
  const [previousCompany2, setPreviousCompany2] = useState(employee?.previous_company_2 || "");
  const [previousRole2,    setPreviousRole2]    = useState(employee?.previous_role_2    || "");
  const [previousYears2,   setPreviousYears2]   = useState(employee?.previous_years_2   || "");

  // BANK
  const [bankName,      setBankName]      = useState(employee?.bank_name      || "");
  const [branchName,    setBranchName]    = useState(employee?.branch_name    || "");
  const [accountNumber, setAccountNumber] = useState(employee?.account_number || "");
  const [ifscCode,      setIfscCode]      = useState(employee?.ifsc_code      || "");
  const [nomineeName,   setNomineeName]   = useState(employee?.nominee_name   || "");

  // EMERGENCY
  const [emergencyName,         setEmergencyName]         = useState(employee?.emergency_name         || "");
  const [emergencyPhone,        setEmergencyPhone]        = useState(employee?.emergency_phone        || "");
  const [emergencyRelationship, setEmergencyRelationship] = useState(employee?.emergency_relationship || "");

  // COMPLIANCE
  const [panNumber,    setPanNumber]    = useState(employee?.pan_number    || "");
  const [aadhaarNumber,setAadhaarNumber]= useState(employee?.aadhaar_number|| "");
  const [pfNumber,     setPfNumber]     = useState(employee?.pf_number     || "");
  const [uanNumber,    setUanNumber]    = useState(employee?.uan_number    || "");
  const [esicNumber,   setEsicNumber]   = useState(employee?.esic_number   || "");

  // FILES
  const [photoFile,       setPhotoFile]       = useState(null);
  const [panFile,         setPanFile]         = useState(null);
  const [aadhaarFile,     setAadhaarFile]     = useState(null);
  const [chequeFile,      setChequeFile]      = useState(null);
  const [bankFile,        setBankFile]        = useState(null);
  const [resumeFile,      setResumeFile]      = useState(null);
  const [offerLetterFile, setOfferLetterFile] = useState(null);

  const employeeRoles  = ["Employee","Manager","Department Head"];
  const employmentTypes= ["Permanent","Probation","Contract"];
  const skillTypes     = ["Skilled","Semi Skilled","Unskilled"];
  const relationships  = ["Father","Mother","Spouse","Brother","Sister","Friend"];
  const qualifications = ["PhD","Post Graduate","Graduate","Diploma","12th","10th"];

  // ── ASSET ROW HELPERS ──────────────────────────────────────────────
  const updateAssetRow = (idx, key, val) =>
    setAssetRows(rows => rows.map((r, i) => i === idx ? { ...r, [key]: val } : r));
  const addAssetRow    = () => setAssetRows(rows => [...rows, blankAsset()]);
  const removeAssetRow = (idx) =>
    setAssetRows(rows => rows.length > 1 ? rows.filter((_, i) => i !== idx) : [blankAsset()]);

  // Persist shift assignment + new asset allocations. Best-effort: the employee
  // is already saved, so a failure here only skips the extra records.
  const persistShiftAndAssets = async (employeeId) => {
    if (!employeeId) return;
    try {
      if (shiftId && String(shiftId) !== String(originalShiftId)) {
        if (existingShiftAssignmentId) {
          await api.delete(`/hr/shift-assignments/${existingShiftAssignmentId}`).catch(() => {});
        }
        await api.post('/hr/shift-assignments', {
          employee_id: employeeId,
          shift_id: Number(shiftId),
          effective_from: joiningDate || today,
        });
      }
    } catch { /* non-blocking */ }

    const toCreate = assetRows.filter(r => (r.asset_name || '').trim());
    for (const r of toCreate) {
      try {
        await api.post('/employee-assets', {
          employee_id: employeeId,
          asset_type: r.asset_type || 'Other',
          asset_name: r.asset_name.trim(),
          asset_tag: r.asset_tag || null,
          serial_number: r.serial_number || null,
          allocated_date: joiningDate || today,
        });
      } catch { /* non-blocking — asset can be added later on the Assets page */ }
    }
  };

  // 💾 SAVE
  const saveEmployee = async () => {
    if (saving) return;
    try {
      if (!firstName || !lastName || !companyEmail) {
        toast.error("First name, last name, and company email are required.");
        return;
      }
      // Phone format (if filled)
      if (phone && !/^\d{10}$/.test(phone.replace(/[\s\-()]/g, ''))) {
        toast.error("Phone number must be 10 digits.");
        return;
      }
      // PAN format (if filled)
      if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(panNumber.trim())) {
        toast.error("PAN must be in format AAAAA9999A (e.g. ABCDE1234F).");
        return;
      }
      // Aadhaar format (if filled)
      if (aadhaarNumber && !/^\d{12}$/.test(aadhaarNumber.replace(/\s/g, ''))) {
        toast.error("Aadhaar number must be exactly 12 digits.");
        return;
      }
      setSaving(true);

      const formData = new FormData();
      const fields = {
        office_id: employeeCode,
        first_name: firstName, last_name: lastName,
        company_email: companyEmail, personal_email: personalEmail,
        phone, company_phone: companyPhone,
        gender, blood_group: bloodGroup, dob, marital_status: maritalStatus,
        father_name: fatherName, mother_name: motherName, spouse_name: spouseName,
        anniversary_date: anniversaryDate,
        current_address: currentAddress, permanent_address: permanentAddress,
        highest_qualification: highestQualification, basic_qualification: basicQualification,
        department, designation,
        reporting_manager_id: reportingManagerId || null,
        reporting_manager: reportingManagerName || null,
        status,
        location, joining_date: joiningDate,
        employment_type: employmentType, skill_type: skillType, zone,
        is_field_employee: isFieldEmployee,
        previous_company_1: previousCompany1, previous_role_1: previousRole1, previous_years_1: previousYears1,
        previous_company_2: previousCompany2, previous_role_2: previousRole2, previous_years_2: previousYears2,
        bank_name: bankName, branch_name: branchName, account_number: accountNumber,
        ifsc_code: ifscCode, nominee_name: nomineeName,
        emergency_name: emergencyName, emergency_phone: emergencyPhone,
        emergency_relationship: emergencyRelationship,
        pan_number: panNumber, aadhaar_number: aadhaarNumber,
        pf_number: pfNumber, uan_number: uanNumber, esic_number: esicNumber,
        notes,
      };
      if (employeeRole) fields.employee_role = employeeRole;

      Object.entries(fields).forEach(([k, v]) => formData.append(k, v));

      // Persist a newly typed zone to the master list so it appears in the
      // dropdown next time (best-effort — the employee still saves the text).
      const zoneTrim = (zone || '').trim();
      if (zoneTrim && !zones.some(z => String(z).toLowerCase() === zoneTrim.toLowerCase())) {
        api.post('/admin/config/zones', { name: zoneTrim }).catch(() => {});
      }

      if (photoFile)       formData.append("photo_file",             photoFile);
      if (panFile)         formData.append("pan_file",               panFile);
      if (aadhaarFile)     formData.append("aadhaar_file",           aadhaarFile);
      if (chequeFile)      formData.append("cancelled_cheque_file",  chequeFile);
      if (bankFile)        formData.append("bank_statement_file",    bankFile);
      if (resumeFile)      formData.append("resume_file",            resumeFile);
      if (offerLetterFile) formData.append("offer_letter_file",      offerLetterFile);

      await api.put(`/employees/${employee.id}`, formData);
      await persistShiftAndAssets(employee.id);
      setDialog({ type: 'success', title: 'Employee Updated', message: 'Employee details have been updated successfully.', autoClose: 2000 });
      setTimeout(() => {
        if (setSelectedEmployee) setSelectedEmployee(null);
        setPage("EmployeesData");
      }, 2100);

    } catch (err) {
      const errMsg =
        err.response?.data?.error ||
        err.response?.data?.message ||
        (typeof err.response?.data === 'string' ? err.response.data : null) ||
        err.message ||
        'Error saving employee';
      setDialog({ type: 'error', title: 'Save Failed', message: errMsg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="add-employee-page">
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />

      <div className="page-container">
        <div className="page-header">
          <h1>Edit Employee</h1>
          <button className="add-page-back-btn" onClick={() => {
            if (setSelectedEmployee) setSelectedEmployee(null);
            setPage("EmployeesData");
          }}>
            ← Back
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); saveEmployee(); }} className="add-employee-form">
          <div className="form-wrapper">

{/* BASIC INFO */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("basic")}>
    <h2>Basic Information</h2>
  </div>
  {openSection === "basic" && (
    <div className="accordion-body">
      <div className="form-grid">
        <div><label>Employee ID</label><input value={employeeCode || "—"} disabled /></div>
        <div><label>First Name *</label><input value={firstName} onChange={e=>setFirstName(e.target.value)} /></div>
        <div><label>Last Name *</label><input value={lastName} onChange={e=>setLastName(e.target.value)} /></div>
        <div><label>Company Email / Gmail *</label><input type="email" required value={companyEmail} onChange={e=>setCompanyEmail(e.target.value)} /></div>
        <div><label>Personal Email</label><input value={personalEmail} onChange={e=>setPersonalEmail(e.target.value)} /></div>
        <div>
          <label>Personal Phone</label>
          <input type="tel" pattern="[0-9]*" inputMode="numeric" value={phone} onChange={e=>setPhone(e.target.value)} />
        </div>
        <div>
          <label>Company Phone</label>
          <input type="tel" pattern="[0-9]*" inputMode="numeric" value={companyPhone} onChange={e=>setCompanyPhone(e.target.value)} />
        </div>
        <div><label>DOB</label><input type="date" value={dob} onChange={e=>setDob(e.target.value)} /></div>
        <div>
          <label>Gender</label>
          <select value={gender} onChange={e=>setGender(e.target.value)}>
            <option value="">-- Select Gender --</option>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
          </select>
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
          <select value={maritalStatus} onChange={e=>setMaritalStatus(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"basic")}>
            <option value="" disabled>-- Select Marital Status --</option>
            <option>Single</option><option>Married</option>
            <option>Divorced</option><option>Widowed</option>
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
        <div>
          <label>Anniversary Date</label>
          <input type="date" value={anniversaryDate} onChange={e=>setAnniversaryDate(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"family")} />
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
        <div>
          <label>Permanent Address</label>
          <textarea value={permanentAddress} onChange={e=>setPermanentAddress(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"address")} />
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
          <select value={basicQualification} onChange={e=>setBasicQualification(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"education")}>
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
        <div><label>Designation</label>
          <select value={designation} onChange={e=>setDesignation(e.target.value)}>
            <option value="" disabled>-- Select Designation --</option>
            {designationList.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label>Role</label>
          <select value={employeeRole} onChange={e=>setEmployeeRole(e.target.value)}>
            <option value="" disabled>-- Select Role --</option>
            {employeeRoles.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label>Reporting Manager</label>
          <select value={reportingManagerId} onChange={e => {
            const id = e.target.value;
            setReportingManagerId(id);
            const mgr = managers.find(m => String(m.id) === id);
            setReportingManagerName(mgr ? `${mgr.first_name} ${mgr.last_name}`.trim() : '');
          }}>
            <option value="">— None —</option>
            {managers.filter(m => m.id !== employee?.id).map(m => (
              <option key={m.id} value={String(m.id)}>{m.first_name} {m.last_name}</option>
            ))}
          </select>
        </div>
        <div><label>Location</label><input value={location} onChange={e=>setLocation(e.target.value)} /></div>
        <div>
          <label>Shift</label>
          <select value={shiftId} onChange={e=>setShiftId(e.target.value)}>
            <option value="">-- Select Shift --</option>
            {shifts.map(s => (
              <option key={s.id} value={String(s.id)}>
                {s.name}{s.start_time ? ` (${String(s.start_time).slice(0,5)}–${String(s.end_time).slice(0,5)})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Employment Type</label>
          <select value={employmentType} onChange={e=>setEmploymentType(e.target.value)}>
            <option value="" disabled>-- Select Type --</option>
            {employmentTypes.map(t => <option key={t}>{t}</option>)}
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
          <label>Field Employee</label>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontWeight:400, cursor:'pointer', marginTop:6 }}>
            <input type="checkbox" checked={isFieldEmployee}
              onChange={e=>setIsFieldEmployee(e.target.checked)}
              style={{ width:16, height:16 }} />
            Exempt from shift-time &amp; location clock-in rules
          </label>
        </div>
        <div>
          <label>Zone</label>
          <input
            list="zone-options"
            value={zone}
            onChange={e=>setZone(e.target.value)}
            placeholder="Select or type a new zone"
          />
          <datalist id="zone-options">
            {zones.map(z => <option key={z} value={z} />)}
          </datalist>
        </div>
        <div>
          <label>Joining Date</label>
          <input type="date" value={joiningDate} onChange={e=>setJoiningDate(e.target.value)} />
        </div>
        <div>
          <label>Status</label>
          <select value={status} onChange={e=>setStatus(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"job")}>
            <option value="Active">Active</option>
            <option value="Probation">Probation</option>
            <option value="Notice">On Notice</option>
            <option value="Inactive">Inactive</option>
          </select>
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
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isFresher}
            onChange={e => {
              setIsFresher(e.target.checked);
              if (e.target.checked) {
                setPreviousCompany1(''); setPreviousRole1(''); setPreviousYears1('');
                setPreviousCompany2(''); setPreviousRole2(''); setPreviousYears2('');
              }
            }}
          />
          Fresher (no previous experience)
        </label>
      </div>
      {!isFresher && (
        <div className="form-grid">
          <div><label>Company 1</label><input value={previousCompany1} onChange={e=>setPreviousCompany1(e.target.value)} /></div>
          <div><label>Role 1</label><input value={previousRole1} onChange={e=>setPreviousRole1(e.target.value)} /></div>
          <div><label>Years 1</label><input type="number" value={previousYears1} onChange={e=>setPreviousYears1(e.target.value)} /></div>
          <div><label>Company 2</label><input value={previousCompany2} onChange={e=>setPreviousCompany2(e.target.value)} /></div>
          <div><label>Role 2</label><input value={previousRole2} onChange={e=>setPreviousRole2(e.target.value)} /></div>
          <div>
            <label>Years 2</label>
            <input type="number" value={previousYears2} onChange={e=>setPreviousYears2(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"experience")} />
          </div>
        </div>
      )}
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
        <div>
          <label>Nominee</label>
          <input value={nomineeName} onChange={e=>setNomineeName(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"bank")} />
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
        <div>
          <label>ESIC Number</label>
          <input value={esicNumber} onChange={e=>setEsicNumber(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"compliance")} />
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
          <select value={emergencyRelationship} onChange={e=>setEmergencyRelationship(e.target.value)} onKeyDown={e=>handleLastFieldTab(e,"emergency")}>
            <option value="" disabled>-- Select Relationship --</option>
            {relationships.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
    </div>
  )}
</div>

{/* ASSETS ALLOCATED */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("assets")}>
    <h2>Assets Allocated</h2>
  </div>
  {openSection === "assets" && (
    <div className="accordion-body">
      {existingAssets.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Already allocated</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {existingAssets.map(a => (
              <span key={a.id} style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 20, padding: '4px 12px', fontSize: 12, color: '#374151' }}>
                {a.asset_type}: {a.asset_name}{a.asset_tag ? ` (${a.asset_tag})` : ''}
                {a.status && a.status !== 'allocated' ? ` — ${a.status}` : ''}
              </span>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0 0' }}>
            Manage returns and full history on the Employee Assets page. Add new allocations below.
          </p>
        </div>
      )}

      {assetRows.map((row, idx) => (
        <div key={idx} className="form-grid" style={{ alignItems: 'end', marginBottom: 10 }}>
          <div>
            <label>Asset Type</label>
            <select value={row.asset_type} onChange={e => updateAssetRow(idx, 'asset_type', e.target.value)}>
              {ASSET_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Asset Name / Description</label>
            <input value={row.asset_name} placeholder="e.g. Dell Latitude 5440, Airtel SIM 98xxxx"
                   onChange={e => updateAssetRow(idx, 'asset_name', e.target.value)} />
          </div>
          <div>
            <label>Asset Tag</label>
            <input value={row.asset_tag} placeholder="e.g. IT-0042"
                   onChange={e => updateAssetRow(idx, 'asset_tag', e.target.value)} />
          </div>
          <div>
            <label>Serial / Number</label>
            <input value={row.serial_number} placeholder="Serial no. / SIM no."
                   onChange={e => updateAssetRow(idx, 'serial_number', e.target.value)} />
          </div>
          <div>
            <button type="button" onClick={() => removeAssetRow(idx)}
              style={{ padding: '9px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: 'transparent', color: '#dc2626', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              Remove
            </button>
          </div>
        </div>
      ))}

      <button type="button" onClick={addAssetRow}
        style={{ padding: '8px 14px', borderRadius: 6, border: '1px dashed #6B3FDB', background: 'transparent', color: '#6B3FDB', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>
        + Add another asset
      </button>
      <p style={{ fontSize: 11, color: '#9ca3af', margin: '10px 0 0' }}>
        Leave rows blank to skip. Each named asset is recorded against this employee and appears on the Employee Assets page.
      </p>
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
        <span>Photo {(employee?.photo_url || photoFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" accept="image/*" onChange={e=>setPhotoFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>PAN {(employee?.pan_file || panFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setPanFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>Aadhaar {(employee?.aadhaar_file || aadhaarFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setAadhaarFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>Cheque {(employee?.cancelled_cheque_file || chequeFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setChequeFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>Bank Statement {(employee?.bank_statement_file || bankFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setBankFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>Resume {(employee?.resume_file || resumeFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setResumeFile(e.target.files[0])} />
      </div>
      <div className="upload-box">
        <span>Offer Letter {(employee?.offer_letter_file || offerLetterFile) && <span style={{color:"green",fontWeight:"bold"}}>✓</span>}</span>
        <input type="file" onChange={e=>setOfferLetterFile(e.target.files[0])} onKeyDown={e=>handleLastFieldTab(e,"docs")} />
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
        onChange={e=>setNotes(e.target.value)}
      />
    </div>
  )}
</div>

          </div>
          <button type="submit" className="save-btn" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </form>
      </div>
    </div>
  );
}