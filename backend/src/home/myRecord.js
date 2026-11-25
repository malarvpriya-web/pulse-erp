// GET /home/my-record — the signed-in employee's OWN employee record, read-only
// (HR > Self Service > My Details, 2026-11-11).
//
// Since 2026-11-11 employees change nothing of their own: HR maintains the
// record, Finance the IT declarations. An employee who spots a mistake raises
// a "Record correction" ticket from the page (Service Desk → HR or Finance).
//
// Always the caller's own row (token, else users.employee_id; never a query or
// body id), inside their company. Identity and bank numbers are masked; HR's
// private notes and salary figures are not returned at all.
import pool from '../config/db.js';
import { companyOf } from '../shared/scope.js';
import { ownEmployeeId } from '../modules/payroll/payrollAccess.js';

const last4 = (v, keep = 4) => {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return null;
  return s.length <= keep ? 'X'.repeat(s.length) : `${'X'.repeat(Math.min(8, s.length - keep))}${s.slice(-keep)}`;
};
// PAN: first five letters are not secret in practice, but keep it to the last 4.
export const maskers = { account: v => last4(v), pan: v => last4(v), aadhaar: v => last4(v), passport: v => last4(v, 3), licence: v => last4(v) };

export async function getMyRecord(req) {
  const empId = await ownEmployeeId(req);
  if (empId == null) return { linked: false };
  const cid = companyOf(req);
  const { rows } = await pool.query(
    `SELECT e.office_id, e.first_name, e.last_name, e.gender, e.dob::text AS dob, e.blood_group, e.marital_status,
            e.father_name, e.mother_name, e.spouse_name, e.anniversary_date::text AS anniversary_date,
            e.company_email, e.personal_email, e.phone, e.company_phone,
            e.current_address, e.permanent_address,
            e.emergency_name, e.emergency_phone, e.emergency_relationship, e.nominee_name,
            e.department, e.sub_department, e.designation, e.grade, e.band, e.employment_type, e.status,
            e.joining_date::text AS joining_date, e.location, e.zone,
            NULLIF(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')), '') AS manager_name, e.reporting_manager,
            e.highest_qualification, e.basic_qualification,
            e.previous_company_1, e.previous_role_1, e.previous_years_1,
            e.previous_company_2, e.previous_role_2, e.previous_years_2,
            e.pan_number, e.aadhaar_number, e.uan_number, e.pf_number, e.esic_number,
            e.passport_number, e.driving_license_number,
            e.bank_name, e.branch_name, e.ifsc_code, e.account_number, e.account_holder_name, e.bank_verified_at,
            (e.pan_file IS NOT NULL AND e.pan_file <> '') AS has_pan_file,
            (e.aadhaar_file IS NOT NULL AND e.aadhaar_file <> '') AS has_aadhaar_file,
            (e.cancelled_cheque_file IS NOT NULL AND e.cancelled_cheque_file <> '') AS has_cheque_file,
            (e.resume_file IS NOT NULL AND e.resume_file <> '') AS has_resume_file,
            (e.offer_letter_file IS NOT NULL AND e.offer_letter_file <> '') AS has_offer_letter_file,
            (e.appointment_letter_file IS NOT NULL AND e.appointment_letter_file <> '') AS has_appointment_letter_file,
            (e.confidentiality_letter_file IS NOT NULL AND e.confidentiality_letter_file <> '') AS has_confidentiality_letter_file
       FROM employees e
       LEFT JOIN employees m ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)`,
    [empId, cid],
  );
  const e = rows[0];
  if (!e) return { linked: false };
  const fullName = [e.first_name, e.last_name].filter(Boolean).join(' ');

  return {
    linked: true,
    employee_id: empId,
    // The statutory / bank fields GET /employees/:id leaves out for an employee,
    // masked, keyed like the employee row — the View Employee page in self mode
    // (My Details) lays them over the record it loads.
    masked: {
      pan_number: maskers.pan(e.pan_number), aadhaar_number: maskers.aadhaar(e.aadhaar_number),
      uan_number: e.uan_number, pf_number: e.pf_number, esic_number: e.esic_number,
      passport_number: maskers.passport(e.passport_number), driving_license_number: maskers.licence(e.driving_license_number),
      bank_name: e.bank_name, branch_name: e.branch_name, ifsc_code: e.ifsc_code,
      account_number: maskers.account(e.account_number), account_holder_name: e.account_holder_name,
    },
    sections: [
      { key: 'personal', title: 'Personal', owner: 'HR', fields: [
        ['Full name', fullName], ['Gender', e.gender], ['Date of birth', e.dob, 'date'], ['Blood group', e.blood_group],
        ['Marital status', e.marital_status], ['Father’s name', e.father_name], ['Mother’s name', e.mother_name],
        ['Spouse’s name', e.spouse_name], ['Anniversary', e.anniversary_date, 'date'],
      ] },
      { key: 'contact', title: 'Contact & Address', owner: 'HR', fields: [
        ['Work email', e.company_email], ['Personal email', e.personal_email], ['Mobile', e.phone], ['Work phone', e.company_phone],
        ['Current address', e.current_address], ['Permanent address', e.permanent_address],
      ] },
      { key: 'emergency', title: 'Emergency Contact & Nominee', owner: 'HR', fields: [
        ['Emergency contact', e.emergency_name], ['Relationship', e.emergency_relationship], ['Emergency phone', e.emergency_phone],
        ['Nominee', e.nominee_name],
      ] },
      { key: 'job', title: 'Job', owner: 'HR', fields: [
        ['Employee code', e.office_id], ['Designation', e.designation], ['Department', e.department], ['Sub-department', e.sub_department],
        ['Reporting manager', e.manager_name || e.reporting_manager], ['Employment type', e.employment_type],
        ['Grade', e.grade], ['Band', e.band], ['Date of joining', e.joining_date, 'date'], ['Location', e.location], ['Status', e.status],
      ] },
      { key: 'education', title: 'Education & Experience', owner: 'HR', fields: [
        ['Highest qualification', e.highest_qualification], ['Basic qualification', e.basic_qualification],
        ['Previous employer 1', [e.previous_company_1, e.previous_role_1, e.previous_years_1 && `${e.previous_years_1} yrs`].filter(Boolean).join(' · ') || null],
        ['Previous employer 2', [e.previous_company_2, e.previous_role_2, e.previous_years_2 && `${e.previous_years_2} yrs`].filter(Boolean).join(' · ') || null],
      ] },
      { key: 'statutory', title: 'Statutory IDs', owner: 'HR', fields: [
        ['PAN', maskers.pan(e.pan_number)], ['Aadhaar', maskers.aadhaar(e.aadhaar_number)], ['UAN', e.uan_number],
        ['PF number', e.pf_number], ['ESIC number', e.esic_number], ['Passport', maskers.passport(e.passport_number)],
        ['Driving licence', maskers.licence(e.driving_license_number)],
      ] },
      { key: 'bank', title: 'Bank (salary account)', owner: 'HR', fields: [
        ['Bank', e.bank_name], ['Branch', e.branch_name], ['IFSC', e.ifsc_code], ['Account number', maskers.account(e.account_number)],
        ['Name on account', e.account_holder_name], ['Verified by HR', e.bank_verified_at ? 'Yes' : 'Not yet'],
      ] },
      { key: 'files', title: 'Documents on file', owner: 'HR', fields: [
        ['PAN card', e.has_pan_file ? 'On file' : null], ['Aadhaar card', e.has_aadhaar_file ? 'On file' : null],
        ['Cancelled cheque', e.has_cheque_file ? 'On file' : null], ['Resume', e.has_resume_file ? 'On file' : null],
        ['Offer letter', e.has_offer_letter_file ? 'On file' : null],
        ['Appointment letter', e.has_appointment_letter_file ? 'On file' : null],
        ['Confidentiality letter', e.has_confidentiality_letter_file ? 'On file' : null],
      ] },
    ].map(s => ({ ...s, fields: s.fields.map(([label, value, kind]) => ({ label, value: value ?? null, ...(kind ? { kind } : {}) })) })),
  };
}

export const getMyRecordHandler = async (req, res) => {
  try {
    res.json(await getMyRecord(req));
  } catch (err) {
    console.error('getMyRecord error:', err);
    res.status(500).json({ error: 'Could not load your employee record' });
  }
};
