import api from '@/services/api/client';

/**
 * Employee file access.
 *
 * Employee photos and compliance documents are stored by StorageService as
 * '/uploads/<name>' and served by exactly ONE route: `GET /files/:filename`,
 * which requires the JWT and audit-logs the read. The public `/uploads` static
 * mount was deliberately removed (see server.js).
 *
 * The profile page used to build `${VITE_API_URL without '/api'}${stored_path}`
 * and hand it to window.open — a URL nothing serves (verified: plain 404) and
 * which could not carry an Authorization header even if something did. Every
 * "View →" tile on the Documents tab was dead in the same two ways the Resume
 * Database's links once were, so this mirrors the fix that module already
 * shipped (features/recruitment/shared/resumeDownload.js).
 */

/**
 * The employee-record file columns, in the order Add Employee presents them.
 *
 * ONE list, exported, so the Documents tab and anything else that enumerates an
 * employee's attachments cannot drift from the fields that page actually
 * writes. The tab used to carry its own inline copy, which is how it could
 * render a "no compliance documents" empty state for an employee who had them.
 */
export const EMPLOYEE_DOC_FIELDS = [
  { key: 'photo_url',             label: 'Photo',            icon: '📷' },
  { key: 'pan_file',              label: 'PAN Card',         icon: '🪪' },
  { key: 'aadhaar_file',          label: 'Aadhaar',          icon: '🪪' },
  { key: 'cancelled_cheque_file', label: 'Cancelled Cheque', icon: '🏦' },
  { key: 'bank_statement_file',   label: 'Bank Statement',   icon: '📊' },
  { key: 'resume_file',           label: 'Resume',           icon: '📄' },
  { key: 'offer_letter_file',     label: 'Offer Letter',     icon: '📋' },
];

/**
 * '/uploads/1772020686985_photo.jpeg' → '1772020686985_photo.jpeg'
 *
 * Only the last path segment is ever used, and callers encode it with
 * encodeURIComponent, so a stored value cannot add path segments or a query.
 * '.' and '..' name no file — and survive encoding, where a client normalising
 * '/files/..' would request another route — so they are refused.
 */
export function storedFilename(storedPath) {
  const name = String(storedPath || '').split(/[/\\]/).pop();
  if (!name || name === '.' || name === '..') return null;
  return name;
}

/** Is this a real external link (Google Drive etc.) rather than a stored file? */
export function isExternalUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function describe(e) {
  if (e?.response?.status === 403) return 'You do not have permission to open this file.';
  if (e?.response?.status === 404) return 'That file is missing from storage.';
  return e?.response?.data?.error || e?.message || 'Could not open the file.';
}

/**
 * Open an employee document in a new tab (PDFs and images render inline; the
 * backend keeps everything else as an attachment).
 *
 * @returns {Promise<string|null>} an error message, or null on success.
 */
export async function openEmployeeFile(storedPath) {
  if (isExternalUrl(storedPath)) {
    window.open(storedPath, '_blank', 'noopener,noreferrer');
    return null;
  }
  const filename = storedFilename(storedPath);
  if (!filename) return 'This record has no file attached.';

  try {
    const resp = await api.get(`/files/${encodeURIComponent(filename)}?disposition=inline`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(resp.data);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    // The object URL backs the new tab's document, so it cannot be revoked
    // immediately — that would blank the tab. A generous timeout releases it
    // once the browser has read the bytes. If the popup was blocked there is no
    // tab to keep alive, so release it at once and say so.
    if (!win) { URL.revokeObjectURL(url); return 'Your browser blocked the file window. Allow pop-ups for this site.'; }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (e) {
    return describe(e);
  }
}

/**
 * Save an employee document to disk.
 *
 * The same authenticated route as openEmployeeFile, WITHOUT
 * `?disposition=inline`, so the backend sends `Content-Disposition: attachment`
 * and records the read as a download rather than a view. Those are deliberately
 * different actions in the audit log: reading a document on screen and taking a
 * copy of it are not the same act.
 *
 * @returns {Promise<string|null>} an error message, or null on success.
 */
export async function downloadEmployeeFile(storedPath) {
  if (isExternalUrl(storedPath)) {
    // Nothing of ours to stream: an external link is another system's page.
    window.open(storedPath, '_blank', 'noopener,noreferrer');
    return null;
  }
  const filename = storedFilename(storedPath);
  if (!filename) return 'This record has no file attached.';

  try {
    const resp = await api.get(`/files/${encodeURIComponent(filename)}`, { responseType: 'blob' });
    const url = URL.createObjectURL(resp.data);
    const a = document.createElement('a');
    a.href = url;
    // Drop the storage timestamp prefix so HR gets the name they uploaded.
    a.download = filename.replace(/^\d+_/, '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch (e) {
    return describe(e);
  }
}

/**
 * Fetch a stored image as an object URL, for use as an <img src>.
 *
 * An <img> cannot send the Authorization header the secure route requires, so
 * the bytes are pulled through the API client and wrapped in a blob URL. The
 * caller owns the returned URL and must revoke it on unmount.
 *
 * @returns {Promise<string|null>} object URL, or null if unavailable.
 */
export async function loadEmployeeImage(storedPath) {
  if (!storedPath) return null;
  if (isExternalUrl(storedPath)) return storedPath;
  const filename = storedFilename(storedPath);
  if (!filename) return null;
  try {
    const resp = await api.get(`/files/${encodeURIComponent(filename)}?disposition=inline`, {
      responseType: 'blob',
    });
    return URL.createObjectURL(resp.data);
  } catch {
    // A missing or forbidden photo is not an error worth interrupting the page
    // for — the caller falls back to initials.
    return null;
  }
}

/**
 * Which of these stored paths actually have a file behind them?
 *
 * `employees.pan_file` and friends are just stored paths: a Documents row
 * renders whether or not anything is on disk. Five of EMP003's document columns
 * point at files that are gone, so the tab read "PAN Card - On file" for a
 * document that could not be opened, and the only way to find out was to click
 * View and get an error.
 *
 * HEAD /files/:filename answers it with the same authorization as the download
 * and no audit entry. An external (Drive) URL is another system's page, so it is
 * reported present without being probed — we have nothing to check.
 *
 * Failures resolve to `true`, not `false`: a network blip or an expired session
 * must not paint every document on the page as missing. This marks what is
 * provably absent, nothing else.
 *
 * @param {string[]} storedPaths
 * @returns {Promise<Record<string, boolean>>} stored path -> file is present
 */
export async function probeEmployeeFiles(storedPaths) {
  const unique = [...new Set((storedPaths || []).filter(Boolean))];
  const entries = await Promise.all(unique.map(async (stored) => {
    if (isExternalUrl(stored)) return [stored, true];
    const filename = storedFilename(stored);
    if (!filename) return [stored, false];
    try {
      await api.head(`/files/${encodeURIComponent(filename)}`);
      return [stored, true];
    } catch (e) {
      return [stored, e?.response?.status !== 404];
    }
  }));
  return Object.fromEntries(entries);
}
