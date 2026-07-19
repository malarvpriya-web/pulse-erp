// frontend/src/features/quality/pages/QualityReports.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

function SimpleBarChart({ data, labelKey, valueKey, color = '#2563eb', height = 160 }) {
  if (!data?.length) return <div style={{ color: '#9ca3af', fontSize: 13, padding: 16 }}>No data</div>;
  const max = Math.max(...data.map(d => d[valueKey] || 0), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height, padding: '8px 0' }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color }}>{d[valueKey] || 0}</span>
          <div style={{ width: '100%', height: Math.max((d[valueKey] / max) * (height - 40), 4), background: color, borderRadius: '3px 3px 0 0', minHeight: 4 }} />
          <span style={{ fontSize: 10, color: '#6b7280', textAlign: 'center', maxWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d[labelKey]}>{d[labelKey]}</span>
        </div>
      ))}
    </div>
  );
}

export default function QualityReports() {
  const toast = useToast();
  const [ncrTrend, setNcrTrend] = useState([]);
  const [inspSummary, setInspSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState({ from: '', to: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateRange.from) params.from = dateRange.from;
      if (dateRange.to)   params.to   = dateRange.to;
      const [t, s] = await Promise.allSettled([
        api.get('/quality/reports/ncr-trend', { params }),
        api.get('/quality/reports/inspection-summary', { params }),
      ]);
      if (t.status === 'fulfilled') setNcrTrend(t.value.data?.data || t.value.data || []);
      if (s.status === 'fulfilled') setInspSummary(s.value.data?.data || s.value.data || []);
    } catch { toast.error('Failed to load reports'); }
    finally { setLoading(false); }
  }, [dateRange, toast]);

  useEffect(() => { load(); }, [load]);

  const inp = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 };

  const ncrCsvUrl = `/api/v1/quality/ncr?export=csv${dateRange.from ? `&from=${dateRange.from}` : ''}${dateRange.to ? `&to=${dateRange.to}` : ''}`;
  const capaCsvUrl = `/api/v1/quality/capa?export=csv`;

  const totalInspections = inspSummary.reduce((s, r) => s + (parseInt(r.total) || 0), 0);
  const totalPass        = inspSummary.reduce((s, r) => s + (parseInt(r.passed) || 0), 0);
  const passRate         = totalInspections > 0 ? Math.round(totalPass * 100 / totalInspections) : 0;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Quality Reports</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <a href={ncrCsvUrl} target="_blank" style={{ padding: '8px 14px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 12, textDecoration: 'none', color: '#374151' }}>⬇ NCR CSV</a>
          <a href={capaCsvUrl} target="_blank" style={{ padding: '8px 14px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 12, textDecoration: 'none', color: '#374151' }}>⬇ CAPA CSV</a>
        </div>
      </div>

      {/* Date filter */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: '#6b7280' }}>From</label>
        <input type="date" style={inp} value={dateRange.from} onChange={e => setDateRange(p => ({ ...p, from: e.target.value }))} />
        <label style={{ fontSize: 12, color: '#6b7280' }}>To</label>
        <input type="date" style={inp} value={dateRange.to} onChange={e => setDateRange(p => ({ ...p, to: e.target.value }))} />
        <button onClick={load} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }}>Apply</button>
        <button onClick={() => setDateRange({ from: '', to: '' })} style={{ background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 12 }}>Clear</button>
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <>
          {/* KPI summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 28 }}>
            {[
              { label: 'Total Inspections', value: totalInspections, color: '#2563eb' },
              { label: 'Pass Rate', value: `${passRate}%`, color: passRate >= 95 ? '#16a34a' : passRate >= 80 ? '#d97706' : '#dc2626' },
              { label: 'Total NCRs (period)', value: ncrTrend.reduce((s, r) => s + (parseInt(r.count) || 0), 0), color: '#dc2626' },
            ].map(k => (
              <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{k.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* NCR trend chart */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>NCR Trend (by Month)</div>
            <SimpleBarChart data={ncrTrend} labelKey="month" valueKey="count" color="#dc2626" height={180} />
          </div>

          {/* Inspection summary by stage */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>Inspection Summary by Stage</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Stage','Total','Passed','Failed','Pass Rate'].map(h => <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {inspSummary.length === 0
                  ? <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No inspection data</td></tr>
                  : inspSummary.map((r, i) => {
                    const rate = parseInt(r.total) > 0 ? Math.round(parseInt(r.passed) * 100 / parseInt(r.total)) : 0;
                    return (
                      <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '9px 14px', fontWeight: 600 }}>{r.stage}</td>
                        <td style={{ padding: '9px 14px' }}>{r.total}</td>
                        <td style={{ padding: '9px 14px', color: '#16a34a', fontWeight: 600 }}>{r.passed}</td>
                        <td style={{ padding: '9px 14px', color: '#dc2626', fontWeight: 600 }}>{r.failed}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 60, height: 6, background: '#e5e7eb', borderRadius: 3 }}>
                              <div style={{ width: `${rate}%`, height: '100%', background: rate >= 95 ? '#16a34a' : rate >= 80 ? '#d97706' : '#dc2626', borderRadius: 3 }} />
                            </div>
                            <span style={{ fontWeight: 700, color: rate >= 95 ? '#16a34a' : rate >= 80 ? '#d97706' : '#dc2626' }}>{rate}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                }
              </tbody>
            </table>
          </div>

          {/* NCR trend data table */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>NCR Monthly Breakdown</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Month','Total NCRs','Critical','Major','Minor','Closed'].map(h => <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {ncrTrend.length === 0
                  ? <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No NCR data for period</td></tr>
                  : ncrTrend.map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '9px 14px', fontWeight: 500 }}>{r.month}</td>
                      <td style={{ padding: '9px 14px', fontWeight: 700 }}>{r.count}</td>
                      <td style={{ padding: '9px 14px', color: '#dc2626' }}>{r.critical || 0}</td>
                      <td style={{ padding: '9px 14px', color: '#d97706' }}>{r.major || 0}</td>
                      <td style={{ padding: '9px 14px', color: '#16a34a' }}>{r.minor || 0}</td>
                      <td style={{ padding: '9px 14px', color: '#6b7280' }}>{r.closed || 0}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
