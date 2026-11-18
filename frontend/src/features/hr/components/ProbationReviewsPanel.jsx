import { useState, useEffect, useCallback } from "react";
import { ClipboardCheck, ChevronDown, ChevronUp } from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";

/**
 * Probation Reviews (HR) — OPEN reviews: those waiting for the department
 * head, and those the head has submitted and HR must now decide.
 *
 * Reads GET /probation-reviews (hr:view) and keeps the open ones (requested,
 * submitted); decided ones are the page's History. For each review still
 * waiting for the head, the server says, using the same rule it enforces on submission:
 *   current           the reviewer is still the head
 *   reviewer_replaced someone else is the head now — reassignable to them
 *   no_eligible_head  no head can be resolved — HR must assign one first
 *
 * Reassigning uses the existing POST /probation-reviews/:id/reassign (hr:edit)
 * with a required reason; the server picks the new reviewer and re-checks
 * everything under its locks, so this list is only ever a snapshot. The button
 * is shown only to hr:edit holders and only when the server says the review is
 * reassignable. The worklist is reloaded after every action.
 *
 * A SUBMITTED review shows the head's recommendation and, when the page passes
 * `onDecide` (hr:edit holders), a "Record decision" button. `reloadKey`
 * reloads the list when the page changes something; `onChanged` tells the
 * page after a reassignment.
 */
const RECOMMENDATION_LABEL = { confirm: 'Confirm', extend: 'Extend', not_confirm: 'Do not confirm' };
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

export default function ProbationReviewsPanel({ reloadKey = 0, onDecide, onChanged } = {}) {
  const { hasPermission } = useAuth();
  const canEdit = !!hasPermission?.('hr', 'edit');

  const [open, setOpen] = useState(true);
  const [reviews, setReviews] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // { id, reason, mode: 'reassign' | 'cancel' }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/probation-reviews');
      // A panel must never take the Probation page down with it.
      if (!Array.isArray(data?.reviews)) {
        setReviews(null);
        setError('Could not load probation reviews.');
        return;
      }
      setReviews(data.reviews.filter((r) => r.status === 'requested' || r.status === 'submitted'));
      setError(null);
    } catch (err) {
      setReviews(null);
      setError(err?.response?.status === 403
        ? 'You do not have access to probation reviews.'
        : err?.response?.data?.error || 'Could not load probation reviews.');
    }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  // Withdraw an open review (POST /probation-reviews/:id/cancel, hr:edit). The
  // employee record is untouched; a new review can be requested afterwards.
  const cancel = async (review) => {
    const reason = String(editing?.reason ?? '').trim();
    if (!reason) {
      setMessage({ type: 'error', text: 'A reason is required to cancel a review.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api.post(`/probation-reviews/${review.id}/cancel`, { reason });
      setMessage({ type: 'success', text: `${review.employee}'s review was cancelled.` });
    } catch (err) {
      setMessage({ type: 'error', text: err?.response?.data?.error || 'Could not cancel the review.' });
    } finally {
      setEditing(null);
      setSaving(false);
      await load();
      onChanged?.();
    }
  };

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
      onChanged?.();
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
            Reviews waiting for a department head, and reviews the head has submitted for your decision. A flagged review&apos;s reviewer is no longer the eligible head of the employee&apos;s department.
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
                              <div className="prob-dh-muted">Assign a department head first (HR › Department Heads), then reassign this review.</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{fmt(r.reviewer_due_date)}{r.is_overdue && <span className="prob-dh-flag">Overdue</span>}</td>
                      <td>
                        {r.status === 'submitted' ? (
                          <>
                            <span className="prob-review-chip is-submitted">Awaiting HR decision</span>
                            <div className="prob-dh-muted">
                              Recommends {RECOMMENDATION_LABEL[r.recommendation] || r.recommendation} · {r.rating}/5
                            </div>
                          </>
                        ) : 'Awaiting head'}
                      </td>
                      <td className="prob-dh-actions">
                        {r.status === 'submitted' && onDecide && (
                          <button type="button" className="prob-hist-action-btn" onClick={() => onDecide(r)}>
                            Record decision
                          </button>
                        )}
                        {canEdit && r.reassignable && !isEditing && (
                          <button type="button" className="prob-hist-action-btn"
                            onClick={() => { setMessage(null); setEditing({ id: r.id, reason: '', mode: 'reassign' }); }}>
                            Reassign to {r.current_head?.name || 'current head'}
                          </button>
                        )}
                        {canEdit && !isEditing && (
                          <button type="button" className="prob-hist-action-btn prob-rv-cancel"
                            onClick={() => { setMessage(null); setEditing({ id: r.id, reason: '', mode: 'cancel' }); }}>
                            Cancel review
                          </button>
                        )}
                        {isEditing && (
                          <span className="prob-rv-edit">
                            <input type="text" maxLength={500}
                              placeholder={editing.mode === 'cancel' ? 'Why is this review cancelled? (required)' : 'Reason (required)'}
                              aria-label={editing.mode === 'cancel'
                                ? `Reason to cancel ${r.employee}'s review`
                                : `Reason to reassign ${r.employee}'s review`}
                              value={editing.reason}
                              onChange={(e) => setEditing((x) => ({ ...x, reason: e.target.value }))} />
                            <button type="button" className="prob-modal-send" disabled={saving}
                              onClick={() => (editing.mode === 'cancel' ? cancel(r) : reassign(r))}>
                              {saving ? 'Saving…' : editing.mode === 'cancel' ? 'Cancel review' : 'Confirm'}
                            </button>
                            <button type="button" className="prob-modal-cancel" onClick={() => setEditing(null)}>Back</button>
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
