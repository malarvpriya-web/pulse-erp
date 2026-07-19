import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search, RefreshCw, Download, AlertTriangle, Package,
  TrendingDown, IndianRupee, Warehouse, X,
  ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react';
import api from '@/services/api/client';
import './StockSummary.css';

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt   = n => (isNaN(parseFloat(n)) ? '—' : parseFloat(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const fmtVal = n => {
  const v = parseFloat(n) || 0;
  if (v >= 1_00_00_000) return `₹${(v / 1_00_00_000).toFixed(2)} Cr`;
  if (v >= 1_00_000)    return `₹${(v / 1_00_000).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};
const pct = (a, b) => (b ? Math.min(100, Math.round((parseFloat(a) / parseFloat(b)) * 100)) : 0);

const TYPE_CFG = {
  raw_material:   { label: 'Raw Material',   color: '#6366f1', bg: '#eef2ff' },
  finished_goods: { label: 'Finished Goods', color: '#0891b2', bg: '#ecfeff' },
  consumable:     { label: 'Consumable',     color: '#d97706', bg: '#fffbeb' },
  spare:          { label: 'Spare',          color: '#6B3FDB', bg: '#faf5ff' },
};

const STOCK_STATUS = (bal, reorder) => {
  const b = parseFloat(bal) || 0;
  const r = parseFloat(reorder) || 0;
  if (b <= 0)       return { key: 'out',      label: 'Out of Stock', color: '#dc2626', bg: '#fef2f2' };
  if (b <= r)       return { key: 'low',      label: 'Low Stock',    color: '#d97706', bg: '#fffbeb' };
  if (b <= r * 1.5) return { key: 'warning',  label: 'Watch',        color: '#ca8a04', bg: '#fefce8' };
  return              { key: 'ok',       label: 'In Stock',     color: '#16a34a', bg: '#f0fdf4' };
};

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, color, bg, alert }) {
  return (
    <div className={`ss-kpi${alert ? ' ss-kpi-alert' : ''}`} style={{ '--kc': color, '--kb': bg }}>
      <div className="ss-kpi-icon"><Icon size={20} /></div>
      <div className="ss-kpi-body">
        <div className="ss-kpi-value">{value}</div>
        <div className="ss-kpi-label">{label}</div>
        {sub && <div className="ss-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ── Stock level bar ───────────────────────────────────────────────────────────
function StockBar({ balance, reorder }) {
  const status = STOCK_STATUS(balance, reorder);
  const p      = pct(balance, Math.max(parseFloat(balance), parseFloat(reorder) * 2) || 1);
  return (
    <div className="ss-bar-wrap" title={`${fmt(balance)} / reorder at ${fmt(reorder)}`}>
      <div className="ss-bar-track">
        <div className="ss-bar-fill" style={{ width: `${p}%`, background: status.color }} />
        {parseFloat(reorder) > 0 && (
          <div className="ss-bar-reorder" style={{ left: `50%` }} title={`Reorder: ${fmt(reorder)}`} />
        )}
      </div>
    </div>
  );
}

// ── Sort icon ─────────────────────────────────────────────────────────────────
function SortIcon({ field, sortBy, dir }) {
  if (sortBy !== field) return <ChevronsUpDown size={12} className="ss-sort-icon muted" />;
  return dir === 'asc'
    ? <ChevronUp size={12} className="ss-sort-icon active" />
    : <ChevronDown size={12} className="ss-sort-icon active" />;
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCsv(rows) {
  const cols = ['item_code','item_name','warehouse_name','balance','unit_of_measure','avg_rate','value','reorder_level','status'];
  const head = cols.join(',');
  const body = rows.map(r => {
    const val = (parseFloat(r.balance) * parseFloat(r.avg_rate)).toFixed(2);
    const st  = STOCK_STATUS(r.balance, r.reorder_level).label;
    return [r.item_code, `"${r.item_name}"`, `"${r.warehouse_name}"`, r.balance, r.unit_of_measure, r.avg_rate, val, r.reorder_level, st].join(',');
  }).join('\n');
  const blob = new Blob([head + '\n' + body], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `stock-summary-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function StockSummary() {
  const [stock,      setStock]      = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [tab,        setTab]        = useState('all');       // 'all' | 'low' | 'out'
  const [search,     setSearch]     = useState('');
  const [whFilter,   setWhFilter]   = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sortBy,     setSortBy]     = useState('item_name');
  const [sortDir,    setSortDir]    = useState('asc');
  const [page,       setPage]       = useState(1);
  const PAGE_SIZE = 20;
  const searchRef = useRef(null);

  // ── Fetch ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (whFilter)   params.warehouse_id = whFilter;
      if (typeFilter) params.item_type    = typeFilter;
      const [s, wh] = await Promise.allSettled([
        api.get('/inventory/stock/summary',  { params }),
        api.get('/inventory/warehouses'),
      ]);
      setStock(     s.status  === 'fulfilled' && Array.isArray(s.value.data)  ? s.value.data  : []);
      setWarehouses(wh.status === 'fulfilled' && Array.isArray(wh.value.data) ? wh.value.data : []);
    } finally {
      setLoading(false);
    }
  }, [whFilter, typeFilter]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const totalValue = useMemo(() =>
    stock.reduce((s, i) => s + (parseFloat(i.balance) || 0) * (parseFloat(i.avg_rate) || 0), 0),
  [stock]);

  const outCount  = useMemo(() => stock.filter(i => parseFloat(i.balance) <= 0).length, [stock]);
  const lowCount  = useMemo(() => stock.filter(i => {
    const b = parseFloat(i.balance) || 0, r = parseFloat(i.reorder_level) || 0;
    return b > 0 && b <= r;
  }).length, [stock]);

  // Type breakdown for mini chart
  const typeBreakdown = useMemo(() => {
    const map = {};
    stock.forEach(i => {
      const t = i.item_type || 'other';
      if (!map[t]) map[t] = { count: 0, value: 0 };
      map[t].count++;
      map[t].value += (parseFloat(i.balance) || 0) * (parseFloat(i.avg_rate) || 0);
    });
    return Object.entries(map).map(([k, v]) => ({ key: k, ...v, cfg: TYPE_CFG[k] }));
  }, [stock]);

  // Filtered + sorted rows
  const rows = useMemo(() => {
    let data = [...stock];

    // Tab filter
    if (tab === 'low') data = data.filter(i => {
      const b = parseFloat(i.balance) || 0, r = parseFloat(i.reorder_level) || 0;
      return b > 0 && b <= r;
    });
    if (tab === 'out') data = data.filter(i => (parseFloat(i.balance) || 0) <= 0);

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter(i =>
        i.item_name?.toLowerCase().includes(q) ||
        i.item_code?.toLowerCase().includes(q) ||
        i.warehouse_name?.toLowerCase().includes(q)
      );
    }

    // Sort
    data.sort((a, b) => {
      let va = a[sortBy], vb = b[sortBy];
      if (['balance','avg_rate','reorder_level'].includes(sortBy)) { va = parseFloat(va)||0; vb = parseFloat(vb)||0; }
      if (sortBy === 'value') { va = (parseFloat(a.balance)||0)*(parseFloat(a.avg_rate)||0); vb = (parseFloat(b.balance)||0)*(parseFloat(b.avg_rate)||0); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    return data;
  }, [stock, tab, search, sortBy, sortDir]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows   = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const sort = (field) => {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('asc'); }
    setPage(1);
  };

  const clearFilters = () => { setSearch(''); setWhFilter(''); setTypeFilter(''); setTab('all'); setPage(1); };
  const hasFilters   = search || whFilter || typeFilter || tab !== 'all';

  return (
    <div className="ss-root">

      {/* ── Header ── */}
      <div className="ss-header">
        <div className="ss-header-left">
          <div className="ss-header-icon"><Package size={22} /></div>
          <div>
            <h1 className="ss-title">Stock Summary</h1>
            <p className="ss-subtitle">
              {loading ? 'Loading…' : `${stock.length.toLocaleString()} items across ${warehouses.length} warehouses`}
            </p>
          </div>
        </div>
        <div className="ss-header-right">
          <button className="ss-btn ss-btn-ghost" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'ss-spin' : ''} /> Refresh
          </button>
          <button className="ss-btn ss-btn-ghost" onClick={() => exportCsv(rows)} disabled={!rows.length}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="ss-kpi-row">
        <KpiCard icon={Package}       label="Total SKUs"     value={stock.length.toLocaleString()}  sub={`${typeBreakdown.length} types`}                   color="#4B2DCE" bg="#F2EFFE" />
        <KpiCard icon={IndianRupee}    label="Total Value"    value={fmtVal(totalValue)}             sub="at avg. cost"                                       color="#0891b2" bg="#ecfeff" />
        <KpiCard icon={Warehouse}     label="Warehouses"     value={warehouses.length}              sub="active locations"                                   color="#16a34a" bg="#f0fdf4" />
        <KpiCard icon={TrendingDown}  label="Low Stock"      value={lowCount}                       sub={lowCount ? 'need reorder' : 'all levels healthy'}   color="#d97706" bg="#fffbeb" alert={lowCount > 0} />
        <KpiCard icon={AlertTriangle} label="Out of Stock"   value={outCount}                       sub={outCount ? 'immediate action' : 'none'}             color="#dc2626" bg="#fef2f2" alert={outCount > 0} />
      </div>

      {/* ── Type breakdown ── */}
      {typeBreakdown.length > 0 && (
        <div className="ss-breakdown">
          {typeBreakdown.map(t => {
            const cfg = t.cfg || { label: t.key, color: '#6b7280', bg: '#f3f4f6' };
            const valPct = totalValue > 0 ? Math.round((t.value / totalValue) * 100) : 0;
            return (
              <button
                key={t.key}
                className={`ss-type-chip${typeFilter === t.key ? ' ss-type-chip-active' : ''}`}
                style={{ '--tc': cfg.color, '--tb': cfg.bg }}
                onClick={() => { setTypeFilter(typeFilter === t.key ? '' : t.key); setPage(1); }}
              >
                <span className="ss-type-dot" />
                <span className="ss-type-label">{cfg.label}</span>
                <span className="ss-type-count">{t.count}</span>
                <span className="ss-type-pct">{valPct}% val</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="ss-toolbar">
        <div className="ss-toolbar-left">
          {/* Tabs */}
          <div className="ss-tabs">
            {[
              { key: 'all', label: 'All Stock',   count: stock.length },
              { key: 'low', label: 'Low Stock',   count: lowCount,  alert: true },
              { key: 'out', label: 'Out of Stock', count: outCount, alert: true },
            ].map(t => (
              <button
                key={t.key}
                className={`ss-tab${tab === t.key ? ' ss-tab-active' : ''}${t.alert && (t.count > 0) ? ' ss-tab-alert' : ''}`}
                onClick={() => { setTab(t.key); setPage(1); }}
              >
                {t.label}
                {t.count > 0 && <span className="ss-tab-badge">{t.count}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="ss-toolbar-right">
          {/* Search */}
          <div className="ss-search-wrap">
            <Search size={13} className="ss-search-icon" />
            <input
              ref={searchRef}
              className="ss-search"
              placeholder="Search item, code, warehouse…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
            {search && <button className="ss-search-clear" onClick={() => setSearch('')}><X size={12} /></button>}
          </div>

          {/* Warehouse filter */}
          <select className="ss-select" value={whFilter} onChange={e => { setWhFilter(e.target.value); setPage(1); }}>
            <option value="">All Warehouses</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name}</option>)}
          </select>

          {/* Clear filters */}
          {hasFilters && (
            <button className="ss-btn ss-btn-ghost ss-btn-sm" onClick={clearFilters}>
              <X size={12} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="ss-table-wrap">
        {loading ? (
          <div className="ss-loading">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="ss-skeleton-row">
                {[...Array(8)].map((_, j) => <div key={j} className="ss-skeleton-cell" style={{ width: `${[80,160,100,60,40,70,90,70][j]}px` }} />)}
              </div>
            ))}
          </div>
        ) : pageRows.length === 0 ? (
          <div className="ss-empty">
            <div className="ss-empty-icon">
              {tab === 'low' ? <TrendingDown size={44} /> : tab === 'out' ? <AlertTriangle size={44} /> : <Package size={44} />}
            </div>
            <div className="ss-empty-title">
              {tab === 'low' ? 'No low-stock items' : tab === 'out' ? 'No out-of-stock items' : 'No items found'}
            </div>
            <div className="ss-empty-sub">
              {hasFilters ? 'Try adjusting your filters' : tab !== 'all' ? 'Great — all stock levels are healthy!' : 'Add stock items to get started'}
            </div>
            {hasFilters && <button className="ss-btn ss-btn-primary ss-btn-sm" onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : (
          <table className="ss-table">
            <thead>
              <tr>
                {[
                  { key: 'item_code',   label: 'Code',      w: 90  },
                  { key: 'item_name',   label: 'Item Name', w: 220 },
                  { key: 'warehouse_name', label: 'Warehouse', w: 130 },
                  { key: 'item_type',   label: 'Type',      w: 120 },
                  { key: 'balance',     label: 'Balance',   w: 100, align: 'right' },
                  { key: 'avg_rate',    label: 'Avg Rate',  w: 90,  align: 'right' },
                  { key: 'value',       label: 'Value',     w: 110, align: 'right' },
                  { key: 'reorder_level', label: 'Reorder', w: 90,  align: 'right' },
                  { key: '_status',     label: 'Status',    w: 110, noSort: true    },
                  { key: '_level',      label: 'Level',     w: 110, noSort: true    },
                ].map(col => (
                  <th
                    key={col.key}
                    style={{ width: col.w, textAlign: col.align || 'left' }}
                    className={col.noSort ? '' : 'ss-th-sort'}
                    onClick={col.noSort ? undefined : () => sort(col.key)}
                  >
                    <span>{col.label}</span>
                    {!col.noSort && <SortIcon field={col.key} sortBy={sortBy} dir={sortDir} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((item, idx) => {
                const val    = (parseFloat(item.balance) || 0) * (parseFloat(item.avg_rate) || 0);
                const status = STOCK_STATUS(item.balance, item.reorder_level);
                const typCfg = TYPE_CFG[item.item_type] || { label: item.item_type || '—', color: '#6b7280', bg: '#f3f4f6' };
                return (
                  <tr key={item.id || idx} className={`ss-row ss-row-${status.key}`}>
                    <td className="ss-code">{item.item_code}</td>
                    <td className="ss-name">
                      <span className="ss-item-name">{item.item_name}</span>
                    </td>
                    <td className="ss-wh">
                      <span className="ss-wh-badge"><Warehouse size={10} />{item.warehouse_name}</span>
                    </td>
                    <td>
                      <span className="ss-type-pill" style={{ color: typCfg.color, background: typCfg.bg }}>
                        {typCfg.label}
                      </span>
                    </td>
                    <td className="ss-num">
                      <span className={status.key !== 'ok' ? 'ss-bal-alert' : ''}>{fmt(item.balance)}</span>
                      <span className="ss-uom"> {item.unit_of_measure}</span>
                    </td>
                    <td className="ss-num ss-muted">₹{fmt(item.avg_rate)}</td>
                    <td className="ss-num ss-val">₹{fmt(val)}</td>
                    <td className="ss-num ss-muted">{fmt(item.reorder_level)}</td>
                    <td>
                      <span className="ss-status-pill" style={{ color: status.color, background: status.bg }}>
                        {status.label}
                      </span>
                    </td>
                    <td><StockBar balance={item.balance} reorder={item.reorder_level} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {!loading && rows.length > PAGE_SIZE && (
        <div className="ss-pagination">
          <span className="ss-page-info">
            Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, rows.length)} of {rows.length.toLocaleString()} items
          </span>
          <div className="ss-page-btns">
            <button className="ss-page-btn" disabled={page === 1} onClick={() => setPage(1)}>«</button>
            <button className="ss-page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = Math.max(1, Math.min(page - 2 + i, totalPages - 4 + i));
              return (
                <button key={p} className={`ss-page-btn${page === p ? ' ss-page-btn-active' : ''}`} onClick={() => setPage(p)}>
                  {p}
                </button>
              );
            })}
            <button className="ss-page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <button className="ss-page-btn" disabled={page === totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        </div>
      )}
    </div>
  );
}
