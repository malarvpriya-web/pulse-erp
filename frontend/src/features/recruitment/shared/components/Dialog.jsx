// Centered dialog shell (backdrop + panel) for recruitment forms. This used to
// be a right-side slide-in drawer; pages now open forms as a normal dialog in
// the middle of the screen. Only the outer chrome is shared — header, close
// button and body stay with each caller (`children`). The panel never grows
// past the viewport: a caller's flex body scrolls, otherwise the panel does.
export default function Dialog({
  width = 440,
  boxShadow = '0 20px 60px rgba(0,0,0,.18)',
  overflowY = 'auto',
  children,
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div
        role="dialog"
        aria-modal="true"
        style={{ background: '#fff', width, maxWidth: '100%', maxHeight: 'calc(100vh - 48px)', borderRadius: 12, overflowY, display: 'flex', flexDirection: 'column', boxShadow, animation: 'pulse-dialog-in .18s ease-out' }}
      >
        {children}
      </div>
    </div>
  );
}
