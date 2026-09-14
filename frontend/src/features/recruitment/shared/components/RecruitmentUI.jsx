import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import '../recruitment-ui.css';

/**
 * Shared presentational primitives for the Recruitment module.
 *
 * These exist so every page expresses the same states the same way. The
 * important one is the KPI/error split: the 2026-08-12 live-data audit found
 * three pages rendering a failed API call as a literal "0", which reads to the
 * user as a real business number. `<Kpi>` renders an explicit "—" plus a
 * possibly-stale marker instead, and `<ErrorNote>` gives the retry affordance.
 */

/* ── Page shell ─────────────────────────────────────────────────────────── */
export function PageHeader({ title, subtitle, actions, onBack, backLabel = 'Back' }) {
  return (
    <div className="rec-header">
      <div>
        {onBack && (
          <button type="button" className="rec-back-link" onClick={onBack}>
            ← {backLabel}
          </button>
        )}
        <h1 className="rec-title">{title}</h1>
        {subtitle && <p className="rec-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="rec-header-actions">{actions}</div>}
    </div>
  );
}

export function RefreshButton({ onClick, loading, label = 'Refresh' }) {
  return (
    <button type="button" className="rec-btn-ghost" onClick={onClick} disabled={loading}>
      <RefreshCw size={15} className={loading ? 'rec-spin' : ''} /> {label}
    </button>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="rec-tabs" role="tablist">
      {tabs.map(t => {
        const key = t.key ?? t;
        const label = t.label ?? t;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={`rec-tab${active === key ? ' rec-tab-active' : ''}`}
            onClick={() => onChange(key)}
          >
            {label}{t.count != null && ` (${t.count})`}
          </button>
        );
      })}
    </div>
  );
}

/* ── KPI ────────────────────────────────────────────────────────────────── */
/**
 * `value` of null/undefined renders as "—", never as 0. Pass a real 0 to show
 * a genuine zero — that distinction is the whole point of this component.
 */
export function Kpi({ icon, iconBg, label, value, sub, suffix = '', unavailable = false }) {
  const missing = unavailable || value === null || value === undefined;
  return (
    <div className="rec-kpi-card">
      {icon && <div className="rec-kpi-icon" style={{ background: iconBg }}>{icon}</div>}
      <div style={{ minWidth: 0 }}>
        {missing
          ? <div className="rec-kpi-val-unavailable" title="This figure could not be loaded">Unavailable</div>
          : <div className="rec-kpi-val">{value}{suffix}</div>}
        <div className="rec-kpi-label">{label}</div>
        {sub && !missing && <div className="rec-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function KpiRow({ children }) {
  return <div className="rec-kpi-row">{children}</div>;
}

/* ── States ─────────────────────────────────────────────────────────────── */
export function ErrorNote({ message, onRetry, title = "Couldn't load this data" }) {
  if (!message) return null;
  return (
    <div className="rec-error" role="alert">
      <AlertTriangle size={17} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <span className="rec-error-title">{title}</span>
        <span>{message}</span>
      </div>
      {onRetry && (
        <button type="button" className="rec-error-retry" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="rec-empty">
      <div className="rec-empty-icon">{icon || <Inbox size={30} strokeWidth={1.5} />}</div>
      <div className="rec-empty-title">{title}</div>
      {hint && <div className="rec-empty-hint">{hint}</div>}
      {action}
    </div>
  );
}

export function SkeletonKpis({ count = 5 }) {
  return (
    <div className="rec-kpi-row">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rec-skeleton rec-skeleton-kpi" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 6 }) {
  return (
    <div style={{ padding: 4 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rec-skeleton rec-skeleton-row" />
      ))}
    </div>
  );
}

/* ── Badges ─────────────────────────────────────────────────────────────── */
const BADGE_TONE = {
  success: 'rec-badge-success', warn: 'rec-badge-warn', danger: 'rec-badge-danger',
  info: 'rec-badge-info', brand: 'rec-badge-brand', neutral: 'rec-badge-neutral',
};
export function Badge({ tone = 'neutral', children, style }) {
  return <span className={`rec-badge ${BADGE_TONE[tone] || BADGE_TONE.neutral}`} style={style}>{children}</span>;
}

/* ── Card ───────────────────────────────────────────────────────────────── */
export function Card({ title, subtitle, actions, children, className = '', style }) {
  return (
    <div className={`rec-card ${className}`} style={style}>
      {(title || actions) && (
        <div className="rec-card-head">
          <div>
            {title && <h2 className="rec-card-title">{title}</h2>}
            {subtitle && <div className="rec-card-sub">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
