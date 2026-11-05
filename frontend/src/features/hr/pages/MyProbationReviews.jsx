import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, LoadingState, LoadError, EmptyState } from '@/components/pulse-ui';
import { fetchReviewerStatus } from '../probationReviewerStatus';
import { fmtDate } from '@/utils/dateFormatter';
import './MyProbationReviews.css';

/**
 * My Probation Reviews — the department head's side of the probation review.
 *
 * Open to every role by URL (PERSONAL_PAGES, no module) exactly like My Intern
 * Evaluations; what it shows is decided by the server:
 *   - GET /probation-reviews/mine/summary  → is this login a CURRENT head here?
 *     If not (never a head, reassigned, left, no linked employee, no company)
 *     the page shows a notice and loads no review data at all.
 *   - GET /probation-reviews/mine          → the reviews assigned to the caller's
 *     linked employee record, in their company.
 *   - POST /probation-reviews/mine/:id/submit → once; the server validates and
 *     authorises, and its message is shown as-is.
 * No HR permission is involved or granted: department heads hold none.
 *
 * ?ref=<review id> (from the notification) highlights that review. If it is not
 * one of the caller's, a notice says it is unavailable — and nothing about it.
 */

const RECOMMENDATION_LABEL = {
  confirm: 'Confirm employment',
  extend: 'Extend probation',
  not_confirm: 'Do not confirm',
};
const RATING_LABEL = { 1: 'Poor', 2: 'Below expectations', 3: 'Meets expectations', 4: 'Good', 5: 'Excellent' };

const fmt = (d) => {
  if (!d) return '—';
  const iso = String(d).slice(0, 10);
  const [y, m, day] = iso.split('-').map(Number);
  if (!y || !m || !day) return '—';
  // The app standard (05 Apr 26) — this printed a four-digit year.
  return fmtDate(iso);
};

function ReviewCard({ review, recommendations, highlighted, onSubmitted }) {
  const [rating, setRating] = useState('');
  const [comments, setComments] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (highlighted && ref.current?.scrollIntoView) ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [highlighted]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.post(`/probation-reviews/mine/${review.id}/submit`, {
        rating: rating === '' ? undefined : Number(rating),
        comments,
        recommendation,
      });
      onSubmitted(data.review);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not submit the review.');
    } finally {
      setSaving(false);
    }
  };

  const open = review.status === 'requested';
  return (
    <article ref={ref} className={`mpr-card${highlighted ? ' is-highlighted' : ''}`}
      aria-current={highlighted ? 'true' : undefined} aria-label={`Probation review for ${review.employee}`}>
      <header className="mpr-card-head">
        <div>
          <h2>{review.employee}</h2>
          <div className="mpr-muted">{review.office_id || '—'}{review.department ? ` · ${review.department}` : ''}</div>
        </div>
        <span className={`mpr-status is-${review.status}`}>{open ? 'Awaiting your review' : 'Submitted'}</span>
      </header>

      <dl className="mpr-facts">
        <div><dt>Probation period</dt><dd>{fmt(review.period_start)} – {fmt(review.original_end_date)}</dd></div>
        <div><dt>Probation ends</dt><dd>{fmt(review.original_end_date)}</dd></div>
        <div>
          <dt>Review due</dt>
          <dd>{fmt(review.reviewer_due_date)}{open && review.is_overdue && <span className="mpr-overdue">Overdue</span>}</dd>
        </div>
        <div><dt>Requested</dt><dd>{fmt(review.requested_at)}{review.requested_by ? ` by ${review.requested_by}` : ''}</dd></div>
        {review.cycle_no > 1 && <div><dt>Review cycle</dt><dd>{review.cycle_no}</dd></div>}
      </dl>

      {open ? (
        <div className="mpr-form">
          <fieldset>
            <legend>Rating</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className="mpr-rating">
                <input type="radio" name={`rating-${review.id}`} value={n}
                  checked={String(rating) === String(n)} onChange={(e) => setRating(e.target.value)} />
                {n} — {RATING_LABEL[n]}
              </label>
            ))}
          </fieldset>
          <label className="mpr-field">
            Comments
            <textarea rows={4} value={comments} maxLength={4000}
              aria-label={`Comments for ${review.employee}`} onChange={(e) => setComments(e.target.value)} />
          </label>
          <label className="mpr-field">
            Recommendation
            <select value={recommendation} aria-label={`Recommendation for ${review.employee}`}
              onChange={(e) => setRecommendation(e.target.value)}>
              <option value="">— Choose —</option>
              {recommendations.map((r) => <option key={r} value={r}>{RECOMMENDATION_LABEL[r] || r}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="mpr-error">{error}</p>}
          <p className="mpr-muted">A review can be submitted once. HR records the final decision.</p>
          <button type="button" className="mpr-submit" disabled={saving} onClick={submit}>
            {saving ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      ) : (
        <div className="mpr-submitted">
          <div><strong>Rating:</strong> {review.rating} — {RATING_LABEL[review.rating] || ''}</div>
          <div><strong>Recommendation:</strong> {RECOMMENDATION_LABEL[review.recommendation] || review.recommendation}</div>
          <div><strong>Comments:</strong> {review.comments}</div>
          <p className="mpr-muted">Submitted {fmt(review.submitted_at)} — waiting for HR&apos;s decision.</p>
        </div>
      )}
    </article>
  );
}

export default function MyProbationReviews() {
  const [searchParams] = useSearchParams();
  const refId = searchParams.get('ref');
  const [state, setState] = useState({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      // Fresh, not cached: a head reassigned a moment ago must not see data.
      const status = await fetchReviewerStatus(true);
      if (!status.is_head) { setState({ phase: 'not-head' }); return; }
      const { data } = await api.get('/probation-reviews/mine');
      setState({ phase: 'ready', reviews: data.reviews || [], recommendations: data.recommendations || [] });
    } catch (err) {
      setState({ phase: 'error', message: err?.response?.data?.error || err?.message || 'Could not load your reviews.' });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onSubmitted = (updated) => {
    setState((s) => ({ ...s, reviews: s.reviews.map((r) => (r.id === updated.id ? updated : r)) }));
    fetchReviewerStatus(true);   // refresh the menu's "needs action"
  };

  const refUnavailable = refId && (state.phase === 'not-head'
    || (state.phase === 'ready' && !state.reviews.some((r) => String(r.id) === String(refId))));

  return (
    <PageShell dock={
      <PageHero icon={ClipboardCheck} eyebrow="Probation" title="My Probation Reviews"
        subtitle="Review the probation of employees in the departments you head. HR records the final decision." />
    }>
      <div className="mpr-page">
        {refUnavailable && (
          <div role="alert" className="mpr-unavailable">
            This review is not available to you. It may have been reassigned or completed, or you may no longer head that department.
          </div>
        )}
        {state.phase === 'loading' && <LoadingState shape="lines" rows={5} />}
        {state.phase === 'error' && <LoadError message={state.message} onRetry={load} />}
        {state.phase === 'not-head' && (
          <EmptyState title="Available to department heads"
            subtitle="You are not currently the head of a department. This page opens for you when HR assigns you one." />
        )}
        {state.phase === 'ready' && state.reviews.length === 0 && (
          <EmptyState title="No probation reviews assigned to you"
            subtitle="When HR asks you to review someone's probation, it appears here." />
        )}
        {state.phase === 'ready' && state.reviews.length > 0 && (
          <div className="mpr-list">
            {state.reviews.map((r) => (
              <ReviewCard key={r.id} review={r} recommendations={state.recommendations}
                highlighted={String(r.id) === String(refId)} onSubmitted={onSubmitted} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
