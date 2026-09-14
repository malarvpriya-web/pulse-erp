import { AlertTriangle, RotateCw } from 'lucide-react';
import './pulse-ui.css';

/**
 * LoadError — "this failed to load", as distinct from "there is nothing here".
 *
 * WHY THIS EXISTS
 * ---------------
 * The prevailing shape across these pages was:
 *
 *   api.get('/procurement/grn')
 *     .then(r => setRows(r.data))
 *     .catch(() => setRows([]))          // <-- an error becomes an empty list
 *
 * A failed request and a genuinely empty result then render identically: the
 * empty state, saying "No goods receipts yet". That is not a cosmetic problem.
 * It reads as a factual statement about the business — there are no receipts —
 * when what actually happened is that the caller was refused, or the server
 * errored, or the token expired. A buyer acts on "no open orders" differently
 * from "we could not reach the server", and the screen was telling them the
 * first when it meant the second.
 *
 * It also hides regressions: a route that starts 403ing after a permissions
 * change looks exactly like a quiet week.
 *
 * Pair it with the request's own error:
 *
 *   catch (e) { setError(e.response?.data?.error || e.message); }
 *   ...
 *   {error ? <LoadError message={error} onRetry={load} />
 *          : rows.length === 0 ? <EmptyState … /> : <Table … />}
 *
 * `message` should be the server's own text where there is one — the backend
 * now answers with sentences a person can act on ("Purchase order PO0006 is
 * 'cancelled' and cannot be received against"), and discarding that in favour of
 * a generic string throws away the only useful part.
 */
export default function LoadError({
  title = 'Could not load this',
  message,
  onRetry,
  compact = false,
}) {
  return (
    <div className={`pl-empty pl-load-error${compact ? ' pl-compact' : ''}`} role="alert">
      <div className="pl-empty-icon pl-load-error-icon">
        <AlertTriangle size={compact ? 18 : 24} aria-hidden="true" />
      </div>
      <p className="pl-empty-title">{title}</p>
      {message && <p className="pl-empty-subtitle">{message}</p>}
      {onRetry && (
        <button type="button" className="pulse-btn-secondary pl-load-error-retry" onClick={onRetry}>
          <RotateCw size={14} aria-hidden="true" /> Try again
        </button>
      )}
    </div>
  );
}
