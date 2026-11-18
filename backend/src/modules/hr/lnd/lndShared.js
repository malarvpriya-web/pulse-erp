/**
 * Learning Center — helpers shared by every L&D router (consolidated 2026-11-18).
 *
 *   cid(req)            tenant, through companyOf() — never req.user.company_id
 *   isLndAdmin(req)     every role the user holds (rolesOf), not just the first
 *   lndRange(query)     the period filter used on every L&D screen: past
 *                       windows (last 3 / 6 / 12 months, quarter, FY) for
 *                       "what did we run", future ones for "what is coming"
 *   getSettings()       lnd_settings with defaults — the one place they are read
 *   upsertRating()      the single skill/competency rating write path
 *   notifyEmployees()   in-app notification (+ e-mail when SMTP is configured)
 */
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';
import { rolesOf } from '../../../middlewares/auth.middleware.js';
import notificationsRepository from '../../notifications/repositories/notifications.repository.js';
import { triggerEmail } from '../../../services/emailTrigger.js';

export const cid = (req) => companyOf(req);

export const LND_ADMIN_ROLES = ['super_admin', 'superadmin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'lnd_admin'];
export const isLndAdmin = (req) => rolesOf(req).some(r => LND_ADMIN_ROLES.includes(r));

export const PROGRAM_STATUSES = ['planned', 'ongoing', 'completed', 'cancelled'];
export const ENROLLMENT_STATUSES = ['enrolled', 'in_progress', 'completed', 'no_show', 'withdrawn'];
export const MODES = ['offline', 'online', 'hybrid'];
export const COST_TYPES = ['trainer_fee', 'venue', 'materials', 'travel', 'food', 'certification', 'other'];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };

export const LND_PERIODS = ['all', 'last3m', 'last6m', 'last12m', 'qtd', 'last_quarter', 'fytd', 'last_fy',
  'next3m', 'next6m', 'upcoming', 'custom'];

/**
 * Resolve ?period=&from=&to= into inclusive YYYY-MM-DD bounds (null = open).
 * Trainings run every 3–6 months, so the quarter / half-year windows matter as
 * much as the financial year; future windows serve the calendar.
 */
export function lndRange(query = {}, fallback = 'all', now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const t = iso(today);
  const from = ISO.test(String(query.from || '')) ? String(query.from) : null;
  const to = ISO.test(String(query.to || '')) ? String(query.to) : null;
  if (from || to) {
    const [lo, hi] = from && to && from > to ? [to, from] : [from, to];
    return { period: 'custom', from: lo, to: hi, label: `${lo || '…'} to ${hi || '…'}` };
  }
  const p = LND_PERIODS.includes(String(query.period)) ? String(query.period) : fallback;
  const fyStart = new Date(today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1, 3, 1);
  const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
  switch (p) {
    case 'last3m': return { period: p, from: iso(addMonths(today, -3)), to: t, label: 'Last 3 months' };
    case 'last6m': return { period: p, from: iso(addMonths(today, -6)), to: t, label: 'Last 6 months' };
    case 'last12m': return { period: p, from: iso(addMonths(today, -12)), to: t, label: 'Last 12 months' };
    case 'qtd': return { period: p, from: iso(qStart), to: iso(new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0)), label: 'This quarter' };
    case 'last_quarter': {
      const s = addMonths(qStart, -3);
      return { period: p, from: iso(s), to: iso(new Date(qStart.getFullYear(), qStart.getMonth(), 0)), label: 'Last quarter' };
    }
    case 'fytd': return { period: p, from: iso(fyStart), to: iso(new Date(fyStart.getFullYear() + 1, 2, 31)), label: 'This financial year' };
    case 'last_fy': return { period: p, from: iso(new Date(fyStart.getFullYear() - 1, 3, 1)), to: iso(new Date(fyStart.getFullYear(), 2, 31)), label: 'Last financial year' };
    case 'next3m': return { period: p, from: t, to: iso(addMonths(today, 3)), label: 'Next 3 months' };
    case 'next6m': return { period: p, from: t, to: iso(addMonths(today, 6)), label: 'Next 6 months' };
    case 'upcoming': return { period: p, from: t, to: null, label: 'Upcoming' };
    default: return { period: 'all', from: null, to: null, label: 'All time' };
  }
}

/** A blank / 'all' query value means "no filter". */
export const dim = (q, key) => {
  const v = q?.[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' || s.toLowerCase() === 'all' ? null : s;
};
export const intOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
};
export const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const dateOrNull = (v) => (ISO.test(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);
export const strOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Small parameter builder: p.add(value) → '$n'. */
export function params(initial = []) {
  const list = [...initial];
  return { list, add(v) { list.push(v); return `$${list.length}`; } };
}

export const SETTINGS_DEFAULTS = {
  training_categories: ['Technical', 'Soft Skills', 'Safety', 'Compliance', 'Quality', 'Leadership', 'Onboarding'],
  default_pass_score: 70,
  default_max_attempts: 3,
  reminder_days_before: 3,
  cert_expiry_reminder_days: 30,
  default_refresher_months: 12,
  enable_email_notifications: true,
  enable_manager_notifications: true,
  feedback_required: false,
  min_feedback_chars: 0,
  allow_self_enrollment: true,
  max_concurrent_enrollments: 5,
};

export async function getSettings(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM lnd_settings WHERE company_id IS NOT DISTINCT FROM $1::int LIMIT 1`, [companyId]);
  const row = rows[0] || {};
  const out = { ...SETTINGS_DEFAULTS };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) if (row[k] != null) out[k] = row[k];
  if (!Array.isArray(out.training_categories) || !out.training_categories.length) {
    out.training_categories = SETTINGS_DEFAULTS.training_categories;
  }
  return out;
}

/**
 * The single write path for a skill / competency rating.
 * Automatic sources (training, assessment, certification) only ever RAISE a
 * level — finishing a course must not lower what a manager rated. A manual or
 * performance rating is taken as given.
 */
export async function upsertRating(db, { employeeId, competencyId, level, source, companyId, assessedBy = null, assessedByUser = null, notes = null, yearsExperience = null }) {
  if (!employeeId || !competencyId || !level) return null;
  const lvl = Math.max(1, Math.min(5, Math.round(Number(level))));
  const automatic = ['training', 'assessment', 'certification'].includes(source);
  const { rows } = await db.query(
    `INSERT INTO employee_competency_assessments
       (employee_id, competency_id, assessed_level, source, assessed_by, assessed_by_user, notes, years_experience, company_id, assessed_date, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,NOW())
     ON CONFLICT (employee_id, competency_id) DO UPDATE SET
       assessed_level   = ${automatic ? 'GREATEST(employee_competency_assessments.assessed_level, EXCLUDED.assessed_level)' : 'EXCLUDED.assessed_level'},
       source           = ${automatic ? `CASE WHEN EXCLUDED.assessed_level > employee_competency_assessments.assessed_level THEN EXCLUDED.source ELSE employee_competency_assessments.source END` : 'EXCLUDED.source'},
       assessed_by      = COALESCE(EXCLUDED.assessed_by, employee_competency_assessments.assessed_by),
       assessed_by_user = COALESCE(EXCLUDED.assessed_by_user, employee_competency_assessments.assessed_by_user),
       notes            = COALESCE(EXCLUDED.notes, employee_competency_assessments.notes),
       years_experience = COALESCE(EXCLUDED.years_experience, employee_competency_assessments.years_experience),
       assessed_date    = CURRENT_DATE,
       updated_at       = NOW()
     RETURNING *`,
    [employeeId, competencyId, lvl, source, assessedBy, assessedByUser, notes, yearsExperience, companyId]);
  return rows[0];
}

/** Active login(s) for a set of employees: [{ user_id, employee_id, email, name }]. */
export async function loginsFor(employeeIds, db = pool) {
  if (!employeeIds?.length) return [];
  const { rows } = await db.query(
    `SELECT u.id AS user_id, e.id AS employee_id, COALESCE(e.company_email, e.personal_email, u.email) AS email,
            COALESCE(e.name, TRIM(e.first_name || ' ' || COALESCE(e.last_name, ''))) AS name,
            e.reporting_manager_id
       FROM employees e JOIN users u ON u.employee_id = e.id AND u.is_active = true
      WHERE e.id = ANY($1::int[])`, [employeeIds]);
  return rows;
}

/** HR / L&D logins of a company — who hears about expiries and refreshers. */
export async function lndAdminLogins(companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id AS user_id
       FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = true AND LOWER(r.code) IN ('hr','hr_manager','lnd_admin')
        AND ($1::int IS NULL OR COALESCE(e.company_id, u.company_id) = $1)`, [companyId]);
  return rows.map(r => r.user_id);
}

/**
 * Notify users in-app (deduplicated per user/type/reference per day) and, when
 * the company allows e-mail and SMTP is configured, by mail too. Never throws:
 * a notification failure must not undo the action that caused it.
 */
export async function notify({ userIds = [], title, message, type, referenceId = null, link = null, email = null, companyId = null }) {
  let sent = 0;
  for (const userId of [...new Set(userIds.filter(Boolean))]) {
    try {
      const dup = await pool.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND module_name = 'training'
            AND notification_type = $2 AND reference_id IS NOT DISTINCT FROM $3::int AND created_at::date = CURRENT_DATE LIMIT 1`,
        [userId, type, referenceId]);
      if (dup.rows.length) continue;
      await notificationsRepository.create({
        user_id: userId, title, message, module_name: 'training',
        reference_id: referenceId, notification_type: type, link,
      });
      sent++;
    } catch (e) {
      console.warn(JSON.stringify({ event: 'lnd_notify_failed', type, message: e.message }));
    }
  }
  if (email?.trigger && email.to?.length) {
    try {
      const s = await getSettings(companyId);
      if (s.enable_email_notifications) {
        for (const r of email.to) if (r.email) await triggerEmail(email.trigger, { ...email.data, email: r.email, employee_name: r.name || '' }, companyId);
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: 'lnd_email_failed', message: e.message }));
    }
  }
  return sent;
}

/** Program detail for notifications. */
export const venueLine = (p) => (p.venue ? ` at ${p.venue}` : p.online_link ? ' (online)' : '');

/** Postgres error → HTTP. Constraint names are mapped to plain sentences. */
export function sendError(res, err, fallback = 'Request failed') {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  if (err?.code) console.warn(JSON.stringify({ event: 'lnd_db_error', code: err.code, message: err.message, detail: err.detail }));
  if (err?.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  if (err?.code === '23503') return res.status(409).json({ error: 'This record is in use or refers to a record that does not exist.' });
  if (err?.code === '23514') return res.status(400).json({ error: 'A value is out of the allowed range.' });
  if (err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') return res.status(400).json({ error: 'A value has the wrong format.' });
  console.error('[lnd]', err);
  return res.status(500).json({ error: fallback });
}

export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Employee name expression for SELECTs over alias e. */
export const EMP_NAME = `COALESCE(NULLIF(e.name,''), TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')))`;

/** Active-employee predicate (status values are capitalised in this DB). */
export const ACTIVE_EMP = `e.deleted_at IS NULL AND LOWER(e.status) IN ('active','probation','confirmed','notice period')`;

/** Load an employee of this company or throw 404. */
export async function employeeInCompany(db, employeeId, companyId) {
  const { rows } = await db.query(
    `SELECT e.id, e.department, e.designation, e.reporting_manager_id, ${EMP_NAME} AS name
       FROM employees e WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2)`,
    [employeeId, companyId]);
  if (!rows.length) throw httpError(404, 'Employee not found');
  return rows[0];
}
