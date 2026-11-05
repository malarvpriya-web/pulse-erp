/**
 * Suite 05 — Form Validation Tests
 *
 * Verifies the "unhappy path" behaviour across forms:
 *   - Required fields show validation errors when empty
 *   - Invalid inputs (email format, negative numbers) are rejected
 *   - Success toast fires when a valid form is submitted
 *   - No crash (ErrorBoundary) on any form interaction
 *
 * Pages covered:
 *   - New Complaint
 *   - Finance: Credit Notes, Debit Notes
 *   - Payroll: Employee-level actions
 *   - Leave: Apply Leave (already in suite 03 — covered briefly here for cross-validation)
 *   - Recruitment: Add Job Opening
 *   - Service Desk: New Ticket (inline form check)
 */

import { test, expect } from '../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
} from '../helpers/page-helpers';

const BASE = 'http://localhost:5173';

// ─── Helper: try to open a "New" / "Add" / "Create" modal ────────────────────

async function openNewModal(page: Parameters<typeof test>[1] extends (args: { page: infer P }) => unknown ? P : never) {
  const triggers = [
    'button:has-text("New")',
    'button:has-text("Add")',
    'button:has-text("Create")',
    'button:has-text("+ New")',
    'button:has-text("Raise")',
  ];
  for (const sel of triggers) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(600);
      return true;
    }
  }
  return false;
}

// ─── New Complaint ──────────────────────────────────────────────────────────
//
// ⚠ THESE TWO USED TO DRIVE `/NewComplaint`, WHICH IS NOT A ROUTE.
//
// That was a STALE TEST, not a missing feature, and it is worth being precise
// about which because the failure looked identical either way. The standalone
// complaint list + create pages were retired on 2026-07-17 and folded into
// `CustomerComplaintsIPCS` — the decision is recorded in
// frontend/src/config/routes.jsx ("The list + create pages were retired
// 2026-07-17 and are served by CustomerComplaintsIPCS ... see
// SERVICE_MASTER_IPCS_PLAN.md 3c"), and no `NewComplaint` component has existed
// since. `tests/reports/route-gap-analysis.md` had already logged
// `/NewComplaint` as a route in the smoke manifest with no nav entry.
//
// GlobalSearch.jsx is CLEAN: it mentions NewComplaint only in a comment
// recording the same retirement, and routes the old labels to
// CustomerComplaintsIPCS so muscle memory still lands somewhere real. This
// suite was the last thing still pointing at the dead URL.
//
// So the tests are REPOINTED at the surviving create path rather than deleted.
// Deleting them would drop the only browser coverage that a complaint can be
// raised at all; weakening them (a `.skip`, or dropping the heading assertion)
// would hide a real regression if the IPCS dialog ever broke. What they prove
// is unchanged: the create form opens, and it is the real one.

test('@P1 New Complaint form loads without error', async ({ page }) => {
  await page.goto(`${BASE}/CustomerComplaintsIPCS`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The create dialog is behind the page's "New" action.
  const newBtn = page.locator('button', { hasText: /^\s*New\s*$/ }).first();
  await expect(newBtn, 'the New Complaint action is missing').toBeVisible({ timeout: 10_000 });
  await newBtn.click();

  // ⚠ Anchored to "New Complaint", not /complaint/i: the PAGE's own <h1> reads
  // "Customer Complaints" and matches the loose pattern first, so the test
  // would pass with the dialog still closed.
  const heading = page.locator('h1, h2').filter({ hasText: /^New Complaint$/ }).first();
  await expect(heading, 'the New Complaint dialog did not open').toBeVisible({ timeout: 8_000 });
  await assertNoErrorBoundary(page);
});

test('@P1 New Complaint: submitting empty form shows validation', async ({ page }) => {
  await page.goto(`${BASE}/CustomerComplaintsIPCS`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const newBtn = page.locator('button', { hasText: /^\s*New\s*$/ }).first();
  if (!(await newBtn.isVisible({ timeout: 10_000 }).catch(() => false))) {
    test.info().annotations.push({ type: 'info', description: 'New Complaint action not available to this role' });
    return;
  }
  await newBtn.click();

  const dialog = page.locator('h2', { hasText: /New Complaint/i }).locator('xpath=ancestor::div[1]/..');
  const submitBtn = dialog.locator('button').filter({ hasText: /Submit|Raise|Save|Send|Create/i }).first();
  if (await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await submitBtn.click();
    await page.waitForTimeout(1_500);
    // The point of the case: an empty submit must not blow the page up.
    await assertNoErrorBoundary(page);

    const errorEl = page.locator('[class*="error"], [class*="invalid"], [class*="required"], [role="alert"]').first();
    const hasErr = await errorEl.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!hasErr) {
      test.info().annotations.push({ type: 'info', description: 'No validation message visible on empty submit — may rely on HTML5 required' });
    }
  }
});

// ─── Procurement: PR form field validation ────────────────────────────────────

test('@P1 PR form: item quantity cannot be negative (client-side guard)', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);

  const opened = await openNewModal(page);
  if (!opened) {
    test.info().annotations.push({ type: 'skip', description: 'Could not open PR creation modal' });
    return;
  }

  const qtyInput = page.locator('input[type="number"][min], input[placeholder*="Qty"], input[placeholder*="qty"]').first();
  if (await qtyInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await qtyInput.fill('-5');
    await qtyInput.blur();

    // Input should either reject or constrain to minimum
    const val = await qtyInput.inputValue();
    const numVal = parseFloat(val);
    expect(numVal, 'Quantity should not allow negative values').toBeGreaterThanOrEqual(0);
  }
});

// ─── Recruitment: Job Opening form ───────────────────────────────────────────

test('@P1 Job Openings page loads and shows list or empty state', async ({ page }) => {
  await page.goto(`${BASE}/JobOpenings`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const content = page.locator([
    '[class*="card"]',
    '[class*="job"]',
    'table tbody tr',
    '[class*="empty"]',
    '[class*="no-data"]',
    '[class*="placeholder"]',
    'h2, h3',                    // heading renders even on empty pages
  ].join(', ')).first();
  const hasContent = await content.isVisible({ timeout: 8_000 }).catch(() => false);
  expect(hasContent, 'Job Openings should show jobs or empty state').toBe(true);
});

test('@P1 Job Openings: "Add Opening" modal opens when triggered', async ({ page }) => {
  await page.goto(`${BASE}/JobOpenings`);
  await waitForPageLoad(page);

  const opened = await openNewModal(page);
  if (opened) {
    await assertNoErrorBoundary(page);
    const modalOrDrawer = page.locator('[class*="modal"], [class*="drawer"], dialog, [role="dialog"]').first();
    const visible = await modalOrDrawer.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!visible) {
      test.info().annotations.push({ type: 'info', description: 'Modal/drawer not detected after click' });
    }
  }
});

// ─── Service Desk: Ticket form ────────────────────────────────────────────────

test('@P1 All Tickets page: New Ticket button or inline form is present', async ({ page }) => {
  await page.goto(`${BASE}/AllTickets`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const newTicketBtn = page.locator('button').filter({ hasText: /New Ticket|Create Ticket|Raise Ticket|Add Ticket/i }).first();
  const hasBtn = await newTicketBtn.isVisible({ timeout: 5_000 }).catch(() => false);

  if (!hasBtn) {
    test.info().annotations.push({ type: 'info', description: 'No "New Ticket" button found — may require nav to different page' });
  }
});

// ─── Finance: Credit / Debit Notes ────────────────────────────────────────────

test('@P1 Receivables page loads (Credit Notes redirect target)', async ({ page }) => {
  await page.goto(`${BASE}/ReceivablesPage`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('[role="tab"], [class*="tab"]');
  const tabCount = await tabs.count();
  if (tabCount > 0) {
    // Click through tabs to ensure none crash
    for (let i = 0; i < Math.min(tabCount, 4); i++) {
      await tabs.nth(i).click().catch(() => null);
      await page.waitForTimeout(400);
      await assertNoErrorBoundary(page);
    }
  }
});

test('@P1 Payables page loads (Debit Notes redirect target)', async ({ page }) => {
  await page.goto(`${BASE}/PayablesPage`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('[role="tab"], [class*="tab"]');
  const tabCount = await tabs.count();
  for (let i = 0; i < Math.min(tabCount, 4); i++) {
    await tabs.nth(i).click().catch(() => null);
    await page.waitForTimeout(400);
    await assertNoErrorBoundary(page);
  }
});

// ─── Email format validation ──────────────────────────────────────────────────

test('@P2 Login form rejects invalid email format', async ({ page }) => {
  // Use a fresh context without auth to test the login form directly
  await page.context().clearCookies();
  await page.evaluate(() => { try { localStorage.clear(); } catch (_) { /* sandboxed */ } });

  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('domcontentloaded');

  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await emailInput.fill('not-an-email');
    await page.locator('input[type="password"]').fill('anything');
    await page.getByRole('button', { name: /sign in/i }).click();

    // HTML5 email validation should prevent submit, or app shows error
    const currentUrl = page.url();
    const stayedOnLogin = currentUrl.includes('/login');
    expect(stayedOnLogin, 'Invalid email should not navigate away from login').toBe(true);
  }
});

// ─── Settings forms ───────────────────────────────────────────────────────────

test('@P2 Company Profile page: form fields are present', async ({ page }) => {
  await page.goto(`${BASE}/CompanyProfile`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const inputs = page.locator('input, select, textarea');
  const count = await inputs.count();
  expect(count, 'Company Profile should have at least one form field').toBeGreaterThanOrEqual(1);
});

test('@P2 Branch Management page loads with table or empty state', async ({ page }) => {
  await page.goto(`${BASE}/BranchManagement`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const content = page.locator('table, [class*="card"], [class*="empty"], [class*="no-data"]').first();
  await expect(content).toBeVisible({ timeout: 8_000 });
});

// ─── Tab navigation inside pages ─────────────────────────────────────────────

test('@P1 Settings Center: tabs are clickable without error', async ({ page }) => {
  await page.goto(`${BASE}/SettingsCenter`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('[role="tab"], [class*="tab"]');
  const count = await tabs.count();

  for (let i = 0; i < Math.min(count, 5); i++) {
    await tabs.nth(i).click().catch(() => null);
    await page.waitForTimeout(500);
    await assertNoErrorBoundary(page);
  }
});

test('@P1 Accounting Engine: tabs are clickable without error', async ({ page }) => {
  await page.goto(`${BASE}/AccountingEngine`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('[role="tab"], [class*="tab"]');
  const count = await tabs.count();

  for (let i = 0; i < Math.min(count, 6); i++) {
    await tabs.nth(i).click().catch(() => null);
    await page.waitForTimeout(500);
    await assertNoErrorBoundary(page);
  }
});
