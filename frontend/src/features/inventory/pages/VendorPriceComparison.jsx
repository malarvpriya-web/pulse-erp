// frontend/src/features/inventory/pages/VendorPriceComparison.jsx
// Component & Vendor Pricing dashboard: compares every vendor quote per store,
// surfaces the best price / best vendor / spread / savings-vs-preferred, and
// breaks the catalogue down by ABC class and category. Filter by store,
// category, ABC class and search. Data: GET /inventory/catalog/vendor-price-comparison
import { useEffect, useRef, useState, useCallback } from 'react';
import api from '@/services/api/client';
import { getVendorPriceComparison, getCategories } from '../services/inventoryService';

const ABC_COLORS = { A: ['#d1fae5', '#16a34a'], B: ['#fef3c7', '#d97706'], C: ['#f3f4f6', '#6b7280'], Unclassified: ['#f3f4f6', '#9ca3af'] };
const BRAND = '#6B3FDB';

const fmtMoney = (v) => {
  const n = parseFloat(v);
  return isNaN(n) || n === null ? '—' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const fmtNum = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

function Kpi({ label, value, sub, color = '#1f2937' }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 4px rgba(0,0,0,.08)', minWidth: 165, flex: '1 1 165px' }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function AbcBadge({ cat }) {
  const [bg, color] = ABC_COLORS[cat] || ABC_COLORS.Unclassified;
  return <span style={{ fontWeight: 700, color, background: bg, padding: '2px 9px', borderRadius: 8, fontSize: 12 }}>{cat === 'Unclassified' ? '—' : cat}</span>;
}

const COLS = [
  ['item_code', 'Item Code'], ['item_name', 'Component'], ['category_name', 'Category'],
  ['abc_class', 'ABC'], ['vendor_count', 'Vendors'], ['best_price', 'Best Price'],
  ['best_vendor', 'Best Vendor'], ['avg_price', 'Avg'], ['highest_price', 'Highest'],
  ['spread_pct', 'Spread %'], ['preferred_price', 'Preferred'], ['savings_vs_preferred', 'Savings'],
];

function exportCSV(items) {
  const header = COLS.map(c => c[1]).join(',');
  const body = items.map(r => COLS.map(([k]) => {
    const v = String(r[k] ?? '');
    return v.includes(',') ? `"${v}"` : v;
  }).join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vendor-price-comparison-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function VendorPriceComparison() {
  const [data, setData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ warehouse_id: '', category_id: '', abc_class: '', search: '' });
  const [onlySavings, setOnlySavings] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    getCategories({ active_only: 'true' }).then(setCategories);
    api.get('/inventory/warehouses').then(r => setWarehouses(r.data?.warehouses || r.data || [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const params = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const res = await api.get('/inventory/catalog/vendor-price-comparison', { params, signal: controller.signal });
      setData(res.data);
    } catch (e) {
      if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') return;
      setError(e?.response?.data?.error || e.message || 'Failed to load comparison');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); return () => abortRef.current?.abort?.(); }, [load]);

  const s = data?.summary || {};
  const byAbc = data?.by_abc || {};
  const byCategory = data?.by_category || [];
  let items = data?.items || [];
  if (onlySavings) items = items.filter(i => (i.savings_vs_preferred || 0) > 0);
  const maxCatComponents = Math.max(1, ...byCategory.map(c => c.components));

  const selInput = { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, background: '#fff' };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Component &amp; Vendor Pricing</h1>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
            Compare every vendor quote per store — best price, spread &amp; savings vs the preferred vendor, by category &amp; ABC class
          </div>
        </div>
        {items.length > 0 && (
          <button onClick={() => exportCSV(items)} style={{ background: '#f9fafb', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            ⬇ Export CSV
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}>
        <select style={selInput} value={filters.warehouse_id} onChange={e => setFilters(f => ({ ...f, warehouse_id: e.target.value }))}>
          <option value="">All Stores</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name || w.name}</option>)}
        </select>
        <select style={selInput} value={filters.category_id} onChange={e => setFilters(f => ({ ...f, category_id: e.target.value }))}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={selInput} value={filters.abc_class} onChange={e => setFilters(f => ({ ...f, abc_class: e.target.value }))}>
          <option value="">All ABC</option>
          {['A', 'B', 'C'].map(c => <option key={c} value={c}>Class {c}</option>)}
        </select>
        <input style={{ ...selInput, minWidth: 200 }} placeholder="Search component…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlySavings} onChange={e => setOnlySavings(e.target.checked)} /> Only with savings
        </label>
      </div>

      {error && <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600 }}>{error}</div>}
      {loading && <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>Loading comparison…</div>}

      {!loading && !error && data && (
        <>
          {/* KPIs */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Kpi label="Components" value={fmtNum(s.total_components)} sub={`${fmtNum(s.priced_components)} priced · ${fmtNum(s.unpriced_components)} unpriced`} />
            <Kpi label="Vendor Quotes" value={fmtNum(s.total_vendor_quotes)} sub={`${fmtNum(s.multi_vendor_components)} multi-vendor components`} />
            <Kpi label="Potential Savings" value={fmtMoney(s.total_potential_savings)} sub="preferred → cheapest quote" color={BRAND} />
            <Kpi label="Avg Price Spread" value={`${fmtNum(s.avg_spread_pct)}%`} sub="highest vs best, per component" />
          </div>

          {/* ABC + Category breakdown */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, alignItems: 'stretch' }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,.08)', flex: '1 1 260px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 12 }}>By ABC Class</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {['A', 'B', 'C', 'Unclassified'].map(k => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 100px' }}>
                    <AbcBadge cat={k} />
                    <span style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{byAbc[k] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,.08)', flex: '2 1 420px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 12 }}>By Category</div>
              {byCategory.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>No components.</div>
              ) : byCategory.slice(0, 8).map(c => (
                <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
                  <div style={{ width: 140, fontSize: 12.5, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.category}</div>
                  <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 6, height: 16, overflow: 'hidden' }}>
                    <div style={{ width: `${(c.components / maxCatComponents) * 100}%`, background: BRAND, height: '100%' }} />
                  </div>
                  <div style={{ width: 40, textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: '#1f2937' }}>{c.components}</div>
                  <div style={{ width: 90, textAlign: 'right', fontSize: 11.5, color: c.potential_savings > 0 ? '#16a34a' : '#9ca3af' }}>
                    {c.potential_savings > 0 ? `save ${fmtMoney(c.potential_savings)}` : '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Comparison table */}
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {COLS.map(([k, label]) => (
                      <th key={k} style={{ padding: '9px 12px', textAlign: ['item_code', 'item_name', 'category_name', 'best_vendor'].includes(k) ? 'left' : 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr><td colSpan={COLS.length} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No components match these filters.</td></tr>
                  ) : items.map((r, i) => {
                    const savings = parseFloat(r.savings_vs_preferred) || 0;
                    return (
                      <tr key={r.item_id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '8px 12px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.item_code}</td>
                        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{r.item_name}</td>
                        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{r.category_name || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}><AbcBadge cat={r.abc_class || 'Unclassified'} /></td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{r.vendor_count > 0 ? r.vendor_count : <span style={{ color: '#dc2626' }}>0</span>}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: '#15803d' }}>{fmtMoney(r.best_price)}</td>
                        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#374151' }}>{r.best_vendor || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#6b7280' }}>{fmtMoney(r.avg_price)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#6b7280' }}>{fmtMoney(r.highest_price)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: r.spread_pct > 0 ? '#d97706' : '#9ca3af' }}>{r.spread_pct != null ? `${fmtNum(r.spread_pct)}%` : '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#6b7280' }}>{fmtMoney(r.preferred_price)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: savings > 0 ? 700 : 400, color: savings > 0 ? '#16a34a' : '#9ca3af' }}>{savings > 0 ? fmtMoney(savings) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
