// frontend/src/features/production/pages/WorkCentrePlanning.jsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '@/context/ToastContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import api from '@/services/api/client';

const CHART_COLORS = ['#6B3FDB', '#2563eb', '#d97706', '#16a34a', '#dc2626'];

function UtilizationBar({ pct }) {
  const color = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a';
  return (
    <div style={{ width: '100%' }}>
      <div style={{ height: 8, background: '#e9e4ff', borderRadius: 4, overflow: 'hidden', marginBottom: 3 }}>
        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 4, transition: 'width 0.5s' }} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color }}>{pct}%</div>
    </div>
  );
}

export default function WorkCentrePlanning() {
  const toast = useToast();
  const [workCentres, setWCs]       = useState([]);
  const [orders, setOrders]          = useState([]);
  const [scheduleData, setSchedule]  = useState([]);
  const [loading, setLoading]        = useState(false);
  const [schedLoading, setSchedLoad] = useState(false);
  const [checking, setChecking]      = useState(false);
  const [overloads, setOverloads]    = useState([]);
  const [startDate, setStart]        = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEnd]            = useState(new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
  const [showAddWC, setShowAddWC]    = useState(false);
  const [addForm, setAddForm]        = useState({ name: '', capacity_hours_per_day: 8, cost_per_hour: 0 });
  const [savingWC, setSavingWC]      = useState(false);

  const loadBase = useCallback(async () => {
    setLoading(true);
    try {
      const [wcRes, ordersRes] = await Promise.allSettled([
        api.get('/bom/work-centres'),
        api.get('/production/orders', { params: { status: 'planned,released,in_progress' } }),
      ]);
      if (wcRes.status === 'fulfilled') setWCs(wcRes.value.data || []);
      if (ordersRes.status === 'fulfilled') {
        const raw = Array.isArray(ordersRes.value.data) ? ordersRes.value.data : [];
        setOrders(raw.map(o => ({
          id:            o.id,
          order_ref:     o.production_order_no,
          product:       o.product_name,
          qty:           o.quantity_planned,
          work_centre:   o.work_centre_name || '—',
          planned_start: o.planned_start_date ? new Date(o.planned_start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—',
          planned_end:   o.planned_end_date   ? new Date(o.planned_end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })   : '—',
          hrs_required:  parseFloat(o.total_std_hrs || 0),
          status:        o.status,
        })));
      }
    } catch { setWCs([]); }
    finally { setLoading(false); }
  }, []);

  const fetchSchedule = useCallback(async (from, to) => {
    setSchedLoad(true);
    try {
      const res = await api.get('/production/work-centres/schedule', { params: { from_date: from, to_date: to } });
      const data = Array.isArray(res.data) ? res.data : [];
      setSchedule(data);
      return data;
    } catch { setSchedule([]); return []; }
    finally { setSchedLoad(false); }
  }, []);

  useEffect(() => {
    loadBase();
    fetchSchedule(startDate, endDate);
  }, [loadBase, fetchSchedule, startDate, endDate]);

  const checkCapacity = async () => {
    setChecking(true);
    try {
      const data = await fetchSchedule(startDate, endDate);
      const alerts = data.filter(r => r.planned_hours > r.capacity_hours);
      setOverloads(alerts);
      if (alerts.length === 0) toast.success('No capacity overloads in the selected date range.');
    } catch (e) {
      setOverloads([]);
      toast.error(e.response?.data?.error || 'Capacity check failed.');
    }
    setChecking(false);
  };

  const addWorkCentre = async () => {
    if (!addForm.name.trim()) return;
    setSavingWC(true);
    try {
      await api.post('/bom/work-centres', addForm);
      toast.success(`Work centre "${addForm.name}" added.`);
      setAddForm({ name: '', capacity_hours_per_day: 8, cost_per_hour: 0 });
      setShowAddWC(false);
      loadBase();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to add work centre.');
    }
    setSavingWC(false);
  };

  // Pivot: { date_label, "WC Name": utilization_pct, ... }
  const chartData = useMemo(() => {
    const byDate = {};
    scheduleData.forEach(row => {
      const label = new Date(row.date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
      if (!byDate[row.date]) byDate[row.date] = { date: label };
      byDate[row.date][row.work_centre_name] = row.utilization_pct;
    });
    return Object.values(byDate);
  }, [scheduleData]);

  const uniqueWCs = useMemo(() => {
    const seen = new Map();
    scheduleData.forEach(r => { if (!seen.has(r.work_centre_name)) seen.set(r.work_centre_name, true); });
    return [...seen.keys()].slice(0, 5);
  }, [scheduleData]);

  const setField = k => e => setAddForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 22 }}>🏭 Work Centre Planning</h2>
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Capacity utilisation and production load management</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>From</div>
            <input type="date" value={startDate} onChange={e => setStart(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>To</div>
            <input type="date" value={endDate} onChange={e => setEnd(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
          </div>
          <button onClick={checkCapacity} disabled={checking || schedLoading}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            {checking ? 'Checking…' : '▶ Check Capacity'}
          </button>
          <button onClick={() => setShowAddWC(v => !v)}
            style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Add Work Centre
          </button>
        </div>
      </div>

      {/* ── Add Work Centre inline form ── */}
      {showAddWC && (
        <div style={{ background: '#fff', border: '1px solid #a78bfa', borderRadius: 10, padding: '16px 18px', marginBottom: 18, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Name *</div>
            <input value={addForm.name} onChange={setField('name')} placeholder="e.g. Welding Station"
              style={{ padding: '7px 10px', border: '1px solid #a78bfa', borderRadius: 7, fontSize: 13, width: 200 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Capacity (hrs/day)</div>
            <input type="number" value={addForm.capacity_hours_per_day} onChange={setField('capacity_hours_per_day')} min={1} max={24}
              style={{ padding: '7px 10px', border: '1px solid #a78bfa', borderRadius: 7, fontSize: 13, width: 110 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Cost/hr (₹)</div>
            <input type="number" value={addForm.cost_per_hour} onChange={setField('cost_per_hour')} min={0}
              style={{ padding: '7px 10px', border: '1px solid #a78bfa', borderRadius: 7, fontSize: 13, width: 100 }} />
          </div>
          <button onClick={addWorkCentre} disabled={savingWC || !addForm.name.trim()}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            {savingWC ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setShowAddWC(false)}
            style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Cancel
          </button>
        </div>
      )}

      {/* ── Overload Alerts ── */}
      {overloads.length > 0 && (
        <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', marginBottom: 18 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 13, marginBottom: 6 }}>Capacity Overloads Detected</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#374151', lineHeight: 1.8 }}>
                {overloads.map((r, i) => (
                  <li key={i}>
                    <strong>{r.work_centre_name}</strong>:{' '}
                    {new Date(r.date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                    {' '}— {r.planned_hours}h planned, {r.capacity_hours}h capacity ({r.utilization_pct}%)
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Work Centre Cards ── */}
      {workCentres.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 14, marginBottom: 22 }}>
          {workCentres.map(wc => {
            const pct = wc.utilization_pct || 0;
            const statusColor = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#16a34a';
            const statusBg    = pct >= 90 ? '#fee2e2' : pct >= 70 ? '#fef3c7' : '#d1fae5';
            return (
              <div key={wc.id} style={{ background: '#fff', border: `1px solid ${pct >= 90 ? '#fecaca' : '#e9e4ff'}`, borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 14 }}>{wc.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{wc.department || 'Production'} · {wc.capacity_hours_per_day}h/day</div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: statusBg, color: statusColor }}>
                    {pct >= 90 ? '🔴 Overloaded' : pct >= 70 ? '🟡 Near Full' : '🟢 Available'}
                  </span>
                </div>
                <UtilizationBar pct={pct} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12 }}>
                  <span style={{ color: '#6b7280' }}>Load: <strong>{wc.total_load_hrs}h</strong></span>
                  <span style={{ color: '#6b7280' }}>Capacity: <strong>{wc.week_capacity_hrs}h/wk</strong></span>
                </div>
              </div>
            );
          })}
        </div>
      ) : !loading && (
        <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 24, marginBottom: 22, textAlign: 'center', color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🏭</div>
          <p style={{ margin: 0, fontSize: 13 }}>No work centres configured. Click <strong>+ Add Work Centre</strong> to get started.</p>
        </div>
      )}

      {/* ── Daily Utilization Chart ── */}
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 2px', color: '#4c1d95', fontSize: 15 }}>Daily Utilization — Work Centres</h3>
        <p style={{ margin: '0 0 16px', color: '#9ca3af', fontSize: 12 }}>
          Bars show utilization % per work centre per day. Dashed red line = 100% capacity.
        </p>
        {schedLoading ? (
          <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B3FDB', fontSize: 13 }}>
            Loading schedule…
          </div>
        ) : chartData.length === 0 ? (
          <div style={{ height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📊</div>
            <p style={{ margin: 0, fontSize: 13 }}>No scheduled orders in this range. Create production orders with planned start/end dates.</p>
          </div>
        ) : (
          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${v}%`} />
                <Tooltip formatter={(value, name) => [`${value}%`, name]} />
                <Legend />
                <ReferenceLine y={100} stroke="#dc2626" strokeDasharray="6 3"
                  label={{ value: 'Capacity', position: 'insideTopRight', fill: '#dc2626', fontSize: 10 }} />
                {uniqueWCs.map((name, i) => (
                  <Bar key={name} dataKey={name} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={40} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── Production Orders Table ── */}
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>Planned Production Orders</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{orders.length} orders</span>
        </div>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#6B3FDB', fontSize: 13 }}>Loading…</div>
        ) : orders.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No planned production orders found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Order Ref', 'Product', 'Qty', 'Work Centre', 'Start', 'End', 'Hrs Required', 'Status'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                    <td style={{ padding: '9px 12px', fontWeight: 600, color: '#6B3FDB' }}>{o.order_ref}</td>
                    <td style={{ padding: '9px 12px' }}>{o.product}</td>
                    <td style={{ padding: '9px 12px', fontWeight: 700 }}>{o.qty}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>{o.work_centre}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>{o.planned_start}</td>
                    <td style={{ padding: '9px 12px', color: '#6b7280' }}>{o.planned_end}</td>
                    <td style={{ padding: '9px 12px', fontWeight: 600 }}>
                      {o.hrs_required > 0 ? `${o.hrs_required.toFixed(1)}h` : '—'}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: o.status === 'in_progress' ? '#dbeafe' : o.status === 'released' ? '#d1fae5' : '#f5f3ff',
                        color:      o.status === 'in_progress' ? '#2563eb' : o.status === 'released' ? '#16a34a' : '#6B3FDB',
                      }}>
                        {o.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
