import React, { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const COLORS = ['#6B3FDB', '#0891b2', '#059669', '#f59e0b', '#ef4444', '#8b5cf6'];
const AGING_COLORS = { '0-30': '#059669', '31-60': '#f59e0b', '61-90': '#f97316', '90+': '#ef4444' };

const cardStyle = {
  background: '#fff',
  border: '1px solid #f0f0f4',
  borderRadius: 12,
  padding: 14,
  marginBottom: 12,
};

const sectionTitle = { fontSize: 13.5, fontWeight: 700, color: '#111827', margin: '0 0 10px' };

const sectionHead = (title, chart, subtitle) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
    <h2 style={{ ...sectionTitle, margin: 0 }}>{title}</h2>
    {chart && <ChartExpandButton title={title} subtitle={subtitle}>{chart}</ChartExpandButton>}
  </div>
);

const thS = {
  padding: '9px 14px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12,
  color: '#6b7280',
  background: '#fafafa',
  borderBottom: '1px solid #f0f0f4',
};

const tdS = {
  padding: '9px 14px',
  fontSize: 13,
  color: '#111827',
  borderBottom: '1px solid #f8f8fc',
};

const AdvancedInventoryDashboard = ({ setPage }) => {
  const toast = useToast();
  const [data, setData]       = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abortRef = useRef(null);

  const fetchData = async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    try {
      setLoading(true);
      setError(null);
      const res = await api.get('/inventory/advanced-dashboard', {
        signal: abortRef.current.signal,
      });
      setData(res.data?.data ?? {});
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
      setError('Failed to load advanced dashboard');
      toast.error('Failed to load advanced dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 14 }}>Loading advanced dashboard…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <p style={{ color: '#ef4444', marginBottom: 12, fontSize: 14 }}>{error}</p>
        <button
          onClick={fetchData}
          style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #d1d5db', cursor: 'pointer', fontSize: 13 }}
        >
          Retry
        </button>
      </div>
    );
  }

  const valuation          = data.valuation          ?? {};
  const movementTrend      = data.movement_trend      ?? [];
  const turnover           = data.turnover            ?? {};
  const aging              = data.aging               ?? {};
  const topItems           = data.top_items           ?? {};
  const warehouseUtil      = data.warehouse_utilization ?? [];

  const agingBuckets = ['0-30', '31-60', '61-90', '90+'];
  const agingChartData = agingBuckets.map(b => ({
    bucket: b,
    count: aging[b]?.count ?? 0,
    value: aging[b]?.value ?? 0,
  }));

  const maxWhValue = Math.max(...warehouseUtil.map(w => w.total_value), 1);

  const byCategoryChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={valuation.by_category ?? []} layout="vertical" margin={{ left: 60, right: 20, top: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={fmtL} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="category" tick={{ fontSize: 11 }} width={60} />
        <Tooltip formatter={(v) => fmtL(v)} />
        <Bar dataKey="value" fill="#6B3FDB" radius={[0, 4, 4, 0]} name="Value" />
      </BarChart>
    </ResponsiveContainer>
  );

  const byWarehouseChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={valuation.by_warehouse ?? []} layout="vertical" margin={{ left: 60, right: 20, top: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={fmtL} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="warehouse" tick={{ fontSize: 11 }} width={60} />
        <Tooltip formatter={(v) => fmtL(v)} />
        <Bar dataKey="value" fill="#0891b2" radius={[0, 4, 4, 0]} name="Value" />
      </BarChart>
    </ResponsiveContainer>
  );

  const trendChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <LineChart data={movementTrend} margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend iconSize={12} />
        <Line type="monotone" dataKey="receipts_qty" name="Receipts"  stroke="#059669" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="issues_qty"   name="Issues"    stroke="#ef4444" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="net_change"   name="Net Change" stroke="#6B3FDB" strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
      </LineChart>
    </ResponsiveContainer>
  );

  const agingChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={agingChartData}
          dataKey="count"
          nameKey="bucket"
          cx="50%" cy="50%"
          outerRadius={r}
          label={({ bucket, count }) => count > 0 ? `${bucket}: ${count}` : ''}
          labelLine={false}
        >
          {agingChartData.map((entry) => (
            <Cell key={entry.bucket} fill={AGING_COLORS[entry.bucket]} />
          ))}
        </Pie>
        <Tooltip formatter={(v, name) => [v, name === 'count' ? 'Items' : name]} />
      </PieChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px', background: '#f5f3ff', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Advanced Inventory Dashboard</h1>
          <p style={{ color: '#6b7280', margin: '3px 0 0', fontSize: 12.5 }}>Valuation, trends, turnover, aging & utilisation</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPage?.('BatchTracking')}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', color: '#6B3FDB', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
            Batch Tracking
          </button>
          <button onClick={() => setPage?.('StockReservations')}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', color: '#6B3FDB', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
            Reservations
          </button>
          <button onClick={() => setPage?.('StockAlertsAndSuggestions')}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', color: '#6B3FDB', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
            Stock Alerts
          </button>
          <button onClick={fetchData}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#6B3FDB', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
            Refresh
          </button>
        </div>
      </div>

      {/* ── STOCK VALUATION ─────────────────────────────── */}
      <div className="dk-anim" style={{ ...cardStyle, '--dk-i': 0 }}>
        <h2 style={sectionTitle}>Stock Valuation</h2>
        <div style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: '#6b7280' }}>Total inventory value</span>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#6B3FDB', marginTop: 2 }}>
            {fmtL(valuation.total_value)}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>By Category</span>
              <ChartExpandButton title="Stock Value by Category">{byCategoryChart(420)}</ChartExpandButton>
            </div>
            {byCategoryChart(175)}
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>By Warehouse</span>
              <ChartExpandButton title="Stock Value by Warehouse">{byWarehouseChart(420)}</ChartExpandButton>
            </div>
            {byWarehouseChart(175)}
          </div>
        </div>
      </div>

      {/* ── MOVEMENT TREND ──────────────────────────────── */}
      <div className="dk-anim" style={{ ...cardStyle, '--dk-i': 1 }}>
        {sectionHead('Movement Trend — Last 12 Months', trendChart(420), 'Receipts vs issues, monthly')}
        {trendChart(200)}
      </div>

      {/* ── INVENTORY TURNOVER ──────────────────────────── */}
      <div className="dk-anim" style={{ ...cardStyle, '--dk-i': 2 }}>
        <h2 style={sectionTitle}>Inventory Turnover</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 18, alignItems: 'start' }}>
          <div style={{ textAlign: 'center', padding: '10px 20px', background: '#f5f3ff', borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Overall Rate</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: '#6B3FDB' }}>
              {(turnover.overall_rate ?? 0).toFixed(2)}×
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>annualised</div>
          </div>
          <div style={{ maxHeight: 190, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6 }}>By Category</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thS}>Category</th>
                  <th style={{ ...thS, textAlign: 'right' }}>Turnover Rate</th>
                </tr>
              </thead>
              <tbody>
                {(turnover.by_category ?? []).map((row, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={tdS}>{row.category}</td>
                    <td style={{ ...tdS, textAlign: 'right', fontWeight: 600, color: '#6B3FDB' }}>
                      {(row.rate ?? 0).toFixed(2)}×
                    </td>
                  </tr>
                ))}
                {(turnover.by_category ?? []).length === 0 && (
                  <tr><td colSpan={2} style={{ ...tdS, color: '#9ca3af', textAlign: 'center' }}>No data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── STOCK AGING ─────────────────────────────────── */}
      <div className="dk-anim" style={{ ...cardStyle, '--dk-i': 3 }}>
        {sectionHead('Stock Aging (days since last movement)', agingChart(420, 150))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'center' }}>
          {agingChart(185, 70)}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {agingBuckets.map(b => {
              const bkt = aging[b] ?? { count: 0, value: 0 };
              return (
                <div key={b} style={{ padding: 11, background: `${AGING_COLORS[b]}15`, borderRadius: 10, borderLeft: `4px solid ${AGING_COLORS[b]}` }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: AGING_COLORS[b] }}>{b} days</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginTop: 2 }}>{bkt.count}</div>
                  <div style={{ fontSize: 11.5, color: '#6b7280' }}>items</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginTop: 3 }}>{fmtL(bkt.value)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── TOP ITEMS ───────────────────────────────────── */}
      <div className="dk-anim" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12, '--dk-i': 4 }}>

        {/* By value */}
        <div style={cardStyle}>
          <h2 style={sectionTitle}>Top 5 by Stock Value</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thS}>Item</th>
                <th style={{ ...thS, textAlign: 'right' }}>Stock</th>
                <th style={{ ...thS, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {(topItems.by_value ?? []).map((item, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={tdS}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{item.item_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{item.item_code}</div>
                  </td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{parseFloat(item.current_stock).toLocaleString('en-IN')}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 600, color: '#6B3FDB' }}>{fmtL(item.stock_value)}</td>
                </tr>
              ))}
              {(topItems.by_value ?? []).length === 0 && (
                <tr><td colSpan={3} style={{ ...tdS, color: '#9ca3af', textAlign: 'center' }}>No items</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* By movement */}
        <div style={cardStyle}>
          <h2 style={sectionTitle}>Top 5 by Movement (last 30 days)</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thS}>Item</th>
                <th style={{ ...thS, textAlign: 'right' }}>Txns</th>
                <th style={{ ...thS, textAlign: 'right' }}>Total Qty</th>
              </tr>
            </thead>
            <tbody>
              {(topItems.by_movement ?? []).map((item, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={tdS}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{item.item_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{item.item_code}</div>
                  </td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 600 }}>{item.movement_count}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{parseFloat(item.total_movement_qty).toLocaleString('en-IN')}</td>
                </tr>
              ))}
              {(topItems.by_movement ?? []).length === 0 && (
                <tr><td colSpan={3} style={{ ...tdS, color: '#9ca3af', textAlign: 'center' }}>No movement in last 30 days</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dead stock */}
      {(topItems.dead_stock ?? []).length > 0 && (
        <div className="dk-anim" style={{ ...cardStyle, borderLeft: '4px solid #ef4444', '--dk-i': 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 style={{ ...sectionTitle, margin: 0, color: '#dc2626' }}>Dead Stock (no movement in 90+ days)</h2>
            <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>
              {(topItems.dead_stock ?? []).length} items · {fmtL((topItems.dead_stock ?? []).reduce((s, r) => s + parseFloat(r.current_stock) * parseFloat(r.unit_cost), 0))} at risk
            </span>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thS, position: 'sticky', top: 0, zIndex: 1 }}>Item</th>
                <th style={{ ...thS, textAlign: 'right', position: 'sticky', top: 0, zIndex: 1 }}>Stock Qty</th>
                <th style={{ ...thS, textAlign: 'right', position: 'sticky', top: 0, zIndex: 1 }}>Unit Cost</th>
                <th style={{ ...thS, textAlign: 'right', position: 'sticky', top: 0, zIndex: 1 }}>Stock Value</th>
                <th style={{ ...thS, position: 'sticky', top: 0, zIndex: 1 }}>Last Movement</th>
              </tr>
            </thead>
            <tbody>
              {(topItems.dead_stock ?? []).map((item, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fff5f5' }}>
                  <td style={tdS}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{item.item_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{item.item_code}</div>
                  </td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{parseFloat(item.current_stock).toLocaleString('en-IN')}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{fmtL(item.unit_cost)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>
                    {fmtL(parseFloat(item.current_stock) * parseFloat(item.unit_cost))}
                  </td>
                  <td style={{ ...tdS, color: '#9ca3af' }}>
                    {item.last_movement_date
                      ? new Date(item.last_movement_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                      : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ── WAREHOUSE UTILISATION ───────────────────────── */}
      <div className="dk-anim" style={{ ...cardStyle, '--dk-i': 6 }}>
        <h2 style={sectionTitle}>Warehouse Utilisation</h2>
        {warehouseUtil.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', margin: '12px 0' }}>No warehouse data</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))', gap: 10 }}>
            {warehouseUtil.map((wh, i) => {
              const pct = maxWhValue > 0 ? (wh.total_value / maxWhValue) * 100 : 0;
              return (
                <div key={i} style={{ background: '#f9f8ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: '#111827', marginBottom: 5 }}>
                    {wh.warehouse_name || 'Unknown'}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#6b7280', marginBottom: 3 }}>{wh.item_count} items</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#6B3FDB', marginBottom: 7 }}>
                    {fmtL(wh.total_value)}
                  </div>
                  <div style={{ height: 6, background: '#e9e4ff', borderRadius: 4 }}>
                    <div style={{ width: `${pct.toFixed(0)}%`, height: '100%', background: COLORS[i % COLORS.length], borderRadius: 4 }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                    {pct.toFixed(0)}% of highest-value warehouse
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
};

export default AdvancedInventoryDashboard;
