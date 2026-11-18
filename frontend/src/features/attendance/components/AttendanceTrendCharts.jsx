// Attendance trend charts for Reports → Analytics & Trends (§278).
//
// Owner, 2026-11-18: "keep from last year graph, 1 year graph, 2 year graph".
//   · TrendLine     attendance % per month over the chosen period (12 / 24
//                   months, this year, last year) — one series, no legend.
//   · YearCompare   this year vs last year, month by month — two series with a
//                   legend + direct labels on the last bar of each.
// Palette validated with the dataviz validator (light surface): brand purple
// #6B3FDB (this year) and teal #0E9F8E (last year). Hover = native SVG
// tooltips on generous hit targets; a table view sits under each chart.
import { useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const C_NOW = '#6B3FDB';
const C_PREV = '#0E9F8E';
const INK = '#374151';
const MUTED = '#9ca3af';
const GRID = '#eef0f4';

const pct = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function TableToggle({ open, onToggle }) {
  return (
    <button type="button" onClick={onToggle} className="pulse-btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }}>
      {open ? 'Hide table' : 'Show as table'}
    </button>
  );
}

/** rows: [{ year, month, attendance_rate, absenteeism_rate, late_rate, total_records }] newest first. */
export function TrendLine({ rows, title }) {
  const [table, setTable] = useState(false);
  const data = [...(rows || [])].reverse();
  const W = 1100; const H = 240; const L = 40; const R = 12; const T = 16; const B = 30;
  const n = data.length;
  const x = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const vals = data.map((r) => pct(r.attendance_rate)).filter((v) => v != null);
  // A rate near 100% is a flat stripe on a 0–100 scale; start the scale just
  // below the lowest month (a line chart needs no zero baseline).
  const lo = vals.length ? Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10) : 0;
  const y = (v) => T + (1 - (v - lo) / (100 - lo)) * (H - T - B);
  const ticks = [0, 1, 2, 3, 4].map((k) => Math.round(lo + (k * (100 - lo)) / 4));
  const pts = data.map((r, i) => ({ i, v: pct(r.attendance_rate), r }));
  const withData = pts.filter((p) => p.v != null);
  // break the line where a month has no records
  const segments = [];
  let cur = [];
  pts.forEach((p) => { if (p.v == null) { if (cur.length) segments.push(cur); cur = []; } else cur.push(p); });
  if (cur.length) segments.push(cur);
  const last = withData[withData.length - 1];
  const every = n > 14 ? 2 : 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>{title}</div>
        <TableToggle open={table} onToggle={() => setTable((t) => !t)} />
      </div>
      {withData.length === 0 ? (
        <div style={{ textAlign: 'center', color: MUTED, padding: 40, fontSize: 13 }}>No attendance recorded in this period</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: attendance percentage by month`} style={{ width: '100%', height: 'auto' }}>
          {ticks.map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={GRID} strokeWidth="1" />
              <text x={L - 6} y={y(g) + 4} fontSize="10" fill={MUTED} textAnchor="end">{g}%</text>
            </g>
          ))}
          {pts.map((p) => (p.i % every === 0 || p.i === n - 1) && (
            <text key={`m${p.i}`} x={x(p.i)} y={H - 10} fontSize="10" fill={MUTED} textAnchor="middle">
              {MONTHS[p.r.month - 1]}{p.r.month === 1 || p.i === 0 ? ` ${String(p.r.year).slice(2)}` : ''}
            </text>
          ))}
          {segments.map((seg, k) => (
            <polyline key={k} fill="none" stroke={C_NOW} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} />
          ))}
          {withData.map((p) => (
            <g key={`p${p.i}`}>
              <circle cx={x(p.i)} cy={y(p.v)} r="4" fill={C_NOW} stroke="#fff" strokeWidth="2" />
              <rect x={x(p.i) - 14} y={T} width="28" height={H - T - B} fill="transparent">
                <title>{`${MONTHS[p.r.month - 1]} ${p.r.year}: ${p.v.toFixed(1)}% attended · ${Number(p.r.absenteeism_rate || 0).toFixed(1)}% absent · ${Number(p.r.late_rate || 0).toFixed(1)}% late (${p.r.total_records} working-day records)`}</title>
              </rect>
            </g>
          ))}
          {last && (
            <text x={Math.min(x(last.i) + 6, W - R)} y={y(last.v) - 8} fontSize="11" fill={INK} fontWeight="700" textAnchor={x(last.i) > W - 60 ? 'end' : 'start'}>
              {last.v.toFixed(1)}%
            </text>
          )}
        </svg>
      )}
      {table && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
          <thead><tr style={{ color: '#6b7280', textAlign: 'left' }}>
            {['Month', 'Attended %', 'Absent %', 'Late %', 'Records'].map((h) => <th key={h} style={{ padding: '4px 6px' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={`${r.year}-${r.month}`} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '4px 6px' }}>{MONTHS[r.month - 1]} {r.year}</td>
                <td style={{ padding: '4px 6px' }}>{pct(r.attendance_rate)?.toFixed(1) ?? '—'}</td>
                <td style={{ padding: '4px 6px' }}>{pct(r.absenteeism_rate)?.toFixed(1) ?? '—'}</td>
                <td style={{ padding: '4px 6px' }}>{pct(r.late_rate)?.toFixed(1) ?? '—'}</td>
                <td style={{ padding: '4px 6px' }}>{r.total_records}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** current / previous: the year's monthly rows (any order). */
export function YearCompare({ current, previous, year }) {
  const [table, setTable] = useState(false);
  const byMonth = (rows) => Object.fromEntries((rows || []).map((r) => [Number(r.month), pct(r.attendance_rate)]));
  const a = byMonth(current); const b = byMonth(previous);
  const W = 1100; const H = 240; const L = 40; const R = 12; const T = 16; const B = 30;
  const band = (W - L - R) / 12;
  const bw = Math.min(14, (band - 8) / 2);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const base = y(0);
  const has = Object.values(a).some((v) => v != null) || Object.values(b).some((v) => v != null);
  const lastA = Math.max(0, ...Object.keys(a).filter((m) => a[m] != null).map(Number));
  const lastB = Math.max(0, ...Object.keys(b).filter((m) => b[m] != null).map(Number));

  const bar = (m, v, i, color, label) => {
    if (v == null) return null;
    const bx = L + (m - 1) * band + band / 2 - bw - 1 + i * (bw + 2);
    const top = y(v); const h = Math.max(0, base - top); const r = Math.min(4, h / 2);
    return (
      <path key={`${label}${m}`} fill={color}
        d={`M${bx},${base} L${bx},${top + r} Q${bx},${top} ${bx + r},${top} L${bx + bw - r},${top} Q${bx + bw},${top} ${bx + bw},${top + r} L${bx + bw},${base} Z`}>
        <title>{`${MONTHS[m - 1]} ${label}: ${v.toFixed(1)}% attended`}</title>
      </path>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>This year vs last year — attendance %</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: INK }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: C_NOW }} />{year}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: C_PREV }} />{year - 1}</span>
          <TableToggle open={table} onToggle={() => setTable((t) => !t)} />
        </div>
      </div>
      {!has ? (
        <div style={{ textAlign: 'center', color: MUTED, padding: 40, fontSize: 13 }}>No attendance recorded in {year - 1} or {year}</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Attendance percentage by month, ${year} against ${year - 1}`} style={{ width: '100%', height: 'auto' }}>
          {[0, 25, 50, 75, 100].map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={GRID} strokeWidth="1" />
              <text x={L - 6} y={y(g) + 4} fontSize="10" fill={MUTED} textAnchor="end">{g}%</text>
            </g>
          ))}
          {MONTHS.map((mn, k) => (
            <text key={mn} x={L + k * band + band / 2} y={H - 10} fontSize="10" fill={MUTED} textAnchor="middle">{mn}</text>
          ))}
          {MONTHS.map((_, k) => bar(k + 1, a[k + 1], 0, C_NOW, String(year)))}
          {MONTHS.map((_, k) => bar(k + 1, b[k + 1], 1, C_PREV, String(year - 1)))}
          {lastA > 0 && a[lastA] != null && (
            <text x={L + (lastA - 1) * band + band / 2 - bw / 2} y={y(a[lastA]) - 6} fontSize="10" fill={INK} fontWeight="700" textAnchor="middle">{a[lastA].toFixed(0)}%</text>
          )}
          {lastB > 0 && b[lastB] != null && lastB !== lastA && (
            <text x={L + (lastB - 1) * band + band / 2 + bw / 2} y={y(b[lastB]) - 6} fontSize="10" fill={INK} fontWeight="700" textAnchor="middle">{b[lastB].toFixed(0)}%</text>
          )}
        </svg>
      )}
      {table && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
          <thead><tr style={{ color: '#6b7280', textAlign: 'left' }}>
            {['Month', `${year} %`, `${year - 1} %`].map((h) => <th key={h} style={{ padding: '4px 6px' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {MONTHS.map((mn, k) => (
              <tr key={mn} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '4px 6px' }}>{mn}</td>
                <td style={{ padding: '4px 6px' }}>{a[k + 1]?.toFixed(1) ?? '—'}</td>
                <td style={{ padding: '4px 6px' }}>{b[k + 1]?.toFixed(1) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
