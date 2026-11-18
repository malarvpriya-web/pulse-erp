import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, Video, Star, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import ResumeViewer from '../shared/components/ResumeViewer';
import { interviewRoundLabel, interviewModeLabel } from '../shared/constants';

/**
 * My Interviews — for anyone booked as an interviewer or panel member.
 *
 * Open to every role (PERSONAL_PAGES): interviewers are usually engineers or
 * managers without Recruitment access. /my-interviews returns only interviews
 * the caller is on, with just what they need to interview — the candidate's
 * current role, experience, skills, résumé and the chosen questions. They give
 * their own feedback here; the recruiter records the outcome that moves the
 * candidate on.
 *
 * Reached from the bell (interview_assigned / interview_reminder) and from
 * Home's My Pending Approvals (Approval Center source `ivfb`). No menu row.
 */
const REC = [
  { value: 'strong_hire', label: 'Strong hire' },
  { value: 'hire',        label: 'Hire' },
  { value: 'hold',        label: 'Hold' },
  { value: 'reject',      label: 'Do not hire' },
];
const recLabel = (v) => REC.find(r => r.value === v)?.label || v;

export default function MyInterviews() {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const [sp] = useSearchParams();
  const [scope, setScope] = useState('upcoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(sp.get('interview') || null);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/my-interviews', { params: { scope } });
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setRows([]);
      setError(e?.response?.data?.error || 'Could not load your interviews.');
    } finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  // Arriving for a past interview (Approval Center) switches to Past if needed.
  useEffect(() => {
    const id = sp.get('interview');
    if (!id || loading || scope === 'past' || rows.some(r => r.id === id)) return;
    setScope('past');
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftOf = (iv) => drafts[iv.id] ?? {
    rating: iv.my_feedback?.rating ?? '', recommendation: iv.my_feedback?.recommendation ?? '', comments: iv.my_feedback?.comments ?? '',
  };
  const setDraft = (iv, k, v) => setDrafts(d => ({ ...d, [iv.id]: { ...draftOf(iv), [k]: v } }));

  const save = async (iv) => {
    const d = draftOf(iv);
    if (!d.recommendation) return toast('Choose your recommendation', 'error');
    setSaving(iv.id);
    try {
      await api.post(`/my-interviews/${iv.id}/feedback`, d);
      toast('Feedback saved — the recruiter can see it on the candidate profile');
      setDrafts(x => { const n = { ...x }; delete n[iv.id]; return n; });
      load();
    } catch (e) { toast(e?.response?.data?.error || 'Could not save your feedback', 'error'); }
    finally { setSaving(null); }
  };

  const field = { width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', background: '#fff' };

  return (
    <PageShell dock={
      <PageHero
        icon={CalendarDays}
        eyebrow="My work"
        title="My Interviews"
        subtitle="Interviews you are leading or on the panel for, and your feedback"
        actions={['upcoming', 'past'].map(k => (
          <button key={k} type="button" className={`plh-cta${scope === k ? '' : ' plh-cta--ghost'}`} onClick={() => setScope(k)}>
            {k === 'upcoming' ? 'Upcoming' : 'Past 90 days'}
          </button>
        ))}
      />
    }>
      {loading ? <p style={{ color: '#9ca3af' }}>Loading…</p>
       : error ? <p style={{ color: '#b91c1c' }}>{error}</p>
       : rows.length === 0 ? (
        <div style={{ background: '#fff', border: '1px solid #eef0f4', borderRadius: 12, padding: 32, textAlign: 'center', color: '#6b7280' }}>
          {scope === 'upcoming' ? 'You are not booked on any upcoming interviews.' : 'No interviews in the last 90 days.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {rows.map(iv => {
            const open = openId === iv.id;
            const d = draftOf(iv);
            const skills = Array.isArray(iv.skills) ? iv.skills : [];
            return (
              <div key={iv.id} style={{ background: '#fff', border: `1px solid ${open ? 'var(--color-primary, #6B3FDB)' : '#eef0f4'}`, borderRadius: 12 }}>
                <button type="button" onClick={() => setOpenId(open ? null : iv.id)}
                        style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', padding: '14px 16px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ minWidth: 70, textAlign: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtDate(iv.interview_date)}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{iv.interview_time ? String(iv.interview_time).slice(0, 5) : '—'}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{iv.candidate_name}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      {[iv.job_title, interviewRoundLabel(iv.interview_round) !== '—' ? interviewRoundLabel(iv.interview_round) : null,
                        interviewModeLabel(iv.interview_mode), iv.is_lead ? 'you lead' : `panel · lead ${iv.lead_name || '—'}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {iv.my_feedback
                    ? <span style={{ fontSize: 12, color: 'var(--color-success, #16a34a)' }}>Feedback given · {recLabel(iv.my_feedback.recommendation)}</span>
                    : <span style={{ fontSize: 12, color: '#b45309' }}>Feedback pending</span>}
                  {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {open && (
                  <div style={{ borderTop: '1px solid #f3f4f6', padding: 16, display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1.3fr) minmax(280px, 1fr)' }} className="myiv-grid">
                    <div style={{ minWidth: 0 }}>
                      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, margin: '0 0 12px' }}>
                        {[['Current role', [iv.current_designation, iv.current_company].filter(Boolean).join(' @ ')],
                          ['Experience', iv.experience_years != null ? `${iv.experience_years} yrs` : ''],
                          ['Notice period', iv.notice_period_days != null ? `${iv.notice_period_days} days` : ''],
                          ['Qualification', iv.qualification], ['Location', iv.current_city || iv.location]]
                          .map(([k, v]) => (
                            <div key={k}><dt style={{ fontSize: 11, color: '#6b7280' }}>{k}</dt><dd style={{ margin: 0, fontSize: 13 }}>{v || '—'}</dd></div>
                          ))}
                      </dl>
                      {skills.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                          {skills.map(s => <span key={s} style={{ background: '#f5f3ff', color: 'var(--color-primary, #6B3FDB)', borderRadius: 12, padding: '2px 8px', fontSize: 12 }}>{s}</span>)}
                        </div>
                      )}
                      {iv.meeting_link && (
                        <p style={{ margin: '0 0 12px' }}><a href={iv.meeting_link} target="_blank" rel="noreferrer"><Video size={13} /> Join the meeting</a></p>
                      )}
                      {iv.notes && <p style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}><FileText size={12} /> {iv.notes}</p>}
                      {Array.isArray(iv.questions) && iv.questions.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Questions chosen for this interview</div>
                          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                            {iv.questions.map(q => <li key={q.id} style={{ marginBottom: 4 }}>{q.question}{q.expected_answer ? <div style={{ fontSize: 12, color: '#6b7280' }}>Look for: {q.expected_answer}</div> : null}</li>)}
                          </ol>
                        </div>
                      )}
                      {iv.has_resume ? <ResumeViewer candidate={iv} minHeight={480} />
                        : <p style={{ fontSize: 13, color: '#6b7280' }}>No résumé on file.</p>}
                    </div>

                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}><Star size={13} /> Your feedback</div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }} htmlFor={`rec-${iv.id}`}>Recommendation *</label>
                      <select id={`rec-${iv.id}`} style={{ ...field, marginBottom: 10 }} value={d.recommendation} onChange={e => setDraft(iv, 'recommendation', e.target.value)}>
                        <option value="">Choose…</option>
                        {REC.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }} htmlFor={`rat-${iv.id}`}>Rating (1–5)</label>
                      <input id={`rat-${iv.id}`} type="number" min="1" max="5" step="0.5" style={{ ...field, marginBottom: 10 }}
                             value={d.rating} onChange={e => setDraft(iv, 'rating', e.target.value)} />
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }} htmlFor={`com-${iv.id}`}>Comments</label>
                      <textarea id={`com-${iv.id}`} rows={6} style={field} value={d.comments} onChange={e => setDraft(iv, 'comments', e.target.value)}
                                placeholder="Strengths, gaps, anything the next round should probe" />
                      <button type="button" className="pulse-btn-primary" style={{ marginTop: 10 }} disabled={saving === iv.id} onClick={() => save(iv)}>
                        {saving === iv.id ? 'Saving…' : iv.my_feedback ? 'Update feedback' : 'Save feedback'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <style>{`@media (max-width: 820px) { .myiv-grid { grid-template-columns: 1fr !important; } }`}</style>
    </PageShell>
  );
}
