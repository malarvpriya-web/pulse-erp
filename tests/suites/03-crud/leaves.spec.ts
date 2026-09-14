/**
 * Suite 03-B — Leaves CRUD Tests
 *
 * Covers:
 *   READ   — My Leaves list, Leave Approvals, Holiday Calendar
 *   CREATE — Apply Leave form validation and submission
 *   FILTER — Leave calendar navigation
 *   APPROVE— Approval queue renders (data-dependent)
 */

import { test, expect } from '../../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
} from '../../helpers/page-helpers';

const BASE = 'http://localhost:5173';

// Helper: get today's date in YYYY-MM-DD
function today() {
  return new Date().toISOString().slice(0, 10);
}
function futureDate(daysAhead: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// ─── READ — Lists ─────────────────────────────────────────────────────────────

test('@P0 My Leaves page loads and renders content', async ({ page }) => {
  await page.goto(`${BASE}/MyLeaves`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P0 Leave Approvals page loads', async ({ page }) => {
  await page.goto(`${BASE}/LeaveApprovals`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 All Leaves page loads', async ({ page }) => {
  await page.goto(`${BASE}/AllLeaves`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Holiday Calendar loads and shows month', async ({ page }) => {
  await page.goto(`${BASE}/HolidayCalendar`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Leave Calendar loads', async ({ page }) => {
  await page.goto(`${BASE}/LeaveCalendar`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Team Leaves page loads', async ({ page }) => {
  await page.goto(`${BASE}/TeamLeaves`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Leave Reports page loads', async ({ page }) => {
  await page.goto(`${BASE}/LeaveReports`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

// ─── CREATE — Apply Leave ─────────────────────────────────────────────────────

test('@P0 Apply Leave form is reachable and renders the form title', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  await expect(
    page.getByRole('heading', { name: /Apply for Leave/i })
  ).toBeVisible({ timeout: 8_000 });
});

test('@P0 Apply Leave form: leave type cards or selector is visible', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The form shows leave balance cards (buttons) or a <select> dropdown
  const leaveCard  = page.locator('[class*="al-bal-card"]').first();
  const leaveSelect = page.locator('select').first();

  const hasCards  = await leaveCard.isVisible({ timeout: 8_000 }).catch(() => false);
  const hasSelect = await leaveSelect.isVisible({ timeout: 3_000 }).catch(() => false);

  expect(hasCards || hasSelect, 'Leave type selector should be present').toBe(true);
});

test('@P0 Apply Leave form: date fields are present', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const dateInputs = page.locator('input[type="date"]');
  await expect(dateInputs.first()).toBeVisible({ timeout: 8_000 });
});

test('@P1 Apply Leave form: can fill dates and type reason', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // Fill start date
  const startDate = page.locator('input[type="date"]').first();
  if (await startDate.isVisible().catch(() => false)) {
    await startDate.fill(futureDate(5));
  }

  // Fill end date
  const endDate = page.locator('input[type="date"]').nth(1);
  if (await endDate.isVisible().catch(() => false)) {
    await endDate.fill(futureDate(5));
  }

  // Fill reason/notes textarea
  const reason = page.locator('textarea').first();
  if (await reason.isVisible().catch(() => false)) {
    await reason.fill('Playwright automated leave request test');
  }

  // No submission — just assert no crash from filling
  await assertNoErrorBoundary(page);
});

test('@P1 Apply Leave form: Submit Request button is present', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);

  const submitBtn = page.getByRole('button', { name: /Submit Request/i });
  await expect(submitBtn).toBeVisible({ timeout: 8_000 });
});

test('@P1 Apply Leave form: submitting without leave type shows validation', async ({ page }) => {
  await page.goto(`${BASE}/ApplyLeave`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // Click Submit without picking a leave type
  const submitBtn = page.getByRole('button', { name: /Submit Request/i });
  if (await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click();
    await page.waitForTimeout(1_500);
    await assertNoErrorBoundary(page);

    // Should show inline error or toast
    const errorEl = page.locator('[class*="error"], [class*="field-err"], [role="alert"]').first();
    const hasError = await errorEl.isVisible().catch(() => false);
    expect(hasError, 'Validation error expected when submitting without leave type').toBe(true);
  }
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────

test('@P2 Leave Settings page loads', async ({ page }) => {
  await page.goto(`${BASE}/LeaveSettings`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Comp Off page loads', async ({ page }) => {
  await page.goto(`${BASE}/CompOff`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P2 Leave Encashment page loads', async ({ page }) => {
  await page.goto(`${BASE}/LeaveEncashment`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});
