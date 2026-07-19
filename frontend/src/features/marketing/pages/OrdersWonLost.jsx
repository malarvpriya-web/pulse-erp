import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';

const PAGE_SIZE = 20;

const fmtL = (n) => {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const STATUS_COLORS = {
  won:       { bg: '#d1fae5', color: '#16a34a' },
  lost:      { bg: '#fee2e2', color: '#dc2626' },
  pending:   { bg: '#fef3c7', color: '#d97706' },
  confirmed: { bg: '#dbeafe', color: '#2563eb' },
};

const PERIODS = [
  { value: '', label: 'All Time' },
  { value: 'month',   label: 'Last 30 Days' },
  { value: 'quarter', label: 'Last Quarter' },
];

export default function OrdersWonLost() {
  const [rows, setRows]         = useState([]);
  const [stats, setStats]       = useState({});
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);
  const [filterCamp, setFilterCamp]   = useState('');
  const [filterPeriod, setFilterPeriod] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterCamp)   params.campaign_id = filterCamp;
      if (filterPeriod) params.period      = filterPeriod;
      const [ordersRes, statsRes, campsRes] = await Promise.allSettled([
        api.get('/marketing/orders-won-lost', { params }),
        api.get('/marketing/orders-won-lost/stats'),
        api.get('/marketing/campaigns'),
      ]);
      setRows(ordersRes.status === 'fulfilled' && Array.isArray(ordersRes.value?.data) ? ordersRes.value.data : []);
      setStats(statsRes.status === 'fulfilled' ? (statsRes.value?.data || {}) : {});
      setCampaigns(campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data) ? campsRes.value.data : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [filterCamp, filterPeriod]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const COLS = ['Order No', 'Customer', 'Campaign', 'Value', 'Status', 'Date'];

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Orders Won / Lost</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Sales outcomes attributed to marketing campaigns</p>
        </div>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search orders…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 180 }} />
        <div style={{ position: 'relative' }}>
          <select value={filterCamp} onChange={e => { setFilterCamp(e.target.value); setPage(1); }}
            style={{ appearance: 'none', padding: '7px 32px 7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>
            <option value="">All Campaigns</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <ChevronDown size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--color-text-secondary)' }} />
        </div>
        <div style={{ position: 'relative' }}>
          <select value={filterPeriod} onChange={e => { setFilterPeriod(e.target.value); setPage(1); }}
            style={{ appearance: 'none', padding: '7px 32px 7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>
            {PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <ChevronDown size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--color-text-secondary)' }} />
        </div>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Won Orders',       value: loading ? '…' : stats.won_count ?? '—',     color: '#16a34a', bg: '#d1fae5' },
          { label: 'Won Value',        value: loading ? '…' : fmtL(stats.won_value),       color: '#16a34a', bg: '#d1fae5' },
          { label: 'Lost Orders',      value: loading ? '…' : stats.lost_count ?? '—',    color: '#dc2626', bg: '#fee2e2' },
          { label: 'Conversion Rate',  value: loading ? '…' : stats.conversion_rate != null ? `${stats.conversion_rate}%` : '—', color: '#2563eb', bg: '#dbeafe' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 500, marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color }}>
              {loading
                ? <div style={{ height: 22, width: 60, background: 'var(--color-border-tertiary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
                : value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              {[90, 140, 120, 100, 80, 110].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : paged.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
              <TrendingUp size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No campaign-attributed orders</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>Sales orders linked to campaigns will appear here.</p>
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {COLS.map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => {
                  const statusKey = (r.status || '').toLowerCase();
                  const sc = STATUS_COLORS[statusKey] || { bg: '#f3f4f6', color: '#6b7280' };
                  return (
                    <tr key={r.id ?? i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: statusKey === 'won' ? 'rgba(22,163,74,0.03)' : statusKey === 'lost' ? 'rgba(220,38,38,0.03)' : 'transparent' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{r.order_no || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-primary)', fontWeight: 500 }}>{r.customer_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.campaign_name || '—'}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}>{fmtL(r.total_amount)}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>{r.status || '—'}</span>
                      </td>
                      <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span>{filtered.length} records · Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === 1 ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === 1 ? 0.5 : 1, fontSize: 13 }}>Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === totalPages ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === totalPages ? 0.5 : 1, fontSize: 13 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
