/**
 * meetings.routes.js — the endpoints behind Manager Dashboard's
 * "Schedule Meeting" drawer.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MeetingDrawer` collects a title, date, time, a multi-select of team members
 * and notes, and posts them to `POST /meetings`. That route was never built and
 * no meetings table existed, so the button reported "Failed to schedule meeting"
 * on every click while looking completely functional.
 *
 * `attendee_ids` are **employee** ids — the drawer's picker lists team members,
 * not logins. Notifications go to `users`, so the fan-out maps employee → login
 * through `users.employee_id` and simply skips anyone without one rather than
 * failing the write.
 *
 * Scoping: company via companyOf(req), never req.user.company_id (fails OPEN).
 * A meeting is visible to its organiser and to its invitees; nobody else.
 */
import express from 'express';
import pool from '../shared/db.js';
import { companyOf, callerIdentity } from '../../shared/scope.js';
import { respondError } from '../../shared/pgErrors.js';
import { hasRole } from '../../middlewares/auth.middleware.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';

const router = express.Router();

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Roles allowed to see meetings they are neither organising nor invited to.
 * Everyone else — including plain `employee` — is confined to their own.
 *
 * This is a JWT-role check (`hasRole` → `rolesOf`, which unions the many-to-many
 * `user_roles`), deliberately NOT `requirePermission`: that reads `role_permissions`
 * and fails CLOSED for the ~19 of 26 roles with no row, which would lock managers
 * out of their own oversight view.
 */
const MEETING_OVERSIGHT_ROLES = [
  'super_admin', 'superadmin', 'admin',
  'hr', 'hr_manager', 'hr_exec',
  'manager', 'department_head',
];

/**
 * Restricts a meeting to its organiser and its invitees.
 *
 * `$n` is the viewer's **employee** id and may be null: `organiser_employee_id = NULL`
 * and `employee_id = NULL` are both NULL, never TRUE, so a login with no employee
 * record matches nothing. That is the correct answer — no meeting can name them —
 * and it must never be mistaken for "matches everyone".
 */
const visibleToViewer = (alias, n) => `(
    ${alias}.organiser_employee_id = $${n}::int
    OR EXISTS (SELECT 1 FROM meeting_attendees ma
                WHERE ma.meeting_id = ${alias}.id AND ma.employee_id = $${n}::int)
  )`;

/** Employee ids → their login user ids. Employees with no login are dropped. */
async function loginsForEmployees(employeeIds) {
  if (!employeeIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, employee_id FROM users
      WHERE employee_id = ANY($1) AND COALESCE(is_active, TRUE) = TRUE`,
    [employeeIds]
  );
  return rows;
}

/**
 * The full meeting with its attendee list, or null.
 *
 * `viewerEmployeeId` is undefined for trusted internal reads (the POST route
 * re-reading what the caller just created, where the organiser may legitimately
 * have no employee record) and for oversight roles. Pass it — even as null — and
 * the row is confined to the organiser and the invitees.
 */
async function loadMeeting(id, companyId, viewerEmployeeId = undefined) {
  const params = [id];
  const where  = ['m.id = $1', 'm.deleted_at IS NULL'];
  if (companyId != null) { params.push(companyId); where.push(`m.company_id = $${params.length}`); }
  if (viewerEmployeeId !== undefined) {
    params.push(viewerEmployeeId);
    where.push(visibleToViewer('m', params.length));
  }

  const { rows } = await pool.query(
    `SELECT m.*,
            NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), '') AS organiser_name
       FROM meetings m
       LEFT JOIN employees e ON e.id = m.organiser_employee_id
      WHERE ${where.join(' AND ')}`,
    params
  );
  if (!rows[0]) return null;

  const { rows: attendees } = await pool.query(
    `SELECT ma.employee_id, ma.response,
            NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), '') AS name,
            e.designation, e.company_email
       FROM meeting_attendees ma
       LEFT JOIN employees e ON e.id = ma.employee_id
      WHERE ma.meeting_id = $1
      ORDER BY e.first_name`,
    [id]
  );
  return { ...rows[0], attendees };
}

// ── POST /meetings ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { title, date, time, attendee_ids, notes } = req.body ?? {};

  if (!title?.trim())        return res.status(422).json({ error: 'title is required' });
  if (!date || !DATE_RE.test(date))
    return res.status(422).json({ error: 'date is required, as YYYY-MM-DD' });
  if (time && !TIME_RE.test(time))
    return res.status(422).json({ error: 'time must be HH:MM' });

  const attendees = Array.isArray(attendee_ids)
    ? [...new Set(attendee_ids.map(Number).filter(Number.isInteger))]
    : [];
  if (attendees.length > 200)
    return res.status(422).json({ error: 'A meeting cannot have more than 200 attendees' });

  const client = await pool.connect();
  try {
    const companyId = companyOf(req);
    const me        = await callerIdentity(req, pool, companyId);
    const userId    = req.user?.userId ?? req.user?.id ?? null;

    // Hoisted out of the attendee block below: the response is built from a
    // fresh loadMeeting() re-read, so anything hung on the INSERT's returned row
    // is silently discarded. That is exactly how this used to be lost.
    let skipped = [];

    await client.query('BEGIN');

    const { rows: [meeting] } = await client.query(
      `INSERT INTO meetings
         (title, meeting_date, meeting_time, notes, organiser_employee_id, company_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title.trim(), date, time || null, notes?.trim() || null, me.employee_id, companyId, userId]
    );

    if (attendees.length) {
      // Reject ids that are not real employees of this company rather than
      // letting the FK abort the whole meeting — the drawer can then say which
      // picks were stale.
      const scopeParams = companyId != null ? [attendees, companyId] : [attendees];
      const scopeSql    = companyId != null ? ' AND (company_id = $2 OR company_id IS NULL)' : '';
      const { rows: valid } = await client.query(
        `SELECT id FROM employees WHERE id = ANY($1) AND deleted_at IS NULL${scopeSql}`,
        scopeParams
      );
      const validIds = valid.map(v => v.id);

      if (validIds.length) {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, employee_id)
           SELECT $1, unnest($2::int[])
           ON CONFLICT (meeting_id, employee_id) DO NOTHING`,
          [meeting.id, validIds]
        );
      }
      skipped = attendees.filter(a => !validIds.includes(a));
    }

    await client.query('COMMIT');

    // Fan out invitations. Awaited so a caller (or a test) sees a settled state
    // before the response, but individually guarded — a notification failure
    // must never undo a committed meeting.
    const invited = await loadMeeting(meeting.id, companyId);
    const logins  = await loginsForEmployees((invited?.attendees ?? []).map(a => a.employee_id));
    const when    = time ? `${date} at ${time}` : date;
    await Promise.allSettled(logins.map(l => notificationsRepository.create({
      user_id:           l.id,
      title:             'Meeting invitation',
      message:           `${me.name || 'Your manager'} scheduled "${title.trim()}" for ${when}.`,
      module_name:       'meetings',
      reference_id:      meeting.id,
      notification_type: 'meeting_invite',
    })));

    // Always present, so the drawer can branch on `.length` without probing for
    // the key's existence.
    res.status(201).json({ ...invited, skipped_attendees: skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    respondError(res, err);
  } finally {
    client.release();
  }
});

// ── GET /meetings ─────────────────────────────────────────────────────────────
// Defaults to the caller's own upcoming meetings — the ones they organised plus
// the ones they were invited to. `?scope=all` widens to the whole company for
// anyone who can already see the manager dashboard.
router.get('/', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const me        = await callerIdentity(req, pool, companyId);
    const { from, to, status, scope } = req.query;

    const where  = ['m.deleted_at IS NULL'];
    const params = [];
    const add    = (frag, val) => { params.push(val); where.push(frag.replace('$?', `$${params.length}`)); };

    if (companyId != null) add('m.company_id = $?', companyId);
    if (status)            add('m.status = $?', status);
    else                   where.push("m.status <> 'cancelled'");
    if (from)              add('m.meeting_date >= $?', from);
    else                   where.push('m.meeting_date >= CURRENT_DATE');
    if (to)                add('m.meeting_date <= $?', to);

    // `?scope=all` was previously honoured for ANY authenticated caller, so a
    // plain employee could read every meeting in the company — title, notes and
    // attendee count — just by appending it. It now has to be earned.
    const wantsAll = scope === 'all';
    if (wantsAll && !hasRole(req, MEETING_OVERSIGHT_ROLES)) {
      return res.status(403).json({ error: 'You are not allowed to list meetings you are not part of' });
    }

    if (!wantsAll) {
      if (me.employee_id == null) {
        // No employee record means no meetings can name this caller. Say so with
        // an empty list rather than silently showing the whole company.
        return res.json({ meetings: [], scope: 'mine', note: 'This login is not linked to an employee record.' });
      }
      params.push(me.employee_id);
      where.push(visibleToViewer('m', params.length));
    }

    const { rows } = await pool.query(
      `SELECT m.*,
              NULLIF(TRIM(CONCAT(e.first_name, ' ', e.last_name)), '') AS organiser_name,
              (SELECT COUNT(*)::int FROM meeting_attendees ma WHERE ma.meeting_id = m.id) AS attendee_count
         FROM meetings m
         LEFT JOIN employees e ON e.id = m.organiser_employee_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.meeting_date, m.meeting_time NULLS LAST
        LIMIT 100`,
      params
    );
    res.json({ meetings: rows, scope: scope === 'all' ? 'all' : 'mine' });
  } catch (err) {
    respondError(res, err);
  }
});

// ── GET /meetings/:id ─────────────────────────────────────────────────────────
// Scoped to the organiser and the invitees. Company scope alone is NOT enough:
// this route used to hand any authenticated colleague the agenda notes and the
// full attendee roster (names + company emails) of a meeting they had no part in.
// 404 rather than 403 — a stranger should not learn the meeting exists.
router.get('/:id', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const oversight = hasRole(req, MEETING_OVERSIGHT_ROLES);
    const viewer    = oversight ? undefined : (await callerIdentity(req, pool, companyId)).employee_id;

    const meeting = await loadMeeting(req.params.id, companyId, viewer);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    res.json(meeting);
  } catch (err) {
    respondError(res, err);
  }
});

// ── PATCH /meetings/:id/cancel ────────────────────────────────────────────────
// Cancel rather than delete: invitees have already been notified, so the record
// has to survive to explain why it disappeared from their list.
router.patch('/:id/cancel', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const me        = await callerIdentity(req, pool, companyId);

    const params = [req.params.id];
    let scope = '';
    if (companyId != null) { params.push(companyId); scope = ' AND company_id = $2'; }

    const { rows: [before] } = await pool.query(
      `SELECT * FROM meetings WHERE id = $1 AND deleted_at IS NULL${scope}`, params
    );
    if (!before) return res.status(404).json({ error: 'Meeting not found' });
    if (before.status === 'cancelled') return res.json(before);
    if (before.organiser_employee_id != null && me.employee_id !== before.organiser_employee_id) {
      return res.status(403).json({ error: 'Only the organiser can cancel this meeting' });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE meetings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    const { rows: attendees } = await pool.query(
      'SELECT employee_id FROM meeting_attendees WHERE meeting_id = $1', [req.params.id]
    );
    const logins = await loginsForEmployees(attendees.map(a => a.employee_id));
    await Promise.allSettled(logins.map(l => notificationsRepository.create({
      user_id:           l.id,
      title:             'Meeting cancelled',
      message:           `"${before.title}" on ${before.meeting_date} was cancelled.`,
      module_name:       'meetings',
      reference_id:      before.id,
      notification_type: 'meeting_cancelled',
    })));

    res.json(updated);
  } catch (err) {
    respondError(res, err);
  }
});

export default router;
