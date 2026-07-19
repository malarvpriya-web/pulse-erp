import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Briefcase, Users, Calendar, CheckCircle, Clock,
  Plus, X, ChevronRight, RefreshCw,
  MapPin, Mail, Phone, Star, Eye, Send, Filter, Search, UserCheck
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Cell, PieChart, Pie,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './RecruitmentDashboard.css';

// Active Kanban stages — dead-end stages visible in All Candidates, not Kanban
const KANBAN_STAGES = ['applied', 'screening', '1st_level', '2nd_level', 'offer', 'hired'];

const STAGE_LABELS = {
  applied:      'Applied',
  screening:    'Screening',
  '1st_level':  '1st Interview',
  '2nd_level':  '2nd Interview',
  offer:        'Offer',
  hired:        'Hired',
  not_suitable: 'Not Suitable',
  maybe:        'Maybe',
  future_use:   'Future Use',
  rejected:     'Rejected',
};

const STAGE_COLORS = {
  applied:      { color: '#64748b', bg: '#f1f5f9' },
  screening:    { color: '#3b82f6', bg: '#eff6ff' },
  '1st_level':  { color: '#8b5cf6', bg: '#f5f3ff' },
  '2nd_level':  { color: '#a855f7', bg: '#faf5ff' },
  offer:        { color: '#f59e0b', bg: '#fffbeb' },
  hired:        { color: '#22c55e', bg: '#f0fdf4' },
  not_suitable: { color: '#ef4444', bg: '#fef2f2' },
  maybe:        { color: '#06b6d4', bg: '#ecfeff' },
  future_use:   { color: '#6366f1', bg: '#eef2ff' },
  rejected:     { color: '#dc2626', bg: '#fff1f2' },
};

// Status colours for Open Positions tab
const STATUS_META = {
  open:   { color: '#15803d', bg: '#dcfce7' },
  draft:  { color: '#6b7280', bg: '#f3f4f6' },
  paused: { color: '#92400e', bg: '#fef3c7' },
  closed: { color: '#dc2626', bg: '#fee2e2' },
};

const SOURCE_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#3b82f6', '#06b6d4'];

const fmt    = (v) => v ?? 0;
const fmtPct = (v) => v != null && isFinite(v) ? `${Number(v).toFixed(1)}%` : 'N/A';

/* ── Schedule Interview Drawer ──────────────────────────────────────── */
function ScheduleDrawer({ candidate, candidates, onClose, onSchedule }) {
  const toast = useToast();
  const [form, setForm] = useState({
    candidate_id: candidate?.id || '',
    date: '', time: '', mode: 'offline', interviewer: '', notes: '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.candidate_id) return toast({ message: 'Select a candidate', type: 'error' });
    if (!form.date || !form.time) return toast({ message: 'Date and time are required', type: 'error' });
    try {
      await api.post('/recruitment/interviews', {
        candidate_id:   form.candidate_id,
        interview_date: form.date,
        interview_time: form.time,
        interview_mode: form.mode,
        notes: form.interviewer ? `Interviewer: ${form.interviewer}${form.notes ? ' — ' + form.notes : ''}` : form.notes,
      });
      onSchedule();
    } catch (err) {
      toast({ message: err.response?.data?.error || 'Failed to schedule interview.', type: 'error' });
    }
  };

  const selectedCand = candidates.find(c => c.id === form.candidate_id) || candidate;

  return (
    <>
      <div className="rec-overlay" onClick={onClose} />
      <div className="rec-drawer">
        <div className="rec-drawer-header">
          <div>
            <h3>Schedule Interview</h3>
            {selectedCand?.full_name && (
              <p className="rec-drawer-sub">{selectedCand.full_name} · {selectedCand.job_title}</p>
            )}
          </div>
          <button className="rec-drawer-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="rec-drawer-body">
          {/* Only show candidate picker when not opened from a specific candidate */}
          {!candidate?.id && (
            <div className="rec-field">
              <label className="rec-field-label">Candidate *</label>
              <select className="rec-select" value={form.candidate_id} onChange={e => set('candidate_id', e.target.value)}>
                <option value="">Select candidate…</option>
                {candidates.map(c => (
                  <option key={c.id} value={c.id}>{c.full_name} — {c.job_title || ''}</option>
                ))}
              </select>
            </div>
          )}
          <div className="rec-field-row">
            <div className="rec-field">
              <label className="rec-field-label">Date *</label>
              <input className="rec-input" type="date" value={form.date} onChange={e => set('date', e.target.value)} />
            </div>
            <div className="rec-field">
              <label className="rec-field-label">Time *</label>
              <input className="rec-input" type="time" value={form.time} onChange={e => set('time', e.target.value)} />
            </div>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Mode</label>
            <select className="rec-select" value={form.mode} onChange={e => set('mode', e.target.value)}>
              <option value="offline">In Person</option>
              <option value="online">Online</option>
              <option value="phone">Phone</option>
            </select>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Interviewer</label>
            <input className="rec-input" placeholder="Interviewer name" value={form.interviewer}
              onChange={e => set('interviewer', e.target.value)} />
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Notes</label>
            <textarea className="rec-textarea" rows={3} value={form.notes}
              onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
        <div className="rec-drawer-footer">
          <button className="rec-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="rec-btn-primary" onClick={handleSubmit}>
            <Calendar size={14} /> Schedule
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Create Offer Drawer ────────────────────────────────────────────── */
function SendOfferDrawer({ candidate, openings, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    offered_salary: '',
    joining_date: '',
    job_opening_id: candidate?.job_opening_id || '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.offered_salary) return toast({ message: 'Offered salary is required', type: 'error' });
    setSaving(true);
    try {
      await api.post('/recruitment/offers', {
        candidate_id:   candidate.id,
        job_opening_id: form.job_opening_id || null,
        offered_salary: form.offered_salary,
        joining_date:   form.joining_date || null,
        notes:          form.notes || null,
      });
      toast({ message: `Offer created for ${candidate.full_name}`, type: 'success' });
      onSaved();
    } catch (e) {
      toast({ message: e.response?.data?.error || 'Failed to create offer', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="rec-overlay" onClick={onClose} />
      <div className="rec-drawer">
        <div className="rec-drawer-header">
          <div>
            <h3>Create Offer</h3>
            <p className="rec-drawer-sub">{candidate.full_name} · {candidate.job_title}</p>
          </div>
          <button className="rec-drawer-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="rec-drawer-body">
          <div className="rec-field">
            <label className="rec-field-label">Job Opening</label>
            <select className="rec-select" value={form.job_opening_id} onChange={e => set('job_opening_id', e.target.value)}>
              <option value="">Select opening…</option>
              {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}</option>)}
            </select>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Annual CTC (₹) *</label>
            <input className="rec-input" type="number" min="0" placeholder="e.g. 600000"
              value={form.offered_salary} onChange={e => set('offered_salary', e.target.value)} />
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Joining Date</label>
            <input className="rec-input" type="date" value={form.joining_date}
              onChange={e => set('joining_date', e.target.value)} />
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Notes</label>
            <textarea className="rec-textarea" rows={3} value={form.notes}
              onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
        <div className="rec-drawer-footer">
          <button className="rec-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="rec-btn-primary" onClick={handleSave} disabled={saving}>
            <Send size={14} /> {saving ? 'Creating…' : 'Create Offer'}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Candidate Detail Drawer ────────────────────────────────────────── */
function CandidateDrawer({ candidate, onClose, onStageChange, onSchedule, onSendOffer }) {
  if (!candidate) return null;
  const sc = STAGE_COLORS[candidate.current_stage] || STAGE_COLORS.applied;
  return (
    <>
      <div className="rec-overlay" onClick={onClose} />
      <div className="rec-drawer rec-drawer-wide">
        <div className="rec-drawer-header">
          <div className="rec-cand-drawer-title">
            <div className="rec-avatar-lg">
              {(candidate.full_name || '?')[0].toUpperCase()}
            </div>
            <div>
              <h3>{candidate.full_name}</h3>
              <p className="rec-drawer-sub">{candidate.job_title}</p>
            </div>
          </div>
          <button className="rec-drawer-close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="rec-drawer-body">
          <div className="rec-cand-meta">
            <span><Mail size={13} /> {candidate.email}</span>
            <span><Phone size={13} /> {candidate.phone}</span>
          </div>
          <div className="rec-cand-stage-row">
            <span className="rec-stage-chip" style={{ background: sc.bg, color: sc.color }}>
              {STAGE_LABELS[candidate.current_stage] || candidate.current_stage}
            </span>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Move to Stage</label>
            <div className="rec-stage-pills">
              {KANBAN_STAGES.map(s => {
                const sc2 = STAGE_COLORS[s];
                return (
                  <button
                    key={s}
                    className={`rec-stage-pill ${candidate.current_stage === s ? 'rec-stage-pill-active' : ''}`}
                    style={candidate.current_stage === s
                      ? { background: sc2.bg, color: sc2.color, borderColor: sc2.color }
                      : {}}
                    onClick={() => onStageChange(candidate.id, s)}
                  >
                    {STAGE_LABELS[s]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="rec-drawer-footer">
          <button className="rec-btn-ghost" onClick={() => onSchedule(candidate)}>
            <Calendar size={14} /> Schedule Interview
          </button>
          <button className="rec-btn-primary" onClick={() => onSendOffer(candidate)}>
            <Send size={14} /> Create Offer
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Main Component ─────────────────────────────────────────────────── */
export default function RecruitmentDashboard({ setPage }) {
  const [tab, setTab]                         = useState('pipeline');
  const [kpis, setKpis]                       = useState(null);
  const [positions, setPositions]             = useState([]);
  const [candidates, setCandidates]           = useState([]);
  const [interviews, setInterviews]           = useState([]);
  const [pipelineCounts, setPipelineCounts]   = useState([]);
  const [sourceData, setSourceData]           = useState([]);
  const [search, setSearch]                   = useState('');
  const [stageFilter, setStageFilter]         = useState('all');
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [scheduleFor, setScheduleFor]         = useState(null); // candidate obj or null (null = pick from list)
  const [offerFor, setOfferFor]               = useState(null);
  const [loading, setLoading]                 = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const _toast = useToast();
  const showToast = (msg, type = 'success') => _toast({ message: msg, type });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [kpiRes, posRes, canRes, intRes, pipeRes, srcRes] = await Promise.allSettled([
      api.get('/recruitment/dashboard-summary'),
      api.get('/recruitment/openings'),
      api.get('/recruitment/candidates'),
      api.get('/recruitment/interviews'),
      api.get('/recruitment/pipeline-summary'),
      api.get('/recruitment/analytics/source'),
    ]);
    if (!isMounted.current) return;
    setKpis(kpiRes.status === 'fulfilled' ? kpiRes.value.data : null);
    setPositions(posRes.status === 'fulfilled' && Array.isArray(posRes.value.data) ? posRes.value.data : []);
    setCandidates(canRes.status === 'fulfilled' && Array.isArray(canRes.value.data) ? canRes.value.data : []);
    setInterviews(intRes.status === 'fulfilled' && Array.isArray(intRes.value.data) ? intRes.value.data : []);
    setPipelineCounts(pipeRes.status === 'fulfilled' && Array.isArray(pipeRes.value.data) ? pipeRes.value.data : []);
    setSourceData(srcRes.status === 'fulfilled' && Array.isArray(srcRes.value.data) ? srcRes.value.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleStageChange = async (id, newStage) => {
    setCandidates(cs => cs.map(c => c.id === id ? { ...c, current_stage: newStage } : c));
    setSelectedCandidate(prev => prev?.id === id ? { ...prev, current_stage: newStage } : prev);
    try {
      await api.post(`/recruitment/candidates/${id}/move-stage`, { new_stage: newStage });
      showToast(`Candidate moved to ${STAGE_LABELS[newStage] || newStage}`);
    } catch {
      loadData();
      showToast('Failed to update stage', 'error');
    }
  };

  const handleScheduled = () => {
    setScheduleFor(null);
    setSelectedCandidate(null);
    showToast('Interview scheduled');
    loadData();
  };

  // Only show Kanban-active stages in pipeline view
  const filteredCandidates = candidates.filter(c => {
    const matchSearch = !search ||
      (c.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.job_title || '').toLowerCase().includes(search.toLowerCase());
    const matchStage = stageFilter === 'all' || c.current_stage === stageFilter;
    return matchSearch && matchStage;
  });

  const funnelChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={pipelineCounts} barSize={40}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
        <XAxis dataKey="stage" tickFormatter={s => STAGE_LABELS[s] || s} tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip labelFormatter={s => STAGE_LABELS[s] || s} />
        <Bar dataKey="count" radius={[6, 6, 0, 0]}>
          {pipelineCounts.map((p, i) => (
            <Cell key={i} fill={p.color || '#6366f1'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const sourceChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={sourceData}
          cx="50%"
          cy="50%"
          innerRadius={inner}
          outerRadius={outer}
          dataKey="count"
          nameKey="source"
          label={({ source, percent }) => `${source} ${(percent * 100).toFixed(0)}%`}
          labelLine={false}
        >
          {sourceData.map((_, i) => (
            <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v, n) => [v, n]} />
      </PieChart>
    </ResponsiveContainer>
  );

  return (
    <div className="rec-page">
      {/* Schedule Interview drawer — may have a pre-selected candidate or open picker */}
      {scheduleFor !== null && (
        <ScheduleDrawer
          candidate={scheduleFor.id ? scheduleFor : null}
          candidates={candidates}
          onClose={() => setScheduleFor(null)}
          onSchedule={handleScheduled}
        />
      )}

      {/* Create Offer drawer */}
      {offerFor && (
        <SendOfferDrawer
          candidate={offerFor}
          openings={positions}
          onClose={() => setOfferFor(null)}
          onSaved={() => { setOfferFor(null); setSelectedCandidate(null); loadData(); }}
        />
      )}

      {selectedCandidate && scheduleFor === null && !offerFor && (
        <CandidateDrawer
          candidate={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          onStageChange={handleStageChange}
          onSchedule={(c) => { setSelectedCandidate(null); setScheduleFor(c); }}
          onSendOffer={(c) => { setSelectedCandidate(null); setOfferFor(c); }}
        />
      )}

      {/* Header */}
      <div className="rec-header">
        <div>
          <h1 className="rec-title">Recruitment Dashboard</h1>
          <p className="rec-subtitle">Track hiring pipeline, interviews, and offers</p>
        </div>
        <div className="rec-header-actions">
          <button className="rec-btn-ghost" onClick={loadData} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'rec-spin' : ''} /> Refresh
          </button>
          <button className="rec-btn-primary" onClick={() => setPage && setPage('JobOpenings')}>
            <Plus size={15} /> Post Job
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="rec-kpi-row">
        {[
          {
            icon: <Briefcase size={20} color="#6366f1" />,
            label: 'Open Positions',
            val: fmt(kpis?.open_positions),
            sub: `${positions.filter(p => p.status === 'open').length} active roles`,
            bg: '#f5f3ff',
          },
          {
            icon: <Users size={20} color="#3b82f6" />,
            label: 'Active Candidates',
            val: fmt(kpis?.active_candidates),
            sub: 'In pipeline',
            bg: '#eff6ff',
          },
          {
            icon: <Calendar size={20} color="#f59e0b" />,
            label: 'Interviews Today',
            val: fmt(kpis?.interviews_today),
            sub: 'Scheduled',
            bg: '#fffbeb',
          },
          {
            icon: <CheckCircle size={20} color="#22c55e" />,
            label: 'Pending Offers',
            val: fmt(kpis?.pending_offers),
            sub: `${fmt(kpis?.hired_this_month)} hired this month`,
            bg: '#f0fdf4',
          },
        ].map(k => (
          <div key={k.label} className="rec-kpi-card">
            <div className="rec-kpi-icon" style={{ background: k.bg }}>{k.icon}</div>
            <div>
              <div className="rec-kpi-val">{k.val}</div>
              <div className="rec-kpi-label">{k.label}</div>
              <div className="rec-kpi-sub">{k.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="rec-tabs">
        {[
          { key: 'pipeline',   label: 'Kanban Pipeline' },
          { key: 'positions',  label: 'Open Positions' },
          { key: 'interviews', label: 'Interview Schedule' },
          { key: 'analytics',  label: 'Analytics' },
        ].map(t => (
          <button
            key={t.key}
            className={`rec-tab ${tab === t.key ? 'rec-tab-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Kanban Pipeline ─── */}
      {tab === 'pipeline' && (
        <div>
          <div className="rec-pipeline-toolbar">
            <div className="rec-search-wrap">
              <Search size={14} />
              <input
                className="rec-search"
                placeholder="Search candidates…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="rec-stage-filter">
              {[{ key: 'all', label: 'All' }, ...KANBAN_STAGES.map(s => ({ key: s, label: STAGE_LABELS[s] }))].map(s => (
                <button
                  key={s.key}
                  className={`rec-filter-btn ${stageFilter === s.key ? 'rec-filter-btn-active' : ''}`}
                  onClick={() => setStageFilter(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Pipeline funnel bar */}
          {pipelineCounts.length > 0 && (
            <div className="rec-funnel-row">
              {pipelineCounts
                .filter(p => KANBAN_STAGES.includes(p.stage))
                .map(p => {
                  const maxCount = Math.max(...pipelineCounts.map(x => x.count), 1);
                  const sc = STAGE_COLORS[p.stage] || STAGE_COLORS.applied;
                  return (
                    <div key={p.stage} className="rec-funnel-step">
                      <div className="rec-funnel-bar-wrap">
                        <div
                          className="rec-funnel-bar"
                          style={{
                            height: `${Math.max(20, (p.count / maxCount) * 80)}px`,
                            background: sc.color,
                          }}
                        />
                      </div>
                      <div className="rec-funnel-count" style={{ color: sc.color }}>{p.count}</div>
                      <div className="rec-funnel-label">{STAGE_LABELS[p.stage] || p.stage}</div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Kanban columns */}
          <div className="rec-kanban">
            {KANBAN_STAGES.map(stage => {
              const stageCands = filteredCandidates.filter(c => c.current_stage === stage);
              const sc = STAGE_COLORS[stage];
              return (
                <div key={stage} className="rec-kanban-col">
                  <div className="rec-kanban-head" style={{ borderTopColor: sc.color }}>
                    <span className="rec-kanban-stage" style={{ color: sc.color }}>{STAGE_LABELS[stage]}</span>
                    <span className="rec-kanban-count" style={{ background: sc.bg, color: sc.color }}>
                      {stageCands.length}
                    </span>
                  </div>
                  <div className="rec-kanban-cards">
                    {stageCands.map(c => (
                      <div key={c.id} className="rec-cand-card" onClick={() => setSelectedCandidate(c)}>
                        <div className="rec-cand-card-top">
                          <div className="rec-avatar">
                            {(c.full_name || '?')[0].toUpperCase()}
                          </div>
                          <div className="rec-cand-info">
                            <div className="rec-cand-name">{c.full_name}</div>
                            <div className="rec-cand-role">{c.job_title || '—'}</div>
                          </div>
                        </div>
                        <div className="rec-cand-card-bottom">
                          <span className="rec-cand-source">{c.source}</span>
                          <span className="rec-cand-applied">
                            {c.created_at ? new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}
                          </span>
                        </div>
                      </div>
                    ))}
                    {stageCands.length === 0 && (
                      <div className="rec-kanban-empty">No candidates</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Open Positions ─── */}
      {tab === 'positions' && (
        <div className="rec-card">
          <div className="rec-card-head">
            <h2 className="rec-card-title">Open Positions</h2>
            <span className="rec-card-sub">
              {positions.filter(p => p.status === 'open').length} active roles
            </span>
          </div>
          <div className="rec-table-scroll">
          <table className="rec-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Department</th>
                <th>Location</th>
                <th>Openings</th>
                <th>Status</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => {
                const statusKey = (p.status || 'draft').toLowerCase();
                const sm = STATUS_META[statusKey] || STATUS_META.draft;
                return (
                  <tr key={p.id}>
                    <td className="rec-td-bold">{p.job_title || p.req_job_title}</td>
                    <td>{p.department || p.req_department}</td>
                    <td><span className="rec-loc"><MapPin size={12} />{p.location || p.req_location}</span></td>
                    <td className="rec-td-center">{p.number_of_positions || 1}</td>
                    <td>
                      <span className="rec-stage-chip-sm" style={{ background: sm.bg, color: sm.color }}>
                        {p.status}
                      </span>
                    </td>
                    <td className="rec-td-muted">
                      {(p.opening_date || p.created_at)
                        ? new Date(p.opening_date || p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                        : '—'}
                    </td>
                  </tr>
                );
              })}
              {positions.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: '#94a3b8' }}>
                    No open positions yet.{' '}
                    <button
                      onClick={() => setPage && setPage('JobOpenings')}
                      style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Post a Job Opening →
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ─── Interview Schedule ─── */}
      {tab === 'interviews' && (
        <div className="rec-card">
          <div className="rec-card-head">
            <h2 className="rec-card-title">Interview Schedule</h2>
            <button className="rec-btn-primary" onClick={() => setScheduleFor({})}>
              <Plus size={14} /> Schedule
            </button>
          </div>
          <div className="rec-interview-list" style={{ maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
            {interviews.length === 0 && (
              <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                No interviews scheduled.
              </div>
            )}
            {interviews.map(iv => (
              <div key={iv.id} className="rec-interview-row">
                <div className="rec-iv-date">
                  <div className="rec-iv-day">
                    {iv.interview_date ? new Date(iv.interview_date + 'T00:00:00').getDate() : '—'}
                  </div>
                  <div className="rec-iv-month">
                    {iv.interview_date ? new Date(iv.interview_date + 'T00:00:00').toLocaleString('en-IN', { month: 'short' }) : ''}
                  </div>
                </div>
                <div className="rec-iv-info">
                  <div className="rec-iv-cand">{iv.candidate_name}</div>
                  <div className="rec-iv-role">{iv.job_title || ''}</div>
                </div>
                <div className="rec-iv-meta">
                  <span className="rec-iv-time"><Clock size={12} />{iv.interview_time}</span>
                  <span className="rec-iv-type">{iv.interview_mode}</span>
                </div>
                <div className="rec-iv-interviewer">
                  <span><Users size={12} />{iv.interviewer_name || 'TBD'}</span>
                </div>
                <div>
                  <span className={`rec-iv-status rec-iv-${iv.status}`}>
                    {iv.status === 'scheduled' ? 'Scheduled' : iv.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Analytics ─── */}
      {tab === 'analytics' && (
        <div className="rec-analytics-grid">
          {/* Pipeline funnel chart */}
          <div className="rec-card">
            <div className="rec-card-head">
              <h2 className="rec-card-title" style={{ marginBottom: 0 }}>Hiring Funnel</h2>
              {pipelineCounts.length > 0 && (
                <ChartExpandButton title="Hiring Funnel" subtitle="Candidates by pipeline stage">
                  {funnelChart(430)}
                </ChartExpandButton>
              )}
            </div>
            {pipelineCounts.length > 0 ? funnelChart(215) : (
              <div style={{ padding: '48px', textAlign: 'center', color: '#94a3b8' }}>No data yet</div>
            )}
          </div>

          {/* Source breakdown */}
          <div className="rec-card">
            <div className="rec-card-head">
              <h2 className="rec-card-title" style={{ marginBottom: 0 }}>Source Breakdown</h2>
              {sourceData.length > 0 && (
                <ChartExpandButton title="Source Breakdown" subtitle="Candidates by sourcing channel">
                  {sourceChart(430, 110, 165)}
                </ChartExpandButton>
              )}
            </div>
            {sourceData.length > 0 ? sourceChart(215, 55, 82) : (
              <div style={{ padding: '48px', textAlign: 'center', color: '#94a3b8' }}>No data yet</div>
            )}
          </div>

          {/* Key metrics */}
          <div className="rec-card rec-card-full">
            <h2 className="rec-card-title">Key Hiring Metrics</h2>
            <div className="rec-metrics-grid">
              {[
                { label: 'Open Positions',     val: fmt(kpis?.open_positions),    color: '#6366f1' },
                { label: 'Active Candidates',  val: fmt(kpis?.active_candidates), color: '#3b82f6' },
                { label: 'Interviews Today',   val: fmt(kpis?.interviews_today),  color: '#f59e0b' },
                { label: 'Hired This Month',   val: fmt(kpis?.hired_this_month),  color: '#22c55e' },
              ].map(m => (
                <div key={m.label} className="rec-metric-tile">
                  <div className="rec-metric-val" style={{ color: m.color }}>{m.val}</div>
                  <div className="rec-metric-label">{m.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
