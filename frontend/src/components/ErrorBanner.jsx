import { AlertCircle, X, RefreshCw } from 'lucide-react';
import { useState } from 'react';

/**
 * ErrorBanner — dismissible error alert for critical pages.
 * Props:
 *   message  — string to display (if falsy, renders nothing)
 *   onRetry  — optional callback for a Retry button
 */
export default function ErrorBanner({ message, onRetry }) {
  const [dismissed, setDismissed] = useState(false);
  if (!message || dismissed) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      background: '#fef2f2', border: '1px solid #fecaca',
      borderRadius: '8px', padding: '10px 14px', marginBottom: '16px',
      fontSize: '13px', color: '#991b1b',
    }}>
      <AlertCircle size={16} color="#dc2626" style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            background: 'none', border: '1px solid #fca5a5', borderRadius: '6px',
            padding: '3px 10px', fontSize: '12px', color: '#dc2626', cursor: 'pointer',
          }}
        >
          <RefreshCw size={12} /> Retry
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
        aria-label="Dismiss"
      >
        <X size={15} color="#9ca3af" />
      </button>
    </div>
  );
}
