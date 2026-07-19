/**
 * PdfCanvas.jsx — renders a PDF (ArrayBuffer) to stacked canvases via pdf.js
 * and lets a parent overlay absolutely-positioned widgets per page.
 *
 * Coordinates are exchanged as 0..1 ratios (top-left origin) so field positions
 * are resolution-independent and match the backend pdf-lib stamping math.
 */
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfCanvas({ fileData, width = 800, renderOverlay, onPageClick }) {
  const [pages, setPages]   = useState([]);   // [{ num, w, h, page }]
  const [error, setError]   = useState(null);
  const canvasRefs = useRef({});

  // Load + measure pages
  useEffect(() => {
    if (!fileData) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ data: fileData.slice(0) }).promise;
        const list = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const vp = page.getViewport({ scale });
          list.push({ num: i, w: vp.width, h: vp.height, page, vp });
        }
        if (!cancelled) setPages(list);
      } catch (e) {
        if (!cancelled) setError('Unable to display this PDF.');
        console.error('[PdfCanvas]', e);
      }
    })();
    return () => { cancelled = true; };
  }, [fileData, width]);

  // Paint pages onto their canvases
  useEffect(() => {
    const tasks = [];
    pages.forEach(({ num, page, vp }) => {
      const canvas = canvasRefs.current[num];
      if (!canvas) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      tasks.push(task);
    });
    return () => tasks.forEach(t => { try { t.cancel(); } catch { /* noop */ } });
  }, [pages]);

  const handleClick = (e, p) => {
    if (!onPageClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    onPageClick(p.num, xRatio, yRatio);
  };

  if (error) return <div style={{ padding: 24, color: '#dc2626', fontSize: 13 }}>{error}</div>;
  if (!pages.length) return <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Loading document…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      {pages.map(p => (
        <div key={p.num}
          onClick={e => handleClick(e, p)}
          style={{ position: 'relative', width: p.w, height: p.h, boxShadow: '0 2px 10px rgba(0,0,0,.12)', background: '#fff', cursor: onPageClick ? 'crosshair' : 'default' }}>
          <canvas ref={el => { canvasRefs.current[p.num] = el; }}
            style={{ display: 'block', width: p.w, height: p.h }} />
          {renderOverlay && renderOverlay(p.num, { w: p.w, h: p.h })}
        </div>
      ))}
    </div>
  );
}
