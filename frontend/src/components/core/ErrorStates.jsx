/**
 * Error state system — consistent error UI for failed data loads.
 */

/**
 * Full-page or section-level error display.
 * @param {string|Error} error    — error message or Error object
 * @param {Function}     [onRetry]— optional retry callback
 * @param {boolean}      [compact]— compact card mode (for inside panels)
 */
export function ErrorState({ error, onRetry, compact = false }) {
  const msg = typeof error === 'string'
    ? error
    : error?.message || 'An unexpected error occurred';

  return (
    <div style={{
      textAlign: 'center',
      padding: compact ? '16px' : '48px 24px',
      background: compact ? '#fff5f5' : 'transparent',
      borderRadius: 10,
      border: compact ? '1px solid #fee2e2' : 'none',
      color: '#991b1b',
    }}>
      <div style={{ fontSize: compact ? 24 : 40, marginBottom: 10 }}>⚠️</div>
      <div style={{ fontSize: compact ? 13 : 14, fontWeight: 600, marginBottom: 6, color: '#991b1b' }}>
        Failed to load data
      </div>
      <div style={{ fontSize: compact ? 11 : 12, color: '#b91c1c', marginBottom: onRetry ? 14 : 0 }}>
        {msg}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            padding: '7px 16px',
            background: '#dc2626',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ↺ Retry
        </button>
      )}
    </div>
  );
}

/**
 * Inline error banner — for field-level or row-level errors.
 * @param {string} message
 */
export function InlineError({ message }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      background: '#fee2e2',
      borderRadius: 6,
      fontSize: 12,
      color: '#991b1b',
    }}>
      ⚠ {message}
    </div>
  );
}

export default ErrorState;
