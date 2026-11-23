/**
 * My Team — the manager's side of a review (2026-11-11).
 *
 * Lists the latest review of everyone who reports to the caller (or names them
 * as manager), with where each one stands. Once the employee has submitted
 * their self-assessment, the manager opens it here, reads it, and submits the
 * manager review (POST /performance/reviews/:id/manager-review). HR finalises
 * it afterwards. Used by My Reviews as a tab, and on its own for a manager who
 * has no review of their own.
 */
import { useState, useEffect } from 'react';
import { Star, X, Users, CheckCircle, Clock } from 'lucide-react';
import api from '@/services/api/client';
import { submitErrorMessage } from '../submitErrorMessage';

const RATING = { 1: 'Poor', 2: 'Below Average', 3: 'Meets Expectations', 4: 'Exceeds Expectations', 5: 'Outstanding' };
const STATUS = {
  self_review_pending: { label: 'Waiting for self-assessment', color: '#7c5cf0', canReview: false },
  self_submitted:      { label: 'Ready for your review',       color: '#d97706', canReview: true },
  manager_submitted:   { label: 'Reviewed — waiting for HR',   color: '#0ea5e9', canReview: true },
  completed:           { label: 'Completed',                   color: '#16a34a', canReview: false },
};
const EMPTY = { manager_rating: 0, final_rating: 0, kra_score: '', behavioral_score: '', manager_comments: '', promotion_recommendation: false, salary_revision_percentage: '' };

function Stars({ value, onChange, label }) {
  return (
    <div className="prf-stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} size={22} role="radio" aria-checked={s === value} aria-label={`${label} ${s}`}
          className={`prf-star ${s <= (value || 0) ? 'prf-star-filled' : ''}`} onClick={() => onChange(s)} />
      ))}
      {value ? <span className="prf-star-label">{RATING[value]}</span> : null}
    </div>
  );
}

// Attendance & punctuality for the review period (§278.3, owner 2026-11-19):
// shown to the manager while rating, and saved with the manager's review.
export function ReviewAttendance({ reviewId }) {
  const [a, setA] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setA(null); setErr('');
    api.get(`/performance/reviews/${reviewId}/attendance`)
      .then((r) => setA(r.data)).catch(() => setErr('Attendance could not be loaded'));
  }, [reviewId]);
  if (err) return <section className="prf-self-summary"><label className="prf-field-label">Attendance & punctuality</label><p>{err}</p></section>;
  if (!a) return null;
  const tile = (label, value, bad) => (
    <div style={{ background: '#faf9ff', border: '1px solid #efeafd', borderRadius: 8, padding: '6px 10px', minWidth: 92 }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: bad && value > 0 ? '#dc2626' : '#1f2937' }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
    </div>
  );
  return (
    <section className="prf-self-summary" data-testid="review-attendance">
      <label className="prf-field-label">Attendance & punctuality ({a.from} to {a.to})</label>
      <p style={{ margin: '4px 0 8px' }}>
        <b>Punctuality rating (default): {a.score != null ? `${a.score} / 5` : 'not enough attendance yet'}</b>
        {a.punctuality_pct != null && <> · on time {a.punctuality_pct}% of days present · present {a.attendance_pct}% of working days</>}
        <br />
        <b>Leave rating (default): {a.leave_rating != null ? `${a.leave_rating} / 5` : '—'}</b>
        {' '}· {a.days_off ?? 0} days off ({a.leave_days ?? 0} leave + {Number(a.days_off ?? 0) - Number(a.leave_days ?? 0)} absent)
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tile('Days present', a.present_days)}
        {tile('Leave days', a.leave_days)}
        {tile('Absent', a.absent_days, true)}
        {tile('On time', a.on_time)}
        {tile('Late ≤15 min', a.late_upto_15)}
        {tile('Late 15–30 min', a.late_15_30, true)}
        {tile('Late >30 min', a.late_over_30, true)}
        {tile('Early exits', a.early_exits, true)}
        {tile('Salary cut (days)', a.penalty_days, true)}
      </div>
      <p style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0 0' }}>
        Punctuality from on-time %: {(a.bands || []).map((b) => `≥${b.min_pct}% = ${b.rating}`).join(' · ')}.
        {' '}Leave from days off: {(a.leave_bands || []).map((b) => (b.max_days == null ? `more = ${b.rating}` : `≤${b.max_days} = ${b.rating}`)).join(' · ')}.
        {' '}Both tables: Attendance → Configuration → Settings. Saved with your review.
      </p>
    </section>
  );
}

export default function TeamReviews({ team, reload, onToast }) {
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const start = (r) => {
    setOpen(r);
    setForm({
      manager_rating: Number(r.manager_rating) || 0, final_rating: Number(r.final_rating) || 0,
      kra_score: r.kra_score ?? '', behavioral_score: r.behavioral_score ?? '', manager_comments: r.manager_comments || '',
      promotion_recommendation: !!r.promotion_recommendation, salary_revision_percentage: r.salary_revision_percentage ?? '',
    });
  };

  const submit = async () => {
    if (!form.manager_rating || !form.final_rating) { onToast('Manager rating and final rating are required', 'error'); return; }
    setSaving(true);
    try {
      await api.post(`/performance/reviews/${open.id}/manager-review`, {
        ...form,
        kra_score: Number(form.kra_score) || null,
        behavioral_score: Number(form.behavioral_score) || null,
        salary_revision_percentage: Number(form.salary_revision_percentage) || 0,
      });
      onToast(`Review of ${open.employee_name} submitted`);
      setOpen(null);
      reload();
    } catch (e) {
      onToast(submitErrorMessage(e, 'Failed to submit the review'), 'error');
    } finally { setSaving(false); }
  };

  if (!team.length) {
    return <p style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Nobody reports to you, so there are no team reviews.</p>;
  }

  return (
    <div className="prf-card">
      <h2 className="prf-card-title"><Users size={16} style={{ verticalAlign: -3 }} /> My Team</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {team.map(r => {
          const st = STATUS[r.status] || { label: r.status, color: '#6b7280' };
          return (
            <div key={r.id} className="prf-team-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.employee_name}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {[r.designation, r.cycle_name || r.review_period].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 120 }}>
                Self: {r.self_rating ? `${Number(r.self_rating)} / 5` : '—'}
                {r.final_rating ? ` · Final: ${Number(r.final_rating)} / 5` : ''}
              </div>
              <span className="prf-team-chip" style={{ color: st.color, borderColor: st.color }}>
                {r.status === 'completed' ? <CheckCircle size={12} /> : <Clock size={12} />} {st.label}
              </span>
              {st.canReview && (
                <button className="prf-btn-primary" onClick={() => start(r)}>
                  {r.status === 'manager_submitted' ? 'Update review' : 'Review'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {open && (
        <div className="prf-overlay" onClick={() => setOpen(null)}>
          <div className="prf-mgr-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Review ${open.employee_name}`}>
            <div className="prf-mgr-modal-hd">
              <div>
                <h3>Manager Review</h3>
                <p className="prf-drawer-sub">{open.employee_name} · {open.cycle_name || open.review_period}</p>
              </div>
              <button className="prf-drawer-close" onClick={() => setOpen(null)} aria-label="Close"><X size={20} /></button>
            </div>
            <div className="prf-mgr-modal-body">
              <section className="prf-self-summary">
                <label className="prf-field-label">Their self-assessment</label>
                <p><b>Self rating:</b> {open.self_rating ? `${Number(open.self_rating)} / 5 — ${RATING[Math.round(open.self_rating)]}` : 'Not given'}</p>
                {open.achievements && <p><b>Highlights:</b> {open.achievements}</p>}
                {open.challenges && <p><b>Challenges:</b> {open.challenges}</p>}
                {open.learnings && <p><b>Learnings:</b> {open.learnings}</p>}
                {open.next_goals && <p><b>Next period:</b> {open.next_goals}</p>}
              </section>
              <ReviewAttendance reviewId={open.id} />
              <section>
                <label className="prf-field-label">Your rating *</label>
                <Stars label="Manager rating" value={form.manager_rating} onChange={v => setForm(f => ({ ...f, manager_rating: v }))} />
              </section>
              <section>
                <label className="prf-field-label">Final rating *</label>
                <Stars label="Final rating" value={form.final_rating} onChange={v => setForm(f => ({ ...f, final_rating: v }))} />
              </section>
              <div className="prf-mgr-row">
                <section>
                  <label className="prf-field-label">KRA score (0–100)</label>
                  <input className="prf-input" type="number" min="0" max="100" value={form.kra_score}
                    onChange={e => setForm(f => ({ ...f, kra_score: e.target.value }))} />
                </section>
                <section>
                  <label className="prf-field-label">Behavioural score (0–100)</label>
                  <input className="prf-input" type="number" min="0" max="100" value={form.behavioral_score}
                    onChange={e => setForm(f => ({ ...f, behavioral_score: e.target.value }))} />
                </section>
              </div>
              <section>
                <label className="prf-field-label">Your comments</label>
                <textarea className="prf-textarea" rows={4} aria-label="Manager comments"
                  placeholder="Strengths you saw, what to improve, support they need…"
                  value={form.manager_comments} onChange={e => setForm(f => ({ ...f, manager_comments: e.target.value }))} />
              </section>
              <div className="prf-mgr-row">
                <section>
                  <label className="prf-field-label">Salary revision (%)</label>
                  <input className="prf-input" type="number" min="0" max="100" value={form.salary_revision_percentage}
                    onChange={e => setForm(f => ({ ...f, salary_revision_percentage: e.target.value }))} />
                </section>
                <section style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 22 }}>
                  <input type="checkbox" id="team-promo" checked={form.promotion_recommendation}
                    onChange={e => setForm(f => ({ ...f, promotion_recommendation: e.target.checked }))} />
                  <label htmlFor="team-promo" className="prf-field-label" style={{ cursor: 'pointer' }}>Recommend for promotion</label>
                </section>
              </div>
            </div>
            <div className="prf-drawer-footer">
              <button className="prf-btn-ghost" onClick={() => setOpen(null)}>Cancel</button>
              <button className="prf-btn-primary" onClick={submit} disabled={saving}>
                {saving ? 'Submitting…' : 'Submit review'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
