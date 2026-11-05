import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { LoadingState, LoadError } from '@/components/pulse-ui';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { openApiPdf } from '../internship';

const STATUS_STYLE = {
  'Not started': { bg: '#f3f4f6', color: '#6b7280' },
  Draft:         { bg: '#f3f4f6', color: '#374151' },
  Submitted:     { bg: '#e0f2fe', color: '#075985' },
  Returned:      { bg: '#fef3c7', color: '#92400e' },
  Approved:      { bg: '#dcfce7', color: '#166534' },
  // request status
  Sent:          { bg: '#e0f2fe', color: '#075985' },
  Reminder:      { bg: '#fef3c7', color: '#92400e' },
  Received:      { bg: '#ede9fe', color: '#5b21b6' },
  Completed:     { bg: '#dcfce7', color: '#166534' },
};

export function EvaluationStatus({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.Draft;
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color }}>
      {status}
    </span>
  );
}

/** The six 1..5 ratings as selects. Shared by the mentor page and HR's "record returned evaluation". */
export function RatingInputs({ ratings, scale, values, onChange, idBase, disabled = false }) {
  return (
    <div className="ie-ratings">
      {ratings.map(f => (
        <div key={f.key} style={{ display: 'contents' }}>
          <label htmlFor={`${idBase}-${f.key}`}>{f.label}<span className="req" aria-hidden="true">*</span></label>
          <select id={`${idBase}-${f.key}`} value={values[f.key] ?? ''} disabled={disabled}
            onChange={e => onChange(f.key, e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">-- Rate --</option>
            {scale.map(s => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

/** Read-only ratings. */
export function RatingsTable({ ratings, scale, evaluation }) {
  if (!ratings?.length || ratings.every(f => evaluation[f.key] == null)) return null;
  const label = (v) => scale?.find(s => s.value === v)?.label;
  return (
    <table className="ie-rating-table">
      <tbody>
        {ratings.map(f => (
          <tr key={f.key}><td>{f.label}</td><td>{evaluation[f.key] != null ? `${evaluation[f.key]} / 5 · ${label(evaluation[f.key]) || ''}` : '—'}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

const ACTION_LABEL = {
  created: 'Draft started', saved: 'Draft saved', submitted: 'Submitted online', returned: 'Returned to mentor',
  approved: 'Approved', requested: 'Sent to mentor', reminded: 'Reminder sent', received: 'Returned document recorded',
  document_attached: 'Document attached',
};
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const OPEN = ['Draft', 'Submitted', 'Returned'];
const errText = (e, fallback) => e?.response?.data?.error || e?.message || fallback;

/** "Record returned evaluation": ratings + recommendation + comments + the mentor's document. */
function ReceiveForm({ ev, meta, onDone, onCancel }) {
  const [values, setValues] = useState({});
  const [recommendation, setRecommendation] = useState('');
  const [comments, setComments] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const complete = meta.ratings.every(f => values[f.key] != null) && recommendation && comments.trim() && file;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      for (const f of meta.ratings) fd.append(f.key, String(values[f.key]));
      fd.append('recommendation', recommendation);
      fd.append('comments', comments.trim());
      fd.append('evaluation_file', file);
      await api.post(`/intern-evaluations/${ev.id}/receive`, fd);
      onDone();
    } catch (e) { setError(errText(e, 'Could not record the evaluation.')); } finally { setBusy(false); }
  };
  const idBase = `ie-rcv-${ev.id}`;
  return (
    <div className="ie-form">
      <p className="iv-muted" style={{ margin: 0 }}>
        Enter what {ev.mentor_name || 'the mentor'} wrote on the returned form and attach it. Another HR reviewer then approves it.
      </p>
      <RatingInputs ratings={meta.ratings} scale={meta.scale} values={values} idBase={idBase}
        onChange={(k, v) => setValues(x => ({ ...x, [k]: v }))} />
      <label htmlFor={`${idBase}-rec`}>Recommendation<span className="req" aria-hidden="true">*</span></label>
      <select id={`${idBase}-rec`} value={recommendation} onChange={e => setRecommendation(e.target.value)}>
        <option value="">-- Select recommendation --</option>
        {meta.recommendations.map(r => <option key={r}>{r}</option>)}
      </select>
      <label htmlFor={`${idBase}-comments`}>Mentor comments<span className="req" aria-hidden="true">*</span></label>
      <textarea id={`${idBase}-comments`} rows={4} maxLength={5000} value={comments} onChange={e => setComments(e.target.value)} />
      <label htmlFor={`${idBase}-file`}>Returned evaluation document<span className="req" aria-hidden="true">*</span></label>
      <input id={`${idBase}-file`} type="file" accept="image/*,.pdf,.doc,.docx" onChange={e => setFile(e.target.files?.[0] || null)} />
      {error && <p role="alert" className="iv-error">{error}</p>}
      <div className="iv-modal-actions">
        <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="pulse-btn-primary" disabled={busy || !complete} onClick={submit}>
          {busy ? 'Saving…' : 'Record evaluation'}
        </button>
      </div>
    </div>
  );
}

/** Request Mentor Evaluation — pick the mentor (default: the assigned one), send now or keep as draft. */
function RequestDialog({ intern, onDone, onCancel }) {
  const [mentors, setMentors] = useState(null);
  const [mentorId, setMentorId] = useState(intern.mentor_employee_id ? String(intern.mentor_employee_id) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/interns/mentor-options').then(r => setMentors(Array.isArray(r.data) ? r.data : [])).catch(() => setMentors([]));
  }, []);
  const send = async (now) => {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/intern-evaluations/request', { intern_id: intern.id, mentor_employee_id: Number(mentorId), send: now });
      onDone(data);
    } catch (e) { setError(errText(e, 'Could not create the request.')); } finally { setBusy(false); }
  };
  return (
    <div className="iv-modal-backdrop" role="dialog" aria-modal="true" aria-label="Request mentor evaluation">
      <div className="iv-modal">
        <h3>Request Mentor Evaluation</h3>
        <p className="iv-muted">{intern.intern_code} · ends {intern.end_date}</p>
        <label htmlFor="ie-req-mentor">Mentor<span className="req" aria-hidden="true">*</span></label>
        <select id="ie-req-mentor" value={mentorId} onChange={e => setMentorId(e.target.value)} disabled={!mentors}>
          <option value="">{mentors ? '-- Select mentor --' : 'Loading…'}</option>
          {(mentors || []).map(m => (
            <option key={m.id} value={String(m.id)}>
              {m.name || `#${m.id}`}{m.office_id ? ` · ${m.office_id}` : ''}{m.id === intern.mentor_employee_id ? ' (assigned mentor)' : ''}
            </option>
          ))}
        </select>
        <p className="iv-muted" style={{ margin: '6px 0 0' }}>
          Sending notifies the mentor and opens the evaluation for them under My Intern Evaluations, with the
          evaluation letter to download. They can fill it in online or return the signed form to HR.
        </p>
        {error && <p role="alert" className="iv-error">{error}</p>}
        <div className="iv-modal-actions">
          <button type="button" className="pulse-btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="pulse-btn-secondary" onClick={() => send(false)} disabled={busy || !mentorId}>Save as draft</button>
          <button type="button" className="pulse-btn-primary" onClick={() => send(true)} disabled={busy || !mentorId}>
            {busy ? 'Sending…' : 'Send to mentor'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * HR's view of an intern's mentor evaluations, on View Intern → Evaluation.
 *
 * Request / send / remind / record a returned document need internships:edit;
 * Approve / Return needs internships:approve and is offered only to a reviewer
 * who did not write (or record) the evaluation (`is_own`). The server enforces
 * every rule itself; this only hides actions that would be refused.
 */
export default function InternEvaluationPanel({ intern, onChanged = () => {} }) {
  const internId = intern.id;
  const { hasPermission } = useAuth();
  const canReview = hasPermission('internships', 'approve');
  const canEdit = hasPermission('internships', 'edit');
  const [evals, setEvals] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [returning, setReturning] = useState(null);   // evaluation id being returned
  const [receiving, setReceiving] = useState(null);   // evaluation id being recorded from paper
  const [requesting, setRequesting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setError(null);
    api.get(`/intern-evaluations/intern/${internId}`)
      .then(r => setEvals(Array.isArray(r.data) ? r.data : []))
      .catch(e => setError(errText(e, 'Could not load evaluations.')));
  }, [internId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/intern-evaluations/meta').then(r => setMeta(r.data)).catch(() => setMeta({ ratings: [], scale: [], recommendations: [] }));
  }, []);
  const refresh = () => { load(); onChanged(); };

  const act = async (fn, okText) => {
    setBusy(true); setActionError(''); setNotice('');
    try {
      const { data } = await fn();
      if (okText) setNotice(typeof okText === 'function' ? okText(data) : okText);
      setReturning(null); setReason('');
      refresh();
    } catch (e) { setActionError(errText(e, 'The action failed.')); } finally { setBusy(false); }
  };
  const sentText = (data) => (data?.notified_logins === 0
    ? 'Sent — but the mentor has no login linked, so nobody was notified in-app. Download the letter and send it to them.'
    : 'Sent to the mentor.');
  const attach = (id, file) => {
    const fd = new FormData(); fd.append('evaluation_file', file);
    return act(() => api.post(`/intern-evaluations/${id}/document`, fd), 'Document attached.');
  };

  if (error) return <LoadError message={error} onRetry={load} />;
  if (!evals || !meta) return <LoadingState shape="lines" rows={4} />;
  const hasOpen = evals.some(e => OPEN.includes(e.status));
  const canRequest = canEdit && intern.status === 'Active' && !hasOpen;

  return (
    <div className="iv-grid ie-panel">
      {requesting && (
        <RequestDialog intern={intern} onCancel={() => setRequesting(false)}
          onDone={(data) => { setRequesting(false); setNotice(data.request_sent_at ? sentText(data) : 'Saved as a draft. Send it when ready.'); refresh(); }} />
      )}
      <div className="iv-card" style={{ gridColumn: '1 / -1' }}>
        <div className="iv-card-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span>Mentor evaluation</span>
          {canRequest && <button type="button" className="pulse-btn-primary" onClick={() => setRequesting(true)}>Request Mentor Evaluation</button>}
        </div>
        {evals.length === 0 && (
          <p className="iv-muted">
            No evaluation yet. {intern.status === 'Active'
              ? 'Use Request Mentor Evaluation when the internship is approaching its end — nothing is marked successful just because the end date passes.'
              : `This internship is ${intern.status}.`}
          </p>
        )}
        {notice && <p role="status" className="ie-ok">{notice}</p>}
        {actionError && <p role="alert" className="iv-error">{actionError}</p>}
      </div>

      {evals.map(ev => {
        const open = ['Draft', 'Returned'].includes(ev.status);
        return (
          <div className="iv-card" key={ev.id}>
            <div className="iv-card-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>Evaluation by {ev.mentor_name || 'mentor'}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <EvaluationStatus status={ev.request_status} />
                {ev.status === 'Returned' && <EvaluationStatus status="Returned" />}
              </span>
            </div>
            <div className="ie-request-meta">
              <span>Sent: {ev.request_sent_at ? when(ev.request_sent_at) : 'not sent'}{ev.requested_by_name ? ` by ${ev.requested_by_name}` : ''}</span>
              {ev.reminder_count > 0 && <span>Reminders: {ev.reminder_count} (last {when(ev.last_reminder_at)})</span>}
              {ev.received_at && <span>Received: {when(ev.received_at)} · {ev.received_via === 'Document' ? 'returned document' : 'online'}</span>}
            </div>
            <RatingsTable ratings={meta.ratings} scale={meta.scale} evaluation={ev} />
            <div className="iv-row"><span className="iv-row-label">Recommendation</span><span className="iv-row-value">{ev.recommendation || '—'}</span></div>
            <div className="iv-row"><span className="iv-row-label">Mentor comments</span><span className="iv-row-value">{ev.comments || '—'}</span></div>
            {ev.submitted_at && (
              <div className="iv-row"><span className="iv-row-label">Submitted</span>
                <span className="iv-row-value">{when(ev.submitted_at)}{ev.submitted_by_name ? ` by ${ev.submitted_by_name}` : ''}</span></div>
            )}
            {ev.reviewed_at && (
              <div className="iv-row"><span className="iv-row-label">{ev.status === 'Returned' ? 'Returned' : 'Reviewed'}</span>
                <span className="iv-row-value">{when(ev.reviewed_at)}{ev.reviewed_by_name ? ` by ${ev.reviewed_by_name}` : ''}{ev.return_reason ? ` — ${ev.return_reason}` : ''}</span></div>
            )}
            <div className="iv-row"><span className="iv-row-label">Documents</span>
              <span className="iv-row-value">
                <button type="button" className="ai-link" onClick={async () => setActionError(await openApiPdf(api, `/intern-evaluations/${ev.id}/letter.pdf`))}>
                  {['Submitted', 'Approved'].includes(ev.status) ? 'Completed evaluation (PDF)' : 'Evaluation letter (PDF)'}
                </button>
                {ev.evaluation_document_url && (
                  <> · <button type="button" className="ai-link" onClick={async () => setActionError((await openEmployeeFile(ev.evaluation_document_url)) || '')}>
                    Returned document</button></>
                )}
              </span></div>

            {canEdit && receiving !== ev.id && (
              <div className="iv-modal-actions" style={{ flexWrap: 'wrap' }}>
                {open && !ev.request_sent_at && (
                  <button type="button" className="pulse-btn-primary" disabled={busy}
                    onClick={() => act(() => api.post(`/intern-evaluations/${ev.id}/send`), sentText)}>Send to mentor</button>
                )}
                {open && ev.request_sent_at && (
                  <button type="button" className="pulse-btn-secondary" disabled={busy}
                    onClick={() => act(() => api.post(`/intern-evaluations/${ev.id}/remind`), 'Reminder sent.')}>Send reminder</button>
                )}
                {open && (
                  <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={() => setReceiving(ev.id)}>Record returned evaluation…</button>
                )}
                {['Submitted', 'Approved'].includes(ev.status) && !ev.evaluation_document_url && (
                  <label className="pulse-btn-secondary" style={{ cursor: 'pointer' }}>
                    Attach signed copy…
                    <input type="file" hidden accept="image/*,.pdf,.doc,.docx"
                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(ev.id, f); }} />
                  </label>
                )}
              </div>
            )}
            {receiving === ev.id && (
              <ReceiveForm ev={ev} meta={meta} onCancel={() => setReceiving(null)}
                onDone={() => { setReceiving(null); setNotice('Returned evaluation recorded.'); refresh(); }} />
            )}

            {ev.status === 'Submitted' && canReview && !ev.is_own && (
              returning === ev.id ? (
                <div className="ie-form">
                  <label htmlFor={`ie-reason-${ev.id}`}>Reason for returning<span className="req" aria-hidden="true">*</span></label>
                  <textarea id={`ie-reason-${ev.id}`} rows={3} value={reason} onChange={e => setReason(e.target.value)}
                    placeholder="What should the mentor add or change?" />
                  <div className="iv-modal-actions">
                    <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={() => { setReturning(null); setReason(''); setActionError(''); }}>Cancel</button>
                    <button type="button" className="pulse-btn-primary" disabled={busy || !reason.trim()}
                      onClick={() => act(() => api.post(`/intern-evaluations/${ev.id}/review`, { decision: 'Return', reason }), 'Returned to the mentor.')}>Return to mentor</button>
                  </div>
                </div>
              ) : (
                <div className="iv-modal-actions">
                  <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={() => { setReturning(ev.id); setActionError(''); }}>Return…</button>
                  <button type="button" className="pulse-btn-primary" disabled={busy}
                    onClick={() => act(() => api.post(`/intern-evaluations/${ev.id}/review`, { decision: 'Approve' }), 'Evaluation approved.')}>Approve</button>
                </div>
              )
            )}
            {ev.status === 'Submitted' && canReview && ev.is_own && (
              <p className="iv-muted" style={{ margin: '8px 0 0' }}>You wrote or recorded this evaluation, so another HR reviewer must approve or return it.</p>
            )}
            {ev.status === 'Submitted' && !canReview && (
              <p className="iv-muted" style={{ margin: '8px 0 0' }}>Waiting for review by HR (approval needs the internship approve permission).</p>
            )}

            <details style={{ marginTop: 10 }}>
              <summary className="iv-muted" style={{ cursor: 'pointer' }}>History ({ev.events?.length || 0})</summary>
              <ol className="ie-history">
                {(ev.events || []).map(x => (
                  <li key={x.id}>
                    <strong>{ACTION_LABEL[x.action] || x.action}</strong>
                    {' · '}{when(x.created_at)}{x.actor_name ? ` · ${x.actor_name}` : ''}
                    {x.reason ? <div className="iv-muted">Reason: {x.reason}</div> : null}
                  </li>
                ))}
              </ol>
            </details>
          </div>
        );
      })}
    </div>
  );
}
