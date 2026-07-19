import { useEffect, useRef } from 'react';
import { AlertTriangle, Trash2, AlertCircle, Info } from 'lucide-react';

const VARIANTS = {
  danger:  { icon: Trash2,        color: '#ef4444', bg: '#fef2f2', label: 'Delete'  },
  warning: { icon: AlertTriangle, color: '#f59e0b', bg: '#fffbeb', label: 'Confirm' },
  info:    { icon: Info,          color: '#3b82f6', bg: '#eff6ff', label: 'OK'      },
};

export default function ConfirmDialog({
  open,
  title       = 'Confirm',
  message     = 'Are you sure?',
  confirmLabel,
  cancelLabel = 'Cancel',
  variant     = 'warning',
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  const { icon: Icon, color, bg, label } = VARIANTS[variant] || VARIANTS.warning;

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onCancel?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div style={{
        background: '#fff', borderRadius: 12, padding: '28px 32px',
        maxWidth: 440, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10, background: bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon size={22} color={color} />
          </div>
          <div>
            <div id="confirm-dialog-title" style={{ fontWeight: 700, fontSize: 16, color: '#111', marginBottom: 6 }}>{title}</div>
            <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5 }}>{message}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
            style={{
              padding: '8px 18px', borderRadius: 7, border: '1.5px solid #d1d5db',
              background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151',
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 18px', borderRadius: 7, border: 'none',
              background: color, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#fff',
            }}
          >
            {confirmLabel || label}
          </button>
        </div>
      </div>
    </div>
  );
}
