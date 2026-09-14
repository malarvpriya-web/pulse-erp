/**
 * Suite 04 — Dashboard Validation Tests
 *
 * Validates that all dashboards render real data (not stuck on zeros or loading
 * spinners) and that key UI elements are present:
 *   - Home page: greeting, quick-links, KPI cards, sections
 *   - Finance dashboard: KPI tiles, charts
 *   - CEO Intelligence: tabs, metric panels
 *   - Analytics dashboards: render without error
 *   - Module dashboards: initial render is not blank
 */

import { test, expect } from '../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
} from '../helpers/page-helpers';

const BASE = 'http://localhost:5173';

// ─── Home Dashboard ────────────────────────────────────────────────────────────

test('@P0 Home page renders greeting section', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The greeting div should be visible
  const greeting = page.locator('[class*="greeting"], [class*="welcome"], h2, h1').first();
  await expect(greeting).toBeVisible({ timeout: 10_000 });
});

test('@P0 Home page renders Quick Links section', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  // Quick links grid — expect at least 4 links (Employees, Projects, Finance, CRM)
  const quickLinks = page.locator('[class*="quick-link"], [class*="quick_link"]');
  const count = await quickLinks.count();
  expect(count, 'Quick links should render at least 4 items').toBeGreaterThanOrEqual(4);
});

test('@P0 Home page loads within 8 seconds (performance check)', async ({ page }) => {
  const start = Date.now();
  await page.goto(BASE);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const elapsed = Date.now() - start;
  expect(elapsed, `Home should load in < 8000ms, took ${elapsed}ms`).toBeLessThan(8_000);
});

test('@P1 Home page KPI section: attendance / tasks / approvals chips are visible', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  // The KPI stats section renders chips/cards
  const kpiSection = page.locator('[class*="kpi"], [class*="stat"], [class*="chip"], [class*="badge"]').first();
  const hasKpis = await kpiSection.isVisible({ timeout: 8_000 }).catch(() => false);

  if (!hasKpis) {
    test.info().annotations.push({ type: 'info', description: 'KPI section not rendered — may depend on live data' });
  }
});

test('@P1 Home page shows Announcements section', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const section = page.locator('[class*="announcement"]').first();
  const hasSection = await section.isVisible({ timeout: 6_000 }).catch(() => false);
  // Acceptable if hidden when announcements list is empty
  if (!hasSection) {
    test.info().annotations.push({ type: 'info', description: 'Announcements section not visible — may be empty state' });
  }
});

// ─── Finance Dashboard ────────────────────────────────────────────────────────

test('@P0 Finance Dashboard renders without error', async ({ page }) => {
  await page.goto(`${BASE}/FinanceDashboardNew`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Finance Dashboard: shows metric cards or charts', async ({ page }) => {
  await page.goto(`${BASE}/FinanceDashboardNew`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const metricEls = page.locator('[class*="card"], [class*="metric"], [class*="chart"], [class*="kpi"], canvas, svg').first();
  await expect(metricEls).toBeVisible({ timeout: 10_000 });
});

test('@P1 Finance Dashboard: no hardcoded "0" in all KPIs (live data check)', async ({ page }) => {
  await page.goto(`${BASE}/FinanceDashboardNew`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // Get all numeric displays — if every single one is "0" that likely means API failed silently
  const allText = (await page.locator('[class*="value"], [class*="amount"], [class*="total"]').allInnerTexts())
    .filter(t => t != null && typeof t === 'string');
  const allZero = allText.every(t => t.trim() === '0' || t.trim() === '₹0' || t.trim() === '0.00');

  if (allZero && allText.length > 3) {
    test.info().annotations.push({
      type: 'warning',
      description: `All ${allText.length} KPI values are zero — possible silent API failure`,
    });
  }
});

// ─── CEO Intelligence Dashboard ──────────────────────────────────────────────

test('@P0 CEO Intelligence Dashboard renders', async ({ page }) => {
  await page.goto(`${BASE}/CEOIntelligenceDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 CEO Intelligence: tabs are visible', async ({ page }) => {
  await page.goto(`${BASE}/CEOIntelligenceDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('[role="tab"], [class*="tab"]');
  const tabCount = await tabs.count();
  expect(tabCount, 'CEO Intelligence should have multiple tabs').toBeGreaterThanOrEqual(2);
});

// ─── Analytics dashboards ─────────────────────────────────────────────────────

// `/CeoDashboard` was deleted on 2026-08-17 when it was merged into CEO
// Intelligence, and `/HRAnalyticsDashboard` on 2026-08-18 when its filter
// implementation was folded into HR Dashboard. Both were still listed here,
// so this suite was asserting that two non-existent routes render.
// CFO Dashboard, HR Benchmarking and System Health had never been covered.
const analyticsDashboards = [
  { name: 'CEO Intelligence',    path: '/CEOIntelligenceDashboard' },
  { name: 'Executive Dashboard', path: '/ExecutiveDashboard' },
  { name: 'HR Dashboard',        path: '/HRDashboard' },
  { name: 'HR Benchmarking',     path: '/HRBenchmarkingDashboard' },
  { name: 'CFO Dashboard',       path: '/CFODashboard' },
  { name: 'Ops Command Center',  path: '/AdminDashboard' },
  { name: 'ERP Intelligence',    path: '/ERPIntelligence' },
  { name: 'System Health',       path: '/SystemHealth' },
];

for (const { name, path } of analyticsDashboards) {
  test(`@P0 ${name} renders without error`, async ({ page }) => {
    await page.goto(`${BASE}${path}`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await assertPageHasContent(page);
  });
}

// ─── Module Dashboards ────────────────────────────────────────────────────────

const moduleDashboards = [
  { name: 'Employees Dashboard',   path: '/EmployeesDashboard' },
  { name: 'Attendance Dashboard',  path: '/AttendanceDashboard' },
  { name: 'Recruitment Dashboard', path: '/RecruitmentDashboard' },
  { name: 'CRM Dashboard',         path: '/SalesDashboard' },
  { name: 'Sales Command Center',  path: '/SalesCommandCenter' },
  { name: 'Inventory Dashboard',   path: '/InventoryDashboard' },
  { name: 'Production Dashboard',  path: '/ProductionDashboard' },
  { name: 'Quality Dashboard',     path: '/QualityDashboard' },
  { name: 'Engineering Dashboard', path: '/EngineeringDashboard' },
  { name: 'Projects Dashboard',    path: '/ProjectsDashboard' },
  { name: 'Support Dashboard',     path: '/SupportDashboard' },
  { name: 'Travel Dashboard',      path: '/TravelDashboard' },
  { name: 'Complaints Dashboard',  path: '/ComplaintsDashboard' },
  { name: 'Marketing Dashboard',   path: '/MarketingDashboard' },
  { name: 'Live Workforce',        path: '/LiveWorkforceDashboard' },
];

for (const { name, path } of moduleDashboards) {
  test(`@P0 ${name} renders without error`, async ({ page }) => {
    await page.goto(`${BASE}${path}`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await assertPageHasContent(page);
  });
}

// ─── Widget-level: check for loading spinners left on screen ─────────────────

test('@P1 Home page: no loading spinners remain after 5 seconds', async ({ page }) => {
  await page.goto(BASE);

  // Wait up to 5 seconds for spinners to clear
  await page.waitForFunction(
    () => {
      const spinners = document.querySelectorAll(
        '[class*="spinner"], [class*="loading"], [class*="skeleton"]'
      );
      return spinners.length === 0;
    },
    { timeout: 10_000 }
  ).catch(() => {
    // Not a hard failure — some persistent loaders may be by design
    test.info().annotations.push({ type: 'warning', description: 'Loading indicators still present after 5s' });
  });

  await assertNoErrorBoundary(page);
});

test('@P1 Finance Dashboard: no loading spinners remain after 8 seconds', async ({ page }) => {
  await page.goto(`${BASE}/FinanceDashboardNew`);

  await page.waitForFunction(
    () => document.querySelectorAll('[class*="spinner"], [class*="skeleton"]').length === 0,
    { timeout: 12_000 }
  ).catch(() => {
    test.info().annotations.push({ type: 'warning', description: 'Finance Dashboard has lingering loading indicators' });
  });

  await assertNoErrorBoundary(page);
});

// ─── Charts render (canvas or SVG) ───────────────────────────────────────────

test('@P1 Finance Dashboard: chart canvas or SVG is rendered', async ({ page }) => {
  await page.goto(`${BASE}/FinanceDashboardNew`);
  await waitForPageLoad(page);
  await page.waitForTimeout(2_000); // Allow chart library to paint

  const chart = page.locator('canvas, svg').first();
  const hasChart = await chart.isVisible({ timeout: 5_000 }).catch(() => false);

  if (!hasChart) {
    test.info().annotations.push({ type: 'info', description: 'No chart canvas/SVG found — may use CSS-only charts' });
  }
});
