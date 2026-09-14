/**
 * journeyEngine.js — executes marketing email journeys.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Enrolling a lead wrote a `sequence_enrollments` row with `next_send_at = NOW()`
 * and nothing ever read it. No step was ever sent; every enrolment sat at step 0
 * forever while the sequences screen reported it as "active". This is the runner.
 *
 * NO FABRICATED ACTIVITY
 * ----------------------
 * A step is marked `sent` only when the mail transport accepted it. If SMTP is
 * not configured the enrolment does NOT advance and the event log records why —
 * an un-run journey must look un-run. The alternative (advance anyway, log a
 * send) manufactures an email history that never existed, which is exactly the
 * failure the open-tracking work in §154 was cleaning up after.
 *
 * Conditions reuse workflowEngine's evaluator rather than growing a second
 * condition language with its own operator quirks.
 */

import nodemailer from 'nodemailer';
import { evaluateConditions, renderTemplate } from '../../../services/workflowEngine.js';

/** True when a real transport is configured. Checked, never assumed. */
export function transportConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER);
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transport;
}

/**
 * When the next step is due.
 *
 * delay_days and delay_hours are ADDITIVE and both measured from the moment the
 * previous step was sent, not from enrolment — a 3-day gap means three days
 * after the last email landed, which is what someone building a journey means.
 */
export function nextSendAt(step, from = new Date()) {
  const ms = (Number(step?.delay_days) || 0) * 86400000
           + (Number(step?.delay_hours) || 0) * 3600000;
  return new Date(from.getTime() + ms);
}

/**
 * The facts a step's condition can branch on.
 *
 * Flat and explicit: a condition written against `lead.status` must keep working
 * when the query behind it changes shape, so the context is built here rather
 * than being whatever the row happened to contain.
 */
export function buildContext({ enrollment, lead, contact, engagement }) {
  const subject = lead || contact || {};
  return {
    enrollment: {
      step: enrollment.current_step ?? 0,
      status: enrollment.status,
      enrolled_at: enrollment.enrolled_at,
    },
    lead: lead || {},
    contact: contact || {},
    subject,
    email: enrollment.email || subject.email || null,
    engagement: {
      sent: Number(engagement?.sent || 0),
      opened: Number(engagement?.opened || 0),
      clicked: Number(engagement?.clicked || 0),
      replied: Number(engagement?.replied || 0),
      // ⚠ opened=0 means NOT OPENED **or** never tracked. Open tracking is off
      // unless a company turns it on, so a journey that branches on "did not
      // open" will branch that way for everyone when tracking is disabled.
      // Surfaced so a condition can guard on it instead of quietly mis-branching.
      tracking_enabled: Boolean(engagement?.tracking_enabled),
    },
  };
}

/** Whether this step should fire for this subject. No condition means yes. */
export function shouldSend(step, context) {
  if (!step?.send_condition) return { send: true };
  const ok = evaluateConditions(step.send_condition, context);
  return { send: ok, reason: ok ? undefined : 'send_condition' };
}

/** Whether the journey should end here regardless of remaining steps. */
export function shouldExit(sequence, step, context) {
  if (sequence?.exit_on_reply && context.engagement.replied > 0) {
    return { exit: true, event: 'exited_replied', detail: 'The recipient replied' };
  }
  if (step?.exit_condition && evaluateConditions(step.exit_condition, context)) {
    return { exit: true, event: 'exited_goal', detail: 'Step exit condition met' };
  }
  return { exit: false };
}

async function logEvent(client, enrollment, event, { step = null, detail = null, emailId = null } = {}) {
  await client.query(
    `INSERT INTO sequence_enrollment_events
       (enrollment_id, sequence_id, company_id, step_order, event, detail, email_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [enrollment.id, enrollment.sequence_id, enrollment.company_id, step, event, detail, emailId]
  );
}

/**
 * Send one step and record it.
 *
 * Returns { delivered, reason }. The caller advances the enrolment only when
 * `delivered` is true — a failure leaves the enrolment exactly where it was so
 * the next run retries rather than skipping a step nobody received.
 */
export async function deliver(client, { enrollment, step, context, sequence }) {
  const to = context.email;
  if (!to) return { delivered: false, reason: 'no_email_address' };
  if (!transportConfigured()) return { delivered: false, reason: 'smtp_not_configured' };

  const subject = renderTemplate(step.subject || sequence.name || '', context);
  const html    = renderTemplate(step.body_html || '', context);

  const info = await transport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to, subject, html,
  });

  // The outbound record lives in crm_emails, the same table the email analytics
  // read — a journey send must be countable alongside a hand-written one.
  const { rows: [logged] } = await client.query(
    `INSERT INTO crm_emails
       (lead_id, contact_id, direction, subject, body_html, from_email, to_emails,
        status, sent_at, message_id, company_id, is_draft)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6::jsonb,'sent',NOW(),$7,$8,false)
     RETURNING id`,
    [enrollment.lead_id, enrollment.contact_id, subject, html,
     process.env.SMTP_FROM || process.env.SMTP_USER, JSON.stringify([to]),
     info?.messageId || null, enrollment.company_id]
  );
  return { delivered: true, emailId: logged.id };
}

/**
 * Advance one enrolment by at most one step.
 *
 * One step per run on purpose: a journey with three zero-delay steps should not
 * fire three emails into somebody's inbox in the same second because the runner
 * looped until it ran out of work.
 */
export async function runEnrollment(pool, enrollmentId, { now = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [enrollment] } = await client.query(
      `SELECT * FROM sequence_enrollments WHERE id = $1 FOR UPDATE`, [enrollmentId]);
    if (!enrollment) { await client.query('ROLLBACK'); return { skipped: 'not_found' }; }
    if (enrollment.status !== 'active') {
      await client.query('ROLLBACK'); return { skipped: enrollment.status };
    }
    // An enrolment with no company cannot be scoped, and an unscoped send is a
    // message to someone whose tenant we cannot establish. Refuse, loudly.
    if (enrollment.company_id == null) {
      await logEvent(client, enrollment, 'failed', { detail: 'Enrolment has no company_id' });
      await client.query(
        `UPDATE sequence_enrollments SET status='failed', last_error=$2 WHERE id=$1`,
        [enrollment.id, 'Enrolment has no company_id']);
      await client.query('COMMIT');
      return { failed: 'unscoped' };
    }

    const { rows: [sequence] } = await client.query(
      `SELECT * FROM email_sequences WHERE id = $1`, [enrollment.sequence_id]);
    if (!sequence || sequence.is_active === false) {
      await client.query('ROLLBACK'); return { skipped: 'sequence_inactive' };
    }

    // Two steps, not one: the step to run now, and the one after it.
    //
    // ⚠ THE ONE AFTER IS WHAT SCHEDULES. A step's delay is the wait BEFORE that
    // step, so after sending step 1 the next run is governed by step 2's delay.
    // Scheduling from the step just sent instead means step 1's `delay_days: 0`
    // decides when step 2 fires — which sent the whole journey in one burst,
    // caught by the live run in §156 when the sink received two messages.
    //
    // `step_order > current_step ORDER BY step_order` rather than an exact
    // `= current_step + 1`: real sequences have gaps in their numbering (the
    // seeded ones are numbered 2, 4, 3, 5, 1), and exact matching silently
    // completes a journey whose first step happens to be numbered 2.
    const { rows: steps } = await client.query(
      `SELECT * FROM crm_email_sequence_steps
        WHERE sequence_id = $1 AND step_order > $2 AND COALESCE(is_active, true)
        ORDER BY step_order
        LIMIT 2`,
      [sequence.id, enrollment.current_step ?? 0]);
    const [step, followingStep] = steps;
    const nextOrder = step?.step_order;

    if (!step) {
      await logEvent(client, enrollment, 'completed', { step: enrollment.current_step });
      await client.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), next_send_at=NULL
          WHERE id=$1`, [enrollment.id]);
      await client.query('COMMIT');
      return { completed: true };
    }

    const [{ rows: [lead] }, { rows: [contact] }, { rows: [engagement] }, { rows: [setting] }] = await Promise.all([
      enrollment.lead_id
        ? client.query(`SELECT * FROM leads WHERE id = $1 AND company_id = $2`,
                       [enrollment.lead_id, enrollment.company_id])
        : Promise.resolve({ rows: [null] }),
      enrollment.contact_id
        ? client.query(`SELECT * FROM contacts WHERE id = $1 AND company_id = $2`,
                       [enrollment.contact_id, enrollment.company_id])
        : Promise.resolve({ rows: [null] }),
      client.query(
        `SELECT COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int  AS opened,
                COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
                COUNT(*) FILTER (WHERE status = 'replied')::int     AS replied
           FROM crm_emails
          WHERE company_id = $1
            AND ($2::int IS NOT NULL AND lead_id = $2 OR $3::int IS NOT NULL AND contact_id = $3)`,
        [enrollment.company_id, enrollment.lead_id, enrollment.contact_id]),
      // crm_settings, not company_settings — the open-tracking flag is a CRM
      // setting and is opt-IN, defaulting false (§154).
      client.query(
        `SELECT COALESCE(BOOL_OR(email_open_tracking), false) AS enabled
           FROM crm_settings WHERE company_id = $1`, [enrollment.company_id]),
    ]);

    const context = buildContext({
      enrollment, lead, contact,
      engagement: { ...engagement, tracking_enabled: setting?.enabled },
    });

    const exit = shouldExit(sequence, step, context);
    if (exit.exit) {
      await logEvent(client, enrollment, exit.event, { step: nextOrder, detail: exit.detail });
      await client.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), next_send_at=NULL
          WHERE id=$1`, [enrollment.id]);
      await client.query('COMMIT');
      return { exited: exit.event };
    }

    const { send, reason } = shouldSend(step, context);
    if (!send) {
      // Skipped, not failed: the journey moves on to the next step at its own
      // delay. A skip that stalled the enrolment would make one unmet condition
      // silently end the journey.
      await logEvent(client, enrollment, 'condition_failed', { step: nextOrder, detail: reason });
      await advance(client, enrollment, nextOrder, followingStep, now, { sent: false });
      await client.query('COMMIT');
      return { skippedStep: nextOrder, completed: !followingStep };
    }

    let result;
    try {
      result = await deliver(client, { enrollment, step, context, sequence });
    } catch (err) {
      result = { delivered: false, reason: err.message };
    }

    if (!result.delivered) {
      // Left in place, not advanced — the next run retries. `attempts` is what
      // makes a permanently stuck journey visible instead of quietly looping.
      await logEvent(client, enrollment, 'failed', { step: nextOrder, detail: result.reason });
      await client.query(
        `UPDATE sequence_enrollments
            SET attempts = COALESCE(attempts,0) + 1,
                last_error = $2,
                status = CASE WHEN COALESCE(attempts,0) + 1 >= 5 THEN 'failed' ELSE status END
          WHERE id = $1`,
        [enrollment.id, result.reason]);
      await client.query('COMMIT');
      return { failed: result.reason };
    }

    await logEvent(client, enrollment, 'sent', { step: nextOrder, emailId: result.emailId });
    await advance(client, enrollment, nextOrder, followingStep, now, { sent: true });
    await client.query('COMMIT');
    return { sent: nextOrder, emailId: result.emailId, completed: !followingStep };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move the enrolment past the step just handled.
 *
 * Scheduled from `followingStep` — the wait belongs to the step that is next,
 * not to the one that just went out. With no following step the journey is over,
 * and it is closed here rather than on a further run: leaving it `active` with
 * `next_send_at` in the past means the runner picks it up every 15 minutes for
 * ever just to discover there is nothing to do.
 */
async function advance(client, enrollment, stepOrder, followingStep, now, { sent }) {
  if (!followingStep) {
    await logEvent(client, enrollment, 'completed', { step: stepOrder });
    await client.query(
      `UPDATE sequence_enrollments
          SET current_step = $2, status = 'completed', completed_at = NOW(),
              next_send_at = NULL, attempts = 0, last_error = NULL,
              last_sent_at = CASE WHEN $3 THEN NOW() ELSE last_sent_at END
        WHERE id = $1`,
      [enrollment.id, stepOrder, sent]);
    return;
  }
  await client.query(
    `UPDATE sequence_enrollments
        SET current_step = $2, next_send_at = $3, attempts = 0, last_error = NULL,
            last_sent_at = CASE WHEN $4 THEN NOW() ELSE last_sent_at END
      WHERE id = $1`,
    [enrollment.id, stepOrder, nextSendAt(followingStep, now), sent]);
}

/** Enrolments whose next step is due. Unscoped rows are excluded by the runner. */
export async function dueEnrollments(pool, { companyId = null, limit = 200, now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT e.id
       FROM sequence_enrollments e
       JOIN email_sequences s ON s.id = e.sequence_id
      WHERE e.status = 'active'
        AND e.company_id IS NOT NULL
        AND COALESCE(s.is_active, true)
        AND e.next_send_at IS NOT NULL
        AND e.next_send_at <= $1
        AND ($2::int IS NULL OR e.company_id = $2)
      ORDER BY e.next_send_at
      LIMIT $3`,
    [now, companyId, limit]
  );
  return rows.map(r => r.id);
}

/**
 * Run every due enrolment.
 *
 * Returns a tally that distinguishes sent from skipped from failed. A single
 * "processed" number would report a journey that delivered nothing as a success,
 * which is how the workflow engine came to be a counter.
 */
export async function runDue(pool, opts = {}) {
  const ids = await dueEnrollments(pool, opts);
  const tally = { due: ids.length, sent: 0, skipped: 0, completed: 0, exited: 0, failed: 0, errors: [] };
  for (const id of ids) {
    try {
      const r = await runEnrollment(pool, id, opts);
      // Order matters: a send that was also the LAST step reports both `sent`
      // and `completed`, and it must count as a send — otherwise the final email
      // of every journey goes missing from the tally.
      if (r.sent) { tally.sent++; if (r.completed) tally.completed++; }
      else if (r.skippedStep) { tally.skipped++; if (r.completed) tally.completed++; }
      else if (r.exited) tally.exited++;
      else if (r.completed) tally.completed++;
      else if (r.failed) { tally.failed++; tally.errors.push({ id, reason: r.failed }); }
    } catch (err) {
      tally.failed++; tally.errors.push({ id, reason: err.message });
    }
  }
  if (ids.length) {
    await pool.query(
      `UPDATE email_sequences SET last_run_at = NOW()
        WHERE id IN (SELECT sequence_id FROM sequence_enrollments WHERE id = ANY($1))`,
      [ids]
    ).catch(() => {});
  }
  return tally;
}

export default { runDue, runEnrollment, dueEnrollments, nextSendAt, shouldSend, shouldExit, buildContext, transportConfigured };
