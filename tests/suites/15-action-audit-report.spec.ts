/**
 * Suite 15 — Action Audit Report Generator (Phase 7 deliverables)
 *
 * Reads all result files from suites 09–14 and generates:
 *   1. tests/reports/action-audit-report.html   — full interactive HTML report
 *   2. tests/reports/failed-actions.csv         — failed actions for triage
 *   3. tests/reports/root-cause-analysis.md     — categorized root causes
 *   4. tests/reports/production-readiness-update.md — production readiness score
 *
 * Run after all audit phases:
 *   npx playwright test --project=action-audit-report
 */

import { test } from '../fixtures/base';
import fs   from 'fs';
import path from 'path';

const REPORTS = 'tests/reports';

// ─── Load all result files ────────────────────────────────────────────────────

function loadJSON<T>(file: string, fallback: T): T {
  const fp = path.join(REPORTS, file);
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}

// ─── CSV generator ───────────────────────────────────────────────────────────

function buildFailedCSV(allFailed: any[]): string {
  const header = 'Route,Module,Button Name,Action Type,Failure Type,Root Cause,Suggested Fix,Severity';
  const rows = allFailed.map(f => {
    const suggestedFix = suggestFix(f.errorType ?? '', f.errorMessage ?? '', f.route ?? '');
    const severity = deriveSeverity(f.errorType ?? '', f.safetyCategory ?? '', f.module ?? '');
    return [
      f.route ?? '',
      f.module ?? '',
      (f.actionLabel ?? f.buttonLabel ?? '').replace(/,/g, ';'),
      f.actionType ?? '',
      f.errorType ?? f.status ?? '',
      (f.errorMessage ?? f.notes ?? '').replace(/,/g, ';').replace(/\n/g, ' ').slice(0, 150),
      suggestedFix.replace(/,/g, ';'),
      severity,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function suggestFix(errorType: string, errorMessage: string, route: string): string {
  if (errorType === 'CRASH' || errorType === 'PAGE_CRASH') return 'Check React ErrorBoundary in component — likely unhandled promise rejection or null dereference';
  if (errorType === 'CONSOLE_ERROR') return `Fix JavaScript error: ${errorMessage.slice(0, 80)}`;
  if (errorType === 'API_5XX') return 'Investigate backend server error — check server logs for the failing endpoint';
  if (errorType === 'VALIDATION_ERROR') return 'Improve auto-fill logic or add required field detection in test helper';
  if (errorType === 'EXCEPTION') return `Playwright exception — check if element is in a shadow DOM or iframe: ${errorMessage.slice(0, 60)}`;
  if (errorType === 'UNPROTECTED') return 'CRITICAL: Add confirmation dialog before executing destructive action';
  if (errorType === 'CANCEL_FAIL') return 'Fix dialog cancel/close button — Escape key should dismiss modal';
  if (errorMessage.includes('timeout')) return 'Increase timeout or investigate slow API response for this route';
  if (errorMessage.includes('not visible')) return 'Element exists but is hidden — check CSS display/visibility for this button';
  return 'Review page behavior manually and add appropriate guard or fix';
}

function deriveSeverity(errorType: string, safetyCategory: string, module: string): string {
  if (errorType === 'UNPROTECTED') return 'CRITICAL';
  if (errorType === 'CRASH' || errorType === 'PAGE_CRASH') return 'HIGH';
  if (errorType === 'API_5XX') return 'HIGH';
  if (safetyCategory === 'APPROVAL' && errorType) return 'HIGH';
  if (errorType === 'CONSOLE_ERROR') return 'MEDIUM';
  if (errorType === 'VALIDATION_ERROR') return 'LOW';
  return 'MEDIUM';
}

// ─── Root cause analysis ─────────────────────────────────────────────────────

function buildRootCauseAnalysis(allFailed: any[], inventory: any, allResults: any): string {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const crashCount     = allFailed.filter(f => f.errorType === 'CRASH' || f.errorType === 'PAGE_CRASH').length;
  const apiCount       = allFailed.filter(f => f.errorType === 'API_5XX').length;
  const consoleCount   = allFailed.filter(f => f.errorType === 'CONSOLE_ERROR').length;
  const dangerCount    = allFailed.filter(f => f.errorType === 'UNPROTECTED').length;
  const validationCount = allFailed.filter(f => f.errorType === 'VALIDATION_ERROR').length;
  const otherCount     = allFailed.length - crashCount - apiCount - consoleCount - dangerCount - validationCount;

  const byModule: Record<string, number> = {};
  for (const f of allFailed) {
    byModule[f.module ?? 'unknown'] = (byModule[f.module ?? 'unknown'] ?? 0) + 1;
  }

  const moduleRows = Object.entries(byModule).sort(([, a], [, b]) => b - a)
    .map(([mod, cnt]) => `| ${mod} | ${cnt} |`).join('\n');

  const topFailures = allFailed.slice(0, 15).map(f =>
    `- **${f.route ?? f.name}** → ${f.actionLabel ?? f.buttonLabel ?? ''}: \`${f.errorType ?? f.status}\` — ${(f.errorMessage ?? f.notes ?? '').slice(0, 120)}`
  ).join('\n');

  const recommendations: string[] = [];
  if (crashCount > 0) recommendations.push(`**${crashCount} React crashes** detected — add ErrorBoundary logging and fix null-reference errors`);
  if (apiCount > 0) recommendations.push(`**${apiCount} API 5xx errors** — review backend server logs for failing endpoints`);
  if (dangerCount > 0) recommendations.push(`🚨 **${dangerCount} unprotected dangerous actions** — add confirmation dialogs IMMEDIATELY (production data risk)`);
  if (consoleCount > 0) recommendations.push(`**${consoleCount} console errors** — fix JavaScript errors to prevent UX degradation`);

  return `# Pulse ERP — Root Cause Analysis
Generated: ${now} IST

## Failure Distribution

| Category | Count | Priority |
|----------|-------|----------|
| React Crashes / ErrorBoundary | ${crashCount} | 🔴 CRITICAL |
| API 5xx Errors | ${apiCount} | 🔴 HIGH |
| Unprotected Dangerous Actions | ${dangerCount} | 🚨 CRITICAL |
| Console Errors (JS) | ${consoleCount} | 🟡 MEDIUM |
| Form Validation Gaps | ${validationCount} | 🟢 LOW |
| Other | ${otherCount} | 🟡 MEDIUM |
| **TOTAL** | **${allFailed.length}** | |

## Failures by Module

| Module | Failures |
|--------|---------|
${moduleRows || '| — | No failures |'}

## Top Failures

${topFailures || '— No failures recorded'}

## Root Cause Categories

### Category 1: Unprotected Dangerous Actions (CRITICAL)
${dangerCount > 0
  ? allFailed.filter(f => f.errorType === 'UNPROTECTED').map(f => `- \`${f.route}\` → "${f.buttonLabel ?? f.actionLabel}" — no confirmation dialog`).join('\n')
  : '✅ All dangerous actions have confirmation dialogs'}

### Category 2: React Crashes
${crashCount > 0
  ? allFailed.filter(f => f.errorType === 'CRASH' || f.errorType === 'PAGE_CRASH').map(f =>
      `- \`${f.route}\` → "${f.actionLabel ?? f.buttonLabel}": ${(f.errorMessage ?? '').slice(0, 120)}`
    ).join('\n')
  : '✅ No React crashes detected'}

### Category 3: API Backend Failures (5xx)
${apiCount > 0
  ? allFailed.filter(f => f.errorType === 'API_5XX').map(f =>
      `- \`${f.route}\` → "${f.actionLabel ?? f.buttonLabel}": ${(f.errorMessage ?? '').slice(0, 120)}`
    ).join('\n')
  : '✅ No 5xx API errors during testing'}

### Category 4: JavaScript Console Errors
${consoleCount > 0
  ? allFailed.filter(f => f.errorType === 'CONSOLE_ERROR').map(f =>
      `- \`${f.route}\` → "${f.actionLabel ?? f.buttonLabel}": ${(f.errorMessage ?? '').slice(0, 120)}`
    ).join('\n')
  : '✅ No critical console errors detected'}

## Recommended Fix Priority

${recommendations.length > 0 ? recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n') : '✅ No critical issues — system is stable'}

## Testing Methodology

- **Discovery**: Automated DOM scan across ${inventory.totalRoutes ?? 'N/A'} routes
- **Safe Actions**: Click-tested ${allResults.safeTotal ?? 'N/A'} safe buttons (filter/export/view/refresh)
- **Form Actions**: Submitted ${allResults.formTotal ?? 'N/A'} create/edit forms with auto-generated test data
- **Approval Workflows**: Tested ${allResults.approvalTotal ?? 'N/A'} approval pages
- **Dangerous Actions**: Verified protection on ${allResults.dangerTotal ?? 'N/A'} delete/purge controls
- **Dashboard Validation**: Validated ${allResults.dashTotal ?? 'N/A'} dashboard pages

---
*Generated by Pulse ERP Test Suite — Suite 15 Action Audit Report*
`;
}

// ─── Production readiness update ──────────────────────────────────────────────

function buildProductionReadiness(allFailed: any[], allResults: any, inventory: any): string {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const criticalIssues = allFailed.filter(f => f.errorType === 'UNPROTECTED' || f.errorType === 'CRASH' || f.errorType === 'PAGE_CRASH');
  const highIssues     = allFailed.filter(f => f.errorType === 'API_5XX');
  const medIssues      = allFailed.filter(f => f.errorType === 'CONSOLE_ERROR');

  // Score: start at 100, deduct per category
  let score = 100;
  score -= criticalIssues.length * 15;
  score -= highIssues.length * 5;
  score -= medIssues.length * 2;
  score = Math.max(0, score);

  const certification = score >= 90 ? '✅ PRODUCTION READY'
                      : score >= 75 ? '⚠️  NEEDS FIXES — Not Production Ready'
                      : score >= 50 ? '🟡 SIGNIFICANT GAPS — Staging Only'
                      :               '🚨 CRITICAL ISSUES — Development Only';

  const safePassRate  = allResults.safePassRate != null ? `${(allResults.safePassRate * 100).toFixed(1)}%` : 'N/A';
  const formPassRate  = allResults.formPassRate != null ? `${(allResults.formPassRate * 100).toFixed(1)}%` : 'N/A';
  const dashPassRate  = allResults.dashPassRate != null ? `${(allResults.dashPassRate * 100).toFixed(1)}%` : 'N/A';

  return `# Pulse ERP — Production Readiness Update
## Action Audit Results — ${now} IST

## Certification: ${certification}
## Score: ${score}/100

---

## Audit Scope

| Metric | Value |
|--------|-------|
| Routes Scanned | ${inventory.totalRoutes ?? 'N/A'} |
| Total Actions Discovered | ${inventory.totalActions ?? 'N/A'} |
| Safe Actions Tested | ${allResults.safeTotal ?? 'N/A'} |
| Form Actions Tested | ${allResults.formTotal ?? 'N/A'} |
| Approval Pages Tested | ${allResults.approvalTotal ?? 'N/A'} |
| Dangerous Actions Checked | ${allResults.dangerTotal ?? 'N/A'} |
| Dashboards Validated | ${allResults.dashTotal ?? 'N/A'} |

## Pass Rates

| Phase | Pass Rate | Status |
|-------|-----------|--------|
| Safe Action Execution | ${safePassRate} | ${allResults.safePassRate >= 0.9 ? '✅' : '⚠️ '} |
| Form Submission | ${formPassRate} | ${allResults.formPassRate >= 0.8 ? '✅' : '⚠️ '} |
| Dashboard Validation | ${dashPassRate} | ${allResults.dashPassRate >= 0.85 ? '✅' : '⚠️ '} |
| Dangerous Action Protection | ${allResults.dangerProtected ? '✅ Protected' : '❌ Gaps Found'} | ${allResults.dangerProtected ? '✅' : '🚨'} |
| Approval Workflows | ${allResults.approvalOk ? '✅ Functional' : '⚠️  Warnings'} | ${allResults.approvalOk ? '✅' : '⚠️ '} |

## Critical Issues Requiring Immediate Action

${criticalIssues.length === 0 ? '✅ No critical issues detected' :
  criticalIssues.map(f => `- 🚨 \`${f.route ?? f.name}\`: ${f.errorType} — ${(f.errorMessage ?? f.notes ?? '').slice(0, 100)}`).join('\n')}

## High Priority Issues

${highIssues.length === 0 ? '✅ No high-priority issues' :
  highIssues.slice(0, 10).map(f => `- ⚠️  \`${f.route ?? f.name}\`: ${f.errorType} — ${(f.errorMessage ?? '').slice(0, 100)}`).join('\n')}

## Score Breakdown

| Category | Points | Deducted | Score |
|----------|--------|----------|-------|
| Unprotected dangerous actions (${criticalIssues.filter(f => f.errorType === 'UNPROTECTED').length}) | -15 each | -${criticalIssues.filter(f => f.errorType === 'UNPROTECTED').length * 15} | |
| React crashes (${criticalIssues.filter(f => f.errorType !== 'UNPROTECTED').length}) | -15 each | -${criticalIssues.filter(f => f.errorType !== 'UNPROTECTED').length * 15} | |
| API 5xx errors (${highIssues.length}) | -5 each | -${highIssues.length * 5} | |
| Console errors (${medIssues.length}) | -2 each | -${medIssues.length * 2} | |
| **TOTAL** | | **-${100 - score}** | **${score}/100** |

## Previous Certifications
- Phase 44A: INDUSTRIAL GO-LIVE ✅
- Phase 44B: PRODUCTION INTEGRITY ✅
- Phase 45: Dashboard Live Data (94/100)
- Phase 47/48: 89/100 (all P0 blockers fixed)

## Next Steps
${score >= 90
  ? '✅ System is production ready. Proceed with deployment.'
  : score >= 75
  ? '1. Fix all critical issues above\n2. Re-run dangerous-actions and form-actions suites\n3. Target score: 90+/100'
  : '1. Address all CRITICAL issues first\n2. Fix API 5xx errors\n3. Resolve React crashes\n4. Re-run full audit suite'}

---
*Generated by Pulse ERP Test Suite — Suite 15 Action Audit Report*
*Run: \`npx playwright test --project=action-audit-report\`*
`;
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

function buildHTMLReport(inventory: any, safeResults: any[], formResults: any[], approvalResults: any[], dangerResults: any[], dashResults: any[]): string {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const totalActions   = inventory.totalActions ?? 0;
  const safeTotal      = safeResults.length;
  const safePassed     = safeResults.filter(r => r.status === 'PASS').length;
  const safePassRate   = safeTotal > 0 ? ((safePassed / safeTotal) * 100).toFixed(1) : '0';
  const formTotal      = formResults.length;
  const formPassed     = formResults.filter(r => r.status === 'PASS').length;
  const dangerTotal    = dangerResults.length;
  const dangerProtected = dangerResults.filter(r => r.status === 'PROTECTED').length;
  const dangerUnprotected = dangerResults.filter(r => r.status === 'UNPROTECTED').length;
  const dashTotal      = dashResults.length;
  const dashPassed     = dashResults.filter(r => r.status === 'PASS').length;

  const allFailed = [
    ...safeResults.filter(r => r.status === 'FAIL'),
    ...formResults.filter(r => r.status === 'FAIL'),
    ...approvalResults.filter(r => r.status === 'FAIL'),
    ...dangerResults.filter(r => r.status === 'UNPROTECTED'),
    ...dashResults.filter(r => r.status === 'FAIL'),
  ];

  const byModule: Record<string, { pass: number; fail: number; warn: number }> = {};
  const allResults = [...safeResults, ...formResults, ...dashResults];
  for (const r of allResults) {
    const mod = r.module ?? 'unknown';
    if (!byModule[mod]) byModule[mod] = { pass: 0, fail: 0, warn: 0 };
    if (r.status === 'PASS')       byModule[mod].pass++;
    else if (r.status === 'FAIL')  byModule[mod].fail++;
    else                           byModule[mod].warn++;
  }

  const moduleRows = Object.entries(byModule).sort().map(([mod, { pass, fail, warn }]) => {
    const total = pass + fail + warn;
    const pct   = total > 0 ? ((pass / total) * 100).toFixed(0) : '0';
    const badge = fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass';
    return `<tr><td><b>${mod}</b></td><td>${pass}</td><td>${fail}</td><td>${warn}</td><td>${total}</td><td><span class="badge ${badge}">${pct}%</span></td></tr>`;
  }).join('');

  const failedRows = allFailed.slice(0, 100).map(f => {
    const fix = suggestFix(f.errorType ?? '', f.errorMessage ?? '', f.route ?? '');
    const sev = deriveSeverity(f.errorType ?? '', f.safetyCategory ?? '', f.module ?? '');
    const sevClass = sev === 'CRITICAL' ? 'fail' : sev === 'HIGH' ? 'warn' : 'pass';
    return `<tr>
      <td><code>${f.route ?? f.name ?? ''}</code></td>
      <td>${f.module ?? ''}</td>
      <td>${(f.actionLabel ?? f.buttonLabel ?? '').slice(0, 40)}</td>
      <td><span class="badge ${f.errorType === 'UNPROTECTED' ? 'fail' : 'warn'}">${f.errorType ?? f.status ?? ''}</span></td>
      <td>${(f.errorMessage ?? f.notes ?? '').slice(0, 100)}</td>
      <td>${fix.slice(0, 100)}</td>
      <td><span class="badge ${sevClass}">${sev}</span></td>
    </tr>`;
  }).join('');

  const inventoryRows = (inventory.actions ?? []).slice(0, 200).map((a: any) => {
    const catClass = a.safetyCategory === 'DANGEROUS' ? 'fail' : a.safetyCategory === 'FORM' ? 'warn' : a.safetyCategory === 'APPROVAL' ? 'info' : 'pass';
    return `<tr>
      <td><code>${a.route}</code></td>
      <td>${a.module}</td>
      <td>${a.actionType}</td>
      <td>${a.actionLabel.slice(0, 50)}</td>
      <td><span class="badge ${catClass}">${a.safetyCategory}</span></td>
    </tr>`;
  }).join('');

  const dangerRows = dangerResults.map(r => {
    const cls = r.status === 'PROTECTED' ? 'pass' : r.status === 'UNPROTECTED' ? 'fail' : 'warn';
    return `<tr>
      <td><code>${r.route}</code></td>
      <td>${r.module}</td>
      <td>${(r.buttonLabel ?? '').slice(0, 40)}</td>
      <td><span class="badge ${cls}">${r.status}</span></td>
      <td>${r.hasConfirmDialog ? '✅' : '❌'}</td>
      <td>${r.cancelWorks ? '✅' : '❌'}</td>
      <td>${r.notes.slice(0, 80)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pulse ERP — Action Audit Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.5; }
  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
  header { background: linear-gradient(135deg, #1a1f2e, #252b3b); border-radius: 12px; padding: 32px; margin-bottom: 24px; border: 1px solid #2d333b; }
  header h1 { font-size: 28px; font-weight: 700; color: #58a6ff; margin-bottom: 8px; }
  header p { color: #8b949e; font-size: 14px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-top: 24px; }
  .stat-card { background: #1c2128; border: 1px solid #30363d; border-radius: 8px; padding: 20px; text-align: center; }
  .stat-value { font-size: 32px; font-weight: 700; color: #58a6ff; }
  .stat-value.green { color: #3fb950; }
  .stat-value.red { color: #f85149; }
  .stat-value.yellow { color: #d29922; }
  .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  section h2 { font-size: 18px; font-weight: 600; color: #c9d1d9; margin-bottom: 16px; border-bottom: 1px solid #30363d; padding-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1c2128; color: #8b949e; padding: 10px 12px; text-align: left; font-weight: 500; border-bottom: 1px solid #30363d; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
  tr:hover td { background: #1c2128; }
  code { background: #2d333b; color: #79c0ff; padding: 2px 6px; border-radius: 4px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge.pass { background: #1c4532; color: #3fb950; }
  .badge.fail { background: #3d1c1c; color: #f85149; }
  .badge.warn { background: #3d2e00; color: #d29922; }
  .badge.info { background: #1c2e4a; color: #58a6ff; }
  .progress-bar { background: #21262d; border-radius: 4px; height: 8px; margin: 4px 0; }
  .progress-fill { height: 100%; border-radius: 4px; }
  .progress-fill.green { background: #3fb950; }
  .progress-fill.yellow { background: #d29922; }
  .progress-fill.red { background: #f85149; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { background: #1c2128; border: 1px solid #30363d; color: #8b949e; padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 12px; }
  .filter-btn:hover, .filter-btn.active { background: #2d333b; color: #c9d1d9; border-color: #58a6ff; }
  input[type="text"] { background: #1c2128; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; width: 100%; max-width: 300px; font-size: 13px; }
  input[type="text"]:focus { outline: none; border-color: #58a6ff; }
  .tab-nav { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid #30363d; }
  .tab-btn { background: none; border: none; color: #8b949e; padding: 10px 20px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; }
  .tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .score-ring { width: 120px; height: 120px; margin: 0 auto 16px; position: relative; }
</style>
</head>
<body>
<div class="container">

<header>
  <h1>🔍 Pulse ERP — Automated Action Audit Report</h1>
  <p>Generated: ${now} IST &nbsp;|&nbsp; Comprehensive button & workflow audit across all ${inventory.totalRoutes ?? 0} routes</p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${totalActions.toLocaleString()}</div>
      <div class="stat-label">Actions Discovered</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${safePassRate >= '90' ? 'green' : safePassRate >= '75' ? 'yellow' : 'red'}">${safePassRate}%</div>
      <div class="stat-label">Safe Action Pass Rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${dangerUnprotected === 0 ? 'green' : 'red'}">${dangerUnprotected}</div>
      <div class="stat-label">Unprotected Dangerous Actions</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${allFailed.length === 0 ? 'green' : allFailed.length < 10 ? 'yellow' : 'red'}">${allFailed.length}</div>
      <div class="stat-label">Total Failures</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formTotal}</div>
      <div class="stat-label">Forms Tested</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${dangerTotal}</div>
      <div class="stat-label">Delete Controls Verified</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${dashTotal}</div>
      <div class="stat-label">Dashboards Validated</div>
    </div>
    <div class="stat-card">
      <div class="stat-value ${dashPassed === dashTotal ? 'green' : 'yellow'}">${dashPassed}/${dashTotal}</div>
      <div class="stat-label">Dashboards Passing</div>
    </div>
  </div>
</header>

<section>
  <div class="tab-nav">
    <button class="tab-btn active" onclick="showTab('summary')">📊 Summary</button>
    <button class="tab-btn" onclick="showTab('failures')">❌ Failures (${allFailed.length})</button>
    <button class="tab-btn" onclick="showTab('dangerous')">🔒 Dangerous Actions</button>
    <button class="tab-btn" onclick="showTab('inventory')">📋 Full Inventory</button>
  </div>

  <!-- SUMMARY TAB -->
  <div id="tab-summary" class="tab-content active">
    <h2>Results by Module</h2>
    <input type="text" placeholder="Filter by module..." onkeyup="filterTable('module-table', this.value)" style="margin-bottom:12px">
    <table id="module-table">
      <thead><tr><th>Module</th><th>Pass</th><th>Fail</th><th>Warn</th><th>Total</th><th>Rate</th></tr></thead>
      <tbody>${moduleRows || '<tr><td colspan="6" style="text-align:center;color:#8b949e">No data yet — run suites 09-14 first</td></tr>'}</tbody>
    </table>

    <br>
    <h2>Phase Coverage</h2>
    <table>
      <thead><tr><th>Phase</th><th>Tested</th><th>Pass</th><th>Fail</th><th>Rate</th></tr></thead>
      <tbody>
        <tr><td>Phase 1 — Discovery</td><td>${totalActions}</td><td>—</td><td>—</td><td><span class="badge pass">COMPLETE</span></td></tr>
        <tr><td>Phase 2 — Safe Actions</td><td>${safeTotal}</td><td>${safePassed}</td><td>${safeTotal - safePassed}</td><td><span class="badge ${parseFloat(safePassRate) >= 90 ? 'pass' : 'warn'}">${safePassRate}%</span></td></tr>
        <tr><td>Phase 3 — Form Actions</td><td>${formTotal}</td><td>${formPassed}</td><td>${formTotal - formPassed}</td><td><span class="badge ${formTotal > 0 && formPassed/formTotal >= 0.8 ? 'pass' : 'warn'}">${formTotal > 0 ? ((formPassed/formTotal)*100).toFixed(0)+'%' : 'N/A'}</span></td></tr>
        <tr><td>Phase 4 — Approvals</td><td>${approvalResults.length}</td><td>${approvalResults.filter(r => r.status === 'PASS').length}</td><td>${approvalResults.filter(r => r.status === 'FAIL').length}</td><td><span class="badge ${approvalResults.filter(r => r.status === 'FAIL').length === 0 ? 'pass' : 'fail'}">${approvalResults.filter(r => r.status === 'FAIL').length === 0 ? 'PASS' : 'FAIL'}</span></td></tr>
        <tr><td>Phase 5 — Dangerous Protection</td><td>${dangerTotal}</td><td>${dangerProtected}</td><td>${dangerUnprotected}</td><td><span class="badge ${dangerUnprotected === 0 ? 'pass' : 'fail'}">${dangerUnprotected === 0 ? '✅ PROTECTED' : '🚨 GAPS'}</span></td></tr>
        <tr><td>Phase 6 — Dashboards</td><td>${dashTotal}</td><td>${dashPassed}</td><td>${dashTotal - dashPassed}</td><td><span class="badge ${dashPassed === dashTotal ? 'pass' : 'warn'}">${dashTotal > 0 ? ((dashPassed/dashTotal)*100).toFixed(0)+'%' : 'N/A'}</span></td></tr>
      </tbody>
    </table>
  </div>

  <!-- FAILURES TAB -->
  <div id="tab-failures" class="tab-content">
    <h2>Failed Actions — ${allFailed.length} total</h2>
    ${allFailed.length === 0 ? '<p style="color:#3fb950;padding:20px">✅ No failures detected!</p>' : `
    <input type="text" placeholder="Search failures..." onkeyup="filterTable('fail-table', this.value)" style="margin-bottom:12px">
    <table id="fail-table">
      <thead><tr><th>Route</th><th>Module</th><th>Button</th><th>Error Type</th><th>Details</th><th>Suggested Fix</th><th>Severity</th></tr></thead>
      <tbody>${failedRows}</tbody>
    </table>`}
  </div>

  <!-- DANGEROUS ACTIONS TAB -->
  <div id="tab-dangerous" class="tab-content">
    <h2>Dangerous Action Protection — ${dangerTotal} checked</h2>
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-value green">${dangerProtected}</div><div class="stat-label">🔒 Protected</div></div>
      <div class="stat-card"><div class="stat-value ${dangerUnprotected > 0 ? 'red' : 'green'}">${dangerUnprotected}</div><div class="stat-label">🚨 Unprotected</div></div>
      <div class="stat-card"><div class="stat-value">${dangerResults.filter(r => r.status === 'NOT_FOUND').length}</div><div class="stat-label">🔍 Not Found</div></div>
    </div>
    <table>
      <thead><tr><th>Route</th><th>Module</th><th>Button</th><th>Status</th><th>Dialog?</th><th>Cancel?</th><th>Notes</th></tr></thead>
      <tbody>${dangerRows || '<tr><td colspan="7" style="text-align:center;color:#8b949e">Run dangerous-actions project first</td></tr>'}</tbody>
    </table>
  </div>

  <!-- FULL INVENTORY TAB -->
  <div id="tab-inventory" class="tab-content">
    <h2>Complete Action Inventory — ${totalActions} actions (first 200 shown)</h2>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterByCategory('all')">All</button>
      <button class="filter-btn" onclick="filterByCategory('SAFE')">SAFE</button>
      <button class="filter-btn" onclick="filterByCategory('FORM')">FORM</button>
      <button class="filter-btn" onclick="filterByCategory('APPROVAL')">APPROVAL</button>
      <button class="filter-btn" onclick="filterByCategory('DANGEROUS')">DANGEROUS</button>
    </div>
    <input type="text" placeholder="Search inventory..." onkeyup="filterTable('inv-table', this.value)" style="margin-bottom:12px">
    <table id="inv-table">
      <thead><tr><th>Route</th><th>Module</th><th>Type</th><th>Label</th><th>Category</th></tr></thead>
      <tbody id="inv-tbody">${inventoryRows || '<tr><td colspan="5" style="text-align:center;color:#8b949e">Run action-discovery project first</td></tr>'}</tbody>
    </table>
  </div>
</section>

</div>

<script>
function showTab(id) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  event.target.classList.add('active');
}

function filterTable(tableId, query) {
  const q = query.toLowerCase();
  const rows = document.getElementById(tableId)?.querySelectorAll('tbody tr') || [];
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function filterByCategory(cat) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  const rows = document.getElementById('inv-tbody')?.querySelectorAll('tr') || [];
  rows.forEach(row => {
    if (cat === 'all') { row.style.display = ''; return; }
    row.style.display = row.textContent.includes(cat) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

test('@P0 [AUDIT-REPORT] Generate complete action audit deliverables', async () => {
  fs.mkdirSync(REPORTS, { recursive: true });

  // Load all result files
  const inventory     = loadJSON('button-inventory.json', { totalRoutes: 0, totalActions: 0, actions: [] });
  const safeData      = loadJSON('safe-actions-results.json', { results: [] });
  const formData      = loadJSON('form-actions-results.json', { results: [] });
  const approvalData  = loadJSON('approval-workflow-results.json', { results: [] });
  const dangerData    = loadJSON('dangerous-actions-results.json', { results: [] });
  const dashData      = loadJSON('dashboard-validation-results.json', { results: [] });

  const safeResults     = safeData.results     as any[];
  const formResults     = formData.results     as any[];
  const approvalResults = approvalData.results as any[];
  const dangerResults   = dangerData.results   as any[];
  const dashResults     = dashData.results     as any[];

  const allFailed = [
    ...safeResults.filter((r: any) => r.status === 'FAIL'),
    ...formResults.filter((r: any) => r.status === 'FAIL'),
    ...approvalResults.filter((r: any) => r.status === 'FAIL'),
    ...dangerResults.filter((r: any) => r.status === 'UNPROTECTED'),
    ...dashResults.filter((r: any) => r.status === 'FAIL'),
  ];

  // ── 1. button-inventory.json (already generated by suite 09) ─────────────
  console.log(`\n📋 Inventory: ${inventory.totalActions} actions across ${inventory.totalRoutes} routes`);

  // ── 2. failed-actions.csv ──────────────────────────────────────────────────
  const csv = buildFailedCSV(allFailed);
  fs.writeFileSync(path.join(REPORTS, 'failed-actions.csv'), csv, 'utf8');
  console.log(`📄 Failed actions CSV: ${allFailed.length} entries → tests/reports/failed-actions.csv`);

  // ── 3. root-cause-analysis.md ──────────────────────────────────────────────
  const allResultStats = {
    safeTotal:    safeResults.length,
    formTotal:    formResults.length,
    approvalTotal: approvalResults.length,
    dangerTotal:  dangerResults.length,
    dashTotal:    dashResults.length,
    safePassRate: safeResults.length > 0 ? safeResults.filter((r: any) => r.status === 'PASS').length / safeResults.length : 1,
    formPassRate: formResults.length > 0 ? formResults.filter((r: any) => r.status === 'PASS').length / formResults.length : 1,
    dashPassRate: dashResults.length > 0 ? dashResults.filter((r: any) => r.status === 'PASS').length / dashResults.length : 1,
    dangerProtected: dangerResults.filter((r: any) => r.status === 'UNPROTECTED').length === 0,
    approvalOk:   approvalResults.filter((r: any) => r.status === 'FAIL').length === 0,
  };

  const rca = buildRootCauseAnalysis(allFailed, inventory, allResultStats);
  fs.writeFileSync(path.join(REPORTS, 'root-cause-analysis.md'), rca, 'utf8');
  console.log(`📄 Root cause analysis → tests/reports/root-cause-analysis.md`);

  // ── 4. production-readiness-update.md ─────────────────────────────────────
  const prUpdate = buildProductionReadiness(allFailed, allResultStats, inventory);
  fs.writeFileSync(path.join(REPORTS, 'production-readiness-update.md'), prUpdate, 'utf8');
  console.log(`📄 Production readiness update → tests/reports/production-readiness-update.md`);

  // ── 5. action-audit-report.html ───────────────────────────────────────────
  const html = buildHTMLReport(inventory, safeResults, formResults, approvalResults, dangerResults, dashResults);
  fs.writeFileSync(path.join(REPORTS, 'action-audit-report.html'), html, 'utf8');
  console.log(`🌐 HTML report → tests/reports/action-audit-report.html`);

  console.log('\n✅ All deliverables generated:');
  console.log('   📦 tests/reports/button-inventory.json');
  console.log('   🌐 tests/reports/action-audit-report.html');
  console.log('   📄 tests/reports/failed-actions.csv');
  console.log('   🔍 tests/reports/root-cause-analysis.md');
  console.log('   🏭 tests/reports/production-readiness-update.md');

  // Final assertion: no CRITICAL failures
  const criticalFails = allFailed.filter((f: any) =>
    f.errorType === 'UNPROTECTED' || f.errorType === 'PAGE_CRASH'
  );
  if (criticalFails.length > 0) {
    const list = criticalFails.slice(0, 5).map((f: any) =>
      `${f.route ?? f.name}: ${f.errorType}`
    ).join('\n  ');
    throw new Error(`${criticalFails.length} CRITICAL issues require immediate attention:\n  ${list}`);
  }
}, { timeout: 60_000 });
