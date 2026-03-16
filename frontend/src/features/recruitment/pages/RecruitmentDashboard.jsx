import { useState, useEffect, useCallback } from 'react';
import {
  Briefcase, Users, Calendar, CheckCircle, Clock,
  Plus, X, ChevronRight, RefreshCw, AlertCircle,
  MapPin, Mail, Phone, Star, Eye, Send, Filter, Search
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, FunnelChart, Funnel, LabelList, Cell,
  PieChart, Pie, Legend
} from 'recharts';
import api from '@/services/api/client';
import './RecruitmentDashboard.css';

/* ── sample data ────────────────────────────────────── */
const SAMPLE_POSITIONS = [
  { id: 1, title: 'Senior React Developer',   department: 'Engineering', location: 'Bangalore',   openings: 2, applicants: 18, stage: 'Interviewing', priority: 'high',   posted: 'Feb 10 2026' },
  { id: 2, title: 'Product Manager',           department: 'Product',     location: 'Remote',      openings: 1, applicants: 34, stage: 'Screening',    priority: 'high',   posted: 'Feb 18 2026' },
  { id: 3, title: 'DevOps Engineer',           department: 'Engineering', location: 'Hyderabad',   openings: 1, applicants: 12, stage: 'Interviewing', priority: 'medium', posted: 'Jan 28 2026' },
  { id: 4, title: 'UX Designer',               department: 'Design',      location: 'Bangalore',   openings: 2, applicants: 26, stage: 'Offer',        priority: 'medium', posted: 'Jan 20 2026' },
  { id: 5, title: 'Data Analyst',              department: 'Analytics',   location: 'Pune',        openings: 1, applicants: 22, stage: 'Screening',    priority: 'low',    posted: 'Feb 25 2026' },
];

const PIPELINE_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];

const SAMPLE_CANDIDATES = [
  { id: 1,  name: 'Arjun Mehta',    role: 'Senior React Developer', stage: 'Interview',  rating: 4, email: 'arjun@email.com',  phone: '+91 98765 43210', applied: 'Feb 12', avatar: 'AM' },
  { id: 2,  name: 'Priya Sharma',   role: 'Product Manager',        stage: 'Screening',  rating: 5, email: 'priya@email.com',  phone: '+91 87654 32109', applied: 'Feb 19', avatar: 'PS' },
  { id: 3,  name: 'Rohan Verma',    role: 'DevOps Engineer',        stage: 'Offer',      rating: 4, email: 'rohan@email.com',  phone: '+91 76543 21098', applied: 'Jan 30', avatar: 'RV' },
  { id: 4,  name: 'Sneha Iyer',     role: 'UX Designer',            stage: 'Hired',      rating: 5, email: 'sneha@email.com',  phone: '+91 65432 10987', applied: 'Jan 22', avatar: 'SI' },
  { id: 5,  name: 'Kiran Rao',      role: 'Data Analyst',           stage: 'Applied',    rating: 3, email: 'kiran@email.com',  phone: '+91 54321 09876', applied: 'Feb 26', avatar: 'KR' },
  { id: 6,  name: 'Anjali Das',     role: 'Senior React Developer', stage: 'Screening',  rating: 4, email: 'anjali@email.com', phone: '+91 43210 98765', applied: 'Feb 14', avatar: 'AD' },
  { id: 7,  name: 'Vikram Nair',    role: 'UX Designer',            stage: 'Interview',  rating: 3, email: 'vikram@email.com', phone: '+91 32109 87654', applied: 'Jan 25', avatar: 'VN' },
  { id: 8,  name: 'Deepa Pillai',   role: 'Product Manager',        stage: 'Interview',  rating: 5, email: 'deepa@email.com',  phone: '+91 21098 76543', applied: 'Feb 20', avatar: 'DP' },
];

const SAMPLE_INTERVIEWS = [
  { id: 1, candidate: 'Arjun Mehta',   role: 'Senior React Developer', date: 'Mar 16 2026', time: '10:00 AM', type: 'Technical', interviewer: 'Suresh Kumar',  status: 'scheduled' },
  { id: 2, candidate: 'Deepa Pillai',  role: 'Product Manager',        date: 'Mar 16 2026', time: '2:30 PM',  type: 'HR',        interviewer: 'Meera Joshi',   status: 'scheduled' },
  { id: 3, candidate: 'Vikram Nair',   role: 'UX Designer',            date: 'Mar 17 2026', time: '11:00 AM', type: 'Portfolio', interviewer: 'Anand Rao',     status: 'scheduled' },
  { id: 4, candidate: 'Anjali Das',    role: 'Senior React Developer', date: 'Mar 18 2026', time: '3:00 PM',  type: 'Technical', interviewer: 'Suresh Kumar',  status: 'pending' },
];

const SAMPLE_PIPELINE_COUNTS = [
  { stage: 'Applied',   count: 112, color: '#94a3b8' },
  { stage: 'Screening', count: 64,  color: '#60a5fa' },
  { stage: 'Interview', count: 28,  color: '#a78bfa' },
  { stage: 'Offer',     count: 9,   color: '#f59e0b' },
  { stage: 'Hired',     count: 5,   color: '#22c55e' },
];

const SAMPLE_SOURCE = [
  { name: 'LinkedIn',   value: 42 },
  { name: 'Naukri',     value: 28 },
  { name: 'Referral',   value: 18 },
  { name: 'Website',    value: 12 },
];

const SOURCE_COLORS = ['#6366f1','#22c55e','#f59e0b','#ec4899'];

/* ── helpers ────────────────────────────────────────── */
const PRIORITY_META = {
  high:   { label: 'High',   color: '#ef4444', bg: '#fef2f2' },
  medium: { label: 'Medium', color: '#f59e0b', bg: '#fffbeb' },
  low:    { label: 'Low',    color: '#22c55e', bg: '#f0fdf4' },
};

const STAGE_COLORS = {
  Applied:   { color: '#64748b', bg: '#f1f5f9' },
  Screening: { color: '#3b82f6', bg: '#eff6ff' },
  Interview: { color: '#8b5cf6', bg: '#f5f3ff' },
  Offer:     { color: '#f59e0b', bg: '#fffbeb' },
  Hired:     { color: '#22c55e', bg: '#f0fdf4' },
};

const Toast = ({ toast, onClose }) => {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`rec-toast rec-toast-${toast.type}`}>
      {toast.type === 'success' ? <CheckCircle size={16}/> : <AlertCircle size={16}/>}
      {toast.msg}
    </div>
  );
};

/* ── Schedule Interview Drawer ──────────────────────── */
function ScheduleDrawer({ candidate, onClose, onSchedule }) {
  const [form, setForm] = useState({
    date: '',
    time: '',
    type: 'Technical',
    interviewer: '',
    notes: '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.date || !form.time || !form.interviewer) return;
    try { await api.post('/recruitment/interviews', { candidate_id: candidate?.id, ...form }); } catch (_) {}
    onSchedule(form);
  };

  return (
    <>
      <div className="rec-overlay" onClick={onClose}/>
      <div className="rec-drawer">
        <div className="rec-drawer-header">
          <div>
            <h3>Schedule Interview</h3>
            {candidate && <p className="rec-drawer-sub">{candidate.name} · {candidate.role}</p>}
          </div>
          <button className="rec-drawer-close" onClick={onClose}><X size={20}/></button>
        </div>
        <div className="rec-drawer-body">
          <div className="rec-field-row">
            <div className="rec-field">
              <label className="rec-field-label">Date *</label>
              <input className="rec-input" type="date" value={form.date} onChange={e => set('date', e.target.value)}/>
            </div>
            <div className="rec-field">
              <label className="rec-field-label">Time *</label>
              <input className="rec-input" type="time" value={form.time} onChange={e => set('time', e.target.value)}/>
            </div>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Interview Type</label>
            <select className="rec-select" value={form.type} onChange={e => set('type', e.target.value)}>
              {['Technical', 'HR', 'Portfolio', 'Culture Fit', 'Final'].map(t => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Interviewer *</label>
            <input className="rec-input" placeholder="Interviewer name" value={form.interviewer} onChange={e => set('interviewer', e.target.value)}/>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Notes</label>
            <textarea className="rec-textarea" rows={3} placeholder="Any special notes…" value={form.notes} onChange={e => set('notes', e.target.value)}/>
          </div>
        </div>
        <div className="rec-drawer-footer">
          <button className="rec-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="rec-btn-primary" onClick={handleSubmit}>
            <Calendar size={14}/> Schedule
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Candidate Detail Drawer ────────────────────────── */
function CandidateDrawer({ candidate, onClose, onStageChange, onSchedule }) {
  if (!candidate) return null;
  const sc = STAGE_COLORS[candidate.stage] || STAGE_COLORS.Applied;
  return (
    <>
      <div className="rec-overlay" onClick={onClose}/>
      <div className="rec-drawer rec-drawer-wide">
        <div className="rec-drawer-header">
          <div className="rec-cand-drawer-title">
            <div className="rec-avatar-lg">{candidate.avatar}</div>
            <div>
              <h3>{candidate.name}</h3>
              <p className="rec-drawer-sub">{candidate.role}</p>
            </div>
          </div>
          <button className="rec-drawer-close" onClick={onClose}><X size={20}/></button>
        </div>
        <div className="rec-drawer-body">
          <div className="rec-cand-meta">
            <span><Mail size={13}/> {candidate.email}</span>
            <span><Phone size={13}/> {candidate.phone}</span>
            <span><Calendar size={13}/> Applied: {candidate.applied}</span>
          </div>
          <div className="rec-cand-stage-row">
            <span className="rec-stage-chip" style={{ background: sc.bg, color: sc.color }}>{candidate.stage}</span>
            <div className="rec-stars-sm">
              {[1,2,3,4,5].map(s => (
                <Star key={s} size={14} fill={s <= candidate.rating ? '#f59e0b' : 'none'} color={s <= candidate.rating ? '#f59e0b' : '#d1d5db'}/>
              ))}
            </div>
          </div>
          <div className="rec-field">
            <label className="rec-field-label">Move to Stage</label>
            <div className="rec-stage-pills">
              {PIPELINE_STAGES.map(s => (
                <button
                  key={s}
                  className={`rec-stage-pill ${candidate.stage === s ? 'rec-stage-pill-active' : ''}`}
                  style={candidate.stage === s ? { background: sc.bg, color: sc.color, borderColor: sc.color } : {}}
                  onClick={() => onStageChange(candidate.id, s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="rec-drawer-footer">
          <button className="rec-btn-ghost" onClick={() => onSchedule(candidate)}>
            <Calendar size={14}/> Schedule Interview
          </button>
          <button className="rec-btn-primary" onClick={onClose}>
            <Send size={14}/> Send Offer
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Main Component ─────────────────────────────────── */
export default function RecruitmentDashboard() {
  const [tab, setTab] = useState('pipeline');
  const [positions, setPositions] = useState(SAMPLE_POSITIONS);
  const [candidates, setCandidates] = useState(SAMPLE_CANDIDATES);
  const [interviews, setInterviews] = useState(SAMPLE_INTERVIEWS);
  const [pipelineCounts, setPipelineCounts] = useState(SAMPLE_PIPELINE_COUNTS);
  const [sourceData, setSourceData] = useState(SAMPLE_SOURCE);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('All');
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);

  const showToast = (msg, type = 'success') => setToast({ msg, type });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [posRes, canRes, intRes, pipeRes, srcRes] = await Promise.allSettled([
      api.get('/recruitment/positions'),
      api.get('/recruitment/candidates'),
      api.get('/recruitment/interviews'),
      api.get('/recruitment/pipeline'),
      api.get('/recruitment/sources'),
    ]);
    if (posRes.status === 'fulfilled' && posRes.value.data?.length) setPositions(posRes.value.data);
    if (canRes.status === 'fulfilled' && canRes.value.data?.length) setCandidates(canRes.value.data);
    if (intRes.status === 'fulfilled' && intRes.value.data?.length) setInterviews(intRes.value.data);
    if (pipeRes.status === 'fulfilled' && pipeRes.value.data?.length) setPipelineCounts(pipeRes.value.data);
    if (srcRes.status === 'fulfilled' && srcRes.value.data?.length) setSourceData(srcRes.value.data);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleStageChange = (id, newStage) => {
    setCandidates(cs => cs.map(c => c.id === id ? { ...c, stage: newStage } : c));
    setSelectedCandidate(prev => prev?.id === id ? { ...prev, stage: newStage } : prev);
    showToast(`Candidate moved to ${newStage}`);
  };

  const handleScheduled = (form) => {
    setScheduleFor(null);
    setSelectedCandidate(null);
    showToast('Interview scheduled successfully');
  };

  const filteredCandidates = candidates.filter(c => {
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.role.toLowerCase().includes(search.toLowerCase());
    const matchStage  = stageFilter === 'All' || c.stage === stageFilter;
    return matchSearch && matchStage;
  });

  // KPIs
  const totalOpen       = positions.reduce((s, p) => s + p.openings, 0);
  const totalApplicants = candidates.length;
  const scheduledCount  = interviews.filter(i => i.status === 'scheduled').length;
  const offerCount      = candidates.filter(c => c.stage === 'Offer').length;

  return (
    <div className="rec-page">
      <Toast toast={toast} onClose={() => setToast(null)}/>

      {scheduleFor && (
        <ScheduleDrawer
          candidate={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onSchedule={handleScheduled}
        />
      )}

      {selectedCandidate && !scheduleFor && (
        <CandidateDrawer
          candidate={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          onStageChange={handleStageChange}
          onSchedule={(c) => { setSelectedCandidate(null); setScheduleFor(c); }}
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
            <RefreshCw size={15} className={loading ? 'rec-spin' : ''}/> Refresh
          </button>
          <button className="rec-btn-primary" onClick={() => setScheduleFor({})}>
            <Plus size={15}/> Schedule Interview
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="rec-kpi-row">
        {[
          { icon: <Briefcase size={20} color="#6366f1"/>, label: 'Open Positions',    val: totalOpen,       sub: `${positions.length} roles`,        bg: '#f5f3ff' },
          { icon: <Users size={20} color="#3b82f6"/>,     label: 'Active Candidates', val: totalApplicants, sub: 'In pipeline',                      bg: '#eff6ff' },
          { icon: <Calendar size={20} color="#f59e0b"/>,  label: 'Interviews Today',  val: scheduledCount,  sub: 'Scheduled',                        bg: '#fffbeb' },
          { icon: <CheckCircle size={20} color="#22c55e"/>,label: 'Pending Offers',   val: offerCount,      sub: `${candidates.filter(c=>c.stage==='Hired').length} hired this month`, bg: '#f0fdf4' },
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
          <button key={t.key} className={`rec-tab ${tab === t.key ? 'rec-tab-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Kanban Pipeline ─── */}
      {tab === 'pipeline' && (
        <div>
          <div className="rec-pipeline-toolbar">
            <div className="rec-search-wrap">
              <Search size={14}/>
              <input className="rec-search" placeholder="Search candidates…" value={search} onChange={e => setSearch(e.target.value)}/>
            </div>
            <div className="rec-stage-filter">
              {['All', ...PIPELINE_STAGES].map(s => (
                <button
                  key={s}
                  className={`rec-filter-btn ${stageFilter === s ? 'rec-filter-btn-active' : ''}`}
                  onClick={() => setStageFilter(s)}
                >{s}</button>
              ))}
            </div>
          </div>

          {/* Pipeline funnel counts */}
          <div className="rec-funnel-row">
            {pipelineCounts.map(p => (
              <div key={p.stage} className="rec-funnel-step">
                <div className="rec-funnel-bar-wrap">
                  <div
                    className="rec-funnel-bar"
                    style={{
                      height: `${Math.max(20, (p.count / pipelineCounts[0].count) * 80)}px`,
                      background: p.color
                    }}
                  />
                </div>
                <div className="rec-funnel-count" style={{ color: p.color }}>{p.count}</div>
                <div className="rec-funnel-label">{p.stage}</div>
              </div>
            ))}
          </div>

          {/* Kanban columns */}
          <div className="rec-kanban">
            {PIPELINE_STAGES.map(stage => {
              const stageCands = filteredCandidates.filter(c => c.stage === stage);
              const sc = STAGE_COLORS[stage];
              return (
                <div key={stage} className="rec-kanban-col">
                  <div className="rec-kanban-head" style={{ borderTopColor: sc.color }}>
                    <span className="rec-kanban-stage" style={{ color: sc.color }}>{stage}</span>
                    <span className="rec-kanban-count" style={{ background: sc.bg, color: sc.color }}>{stageCands.length}</span>
                  </div>
                  <div className="rec-kanban-cards">
                    {stageCands.map(c => (
                      <div key={c.id} className="rec-cand-card" onClick={() => setSelectedCandidate(c)}>
                        <div className="rec-cand-card-top">
                          <div className="rec-avatar">{c.avatar}</div>
                          <div className="rec-cand-info">
                            <div className="rec-cand-name">{c.name}</div>
                            <div className="rec-cand-role">{c.role}</div>
                          </div>
                        </div>
                        <div className="rec-cand-card-bottom">
                          <div className="rec-stars-sm">
                            {[1,2,3,4,5].map(s => (
                              <Star key={s} size={11} fill={s <= c.rating ? '#f59e0b' : 'none'} color={s <= c.rating ? '#f59e0b' : '#d1d5db'}/>
                            ))}
                          </div>
                          <span className="rec-cand-applied">{c.applied}</span>
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
            <span className="rec-card-sub">{positions.length} active roles · {totalOpen} total openings</span>
          </div>
          <table className="rec-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Department</th>
                <th>Location</th>
                <th>Openings</th>
                <th>Applicants</th>
                <th>Stage</th>
                <th>Priority</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => {
                const pm = PRIORITY_META[p.priority] || PRIORITY_META.low;
                const sc = STAGE_COLORS[p.stage] || STAGE_COLORS.Applied;
                return (
                  <tr key={p.id}>
                    <td className="rec-td-bold">{p.title}</td>
                    <td>{p.department}</td>
                    <td><span className="rec-loc"><MapPin size={12}/>{p.location}</span></td>
                    <td className="rec-td-center">{p.openings}</td>
                    <td className="rec-td-center">
                      <span className="rec-applicant-chip"><Users size={11}/>{p.applicants}</span>
                    </td>
                    <td>
                      <span className="rec-stage-chip-sm" style={{ background: sc.bg, color: sc.color }}>{p.stage}</span>
                    </td>
                    <td>
                      <span className="rec-priority-chip" style={{ background: pm.bg, color: pm.color }}>{pm.label}</span>
                    </td>
                    <td className="rec-td-muted">{p.posted}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Interview Schedule ─── */}
      {tab === 'interviews' && (
        <div className="rec-card">
          <div className="rec-card-head">
            <h2 className="rec-card-title">Interview Schedule</h2>
            <button className="rec-btn-primary" onClick={() => setScheduleFor({})}>
              <Plus size={14}/> Schedule
            </button>
          </div>
          <div className="rec-interview-list">
            {interviews.map(iv => (
              <div key={iv.id} className="rec-interview-row">
                <div className="rec-iv-date">
                  <div className="rec-iv-day">{iv.date.split(' ')[1]}</div>
                  <div className="rec-iv-month">{iv.date.split(' ')[0]}</div>
                </div>
                <div className="rec-iv-info">
                  <div className="rec-iv-cand">{iv.candidate}</div>
                  <div className="rec-iv-role">{iv.role}</div>
                </div>
                <div className="rec-iv-meta">
                  <span className="rec-iv-time"><Clock size={12}/>{iv.time}</span>
                  <span className="rec-iv-type">{iv.type}</span>
                </div>
                <div className="rec-iv-interviewer">
                  <span><Users size={12}/>{iv.interviewer}</span>
                </div>
                <div>
                  <span className={`rec-iv-status rec-iv-${iv.status}`}>
                    {iv.status === 'scheduled' ? 'Scheduled' : 'Pending Confirmation'}
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
            <h2 className="rec-card-title">Hiring Funnel</h2>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={pipelineCounts} barSize={40}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4"/>
                <XAxis dataKey="stage" tick={{ fontSize: 12 }}/>
                <YAxis tick={{ fontSize: 12 }}/>
                <Tooltip/>
                <Bar dataKey="count" radius={[6,6,0,0]}>
                  {pipelineCounts.map((p, i) => <Cell key={i} fill={p.color}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Source breakdown */}
          <div className="rec-card">
            <h2 className="rec-card-title">Source Breakdown</h2>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={sourceData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {sourceData.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]}/>)}
                </Pie>
                <Tooltip formatter={(v) => [`${v}%`, 'Candidates']}/>
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Key metrics */}
          <div className="rec-card rec-card-full">
            <h2 className="rec-card-title">Key Hiring Metrics</h2>
            <div className="rec-metrics-grid">
              {[
                { label: 'Avg Time to Hire',     val: '18 days',  color: '#6366f1' },
                { label: 'Offer Acceptance Rate', val: '78%',      color: '#22c55e' },
                { label: 'Interview to Hire',     val: '5.6 : 1',  color: '#f59e0b' },
                { label: 'Pipeline Conversion',   val: '4.5%',     color: '#ec4899' },
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
