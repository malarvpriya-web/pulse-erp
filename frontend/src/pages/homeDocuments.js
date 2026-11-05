import api from '@/services/api/client';

/**
 * Home's Policies and Brand Vault tiles.
 *
 * Each document arrives from /home/summary with `download`:
 *   'file' → the file is fetched through GET /home/documents/:kind/:id/download,
 *            which streams the real file (Drive files, Google Docs exported to
 *            Office formats). It goes through the API client because the route
 *            needs the Authorization header a plain <a href> cannot send.
 *   'link' → an external page (not Google Drive): opened in a new tab.
 *   null   → nothing linked yet.
 *
 * The browser never follows a Drive share link itself: that opens Drive's
 * viewer, and for an org-restricted file it lands on Google's sign-in page.
 */

function filenameFrom(header, fallback) {
  const h = String(header || '');
  const star = h.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* use the plain name */ }
  }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : fallback;
}

// With responseType 'blob' an error body is a Blob too; read the JSON message
// out of it so the user sees why, not "Request failed with status code 502".
async function messageOf(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const body = JSON.parse(await data.text());
      if (body?.error) return body.error;
    } catch { /* not JSON */ }
  } else if (data?.error) {
    return data.error;
  }
  if (!err?.response) return 'Could not reach the server. Check your connection and try again.';
  return 'Could not download this document.';
}

/** @returns {Promise<string|null>} an error message, or null on success. */
export async function downloadHomeDocument(kind, doc) {
  if (doc.download === 'link' && doc.file_url) {
    window.open(doc.file_url, '_blank', 'noopener,noreferrer');
    return null;
  }
  if (doc.download !== 'file') return 'This document is not linked to a file yet.';

  try {
    const resp = await api.get(`/home/documents/${kind}/${doc.id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(resp.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filenameFrom(resp.headers?.['content-disposition'], doc.title || 'document');
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick: some browsers start the save asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return null;
  } catch (err) {
    return messageOf(err);
  }
}
