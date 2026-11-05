import { useState, useEffect } from "react";
import { Users } from 'lucide-react';
import api from "@/services/api/client";
import { WRITABLE_STATUSES, STATUS_LABELS, canonicalWritableStatus } from '../employeeStatus';
import ResultDialog from "@/components/ResultDialog";
import MasterSelect from "@/components/core/MasterSelect";
import VocabSelect from "@/components/core/VocabSelect";
import BranchSelect from "@/components/core/BranchSelect";
import "./AddEmployee.css";
import "./EmployeesData.css";
import { PageHero, PageShell, LoadingState, LoadError } from '@/components/pulse-ui';
import { loadEmployeeImage, isExternalUrl, openEmployeeFile } from '../shared/employeeFiles';
import { pickCurrentRevision, salaryInputValue } from '../shared/salaryRevision';
import { useAuth } from '@/context/AuthContext';

/**
 * Validated fields in the order the form presents them, with the accordion
 * section and the DOM id of the control. Used to jump to the FIRST problem.
 *
 * Order matters and matches the section order below — walking the errors object
 * instead would follow insertion order, which is the order the checks happen to
 * be written in, not the order the user reads.
 */
const FIELD_ORDER = [
  { key: 'firstName',     section: 'basic',      id: 'ae-first-name' },
  { key: 'lastName',      section: 'basic',      id: 'ae-last-name' },
  { key: 'companyEmail',  section: 'basic',      id: 'ae-company-email' },
  { key: 'personalEmail', section: 'basic',      id: 'ae-personal-email' },
  { key: 'phone',         section: 'basic',      id: 'ae-phone' },
  { key: 'department',    section: 'job',        id: 'ae-department' },
  { key: 'designation',   section: 'job',        id: 'ae-designation' },
  { key: 'joiningDate',   section: 'job',        id: 'ae-joining-date' },
  { key: 'status',        section: 'job',        id: 'ae-status' },
  { key: 'probationMonths', section: 'job',      id: 'ae-probation-months' },
  { key: 'probationEnd',  section: 'job',        id: 'ae-probation-end' },
  { key: 'basicSalary',      section: 'job',        id: 'ae-basic-salary' },
  { key: 'specialAllowance', section: 'job',        id: 'ae-special-allowance' },
  { key: 'previousYears1', section: 'experience', id: 'ae-prev-years-1' },
  { key: 'previousYears2', section: 'experience', id: 'ae-prev-years-2' },
  { key: 'panNumber',     section: 'compliance', id: 'ae-pan' },
  { key: 'aadhaarNumber', section: 'compliance', id: 'ae-aadhaar' },
  // Mandatory since §202 — payroll cannot pay without them.
  { key: 'currentAddress', section: 'address',   id: 'ae-current-address' },
  { key: 'accountNumber', section: 'bank',       id: 'ae-account-number' },
  { key: 'ifscCode',      section: 'bank',       id: 'ae-ifsc' },
];

/**
 * The seven upload slots, in the order the Documents section shows them.
 * `field` is the multipart name the API takes; `column` is where the stored
 * path lives on the employee row (only the photo's differ). Edit mode reads
 * `column` to show what is already on file, and names `field` in
 * `remove_files` to clear it.
 */
const DOC_SLOTS = [
  { field: 'photo_file',            column: 'photo_url',             label: 'Photo', accept: 'image/*' },
  { field: 'pan_file',              column: 'pan_file',              label: 'PAN' },
  { field: 'aadhaar_file',          column: 'aadhaar_file',          label: 'Aadhaar' },
  { field: 'cancelled_cheque_file', column: 'cancelled_cheque_file', label: 'Cheque' },
  { field: 'bank_statement_file',   column: 'bank_statement_file',   label: 'Bank Statement' },
  { field: 'resume_file',           column: 'resume_file',           label: 'Resume' },
  { field: 'offer_letter_file',     column: 'offer_letter_file',     label: 'Offer Letter' },
];

/** The red asterisk. aria-hidden — the control's own `required` carries the
 *  meaning for a screen reader, and "star" read aloud mid-label does not. */
const Req = () => <span className="req" aria-hidden="true">*</span>;

/**
 * One form cell: label, control, and the field's error line.
 *
 * ⚠⚠ DEFINED AT MODULE LEVEL, AND IT MUST STAY THERE.
 *
 * This was declared INSIDE AddEmployee, which is a component-identity bug with
 * a very misleading symptom. A component declared in a render body is a NEW
 * function on every render, so React treats it as a different component type,
 * unmounts the entire subtree and mounts a fresh one. Every field wrapped in
 * <Field> was therefore destroyed and re-created on EVERY keystroke anywhere on
 * the form — which meant each MasterSelect re-ran its fetch, lost its open
 * menu, lost its search text and lost the "added successfully" message it had
 * just set. The visible bug was "the success message never appears"; the actual
 * bug was that the picker had been remounted out from under it.
 *
 * It closes over nothing, so hoisting is a pure move.
 */
const Field = ({ id, label, required = false, error, children, className = '' }) => (
  <div className={`${error ? 'is-invalid ' : ''}${className}`.trim() || undefined}>
    <label htmlFor={id}>{label}{required && <Req />}</label>
    {children}
    {error && <span className="field-error" id={`${id}-err`} role="alert">{error}</span>}
  </div>
);

/**
 * ONE form for both Add and Edit Employee.
 *
 * Edit mode is `employee` set. EditEmployee.jsx is only a loader: it fetches
 * the FULL record (the All Employees row is a list projection and is missing
 * fields) plus the salary revisions, then mounts this component with them —
 * every useState below seeds from `employee` once, at mount, so the data has
 * to be complete before this renders.
 *
 * `salaryRevisions`: an array when they were loaded (possibly empty), anything
 * else when they could not be — and then the salary cannot be corrected here,
 * because a correction must name the revision it changes.
 */
function EmployeeForm({ setPage, employee, setSelectedEmployee, salaryRevisions, seed = null, conversion = null }) {
  // Initial values: the record being edited, else (Convert to Employee) the
  // pre-fill from the intern record, else blank. `employee` alone still means
  // EDIT mode everywhere below; `seed` only ever supplies starting values.
  const src = employee || seed;

  // Helper to format date from database
  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const [notes,setNotes] = useState(src?.notes || "");
  const [openSection, setOpenSection] = useState("basic");
  const [managers, setManagers]=useState([]);
  const [dialog, setDialog] = useState(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * Latched on a SUCCESSFUL save and never cleared.
   *
   * `saving` alone did not prevent a duplicate submission. The success path
   * schedules the redirect with setTimeout and then falls through to
   * `finally { setSaving(false) }`, which runs immediately — so for the 2.1s
   * (6s when a login was created) that the confirmation dialog is on screen,
   * the Save button behind it was enabled again and a second click POSTed a
   * second employee. The unique index on company_email turns that into a 409
   * rather than a duplicate person, but a 409 after a successful save reads as
   * "it failed", which is worse than the button simply staying down.
   */
  const [submitted, setSubmitted] = useState(false);
  /**
   * field key -> message. Rendered under the field AND used to mark it, so the
   * answer to "which one is wrong?" is on the control rather than only in a
   * modal the user has to dismiss before they can look.
   */
  const [fieldErrors, setFieldErrors] = useState({});
  const clearFieldError = (key) =>
    setFieldErrors(e => (e[key] ? { ...e, [key]: undefined } : e));
  // Counts only LIVE errors. clearFieldError sets a key to undefined rather
  // than deleting it, so Object.keys().length would keep counting a field the
  // user has already fixed.
  const errorCount = Object.values(fieldErrors).filter(Boolean).length;

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

  /** Tab off the last field of a section opens the next one. */
  const handleLastFieldTab = (e, sectionName) => {
    if (e.key === "Tab" && !e.shiftKey) goToNextSection(sectionName);
  };

  // 🆔 Employee Code from backend
  const [employeeCode, setEmployeeCode] = useState(employee?.office_id || "");
  // Distinguishes "still asking the server" from "asked, and it is up to the
  // server at save time". Without it the field cannot tell the two apart.
  const [codeState, setCodeState] = useState('loading');

  // Hoisted before useEffect to satisfy React Compiler declaration order.
  // Departments, zones and designations are no longer fetched here — each of
  // those pickers is a <MasterSelect>, which owns its own fetch and can add to
  // the master inline instead of sending the user to Master Data Setup.
  const [shifts, setShifts] = useState([]);

  // SHIFT — persisted as an hr_shift_assignment after the employee is saved.
  const [shiftId, setShiftId] = useState("");
  // Loaded in edit mode: the currently-assigned shift and its assignment row id,
  // so a shift change can retire the old assignment and skip a no-op re-create.
  const [originalShiftId, setOriginalShiftId] = useState("");
  const [existingShiftAssignmentId, setExistingShiftAssignmentId] = useState(null);

  // ASSETS — laptop / SIM / phone etc. Each row with an asset_name is created
  // via POST /employee-assets once the employee record exists.
  // Asset types were this same thirteen-item array in three places (here,
  // EditEmployee, HR EmployeeAssets). Now the asset-type master.
  const blankAsset = () => ({ asset_type: 'Laptop', asset_name: '', asset_tag: '', serial_number: '' });
  const [assetRows, setAssetRows] = useState([blankAsset()]);
  const [existingAssets, setExistingAssets] = useState([]);
  // As loaded, so only an allocation the user actually changed is PUT back.
  const [originalAssets, setOriginalAssets] = useState([]);
  const updateExistingAsset = (id, key, val) =>
    setExistingAssets(rows => rows.map(a => a.id === id ? { ...a, [key]: val } : a));

  // 👨‍💼 Fetch managers safely
 useEffect(()=>{
  const EX_STATUSES_LOWER = new Set(['left','terminated','resigned','ex-employee','notice_period','notice period','inactive']);
  api.get("/employees")
    .then(res => setManagers(
      (Array.isArray(res.data) ? res.data : [])
        .filter(e => !EX_STATUSES_LOWER.has((e.status || '').toLowerCase()))
    ))
    .catch(() => {});

  // Shift master for the Job Information shift picker
  api.get('/hr/shifts')
    .then(res => setShifts(Array.isArray(res.data) ? res.data : []))
    .catch(() => setShifts([]));

  // In edit mode, preload the employee's current shift + allocated assets so
  // they show in the form and a shift change can retire the old assignment.
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
      .then(res => {
        const rows = Array.isArray(res.data) ? res.data : [];
        setExistingAssets(rows);
        setOriginalAssets(rows);
      })
      .catch(() => {});
  }

  if (!employee) {
    /**
     * Prefill the Employee ID the server will use.
     *
     * Displayed as a read-only preview, and NOT reformatted here: the endpoint
     * is now the single authority on the format, and the local reformatting this
     * replaces ('EMP' + digits, padded to 4) was a fourth ID generator hiding in
     * a .catch(). So was the fallback beneath it, which scanned the whole
     * employee list for a max and would happily mint a code that already
     * existed under a different company.
     *
     * On failure the field is simply left blank. addEmployee() mints the real
     * code inside its own transaction, so a blank here produces a correct ID —
     * whereas a locally-invented one now fails the format CHECK and the
     * per-company unique index.
     */
    api.get("/employees/next-code")
      .then(res => {
        const code = res.data?.code;
        setEmployeeCode(typeof code === 'string' ? code : "");
      })
      .catch(() => setEmployeeCode(""))
      .finally(() => setCodeState('settled'));
  }

},[employee]);

  // BASIC
  const [firstName,setFirstName]=useState(src?.first_name || "");
  const [lastName,setLastName]=useState(src?.last_name || "");
  const [companyEmail,setCompanyEmail]=useState(src?.company_email || "");
  const [personalEmail,setPersonalEmail]=useState(src?.personal_email || "");
  const [phone,setPhone]=useState(src?.phone || "");
  const [companyPhone,setCompanyPhone]=useState(src?.company_phone || "");
  const [gender,setGender]=useState(src?.gender || "");
  const [bloodGroup,setBloodGroup]=useState(src?.blood_group || "");
  const [dob,setDob]=useState(formatDate(src?.dob));
  const [maritalStatus,setMaritalStatus]=useState(src?.marital_status || "");

  // FAMILY
  const [fatherName,setFatherName]=useState(src?.father_name || "");
  const [motherName,setMotherName]=useState(src?.mother_name || "");
  const [spouseName,setSpouseName]=useState(src?.spouse_name || "");
  const [anniversaryDate,setAnniversaryDate]=useState(formatDate(employee?.anniversary_date));

  // ADDRESS
  const [currentAddress,setCurrentAddress]=useState(src?.current_address || "");
  const [permanentAddress,setPermanentAddress]=useState(src?.permanent_address || "");

  // EDUCATION
  const [highestQualification,setHighestQualification]=useState(src?.highest_qualification || "");
  const [basicQualification,setBasicQualification]=useState(src?.basic_qualification || "");

  // JOB
  const [department,setDepartment] = useState(employee?.department || "");
  const [designation,setDesignation]=useState(employee?.designation || "");
  // Grade and band validate against master_grades / master_bands server-side
  // (employee.service.js validateMasterValue) and the columns have existed all
  // along — there was simply no field on any form, so every employee row held
  // NULL for both and the two master tabs had no consumer at all.
  const [grade,setGrade]=useState(employee?.grade || "");
  const [band,setBand]=useState(employee?.band || "");
  const [employeeRole,setEmployeeRole]=useState(employee?.employee_role || "");
  const [reportingManagerId,setReportingManagerId]=useState(employee?.reporting_manager_id ? String(employee.reporting_manager_id) : "");
  const [reportingManagerName,setReportingManagerName]=useState(employee?.reporting_manager || "");
  // LOCATION — `branch_id` is what is stored and validated; `location` is the
  // branch's display name, kept because EmployeeProfile, the All Employees
  // column and the export all read it as a plain string. See BranchSelect.
  const [branchId,setBranchId]=useState(employee?.branch_id ? String(employee.branch_id) : "");
  const [location,setLocation]=useState(employee?.location || "");
  const [employmentType,setEmploymentType]=useState(employee?.employment_type || "");
  const [skillType,setSkillType]=useState(employee?.skill_type || "");
  // WORKFORCE CATEGORY — an id (employees.workforce_category_id, FK to the
  // WORKFORCE_CATEGORY master), like branch_id. '' means none.
  const [workforceCategoryId,setWorkforceCategoryId]=useState(
    employee?.workforce_category_id != null ? String(employee.workforce_category_id) : "");
  const [isFieldEmployee,setIsFieldEmployee]=useState(employee?.is_field_employee === true);
  // ZONE — like Location, the id is canonical and the text is the display
  // value. `zone_id` (FK -> master_zones) was NULL on all 46 live rows while
  // the text column carried the value; `holidays.zone_id` is a real consumer,
  // so a zone that exists only as text cannot be given a holiday.
  const [zone,setZone]=useState(employee?.zone || "");
  const [zoneId,setZoneId]=useState(employee?.zone_id ? String(employee.zone_id) : "");

  // A stored status outside WRITABLE_STATUSES (legacy spellings such as
  // 'terminated') is shown as-is and, if left untouched, NOT sent — the API
  // would refuse it, and refusing the whole edit over a field the user never
  // changed is worse than leaving it alone.
  const originalStatus = employee?.status || '';
  const [status,setStatus]=useState(employee ? (canonicalWritableStatus(employee.status) || employee.status || 'Active') : 'Active');
  const legacyStatus = employee && originalStatus && !canonicalWritableStatus(originalStatus) ? originalStatus : null;
  // Containment C6 / MD-14: 'Left' is reached only through Exit Management (the
  // server refuses it here). It stays in the list only for a record that is
  // already Left, so editing an ex-employee does not force a status change.
  const alreadyLeft = canonicalWritableStatus(originalStatus) === 'Left';
  const statusOptions = WRITABLE_STATUSES.filter(v => v !== 'Left' || alreadyLeft);
  const today = new Date().toISOString().split("T")[0];
  // Today is a default for a NEW hire only. On an existing record with no
  // joining date it would be silently saved as "joined today" — the field is
  // left blank instead and the required check asks for the real date.
  const [joiningDate,setJoiningDate] = useState(employee ? formatDate(employee?.joining_date) : today);

  // PROBATION — employees.probation_end_date is the canonical end date, and
  // the SERVER calculates it (backend shared/probationDates.js) from the
  // joining date and a period in calendar months. This form never computes a
  // date itself: it shows the server's preview (GET /probation/calculate) and
  // sends the PERIOD, plus an end date only when HR typed one by hand.
  //
  // ⚠ Edit mode sends every other field on every save. Probation keys are
  // sent only when the user changed them here (probationDirty), so an
  // unrelated edit can never rewrite a saved end date — including one set by
  // hand. A changed joining date does NOT silently move it either: the form
  // offers "Recalculate" and the person saving sees the new date first.
  const storedProbationEnd = employee?.probation_end_date ? String(employee.probation_end_date).slice(0, 10) : '';
  const [probationMonths,setProbationMonths] = useState(employee?.probation_months != null ? String(employee.probation_months) : '');
  const [probationEnd,setProbationEnd] = useState(storedProbationEnd);
  const [probationDirty,setProbationDirty] = useState(false);
  const [probationManual,setProbationManual] = useState(false);
  const [probationPreview,setProbationPreview] = useState(null);   // { probation_end_date, probation_months, policy } | { error }
  const showProbation = status === 'Probation' || probationDirty || (!!employee && (!!storedProbationEnd || probationMonths !== ''));
  // Create: follow the joining date and period live. Edit: only once the user
  // has changed a probation field (or asked to recalculate).
  const probationAuto = showProbation && !probationManual && (!employee || probationDirty);
  const joiningMovedFromStored = !!employee && !!storedProbationEnd
    && joiningDate !== formatDate(employee?.joining_date) && !probationDirty;

  useEffect(() => {
    if (!probationAuto || !joiningDate) return undefined;
    if (probationMonths !== '' && !/^\d+$/.test(String(probationMonths).trim())) return undefined;
    let cancelled = false;
    api.get('/probation/calculate', {
      params: { joining_date: joiningDate, ...(probationMonths !== '' ? { months: probationMonths } : {}) },
    }).then(({ data }) => {
      if (cancelled) return;
      setProbationPreview(data);
      setProbationEnd(data.probation_end_date || '');
      // Make the period explicit — the company default becomes the value sent.
      if (probationMonths === '' && data.probation_months != null) setProbationMonths(String(data.probation_months));
    }).catch((err) => {
      if (cancelled) return;
      // No preview (e.g. a role without HR view): the server still calculates
      // the same date on save, so only the preview is missing.
      setProbationPreview({ error: err?.response?.data?.error || 'Preview unavailable — the end date is calculated when you save.' });
    });
    return () => { cancelled = true; };
  }, [probationAuto, joiningDate, probationMonths]);

  // EXPERIENCE
  const [isFresher, setIsFresher] = useState(false);
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
  const [emergencyName,setEmergencyName]=useState(src?.emergency_name || "");
  const [emergencyPhone,setEmergencyPhone]=useState(src?.emergency_phone || "");
  const [emergencyRelationship,setEmergencyRelationship]=useState(src?.emergency_relationship || "");

  // COMPLIANCE
  const [panNumber,setPanNumber]=useState(employee?.pan_number || "");
  const [aadhaarNumber,setAadhaarNumber]=useState(employee?.aadhaar_number || "");
  const [pfNumber,setPfNumber]=useState(employee?.pf_number || "");
  const [uanNumber,setUanNumber]=useState(employee?.uan_number || "");
  const [esicNumber,setEsicNumber]=useState(employee?.esic_number || "");

  // COMPENSATION
  // Create: the first revision, effective the joining date.
  // Edit: a CORRECTION to the revision in force today, made in place by id —
  // never a second revision for the same effective date. See salaryRevision.js
  // and updateEmployee in the backend service.
  const currentRevision = employee ? pickCurrentRevision(salaryRevisions) : null;
  // Setting or correcting the salary is payroll:edit (PC-01 closure decision 5);
  // without it the employee is created / edited with no salary fields at all —
  // the server refuses a salary it is sent, it never drops one silently.
  const { hasPermission } = useAuth();
  const canEditSalary = typeof hasPermission === 'function' && hasPermission('payroll', 'edit');
  const salaryEditable = canEditSalary && (!employee || Array.isArray(salaryRevisions));
  const initialBasic = salaryInputValue(currentRevision?.basic_salary);
  const initialAllowance = salaryInputValue(currentRevision?.special_allowance);
  const [basicSalary,setBasicSalary]=useState(initialBasic);
  const [specialAllowance,setSpecialAllowance]=useState(initialAllowance);

  // FILES
  // Upload fields the user has asked to clear on save (edit mode only). A file
  // on record that is neither replaced nor named here is left exactly as it is.
  const [removeFiles, setRemoveFiles] = useState(() => new Set());
  const toggleRemoveFile = (field) => setRemoveFiles(prev => {
    const next = new Set(prev);
    if (next.has(field)) next.delete(field); else next.add(field);
    return next;
  });
  const [fileError, setFileError] = useState('');
  // field -> File chosen in this session. Choosing a file for a slot also
  // cancels a pending removal of that slot — the new file replaces the old.
  const [docFiles, setDocFiles] = useState({});
  const setDocFile = (field, file) => {
    setDocFiles(d => ({ ...d, [field]: file || null }));
    if (file) setRemoveFiles(prev => { if (!prev.has(field)) return prev; const n = new Set(prev); n.delete(field); return n; });
  };
  const photoFile = docFiles.photo_file || null;
  // A file <input> is uncontrolled, so "Clear selection" remounts it (new key)
  // or it would keep displaying the name of a file that will not be sent.
  const [inputGen, setInputGen] = useState({});
  const [photoPreview,setPhotoPreview]=useState(null);
  // The stored photo to preview: the employee's own, or (conversion) the
  // intern's, which the server reuses unless a new one is chosen.
  const storedPhoto = employee?.photo_url || conversion?.photo_url || null;

  // Photo preview: a freshly chosen file becomes an object URL; otherwise fall
  // back to the stored photo, which has to be fetched with the JWT because the
  // only route that serves uploads (/files/:filename) requires one. Both kinds
  // of URL are released when this effect re-runs or the form unmounts.
  useEffect(() => {
    let revoke = null;
    let cancelled = false;
    if (photoFile) {
      revoke = URL.createObjectURL(photoFile);
      setPhotoPreview(revoke);
    } else if (storedPhoto) {
      loadEmployeeImage(storedPhoto).then(url => {
        if (cancelled) { if (url && !isExternalUrl(storedPhoto)) URL.revokeObjectURL(url); return; }
        if (url && !isExternalUrl(storedPhoto)) revoke = url;
        setPhotoPreview(url);
      });
    } else {
      setPhotoPreview(null);
    }
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [photoFile, storedPhoto]);


  const employeeRoles = ["Employee","Manager","Department Head"];
  // Employment type, skill type and qualification are masters now, not arrays.
  // employees.employment_type had been written by TWO vocabularies — this page's
  // ('Permanent'/'Probation'/'Contract') and recruitment's ('full_time'…) — so
  // the column holds both spellings. Both sets are seeded into the master so no
  // existing record is orphaned; see backend/src/modules/master/vocabularies.js.
  const relationships = ["Father","Mother","Spouse","Brother","Sister","Friend"];


  // ── ASSET ROW HELPERS ──────────────────────────────────────────────
  const updateAssetRow = (idx, key, val) =>
    setAssetRows(rows => rows.map((r, i) => i === idx ? { ...r, [key]: val } : r));
  const addAssetRow    = () => setAssetRows(rows => [...rows, blankAsset()]);
  const removeAssetRow = (idx) =>
    setAssetRows(rows => rows.length > 1 ? rows.filter((_, i) => i !== idx) : [blankAsset()]);

  // Persist shift assignment + asset allocations for a saved employee. Best-effort:
  // the employee is already saved, so a failure here only skips the extra records.
  const persistShiftAndAssets = async (employeeId) => {
    const failures = [];
    if (!employeeId) return failures;
    // Shift — only touch assignments when a shift is selected and it changed.
    try {
      if (shiftId && String(shiftId) !== String(originalShiftId)) {
        // Retire any current active assignment before adding the new one so the
        // attendance shift-resolver doesn't see two active assignments.
        if (existingShiftAssignmentId) {
          await api.delete(`/hr/shift-assignments/${existingShiftAssignmentId}`).catch(() => {});
        }
        await api.post('/hr/shift-assignments', {
          employee_id: employeeId,
          shift_id: Number(shiftId),
          effective_from: joiningDate || today,
        });
      }
    } catch { failures.push('the shift assignment'); }

    // Existing allocations the user edited (edit mode). Only changed rows.
    for (const a of existingAssets) {
      const was = originalAssets.find(o => o.id === a.id);
      if (!was) continue;
      const changed = ['asset_type', 'asset_name', 'asset_tag', 'serial_number']
        .some(k => String(a[k] ?? '') !== String(was[k] ?? ''));
      if (!changed) continue;
      try {
        await api.put(`/employee-assets/${a.id}`, {
          asset_type: a.asset_type || null,
          asset_name: String(a.asset_name || '').trim() || null,
          asset_tag: a.asset_tag || null,
          serial_number: a.serial_number || null,
        });
      } catch { failures.push(`asset "${a.asset_name || a.id}"`); }
    }

    // Assets — create one allocation per filled row.
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
      } catch { failures.push(`new asset "${r.asset_name.trim()}"`); }
    }
    return failures;
  };

  /**
   * Create: the figures as entered. Edit: only when they CHANGED, together with
   * the id of the revision being corrected — an unchanged salary sends nothing,
   * so saving an unrelated field never touches a revision.
   */
  const salaryPayload = () => {
    if (!employee) return salaryEditable ? { basic_salary: basicSalary, special_allowance: specialAllowance } : {};
    if (!salaryEditable) return {};
    const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim()
      || (String(a ?? '').trim() !== '' && String(b ?? '').trim() !== '' && Number(a) === Number(b));
    if (same(basicSalary, initialBasic) && same(specialAllowance, initialAllowance)) return {};
    return {
      basic_salary: basicSalary,
      special_allowance: specialAllowance,
      ...(currentRevision ? { salary_revision_id: currentRevision.id } : {}),
    };
  };

  // 💾 SAVE EMPLOYEE
  const addEmployee = async ()=>{
    if (saving) return;
    try{

      // Required validation.
      //
      // Department, Designation and Status are required by the API (see
      // REQUIRED_ON_CREATE in backend employee.service.js). Checking here as
      // well is not duplication for its own sake: the API's 400 arrives after a
      // full submit with files attached, and it names the field in prose rather
      // than opening the accordion section that holds it.
      //
      // Every rule below is checked here AND server-side. That is not
      // duplication for its own sake: the API's 400 arrives after a full
      // multipart submit with files attached, and it names the field in prose
      // rather than putting the message on the control inside the collapsed
      // accordion section that holds it.
      //
      // The mirror on the server is REQUIRED_ON_CREATE + the format guards in
      // backend/src/employees/employee.service.js. The two lists agree
      // field-for-field; `employeeRequiredFields.contract.test.js` is what
      // keeps them agreeing.
      //
      // ALL rules are evaluated before returning. Reporting one problem at a
      // time turns a form with three blanks into three round trips.
      const errs = {};
      const blank = (v) => !String(v ?? '').trim();

      if (blank(firstName))    errs.firstName    = 'First name is required.';
      if (blank(lastName))     errs.lastName     = 'Last name is required.';
      if (blank(companyEmail)) errs.companyEmail = 'Company email is required.';
      if (blank(department))   errs.department   = 'Select a department.';
      if (blank(designation))  errs.designation  = 'Select a designation.';
      if (blank(status))       errs.status       = 'Select an employment status.';
      if (blank(joiningDate))  errs.joiningDate  = 'Joining date is required.';
      if (showProbation && probationMonths !== '') {
        const m = String(probationMonths).trim();
        if (!/^\d+$/.test(m) || Number(m) < 1 || Number(m) > 24) {
          errs.probationMonths = 'Probation period must be a whole number of months from 1 to 24.';
        }
      }
      if (showProbation && probationManual && probationEnd && joiningDate && probationEnd < joiningDate) {
        errs.probationEnd = 'Probation end date cannot be before the joining date.';
      }

      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!errs.companyEmail && !emailRe.test(companyEmail)) {
        errs.companyEmail = 'Enter a valid email address, e.g. name@company.com.';
      }
      if (personalEmail && !emailRe.test(personalEmail)) {
        errs.personalEmail = 'Enter a valid email address, e.g. name@example.com.';
      }
      if (phone && !/^\d{10}$/.test(phone.replace(/[\s\-()]/g, ''))) {
        errs.phone = 'Phone number must be 10 digits.';
      }
      if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(panNumber.trim())) {
        errs.panNumber = 'PAN must look like ABCDE1234F.';
      }
      if (aadhaarNumber && !/^\d{12}$/.test(aadhaarNumber.replace(/\s/g, ''))) {
        errs.aadhaarNumber = 'Aadhaar must be exactly 12 digits.';
      }

      // Bank account, IFSC and current address (§202). Required on Add; on Edit
      // they may not be CLEARED once on record, but a record that never had
      // them can still be saved for other changes (the server applies the same
      // rule — employee.controller.js REQUIRED_BANK_ON_CREATE). Formats are the
      // ones payroll pays on (payrollEligibility.validateStatutoryProfile). A
      // masked number (XXXX1234, shown to HR without the bank permission) is
      // "unchanged" and not checked.
      const had = (v) => !!String(v ?? '').trim();
      const mustHave = (stored) => !employee || had(stored);
      if (blank(currentAddress) && mustHave(employee?.current_address)) errs.currentAddress = 'Current address is required.';
      if (blank(accountNumber) && mustHave(employee?.account_number)) errs.accountNumber = 'Bank account number is required.';
      else if (!blank(accountNumber) && !/^X{4}\S{1,4}$/.test(accountNumber.trim()) && !/^\d{9,18}$/.test(accountNumber.replace(/\s/g, ''))) {
        errs.accountNumber = 'Bank account number must be 9–18 digits.';
      }
      if (blank(ifscCode) && mustHave(employee?.ifsc_code)) errs.ifscCode = 'IFSC code is required.';
      else if (!blank(ifscCode) && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifscCode.trim())) {
        errs.ifscCode = 'IFSC must look like HDFC0001234.';
      }

      // Numeric ranges. Mirrors the service-layer guard exactly (SALARY_RANGE /
      // YEARS_RANGE in employees/employee.service.js) so the form says the same
      // thing the API would, rather than letting the user submit and be told.
      //
      // The years ceiling exists because `previous_years_2` held 123 on a live
      // record and View Employee showed "124 years" of total experience. An
      // empty field is "not stated" and stays valid.
      const range = (raw, key, label, min, max, integer) => {
        const v = String(raw ?? '').trim();
        if (!v) return;
        const n = Number(v);
        if (!Number.isFinite(n)) { errs[key] = `${label} must be a number.`; return; }
        if (integer && !Number.isInteger(n)) { errs[key] = `${label} must be a whole number.`; return; }
        if (n < min || n > max) errs[key] = `${label} must be between ${min} and ${max}.`;
      };
      range(previousYears1, 'previousYears1', 'Years at company 1', 0, 60, true);
      range(previousYears2, 'previousYears2', 'Years at company 2', 0, 60, true);
      if (salaryEditable) {
        range(basicSalary, 'basicSalary', 'Basic salary', 0, 100000000, false);
        range(specialAllowance, 'specialAllowance', 'Special allowance', 0, 100000000, false);
        // A revision that exists can be corrected but not erased; one that does
        // not exist yet needs a basic figure before an allowance means anything.
        if (employee && !errs.basicSalary && !String(basicSalary).trim()
            && (currentRevision || String(specialAllowance).trim())) {
          errs.basicSalary = currentRevision
            ? 'Basic salary cannot be cleared. Correct it to the right figure.'
            : 'Enter a basic salary to record one.';
        }
      }

      setFieldErrors(errs);

      if (Object.keys(errs).length) {
        // Open the section holding the FIRST problem and focus its control. An
        // error about a field inside a collapsed accordion is an error the user
        // cannot act on, and the previous version opened 'job' unconditionally
        // whenever any job field was among the gaps — so a blank First Name
        // sent the user to the wrong section.
        const first = FIELD_ORDER.find(f => errs[f.key]);
        if (first) {
          setOpenSection(first.section);
          setTimeout(() => {
            const el = document.getElementById(first.id);
            el?.focus();
            el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 60);
        }
        // ⚠ Deliberately NO modal for a CLIENT-side validation failure.
        //
        // ResultDialog renders a full-page `.rdlg-backdrop` that swallows
        // pointer events, so the error dialog physically blocked the form
        // until it was dismissed — the user had to close a dialog in order to
        // reach the field the dialog was pointing at. (Playwright found this:
        // the backdrop intercepted a click on an accordion header.) That was
        // tolerable when the modal was the ONLY place the problem was named;
        // now every bad field is marked, carries its own message, and the
        // first one is focused and scrolled to, with a running count in the
        // save bar. A modal on top of that is one more thing to dismiss.
        //
        // The modal is kept for the SAVE-FAILED path below, which is a real
        // event the user did not cause and cannot see anywhere else.
        return;
      }
      setSaving(true);

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
        grade,
        band,
        // Always sent, '' when None: in edit mode an ABSENT key means "leave
        // the manager alone", so leaving it out made None impossible to save.
        reporting_manager_id: reportingManagerId,
        reporting_manager: reportingManagerName || null,
        location,
        branch_id: branchId || '',
        joining_date:joiningDate,
        employment_type:employmentType,
        skill_type:skillType,
        // Always sent, '' when none — same reason as reporting_manager_id: in
        // edit mode an absent key means "leave it", so clearing needs ''.
        workforce_category_id: workforceCategoryId || '',
        is_field_employee:isFieldEmployee,
        zone,
        zone_id: zoneId || '',
        status,
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
        notes,
        ...salaryPayload(),
      };
      if (legacyStatus && status === legacyStatus) delete fields.status;
      // Probation: create sends it whenever the section applies; edit only when
      // a probation field was changed. The end date travels only when typed by
      // hand — otherwise the server calculates it from the period.
      if (showProbation && (!employee || probationDirty)) {
        if (String(probationMonths).trim() !== '') fields.probation_months = String(probationMonths).trim();
        if (probationManual && probationEnd) fields.probation_end_date = probationEnd;
      }
      if (employee && removeFiles.size) fields.remove_files = [...removeFiles].join(',');

      if (employeeRole) {
        fields.employee_role = employeeRole;
      }
      // Convert to Employee: the server re-checks eligibility, links both
      // records and reuses the intern's photo / résumé, in the same transaction.
      if (!employee && conversion) fields.from_intern_id = String(conversion.intern_id);

      // A field left out is ABSENT, not the four characters "null".
      //
      // `formData.append(k, null)` serialises to the STRING "null" — and
      // several entries above are `x || null` for "not chosen". So an untouched
      // Reporting Manager picker POSTed reporting_manager="null", which
      // assertValidManager rejected with
      //   "null" is not a valid reporting manager
      // and NO employee could be saved from this form at all without picking a
      // manager. Skipping nullish values is what `x || null` meant in the first
      // place; the backend already reads a missing field as "not provided".
      Object.entries(fields).forEach(([k,v]) => {
        if (v === null || v === undefined) return;
        formData.append(k, v);
      });

      // The zone picker used to be a free-text datalist, so a typed value was
      // best-effort POSTed to the zone master here. It is a <MasterSelect> now:
      // the value can only come from the master or from its own "Add new" —
      // either way the row already exists by the time we get here.

      for (const slot of DOC_SLOTS) {
        const f = docFiles[slot.field];
        if (f) formData.append(slot.field, f);
      }

      // Bank details go to a second HR person before they take effect (§204):
      // the save response carries the pending request, and the dialog says so.
      const bankNote = (resp) => {
        const r = resp?.bank_change_request;
        if (!r) return '';
        return r.status === 'pending'
          ? ' The bank details were sent to another HR person for approval (HR → Bank Detail Approvals) and take effect once approved.'
          : ' The bank details could not be recorded for approval — enter them again.';
      };

      let exceptional = false;
      if (employee) {
        const { data: updated } = await api.put(`/employees/${employee.id}`, formData);
        const pendingNote = bankNote(updated);
        const failures = await persistShiftAndAssets(employee.id);
        setSubmitted(true);
        exceptional = failures.length > 0;
        if (failures.length) {
          setDialog({ type:'error', title:'Employee Updated — with exceptions',
            message:`The employee record was saved, but ${failures.join(', ')} could not be saved. Re-open Edit Employee to retry.${pendingNote}` });
        } else if (pendingNote) {
          setDialog({ type:'success', title:'Employee Updated — bank details awaiting approval', message:`Employee details have been updated.${pendingNote}` });
        } else {
          setDialog({ type:'success', title:'Employee Updated', message:'Employee details have been updated successfully.', autoClose:2000 });
        }
      } else {
        const { data } = await api.post("/employees", formData);
        const failures = await persistShiftAndAssets(data?.id);
        // A converted intern lands on the new employee's profile, which links
        // back to the internship ("Previously an Intern").
        const goNext = () => {
          setSelectedEmployee(null);
          if (conversion && data?.id) {
            try { sessionStorage.setItem('selectedEmployeeId', String(data.id)); } catch { /* storage unavailable */ }
            setPage('EmployeeProfile', { id: data.id });
          } else {
            setPage("EmployeesData");
          }
        };
        // Appended, never instead: the login dialog below is how HR learns a
        // sign-in was created, so a failed asset must not replace it.
        const note = (failures.length
          ? ` However, ${failures.join(', ')} could not be saved. Open Edit Employee to add ${failures.length === 1 ? 'it' : 'them'}.`
          : '') + bankNote(data);
        exceptional = failures.length > 0;
        setSubmitted(true);
        const login = data?.login;
        if (login?.created) {
          // A login account was auto-created. No credential is shown: the API
          // no longer returns one. The employee sets their own password with
          // the sign-in page's "Forgot password?" flow, which sends a one-time
          // code to this address.
          setDialog({
            type:'success',
            title: conversion ? 'Intern Converted to Employee — Login Created' : 'Employee Added — Login Created',
            message:`${conversion ? `${conversion.intern_code} is now employee ${data?.office_id || ''}. The internship record is kept and linked. ` : ''}A sign-in account was created for ${login.email}. Ask them to open the sign-in page, choose "Forgot password?" and enter this email — they will receive a one-time code to set their own password.${note}`,
          });
          setTimeout(goNext, 6000);
          return;
        }
        const added = conversion
          ? `${conversion.intern_code} is now employee ${data?.office_id || ''}. The internship record is kept and linked.`
          : 'New employee has been added successfully.';
        const exceptionNote = failures.length ? note : '';
        setDialog(exceptionNote
          ? { type:'error', title:'Employee Added — with exceptions', message:`New employee has been added.${note}` }
          : { type:'success', title: conversion ? 'Intern Converted to Employee' : 'Employee Added', message: `${added}${bankNote(data)}`, autoClose: bankNote(data) ? 6000 : 2000 });
        setTimeout(goNext, exceptional || bankNote(data) ? 6000 : 2100);
        return;
      }
      // A dialog that reports an exception stays up long enough to be read.
      setTimeout(() => {
        setSelectedEmployee(null);
        setPage("EmployeesData");
      }, exceptional ? 6000 : 2100);

    }catch(err){
      let errMsg =
        err.response?.data?.error ||
        err.response?.data?.message ||
        (typeof err.response?.data === 'string' ? err.response.data : null) ||
        err.message ||
        'Error saving employee';
      if (/unique.*company_email|duplicate.*email|already belongs to employee/i.test(errMsg)) {
        errMsg = `An employee with email "${companyEmail}" already exists.`;
        // Put it on the field as well. A duplicate email is the single most
        // likely rejection, and a modal that names it still leaves the user
        // hunting for which of the two email boxes to change.
        setFieldErrors(e => ({ ...e, companyEmail: errMsg }));
        setOpenSection('basic');
      } else if (/is not a valid department|Select a value from the master list/i.test(errMsg) && /department/i.test(errMsg)) {
        setFieldErrors(e => ({ ...e, department: errMsg }));
        setOpenSection('job');
      } else if (/is not a valid designation/i.test(errMsg)) {
        setFieldErrors(e => ({ ...e, designation: errMsg }));
        setOpenSection('job');
      } else if (/location/i.test(errMsg)) {
        setOpenSection('job');
      }
      setDialog({ type:'error', title:'Save Failed', message: errMsg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Employees"
        title={employee ? "Edit Employee" : conversion ? "Convert Intern to Employee" : "Add Employee"}
        subtitle={employee
          ? "Update this employee's record and employment details."
          : conversion
            ? `Pre-filled from internship ${conversion.intern_code}. Review, complete the employment details and save.`
            : "Create a new employee record and complete their employment details."}
      />
    }>
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />
      <div className="page-container">
        {conversion && (
          <div role="note" style={{ margin: '0 0 14px', padding: '12px 14px', borderRadius: 10, background: '#eff6ff',
            border: '1px solid #bfdbfe', color: '#1e3a8a', fontSize: 13, lineHeight: 1.5 }}>
            <strong>Converting {conversion.name} ({conversion.intern_code}).</strong>{' '}
            Personal, contact, emergency and education details are taken from the internship record
            {conversion.photo_url ? ', and their photo is reused' : ''}{conversion.resume_file ? ', as is their résumé' : ''} —
            upload a file only to replace it. Enter the employment details: department, designation, reporting manager,
            employment type, joining date, salary, location / branch, zone and company email. The Employee ID (EMPxxx) is
            assigned when you save; the internship record stays as history and is linked both ways.
          </div>
        )}
        {/*
          ⚠ NO page-level Back button here. The standard back control in Pulse
          is the Topbar's, on every page — this page used to draw a second one
          six pixels below it doing the same thing. The header div is kept
          empty-of-navigation so page actions can still dock here.
        */}
        <div className="page-header" />

        <form noValidate onSubmit={(e)=>{ e.preventDefault(); addEmployee(); }} className="add-employee-form">
          <div className="form-wrapper">
        {/* BASIC INFO */}
<div className="accordion">
  <div className="accordion-header" onClick={() => toggleSection("basic")}>
    <h2>Basic Information</h2>
  </div>

  {openSection === "basic" && (
    <div className="accordion-body">
      <div className="form-grid">
        {/* Read-only, and honest about which of the three states it is in. It
            used to render "Fetching ID..." forever when the fetch failed, which
            reads as a hung request rather than as "the server will assign one" —
            and the server DOES assign one, so a blank field is not an error. */}
        <div>
          <label htmlFor="ae-employee-id">Employee ID</label>
          <input
            id="ae-employee-id"
            name="office_id"
            readOnly
            aria-readonly="true"
            value={employeeCode || (codeState === 'loading' ? 'Fetching ID…' : 'Assigned on save')}
            disabled
            title={employeeCode
              ? 'Generated by the server. Reserved at save, so a second HR user saving first may shift it by one.'
              : 'The server assigns the Employee ID when this record is saved.'}
          />
        </div>
        <Field id="ae-first-name" label="First Name" required error={fieldErrors.firstName}>
          <input id="ae-first-name" name="firstName" placeholder="First name" required
            aria-describedby={fieldErrors.firstName ? 'ae-first-name-err' : undefined}
            value={firstName} onChange={e=>{setFirstName(e.target.value); clearFieldError('firstName');}} />
        </Field>
        <Field id="ae-last-name" label="Last Name" required error={fieldErrors.lastName}>
          <input id="ae-last-name" name="lastName" placeholder="Last name" required
            aria-describedby={fieldErrors.lastName ? 'ae-last-name-err' : undefined}
            value={lastName} onChange={e=>{setLastName(e.target.value); clearFieldError('lastName');}} />
        </Field>
        <Field id="ae-company-email" label="Company Email / Gmail" required error={fieldErrors.companyEmail}>
          <input id="ae-company-email" name="companyEmail" type="email" required
            aria-describedby={fieldErrors.companyEmail ? 'ae-company-email-err' : undefined}
            value={companyEmail} onChange={e=>{setCompanyEmail(e.target.value); clearFieldError('companyEmail');}} />
          {/* Company email is an HR record, not the login. The sign-in address
              lives on the user account (linked by users.employee_id) and is
              not touched by this form — see employeeEmailLoginSeparation tests. */}
          {employee && (
            <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 4 }}>
              Changing this does not change the address this employee signs in with.
            </span>
          )}
        </Field>
        <Field id="ae-personal-email" label="Personal Email" error={fieldErrors.personalEmail}>
          <input id="ae-personal-email" name="personalEmail" type="email"
            aria-describedby={fieldErrors.personalEmail ? 'ae-personal-email-err' : undefined}
            value={personalEmail} onChange={e=>{setPersonalEmail(e.target.value); clearFieldError('personalEmail');}} />
        </Field>

        <Field id="ae-phone" label="Personal Phone" error={fieldErrors.phone}>
          <input id="ae-phone" name="phone" type="tel" pattern="[0-9]*" inputMode="numeric"
            aria-describedby={fieldErrors.phone ? 'ae-phone-err' : undefined}
            value={phone} onChange={e=>{setPhone(e.target.value); clearFieldError('phone');}} />
        </Field>

        <div>
          <label htmlFor="ae-company-phone">Company Phone</label>
          <input id="ae-company-phone" name="companyPhone" type="tel" pattern="[0-9]*" inputMode="numeric" value={companyPhone}
            onChange={e=>setCompanyPhone(e.target.value)} />
        </div>

        <div><label htmlFor="ae-dob">DOB</label><input id="ae-dob" name="dob" type="date" value={dob} onChange={e=>setDob(e.target.value)} /></div>

        <div>
          <label htmlFor="ae-gender">Gender</label>
          <select id="ae-gender" name="gender" value={gender} onChange={e=>setGender(e.target.value)}>
            <option value="">-- Select Gender --</option>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
          </select>
        </div>

        <div>
          <label htmlFor="ae-blood-group">Blood Group</label>
          <select id="ae-blood-group" name="bloodGroup" value={bloodGroup} onChange={e=>setBloodGroup(e.target.value)}>
            <option value="" disabled>-- Select Blood Group --</option>
            <option>A+</option><option>A-</option>
            <option>B+</option><option>B-</option>
            <option>O+</option><option>O-</option>
            <option>AB+</option><option>AB-</option>
          </select>
        </div>

        <div>
          <label htmlFor="ae-marital-status">Marital Status</label>
          <select id="ae-marital-status" name="maritalStatus" value={maritalStatus} onChange={e=>setMaritalStatus(e.target.value)}
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
        <Field id="ae-current-address" label="Current Address" required error={fieldErrors.currentAddress}>
          <textarea id="ae-current-address" value={currentAddress} onChange={e=>setCurrentAddress(e.target.value)} />
        </Field>
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
          <label htmlFor="ae-highest-qualification">Highest Qualification</label>
          <VocabSelect onNavigate={setPage} searchable vocab="qualifications" id="ae-highest-qualification" value={highestQualification}
            onChange={v=>setHighestQualification(v)} placeholder="-- Select Qualification --" />
        </div>
        <div>
          <label htmlFor="ae-basic-qualification">Basic Qualification</label>
          <VocabSelect onNavigate={setPage} searchable vocab="qualifications" id="ae-basic-qualification" value={basicQualification}
            onChange={v=>setBasicQualification(v)} placeholder="-- Select Qualification --" />
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
        <Field id="ae-department" label="Department" required error={fieldErrors.department}>
          {/*
            ⚠ EVERY master picker on this form passes `searchable` explicitly.
            Left to MasterSelect's row-count threshold (12), the SAME field is a
            native <select> for a tenant with nine employment types and a
            combobox for one with thirteen — so the "+ Add new…" row, the
            "Manage X →" link and the keyboard behaviour all moved depending on
            how much seed data a deployment happened to have. Uniform beats
            marginally-better-for-short-lists.
          */}
          <MasterSelect
            onNavigate={setPage}
            id="ae-department"
            endpoint="/master/departments"
            label="Department"
            searchable
            required
            value={department}
            onChange={(v) => { setDepartment(v); clearFieldError('department'); }}
          />
        </Field>

        <Field id="ae-designation" label="Designation" required error={fieldErrors.designation}>
          <MasterSelect
            onNavigate={setPage}
            id="ae-designation"
            endpoint="/master/designations"
            label="Designation"
            searchable
            required
            value={designation}
            onChange={(v) => { setDesignation(v); clearFieldError('designation'); }}
          />
        </Field>

        <div>
          <label htmlFor="ae-grade">Grade</label>
          <MasterSelect
            onNavigate={setPage}
            id="ae-grade"
            searchable
            endpoint="/master/grades"
            label="Grade"
            value={grade}
            onChange={setGrade}
          />
        </div>

        <div>
          <label htmlFor="ae-band">Band</label>
          <MasterSelect
            onNavigate={setPage}
            id="ae-band"
            searchable
            endpoint="/master/bands"
            label="Band"
            value={band}
            onChange={setBand}
          />
        </div>

        <div>
          <label htmlFor="ae-employee-role">Role</label>
          <select id="ae-employee-role" name="employeeRole" value={employeeRole} onChange={e=>setEmployeeRole(e.target.value)}>
            <option value="" disabled>-- Select Role --</option>
            {employeeRoles.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="ae-reporting-manager">Reporting Manager</label>
          <select id="ae-reporting-manager" name="reportingManagerId" value={reportingManagerId} onChange={e => {
            const id = e.target.value;
            setReportingManagerId(id);
            const mgr = managers.find(m => String(m.id) === id);
            setReportingManagerName(mgr ? `${mgr.first_name} ${mgr.last_name}`.trim() : '');
          }}>
            <option value="">— None —</option>
            {/* The list excludes exited employees. A manager who has since left
                is still THIS record's manager until someone changes it, so they
                are offered back — otherwise the select fell to None and the
                next save quietly cleared the manager. */}
            {reportingManagerId && !managers.some(m => String(m.id) === reportingManagerId) && (
              <option value={reportingManagerId}>{reportingManagerName || `Employee #${reportingManagerId}`} (current)</option>
            )}
            {managers.filter(m => !employee || m.id !== employee.id).map(m => (
              <option key={m.id} value={String(m.id)}>{m.first_name} {m.last_name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ae-location">Location</label>
          <BranchSelect
            onNavigate={setPage}
            id="ae-location"
            value={branchId}
            onChange={(id, row) => { setBranchId(id ?? ''); setLocation(row?.name || ''); }}
          />
        </div>

        <div>
          <label htmlFor="ae-shift">Shift</label>
          <select id="ae-shift" name="shiftId" value={shiftId} onChange={e=>setShiftId(e.target.value)}>
            <option value="">-- Select Shift --</option>
            {shifts.map(s => (
              <option key={s.id} value={String(s.id)}>
                {s.name}{s.start_time ? ` (${String(s.start_time).slice(0,5)}–${String(s.end_time).slice(0,5)})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ae-employment-type">Employment Type</label>
          <VocabSelect onNavigate={setPage} searchable vocab="employment-types" id="ae-employment-type" value={employmentType}
            onChange={v=>setEmploymentType(v)} placeholder="-- Select Type --" />
        </div>

        <div>
          <label htmlFor="ae-skill-type">Skill Type</label>
          <VocabSelect onNavigate={setPage} searchable vocab="skill-types" id="ae-skill-type" value={skillType}
            onChange={v=>setSkillType(v)} placeholder="-- Select Skill --" />
        </div>

        <div>
          <label htmlFor="ae-workforce-category">Workforce Category</label>
          {/* searchable={false}: the native <select> keeps a "-- Select --"
              option, which is how an optional category is CLEARED. The
              searchable combobox has no way back to blank once a value is
              chosen. orphanLabel names a category that has since been
              deactivated, instead of showing its bare id. */}
          <VocabSelect onNavigate={setPage} searchable={false} vocab="workforce-categories"
            id="ae-workforce-category" optionValue="id" value={workforceCategoryId}
            orphanLabel={employee?.workforce_category_name
              ? `${employee.workforce_category_name}${employee.workforce_category_active === false ? ' (inactive)' : ''}`
              : undefined}
            onChange={v=>setWorkforceCategoryId(v == null ? '' : String(v))}
            placeholder="-- Select Category --" />
        </div>

        <div>
          <label>Field Employee</label>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontWeight:400, cursor:'pointer', marginTop:6 }}>
            <input type="checkbox" checked={isFieldEmployee}
              onChange={e=>setIsFieldEmployee(e.target.checked)}
              style={{ width:16, height:16 }} />
            Punches attendance in the app with a camera selfie + GPS.
            Exempt from the shift window and geo-fence. Everyone else clocks
            in at the office face / biometric device instead.
          </label>
        </div>

        <div>
          <label htmlFor="ae-zone">Zone</label>
          {/* POST /master/zones additionally accepts the hr roles, so the add
              option stays available to the people who fill this form in. */}
          <MasterSelect
            onNavigate={setPage}
            id="ae-zone"
            searchable
            endpoint="/master/zones"
            label="Zone"
            value={zone}
            // The ROW, not just the name: a value promoted into the zone master
            // has an id, and storing it is what makes the FK usable. A value
            // the master does not hold still saves as text with a null id,
            // which is the pre-existing behaviour and not an error.
            onChange={(v, row) => { setZone(v); setZoneId(row?.id ? String(row.id) : ''); }}
            addRoles={['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']}
          />
        </div>

        <Field id="ae-joining-date" label="Joining Date" required error={fieldErrors.joiningDate}>
          <input id="ae-joining-date" name="joiningDate" type="date" required value={joiningDate}
            aria-describedby={fieldErrors.joiningDate ? 'ae-joining-date-err' : undefined}
            max={new Date(Date.now() + 2 * 365 * 864e5).toISOString().slice(0, 10)}
            onChange={e=>{setJoiningDate(e.target.value); clearFieldError('joiningDate');}} />
        </Field>

        <Field id="ae-status" label="Status" required error={fieldErrors.status}>
          <select id="ae-status" name="status" required value={status}
                  aria-describedby={fieldErrors.status ? 'ae-status-err' : undefined}
                  onChange={e=>{setStatus(e.target.value); clearFieldError('status');}}
                  onKeyDown={(e)=>handleLastFieldTab(e,"job")}>
            {/* WRITABLE_STATUSES, not four hardcoded <option>s. The Add form
                offered Active / Probation / Inactive and no Notice at all, while
                the Edit form offered Notice and Inactive -- two forms writing the
                same column from two different vocabularies, one of which could
                not express a real state and both of which could set an exited
                status with no last working day. */}
            {legacyStatus && (
              <option value={legacyStatus}>{legacyStatus} (stored value — unchanged unless you pick another)</option>
            )}
            {statusOptions.map(v => (
              <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>
            ))}
          </select>
          {!alreadyLeft && (
            <p id="ae-status-help" style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
              To record that someone is leaving, use Exit Management (or Terminate on All Employees).
            </p>
          )}
        </Field>

        {showProbation && (
          <Field id="ae-probation-months" label="Probation Period (months)" error={fieldErrors.probationMonths}>
            <input id="ae-probation-months" name="probationMonths" type="number" min={1} max={24} step={1}
              inputMode="numeric" value={probationMonths}
              aria-describedby={fieldErrors.probationMonths ? 'ae-probation-months-err' : 'ae-probation-help'}
              placeholder={probationPreview?.policy ? `${probationPreview.policy.probation_months} (company default)` : 'Company default'}
              onChange={e => {
                setProbationMonths(e.target.value);
                setProbationManual(false);
                setProbationDirty(true);
                clearFieldError('probationMonths');
              }} />
          </Field>
        )}

        {showProbation && (
          <Field id="ae-probation-end" label="Probation End Date" error={fieldErrors.probationEnd}>
            <input id="ae-probation-end" name="probationEnd" type="date" value={probationEnd}
              min={joiningDate || undefined}
              aria-describedby={fieldErrors.probationEnd ? 'ae-probation-end-err' : 'ae-probation-help'}
              onChange={e => {
                setProbationEnd(e.target.value);
                setProbationManual(true);
                setProbationDirty(true);
                clearFieldError('probationEnd');
              }} />
            <span id="ae-probation-help" style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#6b7280' }}>
              {probationManual
                ? 'Set by hand — saved exactly as entered.'
                : probationAuto && probationPreview?.error
                  ? probationPreview.error
                  : probationAuto && probationEnd
                    ? `Last day of probation: ${probationMonths || probationPreview?.probation_months || ''} month(s) from the joining date.`
                    : employee && storedProbationEnd
                      ? 'Saved end date. Change the period or the date to update it.'
                      : employee
                        ? 'No end date saved yet. Enter a period to calculate one.'
                        : ''}
              {joiningMovedFromStored && (
                <>
                  {' '}The joining date changed.{' '}
                  <button type="button"
                    style={{ background: 'none', border: 0, padding: 0, color: '#6B3FDB', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}
                    onClick={() => { setProbationManual(false); setProbationDirty(true); }}>
                    Recalculate the end date
                  </button>
                </>
              )}
            </span>
          </Field>
        )}
      </div>

      {/*
        COMPENSATION.

        Create: the figure that becomes this employee's first salary revision,
        effective their joining date. Add Employee used to collect no salary at
        all, so every hire landed on the column DEFAULT of 30000 — 83 of 85 rows
        were exactly that.

        Edit: a CORRECTION to the revision in force today, written in place by
        its id. A mistyped first salary is fixed without leaving the wrong
        figure in the history as though it had been paid, and no second
        revision is ever booked for the same effective date. An increment —
        a NEW figure from a NEW date — is still made in Payroll → Salary
        Structure → Assign.
      */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid #e9e4ff' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#6B3FDB' }}>Compensation</h3>
        <p id="ae-salary-help" style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
          {!canEditSalary
            ? 'The salary is recorded by Payroll (it needs payroll edit permission). Save the employee without it.'
            : !employee
            ? `Becomes the first entry in this employee's Salary Revision History, effective their joining date. Leave blank if it is not settled yet.`
            : !salaryEditable
              ? 'Salary history could not be loaded, so the salary cannot be corrected here right now. Re-open this form to try again.'
              : currentRevision
                ? `Correcting the salary revision effective ${String(currentRevision.effective_from).slice(0, 10)} — the one in force today. The change replaces that entry; it does not add a new revision. For an increment from a new date, use Payroll → Salary Structure → Assign.`
                : 'No salary has been recorded yet. Entering one creates the first revision, effective the joining date.'}
        </p>

        {!salaryEditable ? (
          <div className="form-grid">
            <div>
              <label htmlFor="ae-basic-salary">Basic Salary</label>
              <input id="ae-basic-salary" readOnly disabled
                value={!employee ? 'Recorded by Payroll'
                  : !('basic_salary' in employee)
                  ? 'Restricted — needs payroll access'   // withheld by the server (PC-01), not missing
                  : employee.basic_salary != null ? `₹${Number(employee.basic_salary).toLocaleString('en-IN')}` : 'Not recorded'} />
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <Field id="ae-basic-salary" label="Basic Salary (₹ per month)" error={fieldErrors.basicSalary}>
              <input id="ae-basic-salary" name="basicSalary" type="number" min="0" step="1"
                placeholder="e.g. 45000"
                value={basicSalary}
                aria-describedby={fieldErrors.basicSalary ? 'ae-basic-salary-err' : 'ae-salary-help'}
                onChange={e=>{setBasicSalary(e.target.value); clearFieldError('basicSalary');}} />
            </Field>
            <Field id="ae-special-allowance" label="Special Allowance (₹ per month)" error={fieldErrors.specialAllowance}>
              <input id="ae-special-allowance" name="specialAllowance" type="number" min="0" step="1"
                placeholder="e.g. 5000"
                value={specialAllowance}
                aria-describedby={fieldErrors.specialAllowance ? 'ae-special-allowance-err' : 'ae-salary-help'}
                onChange={e=>{setSpecialAllowance(e.target.value); clearFieldError('specialAllowance');}} />
            </Field>
          </div>
        )}
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
                setPreviousCompany1('');
                setPreviousRole1('');
                setPreviousYears1('');
                setPreviousCompany2('');
                setPreviousRole2('');
                setPreviousYears2('');
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
          <div>
            <label htmlFor="ae-prev-years-1">Years 1</label>
            <input id="ae-prev-years-1" type="number" min="0" max="60" step="1" value={previousYears1}
              aria-describedby={fieldErrors.previousYears1 ? 'ae-prev-years-1-err' : undefined}
              onChange={e=>{setPreviousYears1(e.target.value); clearFieldError('previousYears1');}} />
            {fieldErrors.previousYears1 && <span className="field-error" id="ae-prev-years-1-err" role="alert">{fieldErrors.previousYears1}</span>}
          </div>
          <div><label>Company 2</label><input value={previousCompany2} onChange={e=>setPreviousCompany2(e.target.value)} /></div>
          <div><label>Role 2</label><input value={previousRole2} onChange={e=>setPreviousRole2(e.target.value)} /></div>
          <div>
            <label htmlFor="ae-prev-years-2">Years 2</label>
            <input id="ae-prev-years-2" type="number" min="0" max="60" step="1" value={previousYears2}
              aria-describedby={fieldErrors.previousYears2 ? 'ae-prev-years-2-err' : undefined}
                   onChange={e=>{setPreviousYears2(e.target.value); clearFieldError('previousYears2');}}
                   onKeyDown={(e)=>handleLastFieldTab(e,"experience")} />
            {fieldErrors.previousYears2 && <span className="field-error" id="ae-prev-years-2-err" role="alert">{fieldErrors.previousYears2}</span>}
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
        <div>
          <label htmlFor="ae-bank">Bank Name</label>
          {/* The 44 RBI scheduled banks, from master_values BANK. Open, not
              closed: "+ Add new bank…" is the "Other" path for a co-operative
              or newly-merged bank the seed does not carry, and it writes the
              value into the master so the next hire picks it rather than
              retyping it differently. A value already on the record that the
              master does not hold is offered back as its own option, so the
              four legacy free-text banks are not wiped on the next save. */}
          <VocabSelect onNavigate={setPage} searchable vocab="banks" id="ae-bank" searchable
            value={bankName} onChange={v=>setBankName(v)}
            placeholder="Select bank…" />
        </div>
        <div><label>Branch</label><input value={branchName} onChange={e=>setBranchName(e.target.value)} /></div>
        {/* Only HR with the bank-details permission may enter or change these;
            the server refuses anyone else and notifies Accounts of a change. */}
        <Field id="ae-account-number" label="Account Number" required error={fieldErrors.accountNumber}>
          <input id="ae-account-number" inputMode="numeric" value={accountNumber} onChange={e=>setAccountNumber(e.target.value)} />
        </Field>
        <Field id="ae-ifsc" label="IFSC" required error={fieldErrors.ifscCode}>
          <input id="ae-ifsc" value={ifscCode} onChange={e=>setIfscCode(e.target.value.toUpperCase())} placeholder="HDFC0001234" />
        </Field>
        {/* "Verify as-is" (§206): details on record that predate the
            maker-checker go to a second HR person unchanged. The server checks
            they are valid and not yet verified; the result shows in the dialog. */}
        {employee && employee.account_number && !employee.bank_verified_at && (
          <div style={{ gridColumn: '1/-1', fontSize: 12, color: '#6b7280' }}>
            These bank details have not been verified by a second HR person.{' '}
            <button type="button" className="btn-secondary" disabled={verifyBusy}
              onClick={async () => {
                setVerifyBusy(true);
                try {
                  await api.post(`/employees/${employee.id}/bank-verification-request`);
                  setDialog({ type:'success', title:'Verification requested', message:'The bank details on record were sent to another HR person to verify (HR → Bank Detail Approvals). Nothing on the record changes.' });
                } catch (err) {
                  setDialog({ type:'error', title:'Verification not requested', message: err.response?.data?.error || 'The request could not be made.' });
                } finally { setVerifyBusy(false); }
              }}>
              {verifyBusy ? 'Requesting…' : 'Request verification'}
            </button>
          </div>
        )}
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
        <Field id="ae-pan" label="PAN Number" error={fieldErrors.panNumber}>
          <input id="ae-pan" name="panNumber" placeholder="ABCDE1234F"
            aria-describedby={fieldErrors.panNumber ? 'ae-pan-err' : undefined}
            value={panNumber} onChange={e=>{setPanNumber(e.target.value); clearFieldError('panNumber');}} />
        </Field>
        <Field id="ae-aadhaar" label="Aadhaar Number" error={fieldErrors.aadhaarNumber}>
          <input id="ae-aadhaar" name="aadhaarNumber" inputMode="numeric" placeholder="12 digits"
            aria-describedby={fieldErrors.aadhaarNumber ? 'ae-aadhaar-err' : undefined}
            value={aadhaarNumber} onChange={e=>{setAadhaarNumber(e.target.value); clearFieldError('aadhaarNumber');}} />
        </Field>
        <div><label htmlFor="ae-pf">PF Number</label><input id="ae-pf" name="pfNumber" value={pfNumber} onChange={e=>setPfNumber(e.target.value)} /></div>
        <div><label htmlFor="ae-uan">UAN Number</label><input id="ae-uan" name="uanNumber" value={uanNumber} onChange={e=>setUanNumber(e.target.value)} /></div>
        <div><label htmlFor="ae-esic">ESIC Number</label>
          <input id="ae-esic" name="esicNumber" value={esicNumber} onChange={e=>setEsicNumber(e.target.value)}
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
          <label htmlFor="ae-emergency-relationship">Relationship</label>
          <select id="ae-emergency-relationship" name="emergencyRelationship"
                  value={emergencyRelationship} onChange={(e)=>setEmergencyRelationship(e.target.value)}
                  onKeyDown={(e)=>handleLastFieldTab(e,"emergency")}>
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
          {/* Allocated rows are editable in place and saved with the form.
              Returned / disposed ones are history — shown, not edited; the
              Employee Assets page owns return, transfer and disposal. */}
          {existingAssets.filter(a => !a.status || a.status === 'allocated').map(a => (
            <div key={a.id} className="form-grid" style={{ alignItems: 'end', marginTop: 8 }}>
              <div>
                <label htmlFor={`ae-ex-asset-type-${a.id}`}>Asset Type</label>
                <VocabSelect onNavigate={setPage} searchable vocab="asset-types" id={`ae-ex-asset-type-${a.id}`}
                  ariaLabel={`Asset type, ${a.asset_name || 'allocated asset'}`}
                  value={a.asset_type || ''}
                  onChange={v => updateExistingAsset(a.id, 'asset_type', v)} />
              </div>
              <div>
                <label htmlFor={`ae-ex-asset-name-${a.id}`}>Asset Name / Description</label>
                <input id={`ae-ex-asset-name-${a.id}`} value={a.asset_name || ''}
                  onChange={e => updateExistingAsset(a.id, 'asset_name', e.target.value)} />
              </div>
              <div>
                <label htmlFor={`ae-ex-asset-tag-${a.id}`}>Asset Tag</label>
                <input id={`ae-ex-asset-tag-${a.id}`} value={a.asset_tag || ''}
                  onChange={e => updateExistingAsset(a.id, 'asset_tag', e.target.value)} />
              </div>
              <div>
                <label htmlFor={`ae-ex-asset-serial-${a.id}`}>Serial / Number</label>
                <input id={`ae-ex-asset-serial-${a.id}`} value={a.serial_number || ''}
                  onChange={e => updateExistingAsset(a.id, 'serial_number', e.target.value)} />
              </div>
            </div>
          ))}
          {existingAssets.some(a => a.status && a.status !== 'allocated') && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {existingAssets.filter(a => a.status && a.status !== 'allocated').map(a => (
                <span key={a.id} style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 20, padding: '4px 12px', fontSize: 12, color: '#374151' }}>
                  {a.asset_type}: {a.asset_name}{a.asset_tag ? ` (${a.asset_tag})` : ''} — {a.status}
                </span>
              ))}
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginTop: 14 }}>Allocate more</label>
        </div>
      )}

      {assetRows.map((row, idx) => (
        <div key={idx} className="form-grid" style={{ alignItems: 'end', marginBottom: 10 }}>
          <div>
            <label htmlFor={`ae-asset-type-${idx}`}>Asset Type</label>
            {/* The ASSET_TYPE master (13 shared rows + anything this tenant has
                added). 13 is one past MasterSelect's SEARCH_THRESHOLD, which is
                exactly why Asset Type was one of the three pickers that showed
                the broken menu while Grade, Qualification and Skill Type — all
                under the threshold, so all native <select>s — looked fine. */}
            <VocabSelect onNavigate={setPage} searchable vocab="asset-types" id={`ae-asset-type-${idx}`}
              ariaLabel={`Asset type, row ${idx + 1}`}
              value={row.asset_type}
              onChange={v => updateAssetRow(idx, 'asset_type', v)} />
          </div>
          <div>
            <label htmlFor={`ae-asset-name-${idx}`}>Asset Name / Description</label>
            <input id={`ae-asset-name-${idx}`} value={row.asset_name} placeholder="e.g. Dell Latitude 5440, Airtel SIM 98xxxx"
                   onChange={e => updateAssetRow(idx, 'asset_name', e.target.value)} />
          </div>
          <div>
            <label htmlFor={`ae-asset-tag-${idx}`}>Asset Tag</label>
            <input id={`ae-asset-tag-${idx}`} value={row.asset_tag} placeholder="e.g. IT-0042"
                   onChange={e => updateAssetRow(idx, 'asset_tag', e.target.value)} />
          </div>
          <div>
            <label htmlFor={`ae-asset-serial-${idx}`}>Serial / Number</label>
            <input id={`ae-asset-serial-${idx}`} value={row.serial_number} placeholder="Serial no. / SIM no."
                   onChange={e => updateAssetRow(idx, 'serial_number', e.target.value)} />
          </div>
          <div>
            <button type="button" aria-label={`Remove asset row ${idx + 1}`} onClick={() => removeAssetRow(idx)}
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
      {fileError && <p role="alert" style={{ gridColumn: '1 / -1', color: '#dc2626', fontSize: 12, margin: 0 }}>{fileError}</p>}
      {DOC_SLOTS.map((slot, i) => {
        const stored = employee?.[slot.column] || null;
        const chosen = docFiles[slot.field] || null;
        const removing = removeFiles.has(slot.field) && !chosen;
        const onFile = !!stored && !removing;
        const isLast = i === DOC_SLOTS.length - 1;
        return (
          <div className="upload-box" key={slot.field}>
            <span>
              {slot.label}{' '}
              {(onFile || chosen) && <span style={{color: "green", fontWeight: "bold"}}>✓</span>}
            </span>
            {/* Photo: object URL for a freshly chosen file, authenticated blob
                for the stored one. Hidden once the stored photo is marked for
                removal and nothing replaces it. */}
            {slot.field === 'photo_file' && photoPreview && (onFile || chosen) && (
              <img src={photoPreview} alt="Employee photo preview"
                style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e9e4ff', margin: '6px 0' }} />
            )}
            {stored && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, margin: '4px 0' }}>
                {removing ? (
                  <span style={{ color: '#b45309' }}>Will be removed on save.</span>
                ) : (
                  <span style={{ color: '#6b7280' }}>{chosen ? 'On file — will be replaced' : 'On file'}</span>
                )}
                {!removing && (
                  <button type="button" onClick={async () => setFileError((await openEmployeeFile(stored)) || '')}
                    style={{ background: 'none', border: 'none', color: '#6B3FDB', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                    View
                  </button>
                )}
                {!chosen && (
                  <button type="button" onClick={() => toggleRemoveFile(slot.field)}
                    aria-label={removing ? `Keep ${slot.label}` : `Remove ${slot.label}`}
                    style={{ background: 'none', border: 'none', color: removing ? '#6B3FDB' : '#dc2626', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                    {removing ? 'Undo' : 'Remove'}
                  </button>
                )}
              </div>
            )}
            <input type="file" accept={slot.accept} key={`${slot.field}-${inputGen[slot.field] || 0}`}
              aria-label={stored ? `Replace ${slot.label}` : `Upload ${slot.label}`}
              onChange={e => setDocFile(slot.field, e.target.files?.[0] || null)}
              onKeyDown={isLast ? (e)=>handleLastFieldTab(e,"docs") : undefined} />
            {chosen && (
              <button type="button" onClick={() => { setDocFile(slot.field, null); setInputGen(g => ({ ...g, [slot.field]: (g[slot.field] || 0) + 1 })); }}
                style={{ marginTop: 6, background: 'none', border: 'none', color: '#6B3FDB', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                Clear selection
              </button>
            )}
          </div>
        );
      })}
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
{/*
  Sticky. The form is twelve accordion sections tall, so a Save button pinned
  to the very bottom of the document meant scrolling past everything to reach
  it on a 1280x800 screen.

  `saving || submitted` — see the `submitted` comment above. `saving` alone
  re-enabled the button the instant the request resolved, while the success
  dialog and its 2.1s redirect were still on screen.
*/}
<div className="ae-save-bar">
  <button type="submit" className="save-btn" disabled={saving || submitted}>
    {saving ? 'Saving…' : submitted ? 'Saved' : 'Save'}
  </button>
  {/*
    aria-live: the outcome has to reach a screen reader without moving focus.
    `errorCount` is the same state that marks the fields, so the count and the
    marks cannot disagree.
  */}
  <span
    className={`ae-save-hint${errorCount ? ' is-error' : ''}`}
    role="status"
    aria-live="polite"
  >
    {saving
      ? 'Saving employee…'
      : submitted
        ? 'Saved. Returning to All Employees…'
        : errorCount
          ? `${errorCount} field${errorCount === 1 ? '' : 's'} need${errorCount === 1 ? 's' : ''} attention.`
          : 'First name, last name, company email, department, designation, joining date, status, current address, bank account number and IFSC are required.'}
  </span>
</div>

</form>
</div>
</PageShell>
);
}

/**
 * Convert to Employee loads the pre-fill (GET /interns/:id/conversion) and then
 * mounts the SAME form, seeded from it — no second employee form exists.
 * Module level, so a re-render never remounts the form.
 */
function ConversionLoader({ internId, ...props }) {
  const [state, setState] = useState({ source: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api.get(`/interns/${encodeURIComponent(internId)}/conversion`)
      .then(r => { if (live) setState({ source: r.data, error: null }); })
      .catch(e => { if (live) setState({ source: null, error: e?.response?.data?.error || e?.message || 'Could not load the intern.' }); });
    return () => { live = false; };
  }, [internId, attempt]);
  const { source, error } = state;
  const blocked = source && !source.eligibility?.eligible;
  if (source && !blocked) {
    return (
      <EmployeeForm {...props} employee={null} seed={source.prefill}
        conversion={{ intern_id: source.intern.id, intern_code: source.intern.intern_code, name: source.intern.name,
          photo_url: source.intern.photo_url, resume_file: source.intern.resume_file }} />
    );
  }
  return (
    <PageShell dock={<PageHero icon={Users} eyebrow="Employees" title="Convert Intern to Employee"
      subtitle={source ? `${source.intern.intern_code} · ${source.intern.name}` : 'Loading the intern record…'} />}>
      <div className="page-container">
        {error || blocked
          ? <LoadError title={error ? undefined : 'Cannot convert this intern'}
              message={error || `This intern cannot be converted: ${source.eligibility.reason}`}
              onRetry={error ? () => { setState({ source: null, error: null }); setAttempt(a => a + 1); } : undefined} />
          : <LoadingState shape="lines" rows={8} />}
      </div>
    </PageShell>
  );
}

export default function AddEmployee(props) {
  const internId = props.employee ? null : props.urlParams?.fromIntern;
  if (internId) return <ConversionLoader key={internId} internId={internId} {...props} />;
  return <EmployeeForm {...props} />;
}
