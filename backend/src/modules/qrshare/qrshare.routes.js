/**
 * qrshare.routes.js — QR Share Studio (authenticated surface)
 *
 * Staff create QR codes that point at a public tokenized URL (/api/v1/q/:token)
 * so a file / link / text / visiting-card can be shared with customers and
 * consultants WITHOUT sending the file itself. Every scan is tracked.
 *
 * NOT related to qr_attendance_* (site clock-in QRs) — different tables/routes.
 *
 * Mounted at /api/v1/qr-codes with verifyToken in server.js.
 *   POST   /              create (multipart when qr_type=file)
 *   GET    /mine          caller's own QR codes
 *   GET    /all           company-wide list        (super_admin/admin/hr/manager)
 *   GET    /stats         per-employee analytics   (super_admin/admin/hr/manager)
 *   GET    /:id/scans     scan log (owner or admin roles)
 *   PATCH  /:id/toggle    activate / deactivate (owner or admin roles)
 *   DELETE /:id           delete record + stored file (owner or admin roles)
 */

import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/modules/qrshare → backend/uploads/qrshare
export const QRSHARE_DIR = path.resolve(__dirname, '../../../uploads/qrshare');

const ADMIN_ROLES = ['super_admin', 'admin', 'hr', 'manager'];
const isAdminRole = req => ADMIN_ROLES.includes(String(req.user?.role || '').toLowerCase());
const userId = req => req.user?.userId ?? req.user?.id ?? null;

const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error('[qrshare]', e.message); res.status(500).json({ success: false, error: e.message }); }
};

const TYPES = new Set(['file', 'url', 'text', 'vcard']);
const RECIPIENT_TYPES = new Set(['customer', 'consultant', 'vendor', 'partner', 'internal', 'other']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

function saveFile(buffer, originalName) {
  if (!fs.existsSync(QRSHARE_DIR)) fs.mkdirSync(QRSHARE_DIR, { recursive: true });
  const ext  = (path.extname(originalName || '') || '.bin').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(QRSHARE_DIR, name), buffer);
  return path.posix.join('qrshare', name); // stored relative to backend/uploads
}

/* ── CREATE ──────────────────────────────────────────────────────────────── */
router.post('/', upload.single('file'), safe(async (req, res) => {
  const {
    title, qr_type = 'file', target_url, content_text, vcard,
    recipient_name, recipient_type = 'customer',
    fg_color = '#000000', bg_color = '#FFFFFF', with_logo = 'false',
    expires_at,
  } = req.body;

  if (!title?.trim()) return res.status(400).json({ success: false, error: 'Title is required' });
  if (!TYPES.has(qr_type)) return res.status(400).json({ success: false, error: 'Invalid QR type' });
  if (!HEX_COLOR.test(fg_color) || !HEX_COLOR.test(bg_color))
    return res.status(400).json({ success: false, error: 'Colors must be hex like #6B3FDB' });
  const recType = RECIPIENT_TYPES.has(recipient_type) ? recipient_type : 'other';

  let filePath = null, fileName = null, fileMime = null, fileSize = null;
  let vcardJson = null;

  if (qr_type === 'file') {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    filePath = saveFile(req.file.buffer, req.file.originalname);
    fileName = req.file.originalname;
    fileMime = req.file.mimetype || 'application/octet-stream';
    fileSize = req.file.size;
  } else if (qr_type === 'url') {
    if (!/^https?:\/\/.+/i.test(target_url || '')) return res.status(400).json({ success: false, error: 'A valid http(s) URL is required' });
  } else if (qr_type === 'text') {
    if (!content_text?.trim()) return res.status(400).json({ success: false, error: 'Text content is required' });
  } else if (qr_type === 'vcard') {
    try { vcardJson = typeof vcard === 'string' ? JSON.parse(vcard) : vcard; } catch { /* handled below */ }
    if (!vcardJson?.name?.trim()) return res.status(400).json({ success: false, error: 'Visiting card needs at least a name' });
  }

  const token = crypto.randomBytes(20).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO qr_share_codes
       (company_id, created_by, title, qr_type, share_token,
        file_path, file_name, file_mime, file_size_bytes,
        target_url, content_text, vcard,
        recipient_name, recipient_type, fg_color, bg_color, with_logo, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [req.scope?.company_id ?? null, userId(req), title.trim(), qr_type, token,
     filePath, fileName, fileMime, fileSize,
     qr_type === 'url' ? target_url.trim() : null,
     qr_type === 'text' ? content_text.trim() : null,
     vcardJson ? JSON.stringify(vcardJson) : null,
     recipient_name?.trim() || null, recType, fg_color, bg_color,
     String(with_logo) === 'true', expires_at || null]
  );
  res.status(201).json({ success: true, data: rows[0] });
}));

/* ── MY QR CODES ─────────────────────────────────────────────────────────── */
router.get('/mine', safe(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM qr_share_codes WHERE created_by = $1 ORDER BY created_at DESC LIMIT 200`,
    [userId(req)]
  );
  res.json({ success: true, data: rows });
}));

/* ── ALL (admin surface) ─────────────────────────────────────────────────── */
router.get('/all', allowRoles(...ADMIN_ROLES), safe(async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  // NULL-company rows stay visible to scoped admins (legacy-row gotcha)
  const { rows } = await pool.query(
    `SELECT q.*, COALESCE(u.name, u.email) AS creator_name, e.office_id AS creator_office_id
       FROM qr_share_codes q
       LEFT JOIN users u     ON u.id = q.created_by
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE ($1::int IS NULL OR q.company_id = $1 OR q.company_id IS NULL)
      ORDER BY q.created_at DESC LIMIT 500`,
    [cid]
  );
  res.json({ success: true, data: rows });
}));

/* ── STATS (admin analytics) ─────────────────────────────────────────────── */
router.get('/stats', allowRoles(...ADMIN_ROLES), safe(async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  const scopeSql = `($1::int IS NULL OR q.company_id = $1 OR q.company_id IS NULL)`;

  const [totals, byCreator, byType, topScanned] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_codes,
              COUNT(*) FILTER (WHERE q.is_active)::int AS active_codes,
              COALESCE(SUM(q.scan_count),0)::int AS total_scans,
              COUNT(DISTINCT q.created_by)::int AS creators
         FROM qr_share_codes q WHERE ${scopeSql}`, [cid]),
    pool.query(
      `SELECT q.created_by, COALESCE(u.name, u.email) AS creator_name,
              e.office_id AS creator_office_id,
              COUNT(*)::int AS codes, COALESCE(SUM(q.scan_count),0)::int AS scans
         FROM qr_share_codes q
         LEFT JOIN users u     ON u.id = q.created_by
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE ${scopeSql}
        GROUP BY q.created_by, u.name, u.email, e.office_id
        ORDER BY codes DESC LIMIT 50`, [cid]),
    pool.query(
      `SELECT q.qr_type, COUNT(*)::int AS codes
         FROM qr_share_codes q WHERE ${scopeSql} GROUP BY q.qr_type`, [cid]),
    pool.query(
      `SELECT q.id, q.title, q.qr_type, q.scan_count, q.last_scanned_at,
              COALESCE(u.name, u.email) AS creator_name
         FROM qr_share_codes q
         LEFT JOIN users u ON u.id = q.created_by
        WHERE ${scopeSql} AND q.scan_count > 0
        ORDER BY q.scan_count DESC LIMIT 10`, [cid]),
  ]);

  res.json({
    success: true,
    data: {
      totals: totals.rows[0],
      by_creator: byCreator.rows,
      by_type: byType.rows,
      top_scanned: topScanned.rows,
    },
  });
}));

/* ── Ownership guard for row-level actions ───────────────────────────────── */
async function loadOwned(req, res) {
  const { rows } = await pool.query(`SELECT * FROM qr_share_codes WHERE id = $1`, [parseInt(req.params.id)]);
  const row = rows[0];
  if (!row) { res.status(404).json({ success: false, error: 'QR code not found' }); return null; }
  if (row.created_by !== userId(req) && !isAdminRole(req)) {
    res.status(403).json({ success: false, error: 'Not your QR code' }); return null;
  }
  return row;
}

/* ── SCAN LOG ────────────────────────────────────────────────────────────── */
router.get('/:id/scans', safe(async (req, res) => {
  const row = await loadOwned(req, res);
  if (!row) return;
  const { rows } = await pool.query(
    `SELECT id, scanned_at, ip, user_agent FROM qr_share_scans
      WHERE qr_id = $1 ORDER BY scanned_at DESC LIMIT 200`, [row.id]
  );
  res.json({ success: true, data: rows });
}));

/* ── ACTIVATE / DEACTIVATE ───────────────────────────────────────────────── */
router.patch('/:id/toggle', safe(async (req, res) => {
  const row = await loadOwned(req, res);
  if (!row) return;
  const { rows } = await pool.query(
    `UPDATE qr_share_codes SET is_active = NOT is_active WHERE id = $1 RETURNING *`, [row.id]
  );
  res.json({ success: true, data: rows[0] });
}));

/* ── DELETE ──────────────────────────────────────────────────────────────── */
router.delete('/:id', safe(async (req, res) => {
  const row = await loadOwned(req, res);
  if (!row) return;
  await pool.query(`DELETE FROM qr_share_codes WHERE id = $1`, [row.id]);
  if (row.file_path) {
    const abs = path.resolve(QRSHARE_DIR, '..', row.file_path);
    // Only unlink inside the uploads dir — never follow a stored path elsewhere
    if (abs.startsWith(path.resolve(QRSHARE_DIR, '..')) && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch { /* best-effort */ }
    }
  }
  res.json({ success: true, message: 'QR code deleted' });
}));

export default router;
