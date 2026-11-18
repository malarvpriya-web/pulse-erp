import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import {
  Calendar, Clock, Video, Building2, Phone, User, Link2, FileText,
  CheckCircle, XCircle, RefreshCw, CalendarDays, BookOpen, Square,
  CheckSquare, X, Search, ChevronDown, ChevronUp, Plus, UserPlus, Pencil,
} from 'lucide-react';
import './InterviewScheduler.css';
import { useToast } from '@/context/ToastContext';
import { fmtDate as fmtDateStr } from '@/utils/dateFormatter';
import { CAT_STYLE, DIFF_STYLE, candidateRows, INTERVIEW_ROUNDS, INTERVIEW_MODES, interviewRoundLabel } from '../shared/constants';
import Dialog from '../shared/components/Dialog';
import { PageHero, PageShell } from '@/components/pulse-ui';

const STATUS_META = {
  scheduled:   { label: 'Scheduled',   bg: '#dbeafe', color: '#1d4ed8', icon: Clock },
  completed:   { label: 'Completed',   bg: '#dcfce7', color: '#15803d', icon: CheckCircle },
  cancelled:   { label: 'Cancelled',   bg: '#fee2e2', color: '#b91c1c', icon: XCircle },
};

const MODE_META = {
  video:     { label: 'Video call', icon: Video,     color: '#4f46e5', bg: '#e0e7ff' },
  in_person: { label: 'In person',  icon: Building2, color: '#0369a1', bg: '#dbeafe' },
  phone:     { label: 'Phone',      icon: Phone,     color: '#0f766e', bg: '#ccfbf1' },
};
MODE_META.online = MODE_META.video;      // rows saved before 2026-11-17
MODE_META.offline = MODE_META.in_person;

const fmtTime = (t) => {
  if (!t) return '—';
  try {
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
  } catch { return t; }
};

const fmtDate = (d) => {
  try {
    const dt = new Date(d + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate()+1);
    if (dt.getTime() === today.getTime()) return { label: 'Today', sub: fmtDateStr(dt), isToday: true };
    if (dt.getTime() === tomorrow.getTime()) return { label: 'Tomorrow', sub: fmtDateStr(dt), isToday: false };
    return { label: fmtDateStr(dt), sub: dt.getFullYear().toString(), isToday: false };
  } catch { return { label: d, sub: '', isToday: false }; }
};

// ── Suggested Questions side panel ───────────────────────────────────────────

function SuggestedQuestionsPanel({ interview, onClose }) {
  const toast = useToast();
  const [questions,  setQuestions]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  // Ticks are saved on the interview (question_ids), so the interviewer sees the
  // same list when they reopen it.
  const [checked,    setChecked]    = useState(() => Object.fromEntries((interview.question_ids || []).map(id => [id, true])));
  const firstRender = useRef(true);
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('');
  const [expanded,   setExpanded]   = useState({});           // id → bool

  const load = useCallback(() => {
    setLoading(true);
    api.get('/talent/questions', { params: { search, category: catFilter } })
      .then(r => setQuestions(r.data?.data ?? []))
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false));
  }, [search, catFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    const ids = Object.entries(checked).filter(([, v]) => v).map(([k]) => Number(k));
    const t = setTimeout(() => {
      api.put(`/recruitment/interviews/${interview.id}`, { question_ids: ids })
        .catch(() => toast({ message: 'Could not save the question list', type: 'error' }));
    }, 400);
    return () => clearTimeout(t);
  }, [checked]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle      = (id) => setChecked(p => ({ ...p, [id]: !p[id] }));
  const toggleExp   = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));
  const checkedCount = Object.values(checked).filter(Boolean).length;

  const categories = [...new Set(questions.map(q => q.category))].sort();

  return (
    <Dialog width={460} boxShadow="-4px 0 24px rgba(0,0,0,.15)">

        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid #f0f0f4', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ background: '#ede9fe', borderRadius: 8, padding: 8, display: 'flex' }}>
                <BookOpen size={16} color="#6B3FDB" />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', margin: 0 }}>Suggested Questions</p>
                <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>
                  {interview.candidate_name} · {checkedCount > 0 ? `${checkedCount} selected` : 'select to use as checklist'}
                </p>
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}>
              <X size={18} />
            </button>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search questions…"
                style={{ width: '100%', paddingLeft: 26, paddingRight: 8, paddingTop: 7, paddingBottom: 7, border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <select
              value={catFilter}
              onChange={e => setCatFilter(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, outline: 'none', background: '#fff', minWidth: 130 }}
            >
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Checklist progress bar */}
        {checkedCount > 0 && (
          <div style={{ padding: '8px 20px', background: '#f5f3ff', borderBottom: '1px solid #ede9fe', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#6B3FDB' }}>Interview progress</span>
              <span style={{ fontSize: 11, color: '#6B3FDB' }}>{checkedCount} / {questions.length}</span>
            </div>
            <div style={{ background: '#ddd6fe', borderRadius: 4, height: 4, overflow: 'hidden' }}>
              <div style={{ background: '#6B3FDB', height: '100%', width: `${(checkedCount / Math.max(questions.length, 1)) * 100}%`, transition: 'width .3s' }} />
            </div>
          </div>
        )}

        {/* Questions list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {loading ? (
            <p style={{ textAlign: 'center', color: '#9ca3af', paddingTop: 40, fontSize: 13 }}>Loading…</p>
          ) : questions.length === 0 ? (
            <p style={{ textAlign: 'center', color: '#9ca3af', paddingTop: 40, fontSize: 13 }}>No questions found</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {questions.map(q => {
                const isChecked = !!checked[q.id];
                const isExp     = !!expanded[q.id];
                const cs = CAT_STYLE[q.category]   || { bg: '#f3f4f6', color: '#374151' };
                const ds = DIFF_STYLE[q.difficulty] || DIFF_STYLE.medium;

                return (
                  <div
                    key={q.id}
                    style={{
                      background: isChecked ? '#f5f3ff' : '#fafafa',
                      border: `1px solid ${isChecked ? '#c4b5fd' : '#f0f0f4'}`,
                      borderRadius: 9,
                      overflow: 'hidden',
                      transition: 'border-color .15s, background .15s',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10, padding: '10px 12px', alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => toggle(q.id)}>
                      <div style={{ marginTop: 1, flexShrink: 0, color: isChecked ? '#6B3FDB' : '#d1d5db' }}>
                        {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 12, color: isChecked ? '#4c1d95' : '#1f2937', margin: '0 0 6px', lineHeight: 1.5, textDecoration: isChecked ? 'line-through' : 'none', opacity: isChecked ? 0.7 : 1 }}>
                          {q.question}
                        </p>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <span style={{ background: cs.bg, color: cs.color, borderRadius: 20, padding: '1px 7px', fontSize: 9, fontWeight: 600 }}>{q.category}</span>
                          <span style={{ background: ds.bg, color: ds.color, borderRadius: 20, padding: '1px 7px', fontSize: 9, fontWeight: 600, textTransform: 'capitalize' }}>{q.difficulty}</span>
                          {q.job_role && <span style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 20, padding: '1px 7px', fontSize: 9 }}>{q.job_role}</span>}
                        </div>
                      </div>
                      {q.expected_answer && (
                        <button
                          onClick={e => { e.stopPropagation(); toggleExp(q.id); }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '2px 4px', flexShrink: 0 }}
                        >
                          {isExp ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      )}
                    </div>
                    {isExp && q.expected_answer && (
                      <div style={{ padding: '0 12px 10px 38px', background: '#fff7ed' }}>
                        <p style={{ fontSize: 11, fontWeight: 600, color: '#5b21b6', margin: '0 0 3px', textTransform: 'uppercase', letterSpacing: .3 }}>Hints</p>
                        <p style={{ fontSize: 11, color: '#4c1d95', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{q.expected_answer}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {checkedCount > 0 && (
          <div style={{ padding: '12px 20px', borderTop: '1px solid #f0f0f4', flexShrink: 0, background: '#fafafa' }}>
            <button
              onClick={() => setChecked({})}
              style={{ width: '100%', padding: '8px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 12, color: '#6b7280' }}
            >
              Reset checklist
            </button>
          </div>
        )}
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  candidate_id: '', job_opening_id: '', interview_round: '1st_level', date: '', time: '',
  mode: 'in_person', meeting_link: '', interviewer_id: '', panel: [], notes: '',
};
const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };
const labelStyle = { fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 };

/** Searchable candidate picker: opens its list on click (no 200-row cap). */
function CandidatePicker({ value, onChange, initialName }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(initialName || '');
  useEffect(() => { setLabel(initialName || ''); }, [initialName]);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api.get('/recruitment/candidates', { params: { search: q || undefined, limit: 30, sort_by: 'last_activity_at' } })
        .then(r => setRows(candidateRows(r.data))).catch(() => setRows([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <div style={{ position: 'relative' }}>
      <input style={inputStyle} value={open ? q : (label || '')} placeholder="Search by name, email or phone…"
             onFocus={() => { setOpen(true); setQ(''); }} onChange={e => setQ(e.target.value)}
             onBlur={() => setTimeout(() => setOpen(false), 150)} aria-label="Candidate" />
      {open && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 240, overflowY: 'auto', boxShadow: '0 8px 20px rgba(0,0,0,.08)' }}>
          {rows.length === 0 && <div style={{ padding: 10, fontSize: 12, color: '#9ca3af' }}>No candidates found</div>}
          {rows.map(c => (
            <button type="button" key={c.id}
                    onMouseDown={() => { onChange(c); setLabel(c.full_name); setOpen(false); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: String(c.id) === String(value) ? '#f5f3ff' : '#fff', cursor: 'pointer', fontSize: 13 }}>
              <strong>{c.full_name}</strong>
              <span style={{ color: '#6b7280' }}>{c.job_title ? ` — ${c.job_title}` : ''}{c.current_stage ? ` · ${c.current_stage.replace(/_/g, ' ')}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const InterviewScheduler = ({ setPage }) => {
  const _toast = useToast();
  const toast  = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const [sp, setSp] = useSearchParams();

  const [interviews,   setInterviews]   = useState([]);
  const [employees,    setEmployees]    = useState([]);
  const [openings,     setOpenings]     = useState([]);
  const [departments,  setDepartments]  = useState([]);
  const [loading,      setLoading]      = useState(false);
  // ?date=YYYY-MM-DD&status=all — the work queue's "interviews today" tile
  // opens the schedule on the set it counted.
  const [filter,       setFilter]       = useState(() => (['all', 'scheduled', 'completed', 'cancelled'].includes(sp.get('status')) ? sp.get('status') : 'scheduled'));
  const [mineOnly,     setMineOnly]     = useState(false);
  const [dateFilter,   setDateFilter]   = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(sp.get('date') || '') ? sp.get('date') : ''));
  // ?dept=<department> — the Dashboard's department filter carried over, so its
  // "Interviews today" tile and this list agree. An interview's department is
  // its job's, else the candidate's applied job's (API).
  const [deptFilter,   setDeptFilter]   = useState(() => sp.get('dept') || '');
  const [questionsFor, setQuestionsFor] = useState(null);
  const [formOpen,     setFormOpen]     = useState(false);
  const [editing,      setEditing]      = useState(null);       // interview being edited/rescheduled
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [candName,     setCandName]     = useState('');
  const [saving,       setSaving]       = useState(false);
  const [completingIv, setCompletingIv] = useState(null);
  const [feedback,     setFeedback]     = useState({ outcome: 'selected', rejection_reason: '', rating: '', comments: '' });
  const [submittingFb, setSubmittingFb] = useState(false);

  const fetchInterviews = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter !== 'all') params.status = filter;
      if (dateFilter) params.interview_date = dateFilter;
      if (mineOnly) params.mine = 1;
      if (deptFilter) params.department = deptFilter;
      const res = await api.get('/recruitment/interviews', { params });
      setInterviews(Array.isArray(res.data) ? res.data : []);
    } catch { setInterviews([]); }
    finally { setLoading(false); }
  }, [filter, dateFilter, mineOnly, deptFilter]);

  const pickDept = (v) => {
    setDeptFilter(v);
    setSp(prev => { const n = new URLSearchParams(prev); if (v) n.set('dept', v); else n.delete('dept'); return n; }, { replace: true });
  };

  useEffect(() => { fetchInterviews(); }, [fetchInterviews]);
  useEffect(() => {
    api.get('/recruitment/meta/candidate-workbench').then(r => setEmployees(r.data?.employees || [])).catch(() => {});
    api.get('/recruitment/openings', { params: { status: 'open' } }).then(r => setOpenings(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get('/recruitment/filter-options').then(r => setDepartments(Array.isArray(r.data?.departments) ? r.data.departments : [])).catch(() => {});
  }, []);
  const deptOptions = [...new Set([...departments, ...(deptFilter ? [deptFilter] : [])])].sort();

  // Arriving from Candidate Detail with ?candidate=<id> opens the form for them.
  useEffect(() => {
    const cid = sp.get('candidate');
    if (!cid) return;
    api.get(`/recruitment/candidates/${cid}`).then(r => {
      const c = r.data;
      setEditing(null);
      setForm({ ...EMPTY_FORM, candidate_id: String(c.id), job_opening_id: c.applied_job_id ? String(c.applied_job_id) : '',
                interview_round: c.current_stage === '1st_level' ? '2nd_level' : '1st_level' });
      setCandName(c.full_name);
      setFormOpen(true);
    }).catch(() => {});
    setSp(prev => { const n = new URLSearchParams(prev); n.delete('candidate'); return n; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const openNew = () => { setEditing(null); setForm(EMPTY_FORM); setCandName(''); setFormOpen(true); };
  const openEdit = (iv) => {
    setEditing(iv);
    setForm({
      candidate_id: String(iv.candidate_id), job_opening_id: iv.job_opening_id ? String(iv.job_opening_id) : '',
      interview_round: iv.interview_round || '', date: String(iv.interview_date || '').slice(0, 10),
      time: String(iv.interview_time || '').slice(0, 5), mode: iv.interview_mode === 'offline' ? 'in_person' : iv.interview_mode === 'online' ? 'video' : (iv.interview_mode || 'in_person'),
      meeting_link: iv.meeting_link || '', interviewer_id: iv.interviewer_id ? String(iv.interviewer_id) : '',
      panel: (iv.panel_employee_ids || []).map(String), notes: iv.notes || '',
    });
    setCandName(iv.candidate_name);
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.candidate_id) return toast('Choose the candidate', 'error');
    if (!form.date) return toast('Choose the interview date', 'error');
    if (!form.interviewer_id) return toast('Choose the interviewer — they get the reminder and give the feedback', 'error');
    if (form.mode === 'video' && form.meeting_link && !/^https?:\/\//i.test(form.meeting_link)) return toast('The meeting link must start with http:// or https://', 'error');
    setSaving(true);
    const body = {
      interview_date: form.date, interview_time: form.time || '', interview_mode: form.mode,
      meeting_link: form.meeting_link, interviewer_id: Number(form.interviewer_id),
      panel_employee_ids: form.panel.map(Number), interview_round: form.interview_round || '',
      job_opening_id: form.job_opening_id ? Number(form.job_opening_id) : '', notes: form.notes,
    };
    try {
      if (editing) {
        await api.put(`/recruitment/interviews/${editing.id}`, body);
        toast('Interview updated');
      } else {
        await api.post('/recruitment/interviews', { ...body, candidate_id: Number(form.candidate_id) });
        toast('Interview scheduled — the interviewer and panel have been notified');
      }
      setFormOpen(false);
      fetchInterviews();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not save the interview', 'error');
    } finally { setSaving(false); }
  };

  const cancelInterview = async (iv) => {
    const reason = window.prompt(`Cancel the interview with ${iv.candidate_name}? Give a reason (optional).`);
    if (reason === null) return;
    try {
      await api.put(`/recruitment/interviews/${iv.id}`, { status: 'cancelled', ...(reason.trim() ? { notes: `Cancelled: ${reason.trim()}` } : {}) });
      toast('Interview cancelled');
      fetchInterviews();
    } catch (err) { toast(err?.response?.data?.error || 'Could not cancel the interview', 'error'); }
  };

  const handleCompleteFeedback = async () => {
    if (feedback.outcome === 'rejected' && !feedback.rejection_reason.trim())
      return toast('Give the reason the candidate is not moving on', 'error');
    setSubmittingFb(true);
    try {
      const res = await api.post(`/recruitment/interviews/${completingIv.id}/submit-feedback`, {
        outcome:          feedback.outcome,
        rejection_reason: feedback.rejection_reason || undefined,
        rating:           feedback.rating || undefined,
        comments:         feedback.comments || undefined,
      });
      toast(res.data?.message || 'Feedback saved');
      setCompletingIv(null);
      fetchInterviews();
    } catch (err) {
      toast(err?.response?.data?.error || 'Could not save the feedback', 'error');
    } finally { setSubmittingFb(false); }
  };

  const openCandidate = (id) => { setSelectedCandidateId(id); setPage?.('CandidateDetail'); };

  const grouped = {};
  interviews.forEach(iv => {
    const d = String(iv.interview_date || '').slice(0, 10);
    (grouped[d] = grouped[d] || []).push(iv);
  });
  const sortedDates = Object.keys(grouped).sort();

  const empName = (id) => employees.find(e => String(e.id) === String(id))?.name || '';

  return (
    <PageShell dock={
      <PageHero
        icon={UserPlus}
        eyebrow="Recruitment"
        title="Interview Scheduler"
        subtitle="Book interviews with an interviewer and panel, reschedule, and record the outcome"
      />
    }>

      {formOpen && (
        <Dialog width="min(520px,100vw)" boxShadow="-4px 0 24px rgba(0,0,0,.15)" overflowY="auto">
          <div style={{ padding: '18px 22px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{editing ? 'Edit or reschedule interview' : 'Schedule interview'}</h3>
            <button onClick={() => setFormOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
          </div>
          <div style={{ padding: '18px 22px', flex: 1, display: 'grid', gap: 14 }}>
            <div>
              <div style={labelStyle}>Candidate *</div>
              {editing
                ? <div style={{ ...inputStyle, background: '#f9fafb' }}>{candName}</div>
                : <CandidatePicker value={form.candidate_id} initialName={candName}
                                   onChange={(c) => { set('candidate_id', String(c.id)); setCandName(c.full_name);
                                                      if (c.applied_job_id) set('job_opening_id', String(c.applied_job_id)); }} />}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={labelStyle}>Round</div>
                <select style={inputStyle} value={form.interview_round} onChange={e => set('interview_round', e.target.value)}>
                  <option value="">Not specified</option>
                  {INTERVIEW_ROUNDS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>For job</div>
                <select style={inputStyle} value={form.job_opening_id} onChange={e => set('job_opening_id', e.target.value)}>
                  <option value="">Candidate's applied job</option>
                  {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Date *</div>
                <input type="date" style={inputStyle} value={form.date} onChange={e => set('date', e.target.value)} />
              </div>
              <div>
                <div style={labelStyle}>Time</div>
                <input type="time" style={inputStyle} value={form.time} onChange={e => set('time', e.target.value)} />
              </div>
              <div>
                <div style={labelStyle}>Mode</div>
                <select style={inputStyle} value={form.mode} onChange={e => set('mode', e.target.value)}>
                  {INTERVIEW_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Meeting link</div>
                <input style={inputStyle} value={form.meeting_link} onChange={e => set('meeting_link', e.target.value)}
                       placeholder={form.mode === 'video' ? 'https://meet…' : 'Not needed'} disabled={form.mode !== 'video'} />
              </div>
            </div>
            <div>
              <div style={labelStyle}>Interviewer (lead) *</div>
              <select style={inputStyle} value={form.interviewer_id} onChange={e => set('interviewer_id', e.target.value)}>
                <option value="">Choose an employee…</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` — ${e.designation}` : ''}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Panel members</div>
              <select style={inputStyle} value="" onChange={e => { const v = e.target.value; if (v && !form.panel.includes(v) && v !== form.interviewer_id) set('panel', [...form.panel, v]); }}>
                <option value="">Add a panel member…</option>
                {employees.filter(e => String(e.id) !== form.interviewer_id && !form.panel.includes(String(e.id)))
                  .map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` — ${e.designation}` : ''}</option>)}
              </select>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {form.panel.map(id => (
                  <span key={id} style={{ background: '#f5f3ff', color: 'var(--color-primary, #6B3FDB)', borderRadius: 14, padding: '3px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {empName(id) || `#${id}`}
                    <button type="button" aria-label="Remove" onClick={() => set('panel', form.panel.filter(x => x !== id))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}><X size={11} /></button>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Notes</div>
              <textarea rows={3} style={inputStyle} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Anything the panel should know…" />
            </div>
          </div>
          <div style={{ padding: '14px 22px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10, background: '#fafafa' }}>
            <button className="pulse-btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
            <button className="pulse-btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Schedule'}</button>
          </div>
        </Dialog>
      )}

      {completingIv && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', width: 'min(480px,94vw)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#1f2937' }}>Record the outcome</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
                  {completingIv.candidate_name} · {interviewRoundLabel(completingIv.interview_round)} · {fmtDateStr(completingIv.interview_date)}
                </p>
              </div>
              <button onClick={() => setCompletingIv(null)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <div style={labelStyle}>Outcome *</div>
                <select style={inputStyle} value={feedback.outcome} onChange={e => setFeedback(f => ({ ...f, outcome: e.target.value }))}>
                  <option value="selected">Selected — moves on (1st level → 2nd level, 2nd level/final → offer)</option>
                  <option value="rejected">Not selected — moves to Not Suitable</option>
                </select>
              </div>
              {feedback.outcome === 'rejected' && (
                <div>
                  <div style={labelStyle}>Reason *</div>
                  <input style={inputStyle} value={feedback.rejection_reason} onChange={e => setFeedback(f => ({ ...f, rejection_reason: e.target.value }))} />
                </div>
              )}
              <div>
                <div style={labelStyle}>Rating (1–5)</div>
                <input type="number" min="1" max="5" step="0.5" style={inputStyle} value={feedback.rating} onChange={e => setFeedback(f => ({ ...f, rating: e.target.value }))} />
              </div>
              <div>
                <div style={labelStyle}>Comments</div>
                <textarea rows={3} style={inputStyle} value={feedback.comments} onChange={e => setFeedback(f => ({ ...f, comments: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button className="pulse-btn-secondary" onClick={() => setCompletingIv(null)}>Cancel</button>
              <button className="pulse-btn-primary" onClick={handleCompleteFeedback} disabled={submittingFb}>{submittingFb ? 'Saving…' : 'Save & complete'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="is-header">
        <div className="is-header-r" style={{ flexWrap: 'wrap' }}>
          <input type="date" className="is-date-input" value={dateFilter} onChange={e => setDateFilter(e.target.value)} aria-label="Date" />
          <select className="is-select" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Status">
            <option value="all">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select className="is-select" value={deptFilter} onChange={e => pickDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} /> Only mine
          </label>
          {dateFilter && <button className="is-clear-btn" onClick={() => setDateFilter('')}>Clear date</button>}
          <button className="pulse-btn-primary" onClick={openNew}><Plus size={13} /> Schedule</button>
        </div>
      </div>

      {loading ? (
        <div className="is-skeleton-list">{[1, 2, 3].map(i => <div key={i} className="is-skeleton-row" />)}</div>
      ) : sortedDates.length === 0 ? (
        <div className="is-empty">
          <CalendarDays size={40} color="#c4b5fd" />
          <p>No interviews {filter !== 'all' ? filter : ''}{dateFilter ? ' on this date' : ''}</p>
        </div>
      ) : (
        <div className="is-timeline">
          {sortedDates.map(date => {
            const df = fmtDate(date);
            return (
              <div key={date} className="is-date-group">
                <div className={`is-date-hd ${df.isToday ? 'is-date-today' : ''}`}>
                  <div className="is-date-dot" />
                  <div className="is-date-info">
                    <span className="is-date-label">{df.label}</span>
                    <span className="is-date-sub">{df.sub}</span>
                  </div>
                  <span className="is-date-count">{grouped[date].length} interview{grouped[date].length > 1 ? 's' : ''}</span>
                </div>
                <div className="is-cards">
                  {grouped[date].map(iv => {
                    const sm = STATUS_META[iv.status] || STATUS_META.scheduled;
                    const mm = MODE_META[iv.interview_mode] || MODE_META.in_person;
                    const StatusIcon = sm.icon;
                    const ModeIcon   = mm.icon;
                    const initials   = (iv.candidate_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <div key={iv.id} className="is-card">
                        <div className="is-card-time">
                          <Clock size={12} color="#9ca3af" />
                          <span className="is-time">{fmtTime(iv.interview_time)}</span>
                          <div className="is-mode-pill" style={{ background: mm.bg, color: mm.color }}>
                            <ModeIcon size={10} /><span>{mm.label}</span>
                          </div>
                        </div>
                        <div className="is-card-divider" />
                        <div className="is-card-body">
                          <div className="is-candidate-row">
                            <div className="is-avatar">{initials}</div>
                            <div>
                              <button type="button" className="is-candidate-name" onClick={() => openCandidate(iv.candidate_id)}
                                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>{iv.candidate_name}</button>
                              <div className="is-candidate-email">
                                {[interviewRoundLabel(iv.interview_round) !== '—' ? interviewRoundLabel(iv.interview_round) : null, iv.job_title].filter(Boolean).join(' · ') || iv.candidate_email}
                              </div>
                            </div>
                          </div>
                          <div className="is-meta-row">
                            <span className="is-meta-item"><User size={11} /> {iv.interviewer_name || 'No interviewer'}
                              {Array.isArray(iv.panel) && iv.panel.length ? ` + ${iv.panel.map(p => p.name).join(', ')}` : ''}</span>
                            {iv.meeting_link && (
                              <a href={iv.meeting_link} target="_blank" rel="noopener noreferrer" className="is-meeting-link"><Link2 size={11} /> Join meeting</a>
                            )}
                            {iv.feedback_count > 0 && <span className="is-meta-item"><FileText size={11} /> {iv.feedback_count} feedback</span>}
                            {iv.notes && <span className="is-meta-item"><FileText size={11} /> {iv.notes}</span>}
                          </div>
                        </div>
                        <div className="is-card-r">
                          <span className="is-status-badge" style={{ background: sm.bg, color: sm.color }}>
                            <StatusIcon size={10} /> {sm.label}
                          </span>
                          <div className="is-action-row">
                            {iv.status === 'scheduled' && (<>
                              <button className="is-btn-complete"
                                      onClick={() => { setFeedback({ outcome: 'selected', rejection_reason: '', rating: '', comments: '' }); setCompletingIv(iv); }}>
                                <CheckCircle size={12} /> Complete
                              </button>
                              <button className="is-btn-cancel" onClick={() => openEdit(iv)}><Pencil size={12} /> Edit</button>
                              <button className="is-btn-cancel" onClick={() => cancelInterview(iv)}><XCircle size={12} /> Cancel</button>
                            </>)}
                            <button onClick={() => setQuestionsFor(iv)}
                                    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                              <BookOpen size={11} /> Questions{Array.isArray(iv.question_ids) && iv.question_ids.length ? ` (${iv.question_ids.length})` : ''}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {questionsFor && (
        <SuggestedQuestionsPanel
          interview={questionsFor}
          onClose={() => { setQuestionsFor(null); fetchInterviews(); }}
        />
      )}
    </PageShell>
  );
};

export default InterviewScheduler;
