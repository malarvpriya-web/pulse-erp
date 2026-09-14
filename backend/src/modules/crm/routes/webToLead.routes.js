/**
 * webToLead.routes.js — public web-to-lead capture, plus the staff-side form
 * management behind it.
 *
 * The brief names "web lead capture" (§1). There was no public endpoint a
 * marketing form could post to, so every web enquiry was retyped by hand into
 * the CRM.
 *
 * TWO ROUTERS, MOUNTED DIFFERENTLY
 * --------------------------------
 * `publicRouter` takes anonymous POSTs from a website form and is mounted OUTSIDE
 * verifyToken. `adminRouter` manages the forms and is mounted inside the CRM
 * router with the normal permission gates.
 *
 * They are separate objects rather than one router with per-route middleware so
 * that the public surface is exactly one endpoint, visible at the mount site in
 * server.js. A public write path hidden among fifty authenticated ones is how a
 * gate goes missing.
 *
 * WHAT DEFENDS A PUBLIC WRITE ENDPOINT
 * ------------------------------------
 *  - a per-form KEY, revocable from the database with no deploy;
 *  - an ORIGIN allowlist per form (empty = any, which someone has to choose);
 *  - a per-form HOURLY CAP, counted from the submissions table itself so it
 *    survives a restart — an in-memory counter resets to zero on every deploy,
 *    which is when a flood is most likely;
 *  - a HONEYPOT field: a real browser leaves it empty, a bot fills everything in.
 *    Answered with 200 so the bot cannot tell it was caught;
 *  - DUPLICATE suppression on email within the window, so a double-click or a
 *    retry does not create two enquiries;
 *  - every submission recorded, accepted or not. A rejected submission is the
 *    only evidence that a form is being abused or that a real enquiry was lost.
 *
 * The endpoint never reveals whether an email already exists — that would make
 * it a customer-enumeration oracle.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { logAudit } from '../../../services/AuditService.js';
import leadsRepository from '../repositories/leads.repository.js';
import { resolveAssignment } from '../services/leadAssignment.service.js';
import crypto from 'node:crypto';

export const publicRouter = express.Router();
export const adminRouter = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const DEDUPE_MINUTES = 30;

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message || 'Internal error' });

async function record(formId, companyId, status, { leadId = null, reason = null, payload = null, req }) {
  try {
    await pool.query(
      `INSERT INTO web_lead_submissions
         (form_id, company_id, lead_id, status, reason, payload, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [formId, companyId, leadId, status, reason,
       payload ? JSON.stringify(payload) : null,
       req?.ip ?? null, req?.get?.('user-agent') ?? null]
    );
  } catch (err) {
    // Never let the audit write break the capture — a lost enquiry is worse
    // than a missing log line — but never swallow it silently either.
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'web_lead_submission_log_failed',
      formId, status, message: err.message,
    }));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC — one endpoint
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/public/web-lead/:formKey
 *
 * Body: { company_name, contact_person, email, phone, message, industry,
 *         location, zone, estimated_value, website }   // `website` is the honeypot
 */
publicRouter.post('/web-lead/:formKey', async (req, res) => {
  try {
    const { rows: [form] } = await pool.query(
      `SELECT * FROM web_lead_forms WHERE form_key = $1`, [req.params.formKey]
    );
    // Same answer for an unknown key and a disabled form: a public endpoint must
    // not confirm which form keys exist.
    if (!form || !form.is_active) {
      return res.status(404).json({ error: 'Form not found' });
    }

    const origins = Array.isArray(form.allowed_origins) ? form.allowed_origins : [];
    if (origins.length) {
      const origin = req.get('origin') || req.get('referer') || '';
      const ok = origins.some(o => origin.startsWith(String(o)));
      if (!ok) {
        await record(form.id, form.company_id, 'rejected', { reason: `origin not allowed: ${origin || '(none)'}`, payload: req.body, req });
        return res.status(403).json({ error: 'This form cannot be submitted from that origin' });
      }
    }

    // Counted from the table, so a restart cannot reset it.
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM web_lead_submissions
        WHERE form_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [form.id]
    );
    if (n >= form.max_per_hour) {
      await record(form.id, form.company_id, 'rate_limited', { reason: `${n} submissions in the last hour, cap ${form.max_per_hour}`, req });
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }

    // Honeypot. 200 on purpose: telling a bot it was detected teaches it to
    // stop filling the field.
    if (String(req.body?.website ?? '').trim() !== '') {
      await record(form.id, form.company_id, 'spam', { reason: 'honeypot field filled', payload: req.body, req });
      return res.status(200).json({ success: true, message: 'Thank you — we will be in touch.' });
    }

    const companyName = String(req.body?.company_name ?? '').trim();
    const contact = String(req.body?.contact_person ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();

    if (!companyName && !contact) {
      await record(form.id, form.company_id, 'rejected', { reason: 'neither company_name nor contact_person supplied', payload: req.body, req });
      return res.status(400).json({ error: 'Please tell us your name or your company.' });
    }
    if (!email && !phone) {
      await record(form.id, form.company_id, 'rejected', { reason: 'no email and no phone', payload: req.body, req });
      return res.status(400).json({ error: 'Please leave an email address or a phone number so we can reply.' });
    }
    if (email && !EMAIL_RE.test(email)) {
      await record(form.id, form.company_id, 'rejected', { reason: 'invalid email format', payload: req.body, req });
      return res.status(400).json({ error: 'That email address does not look right.' });
    }

    // Same email through the same form inside the window is one enquiry, not two.
    if (email) {
      const { rows: [dupe] } = await pool.query(
        `SELECT s.id, s.lead_id FROM web_lead_submissions s
          WHERE s.form_id = $1 AND s.status = 'accepted'
            AND LOWER(s.payload->>'email') = LOWER($2)
            AND s.created_at > NOW() - ($3 || ' minutes')::interval
          ORDER BY s.created_at DESC LIMIT 1`,
        [form.id, email, String(DEDUPE_MINUTES)]
      );
      if (dupe) {
        await record(form.id, form.company_id, 'duplicate', { leadId: dupe.lead_id, reason: `same email within ${DEDUPE_MINUTES} minutes`, payload: req.body, req });
        // Indistinguishable from success: a different answer here would confirm
        // to an outsider that the address had been submitted before.
        return res.status(200).json({ success: true, message: 'Thank you — we will be in touch.' });
      }
    }

    const payload = {
      company_name: companyName || contact,
      contact_person: contact || null,
      email: email || null,
      phone: phone || null,
      lead_source: form.lead_source,
      industry: String(req.body?.industry ?? '').trim() || form.default_industry || null,
      location: String(req.body?.location ?? '').trim() || null,
      zone: String(req.body?.zone ?? '').trim() || form.default_zone || null,
      estimated_value: Number.isFinite(Number(req.body?.estimated_value)) && Number(req.body.estimated_value) >= 0
        ? Number(req.body.estimated_value) : null,
      notes: String(req.body?.message ?? '').trim() || null,
      status: 'New',
      company_id: form.company_id,
    };

    // Territory and owner, exactly as an internally-created lead gets them.
    let assigned_to = null;
    let territory_id = null;
    try {
      const resolved = await resolveAssignment(form.company_id, 'round_robin', payload);
      assigned_to = resolved.assigned_to;
      territory_id = resolved.territory_id;
    } catch (err) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), level: 'WARN', event: 'web_lead_assignment_failed',
        formId: form.id, message: err.message,
      }));
    }

    const lead = await leadsRepository.create({ ...payload, assigned_to, territory_id, created_by: null });

    await pool.query(
      `UPDATE web_lead_forms
          SET submission_count = submission_count + 1, last_submission_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [form.id]
    );
    await record(form.id, form.company_id, 'accepted', { leadId: lead.id, payload: req.body, req });

    logAudit({
      userId: null, module: 'crm', recordId: lead.id, recordType: 'lead',
      action: 'create', newData: { source: 'web_to_lead', form: form.name, lead_id: lead.id },
      req, company_id: form.company_id,
    });

    // Deliberately minimal: a public caller gets confirmation, never the
    // internal id, the assigned owner or anything else about the CRM.
    res.status(201).json({ success: true, message: 'Thank you — we will be in touch.' });
  } catch (err) {
    console.error('[web-to-lead]', err.message);
    res.status(500).json({ error: 'We could not record your enquiry. Please try again.' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   STAFF — form management
   ══════════════════════════════════════════════════════════════════════════ */

adminRouter.get('/web-lead-forms', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, e.name AS created_by_name,
              (SELECT COUNT(*) FROM web_lead_submissions s
                WHERE s.form_id = f.id AND s.created_at > NOW() - INTERVAL '30 days')::int AS submissions_30d,
              (SELECT COUNT(*) FROM web_lead_submissions s
                WHERE s.form_id = f.id AND s.status <> 'accepted'
                  AND s.created_at > NOW() - INTERVAL '30 days')::int                      AS rejected_30d
         FROM web_lead_forms f
         LEFT JOIN employees e ON e.id = f.created_by
        WHERE ($1::int IS NULL OR f.company_id = $1)
        ORDER BY f.created_at DESC`,
      [companyOf(req)]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

adminRouter.post('/web-lead-forms', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required' });
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const maxPerHour = Number.isFinite(Number(req.body?.max_per_hour)) && Number(req.body.max_per_hour) > 0
      ? Math.min(Number(req.body.max_per_hour), 10000) : 60;
    const origins = Array.isArray(req.body?.allowed_origins) ? req.body.allowed_origins.map(String) : [];

    // Generated, never accepted from the caller: a key someone chooses is a key
    // someone can guess.
    const formKey = crypto.randomBytes(24).toString('base64url');

    const { rows: [row] } = await pool.query(
      `INSERT INTO web_lead_forms
         (company_id, name, form_key, lead_source, default_zone, default_industry,
          allowed_origins, max_per_hour, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, name, formKey,
       String(req.body?.lead_source ?? 'Website').trim() || 'Website',
       req.body?.default_zone ?? null, req.body?.default_industry ?? null,
       JSON.stringify(origins), maxPerHour, await employeeOf(req, pool)]
    );

    logAudit({
      userId: req.user?.userId, module: 'crm', recordId: row.id, recordType: 'web_lead_form',
      action: 'create', newData: { ...row, form_key: '[redacted]' }, req, company_id: cid,
    });
    res.status(201).json({ ...row, endpoint: `/api/public/web-lead/${formKey}` });
  } catch (err) { fail(res, err); }
});

adminRouter.patch('/web-lead-forms/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const allowed = ['name', 'lead_source', 'default_zone', 'default_industry', 'max_per_hour', 'is_active'];
    const sets = []; const vals = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
    }
    if (Array.isArray(req.body?.allowed_origins)) {
      sets.push(`allowed_origins = $${sets.length + 1}`);
      vals.push(JSON.stringify(req.body.allowed_origins.map(String)));
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    sets.push('updated_at = NOW()');
    vals.push(req.params.id, cid);
    const { rows } = await pool.query(
      `UPDATE web_lead_forms SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND ($${vals.length}::int IS NULL OR company_id = $${vals.length})
        RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Form not found' });

    logAudit({
      userId: req.user?.userId, module: 'crm', recordId: req.params.id, recordType: 'web_lead_form',
      action: 'update', newData: { ...rows[0], form_key: '[redacted]' }, req, company_id: cid,
    });
    res.json({ ...rows[0], form_key: '[redacted]' });
  } catch (err) { fail(res, err); }
});

/** Submission history — including what was refused, and why. */
adminRouter.get('/web-lead-forms/:id/submissions', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [form] } = await pool.query(
      `SELECT id FROM web_lead_forms WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const { rows } = await pool.query(
      `SELECT s.id, s.status, s.reason, s.lead_id, s.ip_address, s.created_at,
              s.payload->>'email' AS email, s.payload->>'company_name' AS company_name
         FROM web_lead_submissions s
        WHERE s.form_id = $1
        ORDER BY s.created_at DESC
        LIMIT 200`,
      [req.params.id]
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) { fail(res, err); }
});

export default { publicRouter, adminRouter };
