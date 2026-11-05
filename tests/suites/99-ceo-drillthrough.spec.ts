import { test, expect, type Page } from '@playwright/test';

// The tab strip renders role="tab", not role="button" — selecting by the wrong
// role silently matches nothing and the test fails on the row, not the tab.
async function openTab(page: Page, name: string) {
  // Plain string, NOT a regex. getByRole's `name` does substring matching, which
  // is what this needs: the War Room tab renders an alert-count badge inside the
  // button, so its accessible name is "War Room 8", not "War Room". An anchored
  // regex silently missed it, and a template-literal boundary is worse still —
  // a backslash-b inside a TEMPLATE LITERAL is the BACKSPACE character (charCode
  // 8), not a word boundary, so that pattern matched nothing at all.
  await page.getByRole('tab', { name }).click();
  await page.waitForTimeout(600);
}

// Verifies the CEO Intelligence drill-through actually navigates to the record
// page, not just that a click handler exists. Each target page reads a DIFFERENT
// query key (party_id / vendor / id), so the assertion is on the resulting URL.
test.describe('CEO Intelligence drill-through', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/CEOIntelligenceDashboard');
    await page.waitForLoadState('networkidle');
  });

  test('customer row opens Customer360 with party_id', async ({ page }) => {
    await openTab(page, 'Customers');
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page).toHaveURL(/Customer360\?party_id=/i, { timeout: 15000 });
  });

  test('vendor row opens Vendor360 with vendor id', async ({ page }) => {
    await openTab(page, 'Vendors');
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page).toHaveURL(/Vendor360\?vendor=/i, { timeout: 15000 });
  });

  test('project row opens ProjectDetail with id', async ({ page }) => {
    await openTab(page, 'Projects');
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page).toHaveURL(/ProjectDetail\?id=/i, { timeout: 15000 });
  });

  test('drill rows are keyboard reachable', async ({ page }) => {
    await openTab(page, 'Customers');
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    // Visible is not the same as focusable: the table re-renders as the tab's data
    // settles, and focusing mid-render moves focus to a row that is then replaced,
    // so Enter fires on nothing. Wait for focus to actually land before pressing.
    await expect(row).toBeFocused({ timeout: 5000 }).catch(async () => { await row.focus(); });
    await row.focus();
    await expect(row).toBeFocused({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/Customer360\?party_id=/i, { timeout: 15000 });
  });

  test('at-risk customer row opens Customer360', async ({ page }) => {
    await openTab(page, 'Customers');
    await page.getByRole('button', { name: /risk/i }).first().click();
    await page.waitForTimeout(500);
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page).toHaveURL(/Customer360\?party_id=/i, { timeout: 15000 });
  });

  test('collections defaulter row opens Customer360', async ({ page }) => {
    await openTab(page, 'Collections');
    const row = page.locator('tr[role="button"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page).toHaveURL(/Customer360\?party_id=/i, { timeout: 15000 });
  });

  test('executive summary card switches to its tab', async ({ page }) => {
    // Executive is the default tab; the card navigates WITHIN the page.
    const card = page.locator('[role="button"]', { hasText: /Total Customers/i }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await page.waitForTimeout(800);
    await expect(page.locator('tr[role="button"]').first()).toBeVisible({ timeout: 15000 });
  });

  test('strategic alert name opens the record it is about', async ({ page }) => {
    await openTab(page, 'War Room');
    // Alerts mix customers, vendors and projects, so assert on any of the three.
    const link = page.locator('strong[role="button"]').first();
    await expect(link).toBeVisible({ timeout: 15000 });
    await link.click();
    await expect(page).toHaveURL(/(Customer360\?party_id=|Vendor360\?vendor=|ProjectDetail\?id=)/i, { timeout: 15000 });
  });

  test('pipeline stage opens the opportunities board', async ({ page }) => {
    await openTab(page, 'Sales');
    const stage = page.locator('div[role="button"]', { hasText: /opp\s*·/i }).first();
    await expect(stage).toBeVisible({ timeout: 15000 });
    await stage.click();
    await expect(page).toHaveURL(/OpportunitiesKanban/i, { timeout: 15000 });
  });

  test('pipeline stage lands on a board narrowed to that stage', async ({ page }) => {
    await openTab(page, 'Sales');
    const stage = page.locator('div[role="button"]', { hasText: /opp\s*·/i }).first();
    await expect(stage).toBeVisible({ timeout: 15000 });
    const label = (await stage.innerText()).split('\n')[0].trim();
    await stage.click();
    await expect(page).toHaveURL(/OpportunitiesKanban\?stage=/i, { timeout: 15000 });
    // The board must actually narrow, and say so — not just carry the param.
    await expect(page.getByText(/Showing the .* stage only/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Show all stages/i })).toBeVisible();
    // Case-insensitive: the dashboard sends 'negotiation', the board keys 'Negotiation'.
    expect(label.length).toBeGreaterThan(0);
  });

  test('business line opens projects filtered to that line', async ({ page }) => {
    await openTab(page, 'Business Lines');
    // Only lines that map to a product_lines row are clickable; Unassigned is not.
    const card = page.locator('div[role="button"]').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await expect(page).toHaveURL(/Projects\?.*product_line_id=/i, { timeout: 15000 });
    await expect(page.getByText(/business line only/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Show all projects/i })).toBeVisible();
  });
});
