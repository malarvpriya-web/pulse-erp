import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, RefreshCw, CheckCircle, Download } from 'lucide-react';
import api from '@/services/api/client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { currentFY, fyOptions } from '@/utils/financialYear';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtINR = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtL = (v) => {
  const n = Number(v ?? 0);
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
};
const fmtPct = (v) => v != null && isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : 'N/A';
const varColor = (v) => Number(v) >= 0 ? '#10b981' : '#ef4444';

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KPI({ label, value, sub, color, icon: Icon }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '16px 20px', flex: 1, minWidth: 180 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 21, fontWeight: 700, color: color || '#111827' }}>{value}</div>
          {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
        </div>
        {Icon && (
          <div style={{ background: (color || '#6366f1') + '18', borderRadius: 8, padding: 8 }}>
            <Icon size={18} color={color || '#6366f1'} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Utilization Progress Bar ──────────────────────────────────────────────────
function UtilBar({ pct }) {
  const n = Number(pct) || 0;
  const c = n >= 100 ? '#ef4444' : n >= 85 ? '#f59e0b' : '#10b981';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ width: 70, background: '#f5f5f7', borderRadius: 4, height: 6, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(100, n)}%`, background: c, height: '100%', borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: c, minWidth: 34, textAlign: 'right' }}>{fmtPct(n)}</span>
    </div>
  );
}

// ── Panel (used standalone and embedded in BudgetManagement tab) ──────────────
export function BudgetVsActualsPanel() {
  const FY_OPTS = fyOptions();
  const [fy, setFy] = useState(currentFY());
  const [dept, setDept] = useState('All');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deptList, setDeptList] = useState(['All']);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/budgets/report/vs-actuals', {
        params: { financial_year: fy, department: dept === 'All' ? '' : dept },
      });
      setData(res.data);
      const names = (res.data?.by_department || []).map(r => r.department).filter(Boolean);
      setDeptList(['All', ...new Set(names)]);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fy, dept]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary || {};
  const deptRows = data?.by_department || [];
  const catRows = [...(data?.by_category || [])].sort(
    (a, b) => parseFloat(b.actual ?? b.actual_spend ?? 0) - parseFloat(a.actual ?? a.actual_spend ?? 0)
  );
  const chartData = deptRows.map(r => ({
    name: (r.department || '').slice(0, 8),
    Budgeted: Math.round(parseFloat(r.budgeted ?? 0) / 100000),
    Actual: Math.round(parseFloat(r.actual ?? 0) / 100000),
  }));

  const fyLabel = FY_OPTS.find(f => f.value === fy)?.label || fy;

  const exportCSV = () => {
    const header = ['Category', 'Budgeted', 'Actual Spend', 'Variance', 'Utilization%'];
    const rows = catRows.map(r => {
      const bud = parseFloat(r.budgeted ?? 0);
      const act = parseFloat(r.actual ?? r.actual_spend ?? 0);
      const vari = bud - act;
      const pct = bud > 0 ? ((act / bud) * 100).toFixed(1) : '0.0';
      return [r.category, bud, act, vari, pct];
    });
    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spend-by-category-${fy}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 }}>Budget vs Actuals</h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Track departmental spend against approved budgets</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={fy} onChange={e => setFy(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
            {FY_OPTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <select value={dept} onChange={e => setDept(e.target.value)}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
            {deptList.map(d => <option key={d}>{d}</option>)}
          </select>
          <button onClick={load}
            style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>
            <RefreshCw size={13} color="#6b7280" />
          </button>
        </div>
      </div>

      {/* Alerts */}
      {(data?.alerts || []).map((a, i) => (
        <div key={i} style={{
          background: a.severity === 'critical' ? '#fef2f2' : '#fef9c3',
          border: `1px solid ${a.severity === 'critical' ? '#fecaca' : '#fde68a'}`,
          borderRadius: 10, padding: '10px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
        }}>
          <AlertTriangle size={14} color={a.severity === 'critical' ? '#ef4444' : '#f59e0b'} />
          <span style={{ color: a.severity === 'critical' ? '#991b1b' : '#92400e' }}>
            <strong>{a.department}</strong> is at {fmtPct(a.utilization_pct)} utilization — {
              a.overspent
                ? `overspent by ${fmtINR(Math.abs(Number(a.variance ?? 0)))}`
                : `only ${fmtINR(Math.abs(Number(a.variance ?? 0)))} remaining`
            }
          </span>
        </div>
      ))}

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <KPI label="Total Budgeted" value={fmtL(s.total_budgeted)} icon={TrendingUp} color="#6366f1" />
        <KPI label="Total Actual Spend" value={fmtL(s.total_actual)} icon={TrendingDown} color="#3b82f6" />
        <KPI label="Remaining Budget" value={fmtL(s.total_variance)} color="#10b981" sub="Unspent" icon={CheckCircle} />
        <KPI
          label="Overall Utilization"
          value={fmtPct(s.overall_utilization)}
          color={Number(s.overall_utilization) >= 100 ? '#ef4444' : Number(s.overall_utilization) >= 85 ? '#f59e0b' : '#10b981'}
          sub={`of ${fyLabel}`}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        {/* Bar Chart */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 16 }}>
            Budget vs Actual by Department (₹L)
          </div>
          {loading ? (
            <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>
              Loading…
            </div>
          ) : chartData.length === 0 ? (
            <div style={{ height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#9ca3af' }}>
              <div style={{ fontSize: 13 }}>No department budgets for {fyLabel}.</div>
              <div style={{ fontSize: 12 }}>Create budgets in Budget Management → Budget List.</div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                  tickFormatter={v => `₹${v}L`} />
                <Tooltip formatter={v => [`₹${v}L`]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #f0f0f4' }} />
                <Legend iconType="square" wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Budgeted" fill="#e0e7ff" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Actual" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Department Breakdown */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #f5f5f7', fontSize: 13, fontWeight: 600, color: '#374151' }}>
            Department Breakdown
          </div>
          {deptRows.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No department data for {fyLabel}.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Department', 'Budgeted', 'Actual', 'Variance', 'Utilization'].map(h => (
                    <th key={h} style={{
                      padding: '8px 12px',
                      textAlign: h === 'Department' ? 'left' : 'right',
                      fontWeight: 600, color: '#6b7280', fontSize: 11,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deptRows.map((r, i) => {
                  const bud = parseFloat(r.budgeted ?? 0);
                  const act = parseFloat(r.actual ?? 0);
                  const vari = bud - act;
                  const pct = parseFloat(r.utilization_pct ?? 0);
                  return (
                    <tr key={i} style={{ borderTop: '1px solid #f5f5f7' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500, color: '#374151' }}>{r.department}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#6b7280' }}>{fmtL(bud)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: '#111827' }}>{fmtL(act)}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: varColor(vari) }}>
                        {vari < 0 ? `(${fmtINR(Math.abs(vari))})` : fmtINR(vari)}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <UtilBar pct={pct} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Spend by Category */}
      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #f5f5f7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Spend by Category</span>
          <button onClick={exportCSV} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
            background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151',
          }}>
            <Download size={12} /> Export
          </button>
        </div>
        {catRows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            No category data for {fyLabel}.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Category', 'Budgeted', 'Actual Spend', 'Variance', 'Utilization'].map(h => (
                  <th key={h} style={{
                    padding: '9px 14px',
                    textAlign: h === 'Category' ? 'left' : 'right',
                    fontWeight: 600, color: '#6b7280', fontSize: 11,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catRows.map((r, i) => {
                const bud = parseFloat(r.budgeted ?? 0);
                const act = parseFloat(r.actual ?? r.actual_spend ?? 0);
                const vari = bud - act;
                const pct = bud > 0 ? Math.round((act / bud) * 100) : 0;
                return (
                  <tr key={i} style={{ borderTop: '1px solid #f5f5f7' }}>
                    <td style={{ padding: '10px 14px', color: '#374151', fontWeight: 500 }}>{r.category}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtINR(bud)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#111827' }}>{fmtINR(act)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: varColor(vari) }}>
                      {vari < 0 ? `(${fmtINR(Math.abs(vari))})` : fmtINR(vari)}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <UtilBar pct={pct} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ── Standalone page wrapper ───────────────────────────────────────────────────
export default function BudgetVsActuals() {
  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <BudgetVsActualsPanel />
    </div>
  );
}
