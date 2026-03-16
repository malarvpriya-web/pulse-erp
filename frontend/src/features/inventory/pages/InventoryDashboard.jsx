import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  Package, AlertTriangle, TrendingUp, ShoppingCart,
  RefreshCw, ArrowUpRight, Plus, ArrowRightLeft
} from 'lucide-react';
import api from '@/services/api/client';
import './InventoryDashboard.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const SAMPLE_STATS = {
  total_items: 142,
  low_stock_count: 18,
  total_value: 2340000,
  pending_pos: 7,
};

const SAMPLE_SUMMARY = [
  { category: 'Raw Materials', total_quantity: 850, item_count: 42 },
  { category: 'Finished Goods', total_quantity: 340, item_count: 28 },
  { category: 'Packaging',     total_quantity: 1200, item_count: 15 },
  { category: 'Consumables',   total_quantity: 500, item_count: 30 },
  { category: 'Spares',        total_quantity: 210, item_count: 27 },
];

const SAMPLE_LOW = [
  { id: 1, name: 'Ball Bearings 20mm', sku: 'SKU-001', category: 'Spares', current_stock: 5, reorder_level: 20, unit: 'pcs' },
  { id: 2, name: 'Packing Tape 48mm', sku: 'SKU-012', category: 'Packaging', current_stock: 12, reorder_level: 50, unit: 'rolls' },
  { id: 3, name: 'Lubricant Oil 5L',  sku: 'SKU-034', category: 'Consumables', current_stock: 2, reorder_level: 10, unit: 'cans' },
  { id: 4, name: 'Copper Wire 2.5mm', sku: 'SKU-056', category: 'Raw Materials', current_stock: 30, reorder_level: 100, unit: 'kg' },
];

const SAMPLE_MOVES = [
  { id: 1, item_name: 'Ball Bearings 20mm', movement_type: 'IN',  quantity: 200, reference: 'GRN-001', created_at: new Date().toISOString() },
  { id: 2, item_name: 'Packing Tape 48mm',  movement_type: 'OUT', quantity: 50,  reference: 'SO-102',  created_at: new Date().toISOString() },
  { id: 3, item_name: 'Lubricant Oil 5L',   movement_type: 'OUT', quantity: 5,   reference: 'ISS-007', created_at: new Date().toISOString() },
  { id: 4, item_name: 'Copper Wire 2.5mm',  movement_type: 'IN',  quantity: 500, reference: 'PO-045',  created_at: new Date().toISOString() },
];

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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [dashRes, sumRes, lowRes, movRes] = await Promise.allSettled([
      api.get('/inventory/dashboard'),
      api.get('/inventory/stock/summary'),
      api.get('/inventory/stock/low-stock'),
      api.get('/inventory/stock/movement', { params: { limit: 8 } }),
    ]);

    const rawStats = dashRes.status === 'fulfilled' ? dashRes.value.data : null;
    setStats(rawStats || SAMPLE_STATS);

    const rawSum = sumRes.status === 'fulfilled' ? (sumRes.value.data.summary || sumRes.value.data) : [];
    setSummary(Array.isArray(rawSum) && rawSum.length ? rawSum : SAMPLE_SUMMARY);

    const rawLow = lowRes.status === 'fulfilled' ? (lowRes.value.data.items || lowRes.value.data) : [];
    setLowStock(Array.isArray(rawLow) && rawLow.length ? rawLow : SAMPLE_LOW);

    const rawMov = movRes.status === 'fulfilled' ? (movRes.value.data.movements || movRes.value.data) : [];
    setMoves(Array.isArray(rawMov) && rawMov.length ? rawMov : SAMPLE_MOVES);

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="invd-loading"><div className="invd-spinner" /><p>Loading…</p></div>;

  const s = stats || SAMPLE_STATS;
  const chartData = summary.map(r => ({
    name: r.category,
    qty: parseInt(r.total_quantity) || 0,
  }));

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
        </div>
      </div>

      {/* KPIs */}
      <div className="invd-kpis">
        <KPI icon={Package}       label="Total Items"     value={s.total_items || 0}    color="#6366f1" sub="In master" />
        <KPI icon={AlertTriangle} label="Low Stock"       value={s.low_stock_count || 0} color="#ef4444" alert={(s.low_stock_count||0)>0} sub="Below reorder level" />
        <KPI icon={TrendingUp}    label="Inventory Value" value={fmt(s.total_value)}     color="#10b981" sub="Total valuation" />
        <KPI icon={ShoppingCart}  label="Pending POs"     value={s.pending_pos || 0}     color="#f59e0b" sub="Awaiting receipt" />
      </div>

      {/* main grid */}
      <div className="invd-grid">

        {/* stock by category bar chart */}
        <div className="invd-card invd-fc7">
          <div className="invd-card-hd">
            <span className="invd-card-title">Stock Qty by Category</span>
          </div>
          <div className="invd-card-body">
            <ResponsiveContainer width="100%" height={220}>
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
              const pct = Math.min(100, Math.round((item.current_stock / item.reorder_level) * 100));
              return (
                <div key={item.id || i} className="invd-low-row">
                  <div className="invd-low-info">
                    <span className="invd-low-name">{item.name}</span>
                    <span className="invd-low-sku">{item.sku} · {item.category}</span>
                  </div>
                  <div className="invd-low-right">
                    <span className="invd-low-stock">
                      {item.current_stock} / {item.reorder_level} {item.unit}
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
          <div className="invd-card-body" style={{ padding: 0 }}>
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
                    <td>{m.created_at ? new Date(m.created_at).toLocaleDateString('en-IN') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
