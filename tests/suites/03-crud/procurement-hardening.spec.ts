/**
 * Suite 03-C2 — the things the 2026-09-03 procurement pass changed, checked in
 * a real browser.
 *
 * The other procurement spec proves the pages LOAD. These prove the specific
 * claims this remediation makes, each of which was previously false on screen:
 *
 *   1. A goods receipt is born in a status the screen counts. Every receipt the
 *      app had ever created was 'draft' — a value the KPI strip, the tabs and
 *      the Confirm button all fail to match — so the header read
 *      "Pending (0) · Partial (0) · Received (0) · Rejected (0)" above a table
 *      with rows in it, every tab returned "no receipts match", and the Confirm
 *      button had never rendered on a single receipt.
 *
 *   2. A failed load says so. The pages turned an API error into an empty array,
 *      so a refusal rendered as "No goods receipts yet" — a statement about the
 *      business, when the truth was about the request.
 *
 *   3. The removed shadow endpoints are gone from the live server.
 *
 * These are browser tests because the claim is about what a person SEES. A
 * backend assertion that `status === 'pending'` does not establish that the
 * Confirm button renders, and the render is the part that was broken.
 */

import { readFileSync } from 'node:fs';
import { test, expect } from '../../fixtures/base';
import { waitForPageLoad, assertNoErrorBoundary } from '../../helpers/page-helpers';

const BASE = 'http://localhost:5173';
const API  = 'http://localhost:5000';

/**
 * The session token the setup project minted.
 *
 * It lives in localStorage, not a cookie, so `storageState` does not put it on
 * an API request automatically — the app's axios client reads it and sets the
 * header. A direct API assertion has to do the same, or it measures the 401
 * from `verifyToken` instead of the thing under test.
 */
function authHeader() {
  const state = JSON.parse(readFileSync('tests/.auth/user.json', 'utf8'));
  const origin = state.origins?.find((o: any) => o.origin === BASE);
  const token = origin?.localStorage?.find((i: any) => i.name === 'token')?.value;
  if (!token) throw new Error('No token in tests/.auth/user.json — run the setup project first.');
  return { Authorization: `Bearer ${token.replace(/^"|"$/g, '')}` };
}

test('@P0 Goods Receipt: the status tabs count the receipts the table shows', async ({ page }) => {
  await page.goto(`${BASE}/GoodsReceipt`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const tabs = page.locator('.grn-status-tab');
  await expect(tabs.first()).toBeVisible();

  const readCount = async (label: string) => {
    const text = await tabs.filter({ hasText: new RegExp(`^${label}\\s*\\(`) }).first().innerText();
    return Number(text.match(/\((\d+)\)/)?.[1] ?? -1);
  };

  const all = await readCount('All');
  test.skip(all === 0, 'No goods receipts in this database — nothing to count.');

  // The bug: `All` counted the rows while every other tab read 0, because the
  // rows held a status none of them matched.
  const buckets = await Promise.all(['Pending', 'Partial', 'Received', 'Rejected'].map(readCount));
  const summed = buckets.reduce((a, b) => a + b, 0);
  expect(summed, 'the status tabs should together account for every receipt in All').toBe(all);
});

/**
 * Raise a receipt that is genuinely awaiting confirmation, over the API.
 *
 * This test used to assert against whatever the database happened to hold, and
 * then CONFIRM it — so it consumed the only fixture it depended on. It passed
 * the first time it ran against a given database and failed on every run after
 * that, with "at least one receipt should be confirmable: received 0". A test
 * that can only pass once is not a regression test; it is a one-shot.
 *
 * So it provisions its own. The chain is the real one a buyer walks —
 * requisition, approval, conversion, order approval, receipt — because that is
 * also what makes the resulting receipt a realistic subject: born through the
 * app, in whatever status the app actually writes.
 */
async function provisionPendingReceipt(): Promise<string> {
  const headers = { ...authHeader(), 'Content-Type': 'application/json' };
  const post = async (path: string, body: unknown, method = 'POST') => {
    const res = await fetch(`${API}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const get = async (path: string) => {
    const res = await fetch(`${API}${path}`, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const items = await get('/api/procurement/price-history/items?q=');
  const itemId = items.body?.[0]?.id;
  if (!itemId) throw new Error('No component available to receive against.');

  // Approving a purchase order enforces a minimum vendor rating, and a vendor
  // with no rating history is refused outright — so pick one that has some,
  // rather than letting that gate decide whether this test can run.
  const vendors = await get('/api/procurement/vendors');
  const candidates: number[] = (vendors.body?.vendors ?? []).map((v: any) => v.id);
  let supplierId: number | null = null;
  for (const id of candidates) {
    const card = await get(`/api/procurement/vendors/${id}/scorecard`);
    if ((card.body?.ratings?.length ?? 0) > 0) { supplierId = id; break; }
  }
  if (!supplierId) throw new Error('No rated vendor — purchase-order approval would refuse every candidate.');

  const today = new Date().toISOString().slice(0, 10);
  const pr = await post('/api/procurement/purchase-requests', {
    request_date: today, notes: 'E2E pending-receipt fixture', priority: 'low',
    items: [{ item_id: itemId, item_name: 'E2E fixture', quantity: 3, expected_price: 50 }],
  });
  if (pr.status !== 201) throw new Error(`requisition failed: ${pr.status} ${JSON.stringify(pr.body)}`);

  await post(`/api/procurement/purchase-requests/${pr.body.id}/approve`, {}, 'PUT');
  const conv = await post(`/api/procurement/purchase-requests/${pr.body.id}/convert-to-po`, { supplier_id: supplierId }, 'PATCH');
  const poId = conv.body?.po_id;
  if (!poId) throw new Error(`conversion failed: ${conv.status} ${JSON.stringify(conv.body)}`);

  const appr = await post(`/api/procurement/purchase-orders/${poId}/approve`, {}, 'PATCH');
  if (appr.status !== 200) throw new Error(`order approval failed: ${appr.status} ${JSON.stringify(appr.body)}`);

  // A receipt held for incoming inspection does not need a warehouse until it
  // is released, but the screen shows one and the release path requires it —
  // so book it against a real location rather than leaving it null.
  const whs = await get('/api/inventory/warehouses');
  const warehouseId = (Array.isArray(whs.body) ? whs.body : whs.body?.data ?? [])[0]?.id ?? null;

  const po = await get(`/api/procurement/purchase-orders/${poId}`);
  const lines = po.body?.items ?? [];
  const grn = await post('/api/procurement/grn', {
    po_id: poId, warehouse_id: warehouseId, received_date: today,
    items: lines.map((l: any) => ({
      po_item_id: l.id, item_id: l.item_id,
      quantity_received: Number(l.quantity), quantity_rejected: 0, rate: Number(l.rate),
    })),
  });
  if (grn.status !== 201) throw new Error(`receipt failed: ${grn.status} ${JSON.stringify(grn.body)}`);
  return String(grn.body.grn_number);
}

test('@P0 Goods Receipt: a pending receipt offers Confirm, and confirming changes its badge', async ({ page }) => {
  const provisioned = await provisionPendingReceipt();

  await page.goto(`${BASE}/GoodsReceipt`);
  await waitForPageLoad(page);

  const rows = page.locator('.grn-table tbody tr');
  const n = await rows.count();
  expect(n, 'the receipt this test just raised should be listed').toBeGreaterThan(0);

  // Confirm renders only for a receipt whose status the screen recognises as
  // pending. It had never appeared, because nothing ever wrote that status.
  const confirmables = page.locator('.grn-confirm-btn');
  const confirmCount = await confirmables.count();
  expect(confirmCount, `receipt ${provisioned} was just raised and should be confirmable`).toBeGreaterThan(0);

  const row = page.locator('.grn-table tbody tr', { has: page.locator('.grn-confirm-btn') }).first();
  const grnNumber = (await row.locator('.grn-grn-num').innerText()).trim();

  await row.locator('.grn-confirm-btn').click();

  // The badge for THAT receipt must move off Pending. The server decides between
  // 'received' and 'partial' depending on whether the order is still short, so
  // the assertion is that it changed — not which of the two it became.
  const badge = page.locator('.grn-table tbody tr', { hasText: grnNumber }).first().locator('.grn-badge');
  await expect(badge).not.toHaveText('Pending', { timeout: 12_000 });
  await expect(page.locator('.grn-toast, .grn-toast-error')).toBeVisible({ timeout: 8_000 });
});

test('@P0 Goods Receipt: a failed load says it failed, instead of showing an empty list', async ({ page }) => {
  // The distinction this asserts is the whole point of LoadError: "we could not
  // reach the server" and "there are no receipts" are different facts, and the
  // page used to render the second when it meant the first.
  await page.route('**/api/procurement/grn**', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated backend failure' }) }));

  await page.goto(`${BASE}/GoodsReceipt`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const err = page.locator('.pl-load-error');
  await expect(err).toBeVisible({ timeout: 12_000 });
  await expect(err).toContainText('Simulated backend failure');
  // And it must NOT be claiming there is nothing here.
  await expect(page.locator('text=No goods receipts yet')).toHaveCount(0);
  // Retry is offered, because the failure may be transient.
  await expect(err.getByRole('button', { name: /try again/i })).toBeVisible();
});

test('@P0 Purchase Orders: a failed load says it failed', async ({ page }) => {
  await page.route('**/api/procurement/purchase-orders**', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'You do not have permission to view in procurement.' }) }));

  await page.goto(`${BASE}/PurchaseOrderManagement`);
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);

  const err = page.locator('.pl-load-error');
  await expect(err).toBeVisible({ timeout: 12_000 });
  // A permission refusal is exactly the case that used to read as "no orders".
  await expect(err).toContainText('permission');
  await expect(page.locator('text=No purchase orders yet')).toHaveCount(0);
});

test('@P0 the ungated duplicate endpoints are gone from the live server', async ({ request }) => {
  const headers = authHeader();
  // These shadowed hardened controls: an unscoped vendor update that could
  // rewrite bank details, an unscoped RFQ award, and an unscoped clearing of a
  // flagged invoice for payment. Checked through the browser context so the
  // assertion covers the real mount order in server.js.
  for (const [method, path, canonical] of [
    ['put',   '/api/vendors/1',                 'PUT /api/procurement/vendors/:id'],
    ['patch', '/api/three-way-match/1/resolve',  'PATCH /api/procurement/three-way-match/:id/resolve'],
    ['put',   '/api/rfqs/1/quotes/1/winner',     'PATCH /api/procurement/rfqs/:rfqId/award/:vendorId'],
  ] as const) {
    // Authenticated on purpose: these paths sit behind verifyToken, so an
    // anonymous call measures the 401 rather than the 410 under test.
    const res = await request[method](`${API}${path}`, { data: {}, headers });
    expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(410);
    expect((await res.json()).use).toBe(canonical);
  }
});
