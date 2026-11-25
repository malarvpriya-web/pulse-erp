/**
 * Joining letters — issued at onboarding, kept with the employee's documents.
 *
 * Owner, 18 Nov 26: "First we will send only the offer mail, not the offer
 * letter. The offer letter, appointment letter, confidential letter — everything
 * will be issued during the onboarding only, and saved where the employee's
 * documents (Add Employee) are saved, in their name."
 *
 * So:
 *   • The offer e-mail goes out on approval WITHOUT an attachment
 *     (approvals.controller.js).
 *   • HR issues each letter for a hired employee from Recruitment → Offer &
 *     Onboarding → Onboarding. Issuing builds the PDF, stores it as
 *     "<EMP code>_<Name>_<Letter>.pdf", and files it on the employee record —
 *     employees.offer_letter_file / appointment_letter_file /
 *     confidentiality_letter_file, the same slots Add / Edit Employee shows
 *     under Upload Documents (HR can upload the signed copy over it there).
 *   • employee_letter_issues keeps every copy issued (re-issue keeps history).
 *
 * The company's wording is in Reports & Setup → Settings; the employee's own
 * details (designation, joining date, probation, notice, manager) come from the
 * employee record, and CTC from the accepted offer.
 */
import { buildProbationLetterPdf } from '../../utils/probationLetterPdf.js';
import { buildOfferLetterPdf, letterDate, rupees, OFFER_LETTER_DEFAULTS } from './offerLetter.js';
import { uploadFile } from '../../services/StorageService.js';

export const LETTER_TYPES = {
  offer:           { column: 'offer_letter_file',           label: 'Offer Letter' },
  appointment:     { column: 'appointment_letter_file',     label: 'Appointment Letter' },
  confidentiality: { column: 'confidentiality_letter_file', label: 'Confidentiality Letter' },
};

// Keep in step with RecruitmentSettings.jsx (the defaults shown there).
export const JOINING_LETTER_DEFAULTS = {
  appointment_letter_terms: [
    'Your working hours, weekly offs, holidays and leave will be as per the company policies in force from time to time.',
    'You will follow the company rules, policies and code of conduct, as they are amended from time to time.',
    'You may be transferred or deputed to any location, department or associated company of the organisation as business needs require.',
    'You will keep all company information confidential during and after your employment, as set out in the confidentiality letter given to you.',
    'Either side may end this employment by giving the notice period that applies to you, or salary in lieu of notice, as per company policy.',
  ].join('\n\n'),
  appointment_letter_closing: 'Please sign and return a copy of this letter as your acceptance of these terms.',
  confidentiality_letter_terms: [
    'During your employment you will have access to confidential information of the company, its customers and suppliers, including designs, drawings, software, prices, customer lists, business plans and employee data.',
    'You will use this information only for your work for the company, and will not disclose it to anyone outside the company, or to colleagues who do not need it, without written permission.',
    'Anything you design, write or develop as part of your work belongs to the company.',
    'When you leave, or whenever the company asks, you will return all documents, devices and copies of company information in your possession.',
    'These obligations continue after your employment ends.',
  ].join('\n\n'),
  confidentiality_letter_closing: 'Please sign below to confirm that you have read, understood and accept these terms.',
};

async function wording(db, companyId) {
  const { rows: [s] } = await db.query(
    `SELECT settings FROM company_settings WHERE module = 'recruitment' AND company_id = $1 LIMIT 1`, [companyId])
    .catch(() => ({ rows: [] }));
  const out = { ...JOINING_LETTER_DEFAULTS, offer_letter_signatory_title: OFFER_LETTER_DEFAULTS.offer_letter_signatory_title };
  for (const k of Object.keys(out)) {
    const v = s?.settings?.[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

const paragraphs = (text) => String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

/** The employee, their company, manager and accepted offer — company-scoped. */
export async function employeeLetterData(db, { companyId, employeeId }) {
  const { rows: [r] } = await db.query(
    `SELECT e.id, e.office_id, e.name, e.designation, e.department, e.location, e.employment_type,
            e.joining_date, e.probation_end_date, e.probation_months, e.notice_period_days,
            e.personal_email, e.company_email, e.current_address, e.company_id, e.source_candidate_id,
            m.name AS manager_name, m.designation AS manager_designation,
            co.name AS company_name, co.address, co.city, co.state, co.pincode,
            o.id AS offer_id, o.offer_no, o.offered_salary
       FROM employees e
       JOIN companies co ON co.id = e.company_id
       LEFT JOIN employees m ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT ol.id, ol.offer_no, ol.offered_salary FROM offer_letters ol
          WHERE ol.candidate_id = e.source_candidate_id AND ol.offer_status = 'accepted' AND ol.deleted_at IS NULL
          ORDER BY ol.updated_at DESC NULLS LAST LIMIT 1
       ) o ON TRUE
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)`,
    [employeeId, companyId ?? null]);
  return r || null;
}

const companyAddress = (r) => [r.address, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
const recipient = (r) => [r.name, r.office_id ? `Employee code ${r.office_id}` : null, r.current_address].filter(Boolean);

async function buildAppointment(db, r, signer) {
  const w = await wording(db, r.company_id);
  const role = r.designation || 'the position offered to you';
  const paras = [
    `Dear ${r.name},`,
    `Further to your acceptance of our offer${r.offer_no ? ` (${r.offer_no})` : ''}, we are pleased to appoint you as ${role}${r.department ? ` in the ${r.department} department` : ''} at ${r.company_name}${r.joining_date ? `, with effect from ${letterDate(r.joining_date)}` : ''}.`,
    [
      r.office_id ? `Your employee code is ${r.office_id}.` : null,
      r.manager_name ? `You will report to ${r.manager_name}${r.manager_designation ? `, ${r.manager_designation}` : ''}.` : null,
      r.location ? `Your place of work will be ${r.location}.` : null,
    ].filter(Boolean).join(' '),
    r.offered_salary
      ? `Your annual cost to company (CTC) will be ${rupees(r.offered_salary)}, paid monthly as per your salary structure, less statutory deductions.`
      : 'Your salary will be paid monthly as per your salary structure, less statutory deductions.',
    r.probation_end_date
      ? `You will be on probation${r.probation_months ? ` for ${r.probation_months} months` : ''}, until ${letterDate(r.probation_end_date)}. Your confirmation will be communicated to you in writing.`
      : null,
    r.notice_period_days ? `After confirmation, the notice period on either side will be ${r.notice_period_days} days.` : null,
    ...paragraphs(w.appointment_letter_terms),
    w.appointment_letter_closing,
  ].filter(Boolean);
  return buildProbationLetterPdf({
    companyName: r.company_name, companyAddress: companyAddress(r),
    reference: `APT-${r.office_id || r.id}`, letterDate: letterDate(new Date()),
    recipient: recipient(r), subject: `Letter of appointment - ${role}`,
    body: [...paras, `Accepted by ${r.name}: ____________________    Date: ____________`].join('\n\n'),
    signatoryName: signer, signatoryTitle: w.offer_letter_signatory_title,
  });
}

async function buildConfidentiality(db, r, signer) {
  const w = await wording(db, r.company_id);
  const paras = [
    `Dear ${r.name},`,
    `As ${r.designation || 'an employee'}${r.department ? ` in the ${r.department} department` : ''} of ${r.company_name}, you agree to the following.`,
    ...paragraphs(w.confidentiality_letter_terms),
    w.confidentiality_letter_closing,
  ];
  return buildProbationLetterPdf({
    companyName: r.company_name, companyAddress: companyAddress(r),
    reference: `CNF-${r.office_id || r.id}`, letterDate: letterDate(new Date()),
    recipient: recipient(r), subject: 'Confidentiality undertaking',
    body: [...paras, `Signed by ${r.name}: ____________________    Date: ____________`].join('\n\n'),
    signatoryName: signer, signatoryTitle: w.offer_letter_signatory_title,
  });
}

const httpErr = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Builds the PDF for one letter (nothing stored). */
export async function buildJoiningLetter(db, { companyId, employeeId, type, signatoryUserId }) {
  if (!LETTER_TYPES[type]) throw httpErr(400, 'Unknown letter type', 'LETTER_TYPE');
  const r = await employeeLetterData(db, { companyId, employeeId });
  if (!r) throw httpErr(404, 'Employee not found', 'NOT_FOUND');
  const { rows: [u] } = await db.query(`SELECT name FROM users WHERE id = $1`, [signatoryUserId ?? null]);
  const signer = u?.name || '';
  let pdf;
  if (type === 'offer') {
    if (!r.offer_id) throw httpErr(409, 'This employee has no accepted offer in Recruitment, so there is no offer letter to issue. Upload it on the employee record instead.', 'NO_ACCEPTED_OFFER');
    pdf = (await buildOfferLetterPdf(db, { companyId: r.company_id, offerId: r.offer_id, signatoryUserId }))?.pdf;
  } else if (type === 'appointment') {
    pdf = await buildAppointment(db, r, signer);
  } else {
    pdf = await buildConfidentiality(db, r, signer);
  }
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const filename = `${[safe(r.office_id), safe(r.name), safe(LETTER_TYPES[type].label)].filter(Boolean).join('_')}.pdf`;
  return { pdf, filename, employee: r };
}

/** Issue = build, store, file on the employee record, keep history. */
export async function issueJoiningLetter(db, { companyId, employeeId, type, userId }) {
  const { pdf, filename, employee } = await buildJoiningLetter(db, { companyId, employeeId, type, signatoryUserId: userId });
  const url = await uploadFile(pdf, filename, 'application/pdf');
  const col = LETTER_TYPES[type].column; // fixed whitelist, never user text
  // Scoped to the company too, so a write can never land on another tenant's employee.
  await db.query(`UPDATE employees SET ${col} = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`, [url, employee.id, employee.company_id]);
  const { rows: [row] } = await db.query(
    `INSERT INTO employee_letter_issues (company_id, employee_id, letter_type, file_url, reference, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, issued_at`,
    [employee.company_id, employee.id, type, url, type === 'offer' ? employee.offer_no : null, userId ?? null]);
  return { type, file_url: url, filename, issued_at: row.issued_at };
}

/** What is on file for each letter now, and when it was last issued. */
export async function listJoiningLetters(db, { companyId, employeeId }) {
  const r = await employeeLetterData(db, { companyId, employeeId });
  if (!r) return null;
  const { rows: files } = await db.query(
    `SELECT offer_letter_file, appointment_letter_file, confidentiality_letter_file FROM employees WHERE id = $1`, [r.id]);
  const { rows: issues } = await db.query(
    `SELECT DISTINCT ON (i.letter_type) i.letter_type, i.file_url, i.issued_at, u.name AS issued_by_name,
            COUNT(*) OVER (PARTITION BY i.letter_type)::int AS times_issued
       FROM employee_letter_issues i LEFT JOIN users u ON u.id = i.issued_by
      WHERE i.employee_id = $1 ORDER BY i.letter_type, i.issued_at DESC`, [r.id]);
  const byType = Object.fromEntries(issues.map(i => [i.letter_type, i]));
  return {
    employee_id: r.id, employee_code: r.office_id, name: r.name,
    letters: Object.entries(LETTER_TYPES).map(([type, t]) => {
      const file = files[0]?.[t.column] || null;
      const last = byType[type];
      return {
        type, label: t.label, file_url: file,
        // On file but not issued from here (or replaced since) = uploaded on the employee record.
        source: !file ? null : last && last.file_url === file ? 'issued' : 'uploaded',
        last_issued_at: last?.issued_at ?? null, last_issued_by: last?.issued_by_name ?? null,
        times_issued: last?.times_issued ?? 0,
        can_issue: type !== 'offer' || Boolean(r.offer_id),
        blocked_reason: type === 'offer' && !r.offer_id ? 'No accepted offer in Recruitment' : null,
      };
    }),
  };
}
