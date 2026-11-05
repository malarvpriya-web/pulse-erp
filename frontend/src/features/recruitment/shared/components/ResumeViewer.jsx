import { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileText, Download, Maximize2, Minimize2, ExternalLink, ZoomIn, ZoomOut,
  RotateCw, AlertCircle, Upload,
} from 'lucide-react';
import api from '@/services/api/client';
// resumeSourceOf lives in its own module so this file exports a component and
// nothing else — Vite's fast refresh gives up on a mixed file and full-reloads
// the page on every edit instead of hot-swapping the component.
import { resumeSourceOf } from '../resumeSource';
import './resume-viewer.css';

/**
 * ResumeViewer — the résumé, on screen, without downloading it.
 *
 * This is §5 of the recruitment brief, and it did not exist in any form. The
 * candidate profile rendered no résumé at all (grep `resume` in the old
 * CandidateDetail.jsx: zero hits), and the one place a résumé WAS reachable — the
 * Resume Database — could only hand the recruiter a file to save, because
 * `openResume()` builds an `<a download>` and the secure file route hardcoded
 * `Content-Disposition: attachment`. §5 asks for the opposite in as many words:
 * "The recruiter should NOT have to download the résumé just to read it."
 *
 * ── WHY A BLOB, NOT AN <iframe src="/api/files/…"> ──────────────────────────
 * The file route requires the JWT. A bare `src` on an iframe or object tag sends
 * no Authorization header, so it would 401 — which is exactly why the old Resume
 * Database link was dead in two independent ways. Streaming the bytes through the
 * API client (which attaches the token) and handing the iframe an object URL is
 * the only approach that works without putting the token in a query string, where
 * it would end up in browser history and server logs.
 *
 * `?disposition=inline` asks the backend for `inline` rather than `attachment`;
 * the blob would render regardless, but sending it means the server records the
 * act as a VIEW rather than a DOWNLOAD in its audit log, which is a genuine
 * distinction when the audited thing is candidate PII.
 *
 * ── WHAT CANNOT BE PREVIEWED, AND SAYING SO ────────────────────────────────
 * Word documents have no native browser renderer. Rather than showing a blank
 * frame (which reads as a bug) or silently downloading (which is the behaviour
 * this component exists to remove), a .doc/.docx gets an honest panel naming the
 * limitation with a download button. A Google Drive résumé is a real external
 * link and opens there, because Drive will not frame itself cross-origin.
 */

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300];

export default function ResumeViewer({
  candidate,
  /** Rendered in the toolbar's right side — the caller's own actions. */
  toolbarExtra = null,
  /** Called when the recruiter asks to attach a résumé (no-résumé state). */
  onUpload = null,
  minHeight = 520,
}) {
  const src = resumeSourceOf(candidate);

  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(100);
  const [fit, setFit] = useState('width');     // 'width' | 'page' | 'zoom'
  const [fullscreen, setFullscreen] = useState(false);
  const [rotation, setRotation] = useState(0);

  // Held in a ref as well as state so the cleanup function revokes the CURRENT
  // url. Reading it from state inside a cleanup closure captures the value from
  // the render that registered the effect, which leaks every url but the last.
  const blobRef = useRef(null);

  const revoke = useCallback(() => {
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (src.kind !== 'file') { revoke(); setBlobUrl(null); return undefined; }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.get(`/files/${encodeURIComponent(src.filename)}`, {
      responseType: 'blob',
      params: { disposition: 'inline' },
    })
      .then((resp) => {
        if (cancelled) return;
        revoke();
        // The Content-Type the server sent is carried through, so the browser
        // picks its PDF viewer for a PDF and its image viewer for an image. A
        // blob with no type renders as a download prompt.
        const blob = resp.data instanceof Blob
          ? resp.data
          : new Blob([resp.data], { type: resp.headers?.['content-type'] || 'application/pdf' });
        const url = URL.createObjectURL(blob);
        blobRef.current = url;
        setBlobUrl(url);
      })
      .catch((e) => {
        if (cancelled) return;
        // Specific messages, because "could not load" tells the recruiter nothing
        // they can act on. 403 means ask an administrator; 404 means the file is
        // gone and the record needs a fresh upload.
        const status = e?.response?.status;
        if (status === 403)      setError('You do not have permission to open this résumé.');
        else if (status === 404) setError('The résumé file is missing from storage. It may need to be uploaded again.');
        else if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') setError(null);
        else setError(e?.response?.data?.error || e?.message || 'Could not open the résumé.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [src.kind, src.filename, revoke]);

  // Revoke on unmount only. Separate from the fetch effect so a re-fetch does not
  // revoke the url it is about to replace before the iframe has stopped using it.
  useEffect(() => revoke, [revoke]);

  // Escape leaves fullscreen. Bound only while fullscreen, so it cannot swallow
  // Escape from a dialog on the page underneath.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const download = async () => {
    if (src.kind === 'drive' || src.kind === 'external') {
      window.open(src.url, '_blank', 'noreferrer');
      return;
    }
    if (!src.filename) return;
    try {
      const resp = await api.get(`/files/${encodeURIComponent(src.filename)}`, { responseType: 'blob' });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = src.displayName || src.filename;
      a.click();
      // Deferred: revoking synchronously after .click() races the browser's own
      // read of the url and produces an empty file in some versions.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not download the résumé.');
    }
  };

  const zoomBy = (dir) => {
    const i = ZOOM_STEPS.indexOf(zoom);
    const next = ZOOM_STEPS[Math.min(Math.max((i === -1 ? 2 : i) + dir, 0), ZOOM_STEPS.length - 1)];
    setZoom(next);
    setFit('zoom');
  };

  /**
   * PDF viewer fragment parameters.
   *
   * `#view=FitH` / `#zoom=N` are the PDF Open Parameters the built-in viewers in
   * Chrome, Edge and Firefox honour, which is what gives §5's fit-to-width,
   * fit-to-page and zoom without shipping a PDF rendering engine. `toolbar=1`
   * keeps the viewer's own page navigation, so "page navigation" is real rather
   * than reimplemented worse.
   */
  const frameSrc = blobUrl
    ? `${blobUrl}#toolbar=1&navpanes=0&${
        fit === 'width' ? 'view=FitH' : fit === 'page' ? 'view=Fit' : `zoom=${zoom}`
      }`
    : null;

  const body = () => {
    if (src.kind === 'none') {
      return (
        <div className="rv-empty">
          <FileText size={40} strokeWidth={1.4} />
          <p className="rv-empty-title">No résumé on file</p>
          <p className="rv-empty-sub">
            Everything else on this page still works — screening, notes and stage moves
            do not require a résumé.
          </p>
          {onUpload && (
            <button type="button" className="rv-btn rv-btn--primary" onClick={onUpload}>
              <Upload size={14} /> Attach a résumé
            </button>
          )}
        </div>
      );
    }

    if (src.kind === 'drive') {
      return (
        <div className="rv-empty">
          <ExternalLink size={40} strokeWidth={1.4} />
          <p className="rv-empty-title">This résumé lives in Google Drive</p>
          <p className="rv-empty-sub">
            Drive does not allow itself to be embedded, so it opens in a new tab.
          </p>
          <button type="button" className="rv-btn rv-btn--primary" onClick={download}>
            <ExternalLink size={14} /> Open in Drive
          </button>
        </div>
      );
    }

    if (src.kind === 'external') {
      return (
        <div className="rv-empty">
          <AlertCircle size={40} strokeWidth={1.4} />
          <p className="rv-empty-title">No résumé file stored</p>
          <p className="rv-empty-sub">
            This record points at an external address rather than an uploaded file
            ({src.url}), so there is nothing to display. Upload the résumé to make it
            readable here.
          </p>
          {onUpload && (
            <button type="button" className="rv-btn rv-btn--primary" onClick={onUpload}>
              <Upload size={14} /> Attach a résumé
            </button>
          )}
        </div>
      );
    }

    if (src.kind === 'unpreviewable') {
      return (
        <div className="rv-empty">
          <FileText size={40} strokeWidth={1.4} />
          <p className="rv-empty-title">{src.displayName}</p>
          <p className="rv-empty-sub">
            Word documents cannot be rendered in the browser. Download it to read it, or
            ask the candidate for a PDF — PDFs open right here.
          </p>
          <button type="button" className="rv-btn rv-btn--primary" onClick={download}>
            <Download size={14} /> Download
          </button>
        </div>
      );
    }

    if (loading) {
      return (
        <div className="rv-empty">
          <div className="rv-spinner" aria-hidden />
          <p className="rv-empty-sub">Loading résumé…</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="rv-empty">
          <AlertCircle size={40} strokeWidth={1.4} className="rv-icon-bad" />
          <p className="rv-empty-title">Could not open the résumé</p>
          <p className="rv-empty-sub">{error}</p>
          <button type="button" className="rv-btn" onClick={download}>
            <Download size={14} /> Try downloading instead
          </button>
        </div>
      );
    }

    if (!blobUrl) return null;

    if (src.isImage) {
      return (
        <div className="rv-scroll">
          <img
            src={blobUrl}
            alt={`Résumé — ${candidate?.full_name || 'candidate'}`}
            className="rv-image"
            style={{
              width: fit === 'width' ? '100%' : fit === 'page' ? 'auto' : `${zoom}%`,
              maxHeight: fit === 'page' ? '100%' : 'none',
              transform: rotation ? `rotate(${rotation}deg)` : undefined,
            }}
          />
        </div>
      );
    }

    return (
      <iframe
        // Keyed on the fragment so a fit/zoom change actually reloads the viewer.
        // Without the key React keeps the same element and the browser ignores a
        // changed hash on an existing iframe, which makes the zoom buttons appear
        // to do nothing.
        key={frameSrc}
        src={frameSrc}
        title={`Résumé — ${candidate?.full_name || 'candidate'}`}
        className="rv-frame"
      />
    );
  };

  const canZoom = src.kind === 'file' && !loading && !error && blobUrl;
  const hasFile = src.kind !== 'none';

  return (
    <div
      className={`rv${fullscreen ? ' rv--fullscreen' : ''}`}
      style={fullscreen ? undefined : { minHeight }}
    >
      <div className="rv-toolbar">
        <div className="rv-toolbar-left">
          <FileText size={15} className="rv-toolbar-icon" />
          <span className="rv-filename" title={src.displayName || src.filename || ''}>
            {src.displayName || (src.kind === 'drive' ? 'Google Drive résumé' : 'Résumé')}
          </span>
        </div>

        {canZoom && (
          <div className="rv-toolbar-mid">
            <button type="button" className="rv-tool" onClick={() => zoomBy(-1)} title="Zoom out" aria-label="Zoom out">
              <ZoomOut size={14} />
            </button>
            <span className="rv-zoom-label">{fit === 'zoom' ? `${zoom}%` : fit === 'width' ? 'Fit width' : 'Fit page'}</span>
            <button type="button" className="rv-tool" onClick={() => zoomBy(1)} title="Zoom in" aria-label="Zoom in">
              <ZoomIn size={14} />
            </button>
            <span className="rv-sep" />
            <button
              type="button"
              className={`rv-tool rv-tool--text${fit === 'width' ? ' is-on' : ''}`}
              onClick={() => setFit('width')}
            >
              Fit width
            </button>
            <button
              type="button"
              className={`rv-tool rv-tool--text${fit === 'page' ? ' is-on' : ''}`}
              onClick={() => setFit('page')}
            >
              Fit page
            </button>
            {src.isImage && (
              <button type="button" className="rv-tool" onClick={() => setRotation(r => (r + 90) % 360)} title="Rotate">
                <RotateCw size={14} />
              </button>
            )}
          </div>
        )}

        <div className="rv-toolbar-right">
          {toolbarExtra}
          {hasFile && (
            <button type="button" className="rv-tool" onClick={download} title="Download résumé" aria-label="Download résumé">
              <Download size={14} />
            </button>
          )}
          {src.kind === 'file' && (
            <button
              type="button"
              className="rv-tool"
              onClick={() => setFullscreen(f => !f)}
              title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
        </div>
      </div>

      <div className="rv-body">{body()}</div>
    </div>
  );
}
