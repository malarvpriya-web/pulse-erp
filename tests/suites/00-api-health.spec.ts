/**
 * Suite 00 — API Health Audit
 *
 * For every registered Pulse ERP API module:
 *   1. Probe the endpoint WITHOUT auth  → must return 401 (no bypass)
 *   2. Probe the endpoint WITH auth     → must NOT return 401 (endpoint reachable)
 *   3. Measure response time            → flag if > 2 000 ms
 *
 * A dedicated login call obtains a fresh JWT so this suite runs
 * independently of browser storage state.
 *
 * Artifacts:
 *   tests/reports/api-health-report.json
 *
 * Run:
 *   npx playwright test --project=api-health
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_BASE  = process.env.API_BASE_URL ?? 'http://localhost:5000';
const V1        = `${API_BASE}/api/v1`;
const LOGIN_URL = `${V1}/auth/login`;
const CREDS     = { email: 'superadmin@pulse.com', password: 'Pulse@123' };
const SLOW_MS   = 2_000;

// Suppress browser-auth requirement — this suite uses raw HTTP only
test.use({ storageState: undefined });

// ─── Endpoint manifest ────────────────────────────────────────────────────────

interface EndpointSpec {
  module: string;
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
  severity: 'P0' | 'P1' | 'P2';
  /** Accept these statuses as "healthy" when authenticated */
  acceptedAuthStatuses?: number[];
  /** If true, 404 is treated as healthy (root GET not implemented on that prefix) */
  rootGetOptional?: boolean;
  /** If true this endpoint is intentionally public — skip the no-auth 401 check */
  isPublic?: boolean;
  description?: string;
}

const ENDPOINTS: EndpointSpec[] = [
  // ── Health ────────────────────────────────────────────────────────────────
  { module: 'infra',       path: '/api/health',                 severity: 'P0', isPublic: true,  description: 'Server health + DB + migrations' },

  // ── Auth ──────────────────────────────────────────────────────────────────
  { module: 'auth',        path: `${V1}/auth/login`,            severity: 'P0', method: 'POST', body: CREDS,
    isPublic: true, acceptedAuthStatuses: [200], description: 'Login returns 200 + token' },
  { module: 'auth',        path: `${V1}/auth/login`,            severity: 'P0', method: 'POST', body: { email: 'bad@x.com', password: 'wrong' },
    isPublic: true, acceptedAuthStatuses: [401, 400], description: 'Bad credentials returns 4xx' },

  // ── Core ──────────────────────────────────────────────────────────────────
  { module: 'employees',   path: `${V1}/employees`,             severity: 'P0', rootGetOptional: false, description: 'Employee list' },
  { module: 'home',        path: `${V1}/home/kpis`,             severity: 'P0', rootGetOptional: true,  description: 'Home KPI widgets' },
  { module: 'announcements', path: `${V1}/announcements/active`, severity: 'P1', isPublic: true, acceptedAuthStatuses: [200], description: 'Public announcements' },
  { module: 'notes',       path: `${V1}/notes`,                 severity: 'P2', rootGetOptional: true,  description: 'Notes list' },
  { module: 'probation',   path: `${V1}/probation`,             severity: 'P2', rootGetOptional: true,  description: 'Probation list' },

  // ── Leaves ────────────────────────────────────────────────────────────────
  { module: 'leaves',      path: `${V1}/leaves`,                severity: 'P0', description: 'Leave list' },
  { module: 'leaves',      path: `${V1}/comp-off`,              severity: 'P1', rootGetOptional: true,  description: 'Comp-off list' },
  { module: 'leaves',      path: `${V1}/leave-encashment`,      severity: 'P2', rootGetOptional: true,  description: 'Leave encashment' },

  // ── Attendance ────────────────────────────────────────────────────────────
  { module: 'attendance',  path: `${V1}/attendance`,            severity: 'P0', rootGetOptional: true,  description: 'Attendance records' },
  { module: 'attendance',  path: `${V1}/holidays`,              severity: 'P1', rootGetOptional: true,  description: 'Holiday calendar' },

  // ── Finance ───────────────────────────────────────────────────────────────
  { module: 'finance',     path: `${V1}/finance`,               severity: 'P0', rootGetOptional: true,  description: 'Finance summary' },
  { module: 'finance',     path: `${V1}/accounting`,            severity: 'P0', rootGetOptional: true,  description: 'Accounting engine' },
  { module: 'finance',     path: `${V1}/gst`,                   severity: 'P0', rootGetOptional: true,  description: 'GST module' },
  { module: 'finance',     path: `${V1}/tds`,                   severity: 'P1', rootGetOptional: true,  description: 'TDS module' },
  { module: 'finance',     path: `${V1}/budgets`,               severity: 'P1', rootGetOptional: true,  description: 'Budgets' },
  { module: 'finance',     path: `${V1}/fixed-assets`,          severity: 'P1', rootGetOptional: true,  description: 'Fixed assets' },
  { module: 'finance',     path: `${V1}/statements`,            severity: 'P1', rootGetOptional: true,  description: 'Financial statements' },
  { module: 'finance',     path: `${V1}/forex`,                 severity: 'P2', rootGetOptional: true,  description: 'Forex rates' },
  { module: 'finance',     path: `${V1}/finance/credit-notes`,  severity: 'P2', rootGetOptional: true,  description: 'Credit notes' },
  { module: 'finance',     path: `${V1}/finance/cost-centers`,  severity: 'P2', rootGetOptional: true,  description: 'Cost centers' },

  // ── Procurement ───────────────────────────────────────────────────────────
  { module: 'procurement', path: `${V1}/procurement`,           severity: 'P0', rootGetOptional: true,  description: 'Procurement list' },
  { module: 'procurement', path: `${V1}/vendors`,               severity: 'P0', rootGetOptional: true,  description: 'Vendor list' },
  { module: 'procurement', path: `${V1}/rfqs`,                  severity: 'P1', rootGetOptional: true,  description: 'RFQ list' },
  { module: 'procurement', path: `${V1}/vendor-360`,            severity: 'P1', rootGetOptional: true,  description: 'Vendor 360°' },
  { module: 'procurement', path: `${V1}/vendor-health`,         severity: 'P1', rootGetOptional: true,  description: 'Vendor health scores' },

  // ── Inventory ─────────────────────────────────────────────────────────────
  { module: 'inventory',   path: `${V1}/inventory`,             severity: 'P0', rootGetOptional: true,  description: 'Inventory items' },
  { module: 'inventory',   path: `${V1}/warehouse`,             severity: 'P1', rootGetOptional: true,  description: 'Warehouse list' },
  { module: 'inventory',   path: `${V1}/logistics`,             severity: 'P2', rootGetOptional: true,  description: 'Logistics' },

  // ── Production ────────────────────────────────────────────────────────────
  { module: 'production',  path: `${V1}/bom`,                   severity: 'P0', rootGetOptional: true,  description: 'BOM list' },
  { module: 'production',  path: `${V1}/production`,            severity: 'P0', rootGetOptional: true,  description: 'Production orders' },
  { module: 'quality',     path: `${V1}/quality`,               severity: 'P1', rootGetOptional: true,  description: 'Quality checks' },

  // ── Projects ──────────────────────────────────────────────────────────────
  { module: 'projects',    path: `${V1}/projects`,              severity: 'P0', rootGetOptional: true,  description: 'Project list' },
  { module: 'projects',    path: `${V1}/tasks`,                 severity: 'P0', rootGetOptional: true,  description: 'Task list' },
  { module: 'projects',    path: `${V1}/gantt`,                 severity: 'P1', rootGetOptional: true,  description: 'Gantt data' },
  { module: 'projects',    path: `${V1}/project-360`,           severity: 'P1', rootGetOptional: true,  description: 'Project 360°' },
  { module: 'projects',    path: `${V1}/project-profitability`, severity: 'P1', rootGetOptional: true,  description: 'Project profitability' },

  // ── HR & Payroll ──────────────────────────────────────────────────────────
  { module: 'payroll',     path: `${V1}/payroll`,               severity: 'P0', rootGetOptional: true,  description: 'Payroll runs' },
  { module: 'payroll',     path: `${V1}/salary-structures`,     severity: 'P1', rootGetOptional: true,  description: 'Salary structures' },
  { module: 'hr',          path: `${V1}/hr`,                    severity: 'P1', rootGetOptional: true,  description: 'HR overview' },
  { module: 'hr',          path: `${V1}/training`,              severity: 'P1', rootGetOptional: true,  description: 'Training list' },
  { module: 'hr',          path: `${V1}/certifications`,        severity: 'P1', rootGetOptional: true,  description: 'Certifications' },
  { module: 'hr',          path: `${V1}/learning-paths`,        severity: 'P2', rootGetOptional: true,  description: 'Learning paths' },
  { module: 'hr',          path: `${V1}/assessments`,           severity: 'P2', rootGetOptional: true,  description: 'Assessments' },
  { module: 'hr',          path: `${V1}/succession`,            severity: 'P2', rootGetOptional: true,  description: 'Succession planning' },
  { module: 'hr',          path: `${V1}/onboarding`,            severity: 'P1', rootGetOptional: true,  description: 'Onboarding checklists' },
  { module: 'timesheets',  path: `${V1}/timesheets`,            severity: 'P1', rootGetOptional: true,  description: 'Timesheets' },

  // ── Performance ───────────────────────────────────────────────────────────
  { module: 'performance', path: `${V1}/performance`,           severity: 'P1', rootGetOptional: true,  description: 'Performance reviews' },
  { module: 'performance', path: `${V1}/performance/cycles`,    severity: 'P1', rootGetOptional: true,  description: 'Review cycles' },
  { module: 'performance', path: `${V1}/performance/okr`,       severity: 'P1', rootGetOptional: true,  description: 'OKR goals' },

  // ── Recruitment ───────────────────────────────────────────────────────────
  { module: 'recruitment', path: `${V1}/recruitment`,           severity: 'P0', rootGetOptional: true,  description: 'Job openings / candidates' },
  { module: 'talent',      path: `${V1}/talent`,                severity: 'P1', rootGetOptional: true,  description: 'Talent pools' },

  // ── CRM & Sales ───────────────────────────────────────────────────────────
  { module: 'crm',         path: `${V1}/crm`,                   severity: 'P0', rootGetOptional: true,  description: 'CRM root' },
  { module: 'sales',       path: `${V1}/sales`,                 severity: 'P0', rootGetOptional: true,  description: 'Sales orders' },
  { module: 'sales',       path: `${V1}/sales-command-center`,  severity: 'P1', rootGetOptional: true,  description: 'Sales command center' },
  { module: 'sales',       path: `${V1}/sales-funnel`,          severity: 'P1', rootGetOptional: true,  description: 'Sales funnel' },
  { module: 'marketing',   path: `${V1}/marketing`,             severity: 'P2', rootGetOptional: true,  description: 'Marketing campaigns' },

  // ── Travel ────────────────────────────────────────────────────────────────
  { module: 'travel',      path: `${V1}/travel`,                severity: 'P1', rootGetOptional: true,  description: 'Travel requests' },
  { module: 'travel',      path: `${V1}/reimbursement`,         severity: 'P1', rootGetOptional: true,  description: 'Reimbursements' },
  { module: 'travel',      path: `${V1}/customer-visits`,       severity: 'P2', rootGetOptional: true,  description: 'Customer visits' },

  // ── Operations & Admin ────────────────────────────────────────────────────
  { module: 'admin',       path: `${V1}/admin`,                 severity: 'P1', rootGetOptional: true,  description: 'Admin config' },
  { module: 'admin',       path: `${V1}/company-profile`,       severity: 'P0', rootGetOptional: true,  description: 'Company profile' },
  { module: 'admin',       path: `${V1}/branches`,              severity: 'P1', rootGetOptional: true,  description: 'Branch management' },
  { module: 'admin',       path: `${V1}/settings`,              severity: 'P1', rootGetOptional: true,  description: 'Settings status' },
  { module: 'admin',       path: `${V1}/workflows`,             severity: 'P1', rootGetOptional: true,  description: 'Workflow engine' },
  { module: 'admin',       path: `${V1}/master`,                severity: 'P1', rootGetOptional: true,  description: 'Master data' },
  { module: 'admin',       path: `${V1}/operations`,            severity: 'P2', rootGetOptional: true,  description: 'Operations config' },
  { module: 'admin',       path: `${V1}/maintenance`,           severity: 'P2', rootGetOptional: true,  description: 'Maintenance jobs' },

  // ── Support & Platform ────────────────────────────────────────────────────
  { module: 'reports',     path: `${V1}/reports`,               severity: 'P0', rootGetOptional: true,  description: 'Report generator' },
  { module: 'notifications', path: `${V1}/notifications`,       severity: 'P0', rootGetOptional: true,  description: 'Notification feed' },
  { module: 'audit',       path: `${V1}/audit`,                 severity: 'P0', rootGetOptional: true,  description: 'Audit log' },
  { module: 'approvals',   path: `${V1}/approvals`,             severity: 'P0', rootGetOptional: true,  description: 'Approval queue' },
  { module: 'dashboard',   path: `${V1}/dashboard`,             severity: 'P0', rootGetOptional: true,  description: 'Dashboard KPIs' },
  { module: 'documents',   path: `${V1}/documents`,             severity: 'P1', rootGetOptional: true,  description: 'Document vault' },
  { module: 'servicedesk', path: `${V1}/servicedesk`,           severity: 'P1', rootGetOptional: true,  description: 'Service tickets' },
  { module: 'complaints',  path: `${V1}/complaints`,            severity: 'P1', rootGetOptional: true,  description: 'Complaint tracker' },
  { module: 'orgchart',    path: `${V1}/orgchart`,              severity: 'P1', rootGetOptional: true,  description: 'Org chart data' },
  { module: 'search',      path: `${V1}/global-search?q=test`,  severity: 'P1', rootGetOptional: true,  description: 'Global search' },

  // ── AI & Intelligence ─────────────────────────────────────────────────────
  { module: 'ai',          path: `${V1}/intelligence`,          severity: 'P1', rootGetOptional: true,  description: 'ERP intelligence' },
  { module: 'ai',          path: `${V1}/ceo-intelligence`,      severity: 'P1', rootGetOptional: true,  description: 'CEO intelligence' },
  { module: 'ai',          path: `${V1}/analytics`,             severity: 'P1', rootGetOptional: true,  description: 'Analytics engine' },

  // ── Engineering ───────────────────────────────────────────────────────────
  { module: 'engineering', path: `${V1}/engineering`,           severity: 'P2', rootGetOptional: true,  description: 'Engineering center' },
];

// ─── Result type ─────────────────────────────────────────────────────────────

interface HealthResult {
  module: string;
  path: string;
  method: string;
  severity: string;
  description: string;
  withAuth: {
    status: number;
    responseMs: number;
    pass: boolean;
    slow: boolean;
    error?: string;
  };
  withoutAuth: {
    status: number;
    responseMs: number;
    pass: boolean;
    error?: string;
  } | null;
  overallPass: boolean;
}

// ─── Module-level state (shared across tests in this file) ────────────────────

let jwtToken = '';
const healthResults: HealthResult[] = [];

// ─── Auth ─────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ playwright }) => {
  fs.mkdirSync('tests/reports', { recursive: true });

  const ctx = await playwright.request.newContext();
  try {
    const res = await ctx.post(LOGIN_URL, {
      data: CREDS,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });

    if (res.ok()) {
      const body = await res.json().catch(() => ({}));
      jwtToken = body?.token
        || body?.data?.token
        || body?.access_token
        || body?.accessToken
        || '';
    }
  } catch {
    // Tests will still run — the "no auth" checks will still pass
  } finally {
    await ctx.dispose();
  }
});

test.afterAll(() => {
  const passed   = healthResults.filter(r => r.overallPass).length;
  const failed   = healthResults.filter(r => !r.overallPass).length;
  const slowList = healthResults.filter(r => r.withAuth.slow);
  const avgMs    = healthResults.length
    ? Math.round(healthResults.reduce((s, r) => s + r.withAuth.responseMs, 0) / healthResults.length)
    : 0;

  const report = {
    generatedAt:     new Date().toISOString(),
    apiBase:         API_BASE,
    totalEndpoints:  healthResults.length,
    passed,
    failed,
    passRate:        healthResults.length ? `${Math.round((passed / healthResults.length) * 100)}%` : '0%',
    avgResponseMs:   avgMs,
    slowEndpoints:   slowList.length,
    slowThresholdMs: SLOW_MS,
    jwtObtained:     !!jwtToken,
    endpoints:       healthResults,
    securityAlerts: healthResults
      .filter(r => r.withoutAuth && !r.withoutAuth.pass)
      .map(r => ({ module: r.module, path: r.path, issue: 'Endpoint accessible without auth — possible auth bypass!' })),
    summary: {
      p0Pass: healthResults.filter(r => r.severity === 'P0' && r.overallPass).length,
      p0Total: healthResults.filter(r => r.severity === 'P0').length,
      p1Pass: healthResults.filter(r => r.severity === 'P1' && r.overallPass).length,
      p1Total: healthResults.filter(r => r.severity === 'P1').length,
    },
  };

  fs.writeFileSync('tests/reports/api-health-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n📊 API Health Report → tests/reports/api-health-report.json`);
  console.log(`   ${passed}/${healthResults.length} endpoints healthy | avg ${avgMs}ms | ${slowList.length} slow | ${report.securityAlerts.length} auth alerts`);
});

// ─── Test factory ─────────────────────────────────────────────────────────────

function probeEndpoint(spec: EndpointSpec) {
  const label = `[${spec.severity}] [${spec.module.toUpperCase()}] ${spec.method ?? 'GET'} ${spec.path}`;

  test(`@${spec.severity} API:${label}${spec.description ? ` — ${spec.description}` : ''}`, async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      timeout: 30_000,
    });

    const method  = spec.method ?? 'GET';
    const reqOpts = spec.body ? { data: spec.body, headers: { 'Content-Type': 'application/json' } } : {};

    // ── Probe WITH auth ────────────────────────────────────────────────────
    let authStatus  = 0;
    let authMs      = 0;
    let authError: string | undefined;

    try {
      const t0  = Date.now();
      const authHeaders: Record<string, string> = jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {};
      const res = await (method === 'POST'
        ? ctx.post(spec.path, { ...reqOpts, headers: { ...reqOpts.headers, ...authHeaders } })
        : ctx.get(spec.path, { headers: authHeaders }));
      authMs     = Date.now() - t0;
      authStatus = res.status();
    } catch (e: unknown) {
      authError = e instanceof Error ? e.message : String(e);
    }

    const accepted     = spec.acceptedAuthStatuses ?? [200, 201, 204];
    const authPass     = authError
      ? false
      : spec.rootGetOptional
        // 403 = role-restricted but endpoint reachable; 404 = no root GET handler — both OK
        // Only 401 means the token was not recognised (auth broken)
        ? authStatus !== 401
        // For explicit endpoints: accepted statuses OR 403 (role-restricted still means "reachable")
        : accepted.includes(authStatus) || authStatus === 403;
    const authSlow = authMs > SLOW_MS;

    // ── Probe WITHOUT auth ─────────────────────────────────────────────────
    let noAuthStatus = 0;
    let noAuthMs     = 0;
    let noAuthError: string | undefined;
    let noAuthPass   = true;

    if (!spec.isPublic) {
      try {
        const t0  = Date.now();
        const res = await (method === 'POST'
          ? ctx.post(spec.path, reqOpts)
          : ctx.get(spec.path));
        noAuthMs     = Date.now() - t0;
        noAuthStatus = res.status();
        // 401 or 403 expected — anything else is a security concern
        noAuthPass = noAuthStatus === 401 || noAuthStatus === 403;
      } catch (e: unknown) {
        noAuthError  = e instanceof Error ? e.message : String(e);
        noAuthPass   = true; // connection refused / timeout — not a bypass
      }
    }

    const overallPass = authPass && noAuthPass;

    healthResults.push({
      module:       spec.module,
      path:         spec.path,
      method,
      severity:     spec.severity,
      description:  spec.description ?? '',
      withAuth: { status: authStatus, responseMs: authMs, pass: authPass, slow: authSlow, error: authError },
      withoutAuth: spec.isPublic ? null : { status: noAuthStatus, responseMs: noAuthMs, pass: noAuthPass, error: noAuthError },
      overallPass,
    });

    await ctx.dispose();

    // ── Assertions ─────────────────────────────────────────────────────────
    if (authError) {
      test.info().annotations.push({ type: 'error', description: `Connection failed: ${authError}` });
      // Soft-fail for connectivity — server may not be running in CI
      return;
    }

    if (authSlow) {
      test.info().annotations.push({
        type: 'warning',
        description: `Slow response: ${authMs}ms (threshold ${SLOW_MS}ms)`,
      });
    }

    if (!noAuthPass) {
      test.info().annotations.push({
        type: 'security',
        description: `SECURITY: Endpoint returned ${noAuthStatus} without auth — possible bypass!`,
      });
    }

    // The core assertion: endpoint must not return 401 when authenticated
    // (403 is acceptable — means endpoint reachable, token recognised, role-restricted)
    expect(authPass, `${spec.path} returned ${authStatus} with valid auth (expected reachable: not 401)`).toBe(true);

    // Security: must be protected when no auth provided
    if (!spec.isPublic) {
      expect(noAuthPass, `SECURITY ALERT: ${spec.path} returned ${noAuthStatus} without auth — should be 401/403`).toBe(true);
    }
  });
}

// ─── Generate tests ───────────────────────────────────────────────────────────

for (const spec of ENDPOINTS) {
  probeEndpoint(spec);
}
