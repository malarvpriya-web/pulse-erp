import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Save } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

/**
 * Stage-1 screening questions, editable per company.
 *
 * The shared set is never changed: saving writes this company's own copy of
 * the question (same code), which the screening page then shows instead.
 * Scores come from the competency ratings, not the wording, so rewording or
 * switching a question off does not change how scores are worked out.
 * Editing needs Recruitment delete (admin) rights; the API enforces it.
 */
export default function ScreeningQuestionsEditor() {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/recruitment/screening-questions', { params: { include_inactive: 1 } });
      setRows(Array.isArray(res.data) ? res.data : []);
      setDrafts({});
      setLoadError('');
    } catch (e) {
      // Shown, not swallowed: an empty list would read as "no questions set".
      setRows([]);
      setLoadError(e?.response?.data?.error || 'The screening questions could not be loaded.');
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (q, patch) => {
    setSaving(q.code);
    try {
      await api.put(`/recruitment/screening-questions/${q.code}`, patch);
      toast('Screening question saved');
      load();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save the question', 'error');
    } finally { setSaving(null); }
  };

  const optionsText = (q) => (Array.isArray(q.options) ? q.options.map(o => (typeof o === 'string' ? o : o?.label ?? o?.value)).join('\n') : '');

  return (
    <section style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 18 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <ClipboardCheck size={16} color="var(--color-primary, #6B3FDB)" />
        <h3 style={{ margin: 0, fontSize: 15 }}>Stage-1 screening questions</h3>
      </header>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: '#6b7280' }}>
        Asked on the Screen page for every candidate. Reword them for your company or switch one off. Scoring is on the competency ratings, so it is not affected.
        {' '}Each question saves on its own (its Save button or the In use tick), not with Save Changes.
      </p>
      {loadError && (
        <div role="alert" style={{ fontSize: 13, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
          {loadError} <button type="button" className="pulse-btn-secondary" style={{ marginLeft: 8 }} onClick={load}>Retry</button>
        </div>
      )}
      {loading ? <p style={{ fontSize: 13, color: '#9ca3af' }}>Loading…</p> : rows.map(q => {
        const d = drafts[q.code] || {};
        const prompt = d.prompt ?? q.prompt;
        const opts = d.options ?? optionsText(q);
        const dirty = d.prompt !== undefined || d.options !== undefined;
        return (
          <div key={q.code} style={{ borderTop: '1px solid #f3f4f6', padding: '12px 0', opacity: q.is_active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 12, color: '#374151' }}>
                {q.code} · {String(q.competency || '').replace(/_/g, ' ')}
                {q.company_id ? <span style={{ color: 'var(--color-primary, #6B3FDB)', fontWeight: 500 }}> · edited for your company</span> : null}
              </strong>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={q.is_active} disabled={saving === q.code}
                       onChange={e => save(q, { is_active: e.target.checked })} /> In use
              </label>
            </div>
            <textarea rows={2} value={prompt} aria-label={`Question ${q.code}`}
                      onChange={e => setDrafts(x => ({ ...x, [q.code]: { ...x[q.code], prompt: e.target.value } }))}
                      style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} />
            {q.answer_type === 'single_choice' && (
              <>
                <div style={{ fontSize: 11, color: '#6b7280', margin: '6px 0 4px' }}>Answer wording — one per line, same number and order (each answer is saved as a fixed code)</div>
                <textarea rows={Math.max(3, opts.split('\n').length)} value={opts} aria-label={`Options for ${q.code}`}
                          onChange={e => setDrafts(x => ({ ...x, [q.code]: { ...x[q.code], options: e.target.value } }))}
                          style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} />
              </>
            )}
            {dirty && (
              <button type="button" className="pulse-btn-primary" style={{ marginTop: 6 }} disabled={saving === q.code}
                      onClick={() => save(q, {
                        prompt,
                        ...(q.answer_type === 'single_choice' ? { options: opts.split('\n').map(x => x.trim()).filter(Boolean) } : {}),
                      })}>
                <Save size={13} /> {saving === q.code ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
