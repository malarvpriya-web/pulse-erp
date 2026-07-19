import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { TrendingUp } from 'lucide-react';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function currentFYYear(d = new Date()) {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

const fmtL = (n) => {
  const v = Number(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtPct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

function periodLabel(type, year, value) {
  if (type === 'annual')    return `FY ${year}-${String(year + 1).slice(2)}`;
  if (type === 'quarterly') return `Q${value} FY ${year}-${String(year + 1).slice(2)}`;
  return `${MONTHS[value - 1]} ${year}`;
}

export default function SalesForecasts() {
  const toast = useToast();
  const now = new Date();
  const [periodType,  setPeriodType]  = useState('monthly');
  const [periodYear,  setPeriodYear]  = useState(currentFYYear(now));
  const [periodValue, setPeriodValue] = useState(now.getMonth() + 1);

  const [summary,  setSummary]  = useState(null);
  const [monthData,setMonthData]= useState([]);
  const [repData,  setRepData]  = useState([]);
  const [pipeline, setPipeline] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const abortRef = useRef(null);

  const pval = periodType === 'annual' ? 1 : periodValue;

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const qs = `period_type=${periodType}&period_year=${periodYear}&period_value=${pval}`;
    Promise.all([
      api.get(`/sales/forecasts/summary?${qs}`,            { signal: ctrl.signal }),
      api.get(`/sales/forecasts/by-month?period_year=${periodYear}`, { signal: ctrl.signal }),
      api.get(`/sales/forecasts/by-rep?${qs}`,             { signal: ctrl.signal }),
      api.get(`/sales/forecasts/pipeline-breakdown?${qs}`, { signal: ctrl.signal }),
    ])
      .then(([s, m, r, p]) => {
        setSummary(s.data ?? null);
        setMonthData(Array.isArray(m.data) ? m.data : []);
        setRepData(Array.isArray(r.data)   ? r.data : []);
        setPipeline(Array.isArray(p.data)  ? p.data : []);
      })
      .catch((err) => { if (err?.name !== 'CanceledError' && err?.name !== 'AbortError') toast.error('Failed to load forecast data'); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [periodType, periodYear, pval]);

  const pct = summary?.achievement_pct;
  const pctColor = pct == null
    ? '#6b7280'
    : pct >= 100 ? '#059669'
    : pct >= 70  ? '#d97706'
    : '#dc2626';

  const chartData = monthData.map((r) => ({
    month:      MONTHS[r.month - 1],
    Forecasted: parseFloat(r.forecasted) || 0,
    Achieved:   parseFloat(r.achieved)   || 0,
    Target:     parseFloat(r.target)     || 0,
  }));

  const noData = !loading && summary !== null
    && (parseFloat(summary?.forecasted) || 0) === 0
    && (parseFloat(summary?.achieved)   || 0) === 0;

  const yearOpts = [];
  for (let y = now.getFullYear() - 3; y <= now.getFullYear() + 1; y++) yearOpts.push(y);

  const pvOptions = periodType === 'monthly'
    ? MONTHS.map((m, i) => ({ label: m, value: i + 1 }))
    : periodType === 'quarterly'
    ? [1, 2, 3, 4].map((q) => ({ label: `Q${q}`, value: q }))
    : [];

  const btnBase = { padding: '7px 16px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
  const selBase = { padding: '7px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, color: '#374151', background: '#fff', cursor: 'pointer' };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Sales Forecasts</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
          Auto-computed from pipeline opportunities · {periodLabel(periodType, periodYear, pval)}
        </p>
      </div>

      {/* Period Filter */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        {['monthly', 'quarterly', 'annual'].map((t) => (
          <button key={t}
            onClick={() => {
              setPeriodType(t);
              if (t === 'quarterly') setPeriodValue(Math.ceil((now.getMonth() + 1) / 3));
              if (t === 'monthly')   setPeriodValue(now.getMonth() + 1);
            }}
            style={{ ...btnBase, background: periodType === t ? '#6B3FDB' : '#fff', color: periodType === t ? '#fff' : '#374151' }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <select value={periodYear} onChange={(e) => setPeriodYear(Number(e.target.value))} style={selBase}>
          {yearOpts.map((y) => (
            <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>
          ))}
        </select>
        {pvOptions.length > 0 && (
          <select value={periodValue} onChange={(e) => setPeriodValue(Number(e.target.value))} style={selBase}>
            {pvOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Total Forecasted', value: fmtL(summary?.forecasted), color: '#6366f1' },
          { label: 'Total Achieved',   value: fmtL(summary?.achieved),   color: '#10b981' },
          { label: 'Target',           value: fmtL(summary?.target),     color: '#f59e0b' },
          { label: 'Achievement %',    value: fmtPct(pct),               color: pctColor  },
        ].map((k) => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: 20, border: '1px solid #f0f0f4' }}>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k.label}</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: k.color, margin: 0 }}>{k.value}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading forecasts…</div>
      ) : noData ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <TrendingUp size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', fontWeight: 500, margin: '0 0 6px', fontSize: 15 }}>
            No opportunities with close dates in this period.
          </p>
          <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 20px' }}>
            Add opportunities in CRM → Opportunities to see forecasts.
          </p>
          <a href="/crm/opportunities"
            style={{ display: 'inline-block', padding: '9px 20px', background: '#6B3FDB', color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
            Go to Opportunities
          </a>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24, marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: '#1f2937', margin: '0 0 20px' }}>
              Forecast vs Achieved vs Target — FY {periodYear}-{String(periodYear + 1).slice(2)}
            </h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => v >= 100000 ? `${(v / 100000).toFixed(0)}L` : v} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, name) => [fmtL(v), name]} />
                <Legend />
                <Bar dataKey="Forecasted" fill="#6366f1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Achieved"   fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Target"     fill="#e5e7eb" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* By Rep + Pipeline */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

            {/* By Rep */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>By Sales Rep</h3>
              </div>
              {repData.length === 0 ? (
                <p style={{ color: '#9ca3af', fontSize: 13, padding: 20, textAlign: 'center', margin: 0 }}>No rep data for this period</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Rep', 'Forecasted', 'Achieved', 'Target', '%'].map((h) => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Rep' ? 'left' : 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {repData.map((r, i) => {
                      const ap = r.target > 0 ? Math.round(r.achieved / r.target * 100) : null;
                      return (
                        <tr key={r.id || i} style={{ borderBottom: '1px solid #f9fafb' }}>
                          <td style={{ padding: '9px 14px', color: '#1f2937', fontWeight: 500 }}>
                            <div>{r.name}</div>
                            {r.designation && <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.designation}</div>}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6366f1' }}>{fmtL(r.forecasted)}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmtL(r.achieved)}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtL(r.target)}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700,
                            color: ap == null ? '#9ca3af' : ap >= 100 ? '#059669' : ap >= 70 ? '#d97706' : '#dc2626' }}>
                            {fmtPct(ap)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pipeline Breakdown */}
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>Pipeline Breakdown</h3>
              </div>
              {pipeline.length === 0 ? (
                <p style={{ color: '#9ca3af', fontSize: 13, padding: 20, textAlign: 'center', margin: 0 }}>No pipeline data for this period</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Stage', 'Deals', 'Gross Value', 'Weighted', 'Avg %'].map((h) => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Stage' ? 'left' : 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pipeline.map((p, i) => (
                      <tr key={p.stage || i} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '9px 14px', color: '#1f2937', fontWeight: 500 }}>{p.stage}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6b7280' }}>{p.deal_count}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtL(p.gross_value)}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: '#6366f1', fontWeight: 600 }}>{fmtL(p.weighted_value)}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: '#f59e0b', fontWeight: 600 }}>
                          {p.avg_probability != null ? `${Number(p.avg_probability).toFixed(0)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

          </div>
        </>
      )}
    </div>
  );
}
