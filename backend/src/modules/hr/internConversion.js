/**
 * Intern → Employee conversion.
 *
 * There is ONE way to create the employee: the normal POST /employees (the Add
 * Employee form in conversion mode), so every employee rule — required fields,
 * EMPxxx minted by shared/employeeCode.js inside the transaction, branch / zone
 * / manager checks, login provisioning, payroll enrolment — applies unchanged.
 * That request carries `from_intern_id`; employee.service.js then calls
 * lockConvertibleIntern() BEFORE the insert and linkConversion() after it, in
 * the SAME transaction, so a refused conversion creates no employee and a
 * failed insert leaves the intern unconverted.
 *
 * Nothing is copied that would make a second person record: the employee
 * reuses the intern's stored photo and résumé FILES (same StorageService
 * object, no re-upload), and the remaining intern documents stay on the intern
 * record, which is kept for good and linked both ways
 * (interns.converted_employee_id ↔ employees.source_intern_id).
 *
 * Eligibility (mirrored by trg_interns_completion_guard):
 *   - internship Completed (completion already needs an HR-approved evaluation);
 *   - the LATEST evaluation Approved and "Recommended for Employment";
 *   - not converted before.
 */
import { EMPLOYMENT_RECOMMENDATION } from '../../shared/internship.js';

const conflict = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });

/** { eligible, reason, evaluation_id, converted? } for a loaded intern row. */
export async function conversionEligibility(db, intern) {
  if (intern.converted_employee_id) {
    return {
      eligible: false, reason: 'Already converted to an employee.',
      converted: { employee_id: intern.converted_employee_id, employee_code: intern.converted_employee_code ?? null },
    };
  }
  const { rows: [latest] } = await db.query(
    `SELECT id, status, recommendation FROM intern_evaluations
      WHERE intern_id = $1::int AND company_id = $2::int ORDER BY id DESC LIMIT 1`, [intern.id, intern.company_id]);
  if (!latest || latest.status !== 'Approved' || latest.recommendation !== EMPLOYMENT_RECOMMENDATION) {
    return {
      eligible: false,
      reason: latest?.status === 'Approved'
        ? `The approved evaluation says "${latest.recommendation}", not "${EMPLOYMENT_RECOMMENDATION}".`
        : `Needs an HR-approved mentor evaluation recommending employment${latest ? ` (latest is ${latest.status})` : ''}.`,
      evaluation_id: latest?.id ?? null,
    };
  }
  if (intern.status !== 'Completed') {
    return { eligible: false, reason: 'Mark the internship Completed first.', evaluation_id: latest.id };
  }
  return { eligible: true, reason: null, evaluation_id: latest.id };
}

/** The intern's latest live Résumé document, if any. */
async function latestResume(db, internId) {
  const { rows } = await db.query(
    `SELECT file_url, original_name FROM intern_documents
      WHERE intern_id = $1::int AND doc_type = 'Resume' AND deleted_at IS NULL
      ORDER BY uploaded_at DESC, id DESC LIMIT 1`, [internId]);
  return rows[0] ?? null;
}

async function internRow(db, internId, companyId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT i.*, i.dob::text AS dob, i.start_date::text AS start_date, i.end_date::text AS end_date,
            i.completed_on::text AS completed_on
       FROM interns i
      WHERE i.id = $1::int AND i.company_id = $2::int AND i.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF i' : ''}`, [internId, companyId]);
  return rows[0] ?? null;
}

/**
 * What the Add Employee form is pre-populated with. Personal, contact,
 * emergency and education details come across; the employment-specific fields
 * (department, designation, manager, type, joining date, salary, branch, zone,
 * company email…) are deliberately left for HR — an intern's department and
 * role are their INTERNSHIP's, not a decision about the job.
 */
export async function conversionSource(db, internId, companyId) {
  const intern = await internRow(db, internId, companyId);
  if (!intern) return null;
  const { rows: [ce] } = intern.converted_employee_id
    ? await db.query(`SELECT office_id FROM employees WHERE id = $1::int AND company_id = $2::int`,
        [intern.converted_employee_id, intern.company_id])
    : { rows: [] };
  intern.converted_employee_code = ce?.office_id ?? null;
  const eligibility = await conversionEligibility(db, intern);
  const resume = await latestResume(db, intern.id);

  // Course → Highest Qualification only when it IS a Qualification value; the
  // employee picker is that vocabulary and would blank anything else.
  let qualification = '';
  if (intern.course) {
    const { rows } = await db.query(
      `SELECT value FROM master_values
        WHERE type = 'QUALIFICATION' AND is_active = true AND LOWER(BTRIM(value)) = LOWER(BTRIM($1::text))
          AND (company_id IS NULL OR company_id = $2::int)
        ORDER BY company_id NULLS FIRST LIMIT 1`, [intern.course, companyId]);
    qualification = rows[0]?.value ?? '';
  }
  const education = [
    [intern.course, intern.specialization].filter(Boolean).join(' — '),
    intern.college, intern.graduation_year ? `graduating ${intern.graduation_year}` : null,
  ].filter(Boolean).join(', ');

  return {
    intern: {
      id: intern.id, intern_code: intern.intern_code, status: intern.status,
      name: [intern.first_name, intern.last_name].filter(Boolean).join(' '),
      department: intern.department, designation: intern.designation,
      start_date: intern.start_date, end_date: intern.end_date, completed_on: intern.completed_on,
      photo_url: intern.photo_url, resume_file: resume?.file_url ?? null, resume_name: resume?.original_name ?? null,
    },
    eligibility,
    prefill: {
      first_name: intern.first_name || '',
      last_name: intern.last_name || '',
      dob: intern.dob || '',
      gender: intern.gender || '',
      personal_email: intern.personal_email || '',
      phone: intern.phone || '',
      current_address: intern.address || '',
      emergency_name: intern.emergency_name || '',
      emergency_phone: intern.emergency_phone || '',
      emergency_relationship: intern.emergency_relationship || '',
      highest_qualification: qualification,
      notes: `Converted from internship ${intern.intern_code} (${intern.department || '—'}, ${intern.designation || '—'}, `
        + `${intern.start_date} to ${intern.end_date}).${education ? ` Education: ${education}.` : ''}`,
    },
  };
}

/**
 * Inside the employee-create transaction, BEFORE the insert: lock the intern
 * and refuse anything not convertible. Returns the files the employee reuses.
 */
export async function lockConvertibleIntern(client, internId, companyId) {
  if (companyId == null) throw conflict('A conversion needs a company scope.', 'CONVERSION_NEEDS_COMPANY');
  const intern = await internRow(client, internId, companyId, { lock: true });
  if (!intern) throw Object.assign(new Error('Intern not found'), { statusCode: 404 });
  const eligibility = await conversionEligibility(client, intern);
  if (!eligibility.eligible) throw conflict(`This intern cannot be converted: ${eligibility.reason}`, 'NOT_ELIGIBLE_FOR_CONVERSION');
  const resume = await latestResume(client, intern.id);
  return { intern, eligibility, photo_url: intern.photo_url || null, resume_file: resume?.file_url || null };
}

/**
 * Inside the same transaction, AFTER the insert: link both records and audit.
 *
 * Both writes carry the intern's company and must change exactly one row. The
 * only caller (addEmployee) inserts the employee into the very company it
 * locked the intern under, so today the ids cannot disagree — but that safety
 * lived in the caller. Here it is enforced at the mutation: an employee or
 * intern from another company is refused and, by throwing, rolls the whole
 * conversion (employee insert included) back.
 */
export async function linkConversion(client, { intern, eligibility, employee, userId }) {
  const linked = await client.query(
    `UPDATE employees SET source_intern_id = $2::int WHERE id = $1::int AND company_id = $3::int`,
    [employee.id, intern.id, intern.company_id]);
  if (linked.rowCount !== 1) {
    throw conflict('The new employee is not in the intern\'s company.', 'CONVERSION_COMPANY_MISMATCH');
  }
  const marked = await client.query(
    `UPDATE interns SET converted_employee_id = $2::int, converted_at = NOW(), converted_by_user_id = $3::int,
            updated_by = $3::int, updated_at = NOW()
      WHERE id = $1::int AND company_id = $4::int`, [intern.id, employee.id, userId ?? null, intern.company_id]);
  if (marked.rowCount !== 1) {
    throw conflict('The intern is not in this company.', 'CONVERSION_COMPANY_MISMATCH');
  }
  await client.query(
    `INSERT INTO intern_audit_events (company_id, intern_id, action, actor_user_id, evaluation_id, details)
     VALUES ($1::int, $2::int, 'converted_to_employee', $3::int, $4::int, $5::jsonb)`,
    [intern.company_id, intern.id, userId ?? null, eligibility.evaluation_id ?? null,
     JSON.stringify({ employee_id: employee.id, employee_code: employee.office_id })]);
}
