import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AlertTriangle, RotateCcw, SlidersHorizontal } from 'lucide-react';
import api from '@/services/api/client';

/**
 * Cost-sensitivity tornado.
 *
 * Ranks project cost drivers by how far each one moves NET MARGIN when it comes
 * in below or above its booked amount. Bars diverge from the base-case margin:
 * left (red) = margin lost if the driver overruns, right (green) = margin gained
 * if it underruns.
 *
 * The +/-% ranges are ASSUMPTIONS, not measurements. They are seeded from the
 * server's defaults, printed on every bar and editable below the chart — a
 * tornado whose range is invisible reads as a measured result, which it is not.
 */

const fmtINR = (n) => {
  const v = parseFloat(n || 0);
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)}Cr`;
  if (abs >= 100000)   return `${sign}₹${(abs / 100000).toFixed(2)}L`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
};

const OVER  = '#dc2626';  // driver overruns -> margin falls
const UNDER = '#15803d';  // driver underruns -> margin rises

function TornadoBars({ rows, baseMargin, maxSwing }) {
  const ROW_H = 30, LABEL_W = 132, VAL_W = 96, PAD_T = 26, PAD_B = 8;
  const BAR_W = 420;                       // full width, centre line at BAR_W/2
  const W = LABEL_W + BAR_W + VAL_W;
  const H = PAD_T + rows.length * ROW_H + PAD_B;
  const cx = LABEL_W + BAR_W / 2;
  const half = BAR_W / 2 - 6;
  const scale = (v) => (maxSwing > 0 ? (v / maxSwing) * half : 0);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }} role="img"
         aria-label="Cost driver sensitivity tornado">
      {/* centre line = base-case margin */}
      <line x1={cx} x2={cx} y1={PAD_T - 12} y2={H - PAD_B} stroke="#9ca3af" strokeWidth={1} strokeDasharray="3 3" />
      <text x={cx} y={PAD_T - 16} textAnchor="middle" fontSize={9} fill="#6b7280">
        Base margin {fmtINR(baseMargin)}
      </text>
      <text x={cx - half / 2} y={PAD_T - 4} textAnchor="middle" fontSize={8} fill={OVER}>margin falls</text>
      <text x={cx + half / 2} y={PAD_T - 4} textAnchor="middle" fontSize={8} fill={UNDER}>margin rises</text>

      {rows.map((r, i) => {
        const y = PAD_T + i * ROW_H;
        const wOver  = scale(Math.abs(r.marginDelta_high));  // high cost -> left
        const wUnder = scale(Math.abs(r.marginDelta_low));   // low cost  -> right
        return (
          <g key={r.key}>
            <text x={LABEL_W - 8} y={y + 15} textAnchor="end" fontSize={11} fill="var(--color-text-primary, #111827)">
              {r.label}
            </text>
            <rect x={cx - wOver} y={y + 4} width={wOver} height={15} rx={2} fill={OVER} opacity={0.85} />
            <rect x={cx} y={y + 4} width={wUnder} height={15} rx={2} fill={UNDER} opacity={0.85} />
            <text x={LABEL_W + BAR_W + 4} y={y + 15} fontSize={10} fill="#6b7280">
              {r.low_pct}% / +{r.high_pct}%
            </text>
            <title>
              {`${r.label} — booked ${fmtINR(r.amount)}\n`}
              {`at ${r.high_pct > 0 ? '+' : ''}${r.high_pct}%: margin ${fmtINR(baseMargin + r.marginDelta_high)} (${fmtINR(r.marginDelta_high)})\n`}
              {`at ${r.low_pct}%: margin ${fmtINR(baseMargin + r.marginDelta_low)} (+${fmtINR(Math.abs(r.marginDelta_low))})\n`}
              {`total swing ${fmtINR(r.swing)}`}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

export default function CostSensitivityTornado({ projectId, onRecalculate }) {
  const [data,    setData]    = useState(null);
  const [ranges,  setRanges]  = useState({});   // key -> { low, high }
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const mounted = useRef(true);

  // Arm on EVERY mount, not just the first — a disarm-only cleanup never
  // re-arms under StrictMode's double-mount and hangs the panel on "Loading".
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setError(null);
    try {
      const res = await api.get(`/projects/projects/${projectId}/cost-sensitivity`);
      if (!mounted.current) return;
      const d = res.data;
      setData(d);
      setRanges(Object.fromEntries(
        (d.drivers || []).map(x => [x.key, { low: x.default_low_pct, high: x.default_high_pct }])
      ));
    } catch (e) {
      if (mounted.current) setError(e?.response?.data?.error || 'Failed to load cost sensitivity');
    }
    if (mounted.current) setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const resetRanges = () => setRanges(Object.fromEntries(
    (data?.drivers || []).map(x => [x.key, { low: x.default_low_pct, high: x.default_high_pct }])
  ));

  const setRange = (key, edge, raw) => {
    const v = raw === '' || raw === '-' ? raw : Number(raw);
    setRanges(prev => ({ ...prev, [key]: { ...prev[key], [edge]: v } }));
  };

  const baseMargin = parseFloat(data?.basis?.net_margin || 0);

  const { rows, unmeasured, maxSwing } = useMemo(() => {
    const drivers = data?.drivers || [];
    const measured = drivers.filter(d => d.measured);
    const built = measured.map(d => {
      const r = ranges[d.key] || {};
      const low  = Number.isFinite(Number(r.low))  ? Number(r.low)  : d.default_low_pct;
      const high = Number.isFinite(Number(r.high)) ? Number(r.high) : d.default_high_pct;
      // A cost moving by p% moves margin by -amount*p/100.
      const marginDelta_low  = -d.amount * (low / 100);
      const marginDelta_high = -d.amount * (high / 100);
      return {
        ...d, low_pct: low, high_pct: high, marginDelta_low, marginDelta_high,
        swing: Math.abs(marginDelta_high - marginDelta_low),
      };
    }).sort((a, b) => b.swing - a.swing);

    return {
      rows: built,
      unmeasured: drivers.filter(d => !d.measured),
      maxSwing: Math.max(...built.map(b => Math.max(Math.abs(b.marginDelta_low), Math.abs(b.marginDelta_high))), 0),
    };
  }, [data, ranges]);

  const card = {
    background: 'var(--color-background-secondary)',
    border: '1px solid var(--color-border-tertiary)',
    borderRadius: 10, padding: '13px 15px',
  };

  if (!projectId) return null;

  return (
    <div className="dk-anim" style={{ ...card, marginTop: 12, '--dk-i': 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Cost Sensitivity (Tornado)</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            Which cost driver moves net margin most, at the assumed range below
          </div>
        </div>
        <button onClick={resetRanges} disabled={!rows.length}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '5px 10px',
                         borderRadius: 6, border: '1px solid var(--color-border)', background: 'transparent',
                         color: 'var(--color-text-primary)', cursor: rows.length ? 'pointer' : 'not-allowed' }}>
          <RotateCcw size={12} /> Reset ranges
        </button>
      </div>

      {loading && <div style={{ padding: 30, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading cost drivers…</div>}

      {!loading && error && (
        <div style={{ padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Integrity gate — a rollup-inconsistent row would draw a confident chart
          from numbers the cost engine never produced, so refuse to draw it. */}
      {!loading && !error && data && data.integrity?.state !== 'ok' && (
        <div style={{ display: 'flex', gap: 10, padding: 14, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, marginTop: 8 }}>
          <AlertTriangle size={18} color="#c2410c" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#c2410c', marginBottom: 3 }}>
              {data.integrity.state === 'never_calculated' ? 'No cost rollup yet' : 'Cost rollup is inconsistent'}
            </div>
            <div style={{ fontSize: 12, color: '#7c2d12', lineHeight: 1.5 }}>{data.integrity.message}</div>
            {onRecalculate && (
              <button onClick={async () => { await onRecalculate(); load(); }}
                      style={{ marginTop: 9, fontSize: 11, padding: '5px 11px', borderRadius: 6, border: '1px solid #fdba74',
                               background: '#ffedd5', color: '#9a3412', cursor: 'pointer', fontWeight: 600 }}>
                Recalculate now
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && !error && data && data.integrity?.state === 'ok' && rows.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
          No cost has been booked against any driver for this project, so there is nothing to rank.
        </div>
      )}

      {!loading && !error && data && data.integrity?.state === 'ok' && rows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: '#6b7280', margin: '6px 0 2px' }}>
            <span>Revenue <b style={{ color: 'var(--color-text-primary)' }}>{fmtINR(data.basis.total_revenue)}</b></span>
            <span>Cost <b style={{ color: 'var(--color-text-primary)' }}>{fmtINR(data.basis.driver_sum)}</b></span>
            <span>Net margin <b style={{ color: baseMargin >= 0 ? UNDER : OVER }}>{fmtINR(baseMargin)}</b></span>
            <span>Margin % <b style={{ color: 'var(--color-text-primary)' }}>
              {data.basis.net_margin_pct == null ? 'n/a — no revenue booked' : `${data.basis.net_margin_pct.toFixed(1)}%`}
            </b></span>
          </div>

          <TornadoBars rows={rows} baseMargin={baseMargin} maxSwing={maxSwing} />

          <div style={{ marginTop: 10, borderTop: '1px solid var(--color-border-tertiary)', paddingTop: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6 }}>
              <SlidersHorizontal size={12} /> Assumed range per driver (editable — these are estimates, not measurements)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))', gap: '5px 16px' }}>
              {rows.map(r => (
                <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ flex: 1, color: '#6b7280' }}>{r.label}</span>
                  <span style={{ color: '#9ca3af', minWidth: 62, textAlign: 'right' }}>{fmtINR(r.amount)}</span>
                  <input type="number" value={r.low_pct} onChange={e => setRange(r.key, 'low', e.target.value)}
                         aria-label={`${r.label} low percent`}
                         style={{ width: 48, padding: '2px 4px', fontSize: 11, textAlign: 'right',
                                  border: '1px solid var(--color-border)', borderRadius: 4,
                                  background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                  <span style={{ color: '#9ca3af' }}>/</span>
                  <input type="number" value={r.high_pct} onChange={e => setRange(r.key, 'high', e.target.value)}
                         aria-label={`${r.label} high percent`}
                         style={{ width: 48, padding: '2px 4px', fontSize: 11, textAlign: 'right',
                                  border: '1px solid var(--color-border)', borderRadius: 4,
                                  background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                  <span style={{ color: '#9ca3af' }}>%</span>
                </div>
              ))}
            </div>
          </div>

          {unmeasured.length > 0 && (
            <div style={{ marginTop: 9, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
              <b style={{ color: '#6b7280' }}>Not measured:</b>{' '}
              {unmeasured.map(u => u.label).join(', ')} — no cost booked against{' '}
              {unmeasured.length === 1 ? 'this category' : 'these categories'}, which is not the same as
              a zero cost. They are excluded from the ranking rather than shown as zero-swing bars.
            </div>
          )}
        </>
      )}
    </div>
  );
}
