import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { Calendar, Clock, Video, Building2, Phone, User, Link2, FileText, CheckCircle, XCircle, RefreshCw, CalendarDays, BookOpen, Square, CheckSquare, X, Search, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import './InterviewScheduler.css';
import { useToast } from '@/context/ToastContext';

const STATUS_META = {
  scheduled:   { label: 'Scheduled',   bg: '#dbeafe', color: '#1d4ed8', icon: Clock },
  completed:   { label: 'Completed',   bg: '#dcfce7', color: '#15803d', icon: CheckCircle },
  cancelled:   { label: 'Cancelled',   bg: '#fee2e2', color: '#b91c1c', icon: XCircle },
  rescheduled: { label: 'Rescheduled', bg: '#fef3c7', color: '#92400e', icon: RefreshCw },
};

const MODE_META = {
  online:  { label: 'Online',  icon: Video,      color: '#4f46e5', bg: '#e0e7ff' },
  offline: { label: 'In Person', icon: Building2, color: '#0369a1', bg: '#dbeafe' },
  phone:   { label: 'Phone',   icon: Phone,      color: '#0f766e', bg: '#ccfbf1' },
};

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
    if (dt.getTime() === today.getTime()) return { label: 'Today', sub: dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }), isToday: true };
    if (dt.getTime() === tomorrow.getTime()) return { label: 'Tomorrow', sub: dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }), isToday: false };
    return { label: dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }), sub: dt.getFullYear().toString(), isToday: false };
  } catch { return { label: d, sub: '', isToday: false }; }
};

// ── Suggested Questions side panel ───────────────────────────────────────────
const CAT_STYLE = {
  HR:             { bg: '#dbeafe', color: '#1d4ed8' },
  Technical:      { bg: '#ede9fe', color: '#6d28d9' },
  Behavioural:    { bg: '#fce7f3', color: '#9d174d' },
  Situational:    { bg: '#fef3c7', color: '#92400e' },
  'Cultural Fit': { bg: '#d1fae5', color: '#065f46' },
  Domain:         { bg: '#f0fdf4', color: '#15803d' },
};
const DIFF_STYLE = {
  easy:   { bg: '#dcfce7', color: '#15803d' },
  medium: { bg: '#fef3c7', color: '#92400e' },
  hard:   { bg: '#fee2e2', color: '#b91c1c' },
};

function SuggestedQuestionsPanel({ interview, onClose }) {
  const toast = useToast();
  const [questions,  setQuestions]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [checked,    setChecked]    = useState({});           // id → bool
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

  const toggle      = (id) => setChecked(p => ({ ...p, [id]: !p[id] }));
  const toggleExp   = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));
  const checkedCount = Object.values(checked).filter(Boolean).length;

  const categories = [...new Set(questions.map(q => q.category))].sort();

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 460, height: '100%', display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px rgba(0,0,0,.15)' }}>

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
                        <p style={{ fontSize: 11, fontWeight: 600, color: '#92400e', margin: '0 0 3px', textTransform: 'uppercase', letterSpacing: .3 }}>Hints</p>
                        <p style={{ fontSize: 11, color: '#78350f', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{q.expected_answer}</p>
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
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const InterviewScheduler = ({ setPage }) => {
  const _toast = useToast();
  const toast  = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const [interviews,   setInterviews]   = useState([]);
  const [candidates,   setCandidates]   = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [filter,       setFilter]       = useState('all');
  const [dateFilter,   setDateFilter]   = useState('');
  const [questionsFor, setQuestionsFor] = useState(null);
  // Schedule drawer
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedForm,    setSchedForm]    = useState({ candidate_id: '', date: '', time: '', mode: 'offline', interviewer: '', notes: '' });
  const [scheduling,   setScheduling]   = useState(false);
  // Complete-with-feedback modal
  const [completingIv, setCompletingIv] = useState(null);
  const [feedback,     setFeedback]     = useState({ outcome: 'selected', rejection_reason: '', rating: '', comments: '' });
  const [submittingFb, setSubmittingFb] = useState(false);

  const fetchInterviews = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter !== 'all') params.status = filter;
      if (dateFilter) params.interview_date = dateFilter;
      const res = await api.get('/recruitment/interviews', { params });
      setInterviews(Array.isArray(res.data) ? res.data : []);
    } catch { setInterviews([]); }
    finally { setLoading(false); }
  }, [filter, dateFilter]);

  useEffect(() => { fetchInterviews(); }, [fetchInterviews]);

  useEffect(() => {
    api.get('/recruitment/candidates').then(r => setCandidates(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const cancelInterview = async (id) => {
    try {
      await api.put(`/recruitment/interviews/${id}`, { status: 'cancelled' });
      toast('Interview cancelled');
      fetchInterviews();
    } catch { toast('Error cancelling interview', 'error'); }
  };

  const handleSchedule = async () => {
    if (!schedForm.candidate_id) return toast('Select a candidate', 'error');
    if (!schedForm.date || !schedForm.time) return toast('Date and time are required', 'error');
    setScheduling(true);
    try {
      await api.post('/recruitment/interviews', {
        candidate_id:   schedForm.candidate_id,
        interview_date: schedForm.date,
        interview_time: schedForm.time,
        interview_mode: schedForm.mode,
        notes: schedForm.interviewer
          ? `Interviewer: ${schedForm.interviewer}${schedForm.notes ? ' — ' + schedForm.notes : ''}`
          : schedForm.notes,
      });
      toast('Interview scheduled');
      setScheduleOpen(false);
      setSchedForm({ candidate_id: '', date: '', time: '', mode: 'offline', interviewer: '', notes: '' });
      fetchInterviews();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to schedule', 'error');
    } finally { setScheduling(false); }
  };

  const handleCompleteFeedback = async () => {
    if (feedback.outcome === 'rejected' && !feedback.rejection_reason.trim())
      return toast('Rejection reason is required', 'error');
    setSubmittingFb(true);
    try {
      await api.post(`/recruitment/interviews/${completingIv.id}/submit-feedback`, {
        outcome:          feedback.outcome,
        rejection_reason: feedback.rejection_reason || undefined,
        rating:           feedback.rating || undefined,
        comments:         feedback.comments || undefined,
      });
      toast('Interview completed — candidate stage updated');
      setCompletingIv(null);
      setFeedback({ outcome: 'selected', rejection_reason: '', rating: '', comments: '' });
      fetchInterviews();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to submit feedback', 'error');
    } finally { setSubmittingFb(false); }
  };

  const openCandidate = (id) => { setSelectedCandidateId(id); setPage('CandidateDetail'); };

  // Group by date
  const grouped = {};
  interviews.forEach(iv => {
    const d = iv.interview_date;
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(iv);
  });
  const sortedDates = Object.keys(grouped).sort();

  const counts = {
    total:       interviews.length,
    scheduled:   interviews.filter(i => i.status === 'scheduled').length,
    completed:   interviews.filter(i => i.status === 'completed').length,
    cancelled:   interviews.filter(i => i.status === 'cancelled').length,
  };

  return (
    <div className="is-root">

      {/* Schedule Drawer */}
      {scheduleOpen && (
        <>
          <div onClick={() => setScheduleOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 900 }} />
          <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(480px,95vw)', background: '#fff', zIndex: 901, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(0,0,0,.15)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 800, fontSize: 16, color: '#1f2937' }}>Schedule Interview</span>
              <button onClick={() => setScheduleOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { label: 'Candidate *', node: (
                  <select style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none' }}
                    value={schedForm.candidate_id} onChange={e => setSchedForm(f => ({ ...f, candidate_id: e.target.value }))}>
                    <option value="">Select candidate…</option>
                    {candidates.map(c => <option key={c.id} value={c.id}>{c.full_name} — {c.job_title || ''}</option>)}
                  </select>
                )},
                { label: 'Date *', node: <input type="date" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} value={schedForm.date} onChange={e => setSchedForm(f => ({ ...f, date: e.target.value }))} /> },
                { label: 'Time *', node: <input type="time" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} value={schedForm.time} onChange={e => setSchedForm(f => ({ ...f, time: e.target.value }))} /> },
                { label: 'Mode', node: (
                  <select style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none' }}
                    value={schedForm.mode} onChange={e => setSchedForm(f => ({ ...f, mode: e.target.value }))}>
                    <option value="offline">In Person</option>
                    <option value="online">Online</option>
                    <option value="phone">Phone</option>
                  </select>
                )},
                { label: 'Interviewer', node: <input style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} placeholder="Interviewer name" value={schedForm.interviewer} onChange={e => setSchedForm(f => ({ ...f, interviewer: e.target.value }))} /> },
                { label: 'Notes', node: <textarea rows={3} style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} value={schedForm.notes} onChange={e => setSchedForm(f => ({ ...f, notes: e.target.value }))} /> },
              ].map(({ label, node }) => (
                <div key={label}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>{label}</div>
                  {node}
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #f0f0f4', display: 'flex', justifyContent: 'flex-end', gap: 10, background: '#fafafa' }}>
              <button onClick={() => setScheduleOpen(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSchedule} disabled={scheduling} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#4B2DCE', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13, opacity: scheduling ? 0.7 : 1 }}>
                {scheduling ? 'Scheduling…' : 'Schedule'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Complete with Feedback Modal */}
      {completingIv && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 30px', width: 'min(480px,94vw)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#1f2937' }}>Mark Interview Complete</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>{completingIv.candidate_name} · {completingIv.interview_date}</p>
              </div>
              <button onClick={() => setCompletingIv(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={18} /></button>
            </div>
            {[
              { label: 'Outcome *', node: (
                <select style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none' }}
                  value={feedback.outcome} onChange={e => setFeedback(f => ({ ...f, outcome: e.target.value }))}>
                  <option value="selected">Selected — advance to next stage</option>
                  <option value="rejected">Rejected — move to Not Suitable</option>
                </select>
              )},
              ...(feedback.outcome === 'rejected' ? [{ label: 'Rejection Reason *', node: <input style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} placeholder="Reason for rejection…" value={feedback.rejection_reason} onChange={e => setFeedback(f => ({ ...f, rejection_reason: e.target.value }))} /> }] : []),
              { label: 'Rating (1–5)', node: <input type="number" min="1" max="5" step="0.1" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} value={feedback.rating} onChange={e => setFeedback(f => ({ ...f, rating: e.target.value }))} /> },
              { label: 'Comments', node: <textarea rows={3} style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} placeholder="Optional notes…" value={feedback.comments} onChange={e => setFeedback(f => ({ ...f, comments: e.target.value }))} /> },
            ].map(({ label, node }) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>{label}</div>
                {node}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button onClick={() => setCompletingIv(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleCompleteFeedback} disabled={submittingFb} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 13, opacity: submittingFb ? 0.7 : 1 }}>
                {submittingFb ? 'Submitting…' : 'Submit & Complete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="is-header">
        <div className="is-header-l">
          <div className="is-header-icon"><CalendarDays size={18} /></div>
          <div>
            <h1 className="is-title">Interview Scheduler</h1>
            <p className="is-sub">All scheduled interviews by date</p>
          </div>
        </div>
        <div className="is-header-r">
          <input type="date" className="is-date-input" value={dateFilter}
            onChange={e => setDateFilter(e.target.value)} />
          <select className="is-select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="rescheduled">Rescheduled</option>
          </select>
          {dateFilter && (
            <button className="is-clear-btn" onClick={() => setDateFilter('')}>Clear date</button>
          )}
          <button
            onClick={() => setScheduleOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', background: '#4B2DCE', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
          >
            <Plus size={13} /> Schedule
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="is-summary">
        {[
          { label: 'Total',     value: counts.total,     cls: 'is-sum-purple' },
          { label: 'Scheduled', value: counts.scheduled, cls: 'is-sum-blue' },
          { label: 'Completed', value: counts.completed, cls: 'is-sum-green' },
          { label: 'Cancelled', value: counts.cancelled, cls: 'is-sum-red' },
        ].map(c => (
          <div key={c.label} className="is-sum-card">
            <span className={`is-sum-val ${c.cls}`}>{c.value}</span>
            <span className="is-sum-label">{c.label}</span>
          </div>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="is-skeleton-list">
          {[1,2,3].map(i => <div key={i} className="is-skeleton-row" />)}
        </div>
      ) : sortedDates.length === 0 ? (
        <div className="is-empty">
          <CalendarDays size={40} color="#c4b5fd" />
          <p>No interviews scheduled</p>
        </div>
      ) : (
        <div className="is-timeline">
          {sortedDates.map(date => {
            const df = fmtDate(date);
            return (
              <div key={date} className="is-date-group">

                {/* Date heading */}
                <div className={`is-date-hd ${df.isToday ? 'is-date-today' : ''}`}>
                  <div className="is-date-dot" />
                  <div className="is-date-info">
                    <span className="is-date-label">{df.label}</span>
                    <span className="is-date-sub">{df.sub}</span>
                  </div>
                  <span className="is-date-count">{grouped[date].length} interview{grouped[date].length > 1 ? 's' : ''}</span>
                </div>

                {/* Interview cards */}
                <div className="is-cards">
                  {grouped[date].map(iv => {
                    const sm = STATUS_META[iv.status] || STATUS_META.scheduled;
                    const mm = MODE_META[iv.interview_mode] || MODE_META.offline;
                    const StatusIcon = sm.icon;
                    const ModeIcon   = mm.icon;
                    const initials   = (iv.candidate_name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();

                    return (
                      <div key={iv.id} className="is-card">

                        {/* Left — time */}
                        <div className="is-card-time">
                          <Clock size={12} color="#9ca3af" />
                          <span className="is-time">{fmtTime(iv.interview_time)}</span>
                          <div className="is-mode-pill" style={{ background: mm.bg, color: mm.color }}>
                            <ModeIcon size={10} />
                            <span>{mm.label}</span>
                          </div>
                        </div>

                        {/* Divider */}
                        <div className="is-card-divider" />

                        {/* Center — details */}
                        <div className="is-card-body">
                          <div className="is-candidate-row">
                            <div className="is-avatar">{initials}</div>
                            <div>
                              <div className="is-candidate-name"
                                onClick={() => openCandidate(iv.candidate_id)}>{iv.candidate_name}</div>
                              <div className="is-candidate-email">{iv.candidate_email}</div>
                            </div>
                          </div>

                          <div className="is-meta-row">
                            {iv.interviewer_name && (
                              <span className="is-meta-item"><User size={11} /> {iv.interviewer_name}</span>
                            )}
                            {iv.meeting_link && (
                              <a href={iv.meeting_link} target="_blank" rel="noopener noreferrer" className="is-meeting-link">
                                <Link2 size={11} /> Join Meeting
                              </a>
                            )}
                            {iv.notes && (
                              <span className="is-meta-item"><FileText size={11} /> {iv.notes}</span>
                            )}
                          </div>
                        </div>

                        {/* Right — status + actions */}
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
                              <button className="is-btn-cancel"
                                onClick={() => cancelInterview(iv.id)}>
                                <XCircle size={12} /> Cancel
                              </button>
                            </>)}
                            <button
                              onClick={() => setQuestionsFor(iv)}
                              style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600 }}
                            >
                              <BookOpen size={11}/> Questions
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
          onClose={() => setQuestionsFor(null)}
        />
      )}
    </div>
  );
};

export default InterviewScheduler;
