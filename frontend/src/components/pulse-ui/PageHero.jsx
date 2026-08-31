import './pulse-hero.css';

/**
 * PageShell — page root with a FROZEN top strip.
 *
 * Whatever goes in `dock` (the hero, and usually a filter bar) stays pinned to
 * the top of the viewport; `children` scroll underneath it.
 *
 *   <PageShell dock={<>
 *     <PageHero icon={Gauge} title="Quality Dashboard" … />
 *     <DashboardFilterBar filters={filters} />
 *   </>}>
 *     …page body…
 *   </PageShell>
 *
 * Use this INSTEAD of `.pulse-page` / `<PageLayout>` on hero pages — it cancels
 * `.page-content`'s 20px padding rather than nesting inside it, which is both
 * what makes `top: 0` dock flush (manual §115) and what removes the doubled
 * 44px of dead space at the top of every page.
 *
 * @param {object} props
 * @param {React.ReactNode} props.dock frozen strip — hero, filter bar
 * @param {React.ReactNode} props.children scrolling page body
 * @param {string} [props.className] extra class(es) on the root
 * @param {object} [rest] anything else lands on the root element. Pages that
 *   put a click-away `onClick` on their page root need it to survive the
 *   conversion — without this passthrough it was silently dropped.
 */
export function PageShell({ dock, children, className = '', ...rest }) {
  return (
    <div className={`plh-page${className ? ` ${className}` : ''}`} {...rest}>
      {dock && <div className="plh-dock">{dock}</div>}
      <div className="plh-body">{children}</div>
    </div>
  );
}

/**
 * PageHero — the canonical Pulse page header: a purple gradient command band
 * with an icon chip, title, subtitle, inline meta stats and right-hand
 * actions / frosted KPI tiles.
 *
 * This is the signed-off design language, taken from System Health Monitor
 * (features/admin/pages/SystemHealth.jsx) and the Home hero (pages/Home.css).
 * Home itself is LOCKED per CLAUDE.md — this component re-implements the same
 * look under the `plh-` prefix so every other page can adopt it.
 *
 *   <PageHero
 *     icon={ShieldCheck}
 *     title="NCR Management"
 *     subtitle="Non-conformance reports across quality, procurement & production"
 *     meta={[
 *       { label: 'open', value: 12, tone: 'bad' },
 *       { label: 'closed this month', value: 48, tone: 'good' },
 *     ]}
 *     tiles={[{ label: 'Critical', value: 3, onClick: … }]}
 *     actions={<button className="plh-cta">+ Raise NCR</button>}
 *   />
 *
 * @param {object} props
 * @param {React.ComponentType} [props.icon] lucide icon for the chip
 * @param {string} props.title
 * @param {string} [props.eyebrow] small caps label above the title
 * @param {React.ReactNode} [props.subtitle]
 * @param {Array<{label:string,value:React.ReactNode,tone?:'good'|'warn'|'bad'}>} [props.meta]
 *   inline stat run under the subtitle — `value` renders bold/coloured.
 * @param {Array<{label:string,value:React.ReactNode,onClick?:Function,title?:string}>} [props.tiles]
 *   frosted-glass KPI tiles on the right (the Home hero pattern).
 * @param {React.ReactNode} [props.actions] buttons — use `.plh-cta` /
 *   `.plh-cta plh-cta--ghost` / `.plh-icon-btn`.
 * @param {'violet'|'midnight'|'teal'|'emerald'|'amber'|'rose'|'slate'|'indigo'} [props.tone='violet']
 *   gradient family. ★ App-wide decision (2026-08-20): every page uses the
 *   default `violet` — do not pass this prop. The other gradients ship but
 *   are dormant; see heroTones.js before reaching for one.
 * @param {string} [props.className]
 */
export default function PageHero({
  icon: Icon,
  title,
  eyebrow,
  subtitle,
  meta,
  tiles,
  actions,
  tone = 'violet',
  className = '',
}) {
  return (
    <div className={`plh-hero plh-hero--${tone}${className ? ` ${className}` : ''}`}>
      <div className="plh-hero-l">
        {Icon && (
          <span className="plh-hero-icon">
            <Icon size={22} aria-hidden="true" />
          </span>
        )}
        <div className="plh-hero-txt">
          {eyebrow && <span className="plh-eyebrow">{eyebrow}</span>}
          <h1 className="plh-title">{title}</h1>
          {subtitle && <p className="plh-sub">{subtitle}</p>}
          {meta && meta.length > 0 && (
            <div className="plh-meta">
              {meta.map((m, i) => (
                <span key={i} className={`plh-meta-item${m.tone ? ` is-${m.tone}` : ''}`}>
                  <strong>{m.value}</strong> {m.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {(tiles?.length > 0 || actions) && (
        <div className="plh-hero-r">
          {tiles?.length > 0 && (
            <div className="plh-tiles">
              {tiles.map((t, i) => {
                const Tag = t.onClick ? 'button' : 'div';
                return (
                  <Tag
                    key={i}
                    type={t.onClick ? 'button' : undefined}
                    className="plh-tile"
                    onClick={t.onClick}
                    title={t.title}
                  >
                    <span className="plh-tile-val">{t.value}</span>
                    <span className="plh-tile-label">{t.label}</span>
                  </Tag>
                );
              })}
            </div>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * StatBand — the row of white metric cards that sits directly under the hero
 * (System Health's 6-up KPI row). Pass `cols` to lock a column count, or
 * leave it auto-fit.
 *
 *   <StatBand cols={4}>
 *     <Stat icon={Package} label="Total SKUs" value={1204} tone="primary" />
 *   </StatBand>
 *
 * @param {object} props
 * @param {React.ReactNode} props.children one or more <Stat>
 * @param {2|3|4|5|6} [props.cols] fixed column count (omit for auto-fit)
 * @param {string} [props.className]
 */
export function StatBand({ children, cols, className = '' }) {
  return (
    <div className={`plh-stats${cols ? ` plh-stats--${cols}` : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

/**
 * Stat — one white metric card: tinted icon chip + caps label + big value.
 *
 * @param {object} props
 * @param {React.ComponentType} [props.icon] lucide icon
 * @param {string} props.label
 * @param {React.ReactNode} props.value
 * @param {string} [props.sub] small caption under the value
 * @param {'primary'|'success'|'warning'|'danger'|'info'|'neutral'|'teal'} [props.tone='primary']
 * @param {Function} [props.onClick] renders as a button with hover-lift
 * @param {number} [props.index] stagger index for the entrance animation
 * @param {string} [props.color] explicit chip colour, overriding `tone`. Exists
 *   so the per-page `KpiCard` components dotted around the app can delegate
 *   here without losing the specific colour they were passing.
 * @param {string} [props.bg] explicit chip background to pair with `color`.
 *   Defaults to a 12%-alpha wash of `color`.
 * @param {number} [props.trend] percentage change; renders a signed chip.
 * @param {boolean} [props.warn] flags the value as needing attention.
 * @param {boolean} [props.loading] renders a skeleton instead of the value.
 */
export function Stat({
  icon: Icon, label, value, sub, tone = 'primary', onClick, index = 0,
  color, bg, trend, warn, loading, className = '',
}) {
  const Tag = onClick ? 'button' : 'div';
  // `color` given but no `bg` → derive a light wash so callers only pass one.
  const chipStyle = color
    ? { color, background: bg || `color-mix(in srgb, ${color} 12%, transparent)` }
    : undefined;

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`plh-stat${className ? ` ${className}` : ''}`}
      onClick={onClick}
      style={{ animationDelay: `${index * 45}ms` }}
    >
      {Icon && (
        <span
          className={`plh-stat-ico${color ? '' : ` plh-tone-${tone}`}`}
          style={chipStyle}
        >
          <Icon size={16} aria-hidden="true" />
        </span>
      )}
      <div className="plh-stat-txt">
        <div className="plh-stat-label">{label}</div>
        <div className="plh-stat-val" style={warn ? { color: '#b91c1c' } : undefined}>
          {loading ? <span className="plh-skel" /> : value}
        </div>
        {(sub || trend != null) && (
          <div className="plh-stat-sub">
            {trend != null && (
              <span className={`plh-trend${trend < 0 ? ' is-down' : ''}`}>
                {trend > 0 ? '▲' : trend < 0 ? '▼' : '—'} {Math.abs(trend)}%
              </span>
            )}
            {sub}
          </div>
        )}
      </div>
    </Tag>
  );
}

/**
 * MeterCard — a labelled progress bar card (System Health's "Connectivity
 * Health" / "Data Coverage" pair). Accepts either a single `value` or a
 * `segments` array for a stacked bar.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {number} [props.value] 0–100; ignored when `segments` is given
 * @param {string} [props.caption] right-aligned text in the header row
 * @param {'success'|'warning'|'danger'|'primary'|'info'} [props.tone]
 *   fill colour. Omitted + `value` given ⇒ auto (≥95 success, ≥80 warning,
 *   else danger).
 * @param {Array<{pct:number,tone:string}>} [props.segments] stacked fills
 * @param {Array<{label:string,value:React.ReactNode,color?:string}>} [props.legend]
 */
export function MeterCard({ title, value = 0, caption, tone, segments, legend }) {
  const autoTone = value >= 95 ? 'success' : value >= 80 ? 'warning' : 'danger';
  const fillTone = tone || autoTone;
  const capColor =
    fillTone === 'success' ? '#16a34a' :
    fillTone === 'warning' ? '#6d28d9' :
    fillTone === 'danger'  ? '#dc2626' :
    fillTone === 'info'    ? '#0891b2' : '#6B3FDB';

  return (
    <div className="plh-meter">
      <div className="plh-meter-hd">
        <span className="plh-meter-title">{title}</span>
        <span className="plh-meter-pct" style={{ color: capColor }}>
          {caption ?? `${Math.round(value)}%`}
        </span>
      </div>
      <div className="plh-meter-track">
        {segments?.length
          ? segments.map((s, i) => (
              <div
                key={i}
                className={`plh-meter-fill plh-meter-fill--${s.tone}`}
                style={{ width: `${Math.max(0, Math.min(100, s.pct))}%` }}
              />
            ))
          : (
            <div
              className={`plh-meter-fill plh-meter-fill--${fillTone}`}
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            />
          )}
      </div>
      {legend?.length > 0 && (
        <div className="plh-meter-legend">
          {legend.map((l, i) => (
            <span key={i}>
              <strong style={l.color ? { color: l.color } : undefined}>{l.value}</strong> {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * MeterGrid — responsive wrapper for a row of <MeterCard>.
 */
export function MeterGrid({ children, className = '' }) {
  return <div className={`plh-meters${className ? ` ${className}` : ''}`}>{children}</div>;
}

/**
 * SectionTitle — the small purple-bar caps heading used between page bands.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children the label
 * @param {boolean} [props.rule=false] draw a fading hairline to the right
 */
export function SectionTitle({ children, rule = false }) {
  return (
    <div className="plh-section">
      {children}
      {rule && <span className="plh-section-line" />}
    </div>
  );
}
