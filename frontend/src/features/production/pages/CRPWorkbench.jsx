// frontend/src/features/production/pages/CRPWorkbench.jsx
//
// Capacity Requirements Planning workbench. Drives /crp:
//   run CRP → work-centre × time-bucket load heatmap (available vs required),
//   drill into overloaded cells, and maintain work-centre capacity attributes.
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #ede9fe', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff', whiteSpace: 'nowrap' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };
const btnS = { background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 };

// load% -> heatmap colour
function loadColor(pct) {
  if (pct <= 0) return { bg: '#f9fafb', fg: '#9ca3af' };
  if (pct <= 70) return { bg: '#dcfce7', fg: '#15803d' };
  if (pct <= 90) return { bg: '#d1fae5', fg: '#047857' };
  if (pct <= 100) return { bg: '#fef3c7', fg: '#b45309' };
  if (pct <= 150) return { bg: '#fed7aa', fg: '#c2410c' };
  return { bg: '#fecaca', fg: '#b91c1c' };
}

function KPI({ label, value, tint = PURPLE }) {
  return (
    <div style={{ ...card, flex: '1 1 130px', minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: tint, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: MUT, marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function CRPWorkbench() {
  const toast = useToast();
  const [tab, setTab] = useState('load');
  const [horizon, setHorizon] = useState(84);
  const [bucketDays, setBucketDays] = useState(7);
  const [incPlanned, setIncPlanned] = useState(true);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(null);
  const [buckets, setBuckets] = useState([]);
  const [load, setLoad] = useState([]);
  const [runs, setRuns] = useState([]);
  const [detail, setDetail] = useState(null);       // clicked cell
  const [wcs, setWcs] = useState([]);

  const loadRuns = useCallback(async () => { try { setRuns((await api.get('/crp/runs')).data || []); } catch { /* */ } }, []);
  const loadWCs = useCallback(async () => { try { setWcs((await api.get('/crp/work-centre-capacity')).data || []); } catch { /* */ } }, []);

  const hydrate = useCallback((runObj, loadRows) => {
    setRun(runObj);
    setLoad(loadRows);
    const bset = new Map();
    loadRows.forEach(r => { if (!bset.has(r.bucket_index)) bset.set(r.bucket_index, { index: r.bucket_index, start: r.bucket_start, end: r.bucket_end }); });
    setBuckets([...bset.values()].sort((a, b) => a.index - b.index));
  }, []);

  const loadRunDetail = useCallback(async (id) => {
    try { const { data } = await api.get(`/crp/runs/${id}`); hydrate(data.run, data.load || []); }
    catch { toast.error('Failed to load run'); }
  }, [hydrate, toast]);

  useEffect(() => { loadRuns(); loadWCs(); }, [loadRuns, loadWCs]);

  const runCRP = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/crp/run', { horizon_days: Number(horizon), bucket_days: Number(bucketDays), include_planned: incPlanned });
      hydrate(data.run, data.load || []); setTab('load'); loadRuns();
      toast.success(`CRP done — ${data.summary.overloaded_buckets} overloaded bucket(s), peak ${Number(data.summary.peak_load_pct)}%`);
    } catch (e) { toast.error(e.response?.data?.error || 'CRP run failed'); }
    finally { setRunning(false); }
  };

  // group load rows by work centre for the heatmap
  const wcRows = [];
  const seen = new Map();
  load.forEach(r => {
    if (!seen.has(r.work_centre_id)) { seen.set(r.work_centre_id, { id: r.work_centre_id, name: r.work_centre_name, cells: {} }); wcRows.push(seen.get(r.work_centre_id)); }
    seen.get(r.work_centre_id).cells[r.bucket_index] = r;
  });

  const saveWc = async (wc, patch) => {
    try { const { data } = await api.put(`/crp/work-centre-capacity/${wc.id}`, patch); setWcs(list => list.map(x => x.id === wc.id ? { ...x, ...data } : x)); toast.success(`${wc.name} updated`); }
    catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const Tab = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{ background: tab === id ? PURPLE : 'transparent', color: tab === id ? '#fff' : INK, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{label}</button>
  );

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>📊 Capacity Planning (CRP)</h2>
          <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Work-centre load vs available capacity across the planning horizon</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: MUT }}>Horizon (days)
            <input type="number" min={1} max={365} value={horizon} onChange={e => setHorizon(e.target.value)} style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 90 }} />
          </label>
          <label style={{ fontSize: 12, color: MUT }}>Bucket (days)
            <select value={bucketDays} onChange={e => setBucketDays(e.target.value)} style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
              <option value={1}>Daily</option><option value={7}>Weekly</option><option value={14}>Fortnightly</option><option value={30}>Monthly</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: INK, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={incPlanned} onChange={e => setIncPlanned(e.target.checked)} />Include MRP planned
          </label>
          <button onClick={runCRP} disabled={running} style={{ ...btnP, opacity: running ? 0.6 : 1 }}>{running ? 'Running…' : '▶ Run CRP'}</button>
        </div>
      </div>

      {run && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <KPI label="Work Centres" value={run.work_centre_count} />
          <KPI label="Buckets" value={run.bucket_count} />
          <KPI label="Overloaded Buckets" value={run.overloaded_count} tint={run.overloaded_count ? '#dc2626' : '#16a34a'} />
          <KPI label="Peak Load" value={`${Number(run.peak_load_pct)}%`} tint={Number(run.peak_load_pct) > 100 ? '#dc2626' : '#16a34a'} />
          <KPI label="Total Load" value={`${Number(run.total_required_hrs)}h / ${Number(run.total_available_hrs)}h`} tint="#0369a1" />
          <div style={{ ...card, flex: '1 1 160px', minWidth: 140 }}>
            <div style={{ fontSize: 12, color: MUT }}>Run</div>
            <div style={{ fontWeight: 700, color: HEAD, fontSize: 13 }}>{run.run_no}</div>
            <select value={run.id} onChange={e => loadRunDetail(e.target.value)} style={{ marginTop: 6, width: '100%', padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 12 }}>
              {runs.map(r => <option key={r.id} value={r.id}>{r.run_no} · {fmtDate(r.created_at)}</option>)}
            </select>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Tab id="load" label="Load Heatmap" />
        <Tab id="capacity" label="Work-Centre Capacity" />
      </div>

      {/* HEATMAP */}
      {tab === 'load' && (
        <div style={card}>
          {load.length === 0 ? (
            <div style={{ color: MUT, fontSize: 13 }}>No load data. Run CRP to compute capacity load.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 11, color: MUT, flexWrap: 'wrap' }}>
                {[['≤70%', '#dcfce7'], ['71–90%', '#d1fae5'], ['91–100%', '#fef3c7'], ['101–150%', '#fed7aa'], ['>150%', '#fecaca']].map(([l, c]) => (
                  <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: c, borderRadius: 3, display: 'inline-block' }} />{l}</span>
                ))}
                <span style={{ marginLeft: 'auto' }}>Cell = load% · click for detail</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, position: 'sticky', left: 0, background: '#fff' }}>Work Centre</th>
                    {buckets.map(b => <th key={b.index} style={{ ...th, textAlign: 'center' }}>{fmtDate(b.start)}</th>)}
                  </tr></thead>
                  <tbody>
                    {wcRows.map(wc => (
                      <tr key={wc.id}>
                        <td style={{ ...td, fontWeight: 600, position: 'sticky', left: 0, background: '#fff' }}>{wc.name}</td>
                        {buckets.map(b => {
                          const c = wc.cells[b.index];
                          const pct = c ? Number(c.load_pct) : 0;
                          const col = loadColor(pct);
                          return (
                            <td key={b.index} onClick={() => c && (c.required_hours > 0) && setDetail(c)}
                              title={c ? `${c.required_hours}h / ${c.available_hours}h` : ''}
                              style={{ padding: '6px 8px', textAlign: 'center', background: col.bg, color: col.fg, border: '1px solid #fff', fontSize: 12, fontWeight: 700, cursor: c && c.required_hours > 0 ? 'pointer' : 'default', minWidth: 58 }}>
                              {pct > 0 ? `${pct}%` : '·'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {detail && (
            <div style={{ marginTop: 14, ...card, background: '#faf8ff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, color: HEAD, fontSize: 15 }}>{detail.work_centre_name} · {fmtDate(detail.bucket_start)} – {fmtDate(detail.bucket_end)}</h3>
                <button style={btnS} onClick={() => setDetail(null)}>Close</button>
              </div>
              <div style={{ display: 'flex', gap: 18, margin: '8px 0 12px', fontSize: 13, flexWrap: 'wrap' }}>
                <span>Available: <b>{detail.available_hours}h</b></span>
                <span>Firm: <b>{detail.firm_hours}h</b></span>
                <span>Planned: <b>{detail.planned_hours}h</b></span>
                <span>Required: <b style={{ color: detail.is_overloaded ? '#dc2626' : '#16a34a' }}>{detail.required_hours}h ({detail.load_pct}%)</b></span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Source', 'Reference', 'Operation', 'Hours'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {(detail.contributors || []).map((c, i) => (
                    <tr key={i}><td style={td}><span style={{ background: c.type === 'firm' ? '#e0f2fe' : '#ede9fe', color: c.type === 'firm' ? '#0369a1' : PURPLE, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{c.type}</span></td>
                      <td style={td}>{c.ref}</td><td style={td}>{c.op}</td><td style={{ ...td, fontWeight: 700 }}>{c.hours}h</td></tr>
                  ))}
                  {(!detail.contributors || detail.contributors.length === 0) && <tr><td style={{ ...td, color: MUT }} colSpan={4}>No contributor detail.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* CAPACITY EDITOR */}
      {tab === 'capacity' && (
        <div style={card}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: MUT }}>Available hours per bucket = capacity/day × working days × efficiency × machines.</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Work Centre', 'Capacity (h/day)', 'Efficiency %', 'Days/Week', 'Machines', 'Cost/hr', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {wcs.map(wc => <WcRow key={wc.id} wc={wc} onSave={saveWc} />)}
                {wcs.length === 0 && <tr><td style={{ ...td, color: MUT }} colSpan={7}>No work centres.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function WcRow({ wc, onSave }) {
  const base = { capacity_hours_per_day: wc.capacity_hours_per_day, efficiency_pct: wc.efficiency_pct, working_days_per_week: wc.working_days_per_week, num_machines: wc.num_machines, cost_per_hour: wc.cost_per_hour };
  const [f, setF] = useState(base);
  const inp = { padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12, width: 70 };
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  const td2 = { padding: '8px 10px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f0ff' };
  return (
    <tr>
      <td style={{ ...td2, fontWeight: 600 }}>{wc.name}</td>
      <td style={td2}><input type="number" value={f.capacity_hours_per_day} onChange={set('capacity_hours_per_day')} style={inp} /></td>
      <td style={td2}><input type="number" value={f.efficiency_pct} onChange={set('efficiency_pct')} style={inp} /></td>
      <td style={td2}><input type="number" min={1} max={7} value={f.working_days_per_week} onChange={set('working_days_per_week')} style={{ ...inp, width: 54 }} /></td>
      <td style={td2}><input type="number" min={1} value={f.num_machines} onChange={set('num_machines')} style={{ ...inp, width: 54 }} /></td>
      <td style={td2}><input type="number" value={f.cost_per_hour} onChange={set('cost_per_hour')} style={inp} /></td>
      <td style={td2}><button disabled={!dirty} style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12, opacity: dirty ? 1 : 0.4 }}
        onClick={() => onSave(wc, { capacity_hours_per_day: Number(f.capacity_hours_per_day), efficiency_pct: Number(f.efficiency_pct), working_days_per_week: Number(f.working_days_per_week), num_machines: Number(f.num_machines), cost_per_hour: Number(f.cost_per_hour) })}>Save</button></td>
    </tr>
  );
}
