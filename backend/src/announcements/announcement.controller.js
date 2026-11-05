import * as announcementService from "./announcement.service.js";
import { AnnouncementStateError } from "./announcement.service.js";
import { viewerFromReq, visibleAnnouncements, visibleAnnouncement } from "./announcement.visibility.js";
import { publishIfDue } from "./announcement.publisher.js";
import { companyOf } from "../shared/scope.js";
import { rolesOf } from "../middlewares/auth.middleware.js";
import { logAudit } from "../services/AuditService.js";
import pool from "../config/db.js";

// ── who is calling ────────────────────────────────────────────────────────────

const userIdOf = (req) => req.user?.userId ?? req.user?.id ?? null;

/**
 * Every endpoint needs a concrete company. A request without one used to mean
 * "every company" in `($1::int IS NULL OR company_id = $1)`; now it is refused.
 */
function companyOrRefuse(req, res) {
  const cid = companyOf(req);
  if (cid == null) {
    res.status(403).json({ message: 'No company context for this login' });
    return null;
  }
  return cid;
}

/**
 * Publishing breadth. The permission matrix (role_permissions, module
 * 'announcements') decides WHETHER a caller may add / edit / delete — the routes
 * enforce it. It says nothing about AUDIENCE, and manager / department_head hold
 * add+edit. Until the business decides otherwise, a caller whose only publishing
 * role is manager-tier is TEAM-SCOPED: they may address their own department (or
 * one employee in it), and may change only announcements they created. HR and
 * admin roles publish company-wide. This is the narrower reading, chosen on
 * purpose — MODULE_FEATURE_CONNECTION_MANUAL.md lists it as an open decision.
 */
export const COMPANY_WIDE_PUBLISHER_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec'];

async function publisherScope(req, cid) {
  const roles = rolesOf(req);
  if (roles.some(r => COMPANY_WIDE_PUBLISHER_ROLES.includes(r))) return { companyWide: true };
  const userId = userIdOf(req);
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(BTRIM(e.department), ''), NULLIF(BTRIM(u.department), '')) AS department
       FROM users u
       LEFT JOIN employees e ON e.id = COALESCE($2::int, u.employee_id) AND e.company_id = $3::int
      WHERE u.id = $1`,
    [userId, req.user?.employee_id ?? null, cid]);
  return { companyWide: false, department: rows[0]?.department ?? null, userId };
}

const sameDept = (a, b) => a != null && b != null
  && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ── input ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const PRIORITIES = new Set(['high', 'medium', 'low']);
const TARGET_TYPES = new Set(['all', 'department', 'employee']);

const validDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !isNaN(Date.parse(v.slice(0, 10)));
const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

/** Normalise and validate a create/update body. Returns { fields } or { error }. */
function readBody(body = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { error: 'Title is required' };
  if (title.length > 255) return { error: 'Title must be 255 characters or less' };
  const message = typeof body.message === 'string' ? body.message : '';
  if (!stripTags(message)) return { error: 'Message is required' };
  if (!body.from_date) return { error: 'Start date is required' };
  if (!body.to_date) return { error: 'End date is required' };
  if (!validDate(body.from_date) || !validDate(body.to_date)) return { error: 'Dates must be YYYY-MM-DD' };
  const from_date = body.from_date.slice(0, 10);
  const to_date = body.to_date.slice(0, 10);
  if (from_date > to_date) return { error: 'End date cannot be before start date' };

  let publish_at = null;
  if (body.publish_at != null && body.publish_at !== '') {
    if (typeof body.publish_at !== 'string' || !DATETIME_RE.test(body.publish_at) || isNaN(Date.parse(body.publish_at)))
      return { error: 'Scheduled publish must be a date and time' };
    publish_at = body.publish_at;
  }

  const target_type = body.target_type ? String(body.target_type) : 'all';
  if (!TARGET_TYPES.has(target_type)) return { error: 'Unknown target audience' };
  const target_value = target_type === 'all' ? '' : String(body.target_value ?? '').trim();
  if (target_type !== 'all' && !target_value)
    return { error: `Please select a ${target_type === 'department' ? 'department' : 'employee'}` };
  if (target_type === 'employee' && !/^\d+$/.test(target_value)) return { error: 'Unknown employee' };

  const priority = PRIORITIES.has(String(body.priority || '').toLowerCase())
    ? String(body.priority).toLowerCase() : 'medium';
  const category = typeof body.category === 'string' && body.category.trim()
    ? body.category.trim().slice(0, 50) : 'General';

  return {
    fields: {
      title, message, from_date, to_date, publish_at, target_type, target_value, priority, category,
      // An omitted flag used to be inserted as NULL (neither active nor inactive).
      is_active: body.is_active === undefined ? true : body.is_active === true,
      is_pinned: body.is_pinned === true,
    },
  };
}

/** Audience must exist in this company, and fit the publisher's breadth. Returns an error or null. */
async function checkAudience(f, cid, scope) {
  let employeeDept = null;
  if (f.target_type === 'employee') {
    const { rows } = await pool.query(
      `SELECT department FROM employees WHERE id = $1 AND company_id = $2::int`, [Number(f.target_value), cid]);
    if (!rows.length) return { status: 400, message: 'Unknown employee' };
    employeeDept = rows[0].department;
  }
  if (scope.companyWide) return null;
  if (!scope.department)
    return { status: 403, message: 'Your department is not on record, so you cannot post a team announcement' };
  const ok = (f.target_type === 'department' && sameDept(f.target_value, scope.department))
          || (f.target_type === 'employee' && sameDept(employeeDept, scope.department));
  return ok ? null : { status: 403, message: 'You can only post announcements to your own department' };
}

/** A team-scoped publisher may change only what they created. */
const mayChange = (row, scope) => scope.companyWide || Number(row.created_by) === Number(scope.userId);

function audit(req, cid, action, recordId, oldData, newData) {
  // logAudit is fire-and-forget and returns undefined — never .catch() it.
  logAudit({
    userId: userIdOf(req), module: 'announcements', recordId, recordType: 'announcement',
    action, oldData, newData, req, company_id: cid,
  });
}

/** Notify now if the saved row is live; a scheduled one is left to the publish job. */
async function notifyIfLive(id) {
  try { await publishIfDue(id); }
  catch (err) { console.error('[Announcements] publish failed for', id, '—', err.message); }
}

const fail = (res, err) => res.status(500).json({ message: err.message });

/** Load the row for a mutation, enforcing company + authorship. Sends the response on failure. */
async function loadForChange(req, res, cid, scope) {
  const row = await announcementService.findInCompany(req.params.id, cid);
  if (!row) { res.status(404).json({ message: 'Announcement not found' }); return null; }
  if (!mayChange(row, scope)) {
    res.status(403).json({ message: 'You can only change announcements you posted' });
    return null;
  }
  return row;
}

// ── handlers ──────────────────────────────────────────────────────────────────

export const createAnnouncement = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const { fields, error } = readBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const scope = await publisherScope(req, cid);
    const bad = await checkAudience(fields, cid, scope);
    if (bad) return res.status(bad.status).json({ message: bad.message });

    const created = await announcementService.addAnnouncement(cid, fields, userIdOf(req));
    audit(req, cid, 'create', created.id, null, created);
    await notifyIfLive(created.id);
    res.status(201).json(created);
  } catch (err) { fail(res, err); }
};

/** Management list. Read-only. */
export const getAllAnnouncements = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const scope = await publisherScope(req, cid);
    const rows = await announcementService.listForManagement(cid, {
      createdBy: scope.companyWide ? null : scope.userId,
    });
    res.json(rows);
  } catch (err) { fail(res, err); }
};

/** What the signed-in user may see now: their company, their audience, live only. Read-only. */
export const getActiveAnnouncements = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const viewer = await viewerFromReq(req, cid);
    res.json(await visibleAnnouncements(viewer));
  } catch (err) { fail(res, err); }
};

export const updateAnnouncement = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const scope = await publisherScope(req, cid);
    const before = await loadForChange(req, res, cid, scope); if (!before) return;
    const { fields, error } = readBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const bad = await checkAudience(fields, cid, scope);
    if (bad) return res.status(bad.status).json({ message: bad.message });

    const after = await announcementService.updateAnnouncement(before.id, cid, fields, userIdOf(req));
    if (!after) return res.status(404).json({ message: 'Announcement not found' });
    audit(req, cid, 'update', after.id, before, after);
    await notifyIfLive(after.id);
    res.json(after);
  } catch (err) { fail(res, err); }
};

export const toggleStatus = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    if (typeof req.body?.is_active !== 'boolean') return res.status(400).json({ message: 'is_active must be true or false' });
    const scope = await publisherScope(req, cid);
    const before = await loadForChange(req, res, cid, scope); if (!before) return;
    const after = await announcementService.toggleAnnouncementStatus(before.id, req.body.is_active, cid, userIdOf(req));
    audit(req, cid, 'update', after.id, before, after);
    await notifyIfLive(after.id);
    res.json(after);
  } catch (err) {
    if (err instanceof AnnouncementStateError) return res.status(400).json({ message: err.message });
    fail(res, err);
  }
};

export const togglePin = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    if (typeof req.body?.is_pinned !== 'boolean') return res.status(400).json({ message: 'is_pinned must be true or false' });
    const scope = await publisherScope(req, cid);
    const before = await loadForChange(req, res, cid, scope); if (!before) return;
    const after = await announcementService.togglePinned(before.id, req.body.is_pinned, cid, userIdOf(req));
    if (!after) return res.status(404).json({ message: 'Announcement not found' });
    audit(req, cid, 'update', after.id, before, after);
    res.json(after);
  } catch (err) { fail(res, err); }
};

/**
 * Mark read — for the caller only. The user comes from the token (any user_id in
 * the body is ignored), and only an announcement the caller can currently see
 * can be marked; anything else is a 404, so ids in other companies or audiences
 * are not even confirmed to exist.
 */
export const markRead = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const viewer = await viewerFromReq(req, cid);
    if (!(await visibleAnnouncement(viewer, req.params.id)))
      return res.status(404).json({ message: 'Announcement not found' });
    const readAt = await announcementService.markAnnouncementRead(req.params.id, userId);
    res.json({ success: true, read_at: readAt });
  } catch (err) { fail(res, err); }
};

/** Archive. The row stays (deleted_at); the audit entry carries the full before-image. */
export const deleteAnnouncement = async (req, res) => {
  try {
    const cid = companyOrRefuse(req, res); if (cid == null) return;
    const scope = await publisherScope(req, cid);
    const before = await loadForChange(req, res, cid, scope); if (!before) return;
    const after = await announcementService.archiveAnnouncement(before.id, cid, userIdOf(req));
    if (!after) return res.status(404).json({ message: 'Announcement not found' });
    audit(req, cid, 'delete', after.id, before, after);
    res.json({ message: 'Announcement archived', archived: true, id: after.id });
  } catch (err) { fail(res, err); }
};
