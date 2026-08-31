/**
 * analyticsAuthz.js — Authorization for the Analytics & AI read surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/analytics`, `/dashboard` and `/ai` were mounted with `verifyToken` and nothing
 * else — 72 endpoints whose only requirement was "is logged in". That included
 * `/dashboard/cfo` (full P&L, cash position, AR/AP, burn rate, runway),
 * `/analytics/salary-bands` and `/analytics/hr-benchmarks` (mean, median, P25 and
 * P75 salary), and `/analytics/top-performers` (named employees with their
 * performance ratings). The sidebar hid those pages from most roles, but nav
 * gating is client-side and is not an access control — any authenticated user
 * could read the data straight from the API.
 *
 * Rather than annotate 72 routes by hand and leave the next new route unguarded
 * by default, this module gates at the mount point using a path-prefix policy
 * with a **deny-by-default fallback**: any path not matched by a rule falls back
 * to the router's declared default permission, so a route added tomorrow inherits
 * a guard instead of shipping open.
 *
 * Each rule maps a path prefix to the `requirePermission(module, action)` the
 * underlying data would require if the user opened the owning module directly —
 * salary data needs `payroll:view` exactly as the Payroll module does, financial
 * statements need `finance:view`, and so on. This keeps one permission model
 * across the app instead of inventing an "analytics" permission that would drift.
 */
import { requirePermission } from '../middlewares/auth.middleware.js';
import { POLICY_RULES as REPORT_POLICY_RULES } from '../modules/reports/reportCatalog.js';

/**
 * Build a mount-level guard from an ordered prefix policy.
 *
 * @param {Array<[string, string, string]>} rules  [pathPrefix, module, action]
 *        Matched in order; first prefix wins, so put specific paths first.
 * @param {[string, string]} fallback  [module, action] applied to anything unmatched.
 */
export function permissionByPath(rules, fallback) {
  // Pre-build the middleware for each distinct (module, action) so we are not
  // constructing closures per request.
  const built = new Map();
  const guardFor = (mod, act) => {
    const key = `${mod}:${act}`;
    if (!built.has(key)) built.set(key, requirePermission(mod, act));
    return built.get(key);
  };

  const compiled = rules.map(([prefix, mod, act]) => [prefix, guardFor(mod, act)]);
  const fallbackGuard = guardFor(fallback[0], fallback[1]);

  return (req, res, next) => {
    // req.path here is relative to the mount point (e.g. '/salary-bands').
    const path = req.path || '/';
    for (const [prefix, guard] of compiled) {
      if (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) {
        return guard(req, res, next);
      }
    }
    return fallbackGuard(req, res, next);
  };
}

/**
 * /analytics — mostly HR and workforce analytics, plus a small finance/CEO slice.
 *
 * Default is `hr:view`: the bulk of this router reads `employees`, so an
 * unmatched new route lands on the strictest sensible guard rather than none.
 */
export const analyticsPolicy = permissionByPath([
  // Compensation — same bar as opening Payroll.
  ['/salary-bands',     'payroll',  'view'],
  ['/hr-benchmarks',    'payroll',  'view'],   // carries median/P25/P75 salary
  // Named individuals with their performance ratings.
  //
  // NOT `performance:view` — every employee holds that, because it is what lets
  // them open their own appraisal. This endpoint returns a company-wide
  // leaderboard of named colleagues and their scores, which is people data, so it
  // takes the same bar as the rest of the employee master.
  ['/top-performers',   'hr', 'view'],
  // Aggregate satisfaction score only, no individuals — performance is the right bar.
  ['/satisfaction',     'performance', 'view'],
  // Company-wide commercial figures.
  ['/ceo',              'finance',  'view'],
  ['/revenue',          'finance',  'view'],
  ['/sales',            'crm',      'view'],
  // Recruitment funnel.
  ['/offer-acceptance', 'recruitment', 'view'],
  ['/time-to-hire',     'recruitment', 'view'],
  // Sub-routers with their own domain.
  ['/pq',               'production', 'view'],
  ['/manufacturing',    'production', 'view'],
], ['hr', 'view']);

/**
 * /dashboard — cross-module summary reads.
 *
 * Default is `reports:view`, the permission that already governs "may this user
 * see aggregated cross-module output". Celebrations are deliberately open to
 * every authenticated user: they are the birthday/anniversary wall on the home
 * page and carry no confidential data.
 */
export const dashboardPolicy = permissionByPath([
  // Full P&L, cash, AR/AP, DSO/DPO, burn, runway.
  ['/cfo',             'finance', 'view'],
  ['/finance',         'finance', 'view'],
  ['/revenue',         'finance', 'view'],
  ['/expenses',        'finance', 'view'],
  ['/cash',            'finance', 'view'],
  ['/top-customers',   'crm',     'view'],
  ['/top-vendors',     'procurement', 'view'],
  ['/sales',           'crm',     'view'],
  ['/workforce',       'hr',      'view'],
  ['/hires',           'hr',      'view'],
  ['/headcount-trend', 'hr',      'view'],
  ['/leave-summary',   'leave',   'view'],
  ['/manufacturing',   'production', 'view'],
  ['/project-health',  'projects', 'view'],
], ['reports', 'view']);

/**
 * /ai — predictions and assistants over the same underlying data.
 *
 * Default `reports:view`; the per-domain predictors inherit their domain's guard
 * so an AI wrapper can never become a way around a module permission.
 */
export const aiPolicy = permissionByPath([
  ['/predict/attrition',   'hr',          'view'],
  ['/predict/sales',       'crm',         'view'],
  ['/predict/lead-priority', 'crm',       'view'],
  ['/predict/inventory',   'inventory',   'view'],
  ['/predict/quality-risk', 'quality',    'view'],
  ['/predict/device-failure', 'iot',      'view'],
  ['/predict/project-health', 'projects', 'view'],
  ['/predict/ticket-summary', 'servicedesk', 'view'],
  ['/payroll',             'payroll',     'view'],
  ['/cashflow',            'finance',     'view'],
  ['/ceo-insights',        'finance',     'view'],
  ['/prescriptive',        'reports',     'view'],
  ['/anomalies',           'reports',     'view'],
  ['/predictions',         'reports',     'view'],
  ['/query',               'reports',     'view'],
], ['reports', 'view']);

/**
 * /intelligence — the "13 system APIs" grab-bag that sits beside the CEO/AI
 * routers in src/modules/intelligence/.
 *
 * It was mounted with `verifyToken` and nothing else, so a plain `employee`
 * could GET /intelligence/roles (the whole role table, every company) and
 * /intelligence/rules (business rule-engine configuration), and could POST to
 * /role-permissions and /field-permissions. Those two writes happen to fail on
 * a column mismatch today, which is luck rather than access control — the
 * intent of the handler is to grant a named role a named permission.
 *
 * Nothing in the frontend calls this router, and most of its endpoints are
 * broken against the live schema (see ANALYTICS_AI_FINAL_HARDENING_REPORT.md),
 * so the policy is deliberately strict: administration of roles, permissions,
 * rules, masters and companies takes `admin:view`, and the remaining domains
 * inherit the permission of the module that owns the data. Default is
 * `admin:view` so anything added later is guarded rather than open.
 */
export const intelligencePolicy = permissionByPath([
  // Read-only domain surfaces keep their owning module's bar.
  ['/audit-logs',       'audit',    'view'],
  ['/documents',        'documents','view'],
  ['/project-costs',    'projects', 'view'],
  ['/budget-vs-actual', 'projects', 'view'],
  ['/profit-tracker',   'finance',  'view'],
  ['/insights',         'reports',  'view'],
  ['/widgets',          'reports',  'view'],
  ['/workflows',        'approvals','view'],
  ['/workflow-instances','approvals','view'],
  ['/sla-config',       'settings', 'view'],
  ['/sla-tracking',     'servicedesk', 'view'],
  ['/notification-rules','notifications', 'view'],
  ['/branches',         'branches', 'view'],
  // Role/permission/rule/master administration — admin only.
], ['admin', 'view']);

/**
 * /reports — the prebuilt report catalog.
 *
 * This router was mounted with `verifyToken` and nothing else while
 * `/analytics`, `/ai` and `/dashboard` above were being hardened, so it kept
 * exactly the exposure this module exists to close: a plain Employee token
 * returned 200 on every endpoint, including `/leave/liability` (each colleague
 * named, with `daily_rate = basic_salary / 26`, i.e. every salary recoverable by
 * multiplication), `/outstanding-invoices` (the whole AR ledger),
 * `/gst-report` and `/payroll-summary`.
 *
 * The rules are generated from `modules/reports/reportCatalog.js` rather than
 * written out here, so a report added to the catalog is guarded by construction
 * and cannot ship open. `/catalog` is deliberately excluded from the generated
 * list and left at the `reports:view` fallback: it returns report names and
 * filter descriptors only — no business data — and the page needs it to render
 * the picker at all.
 */
export const reportsPolicy = permissionByPath(REPORT_POLICY_RULES, ['reports', 'view']);

/**
 * Paths that stay open to any authenticated user, checked before the policy.
 * Keep this list tiny and justify every entry.
 */
export const DASHBOARD_PUBLIC_PATHS = [
  '/celebrations',        // birthday / anniversary wall on the home page
  '/celebrations-today',
  '/celebration-wishes',  // GET + POST: reacting to a colleague's birthday
];

/** Wrap a policy so the listed paths bypass it. */
export const withOpenPaths = (policy, openPaths) => (req, res, next) => {
  const path = req.path || '/';
  if (openPaths.some(p => path === p || path.startsWith(p + '/'))) return next();
  return policy(req, res, next);
};

export default {
  permissionByPath, analyticsPolicy, dashboardPolicy, aiPolicy, intelligencePolicy, reportsPolicy,
  withOpenPaths, DASHBOARD_PUBLIC_PATHS,
};
