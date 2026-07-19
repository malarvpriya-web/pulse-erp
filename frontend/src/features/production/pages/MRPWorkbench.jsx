// frontend/src/features/production/pages/MRPWorkbench.jsx
//
// MRP II material-planning workbench. Drives the /mrp backend:
//   run regenerative MRP → review planned orders + exceptions → convert to
//   PRs / production orders. Plus MPS, forecast, and item-planning maintenance.
import { useState, useEffect, useCallback, Fragment } from 'react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #ede9fe', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff', whiteSpace: 'nowrap' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };
const btnS = { background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 };
const chip = (bg, fg) => ({ background: bg, color: fg, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, display: 'inline-block' });
const SEV = { critical: chip('#fee2e2', '#dc2626'), warning: chip('#fef3c7', '#d97706'), info: chip('#dbeafe', '#2563eb') };

function KPI({ label, value, tint = PURPLE }) {
  return (
    <div style={{ ...card, flex: '1 1 130px', minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: tint, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: MUT, marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function MRPWorkbench() {
  const toast = useToast();
  const [tab, setTab] = useState('planned');
  const [horizon, setHorizon] = useState(90);
  const [bucketDays, setBucketDays] = useState(7);
  const [inc, setInc] = useState({ so: true, mps: true, fc: true });
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(null);
  const [planned, setPlanned] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [timePhased, setTimePhased] = useState([]);
  const [runs, setRuns] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [atpItem, setAtpItem] = useState('');
  const [atp, setAtp] = useState(null);
  const [atpBusy, setAtpBusy] = useState(false);
  const [ctpForm, setCtpForm] = useState({ item_id: '', quantity: '', need_date: '' });
  const [ctp, setCtp] = useState(null);
  const [ctpBusy, setCtpBusy] = useState(false);

  const [mps, setMps] = useState([]);
  const [forecasts, setForecasts] = useState([]);
  const [items, setItems] = useState([]);
  const [mpsForm, setMpsForm] = useState({ product_id: '', product_name: '', due_date: '', quantity: '' });
  const [fcForm, setFcForm] = useState({ item_id: '', forecast_date: '', quantity: '' });

  const loadRuns = useCallback(async () => {
    try { setRuns((await api.get('/mrp/runs')).data || []); } catch { /* */ }
  }, []);
  const loadRunDetail = useCallback(async (id) => {
    try {
      const { data } = await api.get(`/mrp/runs/${id}`);
      setRun(data.run); setPlanned(data.planned_orders || []); setExceptions(data.exceptions || []); setTimePhased(data.time_phased || []);
    } catch (e) { toast.error('Failed to load run'); }
  }, [toast]);

  const loadItems = useCallback(async () => {
    try { setItems((await api.get('/mrp/item-planning')).data || []); } catch { /* */ }
  }, []);
  const loadDemand = useCallback(async () => {
    try {
      const [m, f] = await Promise.allSettled([api.get('/mrp/mps'), api.get('/mrp/forecasts')]);
      if (m.status === 'fulfilled') setMps(m.value.data || []);
      if (f.status === 'fulfilled') setForecasts(f.value.data || []);
    } catch { /* */ }
  }, []);

  useEffect(() => { loadRuns(); loadItems(); loadDemand(); }, [loadRuns, loadItems, loadDemand]);

  const runMRP = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/mrp/run', {
        horizon_days: Number(horizon), bucket_days: Number(bucketDays), include_sales_orders: inc.so, include_mps: inc.mps, include_forecast: inc.fc,
      });
      setRun(data.run); setPlanned(data.planned_orders || []); setExceptions(data.exceptions || []); setTimePhased(data.time_phased || []);
      setTab('planned'); loadRuns();
      const s = data.summary;
      toast.success(`MRP done — ${s.planned_orders} planned (${s.make} make / ${s.buy} buy), ${s.exceptions} exceptions${s.unmatched ? `, ${s.unmatched} unmatched` : ''}`);
    } catch (e) { toast.error(e.response?.data?.error || 'MRP run failed'); }
    finally { setRunning(false); }
  };

  const convert = async (id) => {
    setBusyId(id);
    try {
      const { data } = await api.post(`/mrp/planned-orders/${id}/convert`);
      toast.success(`Created ${data.created.type.replace('_', ' ')} ${data.created.ref}`);
      setPlanned(p => p.map(o => o.id === id ? data.planned_order : o));
    } catch (e) { toast.error(e.response?.data?.error || 'Convert failed'); }
    finally { setBusyId(null); }
  };
  const ignore = async (id) => {
    setBusyId(id);
    try {
      const { data } = await api.post(`/mrp/planned-orders/${id}/ignore`);
      setPlanned(p => p.map(o => o.id === id ? data : o));
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusyId(null); }
  };
  const convertAll = async (order_type) => {
    if (!run) return;
    if (!window.confirm(`Convert all planned ${order_type || ''} orders in this run?`)) return;
    try {
      const { data } = await api.post('/mrp/planned-orders/convert-all', { run_id: run.id, order_type });
      toast.success(`Converted ${data.converted}/${data.total}${data.failed ? `, ${data.failed} failed` : ''}`);
      loadRunDetail(run.id);
    } catch (e) { toast.error(e.response?.data?.error || 'Bulk convert failed'); }
  };

  const addMps = async () => {
    if (!mpsForm.product_name || !mpsForm.due_date || !mpsForm.quantity) return toast.error('Product, date & qty required');
    try {
      await api.post('/mrp/mps', { ...mpsForm, product_id: mpsForm.product_id || null, quantity: Number(mpsForm.quantity) });
      setMpsForm({ product_id: '', product_name: '', due_date: '', quantity: '' }); loadDemand(); toast.success('MPS entry added');
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const delMps = async (id) => { try { await api.delete(`/mrp/mps/${id}`); loadDemand(); } catch { toast.error('Delete failed'); } };
  const addFc = async () => {
    if (!fcForm.item_id || !fcForm.forecast_date || !fcForm.quantity) return toast.error('Item, date & qty required');
    try {
      await api.post('/mrp/forecasts', { ...fcForm, quantity: Number(fcForm.quantity) });
      setFcForm({ item_id: '', forecast_date: '', quantity: '' }); loadDemand(); toast.success('Forecast added');
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const delFc = async (id) => { try { await api.delete(`/mrp/forecasts/${id}`); loadDemand(); } catch { toast.error('Delete failed'); } };

  const runATP = async () => {
    if (!atpItem) return toast.error('Select an item');
    setAtpBusy(true);
    try { setAtp((await api.get('/mrp/atp', { params: { item_id: atpItem, horizon_days: horizon, bucket_days: bucketDays } })).data); }
    catch (e) { toast.error(e.response?.data?.error || 'ATP failed'); }
    finally { setAtpBusy(false); }
  };

  const runCTP = async () => {
    if (!ctpForm.item_id || !ctpForm.quantity) return toast.error('Item and quantity required');
    setCtpBusy(true);
    try { setCtp((await api.get('/mrp/ctp', { params: { item_id: ctpForm.item_id, quantity: ctpForm.quantity, need_date: ctpForm.need_date || undefined, bucket_days: bucketDays } })).data); }
    catch (e) { toast.error(e.response?.data?.error || 'CTP failed'); }
    finally { setCtpBusy(false); }
  };

  const saveItem = async (it, patch) => {
    try {
      const { data } = await api.put(`/mrp/item-planning/${it.id}`, patch);
      setItems(list => list.map(x => x.id === it.id ? { ...x, ...data } : x));
      toast.success(`${it.item_name} updated`);
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const orderChip = (t) => t === 'make' ? chip('#ede9fe', PURPLE) : chip('#e0f2fe', '#0369a1');
  const statusChip = (s) => ({
    planned: chip('#f3f4f6', INK), converted: chip('#dcfce7', '#16a34a'),
    firmed: chip('#fef3c7', '#d97706'), ignored: chip('#f3f4f6', '#9ca3af'),
  }[s] || chip('#f3f4f6', INK));

  const Tab = ({ id, label, n }) => (
    <button onClick={() => setTab(id)} style={{
      background: tab === id ? PURPLE : 'transparent', color: tab === id ? '#fff' : INK,
      border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13,
    }}>{label}{n != null ? ` (${n})` : ''}</button>
  );

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      {/* Header + run controls */}
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>🧮 MRP Workbench</h2>
          <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Regenerative material requirements planning — demand → net requirements → planned orders</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: MUT }}>Horizon (days)
            <input type="number" min={1} max={730} value={horizon} onChange={e => setHorizon(e.target.value)}
              style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 90 }} />
          </label>
          <label style={{ fontSize: 12, color: MUT }}>Bucket
            <select value={bucketDays} onChange={e => setBucketDays(e.target.value)} style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
              <option value={1}>Daily</option><option value={7}>Weekly</option><option value={14}>Fortnightly</option><option value={30}>Monthly</option>
            </select>
          </label>
          {[['so', 'Sales Orders'], ['mps', 'MPS'], ['fc', 'Forecast']].map(([k, lbl]) => (
            <label key={k} style={{ fontSize: 12, color: INK, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={inc[k]} onChange={e => setInc(s => ({ ...s, [k]: e.target.checked }))} />{lbl}
            </label>
          ))}
          <button onClick={runMRP} disabled={running} style={{ ...btnP, opacity: running ? 0.6 : 1 }}>
            {running ? 'Running…' : '▶ Run MRP'}
          </button>
        </div>
      </div>

      {/* KPI row */}
      {run && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <KPI label="Planned Orders" value={run.planned_order_count} />
          <KPI label="Make" value={run.planned_make_count} tint="#7c3aed" />
          <KPI label="Buy" value={run.planned_buy_count} tint="#0369a1" />
          <KPI label="Exceptions" value={run.exception_count} tint={run.exception_count ? '#dc2626' : '#16a34a'} />
          <KPI label="Est. Buy Value" value={`₹${Number(run.total_purchase_value || 0).toLocaleString('en-IN')}`} tint="#16a34a" />
          <div style={{ ...card, flex: '1 1 160px', minWidth: 140 }}>
            <div style={{ fontSize: 12, color: MUT }}>Run</div>
            <div style={{ fontWeight: 700, color: HEAD, fontSize: 13 }}>{run.run_no}</div>
            <select value={run.id} onChange={e => loadRunDetail(e.target.value)}
              style={{ marginTop: 6, width: '100%', padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12 }}>
              {runs.map(r => <option key={r.id} value={r.id}>{r.run_no} · {fmtDate(r.created_at)}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Tab id="planned" label="Planned Orders" n={planned.length || null} />
        <Tab id="timephased" label="Time-Phased" />
        <Tab id="atp" label="ATP Check" />
        <Tab id="ctp" label="CTP Check" />
        <Tab id="exceptions" label="Exceptions" n={exceptions.length || null} />
        <Tab id="demand" label="Demand (MPS + Forecast)" />
        <Tab id="items" label="Item Planning" />
      </div>

      {/* PLANNED ORDERS */}
      {tab === 'planned' && (
        <div style={card}>
          {planned.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, justifyContent: 'flex-end' }}>
              <button style={btnS} onClick={() => convertAll('buy')}>Convert all Buy → PRs</button>
              <button style={btnS} onClick={() => convertAll('make')}>Convert all Make → Orders</button>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {['LLC', 'Type', 'Item', 'Qty', 'UoM', 'Gross', 'On-hand', 'Sched', 'Net', 'Need', 'Start', 'Pegging', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {planned.map(p => (
                  <tr key={p.id}>
                    <td style={td}>{p.low_level_code}</td>
                    <td style={td}><span style={orderChip(p.order_type)}>{p.order_type}</span></td>
                    <td style={{ ...td, fontWeight: 600, whiteSpace: 'normal' }}>{p.item_name}<div style={{ fontSize: 11, color: MUT }}>{p.item_code}</div></td>
                    <td style={{ ...td, fontWeight: 700 }}>{Number(p.quantity)}</td>
                    <td style={td}>{p.uom || '—'}</td>
                    <td style={td}>{Number(p.gross_requirement)}</td>
                    <td style={td}>{Number(p.on_hand)}</td>
                    <td style={td}>{Number(p.scheduled_receipts)}</td>
                    <td style={{ ...td, fontWeight: 700, color: '#dc2626' }}>{Number(p.net_requirement)}</td>
                    <td style={td}>{fmtDate(p.need_date)}</td>
                    <td style={td}>{fmtDate(p.start_date)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', maxWidth: 200 }}>
                      {(p.pegging || []).slice(0, 3).map((x, i) => <span key={i} style={{ ...chip('#f5f3ff', PURPLE), marginRight: 3, marginBottom: 2 }}>{x.source}:{x.qty}</span>)}
                    </td>
                    <td style={td}><span style={statusChip(p.status)}>{p.status}</span></td>
                    <td style={td}>
                      {p.status === 'planned' && (
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button disabled={busyId === p.id} style={btnS} onClick={() => convert(p.id)}>{busyId === p.id ? '…' : 'Convert'}</button>
                          <button disabled={busyId === p.id} style={{ ...btnS, background: '#f3f4f6', color: MUT }} onClick={() => ignore(p.id)}>Ignore</button>
                        </div>
                      )}
                      {p.status === 'converted' && <span style={{ fontSize: 11, color: '#16a34a' }}>{p.converted_ref}</span>}
                    </td>
                  </tr>
                ))}
                {planned.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={14}>No planned orders. Run MRP to generate.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* EXCEPTIONS */}
      {tab === 'exceptions' && (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Severity', 'Type', 'Item', 'Need Date', 'Message'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {exceptions.map(e => (
                <tr key={e.id}>
                  <td style={td}><span style={SEV[e.severity] || SEV.info}>{e.severity}</span></td>
                  <td style={td}>{e.exception_type}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{e.item_name}</td>
                  <td style={td}>{e.need_date ? fmtDate(e.need_date) : '—'}</td>
                  <td style={{ ...td, whiteSpace: 'normal' }}>{e.message}</td>
                </tr>
              ))}
              {exceptions.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={5}>No exceptions.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* TIME-PHASED GRID */}
      {tab === 'timephased' && (() => {
        const byItem = {};
        timePhased.forEach(r => { (byItem[r.item_id] = byItem[r.item_id] || { name: r.item_name, llc: r.low_level_code, cells: {} }).cells[r.bucket_index] = r; });
        const bmax = timePhased.reduce((m, r) => Math.max(m, r.bucket_index), 0);
        const bIdx = Array.from({ length: bmax + 1 }, (_, i) => i);
        const rows = Object.entries(byItem).sort((a, b) => a[1].llc - b[1].llc);
        const METRICS = [['gross_requirements', 'Gross Req', INK], ['scheduled_receipts', 'Sched Rcpt', '#0369a1'], ['planned_receipts', 'Planned', PURPLE], ['projected_available', 'Proj Avail', '#16a34a']];
        return (
          <div style={card}>
            {rows.length === 0 ? <div style={{ color: MUT, fontSize: 13 }}>No time-phased data. Run MRP.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, position: 'sticky', left: 0, background: '#fff' }}>Item / Metric</th>
                    {bIdx.map(i => <th key={i} style={{ ...th, textAlign: 'right' }}>Bkt {i}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map(([id, it]) => (
                      <Fragment key={id}>
                        <tr><td style={{ ...td, fontWeight: 700, color: HEAD, background: '#faf8ff', position: 'sticky', left: 0 }} colSpan={bIdx.length + 1}>LLC{it.llc} · {it.name}</td></tr>
                        {METRICS.map(([k, lbl, col]) => (
                          <tr key={k}>
                            <td style={{ ...td, color: col, fontWeight: 600, position: 'sticky', left: 0, background: '#fff', paddingLeft: 20 }}>{lbl}</td>
                            {bIdx.map(i => { const c = it.cells[i]; const v = c ? Number(c[k]) : 0;
                              return <td key={i} style={{ ...td, textAlign: 'right', color: k === 'planned_receipts' && v > 0 ? PURPLE : (k === 'projected_available' && v < 0 ? '#dc2626' : INK), fontWeight: k === 'planned_receipts' && v > 0 ? 700 : 400 }}>{v || (c ? '0' : '·')}</td>; })}
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ATP CHECK */}
      {tab === 'atp' && (
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: MUT }}>Item
              <select value={atpItem} onChange={e => setAtpItem(e.target.value)} style={{ display: 'block', marginTop: 3, padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 220 }}>
                <option value="">Select item…</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
              </select></label>
            <button style={{ ...btnP, opacity: atpBusy ? 0.6 : 1 }} disabled={atpBusy} onClick={runATP}>{atpBusy ? 'Checking…' : 'Check ATP'}</button>
            {atp && <div style={{ marginLeft: 'auto', fontSize: 13 }}>Total ATP: <b style={{ color: atp.total_atp > 0 ? '#16a34a' : '#dc2626', fontSize: 18 }}>{atp.total_atp}</b> {atp.item.uom}</div>}
          </div>
          {atp && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Bucket', 'From', 'Supply', 'Committed', 'ATP', 'Cumulative ATP'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {atp.grid.map(g => (
                    <tr key={g.bucket_index}>
                      <td style={td}>Bkt {g.bucket_index}</td>
                      <td style={td}>{fmtDate(g.bucket_start)}</td>
                      <td style={td}>{g.supply}</td>
                      <td style={td}>{g.committed}</td>
                      <td style={{ ...td, fontWeight: 700, color: g.atp < 0 ? '#dc2626' : '#16a34a' }}>{g.atp}</td>
                      <td style={{ ...td, fontWeight: 700, color: g.cumulative_atp < 0 ? '#dc2626' : INK }}>{g.cumulative_atp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!atp && <div style={{ color: MUT, fontSize: 13 }}>Select an item and check how much is available to promise, time-phased.</div>}
        </div>
      )}

      {/* CTP CHECK */}
      {tab === 'ctp' && (
        <div style={card}>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: MUT }}>Capable-to-Promise checks material (ATP) <b>and</b> work-centre capacity to answer whether an order can be delivered by a date.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: MUT }}>Item
              <select value={ctpForm.item_id} onChange={e => setCtpForm(f => ({ ...f, item_id: e.target.value }))} style={{ display: 'block', marginTop: 3, padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 200 }}>
                <option value="">Select item…</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
              </select></label>
            <label style={{ fontSize: 12, color: MUT }}>Quantity
              <input type="number" value={ctpForm.quantity} onChange={e => setCtpForm(f => ({ ...f, quantity: e.target.value }))} style={{ display: 'block', marginTop: 3, padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 100 }} /></label>
            <label style={{ fontSize: 12, color: MUT }}>Need by
              <input type="date" value={ctpForm.need_date} onChange={e => setCtpForm(f => ({ ...f, need_date: e.target.value }))} style={{ display: 'block', marginTop: 3, padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} /></label>
            <button style={{ ...btnP, opacity: ctpBusy ? 0.6 : 1 }} disabled={ctpBusy} onClick={runCTP}>{ctpBusy ? 'Checking…' : 'Check CTP'}</button>
          </div>
          {ctp && (
            <div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', padding: 14, borderRadius: 10, background: ctp.capable ? '#f0fdf4' : '#fef2f2', border: `1px solid ${ctp.capable ? '#bbf7d0' : '#fecaca'}`, marginBottom: 12 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: ctp.capable ? '#16a34a' : '#dc2626' }}>{ctp.capable ? '✓ CAPABLE' : '✗ NOT CAPABLE'}</span>
                <span style={{ fontSize: 14 }}>Promise date: <b>{fmtDate(ctp.promise_date)}</b></span>
                <span style={{ fontSize: 13, color: MUT }}>Constraint: <b style={{ color: INK }}>{ctp.limiting_constraint}</b> · mode {ctp.mode}</span>
              </div>
              <div style={{ display: 'flex', gap: 18, fontSize: 13, marginBottom: 12, flexWrap: 'wrap' }}>
                <span>Requested: <b>{ctp.requested_qty}</b></span>
                <span>From ATP by need: <b style={{ color: '#16a34a' }}>{ctp.atp_available_by_need}</b></span>
                <span>To produce: <b style={{ color: PURPLE }}>{ctp.shortfall_to_produce}</b></span>
              </div>
              <p style={{ fontSize: 13, color: INK, margin: '0 0 12px' }}>{ctp.explanation}</p>
              {ctp.capacity?.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['Work Centre', 'Required Hours', 'Capacity Available', 'Feasible'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {ctp.capacity.map((c, i) => (
                      <tr key={i}>
                        <td style={{ ...td, fontWeight: 600 }}>{c.work_centre_name || `WC ${c.work_centre_id}`}</td>
                        <td style={td}>{c.required_hours}h</td>
                        <td style={td}>{fmtDate(c.earliest_date)}</td>
                        <td style={td}>{c.feasible ? <span style={chip('#dcfce7', '#16a34a')}>yes</span> : <span style={chip('#fee2e2', '#dc2626')}>no</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {!ctp && <div style={{ color: MUT, fontSize: 13 }}>Enter an item, quantity, and required date to test whether the order is capable-to-promise.</div>}
        </div>
      )}

      {/* DEMAND */}
      {tab === 'demand' && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ ...card, flex: '1 1 380px' }}>
            <h3 style={{ margin: '0 0 10px', color: HEAD, fontSize: 15 }}>Master Production Schedule</h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'flex-end' }}>
              <select value={mpsForm.product_id} onChange={e => { const it = items.find(i => String(i.id) === e.target.value); setMpsForm(f => ({ ...f, product_id: e.target.value, product_name: it?.item_name || f.product_name })); }}
                style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12, flex: '1 1 140px' }}>
                <option value="">Product…</option>
                {items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
              </select>
              <input type="date" value={mpsForm.due_date} onChange={e => setMpsForm(f => ({ ...f, due_date: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12 }} />
              <input type="number" placeholder="Qty" value={mpsForm.quantity} onChange={e => setMpsForm(f => ({ ...f, quantity: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12, width: 70 }} />
              <button style={btnP} onClick={addMps}>Add</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Product', 'Due', 'Qty', 'Status', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {mps.map(m => (
                  <tr key={m.id}><td style={td}>{m.product_name}</td><td style={td}>{fmtDate(m.due_date)}</td><td style={td}>{Number(m.quantity)}</td>
                    <td style={td}><span style={chip('#f5f3ff', PURPLE)}>{m.status}</span></td>
                    <td style={td}><button style={{ ...btnS, background: '#fee2e2', color: '#dc2626' }} onClick={() => delMps(m.id)}>✕</button></td></tr>
                ))}
                {mps.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={5}>No MPS entries.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ ...card, flex: '1 1 380px' }}>
            <h3 style={{ margin: '0 0 10px', color: HEAD, fontSize: 15 }}>Demand Forecast</h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'flex-end' }}>
              <select value={fcForm.item_id} onChange={e => setFcForm(f => ({ ...f, item_id: e.target.value }))}
                style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12, flex: '1 1 140px' }}>
                <option value="">Item…</option>
                {items.map(i => <option key={i.id} value={i.id}>{i.item_name}</option>)}
              </select>
              <input type="date" value={fcForm.forecast_date} onChange={e => setFcForm(f => ({ ...f, forecast_date: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12 }} />
              <input type="number" placeholder="Qty" value={fcForm.quantity} onChange={e => setFcForm(f => ({ ...f, quantity: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12, width: 70 }} />
              <button style={btnP} onClick={addFc}>Add</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Item', 'Date', 'Qty', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {forecasts.map(f => (
                  <tr key={f.id}><td style={td}>{f.master_item_name || f.product_name || f.item_code}</td><td style={td}>{fmtDate(f.forecast_date)}</td><td style={td}>{Number(f.quantity)}</td>
                    <td style={td}><button style={{ ...btnS, background: '#fee2e2', color: '#dc2626' }} onClick={() => delFc(f.id)}>✕</button></td></tr>
                ))}
                {forecasts.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={4}>No forecasts.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ITEM PLANNING */}
      {tab === 'items' && (
        <div style={card}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: MUT }}>Edit planning attributes inline, then click Save on the row.</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Item', 'Make/Buy', 'Safety', 'Lead (d)', 'Lot Rule', 'Lot Qty', 'Min', 'Max', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {items.map(it => <ItemRow key={it.id} it={it} onSave={saveItem} />)}
                {items.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={9}>No items.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemRow({ it, onSave }) {
  const [f, setF] = useState({
    make_or_buy: it.make_or_buy, safety_stock: it.safety_stock, lead_time_days: it.lead_time_days,
    lot_sizing_rule: it.lot_sizing_rule, lot_size_qty: it.lot_size_qty, min_order_qty: it.min_order_qty, max_order_qty: it.max_order_qty,
  });
  const inp = { padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12, width: 62 };
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const dirty = JSON.stringify(f) !== JSON.stringify({
    make_or_buy: it.make_or_buy, safety_stock: it.safety_stock, lead_time_days: it.lead_time_days,
    lot_sizing_rule: it.lot_sizing_rule, lot_size_qty: it.lot_size_qty, min_order_qty: it.min_order_qty, max_order_qty: it.max_order_qty,
  });
  return (
    <tr>
      <td style={{ ...td, fontWeight: 600 }}>{it.item_name}<div style={{ fontSize: 11, color: '#6b7280' }}>{it.item_code}</div></td>
      <td style={td}><select value={f.make_or_buy} onChange={set('make_or_buy')} style={{ ...inp, width: 68 }}><option value="buy">buy</option><option value="make">make</option></select></td>
      <td style={td}><input type="number" value={f.safety_stock} onChange={set('safety_stock')} style={inp} /></td>
      <td style={td}><input type="number" value={f.lead_time_days} onChange={set('lead_time_days')} style={{ ...inp, width: 50 }} /></td>
      <td style={td}><select value={f.lot_sizing_rule} onChange={set('lot_sizing_rule')} style={{ ...inp, width: 96 }}>
        <option value="lot_for_lot">lot_for_lot</option><option value="fixed_qty">fixed_qty</option><option value="min_max">min_max</option><option value="eoq">eoq</option>
      </select></td>
      <td style={td}><input type="number" value={f.lot_size_qty} onChange={set('lot_size_qty')} style={inp} /></td>
      <td style={td}><input type="number" value={f.min_order_qty} onChange={set('min_order_qty')} style={inp} /></td>
      <td style={td}><input type="number" value={f.max_order_qty} onChange={set('max_order_qty')} style={inp} /></td>
      <td style={td}><button disabled={!dirty} style={{ ...btnS, opacity: dirty ? 1 : 0.4 }} onClick={() => onSave(it, {
        make_or_buy: f.make_or_buy, safety_stock: Number(f.safety_stock), lead_time_days: Number(f.lead_time_days),
        lot_sizing_rule: f.lot_sizing_rule, lot_size_qty: Number(f.lot_size_qty), min_order_qty: Number(f.min_order_qty), max_order_qty: Number(f.max_order_qty),
      })}>Save</button></td>
    </tr>
  );
}
