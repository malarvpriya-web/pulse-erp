// frontend/src/features/production/pages/SOPPlanning.jsx
//
// Sales & Operations Planning: RCCP (rough-cut capacity from MPS) + aggregate
// S&OP plan (demand vs supply vs projected inventory). Drives /sop.
import { useState, useEffect, useCallback, Fragment } from 'react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #ede9fe', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff', whiteSpace: 'nowrap' };

function loadColor(pct) {
  if (pct <= 0) return { bg: '#f9fafb', fg: '#9ca3af' };
  if (pct <= 70) return { bg: '#dcfce7', fg: '#15803d' };
  if (pct <= 90) return { bg: '#d1fae5', fg: '#047857' };
  if (pct <= 100) return { bg: '#fef3c7', fg: '#b45309' };
  if (pct <= 150) return { bg: '#fed7aa', fg: '#c2410c' };
  return { bg: '#fecaca', fg: '#b91c1c' };
}

export default function SOPPlanning() {
  const toast = useToast();
  const [tab, setTab] = useState('rccp');
  const [horizon, setHorizon] = useState(168);
  const [bucketDays, setBucketDays] = useState(28);
  const [loading, setLoading] = useState(false);
  const [rccp, setRccp] = useState(null);
  const [sop, setSop] = useState(null);

  const loadRccp = useCallback(async () => {
    setLoading(true);
    try { setRccp((await api.get('/sop/rccp', { params: { horizon_days: horizon, bucket_days: bucketDays } })).data); }
    catch (e) { toast.error(e.response?.data?.error || 'RCCP failed'); }
    finally { setLoading(false); }
  }, [horizon, bucketDays, toast]);
  const loadSop = useCallback(async () => {
    setLoading(true);
    try { setSop((await api.get('/sop/plan', { params: { horizon_days: horizon, bucket_days: bucketDays } })).data); }
    catch (e) { toast.error(e.response?.data?.error || 'S&OP failed'); }
    finally { setLoading(false); }
  }, [horizon, bucketDays, toast]);

  useEffect(() => { if (tab === 'rccp') loadRccp(); else loadSop(); }, [tab, loadRccp, loadSop]);

  // group RCCP load by work centre
  const rccpRows = [];
  if (rccp) { const seen = new Map();
    rccp.load.forEach(r => { if (!seen.has(r.work_centre_id)) { seen.set(r.work_centre_id, { id: r.work_centre_id, name: r.work_centre_name, cells: {} }); rccpRows.push(seen.get(r.work_centre_id)); } seen.get(r.work_centre_id).cells[r.bucket_index] = r; }); }

  const Tab = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{ background: tab === id ? PURPLE : 'transparent', color: tab === id ? '#fff' : INK, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{label}</button>
  );

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>📈 Sales &amp; Operations Planning</h2>
          <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Rough-cut capacity validation of the MPS + aggregate demand/supply/inventory plan</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: MUT }}>Horizon (days)
            <input type="number" min={7} max={730} value={horizon} onChange={e => setHorizon(e.target.value)} style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, width: 90 }} /></label>
          <label style={{ fontSize: 12, color: MUT }}>Bucket
            <select value={bucketDays} onChange={e => setBucketDays(e.target.value)} style={{ display: 'block', marginTop: 2, padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
              <option value={7}>Weekly</option><option value={14}>Fortnightly</option><option value={28}>Monthly (4wk)</option>
            </select></label>
          <button onClick={() => tab === 'rccp' ? loadRccp() : loadSop()} disabled={loading} style={{ background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13, opacity: loading ? 0.6 : 1 }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <Tab id="rccp" label="Rough-Cut Capacity (RCCP)" />
        <Tab id="sop" label="S&OP Plan" />
      </div>

      {/* RCCP */}
      {tab === 'rccp' && (
        <div style={card}>
          {!rccp || rccp.load.length === 0 ? <div style={{ color: MUT, fontSize: 13 }}>No RCCP data. Add MPS entries and product routings.</div> : (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 12, color: MUT, flexWrap: 'wrap' }}>
                <span>MPS lines: <b>{rccp.summary.mps_lines}</b></span>
                <span>Overloaded buckets: <b style={{ color: rccp.summary.overloaded_buckets ? '#dc2626' : '#16a34a' }}>{rccp.summary.overloaded_buckets}</b></span>
                <span>Peak load: <b style={{ color: rccp.summary.peak_load_pct > 100 ? '#dc2626' : '#16a34a' }}>{rccp.summary.peak_load_pct}%</b></span>
                <span style={{ marginLeft: 'auto' }}>Cell = load% (from MPS × routing)</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, position: 'sticky', left: 0, background: '#fff' }}>Work Centre</th>
                    {rccp.buckets.map(b => <th key={b.index} style={{ ...th, textAlign: 'center' }}>{fmtDate(b.start)}</th>)}
                  </tr></thead>
                  <tbody>
                    {rccpRows.map(wc => (
                      <tr key={wc.id}>
                        <td style={{ ...td, fontWeight: 600, position: 'sticky', left: 0, background: '#fff' }}>{wc.name}</td>
                        {rccp.buckets.map(b => { const c = wc.cells[b.index]; const pct = c ? Number(c.load_pct) : 0; const col = loadColor(pct);
                          return <td key={b.index} title={c ? `${c.required_hours}h / ${c.available_hours}h` : ''} style={{ padding: '6px 8px', textAlign: 'center', background: col.bg, color: col.fg, border: '1px solid #fff', fontSize: 12, fontWeight: 700, minWidth: 58 }}>{pct > 0 ? `${pct}%` : '·'}</td>; })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* S&OP */}
      {tab === 'sop' && (
        <div style={card}>
          {!sop || sop.products.length === 0 ? <div style={{ color: MUT, fontSize: 13 }}>No S&OP data. Add demand (MPS/forecast/sales orders) and supply.</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, position: 'sticky', left: 0, background: '#fff' }}>Product / Row</th>
                  {sop.buckets.map(b => <th key={b.index} style={{ ...th, textAlign: 'right' }}>{fmtDate(b.start)}</th>)}
                </tr></thead>
                <tbody>
                  {sop.products.map(p => {
                    const ROWS = [['demand', 'Demand', '#dc2626'], ['supply', 'Supply', '#16a34a'], ['projected_inventory', 'Proj Inv', PURPLE]];
                    return (
                      <Fragment key={p.item_id}>
                        <tr><td style={{ ...td, fontWeight: 700, color: HEAD, background: '#faf8ff', position: 'sticky', left: 0 }} colSpan={sop.buckets.length + 1}>{p.item_name} (on-hand {p.on_hand})</td></tr>
                        {ROWS.map(([k, lbl, col]) => (
                          <tr key={`${p.item_id}-${k}`}>
                            <td style={{ ...td, color: col, fontWeight: 600, position: 'sticky', left: 0, background: '#fff', paddingLeft: 20 }}>{lbl}</td>
                            {sop.buckets.map(b => { const c = p.cells[b.index]; const v = c ? Number(c[k]) : 0;
                              return <td key={b.index} style={{ ...td, textAlign: 'right', color: k === 'projected_inventory' && v < 0 ? '#dc2626' : INK, fontWeight: k === 'projected_inventory' ? 700 : 400 }}>{v || '·'}</td>; })}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
