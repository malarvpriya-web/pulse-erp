/**
 * STANDARD ERP COMPONENT INTERFACE
 *
 * Every presentational component in this codebase MUST follow this contract:
 *
 * @prop {Array|Object} data       — All data via props, NEVER fetch internally
 * @prop {boolean}      loading    — Show skeleton when true
 * @prop {string|null}  error      — Show error UI when set
 * @prop {Object}       filters    — Active filter state { dept, period, fy }
 * @prop {Object}       meta       — Extra context { title, subtitle, icon, color }
 * @prop {Function}     onAction   — Callback for all user actions
 *   onAction({ type, payload })
 *   Types: see ACTION_TYPES below
 * @prop {Object}       config     — Component behaviour config
 *   config.showExport    — show export button
 *   config.showDrillDown — enable click-through
 *   config.showInsights  — show AI insight panel
 *   config.showForecast  — show prediction overlay
 *   config.showPrescribe — show recommendations panel
 *
 * VIOLATIONS to avoid:
 *   ❌ fetch() or api.get() inside a component
 *   ❌ Hardcoded employee names, amounts, or dates
 *   ❌ Missing loading state
 *   ❌ Missing error state
 *   ❌ Missing empty state
 */

export const DEFAULT_PROPS = {
  data:     null,
  loading:  false,
  error:    null,
  filters:  {},
  meta:     { title: '', subtitle: '', icon: null, color: '#6366f1' },
  onAction: () => {},
  config: {
    showExport:    true,
    showDrillDown: true,
    showInsights:  false,
    showForecast:  false,
    showPrescribe: false,
  },
};

export const ACTION_TYPES = {
  VIEW:        'view',
  EDIT:        'edit',
  DELETE:      'delete',
  APPROVE:     'approve',
  REJECT:      'reject',
  EXPORT:      'export',
  FILTER:      'filter',
  DRILL_DOWN:  'drill_down',
  PRESCRIBE:   'prescribe',
  FORECAST:    'forecast',
  ALERT_ACK:   'alert_acknowledge',
  ALERT_RESOLVE:'alert_resolve',
  NOTIFY:      'notify',
  SCHEDULE:    'schedule',
  NAVIGATE:    'navigate',
};

/**
 * Violation audit helper — call during development to surface interface issues.
 * @param {string} componentName
 * @param {Object} props
 */
export function auditProps(componentName, props) {
  const issues = [];
  if (props.data === undefined)     issues.push('missing `data` prop');
  if (props.loading === undefined)  issues.push('missing `loading` prop');
  if (props.error === undefined)    issues.push('missing `error` prop');
  if (typeof props.onAction !== 'function') issues.push('`onAction` must be a function');
  if (issues.length) {
    console.warn(`[${componentName}] Interface violations:`, issues);
  }
  return issues;
}
