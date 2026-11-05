import { useState } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { fmtDate, openApiPdf } from '../internship';

const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const EVENT_LABEL = {
  completed: 'Internship completed', certificate_issued: 'Certificate issued', certificate_revoked: 'Certificate revoked',
  converted_to_employee: 'Converted to employee',
};

/**
 * Completion & certificate, on View Intern → Internship.
 *
 * Issue: an internship completed through the gate, with no active certificate
 * (POST /interns/:id/certificate). By default the certificate is GENERATED from
 * the company's Completion Certificate template (generate=true) and numbered
 * <INTxxx>/CERT/<year>/<n> when no number is typed; HR may instead upload a
 * signed copy. Revoke: needs internships:approve and a
 * reason (POST …/certificate/revoke). Replacing a certificate is revoke, then
 * issue with a new number — the API never reissues a revoked number. The server
 * enforces every rule; this only offers the actions that can succeed.
 */
export default function InternCompletionPanel({ intern, onChanged }) {
  const { hasPermission } = useAuth();
  const canIssue = hasPermission('internships', 'edit');
  const canRevoke = hasPermission('internships', 'approve');
  const certs = intern.certificates || [];
  const active = certs.find(c => !c.revoked_at) || null;
  const eligibleToIssue = intern.status === 'Completed' && intern.completion_evaluation_id != null && !active;

  const [mode, setMode] = useState(null);      // 'issue' | 'revoke' | null
  const [number, setNumber] = useState('');
  const [file, setFile] = useState(null);
  const [source, setSource] = useState('generate');   // 'generate' | 'upload'
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => { setMode(null); setNumber(''); setFile(null); setReason(''); setError(''); setSource('generate'); };

  const submit = async () => {
    setBusy(true); setError('');
    try {
      let data;
      if (mode === 'issue') {
        const fd = new FormData();
        if (number.trim()) fd.append('certificate_number', number.trim());
        if (source === 'generate') fd.append('generate', 'true');
        else if (file) fd.append('certificate_file', file);
        ({ data } = await api.post(`/interns/${intern.id}/certificate`, fd));
      } else {
        ({ data } = await api.post(`/interns/${intern.id}/certificate/revoke`, { reason: reason.trim() }));
      }
      close();
      onChanged(data);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'The action failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="iv-card">
      <div className="iv-card-title">Completion &amp; certificate</div>
      <div className="iv-row"><span className="iv-row-label">Completed on</span>
        <span className="iv-row-value">{intern.completed_on ? fmtDate(intern.completed_on) : '—'}</span></div>
      {intern.status !== 'Completed' && intern.completion && (
        <div className="iv-row"><span className="iv-row-label">Ready to complete?</span>
          <span className="iv-row-value">{intern.completion.eligible ? 'Yes — use Mark Completed' : intern.completion.reason}</span></div>
      )}
      <div className="iv-row"><span className="iv-row-label">Certificate</span>
        <span className="iv-row-value">
          {active ? (
            <>
              {active.certificate_number} · issued {fmtDate(active.issued_at)}{active.issued_by_name ? ` by ${active.issued_by_name}` : ''}
              {active.file_url && (
                <> · <button type="button" className="ai-link" onClick={() => openEmployeeFile(active.file_url)}>View / download</button></>
              )}
            </>
          ) : 'Not issued'}
        </span></div>

      {mode == null && (
        <div className="iv-modal-actions">
          {eligibleToIssue && canIssue && (
            <button type="button" className="pulse-btn-primary" onClick={() => setMode('issue')}>Issue certificate</button>
          )}
          {active && canRevoke && (
            <button type="button" className="pulse-btn-secondary" onClick={() => setMode('revoke')}>Revoke certificate…</button>
          )}
        </div>
      )}

      {mode === 'issue' && (
        <div className="ie-form">
          <label htmlFor="ic-number">Certificate number</label>
          <input id="ic-number" value={number} maxLength={100} onChange={e => setNumber(e.target.value)}
            placeholder={`Leave blank for ${intern.intern_code}/CERT/${new Date().getFullYear()}/…`} />
          <fieldset style={{ border: 0, padding: 0, margin: '6px 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <legend className="iv-row-label">Certificate document</legend>
            <label style={{ fontWeight: 500 }}>
              <input type="radio" name="ic-source" checked={source === 'generate'} onChange={() => setSource('generate')} />
              {' '}Generate from the Completion Certificate template
            </label>
            <label style={{ fontWeight: 500 }}>
              <input type="radio" name="ic-source" checked={source === 'upload'} onChange={() => setSource('upload')} />
              {' '}Upload a signed certificate
            </label>
          </fieldset>
          {source === 'generate' ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              <button type="button" className="ai-link" onClick={async () => {
                const q = number.trim() ? `?number=${encodeURIComponent(number.trim())}` : '';
                setError(await openApiPdf(api, `/interns/${intern.id}/certificate/preview.pdf${q}`));
              }}>Preview certificate (PDF)</button>
              <span className="iv-muted"> — wording is set under Internships → Document Templates.</span>
            </p>
          ) : (
            <input id="ic-file" type="file" accept="image/*,.pdf,.doc,.docx" aria-label="Certificate file"
              onChange={e => setFile(e.target.files?.[0] || null)} />
          )}
          {error && <p role="alert" className="iv-error">{error}</p>}
          <div className="iv-modal-actions">
            <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={close}>Cancel</button>
            <button type="button" className="pulse-btn-primary" disabled={busy || (source === 'upload' && !file)} onClick={submit}>
              {busy ? 'Issuing…' : 'Issue certificate'}
            </button>
          </div>
        </div>
      )}

      {mode === 'revoke' && (
        <div className="ie-form">
          <label htmlFor="ic-reason">Reason for revoking {active?.certificate_number}<span className="req" aria-hidden="true">*</span></label>
          <textarea id="ic-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} />
          <p className="iv-muted" style={{ margin: 0 }}>The number is retired. A replacement is issued with a new number.</p>
          {error && <p role="alert" className="iv-error">{error}</p>}
          <div className="iv-modal-actions">
            <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={close}>Cancel</button>
            <button type="button" className="pulse-btn-primary" disabled={busy || !reason.trim()} onClick={submit}>
              {busy ? 'Revoking…' : 'Revoke certificate'}
            </button>
          </div>
        </div>
      )}

      {(certs.length > 0 || (intern.lifecycle_events || []).length > 0) && (
        <details style={{ marginTop: 10 }}>
          <summary className="iv-muted" style={{ cursor: 'pointer' }}>History ({(intern.lifecycle_events || []).length})</summary>
          <ol className="ie-history">
            {(intern.lifecycle_events || []).map(x => (
              <li key={x.id}>
                <strong>{EVENT_LABEL[x.action] || x.action}</strong>
                {x.details?.certificate_number ? ` ${x.details.certificate_number}` : ''}
                {' · '}{when(x.created_at)}{x.actor_name ? ` · ${x.actor_name}` : ''}
                {x.reason ? <div className="iv-muted">Reason: {x.reason}</div> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
