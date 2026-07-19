import { useState, useEffect } from 'react';
import { Plus, CheckCircle, Clock, X, AlertCircle, RefreshCw, User, BarChart2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';

const STATUS_COLOR = {
  pending:   { bg: '#f59e0b18', text: '#f59e0b' },
  submitted: { bg: '#10b98118', text: '#10b981' },
  declined:  { bg: '#ef444418', text: '#ef4444' },
};

const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

export default function Feedback360() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid these controls from anyone holding manager/hr
  // as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isMgr = hasAnyRole('manager', 'hr', 'super_admin', 'admin');
  const isHR  = hasAnyRole('hr', 'super_admin', 'admin');

  const [tab, setTab]               = useState('to_review');
  const [requests, setRequests]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [feedback, setFeedback]     = useState({});
  const [showSubmit, setShowSubmit] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const as = tab === 'to_review' ? 'reviewer' : 'reviewee';
      const res = await api.get(`/performance/feedback?as=${as}`);
      setRequests(res.data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [tab]);

  async function submitFeedback(id) {
    const f = feedback[id] || {};
    if (!f.overall_score) { setError('Overall score is required'); return; }
    setSubmitting(id);
    try {
      await api.patch(`/performance/feedback/${id}/submit`, {
        overall_score: parseFloat(f.overall_score),
        feedback_text: f.feedback_text || '',
        strengths: f.strengths || '',
        improvements: f.improvements || '',
      });
      setShowSubmit(null);
      load();
    } catch (e) { setError(e.message); }
    finally { setSubmitting(null); }
  }

  async function decline(id) {
    try { await api.patch(`/performance/feedback/${id}/decline`); load(); }
    catch (e) { setError(e.message); }
  }

  const setF = (id, key, val) => setFeedback(f => ({ ...f, [id]: { ...(f[id] || {}), [key]: val } }));

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>360° Feedback</h1>
      </div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {[
          { key: 'to_review',  label: 'Feedback to Give' },
          { key: 'about_me',   label: 'Feedback About Me' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13,
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            borderBottom: tab === t.key ? '2px solid var(--color-primary)' : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)' }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : requests.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
          <CheckCircle size={36} style={{ marginBottom: 12, color: 'var(--color-text-tertiary)' }} />
          <p style={{ margin: 0, fontWeight: 500 }}>{tab === 'to_review' ? 'No pending feedback requests' : 'No feedback received yet'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {requests.map(r => {
            const sc = STATUS_COLOR[r.status] || STATUS_COLOR.pending;
            const isOpen = showSubmit === r.id;
            return (
              <div key={r.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#3b82f618', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <User size={16} style={{ color: '#3b82f6' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: '0 0 2px', fontWeight: 600, fontSize: 14 }}>
                      {tab === 'to_review' ? r.employee_name : (r.provider_name || 'Anonymous')}
                    </p>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      <span>Relationship: {r.relationship}</span>
                      {r.due_date && <span>Due: {r.due_date?.slice(0, 10)}</span>}
                      {r.overall_score && <span>Score: <strong>{r.overall_score}/5</strong></span>}
                    </div>
                  </div>
                  <span style={{ background: sc.bg, color: sc.text, padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                    {r.status}
                  </span>
                  {tab === 'to_review' && r.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setShowSubmit(isOpen ? null : r.id)} style={{
                        padding: '6px 14px', background: 'var(--color-primary)', color: '#fff',
                        border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      }}>Give Feedback</button>
                      <button onClick={() => decline(r.id)} style={{
                        padding: '6px 14px', background: '#ef444418', color: '#ef4444',
                        border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                      }}>Decline</button>
                    </div>
                  )}
                </div>

                {isOpen && (
                  <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '16px 20px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Overall Score (1-5) *</label>
                        <select style={inp} value={feedback[r.id]?.overall_score || ''} onChange={e => setF(r.id, 'overall_score', e.target.value)}>
                          <option value="">Select score</option>
                          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} — {['', 'Unsatisfactory', 'Below Expectations', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'][n]}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Feedback</label>
                        <textarea style={{ ...inp, minHeight: 60, resize: 'vertical' }} value={feedback[r.id]?.feedback_text || ''} onChange={e => setF(r.id, 'feedback_text', e.target.value)} placeholder="Overall feedback..." />
                      </div>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Key Strengths</label>
                        <textarea style={{ ...inp, minHeight: 60, resize: 'vertical' }} value={feedback[r.id]?.strengths || ''} onChange={e => setF(r.id, 'strengths', e.target.value)} placeholder="What does this person do well?" />
                      </div>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Areas for Improvement</label>
                        <textarea style={{ ...inp, minHeight: 60, resize: 'vertical' }} value={feedback[r.id]?.improvements || ''} onChange={e => setF(r.id, 'improvements', e.target.value)} placeholder="What could be improved?" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => submitFeedback(r.id)} disabled={submitting === r.id} style={{ padding: '8px 20px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                        {submitting === r.id ? 'Submitting...' : 'Submit Feedback'}
                      </button>
                      <button onClick={() => setShowSubmit(null)} style={{ padding: '8px 20px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                    </div>
                  </div>
                )}

                {tab === 'about_me' && r.status === 'submitted' && (
                  <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '12px 20px', background: '#10b98108' }}>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
                      {r.feedback_text || 'No additional comments'}
                    </p>
                    {r.strengths && <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}><strong>Strengths:</strong> {r.strengths}</p>}
                    {r.improvements && <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}><strong>Improvements:</strong> {r.improvements}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
