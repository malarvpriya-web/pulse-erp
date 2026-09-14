/**
 * journey.routes.js — operating a marketing journey.
 *
 * Mounted at /api/crm/journeys. The sequence CRUD stays in email.routes.js; this
 * is the running of them: enrol, pause, resume, stop, run now, and — the part
 * that did not exist — see what each enrolled person actually received.
 *
 * Every route is company-scoped through companyOf(req) and permission-gated on
 * the `crm` module. `run` is gated on `edit` rather than `view` because it sends
 * real email.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import {
  runDue, runEnrollment, dueEnrollments, transportConfigured,
} from '../services/journeyEngine.js';

const router = express.Router();
const canView = requirePermission('crm', 'view');
const canEdit = requirePermission('crm', 'edit');
const canAdd  = requirePermission('crm', 'add');
const fail = (res, err) => res.status(500).json({ success: false, message: err.message });

/**
 * Journey overview: enrolments by state, and what has actually been delivered.
 *
 * `delivered` counts rows in the event log, not enrolments — an enrolment can be
 * "active" for weeks having received nothing, and the old screen showed exactly
 * that number as if it meant engagement.
 */
router.get('/', canView, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.description, s.trigger_stage, s.is_active,
              s.exit_on_reply, s.goal_event, s.last_run_at, s.created_at,
              (SELECT COUNT(*)::int FROM crm_email_sequence_steps st
                WHERE st.sequence_id = s.id AND COALESCE(st.is_active, true))       AS step_count,
              COUNT(e.id) FILTER (WHERE e.status = 'active')::int    AS active,
              COUNT(e.id) FILTER (WHERE e.status = 'paused')::int    AS paused,
              COUNT(e.id) FILTER (WHERE e.status = 'completed')::int AS completed,
              COUNT(e.id) FILTER (WHERE e.status = 'stopped')::int   AS stopped,
              COUNT(e.id) FILTER (WHERE e.status = 'failed')::int    AS failed,
              COUNT(e.id) FILTER (WHERE e.status = 'active'
                                    AND e.next_send_at <= NOW())::int AS due_now,
              (SELECT COUNT(*)::int FROM sequence_enrollment_events ev
                WHERE ev.sequence_id = s.id AND ev.event = 'sent')    AS emails_sent
         FROM email_sequences s
         LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
        WHERE (s.company_id = $1 OR s.company_id IS NULL)
        GROUP BY s.id
        ORDER BY s.created_at DESC`,
      [companyId]
    );
    res.json({
      success: true,
      data: rows,
      // Stated in the payload rather than left for someone to infer from a
      // journey that never sends: with no transport, nothing goes out and every
      // enrolment stays exactly where it is.
      delivery: transportConfigured()
        ? { configured: true }
        : { configured: false,
            message: 'No SMTP transport is configured. Journeys will not send, and enrolments will not advance.' },
    });
  } catch (err) { fail(res, err); }
});

/** The enrolments on one journey, with where each person has reached. */
router.get('/:id/enrollments', canView, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const params = [req.params.id, companyId];
    let where = 'e.sequence_id = $1 AND ($2::int IS NULL OR e.company_id = $2)';
    if (req.query.status) { params.push(req.query.status); where += ` AND e.status = $${params.length}`; }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT e.id, e.status, e.current_step, e.next_send_at, e.last_sent_at,
              e.enrolled_at, e.completed_at, e.stopped_at, e.stopped_reason,
              e.attempts, e.last_error, e.lead_id, e.contact_id,
              COALESCE(e.email, l.email, c.email) AS email,
              -- The leads table has NO name column: it carries contact_person
              -- and company_name. Referencing l.name made this whole endpoint
              -- 500, which read as "no enrolments" in the UI.
              COALESCE(NULLIF(l.contact_person, ''), NULLIF(l.company_name, ''),
                       NULLIF(TRIM(c.first_name || ' ' || COALESCE(c.last_name, '')), '')) AS subject_name,
              (SELECT COUNT(*)::int FROM sequence_enrollment_events ev
                WHERE ev.enrollment_id = e.id AND ev.event = 'sent') AS emails_received
         FROM sequence_enrollments e
         LEFT JOIN leads l    ON l.id = e.lead_id
         LEFT JOIN contacts c ON c.id = e.contact_id
        WHERE ${where}
        ORDER BY e.enrolled_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
});

/** What one enrolled person actually received, and what was skipped and why. */
router.get('/enrollments/:enrollmentId/events', canView, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `SELECT ev.id, ev.event, ev.step_order, ev.detail, ev.created_at,
              em.subject, em.sent_at, em.opened_at, em.clicked_at
         FROM sequence_enrollment_events ev
         LEFT JOIN crm_emails em ON em.id = ev.email_id
         JOIN sequence_enrollments e ON e.id = ev.enrollment_id
        WHERE ev.enrollment_id = $1 AND ($2::int IS NULL OR e.company_id = $2)
        ORDER BY ev.created_at`,
      [req.params.enrollmentId, companyId]
    );
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
});

/**
 * Enrol a lead or contact.
 *
 * Resolves the email address at enrolment time and stores it on the row: a lead
 * whose address changes mid-journey should keep receiving at the address they
 * were enrolled with, and a lead deleted mid-journey must not strand a row with
 * no way to say who it was for.
 */
router.post('/:id/enroll', canAdd, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { lead_id, contact_id } = req.body || {};
    if (!lead_id && !contact_id) {
      return res.status(400).json({ success: false, message: 'lead_id or contact_id is required' });
    }

    const { rows: [sequence] } = await pool.query(
      `SELECT id, is_active FROM email_sequences
        WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
      [req.params.id, companyId]);
    if (!sequence) return res.status(404).json({ success: false, message: 'Sequence not found' });

    let email = null;
    if (lead_id) {
      const { rows } = await pool.query(
        `SELECT email FROM leads WHERE id = $1 AND company_id = $2`, [lead_id, companyId]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Lead not found' });
      email = rows[0].email;
    } else {
      const { rows } = await pool.query(
        `SELECT email FROM contacts WHERE id = $1 AND company_id = $2`, [contact_id, companyId]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'Contact not found' });
      email = rows[0].email;
    }
    if (!email) {
      return res.status(400).json({ success: false,
        message: 'That record has no email address, so it cannot be enrolled in an email journey' });
    }

    const { rows: existing } = await pool.query(
      `SELECT id FROM sequence_enrollments
        WHERE sequence_id = $1 AND status = 'active'
          AND ($2::int IS NOT NULL AND lead_id = $2 OR $3::int IS NOT NULL AND contact_id = $3)`,
      [req.params.id, lead_id || null, contact_id || null]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Already enrolled in this journey' });
    }

    const { rows: [enrolled] } = await pool.query(
      `INSERT INTO sequence_enrollments
         (sequence_id, lead_id, contact_id, email, company_id, enrolled_by, next_send_at, current_step, status)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),0,'active')
       RETURNING *`,
      [req.params.id, lead_id || null, contact_id || null, email, companyId, await employeeOf(req, pool)]);

    await pool.query(
      `INSERT INTO sequence_enrollment_events (enrollment_id, sequence_id, company_id, event, detail)
       VALUES ($1,$2,$3,'enrolled',$4)`,
      [enrolled.id, req.params.id, companyId, `Enrolled at ${email}`]);

    logAudit({ userId: req.user?.userId, module: 'crm', recordId: enrolled.id,
      recordType: 'sequence_enrollment', action: 'create', newData: enrolled, req });
    res.status(201).json({ success: true, data: enrolled });
  } catch (err) { fail(res, err); }
});

/** pause / resume / stop, each recorded so the timeline explains itself. */
const setState = (status, event) => async (req, res) => {
  try {
    const companyId = companyOf(req);
    const reason = req.body?.reason || null;
    const { rows: [before] } = await pool.query(
      `SELECT * FROM sequence_enrollments WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.enrollmentId, companyId]);
    if (!before) return res.status(404).json({ success: false, message: 'Enrolment not found' });

    // Resuming picks up from now, not from the moment it was paused — otherwise
    // a journey paused for a month fires its whole backlog the instant it resumes.
    // ⚠ Every $2 carries an explicit ::text. Without it Postgres has to deduce
    // one type for a parameter used BOTH as an assignment target (status = $2,
    // varchar) and inside comparisons ($2 = 'stopped', text) — and refuses with
    // "inconsistent types deduced for parameter $2". That 500'd every pause,
    // resume and stop, and the failure was invisible from the outside because
    // the row simply stayed as it was.
    const { rows: [updated] } = await pool.query(
      `UPDATE sequence_enrollments
          SET status = $2::text,
              stopped_at    = CASE WHEN $2::text = 'stopped' THEN NOW() ELSE stopped_at END,
              stopped_reason= CASE WHEN $2::text = 'stopped' THEN $3::text ELSE stopped_reason END,
              next_send_at  = CASE WHEN $2::text = 'active'  THEN NOW()
                                   WHEN $2::text = 'stopped' THEN NULL
                                   ELSE next_send_at END
        WHERE id = $1
        RETURNING *`,
      [req.params.enrollmentId, status, reason]);

    await pool.query(
      `INSERT INTO sequence_enrollment_events (enrollment_id, sequence_id, company_id, event, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [updated.id, updated.sequence_id, updated.company_id, event, reason]);

    logAudit({ userId: req.user?.userId, module: 'crm', recordId: updated.id,
      recordType: 'sequence_enrollment', action: event, oldData: before, newData: updated, req });
    res.json({ success: true, data: updated });
  } catch (err) { fail(res, err); }
};

router.post('/enrollments/:enrollmentId/pause',  canEdit, setState('paused', 'paused'));
router.post('/enrollments/:enrollmentId/resume', canEdit, setState('active', 'resumed'));
router.post('/enrollments/:enrollmentId/stop',   canEdit, setState('stopped', 'stopped'));

/**
 * Run the due enrolments now.
 *
 * Scoped to the caller's company — a manual run must not step through another
 * tenant's journeys. The tally distinguishes sent from skipped from failed
 * rather than reporting one "processed" number.
 */
router.post('/run', canEdit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (companyId == null) {
      return res.status(400).json({ success: false,
        message: 'A company scope is required to run journeys' });
    }
    const tally = await runDue(pool, { companyId, limit: 200 });
    logAudit({ userId: req.user?.userId, module: 'crm', recordType: 'journey_run',
      action: 'run', newData: tally, req });
    res.json({ success: true, data: tally, delivery: { configured: transportConfigured() } });
  } catch (err) { fail(res, err); }
});

/** Advance one enrolment — used from the enrolment row, and by the tests. */
router.post('/enrollments/:enrollmentId/run', canEdit, async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `SELECT id FROM sequence_enrollments WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.enrollmentId, companyId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Enrolment not found' });
    res.json({ success: true, data: await runEnrollment(pool, req.params.enrollmentId) });
  } catch (err) { fail(res, err); }
});

/** What would run right now, without running it. */
router.get('/due', canView, async (req, res) => {
  try {
    const ids = await dueEnrollments(pool, { companyId: companyOf(req), limit: 500 });
    res.json({ success: true, data: { due: ids.length, enrollment_ids: ids } });
  } catch (err) { fail(res, err); }
});

export default router;
