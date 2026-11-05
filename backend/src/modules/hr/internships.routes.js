// ──────────────────────────────────────────────────────────────────────────────
// internships.routes.js — the intern register.
//
// Mounted at /api/interns (and /api/v1/interns). Every route is gated by
// `requirePermission('internships', …)` and scoped by companyOf(req) — never
// req.user.company_id, never a body field.
//
// Interns are a SEPARATE population from employees: their own table, their own
// INTxxx code, no salary assignment, no payroll, no attendance roster. What IS
// shared, deliberately:
//   - Department / Designation: the same masters, validated by the same
//     validateMasterValue() the employee form uses, stored by name.
//   - Mentor: an `employees` row of the intern's own company.
//   - Files: StorageService.uploadFile() writes the bytes; GET /api/files/:name
//     serves them (secureFiles.routes.js has an intern branch).
// ──────────────────────────────────────────────────────────────────────────────
import express from 'express';
import multer from 'multer';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import { uploadFile, deleteFile } from '../../services/StorageService.js';
import { respondError } from '../../shared/pgErrors.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { validateMasterValue } from '../../employees/employee.service.js';
import { nextInternCode } from '../../shared/internCode.js';
import { ALLOWED_MIME, MAX_FILE_BYTES } from './internshipUploads.js';
import {
  INTERN_STATUSES, CLOSED_STATUSES, STIPEND_FREQUENCIES, INTERN_DOC_TYPES,
  SOON_DAYS, MAX_DURATION_DAYS, VIEW_SQL, DURATION_BUCKETS, DURATION_BUCKET_SQL,
  MONTHLY_STIPEND_SQL, TOTAL_STIPEND_SQL,
  STATUS_TRANSITIONS, INITIAL_STATUSES, canTransition, GENERAL_DOC_KEYS,
  COMPLETING_RECOMMENDATIONS, EMPLOYMENT_RECOMMENDATION, COMPLETION_STAGES, COMPLETION_STAGE_SQL,
  REQUEST_STATUS_SQL,
} from '../../shared/internship.js';
import {
  TEMPLATE_KEYS, PLACEHOLDERS, DEFAULT_TEMPLATES, OWNER_MODULE, loadTemplate, renderTemplate,
  unknownPlaceholders, internValues, companyName, fmtDocDate,
} from '../../shared/internshipTemplates.js';
import { buildCertificatePdf } from '../../utils/internshipPdf.js';
import { conversionEligibility, conversionSource } from './internConversion.js';

const router = express.Router();

// ── Uploads ──────────────────────────────────────────────────────────────────
// The same type allowlist and size cap server.js applies to employee uploads
// (shared with the evaluations router via internshipUploads.js).
const DOC_FIELD = (key) => `doc_${key}`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'photo_file' && !file.mimetype.startsWith('image/')) {
      return cb(Object.assign(new Error('The photo must be an image (JPG, PNG, WebP or GIF).'), { status: 415 }));
    }
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`"${file.originalname}" is not allowed. Upload an image, PDF or Word document.`), { status: 415 }));
  },
}).fields([
  { name: 'photo_file', maxCount: 1 },
  // No doc_certificate: a certificate file arrives only through
  // POST /:id/certificate. Sent here it is an unexpected field (400).
  ...GENERAL_DOC_KEYS.map(k => ({ name: DOC_FIELD(k), maxCount: k === 'other' ? 5 : 2 })),
]);

/** Answer a multer error with a 4xx, not a 500. */
const answerUploadError = (res, err) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Each file must be 5 MB or smaller.' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const certificate = err.field === DOC_FIELD('certificate');
    return res.status(400).json({
      error: certificate
        ? 'A certificate is attached only when it is issued, from the intern record (Issue certificate).'
        : `Unexpected upload field "${err.field}".`,
      ...(certificate ? { field: 'certificate', code: 'CERTIFICATE_ACTION_REQUIRED' } : {}),
    });
  }
  return res.status(err.status || 400).json({ error: err.message });
};

const acceptFiles = (req, res, next) => upload(req, res, (err) => (err ? answerUploadError(res, err) : next()));

/** The certificate issuance action's one file: `certificate_file`. */
const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error(`"${file.originalname}" is not allowed. Upload an image, PDF or Word document.`), { status: 415 }))),
}).single('certificate_file');
const acceptCertificate = (req, res, next) =>
  certificateUpload(req, res, (err) => (err ? answerUploadError(res, err) : next()));

// ── Validation ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9]{10,13}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A 400 that names the form field it is about, so the form can mark it. */
function fieldError(field, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.field = field;
  return err;
}

const str = (v) => (v == null ? '' : String(v)).trim();
const optional = (v) => { const s = str(v); return s === '' || s === 'null' || s === 'undefined' ? null : s; };

function isoDate(raw, field, label) {
  const s = optional(raw);
  if (s == null) return null;
  if (!DATE_RE.test(s)) throw fieldError(field, `${label} must be a date (YYYY-MM-DD).`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw fieldError(field, `${label} is not a real date.`);
  }
  return s;
}

/** Inclusive day count between two YYYY-MM-DD strings — the same arithmetic as
 *  the generated `duration_days` column. */
export function inclusiveDays(start, end) {
  const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
}

/** Today in the server's local calendar, as YYYY-MM-DD (not UTC midnight). */
function todayIso() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * The education fields and the master_values vocabulary each one is chosen from
 * (registered in modules/master/vocabularies.js, seeded by 20261013000003).
 */
export const EDUCATION_VOCABS = {
  course:         { type: 'COURSE',         label: 'Course / degree' },
  specialization: { type: 'SPECIALIZATION', label: 'Specialization' },
  current_year:   { type: 'ACADEMIC_YEAR',  label: 'Year / semester' },
};

/**
 * Resolve a submitted education value against its vocabulary.
 *
 *  - Blank: null, or a 400 when the field is required.
 *  - An ACTIVE value of the vocabulary, shared (company_id NULL) or owned by the
 *    caller's company: returned in the master's spelling. Another tenant's own
 *    value is not visible here, so it is refused.
 *  - The value already stored on this intern, unchanged: kept as it is, even if
 *    it is not (or no longer) in the master. A legacy free-text course or a
 *    since-deactivated value must survive an unrelated edit, never be refused
 *    or cleared by it. Changing TO a value outside the master is refused.
 *
 * A direct lookup rather than canonicalValue() from shared/masterVocabulary.js,
 * because the stored-value exception and the company ordering above need the
 * row, not just membership in a cached list. (That cache is now cleared on every
 * master write, so either would see a value added through "+ Add new".)
 */
async function educationValue(db, field, raw, companyId, current, required) {
  const { type, label } = EDUCATION_VOCABS[field];
  const s = optional(raw);
  if (s == null) {
    if (required) throw fieldError(field, `${label} is required.`);
    return null;
  }
  const { rows } = await db.query(
    `SELECT value FROM master_values
      WHERE type = $1::varchar AND is_active = true
        AND LOWER(BTRIM(value)) = LOWER(BTRIM($2::text))
        AND (company_id IS NULL OR company_id = $3::int)
      ORDER BY company_id NULLS FIRST
      LIMIT 1`,
    [type, s, companyId ?? null]);
  if (rows.length) return rows[0].value;
  const stored = current?.[field];
  if (stored != null && String(stored).trim() === s) return stored;
  throw fieldError(field, `"${s}" is not in the ${label} list. Select a value from the list, or add it with "+ Add new".`);
}

/**
 * Is `from` -> `to` a move the general form may make? `from` null = create.
 * The documented map is STATUS_TRANSITIONS in shared/internship.js.
 */
export function assertStatusMove(from, to) {
  if (to === 'Completed' && from !== 'Completed') {
    throw Object.assign(fieldError('status',
      "An internship is completed from its record (Mark Completed), after HR approves the mentor's evaluation."),
    { code: 'COMPLETION_ACTION_REQUIRED' });
  }
  if (from == null) {
    if (!INITIAL_STATUSES.includes(to)) {
      throw fieldError('status', `A new internship starts as one of: ${INITIAL_STATUSES.join(', ')}.`);
    }
    return;
  }
  if (!canTransition(from, to)) {
    const allowed = STATUS_TRANSITIONS[from] || [];
    throw fieldError('status', allowed.length
      ? `${from} can move only to: ${allowed.join(', ')}.`
      : `A ${from} internship cannot change status.`);
  }
}

function assertNoCompletionFields(body, current) {
  const sent = (k) => optional(body?.[k]);
  const issued = ['true', '1', 'yes', 'on'].includes(str(body?.certificate_issued).toLowerCase());
  const changed = [];
  if (sent('completed_on') != null && sent('completed_on') !== (current?.completed_on ?? null)) changed.push('completed_on');
  if (issued && !current?.certificate_issued) changed.push('certificate_issued');
  if (sent('certificate_number') != null && sent('certificate_number') !== (current?.certificate_number ?? null)) changed.push('certificate_number');
  if (changed.length) {
    throw Object.assign(fieldError(changed[0],
      'Completion and certificate details are recorded from the intern record (Mark Completed / Issue certificate), not from this form.'),
    { code: 'COMPLETION_ACTION_REQUIRED' });
  }
}

/** Every editable column, in one list. Create and update both write exactly these. */
const EDITABLE = [
  'first_name', 'last_name', 'dob', 'gender', 'personal_email', 'phone', 'address',
  'emergency_name', 'emergency_phone', 'emergency_relationship',
  'college', 'course', 'specialization', 'current_year', 'graduation_year',
  'department', 'designation', 'mentor_employee_id', 'internship_type',
  'start_date', 'end_date', 'status', 'status_reason',
  'stipend', 'stipend_frequency', 'other_benefits', 'notes', 'project_work_area',
];
// completed_on / certificate_issued / certificate_number are NOT editable here.
// They are written only by POST /:id/complete and the certificate actions.

/**
 * Validate a submitted form into column values.
 *
 * Create and update take the SAME complete form, so this validates the whole
 * record every time: an update is checked against the result it would produce,
 * not field by field. `current` is the stored row on update (for the mentor
 * exception below), undefined on create.
 *
 * @returns {Promise<object>} column → value, for every column in EDITABLE
 */
export async function validateIntern(body, companyId, db, current) {
  const v = {};
  v.first_name = str(body.first_name);
  if (!v.first_name) throw fieldError('first_name', 'First name is required.');
  v.last_name = optional(body.last_name);
  v.dob = isoDate(body.dob, 'dob', 'Date of birth');
  if (v.dob && v.dob >= todayIso()) throw fieldError('dob', 'Date of birth must be in the past.');
  v.gender = optional(body.gender);
  if (v.gender && !['Male', 'Female', 'Other'].includes(v.gender)) throw fieldError('gender', 'Select a gender from the list.');

  v.personal_email = optional(body.personal_email);
  if (v.personal_email && !EMAIL_RE.test(v.personal_email)) throw fieldError('personal_email', 'Enter a valid email address, e.g. name@example.com.');
  const phone = (raw, field, label) => {
    const s = optional(raw);
    if (s == null) return null;
    const digits = s.replace(/[\s\-()]/g, '');
    if (!PHONE_RE.test(digits)) throw fieldError(field, `${label} must be 10 to 13 digits.`);
    return digits;
  };
  v.phone = phone(body.phone, 'phone', 'Phone');
  v.address = optional(body.address);
  v.emergency_name = optional(body.emergency_name);
  v.emergency_phone = phone(body.emergency_phone, 'emergency_phone', 'Emergency phone');
  v.emergency_relationship = optional(body.emergency_relationship);

  v.college = str(body.college);
  if (!v.college) throw fieldError('college', 'College / institution is required.');
  v.course = await educationValue(db, 'course', body.course, companyId, current, true);
  v.specialization = await educationValue(db, 'specialization', body.specialization, companyId, current, false);
  v.current_year = await educationValue(db, 'current_year', body.current_year, companyId, current, false);
  const gy = optional(body.graduation_year);
  if (gy == null) v.graduation_year = null;
  else {
    const n = Number(gy);
    if (!Number.isInteger(n) || n < 1950 || n > 2100) throw fieldError('graduation_year', 'Graduation year must be a year such as 2027.');
    v.graduation_year = n;
  }

  v.department = str(body.department);
  if (!v.department) throw fieldError('department', 'Select a department.');
  v.designation = str(body.designation);
  if (!v.designation) throw fieldError('designation', 'Select an internship role.');
  try {
    await validateMasterValue(v.department, 'master_departments', companyId);
  } catch (e) { throw fieldError('department', e.message); }
  try {
    await validateMasterValue(v.designation, 'master_designations', companyId);
  } catch (e) { throw fieldError('designation', e.message); }

  // Mentor: an employee of THIS company. A new choice must be a current
  // employee; an unchanged mentor who has since left is kept, because refusing
  // the whole edit over a field nobody touched is worse than leaving it alone.
  const mentorRaw = optional(body.mentor_employee_id);
  if (mentorRaw == null) v.mentor_employee_id = null;
  else {
    const id = Number(mentorRaw);
    if (!Number.isInteger(id) || id < 1) throw fieldError('mentor_employee_id', 'Select a mentor from the list.');
    const unchanged = current && Number(current.mentor_employee_id) === id;
    const { rows } = await db.query(
      `SELECT id FROM employees
        WHERE id = $1::int AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2::int)
          ${unchanged ? '' : `AND ${isCurrentSql('status')}`}`,
      [id, companyId ?? null]);
    if (!rows.length) throw fieldError('mentor_employee_id', 'That mentor is not a current employee of your company.');
    v.mentor_employee_id = id;
  }
  v.internship_type = optional(body.internship_type);

  v.start_date = isoDate(body.start_date, 'start_date', 'Start date');
  if (!v.start_date) throw fieldError('start_date', 'Start date is required.');
  v.end_date = isoDate(body.end_date, 'end_date', 'End date');
  if (!v.end_date) throw fieldError('end_date', 'End date is required.');
  if (v.end_date < v.start_date) throw fieldError('end_date', 'End date cannot be before the start date.');
  if (inclusiveDays(v.start_date, v.end_date) > MAX_DURATION_DAYS) {
    throw fieldError('end_date', `An internship cannot be longer than ${MAX_DURATION_DAYS} days.`);
  }

  v.status = str(body.status) || (current ? current.status : 'Selected');
  if (!INTERN_STATUSES.includes(v.status)) throw fieldError('status', `Status must be one of: ${INTERN_STATUSES.join(', ')}.`);
  assertStatusMove(current ? current.status : null, v.status);
  v.status_reason = optional(body.status_reason);

  const stipendRaw = optional(body.stipend);
  if (stipendRaw == null) v.stipend = null;
  else {
    const n = Number(stipendRaw);
    if (!Number.isFinite(n) || n < 0 || n > 10000000) throw fieldError('stipend', 'Stipend must be a positive amount.');
    v.stipend = Math.round(n * 100) / 100;
  }
  v.stipend_frequency = optional(body.stipend_frequency);
  if (v.stipend_frequency && !STIPEND_FREQUENCIES.includes(v.stipend_frequency)) {
    throw fieldError('stipend_frequency', `Stipend frequency must be one of: ${STIPEND_FREQUENCIES.join(', ')}.`);
  }
  if (v.stipend != null && v.stipend > 0 && !v.stipend_frequency) {
    throw fieldError('stipend_frequency', 'Select how often the stipend is paid.');
  }
  if (v.stipend_frequency === 'Unpaid' && v.stipend) {
    throw fieldError('stipend', 'An unpaid internship cannot carry a stipend amount.');
  }
  v.other_benefits = optional(body.other_benefits);

  // Completion and certificate fields are not part of this form. Sending a
  // value that differs from what is stored is refused, not silently dropped, so
  // an old client cannot believe it completed or certified an internship.
  assertNoCompletionFields(body, current);
  v.notes = optional(body.notes);
  v.project_work_area = optional(body.project_work_area);
  if (v.project_work_area && v.project_work_area.length > 500) {
    throw fieldError('project_work_area', 'Project / work area is limited to 500 characters.');
  }
  return v;
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Upload every file in the request. Returns what was written, so a failed
 *  save can remove it again rather than leaving unindexed bytes behind. */
async function storeUploads(reqFiles) {
  const stored = { photo: null, docs: [] };
  if (!reqFiles) return stored;
  const photo = reqFiles.photo_file?.[0];
  if (photo) stored.photo = await uploadFile(photo.buffer, photo.originalname, photo.mimetype);
  for (const [key, type] of Object.entries(INTERN_DOC_TYPES)) {
    for (const f of reqFiles[DOC_FIELD(key)] || []) {
      stored.docs.push({
        doc_type: type,
        file_url: await uploadFile(f.buffer, f.originalname, f.mimetype),
        original_name: f.originalname,
        mime_type: f.mimetype,
        size_bytes: f.size,
      });
    }
  }
  return stored;
}

async function discardUploads(stored) {
  const urls = [stored.photo, ...stored.docs.map(d => d.file_url)].filter(Boolean);
  await Promise.all(urls.map(u => deleteFile(u).catch(() => {})));
}

async function insertDocs(client, internId, companyId, docs, titles, userId) {
  for (const d of docs) {
    await client.query(
      `INSERT INTO intern_documents
         (company_id, intern_id, doc_type, title, file_url, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1::int, $2::int, $3::varchar, $4::varchar, $5::text, $6::varchar, $7::varchar, $8::int, $9::int)`,
      [companyId, internId, d.doc_type, titles[d.doc_type] ?? null, d.file_url,
       d.original_name, d.mime_type, d.size_bytes, userId ?? null]);
  }
}

// ── Read SQL (exported so the integration suite runs the same statements) ────

export const LIST_SELECT = `
  i.id, i.intern_code, i.first_name, i.last_name,
  BTRIM(CONCAT_WS(' ', i.first_name, i.last_name)) AS name,
  i.photo_url, i.personal_email, i.phone,
  i.college, i.course, i.department, i.designation, i.internship_type,
  i.mentor_employee_id,
  NULLIF(BTRIM(CONCAT_WS(' ', m.first_name, m.last_name)), '') AS mentor_name,
  m.office_id AS mentor_office_id,
  i.start_date::text AS start_date, i.end_date::text AS end_date, i.duration_days,
  ${DURATION_BUCKET_SQL} AS duration_bucket,
  i.status, i.stipend, i.stipend_frequency,
  i.completed_on::text AS completed_on, i.certificate_issued,
  ${COMPLETION_STAGE_SQL} AS completion_stage,
  i.converted_employee_id, ce.office_id AS converted_employee_code`;

export const LIST_FROM = `
  FROM interns i
  LEFT JOIN employees m ON m.id = i.mentor_employee_id
  LEFT JOIN employees ce ON ce.id = i.converted_employee_id`;

/**
 * Build the WHERE clause for the register from query parameters. Every filter
 * the page offers, and every population a summary card opens, goes through here.
 */
export function buildListFilter(query, companyId) {
  const where = ['i.deleted_at IS NULL'];
  const params = [];
  // A function replacement, not a string: in a replacement STRING `$1` is a
  // capture-group reference, which is how `$` has gone missing here before.
  const add = (sql, value) => { params.push(value); const n = params.length; where.push(sql.replace(/\?/g, () => `$${n}`)); };

  if (companyId != null) add('i.company_id = ?::int', companyId);
  const view = str(query.view);
  if (view) {
    if (!VIEW_SQL[view]) throw fieldError('view', `Unknown view "${view}".`);
    where.push(`(${VIEW_SQL[view]})`);
  }
  const statuses = str(query.status).split(',').map(s => s.trim()).filter(Boolean);
  if (statuses.length) {
    const bad = statuses.find(s => !INTERN_STATUSES.includes(s));
    if (bad) throw fieldError('status', `Unknown status "${bad}".`);
    add('i.status = ANY(?::varchar[])', statuses);
  }
  if (str(query.stage)) {
    if (!COMPLETION_STAGES.includes(str(query.stage))) throw fieldError('stage', `Unknown stage "${str(query.stage)}".`);
    add(`(${COMPLETION_STAGE_SQL}) = ?::text`, str(query.stage));
  }
  if (str(query.department)) add('LOWER(BTRIM(i.department)) = LOWER(BTRIM(?::text))', str(query.department));
  if (str(query.college)) add('LOWER(BTRIM(i.college)) = LOWER(BTRIM(?::text))', str(query.college));
  if (str(query.internship_type)) add('LOWER(BTRIM(i.internship_type)) = LOWER(BTRIM(?::text))', str(query.internship_type));
  if (str(query.mentor_id)) {
    const id = Number(query.mentor_id);
    if (!Number.isInteger(id)) throw fieldError('mentor_id', 'mentor_id must be an employee id.');
    add('i.mentor_employee_id = ?::int', id);
  }
  if (str(query.duration)) {
    if (!DURATION_BUCKETS.includes(str(query.duration))) throw fieldError('duration', 'Unknown duration band.');
    add(`(${DURATION_BUCKET_SQL}) = ?::text`, str(query.duration));
  }
  for (const [param, sql] of [
    ['start_from', 'i.start_date >= ?::date'], ['start_to', 'i.start_date <= ?::date'],
    ['end_from', 'i.end_date >= ?::date'], ['end_to', 'i.end_date <= ?::date'],
  ]) {
    const d = isoDate(query[param], param, param.replace('_', ' '));
    if (d) add(sql, d);
  }
  const q = str(query.q);
  if (q) {
    add(`(i.intern_code ILIKE ? OR CONCAT_WS(' ', i.first_name, i.last_name) ILIKE ?
          OR i.college ILIKE ? OR i.personal_email ILIKE ?)`, `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`);
  }
  return { where: where.join(' AND '), params };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const userIdOf = (req) => req.user?.userId ?? req.user?.id ?? null;

/** A write needs a company to file the intern under. A global (no-company)
 *  scope can read across tenants but cannot create an intern in none. */
function writeCompany(req, res) {
  const companyId = companyOf(req);
  if (companyId == null) {
    res.status(400).json({ error: 'Your account is not assigned to a company, so it cannot record interns.' });
    return null;
  }
  return companyId;
}

function sendError(res, err) {
  if (err?.statusCode) {
    const code = typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {};
    return res.status(err.statusCode).json({ error: err.message, field: err.field, ...code });
  }
  return respondError(res, err);
}

router.get('/', requirePermission('internships', 'view'), async (req, res) => {
  try {
    const { where, params } = buildListFilter(req.query, companyOf(req));
    const { rows } = await pool.query(
      `SELECT ${LIST_SELECT} ${LIST_FROM} WHERE ${where}
        ORDER BY i.start_date DESC, i.id DESC`, params);
    res.json(rows);
  } catch (err) { sendError(res, err); }
});

/**
 * Summary cards + reports. Every number carries the filter that reproduces it,
 * so a card or a report row opens exactly the interns it counted.
 */
router.get('/summary', requirePermission('internships', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  try {
    const scope = companyId != null ? 'AND i.company_id = $1::int' : '';
    const params = companyId != null ? [companyId] : [];
    const base = `FROM interns i WHERE i.deleted_at IS NULL ${scope}`;
    const count = (pred) => `COUNT(*) FILTER (WHERE ${pred})::int`;

    const { rows: [cards] } = await pool.query(
      `SELECT ${count(VIEW_SQL.active)} AS active,
              ${count(VIEW_SQL.starting_soon)} AS starting_soon,
              ${count(VIEW_SQL.ending_soon)} AS ending_soon,
              ${count(VIEW_SQL.completed)} AS completed,
              ${count(VIEW_SQL.awaiting_completion)} AS awaiting_completion,
              ${count(VIEW_SQL.evaluation_pending)} AS evaluation_pending,
              ${count(VIEW_SQL.converted)} AS converted,
              COUNT(*)::int AS total
         ${base}`, params);

    const group = async (expr, extra = 'TRUE') => (await pool.query(
      `SELECT ${expr} AS label, COUNT(*)::int AS count ${base} AND (${extra})
        GROUP BY 1 ORDER BY 2 DESC, 1`, params)).rows;

    const byStatusRows = await group('i.status');
    const byStatus = INTERN_STATUSES.map(s => ({
      label: s, count: byStatusRows.find(r => r.label === s)?.count ?? 0, filter: { status: s },
    }));
    const byDurationRows = await group(DURATION_BUCKET_SQL);
    const byDuration = DURATION_BUCKETS.map(b => ({
      label: b, count: byDurationRows.find(r => r.label === b)?.count ?? 0, filter: { duration: b },
    }));
    const activeByDepartment = (await group('i.department', VIEW_SQL.active))
      .map(r => ({ ...r, filter: { view: 'active', department: r.label } }));
    const byCollege = (await group('i.college'))
      .map(r => ({ ...r, filter: { college: r.label } }));

    // Stipend: the population being paid NOW (Onboarding + Active), as a
    // monthly run-rate and as the committed cost of those internships.
    const { rows: [spend] } = await pool.query(
      `SELECT COALESCE(SUM(${MONTHLY_STIPEND_SQL}), 0)::numeric(14,2) AS monthly_run_rate,
              COALESCE(SUM(${TOTAL_STIPEND_SQL}), 0)::numeric(14,2)   AS committed_total,
              COUNT(*) FILTER (WHERE COALESCE(i.stipend, 0) > 0 AND i.stipend_frequency <> 'Unpaid')::int AS paid,
              COUNT(*) FILTER (WHERE NOT (COALESCE(i.stipend, 0) > 0 AND i.stipend_frequency <> 'Unpaid'))::int AS unpaid
         ${base} AND (${VIEW_SQL.current})`, params);
    const { rows: spendByDept } = await pool.query(
      `SELECT i.department AS label, COUNT(*)::int AS count,
              COALESCE(SUM(${MONTHLY_STIPEND_SQL}), 0)::numeric(14,2) AS monthly
         ${base} AND (${VIEW_SQL.current})
        GROUP BY 1 ORDER BY 3 DESC, 1`, params);
    const { rows: [allTime] } = await pool.query(
      `SELECT COALESCE(SUM(${TOTAL_STIPEND_SQL}), 0)::numeric(14,2) AS total ${base}
          AND i.status NOT IN ('Applied','Selected','Cancelled')`, params);

    res.json({
      soon_days: SOON_DAYS,
      cards,
      card_filters: {
        active: { view: 'active' }, starting_soon: { view: 'starting_soon' },
        ending_soon: { view: 'ending_soon' }, completed: { view: 'completed' },
        awaiting_completion: { view: 'awaiting_completion' }, total: {},
        evaluation_pending: { view: 'evaluation_pending' }, converted: { view: 'converted' },
      },
      reports: {
        active_by_department: activeByDepartment,
        by_college: byCollege,
        by_duration: byDuration,
        by_status: byStatus,
        stipend: {
          monthly_run_rate: Number(spend.monthly_run_rate),
          committed_total: Number(spend.committed_total),
          paid: spend.paid, unpaid: spend.unpaid,
          all_time_total: Number(allTime.total),
          by_department: spendByDept.map(r => ({
            label: r.label, count: r.count, monthly: Number(r.monthly),
            filter: { view: 'current', department: r.label },
          })),
        },
      },
    });
  } catch (err) { sendError(res, err); }
});

/** Values in use, for the register's filter dropdowns. */
router.get('/filter-options', requirePermission('internships', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  try {
    const scope = companyId != null ? 'AND i.company_id = $1::int' : '';
    const params = companyId != null ? [companyId] : [];
    const distinct = async (col) => (await pool.query(
      `SELECT DISTINCT BTRIM(${col}) AS v FROM interns i
        WHERE i.deleted_at IS NULL ${scope} AND NULLIF(BTRIM(${col}), '') IS NOT NULL ORDER BY 1`, params))
      .rows.map(r => r.v);
    const { rows: mentors } = await pool.query(
      `SELECT DISTINCT m.id, NULLIF(BTRIM(CONCAT_WS(' ', m.first_name, m.last_name)), '') AS name, m.office_id
         FROM interns i JOIN employees m ON m.id = i.mentor_employee_id
        WHERE i.deleted_at IS NULL ${scope} ORDER BY 2`, params);
    res.json({
      departments: await distinct('i.department'),
      colleges: await distinct('i.college'),
      internship_types: await distinct('i.internship_type'),
      mentors,
      statuses: INTERN_STATUSES,
      completion_stages: COMPLETION_STAGES,
      durations: DURATION_BUCKETS,
    });
  } catch (err) { sendError(res, err); }
});

/** Current employees of the caller's company, for the Mentor picker. */
router.get('/mentor-options', requirePermission('internships', 'view'), async (req, res) => {
  const companyId = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, NULLIF(BTRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name,
              office_id, designation, department
         FROM employees
        WHERE deleted_at IS NULL AND ${isCurrentSql('status')}
          AND ($1::int IS NULL OR company_id = $1::int)
        ORDER BY first_name, last_name`, [companyId ?? null]);
    res.json(rows);
  } catch (err) { sendError(res, err); }
});

/** Form vocabularies, served so the form and the API cannot disagree. */
router.get('/meta', requirePermission('internships', 'view'), (_req, res) => {
  res.json({
    statuses: INTERN_STATUSES, closed_statuses: CLOSED_STATUSES,
    transitions: STATUS_TRANSITIONS, initial_statuses: INITIAL_STATUSES,
    stipend_frequencies: STIPEND_FREQUENCIES,
    // The general form's upload slots: no Certificate (see GENERAL_DOC_KEYS).
    doc_types: GENERAL_DOC_KEYS.map(key => ({ key, label: INTERN_DOC_TYPES[key], field: DOC_FIELD(key) })),
    soon_days: SOON_DAYS, max_duration_days: MAX_DURATION_DAYS,
    completion_stages: COMPLETION_STAGES,
  });
});

/** Preview of the next Intern ID. The real code is minted inside the create
 *  transaction, so this is informational only. */
router.get('/next-code', requirePermission('internships', 'add'), async (req, res) => {
  const companyId = companyOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = await nextInternCode(client, companyId ?? null);
    await client.query('COMMIT');
    res.json({ code });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});


// ── Document templates ───────────────────────────────────────────────────────
// Completion Certificate and Mentor Evaluation Letter, per company, in the
// existing document_templates table (see shared/internshipTemplates.js).
// Read: internships:view. Maintain: internships:edit (HR).

const MAX_TEMPLATE_CHARS = 8000;

router.get('/templates', requirePermission('internships', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) {
      return res.json(TEMPLATE_KEYS.map(key => ({ key, ...DEFAULT_TEMPLATES[key], is_default: true, placeholders: PLACEHOLDERS[key] })));
    }
    res.json(await Promise.all(TEMPLATE_KEYS.map(key => loadTemplate(pool, companyId, key))));
  } catch (err) { sendError(res, err); }
});

router.put('/templates/:key', requirePermission('internships', 'edit'), async (req, res) => {
  const key = String(req.params.key);
  if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown template' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  try {
    const heading = str(req.body?.heading);
    const content = String(req.body?.content ?? '').replace(/\r\n/g, '\n').trim();
    const signatoryName = optional(req.body?.signatory_name);
    const signatoryTitle = optional(req.body?.signatory_title);
    if (!heading) throw fieldError('heading', 'Enter the document heading.');
    if (heading.length > 200) throw fieldError('heading', 'The heading is limited to 200 characters.');
    if (!content) throw fieldError('content', 'The template text cannot be empty.');
    if (content.length > MAX_TEMPLATE_CHARS) throw fieldError('content', `The template text is limited to ${MAX_TEMPLATE_CHARS} characters.`);
    if ((signatoryName || '').length > 150) throw fieldError('signatory_name', 'Signatory name is too long.');
    if ((signatoryTitle || '').length > 150) throw fieldError('signatory_title', 'Signatory title is too long.');
    const bad = unknownPlaceholders(key, `${heading}\n${content}`);
    if (bad.length) {
      throw fieldError('content', `Unknown field${bad.length > 1 ? 's' : ''}: ${bad.map(b => `{{${b}}}`).join(', ')}. Use only the fields listed beside the editor.`);
    }
    const before = await loadTemplate(pool, companyId, key);
    const { rows: [row] } = await pool.query(
      `INSERT INTO document_templates
         (name, category, content, heading, signatory_name, signatory_title, company_id, owner_module, template_key,
          is_active, updated_by)
       VALUES ($1::varchar, 'Internship', $2::text, $3::varchar, $4::varchar, $5::varchar, $6::int, $7::varchar, $8::varchar,
               true, $9::int)
       ON CONFLICT (company_id, owner_module, template_key) WHERE deleted_at IS NULL AND owner_module IS NOT NULL
       DO UPDATE SET content = EXCLUDED.content, heading = EXCLUDED.heading,
                     signatory_name = EXCLUDED.signatory_name, signatory_title = EXCLUDED.signatory_title,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING id`,
      // updated_by is a users.id. created_by is NOT written: on this legacy
      // table it references employees(id), and an HR login need not be one.
      [DEFAULT_TEMPLATES[key].name, content, heading, signatoryName, signatoryTitle, companyId, OWNER_MODULE, key, userIdOf(req)]);
    const after = await loadTemplate(pool, companyId, key);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: row.id, recordType: 'internship_template',
      action: 'update', oldData: before, newData: after, req, company_id: companyId });
    res.json(after);
  } catch (err) { sendError(res, err); }
});

/** DELETE /templates/:key — back to the built-in default (the row is soft-deleted). */
router.delete('/templates/:key', requirePermission('internships', 'edit'), async (req, res) => {
  const key = String(req.params.key);
  if (!TEMPLATE_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown template' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  try {
    const before = await loadTemplate(pool, companyId, key);
    await pool.query(
      `UPDATE document_templates SET deleted_at = NOW(), updated_by = $4::int, updated_at = NOW()
        WHERE company_id = $1::int AND owner_module = $2::varchar AND template_key = $3::varchar AND deleted_at IS NULL`,
      [companyId, OWNER_MODULE, key, userIdOf(req)]);
    if (!before.is_default) {
      logAudit({ userId: userIdOf(req), module: 'internships', recordId: before.id, recordType: 'internship_template',
        action: 'delete', oldData: before, req, company_id: companyId });
    }
    res.json(await loadTemplate(pool, companyId, key));
  } catch (err) { sendError(res, err); }
});

/** The rendered certificate text and the values behind it. */
async function certificateContent(db, intern, companyId, { number, issueDate }) {
  const tpl = await loadTemplate(db, companyId, 'completion_certificate');
  const company = await companyName(db, companyId);
  const values = {
    ...internValues(intern, company),
    certificate_number: number, certificate_issue_date: fmtDocDate(issueDate),
    signatory_name: tpl.signatory_name, signatory_title: tpl.signatory_title,
  };
  return {
    heading: renderTemplate(tpl.heading, values), text: renderTemplate(tpl.content, values),
    certificateNumber: number, issueDate: fmtDocDate(issueDate), companyName: company,
    signatoryName: tpl.signatory_name, signatoryTitle: tpl.signatory_title,
  };
}

/**
 * The next certificate number for an intern: <INTxxx>/CERT/<year>/<n>, n
 * counting every certificate the intern was ever issued (revoked ones too, so a
 * replacement never reuses a number). Unique per company because the intern
 * code is; issuance still checks.
 */
async function nextCertificateNumber(db, intern) {
  const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS n FROM intern_certificates WHERE intern_id = $1::int`, [intern.id]);
  return `${intern.intern_code}/CERT/${todayIso().slice(0, 4)}/${r.n + 1}`;
}

const sendPdf = (res, pdf, filename) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdf);
};

async function loadIntern(db, id, companyId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT i.*, i.dob::text AS dob, i.start_date::text AS start_date, i.end_date::text AS end_date,
            i.completed_on::text AS completed_on,
            ${DURATION_BUCKET_SQL} AS duration_bucket,
            NULLIF(BTRIM(CONCAT_WS(' ', m.first_name, m.last_name)), '') AS mentor_name,
            m.office_id AS mentor_office_id, m.designation AS mentor_designation,
            ${COMPLETION_STAGE_SQL} AS completion_stage,
            ce.office_id AS converted_employee_code,
            NULLIF(BTRIM(CONCAT_WS(' ', ce.first_name, ce.last_name)), '') AS converted_employee_name,
            cu.name AS converted_by_name
       FROM interns i
       LEFT JOIN employees m ON m.id = i.mentor_employee_id
       LEFT JOIN employees ce ON ce.id = i.converted_employee_id
       LEFT JOIN users cu ON cu.id = i.converted_by_user_id
      WHERE i.id = $1::int AND i.deleted_at IS NULL
        AND ($2::int IS NULL OR i.company_id = $2::int)
      ${lock ? 'FOR UPDATE OF i' : ''}`,
    [id, companyId ?? null]);
  return rows[0] ?? null;
}

async function loadDocs(db, internId) {
  const { rows } = await db.query(
    `SELECT id, doc_type, title, file_url, original_name, mime_type, size_bytes, uploaded_at
       FROM intern_documents
      WHERE intern_id = $1::int AND deleted_at IS NULL
      ORDER BY uploaded_at, id`, [internId]);
  return rows;
}

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

const parseId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };

router.get('/:id', requirePermission('internships', 'view'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  try {
    const intern = await loadIntern(pool, id, companyOf(req));
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    intern.documents = await loadDocs(pool, id);
    intern.completion = await completionEligibility(pool, intern);
    intern.certificates = await loadCertificates(pool, id);
    intern.lifecycle_events = await loadLifecycleEvents(pool, id, intern.company_id);
    intern.conversion = await conversionEligibility(pool, intern);
    res.json(intern);
  } catch (err) { sendError(res, err); }
});

/**
 * GET /:id/conversion — what "Convert to Employee" needs: eligibility, the
 * intern summary, and the Add Employee pre-fill (internConversion.js). The
 * employee itself is created by POST /employees with from_intern_id.
 */
router.get('/:id/conversion', requirePermission('internships', 'view'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  try {
    const source = await conversionSource(pool, id, companyId);
    if (!source) return res.status(404).json({ error: 'Intern not found' });
    res.json(source);
  } catch (err) { sendError(res, err); }
});

/**
 * GET /:id/certificate/preview.pdf — the certificate as it would be issued now,
 * from the company's template. Only for an internship that can be (or has
 * been) certified, so a preview is never mistaken for the real thing earlier.
 */
router.get('/:id/certificate/preview.pdf', requirePermission('internships', 'view'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  try {
    const intern = await loadIntern(pool, id, companyId);
    if (!intern) return res.status(404).json({ error: 'Intern not found' });
    if (intern.status !== 'Completed') {
      return res.status(409).json({ error: 'A certificate exists only for a completed internship.', code: 'NOT_ELIGIBLE_FOR_CERTIFICATE' });
    }
    const number = optional(req.query.number) || intern.certificate_number || await nextCertificateNumber(pool, intern);
    const pdf = await buildCertificatePdf(await certificateContent(pool, intern, companyId, { number, issueDate: todayIso() }));
    sendPdf(res, pdf, `Certificate-preview-${intern.intern_code}.pdf`);
  } catch (err) { sendError(res, err); }
});

/** `title_<doc type key>` fields carry an optional label per uploaded document. */
const titlesFrom = (body) => Object.fromEntries(Object.entries(INTERN_DOC_TYPES)
  .map(([key, type]) => [type, optional(body[`title_${key}`])]));

router.post('/', requirePermission('internships', 'add'), acceptFiles, async (req, res) => {
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  // Validate BEFORE checking out a client. validateMasterValue() queries the
  // shared pool, and asking the pool for a second connection while holding one
  // is how a burst of concurrent saves starves it.
  let v;
  try { v = await validateIntern(req.body, companyId, pool); } catch (err) { return sendError(res, err); }
  let stored = { photo: null, docs: [] };
  const client = await pool.connect();
  try {
    stored = await storeUploads(req.files);
    await client.query('BEGIN');
    const code = await nextInternCode(client, companyId);
    const cols = ['company_id', 'intern_code', 'photo_url', 'created_by', 'updated_by', ...EDITABLE];
    const vals = [companyId, code, stored.photo, userIdOf(req), userIdOf(req), ...EDITABLE.map(c => v[c])];
    const { rows: [row] } = await client.query(
      `INSERT INTO interns (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
    await insertDocs(client, row.id, companyId, stored.docs, titlesFrom(req.body), userIdOf(req));
    await client.query('COMMIT');
    const intern = await loadIntern(client, row.id, companyId);
    intern.documents = await loadDocs(client, row.id);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: row.id, recordType: 'intern',
      action: 'create', newData: intern, req, company_id: companyId });
    res.status(201).json(intern);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await discardUploads(stored);
    sendError(res, err);
  } finally { client.release(); }
});

router.put('/:id', requirePermission('internships', 'edit'), acceptFiles, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  // Validated against the stored row BEFORE a client is checked out — see POST.
  let v;
  try {
    const current = await loadIntern(pool, id, companyId);
    if (!current) return res.status(404).json({ error: 'Intern not found' });
    v = await validateIntern(req.body, companyId, pool, current);
  } catch (err) { return sendError(res, err); }
  let stored = { photo: null, docs: [] };
  const client = await pool.connect();
  try {
    stored = await storeUploads(req.files);
    await client.query('BEGIN');
    const before = await loadIntern(client, id, companyId, { lock: true });
    if (!before) {
      await client.query('ROLLBACK');
      await discardUploads(stored);
      return res.status(404).json({ error: 'Intern not found' });
    }
    before.documents = await loadDocs(client, id);
    // Re-checked under the row lock: the status may have moved since the
    // unlocked validation above (e.g. completed by another HR user).
    assertStatusMove(before.status, v.status);

    const removePhoto = ['true', '1'].includes(str(req.body.remove_photo).toLowerCase());
    const photo = stored.photo ?? (removePhoto ? null : before.photo_url);
    const sets = EDITABLE.map((c, i) => `${c} = $${i + 1}`);
    const vals = EDITABLE.map(c => v[c]);
    vals.push(photo, userIdOf(req), id, companyId);
    const n = vals.length;
    await client.query(
      `UPDATE interns SET ${sets.join(', ')}, photo_url = $${n - 3}, updated_by = $${n - 2}::int, updated_at = NOW()
        WHERE id = $${n - 1}::int AND company_id = $${n}::int`, vals);

    // Removals name document ids; only this intern's own rows are touched.
    const removeIds = str(req.body.remove_documents).split(',').map(Number).filter(x => Number.isInteger(x) && x > 0);
    if (removeIds.some(rid => before.documents.find(d => d.id === rid)?.doc_type === 'Certificate')) {
      throw Object.assign(httpError(400, 'A certificate is withdrawn by revoking it, not by removing the file.'),
        { field: 'certificate', code: 'CERTIFICATE_ACTION_REQUIRED' });
    }
    if (removeIds.length) {
      await client.query(
        `UPDATE intern_documents SET deleted_at = NOW()
          WHERE intern_id = $1::int AND company_id = $2::int AND id = ANY($3::int[]) AND deleted_at IS NULL`,
        [id, companyId, removeIds]);
    }
    await insertDocs(client, id, companyId, stored.docs, titlesFrom(req.body), userIdOf(req));
    await client.query('COMMIT');

    const after = await loadIntern(client, id, companyId);
    after.documents = await loadDocs(client, id);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: id, recordType: 'intern',
      action: before.status !== after.status ? 'status_change' : 'update',
      oldData: before, newData: after, req, company_id: companyId });
    res.json(after);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await discardUploads(stored);
    sendError(res, err);
  } finally { client.release(); }
});

// ── Completion and certificates ──────────────────────────────────────────────
//
// The ONLY ways to complete an internship or to issue / revoke its certificate.
// The general create/update refuse all three (assertStatusMove,
// assertNoCompletionFields, no doc_certificate upload slot), and the database
// refuses them too (trg_interns_completion_guard). Each action locks the intern,
// re-checks eligibility under the lock, and records an explicit
// intern_audit_events row as well as an audit_logs entry.

/**
 * May this internship be completed now? The latest evaluation (any mentor) must
 * be Approved and recommend completion; an older approval does not count once a
 * newer evaluation exists, because that newer one is the mentor's current view.
 */
async function completionEligibility(db, intern) {
  if (intern.status === 'Completed') return { eligible: false, reason: 'This internship is already completed.' };
  if (intern.status !== 'Active') {
    return { eligible: false, reason: `Only an Active internship can be completed; this one is ${intern.status}.` };
  }
  const { rows: [latest] } = await db.query(
    `SELECT id, status, recommendation FROM intern_evaluations
      WHERE intern_id = $1::int AND company_id = $2::int ORDER BY id DESC LIMIT 1`,
    [intern.id, intern.company_id]);
  if (!latest) return { eligible: false, reason: 'No mentor evaluation yet. Use Request Mentor Evaluation.' };
  if (latest.status !== 'Approved') {
    return { eligible: false, reason: `The mentor's evaluation is ${latest.status}; HR must approve it first.`, evaluation_id: latest.id };
  }
  if (!COMPLETING_RECOMMENDATIONS.includes(latest.recommendation)) {
    return { eligible: false, reason: `The approved evaluation recommends "${latest.recommendation}", so the internship stays open.`, evaluation_id: latest.id };
  }
  return { eligible: true, reason: null, evaluation_id: latest.id };
}

async function loadCertificates(db, internId) {
  const { rows } = await db.query(
    `SELECT c.id, c.certificate_number, c.document_id, c.issued_at, c.issued_by_user_id, iu.name AS issued_by_name,
            c.revoked_at, c.revoked_by_user_id, ru.name AS revoked_by_name, c.revoke_reason,
            d.file_url, d.original_name
       FROM intern_certificates c
       LEFT JOIN users iu ON iu.id = c.issued_by_user_id
       LEFT JOIN users ru ON ru.id = c.revoked_by_user_id
       LEFT JOIN intern_documents d ON d.id = c.document_id AND d.deleted_at IS NULL
      WHERE c.intern_id = $1::int
      ORDER BY c.id DESC`, [internId]);
  return rows;
}

async function loadLifecycleEvents(db, internId, companyId) {
  const { rows } = await db.query(
    `SELECT x.id, x.action, x.actor_user_id, u.name AS actor_name, x.evaluation_id, x.certificate_id,
            x.reason, x.details, x.created_at
       FROM intern_audit_events x LEFT JOIN users u ON u.id = x.actor_user_id
      WHERE x.intern_id = $1::int AND x.company_id = $2::int
      ORDER BY x.id`, [internId, companyId]);
  return rows;
}

async function recordLifecycle(db, req, intern, action, { evaluationId = null, certificateId = null, reason = null, details = {} }) {
  await db.query(
    `INSERT INTO intern_audit_events (company_id, intern_id, action, actor_user_id, evaluation_id, certificate_id, reason, details)
     VALUES ($1::int, $2::int, $3::varchar, $4::int, $5::int, $6::int, $7::text, $8::jsonb)`,
    [intern.company_id, intern.id, action, userIdOf(req), evaluationId, certificateId, reason, JSON.stringify(details)]);
}

/** Reload the intern with everything the record page shows, on `db`. */
async function fullIntern(db, id, companyId) {
  const intern = await loadIntern(db, id, companyId);
  intern.documents = await loadDocs(db, id);
  intern.completion = await completionEligibility(db, intern);
  intern.certificates = await loadCertificates(db, id);
  intern.lifecycle_events = await loadLifecycleEvents(db, id, companyId);
  intern.conversion = await conversionEligibility(db, intern);
  return intern;
}

/** POST /:id/complete  { completed_on } — Active → Completed, on an approved evaluation. */
router.post('/:id/complete', requirePermission('internships', 'edit'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intern = await loadIntern(client, id, companyId, { lock: true });
    if (!intern) throw httpError(404, 'Intern not found');
    const eligibility = await completionEligibility(client, intern);
    if (!eligibility.eligible) {
      throw Object.assign(httpError(409, eligibility.reason), { code: 'NOT_ELIGIBLE_FOR_COMPLETION' });
    }
    const completedOn = isoDate(req.body?.completed_on, 'completed_on', 'Completion date');
    if (!completedOn) throw fieldError('completed_on', 'Enter the date the internship was completed.');
    if (completedOn < intern.start_date) throw fieldError('completed_on', 'Completion date cannot be before the start date.');
    if (completedOn > todayIso()) throw fieldError('completed_on', 'Completion date cannot be in the future.');

    await client.query(
      `UPDATE interns SET status = 'Completed', completed_on = $3::date, completion_evaluation_id = $4::int,
              updated_by = $5::int, updated_at = NOW()
        WHERE id = $1::int AND company_id = $2::int`,
      [id, companyId, completedOn, eligibility.evaluation_id, userIdOf(req)]);
    await recordLifecycle(client, req, intern, 'completed', {
      evaluationId: eligibility.evaluation_id,
      details: { from_status: intern.status, completed_on: completedOn },
    });
    await client.query('COMMIT');
    const after = await fullIntern(client, id, companyId);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: id, recordType: 'intern',
      action: 'complete', oldData: { status: intern.status }, newData: { status: 'Completed', completed_on: completedOn,
        completion_evaluation_id: eligibility.evaluation_id }, req, company_id: companyId });
    res.json(after);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/**
 * POST /:id/certificate  multipart { certificate_number, certificate_file? }
 *
 * Only for an internship completed through POST /:id/complete (it carries the
 * approved evaluation it rested on), and only when no certificate is active.
 * Replacing a certificate is revoke-then-issue, each audited; the revoked number
 * is never reissued.
 */
router.post('/:id/certificate', requirePermission('internships', 'edit'), acceptCertificate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  // generate=true: the PDF is produced from the company's certificate template
  // (an uploaded file then is refused — one document per certificate).
  const generate = ['true', '1', 'yes'].includes(str(req.body?.generate).toLowerCase());
  if (generate && req.file) {
    return res.status(400).json({ error: 'Either generate the certificate from the template or upload a file, not both.', field: 'certificate_file' });
  }
  let number = optional(req.body?.certificate_number);
  if (number && number.length > 100) return res.status(400).json({ error: 'Certificate number is too long.', field: 'certificate_number' });

  let fileUrl = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intern = await loadIntern(client, id, companyId, { lock: true });
    if (!intern) throw httpError(404, 'Intern not found');
    if (intern.status !== 'Completed' || intern.completion_evaluation_id == null) {
      throw Object.assign(httpError(409, 'A certificate can be issued only for an internship completed after an approved mentor evaluation.'),
        { code: 'NOT_ELIGIBLE_FOR_CERTIFICATE' });
    }
    // Blank number: the next one in the intern's own series (under the lock).
    if (!number) number = await nextCertificateNumber(client, intern);
    const { rows: [active] } = await client.query(
      `SELECT id, certificate_number FROM intern_certificates WHERE intern_id = $1::int AND revoked_at IS NULL`, [id]);
    if (active) {
      throw Object.assign(httpError(409, `Certificate ${active.certificate_number} is already issued. Revoke it first to issue a replacement.`),
        { code: 'CERTIFICATE_ALREADY_ISSUED' });
    }
    const { rows: [taken] } = await client.query(
      `SELECT c.intern_id, i.intern_code, c.revoked_at FROM intern_certificates c JOIN interns i ON i.id = c.intern_id
        WHERE c.company_id = $1::int AND LOWER(BTRIM(c.certificate_number)) = LOWER(BTRIM($2::text))`, [companyId, number]);
    if (taken) {
      throw Object.assign(httpError(409, taken.revoked_at
        ? `Certificate number ${number} was used before and revoked; numbers are never reissued.`
        : `Certificate number ${number} is already issued to ${taken.intern_code}.`), { field: 'certificate_number' });
    }

    let documentId = null;
    let file = req.file;
    if (generate) {
      const buffer = await buildCertificatePdf(await certificateContent(client, intern, companyId, { number, issueDate: todayIso() }));
      const name = `Certificate-${intern.intern_code}-${number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
      file = { buffer, originalname: name, mimetype: 'application/pdf', size: buffer.length };
    }
    if (file) {
      fileUrl = await uploadFile(file.buffer, file.originalname, file.mimetype);
      const { rows: [doc] } = await client.query(
        `INSERT INTO intern_documents (company_id, intern_id, doc_type, title, file_url, original_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1::int, $2::int, 'Certificate', $3::varchar, $4::text, $5::varchar, $6::varchar, $7::int, $8::int) RETURNING id`,
        [companyId, id, `Certificate ${number}`, fileUrl, file.originalname, file.mimetype, file.size, userIdOf(req)]);
      documentId = doc.id;
    }
    const { rows: [cert] } = await client.query(
      `INSERT INTO intern_certificates (company_id, intern_id, certificate_number, document_id, issued_by_user_id)
       VALUES ($1::int, $2::int, $3::varchar, $4::int, $5::int) RETURNING id`,
      [companyId, id, number, documentId, userIdOf(req)]);
    await client.query(
      `UPDATE interns SET certificate_issued = true, certificate_number = $3::varchar, updated_by = $4::int, updated_at = NOW()
        WHERE id = $1::int AND company_id = $2::int`, [id, companyId, number, userIdOf(req)]);
    await recordLifecycle(client, req, intern, 'certificate_issued', {
      certificateId: cert.id, details: { certificate_number: number, document_id: documentId, generated: generate },
    });
    await client.query('COMMIT');
    const after = await fullIntern(client, id, companyId);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: id, recordType: 'intern_certificate',
      action: 'issue_certificate', newData: { certificate_id: cert.id, certificate_number: number, document_id: documentId },
      req, company_id: companyId });
    res.status(201).json(after);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (fileUrl) await deleteFile(fileUrl).catch(() => {});
    if (err?.code === '23505') return res.status(409).json({ error: `Certificate number ${number} is already in use.`, field: 'certificate_number' });
    sendError(res, err);
  } finally { client.release(); }
});

/**
 * POST /:id/certificate/revoke  { reason }
 *
 * internships:approve (the same grant that approves evaluations — not widened
 * here). The certificate row is kept with who/when/why; its file stops being
 * served (soft-deleted document); the intern's display copy is cleared.
 */
router.post('/:id/certificate/revoke', requirePermission('internships', 'approve'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid intern id' });
  const companyId = writeCompany(req, res);
  if (companyId == null) return;
  const reason = optional(req.body?.reason);
  if (!reason) return res.status(400).json({ error: 'Give a reason for revoking the certificate.', field: 'reason' });
  if (reason.length > 2000) return res.status(400).json({ error: 'Reason is too long.', field: 'reason' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intern = await loadIntern(client, id, companyId, { lock: true });
    if (!intern) throw httpError(404, 'Intern not found');
    const { rows: [active] } = await client.query(
      `SELECT id, certificate_number, document_id FROM intern_certificates
        WHERE intern_id = $1::int AND company_id = $2::int AND revoked_at IS NULL FOR UPDATE`, [id, companyId]);
    if (!active) throw Object.assign(httpError(409, 'This internship has no issued certificate to revoke.'), { code: 'NO_ACTIVE_CERTIFICATE' });

    await client.query(
      `UPDATE intern_certificates SET revoked_at = NOW(), revoked_by_user_id = $2::int, revoke_reason = $3::text
        WHERE id = $1::int`, [active.id, userIdOf(req), reason]);
    if (active.document_id) {
      await client.query(`UPDATE intern_documents SET deleted_at = NOW() WHERE id = $1::int AND deleted_at IS NULL`, [active.document_id]);
    }
    await client.query(
      `UPDATE interns SET certificate_issued = false, certificate_number = NULL, updated_by = $3::int, updated_at = NOW()
        WHERE id = $1::int AND company_id = $2::int`, [id, companyId, userIdOf(req)]);
    await recordLifecycle(client, req, intern, 'certificate_revoked', {
      certificateId: active.id, reason, details: { certificate_number: active.certificate_number },
    });
    await client.query('COMMIT');
    const after = await fullIntern(client, id, companyId);
    logAudit({ userId: userIdOf(req), module: 'internships', recordId: id, recordType: 'intern_certificate',
      action: 'revoke_certificate', oldData: { certificate_id: active.id, certificate_number: active.certificate_number },
      newData: { revoked: true, reason }, req, company_id: companyId });
    res.json(after);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

export default router;
