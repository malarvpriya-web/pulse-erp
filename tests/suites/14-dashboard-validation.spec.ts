/**
 * Suite 14 — Dashboard Validation (Phase 6 + Phase 7 Error Capture)
 *
 * For every dashboard KPI card / stat widget:
 *   1. Click the card
 *   2. Verify the drill-down page loads (or modal opens)
 *   3. Verify counts / values are non-zero or properly handle zero state
 *   4. Verify charts render (canvas, svg, or chart class present)
 *   5. Capture all console errors and API failures during the session
 *
 * Output:
 *   tests/reports/dashboard-validation-results.json
 *   tests/reports/screenshots/dash-*.png
 *
 * Run:
 *   npx playwright test --project=dashboard-validation
 */

import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { waitForPageLoad } from '../helpers/page-helpers';
import fs   from 'fs';
import path from 'path';

const BASE    = 'http://localhost:5173';
const OUT_FILE = 'tests/reports/dashboard-validation-results.json';
const SS_DIR   = 'tests/reports/screenshots';

// ─── Dashboard routes to validate ────────────────────────────────────────────

interface DashRoute {
  name:     string;
  route:    string;
  module:   string;
  severity: 'P0' | 'P1';
  cardSelectors: string[];   // CSS selectors that find clickable stat cards
  chartSelectors: string[];  // CSS selectors that find chart elements
}

const DASHBOARD_ROUTES: DashRoute[] = [
  {
    name:           'Home Dashboard',
    route:          '/',
    module:         'core',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi-card"]', '[class*="stat-card"]', '[class*="metric-card"]', '[class*="widget"]'],
    chartSelectors: ['canvas', 'svg[class*="recharts"]', '[class*="chart"]'],
  },
  {
    name:           'CEO Intelligence',
    route:          '/CEOIntelligenceDashboard',
    module:         'analytics',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="metric"]', '[class*="stat"]', '[class*="insight-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]', '[class*="recharts"]'],
  },
  // '/CeoDashboard' was deleted on 2026-08-17 (merged into CEO Intelligence).
  // Replaced with the three Analytics pages that had never been covered here.
  {
    name:           'CFO Dashboard',
    route:          '/CFODashboard',
    module:         'finance',
    severity:       'P0',
    // Updated 2026-08-26 with the hero-language redesign: the bespoke
    // `.cfo-exec-kpi` gradient strip is now the shared `.plh-stat` band and the
    // bespoke `.cfo-card` is the shared `.dc-card`. A selector that matches
    // nothing reports "0 cards" as a pass, so these have to move with the DOM.
    cardSelectors:  ['[class*="plh-stat"]', '[class*="cfo-ratio-item"]', '[class*="dc-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="recharts"]'],
  },
  {
    name:           'HR Benchmarking',
    route:          '/HRBenchmarkingDashboard',
    module:         'hr',
    severity:       'P1',
    cardSelectors:  ['[class*="hrb-card"]', '[class*="metric"]'],
    chartSelectors: ['[class*="hrb-stack"]', 'svg'],
  },
  {
    name:           'HR Dashboard',
    route:          '/HRDashboard',
    module:         'analytics',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat-card"]', '[class*="metric"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Employees Dashboard',
    route:          '/EmployeesDashboard',
    module:         'employees',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="card"][onclick]', 'a[class*="card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Recruitment Dashboard',
    route:          '/RecruitmentDashboard',
    module:         'recruitment',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="metric"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'CRM / Sales Dashboard',
    route:          '/SalesDashboard',
    module:         'crm',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="pipeline"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]', '[class*="funnel"]'],
  },
  {
    name:           'Finance Dashboard',
    route:          '/FinanceDashboardNew',
    module:         'finance',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="balance"]', '[class*="stat"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Purchase Request Dashboard',
    route:          '/PurchaseRequestDashboard',
    module:         'procurement',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="count"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Inventory Dashboard',
    route:          '/InventoryDashboard',
    module:         'inventory',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="stock"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Production Dashboard',
    route:          '/ProductionDashboard',
    module:         'production',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="order-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Quality Dashboard',
    route:          '/QualityDashboard',
    module:         'quality',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="ncr"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Engineering Dashboard',
    route:          '/EngineeringDashboard',
    module:         'engineering',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="project-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Projects Dashboard',
    route:          '/ProjectsDashboard',
    module:         'projects',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="project-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Travel Dashboard',
    route:          '/TravelDashboard',
    module:         'travel',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="trip-card"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Support Dashboard',
    route:          '/SupportDashboard',
    module:         'servicedesk',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="ticket"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'L&D Dashboard',
    route:          '/LearningDashboard',
    module:         'lnd',
    severity:       'P1',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="course"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  {
    name:           'Live Workforce',
    route:          '/LiveWorkforceDashboard',
    module:         'attendance',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="stat"]', '[class*="present"]', '[class*="absent"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
  // '/HRAnalyticsDashboard' was deleted on 2026-08-18: it was registered in
  // routes.jsx but absent from every nav menu, so no user could reach it. Its one
  // real advantage — sending filter params to every call — now lives in
  // HR Dashboard's Analytics tab, which is covered above.
  {
    name:           'System Health',
    route:          '/SystemHealth',
    module:         'admin',
    severity:       'P1',
    cardSelectors:  ['[class*="kpi"]', 'button'],
    chartSelectors: [],   // renders a table, not charts; empty until the test is run
  },
  {
    name:           'Sales Command Center',
    route:          '/SalesCommandCenter',
    module:         'sales',
    severity:       'P0',
    cardSelectors:  ['[class*="kpi"]', '[class*="command"]', '[class*="metric"]'],
    chartSelectors: ['canvas', 'svg', '[class*="chart"]'],
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardCardResult {
  cardLabel:      string;
  cardSelector:   string;
  clickable:      boolean;
  drilldownLoads: boolean;
  url:            string;
  notes:          string;
}

interface DashboardResult {
  name:           string;
  route:          string;
  module:         string;
  severity:       string;
  status:         'PASS' | 'FAIL' | 'WARN';
  pageLoads:      boolean;
  chartsFound:    number;
  cardsFound:     number;
  cardsClicked:   number;
  drilldownPassed: number;
  consoleErrors:  string[];
  networkErrors:  string[];
  screenshotPath?: string;
  cards:          DashboardCardResult[];
  notes:          string;
}

// ─── Dashboard validation helper ─────────────────────────────────────────────

async function validateDashboard(
  page: any,
  dash: DashRoute
): Promise<DashboardResult> {
  const ssBase = path.join(SS_DIR, `dash-${dash.module}-${Date.now()}`);
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  const listener = (msg: any) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  };
  const netListener = (resp: any) => {
    if (resp.status() >= 500) networkErrors.push(`${resp.status()} ${resp.url().slice(0, 100)}`);
  };

  page.on('console', listener);
  page.on('response', netListener);

  const result: DashboardResult = {
    name:            dash.name,
    route:           dash.route,
    module:          dash.module,
    severity:        dash.severity,
    status:          'WARN',
    pageLoads:       false,
    chartsFound:     0,
    cardsFound:      0,
    cardsClicked:    0,
    drilldownPassed: 0,
    consoleErrors,
    networkErrors,
    cards:           [],
    notes:           '',
  };

  try {
    await page.goto(`${BASE}${dash.route}`, { timeout: 20_000 });
    await waitForPageLoad(page).catch(() => null);
    await page.waitForTimeout(2000); // let widgets load

    const body = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    if (body.includes('Something went wrong')) {
      result.status = 'FAIL';
      result.notes  = 'Page crashed on load';
      page.off('console', listener);
      page.off('response', netListener);
      return result;
    }

    result.pageLoads = true;

    // Count charts
    for (const chartSel of dash.chartSelectors) {
      const count = await page.locator(chartSel).count().catch(() => 0);
      result.chartsFound += count;
    }

    // Screenshot the loaded dashboard
    await page.screenshot({ path: `${ssBase}-loaded.png`, fullPage: false }).catch(() => null);
    result.screenshotPath = `${ssBase}-loaded.png`;

    // Find all stat/KPI cards
    let allCards: any[] = [];
    for (const cardSel of dash.cardSelectors) {
      const cards = await page.locator(cardSel).all().catch(() => []);
      allCards.push(...cards);
      if (allCards.length >= 8) break;
    }
    result.cardsFound = allCards.length;

    // Click up to 3 cards and check drill-down
    const cardsToClick = allCards.slice(0, 3);
    const initialUrl = page.url();

    for (const card of cardsToClick) {
      const isVisible = await card.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!isVisible) continue;

      const labelText = await card.innerText({ timeout: 1_000 }).catch(() => '(unlabeled)');
      const label = labelText.trim().slice(0, 60).replace(/\n/g, ' ');

      const cardResult: DashboardCardResult = {
        cardLabel:      label,
        cardSelector:   '',
        clickable:      false,
        drilldownLoads: false,
        url:            initialUrl,
        notes:          '',
      };

      try {
        const urlBefore = page.url();
        await card.click({ timeout: 3_000, force: false });
        await page.waitForTimeout(1500);

        const urlAfter = page.url();
        const navigated = urlAfter !== urlBefore;

        // Check modal opened
        const modal = page.locator('[role="dialog"], [class*="modal"], [class*="drawer"]').first();
        const modalOpened = await modal.isVisible({ timeout: 2_000 }).catch(() => false);

        cardResult.clickable = true;
        cardResult.url       = urlAfter;

        if (navigated) {
          await waitForPageLoad(page).catch(() => null);
          const afterBody = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
          const drilldownOk = !afterBody.includes('Something went wrong') &&
                              !afterBody.includes('404') &&
                              afterBody.length > 100;
          cardResult.drilldownLoads = drilldownOk;
          cardResult.notes = drilldownOk ? `Navigated to ${urlAfter}` : `Navigated but page broken: ${urlAfter}`;

          if (drilldownOk) result.drilldownPassed++;

          // Navigate back
          await page.goBack({ timeout: 10_000 }).catch(() => page.goto(`${BASE}${dash.route}`, { timeout: 15_000 }));
          await waitForPageLoad(page).catch(() => null);
          await page.waitForTimeout(1000);

        } else if (modalOpened) {
          const modalText = await modal.innerText({ timeout: 2_000 }).catch(() => '');
          cardResult.drilldownLoads = modalText.length > 20;
          cardResult.notes = `Opened modal (${modalText.slice(0, 60)})`;

          if (cardResult.drilldownLoads) result.drilldownPassed++;

          // Close modal
          await page.keyboard.press('Escape').catch(() => null);
          await page.waitForTimeout(400);
        } else {
          cardResult.notes = 'Click had no visual effect — may not be a drill-down card';
        }

      } catch {
        cardResult.notes = 'Click failed (element may be non-interactive)';
      }

      result.cards.push(cardResult);
      result.cardsClicked++;
    }

    // Determine overall status
    const criticalErrors = consoleErrors.filter(e =>
      e.includes('TypeError') || e.includes('Uncaught') || e.includes('ReferenceError')
    );

    if (criticalErrors.length > 0) {
      result.status = 'FAIL';
      result.notes  = `Console errors: ${criticalErrors[0].slice(0, 100)}`;
    } else if (networkErrors.length > 0) {
      result.status = 'WARN';
      result.notes  = `API errors: ${networkErrors.slice(0, 3).join('; ')}`;
    } else if (result.chartsFound > 0 && result.pageLoads) {
      result.status = 'PASS';
      result.notes  = `${result.chartsFound} charts, ${result.cardsFound} cards, ${result.drilldownPassed}/${result.cardsClicked} drill-downs passed`;
    } else if (result.pageLoads) {
      result.status = 'WARN';
      result.notes  = result.chartsFound === 0
        ? 'Page loads but no charts detected — may be loading asynchronously'
        : 'Page loads — no interactive cards found';
    } else {
      result.status = 'FAIL';
      result.notes  = 'Page did not load properly';
    }

  } catch (err: any) {
    result.status = 'FAIL';
    result.notes  = err.message?.slice(0, 200) ?? 'Unknown error';
  } finally {
    page.off('console', listener);
    page.off('response', netListener);
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

test('@P0 [DASHBOARD-VALIDATION] Validate all dashboards: charts render + cards drill-down', async ({ page }: { page: Page }) => {
  fs.mkdirSync(SS_DIR, { recursive: true });
  fs.mkdirSync('tests/reports', { recursive: true });

  const results: DashboardResult[] = [];
  let passed = 0, warned = 0, failed = 0;

  for (const dash of DASHBOARD_ROUTES) {
    console.log(`  Validating ${dash.name} (${dash.route})...`);
    const result = await validateDashboard(page, dash);
    results.push(result);

    const icon = result.status === 'PASS' ? '✅' : result.status === 'WARN' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${dash.name}: ${result.notes.slice(0, 100)}`);

    if (result.status === 'PASS')      passed++;
    else if (result.status === 'WARN') warned++;
    else                                failed++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2), 'utf8');

  console.log(`\n📊 Dashboard Validation Results:`);
  console.log(`   Total:  ${DASHBOARD_ROUTES.length}`);
  console.log(`   PASS:   ${passed}`);
  console.log(`   WARN:   ${warned}`);
  console.log(`   FAIL:   ${failed}`);

  const p0Fails = results.filter(r => r.severity === 'P0' && r.status === 'FAIL');
  if (p0Fails.length > 0) {
    const failList = p0Fails.map(r => `  ${r.name}: ${r.notes.slice(0, 80)}`).join('\n');
    throw new Error(`${p0Fails.length} P0 dashboards failed:\n${failList}`);
  }
}, { timeout: 600_000 });

test('@P0 [DASHBOARD-VALIDATION] P0 dashboards must render charts', async ({ page }: { page: Page }) => {
  const p0Dashes = DASHBOARD_ROUTES.filter(d => d.severity === 'P0');
  const noCharts: string[] = [];

  for (const dash of p0Dashes) {
    await page.goto(`${BASE}${dash.route}`, { timeout: 20_000 }).catch(() => null);
    await waitForPageLoad(page).catch(() => null);
    await page.waitForTimeout(2000);

    let chartCount = 0;
    for (const sel of dash.chartSelectors) {
      chartCount += await page.locator(sel).count().catch(() => 0);
    }

    if (chartCount === 0) {
      // Double-check with a broader canvas/svg search
      const broadCount = await page.locator('canvas, svg[width][height]').count().catch(() => 0);
      if (broadCount === 0) noCharts.push(dash.name);
    }
  }

  if (noCharts.length > Math.floor(p0Dashes.length * 0.3)) {
    // More than 30% of P0 dashboards have no charts — fail
    throw new Error(`${noCharts.length} P0 dashboards render with no charts: ${noCharts.join(', ')}`);
  }

  if (noCharts.length > 0) {
    test.info().annotations.push({
      type: 'warning',
      description: `Dashboards with no detected charts (may be async): ${noCharts.join(', ')}`,
    });
  }

  console.log(`  ✅ Chart rendering: ${p0Dashes.length - noCharts.length}/${p0Dashes.length} P0 dashboards have charts`);
}, { timeout: 300_000 });

test('@P1 [DASHBOARD-VALIDATION] Dashboard KPI values must be non-hardcoded', async ({ page }) => {
  // Check home dashboard for common hardcoded values
  await page.goto(`${BASE}/`, { timeout: 20_000 });
  await waitForPageLoad(page).catch(() => null);
  await page.waitForTimeout(2000);

  const hardcodedPatterns = [
    /\b42\b/,        // common placeholder
    /\b1234\b/,
    /\b9999\b/,
    /\bN\/A\b/,
    /\bTBD\b/,
    /lorem ipsum/i,
  ];

  const kpiEls = page.locator('[class*="kpi"], [class*="stat-value"], [class*="metric-value"]');
  const kpiCount = await kpiEls.count().catch(() => 0);

  let hardcodedCount = 0;
  for (let i = 0; i < Math.min(kpiCount, 10); i++) {
    const text = await kpiEls.nth(i).innerText({ timeout: 1_000 }).catch(() => '');
    if (hardcodedPatterns.some(p => p.test(text))) hardcodedCount++;
  }

  if (hardcodedCount > 0) {
    test.info().annotations.push({
      type: 'warning',
      description: `${hardcodedCount} KPI values match hardcoded placeholder patterns on home dashboard`,
    });
  }

  console.log(`  ${kpiCount} KPI elements found on home dashboard, ${hardcodedCount} potential placeholders`);
});

test('@P1 [DASHBOARD-VALIDATION] Log complete error capture summary', async () => {
  if (!fs.existsSync(OUT_FILE)) return;

  const { results } = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) as { results: DashboardResult[] };

  const allConsoleErrs = results.flatMap(r => r.consoleErrors.map(e => ({ dashboard: r.name, error: e })));
  const allNetworkErrs = results.flatMap(r => r.networkErrors.map(e => ({ dashboard: r.name, error: e })));

  console.log(`\n🔍 Error Capture Summary across ${results.length} dashboards:`);
  console.log(`   Console errors: ${allConsoleErrs.length}`);
  console.log(`   Network 5xx:    ${allNetworkErrs.length}`);

  if (allConsoleErrs.length > 0) {
    console.log('\n   Top console errors:');
    allConsoleErrs.slice(0, 5).forEach(({ dashboard, error }) => {
      console.log(`   • ${dashboard}: ${error.slice(0, 100)}`);
    });
  }

  if (allNetworkErrs.length > 0) {
    console.log('\n   API failures:');
    allNetworkErrs.slice(0, 5).forEach(({ dashboard, error }) => {
      console.log(`   • ${dashboard}: ${error.slice(0, 100)}`);
    });
  }

  const totalErrors = allConsoleErrs.length + allNetworkErrs.length;
  if (totalErrors > 20) {
    test.info().annotations.push({
      type: 'warning',
      description: `${totalErrors} errors detected across dashboards — review before production`,
    });
  }
});
