/**
 * Where is a candidate's résumé, and in what form?
 *
 * Its own module rather than a second export from ResumeViewer.jsx, because Vite's
 * fast refresh only works on a file that exports components alone — a mixed file
 * makes every edit to the viewer a full page reload instead of a hot swap.
 *
 * Three storage paths accumulated over this module's life and all three are still
 * populated, so all three are handled rather than picking one and quietly breaking
 * the others: a Google Drive link, `resume_file_url` (the current local path) and
 * `resume_url` (the older one).
 */

/** Everything a browser can render in place. Anything else gets an honest panel. */
export const PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export function resumeSourceOf(candidate) {
  if (!candidate) return { kind: 'none' };

  if (candidate.resume_gdrive_url) {
    return { kind: 'drive', url: candidate.resume_gdrive_url };
  }

  const stored = candidate.resume_file_url || candidate.resume_url;
  if (!stored) return { kind: 'none' };

  const filename = String(stored).split('/').pop();
  if (!filename) return { kind: 'none' };

  // A seeded placeholder is not a résumé. Several seeded candidates carry
  // 'https://example.invalid/seed/NNN' in this column, and treating that as a file
  // produces a confusing 404 where "no résumé on file" is the truth.
  if (/^https?:\/\//i.test(stored) && !/\/uploads\//i.test(stored)) {
    return { kind: 'external', url: stored, filename };
  }

  return {
    kind: PREVIEWABLE.test(filename) ? 'file' : 'unpreviewable',
    filename,
    isImage: IMAGE.test(filename),
    // The '1727364..._name.pdf' prefix the upload path adds is noise on screen.
    displayName: filename.replace(/^\d+_/, ''),
  };
}
