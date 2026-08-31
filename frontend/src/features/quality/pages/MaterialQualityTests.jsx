// frontend/src/features/quality/pages/MaterialQualityTests.jsx
//
// Quality department worklist for material & production tests. Surfaces every
// test raised against material received into Stores (GRN) or against a
// production operation (any level of production), lets Quality record readings
// inline (auto-evaluated, auto-NCR on fail) and filter their queue.
import { useState, useEffect, useCallback } from 'react';
import {
  FlaskConical, ClipboardList, Hourglass, CheckCircle2, XCircle,
  PackageCheck, Factory,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell, StatBand, Stat, MeterCard, MeterGrid } from '@/components/pulse-ui';

const RESULT_COLORS = {
  pending: ['#f3f4f6', '#6b7280'], pass: ['#d1fae5', '#16a34a'],
  fail: ['#fee2e2', '#dc2626'], na: ['#e0e7ff', '#4338ca'],
};
function ResultBadge({ result }) {
  const [bg, color] = RESULT_COLORS[result] || RESULT_COLORS.pending;
  return <span style={{ background: bg, color, padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{(result || 'pending').toUpperCase()}</span>;
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

  const passed  = Number(summary.passed ?? 0);
  const failed  = Number(summary.failed ?? 0);
  const pending = Number(summary.pending ?? 0);
  const decided = passed + failed;
  const passRate = decided ? Math.round((passed / decided) * 100) : 0;

  return (
    <PageShell dock={
        <PageHero
          icon={FlaskConical}
          eyebrow="Quality"
          title="Material & Production Quality Tests"
          subtitle="Tests raised on material received into Stores and at every level of production — record readings to auto-evaluate against spec"
          meta={[
            { value: summary.total ?? 0, label: 'total tests' },
            { value: `${passRate}%`, label: 'pass rate', tone: passRate >= 95 ? 'good' : passRate >= 80 ? 'warn' : 'bad' },
            { value: pending, label: 'awaiting readings', tone: pending ? 'warn' : 'good' },
          ]}
          tiles={[
            { label: 'Passed',  value: passed },
            { label: 'Failed',  value: failed },
            { label: 'Pending', value: pending },
          ]}
        />
    }>

      <StatBand cols={6}>
        <Stat index={0} icon={ClipboardList} tone="primary" label="Total Tests"       value={summary.total ?? 0}           sub="all sources" />
        <Stat index={1} icon={Hourglass}     tone="warning" label="Pending"           value={pending}                      sub="readings not recorded" />
        <Stat index={2} icon={CheckCircle2}  tone="success" label="Passed"            value={passed}                       sub={`${passRate}% of decided`} />
        <Stat index={3} icon={XCircle}       tone="danger"  label="Failed"            value={failed}                       sub="auto-raises NCR" />
        <Stat index={4} icon={PackageCheck}  tone="teal"    label="Material (Stores)" value={summary.material_tests ?? 0}  sub="from GRN" />
        <Stat index={5} icon={Factory}       tone="info"    label="Production"        value={summary.production_tests ?? 0} sub="from operations" />
      </StatBand>

      <MeterGrid>
        <MeterCard
          title="Test Pass Rate"
          value={passRate}
          legend={[
            { value: passed, label: 'passed', color: '#16a34a' },
            { value: failed, label: 'failed', color: '#dc2626' },
            { value: pending, label: 'pending', color: '#6d28d9' },
          ]}
        />
        <MeterCard
          title="Queue Progress"
          caption={`${summary.total ? Math.round((decided / summary.total) * 100) : 0}% recorded`}
          tone="primary"
          value={summary.total ? (decided / summary.total) * 100 : 0}
          legend={[
            { value: decided, label: 'recorded', color: '#6B3FDB' },
            { value: pending, label: 'outstanding', color: '#6d28d9' },
          ]}
        />
      </MeterGrid>

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
    </PageShell>
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
