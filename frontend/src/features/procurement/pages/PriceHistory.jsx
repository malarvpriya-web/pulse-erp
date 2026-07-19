import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Minus, Plus, Search, RefreshCw,
  X, BarChart2, ChevronDown, Tag, ArrowUp, ArrowDown, Save,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import api from '@/services/api/client';
import './PriceHistory.css';

const INR = n => n == null ? '—' : `₹${parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtShort = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';

const VENDOR_COLORS = ['#10b981','#6366f1','#f59e0b','#ef4444','#8b5cf6','#0ea5e9','#f97316','#14b8a6'];

const EMPTY_FORM = { vendor_name_text: '', unit_price: '', quantity: '', price_date: new Date().toISOString().slice(0,10), price_type: 'purchase', reference_number: '', notes: '' };

// ── Recharts custom tooltip ───────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="ph-recharts-tooltip">
      <div className="ph-recharts-tt-date">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="ph-recharts-tt-row">
          <span style={{ color: p.color }}>●</span>
          <span>{p.name}</span>
          <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{INR(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Price trend chart using Recharts ─────────────────────────────────────────
function PriceChart({ history, vendorColors }) {
  const chartData = useMemo(() => {
    if (!history.length) return [];
    const dateSet = new Set(history.map(r => r.price_date).filter(Boolean));
    const dates = [...dateSet].sort();
    const vendors = [...new Set(history.map(r => r.vendor_name || 'Unknown'))];
    return dates.map(date => {
      const row = { date: fmtShort(date) };
      vendors.forEach(vendor => {
        const entry = history.find(r => r.price_date === date && (r.vendor_name || 'Unknown') === vendor);
        if (entry) row[vendor] = parseFloat(entry.unit_price);
      });
      return row;
    });
  }, [history]);

  const vendors = [...new Set(history.map(r => r.vendor_name || 'Unknown'))];

  if (!chartData.length) {
    return (
      <div className="ph-empty" style={{ padding: '40px 0' }}>
        <BarChart2 size={40} color="#d1d5db" />
        <p>No data to chart</p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={{ stroke: '#e5e7eb' }}
        />
        <YAxis
          tick={{ fontSize: 10, fill: '#9ca3af' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : `₹${v}`}
          width={52}
        />
        <Tooltip content={<ChartTooltip />} />
        {vendors.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {vendors.map((vendor, vi) => (
          <Line
            key={vendor}
            type="monotone"
            dataKey={vendor}
            stroke={vendorColors[vendor] || VENDOR_COLORS[vi % VENDOR_COLORS.length]}
            strokeWidth={2.5}
            dot={{ r: 4, strokeWidth: 1.5, fill: '#fff' }}
            activeDot={{ r: 6 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PriceHistory() {
  const [history,    setHistory]    = useState([]);
  const [compare,    setCompare]    = useState([]);
  const [stats,      setStats]      = useState({});
  const [loading,    setLoading]    = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [itemSearch, setItemSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [vendorFilter, setVendorFilter] = useState('');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [showForm,   setShowForm]   = useState(false);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);
  const [toast,      setToast]      = useState(null);

  const searchRef  = useRef(null);
  const debounceRef = useRef(null);
  const isMounted  = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Debounced item search
  const handleItemSearch = val => {
    setItemSearch(val);
    setShowDropdown(true);
    clearTimeout(debounceRef.current);
    if (!val.trim()) { setSuggestions([]); setLoadingItems(false); return; }
    setLoadingItems(true);
    debounceRef.current = setTimeout(() => {
      api.get('/procurement/price-history/items', { params: { q: val } })
        .then(r => { if (isMounted.current) setSuggestions(Array.isArray(r.data) ? r.data : []); })
        .catch(() => { if (isMounted.current) setSuggestions([]); })
        .finally(() => { if (isMounted.current) setLoadingItems(false); });
    }, 250);
  };

  // Fetch price history when item or filters change
  const loadHistory = useCallback(() => {
    if (!selectedItem) return;
    setLoading(true);
    const params = { item_id: selectedItem.id };
    if (dateFrom) params.from = dateFrom;
    if (dateTo)   params.to   = dateTo;

    Promise.all([
      api.get('/procurement/price-history', { params }),
      api.get('/procurement/price-history/compare', { params: { item_id: selectedItem.id } }),
    ])
      .then(([hRes, cRes]) => {
        if (!isMounted.current) return;
        const h = hRes.data?.history || [];
        setHistory(h);
        setStats(hRes.data?.stats || {});
        setCompare(Array.isArray(cRes.data) ? cRes.data : []);
      })
      .catch(() => { if (isMounted.current) { setHistory([]); setCompare([]); setStats({}); } })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [selectedItem, dateFrom, dateTo]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSavePrice = async () => {
    if (!selectedItem) return showToast('Select an item first', 'error');
    if (!form.unit_price) return showToast('Unit price is required', 'error');
    setSaving(true);
    try {
      await api.post('/procurement/price-history', {
        item_id: selectedItem.id,
        item_name_text: selectedItem.item_name,
        ...form,
      });
      if (!isMounted.current) return;
      showToast('Price recorded successfully');
      setShowForm(false);
      setForm(EMPTY_FORM);
      loadHistory();
    } catch (e) {
      if (!isMounted.current) return;
      showToast(e.response?.data?.error || 'Failed to save', 'error');
    } finally { if (isMounted.current) setSaving(false); }
  };

  // Assign consistent colors to vendors
  const vendorColors = useMemo(() => {
    const vendors = [...new Set(history.map(r => r.vendor_name || 'Unknown'))];
    return Object.fromEntries(vendors.map((v, i) => [v, VENDOR_COLORS[i % VENDOR_COLORS.length]]));
  }, [history]);

  const allVendors = [...new Set(history.map(r => r.vendor_name).filter(Boolean))];

  const displayedHistory = vendorFilter
    ? history.filter(r => r.vendor_name === vendorFilter)
    : history;

  // Price delta vs previous entry
  const withDelta = displayedHistory.map((r, i) => {
    const prev = displayedHistory[i + 1];
    if (!prev) return { ...r, delta: null };
    const delta = parseFloat(r.unit_price) - parseFloat(prev.unit_price);
    return { ...r, delta };
  });

  const pctChange = stats.price_change_pct;
  const pctDir = pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : 'flat';

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="ph-root">
      {toast && <div className={`ph-toast ph-toast-${toast.type}`}>{toast.msg}</div>}

      {/* Header */}
      <div className="ph-header">
        <div className="ph-header-left">
          <div className="ph-header-icon"><TrendingUp size={20} /></div>
          <div>
            <h1 className="ph-title">Price History</h1>
            <p className="ph-sub">Track, compare and analyse purchase price trends by item and vendor</p>
          </div>
        </div>
        <div className="ph-header-right">
          <button className="ph-icon-btn" onClick={loadHistory} title="Refresh"><RefreshCw size={14} /></button>
          {selectedItem && (
            <button className="ph-btn-add" onClick={() => { setForm(EMPTY_FORM); setShowForm(true); }}>
              <Plus size={14} /> Add Price
            </button>
          )}
        </div>
      </div>

      <div className="ph-body">
        {/* Item selector + date filters */}
        <div className="ph-item-select-wrap">
          <span className="ph-item-select-label">Item</span>

          {selectedItem ? (
            <div className="ph-selected-item">
              <Tag size={13} />
              {selectedItem.item_name}
              {selectedItem.item_code && <span style={{ opacity: .6, fontWeight: 400 }}> ({selectedItem.item_code})</span>}
              <button className="ph-selected-clear" onClick={() => { setSelectedItem(null); setHistory([]); setCompare([]); setStats({}); setSuggestions([]); setItemSearch(''); }}><X size={13} /></button>
            </div>
          ) : (
            <div className="ph-item-search-wrap">
              <div className="ph-item-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  value={itemSearch}
                  onChange={e => handleItemSearch(e.target.value)}
                  onFocus={() => { setShowDropdown(true); if (itemSearch.trim()) handleItemSearch(itemSearch); }}
                  onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                  placeholder={loadingItems ? 'Searching…' : 'Search item name or code…'}
                />
                {itemSearch && <button onClick={() => { setItemSearch(''); setSuggestions([]); }}><X size={13} /></button>}
              </div>
              {showDropdown && suggestions.length > 0 && (
                <div className="ph-item-dropdown">
                  {suggestions.map(item => (
                    <div
                      key={item.id}
                      className="ph-item-opt"
                      onMouseDown={() => { setSelectedItem(item); setItemSearch(''); setSuggestions([]); setShowDropdown(false); }}
                    >
                      {item.item_name}
                      {item.item_code && <span className="ph-item-opt-code">{item.item_code}</span>}
                      {item.uom && <span className="ph-item-opt-code">· {item.uom}</span>}
                    </div>
                  ))}
                </div>
              )}
              {showDropdown && itemSearch.trim().length > 0 && !loadingItems && suggestions.length === 0 && (
                <div className="ph-item-dropdown">
                  <div className="ph-item-opt" style={{ color: '#9ca3af', cursor: 'default' }}>No items found</div>
                </div>
              )}
            </div>
          )}

          <div className="ph-date-filters">
            <label>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <label>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            {(dateFrom || dateTo) && (
              <button className="ph-icon-btn" style={{ width: 'auto', padding: '0 10px', fontSize: 11, color: '#6b7280', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 7, height: 30 }}
                onClick={() => { setDateFrom(''); setDateTo(''); }}>Clear dates</button>
            )}
          </div>
        </div>

        {/* KPIs */}
        {selectedItem && (
          <div className="ph-kpis">
            <div className="ph-kpi">
              <div className="ph-kpi-lbl">Current Price</div>
              <div className={`ph-kpi-val ${pctDir === 'up' ? 'red' : pctDir === 'down' ? 'green' : ''}`}>{INR(stats.current_price)}</div>
              {pctChange != null && (
                <div className={`ph-kpi-change ${pctDir}`}>
                  {pctDir === 'up' ? <ArrowUp size={10} /> : pctDir === 'down' ? <ArrowDown size={10} /> : <Minus size={10} />}
                  {Math.abs(pctChange)}% vs first
                </div>
              )}
            </div>
            <div className="ph-kpi">
              <div className="ph-kpi-lbl">Lowest Ever</div>
              <div className="ph-kpi-val green">{INR(stats.min_price)}</div>
              <div className="ph-kpi-sub">Best purchase price</div>
            </div>
            <div className="ph-kpi">
              <div className="ph-kpi-lbl">Highest Ever</div>
              <div className="ph-kpi-val red">{INR(stats.max_price)}</div>
              <div className="ph-kpi-sub">Peak price recorded</div>
            </div>
            <div className="ph-kpi">
              <div className="ph-kpi-lbl">Average Price</div>
              <div className="ph-kpi-val amber">{INR(stats.avg_price)}</div>
              <div className="ph-kpi-sub">Across all vendors</div>
            </div>
            <div className="ph-kpi">
              <div className="ph-kpi-lbl">Data Points</div>
              <div className="ph-kpi-val">{stats.data_points ?? 0}</div>
              <div className="ph-kpi-sub">{compare.length} vendor{compare.length !== 1 ? 's' : ''} quoted</div>
            </div>
          </div>
        )}

        {/* Chart + Vendor Comparison */}
        {selectedItem && (
          <div className="ph-cols">
            {/* Chart */}
            <div className="ph-card">
              <div className="ph-card-hd">
                <span className="ph-card-hd-title"><TrendingUp size={14} color="#10b981" /> Price Trend</span>
                <span className="ph-card-hd-sub">{selectedItem.item_name}</span>
              </div>
              {loading ? (
                <div className="ph-loading"><div className="ph-spinner" /></div>
              ) : history.length === 0 ? (
                <div className="ph-empty">
                  <TrendingUp size={36} color="#d1d5db" />
                  <p>No price history for this item yet</p>
                </div>
              ) : (
                <div className="ph-chart-wrap">
                  <PriceChart history={history} vendorColors={vendorColors} />
                </div>
              )}
            </div>

            {/* Vendor comparison */}
            <div className="ph-card">
              <div className="ph-card-hd">
                <span className="ph-card-hd-title"><BarChart2 size={14} color="#6366f1" /> Vendor Comparison</span>
              </div>
              {compare.length === 0 ? (
                <div className="ph-empty" style={{ padding: '30px 16px' }}>
                  <p>No vendor data</p>
                </div>
              ) : (
                <div className="ph-table-scroll">
                <table className="ph-vendor-table">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Last</th>
                      <th>Avg</th>
                      <th>Min</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compare.map((v, i) => (
                      <tr key={v.vendor_id || i}>
                        <td>
                          <div className="ph-v-name" style={{ color: VENDOR_COLORS[i % VENDOR_COLORS.length] }}>
                            {v.vendor_name}
                          </div>
                          {i === 0 && <span className="ph-best-badge">Best avg</span>}
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{v.quote_count} quote{v.quote_count !== 1 ? 's' : ''} · Last {fmtDate(v.last_quoted)}</div>
                        </td>
                        <td className="ph-v-price">{INR(v.last_price)}</td>
                        <td style={{ fontSize: 12, color: '#374151' }}>{INR(v.avg_price)}</td>
                        <td style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>{INR(v.min_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* History table */}
        {selectedItem && (
          <div className="ph-card">
            <div className="ph-card-hd">
              <span className="ph-card-hd-title">
                <ChevronDown size={14} color="#6b7280" /> Full Price History
                {displayedHistory.length > 0 && <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>({displayedHistory.length} records)</span>}
              </span>
              {allVendors.length > 1 && (
                <div className="ph-vendor-filter">
                  <select value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}>
                    <option value="">All vendors</option>
                    {allVendors.map((v, i) => <option key={i} value={v}>{v}</option>)}
                  </select>
                </div>
              )}
            </div>

            {loading ? (
              <div className="ph-loading"><div className="ph-spinner" /></div>
            ) : withDelta.length === 0 ? (
              <div className="ph-empty">
                <BarChart2 size={40} color="#d1d5db" />
                <p>No price records found</p>
                <small style={{ fontSize: 12, color: '#d1d5db' }}>Prices are recorded when purchase orders are created, or you can add manually.</small>
              </div>
            ) : (
              <div className="ph-table-scroll">
              <table className="ph-history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Unit Price</th>
                    <th>Qty</th>
                    <th>Vendor</th>
                    <th>Reference</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {withDelta.map((r, i) => {
                    const vColor = vendorColors[r.vendor_name] || '#6b7280';
                    return (
                      <tr key={i}>
                        <td style={{ color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(r.price_date)}</td>
                        <td>
                          <span className="ph-price-cell">{INR(r.unit_price)}</span>
                          {r.delta != null && r.delta !== 0 && (
                            <span className={`ph-price-delta ${r.delta > 0 ? 'up' : 'down'}`}>
                              {r.delta > 0 ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
                              {INR(Math.abs(r.delta))}
                            </span>
                          )}
                        </td>
                        <td style={{ color: '#6b7280', fontSize: 12 }}>{r.quantity ?? '—'}</td>
                        <td>
                          {r.vendor_name && (
                            <span style={{ color: vColor, fontWeight: 600, fontSize: 12 }}>{r.vendor_name}</span>
                          )}
                        </td>
                        <td>
                          {r.reference_number ? (
                            <span className={`ph-ref-badge ${r.source === 'purchase_order' ? 'po' : 'manual'}`}>
                              {r.source === 'purchase_order' ? 'PO' : r.reference_type || 'Manual'}: {r.reference_number}
                            </span>
                          ) : r.source === 'purchase_order' ? (
                            <span className="ph-ref-badge po">PO</span>
                          ) : (
                            <span className="ph-ref-badge manual">Manual</span>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: '#6b7280' }}>{r.notes || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}

        {/* No item selected state */}
        {!selectedItem && (
          <div className="ph-card">
            <div className="ph-empty" style={{ padding: '80px 24px' }}>
              <TrendingUp size={48} color="#d1d5db" />
              <p>Select an item above to view its price history</p>
              <small style={{ fontSize: 12, color: '#d1d5db' }}>Price data is automatically collected from purchase orders and can also be entered manually.</small>
            </div>
          </div>
        )}
      </div>

      {/* Add price modal */}
      {showForm && (
        <div className="ph-overlay" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div className="ph-modal">
            <div className="ph-modal-hd">
              <h2>Record Price — {selectedItem?.item_name}</h2>
              <button className="ph-modal-close" onClick={() => setShowForm(false)}><X size={14} /></button>
            </div>
            <div className="ph-modal-body">
              <div className="ph-row2">
                <div className="ph-field">
                  <label>Unit Price <span className="ph-req">*</span></label>
                  <input type="number" step="0.01" min="0" value={form.unit_price} onChange={e => setF('unit_price', e.target.value)} placeholder="0.00" />
                </div>
                <div className="ph-field">
                  <label>Quantity</label>
                  <input type="number" step="0.01" min="0" value={form.quantity} onChange={e => setF('quantity', e.target.value)} placeholder="e.g. 100" />
                </div>
              </div>
              <div className="ph-row2">
                <div className="ph-field">
                  <label>Vendor Name</label>
                  <input type="text" value={form.vendor_name_text} onChange={e => setF('vendor_name_text', e.target.value)} placeholder="Supplier / vendor" />
                </div>
                <div className="ph-field">
                  <label>Price Date</label>
                  <input type="date" value={form.price_date} onChange={e => setF('price_date', e.target.value)} />
                </div>
              </div>
              <div className="ph-row2">
                <div className="ph-field">
                  <label>Price Type</label>
                  <select value={form.price_type} onChange={e => setF('price_type', e.target.value)}>
                    <option value="purchase">Purchase</option>
                    <option value="quotation">Quotation</option>
                    <option value="selling">Selling</option>
                    <option value="market">Market Rate</option>
                  </select>
                </div>
                <div className="ph-field">
                  <label>Reference No.</label>
                  <input type="text" value={form.reference_number} onChange={e => setF('reference_number', e.target.value)} placeholder="PO / RFQ / Invoice no." />
                </div>
              </div>
              <div className="ph-field">
                <label>Notes</label>
                <input type="text" value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Any remarks…" />
              </div>
            </div>
            <div className="ph-modal-ft">
              <button className="ph-btn-cancel" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="ph-btn-save" onClick={handleSavePrice} disabled={saving || !form.unit_price}>
                <Save size={13} />
                {saving ? 'Saving…' : 'Save Price'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
