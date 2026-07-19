// frontend/src/features/quality/pages/MaterialQualityTests.jsx
//
// Quality department worklist for material & production tests. Surfaces every
// test raised against material received into Stores (GRN) or against a
// production operation (any level of production), lets Quality record readings
// inline (auto-evaluated, auto-NCR on fail) and filter their queue.
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const RESULT_COLORS = {
  pending: ['#f3f4f6', '#6b7280'], pass: ['#d1fae5', '#16a34a'],
  fail: ['#fee2e2', '#dc2626'], na: ['#e0e7ff', '#4338ca'],
};
function ResultBadge({ result }) {
  const [bg, color] = RESULT_COLORS[result] || RESULT_COLORS.pending;
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{(result || 'pending').toUpperCase()}</span>;
}

function Tile({ label, value, tone }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #eef0f4', borderRadius: 12, padding: '16px 18px', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone || '#111827', marginTop: 4 }}>{value}</div>
    </div>
  );
}

const FILTERS = [
  ['all', 'All'],
  ['grn', 'Material (Stores)'],
  ['production', 'Production'],
  ['pending', 'Pending only'],
  ['fail', 'Failures'],
];

export default function MaterialQualityTests() {
  const toast = useToast();
  const [summary, setSummary] = useState({});
  const [tests, setTests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (filter === 'grn') params.set('source_type', 'grn');
      if (filter === 'production') params.set('source_type', 'production_operation');
      if (filter === 'pending') params.set('result', 'pending');
      if (filter === 'fail') params.set('result', 'fail');
      const [s, t] = await Promise.all([
        api.get('/quality/tests/summary'),
        api.get(`/quality/tests?${params.toString()}`),
      ]);
      setSummary(s.data?.data || {});
      setTests(t.data?.data || []);
    } catch { toast.error('Could not load quality tests'); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const record = async (t, patch) => {
    try {
      const r = await api.put(`/quality/tests/${t.id}`, patch);
      if (r.data?.auto_ncr) toast.error(`Failed — NCR ${r.data.auto_ncr.ncr_number} raised`);
      else toast.success('Result recorded');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not record'); }
  };

  return (
    <div className="pulse-page">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Material & Production Quality Tests</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
          Tests raised on material received into Stores and at every level of production. Record readings to auto-evaluate against spec.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Tile label="Total tests" value={summary.total ?? 0} />
        <Tile label="Pending" value={summary.pending ?? 0} tone="#d97706" />
        <Tile label="Passed" value={summary.passed ?? 0} tone="#16a34a" />
        <Tile label="Failed" value={summary.failed ?? 0} tone="#dc2626" />
        <Tile label="Material (Stores)" value={summary.material_tests ?? 0} tone="#6B3FDB" />
        <Tile label="Production" value={summary.production_tests ?? 0} tone="#6B3FDB" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: filter === v ? 'none' : '1px solid #e5e7eb',
              background: filter === v ? '#6B3FDB' : '#fff',
              color: filter === v ? '#fff' : '#374151',
            }}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #eef0f4', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : tests.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No tests in this view.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: '#faf9ff' }}>
                  {['Source', 'Stage', 'Item / Test', 'Spec', 'Reading', 'Result', ''].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tests.map(t => <Row key={t.id} t={t} onRecord={record} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ t, onRecord }) {
  const [val, setVal] = useState(t.actual_value ?? '');
  const spec = t.spec_min != null || t.spec_max != null
    ? `${t.spec_min ?? '−∞'} … ${t.spec_max ?? '∞'} ${t.unit || ''}`.trim()
    : (t.expected_value ? `= ${t.expected_value}` : '—');
  const src = t.source_type === 'grn'
    ? { label: t.grn_number || `GRN #${t.grn_id}`, tone: '#6B3FDB' }
    : { label: t.production_order_number || `Order #${t.production_order_id || ''}`, tone: '#0891b2' };
  return (
    <tr style={{ borderTop: '1px solid #f0f0f4' }}>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 700, color: src.tone }}>{src.label}</span>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>{t.source_type === 'grn' ? 'Stores material' : 'Production'}</div>
      </td>
      <td style={{ padding: '10px 12px' }}><span style={{ fontSize: 11, fontWeight: 700, color: '#6B3FDB' }}>{t.stage}</span></td>
      <td style={{ padding: '10px 12px', color: '#111827' }}>
        {t.item_name && <div style={{ color: '#6b7280', fontSize: 11 }}>{t.item_name}</div>}
        <div style={{ fontWeight: 600 }}>{t.test_name}</div>
      </td>
      <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>{spec}</td>
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input value={val} onChange={e => setVal(e.target.value)} placeholder="value"
            style={{ width: 78, padding: '5px 7px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
          <button onClick={() => onRecord(t, { actual_value: val })}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Record</button>
        </div>
      </td>
      <td style={{ padding: '10px 12px' }}><ResultBadge result={t.result} /></td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button title="Pass" onClick={() => onRecord(t, { result: 'pass', status: 'completed' })}
            style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 6, padding: '4px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>✓</button>
          <button title="Fail" onClick={() => onRecord(t, { result: 'fail', status: 'completed' })}
            style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, padding: '4px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>✗</button>
        </div>
      </td>
    </tr>
  );
}
