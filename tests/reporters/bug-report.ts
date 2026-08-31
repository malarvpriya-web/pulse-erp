/**
 * Pulse ERP — Custom HTML Bug Reporter
 *
 * Generates tests/reports/bug-report.html after each run with:
 *   - Executive summary (pass/fail/skip counts)
 *   - Severity breakdown (P0 / P1 / P2)
 *   - Module-by-module health table
 *   - Full failure list with root cause, error message, screenshot link
 *   - Severity classification per failure
 *   - Timestamp, duration, browser info
 */

import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  FullResult,
  Suite,
} from '@playwright/test/reporter';

import fs from 'fs';

interface BugEntry {
  title: string;
  file: string;
  severity: string;
  module: string;
  status: string;
  duration: number;
  error: string;
  screenshot?: string;
  annotations: Array<{ type: string; description: string }>;
}

function extractSeverity(title: string): string {
  if (title.includes('@P0')) return 'P0';
  if (title.includes('@P1')) return 'P1';
  if (title.includes('@P2')) return 'P2';
  return 'Unknown';
}

function extractModule(title: string, file: string): string {
  const moduleMatch = title.match(/\[([A-Z_]+)\]/);
  if (moduleMatch) return moduleMatch[1];

  const fileMatch = file.match(/(?:03-crud\/)?([\w-]+)\.spec/);
  if (fileMatch) return fileMatch[1].replace(/-/g, '_').toUpperCase();

  return 'GENERAL';
}

function severityColor(sev: string): string {
  if (sev === 'P0') return '#dc2626';
  if (sev === 'P1') return '#d97706';
  if (sev === 'P2') return '#6b7280';
  return '#374151';
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    passed:  '#16a34a',
    failed:  '#dc2626',
    timedOut:'#7c3aed',
    skipped: '#6b7280',
    flaky:   '#d97706',
  };
  const color = colors[status] || '#374151';
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${status.toUpperCase()}</span>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class BugReporter implements Reporter {
  private bugs: BugEntry[] = [];
  private startTime = 0;
  private config!: FullConfig;

  onBegin(config: FullConfig, _suite: Suite) {
    this.config = config;
    this.startTime = Date.now();
    fs.mkdirSync('tests/reports', { recursive: true });
    fs.mkdirSync('tests/reports/screenshots', { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'passed') return; // only capture non-passes

    const sev = extractSeverity(test.title);
    const mod = extractModule(test.title, test.location.file);

    const errorMsg = result.errors
      .map(e => e.message?.split('\n')[0] || String(e))
      .join(' | ');

    const screenshot = result.attachments.find(a => a.name === 'screenshot')?.path;

    this.bugs.push({
      title: test.title,
      file: test.location.file.split(/[\\/]/).slice(-3).join('/'),
      severity: sev,
      module: mod,
      status: result.status,
      duration: result.duration,
      error: errorMsg,
      screenshot,
      annotations: (test.annotations || []).map(a => ({ type: a.type, description: (a as { description?: string }).description || '' })),
    });
  }

  onEnd(result: FullResult) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const totalFailed   = this.bugs.filter(b => b.status === 'failed').length;
    const totalTimedOut = this.bugs.filter(b => b.status === 'timedOut').length;
    const totalFlaky    = this.bugs.filter(b => b.status === 'flaky').length;

    const p0Failures = this.bugs.filter(b => b.severity === 'P0' && b.status !== 'passed').length;
    const p1Failures = this.bugs.filter(b => b.severity === 'P1' && b.status !== 'passed').length;
    const p2Failures = this.bugs.filter(b => b.severity === 'P2' && b.status !== 'passed').length;

    // Module breakdown
    const moduleMap: Record<string, { pass: number; fail: number }> = {};
    for (const b of this.bugs) {
      if (!moduleMap[b.module]) moduleMap[b.module] = { pass: 0, fail: 0 };
      if (b.status === 'failed' || b.status === 'timedOut') {
        moduleMap[b.module].fail++;
      } else {
        moduleMap[b.module].pass++;
      }
    }

    const moduleRows = Object.entries(moduleMap)
      .sort(([, a], [, b]) => b.fail - a.fail)
      .map(([mod, counts]) => {
        const health = counts.fail === 0 ? '✅' : counts.fail <= 2 ? '⚠️' : '❌';
        return `<tr>
          <td><strong>${mod}</strong></td>
          <td style="color:#dc2626">${counts.fail}</td>
          <td>${health}</td>
        </tr>`;
      }).join('');

    const bugRows = this.bugs.map(b => {
      const screenshotLink = b.screenshot
        ? `<a href="${b.screenshot}" target="_blank">📷 Screenshot</a>`
        : '—';

      const annotationText = b.annotations
        .map(a => `<em style="color:#6b7280">[${a.type}] ${escapeHtml(a.description)}</em>`)
        .join('<br>') || '—';

      const rootCause = classifyRootCause(b.error);

      return `<tr>
        <td>${statusBadge(b.status)}</td>
        <td style="color:${severityColor(b.severity)};font-weight:700">${b.severity}</td>
        <td>${escapeHtml(b.module)}</td>
        <td style="max-width:350px;word-break:break-word">${escapeHtml(b.title)}</td>
        <td style="font-family:monospace;font-size:11px;max-width:300px;word-break:break-all;color:#dc2626">${escapeHtml(b.error.slice(0, 200))}</td>
        <td style="font-size:11px;color:#6b7280">${rootCause}</td>
        <td style="font-size:11px">${annotationText}</td>
        <td>${(b.duration / 1000).toFixed(1)}s</td>
        <td>${screenshotLink}</td>
        <td style="font-size:11px;color:#6b7280">${escapeHtml(b.file)}</td>
      </tr>`;
    }).join('');

    const overallStatus = p0Failures > 0 ? '🔴 CRITICAL FAILURES' : totalFailed > 0 ? '🟡 FAILURES PRESENT' : '🟢 ALL PASSING';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pulse ERP — Automated Bug Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
  .header { background: linear-gradient(135deg, #1e3a5f, #2563eb); color: #fff; padding: 32px 40px; }
  .header h1 { font-size: 28px; font-weight: 700; }
  .header p { font-size: 14px; opacity: 0.8; margin-top: 6px; }
  .status-banner { font-size: 22px; margin-top: 12px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 32px 40px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); border-left: 4px solid #e2e8f0; }
  .card.danger { border-color: #dc2626; }
  .card.warning { border-color: #d97706; }
  .card.success { border-color: #16a34a; }
  .card .val { font-size: 36px; font-weight: 800; }
  .card .lbl { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; margin-top: 4px; }
  h2 { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #1e293b; border-left: 4px solid #2563eb; padding-left: 12px; }
  section { margin-bottom: 40px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); font-size: 13px; }
  th { background: #f1f5f9; padding: 10px 14px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #475569; }
  td { padding: 10px 14px; border-top: 1px solid #f1f5f9; vertical-align: top; }
  tr:hover { background: #f8fafc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; padding: 24px; }
</style>
</head>
<body>
<div class="header">
  <h1>⚡ Pulse ERP — Automated Bug Report</h1>
  <p>Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST &nbsp;|&nbsp; Duration: ${elapsed}s &nbsp;|&nbsp; Total failures captured: ${this.bugs.length}</p>
  <div class="status-banner">${overallStatus}</div>
</div>

<div class="container">

  <!-- Summary Cards -->
  <section>
    <h2>Executive Summary</h2>
    <div class="summary">
      <div class="card ${totalFailed > 0 ? 'danger' : 'success'}">
        <div class="val">${totalFailed}</div>
        <div class="lbl">Failed</div>
      </div>
      <div class="card ${totalTimedOut > 0 ? 'danger' : 'success'}">
        <div class="val">${totalTimedOut}</div>
        <div class="lbl">Timed Out</div>
      </div>
      <div class="card ${totalFlaky > 0 ? 'warning' : 'success'}">
        <div class="val">${totalFlaky}</div>
        <div class="lbl">Flaky</div>
      </div>
      <div class="card ${p0Failures > 0 ? 'danger' : 'success'}">
        <div class="val" style="color:#dc2626">${p0Failures}</div>
        <div class="lbl">P0 Failures (Critical)</div>
      </div>
      <div class="card ${p1Failures > 0 ? 'warning' : 'success'}">
        <div class="val" style="color:#d97706">${p1Failures}</div>
        <div class="lbl">P1 Failures</div>
      </div>
      <div class="card">
        <div class="val" style="color:#6b7280">${p2Failures}</div>
        <div class="lbl">P2 Failures</div>
      </div>
    </div>
  </section>

  <!-- Module Health -->
  ${moduleRows ? `<section>
    <h2>Module Health (failures only)</h2>
    <table>
      <thead><tr><th>Module</th><th>Failures</th><th>Status</th></tr></thead>
      <tbody>${moduleRows}</tbody>
    </table>
  </section>` : ''}

  <!-- Bug List -->
  <section>
    <h2>Failure Details (${this.bugs.length} issues)</h2>
    ${this.bugs.length === 0
      ? '<p style="color:#16a34a;font-size:16px;padding:20px 0">✅ No failures recorded in this run.</p>'
      : `<table>
      <thead><tr>
        <th>Status</th>
        <th>Sev.</th>
        <th>Module</th>
        <th>Test Title</th>
        <th>Error (first 200 chars)</th>
        <th>Root Cause</th>
        <th>Annotations</th>
        <th>Time</th>
        <th>Screenshot</th>
        <th>File</th>
      </tr></thead>
      <tbody>${bugRows}</tbody>
    </table>`}
  </section>

</div>
<div class="footer">
  Pulse ERP Automated Test Suite &nbsp;|&nbsp; Playwright ${process.env.npm_package_devDependencies_playwright || ''} &nbsp;|&nbsp; ${new Date().getFullYear()}
</div>
</body>
</html>`;

    const outPath = 'tests/reports/bug-report.html';
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`\n📄 Bug report: ${outPath}`);
  }
}

function classifyRootCause(error: string): string {
  if (!error) return '—';
  const e = error.toLowerCase();
  if (e.includes('timeout') || e.includes('timed out'))          return 'Timeout — slow load or API stall';
  if (e.includes('errorboundary') || e.includes('went wrong'))   return 'ErrorBoundary triggered';
  if (e.includes('unauthorized') || e.includes('403'))           return 'Auth / Permission gap';
  if (e.includes('404') || e.includes('not found'))              return 'Route or API endpoint missing';
  if (e.includes('empty') || e.includes('blank'))                return 'Page rendered blank content';
  if (e.includes('network') || e.includes('failed to fetch'))    return 'Network / CORS error';
  if (e.includes('console') || e.includes('console error'))      return 'JS console error';
  if (e.includes('locator') || e.includes('getbyrole'))          return 'Element not found — selector stale';
  if (e.includes('expect') || e.includes('tobevisible'))         return 'Assertion failed — UI element missing';
  if (e.includes('navigation') || e.includes('goto'))            return 'Navigation failed';
  return 'Unknown — see full trace';
}

export default BugReporter;
