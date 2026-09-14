import { Filter, X } from 'lucide-react';
import { PERIOD_OPTIONS } from '@/hooks/useDashboardFilters';
import './pulse-ui.css';

/**
 * DashboardFilterBar — the single filter control for dashboard pages.
 *
 * Fully controlled by `useDashboardFilters`; it holds no state of its own.
 * Pass the hook's return value straight through as `filters`.
 *
 * This replaces the per-dashboard hand-rolled selects and period tabs.
 * `components/GlobalFilterBar.jsx` was an earlier attempt with no importers at
 * all (and a hardcoded department list that didn't match live data) — deleted
 * once this rollout finished, along with its equally unused FilterContext.
 * `components/core/FilterBar.jsx` is a *table* filter bar (search + export) used
 * by AllCandidates.jsx — leave that one where it is; it is not for dashboards.
 *
 * @example
 *   const filters = useDashboardFilters({
 *     defaultPeriod: 'fytd',
 *     dimensions: { department: 'all' },
 *     storageKey: 'quality-dashboard',
 *   });
 *   <DashboardFilterBar
 *     filters={filters}
 *     dimensions={[{ key: 'department', label: 'Department', options: deptOptions }]}
 *     actions={<button className="pulse-btn-secondary" onClick={load}>Refresh</button>}
 *   />
 *
 * @param {object} props
 * @param {ReturnType<import('@/hooks/useDashboardFilters').default>} props.filters
 * @param {Array<{key:string,label:string,options:Array<{value:string,label:string}>,allLabel?:string,width?:number}>} [props.dimensions]
 *   module dimensions, in display order. An "All …" entry is prepended
 *   automatically — options should contain only real values.
 * @param {boolean} [props.showPeriod=true] hide on dashboards that are purely
 *   point-in-time (stock on hand) and only take dimensions.
 * @param {string}  [props.periodLabel='Period']
 * @param {React.ReactNode} [props.actions] right-aligned slot (Refresh, Export…).
 */
export default function DashboardFilterBar({
  filters,
  dimensions = [],
  showPeriod = true,
  periodLabel = 'Period',
  actions,
}) {
  const {
    period, setPeriod,
    from, setFrom, to, setTo,
    dimensions: values, setDimension,
    activeCount, reset,
  } = filters;

  return (
    <div className="pl-filterbar" role="group" aria-label="Dashboard filters">
      <Filter size={14} className="pl-filterbar-ico" aria-hidden="true" />

      {showPeriod && (
        <label className="pl-filterbar-field">
          <span className="pl-filterbar-label">{periodLabel}</span>
          <select
            className="pl-filterbar-input"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {PERIOD_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      )}

      {showPeriod && period === 'custom' && (
        <>
          <label className="pl-filterbar-field">
            <span className="pl-filterbar-label">From</span>
            <input
              type="date"
              className="pl-filterbar-input"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="pl-filterbar-field">
            <span className="pl-filterbar-label">To</span>
            <input
              type="date"
              className="pl-filterbar-input"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </>
      )}

      {dimensions.map(d => (
        <label key={d.key} className="pl-filterbar-field">
          <span className="pl-filterbar-label">{d.label}</span>
          <select
            className="pl-filterbar-input"
            style={d.width ? { minWidth: d.width } : undefined}
            value={values?.[d.key] ?? 'all'}
            onChange={(e) => setDimension(d.key, e.target.value)}
          >
            <option value="all">{d.allLabel || `All ${d.label}`}</option>
            {(d.options || []).map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      ))}

      {activeCount > 0 && (
        <button type="button" className="pl-filterbar-reset" onClick={reset}>
          <X size={12} aria-hidden="true" />
          Reset
          <span className="pl-filterbar-badge">{activeCount}</span>
        </button>
      )}

      {actions && <div className="pl-filterbar-actions">{actions}</div>}
    </div>
  );
}
