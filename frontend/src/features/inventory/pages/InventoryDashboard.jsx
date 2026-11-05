import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  Package, AlertTriangle, TrendingUp, ShoppingCart, RefreshCw,
  ArrowUpRight, Plus, ArrowRightLeft, LayoutDashboard,
  Target, PackageX, RotateCw, ShieldAlert, Layers, Clock,
} from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import { DashboardFilterBar, PageHero, PageShell } from '@/components/pulse-ui';
import './InventoryDashboard.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};


const COLORS = ['#6366f1', '#10b981', '#7c5cf0', '#3b82f6', '#8b5cf6'];

/**
 * A measured figure that has no value yet reads as an em-dash, never as 0.
 * "We consumed nothing" and "we cannot compute this" are different findings and
 * a 0 quietly claims the first one.
 */
const numOrDash = (v, suffix = '', dp = 0) =>
  v === null || v === undefined ? '—' : `${parseFloat(v).toFixed(dp)}${suffix}`;

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
  // The GOVERNED planning parameters — one row per item, straight from the
  // service that computes and persists them. This replaces two separate
  // client-side reinventions (see the EOQ panel and the ABC panel below).
  const [planningParams, setPlanningParams] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiErrors, setApiErrors] = useState([]);

  const [options, setOptions] = useState({ warehouses: [], categories: [] });

  // No period: every KPI here is a point-in-time balance (stock on hand, open
  // POs), so a date range would be meaningless — warehouse and category are the
  // dimensions that actually mean something for stock.
  const filters = useDashboardFilters({
    dimensions: { warehouse_id: 'all', category_id: 'all' },
    storageKey: 'inventory-dashboard',
  });
  const { params } = filters;

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get('/inventory/dashboard/filter-options')
      .then(r => { if (!cancelled) setOptions(o => ({ ...o, ...(r.data || {}) })); })
      .catch(() => { /* dropdowns fall back to "All" only */ });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [dashRes, sumRes, lowRes, movRes, itemsRes, kpiRes, paramRes] = await Promise.allSettled([
      api.get('/inventory/dashboard', { params }),
      api.get('/inventory/stock/summary'),
      api.get('/inventory/stock/low-stock'),
      api.get('/inventory/stock/movement', { params: { limit: 8 } }),
      api.get('/inventory/items', { params: { limit: 200 } }),
      api.get('/inventory/planning/kpis'),
      api.get('/inventory/planning/parameters'),
    ]);

    if (!isMounted.current) return;

    const errors = [];
    if (dashRes.status === 'rejected') errors.push('Dashboard KPIs');
    if (sumRes.status === 'rejected')  errors.push('Stock Summary');
    if (lowRes.status === 'rejected')  errors.push('Low Stock Alerts');
    if (movRes.status === 'rejected')  errors.push('Recent Movements');
    if (kpiRes.status === 'rejected')  errors.push('Cost vs Service KPIs');
    if (paramRes.status === 'rejected') errors.push('Planning Parameters');
    setApiErrors(errors);

    setKpis(kpiRes.status === 'fulfilled' ? kpiRes.value.data : null);
    const rawParams = paramRes.status === 'fulfilled' ? paramRes.value.data : [];
    setPlanningParams(Array.isArray(rawParams) ? rawParams : []);

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
  }, [params]);

  useEffect(() => { load(); }, [load]);

  const filterDimensions = [
    { key: 'warehouse_id', label: 'Warehouse', allLabel: 'All Warehouses', options: options.warehouses },
    { key: 'category_id',  label: 'Category',  allLabel: 'All Categories', options: options.categories },
  ];
  /*
   * /procurement/analytics/eoq answers from the GOVERNED parameters now — the
   * same persisted figures MRP, the reorder alerts and the purchase
   * requisitions act on — and stamps each reply with `source`. It used to
   * recompute inline from its own constants, including a flat 14-day lead time
   * in place of each item's real one and no safety stock at all, which is why
   * this card showed 30-52% of the governed reorder point on long-lead parts.
   *
   * It is still the right caller for this panel because it also returns the
   * annual cost break-up — purchase, ordering and holding — which is the cost
   * half of the trade-off this screen exists to show, and which the raw
   * parameter list does not carry.
   */
  const [eoqData, setEoqData] = useState(null);
  useEffect(() => {
    if (!selectedItemId) { setEoqData(null); return; }
    let cancelled = false;
    api.get('/procurement/analytics/eoq', { params: { item_id: selectedItemId } })
      .then((r) => { if (!cancelled && isMounted.current) setEoqData(r.data || null); })
      .catch(() => { if (!cancelled && isMounted.current) setEoqData(null); });
    return () => { cancelled = true; };
  }, [selectedItemId]);

  /* Whether a planner has overruled the model on this item. The EOQ endpoint
     reports the governed figures but not which of them is pinned, and an
     override that cannot be seen is an override nobody can review. */
  const eoqOverride = planningParams.find((p) => String(p.id) === String(selectedItemId)) || null;


  const s = stats || {};
  const chartData = summary.map(r => ({
    name: r.category,
    qty: parseInt(r.total_quantity) || 0,
  }));
  /*
   * ABC comes from the classification the planning service computed and
   * persisted. It used to be recomputed here in the browser, and it was wrong
   * in three separate ways at once:
   *
   *   1. WRONG BASIS. It ranked items by the value of stock ON HAND. ABC ranks
   *      by ANNUAL CONSUMPTION VALUE. A cheap part consumed constantly is an A;
   *      an expensive part sitting untouched in a corner is not. Ranking by
   *      what happens to be on the shelf inverts precisely that judgement.
   *   2. HARD-CODED BANDS of 80/95, against the governed thresholds — which are
   *      70/90 by default and settable per company. The screen and the engine
   *      could not agree even in principle.
   *   3. THE BOUNDARY TEST WAS INVERTED. It banded on the cumulative AFTER
   *      adding each item, so a single part holding 80% of all value came out B
   *      and a sole part holding 100% came out C — the most important item in
   *      the business, filed as the tail.
   *
   * Items the service deliberately left unclassified (too little demand history
   * to compute one honestly) are excluded rather than defaulted into C.
   */
  const abcStats = planningParams.reduce((acc, p) => {
    const cls = p.abc_class;
    if (!acc[cls]) return acc;
    acc[cls].count += 1;
    acc[cls].value += parseFloat(p.annual_consumption_value || 0);
    return acc;
  }, {
    A: { count: 0, value: 0, color: '#ef4444' },
    B: { count: 0, value: 0, color: '#7c5cf0' },
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
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Inventory"
        title="Inventory Dashboard"
        subtitle="Stock levels, alerts & movement overview"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={() => setPage && setPage('ItemMaster')}>
            Item Master <ArrowUpRight size={13} />
          </button>
          <button className="plh-cta plh-cta--ghost" onClick={() => setPage && setPage('ItemMaster')}>
            <Plus size={14} /> Add Item
          </button>
          <button className="plh-cta plh-cta--ghost" onClick={load}><RefreshCw size={14} /></button>
          <button className="plh-cta"
            onClick={() => setPage && setPage('InventorySettings')}
            
            title="Inventory Settings">
            ⚙ Settings
          </button>
        </>}
      />
    }>
      {/* header */}

      {/* Stock is a point-in-time balance — dimensions only, no date range. */}
      <DashboardFilterBar filters={filters} dimensions={filterDimensions} showPeriod={false} />

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
        <KPI icon={ShoppingCart}  label="Pending POs"     value={s.pending_pos || 0}     color="#7c5cf0" sub="Awaiting receipt" />
      </div>

      {/*
        Cost against service level — the trade-off the rest of this screen only
        shows one side of. Every figure is measured from the ledger over the
        company's planning window; none is a target dressed up as a result.
      */}
      {kpis && (
        <>
          <div className="invd-kpis" style={{ marginTop: 4 }}>
            {/*
              Two numbers, deliberately in one tile. The TARGET picks the z that
              sizes safety stock; the ACHIEVED figure is what the ledger actually
              did. Showing the target alone — which is what most inventory
              dashboards do — reports a policy as though it were an outcome.
            */}
            <KPI
              icon={Target}
              label="Service Level"
              value={numOrDash(kpis.service_level.achieved_in_stock_pct, '%', 1)}
              color="#10b981"
              alert={kpis.service_level.achieved_in_stock_pct !== null
                     && kpis.service_level.achieved_in_stock_pct < kpis.service_level.target_pct}
              sub={`Achieved vs ${numOrDash(kpis.service_level.target_pct, '%', 0)} target · in-stock days`}
            />
            <KPI
              icon={PackageX}
              label="Stockouts"
              value={kpis.stockouts.items_currently_out}
              color="#ef4444"
              alert={kpis.stockouts.items_currently_out > 0}
              sub={`${kpis.stockouts.stockout_events_in_window} event(s) in ${kpis.window.days}d`}
            />
            <KPI
              icon={RotateCw}
              label="Inventory Turnover"
              value={numOrDash(kpis.turnover.inventory_turnover, '×', 2)}
              color="#6366f1"
              sub={`${numOrDash(kpis.turnover.days_of_inventory, ' days')} of inventory`}
            />
            <KPI
              icon={ShieldAlert}
              label="Safety Stock Breaches"
              value={kpis.safety_stock_breaches.count}
              color="#f59e0b"
              alert={kpis.safety_stock_breaches.count > 0}
              sub="Below the level in force"
            />
            <KPI
              icon={Layers}
              label="Excess Stock"
              value={fmt(kpis.excess_inventory.total_excess_value)}
              color="#7c5cf0"
              sub={`${kpis.excess_inventory.count} item(s) over ${kpis.excess_inventory.threshold_cover_days}d cover`}
            />
            <KPI
              icon={Clock}
              label="Slow / Non-moving"
              value={fmt(kpis.obsolete_slow_moving.total_value)}
              color="#64748b"
              sub={`${kpis.obsolete_slow_moving.slow_moving_count} slow · ${kpis.obsolete_slow_moving.non_moving_count} non-moving`}
            />
          </div>
          {/*
            Said plainly rather than buried in a tooltip: this is availability,
            not a demand-weighted fill rate, and the database cannot produce the
            latter because no requested quantity is recorded anywhere. Leaving it
            unsaid would let an availability figure be quoted as a fill rate,
            which is the number a customer actually cares about.
          */}
          <p style={{ fontSize: 11.5, color: '#6b7280', margin: '2px 2px 14px' }}>
            Measured {kpis.window.start} → {kpis.window.end} at daily resolution.
            Service level is <strong>availability</strong> ({kpis.service_level.item_days_out_of_stock} of{' '}
            {kpis.service_level.item_days_carried} item-days out of stock across{' '}
            {kpis.service_level.items_carried} item(s) actually carried). A demand-weighted
            fill rate is not computable: issues record the quantity given, never the quantity asked for.
            {kpis.coverage.last_planning_run && (
              <> Parameters last recomputed{' '}
                {new Date(kpis.coverage.last_planning_run)
                  .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                {' '}({kpis.coverage.items_classified} of {kpis.coverage.items_total} items classified).
              </>
            )}
          </p>
        </>
      )}

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
                <div key={`${item.id ?? i}-${item.warehouse_id ?? item.warehouse_name ?? ''}`} className="invd-low-row">
                  <div className="invd-low-info">
                    <span className="invd-low-name">{item.item_name || item.name}</span>
                    <span className="invd-low-sku">{item.item_code || item.sku} · {item.warehouse_name || item.category}</span>
                  </div>
                  <div className="invd-low-right">
                    <span className="invd-low-stock">
                      {bal.toLocaleString('en-IN')} / {rl.toLocaleString('en-IN')}
                    </span>
                    <div className="invd-bar-track">
                      <div className="invd-bar" style={{ width: `${pct}%`, background: pct < 30 ? '#ef4444' : '#7c5cf0' }} />
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
            {/* The service leaves an item below min_periods_for_stats NULL on
                purpose — a zero EOQ computed from no data reads as a deliberate
                decision to order nothing. The screen has to say which it is. */}
            {eoqData && eoqData.source === 'insufficient_history' && (
              <p style={{ color: '#6b7280', margin: 0 }}>
                Not enough demand history to compute planning parameters for this item —
                left blank rather than shown as zero.
              </p>
            )}
            {eoqData && eoqData.source !== 'insufficient_history' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  <div><strong>EOQ:</strong> {numOrDash(eoqData.eoq, '', 2)}</div>
                  <div><strong>Annual Demand:</strong> {numOrDash(eoqData.annual_demand, '', 2)}</div>
                  <div><strong>Reorder Point:</strong> {numOrDash(eoqData.reorder_point_calculated, '', 2)}</div>
                  <div><strong>Safety Stock:</strong> {numOrDash(eoqData.safety_stock, '', 2)}</div>
                  <div><strong>Lead Time:</strong> {numOrDash(eoqData.lead_time_days, ' days')}</div>
                  <div><strong>Expected Delivery:</strong> {eoqData.expected_delivery_date || '—'}</div>
                  <div><strong>Purchase Cost:</strong> {fmt(eoqData.annual_cost_breakup?.purchase_cost)}</div>
                  <div><strong>Ordering Cost:</strong> {fmt(eoqData.annual_cost_breakup?.ordering_cost)}</div>
                  <div><strong>Holding Cost:</strong> {fmt(eoqData.annual_cost_breakup?.holding_cost)}</div>
                  <div><strong>Total Annual Cost:</strong> {fmt(eoqData.total_annual_inventory_cost)}</div>
                </div>
                {/* Where the figure came from, and whether a planner overruled the
                    model — an override nobody can see is an override nobody can
                    review. `source` distinguishes the governed answer from a
                    what-if run with caller-supplied costs. */}
                <p style={{ fontSize: 12, color: '#6b7280', marginTop: 10, marginBottom: 0 }}>
                  Source: <strong>{eoqData.source || 'governed'}</strong>
                  {eoqData.abc_class && ` · class ${eoqData.abc_class}`}
                  {eoqData.service_level_pct > 0
                    && ` · service level ${parseFloat(eoqData.service_level_pct).toFixed(0)}%`}
                  {eoqOverride?.safety_stock_source === 'manual'
                    && ` · safety stock pinned by a planner (model says ${parseFloat(eoqOverride.safety_stock_calculated || 0).toFixed(2)})`}
                  {eoqOverride?.reorder_point_source === 'manual'
                    && ` · reorder point pinned by a planner (model says ${parseFloat(eoqOverride.reorder_point_calculated || 0).toFixed(2)})`}
                  {eoqData.computed_at
                    && ` · computed ${new Date(eoqData.computed_at)
                          .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`}
                </p>
              </>
            )}
          </div>
        </div>

        {/* ABC analysis */}
        <div className="invd-card invd-fc12">
          <div className="invd-card-hd">
            <span className="invd-card-title">ABC Analysis (By Annual Consumption Value)</span>
            <ChartExpandButton title="ABC Analysis" subtitle="Item classes by annual consumption value">
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
    </PageShell>
  );
}
