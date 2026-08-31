/**
 * Pulse ERP — Production Readiness Reporter
 *
 * Generates tests/reports/production-readiness-report.md after every full run.
 *
 * Scoring model (100 points total):
 *
 *   Route Coverage   (25 pts) — % of routes that passed smoke tests
 *   CRUD Coverage    (20 pts) — % of CRUD module tests that passed
 *   Dashboard Health (20 pts) — % of dashboard tests that passed
 *   API Health       (20 pts) — read from api-health-report.json if present
 *   Security         (10 pts) — P0 auth/security test pass rate
 *   Stability        ( 5 pts) — no flaky / retry-required tests
 *
 * Release Recommendation:
 *   ≥ 90 → PRODUCTION READY
 *   ≥ 75 → STAGING READY (minor issues)
 *   ≥ 60 → DEVELOPMENT READY (significant issues)
 *   < 60 → NOT READY (critical failures)
 */

import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  FullResult,
  Suite,
} from '@playwright/test/reporter';

import fs   from 'fs';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestRecord {
  title:    string;
  file:     string;
  suite:    string;
  status:   string;
  severity: string;
  module:   string;
  duration: number;
  retries:  number;
  errors:   string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSeverity(title: string): string {
  if (title.includes('@P0')) return 'P0';
  if (title.includes('@P1')) return 'P1';
  if (title.includes('@P2')) return 'P2';
  return 'P2';
}

function extractSuite(file: string): string {
  const m = file.match(/(\d\d-[\w-]+)\.spec/);
  return m?.[1] ?? 'unknown';
}

function extractModule(title: string, file: string): string {
  const bracket = title.match(/\[([A-Z][A-Z_\-]+)\]/);
  if (bracket) return bracket[1].toLowerCase().replace(/_/g, '-');

  const fileMod = file.match(/(?:03-crud\/|suites\/)([\w-]+)\.spec/);
  return fileMod?.[1] ?? 'general';
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function pct(pass: number, total: number): number {
  return total === 0 ? 100 : Math.round((pass / total) * 100);
}

function scoreBar(score: number, max: number): string {
  const filled = Math.round((score / max) * 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function statusEmoji(s: string): string {
  return s === 'passed' ? '✅' : s === 'failed' ? '❌' : s === 'timedOut' ? '⏱' : '⚠️';
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

class ProductionReadinessReporter implements Reporter {
  private records: TestRecord[] = [];
  private totalTests = 0;
  private startTime  = 0;

  onBegin(_config: FullConfig, _suite: Suite) {
    this.startTime = Date.now();
    fs.mkdirSync('tests/reports', { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.totalTests++;

    const errors = result.errors
      .map(e => (e.message ?? String(e)).split('\n')[0])
      .filter(Boolean);

    this.records.push({
      title:    test.title,
      file:     test.location.file,
      suite:    extractSuite(test.location.file),
      status:   result.status,
      severity: extractSeverity(test.title),
      module:   extractModule(test.title, test.location.file),
      duration: result.duration,
      retries:  result.retry,
      errors,
    });
  }

  onEnd(result: FullResult) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    // ── Partition by suite type ─────────────────────────────────────────────
    const smokeSuite  = this.records.filter(r => r.suite.includes('01-smoke'));
    const navSuite    = this.records.filter(r => r.suite.includes('02-nav'));
    const crudSuite   = this.records.filter(r => r.suite.includes('03-crud') || r.title.includes('[EMP-') || r.title.includes('[LEAVE-') || r.title.includes('[PROJ-'));
    const dashSuite   = this.records.filter(r => r.suite.includes('04-dash') || r.suite.includes('07-dash'));
    const apiSuite    = this.records.filter(r => r.suite.includes('00-api') || r.title.includes('API:'));
    const dbSuite     = this.records.filter(r => r.suite.includes('06-db'));
    const routeSuite  = this.records.filter(r => r.suite.includes('08-route'));
    const p0Records   = this.records.filter(r => r.severity === 'P0');
    const allFailed   = this.records.filter(r => r.status === 'failed' || r.status === 'timedOut');
    const flaky       = this.records.filter(r => r.retries > 0);

    // ── Score calculation ───────────────────────────────────────────────────

    // Route Coverage (25 pts)
    const routePass    = smokeSuite.filter(r => r.status === 'passed').length;
    const routePct     = pct(routePass, smokeSuite.length);
    const routeScore   = clamp(Math.round((routePct / 100) * 25), 0, 25);

    // CRUD Coverage (20 pts)
    const crudPass     = crudSuite.filter(r => r.status === 'passed').length;
    const crudPct      = pct(crudPass, crudSuite.length);
    const crudScore    = clamp(Math.round((crudPct / 100) * 20), 0, 20);

    // Dashboard Health (20 pts)
    const dashPass     = dashSuite.filter(r => r.status === 'passed').length;
    const dashPct      = pct(dashPass, dashSuite.length);
    const dashScore    = clamp(Math.round((dashPct / 100) * 20), 0, 20);

    // API Health (20 pts) — prefer api-health-report.json, fallback to apiSuite
    let apiScore = 0;
    let apiPct   = 0;
    let apiPassCount = 0;
    let apiTotalCount = 0;

    try {
      const healthPath = 'tests/reports/api-health-report.json';
      if (fs.existsSync(healthPath)) {
        const health  = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
        apiPassCount  = health.passed   ?? 0;
        apiTotalCount = health.totalEndpoints ?? 0;
        apiPct        = apiTotalCount ? Math.round((apiPassCount / apiTotalCount) * 100) : 100;
        // Security alerts deduct 2 pts each (max -10)
        const secPenalty = Math.min(10, (health.securityAlerts?.length ?? 0) * 2);
        apiScore = clamp(Math.round((apiPct / 100) * 20) - secPenalty, 0, 20);
      }
    } catch { /* file may not exist */ }

    if (apiTotalCount === 0 && apiSuite.length > 0) {
      apiPassCount  = apiSuite.filter(r => r.status === 'passed').length;
      apiTotalCount = apiSuite.length;
      apiPct        = pct(apiPassCount, apiTotalCount);
      apiScore      = clamp(Math.round((apiPct / 100) * 20), 0, 20);
    } else if (apiTotalCount === 0) {
      apiScore = 10; // neutral — not run
      apiPct   = 100;
    }

    // Security (10 pts) — P0 auth/security test pass rate
    const secTests   = p0Records.filter(r =>
      r.title.toLowerCase().includes('auth') ||
      r.title.toLowerCase().includes('security') ||
      r.title.toLowerCase().includes('unauthorized') ||
      r.suite.includes('00-api')
    );
    const secPass    = secTests.filter(r => r.status === 'passed').length;
    const secPct     = pct(secPass, secTests.length);
    const secScore   = clamp(Math.round((secPct / 100) * 10), 0, 10);

    // Stability (5 pts) — deduct per flaky test
    const flakyPenalty = Math.min(5, flaky.length);
    const stabScore    = clamp(5 - flakyPenalty, 0, 5);

    const totalScore = routeScore + crudScore + dashScore + apiScore + secScore + stabScore;

    // ── Recommendation ──────────────────────────────────────────────────────
    let recommendation: string;
    let recEmoji: string;
    if (totalScore >= 90) {
      recommendation = 'PRODUCTION READY — all critical checks pass';
      recEmoji       = '🟢';
    } else if (totalScore >= 75) {
      recommendation = 'STAGING READY — minor issues present, review before prod';
      recEmoji       = '🟡';
    } else if (totalScore >= 60) {
      recommendation = 'DEVELOPMENT READY — significant issues require fixing';
      recEmoji       = '🟠';
    } else {
      recommendation = 'NOT READY — critical failures block release';
      recEmoji       = '🔴';
    }

    // ── P0 failures (critical bugs) ─────────────────────────────────────────
    const p0Failures = allFailed.filter(r => r.severity === 'P0');

    // ── Module health table ─────────────────────────────────────────────────
    const moduleHealth: Record<string, { pass: number; fail: number; flaky: number }> = {};
    for (const r of this.records) {
      moduleHealth[r.module] ??= { pass: 0, fail: 0, flaky: 0 };
      if (r.status === 'passed')                               moduleHealth[r.module].pass++;
      else if (r.status === 'failed' || r.status === 'timedOut') moduleHealth[r.module].fail++;
      if (r.retries > 0)                                       moduleHealth[r.module].flaky++;
    }

    // ── Security findings ───────────────────────────────────────────────────
    let securityFindings: string[] = [];
    try {
      const hp = 'tests/reports/api-health-report.json';
      if (fs.existsSync(hp)) {
        const h = JSON.parse(fs.readFileSync(hp, 'utf8'));
        securityFindings = (h.securityAlerts ?? []).map((a: { module: string; path: string; issue: string }) =>
          `- **[${a.module}]** \`${a.path}\` — ${a.issue}`
        );
      }
    } catch { /* */ }

    // ── Build markdown ──────────────────────────────────────────────────────
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const moduleTable = Object.entries(moduleHealth)
      .sort(([, a], [, b]) => b.fail - a.fail)
      .map(([mod, h]) => {
        const health = h.fail === 0 ? '✅' : h.fail <= 2 ? '⚠️' : '❌';
        const total  = h.pass + h.fail;
        const rate   = total ? `${Math.round((h.pass / total) * 100)}%` : '—';
        return `| \`${mod}\` | ${h.pass} | ${h.fail} | ${h.flaky} | ${rate} | ${health} |`;
      })
      .join('\n');

    const p0Table = p0Failures.length
      ? p0Failures.map(r =>
          `| \`${r.module}\` | ${r.title.slice(0, 80)} | ${statusEmoji(r.status)} \`${r.status}\` | ${(r.duration / 1000).toFixed(1)}s |`
        ).join('\n')
      : '| — | No P0 failures — all critical tests passed | ✅ | — |';

    const md = `# Production Readiness Report — Pulse ERP
Generated: ${now} IST | Duration: ${elapsed}s | Total tests: ${this.totalTests}

---

## ${recEmoji} Final Score: ${totalScore} / 100

\`\`\`
${scoreBar(totalScore, 100)} ${totalScore}/100
\`\`\`

**Release Recommendation:** ${recommendation}

---

## Scoring Breakdown

| Category | Score | Max | % | Bar |
|----------|------:|----:|--:|-----|
| Route Coverage (smoke tests) | ${routeScore} | 25 | ${routePct}% | \`${scoreBar(routeScore, 25)}\` |
| CRUD Coverage | ${crudScore} | 20 | ${crudPct}% | \`${scoreBar(crudScore, 20)}\` |
| Dashboard Health | ${dashScore} | 20 | ${dashPct}% | \`${scoreBar(dashScore, 20)}\` |
| API Health | ${apiScore} | 20 | ${apiPct}% | \`${scoreBar(apiScore, 20)}\` |
| Security | ${secScore} | 10 | ${secPct}% | \`${scoreBar(secScore, 10)}\` |
| Stability (no flaky) | ${stabScore} | 5 | — | \`${scoreBar(stabScore, 5)}\` |

---

## Route Coverage — ${routePct}%

| Metric | Value |
|--------|-------|
| Smoke-tested routes | ${smokeSuite.length} |
| Passing | ${routePass} |
| Failing | ${smokeSuite.length - routePass} |

${smokeSuite.length === 0 ? '> ⚠️ No smoke tests were run (project `smoke` may not have been included).' : ''}

---

## CRUD Coverage — ${crudPct}%

| Metric | Value |
|--------|-------|
| CRUD tests run | ${crudSuite.length} |
| Passing | ${crudPass} |
| Failing | ${crudSuite.length - crudPass} |

${crudSuite.length === 0 ? '> ⚠️ No CRUD tests were run (projects `crud-*` / `db-consistency` may not have been included).' : ''}

---

## Dashboard Health — ${dashPct}%

| Metric | Value |
|--------|-------|
| Dashboard tests run | ${dashSuite.length} |
| Passing | ${dashPass} |
| Failing | ${dashSuite.length - dashPass} |

${dashSuite.length === 0 ? '> ⚠️ No dashboard tests were run (project `dashboard` may not have been included).' : ''}

---

## API Health — ${apiPct}%

| Metric | Value |
|--------|-------|
| Endpoints probed | ${apiTotalCount || '—'} |
| Passing | ${apiPassCount || '—'} |
| Score | ${apiScore}/20 |

${apiTotalCount === 0 ? '> ⚠️ `api-health-report.json` not found — run the `api-health` project to populate.' : ''}

---

## Security Findings

${securityFindings.length
  ? securityFindings.join('\n')
  : '✅ No security alerts detected.'}

---

## Critical Bugs (P0 Failures)

| Module | Test | Status | Duration |
|--------|------|--------|----------|
${p0Table}

---

## Module-by-Module Health

| Module | Pass | Fail | Flaky | Pass Rate | Health |
|--------|-----:|-----:|------:|----------:|--------|
${moduleTable || '| — | No tests recorded | — | — | — | — |'}

---

## Stability

| Metric | Value |
|--------|-------|
| Total tests | ${this.totalTests} |
| Passed | ${this.records.filter(r => r.status === 'passed').length} |
| Failed | ${this.records.filter(r => r.status === 'failed').length} |
| Timed out | ${this.records.filter(r => r.status === 'timedOut').length} |
| Flaky (needed retry) | ${flaky.length} |
| Skipped | ${this.records.filter(r => r.status === 'skipped').length} |

---

## Checklist Before Release

- [${routePct >= 95 ? 'x' : ' '}] Route coverage ≥ 95% (current: ${routePct}%)
- [${crudPct >= 90 ? 'x' : ' '}] CRUD coverage ≥ 90% (current: ${crudPct}%)
- [${dashPct >= 90 ? 'x' : ' '}] Dashboard health ≥ 90% (current: ${dashPct}%)
- [${apiPct >= 90 ? 'x' : ' '}] API health ≥ 90% (current: ${apiPct}%)
- [${securityFindings.length === 0 ? 'x' : ' '}] Zero security alerts
- [${p0Failures.length === 0 ? 'x' : ' '}] Zero P0 failures
- [${flaky.length === 0 ? 'x' : ' '}] Zero flaky tests

---

*Generated by Pulse ERP Automated Test Suite — Production Readiness Reporter*
*Playwright Test | ${new Date().getFullYear()}*
`;

    const outPath = 'tests/reports/production-readiness-report.md';
    fs.writeFileSync(outPath, md, 'utf8');
    console.log(`\n📋 Production Readiness Report → ${outPath}`);
    console.log(`   Score: ${totalScore}/100 | ${recEmoji} ${recommendation}`);
    console.log(`   Route: ${routePct}% | CRUD: ${crudPct}% | Dash: ${dashPct}% | API: ${apiPct}% | Sec: ${secPct}%`);
  }
}

export default ProductionReadinessReporter;
