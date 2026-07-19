import { useState, useEffect, useCallback } from 'react';
import {
  Star, Target, TrendingUp, Award, ChevronRight, X,
  CheckCircle, Clock, AlertCircle, User, BarChart2,
  FileText, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, Cell
} from 'recharts';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import './PerformanceReviews.css';

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
      {action}
    </div>
  );
}

const RATING_LABELS = { 1: 'Poor', 2: 'Below Average', 3: 'Meets Expectations', 4: 'Exceeds Expectations', 5: 'Outstanding' };
const STATUS_META = {
  on_track:  { label: 'On Track',  color: '#22c55e', bg: '#f0fdf4' },
  at_risk:   { label: 'At Risk',   color: '#f59e0b', bg: '#fffbeb' },
  completed: { label: 'Completed', color: '#6366f1', bg: '#eef2ff' },
  overdue:   { label: 'Overdue',   color: '#ef4444', bg: '#fef2f2' },
};

/* ── helpers ────────────────────────────────────────── */
const StarRating = ({ value, onChange, readOnly = false }) => (
  <div className="prf-stars">
    {[1,2,3,4,5].map(s => (
      <Star
        key={s}
        size={22}
        className={`prf-star ${s <= (value || 0) ? 'prf-star-filled' : ''} ${readOnly ? 'prf-star-ro' : ''}`}
        onClick={() => !readOnly && onChange && onChange(s)}
      />
    ))}
    {value ? <span className="prf-star-label">{RATING_LABELS[value]}</span> : null}
  </div>
);

const Toast = ({ toast, onClose }) => {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`prf-toast prf-toast-${toast.type}`}>
      {toast.type === 'success' ? <CheckCircle size={16}/> : <AlertCircle size={16}/>}
      {toast.msg}
    </div>
  );
};

/* ── Self Assessment Drawer ─────────────────────────── */
function SelfAssessmentDrawer({ review, onClose, onSubmit }) {
  const toast = useToast();
  const [form, setForm] = useState({
    self_rating: review?.self_rating || 0,
    highlights: '',
    challenges: '',
    learnings: '',
    next_goals: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.self_rating) { toast.error('Please select a self rating'); return; }
    setSaving(true);
    try {
      await api.post(`/performance/reviews/${review.id}/self-review`, form);
    } catch (_) {}
    onSubmit({ ...form });
    setSaving(false);
  };

  return (
    <>
      <div className="prf-overlay" onClick={onClose}/>
      <div className="prf-drawer">
        <div className="prf-drawer-header">
          <div>
            <h3>Self Assessment</h3>
            <p className="prf-drawer-sub">{review?.cycle} · {review?.period}</p>
          </div>
          <button className="prf-drawer-close" onClick={onClose}><X size={20}/></button>
        </div>
        <div className="prf-drawer-body">
          <section>
            <label className="prf-field-label">Overall Self Rating *</label>
            <StarRating value={form.self_rating} onChange={v => set('self_rating', v)}/>
          </section>
          <section>
            <label className="prf-field-label">Key Highlights & Achievements</label>
            <textarea
              className="prf-textarea"
              rows={4}
              placeholder="What did you accomplish this period?"
              value={form.highlights}
              onChange={e => set('highlights', e.target.value)}
            />
          </section>
          <section>
            <label className="prf-field-label">Challenges Faced</label>
            <textarea
              className="prf-textarea"
              rows={3}
              placeholder="What obstacles did you encounter?"
              value={form.challenges}
              onChange={e => set('challenges', e.target.value)}
            />
          </section>
          <section>
            <label className="prf-field-label">Learnings & Development</label>
            <textarea
              className="prf-textarea"
              rows={3}
              placeholder="What skills or knowledge did you develop?"
              value={form.learnings}
              onChange={e => set('learnings', e.target.value)}
            />
          </section>
          <section>
            <label className="prf-field-label">Goals for Next Period</label>
            <textarea
              className="prf-textarea"
              rows={3}
              placeholder="What do you aim to achieve next quarter?"
              value={form.next_goals}
              onChange={e => set('next_goals', e.target.value)}
            />
          </section>
        </div>
        <div className="prf-drawer-footer">
          <button className="prf-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="prf-btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Submitting…' : 'Submit Self Assessment'}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Goal Detail Expand ─────────────────────────────── */
function GoalRow({ goal }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[goal.status] || STATUS_META.on_track;
  return (
    <div className="prf-goal-row">
      <div className="prf-goal-top" onClick={() => setOpen(o => !o)}>
        <div className="prf-goal-left">
          <span className="prf-goal-badge" style={{ background: meta.bg, color: meta.color }}>{meta.label}</span>
          <span className="prf-goal-title">{goal.title}</span>
          <span className="prf-goal-cat">{goal.category}</span>
        </div>
        <div className="prf-goal-right">
          <span className="prf-goal-pct">{goal.progress}%</span>
          <div className="prf-goal-bar-wrap">
            <div className="prf-goal-bar-fill" style={{ width: `${goal.progress}%`, background: meta.color }}/>
          </div>
          <span className="prf-goal-weight">Wt: {goal.weight}%</span>
          {open ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
        </div>
      </div>
      {open && (
        <div className="prf-goal-detail">
          <div className="prf-goal-detail-row">
            <span>Due Date</span><strong>{goal.due}</strong>
          </div>
          <div className="prf-goal-detail-row">
            <span>Progress</span><strong>{goal.progress} / {goal.target} units</strong>
          </div>
          <div className="prf-goal-detail-row">
            <span>Weight</span><strong>{goal.weight}% of total score</strong>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Component ─────────────────────────────────── */
export default function PerformanceReviews() {
  const { user: _user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [review, setReview] = useState(null);
  const [goals, setGoals] = useState([]);
  const [competencies, setCompetencies] = useState([]);
  const [history, setHistory] = useState([]);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [mgr, setMgr] = useState({ manager_rating: 0, manager_comments: '', kra_score: '', behavioral_score: '', final_rating: '', promotion_recommendation: false, salary_revision_percentage: '' });
  const [mgrSaving, setMgrSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [revRes, goalsRes, compRes, histRes] = await Promise.allSettled([
      api.get('/performance/review/current'),
      api.get('/performance/goals'),
      api.get('/performance/competencies'),
      api.get('/performance/history'),
    ]);
    if (revRes.status === 'fulfilled' && revRes.value?.data) {
      const rd = revRes.value.data;
      setReview({
        id:                 rd.id,
        period:             rd.review_period || 'Current Period',
        cycle:              rd.cycle_name    || 'Performance Review',
        status:             rd.status        || 'self_review_pending',
        self_rating:        rd.self_rating   || null,
        manager_rating:     rd.manager_rating || null,
        final_rating:       rd.final_rating  || null,
        self_submitted_at:  rd.self_submitted_at,
        manager_reviewed_at:rd.manager_submitted_at,
        strengths:          rd.achievements  || '',
        improvements:       rd.challenges    || '',
        manager_comments:   rd.manager_comments || '',
        employee_name:      rd.employee_name || '',
        manager_name:       rd.manager_name  || '',
        kra_score:          rd.kra_score     || null,
        behavioral_score:   rd.behavioral_score || null,
      });
    }
    if (goalsRes.status === 'fulfilled' && Array.isArray(goalsRes.value?.data) && goalsRes.value.data.length) {
      setGoals(goalsRes.value.data.map(g => ({
        id:       g.id,
        title:    g.goal_title || g.title || '—',
        category: g.category   || '—',
        progress: Number(g.progress_pct || 0),
        target:   Number(g.target_value || 100),
        status:   g.status === 'achieved' ? 'completed' : g.status === 'at_risk' ? 'at_risk' : g.status === 'overdue' ? 'overdue' : 'on_track',
        due:      g.due_date ? new Date(g.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—',
        weight:   Number(g.weightage || 0),
      })));
    }
    if (compRes.status === 'fulfilled' && Array.isArray(compRes.value?.data) && compRes.value.data.length) {
      setCompetencies(compRes.value.data);
    }
    if (histRes.status === 'fulfilled' && Array.isArray(histRes.value?.data) && histRes.value.data.length) {
      setHistory(histRes.value.data.map(h => ({
        id:          h.id,
        cycle:       h.cycle_name || h.review_period || '—',
        period:      h.review_period || '—',
        final_rating:Number(h.final_rating || h.overall_rating || 0),
        manager:     h.manager_name || '—',
        completed_at:h.manager_submitted_at ? new Date(h.manager_submitted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—',
        badge:       h.final_rating >= 4.5 ? 'Outstanding' : h.final_rating >= 3.5 ? 'Exceeds Expectations' : h.final_rating >= 2.5 ? 'Meets Expectations' : 'Below Expectations',
      })));
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSelfSubmit = (data) => {
    setReview(r => ({ ...r, self_rating: data.self_rating, status: 'pending_manager_review', self_submitted_at: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) }));
    setShowDrawer(false);
    showToast('Self assessment submitted successfully');
  };

  const handleManagerSubmit = async () => {
    if (!mgr.manager_rating || !mgr.final_rating) {
      showToast('Manager rating and final rating are required', 'error'); return;
    }
    setMgrSaving(true);
    try {
      await api.post(`/performance/reviews/${review.id}/manager-review`, {
        ...mgr,
        manager_rating: Number(mgr.manager_rating),
        final_rating:   Number(mgr.final_rating),
        kra_score:      Number(mgr.kra_score) || null,
        behavioral_score: Number(mgr.behavioral_score) || null,
        salary_revision_percentage: Number(mgr.salary_revision_percentage) || 0,
      });
      setReview(r => ({ ...r, manager_rating: Number(mgr.manager_rating), final_rating: Number(mgr.final_rating), status: 'completed', manager_comments: mgr.manager_comments }));
      setShowManagerForm(false);
      showToast('Manager review submitted');
    } catch { showToast('Failed to submit manager review', 'error'); }
    finally { setMgrSaving(false); }
  };

  const statusConfig = {
    self_review_pending: { label: 'Self Review Pending', icon: <Clock size={14}/>, color: '#f59e0b' },
    pending_manager_review: { label: 'Awaiting Manager Review', icon: <Clock size={14}/>, color: '#6366f1' },
    completed: { label: 'Review Completed', icon: <CheckCircle size={14}/>, color: '#22c55e' },
    in_progress: { label: 'In Progress', icon: <RefreshCw size={14}/>, color: '#3b82f6' },
  };
  const sc = review ? (statusConfig[review.status] || statusConfig.in_progress) : statusConfig.in_progress;

  const completedGoals = goals.filter(g => g.status === 'completed').length;
  const atRiskGoals    = goals.filter(g => g.status === 'at_risk').length;
  const avgProgress    = goals.length ? Math.round(goals.reduce((s, g) => s + (Number(g.progress) || 0), 0) / goals.length) : 0;

  const historyBarData = history.map(h => ({ name: (h.cycle || '').replace('Annual Review','AR').replace('Mid-Year','MYR'), rating: h.final_rating }));

  if (loading) {
    return (
      <div className="prf-page">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 24px', color: 'var(--color-text-secondary)', gap: 10 }}>
          <RefreshCw size={18} className="prf-spin" />
          Loading your review…
        </div>
      </div>
    );
  }
  if (!review) {
    return (
      <div className="prf-page">
        <EmptyState
          icon={Star}
          title="No active review cycle"
          sub="An admin needs to configure a review cycle in Performance Settings before reviews can be shown."
        />
      </div>
    );
  }

  return (
    <div className="prf-page">
      <Toast toast={toast} onClose={() => setToast(null)}/>
      {showDrawer && (
        <SelfAssessmentDrawer
          review={review}
          onClose={() => setShowDrawer(false)}
          onSubmit={handleSelfSubmit}
        />
      )}

      {/* Header */}
      <div className="prf-header">
        <div>
          <h1 className="prf-title">Performance Reviews</h1>
          <p className="prf-subtitle">{review.cycle} · {review.period}</p>
        </div>
        <div className="prf-header-actions">
          <button className="prf-btn-ghost" onClick={loadData} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'prf-spin' : ''}/>
            Refresh
          </button>
          {review.status === 'self_review_pending' && (
            <button className="prf-btn-primary" onClick={() => setShowDrawer(true)}>
              <FileText size={15}/> Start Self Assessment
            </button>
          )}
          {(review.status === 'self_submitted' || review.status === 'pending_manager_review') && (
            <button className="prf-btn-primary" onClick={() => setShowManagerForm(true)}>
              <Star size={15}/> Submit Manager Review
            </button>
          )}
        </div>
      </div>

      {/* Status Banner */}
      <div className="prf-status-banner" style={{ borderColor: sc.color }}>
        <span className="prf-status-icon" style={{ color: sc.color }}>{sc.icon}</span>
        <span className="prf-status-text" style={{ color: sc.color }}>{sc.label}</span>
        {review.status === 'self_review_pending' && (
          <span className="prf-status-hint">Complete your self assessment to proceed</span>
        )}
        {review.status === 'completed' && review.final_rating && (
          <span className="prf-status-rating">
            Final Rating: <strong>{review.final_rating} / 5.0</strong>
            &nbsp;· {RATING_LABELS[Math.round(review.final_rating)]}
          </span>
        )}
      </div>

      {/* KPI row */}
      <div className="prf-kpi-row">
        {[
          { icon: <Target size={20} color="#6366f1"/>, label: 'Goals Set',       val: goals.length,      sub: `${completedGoals} completed` },
          { icon: <TrendingUp size={20} color="#22c55e"/>, label: 'Avg Progress', val: `${avgProgress}%`,  sub: `${atRiskGoals} at risk` },
          { icon: <Star size={20} color="#f59e0b"/>,  label: 'Self Rating',      val: review.self_rating ? `${review.self_rating} / 5` : '—', sub: review.self_rating ? RATING_LABELS[review.self_rating] : 'Not submitted' },
          { icon: <Award size={20} color="#ec4899"/>, label: 'Last Rating',      val: history[0]?.final_rating ? `${history[0].final_rating} / 5` : '—', sub: history[0]?.badge || '—' },
        ].map(k => (
          <div key={k.label} className="prf-kpi-card">
            <div className="prf-kpi-icon">{k.icon}</div>
            <div>
              <div className="prf-kpi-val">{k.val}</div>
              <div className="prf-kpi-label">{k.label}</div>
              <div className="prf-kpi-sub">{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="prf-tabs">
        {[
          { key: 'overview',      label: 'Overview',      icon: <BarChart2 size={14}/> },
          { key: 'goals',         label: 'Goals & KPIs',  icon: <Target size={14}/> },
          { key: 'competencies',  label: 'Competencies',  icon: <Award size={14}/> },
          { key: 'history',       label: 'History',       icon: <Clock size={14}/> },
        ].map(t => (
          <button
            key={t.key}
            className={`prf-tab ${tab === t.key ? 'prf-tab-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ─── Overview Tab ─── */}
      {tab === 'overview' && (
        <div className="prf-grid">
          {/* Review timeline */}
          <div className="prf-card prf-card-lg">
            <h2 className="prf-card-title">Review Timeline</h2>
            <div className="prf-timeline">
              {[
                { label: 'Review Period Started', date: 'Oct 1 2025', done: true },
                { label: 'Goals Finalized',       date: 'Oct 10 2025', done: true },
                { label: 'Mid-Cycle Check-In',    date: 'Nov 15 2025', done: true },
                { label: 'Self Assessment Due',   date: 'Dec 20 2025', done: review.status !== 'self_review_pending' },
                { label: 'Manager Review',         date: 'Jan 5 2026',  done: review.status === 'completed' },
                { label: 'Final Rating Published', date: 'Jan 15 2026', done: review.status === 'completed' },
              ].map((step, i) => (
                <div key={i} className="prf-timeline-step">
                  <div className={`prf-tl-dot ${step.done ? 'prf-tl-done' : ''}`}>
                    {step.done ? <CheckCircle size={14}/> : <span>{i+1}</span>}
                  </div>
                  <div className="prf-tl-content">
                    <div className="prf-tl-label">{step.label}</div>
                    <div className="prf-tl-date">{step.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Ratings comparison */}
          <div className="prf-card">
            <h2 className="prf-card-title">Rating Breakdown</h2>
            {[
              { label: 'Self Rating',    val: review.self_rating,    color: '#6366f1' },
              { label: 'Manager Rating', val: review.manager_rating, color: '#22c55e' },
              { label: 'Final Rating',   val: review.final_rating,   color: '#f59e0b' },
            ].map(r => (
              <div key={r.label} className="prf-rating-row">
                <span className="prf-rating-label">{r.label}</span>
                <div className="prf-rating-bar-wrap">
                  <div className="prf-rating-bar-fill" style={{ width: r.val ? `${(r.val/5)*100}%` : '0%', background: r.color }}/>
                </div>
                <span className="prf-rating-val" style={{ color: r.color }}>
                  {r.val ? `${r.val} / 5` : '—'}
                </span>
              </div>
            ))}
            {review.manager_comments && (
              <div className="prf-manager-comment">
                <User size={14}/> <strong>Manager's Comment:</strong>
                <p>{review.manager_comments}</p>
              </div>
            )}
          </div>

          {/* Goals summary */}
          <div className="prf-card">
            <h2 className="prf-card-title">Goals Summary</h2>
            <div className="prf-goals-summary-grid">
              {Object.entries(
                goals.reduce((acc, g) => { acc[g.status] = (acc[g.status]||0)+1; return acc; }, {})
              ).map(([status, count]) => {
                const m = STATUS_META[status] || STATUS_META.on_track;
                return (
                  <div key={status} className="prf-gs-chip" style={{ background: m.bg, borderColor: m.color }}>
                    <span className="prf-gs-count" style={{ color: m.color }}>{count}</span>
                    <span className="prf-gs-label">{m.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── Goals Tab ─── */}
      {tab === 'goals' && (
        <div className="prf-card prf-card-full">
          <div className="prf-card-head">
            <h2 className="prf-card-title">Goals & KPIs</h2>
            <span className="prf-card-sub">{goals.length} goals · Weighted average: {avgProgress}%</span>
          </div>
          <div className="prf-goals-list">
            {goals.length === 0 ? (
              <EmptyState icon={Target} title="No goals set" sub="Goals will appear here once assigned" />
            ) : goals.map(g => <GoalRow key={g.id} goal={g}/>)}
          </div>
        </div>
      )}

      {/* ─── Competencies Tab ─── */}
      {tab === 'competencies' && (
        <div className="prf-grid">
          <div className="prf-card prf-card-lg">
            <h2 className="prf-card-title">Competency Radar</h2>
            <ResponsiveContainer width="100%" height={340}>
              <RadarChart data={competencies}>
                <PolarGrid stroke="#e5e7eb"/>
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12 }}/>
                <Radar name="Self" dataKey="self" stroke="#6366f1" fill="#6366f1" fillOpacity={0.25}/>
                <Radar name="Manager" dataKey="manager" stroke="#22c55e" fill="#22c55e" fillOpacity={0.2}/>
                <Tooltip formatter={(v) => `${v} / 5`}/>
              </RadarChart>
            </ResponsiveContainer>
            <div className="prf-radar-legend">
              <span className="prf-legend-dot" style={{ background: '#6366f1' }}/> Self &nbsp;
              <span className="prf-legend-dot" style={{ background: '#22c55e' }}/> Manager
            </div>
          </div>
          <div className="prf-card">
            <h2 className="prf-card-title">Competency Scores</h2>
            <div className="prf-comp-list">
              {competencies.map(c => (
                <div key={c.subject} className="prf-comp-row">
                  <div className="prf-comp-name">{c.subject}</div>
                  <div className="prf-comp-bars">
                    <div className="prf-comp-bar-row">
                      <span>Self</span>
                      <div className="prf-mini-bar-wrap">
                        <div className="prf-mini-bar-fill" style={{ width: `${(c.self/5)*100}%`, background:'#6366f1' }}/>
                      </div>
                      <span>{c.self}</span>
                    </div>
                    <div className="prf-comp-bar-row">
                      <span>Mgr</span>
                      <div className="prf-mini-bar-wrap">
                        <div className="prf-mini-bar-fill" style={{ width: `${(c.manager/5)*100}%`, background:'#22c55e' }}/>
                      </div>
                      <span>{c.manager}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── History Tab ─── */}
      {tab === 'history' && (
        <div className="prf-grid">
          <div className="prf-card prf-card-full">
            <h2 className="prf-card-title">Review History</h2>
            <div className="prf-history-chart">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={historyBarData} barSize={36}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
                  <XAxis dataKey="name" tick={{ fontSize: 12 }}/>
                  <YAxis domain={[0,5]} tick={{ fontSize: 12 }} tickCount={6}/>
                  <Tooltip formatter={(v) => [`${v} / 5`, 'Rating']}/>
                  <Bar dataKey="rating" radius={[6,6,0,0]}>
                    {historyBarData.map((_, i) => (
                      <Cell key={i} fill={i === 0 ? '#6366f1' : '#a5b4fc'}/>
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {history.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af' }}>No completed reviews yet</div>
            ) : (
              <div className="prf-history-list">
                {history.map(h => (
                  <div key={h.id} className="prf-history-row">
                    <div className="prf-hist-cycle">
                      <strong>{h.cycle}</strong>
                      <span>{h.period}</span>
                    </div>
                    <div className="prf-hist-badge">{h.badge}</div>
                    <div className="prf-hist-rating">
                      <span className="prf-hist-score">{h.final_rating}</span>
                      <span className="prf-hist-max">/ 5</span>
                    </div>
                    <div className="prf-hist-meta">
                      <User size={13}/> {h.manager}
                      <span className="prf-hist-date">· {h.completed_at}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Manager Review Modal ─── */}
      {showManagerForm && (
        <div className="prf-overlay" onClick={() => setShowManagerForm(false)}>
          <div className="prf-mgr-modal" onClick={e => e.stopPropagation()}>
            <div className="prf-mgr-modal-hd">
              <div>
                <h3>Manager Review</h3>
                <p className="prf-drawer-sub">{review.employee_name} · {review.cycle}</p>
              </div>
              <button className="prf-drawer-close" onClick={() => setShowManagerForm(false)}><X size={20}/></button>
            </div>
            <div className="prf-mgr-modal-body">
              <section>
                <label className="prf-field-label">Manager Rating *</label>
                <StarRating value={mgr.manager_rating} onChange={v => setMgr(m => ({ ...m, manager_rating: v }))} />
              </section>
              <section>
                <label className="prf-field-label">Final Rating *</label>
                <StarRating value={mgr.final_rating} onChange={v => setMgr(m => ({ ...m, final_rating: v }))} />
              </section>
              <div className="prf-mgr-row">
                <section>
                  <label className="prf-field-label">KRA Score (0–100)</label>
                  <input className="prf-input" type="number" min="0" max="100"
                    placeholder="85" value={mgr.kra_score}
                    onChange={e => setMgr(m => ({ ...m, kra_score: e.target.value }))} />
                </section>
                <section>
                  <label className="prf-field-label">Behavioral Score (0–100)</label>
                  <input className="prf-input" type="number" min="0" max="100"
                    placeholder="80" value={mgr.behavioral_score}
                    onChange={e => setMgr(m => ({ ...m, behavioral_score: e.target.value }))} />
                </section>
              </div>
              <section>
                <label className="prf-field-label">Manager Comments</label>
                <textarea className="prf-textarea" rows={4}
                  placeholder="Overall feedback, strengths observed, areas for improvement…"
                  value={mgr.manager_comments}
                  onChange={e => setMgr(m => ({ ...m, manager_comments: e.target.value }))} />
              </section>
              <div className="prf-mgr-row">
                <section>
                  <label className="prf-field-label">Salary Revision (%)</label>
                  <input className="prf-input" type="number" min="0" max="100"
                    placeholder="0" value={mgr.salary_revision_percentage}
                    onChange={e => setMgr(m => ({ ...m, salary_revision_percentage: e.target.value }))} />
                </section>
                <section style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 22 }}>
                  <input type="checkbox" id="promo" checked={mgr.promotion_recommendation}
                    onChange={e => setMgr(m => ({ ...m, promotion_recommendation: e.target.checked }))} />
                  <label htmlFor="promo" className="prf-field-label" style={{ cursor: 'pointer' }}>Recommend for Promotion</label>
                </section>
              </div>
            </div>
            <div className="prf-drawer-footer">
              <button className="prf-btn-ghost" onClick={() => setShowManagerForm(false)}>Cancel</button>
              <button className="prf-btn-primary" onClick={handleManagerSubmit} disabled={mgrSaving}>
                {mgrSaving ? 'Submitting…' : 'Submit Manager Review'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
