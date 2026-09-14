/**
 * Total Cost of Ownership comparison — browser verification.
 *
 * esbuild happily compiles a page that ReferenceErrors the moment it renders,
 * so a compile check is not evidence the TCO columns work. These tests drive
 * the real pages and assert the numbers a buyer actually reads.
 *
 * Run: npx playwright test --project=tco
 */
import { test, expect } from '@playwright/test';

// A component with at least two priced vendors, so a comparison exists at all.
const ITEM_ID = process.env.PULSE_TCO_ITEM_ID ?? '1';

test.describe('Component 360 — TCO comparison', () => {
  test('vendor table ranks on total cost of ownership, not unit price', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/ItemDetail?id=${ITEM_ID}`);
    await expect(page.getByText('Vendor Comparison')).toBeVisible();

    // The decision columns must exist — their absence is how the page silently
    // reverts to a price-only comparison.
    await expect(page.getByRole('columnheader', { name: 'TCO / unit' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'TCO Premium' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'vs Best TCO' })).toBeVisible();

    // A rendered TCO figure, not a dash: proves the endpoint returned a costed
    // vendor and the cell bound to it.
    const tcoCell = page.locator('td button', { hasText: /^₹/ }).first();
    await expect(tcoCell).toBeVisible();

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the recommendation states whether the cheapest quote is the cheapest buy', async ({ page }) => {
    await page.goto(`/ItemDetail?id=${ITEM_ID}`);
    // One of the two verdicts must be on screen. Neither appearing means the
    // comparison produced no ranking and the buyer is back to guessing.
    await expect(
      page.getByText(/cheapest quote is not the cheapest buy|both the cheapest quote and the lowest total cost/i)
    ).toBeVisible();
  });

  test('the TCO breakdown opens and shows provenance for every line', async ({ page }) => {
    await page.goto(`/ItemDetail?id=${ITEM_ID}`);
    await page.locator('td button', { hasText: /^₹/ }).first().click();

    // Assert on strings that exist ONLY inside the drawer. The phrase "total
    // cost of ownership" is not one of them — it also appears in the table
    // caption and the recommendation, so matching it proves nothing about
    // whether the drawer opened.
    await expect(page.getByRole('button', { name: 'Close breakdown' })).toBeVisible();
    // Not `exact` on the line label: it shares its span with the provenance
    // badge, so the span's text is "Purchase priceQuoted".
    await expect(page.getByText('Purchase price').first()).toBeVisible();
    await expect(page.getByText('Acquisition', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Total for /)).toBeVisible();

    // Provenance badges are the point of the drawer — a total whose lines carry
    // no basis is a guess presented as a costing.
    const badges = page.getByText(/^(Quoted|Observed|Estimated|Assumed)$/);
    expect(await badges.count()).toBeGreaterThan(0);
  });

  test('changing the comparison quantity re-costs the table', async ({ page }) => {
    await page.goto(`/ItemDetail?id=${ITEM_ID}`);
    const firstTco = await page.locator('td button', { hasText: /^₹/ }).first().textContent();

    // Per-order costs spread over more units, so a much larger quantity must
    // move the per-unit TCO. If it does not, ?qty is not reaching the server.
    await page.locator('#tco-qty').fill('5000');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(/quantity taken from: requested/i)).toBeVisible();

    await expect
      .poll(async () => page.locator('td button', { hasText: /^₹/ }).first().textContent())
      .not.toBe(firstTco);
  });

  test('the costing basis is disclosed, so an award can be defended', async ({ page }) => {
    await page.goto(`/ItemDetail?id=${ITEM_ID}`);
    await page.getByRole('button', { name: /Show costing basis/i }).click();

    await expect(page.getByText('Cost of capital')).toBeVisible();
    await expect(page.getByText('Inventory carrying')).toBeVisible();
    await expect(page.getByText('Ordering cost')).toBeVisible();
    await expect(page.getByText(/Evaluation horizon/i)).toBeVisible();
  });
});

test.describe('RFQ award — the decision that used to be made on price alone', () => {
  test('the quote table shows TCO and a verdict, not just the lowest quote', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/VendorManagement');
    await page.getByRole('button', { name: 'RFQ', exact: true }).click();

    // Open the first RFQ that has quotes to compare.
    const view = page.getByRole('button', { name: /View Quotes|Award Winner|^View$/ }).first();
    if (await view.count() === 0) test.skip(true, 'no RFQ on this dataset to open');
    await view.click();

    await expect(page.getByRole('columnheader', { name: 'TCO', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'vs Best TCO' })).toBeVisible();

    // The verdict banner is the whole point: awarding on price is now an
    // explicit choice rather than the only thing the modal could show.
    await expect(
      page.getByText(/Awarding on price would cost more|lowest quote and the lowest total cost/i)
    ).toBeVisible();

    // And the basis is disclosed, so the award can be justified.
    await expect(page.getByText(/TCO costed for .* over a .*-month horizon/i)).toBeVisible();

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('Direct purchase order — the path with no RFQ to compare', () => {
  test('costing a PO shows its total cost of ownership before it is saved', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/PurchaseOrders');
    await page.getByRole('button', { name: /New Purchase Order|Create PO|New PO/i }).first().click();
    await expect(page.getByRole('heading', { name: 'New Purchase Order' })).toBeVisible();

    // Supplier + one catalogued line is the minimum the advisory can cost.
    // Scoped to the drawer's own Supplier field: the page behind the overlay
    // has its own status-filter <select>, and `page.locator('select').first()`
    // picked THAT — leaving supplier_id empty, so the advisory never fired and
    // the test failed pointing at the panel rather than at itself.
    const supplier = page.locator('.po-field', { hasText: 'Supplier' }).locator('select').first();
    const options = await supplier.locator('option').count();
    if (options < 2) test.skip(true, 'no suppliers on this dataset');
    await supplier.selectOption({ index: 1 });

    // Capture the advisory call, so a failure says WHY rather than just that a
    // panel is missing — a blank assertion here would send the next reader
    // hunting through the component instead of reading the response.
    const advisoryCall = page
      .waitForResponse(r => r.url().includes('/tco/advisory'), { timeout: 20_000 })
      .catch(() => null);

    const itemSelect = page.locator('.po-lines-table select').first();
    const itemOptions = await itemSelect.locator('option').count();
    if (itemOptions < 2) test.skip(true, 'no catalogued items on this dataset');
    await itemSelect.selectOption({ index: 1 });
    await page.locator('.po-lines-table input[type="number"]').nth(1).fill('100');

    const res = await advisoryCall;
    expect(res, 'the drawer never called /tco/advisory').not.toBeNull();
    const body = await res!.json().catch(() => ({}));
    expect(res!.status(), `advisory failed: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    expect(body.totals, `advisory returned no totals: ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();

    // The advisory is debounced and served by the API, so poll rather than
    // asserting immediately.
    await expect(page.getByText('Total cost of ownership')).toBeVisible({ timeout: 15_000 });
    // And it must say something concrete either way — a panel that renders but
    // reaches no conclusion is the failure mode worth catching.
    await expect(
      page.getByText(/lower total cost from another approved vendor|No approved vendor offers a lower total cost|nothing to compare against/i)
    ).toBeVisible({ timeout: 15_000 });

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('Procurement Settings — TCO rates', () => {
  test('the rate card is reachable and editable', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/ProcurementSettings');
    await page.getByText('Total Cost of Ownership', { exact: true }).first().click();

    await expect(page.getByText('Cost of Capital (% / yr)')).toBeVisible();
    await expect(page.getByText('Ordering Cost per PO (₹)')).toBeVisible();
    await expect(page.getByText(/GST Recoverable as Input Credit/i)).toBeVisible();

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
