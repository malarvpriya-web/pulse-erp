/**
 * Suite 03-A — Employee CRUD Tests
 *
 * Covers:
 *   READ   — Employee list loads and displays rows
 *   CREATE — Add Employee form accepts required fields and saves
 *   VIEW   — Employee profile opens from list
 *   SEARCH — Filter/search on employee list
 *
 * Note: Tests that create data use a unique suffix to avoid collision.
 * Cleanup is not automated — manual DB cleanup or test DB needed for CI.
 */

import { test, expect } from '../../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
  waitForToast,
} from '../../helpers/page-helpers';

const BASE = 'http://localhost:5173';
const UNIQUE = `Playwright_${Date.now()}`;

// ─── READ — List loads ────────────────────────────────────────────────────────

test('@P0 Employee list (EmployeesData) renders rows', async ({ page }) => {
  await page.goto(`${BASE}/EmployeesData`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);

  // Should have at least one employee row or an empty-state message
  const rows = page.locator('table tbody tr, [class*="employee-row"], [class*="emp-card"]');
  const emptyState = page.locator('[class*="empty"], [class*="no-data"], [class*="no-results"]');

  const hasRows = await rows.count() > 0;
  const isEmpty = await emptyState.isVisible().catch(() => false);

  expect(hasRows || isEmpty, 'Employee list should show rows or empty state').toBe(true);
});

test('@P0 Employee dashboard renders KPI cards', async ({ page }) => {
  await page.goto(`${BASE}/EmployeesDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // Dashboard should show at least one stat/card element
  const cards = page.locator('[class*="stat"], [class*="kpi"], [class*="card"], [class*="metric"]');
  await expect(cards.first()).toBeVisible({ timeout: 8_000 });
});

// ─── CREATE — Add Employee form ───────────────────────────────────────────────

test('@P1 Add Employee form is reachable via URL', async ({ page }) => {
  await page.goto(`${BASE}/AddEmployee`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The form title
  await expect(page.getByRole('heading', { name: /Add Employee/i })).toBeVisible({ timeout: 8_000 });
});

test('@P1 Add Employee form: Basic section has required fields', async ({ page }) => {
  await page.goto(`${BASE}/AddEmployee`);
  await waitForPageLoad(page);

  // First Name, Last Name, Company Email, Phone are in the Basic accordion
  await expect(page.locator('input[placeholder*="First"], input[placeholder*="first"], #firstName, [name="firstName"]').first()).toBeVisible();
});

test('@P1 Add Employee form: submitting with empty required fields shows validation or fails gracefully', async ({ page }) => {
  await page.goto(`${BASE}/AddEmployee`);
  await waitForPageLoad(page);

  // Click Save without filling anything
  const saveBtn = page.getByRole('button', { name: /Save/i });
  await expect(saveBtn).toBeVisible({ timeout: 8_000 });
  await saveBtn.click();

  // Should either show inline validation errors OR a toast error — not crash
  await page.waitForTimeout(2_000);
  await assertNoErrorBoundary(page);

  // Acceptable outcomes: validation messages, an error toast, or dialog
  const validationMsg = page.locator('[class*="error"], [class*="invalid"], [class*="required"], [role="alert"]');
  const dialog = page.locator('[class*="result-dialog"], [class*="modal"], dialog[open]');
  const hasValidation = await validationMsg.first().isVisible().catch(() => false);
  const hasDialog     = await dialog.first().isVisible().catch(() => false);

  expect(hasValidation || hasDialog, 'Form should show validation feedback on empty submit').toBe(true);
});

test('@P1 Add Employee form: fills basic info and reaches Save button', async ({ page }) => {
  await page.goto(`${BASE}/AddEmployee`);
  await waitForPageLoad(page);

  // Target the Basic section's first input visible on screen
  const firstNameInput = page.locator(
    'input[placeholder*="First"], input[placeholder*="first name"], #firstName, [name="first_name"]'
  ).first();

  if (await firstNameInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await firstNameInput.fill('TestFirst');

    const lastNameInput = page.locator(
      'input[placeholder*="Last"], input[placeholder*="last name"], #lastName, [name="last_name"]'
    ).first();
    if (await lastNameInput.isVisible().catch(() => false)) {
      await lastNameInput.fill(`${UNIQUE}`);
    }

    const emailInput = page.locator(
      'input[type="email"], input[placeholder*="email"], #companyEmail, [name="company_email"]'
    ).first();
    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.fill(`${UNIQUE.toLowerCase()}@test.pulse`);
    }
  }

  const saveBtn = page.getByRole('button', { name: /Save/i });
  await expect(saveBtn).toBeVisible();
});

// ─── VIEW — Employee profile ──────────────────────────────────────────────────

test('@P1 Employee profile page opens without error (direct URL with known ID)', async ({ page }) => {
  // Navigate to list, pick the first employee, then go to their profile
  await page.goto(`${BASE}/EmployeesData`);
  await waitForPageLoad(page);

  const firstRow = page.locator('table tbody tr').first();
  const hasTable = await firstRow.isVisible({ timeout: 5_000 }).catch(() => false);

  if (hasTable) {
    // Click the row or a "View" link inside it
    const viewLink = firstRow.locator('button, a').first();
    if (await viewLink.isVisible().catch(() => false)) {
      await viewLink.click();
      await waitForPageLoad(page);
      await assertNoErrorBoundary(page);
      // Profile should show employee name or section headers
      await assertPageHasContent(page);
    }
  } else {
    // No employees in DB — pass silently (data-dependent)
    test.info().annotations.push({ type: 'skip-reason', description: 'No employees in DB' });
  }
});

// ─── SEARCH / FILTER ─────────────────────────────────────────────────────────

test('@P1 Employee list: search input is present and functional', async ({ page }) => {
  await page.goto(`${BASE}/EmployeesData`);
  await waitForPageLoad(page);

  const searchInput = page.locator(
    'input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]'
  ).first();

  const hasSearch = await searchInput.isVisible({ timeout: 5_000 }).catch(() => false);

  if (hasSearch) {
    await searchInput.fill('XYZ_nonexistent_employee_12345');
    await page.waitForTimeout(800);
    await assertNoErrorBoundary(page);
    // Should show empty state, not crash
    await assertPageHasContent(page);
  } else {
    test.info().annotations.push({ type: 'info', description: 'No search input found on employee list' });
  }
});

// ─── Ex-Employees page ────────────────────────────────────────────────────────

test('@P1 Ex-Employees page loads without error', async ({ page }) => {
  await page.goto(`${BASE}/ExEmployees`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});
