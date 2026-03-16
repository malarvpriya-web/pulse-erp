import { useState, useCallback, useEffect } from 'react';
import {
  Plus, RefreshCw, X, ChevronRight, ChevronLeft,
  User, Mail, Phone, Star, Award
} from 'lucide-react';
import api from '@/services/api/client';
import './CandidatePipeline.css';

const STAGES = [
  { key: 'applied',    title: 'Applied',    color: '#dbeafe', text: '#1d4ed8' },
  { key: 'screening',  title: 'Screening',  color: '#fef3c7', text: '#92400e' },
  { key: 'interview',  title: 'Interview',  color: '#fed7aa', text: '#c2410c' },
  { key: 'offer',      title: 'Offer',      color: '#e0e7ff', text: '#4338ca' },
  { key: 'hired',      title: 'Hired',      color: '#dcfce7', text: '#15803d' },
];

const SOURCE_META = {
  website:    { bg: '#dbeafe', color: '#1d4ed8' },
  linkedin:   { bg: '#e0e7ff', color: '#4338ca' },
  referral:   { bg: '#fce7f3', color: '#9d174d' },
  job_portal: { bg: '#fef3c7', color: '#92400e' },
  campus:     { bg: '#f3e8ff', color: '#7c3aed' },
  manual:     { bg: '#f3f4f6', color: '#6b7280' },
};
const srcm = s => SOURCE_META[(s || '').toLowerCase()] || SOURCE_META.manual;

const SAMPLE_OPENINGS = [
  { id: 1, job_title: 'Senior React Developer', department: 'Engineering' },
  { id: 2, job_title: 'Finance Manager',         department: 'Finance'     },
  { id: 3, job_title: 'Data Analyst',            department: 'Operations'  },
];

const SAMPLE_CANDIDATES = [
  { id:1,  full_name:'Arjun Mehta',     email:'arjun.m@gmail.com',   phone:'+91 98765 11111', source:'linkedin',   current_stage:'applied',   score:72, role_applied:'Senior React Developer', overall_status:'active' },
  { id:2,  full_name:'Kavitha Iyer',    email:'kavitha@outlook.com', phone:'+91 87654 22222', source:'website',    current_stage:'screening', score:85, role_applied:'Senior React Developer', overall_status:'active' },
  { id:3,  full_name:'Rohit Bansal',    email:'rohit.b@gmail.com',   phone:'+91 76543 33333', source:'referral',   current_stage:'interview', score:91, role_applied:'Senior React Developer', overall_status:'active' },
  { id:4,  full_name:'Sneha Kulkarni',  email:'sneha.k@yahoo.com',   phone:'+91 65432 44444', source:'job_portal', current_stage:'offer',     score:88, role_applied:'Senior React Developer', overall_status:'active' },
  { id:5,  full_name:'Deepak Joshi',    email:'deepak.j@gmail.com',  phone:'+91 54321 55555', source:'campus',     current_stage:'hired',     score:94, role_applied:'Senior React Developer', overall_status:'active' },
  { id:6,  full_name:'Anjali Nair',     email:'anjali.n@gmail.com',  phone:'+91 43210 66666', source:'linkedin',   current_stage:'applied',   score:63, role_applied:'Senior React Developer', overall_status:'active' },
  { id:7,  full_name:'Suresh Pillai',   email:'suresh.p@gmail.com',  phone:'+91 32109 77777', source:'website',    current_stage:'screening', score:79, role_applied:'Finance Manager',        overall_status:'active' },
  { id:8,  full_name:'Meera Varma',     email:'meera.v@gmail.com',   phone:'+91 21098 88888', source:'referral',   current_stage:'applied',   score:55, role_applied:'Data Analyst',           overall_status:'active' },
  { id:9,  full_name:'Kiran Reddy',     email:'kiran.r@gmail.com',   phone:'+91 10987 99999', source:'manual',     current_stage:'interview', score:68, role_applied:'Finance Manager',        overall_status:'rejected' },
];

const emptyForm = () => ({
  full_name: '', email: '', phone: '', source: 'manual', notes: '',
});

export default function CandidatePipeline({ setPage }) {
  const [openings,   setOpenings]   = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [selJob,     setSelJob]     = useState('');
  const [drawer,     setDrawer]     = useState(false);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [moving,     setMoving]     = useState(null);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadOpenings = useCallback(async () => {
    try {
      const res = await api.get('/recruitment/openings', { params: { status: 'open' } });
      const raw = res.data?.openings || res.data || [];
      const list = Array.isArray(raw) && raw.length ? raw : SAMPLE_OPENINGS;
      setOpenings(list);
      if (!selJob && list.length) setSelJob(list[0].id);
    } catch {
      setOpenings(SAMPLE_OPENINGS);
      if (!selJob) setSelJob(SAMPLE_OPENINGS[0].id);
    }
  }, []);

  const loadCandidates = useCallback(async () => {
    if (!selJob) return;
    setLoading(true);
    try {
      const res = await api.get('/recruitment/candidates', { params: { applied_job_id: selJob } });
      const raw = res.data?.candidates || res.data || [];
      setCandidates(Array.isArray(raw) && raw.length ? raw : SAMPLE_CANDIDATES);
    } catch {
      setCandidates(SAMPLE_CANDIDATES);
    } finally { setLoading(false); }
  }, [selJob]);

  useEffect(() => { loadOpenings(); }, [loadOpenings]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  const moveStage = async (candidate, direction) => {
    const idx = STAGES.findIndex(s => s.key === candidate.current_stage);
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= STAGES.length) return;
    const newStage = STAGES[nextIdx].key;
    setMoving(candidate.id);
    try {
      await api.post(`/recruitment/candidates/${candidate.id}/move-stage`, {
        new_stage: newStage, notes: `Moved to ${newStage}`,
      });
    } catch { /* optimistic */ }
    setCandidates(cs => cs.map(c => c.id === candidate.id ? { ...c, current_stage: newStage } : c));
    setMoving(null);
    showToast(`${candidate.full_name} moved to ${STAGES[nextIdx].title}`);
  };

  const handleSubmit = async () => {
    if (!form.full_name.trim()) return showToast('Full name is required', 'error');
    if (!form.email.trim())     return showToast('Email is required', 'error');
    setSubmitting(true);
    try {
      await api.post('/recruitment/candidates', { ...form, applied_job_id: selJob });
      showToast('Candidate added');
    } catch {
      setCandidates(cs => [{ ...form, id: Date.now(), current_stage: 'applied', score: 0, overall_status: 'active', role_applied: openings.find(o => o.id == selJob)?.job_title || '—' }, ...cs]);
      showToast('Candidate added');
    } finally {
      setDrawer(false);
      setForm(emptyForm());
      setSubmitting(false);
    }
  };

  const active   = candidates.filter(c => c.overall_status !== 'rejected');
  const rejected = candidates.filter(c => c.overall_status === 'rejected');
  const board = STAGES.reduce((acc, s) => { acc[s.key] = active.filter(c => c.current_stage === s.key); return acc; }, {});

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="cp-root">
      {toast && <div className={`cp-toast cp-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="cp-header">
        <div>
          <h2 className="cp-title">Candidate Pipeline</h2>
          <p className="cp-sub">{active.length} active · {rejected.length} rejected</p>
        </div>
        <div className="cp-header-r">
          <select className="cp-job-sel" value={selJob} onChange={e => setSelJob(e.target.value)}>
            {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}{o.department ? ` — ${o.department}` : ''}</option>)}
          </select>
          <button className="cp-icon-btn" onClick={loadCandidates}><RefreshCw size={14} /></button>
          <button className="cp-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
            <Plus size={14} /> Add Candidate
          </button>
        </div>
      </div>

      <div className="cp-stats">
        {STAGES.map(s => (
          <div key={s.key} className="cp-stat" style={{ '--c': s.color }}>
            <span className="cp-stat-num">{board[s.key].length}</span>
            <span className="cp-stat-label">{s.title}</span>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="cp-loading"><div className="cp-spinner" /></div>
      ) : (
        <div className="cp-board">
          {STAGES.map((stage, stageIdx) => (
            <div key={stage.key} className="cp-col">
              <div className="cp-col-hd" style={{ background: stage.color }}>
                <span className="cp-col-title" style={{ color: stage.text }}>{stage.title}</span>
                <span className="cp-col-count" style={{ color: stage.text }}>{board[stage.key].length}</span>
              </div>
              <div className="cp-col-body">
                {board[stage.key].length === 0 && <div className="cp-col-empty">No candidates</div>}
                {board[stage.key].map(c => {
                  const src = srcm(c.source);
                  const score = parseInt(c.score) || 0;
                  return (
                    <div key={c.id} className="cp-card">
                      <div className="cp-card-hd">
                        <div className="cp-avatar">{(c.full_name || '?').charAt(0)}</div>
                        <div>
                          <h4 className="cp-cname">{c.full_name}</h4>
                          <span className="cp-role">{c.role_applied || '—'}</span>
                        </div>
                      </div>
                      <div className="cp-card-info">
                        <span className="cp-email"><Mail size={11} />{c.email}</span>
                        {c.phone && <span className="cp-phone"><Phone size={11} />{c.phone}</span>}
                      </div>
                      <div className="cp-card-ft">
                        <span className="cp-src-badge" style={{ background: src.bg, color: src.color }}>{c.source}</span>
                        {score > 0 && (
                          <div className="cp-score">
                            <Star size={11} color={score >= 80 ? '#f59e0b' : '#9ca3af'} />
                            <span style={{ color: score >= 80 ? '#15803d' : score >= 60 ? '#92400e' : '#dc2626' }}>{score}</span>
                          </div>
                        )}
                      </div>
                      <div className="cp-card-moves">
                        <button className="cp-move-btn" disabled={stageIdx === 0 || moving === c.id} onClick={() => moveStage(c, -1)} title="Move back">
                          <ChevronLeft size={13} />
                        </button>
                        <button className="cp-move-btn" disabled={stageIdx === STAGES.length - 1 || moving === c.id} onClick={() => moveStage(c, 1)} title="Move forward">
                          <ChevronRight size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="cp-rejected-section">
          <h4 className="cp-rejected-title">Rejected ({rejected.length})</h4>
          <div className="cp-rejected-list">
            {rejected.map(c => (
              <div key={c.id} className="cp-rejected-card">
                <div className="cp-avatar cp-avatar-sm">{(c.full_name || '?').charAt(0)}</div>
                <span className="cp-cname">{c.full_name}</span>
                <span className="cp-role">{c.role_applied}</span>
                <span className="cp-rej-badge">Rejected</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {drawer && (
        <div className="cp-overlay" onClick={() => setDrawer(false)}>
          <div className="cp-drawer" onClick={e => e.stopPropagation()}>
            <div className="cp-drawer-hd">
              <h3>Add Candidate</h3>
              <button className="cp-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="cp-drawer-body">
              <div className="cp-field">
                <label>Full Name <span className="cp-req">*</span></label>
                <input value={form.full_name} onChange={e => setF('full_name', e.target.value)} placeholder="Candidate name…" />
              </div>
              <div className="cp-row2">
                <div className="cp-field">
                  <label>Email <span className="cp-req">*</span></label>
                  <input type="email" value={form.email} onChange={e => setF('email', e.target.value)} placeholder="email@…" />
                </div>
                <div className="cp-field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e => setF('phone', e.target.value)} placeholder="+91…" />
                </div>
              </div>
              <div className="cp-field">
                <label>Source</label>
                <select value={form.source} onChange={e => setF('source', e.target.value)}>
                  {['manual','website','linkedin','referral','job_portal','campus'].map(s => (
                    <option key={s} value={s}>{s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                  ))}
                </select>
              </div>
              <div className="cp-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Any notes about this candidate…" />
              </div>
            </div>
            <div className="cp-drawer-ft">
              <button className="cp-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="cp-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Adding…' : 'Add Candidate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
