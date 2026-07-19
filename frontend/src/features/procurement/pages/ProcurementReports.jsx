import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Download, TrendingUp, Package, Users, BarChart2 } from 'lucide-react';
import api from '@/services/api/client';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function BarChart({ data, labelKey, valueKey, color = '#10b981' }) {
  if (!data || data.length === 0) return <p style={{ color: '#9ca3af', textAlign: 'center', padding: 24 }}>No data</p>;
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0)) || 1;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 160, padding: '8px 0' }}>
      {data.map((d, i) => {
        const pct = ((Number(d[valueKey]) || 0) / max) * 100;
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>
              {Number(d[valueKey]) > 0 ? `₹${Number(d[valueKey]) >= 100000 ? (Number(d[valueKey]) / 100000).toFixed(1) + 'L' : (Number(d[valueKey]) / 1000).toFixed(0) + 'K'}` : ''}
            </span>
            <div style={{ width: '100%', height: `${Math.max(pct, 4)}%`, background: color, borderRadius: '4px 4px 0 0', minHeight: 4 }} title={`${d[labelKey]}: ₹${Number(d[valueKey]).toLocaleString('en-IN')}`} />
            <span style={{ fontSize: 9, color: '#9ca3af', textAlign: 'center', maxWidth: 36, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(d[labelKey]).slice(0, 6)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SpendTable({ rows, labelKey, valueKey }) {
  if (!rows || rows.length === 0) return <p style={{ color: '#9ca3af', padding: 16 }}>No data</p>;
  const total = rows.reduce((s, r) => s + (Number(r[valueKey]) || 0), 0);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#f9fafb' }}>
          <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{labelKey === 'vendor_name' ? 'Vendor' : 'Category'}</th>
          <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>Spend (₹)</th>
          <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151' }}>Share %</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((r, i) => {
          const val = Number(r[valueKey]) || 0;
          const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0';
          return (
            <tr key={i} style={{ borderBottom: '1px solid #f5f5f5' }}>
              <td style={{ padding: '8px 12px' }}>{r[labelKey] || '—'}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>₹{val.toLocaleString('en-IN')}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: '#6b7280' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                  <div style={{ width: 60, height: 4, background: '#f3f4f6', borderRadius: 2 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: '#10b981', borderRadius: 2 }} />
                  </div>
                  {pct}%
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ProcurementReports() {
  const [spendData,  setSpendData]  = useState({ by_vendor: [], by_category: [], by_month: [] });
  const [trendData,  setTrendData]  = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [toast,      setToast]      = useState(null);
  const [dateRange,  setDateRange]  = useState({ from: '', to: '' });
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateRange.from) params.from = dateRange.from;
      if (dateRange.to)   params.to   = dateRange.to;
      const [spendR, trendR] = await Promise.allSettled([
        api.get('/procurement/analytics/spend', { params }),
        api.get('/procurement/dashboard/spend-trend'),
      ]);
      if (!isMounted.current) return;
      if (spendR.status === 'fulfilled') setSpendData(spendR.value.data || { by_vendor: [], by_category: [], by_month: [] });
      if (trendR.status === 'fulfilled') setTrendData(trendR.value.data || []);
    } finally { if (isMounted.current) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const exportCSV = (path, name) => {
    const params = [];
    if (dateRange.from) params.push(`from=${dateRange.from}`);
    if (dateRange.to)   params.push(`to=${dateRange.to}`);
    const qs = params.length ? '?' + params.join('&') : '';
    window.open(`/api/procurement/${path}/export${qs}`, '_blank');
  };

  const inp = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const card = { background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.07)', padding: 20 };

  return (
    <div style={{ padding: '24px 28px', margin: '0 auto' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, padding: '10px 20px', borderRadius: 8, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#991b1b' : '#166534', fontWeight: 600, fontSize: 14 }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111' }}>Procurement Reports</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Spend analytics, export data, and procurement insights</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" style={inp} value={dateRange.from} onChange={e => setDateRange(r => ({ ...r, from: e.target.value }))} />
          <span style={{ color: '#9ca3af', fontSize: 13 }}>to</span>
          <input type="date" style={inp} value={dateRange.to} onChange={e => setDateRange(r => ({ ...r, to: e.target.value }))} />
          <button onClick={load} style={{ background: '#10b981', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} /> Apply
          </button>
        </div>
      </div>

      {/* Export Buttons */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Export Data:</span>
          {[
            { label: 'Purchase Requests', path: 'purchase-requests', icon: Package },
            { label: 'Purchase Orders', path: 'purchase-orders', icon: TrendingUp },
            { label: 'GRN Records', path: 'grn', icon: BarChart2 },
          ].map(({ label, path, icon: Icon }) => (
            <button key={path} onClick={() => exportCSV(path, label)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}>
              <Download size={13} /> {label} CSV
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading analytics…</div>
      ) : (
        <>
          {/* 12-Month Spend Trend */}
          <div style={{ ...card, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <TrendingUp size={18} color="#10b981" />
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>12-Month Spend Trend</h3>
            </div>
            <BarChart
              data={trendData.map(d => ({ ...d, label: `${MONTHS[(new Date(d.month || d.period || '')).getMonth()] || d.month || ''}` }))}
              labelKey="label"
              valueKey="total_spend"
              color="#10b981"
            />
            {trendData.length > 0 && (
              <div style={{ display: 'flex', gap: 24, marginTop: 12, borderTop: '1px solid #f5f5f5', paddingTop: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Total (period)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>
                    ₹{trendData.reduce((s, d) => s + (Number(d.total_spend) || 0), 0).toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Monthly Avg</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>
                    ₹{trendData.length ? Math.round(trendData.reduce((s, d) => s + (Number(d.total_spend) || 0), 0) / trendData.length).toLocaleString('en-IN') : 0}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Peak Month</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>
                    {trendData.reduce((best, d) => (Number(d.total_spend) || 0) > (Number(best.total_spend) || 0) ? d : best, trendData[0])?.month?.slice(0, 7) || '—'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Spend by Vendor + Category */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Users size={18} color="#6366f1" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Top Vendors by Spend</h3>
              </div>
              <SpendTable rows={spendData.by_vendor || []} labelKey="vendor_name" valueKey="total_spend" />
            </div>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Package size={18} color="#f59e0b" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Spend by Category</h3>
              </div>
              <SpendTable rows={spendData.by_category || []} labelKey="category" valueKey="total_spend" />
            </div>
          </div>

          {/* Monthly Breakdown Table */}
          {(spendData.by_month || []).length > 0 && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <BarChart2 size={18} color="#10b981" />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Monthly Spend Breakdown</h3>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Month', 'PO Count', 'Total Spend (₹)', 'vs Previous'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Month' ? 'left' : 'right', fontWeight: 600, color: '#374151' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(spendData.by_month || []).map((row, i) => {
                    const prev = i > 0 ? Number((spendData.by_month)[i - 1].total_spend) || 0 : null;
                    const curr = Number(row.total_spend) || 0;
                    const delta = prev !== null && prev > 0 ? ((curr - prev) / prev * 100).toFixed(1) : null;
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                        <td style={{ padding: '8px 12px' }}>{row.month?.slice(0, 7) || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{row.po_count || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>₹{curr.toLocaleString('en-IN')}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: delta === null ? '#9ca3af' : Number(delta) >= 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                          {delta !== null ? `${Number(delta) >= 0 ? '+' : ''}${delta}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
