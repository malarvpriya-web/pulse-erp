import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  GitCompare, Search, X, RefreshCw, Star, TrendingUp,
  TrendingDown, Package, ShoppingCart, Award, BarChart2,
  CheckCircle, AlertTriangle, Minus, ChevronDown, ChevronRight,
  ArrowUp, ArrowDown, Tag, SendHorizonal,
} from 'lucide-react';
import api from '@/services/api/client';
import './VendorComparison.css';

const VENDOR_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
];

const INR = n => n == null ? '—' : `₹${parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const pct = n => n == null ? '—' : `${parseFloat(n).toFixed(1)}%`;

function scoreLabel(s) {
  if (s >= 80) return { text: 'Excellent', color: '#15803d', border: '#86efac', bg: '#f0fdf4' };
  if (s >= 60) return { text: 'Good',      color: '#2563eb', border: '#93c5fd', bg: '#eff6ff' };
  if (s >= 40) return { text: 'Average',   color: '#d97706', border: '#fcd34d', bg: '#fffbeb' };
  return               { text: 'Poor',     color: '#dc2626', border: '#fca5a5', bg: '#fff1f2' };
}

function RatingBar({ label, value, max = 5, color }) {
  const pctVal = Math.min(100, (value / max) * 100);
  return (
    <div className="vc-rating-row">
      <span className="vc-rating-label">{label}</span>
      <div className="vc-rating-bar-wrap">
        <div className="vc-rating-bar" style={{ width: `${pctVal}%`, background: color }} />
      </div>
      <span className="vc-rating-val">{value > 0 ? value.toFixed(1) : '—'}</span>
    </div>
  );
}

// ── Scorecard panel for one vendor ──────────────────────────────────────────
function VendorCard({ vendor, color, isWinner }) {
  const score = vendor.composite_score ?? 0;
  const sl = scoreLabel(score);
  return (
    <div className={`vc-score-card${isWinner ? ' winner' : ''}`}>
      <div className="vc-sc-header">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div className="vc-sc-name">
              <span style={{ color }}>{vendor.vendor_name}</span>
              {isWinner && (
                <span className="vc-winner-badge"><Award size={9} /> Best Overall</span>
              )}
            </div>
            <div className="vc-sc-meta">
              {[vendor.city, vendor.state].filter(Boolean).join(', ') || 'Location not set'}
              {vendor.contact_person && ` · ${vendor.contact_person}`}
            </div>
          </div>
        </div>
        {vendor.category && <div className="vc-sc-category">{vendor.category}</div>}
      </div>

      <div className="vc-sc-score">
        <div className="vc-sc-score-ring" style={{ borderColor: sl.border, background: sl.bg }}>
          <span className="vc-sc-score-num" style={{ color: sl.color }}>{score}</span>
          <span className="vc-sc-score-lbl">/ 100</span>
        </div>
        <span className="vc-sc-score-text" style={{ color: sl.color }}>{sl.text}</span>
      </div>

      <div className="vc-sc-section">
        <div className="vc-sc-section-title">Ratings</div>
        <RatingBar label="Quality"  value={parseFloat(vendor.quality_rating  || 0)} color={color} />
        <RatingBar label="Delivery" value={parseFloat(vendor.delivery_rating || 0)} color={color} />
        <RatingBar label="Pricing"  value={parseFloat(vendor.price_rating    || 0)} color={color} />
      </div>

      <div className="vc-sc-section">
        <div className="vc-sc-section-title">Performance</div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">On-time %</span>
          <span className={`vc-stat-val ${parseFloat(vendor.on_time_pct || 0) >= 90 ? 'green' : parseFloat(vendor.on_time_pct || 0) >= 70 ? 'amber' : 'red'}`}>
            {pct(vendor.on_time_pct)}
          </span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Defect rate</span>
          <span className={`vc-stat-val ${parseFloat(vendor.defect_rate || 0) <= 1 ? 'green' : parseFloat(vendor.defect_rate || 0) <= 5 ? 'amber' : 'red'}`}>
            {pct(vendor.defect_rate)}
          </span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Total orders</span>
          <span className="vc-stat-val">{vendor.total_pos || 0}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Completed</span>
          <span className="vc-stat-val">{vendor.completed_pos || 0}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Last order</span>
          <span className="vc-stat-val" style={{ fontSize: 11 }}>{fmtDate(vendor.last_po_date)}</span>
        </div>
      </div>

      <div className="vc-sc-section">
        <div className="vc-sc-section-title">Pricing</div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Avg unit price</span>
          <span className="vc-stat-val">{INR(vendor.avg_unit_price)}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Lowest price</span>
          <span className="vc-stat-val green">{INR(vendor.min_unit_price)}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Total spend</span>
          <span className="vc-stat-val">{INR(vendor.total_spend)}</span>
        </div>
      </div>

      <div className="vc-sc-section">
        <div className="vc-sc-section-title">RFQ History</div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Quotes given</span>
          <span className="vc-stat-val">{vendor.total_quotes || 0}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Quotes won</span>
          <span className="vc-stat-val green">{vendor.won_quotes || 0}</span>
        </div>
        <div className="vc-stat-row">
          <span className="vc-stat-lbl">Win rate</span>
          <span className={`vc-stat-val ${parseFloat(vendor.win_rate || 0) >= 30 ? 'green' : 'amber'}`}>
            {pct(vendor.win_rate)}
          </span>
        </div>
        {vendor.avg_delivery_days != null && (
          <div className="vc-stat-row">
            <span className="vc-stat-lbl">Avg delivery</span>
            <span className="vc-stat-val">{vendor.avg_delivery_days} days</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Matrix comparison view ───────────────────────────────────────────────────
function MatrixView({ vendors, colors }) {
  if (vendors.length === 0) return null;

  const ROWS = [
    { group: 'Ratings (out of 5)' },
    { label: 'Quality Rating',   key: 'quality_rating',  fmt: v => v > 0 ? parseFloat(v).toFixed(1) : '—', best: 'max', bar: true, max: 5 },
    { label: 'Delivery Rating',  key: 'delivery_rating', fmt: v => v > 0 ? parseFloat(v).toFixed(1) : '—', best: 'max', bar: true, max: 5 },
    { label: 'Price Rating',     key: 'price_rating',    fmt: v => v > 0 ? parseFloat(v).toFixed(1) : '—', best: 'max', bar: true, max: 5 },
    { label: 'Composite Score',  key: 'composite_score', fmt: v => `${v}/100`,                              best: 'max', bar: true, max: 100 },
    { group: 'Performance' },
    { label: 'On-Time %',        key: 'on_time_pct',     fmt: pct,    best: 'max' },
    { label: 'Defect Rate',      key: 'defect_rate',     fmt: pct,    best: 'min' },
    { label: 'Total Orders',     key: 'total_pos',       fmt: v => v, best: 'max' },
    { label: 'Completed Orders', key: 'completed_pos',   fmt: v => v, best: 'max' },
    { group: 'Pricing' },
    { label: 'Avg Unit Price',   key: 'avg_unit_price',  fmt: INR,    best: 'min' },
    { label: 'Lowest Price',     key: 'min_unit_price',  fmt: INR,    best: 'min' },
    { label: 'Avg PO Value',     key: 'avg_po_value',    fmt: INR,    best: null },
    { label: 'Total Spend',      key: 'total_spend',     fmt: INR,    best: null },
    { group: 'RFQ History' },
    { label: 'Quotes Given',     key: 'total_quotes',    fmt: v => v, best: null },
    { label: 'Quotes Won',       key: 'won_quotes',      fmt: v => v, best: 'max' },
    { label: 'Win Rate',         key: 'win_rate',        fmt: pct,    best: 'max' },
    { label: 'Avg Delivery Days',key: 'avg_delivery_days',fmt: v => v != null ? `${v} days` : '—', best: 'min' },
  ];

  return (
    <div className="vc-matrix-wrap">
      <table className="vc-matrix">
        <thead>
          <tr>
            <th style={{ width: 180 }}>Metric</th>
            {vendors.map((v, i) => (
              <th key={v.id} className="vendor-col">
                <span style={{ color: colors[i] }}>{v.vendor_name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, ri) => {
            if (row.group) {
              return (
                <tr key={ri}>
                  <td colSpan={vendors.length + 1} className="row-group">{row.group}</td>
                </tr>
              );
            }

            const vals = vendors.map(v => {
              const raw = v[row.key];
              return raw != null ? parseFloat(raw) : null;
            });
            const validVals = vals.filter(v => v != null && v > 0);
            const bestVal = validVals.length > 0
              ? (row.best === 'max' ? Math.max(...validVals) : Math.min(...validVals))
              : null;

            return (
              <tr key={ri}>
                <td className="row-label">{row.label}</td>
                {vendors.map((v, i) => {
                  const raw = v[row.key];
                  const num = raw != null ? parseFloat(raw) : null;
                  const isBest  = bestVal != null && num === bestVal && validVals.length > 1;
                  const isWorst = row.best && bestVal != null && validVals.length > 1 && num != null && num !== bestVal &&
                    (row.best === 'max' ? num === Math.min(...validVals) : num === Math.max(...validVals));

                  return (
                    <td key={v.id} className="vendor-col">
                      {raw == null || raw === 0 && row.key !== 'composite_score' && row.key !== 'total_pos' && row.key !== 'won_quotes' && row.key !== 'total_quotes' ? (
                        <span className="vc-cell-na">—</span>
                      ) : row.bar ? (
                        <div className="vc-bar-cell">
                          <div className="vc-mini-bar-wrap">
                            <div className="vc-mini-bar" style={{
                              width: `${Math.min(100, (num / (row.max || 100)) * 100)}%`,
                              background: colors[i],
                            }} />
                          </div>
                          <span className={isBest ? 'vc-cell-best' : isWorst ? 'vc-cell-worst' : ''}>
                            {row.fmt(raw)}
                          </span>
                        </div>
                      ) : (
                        <span className={isBest ? 'vc-cell-best' : isWorst ? 'vc-cell-worst' : ''}>
                          {row.fmt(raw)}
                          {isBest && validVals.length > 1 && <span style={{ marginLeft: 4, fontSize: 10 }}>✓</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Items comparison view ────────────────────────────────────────────────────
function ItemsView({ itemRows, vendors, colors }) {
  const byItem = useMemo(() => {
    const map = {};
    itemRows.forEach(r => {
      const key = `${r.item_id}__${r.item_name}`;
      if (!map[key]) map[key] = { item_id: r.item_id, item_name: r.item_name, item_code: r.item_code, uom: r.uom, rows: [] };
      map[key].rows.push(r);
    });
    return Object.values(map);
  }, [itemRows]);

  if (byItem.length === 0) {
    return (
      <div className="vc-empty">
        <Package size={40} color="#d1d5db" />
        <p>No shared item pricing data found for these vendors</p>
        <small>Prices are pulled from purchase orders and price history records.</small>
      </div>
    );
  }

  const vendorColorMap = Object.fromEntries(vendors.map((v, i) => [v.id, colors[i]]));

  return (
    <div>
      {byItem.map(item => {
        const prices = item.rows.map(r => parseFloat(r.avg_price)).filter(Boolean);
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
        const savings = minPrice && maxPrice ? ((maxPrice - minPrice) / maxPrice * 100).toFixed(1) : null;

        return (
          <div key={item.item_id} className="vc-matrix-wrap vc-items-section" style={{ marginBottom: 12 }}>
            <div className="vc-items-section-title">
              <Package size={13} color="#6b7280" />
              {item.item_name}
              {item.item_code && <span style={{ color: '#9ca3af', fontWeight: 400 }}> ({item.item_code})</span>}
              {item.uom && <span style={{ color: '#9ca3af', fontWeight: 400 }}> · {item.uom}</span>}
              {savings && parseFloat(savings) > 0 && (
                <span className="vc-savings-badge" style={{ marginLeft: 'auto' }}>
                  Save up to {savings}% by choosing best vendor
                </span>
              )}
            </div>
            <table className="vc-items-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Avg Price</th>
                  <th>Last Price</th>
                  <th>Min Price</th>
                  <th>Max Price</th>
                  <th>Quotes</th>
                  <th>Last Date</th>
                </tr>
              </thead>
              <tbody>
                {item.rows.map((r, ri) => {
                  const isBest  = prices.length > 1 && parseFloat(r.avg_price) === minPrice;
                  const isWorst = prices.length > 1 && parseFloat(r.avg_price) === maxPrice;
                  const vColor  = vendorColorMap[r.vendor_id] || '#6b7280';
                  return (
                    <tr key={ri}>
                      <td>
                        <span className="vc-vendor-dot" style={{ background: vColor }} />
                        <span style={{ fontWeight: 600 }}>{r.vendor_name}</span>
                      </td>
                      <td className={isBest ? 'vc-price-best' : isWorst ? 'vc-price-worst' : ''}>
                        {INR(r.avg_price)}
                        {isBest && prices.length > 1 && <span style={{ marginLeft: 5, fontSize: 10 }}>✓ Best</span>}
                      </td>
                      <td style={{ fontWeight: 600 }}>{INR(r.last_price)}</td>
                      <td style={{ color: '#15803d' }}>{INR(r.min_price)}</td>
                      <td style={{ color: '#dc2626' }}>{INR(r.max_price)}</td>
                      <td style={{ color: '#6b7280' }}>{r.quote_count}</td>
                      <td style={{ color: '#6b7280', fontSize: 11 }}>{fmtDate(r.last_date)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ── Item-based vendor search section ─────────────────────────────────────────
function ItemVendorSearch({ onToast }) {
  const [query,        setQuery]        = useState('');
  const [suggestions,  setSuggestions]  = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showDrop,     setShowDrop]     = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [vendors,      setVendors]      = useState([]);
  const [loadingVend,  setLoadingVend]  = useState(false);
  const [creatingRfq,  setCreatingRfq]  = useState(null);
  const debounceRef = useRef(null);
  const isMounted   = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const handleQueryChange = val => {
    setQuery(val);
    setShowDrop(true);
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

  const selectItem = item => {
    setSelectedItem(item);
    setQuery('');
    setSuggestions([]);
    setShowDrop(false);
    setLoadingVend(true);
    api.get('/procurement/vendor-comparison', { params: { item_name: item.item_name } })
      .then(r => { if (isMounted.current) setVendors(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setVendors([]); })
      .finally(() => { if (isMounted.current) setLoadingVend(false); });
  };

  const clearItem = () => {
    setSelectedItem(null);
    setVendors([]);
    setQuery('');
  };

  const handleRequestQuote = async (vendor) => {
    if (!selectedItem) return;
    setCreatingRfq(vendor.vendor_id);
    try {
      await api.post('/procurement/rfqs', {
        item_description: selectedItem.item_name,
        quantity: 1,
        unit: selectedItem.uom || 'Nos',
        vendor_ids: vendor.vendor_id ? [vendor.vendor_id] : [],
      });
      onToast(`RFQ created for ${vendor.vendor_name}`, 'success');
    } catch (e) {
      onToast(e.response?.data?.error || 'Failed to create RFQ', 'error');
    } finally {
      if (isMounted.current) setCreatingRfq(null);
    }
  };

  const cheapestPrice = vendors.length > 0 ? Math.min(...vendors.map(v => v.last_price).filter(p => p != null)) : null;

  return (
    <div className="vc-item-search-panel">
      <div className="vc-item-search-hd">
        <Tag size={14} color="#6366f1" />
        <span className="vc-item-search-hd-title">Item-based Vendor Comparison</span>
        <span className="vc-item-search-hd-sub">Search an item to compare all vendors who quoted it</span>
      </div>

      <div className="vc-item-search-row">
        {selectedItem ? (
          <div className="vc-selected-item-chip">
            <Tag size={12} />
            {selectedItem.item_name}
            {selectedItem.item_code && <span style={{ opacity: .6, fontWeight: 400, fontSize: 11 }}> ({selectedItem.item_code})</span>}
            <button onClick={clearItem}><X size={12} /></button>
          </div>
        ) : (
          <div className="vc-item-search-wrap">
            <div className="vc-item-search-input">
              <Search size={14} />
              <input
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                onFocus={() => { setShowDrop(true); if (query.trim()) handleQueryChange(query); }}
                onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                placeholder={loadingItems ? 'Searching…' : 'Search item name or code…'}
              />
              {query && <button onClick={() => { setQuery(''); setSuggestions([]); }}><X size={13} /></button>}
            </div>
            {showDrop && suggestions.length > 0 && (
              <div className="vc-item-dropdown">
                {suggestions.map(item => (
                  <div key={item.id} className="vc-item-drop-opt" onMouseDown={() => selectItem(item)}>
                    <span>{item.item_name}</span>
                    <span className="vc-item-drop-code">{item.item_code}{item.uom ? ` · ${item.uom}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {showDrop && query.trim().length > 0 && !loadingItems && suggestions.length === 0 && (
              <div className="vc-item-dropdown">
                <div className="vc-item-drop-opt" style={{ color: '#9ca3af', cursor: 'default' }}>No items found</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      {selectedItem && (
        <div className="vc-iv-table-wrap">
          {loadingVend ? (
            <div className="vc-iv-no-data"><div className="vc-spinner" /></div>
          ) : vendors.length === 0 ? (
            <div className="vc-iv-no-data">
              <Package size={32} color="#d1d5db" />
              <p style={{ margin: 0, fontSize: 13, color: '#9ca3af' }}>No vendor price data found for this item</p>
            </div>
          ) : (
            <table className="vc-iv-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Last Price (₹)</th>
                  <th>Date</th>
                  <th>Rating</th>
                  <th>Payment Terms</th>
                  <th>Trend</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v, i) => {
                  const isCheapest = v.last_price != null && v.last_price === cheapestPrice && vendors.filter(x => x.last_price === cheapestPrice).length <= vendors.length;
                  const hasPrev = v.prev_price != null && v.last_price != null;
                  const trendUp = hasPrev && v.last_price > v.prev_price;
                  const trendDown = hasPrev && v.last_price < v.prev_price;
                  const ratingStars = v.rating != null ? Math.round(v.rating) : null;

                  return (
                    <tr key={v.vendor_id || i} className={isCheapest ? 'cheapest' : ''}>
                      <td>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>
                          {v.vendor_name}
                          {isCheapest && (
                            <span style={{ marginLeft: 6, fontSize: 10, background: '#dcfce7', color: '#15803d', padding: '1px 6px', borderRadius: 6, fontWeight: 700 }}>
                              Cheapest
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`vc-iv-price${isCheapest ? ' best' : ''}`}>{INR(v.last_price)}</span>
                      </td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{fmtDate(v.last_date)}</td>
                      <td>
                        {ratingStars != null ? (
                          <div className="vc-iv-rating">
                            <Star size={11} fill="#f59e0b" color="#f59e0b" />
                            <span>{v.rating.toFixed(1)}</span>
                          </div>
                        ) : <span style={{ color: '#d1d5db', fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>
                        {v.payment_terms || <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>
                      <td>
                        {!hasPrev ? (
                          <span className="vc-iv-trend-flat">—</span>
                        ) : trendDown ? (
                          <span className="vc-iv-trend-down">
                            <ArrowDown size={11} /> {INR(v.prev_price - v.last_price)} cheaper
                          </span>
                        ) : trendUp ? (
                          <span className="vc-iv-trend-up">
                            <ArrowUp size={11} /> {INR(v.last_price - v.prev_price)} costlier
                          </span>
                        ) : (
                          <span className="vc-iv-trend-flat"><Minus size={11} /> Unchanged</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="vc-iv-btn-rfq"
                          onClick={() => handleRequestQuote(v)}
                          disabled={creatingRfq === v.vendor_id}
                          title={`Request quote from ${v.vendor_name}`}
                        >
                          <SendHorizonal size={11} />
                          {creatingRfq === v.vendor_id ? 'Creating…' : 'Request Quote'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function VendorComparison() {
  const [allVendors,   setAllVendors]   = useState([]);
  const [selected,     setSelected]     = useState([]);
  const [compared,     setCompared]     = useState([]);
  const [itemRows,     setItemRows]     = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [loadingAll,   setLoadingAll]   = useState(false);
  const [activeTab,    setActiveTab]    = useState('scorecard');
  const [search,       setSearch]       = useState('');
  const [showDrop,     setShowDrop]     = useState(false);
  const [toast,        setToast]        = useState(null);
  const searchRef = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    setLoadingAll(true);
    api.get('/vendors')
      .then(r => { if (isMounted.current) setAllVendors(r.data?.vendors || r.data || []); })
      .catch(() => { if (isMounted.current) setAllVendors([]); })
      .finally(() => { if (isMounted.current) setLoadingAll(false); });
  }, []);

  const loadComparison = useCallback(() => {
    if (selected.length === 0) { setCompared([]); setItemRows([]); return; }
    setLoading(true);
    const ids = selected.join(',');
    Promise.all([
      api.get(`/vendors/compare?ids=${ids}`),
      api.get(`/vendors/compare/items?ids=${ids}`),
    ])
      .then(([cRes, iRes]) => {
        if (!isMounted.current) return;
        setCompared(Array.isArray(cRes.data) ? cRes.data : []);
        setItemRows(Array.isArray(iRes.data) ? iRes.data : []);
      })
      .catch(e => { if (isMounted.current) showToast(e.response?.data?.error || 'Failed to load comparison', 'error'); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [selected]);

  useEffect(() => { loadComparison(); }, [loadComparison]);

  const addVendor = id => {
    if (selected.includes(id)) return;
    if (selected.length >= 5) return showToast('Maximum 5 vendors can be compared at once', 'error');
    setSelected(s => [...s, id]);
    setSearch(''); setShowDrop(false);
  };
  const removeVendor = id => setSelected(s => s.filter(x => x !== id));

  const filteredAll = search
    ? allVendors.filter(v => (v.vendor_name || '').toLowerCase().includes(search.toLowerCase()) || (v.category || '').toLowerCase().includes(search.toLowerCase()))
    : allVendors;

  const winnerScore = Math.max(0, ...compared.map(v => v.composite_score || 0));
  const winnerId = winnerScore > 0 ? compared.find(v => v.composite_score === winnerScore)?.id : null;

  const selectedVendorObjects = selected.map(id => allVendors.find(v => v.id === id)).filter(Boolean);

  return (
    <div className="vc-root">
      {toast && <div className={`vc-toast vc-toast-${toast.type}`}>{toast.msg}</div>}

      {/* Header */}
      <div className="vc-header">
        <div className="vc-header-left">
          <div className="vc-header-icon"><GitCompare size={20} /></div>
          <div>
            <h1 className="vc-title">Vendor Comparison</h1>
            <p className="vc-sub">Side-by-side analysis of vendor performance, pricing and reliability</p>
          </div>
        </div>
        <div className="vc-header-right">
          <button className="vc-icon-btn" onClick={loadComparison} title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>

      <div className="vc-body">
        {/* Item-based vendor comparison */}
        <ItemVendorSearch onToast={showToast} />

        {/* Vendor picker */}
        <div className="vc-picker">
          <div className="vc-picker-top">
            <span className="vc-picker-label">Compare Vendors</span>
            <div className="vc-search-wrap">
              <div className="vc-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={e => { setSearch(e.target.value); setShowDrop(true); }}
                  onFocus={() => setShowDrop(true)}
                  placeholder={loadingAll ? 'Loading vendors…' : 'Search vendor name or category…'}
                  disabled={selected.length >= 5}
                />
                {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
              </div>
              {showDrop && filteredAll.length > 0 && !loadingAll && (
                <div className="vc-dropdown">
                  {filteredAll.slice(0, 30).map(v => (
                    <div
                      key={v.id}
                      className={`vc-drop-opt${selected.includes(v.id) ? ' selected' : ''}`}
                      onMouseDown={() => addVendor(v.id)}
                    >
                      <span>{v.vendor_name}</span>
                      <span className="vc-drop-meta">
                        {v.category || ''}{v.city ? ` · ${v.city}` : ''}
                        {selected.includes(v.id) ? ' · Added' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <span className="vc-search-hint">
              {selected.length === 0 ? 'Add 2–5 vendors to compare' : selected.length >= 5 ? 'Maximum reached' : `${selected.length} selected · Add ${5 - selected.length} more`}
            </span>
          </div>

          {selectedVendorObjects.length > 0 && (
            <div className="vc-chips">
              {selectedVendorObjects.map((v, i) => (
                <div key={v.id} className="vc-chip" style={{ background: VENDOR_COLORS[i % VENDOR_COLORS.length] }}>
                  {v.vendor_name}
                  <button className="vc-chip-remove" onClick={() => removeVendor(v.id)}><X size={10} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {selected.length === 0 && (
          <div className="vc-empty">
            <GitCompare size={48} color="#d1d5db" />
            <p>No vendors selected</p>
            <small>Search and add at least 2 vendors above to begin side-by-side comparison</small>
          </div>
        )}

        {selected.length > 0 && loading && (
          <div className="vc-loading"><div className="vc-spinner" /></div>
        )}

        {selected.length > 0 && !loading && compared.length > 0 && (
          <>
            <div className="vc-tabs">
              {[
                { key: 'scorecard', label: 'Scorecards',   icon: Star },
                { key: 'matrix',   label: 'Full Matrix',   icon: BarChart2 },
                { key: 'items',    label: 'Item Prices',   icon: Package },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  className={`vc-tab${activeTab === key ? ' active' : ''}`}
                  onClick={() => setActiveTab(key)}
                >
                  <Icon size={13} />{label}
                </button>
              ))}
            </div>

            {activeTab === 'scorecard' && (
              <div className="vc-scorecard-grid">
                {compared.map((v, i) => (
                  <VendorCard
                    key={v.id}
                    vendor={v}
                    color={VENDOR_COLORS[i % VENDOR_COLORS.length]}
                    isWinner={v.id === winnerId && compared.length > 1}
                  />
                ))}
              </div>
            )}

            {activeTab === 'matrix' && (
              <MatrixView vendors={compared} colors={VENDOR_COLORS} />
            )}

            {activeTab === 'items' && (
              <ItemsView itemRows={itemRows} vendors={compared} colors={VENDOR_COLORS} />
            )}
          </>
        )}

        {selected.length > 0 && !loading && compared.length === 0 && (
          <div className="vc-empty">
            <AlertTriangle size={40} color="#fcd34d" />
            <p>Could not load vendor data</p>
            <small>The selected vendors may not exist in the database yet.</small>
          </div>
        )}
      </div>
    </div>
  );
}
