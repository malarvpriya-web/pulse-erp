import { useState, useCallback, useEffect } from 'react';
import {
  Plus, RefreshCw, X, ChevronRight, ChevronLeft,
  User, Mail, Phone, Star, Award
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import useAppStore from '@/store/useAppStore';
import './CandidatePipeline.css';

const STAGES = [
  { key: 'applied',    title: 'Applied',               color: '#E6F1FB', text: '#2563EB' },
  { key: 'screening',  title: 'Screening',             color: '#F5F3FF', text: '#6C47FF' },
  { key: '1st_level',  title: '1st Level Interview',   color: '#FAEEDA', text: '#D97706' },
  { key: '2nd_level',  title: '2nd Level Interview',   color: '#FFF3E0', text: '#EA580C' },
  { key: 'offer',      title: 'Offer',                 color: '#F0FDF4', text: '#059669' },
  { key: 'hired',      title: 'Hired',                 color: '#E8FBF0', text: '#047857' },
];

const DEADEND_STAGES = [
  { key: 'maybe',        title: 'Maybe',        color: '#F9F9F9', text: '#6b7280' },
  { key: 'future_use',   title: 'Future Use',   color: '#F9F9F9', text: '#6b7280' },
  { key: 'not_suitable', title: 'Not Suitable', color: '#FEF2F2', text: '#dc2626' },
  { key: 'rejected',     title: 'Rejected',     color: '#FEF2F2', text: '#b91c1c' },
];

const SOURCE_META = {
  website:    { bg: '#dbeafe', color: '#1d4ed8' },
  linkedin:   { bg: '#e0e7ff', color: '#4338ca' },
  referral:   { bg: '#fce7f3', color: '#9d174d' },
  job_portal: { bg: '#fef3c7', color: '#92400e' },
  campus:     { bg: '#f3e8ff', color: '#6B3FDB' },
  manual:     { bg: '#f3f4f6', color: '#6b7280' },
};
const srcm = s => SOURCE_META[(s || '').toLowerCase()] || SOURCE_META.manual;


const emptyForm = () => ({
  full_name: '', email: '', phone: '', source: 'manual', notes: '', source_agency_id: '',
});

const ALLOWED_RESUME_EXTS = '.pdf,.doc,.docx';

export default function CandidatePipeline({ setPage: _setPage }) {
  const selectedJobId  = useAppStore(s => s.selectedJobId);
  const setSelectedJobId = useAppStore(s => s.setSelectedJobId);
  const [openings,     setOpenings]     = useState([]);
  const [candidates,   setCandidates]   = useState([]);
  const [agencies,     setAgencies]     = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [selJob,       setSelJob]       = useState(selectedJobId || '');
  const [drawer,       setDrawer]       = useState(false);
  const [form,         setForm]         = useState(emptyForm());
  const [resumeFile,   setResumeFile]   = useState(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [moving,       setMoving]       = useState(null);
  const [showDeadEnd,  setShowDeadEnd]  = useState(false);

  const _toast = useToast();
  const showToast = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);

  const loadOpenings = useCallback(async () => {
    try {
      const res = await api.get('/recruitment/openings', { params: { status: 'open' } });
      const raw = res.data?.openings || res.data || [];
      const list = Array.isArray(raw) ? raw : [];
      setOpenings(list);
      // Prefer the job id passed from JobOpenings; fall back to first in list
      const preferred = selectedJobId || '';
      const validId = preferred && list.some(o => String(o.id) === String(preferred));
      setSelJob(j => j || (validId ? preferred : list.length ? list[0].id : ''));
      if (preferred) setSelectedJobId(null); // consume once
    } catch (err) {
      showToast(`Failed to load job openings: ${err?.response?.data?.message || err.message}`, 'error');
      setOpenings([]);
    }
  }, []);

  const loadCandidates = useCallback(async () => {
    if (!selJob) return;

    try {
      const res = await api.get('/recruitment/candidates', { params: { applied_job_id: selJob } });
      const raw = res.data?.candidates || res.data || [];
      setCandidates(Array.isArray(raw) ? raw : []);
    } catch (err) {
      showToast(`Failed to load candidates: ${err?.response?.data?.message || err.message}`, 'error');
      setCandidates([]);
    } finally { setLoading(false); }
  }, [selJob]);

  useEffect(() => { loadOpenings(); }, [loadOpenings]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  useEffect(() => {
    api.get('/talent/agencies').then(r => setAgencies(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

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
      setCandidates(cs => cs.map(c => c.id === candidate.id ? { ...c, current_stage: newStage } : c));
      showToast(`${candidate.full_name} moved to ${STAGES[nextIdx].title}`);
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to move candidate', 'error');
    } finally {
      setMoving(null);
    }
  };

  const handleSubmit = async () => {
    if (!form.full_name.trim()) return showToast('Full name is required', 'error');
    if (!form.email.trim())     return showToast('Email is required', 'error');
    setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v); });
      if (selJob) fd.append('applied_job_id', selJob);
      if (resumeFile) fd.append('resume', resumeFile);
      await api.post('/recruitment/candidates', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showToast('Candidate added');
      await loadCandidates();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to add candidate', 'error');
    } finally {
      setDrawer(false);
      setForm(emptyForm());
      setResumeFile(null);
      setSubmitting(false);
    }
  };

  const ALL_STAGES = [...STAGES, ...DEADEND_STAGES];
  const board = ALL_STAGES.reduce((acc, s) => {
    acc[s.key] = candidates.filter(c => c.current_stage === s.key);
    return acc;
  }, {});
  const active      = STAGES.reduce((n, s) => n + (board[s.key]?.length || 0), 0);
  const deadEndCount = DEADEND_STAGES.reduce((n, s) => n + (board[s.key]?.length || 0), 0);
  const visibleStages = showDeadEnd ? ALL_STAGES : STAGES;

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="cp-root">
      <div className="cp-header">
        <div>
          <h2 className="cp-title">Candidate Pipeline</h2>
          <p className="cp-sub">{active} active · {deadEndCount} in dead-end stages</p>
        </div>
        <div className="cp-header-r">
          <select className="cp-job-sel" value={selJob} onChange={e => setSelJob(e.target.value)}>
            {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}{o.department ? ` — ${o.department}` : ''}</option>)}
          </select>
          <button
            className={showDeadEnd ? 'cp-btn-outline cp-btn-active' : 'cp-btn-outline'}
            onClick={() => setShowDeadEnd(v => !v)}
            title="Show/hide Maybe, Future Use, Not Suitable and Rejected columns"
          >
            {showDeadEnd ? 'Hide' : 'Show'} Rejected/Dead-end {deadEndCount > 0 ? `(${deadEndCount})` : ''}
          </button>
          <button className="cp-icon-btn" onClick={loadCandidates}><RefreshCw size={14} /></button>
          <button className="cp-btn-primary" onClick={() => { setForm(emptyForm()); setResumeFile(null); setDrawer(true); }}>
            <Plus size={14} /> Add Candidate
          </button>
        </div>
      </div>

      <div className="cp-stats">
        {STAGES.map(s => (
          <div key={s.key} className="cp-stat" style={{ '--c': s.color }}>
            <span className="cp-stat-num">{board[s.key]?.length ?? 0}</span>
            <span className="cp-stat-label">{s.title}</span>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="cp-loading"><div className="cp-spinner" /></div>
      ) : active === 0 && openings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <svg xmlns="http://www.w3.org/2000/svg" width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}><rect x={2} y={7} width={20} height={14} rx={2}/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
          <p style={{ fontWeight: 600, marginBottom: 6 }}>No candidates in pipeline</p>
          <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Post a job opening to start receiving candidates, or add candidates manually.</p>
          <button onClick={() => { setForm(emptyForm()); setResumeFile(null); setDrawer(true); }} style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 500, marginRight: 8 }}>+ Add Candidate</button>
        </div>
      ) : (
        <div className="cp-board">
          {visibleStages.map((stage, stageIdx) => (
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
                          <span className="cp-role">{c.job_title || '—'}</span>
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
                      {STAGES.some(s => s.key === stage.key) && (
                        <div className="cp-card-moves">
                          <button className="cp-move-btn" disabled={stageIdx === 0 || moving === c.id} onClick={() => moveStage(c, -1)} title="Move back">
                            <ChevronLeft size={13} />
                          </button>
                          <button className="cp-move-btn" disabled={stageIdx === STAGES.length - 1 || moving === c.id} onClick={() => moveStage(c, 1)} title="Move forward">
                            <ChevronRight size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {!showDeadEnd && deadEndCount > 0 && (
        <div style={{ textAlign: 'center', padding: '0.75rem', fontSize: 13, color: '#6b7280' }}>
          {deadEndCount} candidate{deadEndCount !== 1 ? 's' : ''} in dead-end stages (Maybe, Future Use, Not Suitable, Rejected).{' '}
          <button
            onClick={() => setShowDeadEnd(true)}
            style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', fontWeight: 500, textDecoration: 'underline', padding: 0 }}
          >
            Show columns
          </button>
        </div>
      )}

      {drawer && (
        <div className="cp-overlay" onClick={() => { setDrawer(false); setResumeFile(null); }}>
          <div className="cp-drawer" onClick={e => e.stopPropagation()}>
            <div className="cp-drawer-hd">
              <h3>Add Candidate</h3>
              <button className="cp-icon-btn" onClick={() => { setDrawer(false); setResumeFile(null); }}><X size={16} /></button>
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
                  {['manual','website','linkedin','referral','job_portal','campus','agency'].map(s => (
                    <option key={s} value={s}>{s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
                  ))}
                </select>
              </div>
              {form.source === 'agency' && agencies.length > 0 && (
                <div className="cp-field">
                  <label>Agency</label>
                  <select value={form.source_agency_id} onChange={e => setF('source_agency_id', e.target.value)}>
                    <option value="">Select agency…</option>
                    {agencies.map(a => <option key={a.id} value={a.id}>{a.agency_name}</option>)}
                  </select>
                </div>
              )}
              <div className="cp-field">
                <label>Resume <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>PDF / Word (max 5 MB)</span></label>
                <input
                  type="file"
                  accept={ALLOWED_RESUME_EXTS}
                  onChange={e => setResumeFile(e.target.files[0] || null)}
                  style={{ fontSize: 13 }}
                />
                {resumeFile && (
                  <span style={{ fontSize: 12, color: '#6366f1', marginTop: 4, display: 'block' }}>
                    {resumeFile.name}
                  </span>
                )}
              </div>
              <div className="cp-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Any notes about this candidate…" />
              </div>
            </div>
            <div className="cp-drawer-ft">
              <button className="cp-btn-outline" onClick={() => { setDrawer(false); setResumeFile(null); }}>Cancel</button>
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
