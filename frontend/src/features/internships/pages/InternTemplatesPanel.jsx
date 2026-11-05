import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { LoadingState, LoadError } from '@/components/pulse-ui';

/**
 * Internships → Document Templates.
 *
 * The Completion Certificate and the Mentor Evaluation Letter, per company
 * (GET/PUT/DELETE /interns/templates). The body is plain text with {{fields}};
 * the server refuses a field it cannot fill, so a typo is caught here rather
 * than on a certificate. The evaluation letter's rating grid, recommendation
 * boxes, comments and signature block are added by the PDF itself.
 *
 * Named …Panel so autoRouter does not treat it as a page of its own.
 */
const TITLES = {
  completion_certificate: 'Internship Completion Certificate',
  evaluation_letter: 'Internship Completion / Evaluation Letter (sent to the mentor)',
};

function TemplateEditor({ template, canEdit, onSaved }) {
  const [form, setForm] = useState({
    heading: template.heading || '', content: template.content || '',
    signatory_name: template.signatory_name || '', signatory_title: template.signatory_title || '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const area = useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const insert = (field) => {
    const el = area.current;
    const token = `{{${field}}}`;
    if (!el) { set('content', `${form.content}${token}`); return; }
    const start = el.selectionStart ?? form.content.length;
    const end = el.selectionEnd ?? start;
    const next = form.content.slice(0, start) + token + form.content.slice(end);
    set('content', next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const { data } = await api.put(`/interns/templates/${template.key}`, form);
      setMessage({ ok: true, text: 'Template saved.' });
      onSaved(data);
    } catch (e) {
      setMessage({ ok: false, text: e?.response?.data?.error || e?.message || 'Could not save the template.' });
    } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setMessage(null);
    try {
      const { data } = await api.delete(`/interns/templates/${template.key}`);
      setForm({ heading: data.heading || '', content: data.content || '', signatory_name: data.signatory_name || '', signatory_title: data.signatory_title || '' });
      setMessage({ ok: true, text: 'Back to the default template.' });
      onSaved(data);
    } catch (e) {
      setMessage({ ok: false, text: e?.response?.data?.error || e?.message || 'Could not reset the template.' });
    } finally { setBusy(false); }
  };

  const id = `tpl-${template.key}`;
  const isCert = template.key === 'completion_certificate';
  return (
    <div className="iv-card">
      <div className="iv-card-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{TITLES[template.key] || template.name}</span>
        <span className="iv-muted" style={{ fontWeight: 500 }}>{template.is_default ? 'Default template' : 'Customised for your company'}</span>
      </div>
      <div className="it-grid">
        <div className="ie-form">
          <label htmlFor={`${id}-heading`}>Heading</label>
          <input id={`${id}-heading`} value={form.heading} maxLength={200} disabled={!canEdit} onChange={e => set('heading', e.target.value)} />
          <label htmlFor={`${id}-content`}>Text</label>
          <textarea id={`${id}-content`} ref={area} rows={12} value={form.content} maxLength={8000} disabled={!canEdit}
            onChange={e => set('content', e.target.value)} />
          {isCert && (
            <>
              <label htmlFor={`${id}-sig`}>Authorized signatory</label>
              <input id={`${id}-sig`} value={form.signatory_name} maxLength={150} disabled={!canEdit}
                placeholder="Name printed under the signature line" onChange={e => set('signatory_name', e.target.value)} />
              <label htmlFor={`${id}-sigt`}>Signatory title</label>
              <input id={`${id}-sigt`} value={form.signatory_title} maxLength={150} disabled={!canEdit}
                placeholder="e.g. Head of HR" onChange={e => set('signatory_title', e.target.value)} />
            </>
          )}
          {!isCert && (
            <p className="iv-muted" style={{ margin: 0 }}>
              The rating grid (Technical Skills, Communication, Teamwork, Discipline / Attendance, Learning Ability, Overall
              Performance), the recommendation, mentor comments and the mentor's name / signature / date are added below this text automatically.
            </p>
          )}
          {message && <p role="status" className={message.ok ? 'ie-ok' : 'iv-error'}>{message.text}</p>}
          {canEdit && (
            <div className="iv-modal-actions">
              {!template.is_default && <button type="button" className="pulse-btn-secondary" disabled={busy} onClick={reset}>Reset to default</button>}
              <button type="button" className="pulse-btn-primary" disabled={busy || !form.heading.trim() || !form.content.trim()} onClick={save}>
                {busy ? 'Saving…' : 'Save template'}
              </button>
            </div>
          )}
        </div>
        <div>
          <div className="iv-row-label" style={{ marginBottom: 6 }}>Fields {canEdit ? '(click to insert)' : ''}</div>
          <ul className="it-fields">
            {Object.entries(template.placeholders || {}).map(([k, label]) => (
              <li key={k}>
                {canEdit
                  ? <button type="button" className="ai-link" onClick={() => insert(k)}>{`{{${k}}}`}</button>
                  : <code>{`{{${k}}}`}</code>}
                <span className="iv-muted"> — {label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function InternTemplatesPanel({ canEdit }) {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    setError(null);
    api.get('/interns/templates')
      .then(r => setTemplates(Array.isArray(r.data) ? r.data : []))
      .catch(e => setError(e?.response?.data?.error || e?.message || 'Could not load the templates.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <LoadError message={error} onRetry={load} />;
  if (!templates) return <LoadingState shape="lines" rows={6} />;
  return (
    <div className="iv-grid it-templates">
      <p className="iv-muted" style={{ margin: 0, gridColumn: '1 / -1' }}>
        Certificates are generated from the first template when HR issues one (Intern → Internship → Issue certificate).
        The evaluation letter is the form a mentor receives with Request Mentor Evaluation.
      </p>
      {templates.map(t => (
        <TemplateEditor key={t.key} template={t} canEdit={canEdit}
          onSaved={(next) => setTemplates(ts => ts.map(x => (x.key === next.key ? next : x)))} />
      ))}
    </div>
  );
}
