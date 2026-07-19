import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

let _nextId = 1;

const ICONS = {
  success: { Icon: CheckCircle,   color: '#10b981', bg: '#dcfce7', border: '#bbf7d0' },
  error:   { Icon: AlertCircle,   color: '#ef4444', bg: '#fee2e2', border: '#fecaca' },
  warning: { Icon: AlertTriangle, color: '#f59e0b', bg: '#fef3c7', border: '#fde68a' },
  info:    { Icon: Info,          color: '#3b82f6', bg: '#dbeafe', border: '#bfdbfe' },
};

function ToastItem({ toast, onDismiss }) {
  const { Icon, color, bg, border } = ICONS[toast.type] || ICONS.info;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: bg, border: `1px solid ${border}`, borderLeft: `4px solid ${color}`,
        borderRadius: 10, padding: '12px 14px', minWidth: 280, maxWidth: 380,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)', animation: 'toast-in 0.25s ease',
        position: 'relative',
      }}
    >
      <Icon size={18} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast.title && (
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 2 }}>
            {toast.title}
          </div>
        )}
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.4 }}>{toast.message}</div>
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#9ca3af', flexShrink: 0 }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <>
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateX(40px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      <div style={{
        position: 'fixed', top: 20, right: 20, zIndex: 99999,
        display: 'flex', flexDirection: 'column', gap: 10,
        pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div key={t.id} style={{ pointerEvents: 'all' }}>
            <ToastItem toast={t} onDismiss={onDismiss} />
          </div>
        ))}
      </div>
    </>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback(({ message, title, type = 'info', duration = 4000 }) => {
    const id = _nextId++;
    setToasts(prev => [...prev, { id, message, title, type }]);
    if (duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  // Convenience methods
  toast.success = (message, opts) => toast({ message, type: 'success', ...opts });
  toast.error   = (message, opts) => toast({ message, type: 'error',   duration: 6000, ...opts });
  toast.warning = (message, opts) => toast({ message, type: 'warning', ...opts });
  toast.info    = (message, opts) => toast({ message, type: 'info',    ...opts });

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
