/**
 * esign.service.js — Native e-signature PDF engine (pdf-lib)
 *
 * Responsibilities:
 *   • Persist uploaded source documents to backend/uploads/esign/
 *   • Read PDF page count / dimensions
 *   • Stamp placed signature_fields onto the source PDF and flatten it
 *   • Generate a tamper-evident Certificate of Completion (audit trail)
 *   • Compute a SHA-256 hash of the final signed PDF
 *
 * Field coordinates are stored as 0..1 ratios relative to each page, with the
 * origin at the TOP-LEFT (browser convention). pdf-lib uses a BOTTOM-LEFT
 * origin, so the y-axis is flipped here during stamping.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import pool from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// backend/src/services → backend/uploads/esign
export const ESIGN_DIR = path.resolve(__dirname, '../../uploads/esign');

function ensureDir() {
  if (!fs.existsSync(ESIGN_DIR)) fs.mkdirSync(ESIGN_DIR, { recursive: true });
}

/** Resolve a DB-relative path ("esign/xyz.pdf") to an absolute disk path. */
export function absPath(relPath) {
  if (!relPath) return null;
  // Stored relative to backend/uploads
  return path.resolve(ESIGN_DIR, '..', relPath);
}

/** Persist a buffer to backend/uploads/esign and return { relPath, absPath }. */
export function saveBuffer(buffer, ext = 'pdf') {
  ensureDir();
  const name    = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const rel     = path.posix.join('esign', name);
  const abs     = path.join(ESIGN_DIR, name);
  fs.writeFileSync(abs, buffer);
  return { relPath: rel, absPath: abs };
}

export function readFile(relPath) {
  const abs = absPath(relPath);
  if (!abs || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Load a PDF buffer and return page count (0 if not a readable PDF). */
export async function pdfPageCount(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return 0;
  }
}

// ── Signature rendering helpers ────────────────────────────────────────────

const isDataUrl = v => typeof v === 'string' && v.startsWith('data:image');

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1] || '';
  return Buffer.from(b64, 'base64');
}

async function embedSignatureImage(pdfDoc, dataUrl) {
  const bytes = dataUrlToBytes(dataUrl);
  if (dataUrl.includes('image/png'))  return pdfDoc.embedPng(bytes);
  if (dataUrl.includes('image/jpeg') || dataUrl.includes('image/jpg')) return pdfDoc.embedJpg(bytes);
  // Fallback attempt as PNG
  return pdfDoc.embedPng(bytes);
}

/**
 * Generate the signed PDF for a completed signing request.
 * Stamps every filled signature_field onto the source document.
 *
 * Returns { relPath, hash, bytes } or null if there is no source document.
 */
export async function generateSignedPdf(signingId) {
  const { rows: sRows } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [signingId]
  );
  const signing = sRows[0];
  if (!signing || !signing.source_file_path) return null;

  const srcBuf = readFile(signing.source_file_path);
  if (!srcBuf) return null;

  const pdfDoc = await PDFDocument.load(srcBuf, { ignoreEncryption: true });
  const pages  = pdfDoc.getPages();
  const helv   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const script = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const { rows: fields } = await pool.query(
    `SELECT sf.*, ss.signer_name, ss.typed_name AS signer_typed
       FROM signature_fields sf
       LEFT JOIN signature_signers ss ON ss.id = sf.signer_id
      WHERE sf.signing_id = $1
      ORDER BY sf.page, sf.id`,
    [signingId]
  );

  for (const f of fields) {
    const pageIdx = Math.max(0, (f.page || 1) - 1);
    const page = pages[pageIdx];
    if (!page) continue;

    const { width: pw, height: ph } = page.getSize();
    const fw = Number(f.w_ratio) * pw;
    const fh = Number(f.h_ratio) * ph;
    const x  = Number(f.x_ratio) * pw;
    // Flip Y: browser top-origin → pdf bottom-origin
    const yTop = Number(f.y_ratio) * ph;
    const y    = ph - yTop - fh;

    const value = f.value;
    if (value == null || value === '') continue;

    try {
      if ((f.field_type === 'signature' || f.field_type === 'initials') && isDataUrl(value)) {
        const img = await embedSignatureImage(pdfDoc, value);
        // Fit image into the field box preserving aspect ratio
        const scale = Math.min(fw / img.width, fh / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        page.drawImage(img, { x, y: y + (fh - dh) / 2, width: dw, height: dh });
      } else if (f.field_type === 'checkbox') {
        const checked = value === 'true' || value === true || value === '1' || value === 'on';
        page.drawText(checked ? 'X' : '', {
          x: x + 2, y: y + 2, size: Math.min(fh, 16), font: helv, color: rgb(0.1, 0.1, 0.1),
        });
      } else {
        // Typed signature / initials use a script font; everything else Helvetica
        const font = (f.field_type === 'signature' || f.field_type === 'initials') ? script : helv;
        const size = Math.min(Number(f.font_size) || 12, fh > 0 ? fh * 0.8 : 12);
        page.drawText(String(value), {
          x: x + 1, y: y + Math.max(2, (fh - size) / 2), size, font, color: rgb(0.06, 0.06, 0.2),
        });
      }
    } catch (e) {
      // Never let one bad field abort the whole document
      console.error(`[esign] field ${f.id} stamp failed:`, e.message);
    }
  }

  // Footer verification stamp on the last page
  const last = pages[pages.length - 1];
  if (last) {
    const { width } = last.getSize();
    last.drawText(`Digitally signed via Pulse ERP · ${new Date().toISOString().slice(0, 10)} · Verify with completion certificate`, {
      x: 24, y: 12, size: 7, font: helv, color: rgb(0.5, 0.5, 0.5), maxWidth: width - 48,
    });
  }

  const outBytes = await pdfDoc.save();
  const buf  = Buffer.from(outBytes);
  const hash = sha256(buf);
  const { relPath } = saveBuffer(buf, 'pdf');
  return { relPath, hash, bytes: buf };
}

/**
 * Build a Certificate of Completion PDF for a signing request.
 * Includes the document hash, every signer's details, and the audit trail.
 */
export async function generateCertificate(signingId, documentHash) {
  const { rows: sRows } = await pool.query(
    `SELECT * FROM document_signings WHERE id = $1`, [signingId]
  );
  const signing = sRows[0];
  if (!signing) return null;

  const { rows: signers } = await pool.query(
    `SELECT * FROM signature_signers WHERE signing_id = $1 ORDER BY signing_order, id`, [signingId]
  );
  const { rows: audit } = await pool.query(
    `SELECT * FROM signature_audit_log WHERE signing_id = $1 ORDER BY occurred_at ASC`, [signingId]
  );

  const pdf  = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([595, 842]); // A4
  const M = 48;
  let y = 842 - M;
  const purple = rgb(0.486, 0.227, 0.929);
  const gray   = rgb(0.42, 0.45, 0.5);
  const dark   = rgb(0.12, 0.13, 0.16);

  const line = (text, { size = 10, font = helv, color = dark, gap = 6, x = M } = {}) => {
    if (y < M + 40) { page = pdf.addPage([595, 842]); y = 842 - M; }
    page.drawText(String(text ?? ''), { x, y, size, font, color, maxWidth: 595 - M * 2 });
    y -= size + gap;
  };

  page.drawText('Certificate of Completion', { x: M, y, size: 22, font: bold, color: purple });
  y -= 34;
  line('Pulse ERP — Native Digital Signature Engine', { size: 10, color: gray, gap: 14 });

  line('Document', { size: 12, font: bold, gap: 8 });
  line(`Title:        ${signing.title}`);
  line(`Type:         ${signing.doc_type || '—'}`);
  line(`Request ID:   #${signing.id}`);
  line(`Status:       ${signing.status}`);
  line(`Created:      ${signing.created_at ? new Date(signing.created_at).toISOString() : '—'}`);
  line(`Completed:    ${signing.completed_at ? new Date(signing.completed_at).toISOString() : new Date().toISOString()}`, { gap: 12 });

  line('Tamper-Evident Hash (SHA-256 of signed PDF)', { size: 12, font: bold, gap: 8 });
  const h = documentHash || signing.document_hash || '(pending)';
  line(h.replace(/(.{64})/g, '$1'), { size: 8, font: helv, color: gray, gap: 14 });

  line('Signers', { size: 12, font: bold, gap: 8 });
  if (signers.length === 0) {
    line('Single recipient:', { size: 10, font: bold, gap: 4 });
    line(`${signing.recipient_name || '—'} <${signing.recipient_email || '—'}>`);
    line(`Status: ${signing.status} · Signed: ${signing.signed_date || '—'} · IP: ${signing.signer_ip || '—'}`, { gap: 12 });
  } else {
    for (const s of signers) {
      line(`#${s.signing_order}  ${s.signer_name} <${s.signer_email}>  [${s.role}]`, { size: 10, font: bold, gap: 4 });
      line(`Status: ${s.status} · Signed: ${s.signed_at ? new Date(s.signed_at).toISOString() : '—'}`, { size: 9, color: gray, gap: 3 });
      line(`Method: ${s.signature_type || '—'} · IP: ${s.signer_ip || '—'}`, { size: 9, color: gray, gap: 10 });
    }
  }

  y -= 4;
  line('Audit Trail', { size: 12, font: bold, gap: 8 });
  if (audit.length === 0) {
    line('No audit events recorded.', { size: 9, color: gray });
  } else {
    for (const e of audit) {
      const when = e.occurred_at ? new Date(e.occurred_at).toISOString() : '—';
      line(`${when}  ·  ${e.event}  ·  ${e.actor_name || 'system'}  ${e.actor_ip ? '· IP ' + e.actor_ip : ''}`,
        { size: 8, color: gray, gap: 3 });
    }
  }

  // Watermark
  page.drawText('VERIFIED', {
    x: 150, y: 300, size: 90, font: bold, color: rgb(0.95, 0.93, 1), rotate: degrees(45),
  });

  const bytes = await pdf.save();
  const buf   = Buffer.from(bytes);
  const { relPath } = saveBuffer(buf, 'pdf');
  return { relPath, bytes: buf };
}

/**
 * Finalize a signing: generate signed PDF + certificate, persist paths + hash.
 * Safe to call when there is no source document (returns { skipped:true }).
 */
export async function finalizeSigning(signingId) {
  const signed = await generateSignedPdf(signingId);
  if (!signed) {
    await pool.query(
      `UPDATE document_signings SET completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [signingId]
    );
    return { skipped: true };
  }
  const cert = await generateCertificate(signingId, signed.hash);
  await pool.query(
    `UPDATE document_signings
       SET signed_pdf_path = $2,
           signed_pdf_url  = $3,
           certificate_path = $4,
           document_hash   = $5,
           completed_at    = NOW(),
           updated_at      = NOW()
     WHERE id = $1`,
    [signingId, signed.relPath, `/api/signatures/${signingId}/signed-pdf`, cert?.relPath || null, signed.hash]
  );
  return { signed_pdf_path: signed.relPath, certificate_path: cert?.relPath, hash: signed.hash };
}
