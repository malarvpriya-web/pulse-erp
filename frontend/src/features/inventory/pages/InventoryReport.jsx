import { useEffect, useMemo, useState } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtL, fmtNum } from '@/utils/format';

/*
 * Inventory Report — ₹-value view of the stock ledger, per store & financial year.
 * Same underlying data as the Stores Dashboard (stock_ledger); this page is the
 * money view of it. FY follows the app-wide April–March convention.
 *
 * Tabs:
 *   Day Report      — daily purchased/used ₹ for the store
 *   Purchased (₹)   — monthwise category pivot of purchase value
 *   Used (₹)        — monthwise category pivot of consumption value
 *   Balance (₹)     — monthwise category pivot of running stock value
 *   Place Order     — items at/below reorder level → create purchase requisitions
 */

const TABS = [
  { key: 'day',         label: 'Day Report' },
  { key: 'purchased',   label: 'Purchased (₹)' },
  { key: 'used',        label: 'Used (₹)' },
  { key: 'balance',     label: 'Balance (₹)' },
  { key: 'place_order', label: 'Place Order' },
];

// Which category-pivot array each tab renders in the 12 monthly columns.
const PIVOT_FIELD = { purchased: 'purchased', used: 'used', balance: 'balance' };

// Stable empty fallbacks so referential identity is preserved across renders
// (keeps useMemo deps honest when the report hasn't loaded yet).
const EMPTY_ARR = [];
const DEFAULT_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

// Build the last N financial years as { year, label } (April–March).
function fyOptions(count = 5) {
  const now = new Date();
  const cur = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: count }, (_, i) => {
    const y = cur - i;
    return { year: y, label: `FY${y}-${String(y + 1).slice(-2)} (Apr ${y} - Mar ${y + 1})` };
  });
}

function toCSV(filename, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function InventoryReport() {
  const toast = useToast();
  const FY_OPTS = useMemo(() => fyOptions(5), []);

  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('all');
  const [fyYear, setFyYear] = useState(FY_OPTS[0].year);
  const [tab, setTab] = useState('day');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [placing, setPlacing] = useState(false);

  // Load store list once.
  useEffect(() => {
    api.get('/inventory/warehouses')
      .then(res => setStores(Array.isArray(res.data) ? res.data : []))
      .catch(() => setStores([]));
  }, []);

  // Load the report whenever store or FY changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api.get('/inventory/inventory-report/monthwise', { params: { warehouse_id: storeId, fy: fyYear } })
      .then(res => { if (alive) { setData(res.data); setSelected(new Set()); } })
      .catch(e => { if (alive) setError(e?.response?.data?.error || e.message || 'Failed to load report'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [storeId, fyYear]);

  const monthLabels = data?.month_labels ?? DEFAULT_MONTHS;
  const categories = data?.categories ?? EMPTY_ARR;
  const days = data?.days ?? EMPTY_ARR;
  const placeOrder = data?.place_order ?? EMPTY_ARR;

  const storeName = storeId === 'all'
    ? 'All Stores'
    : (stores.find(s => String(s.id) === String(storeId))?.warehouse_name || `Store ${storeId}`);

  // ── Column totals (footer) for the active pivot tab ──
  const pivotField = PIVOT_FIELD[tab];
  const pivotTotals = useMemo(() => {
    if (!pivotField) return null;
    const monthly = new Array(12).fill(0);
    let opening = 0, total = 0, closing = 0;
    categories.forEach(c => {
      opening += c.opening_value;
      closing += c.closing_value;
      (c[pivotField] || []).forEach((v, i) => { monthly[i] += v; total += v; });
    });
    return { opening, monthly, total, closing };
  }, [categories, pivotField]);

  // ── Downloads (exports the currently active tab) ──
  const download = () => {
    const stamp = new Date().toISOString().split('T')[0];
    const fyLbl = data?.fy?.label || `FY${fyYear}`;
    if (tab === 'day') {
      toCSV(`day-report-${stamp}.csv`, ['Date', 'Purchased (₹)', 'Used (₹)', 'Net (₹)', 'Transactions'],
        days.map(d => [d.day, d.purchased, d.used, d.net, d.txns]));
    } else if (tab === 'place_order') {
      toCSV(`place-order-${stamp}.csv`,
        ['Item Code', 'Item Name', 'Category', 'UOM', 'Current Stock', 'Reorder Level', 'Shortfall', 'Suggested Qty', 'Preferred Vendor'],
        placeOrder.map(r => [r.item_code, r.item_name, r.category, r.unit_of_measure, r.current_stock, r.reorder_level, r.shortfall, r.suggested_qty, r.preferred_vendor || '']));
    } else {
      const header = ['Category', 'Opening Stock (₹)', ...monthLabels.map(m => `${m} (₹)`), 'Total (₹)', 'Closing Balance (₹)'];
      const rows = categories.map(c => [
        c.category, c.opening_value, ...c[pivotField], c[pivotField].reduce((a, b) => a + b, 0), c.closing_value,
      ]);
      toCSV(`${tab}-report-${stamp}.csv`, header, rows);
    }
    toast.success(`${TABS.find(t => t.key === tab)?.label} exported (${storeName}, ${fyLbl})`);
  };

  // ── Place Order action → purchase requisitions ──
  const toggle = (id) => setSelected(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleAll = () => setSelected(prev =>
    prev.size === placeOrder.length ? new Set() : new Set(placeOrder.map(r => r.id)));

  const placeOrders = async () => {
    if (selected.size === 0) { toast.error('Select at least one item to order'); return; }
    setPlacing(true);
    try {
      const res = await api.post('/inventory/reorder-alerts/generate-pos', { item_ids: [...selected] });
      const created = res.data?.count ?? 0;
      const failed = res.data?.failed_count ?? 0;
      if (failed) toast.success(`${created} purchase request(s) created; ${failed} failed`);
      else toast.success(`${created} purchase request(s) created`);
      setSelected(new Set());
      // Refresh so ordered items reflect any change.
      const r = await api.get('/inventory/inventory-report/monthwise', { params: { warehouse_id: storeId, fy: fyYear } });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to create purchase requests');
    } finally {
      setPlacing(false);
    }
  };

  const th = { padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', fontSize: 12 };
  const thL = { ...th, textAlign: 'left' };
  const td = { padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const tdL = { ...td, textAlign: 'left' };

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: '#1f2937' }}>Inventory Report</h1>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 18 }}>
        ₹-value view of the stock ledger — {storeName}{data?.fy ? ` · ${data.fy.label}` : ''}
      </p>

      {/* ── Filter panel ── */}
      <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,.08)', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Select Store</label>
            <select value={storeId} onChange={e => setStoreId(e.target.value)}
              style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, minWidth: 200, background: '#fff' }}>
              <option value="all">All Stores</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.warehouse_name || s.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Financial Year</label>
            <select value={fyYear} onChange={e => setFyYear(+e.target.value)}
              style={{ padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, minWidth: 240, background: '#fff' }}>
              {FY_OPTS.map(o => <option key={o.year} value={o.year}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={download} disabled={loading}
            style={{ background: '#f9fafb', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 16px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}>
            ⬇ Download
          </button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '9px 16px', fontSize: 13,
              fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? '#6B3FDB' : '#6b7280',
              borderBottom: tab === t.key ? '2px solid #6B3FDB' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label}
            {t.key === 'place_order' && placeOrder.length > 0 && (
              <span style={{ marginLeft: 6, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>{placeOrder.length}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600 }}>{error}</div>
      )}
      {loading && <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>Loading report…</div>}

      {!loading && !error && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>

          {/* ── Category pivot tabs (Purchased / Used / Balance) ── */}
          {pivotField && (
            categories.length === 0 ? (
              <Empty label="No ledger data for this store and financial year." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={thL}>Category</th>
                      <th style={th}>Opening</th>
                      {monthLabels.map(m => <th key={m} style={th}>{m}</th>)}
                      <th style={{ ...th, background: '#f3f4f6' }}>Total</th>
                      <th style={{ ...th, background: '#f3f4f6' }}>Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((c, i) => {
                      const rowTotal = c[pivotField].reduce((a, b) => a + b, 0);
                      return (
                        <tr key={c.category} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                          <td style={{ ...tdL, fontWeight: 600 }}>{c.category}</td>
                          <td style={{ ...td, color: '#6b7280' }}>{fmtL(c.opening_value)}</td>
                          {c[pivotField].map((v, j) => (
                            <td key={j} style={{ ...td, color: v ? '#111827' : '#d1d5db' }}>{v ? fmtL(v) : '—'}</td>
                          ))}
                          <td style={{ ...td, fontWeight: 700, background: '#f9fafb' }}>{fmtL(rowTotal)}</td>
                          <td style={{ ...td, fontWeight: 700, background: '#f9fafb', color: '#6B3FDB' }}>{fmtL(c.closing_value)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {pivotTotals && (
                    <tfoot>
                      <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb', fontWeight: 700 }}>
                        <td style={tdL}>Total</td>
                        <td style={td}>{fmtL(pivotTotals.opening)}</td>
                        {pivotTotals.monthly.map((v, j) => <td key={j} style={td}>{v ? fmtL(v) : '—'}</td>)}
                        <td style={{ ...td, background: '#f3f4f6' }}>{fmtL(pivotTotals.total)}</td>
                        <td style={{ ...td, background: '#f3f4f6', color: '#6B3FDB' }}>{fmtL(pivotTotals.closing)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
                <div style={{ padding: '8px 14px', fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6' }}>
                  Closing = Opening + Purchased − Used · Total = sum of {monthLabels.length} monthly columns · values in ₹ (K/L/Cr)
                </div>
              </div>
            )
          )}

          {/* ── Day Report ── */}
          {tab === 'day' && (
            days.length === 0 ? (
              <Empty label="No stock movements recorded for this store and financial year." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={thL}>Date</th>
                      <th style={th}>Purchased</th>
                      <th style={th}>Used</th>
                      <th style={th}>Net</th>
                      <th style={th}>Transactions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d, i) => (
                      <tr key={d.day} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                        <td style={tdL}>{d.day}</td>
                        <td style={{ ...td, color: '#16a34a' }}>{fmtL(d.purchased)}</td>
                        <td style={{ ...td, color: '#dc2626' }}>{fmtL(d.used)}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{fmtL(d.net)}</td>
                        <td style={td}>{fmtNum(d.txns)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* ── Place Order ── */}
          {tab === 'place_order' && (
            placeOrder.length === 0 ? (
              <Empty label="No items are at or below their reorder level. 🎉" />
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>{selected.size} of {placeOrder.length} selected</span>
                  <button onClick={placeOrders} disabled={placing || selected.size === 0}
                    style={{ background: selected.size ? '#6B3FDB' : '#c4b5fd', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: placing || !selected.size ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}>
                    {placing ? 'Placing…' : `Create Purchase Request${selected.size !== 1 ? 's' : ''}`}
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        <th style={{ ...thL, width: 36 }}>
                          <input type="checkbox" checked={selected.size === placeOrder.length && placeOrder.length > 0} onChange={toggleAll} />
                        </th>
                        <th style={thL}>Item Code</th>
                        <th style={thL}>Item Name</th>
                        <th style={thL}>Category</th>
                        <th style={th}>Current Stock</th>
                        <th style={th}>Reorder Level</th>
                        <th style={th}>Shortfall</th>
                        <th style={th}>Suggested Qty</th>
                        <th style={thL}>Preferred Vendor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {placeOrder.map((r, i) => (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 ? '#fafafa' : '#fff' }}>
                          <td style={{ ...tdL }}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                          <td style={tdL}>{r.item_code}</td>
                          <td style={tdL}>{r.item_name}</td>
                          <td style={tdL}>{r.category}</td>
                          <td style={{ ...td, color: '#dc2626', fontWeight: 600 }}>{fmtNum(r.current_stock)}</td>
                          <td style={td}>{fmtNum(r.reorder_level)}</td>
                          <td style={{ ...td, color: '#ea580c' }}>{fmtNum(r.shortfall)}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{fmtNum(r.suggested_qty)}</td>
                          <td style={{ ...tdL, color: r.preferred_vendor ? '#374151' : '#9ca3af' }}>{r.preferred_vendor || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '8px 14px', fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6' }}>
                  Creating a purchase request routes into the procurement workflow (suggested qty = 2× reorder level − current stock).
                </div>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Empty({ label }) {
  return (
    <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
      <div style={{ fontSize: 34, marginBottom: 10 }}>📊</div>
      <div style={{ fontSize: 14 }}>{label}</div>
    </div>
  );
}
