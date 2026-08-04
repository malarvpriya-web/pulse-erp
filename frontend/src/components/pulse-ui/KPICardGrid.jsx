import './pulse-ui.css';

/**
 * KPICardGrid — auto-fit responsive grid of KPICards with a staggered
 * entrance animation (prefers-reduced-motion guarded). Visually mirrors
 * dashboard/dashkit.css's .dk-kpis/.dk-kpi spec so a future dashboard
 * rollout can adopt this as a pixel-identical no-op, without importing
 * dashkit.css directly (dashboards are a separate, later rollout).
 *
 * <KPICardGrid loading={loading}>
 *   <KPICard icon={Package} label="Total SKUs" value={1204} sub="+12 this month" />
 *   <KPICard icon={AlertTriangle} label="Low Stock" value={18} tone="warning" onClick={...} />
 * </KPICardGrid>
 *
 * @param {object} props
 * @param {React.ReactNode} props.children one or more <KPICard>
 * @param {boolean} [props.loading]
 * @param {number} [props.count=4] skeleton count when loading
 * @param {string} [props.className]
 */
export function KPICardGrid({ children, loading = false, count = 4, className = '' }) {
  return (
    <div className={`pl-kpis${className ? ` ${className}` : ''}`}>
      {loading
        ? Array.from({ length: count }, (_, i) => (
            <div key={i} className="pl-kpi" style={{ '--pl-i': i }}>
              <div className="pl-kpi-top">
                <span className="pl-skel" style={{ width: 28, height: 28, borderRadius: 8 }} />
                <span className="pl-skel" style={{ width: '50%', height: 10 }} />
              </div>
              <div className="pl-skel pl-kpi-sk" />
            </div>
          ))
        : children}
    </div>
  );
}

/**
 * @param {object} props
 * @param {React.ComponentType} [props.icon] lucide icon component
 * @param {string} props.label
 * @param {string|number} props.value
 * @param {string} [props.sub]
 * @param {'default'|'success'|'warning'|'danger'|'info'} [props.tone='default']
 * @param {Function} [props.onClick] adds hover-lift + pointer cursor
 * @param {number} [props.index] stagger delay index (defaults to DOM order via CSS)
 */
export function KPICard({ icon: Icon, label, value, sub, tone = 'default', onClick, index }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`pl-kpi${onClick ? ' pl-clickable' : ''}`}
      onClick={onClick}
      style={index != null ? { '--pl-i': index } : undefined}
    >
      <div className="pl-kpi-top">
        {Icon && (
          <span className={`pl-kpi-ico pl-tone-${tone}`}>
            <Icon size={15} aria-hidden="true" />
          </span>
        )}
        <span className="pl-kpi-label">{label}</span>
      </div>
      <div className="pl-kpi-val">{value}</div>
      {sub && <div className="pl-kpi-sub">{sub}</div>}
    </Tag>
  );
}
