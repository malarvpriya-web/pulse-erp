/**
 * documentDownload.js — turn the link HR/admin stored for a Home document
 * (Policies, Brand Vault) into the file itself.
 *
 * Why the server does this instead of the browser following the link:
 *   - A Drive share link (…/file/d/ID/view) opens Drive's viewer, not the file.
 *   - Rewriting it to uc?export=download (what Home.jsx used to do) only works
 *     for files shared "Anyone with the link". For an org-restricted file it
 *     ends on Google's sign-in page, and the browser saves or shows that HTML
 *     as if it were the policy.
 *   - Google-native Docs/Sheets/Slides have no file to download until exported.
 *
 * Resolution order for a Drive link:
 *   1. The Drive API through the service account, when it is configured
 *      (GOOGLE_DRIVE_SERVICE_ACCOUNT_*). This is the path for the designated HR
 *      folder: share that folder with the service account and every file in it
 *      downloads with no per-file sharing change.
 *   2. Google's link-shared download endpoint, for files shared with
 *      "Anyone with the link". A response that is HTML or that landed on
 *      accounts.google.com means the file is not shared that way; it is
 *      reported as NOT_SHARED, never passed on as the document.
 *
 * A link that is not Google Drive is classified 'link' and opened by the
 * browser as an ordinary page: the server never fetches arbitrary URLs.
 */
import { Readable } from 'node:stream';
import * as drive from '../services/googleDrive.service.js';

// Overridable so tests can stand in for Google without network access.
export const DRIVE_PUBLIC = {
  content: 'https://drive.usercontent.google.com',
  docs:    'https://docs.google.com',
};

const NATIVE_FORMATS = {
  document:     ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  spreadsheets: ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  presentation: ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

const EXT_BY_TYPE = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/msword': 'doc',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.ms-excel': 'xls',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  ...Object.fromEntries(Object.values(NATIVE_FORMATS).map(([ext, type]) => [type, ext])),
};

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']);
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

export class DocumentDownloadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** { kind: 'file' | 'document' | 'spreadsheets' | 'presentation', id } or null. */
export function parseDriveRef(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!DRIVE_HOSTS.has(host)) return null;
  const native = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/);
  if (host === 'docs.google.com' && native && ID_RE.test(native[2])) return { kind: native[1], id: native[2] };
  const file = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
  const id = file?.[1] ?? (u.pathname.includes('/folders/') ? null : u.searchParams.get('id'));
  return id && ID_RE.test(id) ? { kind: 'file', id } : null;
}

const hostOf = (url) => {
  try { return new URL(String(url ?? '').trim()).hostname.toLowerCase(); } catch { return ''; }
};
const isGoogleHost = (url) => DRIVE_HOSTS.has(hostOf(url));
const isHttpUrl = (url) => /^https?:\/\//i.test(String(url ?? '').trim());

/**
 * How Home offers a stored link:
 *   'file' — Pulse streams the file (Drive file or Google doc)
 *   'link' — an external web page, opened in a new tab
 *   null   — nothing usable is linked (empty, '#', a relative path, a folder)
 */
export function classifySource(url) {
  const s = String(url ?? '').trim();
  if (!s || s === '#') return null;
  if (parseDriveRef(s)) return 'file';
  if (isGoogleHost(s)) return null;           // a Drive folder or a non-file Google page
  return isHttpUrl(s) ? 'link' : null;
}

/**
 * Validation for the editors that store these links. Returns an error message
 * or null. A Drive folder link is refused: Home would have nothing to download.
 */
export function validateDocumentUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return 'A file link is required.';
  if (!isHttpUrl(s)) return 'The link must start with https://';
  if (isGoogleHost(s) && !parseDriveRef(s)) {
    return 'Paste the link to the file itself, not a Drive folder. In Drive: right-click the file → Share → Copy link.';
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;
const clean = (s) => String(s || '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();

export function safeFilename(name, contentType, fallbackTitle = 'document') {
  let base = clean(name) || clean(fallbackTitle) || 'document';
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type];
  if (ext && !/\.[A-Za-z0-9]{2,5}$/.test(base)) base = `${base}.${ext}`;
  return base.slice(0, 180);
}

/** RFC 6266: an ASCII fallback plus the UTF-8 name. */
export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function filenameFromHeader(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* use the plain name */ }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

async function viaServiceAccount(ref) {
  const f = await drive.openFileStream(ref.id);
  return { stream: f.stream, filename: f.name, contentType: f.mimeType, size: f.size };
}

async function viaSharedLink(ref, fetchImpl) {
  const url = ref.kind === 'file'
    ? `${DRIVE_PUBLIC.content}/download?id=${encodeURIComponent(ref.id)}&export=download&confirm=t`
    : `${DRIVE_PUBLIC.docs}/${ref.kind}/d/${encodeURIComponent(ref.id)}/export?format=${NATIVE_FORMATS[ref.kind][0]}`;
  let resp;
  try {
    resp = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new DocumentDownloadError('UPSTREAM',
      `Could not reach Google Drive (${e?.name === 'TimeoutError' ? 'timed out' : e?.message}).`);
  }
  const type = resp.headers.get('content-type') || '';
  const landedOnSignIn = /(^|\.)accounts\.google\.com$/.test(hostOf(resp.url));
  if (resp.status === 404) {
    await resp.body?.cancel?.();
    throw new DocumentDownloadError('DRIVE_NOT_FOUND', 'The linked file no longer exists in Google Drive.');
  }
  if (!resp.ok || landedOnSignIn || /text\/html/i.test(type)) {
    await resp.body?.cancel?.();
    throw new DocumentDownloadError('NOT_SHARED',
      'This file is not shared for download. In Google Drive, share it as "Anyone with the link — Viewer" '
      + '(or share the policy folder with the Pulse service account).');
  }
  const len = Number(resp.headers.get('content-length'));
  return {
    stream: Readable.fromWeb(resp.body),
    filename: filenameFromHeader(resp.headers.get('content-disposition')),
    contentType: type.split(';')[0].trim() || 'application/octet-stream',
    size: Number.isFinite(len) && len > 0 ? len : null,
  };
}

/**
 * Resolve a stored link to { stream, filename, contentType, size }.
 * Throws DocumentDownloadError with code NO_FILE | DRIVE_NOT_FOUND |
 * NOT_SHARED | UPSTREAM.
 */
export async function openDocument(url, { title, fetchImpl = globalThis.fetch } = {}) {
  const ref = parseDriveRef(url);
  if (!ref) throw new DocumentDownloadError('NO_FILE', 'This document is not linked to a downloadable file yet.');

  let file = null;
  if (drive.isDriveConfigured()) {
    try {
      file = await viaServiceAccount(ref);
    } catch (e) {
      const code = Number(e?.code ?? e?.response?.status);
      // 403/404: the service account cannot see this file. It may still be
      // link-shared, so try that before giving up.
      if (code !== 403 && code !== 404) {
        console.error('[home.documents] Drive API failed:', code || '', e?.message);
        throw new DocumentDownloadError('UPSTREAM', 'Google Drive returned an error. Please try again.');
      }
    }
  }
  if (!file) file = await viaSharedLink(ref, fetchImpl);

  return { ...file, filename: safeFilename(file.filename, file.contentType, title) };
}
