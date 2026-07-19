/* PulseViz — shared data-visualization kit (prefix: pv-)
 * Brand-consistent chart primitives built on recharts + SVG.
 * Blue/teal/amber here are chart-series colors (allowed by convention);
 * primary emphasis is always brand purple.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  PieChart, Pie, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import './PulseViz.css';

export const PULSE_SERIES = [
  '#6B3FDB', '#2563eb', '#10b981', '#f59e0b',
  '#ef4444', '#14b8a6', '#8b5cf6', '#f97316',
];

export const fmtINRShort = (n) => {
  const num = parseFloat(n);
  if (!num || isNaN(num)) return '₹0';
  if (Math.abs(num) >= 1e7) return `₹${(num / 1e7).toFixed(1)}Cr`;
  if (Math.abs(num) >= 1e5) return `₹${(num / 1e5).toFixed(1)}L`;
  if (Math.abs(num) >= 1000) return `₹${(num / 1000).toFixed(1)}K`;
  return `₹${Math.round(num)}`;
};

/* ── useCountUp — animates a number from 0 to value once it arrives ── */
export function useCountUp(value, duration = 900) {
  const [display, setDisplay] = useState(0);
  const raf = useRef(null);
  useEffect(() => {
    const target = parseFloat(value) || 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(target * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return display;
}

/* ── Shared tooltip ── */
function PvTooltip({ active, payload, label, valueFormatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="pv-tooltip">
      {label != null && <div className="pv-tooltip-label">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="pv-tooltip-row">
          <span className="pv-tooltip-dot" style={{ background: p.color || p.fill }} />
          <span className="pv-tooltip-name">{p.name}</span>
          <span className="pv-tooltip-val">
            {valueFormatter ? valueFormatter(p.value) : p.value?.toLocaleString?.('en-IN') ?? p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── VizCard — card shell with loading shimmer + empty state ── */
export function VizCard({ title, icon, subtitle, action, loading, empty, emptyText = 'No data yet', children, className = '', style }) {
  return (
    <div className={`pv-card ${className}`} style={style}>
      <div className="pv-card-hd">
        <div className="pv-card-title-wrap">
          {icon && <span className="pv-card-icon">{icon}</span>}
          <div>
            <div className="pv-card-title">{title}</div>
            {subtitle && <div className="pv-card-sub">{subtitle}</div>}
          </div>
        </div>
        {action}
      </div>
      <div className="pv-card-body">
        {loading
          ? <div className="pv-shimmer" />
          : empty
            ? <div className="pv-empty">{emptyText}</div>
            : children}
      </div>
    </div>
  );
}

/* ── TrendArea — gradient area chart for time series ── */
export function TrendArea({ data, xKey = 'label', yKey = 'value', color = '#6B3FDB', height = 200, currency = false, name = 'Value', compareKey, compareName = 'Previous' }) {
  const gid = `pvg-${useId().replace(/:/g, '')}`;
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#eceafb" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} tickFormatter={fmt} width={52} />
        <Tooltip content={<PvTooltip valueFormatter={fmt} />} />
        {compareKey && (
          <Area type="monotone" dataKey={compareKey} name={compareName}
            stroke="#c4b5fd" strokeWidth={1.5} strokeDasharray="4 3" fill="none" dot={false} />
        )}
        <Area type="monotone" dataKey={yKey} name={name}
          stroke={color} strokeWidth={2.5} fill={`url(#${gid})`}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ── RoundBars — vertical bars, rounded tops, multi-color option ── */
export function RoundBars({ data, xKey = 'label', yKey = 'value', height = 200, currency = false, name = 'Value', multiColor = false, color = '#6B3FDB' }) {
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eceafb" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} tickFormatter={fmt} width={52} />
        <Tooltip content={<PvTooltip valueFormatter={fmt} />} cursor={{ fill: 'rgba(107,63,219,.05)' }} />
        <Bar dataKey={yKey} name={name} radius={[6, 6, 0, 0]} maxBarSize={38}>
          {data.map((_, i) => (
            <Cell key={i} fill={multiColor ? PULSE_SERIES[i % PULSE_SERIES.length] : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── StackedBars — vertical bars stacked by category (e.g. hours per week by project) ── */
export function StackedBars({ data, xKey = 'label', categories = [], height = 220, currency = false, maxBarSize = 26, legend = true }) {
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eceafb" vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tick={{ fontSize: 10, fill: '#8b8fa3' }} axisLine={false} tickLine={false} tickFormatter={fmt} width={52} />
          <Tooltip content={<PvTooltip valueFormatter={fmt} />} cursor={{ fill: 'rgba(107,63,219,.05)' }} />
          {categories.map((cat, i) => (
            <Bar key={cat} dataKey={cat} name={cat} stackId="s"
              fill={PULSE_SERIES[i % PULSE_SERIES.length]} maxBarSize={maxBarSize}
              radius={i === categories.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {legend && categories.length > 0 && (
        <div className="pv-legend" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          {categories.map((cat, i) => (
            <div key={cat} className="pv-legend-row" style={{ width: 'auto' }}>
              <span className="pv-legend-dot" style={{ background: PULSE_SERIES[i % PULSE_SERIES.length] }} />
              <span className="pv-legend-name" title={cat} style={{ maxWidth: 160 }}>{cat}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Donut — pie with hollow center + total label ── */
export function Donut({ data, nameKey = 'name', valueKey = 'value', height = 200, centerLabel, centerValue, currency = false, colors = PULSE_SERIES }) {
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  const total = data.reduce((s, d) => s + (parseFloat(d[valueKey]) || 0), 0);
  return (
    <div className="pv-donut-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<PvTooltip valueFormatter={fmt} />} />
          <Pie data={data} dataKey={valueKey} nameKey={nameKey}
            innerRadius="62%" outerRadius="88%" paddingAngle={2}
            stroke="#fff" strokeWidth={2}>
            {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pv-donut-center">
        <div className="pv-donut-val">{centerValue ?? fmt(total)}</div>
        {centerLabel && <div className="pv-donut-lbl">{centerLabel}</div>}
      </div>
    </div>
  );
}

/* ── DonutLegend — compact legend rows for a Donut ── */
export function DonutLegend({ data, nameKey = 'name', valueKey = 'value', currency = false, max = 6, colors = PULSE_SERIES }) {
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  return (
    <div className="pv-legend">
      {data.slice(0, max).map((d, i) => (
        <div key={i} className="pv-legend-row">
          <span className="pv-legend-dot" style={{ background: colors[i % colors.length] }} />
          <span className="pv-legend-name" title={d[nameKey]}>{d[nameKey]}</span>
          <span className="pv-legend-val">{fmt(d[valueKey])}</span>
        </div>
      ))}
    </div>
  );
}

/* ── HBarList — ranked horizontal bars (top customers, vendors…) ── */
export function HBarList({ data, nameKey = 'name', valueKey = 'value', currency = false, color = '#6B3FDB', max = 5 }) {
  const fmt = currency ? fmtINRShort : (v) => v?.toLocaleString?.('en-IN') ?? v;
  const top = data.slice(0, max);
  const peak = Math.max(...top.map(d => parseFloat(d[valueKey]) || 0), 1);
  return (
    <div className="pv-hbars">
      {top.map((d, i) => {
        const pct = Math.max(((parseFloat(d[valueKey]) || 0) / peak) * 100, 2);
        return (
          <div key={i} className="pv-hbar-row">
            <div className="pv-hbar-meta">
              <span className="pv-hbar-rank">{i + 1}</span>
              <span className="pv-hbar-name" title={d[nameKey]}>{d[nameKey]}</span>
              <span className="pv-hbar-val">{fmt(d[valueKey])}</span>
            </div>
            <div className="pv-hbar-track">
              <div className="pv-hbar-fill" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}cc, ${color})`, animationDelay: `${i * 90}ms` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── ProgressRing — animated SVG radial gauge ── */
export function ProgressRing({ value = 0, size = 92, stroke = 9, color = '#6B3FDB', track = 'rgba(107,63,219,.12)', label, sublabel, textColor }) {
  const pct = Math.min(Math.max(parseFloat(value) || 0, 0), 100);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="pv-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c}
          strokeDashoffset={c - (pct / 100) * c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="pv-ring-arc" />
      </svg>
      <div className="pv-ring-center" style={textColor ? { color: textColor } : undefined}>
        <span className="pv-ring-val">{label ?? `${Math.round(pct)}%`}</span>
        {sublabel && <span className="pv-ring-sub">{sublabel}</span>}
      </div>
    </div>
  );
}

/* ── Sparkline — tiny axis-free trend, for KPI cards ── */
export function Sparkline({ data, yKey = 'value', color = '#6B3FDB', height = 36, width = '100%' }) {
  const gid = `pvs-${useId().replace(/:/g, '')}`;
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={yKey} stroke={color} strokeWidth={2}
            fill={`url(#${gid})`} dot={false} isAnimationActive />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
