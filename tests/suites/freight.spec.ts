/**
 * §216 — freight & item weight in the browser, on a THROWAWAY company only.
 *
 * backend/scripts/e2e-freight-fixture.mjs creates company ZZFRE2E (maker +
 * approver logins, Bengaluru DC as the main receiving point, a Chennai vendor
 * with no lane yet, a draft rate card by the maker, an RFQ with two quotes).
 * This suite signs in as the APPROVER with its own minted token and tears
 * everything down afterwards. It never awards. No live data is touched.
 *
 * Run: npx playwright test --project=freight
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_DIR = path.resolve(__dirname, '../../backend');
function backend(script: string, args: string[], env: Record<string, string> = {}, fence = 'E2E_FR') {
  const raw = execFileSync('node', [script, ...args], { cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, ...env } });
  const m = raw.match(new RegExp(`---${fence}_BEGIN---\\s*([\\s\\S]*?)\\s*---${fence}_END---`));
  if (!m) throw new Error(`${script} printed no payload:\n${raw}`);
  return JSON.parse(m[1].trim());
}

let fx: any;
let auth: any;
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fx = backend('scripts/e2e-freight-fixture.mjs', ['setup']);
  auth = backend('scripts/e2e-mint-token.mjs', [], { E2E_LOGIN_EMAIL: fx.approver.email }, 'E2E_AUTH');
  if (auth.user.email !== fx.approver.email) throw new Error(`minted ${auth.user.email}, wanted ${fx.approver.email}`);
});
test.afterAll(() => { backend('scripts/e2e-freight-fixture.mjs', ['teardown']); });

async function signIn(page: Page) {
  await page.addInitScript((a) => {
    localStorage.setItem('token', a.token);
    localStorage.setItem('user', JSON.stringify(a.user));
    localStorage.setItem('role', a.role);
    localStorage.setItem('roles', JSON.stringify(a.roles));
    localStorage.setItem('permissions', JSON.stringify([]));
    localStorage.setItem('menuOverrides', JSON.stringify({}));
  }, auth);
}
const openFreightTab = async (page: Page) => {
  await page.goto('/ProcurementSettings');
  await page.getByText('Freight', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Freight lanes' })).toBeVisible();
};
async function openQuotes(page: Page) {
  await page.goto('/VendorManagement');
  await page.getByRole('button', { name: 'RFQ', exact: true }).click();
  await page.locator('tr', { hasText: fx.rfq_number }).getByRole('button', { name: /Award Winner|View Quotes/ }).click();
  await expect(page.getByRole('heading', { name: `Quotes — ${fx.rfq_number}` })).toBeVisible();
}

test('before any lane or approved rate: no recommendation, and each gap is named', async ({ page }) => {
  await signIn(page);
  await openQuotes(page);
  await expect(page.getByText('No recommendation — comparison incomplete.')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'ZZ FR Chennai Supplier' })).toContainText('Needs freight input');
  await expect(page.locator('tr', { hasText: 'ZZ FR Laneless Supplier' })).toContainText('Needs freight input');
  await expect(page.getByText('Lowest TCO')).toHaveCount(0);
});

test('Freight tab: the main receiving point is designated; the approver approves the maker\'s draft rate card', async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFreightTab(page);
  await expect(page.getByLabel('Main receiving point')).toHaveValue(String(fx.warehouse_id));
  const row = page.locator('tr', { hasText: 'ZZ transporter contract' });
  await expect(row).toContainText('Awaiting approval');
  await expect(row).toContainText('ZZ FR maker');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText(`Rate card #${fx.rate_card_id} approved`);
  await expect(page.locator('tr', { hasText: 'ZZ transporter contract' })).toContainText('Approved');
  await expect(page.locator('tr', { hasText: 'ZZ transporter contract' })).toContainText('ZZ FR approver');
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('a lane: straight-line suggestion prefills an ESTIMATE, the person confirms and saves', async ({ page }) => {
  await signIn(page);
  await openFreightTab(page);
  await page.getByRole('button', { name: '+ Add lane' }).click();
  await page.getByLabel('Lane vendor').selectOption({ label: 'ZZ FR Chennai Supplier' });
  // Save is disabled until a person states the source.
  await page.getByLabel('Lane distance km').fill('350');
  await expect(page.getByRole('button', { name: 'Confirm & save lane' })).toBeDisabled();
  await page.getByRole('button', { name: 'Suggest straight-line distance' }).click();
  await expect(page.getByText(/Estimate: \d+(\.\d+)? km — Straight-line distance Chennai/)).toBeVisible();
  await page.getByRole('button', { name: 'Use as estimate' }).click();
  await expect(page.getByLabel('Lane distance source')).toHaveValue('estimated');
  // The person overrides it with the real road distance and source.
  await page.getByLabel('Lane distance km').fill('346');
  await page.getByLabel('Lane distance source').selectOption('observed');
  await page.getByLabel('Lane note').fill('e-way bill trip distance');
  await page.getByRole('button', { name: 'Confirm & save lane' }).click();
  await expect(page.getByRole('status')).toContainText('Lane saved');
  const lane = page.locator('tr', { hasText: 'ZZ FR Chennai Supplier' });
  await expect(lane).toContainText('346 km');
  await expect(lane).toContainText('Observed');
  await expect(lane).toContainText('ZZ FR approver');
});

test('RFQ: the laned vendor is MODELLED with its inputs; the other still needs input; still no recommendation', async ({ page }) => {
  await signIn(page);
  await openQuotes(page);
  // 100 x 2.5 kg = 250 kg x 346 km x Rs 3 / 1000 = Rs 259.50
  const laned = page.locator('tr', { hasText: 'ZZ FR Chennai Supplier' });
  await expect(laned).toContainText('Freight modelled: 250 kg × 346 km (observed) · road');
  await expect(page.locator('tr', { hasText: 'ZZ FR Laneless Supplier' })).toContainText('Needs freight input: distance');
  await expect(page.getByText('No recommendation — comparison incomplete.')).toBeVisible();
  await expect(page.getByText('Lowest TCO')).toHaveCount(0);
});

test('Component 360: same freight model, same incomplete status', async ({ page }) => {
  await signIn(page);
  await page.goto(`/ItemDetail?id=${fx.items.weighed}&qty=100`);
  await expect(page.getByText('No recommendation — comparison incomplete.')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'ZZ FR Laneless Supplier' })).toContainText('needs freight input');
});

test('Item Master: a weight needs its basis and saves per the item unit', async ({ page }) => {
  await signIn(page);
  await page.goto('/ItemMaster');
  await page.locator('tr', { hasText: 'ZZFR-UNWEIGHED' }).first().click();
  await page.getByRole('button', { name: /Edit/ }).first().click().catch(() => {});
  const weight = page.getByLabel(/Shipping Weight \(kg per NOS\)/);
  await expect(weight).toBeVisible();
  await weight.fill('1.75');
  await page.getByLabel('Weight Basis').selectOption('observed');
  const put = page.waitForResponse(r => r.url().includes(`/inventory/items/${fx.items.unweighed}`) && r.request().method() === 'PUT');
  await page.getByRole('button', { name: /^(Save|Update)/ }).first().click();
  const res = await put;
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ shipping_weight_kg: '1.7500', shipping_weight_basis: 'observed', shipping_weight_uom: 'NOS' });
});
