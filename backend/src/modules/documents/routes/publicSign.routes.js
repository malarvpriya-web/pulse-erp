/**
 * publicSign.routes.js — Public (no-login) signing surface
 *
 * Mounted at /api/sign WITHOUT verifyToken. Every route is gated by a
 * cryptographically-random per-signer token delivered by email. A recipient
 * opens /sign/:token in the browser, optionally verifies an emailed OTP, fills
 * their assigned fields, and applies their signature — exactly like Zoho Sign's
 * recipient experience.
 *
 * No authenticated user context exists here, so audit rows record the signer.
 */

import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import pool from '../../shared/db.js';
import * as esign from '../../../services/esign.service.js';
import { emitEsignEvent } from '../../../services/esignWebhook.service.js';
import { sendSignerOtp, sendSigningInvite } from '../../../utils/mailer.js';
import { sendSms } from '../../../utils/sms.js';
import { generateOtp } from '../../../utils/otp.js';
import { dbRateLimit } from '../../../middlewares/rateLimit.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Every OTP send bills real money (SMS) and can be aimed at a third party's
// phone, so throttle on the signing token rather than the caller's IP — the
// token is the resource being abused, and IP-keying lets one attacker rotate
// addresses to keep hammering a single signer. The global limiter still caps
// per-IP volume on top of this.
const otpSendLimit = dbRateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  bucket:   'esign_otp',
  key:      req => req.params.token,
});

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error('[publicSign]', e.message); res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' }); }
};

async function audit(signing_id, event, req, actor, extra = {}) {
  try {
    await pool.query(
      `INSERT INTO signature_audit_log (signing_id, event, actor_name, actor_ip, actor_ua, event_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [signing_id, event, actor || 'Signer',
       req.ip || req.headers['x-forwarded-for'] || null,
       req.headers['user-agent'] || null, JSON.stringify(extra)]
    );
  } catch (_) {}
}

/** Resolve a token to { signing, signer }. signer may be null for legacy single. */
async function resolve(token) {
  const { rows: sr } = await pool.query(
    `SELECT * FROM signature_signers WHERE sign_token = $1 LIMIT 1`, [token]
  );
  if (sr[0]) {
    const { rows: dr } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [sr[0].signing_id]);
    return { signing: dr[0] || null, signer: sr[0] };
  }
  const { rows: dr } = await pool.query(`SELECT * FROM document_signings WHERE sign_token = $1 LIMIT 1`, [token]);
  return { signing: dr[0] || null, signer: null };
}

const publicSigner = s => s ? {
  id: s.id, name: s.signer_name, email: s.signer_email,
  role: s.role, status: s.status, signing_order: s.signing_order,
} : null;

/* ── GET /:token — signing context for the recipient ─────────────────────── */
router.get('/:token', safe(async (req, res) => {
  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'This signing link is invalid or has been removed.' });

  // Expiry check
  if (signing.expiry_date && new Date(signing.expiry_date) < new Date(new Date().toDateString())) {
    return res.status(410).json({ success: false, error: 'This signing request has expired.' });
  }
  if (['declined'].includes(signing.status)) {
    return res.status(410).json({ success: false, error: 'This signing request is no longer active.' });
  }

  // Sequential guard — only the current signer may proceed
  if ((signing.signing_mode === 'sequential') && signer) {
    const { rows: earlier } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM signature_signers
       WHERE signing_id = $1 AND signing_order < $2 AND status <> 'signed'`,
      [signing.id, signer.signing_order]
    );
    if (earlier[0].n > 0) {
      return res.status(423).json({ success: false, error: 'It is not your turn to sign yet. You will be notified when the previous signer completes.' });
    }
  }

  // Fields for this signer (or all, for legacy single)
  const { rows: fields } = signer
    ? await pool.query(`SELECT id, field_type, page, x_ratio, y_ratio, w_ratio, h_ratio, required, label, font_size, value, filled FROM signature_fields WHERE signing_id = $1 AND (signer_id = $2 OR signer_id IS NULL) ORDER BY page, id`, [signing.id, signer.id])
    : await pool.query(`SELECT id, field_type, page, x_ratio, y_ratio, w_ratio, h_ratio, required, label, font_size, value, filled FROM signature_fields WHERE signing_id = $1 ORDER BY page, id`, [signing.id]);

  await audit(signing.id, 'link_opened', req, signer?.signer_name || signing.recipient_name);

  res.json({
    success: true,
    data: {
      title: signing.title,
      doc_type: signing.doc_type,
      message: signing.message,
      status: signer ? signer.status : signing.status,
      already_signed: signer ? signer.status === 'signed' : signing.status === 'signed',
      has_source: !!signing.source_file_path,
      page_count: signing.page_count,
      require_otp: !!signing.require_otp,
      has_phone: !!signer?.signer_phone,
      allow_delegate: !!signer,
      payment_required: !!signing.payment_required,
      payment_status: signing.payment_status,
      payment_amount: signing.payment_amount != null ? Number(signing.payment_amount) : null,
      payment_currency: signing.payment_currency,
      payment_note: signing.payment_note,
      signer: publicSigner(signer) || { name: signing.recipient_name, email: signing.recipient_email },
      fields,
    },
  });
}));

/* ── GET /:token/source — stream the PDF to render in the browser ────────── */
router.get('/:token/source', safe(async (req, res) => {
  const { signing } = await resolve(req.params.token);
  if (!signing?.source_file_path) return res.status(404).json({ success: false, error: 'No document to display.' });
  const buf = esign.readFile(signing.source_file_path);
  if (!buf) return res.status(404).json({ success: false, error: 'Document file missing.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="document.pdf"`);
  res.send(buf);
}));

/* ── POST /:token/otp — email a one-time code ────────────────────────────── */
router.post('/:token/otp', otpSendLimit, safe(async (req, res) => {
  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (!signer) return res.status(400).json({ success: false, error: 'OTP verification is not available for this request.' });
  if (signer.status === 'signed') return res.status(409).json({ success: false, error: 'You have already signed.' });

  const channel = (req.body?.channel === 'sms' && signer.signer_phone) ? 'sms' : 'email';
  const otp = generateOtp();
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(
    `UPDATE signature_signers SET otp_code = $1, otp_expires_at = $2, otp_attempts = 0, otp_channel = $4, updated_at = NOW() WHERE id = $3`,
    [otp, expires, signer.id, channel]
  );

  let sent = false, dest = signer.signer_email;
  try {
    if (channel === 'sms') {
      dest = signer.signer_phone;
      const r = await sendSms(signer.signer_phone, `Your Pulse Sign verification code is ${otp}. It expires in 10 minutes.`);
      sent = r.sent;
    } else {
      const r = await sendSignerOtp(signer.signer_email, otp, { documentTitle: signing.title });
      sent = r.sent;
    }
  } catch (e) { console.error('[publicSign] otp send failed:', e.message); }

  await audit(signing.id, 'otp_sent', req, signer.signer_name, { channel, to: dest });
  res.json({ success: true, sent, channel, message: `A verification code was sent to ${dest}` });
}));

/* ── POST /:token/sign — apply signature + field values ──────────────────── */
router.post('/:token/sign', safe(async (req, res) => {
  const { otp, fields = [], signature_type = 'typed', signature_data, typed_name } = req.body;
  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (signing.is_locked) return res.status(409).json({ success: false, error: 'This document is already completed.' });

  // Payment gate — payment must be captured before signing can complete
  if (signing.payment_required && signing.payment_status !== 'paid') {
    return res.status(402).json({ success: false, error: 'payment_required', message: 'Please complete the required payment before signing.' });
  }

  // Validate signature payload
  if (signature_type === 'typed' && !typed_name?.trim()) {
    return res.status(400).json({ success: false, error: 'Please type your full name to sign.' });
  }
  if (['drawn', 'uploaded'].includes(signature_type) && !signature_data) {
    return res.status(400).json({ success: false, error: 'A drawn or uploaded signature is required.' });
  }

  // OTP enforcement
  if (signing.require_otp && signer) {
    if (!otp) return res.status(400).json({ success: false, error: 'Enter the verification code sent to your email.' });
    if (signer.otp_attempts >= 3) return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    if (signer.otp_code !== otp) {
      await pool.query(`UPDATE signature_signers SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [signer.id]);
      return res.status(401).json({ success: false, error: 'Incorrect verification code.' });
    }
    if (signer.otp_expires_at && new Date(signer.otp_expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Verification code expired. Request a new one.' });
    }
  }

  const sigValue = signature_type === 'typed' ? (typed_name || '').trim() : signature_data;
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  const ua = req.headers['user-agent'] || null;

  // Persist field values submitted by this signer
  for (const f of fields) {
    if (f.id == null) continue;
    let val = f.value;
    // Auto-fill signature/initials fields with the applied signature
    if ((f.field_type === 'signature' || f.field_type === 'initials') && (val == null || val === '')) val = sigValue;
    await pool.query(
      `UPDATE signature_fields SET value = $2, filled = TRUE, filled_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND signing_id = $3`,
      [f.id, val, signing.id]
    );
  }

  if (signer) {
    // Ensure this signer's signature fields carry the signature even if the client omitted them
    await pool.query(
      `UPDATE signature_fields SET value = COALESCE(NULLIF(value,''), $3), filled = TRUE, filled_at = NOW()
         WHERE signing_id = $1 AND signer_id = $2 AND field_type IN ('signature','initials')`,
      [signing.id, signer.id, sigValue]
    );

    await pool.query(
      `UPDATE signature_signers SET status = 'signed', signed_at = NOW(), signer_ip = $2, signer_ua = $3,
         signature_type = $4, signature_data = $5, typed_name = $6, otp_code = NULL, updated_at = NOW()
       WHERE id = $1`,
      [signer.id, ip, ua, signature_type, signature_type === 'typed' ? null : signature_data,
       signature_type === 'typed' ? typed_name.trim() : null]
    );

    const { rows: [counts] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='signed') AS signed, COUNT(*) AS total
         FROM signature_signers WHERE signing_id = $1`, [signing.id]
    );
    const allSigned = parseInt(counts.signed) >= parseInt(counts.total);

    await pool.query(
      `UPDATE document_signings SET signed_count = $2,
         status = CASE WHEN $3 THEN 'signed' ELSE status END,
         is_locked = CASE WHEN $3 THEN TRUE ELSE is_locked END,
         locked_at = CASE WHEN $3 THEN NOW() ELSE locked_at END,
         signed_date = CASE WHEN $3 THEN CURRENT_DATE ELSE signed_date END,
         updated_at = NOW()
       WHERE id = $1`,
      [signing.id, parseInt(counts.signed), allSigned]
    );

    await audit(signing.id, 'signed', req, signer.signer_name, { signature_type, all_signed: allSigned });
    emitEsignEvent(signing.id, 'signer.signed', { signer_email: signer.signer_email, all_signed: allSigned });

    if (allSigned) {
      try { await esign.finalizeSigning(signing.id); } catch (e) { console.error('[publicSign] finalize:', e.message); }
      emitEsignEvent(signing.id, 'request.completed', {});
    } else if (signing.signing_mode === 'sequential') {
      // Email the next pending signer in order
      const { rows: next } = await pool.query(
        `SELECT * FROM signature_signers WHERE signing_id = $1 AND status = 'pending' ORDER BY signing_order LIMIT 1`,
        [signing.id]
      );
      if (next[0]) {
        try {
          await sendSigningInvite(next[0].signer_email, {
            signerName: next[0].signer_name, documentTitle: signing.title,
            token: next[0].sign_token, message: signing.message, expiryDate: signing.expiry_date,
          });
          await pool.query(`UPDATE signature_signers SET status='otp_sent' WHERE id=$1`, [next[0].id]).catch(()=>{});
        } catch (e) { console.error('[publicSign] next-invite:', e.message); }
      }
    }

    return res.json({ success: true, all_signed: allSigned });
  }

  // Legacy single-recipient (no signer row)
  await pool.query(
    `UPDATE document_signings SET status = 'signed', signed_date = CURRENT_DATE,
       signature_type = $2, signature_data = $3, typed_name = $4, signer_ip = $5, signer_ua = $6,
       is_locked = TRUE, locked_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [signing.id, signature_type, signature_type === 'typed' ? null : signature_data,
     signature_type === 'typed' ? typed_name.trim() : null, ip, ua]
  );
  await audit(signing.id, 'signed', req, signing.recipient_name, { signature_type });
  emitEsignEvent(signing.id, 'signer.signed', { signer_email: signing.recipient_email, all_signed: true });
  try { await esign.finalizeSigning(signing.id); } catch (e) { console.error('[publicSign] finalize:', e.message); }
  emitEsignEvent(signing.id, 'request.completed', {});
  res.json({ success: true, all_signed: true });
}));

/* ── POST /:token/decline ────────────────────────────────────────────────── */
router.post('/:token/decline', safe(async (req, res) => {
  const { reason } = req.body;
  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (signing.is_locked) return res.status(409).json({ success: false, error: 'Document already completed.' });

  if (signer) {
    await pool.query(`UPDATE signature_signers SET status='declined', decline_reason=$2, updated_at=NOW() WHERE id=$1`,
      [signer.id, reason || 'Declined']);
  }
  await pool.query(`UPDATE document_signings SET status='declined', declined_reason=$2, updated_at=NOW() WHERE id=$1`,
    [signing.id, `${signer?.signer_name || signing.recipient_name || 'Signer'} declined: ${reason || ''}`]);

  await audit(signing.id, 'declined', req, signer?.signer_name || signing.recipient_name, { reason });
  emitEsignEvent(signing.id, 'request.declined', { by: signer?.signer_email || signing.recipient_email, reason });
  res.json({ success: true });
}));

/* ══════════════════════════════════════════════════════════════════════════
   DELEGATE — reassign this signer slot to someone else (new token + email)
   POST /sign/:token/delegate  { name, email, reason }
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:token/delegate', safe(async (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, error: 'Delegate name and email are required.' });

  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (!signer) return res.status(400).json({ success: false, error: 'This request cannot be delegated.' });
  if (signer.status === 'signed') return res.status(409).json({ success: false, error: 'You have already signed.' });

  const newToken = crypto.randomBytes(32).toString('hex');
  const { rows: [updated] } = await pool.query(
    `UPDATE signature_signers SET
       signer_name = $2, signer_email = $3, sign_token = $4,
       delegated_from_name = $5, delegated_from_email = $6, delegate_reason = $7, delegated_at = NOW(),
       status = 'otp_sent', otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [signer.id, name, email, newToken, signer.signer_name, signer.signer_email, reason || null]
  );

  let sent = false;
  try {
    const r = await sendSigningInvite(email, {
      signerName: name, documentTitle: signing.title, token: newToken,
      message: `Delegated to you by ${signer.signer_name}. ${signing.message || ''}`.trim(),
      expiryDate: signing.expiry_date,
    });
    sent = r.sent;
  } catch (e) { console.error('[publicSign] delegate invite:', e.message); }

  await audit(signing.id, 'delegated', req, signer.signer_name, { to: email, reason });
  emitEsignEvent(signing.id, 'signer.delegated', { from: signer.signer_email, to: email, reason });
  res.json({ success: true, sent, message: `Signing responsibility delegated to ${email}` });
}));

/* ══════════════════════════════════════════════════════════════════════════
   ATTACHMENTS — signer uploads supporting files
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:token/attachment', upload.single('file'), safe(async (req, res) => {
  const { signing, signer } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No file provided.' });

  const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().slice(0, 8);
  const { relPath } = esign.saveBuffer(req.file.buffer, ext);
  const { rows: [att] } = await pool.query(
    `INSERT INTO signature_attachments
       (signing_id, signer_id, file_path, file_name, mime, size_bytes, uploaded_by_name, uploader_ip, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, file_name, mime, size_bytes, created_at`,
    [signing.id, signer?.id || null, relPath, req.file.originalname, req.file.mimetype,
     req.file.size, signer?.signer_name || signing.recipient_name,
     req.ip || null, signing.company_id]
  );
  await audit(signing.id, 'attachment_added', req, signer?.signer_name || signing.recipient_name, { file: req.file.originalname });
  res.status(201).json({ success: true, data: att });
}));

router.get('/:token/attachments', safe(async (req, res) => {
  const { signing } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  const { rows } = await pool.query(
    `SELECT id, file_name, mime, size_bytes, created_at FROM signature_attachments WHERE signing_id = $1 ORDER BY created_at`,
    [signing.id]
  );
  res.json({ success: true, data: rows });
}));

/* ══════════════════════════════════════════════════════════════════════════
   PAYMENT-ON-SIGN — create a Razorpay order + verify (amount is server-fixed)
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/:token/payment/order', safe(async (req, res) => {
  const { signing } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (!signing.payment_required) return res.status(400).json({ success: false, error: 'No payment is required for this document.' });
  if (signing.payment_status === 'paid') return res.json({ success: true, already_paid: true });

  const amount = Number(signing.payment_amount || 0);
  if (amount <= 0) return res.status(400).json({ success: false, error: 'Invalid payment amount configured.' });

  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;

  // Dev simulation when gateway not configured
  if (!keyId || !keySecret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, error: 'payment_gateway_not_configured' });
    }
    const simId = `order_sim_${Date.now()}`;
    await pool.query(`UPDATE document_signings SET payment_order_id = $2, payment_status = 'pending' WHERE id = $1`, [signing.id, simId]);
    return res.json({ success: true, simulated: true, order_id: simId, amount: Math.round(amount * 100), currency: signing.payment_currency || 'INR', key_id: 'rzp_test_sim_key' });
  }

  try {
    const Razorpay = (await import('razorpay')).default;
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount: Math.round(amount * 100),
      currency: signing.payment_currency || 'INR',
      receipt: `SIGN-${signing.id}`,
      notes: { signing_id: String(signing.id) },
    });
    await pool.query(`UPDATE document_signings SET payment_order_id = $2, payment_status = 'pending' WHERE id = $1`, [signing.id, order.id]);
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}));

router.post('/:token/payment/verify', safe(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const { signing } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });

  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  // Dev simulation — accept without a real signature
  if (!keySecret) {
    if (process.env.NODE_ENV === 'production') return res.status(503).json({ success: false, error: 'payment_gateway_not_configured' });
    await pool.query(`UPDATE document_signings SET payment_status = 'paid', payment_ref = $2, updated_at = NOW() WHERE id = $1`,
      [signing.id, razorpay_payment_id || `pay_sim_${Date.now()}`]);
    await audit(signing.id, 'payment_captured', req, signing.recipient_name, { simulated: true });
    emitEsignEvent(signing.id, 'payment.captured', { simulated: true });
    return res.json({ success: true, simulated: true });
  }

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: 'order_id, payment_id and signature are required.' });
  }
  const expected = crypto.createHmac('sha256', keySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Payment signature verification failed.' });
  }

  await pool.query(`UPDATE document_signings SET payment_status = 'paid', payment_ref = $2, updated_at = NOW() WHERE id = $1`,
    [signing.id, razorpay_payment_id]);
  await audit(signing.id, 'payment_captured', req, signing.recipient_name, { payment_id: razorpay_payment_id });
  emitEsignEvent(signing.id, 'payment.captured', { payment_id: razorpay_payment_id });
  res.json({ success: true });
}));

/* ── GET /:token/signed-pdf — recipient downloads the completed document ──── */
router.get('/:token/signed-pdf', safe(async (req, res) => {
  const { signing } = await resolve(req.params.token);
  if (!signing) return res.status(404).json({ success: false, error: 'Invalid link.' });
  if (signing.status !== 'signed') return res.status(409).json({ success: false, error: 'Document is not fully signed yet.' });

  let relPath = signing.signed_pdf_path;
  if (!relPath) { const fin = await esign.finalizeSigning(signing.id); relPath = fin?.signed_pdf_path; }
  const buf = relPath ? esign.readFile(relPath) : null;
  if (!buf) return res.status(404).json({ success: false, error: 'Signed document not available.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="signed-document.pdf"`);
  res.send(buf);
}));

export default router;
