// frontend/src/features/quality/components/QualityTestsPanel.jsx
//
// Reusable panel that links a source (a GRN — material in Stores — OR a
// production operation, at any level of production) to the Quality department.
// Quality can create any number of tests, record readings, and each reading is
// auto-evaluated against its spec window (pass/fail) with an NCR auto-raised on
// failure by the backend. Embed it anywhere: pass a `source` describing what the
// tests belong to.
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const RESULT_COLORS = {
  pending: ['#f3f4f6', '#6b7280'],
  pass:    ['#d1fae5', '#16a34a'],
  fail:    ['#fee2e2', '#dc2626'],
  na:      ['#e0e7ff', '#4338ca'],
};

const STAGES = [
  ['IQC', 'Incoming (Stores)'],
  ['IPQC', 'In-Process'],
  ['FQC', 'Final'],
  ['PDI', 'Pre-Dispatch'],
];

function ResultBadge({ result }) {
  const [bg, color] = RESULT_COLORS[result] || RESULT_COLORS.pending;
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{(result || 'pending').toUpperCase()}</span>;
}

const inp = { width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' };
const lbl = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 3, display: 'block' };

export default function QualityTestsPanel({ source, title = 'Quality Tests', defaultStage = 'IQC', readOnly = false, onChange }) {
  const toast = useToast();
  const [tests, setTests]   = useState([]);
  const [loading, setLoad]  = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft]   = useState(null);
  const [saving, setSaving] = useState(false);

  const query = () => {
    const p = new URLSearchParams();
    if (source?.grnId)             p.set('grn_id', source.grnId);
    else if (source?.operationId)  p.set('operation_id', source.operationId);
    else if (source?.sourceType && source?.sourceId) { p.set('source_type', source.sourceType); p.set('source_id', source.sourceId); }
    return p.toString();
  };

  const load = useCallback(async () => {
    setLoad(true);
    try {
      const r = await api.get(`/quality/tests?${query()}`);
      setTests(r.data?.data || []);
    } catch { setTests([]); }
    finally { setLoad(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.grnId, source?.operationId, source?.sourceId]);

  useEffect(() => { load(); }, [load]);

  const sourcePayload = () => {
    if (source?.grnId)            return { source_type: 'grn', source_id: source.grnId, grn_id: source.grnId };
    if (source?.operationId)      return { source_type: 'production_operation', source_id: source.operationId, operation_id: source.operationId, production_order_id: source.productionOrderId || null };
    return { source_type: source?.sourceType, source_id: source?.sourceId };
  };

  const startAdd = () => {
    setDraft({ test_name: '', parameter: '', spec_min: '', spec_max: '', unit: '', expected_value: '', stage: defaultStage });
    setAdding(true);
  };

  const saveDraft = async () => {
    if (!draft.test_name.trim()) { toast.error('Test name is required'); return; }
    setSaving(true);
    try {
      await api.post('/quality/tests', {
        ...sourcePayload(),
        item_id: source?.itemId || null,
        item_name: source?.itemName || null,
        stage: draft.stage,
        test_name: draft.test_name.trim(),
        parameter: draft.parameter || null,
        spec_min: draft.spec_min === '' ? null : Number(draft.spec_min),
        spec_max: draft.spec_max === '' ? null : Number(draft.spec_max),
        unit: draft.unit || null,
        expected_value: draft.expected_value || null,
      });
      toast.success('Test added');
      setAdding(false); setDraft(null);
      await load(); onChange?.();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not add test'); }
    finally { setSaving(false); }
  };

  const recordResult = async (t, patch) => {
    try {
      const r = await api.put(`/quality/tests/${t.id}`, patch);
      if (r.data?.auto_ncr) toast.error(`Failed — NCR ${r.data.auto_ncr.ncr_number} raised`);
      else toast.success('Result recorded');
      await load(); onChange?.();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not record result'); }
  };

  const del = async (t) => {
    try { await api.delete(`/quality/tests/${t.id}`); await load(); onChange?.(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Delete failed'); }
  };

  const done = tests.filter(t => t.status === 'completed').length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>{title}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {tests.length} test{tests.length !== 1 ? 's' : ''} · {done} completed
            {tests.some(t => t.result === 'fail') && <span style={{ color: '#dc2626', fontWeight: 700 }}> · has failures</span>}
          </div>
        </div>
        {!readOnly && !adding && (
          <button onClick={startAdd}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Add Test
          </button>
        )}
      </div>

      {adding && (
        <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 1.2fr', gap: 8 }}>
            <div><label style={lbl}>Test name *</label><input style={inp} value={draft.test_name} onChange={e => setDraft(d => ({ ...d, test_name: e.target.value }))} placeholder="e.g. Dimensional check" /></div>
            <div><label style={lbl}>Parameter</label><input style={inp} value={draft.parameter} onChange={e => setDraft(d => ({ ...d, parameter: e.target.value }))} placeholder="e.g. Outer dia" /></div>
            <div><label style={lbl}>Spec min</label><input style={inp} type="number" value={draft.spec_min} onChange={e => setDraft(d => ({ ...d, spec_min: e.target.value }))} /></div>
            <div><label style={lbl}>Spec max</label><input style={inp} type="number" value={draft.spec_max} onChange={e => setDraft(d => ({ ...d, spec_max: e.target.value }))} /></div>
            <div><label style={lbl}>Unit</label><input style={inp} value={draft.unit} onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))} placeholder="mm" /></div>
            <div><label style={lbl}>Stage</label>
              <select style={inp} value={draft.stage} onChange={e => setDraft(d => ({ ...d, stage: e.target.value }))}>
                {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={lbl}>Expected value (for non-numeric / pass-fail tests, e.g. "OK", "Present")</label>
            <input style={inp} value={draft.expected_value} onChange={e => setDraft(d => ({ ...d, expected_value: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={saveDraft} disabled={saving}
              style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              {saving ? 'Saving…' : 'Save Test'}
            </button>
            <button onClick={() => { setAdding(false); setDraft(null); }}
              style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading tests…</div>
      ) : tests.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 8 }}>
          No quality tests yet. {!readOnly && 'Use “+ Add Test” to define how many checks Quality should run.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#faf9ff' }}>
                {['Stage', 'Test', 'Spec', 'Reading', 'Result', ''].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tests.map(t => (
                <TestRow key={t.id} t={t} readOnly={readOnly} onRecord={recordResult} onDelete={del} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TestRow({ t, readOnly, onRecord, onDelete }) {
  const [val, setVal] = useState(t.actual_value ?? '');
  const spec = t.spec_min != null || t.spec_max != null
    ? `${t.spec_min ?? '−∞'} … ${t.spec_max ?? '∞'} ${t.unit || ''}`.trim()
    : (t.expected_value ? `= ${t.expected_value}` : '—');
  return (
    <tr style={{ borderTop: '1px solid #f0f0f4' }}>
      <td style={{ padding: '8px 10px' }}><span style={{ fontSize: 11, fontWeight: 700, color: '#6B3FDB' }}>{t.stage}</span></td>
      <td style={{ padding: '8px 10px', color: '#111827' }}>
        <div style={{ fontWeight: 600 }}>{t.test_name}</div>
        {t.parameter && <div style={{ color: '#9ca3af', fontSize: 11 }}>{t.parameter}</div>}
      </td>
      <td style={{ padding: '8px 10px', color: '#6b7280', whiteSpace: 'nowrap' }}>{spec}</td>
      <td style={{ padding: '8px 10px' }}>
        {readOnly ? (t.actual_value ?? '—') : (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input value={val} onChange={e => setVal(e.target.value)} placeholder="value"
              style={{ width: 80, padding: '5px 7px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
            <button onClick={() => onRecord(t, { actual_value: val })}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Record</button>
          </div>
        )}
      </td>
      <td style={{ padding: '8px 10px' }}><ResultBadge result={t.result} /></td>
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        {!readOnly && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button title="Mark Pass" onClick={() => onRecord(t, { result: 'pass', status: 'completed' })}
              style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>✓</button>
            <button title="Mark Fail" onClick={() => onRecord(t, { result: 'fail', status: 'completed' })}
              style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>✗</button>
            <button title="Delete" onClick={() => onDelete(t)}
              style={{ background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}>🗑</button>
          </div>
        )}
      </td>
    </tr>
  );
}
