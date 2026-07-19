import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  Package, AlertTriangle, TrendingUp, ShoppingCart,
  RefreshCw, ArrowUpRight, Plus, ArrowRightLeft
} from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './InventoryDashboard.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};


const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6'];

const KPI = ({ icon: Icon, label, value, sub, color, alert }) => (
  <div className={`invd-kpi${alert ? ' invd-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="invd-kpi-icon"><Icon size={19} /></div>
    <div>
      <p className="invd-kpi-label">{label}</p>
      <h3 className="invd-kpi-val">{value}</h3>
      {sub && <p className="invd-kpi-sub">{sub}</p>}
    </div>
  </div>
);

export default function InventoryDashboard({ setPage }) {
  const [stats,   setStats]   = useState(null);
  const [summary, setSummary] = useState([]);
  const [lowStock,setLowStock]= useState([]);
  const [moves,   setMoves]   = useState([]);
  const [items,   setItems]   = useState([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [eoqData, setEoqData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiErrors, setApiErrors] = useState([]);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [dashRes, sumRes, lowRes, movRes, itemsRes] = await Promise.allSettled([
      api.get('/inventory/dashboard'),
      api.get('/inventory/stock/summary'),
      api.get('/inventory/stock/low-stock'),
      api.get('/inventory/stock/movement', { params: { limit: 8 } }),
      api.get('/inventory/items', { params: { limit: 200 } }),
    ]);

    if (!isMounted.current) return;

    const errors = [];
    if (dashRes.status === 'rejected') errors.push('Dashboard KPIs');
    if (sumRes.status === 'rejected')  errors.push('Stock Summary');
    if (lowRes.status === 'rejected')  errors.push('Low Stock Alerts');
    if (movRes.status === 'rejected')  errors.push('Recent Movements');
    setApiErrors(errors);

    const rawStats = dashRes.status === 'fulfilled' ? dashRes.value.data : null;
    setStats(rawStats || null);

    const rawSum = sumRes.status === 'fulfilled' ? (sumRes.value.data.summary || sumRes.value.data) : [];
    setSummary(Array.isArray(rawSum) ? rawSum : []);

    const rawLow = lowRes.status === 'fulfilled' ? (lowRes.value.data.items || lowRes.value.data) : [];
    setLowStock(Array.isArray(rawLow) ? rawLow : []);

    const rawMov = movRes.status === 'fulfilled' ? (movRes.value.data.movements || movRes.value.data) : [];
    setMoves(Array.isArray(rawMov) ? rawMov : []);
    const rawItems = itemsRes.status === 'fulfilled' ? (itemsRes.value.data.items || itemsRes.value.data) : [];
    const finalItems = Array.isArray(rawItems) ? rawItems : [];
    setItems(finalItems);
    setSelectedItemId(prev => prev || (finalItems.length > 0 ? String(finalItems[0].id) : ''));

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const fetchEoq = async () => {
      if (!selectedItemId) {
        setEoqData(null);
        return;
      }
      try {
        const res = await api.get('/procurement/analytics/eoq', { params: { item_id: selectedItemId } });
        if (isMounted.current) setEoqData(res.data || null);
      } catch {
        if (isMounted.current) setEoqData(null);
      }
    };
    fetchEoq();
  }, [selectedItemId]);


  const s = stats || {};
  const chartData = summary.map(r => ({
    name: r.category,
    qty: parseInt(r.total_quantity) || 0,
  }));
  const stockRows = summary.map((r) => {
    const qty = parseFloat(r.balance ?? r.total_quantity ?? 0);
    const rate = parseFloat(r.avg_rate ?? r.rate ?? 0);
    const value = parseFloat((r.value ?? (qty * rate)) || 0);
    return {
      code: r.item_code || r.category || 'ITEM',
      value: Number.isFinite(value) ? value : 0,
    };
  }).filter((r) => r.value > 0);
  const sortedByValue = [...stockRows].sort((a, b) => b.value - a.value);
  const totalStockValue = sortedByValue.reduce((s2, r) => s2 + r.value, 0);
  let running = 0;
  const abcRows = sortedByValue.map((r) => {
    running += r.value;
    const cumPct = totalStockValue > 0 ? (running / totalStockValue) * 100 : 0;
    const cls = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
    return { ...r, cls };
  });
  const abcStats = abcRows.reduce((acc, r) => {
    acc[r.cls].count += 1;
    acc[r.cls].value += r.value;
    return acc;
  }, {
    A: { count: 0, value: 0, color: '#ef4444' },
    B: { count: 0, value: 0, color: '#f59e0b' },
    C: { count: 0, value: 0, color: '#10b981' },
  });
  const abcChartData = ['A', 'B', 'C'].map((k) => ({
    cls: k,
    count: abcStats[k].count,
    value: abcStats[k].value,
    color: abcStats[k].color,
  }));

  const categoryChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip formatter={v => [v.toLocaleString('en-IN'), 'Qty']} />
        <Bar dataKey="qty" radius={[4, 4, 0, 0]} name="Qty">
          {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const abcChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={abcChartData} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="cls" />
        <YAxis allowDecimals={false} />
        <Tooltip formatter={(v, n) => [n === 'value' ? fmt(v) : v, n === 'value' ? 'Value' : 'Items']} />
        <Bar dataKey="count" name="count" radius={[4, 4, 0, 0]}>
          {abcChartData.map((entry) => <Cell key={entry.cls} fill={entry.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div className="invd-root">
      {/* header */}
      <div className="invd-header">
        <div>
          <h2 className="invd-title">Inventory Dashboard</h2>
          <p className="invd-sub">Stock levels, alerts &amp; movement overview</p>
        </div>
        <div className="invd-header-r">
          <button className="invd-btn-outline" onClick={() => setPage && setPage('ItemMaster')}>
            Item Master <ArrowUpRight size={13} />
          </button>
          <button className="invd-btn-primary" onClick={() => setPage && setPage('ItemMaster')}>
            <Plus size={14} /> Add Item
          </button>
          <button className="invd-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button
            onClick={() => setPage && setPage('InventorySettings')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', color: '#6b7280', fontSize: 13, fontWeight: 500 }}
            title="Inventory Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* API error banner */}
      {apiErrors.length > 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#991b1b', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={15} />
          <span>Failed to load: <strong>{apiErrors.join(', ')}</strong>. Data shown may be incomplete. <button onClick={load} style={{ background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer', textDecoration: 'underline', fontSize: 13, padding: 0 }}>Retry</button></span>
        </div>
      )}

      {/* KPIs */}
      <div className="invd-kpis">
        <KPI icon={Package}       label="Total Items"     value={s.total_items || 0}    color="#6366f1" sub="In master" />
        <KPI icon={AlertTriangle} label="Low Stock"       value={s.low_stock_count || 0} color="#ef4444" alert={(s.low_stock_count||0)>0} sub="Below reorder level" />
        <KPI icon={TrendingUp}    label="Inventory Value" value={fmt(s.total_value)}     color="#10b981" sub="Total valuation" />
        <KPI icon={TrendingUp}    label="Holding Cost / Month" value={fmt(s.total_holding_cost_monthly)} color="#6B3FDB" sub={`Annual rate ${(parseFloat(s.holding_cost_rate_annual || 0) * 100).toFixed(1)}%`} />
        <KPI icon={ShoppingCart}  label="Pending POs"     value={s.pending_pos || 0}     color="#f59e0b" sub="Awaiting receipt" />
      </div>

      {/* main grid */}
      <div className="invd-grid">

        {/* stock by category bar chart */}
        <div className="invd-card invd-fc7">
          <div className="invd-card-hd">
            <span className="invd-card-title">Stock Qty by Category</span>
            <ChartExpandButton title="Stock Qty by Category" subtitle="Quantity on hand per item category">
              {categoryChart(420)}
            </ChartExpandButton>
          </div>
          <div className="invd-card-body">
            {categoryChart(195)}
          </div>
        </div>

        {/* low stock alerts */}
        <div className="invd-card invd-fc5">
          <div className="invd-card-hd">
            <span className="invd-card-title" style={{ color: '#ef4444' }}>
              <AlertTriangle size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Low Stock Alerts
            </span>
            <button className="invd-text-btn" onClick={() => setPage && setPage('ItemMaster')}>
              View All <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="invd-card-body invd-scroll">
            {lowStock.map((item, i) => {
              const bal = parseFloat(item.balance ?? item.current_stock ?? 0);
              const rl  = parseFloat(item.reorder_level ?? 1) || 1;
              const pct = Math.min(100, Math.round((bal / rl) * 100));
              return (
                <div key={item.id || i} className="invd-low-row">
                  <div className="invd-low-info">
                    <span className="invd-low-name">{item.item_name || item.name}</span>
                    <span className="invd-low-sku">{item.item_code || item.sku} · {item.warehouse_name || item.category}</span>
                  </div>
                  <div className="invd-low-right">
                    <span className="invd-low-stock">
                      {bal.toLocaleString('en-IN')} / {rl.toLocaleString('en-IN')}
                    </span>
                    <div className="invd-bar-track">
                      <div className="invd-bar" style={{ width: `${pct}%`, background: pct < 30 ? '#ef4444' : '#f59e0b' }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* recent movements */}
        <div className="invd-card invd-fc12">
          <div className="invd-card-hd">
            <span className="invd-card-title">Recent Stock Movements</span>
            <button className="invd-text-btn" onClick={() => setPage && setPage('StockMovements')}>
              View All <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="invd-card-body" style={{ padding: 0, maxHeight: 265, overflowY: 'auto' }}>
            <table className="invd-table">
              <thead>
                <tr>
                  <th>Item</th><th>Type</th><th>Qty</th><th>Reference</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m, i) => (
                  <tr key={m.id || i}>
                    <td>{m.item_name}</td>
                    <td>
                      <span className="invd-badge" style={{
                        background: m.movement_type === 'IN' ? '#f0fdf4' : '#fef2f2',
                        color:      m.movement_type === 'IN' ? '#15803d' : '#dc2626',
                      }}>
                        {m.movement_type === 'IN' ? '▲ IN' : '▼ OUT'}
                      </span>
                    </td>
                    <td>{parseInt(m.quantity).toLocaleString('en-IN')}</td>
                    <td className="invd-mono">{m.reference || '—'}</td>
                    <td>{m.created_at ? new Date(m.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* EOQ planner */}
        <div className="invd-card invd-fc12">
          <div className="invd-card-hd">
            <span className="invd-card-title">EOQ Planner</span>
          </div>
          <div className="invd-card-body">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: '#374151' }}>Item</label>
              <select
                value={selectedItemId}
                onChange={(e) => setSelectedItemId(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, minWidth: 260 }}
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {(it.item_code || 'ITEM')} - {it.item_name}
                  </option>
                ))}
              </select>
            </div>
            {!eoqData && <p style={{ color: '#6b7280', margin: 0 }}>EOQ data not available for selected item.</p>}
            {eoqData && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                <div><strong>EOQ:</strong> {parseFloat(eoqData.eoq || 0).toFixed(2)}</div>
                <div><strong>Annual Demand:</strong> {parseFloat(eoqData.annual_demand || 0).toFixed(2)}</div>
                <div><strong>Reorder Point:</strong> {parseFloat(eoqData.reorder_point_calculated || 0).toFixed(2)}</div>
                <div><strong>Expected Delivery:</strong> {eoqData.expected_delivery_date || '—'}</div>
                <div><strong>Purchase Cost:</strong> {fmt(eoqData.annual_cost_breakup?.purchase_cost)}</div>
                <div><strong>Ordering Cost:</strong> {fmt(eoqData.annual_cost_breakup?.ordering_cost)}</div>
                <div><strong>Holding Cost:</strong> {fmt(eoqData.annual_cost_breakup?.holding_cost)}</div>
                <div><strong>Total Annual Cost:</strong> {fmt(eoqData.total_annual_inventory_cost)}</div>
              </div>
            )}
          </div>
        </div>

        {/* ABC analysis */}
        <div className="invd-card invd-fc12">
          <div className="invd-card-hd">
            <span className="invd-card-title">ABC Analysis (By Stock Value)</span>
            <ChartExpandButton title="ABC Analysis" subtitle="Item classes by stock value">
              {abcChart(420)}
            </ChartExpandButton>
          </div>
          <div className="invd-card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
              {abcChartData.map((r) => (
                <div key={r.cls} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Class {r.cls}</div>
                  <div style={{ fontWeight: 700, color: r.color }}>{r.count} items</div>
                  <div style={{ fontSize: 12 }}>{fmt(r.value)}</div>
                </div>
              ))}
            </div>
            {abcChart(180)}
          </div>
        </div>

      </div>

      {/* quick actions */}
      <div className="invd-actions">
        <span className="invd-actions-label">Quick Actions</span>
        <button className="invd-btn-primary" onClick={() => setPage && setPage('ItemMaster')}>
          <Plus size={14} /> Add Item
        </button>
        <button className="invd-btn-outline" onClick={() => setPage && setPage('PurchaseOrders')}>
          <ShoppingCart size={14} /> Create PO
        </button>
        <button className="invd-btn-outline" onClick={() => setPage && setPage('StockMovements')}>
          <ArrowRightLeft size={14} /> Stock Adjustment
        </button>
      </div>
    </div>
  );
}
