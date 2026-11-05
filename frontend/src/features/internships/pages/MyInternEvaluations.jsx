import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, LoadingState, LoadError, EmptyState } from '@/components/pulse-ui';
import { fmtDate, fullName, openApiPdf } from '../internship';
import { EvaluationStatus, RatingInputs, RatingsTable } from './InternEvaluationPanel';
import './Internships.css';

/**
 * My Intern Evaluations — the mentor's side of the evaluation workflow.
 *
 * Lists the interns the caller CURRENTLY mentors, plus any intern whose
 * evaluation HR has sent to them (GET /intern-evaluations/mine). Access is
 * decided by identity on the server, so
 * this page carries no internships permission and opens nothing else of the
 * intern record: no register, no edit form, no documents.
 *
 * A Draft or Returned evaluation is editable (Save draft / Submit for review);
 * a Submitted one is locked until HR returns it; an Approved one is read-only.
 */
const EDITABLE = ['Draft', 'Returned'];

/** One intern's evaluation card. Module level so typing never remounts it. */
function EvaluationCard({ intern, recommendations, ratings, scale, onSaved }) {
  const ev = intern.evaluation;
  const editable = !ev || EDITABLE.includes(ev.status);
  const [comments, setComments] = useState(ev?.comments || '');
  const [recommendation, setRecommendation] = useState(ev?.recommendation || '');
  const [scores, setScores] = useState(() => Object.fromEntries(ratings.map(f => [f.key, ev?.[f.key] ?? null])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const rated = ratings.every(f => scores[f.key] != null);

  const send = async (submit) => {
    setBusy(true); setMessage(null);
    try {
      const body = { comments, recommendation, ...scores };
      const { data } = submit
        ? await api.post(`/intern-evaluations/mine/${intern.id}/submit`, body)
        : await api.put(`/intern-evaluations/mine/${intern.id}`, body);
      setMessage({ ok: true, text: submit ? 'Submitted to HR for review.' : 'Draft saved.' });
      onSaved(intern.id, data);
    } catch (e) {
      setMessage({ ok: false, text: e?.response?.data?.error || e?.message || 'Could not save the evaluation.' });
    } finally { setBusy(false); }
  };

  const idBase = `ie-${intern.id}`;
  return (
    <div className="iv-card">
      <div className="iv-card-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{fullName(intern)} · {intern.intern_code}</span>
        <EvaluationStatus status={ev?.status || 'Not started'} />
      </div>
      <p className="iv-muted" style={{ margin: '0 0 8px' }}>
        {[intern.designation, intern.department].filter(Boolean).join(' · ')} · {fmtDate(intern.start_date)} → {fmtDate(intern.end_date)}
        {intern.project_work_area ? ` · ${intern.project_work_area}` : ''}
      </p>
      {ev?.id && (
        <p style={{ margin: '0 0 8px', fontSize: 13 }}>
          <button type="button" className="ai-link"
            onClick={async () => { const err = await openApiPdf(api, `/intern-evaluations/${ev.id}/letter.pdf`); if (err) setMessage({ ok: false, text: err }); }}>
            Download evaluation letter (PDF)
          </button>
          <span className="iv-muted"> — fill it in here, or complete, sign and return the letter to HR.</span>
        </p>
      )}

      {ev?.status === 'Returned' && ev.return_reason && (
        <p role="alert" className="ie-returned">
          <strong>Returned by HR{ev.reviewed_by_name ? ` (${ev.reviewed_by_name})` : ''}:</strong> {ev.return_reason}
        </p>
      )}

      {editable ? (
        <div className="ie-form">
          <RatingInputs ratings={ratings} scale={scale} values={scores} idBase={idBase}
            onChange={(k, v) => setScores(x => ({ ...x, [k]: v }))} />
          <label htmlFor={`${idBase}-comments`}>Mentor comments<span className="req" aria-hidden="true">*</span></label>
          <textarea id={`${idBase}-comments`} rows={5} value={comments} maxLength={5000}
            onChange={e => setComments(e.target.value)}
            placeholder="Work delivered, skills shown, attendance and conduct, areas to improve…" />
          <label htmlFor={`${idBase}-rec`}>Recommendation<span className="req" aria-hidden="true">*</span></label>
          <select id={`${idBase}-rec`} value={recommendation} onChange={e => setRecommendation(e.target.value)}>
            <option value="">-- Select recommendation --</option>
            {recommendations.map(r => <option key={r}>{r}</option>)}
          </select>
          {message && <p role="status" className={message.ok ? 'ie-ok' : 'iv-error'}>{message.text}</p>}
          <div className="iv-modal-actions">
            <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={() => send(false)}>Save draft</button>
            <button type="button" className="pulse-btn-primary" disabled={busy || !comments.trim() || !recommendation || !rated}
              onClick={() => send(true)}>
              {busy ? 'Saving…' : ev?.status === 'Returned' ? 'Resubmit for review' : 'Submit for review'}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <RatingsTable ratings={ratings} scale={scale} evaluation={ev} />
          <div className="iv-row"><span className="iv-row-label">Recommendation</span><span className="iv-row-value">{ev.recommendation}</span></div>
          <div className="iv-row"><span className="iv-row-label">Comments</span><span className="iv-row-value">{ev.comments}</span></div>
          <p className="iv-muted" style={{ margin: '8px 0 0' }}>
            {ev.status === 'Submitted'
              ? `Submitted ${fmtDate(ev.submitted_at)} — waiting for HR review. It can be changed only if HR returns it.`
              : `Approved by HR${ev.reviewed_by_name ? ` (${ev.reviewed_by_name})` : ''} on ${fmtDate(ev.reviewed_at)}.`}
          </p>
          {message && <p role="status" className="ie-ok">{message.text}</p>}
        </div>
      )}
    </div>
  );
}

export default function MyInternEvaluations() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api.get('/intern-evaluations/mine')
      .then(r => setData(r.data))
      .catch(e => setError(e?.response?.data?.error || e?.message || 'Could not load your interns.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const onSaved = (internId, evaluation) => setData(d => ({
    ...d, interns: d.interns.map(i => (i.id === internId ? { ...i, evaluation } : i)),
  }));

  return (
    <PageShell dock={
      <PageHero icon={ClipboardCheck} eyebrow="HR" title="My Intern Evaluations"
        subtitle="Evaluate the interns you mentor. HR reviews each evaluation before the internship is closed." />
    }>
      <div className="in-page">
        {error && <LoadError message={error} onRetry={load} />}
        {!error && !data && <LoadingState shape="lines" rows={5} />}
        {/* Not a current mentor: a notice, never data. The API returns nothing
            to them either; this only says why the page is empty. */}
        {data && !data.linked && (
          <EmptyState title="Available to assigned intern mentors"
            subtitle="Your login is not linked to an employee record, so it cannot be an intern's mentor. Ask HR to link it." />
        )}
        {data && data.linked && data.interns.length === 0 && (
          <EmptyState title="Available to assigned intern mentors"
            subtitle="You are not currently assigned as the mentor of any intern. This page opens for you when HR assigns you one." />
        )}
        {data && data.interns.length > 0 && (
          <div className="iv-grid">
            {data.interns.map(i => (
              <EvaluationCard key={i.id}
                intern={i} recommendations={data.recommendations} ratings={data.ratings || []} scale={data.scale || []}
                onSaved={onSaved} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
