/**
 * Internship document templates — the Completion Certificate and the Mentor
 * Evaluation Letter.
 *
 * Stored in the EXISTING `document_templates` table as rows owned by
 * owner_module = 'internships' and one company (20261013000006). A company that
 * has not edited a template has no row and gets the default below; "Reset to
 * default" deletes the company's row. One row per (company, key).
 *
 * The body is plain text with {{placeholder}} fields. Saving refuses a
 * placeholder this module does not fill, so a typo is caught when HR writes the
 * template, not discovered on a certificate that went out with "{{intern_nme}}".
 * The structured parts of the evaluation letter (rating grid, recommendation
 * boxes, comments, signature block) are drawn by utils/internshipPdf.js from the
 * evaluation vocabulary, so they cannot drift from what the mentor can enter.
 */

export const OWNER_MODULE = 'internships';

export const TEMPLATE_KEYS = ['completion_certificate', 'evaluation_letter'];

const COMMON = {
  intern_name: 'Intern full name',
  intern_code: 'Intern ID (INTxxx)',
  department: 'Department',
  internship_role: 'Internship role',
  project_work_area: 'Project / work area',
  start_date: 'Internship start date',
  end_date: 'Internship end date',
  internship_period: 'Start – end date',
  duration: 'Duration, e.g. "6 months"',
  company_name: 'Your company name',
};

export const PLACEHOLDERS = {
  completion_certificate: {
    ...COMMON,
    college: 'College / institution',
    course: 'Course',
    specialization: 'Specialization',
    course_specialization: 'Course — specialization',
    certificate_number: 'Certificate number',
    certificate_issue_date: 'Certificate issue date',
    signatory_name: 'Authorized signatory name',
    signatory_title: 'Authorized signatory title',
  },
  evaluation_letter: {
    ...COMMON,
    mentor_name: 'Mentor name',
    request_date: 'Date the evaluation was requested',
  },
};

export const DEFAULT_TEMPLATES = {
  completion_certificate: {
    name: 'Internship Completion Certificate',
    heading: 'CERTIFICATE OF INTERNSHIP COMPLETION',
    content: [
      'This is to certify that {{intern_name}} ({{intern_code}}), a student of {{course_specialization}} at {{college}}, has successfully completed an internship with {{company_name}}.',
      '',
      'Department: {{department}}',
      'Internship Role: {{internship_role}}',
      'Project / Work Area: {{project_work_area}}',
      'Internship Period: {{start_date}} to {{end_date}} ({{duration}})',
      '',
      'During the internship, {{intern_name}} worked with dedication and conducted themselves professionally. We wish them every success in their future endeavours.',
    ].join('\n'),
    signatory_name: '',
    signatory_title: 'Authorized Signatory',
  },
  evaluation_letter: {
    name: 'Internship Completion / Evaluation Letter',
    heading: 'INTERNSHIP EVALUATION — MENTOR FORM',
    content: [
      'Dear {{mentor_name}},',
      '',
      '{{intern_name}} ({{intern_code}}) is completing an internship in {{department}} as {{internship_role}} for the period {{internship_period}}, working on: {{project_work_area}}.',
      '',
      'As the mentor, please rate the intern on each area below, add your comments and recommendation, then sign and return this form to HR.',
    ].join('\n'),
    signatory_name: '',
    signatory_title: '',
  },
};

const FIELD_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Placeholders used in `text` that `key`'s template does not fill. */
export function unknownPlaceholders(key, text) {
  const known = PLACEHOLDERS[key] || {};
  const bad = new Set();
  for (const m of String(text || '').matchAll(FIELD_RE)) if (!(m[1] in known)) bad.add(m[1]);
  return [...bad];
}

/** Fill {{fields}}; a known field with no value renders as "—". */
export function renderTemplate(text, values) {
  return String(text || '').replace(FIELD_RE, (whole, k) => {
    if (!(k in values)) return whole;
    const v = values[k];
    return v == null || String(v).trim() === '' ? '—' : String(v);
  });
}

/** "12 Oct 2026" — the date style used across the module. */
export function fmtDocDate(d) {
  if (!d) return '';
  const s = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (!y || !m || !day) return '';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(day).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

/** Calendar-month duration, the same wording as the intern record page. */
export function durationWords(start, end) {
  if (!start || !end) return '';
  const toUtc = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const days = Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
  if (!(days > 0)) return '';
  if (days < 28) return `${days} day${days === 1 ? '' : 's'}`;
  const [sy, sm, sd] = String(start).slice(0, 10).split('-').map(Number);
  const after = new Date(toUtc(end)); after.setUTCDate(after.getUTCDate() + 1);
  let months = (after.getUTCFullYear() - sy) * 12 + (after.getUTCMonth() - (sm - 1));
  let anchor = new Date(Date.UTC(sy, sm - 1 + months, sd));
  if (anchor > after) { months -= 1; anchor = new Date(Date.UTC(sy, sm - 1 + months, sd)); }
  const rem = Math.round((after - anchor) / 86400000);
  return [months > 0 ? `${months} month${months === 1 ? '' : 's'}` : '', rem > 0 ? `${rem} day${rem === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' ') || `${days} days`;
}

/** Field values for an intern row (as loaded by internships.routes.js loadIntern). */
export function internValues(intern, companyName) {
  const name = [intern.first_name, intern.last_name].filter(Boolean).join(' ').trim();
  return {
    intern_name: name,
    intern_code: intern.intern_code,
    college: intern.college,
    course: intern.course,
    specialization: intern.specialization,
    course_specialization: [intern.course, intern.specialization].filter(Boolean).join(' — '),
    department: intern.department,
    internship_role: intern.designation,
    project_work_area: intern.project_work_area,
    start_date: fmtDocDate(intern.start_date),
    end_date: fmtDocDate(intern.end_date),
    internship_period: `${fmtDocDate(intern.start_date)} to ${fmtDocDate(intern.end_date)}`,
    duration: durationWords(intern.start_date, intern.end_date),
    company_name: companyName || '',
    mentor_name: intern.mentor_name,
  };
}

/**
 * The template in force for (company, key): the company's own row, else the
 * default. `is_default` tells the page which one it is showing.
 */
export async function loadTemplate(db, companyId, key) {
  const { rows } = await db.query(
    `SELECT id, name, heading, content, signatory_name, signatory_title, updated_at, updated_by
       FROM document_templates
      WHERE owner_module = $1::varchar AND company_id = $2::int AND template_key = $3::varchar
        AND deleted_at IS NULL
      LIMIT 1`, [OWNER_MODULE, companyId, key]);
  const d = DEFAULT_TEMPLATES[key];
  if (!rows.length) return { key, ...d, is_default: true, placeholders: PLACEHOLDERS[key] };
  const r = rows[0];
  return {
    key, id: r.id, name: r.name || d.name, heading: r.heading ?? d.heading, content: r.content ?? d.content,
    signatory_name: r.signatory_name ?? '', signatory_title: r.signatory_title ?? '',
    updated_at: r.updated_at, updated_by: r.updated_by, is_default: false, placeholders: PLACEHOLDERS[key],
  };
}

/** The company's display name, for {{company_name}}. */
export async function companyName(db, companyId) {
  const { rows } = await db.query(`SELECT name FROM companies WHERE id = $1::int`, [companyId]);
  return rows[0]?.name || '';
}
