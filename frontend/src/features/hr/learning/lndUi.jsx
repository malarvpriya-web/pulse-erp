// Learning Center — shared UI pieces (2026-11-18): filters (with the 3 / 6 /
// 12-month, quarter and FY windows trainings are planned in), dialogs, an
// employee picker that lists everyone on open, pills, KPI tiles, tables and
// formatting. One look and one behaviour across every L&D page.
import { useEffect, useMemo, useState } from 'react';
import api from '@/services/api/client';
import Dialog from '@/features/recruitment/shared/components/Dialog';
import { fmtDate } from '@/utils/dateFormatter';
import './lnd.css';

export { fmtDate };

export const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: 'last3m', label: 'Last 3 months' },
  { value: 'last6m', label: 'Last 6 months' },
  { value: 'last12m', label: 'Last 12 months' },
  { value: 'qtd', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'fytd', label: 'This financial year' },
  { value: 'last_fy', label: 'Last financial year' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'next3m', label: 'Next 3 months' },
  { value: 'next6m', label: 'Next 6 months' },
  { value: 'custom', label: 'Custom dates…' },
];

export const errText = (e, fallback = 'Something went wrong') =>
  e?.response?.data?.error || e?.response?.data?.message || e?.message || fallback;

export const fmtINR = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};
export const fmtNum = (n, dp = 0) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: dp }));
export const pct = (n) => (n == null ? '—' : `${Math.round(Number(n))}%`);
export const today = () => new Date().toISOString().slice(0, 10);

/** Query string from a filter object (blank values dropped; custom dates only with period=custom). */
export function toQuery(f = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === '' || v == null || v === false) continue;
    if ((k === 'from' || k === 'to') && f.period !== 'custom') continue;
    if (k === 'period' && v === 'custom') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ── status → pill tone ────────────────────────────────────────── */
const TONES = {
  planned: 'brand', ongoing: 'info', completed: 'good', cancelled: '',
  enrolled: 'brand', in_progress: 'info', no_show: 'bad', withdrawn: '',
  active: 'good', expired: 'bad', renewed: '', revoked: 'bad', valid: 'good', missing: 'bad',
  compliant: 'good', due_soon: 'warn', overdue: 'bad', not_done: 'bad',
  pending_review: 'warn', reviewed: 'good', auto: '', passed: 'good', failed: 'bad',
  scheduled: 'brand',
};
const LABELS = { in_progress: 'In progress', no_show: 'No-show', due_soon: 'Due soon', not_done: 'Not done', pending_review: 'Awaiting review' };
export const statusLabel = (s) => LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—');
export function Pill({ status, tone, children }) {
  const t = tone ?? TONES[status] ?? '';
  return <span className={`lnd-pill${t ? ` is-${t}` : ''}`}>{children ?? statusLabel(status)}</span>;
}

export function Kpi({ label, value, sub, tone, onClick }) {
  const cls = `lnd-kpi${tone ? ` is-${tone}` : ''}`;
  const body = (<><div className="lnd-kpi-value">{value}</div><div className="lnd-kpi-label">{label}</div>{sub && <div className="lnd-kpi-sub">{sub}</div>}</>);
  return onClick ? <button type="button" className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="lnd-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id}
          className={`lnd-tab${value === t.id ? ' is-active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}{t.count ? <span className="lnd-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children = 'Nothing to show for these filters.' }) {
  return <div className="lnd-empty">{children}</div>;
}

/* ── filter options (cached for the session) ──────────────────── */
let optionsPromise = null;
export function resetLndOptions() { optionsPromise = null; }
export function useLndOptions() {
  const [opts, setOpts] = useState({ categories: [], departments: [], designations: [], trainers: [], competencies: [], cost_types: [], settings: {} });
  useEffect(() => {
    let live = true;
    optionsPromise = optionsPromise || api.get('/training/filter-options').then(r => r.data).catch(() => { optionsPromise = null; return null; });
    optionsPromise.then(d => { if (live && d && typeof d === 'object' && !Array.isArray(d)) setOpts(p => ({ ...p, ...d, settings: d.settings || {} })); });
    return () => { live = false; };
  }, []);
  return opts;
}

/**
 * The filter bar. `fields` picks which controls show:
 *   period, department, category, status (needs statusOptions), trainer, mandatory, q, …extra
 */
export function Filters({ value, onChange, fields = ['period', 'department', 'category', 'q'], statusOptions, extra, onReset, periods = PERIODS }) {
  const o = useLndOptions();
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="lnd-filters">
      {fields.includes('period') && (
        <label>Period
          <select value={value.period || 'all'} onChange={e => set('period', e.target.value)}>
            {periods.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
      )}
      {fields.includes('period') && value.period === 'custom' && (<>
        <label>From<input type="date" value={value.from || ''} onChange={e => set('from', e.target.value)} /></label>
        <label>To<input type="date" value={value.to || ''} onChange={e => set('to', e.target.value)} /></label>
      </>)}
      {fields.includes('department') && (
        <label>Department
          <select value={value.department || ''} onChange={e => set('department', e.target.value)}>
            <option value="">All departments</option>
            {o.departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      )}
      {fields.includes('category') && (
        <label>Category
          <select value={value.category || ''} onChange={e => set('category', e.target.value)}>
            <option value="">All categories</option>
            {o.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      {fields.includes('status') && statusOptions && (
        <label>Status
          <select value={value.status || ''} onChange={e => set('status', e.target.value)}>
            <option value="">All</option>
            {statusOptions.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </label>
      )}
      {fields.includes('trainer') && (
        <label>Trainer
          <select value={value.trainer_id || ''} onChange={e => set('trainer_id', e.target.value)}>
            <option value="">All trainers</option>
            {o.trainers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {fields.includes('mode') && (
        <label>Mode
          <select value={value.mode || ''} onChange={e => set('mode', e.target.value)}>
            <option value="">All modes</option>
            {['offline', 'online', 'hybrid'].map(m => <option key={m} value={m}>{statusLabel(m)}</option>)}
          </select>
        </label>
      )}
      {fields.includes('mandatory') && (
        <label>Type
          <select value={value.mandatory || ''} onChange={e => set('mandatory', e.target.value)}>
            <option value="">Mandatory + optional</option>
            <option value="true">Mandatory only</option>
            <option value="false">Optional only</option>
          </select>
        </label>
      )}
      {fields.includes('cost') && (<>
        <label>Cost from (₹)<input type="number" min="0" style={{ minWidth: 0, width: 110 }} value={value.cost_min || ''} onChange={e => set('cost_min', e.target.value)} /></label>
        <label>Cost to (₹)<input type="number" min="0" style={{ minWidth: 0, width: 110 }} value={value.cost_max || ''} onChange={e => set('cost_max', e.target.value)} /></label>
      </>)}
      {extra}
      {fields.includes('q') && (
        <label>Search<input type="search" value={value.q || ''} placeholder="Search…" onChange={e => set('q', e.target.value)} /></label>
      )}
      {onReset && <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={onReset}>Reset</button>}
    </div>
  );
}

/* ── dialog ────────────────────────────────────────────────────── */
export function LndDialog({ title, onClose, width = 560, children, footer, error }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <Dialog width={width} overflowY="hidden">
      <div className="lnd-dialog-head"><h3>{title}</h3><button type="button" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="lnd-dialog-body">{error && <div className="lnd-error">{error}</div>}{children}</div>
      {footer && <div className="lnd-dialog-foot">{footer}</div>}
    </Dialog>
  );
}

/* ── employee picker: the whole active list shows on open ─────── */
let employeesPromise = null;
export function useEmployees() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let live = true;
    employeesPromise = employeesPromise || api.get('/training/employees').then(r => r.data || []).catch(() => { employeesPromise = null; return []; });
    employeesPromise.then(d => { if (live) setList(Array.isArray(d) ? d : []); });
    return () => { live = false; };
  }, []);
  return list;
}

export function EmployeePicker({ value = [], onChange, exclude = [], multi = true }) {
  const all = useEmployees();
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const excludeSet = useMemo(() => new Set(exclude), [exclude]);
  const depts = useMemo(() => [...new Set(all.map(e => e.department).filter(Boolean))].sort(), [all]);
  const shown = all.filter(e => !excludeSet.has(e.id) && (!dept || e.department === dept)
    && (!q || `${e.name} ${e.office_id || ''} ${e.designation || ''}`.toLowerCase().includes(q.toLowerCase())));
  const sel = new Set(value);
  const toggle = (id) => {
    if (!multi) return onChange([id]);
    const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); onChange([...n]);
  };
  return (
    <div className="lnd-picker">
      <div className="lnd-picker-bar">
        <input type="search" placeholder="Search name, code, designation" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        <select value={dept} onChange={e => setDept(e.target.value)}>
          <option value="">All departments</option>
          {depts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {multi && <button type="button" className="lnd-link" onClick={() => onChange([...new Set([...value, ...shown.map(e => e.id)])])}>Select all shown</button>}
        {multi && value.length > 0 && <button type="button" className="lnd-link" onClick={() => onChange([])}>Clear ({value.length})</button>}
      </div>
      <div className="lnd-picker-list">
        {shown.map(e => (
          <label key={e.id} className="lnd-picker-row">
            <input type={multi ? 'checkbox' : 'radio'} checked={sel.has(e.id)} onChange={() => toggle(e.id)} />
            <span>{e.name}</span><small>{[e.office_id, e.department, e.designation].filter(Boolean).join(' · ')}</small>
          </label>
        ))}
        {!shown.length && <div className="lnd-empty">No employees match.</div>}
      </div>
    </div>
  );
}

/** A single-employee <select> (plain dropdown — opens its whole list). */
export function EmployeeSelect({ value, onChange, placeholder = 'Choose employee', required }) {
  const all = useEmployees();
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : '')} required={required}>
      <option value="">{placeholder}</option>
      {all.map(e => <option key={e.id} value={e.id}>{e.name}{e.office_id ? ` (${e.office_id})` : ''}{e.department ? ` — ${e.department}` : ''}</option>)}
    </select>
  );
}

/* ── CSV export of what is on screen ──────────────────────────── */
export function downloadCsv(rows, name, columns) {
  if (!rows?.length) return;
  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k.replace(/_/g, ' ') }));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(c => esc(c.label)).join(','), ...rows.map(r => cols.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Stars for a 1–5 rating. */
export const stars = (n) => (n ? '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)) : '—');

export const LEVEL_LABEL = { 1: 'Novice', 2: 'Developing', 3: 'Proficient', 4: 'Advanced', 5: 'Expert' };
export function Level({ level, gap, onClick, title }) {
  const cls = `lnd-level l${level || 0}${gap ? ' is-gap' : ''}`;
  const t = title || (level ? `L${level} ${LEVEL_LABEL[level]}` : 'Not rated');
  return onClick
    ? <button type="button" className={cls} title={t} onClick={onClick}>{level || '—'}</button>
    : <span className={cls} title={t}>{level || '—'}</span>;
}
