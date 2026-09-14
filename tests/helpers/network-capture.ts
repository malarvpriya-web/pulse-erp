/**
 * Network Failure Capture
 *
 * Attaches to a Playwright Page and intercepts all HTTP responses,
 * classifying failures (4xx / 5xx / timeout) by module.
 *
 * Usage:
 *   const net = attachNetworkCapture(page);
 *   // ... run test ...
 *   const failures = net.failures();
 *   net.attachToReport(testInfo);
 *   net.detach();
 *
 * Classification rules:
 *   401 → auth_failure
 *   403 → permission_denied
 *   404 → not_found
 *   5xx → server_error
 *   408 / timeout → timeout
 */

import type { Page, TestInfo } from '@playwright/test';

export type FailureCategory =
  | 'auth_failure'
  | 'permission_denied'
  | 'not_found'
  | 'server_error'
  | 'timeout'
  | 'client_error'
  | 'other';

export interface NetworkFailure {
  url:       string;
  method:    string;
  status:    number;
  category:  FailureCategory;
  module:    string;
  timestamp: string;
  duration:  number;
}

export interface NetworkCapture {
  /** All captured failures */
  readonly failures: () => NetworkFailure[];
  /** All captured responses (pass + fail) */
  readonly allResponses: () => Array<{ url: string; status: number; duration: number }>;
  /** Failures grouped by module */
  byModule: () => Record<string, NetworkFailure[]>;
  /** Failures grouped by category */
  byCategory: () => Record<string, NetworkFailure[]>;
  /** Attach failure summary to Playwright test report */
  attachToReport: (testInfo: TestInfo) => Promise<void>;
  /** Remove all listeners */
  detach: () => void;
}

// ─── Module classifier ────────────────────────────────────────────────────────

const MODULE_PATTERNS: Array<[RegExp, string]> = [
  [/\/auth\//i,                       'auth'],
  [/\/employees/i,                     'employees'],
  [/\/leaves|\/leave-|\/comp-off/i,    'leaves'],
  [/\/attendance|\/shift/i,            'attendance'],
  [/\/payroll|\/salary/i,              'payroll'],
  [/\/finance|\/accounting|\/gst|\/tds|\/budget|\/forex|\/fixed-assets/i, 'finance'],
  [/\/procurement|\/vendor|\/rfq|\/grn|\/three-way/i, 'procurement'],
  [/\/inventory|\/warehouse|\/batch|\/serial/i, 'inventory'],
  [/\/bom|\/production/i,              'production'],
  [/\/projects|\/tasks|\/gantt/i,      'projects'],
  [/\/crm|\/leads|\/accounts|\/contacts|\/opportunities|\/proposals/i, 'crm'],
  [/\/sales|\/commission|\/pricing|\/delivery/i, 'sales'],
  [/\/recruitment|\/talent|\/candidates/i, 'recruitment'],
  [/\/hr\/|\/training|\/certif|\/learning|\/succession|\/onboarding/i, 'hr'],
  [/\/performance|\/okr|\/kra|\/calibration|\/feedback/i, 'performance'],
  [/\/timesheets/i,                    'timesheets'],
  [/\/travel|\/reimbursement|\/customer-visits/i, 'travel'],
  [/\/quality/i,                       'quality'],
  [/\/engineering|\/ecn/i,             'engineering'],
  [/\/marketing|\/campaign/i,          'marketing'],
  [/\/reports/i,                       'reports'],
  [/\/documents|\/signature/i,         'documents'],
  [/\/notifications/i,                 'notifications'],
  [/\/audit/i,                         'audit'],
  [/\/approvals/i,                     'approvals'],
  [/\/dashboard/i,                     'dashboard'],
  [/\/servicedesk|\/complaints|\/voc|\/commissioning/i, 'servicedesk'],
  [/\/ai|\/intelligence|\/analytics/i, 'ai'],
  [/\/admin|\/settings|\/company-profile|\/branches|\/wizard/i, 'admin'],
  [/\/home/i,                          'home'],
  [/\/global-search/i,                 'search'],
  [/\/orgchart/i,                      'orgchart'],
  [/\/integrations|\/tally|\/whatsapp|\/zoho|\/payment/i, 'integrations'],
  [/\/webhooks/i,                      'webhooks'],
];

function classifyModule(url: string): string {
  for (const [pattern, module] of MODULE_PATTERNS) {
    if (pattern.test(url)) return module;
  }
  if (url.includes('/api/')) return 'api-unknown';
  return 'frontend';
}

function classifyStatus(status: number): FailureCategory {
  if (status === 401)           return 'auth_failure';
  if (status === 403)           return 'permission_denied';
  if (status === 404)           return 'not_found';
  if (status === 408)           return 'timeout';
  if (status >= 500)            return 'server_error';
  if (status >= 400)            return 'client_error';
  return 'other';
}

const IGNORED_URL_PATTERNS = [
  /favicon\.ico/i,
  /\.hot-update\./i,
  /sockjs-node/i,
  /vite\/client/i,
  /localhost:\d+\/?$/,            // root health ping
];

// ─── Main capture factory ─────────────────────────────────────────────────────

export function attachNetworkCapture(page: Page): NetworkCapture {
  const failureBuffer:  NetworkFailure[] = [];
  const responseBuffer: Array<{ url: string; status: number; duration: number }> = [];
  const timings        = new Map<string, number>();

  const onRequest = (req: import('@playwright/test').Request) => {
    timings.set(req.url(), Date.now());
  };

  const onResponse = async (res: import('@playwright/test').Response) => {
    const url    = res.url();
    const status = res.status();
    const t0     = timings.get(url) ?? Date.now();
    const dur    = Date.now() - t0;
    timings.delete(url);

    if (IGNORED_URL_PATTERNS.some(p => p.test(url))) return;

    responseBuffer.push({ url, status, duration: dur });

    if (status >= 400) {
      failureBuffer.push({
        url,
        method:    res.request().method(),
        status,
        category:  classifyStatus(status),
        module:    classifyModule(url),
        timestamp: new Date().toISOString(),
        duration:  dur,
      });
    }
  };

  const onRequestFailed = (req: import('@playwright/test').Request) => {
    const url = req.url();
    if (IGNORED_URL_PATTERNS.some(p => p.test(url))) return;

    failureBuffer.push({
      url,
      method:    req.method(),
      status:    0,
      category:  'timeout',
      module:    classifyModule(url),
      timestamp: new Date().toISOString(),
      duration:  -1,
    });
  };

  page.on('request',        onRequest);
  page.on('response',       onResponse);
  page.on('requestfailed',  onRequestFailed);

  const capture: NetworkCapture = {
    failures:     () => [...failureBuffer],
    allResponses: () => [...responseBuffer],

    byModule: () => {
      const map: Record<string, NetworkFailure[]> = {};
      for (const f of failureBuffer) {
        (map[f.module] ??= []).push(f);
      }
      return map;
    },

    byCategory: () => {
      const map: Record<string, NetworkFailure[]> = {};
      for (const f of failureBuffer) {
        (map[f.category] ??= []).push(f);
      }
      return map;
    },

    attachToReport: async (testInfo: TestInfo) => {
      if (failureBuffer.length === 0) return;

      const byMod = capture.byModule();
      const lines: string[] = [
        `Network Failures: ${failureBuffer.length} total`,
        '',
        'By Module:',
        ...Object.entries(byMod).map(([mod, fails]) =>
          `  ${mod}: ${fails.length} failure(s) — ${[...new Set(fails.map(f => f.status))].join(', ')}`
        ),
        '',
        'Details:',
        ...failureBuffer.map(f =>
          `  [${f.status}] ${f.method} ${f.url} (${f.category}, ${f.duration}ms)`
        ),
      ];

      await testInfo.attach('network-failures.txt', {
        body:        Buffer.from(lines.join('\n'), 'utf8'),
        contentType: 'text/plain',
      });

      // Summarise in annotations
      const authFailures  = failureBuffer.filter(f => f.category === 'auth_failure').length;
      const serverErrors  = failureBuffer.filter(f => f.category === 'server_error').length;
      const notFound      = failureBuffer.filter(f => f.category === 'not_found').length;

      const parts: string[] = [];
      if (authFailures)  parts.push(`${authFailures}× 401`);
      if (serverErrors)  parts.push(`${serverErrors}× 5xx`);
      if (notFound)      parts.push(`${notFound}× 404`);
      if (parts.length === 0) parts.push(`${failureBuffer.length} failures`);

      testInfo.annotations.push({
        type:        'network-failure',
        description: `Network: ${parts.join(', ')} — see attachment for detail`,
      });
    },

    detach: () => {
      page.off('request',       onRequest);
      page.off('response',      onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };

  return capture;
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

/** Assert no 5xx server errors were captured. */
export function assertNoServerErrors(capture: NetworkCapture): void {
  const errs = capture.failures().filter(f => f.category === 'server_error');
  if (errs.length === 0) return;

  const summary = errs.slice(0, 5)
    .map(f => `  ${f.status} ${f.method} ${f.url}`)
    .join('\n');
  throw new Error(`Server errors (5xx) captured:\n${summary}`);
}

/** Assert no unexpected 401s were captured (auth should be valid in test context). */
export function assertNoUnexpectedAuthFailures(capture: NetworkCapture, allowList: string[] = []): void {
  const errs = capture
    .failures()
    .filter(f => f.category === 'auth_failure')
    .filter(f => !allowList.some(allowed => f.url.includes(allowed)));

  if (errs.length === 0) return;

  const summary = errs.slice(0, 5)
    .map(f => `  401 ${f.method} ${f.url}`)
    .join('\n');
  throw new Error(`Unexpected 401 responses captured:\n${summary}`);
}
