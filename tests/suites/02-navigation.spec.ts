/**
 * Suite 02 — Navigation Tests
 *
 * Verifies the sidebar hover-based navigation mechanism:
 *   - Hover over a top-level menu item reveals a fly-out submenu panel
 *   - Clicking a submenu item navigates to the correct page
 *   - Direct URL navigation matches expected page content
 *   - Redirects defined in App.jsx resolve correctly
 */

import { test, expect } from '../fixtures/base';
import { waitForPageLoad, assertNoErrorBoundary } from '../helpers/page-helpers';

const BASE = 'http://localhost:5173';

// ─── Helper: hover sidebar item, wait for submenu panel ──────────────────────

async function openSubmenu(page: Parameters<typeof test>[1] extends (args: { page: infer P }) => unknown ? P : never, itemName: string) {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();

  // Find sidebar list item containing the label text
  const navItem = sidebar.locator('li').filter({ hasText: itemName }).first();
  await navItem.hover();

  // Wait for the fly-out submenu panel to appear
  const panel = page.locator('.submenu-panel.panel--visible');
  await expect(panel).toBeVisible({ timeout: 5_000 });

  return panel;
}

// ─── Test: sidebar renders and expands on hover ───────────────────────────────

test('@P0 Sidebar is visible after login', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('@P0 Home nav item is present in sidebar', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);
  const homeBtn = page.locator('.sidebar').getByRole('button', { name: /^Home$/i });
  await expect(homeBtn).toBeVisible();
});

test('@P0 Clicking Home in sidebar navigates to /', async ({ page }) => {
  await page.goto(`${BASE}/EmployeesData`);
  await waitForPageLoad(page);

  await page.locator('.sidebar').getByRole('button', { name: /^Home$/i }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 8_000 });
  expect(page.url()).toBe(`${BASE}/`);
});

// ─── Test: submenu fly-out ────────────────────────────────────────────────────

test('@P1 HR submenu opens on hover and shows expected items', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'HR');

  const expectedItems = ['Announcements', 'Payroll Center', 'Employee Directory', 'Offboarding'];
  for (const item of expectedItems) {
    await expect(panel.getByRole('button', { name: item })).toBeVisible();
  }
});

test('@P1 Employees submenu opens and clicking "All Employees" navigates correctly', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'Employees');
  await panel.getByRole('button', { name: 'All Employees' }).click();

  await page.waitForURL(`${BASE}/EmployeesData`, { timeout: 10_000 });
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
});

test('@P1 Finance submenu opens and clicking "Finance Dashboard" navigates correctly', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'Finance');
  await panel.getByRole('button', { name: 'Finance Dashboard' }).click();

  await page.waitForURL(`${BASE}/FinanceDashboardNew`, { timeout: 10_000 });
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
});

test('@P1 Attendance submenu opens and clicking "My Attendance" navigates correctly', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'Attendance');
  await panel.getByRole('button', { name: 'My Attendance' }).click();

  await page.waitForURL(`${BASE}/AttendanceDashboard`, { timeout: 10_000 });
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
});

test('@P1 CRM submenu opens and clicking "Leads" navigates correctly', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'CRM');
  await panel.getByRole('button', { name: 'Leads' }).click();

  await page.waitForURL(`${BASE}/Leads`, { timeout: 10_000 });
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
});

test('@P1 Projects submenu opens and "Dashboard" navigates correctly', async ({ page }) => {
  await page.goto(BASE);
  await waitForPageLoad(page);

  const panel = await openSubmenu(page, 'Projects');
  await panel.getByRole('button', { name: 'Dashboard' }).click();

  await page.waitForURL(`${BASE}/ProjectsDashboard`, { timeout: 10_000 });
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
});

// ─── Test: App.jsx redirects resolve correctly ────────────────────────────────

const redirectCases: Array<{ from: string; to: string; label: string }> = [
  { from: '/JournalEntry',        to: '/AccountingEngine',  label: 'JournalEntry → AccountingEngine' },
  // ChartOfAccounts/PeriodClosing/CostCenters removed from this list 2026-08-04:
  // AccountingEngine has no tab covering any of the three, so the redirect made
  // three real, complete pages unreachable — see MODULE_FEATURE_CONNECTION_
  // MANUAL.md §24. Now covered by directNavCases below instead.
  { from: '/CustomerOutstanding', to: '/ReceivablesPage',   label: 'CustomerOutstanding → ReceivablesPage' },
  { from: '/CreditNotes',         to: '/ReceivablesPage',   label: 'CreditNotes → ReceivablesPage' },
  { from: '/SupplierBills',       to: '/PayablesPage',      label: 'SupplierBills → PayablesPage' },
  { from: '/BankAccounts',        to: '/PaymentBatch',      label: 'BankAccounts → PaymentBatch' },
  { from: '/Tickets',             to: '/SupportDashboard',  label: 'Tickets → SupportDashboard' },
];

for (const { from, to, label } of redirectCases) {
  test(`@P1 Redirect: ${label}`, async ({ page }) => {
    await page.goto(`${BASE}${from}`);
    await page.waitForURL(`${BASE}${to}`, { timeout: 8_000 });
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
  });
}

// ─── Test: 404 / unknown route renders Home (catch-all) ──────────────────────

test('@P2 Unknown route renders Home page (catch-all)', async ({ page }) => {
  await page.goto(`${BASE}/ThisPageDoesNotExist_xyz`);
  await waitForPageLoad(page);
  // The catch-all route renders ROUTES['Home'] for unknown page keys
  await expect(page.locator('.sidebar')).toBeVisible();
  await assertNoErrorBoundary(page);
});

// ─── Test: direct URL navigation for key pages ────────────────────────────────

const directNavCases = [
  { path: '/ApprovalCenter',    name: 'ApprovalCenter' },
  { path: '/NotificationCenter',name: 'NotificationCenter' },
  { path: '/OrgChart',          name: 'OrgChart' },
  { path: '/AuditLogs',         name: 'AuditLogs' },
  { path: '/SettingsCenter',    name: 'SettingsCenter' },
  { path: '/ChartOfAccounts',   name: 'ChartOfAccounts' },
  { path: '/PeriodClosing',     name: 'PeriodClosing' },
  { path: '/CostCenters',       name: 'CostCenters' },
];

for (const { path, name } of directNavCases) {
  test(`@P1 Direct URL navigation to ${name}`, async ({ page }) => {
    await page.goto(`${BASE}${path}`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await expect(page.locator('.page-content')).toBeVisible();
  });
}
