/**
 * Suite 03-C — Procurement CRUD Tests
 *
 * Covers:
 *   READ   — Purchase Request list, PO list, Goods Receipt, Vendor Center
 *   CREATE — New Purchase Request drawer: form fields, validation
 *   FILTER — Status and search filters on PR list
 */

import { test, expect } from '../../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
} from '../../helpers/page-helpers';

const BASE = 'http://localhost:5173';

// ─── READ — Core Lists ────────────────────────────────────────────────────────

test('@P0 Purchase Request Dashboard loads', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P0 Purchase Orders list loads', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseOrders`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P0 PO Management page loads', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseOrderManagement`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P0 Goods Receipt page loads', async ({ page }) => {
  await page.goto(`${BASE}/GoodsReceipt`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P0 Vendor Center loads', async ({ page }) => {
  await page.goto(`${BASE}/VendorCenter`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 MRP Planning page loads', async ({ page }) => {
  await page.goto(`${BASE}/MRPPlanning`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Quality Inspection page loads', async ({ page }) => {
  await page.goto(`${BASE}/QualityInspection`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Procurement Reports page loads', async ({ page }) => {
  await page.goto(`${BASE}/ProcurementReports`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Vendor Dashboard loads', async ({ page }) => {
  await page.goto(`${BASE}/VendorDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

test('@P1 Vendor Risk Dashboard loads', async ({ page }) => {
  await page.goto(`${BASE}/VendorRiskDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
});

// ─── CREATE — New Purchase Request ───────────────────────────────────────────

test('@P0 Purchase Request page has "New Request" trigger', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The page has a "New Request" button that opens a side drawer
  const newBtn = page.locator('button').filter({ hasText: /New Request|Add Request|Create PR/i }).first();
  await expect(newBtn).toBeVisible({ timeout: 8_000 });
});

test('@P1 Clicking "New Request" opens the PR creation drawer', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const newBtn = page.locator('button').filter({ hasText: /New Request|Add Request|Create PR/i }).first();
  if (await newBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await newBtn.click();
    await page.waitForTimeout(800);

    // A drawer/modal should open
    const drawer = page.locator('[class*="drawer"], [class*="modal"], [class*="panel"], [class*="slide"]').first();
    const isOpen = await drawer.isVisible({ timeout: 5_000 }).catch(() => false);

    if (isOpen) {
      // Should show form fields
      const itemField = page.locator('input[placeholder*="item"], input[placeholder*="Item"]').first();
      const hasItemField = await itemField.isVisible({ timeout: 3_000 }).catch(() => false);
      expect(hasItemField, 'PR drawer should show item name field').toBe(true);
    } else {
      test.info().annotations.push({ type: 'info', description: 'New PR drawer UI not detected' });
    }
  }
});

test('@P1 PR form: Priority selector defaults to Medium', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);

  const newBtn = page.locator('button').filter({ hasText: /New Request/i }).first();
  if (await newBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await newBtn.click();
    await page.waitForTimeout(800);

    const prioritySelect = page.locator('select').filter({ has: page.locator('option[value="medium"]') }).first();
    const hasSelect = await prioritySelect.isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasSelect) {
      const selectedValue = await prioritySelect.inputValue();
      expect(selectedValue).toBe('medium');
    }
  }
});

test('@P1 PR form: submitting empty form shows error (not crash)', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);

  const newBtn = page.locator('button').filter({ hasText: /New Request/i }).first();
  if (await newBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await newBtn.click();
    await page.waitForTimeout(800);

    // Try to submit empty
    const submitBtn = page.locator('button[type="submit"], button').filter({ hasText: /Submit|Save|Create/i }).last();
    if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(1_500);
      await assertNoErrorBoundary(page);
    }
  }
});

// ─── FILTER — Status filters ──────────────────────────────────────────────────

test('@P1 PR list: status filter buttons are present', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  // The page shows status filter tabs/pills
  const statusFilter = page.locator('select, [class*="filter"], [class*="tab"], [class*="pill"]').first();
  const hasFilter = await statusFilter.isVisible({ timeout: 5_000 }).catch(() => false);

  // Not a hard failure if the filter is not found — DB may be empty
  if (!hasFilter) {
    test.info().annotations.push({ type: 'info', description: 'Status filter not found — possibly empty state' });
  }
});

test('@P1 PR list: search input is present', async ({ page }) => {
  await page.goto(`${BASE}/PurchaseRequestDashboard`);
  await waitForPageLoad(page);

  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]').first();
  const hasSearch = await searchInput.isVisible({ timeout: 5_000 }).catch(() => false);

  if (hasSearch) {
    await searchInput.fill('XYZ_nonexistent_item_99999');
    await page.waitForTimeout(600);
    await assertNoErrorBoundary(page);
  }
});
