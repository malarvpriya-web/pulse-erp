/**
 * Shared configuration for the authorization sweeps.
 *
 * Both scripts import from here so their notion of "guarded" cannot drift — a
 * guard classified in one script but not the other produced contradictory
 * numbers in earlier revisions.
 *
 * When a scan reports an UNCLASSIFIED identifier, resolve what it actually does
 * and add it to exactly one of the two sets below. Do not guess from the name:
 * `single` looks like a guard and is a local variable; `perm` looks like a
 * variable and is `requirePermission('assets', a)`.
 */
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Was a hardcoded absolute path to one developer's machine — worked only
// there, threw ENOENT (readdirSync on a nonexistent directory) everywhere
// else, including every CI runner. Never caught before because every prior
// CI run failed earlier in the pipeline; this is the first to reach it.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '../../src').replace(/\\/g, '/');

/** Public or self-authenticating routers — no role guard by design. */
export const BY_DESIGN = [
  'auth/auth.routes.js',
  'documents/routes/publicSign.routes.js',
  'servicedesk/routes/customer-portal.routes.js',
  'procurement/routes/vendor-registration.routes.js',
  'qrshare',
  'iot/routes/ingest',
];

/** Verified to perform an authorization decision. */
export const KNOWN_AUTHZ = new Set([
  'requirePermission', 'allowRoles', 'checkPermission',
  'verifyPortalToken', 'verifyVendorToken', 'requireDeviceToken',
  'canActOnApproval', 'requireApproverRole',
  'requireAttendanceAdmin', 'requireAttendanceApprover', 'requireAttendanceOperator',
  'svcAdmin', 'svcKnowledgeBase',
  // Module-local aliases — each verified to wrap requirePermission/allowRoles:
  'perm', 'svc', 'crm', 'engPerm',
  'canCreate', 'canManage', 'canAdmin',
  'requireLeaveAdmin', 'requireHolidayEditor', 'requireHRWrite', 'requireHRRead',
]);

/** Present in middleware position but NOT authorization. */
export const NOT_AUTHZ = new Set([
  // Authentication, or explicit passthrough deferring ownership to the handler.
  'verifyToken', 'verifyTokenLax', 'svcSelfService',
  // Body parsing / uploads / rate limiting.
  'upload', 'employeeUpload', 'clockRateLimit', 'express', 'single', 'array',
  // Input validation.
  'validate', 'validateGenerate', 'validateMarkPaid',
  // Not middleware at all: helpers, constants, parameter names.
  'safe', 'HR_ROLES', 'ADMIN_ROLES', '_req', 'req',
  // Words picked up from prose in route-leading comments, not identifiers.
  'periods', 'dashboard', 'Approval', 'CSV',
]);

/**
 * Authorization performed INSIDE the handler rather than as middleware.
 *
 * This codebase does that routinely — and for good reason: an ownership or
 * value-threshold check needs the record loaded, which middleware would have to
 * fetch a second time. servicedesk's `ownsTicket`, procurement's
 * `assertCanDecideAmount`, and attendance's `assertCanDecideFor` all work this way.
 *
 * A middleware-only scanner reports every one of those routes as unguarded. That
 * was the fourth way this tool was wrong: it flagged procurement's PR/PO approve
 * routes as open when they had enforced value-band limits all along.
 *
 * Same rule as the sets above — add an entry only after reading its definition.
 */
export const IN_HANDLER_AUTHZ = [
  'assertCanDecideAmount',   // procurement — value band vs caller's role level
  'assertCanDecideFor',      // attendance  — manager-of-record + delegation
  'assertSelfOrPrivileged',  // attendance  — own record, or a privileged role
  'ownsTicket',              // servicedesk — service staff or the requester
  'isServiceStaff',          // servicedesk — used as an inline branch guard
];

/**
 * Matches `router.<verb>('<path>', <chain...>` up to the next route definition.
 *
 * Terminates ONLY on the next `router.` at line start (or EOF) — deliberately
 * not on comments. An earlier version ended the match at the first `//` line,
 * which truncated the captured handler body long before any in-handler guard
 * appeared, so every commented route looked unguarded.
 */
export const ROUTE =
  /router\.(post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2\s*,([\s\S]*?)(?=\n\s*router\.|$)/g;

export function routeFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.routes.js')) out.push(p);
    }
  })(ROOT);
  return out.filter(f => !f.includes('__tests__') && !BY_DESIGN.some(b => f.includes(b)));
}

/**
 * Identifiers appearing in a route's middleware chain, split by classification.
 * The chain ends where the handler function begins.
 */
export function classifyChain(chain) {
  const cut = chain.search(/async\s*\(|\(\s*req\s*,|=>/);
  const mw   = cut === -1 ? chain : chain.slice(0, cut);
  const body = cut === -1 ? ''    : chain.slice(cut);
  const ids = [...mw.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\(|,|$)/g)]
    .map(x => x[1]).filter(id => id !== 'async');

  // An in-handler guard counts as authorization even with no middleware.
  const inHandler = IN_HANDLER_AUTHZ.filter(fn => body.includes(fn));

  return {
    authz:     [...ids.filter(id => KNOWN_AUTHZ.has(id)), ...inHandler],
    inHandler,
    unknown:   ids.filter(id => !KNOWN_AUTHZ.has(id) && !NOT_AUTHZ.has(id)),
    empty:     ids.length === 0,
  };
}

/** True when the file applies a known authz guard via router.use(...). */
export function hasFileWideAuthz(src) {
  return [...src.matchAll(/router\.use\(\s*([A-Za-z_$][\w$]*)/g)]
    .some(m => KNOWN_AUTHZ.has(m[1]));
}
