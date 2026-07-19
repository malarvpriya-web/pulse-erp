/**
 * publicQr.routes.js — Public (no-login) QR resolution surface
 *
 * Mounted at /api/v1/q WITHOUT verifyToken (same pattern as /sign and
 * /customer-portal). The QR image encodes /api/v1/q/:token; a customer scans
 * it with a phone camera and lands here. Every hit is recorded, then:
 *   file  → streamed inline (?dl=1 forces download)
 *   url   → 302 redirect
 *   text  → minimal branded HTML page
 *   vcard → .vcf download (phone offers "Add contact")
 *
 * Responses are HTML-friendly because the client is a phone browser, not the app.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import pool from '../shared/db.js';
import { QRSHARE_DIR } from './qrshare.routes.js';

const router = Router();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f8f9fc;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #e9e4ff;border-radius:16px;padding:32px;max-width:520px;width:100%;box-shadow:0 8px 24px rgba(107,63,219,.08)}
  h1{font-size:18px;color:#1f2937;margin:0 0 12px}
  p{color:#4b5563;font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0}
  .brand{color:#6B3FDB;font-weight:800;font-size:13px;letter-spacing:.4px;margin-bottom:16px}
</style></head>
<body><div class="card"><div class="brand">PULSE</div><h1>${esc(title)}</h1>${body}</div></body></html>`;

const errPage = (res, status, msg) =>
  res.status(status).type('html').send(page('QR Code Unavailable', `<p>${esc(msg)}</p>`));

function buildVcf(v) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${v.name || ''}`];
  if (v.name) {
    const parts = String(v.name).trim().split(/\s+/);
    lines.push(`N:${parts.length > 1 ? parts.slice(-1)[0] : ''};${parts[0] || ''};;;`);
  }
  if (v.designation) lines.push(`TITLE:${v.designation}`);
  if (v.organization) lines.push(`ORG:${v.organization}`);
  if (v.phone) lines.push(`TEL;TYPE=CELL:${v.phone}`);
  if (v.email) lines.push(`EMAIL:${v.email}`);
  if (v.website) lines.push(`URL:${v.website}`);
  if (v.address) lines.push(`ADR;TYPE=WORK:;;${String(v.address).replace(/\n/g, ' ')};;;;`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

router.get('/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM qr_share_codes WHERE share_token = $1 LIMIT 1`,
      [req.params.token]
    );
    const qr = rows[0];
    if (!qr || !qr.is_active) return errPage(res, 404, 'This QR code is invalid or has been deactivated.');
    if (qr.expires_at && new Date(qr.expires_at) < new Date())
      return errPage(res, 410, 'This QR code has expired. Please request a new one.');

    // Track the scan (best-effort — never block delivery on analytics)
    try {
      await pool.query(
        `INSERT INTO qr_share_scans (qr_id, ip, user_agent) VALUES ($1,$2,$3)`,
        [qr.id, (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 64),
         (req.headers['user-agent'] || '').slice(0, 500)]
      );
      await pool.query(
        `UPDATE qr_share_codes SET scan_count = scan_count + 1, last_scanned_at = NOW() WHERE id = $1`,
        [qr.id]
      );
    } catch { /* analytics only */ }

    if (qr.qr_type === 'url') return res.redirect(302, qr.target_url);

    if (qr.qr_type === 'text')
      return res.type('html').send(page(qr.title, `<p>${esc(qr.content_text)}</p>`));

    if (qr.qr_type === 'vcard') {
      const v = typeof qr.vcard === 'string' ? JSON.parse(qr.vcard) : (qr.vcard || {});
      const vcf = buildVcf(v);
      res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${(v.name || 'contact').replace(/[^\w .-]/g, '_')}.vcf"`);
      return res.send(vcf);
    }

    // file
    const abs = path.resolve(QRSHARE_DIR, '..', qr.file_path || '');
    if (!qr.file_path || !abs.startsWith(path.resolve(QRSHARE_DIR, '..')) || !fs.existsSync(abs))
      return errPage(res, 404, 'The shared file is no longer available.');

    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', qr.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `${disposition}; filename="${(qr.file_name || 'document').replace(/[^\w .()-]/g, '_')}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    console.error('[publicQr]', e.message);
    errPage(res, 500, 'Something went wrong. Please try again.');
  }
});

export default router;
