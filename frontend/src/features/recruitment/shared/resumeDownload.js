import api from '@/services/api/client';

/**
 * Open a candidate's résumé.
 *
 * Locally stored résumés live behind GET /files/:filename, which requires the
 * JWT — so a plain `<a href="/uploads/…">` could never work, and that is exactly
 * what the Resume Database used to render: the raw stored path, which Express
 * does not serve (the public /uploads static mount was deliberately removed) and
 * which carries no Authorization header even if it did. The link was dead in two
 * independent ways.
 *
 * Streaming through the API client instead means the token travels with the
 * request and the download is audit-logged server-side, the same pattern
 * DocumentMaster already uses. A Google Drive URL is a real external link and
 * still opens directly.
 *
 * @returns {Promise<string|null>} an error message, or null on success.
 */
export async function openResume(candidate) {
  const driveUrl = candidate?.resume_gdrive_url;
  if (driveUrl) {
    window.open(driveUrl, '_blank', 'noreferrer');
    return null;
  }

  const stored = candidate?.resume_file_url || candidate?.resume_url;
  if (!stored) return 'This candidate has no résumé on file.';

  // Stored as '/uploads/<filename>'; the secure route is addressed by filename.
  const filename = String(stored).split('/').pop();
  if (!filename) return 'This résumé has no readable file name.';

  try {
    const resp = await api.get(`/files/${encodeURIComponent(filename)}`, { responseType: 'blob' });
    const url  = URL.createObjectURL(resp.data);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename.replace(/^\d+_/, '');
    a.click();
    URL.revokeObjectURL(url);
    return null;
  } catch (e) {
    if (e?.response?.status === 403) return 'You do not have permission to open this résumé.';
    if (e?.response?.status === 404) return 'The résumé file is missing from storage.';
    return e?.response?.data?.error || e?.message || 'Could not open the résumé.';
  }
}
