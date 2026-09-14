/**
 * Suite 01 — Smoke Tests
 *
 * Navigates to every known Pulse ERP route (160+) and asserts:
 *   1. No ErrorBoundary ("Something went wrong") fires
 *   2. The page renders actual content (not blank)
 *   3. The user is not bounced to Unauthorized
 *
 * Priority tags drive selective runs:
 *   npx playwright test --grep @P0   → mission-critical only
 *   npx playwright test --grep @P1   → P0 + P1
 *
 * Screenshots are captured on failure automatically (playwright.config).
 */

import { test, expect } from '../fixtures/base';
import { SMOKE_ROUTES, RouteConfig } from '../helpers/routes';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
  assertNotUnauthorized,
} from '../helpers/page-helpers';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function smokeCheck(page: Parameters<typeof test>[1] extends (args: { page: infer P }) => unknown ? P : never, route: RouteConfig) {
  await page.goto(`http://localhost:5173${route.path}`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertNotUnauthorized(page);
  await assertPageHasContent(page);
}

// ─── P0 Tests — Mission Critical ─────────────────────────────────────────────

const p0Routes = SMOKE_ROUTES.filter(r => r.severity === 'P0');

for (const route of p0Routes) {
  test(`@P0 [${route.module.toUpperCase()}] ${route.name} loads without error`, async ({ page }) => {
    await smokeCheck(page, route);
  });
}

// ─── P1 Tests — Important ─────────────────────────────────────────────────────

const p1Routes = SMOKE_ROUTES.filter(r => r.severity === 'P1');

for (const route of p1Routes) {
  test(`@P1 [${route.module.toUpperCase()}] ${route.name} loads without error`, async ({ page }) => {
    await smokeCheck(page, route);
  });
}

// ─── P2 Tests — Secondary / Settings ─────────────────────────────────────────

const p2Routes = SMOKE_ROUTES.filter(r => r.severity === 'P2');

for (const route of p2Routes) {
  test(`@P2 [${route.module.toUpperCase()}] ${route.name} loads without error`, async ({ page }) => {
    await smokeCheck(page, route);
  });
}

// ─── Summary assertion — count routes ────────────────────────────────────────

test('@P0 Smoke manifest covers all expected modules', async ({ page }) => {
  const modules = new Set(SMOKE_ROUTES.map(r => r.module));
  const expected = [
    'core', 'analytics', 'employees', 'hr', 'lnd', 'attendance', 'leaves',
    'finance', 'recruitment', 'talent', 'crm', 'sales', 'marketing',
    'procurement', 'inventory', 'production', 'quality', 'engineering',
    'projects', 'operations', 'timesheets', 'performance', 'complaints',
    'servicedesk', 'travel', 'reports', 'settings',
  ];

  for (const mod of expected) {
    expect(modules.has(mod), `Module "${mod}" missing from route manifest`).toBe(true);
  }

  // Just load home to satisfy "page must be used" requirement of the test
  await page.goto('http://localhost:5173/');
  await waitForPageLoad(page);
});
