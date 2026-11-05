import { useState, useEffect, useCallback } from "react";
import { ClipboardCheck, ChevronDown, ChevronUp } from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";

/**
 * Probation Reviews (HR) — open reviews and whether each one's reviewer is
 * still the eligible department head.
 *
 * Reads GET /probation-reviews?status=requested (existing, hr:view). For each
 * open review the server says, using the same rule it enforces on submission:
 *   current           the reviewer is still the head
 *   reviewer_replaced someone else is the head now — reassignable to them
 *   no_eligible_head  no head can be resolved — HR must assign one first
 *
 * Reassigning uses the existing POST /probation-reviews/:id/reassign (hr:edit)
 * with a required reason; the server picks the new reviewer and re-checks
 * everything under its locks, so this list is only ever a snapshot. The button
 * is shown only to hr:edit holders and only when the server says the review is
 * reassignable. The worklist is reloaded after every action.
 */
const STATE_LABEL = {
  reviewer_replaced: 'Reviewer is no longer the head',
  no_eligible_head: 'No eligible head',
};

const fmt = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return '—';
  return new Date(Date.UTC(y, m - 1, day))
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
};

export default function ProbationReviewsPanel() {
  const { hasPermission } = useAuth();
  const canEdit = !!hasPermission?.('hr', 'edit');

  const [open, setOpen] = useState(true);
  const [reviews, setReviews] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // { id, reason }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/probation-reviews', { params: { status: 'requested' } });
      // A panel must never take the Probation page down with it.
      if (!Array.isArray(data?.reviews)) {
        setReviews(null);
        setError('Could not load probation reviews.');
        return;
      }
      setReviews(data.reviews);
      setError(null);
    } catch (err) {
      setReviews(null);
      setError(err?.response?.status === 403
        ? 'You do not have access to probation reviews.'
        : err?.response?.data?.error || 'Could not load probation reviews.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const reassign = async (review) => {
    const reason = String(editing?.reason ?? '').trim();
    if (!reason) {
      setMessage({ type: 'error', text: 'A reason is required to reassign a review.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/probation-reviews/${review.id}/reassign`, { reason });
      if (data?.changed === true) {
        setMessage({ type: 'success', text: `${review.employee}'s review was reassigned to ${data?.review?.reviewer || review.current_head?.name || 'the current head'}.` });
      } else if (data?.changed === false) {
        setMessage({ type: 'success', text: `No change — ${data?.review?.reviewer || 'the current head'} is already the reviewer.` });
      } else {
        setMessage({ type: 'error', text: 'Unexpected response from the server. The list has been refreshed.' });
      }
      setEditing(null);
    } catch (err) {
      // 409 (already submitted, no eligible head any more, changed meanwhile),
      // 403/404 — shown as the server says it.
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Could not reassign the review.' });
      setEditing(null);
    } finally {
      setSaving(false);
      await load();
    }
  };

  return (
    <section className="prob-dh prob-rv" aria-label="Probation reviews">
      <button type="button" className="prob-dh-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ClipboardCheck size={14} /> Probation Reviews
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="prob-dh-body">
          <p className="prob-dh-help">
            Reviews waiting for a department head. A flagged review&apos;s reviewer is no longer the eligible head of the employee&apos;s department.
          </p>
          {message && (
            <div role={message.type === 'error' ? 'alert' : 'status'} className={`prob-dh-msg is-${message.type}`}>{message.text}</div>
          )}
          {error ? (
            <div role="alert" className="prob-dh-msg is-error">{error}</div>
          ) : !reviews ? (
            <div className="prob-dh-help">Loading…</div>
          ) : reviews.length === 0 ? (
            <div className="prob-dh-help">No open probation reviews.</div>
          ) : (
            <table className="prob-dh-table">
              <thead>
                <tr><th>Employee</th><th>Department</th><th>Reviewer</th><th>Due</th><th>Status</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {reviews.map((r) => {
                  const stale = r.reviewer_state && r.reviewer_state !== 'current';
                  const isEditing = editing?.id === r.id;
                  return (
                    <tr key={r.id} data-review={r.id}>
                      <td>{r.employee} <span className="prob-dh-muted">{r.office_id}</span></td>
                      <td>{r.department || '—'}</td>
                      <td>
                        {r.reviewer || '—'}
                        {stale && (
                          <div className="prob-rv-stale">
                            <span className="prob-dh-flag">{STATE_LABEL[r.reviewer_state] || 'Check reviewer'}</span>
                            {r.reviewer_state_reason && <div className="prob-dh-muted">{r.reviewer_state_reason}</div>}
                            {r.reviewer_state === 'no_eligible_head' && (
                              <div className="prob-dh-muted">Assign a department head first (Department Heads, above), then reassign this review.</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{fmt(r.reviewer_due_date)}{r.is_overdue && <span className="prob-dh-flag">Overdue</span>}</td>
                      <td>Awaiting review</td>
                      <td className="prob-dh-actions">
                        {canEdit && r.reassignable && !isEditing && (
                          <button type="button" className="prob-hist-action-btn"
                            onClick={() => { setMessage(null); setEditing({ id: r.id, reason: '' }); }}>
                            Reassign to {r.current_head?.name || 'current head'}
                          </button>
                        )}
                        {isEditing && (
                          <span className="prob-rv-edit">
                            <input type="text" maxLength={500} placeholder="Reason (required)"
                              aria-label={`Reason to reassign ${r.employee}'s review`} value={editing.reason}
                              onChange={(e) => setEditing((x) => ({ ...x, reason: e.target.value }))} />
                            <button type="button" className="prob-modal-send" disabled={saving} onClick={() => reassign(r)}>
                              {saving ? 'Saving…' : 'Confirm'}
                            </button>
                            <button type="button" className="prob-modal-cancel" onClick={() => setEditing(null)}>Cancel</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
