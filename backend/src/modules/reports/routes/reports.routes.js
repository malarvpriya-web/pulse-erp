/**
 * reports.routes.js — the prebuilt report catalog and saved reports.
 *
 * Three things changed here and each closes a defect the audit proved live:
 *
 * 1. **The `CREATE TABLE IF NOT EXISTS saved_reports` bootstrap is gone.** It
 *    declared a third, different shape for a table the migration and the
 *    baseline already own — on a fresh database it would have won the race and
 *    built the wrong columns.
 *
 * 2. **Tenant scope is resolved once, strictly, and denies when unresolved.**
 *    `companyOf()` returning null used to flow straight into predicates written
 *    as `if (company_id != null) ...`, so the 7 of 37 active accounts with no
 *    `user_scope` row queried every tenant. Null now means "global super-admin
 *    scope" and nothing else; anyone else who cannot be scoped gets 403.
 *
 * 3. **Filters are validated against the catalog.** A parameter the report does
 *    not declare is a 400 with the supported list, never a silent no-op. The
 *    Department box used to render on all 21 reports and be honoured by 5.
 *
 * Authorization is applied at the mount point in server.js via `reportsPolicy`,
 * which is derived from the same catalog — see reportCatalog.js.
 */
import express from 'express';
import reportsRepository from '../repositories/reports.repository.js';
import { companyOf } from '../../../shared/scope.js';
import { httpFromPgError } from '../../../shared/pgErrors.js';
import {
  REPORTS, getReport, FILTER_NAMES, PAGINATION_NAMES, DEFAULT_LIMIT, MAX_LIMIT,
} from '../reportCatalog.js';

const router = express.Router();

/* ─── error handling ──────────────────────────────────────────────────────────
   Mapped constraint violations keep their specific message; anything else is
   logged in full server-side and answered generically, so a schema error never
   reaches the client as `column x.y does not exist`. What must NOT happen — the
   behaviour this module shipped with — is an error becoming `200 []`. */
function fail(res, err, context) {
  const mapped = httpFromPgError(err);
  if (mapped) return res.status(mapped.status).json({ error: mapped.message });
  console.error(`[reports] ${context} failed:`, err);
  return res.status(500).json({
    error: 'This report could not be generated. The failure has been logged.',
    code: 'REPORT_FAILED',
    report: context,
  });
}

/* ─── tenant scope ─────────────────────────────────────────────────────────── */
const GLOBAL = Symbol('global-scope');

/** @returns {number|typeof GLOBAL|null} company id, GLOBAL, or null when unresolvable. */
function resolveScope(req) {
  if (req.scope?.isGlobal) return GLOBAL;
  const cid = companyOf(req);
  return cid == null ? null : cid;
}

/** Express guard: attaches `req.companyId` (number, or null only for global scope). */
function requireScope(req, res, next) {
  const scope = resolveScope(req);
  if (scope === null) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'reports_scope_unresolved',
      userId: req.user?.userId ?? req.user?.id, path: req.path,
    }));
    return res.status(403).json({
      error: 'Your account is not assigned to a company, so company-scoped reports cannot be produced. Ask an administrator to set your company assignment.',
      code: 'SCOPE_UNRESOLVED',
    });
  }
  req.companyId = scope === GLOBAL ? null : scope;
  next();
}

const userIdOf = req => req.user?.userId ?? req.user?.id ?? null;

/* ─── filter validation ────────────────────────────────────────────────────── */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sends a 400 and returns the `{ok:false}` sentinel `parseFilters` propagates. */
function badRequest(res, message, extra = {}) {
  res.status(400).json({ error: message, code: 'INVALID_FILTER', ...extra });
  return { ok: false };
}

/**
 * Validate `req.query` against the report's declared filters.
 * Blank strings count as "not supplied", matching shared/requestSchema.js.
 * @returns {{ok: true, filters: object}|{ok: false}} — on failure the response is already sent.
 */
function parseFilters(report, req, res) {
  const supplied = {};
  for (const [k, raw] of Object.entries(req.query || {})) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === null || String(v).trim() === '') continue;
    supplied[k] = String(v).trim();
  }

  for (const key of Object.keys(supplied)) {
    if (PAGINATION_NAMES.includes(key)) continue;
    if (!FILTER_NAMES.includes(key)) {
      return badRequest(res, `Unknown filter "${key}".`, { supported: report.filters });
    }
    if (!report.filters.includes(key)) {
      return badRequest(res,
        `The ${report.label} report does not support the "${key}" filter, so applying it would have no effect on the result.`,
        { supported: report.filters });
    }
  }

  const f = {};
  for (const key of report.filters) {
    if (supplied[key] === undefined) continue;
    const v = supplied[key];
    switch (key) {
      case 'start_date':
      case 'end_date':
        if (!DATE_RE.test(v)) return badRequest(res, `"${key}" must be a date in YYYY-MM-DD format.`);
        f[key] = v; break;
      case 'year': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1970 || n > 2200) return badRequest(res, '"year" must be a four-digit year.');
        f.year = n; break;
      }
      case 'month': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 12) return badRequest(res, '"month" must be between 1 and 12.');
        f.month = n; break;
      }
      case 'employee_id': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return badRequest(res, '"employee_id" must be a positive integer.');
        f.employee_id = n; break;
      }
      default:
        f[key] = v;
    }
  }

  if (f.start_date && f.end_date && f.start_date > f.end_date) {
    return badRequest(res, 'The start date is after the end date.');
  }

  const limit = supplied.limit !== undefined ? Number(supplied.limit) : DEFAULT_LIMIT;
  const offset = supplied.offset !== undefined ? Number(supplied.offset) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(res, `"limit" must be between 1 and ${MAX_LIMIT}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return badRequest(res, '"offset" must be zero or greater.');
  }

  return { ok: true, filters: f, limit, offset };
}

/* ─── report dispatch ───────────────────────────────────────────────────────
   Values are METHOD NAMES, not captured function references. A captured
   reference freezes the table at module load, which is fine in production and
   silently defeats any attempt to instrument or stub the repository — including
   the test that asserts a failing query surfaces as 5xx rather than 200 []. */
const RUNNERS = {
  'attendance':                  'getAttendanceReport',
  'leave':                       'getLeaveReport',
  'leave/summary':               'getLeaveSummaryReport',
  'leave/liability':             'getLeaveLiabilityReport',
  'leave/lop':                   'getLOPReport',
  'leave/department':            'getDepartmentLeaveReport',
  'leave/approval-performance':  'getApprovalPerformanceReport',
  'headcount':                   'getHeadcountReport',
  'payroll-summary':             'getPayrollSummaryReport',
  'sales':                       'getSalesReport',
  'sales-targets':               'getSalesTargetsReport',
  'outstanding-invoices':        'getOutstandingInvoicesReport',
  'gst-report':                  'getGSTReport',
  'expense-report':              'getExpenseReport',
  'project-cost':                'getProjectCostReport',
  'purchase-orders':             'getPurchaseOrdersReport',
  'vendor-performance':          'getVendorPerformanceReport',
  'pending-pos':                 'getPendingPOsReport',
  'stock':                       'getStockReport',
  'stock-movement':              'getStockMovementReport',
  'low-stock':                   'getLowStockReport',
};

/* Every catalog entry must have a runner and vice versa — a mismatch is a
   programming error that should surface at boot, not as a 404 in production. */
{
  const catalogIds = new Set(REPORTS.map(r => r.id));
  const runnerIds = new Set(Object.keys(RUNNERS));
  const missing = [...catalogIds].filter(id => !runnerIds.has(id));
  const orphan = [...runnerIds].filter(id => !catalogIds.has(id));
  const unbound = Object.entries(RUNNERS)
    .filter(([, fn]) => typeof reportsRepository[fn] !== 'function')
    .map(([id, fn]) => `${id} → ${fn}`);
  if (unbound.length) {
    throw new Error(`[reports] runner method(s) missing from the repository: ${unbound.join(', ')}`);
  }
  if (missing.length || orphan.length) {
    throw new Error(`[reports] catalog/runner mismatch — missing runners: ${missing.join(', ') || 'none'}; orphan runners: ${orphan.join(', ') || 'none'}`);
  }
}

/* ─── catalog ──────────────────────────────────────────────────────────────── */

/**
 * The page builds its picker and its filter controls from this, so a report can
 * never advertise a filter the backend ignores.
 */
router.get('/catalog', (req, res) => {
  res.json({
    generated_at: new Date().toISOString(),
    default_limit: DEFAULT_LIMIT,
    max_limit: MAX_LIMIT,
    reports: REPORTS.map(({ id, category, label, desc, filters, grain, measures }) => ({
      id, category, label, desc, filters, grain, measures,
    })),
  });
});

/* ─── saved reports ────────────────────────────────────────────────────────── */

router.get('/saved', requireScope, async (req, res) => {
  try {
    res.json({ rows: await reportsRepository.findSavedReports(userIdOf(req), req.companyId) });
  } catch (error) {
    return fail(res, error, 'saved');
  }
});

router.post('/saved', requireScope, async (req, res) => {
  const { name, report_type, filters, columns, is_shared } = req.body || {};
  if (!name || !String(name).trim()) {
    return badRequest(res, 'A report name is required.');
  }
  if (!report_type || !getReport(report_type)) {
    return badRequest(res, `"${report_type}" is not a report in the catalog.`,
      { supported: REPORTS.map(r => r.id) });
  }
  try {
    const saved = await reportsRepository.createSavedReport({
      name: String(name).trim(),
      report_type,
      filters, columns,
      created_by: userIdOf(req),
      is_shared: is_shared === true,
      company_id: req.companyId,
    });
    res.status(201).json(saved);
  } catch (error) {
    return fail(res, error, 'saved:create');
  }
});

router.delete('/saved/:id', requireScope, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return badRequest(res, 'Invalid report id.');
  try {
    const deleted = await reportsRepository.deleteSavedReport(id, userIdOf(req), req.companyId);
    // Same answer whether the row belongs to someone else or does not exist, so
    // the endpoint cannot be used to enumerate other people's saved reports.
    if (!deleted) return res.status(404).json({ error: 'Saved report not found.' });
    res.json({ message: 'Saved report deleted.' });
  } catch (error) {
    return fail(res, error, 'saved:delete');
  }
});

/* ─── prebuilt reports ─────────────────────────────────────────────────────── */

/**
 * One handler for every report. Two path segments are matched because four
 * report ids are namespaced (`leave/summary`, `leave/liability`, …).
 */
async function runReport(reportId, req, res) {
  const report = getReport(reportId);
  if (!report) {
    return res.status(404).json({
      error: `Unknown report "${reportId}".`,
      code: 'UNKNOWN_REPORT',
      available: REPORTS.map(r => r.id),
    });
  }

  const parsed = parseFilters(report, req, res);
  if (!parsed.ok) return; // parseFilters already answered

  try {
    const { rows, total, limit, offset } = await reportsRepository[RUNNERS[report.id]]({
      ...parsed.filters,
      company_id: req.companyId,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    res.json({
      report: report.id,
      label: report.label,
      grain: report.grain,
      measures: report.measures,
      generated_at: new Date().toISOString(),
      company_id: req.companyId,
      filters: parsed.filters,
      total, limit, offset,
      rows,
    });
  } catch (error) {
    return fail(res, error, report.id);
  }
}

router.get('/:segment', requireScope, (req, res) => runReport(req.params.segment, req, res));
router.get('/:segment/:sub', requireScope, (req, res) =>
  runReport(`${req.params.segment}/${req.params.sub}`, req, res));

export default router;
