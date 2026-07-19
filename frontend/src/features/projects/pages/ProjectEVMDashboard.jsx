import { useState, useEffect, useCallback, useRef } from 'react';
import { TrendingUp, RefreshCw, Activity } from 'lucide-react';
import api from '@/services/api/client';
import { getProjects } from '../services/projectsService';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const fmt = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

const cpiColor  = (cpi) => parseFloat(cpi || 0) >= 1 ? '#15803d' : parseFloat(cpi || 0) >= 0.8 ? '#ca8a04' : '#dc2626';
const spiColor  = (spi) => parseFloat(spi || 0) >= 1 ? '#0369a1' : parseFloat(spi || 0) >= 0.8 ? '#6B3FDB' : '#dc2626';

function GaugeDial({ value, label, minVal, maxVal, color }) {
  const clamp  = Math.max(minVal, Math.min(maxVal, parseFloat(value || 0)));
  const range  = maxVal - minVal;
  const pctVal = (clamp - minVal) / range;
  const angle  = -135 + pctVal * 270;
  const r = 45, cx = 60, cy = 65;
  const toXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const arcPath = (from, to, fill) => {
    const s = toXY(from); const e = toXY(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  };
  const needle = toXY(angle);
  return (
    <div style={{ textAlign: 'center' }}>
      <svg width={120} height={90} viewBox="0 0 120 90">
        <path d={arcPath(-135, 135, false)} fill="none" stroke="#e5e7eb" strokeWidth={10} strokeLinecap="round" />
        <path d={arcPath(-135, -135 + pctVal * 270, false)} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={5} fill={color} />
        <text x={cx} y={85} textAnchor="middle" fontSize={11} fontWeight="bold" fill={color}>{parseFloat(value || 0).toFixed(2)}</text>
      </svg>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: -6 }}>{label}</div>
    </div>
  );
}

function SCurveChart({ scurveData, maxHeight = 165 }) {
  if (!scurveData || scurveData.length === 0) {
    return <div style={{ height: maxHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>No S-Curve data available</div>;
  }
  const maxVal = Math.max(...scurveData.map(d => Math.max(parseFloat(d.planned_cumulative || 0), parseFloat(d.actual_cumulative || 0))), 1);
  const W = 560, H = 180, pad = { t: 10, r: 10, b: 30, l: 50 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;
  const xScale = (i) => pad.l + (i / (scurveData.length - 1 || 1)) * cW;
  const yScale = (v) => pad.t + cH - (parseFloat(v || 0) / maxVal) * cH;
  const planned = scurveData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.planned_cumulative)}`).join(' ');
  const actual  = scurveData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.actual_cumulative)}`).join(' ');

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxHeight, overflow: 'visible' }}>
      {[0, 0.25, 0.5, 0.75, 1].map(t => {
        const y = yScale(maxVal * t);
        return (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="#e5e7eb" strokeWidth={0.5} />
            <text x={pad.l - 5} y={y + 4} textAnchor="end" fontSize={8} fill="#9ca3af">
              {(maxVal * t / 100000).toFixed(0)}L
            </text>
          </g>
        );
      })}
      {scurveData.map((d, i) => (
        <text key={i} x={xScale(i)} y={H - 5} textAnchor="middle" fontSize={7} fill="#9ca3af">
          {d.month || d.period || `M${i + 1}`}
        </text>
      ))}
      <path d={planned} fill="none" stroke="#6366f1" strokeWidth={2} />
      <path d={actual} fill="none" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 2" />
      <g transform={`translate(${W - 120}, ${pad.t})`}>
        <line x1={0} x2={20} y1={6} y2={6} stroke="#6366f1" strokeWidth={2} />
        <text x={24} y={10} fontSize={9} fill="#6366f1">Planned</text>
        <line x1={0} x2={20} y1={20} y2={20} stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 2" />
        <text x={24} y={24} fontSize={9} fill="#f59e0b">Actual</text>
      </g>
    </svg>
  );
}

export default function ProjectEVMDashboard({ setPage }) {
  const [projects,  setProjects]  = useState([]);
  const [selId,     setSelId]     = useState('');
  const [evm,       setEvm]       = useState(null);
  const [scurve,    setScurve]    = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [toast,     setToast]     = useState(null);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    getProjects().then(p => { if (isMounted.current) setProjects(p); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selId) return;
    setLoading(true);
    try {
      const [evmRes, scurveRes] = await Promise.allSettled([
        api.get(`/projects/projects/${selId}/costing`),
        api.get(`/projects/projects/${selId}/scurve`),
      ]);
      if (!isMounted.current) return;
      const evmData = evmRes.status === 'fulfilled' ? (evmRes.value.data?.costing || evmRes.value.data) : null;
      setEvm(evmData);
      const sc = scurveRes.status === 'fulfilled' ? (scurveRes.value.data?.scurve || scurveRes.value.data || []) : [];
      setScurve(sc);
    } catch (e) {
      if (isMounted.current) showToast('Failed to load EVM data', 'error');
    }
    if (isMounted.current) setLoading(false);
  }, [selId]);

  useEffect(() => { if (selId) load(); }, [selId, load]);

  const recalculate = async () => {
    if (!selId) return;
    try {
      await api.post(`/projects/projects/${selId}/costs/recalculate`);
      showToast('EVM recalculated');
      load();
    } catch { showToast('Recalculate failed', 'error'); }
  };

  const cpi = parseFloat(evm?.cost_performance_index || 0);
  const spi = parseFloat(evm?.schedule_performance_index || 0);
  const bac = parseFloat(evm?.total_budget || 0);
  const ev  = parseFloat(evm?.earned_value || 0);
  const ac  = parseFloat(evm?.actual_cost || 0);
  const pv  = parseFloat(evm?.planned_value || 0);
  const eac = cpi > 0 ? bac / cpi : 0;
  const etc = eac - ac;
  const cv  = ev - ac;
  const sv  = ev - pv;

  return (
    <div style={{ padding: '16px 18px 20px', margin: '0 auto' }}>
      {toast && <div style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999, background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4', color: toast.type === 'error' ? '#dc2626' : '#15803d', border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{toast.msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>EVM Dashboard</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Earned Value Management — CPI, SPI, cost/schedule variance, S-Curve</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={!selId} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><RefreshCw size={14} /></button>
          <button onClick={recalculate} disabled={!selId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            <Activity size={13} /> Recalculate EVM
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <select value={selId} onChange={e => setSelId(e.target.value)} style={{ width: 400, padding: '9px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 14 }}>
          <option value="">— Select Project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
        </select>
      </div>

      {!selId && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <TrendingUp size={40} style={{ marginBottom: 10 }} />
          <p>Select a project to view EVM metrics</p>
        </div>
      )}

      {selId && loading && <div style={{ textAlign: 'center', padding: 60, color: '#6b7280' }}>Loading EVM data…</div>}

      {selId && !loading && evm && (
        <div>
          {/* Performance Index Gauges */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 12, padding: '20px 24px' }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Cost Performance Index (CPI)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <GaugeDial value={cpi} label="CPI" minVal={0} maxVal={2} color={cpiColor(cpi)} />
                <div>
                  <div style={{ fontSize: 27, fontWeight: 800, color: cpiColor(cpi) }}>{cpi.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    {cpi >= 1 ? '✓ Under budget' : cpi >= 0.8 ? '⚠ Slight overrun' : '✗ Significant overrun'}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>CPI = EV / AC</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmt(ev)} / {fmt(ac)}</div>
                  <div style={{ marginTop: 8, padding: '6px 10px', background: cv >= 0 ? '#f0fdf4' : '#fef2f2', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>Cost Variance (CV)</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: cv >= 0 ? '#15803d' : '#dc2626' }}>{cv >= 0 ? '+' : ''}{fmt(cv)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 12, padding: '20px 24px' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Schedule Performance Index (SPI)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <GaugeDial value={spi} label="SPI" minVal={0} maxVal={2} color={spiColor(spi)} />
                <div>
                  <div style={{ fontSize: 27, fontWeight: 800, color: spiColor(spi) }}>{spi.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    {spi >= 1 ? '✓ Ahead of schedule' : spi >= 0.8 ? '⚠ Slight delay' : '✗ Behind schedule'}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>SPI = EV / PV</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmt(ev)} / {fmt(pv)}</div>
                  <div style={{ marginTop: 8, padding: '6px 10px', background: sv >= 0 ? '#f0fdf4' : '#fef2f2', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>Schedule Variance (SV)</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: sv >= 0 ? '#15803d' : '#dc2626' }}>{sv >= 0 ? '+' : ''}{fmt(sv)}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* EVM Metrics Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 12 }}>
            {[
              { label: 'BAC (Budget at Completion)', value: fmt(bac), color: '#6366f1', bg: '#eef2ff' },
              { label: 'PV (Planned Value)', value: fmt(pv), color: '#0369a1', bg: '#e0f2fe' },
              { label: 'EV (Earned Value)', value: fmt(ev), color: '#15803d', bg: '#f0fdf4' },
              { label: 'AC (Actual Cost)', value: fmt(ac), color: ac > ev ? '#dc2626' : '#15803d', bg: ac > ev ? '#fef2f2' : '#f0fdf4' },
              { label: 'EAC (Estimate at Completion)', value: fmt(eac), color: eac > bac ? '#dc2626' : '#ca8a04', bg: '#fff7ed' },
            ].map(k => (
              <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '12px 14px', border: `1px solid ${k.color}22` }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: k.color }}>{k.value}</div>
                <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.3, marginTop: 2 }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* ETC + Completion */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
            <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: '13px 15px', '--dk-i': 2 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Forecast Summary</div>
              {[
                { label: 'ETC (Estimate to Complete)', value: fmt(etc), color: '#6B3FDB' },
                { label: 'TCPI (Performance needed)', value: bac > 0 ? ((bac - ev) / Math.max(bac - ac, 0.01)).toFixed(2) : '—', color: '#0369a1' },
                { label: 'Variance at Completion', value: fmt(bac - eac), color: bac >= eac ? '#15803d' : '#dc2626' },
                { label: 'Progress %', value: `${parseFloat(evm?.progress_percentage || 0).toFixed(1)}%`, color: '#6366f1' },
              ].map(k => (
                <div key={k.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border-tertiary)', fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>{k.label}</span>
                  <span style={{ fontWeight: 700, color: k.color }}>{k.value}</span>
                </div>
              ))}
            </div>

            {/* S-Curve */}
            <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: '13px 15px', '--dk-i': 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>S-Curve (Planned vs Actual)</div>
                <ChartExpandButton title="S-Curve (Planned vs Actual)" subtitle="Cumulative planned vs actual cost">
                  <SCurveChart scurveData={scurve} maxHeight={460} />
                </ChartExpandButton>
              </div>
              <SCurveChart scurveData={scurve} />
            </div>
          </div>

          {/* Trend Indicators */}
          <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: '13px 15px', '--dk-i': 4 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Health Indicators</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Cost Health', ok: cpi >= 0.9, warn: cpi >= 0.75, msg: cpi >= 0.9 ? 'Within budget tolerance' : cpi >= 0.75 ? 'Monitor spending' : 'Cost overrun — action needed' },
                { label: 'Schedule Health', ok: spi >= 0.9, warn: spi >= 0.75, msg: spi >= 0.9 ? 'On track' : spi >= 0.75 ? 'Minor delay — recoverable' : 'Significant delay — escalate' },
                { label: 'Forecast', ok: eac <= bac, warn: eac <= bac * 1.1, msg: eac <= bac ? 'Within budget at completion' : eac <= bac * 1.1 ? 'Slight overrun forecast' : 'Significant overrun forecast' },
              ].map(h => (
                <div key={h.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: h.ok ? '#f0fdf4' : h.warn ? '#fff7ed' : '#fef2f2', border: `1px solid ${h.ok ? '#bbf7d0' : h.warn ? '#fed7aa' : '#fecaca'}`, flex: 1, minWidth: 200 }}>
                  <span style={{ fontSize: 18 }}>{h.ok ? '✅' : h.warn ? '⚠️' : '🔴'}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: h.ok ? '#15803d' : h.warn ? '#ca8a04' : '#dc2626' }}>{h.label}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>{h.msg}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
