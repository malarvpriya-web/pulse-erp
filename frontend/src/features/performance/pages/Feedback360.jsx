import { useState, useEffect } from 'react';
import {
  Plus, CheckCircle, Clock, X, AlertCircle, RefreshCw, User, BarChart2,
  LayoutDashboard,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const STATUS_COLOR = {
  pending:   { bg: '#7c5cf018', text: '#7c5cf0' },
  submitted: { bg: '#10b98118', text: '#10b981' },
  declined:  { bg: '#ef444418', text: '#ef4444' },
};

const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

/**
 * Request feedback (2026-11-11): a manager asks someone for feedback on one of
 * their reports; HR may ask about anyone. The request lands in that person's
 * "Feedback to Give". Before this the page had no way to ask at all.
 */
function RequestFeedback({ people, me, hr, onDone, onError }) {
  const mine = people.filter(p => hr || String(p.reporting_manager_id) === String(me));
  const [about, setAbout] = useState('');
  const [from, setFrom] = useState('');
  const [anon, setAnon] = useState(false);
  const [due, setDue] = useState('');
  const [saving, setSaving] = useState(false);
  const aboutP = people.find(p => String(p.id) === String(about));
  const fromP = people.find(p => String(p.id) === String(from));
  // How the giver relates to the person reviewed, from the reporting line.
  const relationship = !aboutP || !fromP ? 'peer'
    : String(aboutP.id) === String(fromP.id) ? 'self'
    : String(aboutP.reporting_manager_id) === String(fromP.id) ? 'manager'
    : String(fromP.reporting_manager_id) === String(aboutP.id) ? 'subordinate'
    : 'peer';
  const send = async () => {
    if (!about || !from) { onError('Choose who the feedback is about and who should give it'); return; }
    setSaving(true);
    try {
      await api.post('/performance/feedback', { employee_id: Number(about), feedback_provider_id: Number(from), relationship, is_anonymous: anon, due_date: due || null });
      onDone(`Asked ${fromP?.name} for feedback on ${aboutP?.name}`);
      setFrom(''); setAnon(false);
    } catch (e) { onError(e?.response?.data?.error || 'Could not send the request'); }
    finally { setSaving(false); }
  };
  return (
    <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <p style={{ margin: '0 0 12px', fontWeight: 600, fontSize: 14 }}>Request feedback</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'end' }}>
        <label style={{ fontSize: 12, fontWeight: 600 }}>About
          <select style={inp} value={about} onChange={e => setAbout(e.target.value)} aria-label="Feedback about">
            <option value="">Choose a team member…</option>
            {mine.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, fontWeight: 600 }}>From
          <select style={inp} value={from} onChange={e => setFrom(e.target.value)} aria-label="Feedback from">
            <option value="">Who should give it…</option>
            {people.map(p => <option key={p.id} value={p.id}>{String(p.id) === String(about) ? `${p.name} (self-review)` : p.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Due by
          <input type="date" style={inp} value={due} onChange={e => setDue(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={anon} onChange={e => setAnon(e.target.checked)} /> Anonymous to {aboutP?.name || 'them'}
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button onClick={send} disabled={saving} style={{ padding: '8px 18px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Sending…' : 'Send request'}
        </button>
        {aboutP && fromP && <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Relationship: {relationship.replace('_', '-')}</span>}
      </div>
    </div>
  );
}

export default function Feedback360() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid these controls from anyone holding manager/hr
  // as a secondary role. See AuthContext.
  const { hasAnyRole, user } = useAuth();
  const isHR  = hasAnyRole('hr', 'super_admin', 'admin');

  const [tab, setTab]               = useState('to_review');
  const [requests, setRequests]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [feedback, setFeedback]     = useState({});
  const [showSubmit, setShowSubmit] = useState(null);
  const [notice, setNotice]         = useState(null);
  // People who can be asked — returned only to HR and to managers; anyone
  // else gets a 403 and simply sees no "Request feedback" button.
  const [people, setPeople]         = useState([]);
  const [showRequest, setShowRequest] = useState(false);
  useEffect(() => {
    api.get('/performance/feedback/people').then(r => setPeople(Array.isArray(r.data) ? r.data : [])).catch(() => setPeople([]));
  }, []);
  const canRequest = people.length > 0;

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
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Performance"
        title="360° Feedback"
        actions={canRequest ? (
          <button className="plh-cta" onClick={() => setShowRequest(v => !v)}>
            <Plus size={15} /> {showRequest ? 'Close request' : 'Request feedback'}
          </button>
        ) : null}
      />
    }>

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

      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>
        How it works: a manager (or HR) asks colleagues for feedback about a person. Those requests appear under
        <b> Feedback to Give</b>; give a score and comments, or decline. Feedback given about you appears under
        <b> Feedback About Me</b> — anonymous givers are not named.
      </p>

      {showRequest && canRequest && (
        <RequestFeedback people={people} me={user?.employee_id} hr={isHR}
          onDone={m => { setNotice(m); setShowRequest(false); load(); }} onError={setError} />
      )}

      {notice && (
        <div role="status" style={{ background: '#10b98118', color: '#047857', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle size={15} /> {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#047857' }}><X size={14} /></button>
        </div>
      )}

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
                  {/* Submitted feedback can be corrected until the appraisal
                      cycle closes (2026-11-11); the form opens with it filled in. */}
                  {tab === 'to_review' && r.status === 'submitted' && !isOpen && (
                    <button onClick={() => {
                      setFeedback(f => ({ ...f, [r.id]: {
                        overall_score: r.overall_score != null ? String(Number(r.overall_score)) : '',
                        feedback_text: r.feedback_text || '', strengths: r.strengths || '', improvements: r.improvements || '',
                      } }));
                      setShowSubmit(r.id);
                    }} style={{
                      padding: '6px 14px', background: 'var(--color-background)', color: 'var(--color-primary)',
                      border: '1px solid var(--color-primary)', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    }}>Edit feedback</button>
                  )}
                </div>

                {isOpen && (
                  <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '16px 20px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                      <div>
                        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Overall Score (1-5) *</label>
                        <select style={inp} value={feedback[r.id]?.overall_score || ''} onChange={e => setF(r.id, 'overall_score', e.target.value)}>
                          <option value="">Select score</option>
                          {/* An existing score between the whole numbers (e.g. 4.5) keeps its value. */}
                          {feedback[r.id]?.overall_score && !['1', '2', '3', '4', '5'].includes(feedback[r.id].overall_score) && (
                            <option value={feedback[r.id].overall_score}>{feedback[r.id].overall_score} (current)</option>
                          )}
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
                        {submitting === r.id ? 'Saving...' : r.status === 'submitted' ? 'Save changes' : 'Submit Feedback'}
                      </button>
                      <button onClick={() => setShowSubmit(null)} style={{ padding: '8px 20px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                    </div>
                  </div>
                )}

                {/* What was written: about me, and — in Feedback to Give — what I gave. */}
                {r.status === 'submitted' && !isOpen && (
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
    </PageShell>
  );
}
