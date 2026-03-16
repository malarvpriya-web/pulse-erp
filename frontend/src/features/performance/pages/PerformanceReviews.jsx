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
import api from '@/services/api/client';
import './PerformanceReviews.css';

/* ── sample data ────────────────────────────────────── */
const SAMPLE_REVIEW = {
  id: 1,
  period: 'Q4 2025 (Oct – Dec)',
  cycle: 'Annual Review 2025',
  status: 'self_review_pending',
  self_rating: null,
  manager_rating: null,
  final_rating: null,
  self_submitted_at: null,
  manager_reviewed_at: null,
  strengths: '',
  improvements: '',
  manager_comments: '',
};

const SAMPLE_GOALS = [
  { id: 1, title: 'Deliver Q4 feature roadmap', category: 'Delivery', progress: 85, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 30 },
  { id: 2, title: 'Reduce bug backlog by 40%', category: 'Quality', progress: 62, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 20 },
  { id: 3, title: 'Complete React advanced course', category: 'Learning', progress: 40, target: 100, status: 'at_risk', due: 'Dec 31 2025', weight: 15 },
  { id: 4, title: 'Mentor 2 junior developers', category: 'Leadership', progress: 100, target: 100, status: 'completed', due: 'Oct 15 2025', weight: 20 },
  { id: 5, title: 'Improve code review turnaround', category: 'Process', progress: 70, target: 100, status: 'on_track', due: 'Dec 31 2025', weight: 15 },
];

const SAMPLE_COMPETENCIES = [
  { subject: 'Technical Skills', self: 4.2, manager: 3.8, fullMark: 5 },
  { subject: 'Communication', self: 3.5, manager: 3.9, fullMark: 5 },
  { subject: 'Leadership', self: 3.8, manager: 4.1, fullMark: 5 },
  { subject: 'Problem Solving', self: 4.5, manager: 4.2, fullMark: 5 },
  { subject: 'Collaboration', self: 4.0, manager: 4.3, fullMark: 5 },
  { subject: 'Innovation', self: 3.6, manager: 3.5, fullMark: 5 },
];

const SAMPLE_HISTORY = [
  { id: 1, cycle: 'Annual Review 2024', period: 'Jan – Dec 2024', final_rating: 4.1, manager: 'Priya Mehta', completed_at: 'Jan 15 2025', badge: 'Exceeds Expectations' },
  { id: 2, cycle: 'Mid-Year 2024', period: 'Jan – Jun 2024', final_rating: 3.8, manager: 'Priya Mehta', completed_at: 'Jul 10 2024', badge: 'Meets Expectations' },
  { id: 3, cycle: 'Annual Review 2023', period: 'Jan – Dec 2023', final_rating: 3.5, manager: 'Rahul Singh', completed_at: 'Jan 20 2024', badge: 'Meets Expectations' },
];

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
    if (!form.self_rating) { alert('Please select a self rating'); return; }
    setSaving(true);
    try {
      await api.post(`/performance/reviews/${review.id}/self-assessment`, form);
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
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [review, setReview] = useState(SAMPLE_REVIEW);
  const [goals, setGoals] = useState(SAMPLE_GOALS);
  const [competencies, setCompetencies] = useState(SAMPLE_COMPETENCIES);
  const [history, setHistory] = useState(SAMPLE_HISTORY);
  const [showDrawer, setShowDrawer] = useState(false);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [revRes, goalsRes, compRes, histRes] = await Promise.allSettled([
      api.get('/performance/review/current'),
      api.get('/performance/goals'),
      api.get('/performance/competencies'),
      api.get('/performance/history'),
    ]);
    if (revRes.status === 'fulfilled' && revRes.value.data) setReview(revRes.value.data);
    if (goalsRes.status === 'fulfilled' && goalsRes.value.data?.length) setGoals(goalsRes.value.data);
    if (compRes.status === 'fulfilled' && compRes.value.data?.length) setCompetencies(compRes.value.data);
    if (histRes.status === 'fulfilled' && histRes.value.data?.length) setHistory(histRes.value.data);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSelfSubmit = (data) => {
    setReview(r => ({ ...r, self_rating: data.self_rating, status: 'pending_manager_review', self_submitted_at: new Date().toLocaleDateString('en-IN') }));
    setShowDrawer(false);
    showToast('Self assessment submitted successfully');
  };

  const statusConfig = {
    self_review_pending: { label: 'Self Review Pending', icon: <Clock size={14}/>, color: '#f59e0b' },
    pending_manager_review: { label: 'Awaiting Manager Review', icon: <Clock size={14}/>, color: '#6366f1' },
    completed: { label: 'Review Completed', icon: <CheckCircle size={14}/>, color: '#22c55e' },
    in_progress: { label: 'In Progress', icon: <RefreshCw size={14}/>, color: '#3b82f6' },
  };
  const sc = statusConfig[review.status] || statusConfig.in_progress;

  const completedGoals = goals.filter(g => g.status === 'completed').length;
  const atRiskGoals    = goals.filter(g => g.status === 'at_risk').length;
  const avgProgress    = Math.round(goals.reduce((s, g) => s + g.progress, 0) / goals.length);

  const historyBarData = history.map(h => ({ name: h.cycle.replace('Annual Review','AR').replace('Mid-Year','MYR'), rating: h.final_rating }));

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
            {goals.map(g => <GoalRow key={g.id} goal={g}/>)}
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
          </div>
        </div>
      )}
    </div>
  );
}
