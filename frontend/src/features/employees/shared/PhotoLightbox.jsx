import { useEffect } from 'react';

/**
 * Full-size photo viewer — the one View Employee and View Intern both use.
 *
 * Extracted from EmployeeProfile so a second profile page reuses it instead of
 * carrying a copy. Behaviour is unchanged from that page:
 *
 * `object-fit: contain` inside a max-95vw/85vh box: the image is shown whole and
 * to scale, never cropped and never stretched, whatever its aspect ratio. Closes
 * on the backdrop, on the button, and on Esc (bound only while open).
 *
 * @param {string}   src         object URL / external URL of the image
 * @param {string}   name        person's name — alt text and caption
 * @param {string=}  code        EMP / INT code shown after the name
 * @param {Function} onClose
 * @param {Function=} onDownload shows a Download button when given
 */
export default function PhotoLightbox({ src, name, code, onClose, onDownload }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!src) return null;
  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${name || 'Profile'} photo`}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(17,17,24,.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close photo viewer"
        style={{
          position: 'absolute', top: 18, right: 22,
          width: 38, height: 38, borderRadius: '50%',
          border: '1px solid rgba(255,255,255,.28)', background: 'rgba(255,255,255,.12)',
          color: '#fff', fontSize: 20, lineHeight: 1, cursor: 'pointer',
        }}
      >
        &times;
      </button>

      {/* Stop the backdrop handler firing when the user clicks the image itself —
          otherwise the viewer shuts the moment they try to interact with it. */}
      <figure onClick={e => e.stopPropagation()} style={{ margin: 0, maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <img
          src={src}
          alt={name || 'Photo'}
          style={{
            maxWidth: '95vw', maxHeight: '75vh',
            width: 'auto', height: 'auto',
            objectFit: 'contain',
            borderRadius: 10,
            boxShadow: '0 24px 70px rgba(0,0,0,.5)',
            background: '#fff',
          }}
        />
        <figcaption style={{ color: 'rgba(255,255,255,.82)', fontSize: 13, textAlign: 'center' }}>
          {name}{code ? ` · ${code}` : ''}
          {onDownload && (
            <button
              onClick={onDownload}
              style={{
                marginLeft: 14, padding: '4px 14px', borderRadius: 7,
                border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.14)',
                color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Download
            </button>
          )}
        </figcaption>
      </figure>
    </div>
  );
}
