/**
 * signatures.routes.js — Native Digital Signature Engine (Phase 30D)
 *
 * Provides workflow-aware, traceable, audit-logged signing without
 * any external provider dependency (no Zoho Sign required).
 *
 * Signed documents are immutably locked — no edits allowed post-signature.
 * Every state transition is written to signature_audit_log.
 */

import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import pool from '../../shared/db.js';
import * as esign from '../../../services/esign.service.js';
import { emitEsignEvent } from '../../../services/esignWebhook.service.js';
import { sendSigningInvite, sendSigningReminder } from '../../../utils/mailer.js';
import { generateOtp } from '../../../utils/otp.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const userId = req => req.user?.userId ?? req.user?.id ?? null;
const userName = req => req.user?.name ?? req.user?.email ?? 'Unknown';
// document_signings.created_by is FK → employees(id). The JWT carries employee_id
// (null for users with no employee record, e.g. super_admin). Never use users.id
// here or the FK constraint is violated.
const creatorId = req => req.user?.employee_id ?? null;

/* ── Audit helper — append-only ─────────────────────────────────────────── */
async function audit(signing_id, event, req, extra = {}) {
  try {
    await pool.query(
      `INSERT INTO signature_audit_log
         (signing_id, event, actor_id, actor_name, actor_ip, actor_ua, event_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        signing_id,
        event,
        userId(req),
        userName(req),
        req.ip || req.headers['x-forwarded-for'] || null,
        req.headers['user-agent'] || null,
        JSON.stringify(extra),
      ]
    );
  } catch (_) { /* audit must never crash the main flow */ }
}

/* ── safe wrapper ───────────────────────────────────────────────────────── */
const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ══════════════════════════════════════════════════════════════════════════
   LIST
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/', safe(async (req, res) => {
  const { status, workflow_type, linked_entity_type, linked_entity_id, limit = 100 } = req.query;
  let q = `SELECT s.*,
             (SELECT json_agg(al ORDER BY al.occurred_at)
              FROM signature_audit_log al WHERE al.signing_id = s.id) AS audit_trail
           FROM document_signings s WHERE 1=1`;
  const params = [];
  let i = 1;

  if (status)              { q += ` AND s.status = $${i++}`;              params.push(status); }
  if (workflow_type)       { q += ` AND s.workflow_type = $${i++}`;       params.push(workflow_type); }
  if (linked_entity_type)  { q += ` AND s.linked_entity_type = $${i++}`;  params.push(linked_entity_type); }
  if (linked_entity_id)    { q += ` AND s.linked_entity_id = $${i++}`;    params.push(parseInt(linked_entity_id)); }

  q += ` ORDER BY s.created_at DESC LIMIT $${i}`;
  params.push(parseInt(limit));

  const { rows } = await pool.query(q, params);
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   WORKFLOW SUMMARY — all signatures for a given entity
   GET /signatures/workflow/:type/:id
   (must be before /:id so Express doesn't swallow "workflow" as an id param)
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/workflow/:type/:id', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT json_agg(al ORDER BY al.occurred_at)
        FROM signature_audit_log al WHERE al.signing_id = s.id) AS audit_trail
     FROM document_signings s
     WHERE s.linked_entity_type = $1 AND s.linked_entity_id = $2
     ORDER BY s.created_at`,
    [req.params.type, parseInt(req.params.id)]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   TEMPLATES  (defined before /:id so "templates" is not swallowed as an id)
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/templates', safe(async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const { rows } = await pool.query(
    `SELECT * FROM signature_templates
       WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC`,
    [cid]
  );
  res.json({ success: true, data: rows });
}));

router.post('/templates', upload.single('file'), safe(async (req, res) => {
  const {
    name, description, doc_type = 'Other', message,
    expiry_days = 14, require_otp = false,
    fields_json = '[]', roles_json = '[]',
  } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  let source_file_path = null, source_file_name = null, source_mime = null, page_count = null;
  if (req.file) {
    const { relPath } = esign.saveBuffer(req.file.buffer, 'pdf');
    source_file_path = relPath;
    source_file_name = req.file.originalname;
    source_mime      = req.file.mimetype;
    page_count       = await esign.pdfPageCount(req.file.buffer);
  }

  const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return []; } };

  const { rows } = await pool.query(
    `INSERT INTO signature_templates
       (name, description, doc_type, source_file_path, source_file_name, source_mime, page_count,
        fields_json, roles_json, message, expiry_days, require_otp,
        created_by, created_by_name, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      name, description || null, doc_type, source_file_path, source_file_name, source_mime, page_count,
      JSON.stringify(parse(fields_json)), JSON.stringify(parse(roles_json)),
      message || null, parseInt(expiry_days) || 14,
      require_otp === 'true' || require_otp === true,
      userId(req), userName(req), req.scope?.company_id ?? null,
    ]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

router.delete('/templates/:tid', safe(async (req, res) => {
  await pool.query(`UPDATE signature_templates SET deleted_at = NOW() WHERE id = $1`, [req.params.tid]);
  res.json({ success: true });
}));

/* Instantiate a signing request from a template */
router.post('/templates/:tid/use', safe(async (req, res) => {
  const { rows: tRows } = await pool.query(
    `SELECT * FROM signature_templates WHERE id = $1 AND deleted_at IS NULL`, [req.params.tid]
  );
  const tpl = tRows[0];
  if (!tpl) return res.status(404).json({ success: false, error: 'Template not found' });

  const { title, recipient_name, recipient_email, signers = [] } = req.body;
  if (!title || !recipient_name || !recipient_email) {
    return res.status(400).json({ success: false, error: 'title, recipient_name and recipient_email are required' });
  }

  // Copy the template's source file to a fresh path so the template stays reusable
  let src = null, pageCount = tpl.page_count;
  if (tpl.source_file_path) {
    const buf = esign.readFile(tpl.source_file_path);
    if (buf) { src = esign.saveBuffer(buf, 'pdf').relPath; }
  }

  const sign_token = crypto.randomBytes(32).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO document_signings
       (title, doc_type, recipient_name, recipient_email, message, sign_token, status, sent_date,
        source_file_path, source_file_name, source_mime, page_count, template_id, require_otp, company_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_DATE,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      title, tpl.doc_type, recipient_name, recipient_email, tpl.message, sign_token,
      src, tpl.source_file_name, tpl.source_mime, pageCount, tpl.id, tpl.require_otp,
      req.scope?.company_id ?? null, creatorId(req),
    ]
  );
  const signing = rows[0];

  // Recreate signers from the request (order 1 = primary recipient auto-added on send)
  for (const s of signers) {
    await pool.query(
      `INSERT INTO signature_signers (signing_id, signer_name, signer_email, signing_order, role, sign_token, status, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
      [signing.id, s.signer_name, s.signer_email, s.signing_order || 2, s.role || 'signer',
       crypto.randomBytes(32).toString('hex'), signing.company_id]
    );
  }

  // Recreate field layout from template (signer_id left null → resolved on send)
  const fields = Array.isArray(tpl.fields_json) ? tpl.fields_json : [];
  for (const f of fields) {
    await pool.query(
      `INSERT INTO signature_fields
         (signing_id, field_type, page, x_ratio, y_ratio, w_ratio, h_ratio, required, label, font_size, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [signing.id, f.field_type || 'signature', f.page || 1,
       f.x_ratio, f.y_ratio, f.w_ratio || 0.2, f.h_ratio || 0.05,
       f.required !== false, f.label || null, f.font_size || 12, signing.company_id]
    );
  }

  await audit(signing.id, 'created_from_template', req, { template_id: tpl.id });
  res.status(201).json({ success: true, data: signing });
}));

/* ══════════════════════════════════════════════════════════════════════════
   FIELDS — standalone by id (before /:id)
   ══════════════════════════════════════════════════════════════════════════ */
router.put('/fields/:fieldId', safe(async (req, res) => {
  const { x_ratio, y_ratio, w_ratio, h_ratio, page, field_type, required, label, font_size, signer_id } = req.body;
  const { rows } = await pool.query(
    `UPDATE signature_fields SET
       x_ratio = COALESCE($2, x_ratio), y_ratio = COALESCE($3, y_ratio),
       w_ratio = COALESCE($4, w_ratio), h_ratio = COALESCE($5, h_ratio),
       page = COALESCE($6, page), field_type = COALESCE($7, field_type),
       required = COALESCE($8, required), label = COALESCE($9, label),
       font_size = COALESCE($10, font_size), signer_id = COALESCE($11, signer_id),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.fieldId, x_ratio, y_ratio, w_ratio, h_ratio, page, field_type,
     required, label, font_size, signer_id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Field not found' });
  res.json({ success: true, data: rows[0] });
}));

router.delete('/fields/:fieldId', safe(async (req, res) => {
  await pool.query(`DELETE FROM signature_fields WHERE id = $1`, [req.params.fieldId]);
  res.json({ success: true });
}));

/* ══════════════════════════════════════════════════════════════════════════
   BULK SEND — one template → many recipients, each gets their own request+link
   POST /signatures/bulk   { template_id, recipients:[{name,email,phone}], ... }
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/bulk', safe(async (req, res) => {
  const {
    template_id, recipients = [], message, require_otp = false,
    auto_reminder = false, reminder_interval_days = 3, max_reminders = 3,
    expiry_date,
  } = req.body;

  if (!template_id) return res.status(400).json({ success: false, error: 'template_id is required' });
  const clean = (recipients || []).filter(r => r?.name && r?.email);
  if (!clean.length) return res.status(400).json({ success: false, error: 'At least one recipient (name + email) is required' });

  const { rows: [tpl] } = await pool.query(
    `SELECT * FROM signature_templates WHERE id = $1 AND deleted_at IS NULL`, [template_id]
  );
  if (!tpl) return res.status(404).json({ success: false, error: 'Template not found' });

  const batchId = crypto.randomBytes(12).toString('hex');
  const cid = req.scope?.company_id ?? null;
  const tplFields = Array.isArray(tpl.fields_json) ? tpl.fields_json : [];
  const created = [];

  for (const r of clean) {
    // Copy template source so each request is independent
    let src = null;
    if (tpl.source_file_path) {
      const buf = esign.readFile(tpl.source_file_path);
      if (buf) src = esign.saveBuffer(buf, 'pdf').relPath;
    }

    const signToken = crypto.randomBytes(32).toString('hex');
    const { rows: [signing] } = await pool.query(
      `INSERT INTO document_signings
         (title, doc_type, recipient_name, recipient_email, message, sign_token, status, sent_date,
          source_file_path, source_file_name, source_mime, page_count, template_id, require_otp,
          auto_reminder, reminder_interval_days, max_reminders, bulk_batch_id, expiry_date,
          company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'sent',CURRENT_DATE,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        `${tpl.name} — ${r.name}`, tpl.doc_type, r.name, r.email, message || tpl.message, signToken,
        src, tpl.source_file_name, tpl.source_mime, tpl.page_count, tpl.id,
        require_otp === true || require_otp === 'true',
        auto_reminder === true || auto_reminder === 'true',
        parseInt(reminder_interval_days) || 3, parseInt(max_reminders) || 3,
        batchId, expiry_date || null, cid, creatorId(req),
      ]
    );

    // Primary signer (order 1)
    const signerToken = crypto.randomBytes(32).toString('hex');
    const { rows: [signer] } = await pool.query(
      `INSERT INTO signature_signers (signing_id, signer_name, signer_email, signer_phone, signing_order, role, sign_token, status, otp_channel, company_id)
       VALUES ($1,$2,$3,$4,1,'signer',$5,'otp_sent',$6,$7) RETURNING *`,
      [signing.id, r.name, r.email, r.phone || null, signerToken, r.phone ? 'sms' : 'email', cid]
    );

    // Clone template fields onto the primary signer
    for (const f of tplFields) {
      await pool.query(
        `INSERT INTO signature_fields
           (signing_id, signer_id, field_type, page, x_ratio, y_ratio, w_ratio, h_ratio, required, label, font_size, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [signing.id, signer.id, f.field_type || 'signature', f.page || 1,
         f.x_ratio, f.y_ratio, f.w_ratio || 0.2, f.h_ratio || 0.05,
         f.required !== false, f.label || null, f.font_size || 12, cid]
      );
    }

    let sent = false;
    try { const rr = await sendSigningInvite(r.email, { signerName: r.name, documentTitle: signing.title, token: signerToken, message: message || tpl.message, expiryDate: expiry_date }); sent = rr.sent; }
    catch (e) { console.error('[bulk] invite failed:', e.message); }

    await audit(signing.id, 'sent', req, { bulk_batch_id: batchId, recipient: r.email });
    emitEsignEvent(signing.id, 'request.sent', { recipient: r.email, bulk: true });
    created.push({ signing_id: signing.id, email: r.email, sent });
  }

  res.status(201).json({ success: true, batch_id: batchId, count: created.length, created });
}));

/* ══════════════════════════════════════════════════════════════════════════
   WEBHOOKS — CRUD (defined before /:id)
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/webhooks', safe(async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const { rows } = await pool.query(
    `SELECT id, company_id, url, events, active, description, last_status, last_delivered_at, failure_count, created_at
       FROM esign_webhooks WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
      ORDER BY created_at DESC`,
    [cid]
  );
  res.json({ success: true, data: rows });
}));

router.post('/webhooks', safe(async (req, res) => {
  const { url, events = ['all'], description, secret } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, error: 'A valid http(s) URL is required' });
  const sec = secret || crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO esign_webhooks (company_id, url, secret, events, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, url, events, active, description, secret, created_at`,
    [req.scope?.company_id ?? null, url, sec, JSON.stringify(events), description || null, userId(req)]
  );
  res.status(201).json({ success: true, data: rows[0] }); // secret returned once
}));

router.put('/webhooks/:id', safe(async (req, res) => {
  const { url, events, active, description } = req.body;
  const { rows } = await pool.query(
    `UPDATE esign_webhooks SET
       url = COALESCE($2, url),
       events = COALESCE($3, events),
       active = COALESCE($4, active),
       description = COALESCE($5, description),
       updated_at = NOW()
     WHERE id = $1 RETURNING id, url, events, active, description`,
    [req.params.id, url || null, events ? JSON.stringify(events) : null,
     typeof active === 'boolean' ? active : null, description ?? null]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Webhook not found' });
  res.json({ success: true, data: rows[0] });
}));

router.delete('/webhooks/:id', safe(async (req, res) => {
  await pool.query(`DELETE FROM esign_webhooks WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
}));

/* Fire a test ping to a webhook */
router.post('/webhooks/:id/test', safe(async (req, res) => {
  const { rows: [wh] } = await pool.query(`SELECT * FROM esign_webhooks WHERE id = $1`, [req.params.id]);
  if (!wh) return res.status(404).json({ success: false, error: 'Webhook not found' });
  const crypto2 = crypto;
  const body = JSON.stringify({ event: 'ping', occurred_at: new Date().toISOString(), data: { message: 'Test event from Pulse Sign' } });
  let status = null, ok = false, error = null;
  try {
    const r = await fetch(wh.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pulse-Event': 'ping',
        'X-Pulse-Signature': crypto2.createHmac('sha256', wh.secret || '').update(body).digest('hex'),
      },
      body,
    });
    status = r.status; ok = r.ok;
  } catch (e) { error = e.message; }
  await pool.query(
    `INSERT INTO esign_webhook_deliveries (webhook_id, event, response_status, success, error) VALUES ($1,'ping',$2,$3,$4)`,
    [wh.id, status, ok, error]
  ).catch(() => {});
  res.json({ success: ok, status, error });
}));

/* ══════════════════════════════════════════════════════════════════════════
   GET SINGLE
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT json_agg(al ORDER BY al.occurred_at)
        FROM signature_audit_log al WHERE al.signing_id = s.id) AS audit_trail
     FROM document_signings s WHERE s.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });

  await audit(rows[0].id, 'viewed', req);

  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   CREATE signing request
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/', safe(async (req, res) => {
  const {
    title, doc_type = 'Other',
    recipient_name, recipient_email, recipient_phone,
    message,
    expiry_date,
    workflow_type,
    linked_entity_id,
    linked_entity_type,
    company_id,
    require_otp = false,
    auto_reminder = false,
    reminder_interval_days = 3,
    max_reminders = 3,
    payment_required = false,
    payment_amount,
    payment_currency = 'INR',
    payment_note,
  } = req.body;

  if (!title || !recipient_name || !recipient_email) {
    return res.status(400).json({ success: false, error: 'title, recipient_name and recipient_email are required' });
  }

  const sign_token = crypto.randomBytes(32).toString('hex');
  const cid = company_id ?? req.scope?.company_id ?? null;
  const payReq = payment_required === true || payment_required === 'true';

  const { rows } = await pool.query(
    `INSERT INTO document_signings
       (title, doc_type, recipient_name, recipient_email, recipient_phone, message, expiry_date,
        sign_token, status, sent_date,
        workflow_type, linked_entity_id, linked_entity_type,
        require_otp, auto_reminder, reminder_interval_days, max_reminders,
        payment_required, payment_amount, payment_currency, payment_note, payment_status,
        created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',CURRENT_DATE,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [
      title, doc_type, recipient_name, recipient_email, recipient_phone || null, message || null,
      expiry_date || null, sign_token,
      workflow_type || null,
      linked_entity_id ? parseInt(linked_entity_id) : null,
      linked_entity_type || null,
      require_otp === true || require_otp === 'true',
      auto_reminder === true || auto_reminder === 'true',
      parseInt(reminder_interval_days) || 3,
      parseInt(max_reminders) || 3,
      payReq,
      payReq && payment_amount ? parseFloat(payment_amount) : null,
      payment_currency || 'INR',
      payment_note || null,
      payReq ? 'pending' : 'none',
      creatorId(req), cid,
    ]
  );

  await audit(rows[0].id, 'created', req, { title, recipient_email, workflow_type });
  res.status(201).json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SIGN — apply native signature (typed / drawn / uploaded)
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/sign', safe(async (req, res) => {
  const { signature_type = 'typed', signature_data, typed_name, sign_token } = req.body;

  // Fetch existing record
  const { rows: existing } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [req.params.id]
  );
  if (!existing[0]) return res.status(404).json({ success: false, error: 'Signing request not found' });
  const doc = existing[0];

  if (doc.is_locked) {
    return res.status(409).json({ success: false, error: 'Document is locked after signoff — no changes allowed.' });
  }
  if (['signed', 'declined'].includes(doc.status)) {
    return res.status(409).json({ success: false, error: `Document already in terminal state: ${doc.status}` });
  }

  // Validate token if provided (public-link signing)
  if (sign_token && doc.sign_token && sign_token !== doc.sign_token) {
    return res.status(401).json({ success: false, error: 'Invalid signature token' });
  }

  // Validate signature payload
  if (signature_type === 'typed' && !typed_name?.trim()) {
    return res.status(400).json({ success: false, error: 'typed_name is required for typed signatures' });
  }
  if (['drawn', 'uploaded'].includes(signature_type) && !signature_data) {
    return res.status(400).json({ success: false, error: 'signature_data (base64) is required' });
  }

  // Apply signature + lock document
  const now = new Date();
  const { rows } = await pool.query(
    `UPDATE document_signings SET
       status          = 'signed',
       signed_date     = CURRENT_DATE,
       signature_type  = $2,
       signature_data  = $3,
       typed_name      = $4,
       signer_ip       = $5,
       signer_ua       = $6,
       is_locked       = true,
       locked_at       = $7,
       locked_by       = $8,
       updated_at      = NOW()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      signature_type,
      signature_data || null,
      typed_name || null,
      req.ip || req.headers['x-forwarded-for'] || null,
      req.headers['user-agent'] || null,
      now,
      userId(req),
    ]
  );

  await audit(rows[0].id, 'signed', req, {
    signature_type,
    typed_name: typed_name || null,
    workflow_type: doc.workflow_type,
    linked_entity_type: doc.linked_entity_type,
    linked_entity_id: doc.linked_entity_id,
  });

  // Generate signed PDF + certificate if a source document is attached (non-fatal)
  let finalize = null;
  try { finalize = await esign.finalizeSigning(rows[0].id); } catch (e) { console.error('[esign] finalize failed:', e.message); }

  res.json({ success: true, data: rows[0], finalize });
}));

/* ══════════════════════════════════════════════════════════════════════════
   DECLINE
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/decline', safe(async (req, res) => {
  const { reason } = req.body;

  const { rows: existing } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [req.params.id]
  );
  if (!existing[0]) return res.status(404).json({ success: false, error: 'Not found' });
  if (existing[0].is_locked) {
    return res.status(409).json({ success: false, error: 'Document is locked — cannot decline.' });
  }

  const { rows } = await pool.query(
    `UPDATE document_signings
     SET status='declined', declined_reason=$2, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [req.params.id, reason || 'Declined by recipient']
  );

  await audit(rows[0].id, 'declined', req, { reason });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   REVOKE (sender cancels before signing)
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/revoke', safe(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [req.params.id]
  );
  if (!existing[0]) return res.status(404).json({ success: false, error: 'Not found' });
  if (existing[0].is_locked) {
    return res.status(409).json({ success: false, error: 'Cannot revoke a locked (signed) document.' });
  }

  const { rows } = await pool.query(
    `UPDATE document_signings
     SET status='declined', declined_reason='Revoked by sender', updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [req.params.id]
  );

  await audit(rows[0].id, 'revoked', req, { revoked_by: userId(req) });
  res.json({ success: true, data: rows[0] });
}));

/* ══════════════════════════════════════════════════════════════════════════
   AUDIT TRAIL (standalone)
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/audit', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM signature_audit_log WHERE signing_id=$1 ORDER BY occurred_at ASC`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   MULTI-SIGNER — ADD SIGNER
   POST /signatures/:id/signers
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/signers', safe(async (req, res) => {
  const { signer_name, signer_email, signer_phone, signing_order = 1, role = 'signer' } = req.body;
  if (!signer_name || !signer_email) {
    return res.status(400).json({ success: false, error: 'signer_name and signer_email are required' });
  }

  const { rows: [doc] } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [req.params.id]
  );
  if (!doc) return res.status(404).json({ success: false, error: 'Signing request not found' });
  if (doc.is_locked) return res.status(409).json({ success: false, error: 'Document is locked' });

  const sign_token = crypto.randomBytes(32).toString('hex');
  const companyId = doc.company_id;

  const { rows: [signer] } = await pool.query(
    `INSERT INTO signature_signers
       (signing_id, signer_name, signer_email, signer_phone, signing_order, role, sign_token, status, otp_channel, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
    [req.params.id, signer_name, signer_email, signer_phone || null, signing_order, role, sign_token,
     signer_phone ? 'sms' : 'email', companyId]
  );

  // Update total_signers count
  await pool.query(
    `UPDATE document_signings
     SET total_signers = (SELECT COUNT(*) FROM signature_signers WHERE signing_id=$1),
         signing_mode = CASE WHEN $2::integer > 1 THEN 'sequential' ELSE COALESCE(signing_mode,'single') END,
         updated_at = NOW()
     WHERE id = $1`,
    [req.params.id, signing_order]
  );

  await audit(doc.id, 'signer_added', req, { signer_email, role, signing_order });
  res.status(201).json({ success: true, data: signer });
}));

/* ══════════════════════════════════════════════════════════════════════════
   MULTI-SIGNER — LIST SIGNERS
   GET /signatures/:id/signers
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/signers', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM signature_signers WHERE signing_id=$1 ORDER BY signing_order, id`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   OTP — SEND OTP TO SIGNER
   POST /signatures/:id/signers/:signerId/send-otp
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/signers/:signerId/send-otp', safe(async (req, res) => {
  const { rows: [signer] } = await pool.query(
    `SELECT ss.*, ds.title FROM signature_signers ss
     JOIN document_signings ds ON ds.id = ss.signing_id
     WHERE ss.id = $1 AND ss.signing_id = $2`,
    [req.params.signerId, req.params.id]
  );
  if (!signer) return res.status(404).json({ success: false, error: 'Signer not found' });
  if (signer.status === 'signed') return res.status(409).json({ success: false, error: 'Already signed' });

  const otp_code = generateOtp();
  const otp_expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await pool.query(
    `UPDATE signature_signers SET otp_code=$1, otp_expires_at=$2, otp_attempts=0, status='otp_sent', updated_at=NOW()
     WHERE id=$3`,
    [otp_code, otp_expires_at, signer.id]
  );

  await audit(signer.signing_id, 'otp_sent', req, { signer_email: signer.signer_email });

  // Return OTP in response for email delivery (calling service handles the email)
  res.json({
    success: true,
    message: `OTP sent to ${signer.signer_email}`,
    otp_expires_at,
    // In production, do NOT return otp_code in response — send via email only.
    // Included here so the frontend can trigger the email via notificationService.
    _otp_for_email: otp_code,
    signer_email: signer.signer_email,
    document_title: signer.title,
  });
}));

/* ══════════════════════════════════════════════════════════════════════════
   OTP — VERIFY OTP + SIGN
   POST /signatures/:id/signers/:signerId/sign-with-otp
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/signers/:signerId/sign-with-otp', safe(async (req, res) => {
  const { otp_code, signature_type = 'typed', signature_data, typed_name } = req.body;

  if (!otp_code) return res.status(400).json({ success: false, error: 'otp_code is required' });

  const { rows: [signer] } = await pool.query(
    `SELECT * FROM signature_signers WHERE id = $1 AND signing_id = $2`,
    [req.params.signerId, req.params.id]
  );
  if (!signer) return res.status(404).json({ success: false, error: 'Signer not found' });
  if (signer.status === 'signed') return res.status(409).json({ success: false, error: 'Already signed' });
  if (signer.otp_attempts >= 3) return res.status(429).json({ success: false, error: 'Too many OTP attempts — request a new OTP' });

  if (signer.otp_code !== otp_code) {
    await pool.query(`UPDATE signature_signers SET otp_attempts=otp_attempts+1, updated_at=NOW() WHERE id=$1`, [signer.id]);
    return res.status(401).json({ success: false, error: 'Invalid OTP' });
  }

  if (signer.otp_expires_at && new Date(signer.otp_expires_at) < new Date()) {
    return res.status(401).json({ success: false, error: 'OTP has expired — request a new one' });
  }

  const now = new Date();
  const { rows: [updated] } = await pool.query(
    `UPDATE signature_signers SET
       status = 'signed',
       signed_at = $1,
       signer_ip = $2,
       signer_ua = $3,
       signature_type = $4,
       signature_data = $5,
       typed_name = $6,
       otp_code = NULL,
       updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [now, req.ip || null, req.headers['user-agent'] || null,
     signature_type, signature_data || null, typed_name || null, signer.id]
  );

  // Update signed_count on parent document
  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='signed') AS signed,
            COUNT(*) AS total
     FROM signature_signers WHERE signing_id=$1`,
    [req.params.id]
  );
  const allSigned = parseInt(counts.signed) >= parseInt(counts.total);

  await pool.query(
    `UPDATE document_signings SET
       signed_count = $1,
       status = CASE WHEN $2 THEN 'signed' ELSE status END,
       is_locked = CASE WHEN $2 THEN true ELSE is_locked END,
       locked_at = CASE WHEN $2 THEN NOW() ELSE locked_at END,
       updated_at = NOW()
     WHERE id = $3`,
    [parseInt(counts.signed), allSigned, req.params.id]
  );

  await audit(signer.signing_id, 'signed_with_otp', req, {
    signer_email: signer.signer_email, signature_type, all_signed: allSigned,
  });

  if (allSigned) {
    try { await esign.finalizeSigning(parseInt(req.params.id)); } catch (e) { console.error('[esign] finalize failed:', e.message); }
  }

  res.json({ success: true, data: updated, all_signed: allSigned });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SIGNER — DECLINE
   POST /signatures/:id/signers/:signerId/decline
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/signers/:signerId/decline', safe(async (req, res) => {
  const { reason } = req.body;
  const { rows: [signer] } = await pool.query(
    `SELECT * FROM signature_signers WHERE id=$1 AND signing_id=$2`, [req.params.signerId, req.params.id]
  );
  if (!signer) return res.status(404).json({ success: false, error: 'Signer not found' });

  const { rows: [updated] } = await pool.query(
    `UPDATE signature_signers SET status='declined', decline_reason=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [reason || 'Declined', signer.id]
  );

  // If any signer declines, mark parent document as declined
  await pool.query(
    `UPDATE document_signings SET status='declined', declined_reason=$1, updated_at=NOW() WHERE id=$2`,
    [`Signer ${signer.signer_email} declined: ${reason || ''}`, req.params.id]
  );

  await audit(signer.signing_id, 'signer_declined', req, { signer_email: signer.signer_email, reason });
  res.json({ success: true, data: updated });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SOURCE DOCUMENT — upload the PDF to be signed
   POST /signatures/:id/source   (multipart, field name "file")
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/source', upload.single('file'), safe(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file provided (field name: file)' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(415).json({ success: false, error: 'Only PDF documents can be signed. Convert the file to PDF first.' });
  }

  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Signing request not found' });
  if (doc.is_locked) return res.status(409).json({ success: false, error: 'Document is locked — cannot replace source.' });

  const pageCount = await esign.pdfPageCount(req.file.buffer);
  if (pageCount === 0) return res.status(400).json({ success: false, error: 'Unable to read the PDF. It may be corrupt or encrypted.' });

  const { relPath } = esign.saveBuffer(req.file.buffer, 'pdf');
  const { rows } = await pool.query(
    `UPDATE document_signings SET
       source_file_path = $2, source_file_name = $3, source_mime = $4, page_count = $5, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id, relPath, req.file.originalname, req.file.mimetype, pageCount]
  );
  await audit(doc.id, 'source_uploaded', req, { file: req.file.originalname, pages: pageCount });
  res.json({ success: true, data: rows[0] });
}));

/* Stream the source PDF (authenticated, for the designer) */
router.get('/:id/source', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT source_file_path, source_file_name FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc?.source_file_path) return res.status(404).json({ success: false, error: 'No source document uploaded' });
  const buf = esign.readFile(doc.source_file_path);
  if (!buf) return res.status(404).json({ success: false, error: 'Source file missing on disk' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.source_file_name || 'document.pdf')}"`);
  res.send(buf);
}));

/* ══════════════════════════════════════════════════════════════════════════
   FIELDS — list + bulk replace for a signing request
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/fields', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM signature_fields WHERE signing_id = $1 ORDER BY page, id`, [req.params.id]
  );
  res.json({ success: true, data: rows });
}));

/* Replace the entire field set (designer save). Body: { fields: [...] } */
router.post('/:id/fields', safe(async (req, res) => {
  const { fields = [] } = req.body;
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Signing request not found' });
  if (doc.is_locked) return res.status(409).json({ success: false, error: 'Document is locked.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM signature_fields WHERE signing_id = $1`, [req.params.id]);
    for (const f of fields) {
      await client.query(
        `INSERT INTO signature_fields
           (signing_id, signer_id, field_type, page, x_ratio, y_ratio, w_ratio, h_ratio, required, label, font_size, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.params.id, f.signer_id || null, f.field_type || 'signature', f.page || 1,
         f.x_ratio, f.y_ratio, f.w_ratio || 0.2, f.h_ratio || 0.05,
         f.required !== false, f.label || null, f.font_size || 12, doc.company_id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`SELECT * FROM signature_fields WHERE signing_id = $1 ORDER BY page, id`, [req.params.id]);
  await audit(doc.id, 'fields_saved', req, { count: fields.length });
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   SEND — dispatch signing invitations by email
   Ensures the primary recipient exists as an order-1 signer, then emails all
   pending signers their unique public link. Unassigned fields are mapped to
   the first signer so at least the primary recipient can complete the doc.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/send', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Signing request not found' });
  if (doc.is_locked || doc.status === 'signed') {
    return res.status(409).json({ success: false, error: 'Document already completed.' });
  }

  // Ensure primary recipient is signer #1
  let { rows: primary } = await pool.query(
    `SELECT * FROM signature_signers WHERE signing_id = $1 AND signing_order = 1 LIMIT 1`, [req.params.id]
  );
  if (primary.length === 0 && doc.recipient_email) {
    const tok = crypto.randomBytes(32).toString('hex');
    const { rows: ins } = await pool.query(
      `INSERT INTO signature_signers (signing_id, signer_name, signer_email, signer_phone, signing_order, role, sign_token, status, otp_channel, company_id)
       VALUES ($1,$2,$3,$4,1,'signer',$5,'pending',$6,$7) RETURNING *`,
      [req.params.id, doc.recipient_name, doc.recipient_email, doc.recipient_phone || null, tok,
       doc.recipient_phone ? 'sms' : 'email', doc.company_id]
    );
    primary = ins;
  }

  const { rows: allSigners } = await pool.query(
    `SELECT * FROM signature_signers WHERE signing_id = $1 ORDER BY signing_order, id`, [req.params.id]
  );

  // Assign any unassigned fields to the primary signer so they are fillable
  if (primary[0]) {
    await pool.query(
      `UPDATE signature_fields SET signer_id = $2 WHERE signing_id = $1 AND signer_id IS NULL`,
      [req.params.id, primary[0].id]
    );
  }

  await pool.query(
    `UPDATE document_signings SET status = 'sent', sent_date = CURRENT_DATE,
       total_signers = $2, updated_at = NOW() WHERE id = $1`,
    [req.params.id, allSigners.length || 1]
  );

  // For sequential mode, only email the current lowest-order pending signer.
  const sequential = (doc.signing_mode || 'single') === 'sequential';
  const pending = allSigners.filter(s => s.status === 'pending');
  const targets = sequential && pending.length ? [pending[0]] : pending;

  const results = [];
  for (const s of targets) {
    let r = { sent: false };
    try {
      r = await sendSigningInvite(s.signer_email, {
        signerName: s.signer_name, documentTitle: doc.title,
        token: s.sign_token, message: doc.message, expiryDate: doc.expiry_date,
      });
    } catch (e) { r = { sent: false, error: e.message }; }
    await pool.query(`UPDATE signature_signers SET status = 'otp_sent' WHERE id = $1 AND status = 'pending'`, [s.id])
      .catch(() => {}); // 'otp_sent' reused as "invited"; keeps CHECK constraint satisfied
    results.push({ email: s.signer_email, ...r });
  }

  await audit(doc.id, 'sent', req, { recipients: targets.map(t => t.signer_email), sequential });
  emitEsignEvent(doc.id, 'request.sent', { recipients: targets.map(t => t.signer_email) });
  res.json({ success: true, sent: results, signers: allSigners.length });
}));

/* Resend an invitation to all outstanding signers */
router.post('/:id/remind', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Not found' });

  const { rows: pending } = await pool.query(
    `SELECT * FROM signature_signers WHERE signing_id = $1 AND status NOT IN ('signed','declined') ORDER BY signing_order`,
    [req.params.id]
  );
  const results = [];
  for (const s of pending) {
    try {
      const r = await sendSigningReminder(s.signer_email, { signerName: s.signer_name, documentTitle: doc.title, token: s.sign_token });
      results.push({ email: s.signer_email, ...r });
    } catch (e) { results.push({ email: s.signer_email, sent: false, error: e.message }); }
  }
  await pool.query(
    `UPDATE document_signings SET reminder_count = COALESCE(reminder_count,0) + 1, last_reminder_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  await audit(doc.id, 'reminded', req, { count: pending.length });
  res.json({ success: true, reminded: results });
}));

/* ══════════════════════════════════════════════════════════════════════════
   DOWNLOADS — signed PDF + completion certificate (authenticated)
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/:id/signed-pdf', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
  let relPath = doc.signed_pdf_path;
  if (!relPath && doc.status === 'signed') {
    const fin = await esign.finalizeSigning(doc.id); // lazy generate if missing
    relPath = fin?.signed_pdf_path;
  }
  const buf = relPath ? esign.readFile(relPath) : null;
  if (!buf) return res.status(404).json({ success: false, error: 'Signed PDF not available yet.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="signed-${doc.id}.pdf"`);
  res.send(buf);
}));

router.get('/:id/certificate', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
  let relPath = doc.certificate_path;
  if (!relPath) {
    const cert = await esign.generateCertificate(doc.id, doc.document_hash);
    if (cert) {
      relPath = cert.relPath;
      await pool.query(`UPDATE document_signings SET certificate_path = $2 WHERE id = $1`, [doc.id, relPath]);
    }
  }
  const buf = relPath ? esign.readFile(relPath) : null;
  if (!buf) return res.status(404).json({ success: false, error: 'Certificate not available.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="certificate-${doc.id}.pdf"`);
  res.send(buf);
}));

/* ══════════════════════════════════════════════════════════════════════════
   IN-PERSON SIGNING — host hands the device to the signer on the same screen.
   Ensures the primary signer exists and returns a token to open /sign/:token.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/in-person', safe(async (req, res) => {
  const { signer_id } = req.body;
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
  if (doc.is_locked) return res.status(409).json({ success: false, error: 'Document already completed.' });

  let signer;
  if (signer_id) {
    ({ rows: [signer] } = await pool.query(`SELECT * FROM signature_signers WHERE id = $1 AND signing_id = $2`, [signer_id, doc.id]));
  } else {
    ({ rows: [signer] } = await pool.query(`SELECT * FROM signature_signers WHERE signing_id = $1 AND signing_order = 1 LIMIT 1`, [doc.id]));
    if (!signer && doc.recipient_email) {
      const tok = crypto.randomBytes(32).toString('hex');
      ({ rows: [signer] } = await pool.query(
        `INSERT INTO signature_signers (signing_id, signer_name, signer_email, signing_order, role, sign_token, status, in_person, company_id)
         VALUES ($1,$2,$3,1,'signer',$4,'otp_sent',TRUE,$5) RETURNING *`,
        [doc.id, doc.recipient_name, doc.recipient_email, tok, doc.company_id]
      ));
      // Assign unassigned fields to this signer
      await pool.query(`UPDATE signature_fields SET signer_id = $2 WHERE signing_id = $1 AND signer_id IS NULL`, [doc.id, signer.id]);
    }
  }
  if (!signer) return res.status(400).json({ success: false, error: 'No signer available for in-person signing.' });

  await pool.query(`UPDATE signature_signers SET in_person = TRUE WHERE id = $1`, [signer.id]);
  await pool.query(`UPDATE document_signings SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END WHERE id = $1`, [doc.id]);
  await audit(doc.id, 'in_person_started', req, { signer_email: signer.signer_email });
  res.json({ success: true, token: signer.sign_token, signer: { id: signer.id, name: signer.signer_name, email: signer.signer_email } });
}));

/* ── Attachments uploaded by signers (sender view) ───────────────────────── */
router.get('/:id/attachments', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, signer_id, file_name, mime, size_bytes, uploaded_by_name, created_at
       FROM signature_attachments WHERE signing_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
}));

router.get('/:id/attachments/:attId/download', safe(async (req, res) => {
  const { rows: [a] } = await pool.query(
    `SELECT * FROM signature_attachments WHERE id = $1 AND signing_id = $2`, [req.params.attId, req.params.id]
  );
  if (!a) return res.status(404).json({ success: false, error: 'Not found' });
  const buf = esign.readFile(a.file_path);
  if (!buf) return res.status(404).json({ success: false, error: 'File missing on disk' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.file_name || 'attachment')}"`);
  res.send(buf);
}));

/* ── Auto-reminder configuration ─────────────────────────────────────────── */
router.put('/:id/reminder-config', safe(async (req, res) => {
  const { auto_reminder, reminder_interval_days, max_reminders } = req.body;
  const { rows } = await pool.query(
    `UPDATE document_signings SET
       auto_reminder = COALESCE($2, auto_reminder),
       reminder_interval_days = COALESCE($3, reminder_interval_days),
       max_reminders = COALESCE($4, max_reminders),
       updated_at = NOW()
     WHERE id = $1 RETURNING auto_reminder, reminder_interval_days, max_reminders`,
    [req.params.id, typeof auto_reminder === 'boolean' ? auto_reminder : null,
     reminder_interval_days ?? null, max_reminders ?? null]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* ── Payment-on-sign configuration ───────────────────────────────────────── */
router.put('/:id/payment', safe(async (req, res) => {
  const { payment_required, payment_amount, payment_currency = 'INR', payment_note } = req.body;
  const { rows } = await pool.query(
    `UPDATE document_signings SET
       payment_required = COALESCE($2, payment_required),
       payment_amount   = COALESCE($3, payment_amount),
       payment_currency = COALESCE($4, payment_currency),
       payment_note     = COALESCE($5, payment_note),
       payment_status   = CASE WHEN $2 = TRUE AND payment_status = 'none' THEN 'pending' ELSE payment_status END,
       updated_at = NOW()
     WHERE id = $1 RETURNING payment_required, payment_amount, payment_currency, payment_status, payment_note`,
    [req.params.id, typeof payment_required === 'boolean' ? payment_required : null,
     payment_amount ?? null, payment_currency, payment_note ?? null]
  );
  if (!rows[0]) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: rows[0] });
}));

/* Verify a signed document's integrity against its stored hash */
router.get('/:id/verify', safe(async (req, res) => {
  const { rows: [doc] } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.id]);
  if (!doc) return res.status(404).json({ success: false, error: 'Not found' });
  if (!doc.signed_pdf_path || !doc.document_hash) {
    return res.json({ success: true, verified: false, reason: 'Document not yet signed.' });
  }
  const buf = esign.readFile(doc.signed_pdf_path);
  const current = buf ? esign.sha256(buf) : null;
  res.json({
    success: true,
    verified: current === doc.document_hash,
    stored_hash: doc.document_hash,
    current_hash: current,
  });
}));

export default router;
