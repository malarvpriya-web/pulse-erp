/**
 * §219 — RFQ quote entry in the browser, on a THROWAWAY company only
 * (backend/scripts/e2e-quote-fixture.mjs, company ZZQEE2E). Own minted token;
 * tears down after. Never awards; no document sequence is consumed.
 *
 * Run: npx playwright test --project=quote-entry
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_DIR = path.resolve(__dirname, '../../backend');
function backend(script: string, args: string[], env: Record<string, string> = {}, fence = 'E2E_QE') {
  const raw = execFileSync('node', [script, ...args], { cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, ...env } });
  const m = raw.match(new RegExp(`---${fence}_BEGIN---\\s*([\\s\\S]*?)\\s*---${fence}_END---`));
  if (!m) throw new Error(`${script} printed no payload:\n${raw}`);
  return JSON.parse(m[1].trim());
}
let fx: any; let auth: any;
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  fx = backend('scripts/e2e-quote-fixture.mjs', ['setup']);
  auth = backend('scripts/e2e-mint-token.mjs', [], { E2E_LOGIN_EMAIL: fx.email }, 'E2E_AUTH');
  if (auth.user.email !== fx.email) throw new Error(`minted ${auth.user.email}, wanted ${fx.email}`);
});
test.afterAll(() => { backend('scripts/e2e-quote-fixture.mjs', ['teardown']); });

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
async function openQuotes(page: Page) {
  await page.goto('/VendorManagement');
  await page.getByRole('button', { name: 'RFQ', exact: true }).click();
  await page.locator('tr', { hasText: fx.rfq_number }).getByRole('button', { name: /Award Winner|View Quotes/ }).click();
  await expect(page.getByRole('heading', { name: `Quotes — ${fx.rfq_number}` })).toBeVisible();
}
const dialog = (page: Page) => page.getByRole('dialog', { name: /quote —/ });

test('an invited vendor\'s quote is entered, with freight quoted in EUR', async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openQuotes(page);
  await page.locator('tr', { hasText: 'ZZ QE Alpha Supplier' }).getByRole('button', { name: 'Enter quote' }).click();
  const d = dialog(page);
  await expect(d.getByRole('heading', { name: /Enter quote — ZZ QE Alpha Supplier/ })).toBeVisible();

  // Validation from the server, shown in the dialog.
  await d.getByRole('button', { name: 'Save quote' }).click();
  await expect(d.getByRole('alert')).toContainText('Enter the quoted unit price or total amount');

  await d.getByLabel('Unit price').fill('100');
  await d.getByLabel('Total amount').fill('10000');
  await d.getByLabel('Currency', { exact: true }).fill('INR');
  await d.getByLabel('Vendor quotation ref').fill('VQ-ALPHA-7');
  await d.getByLabel('Quotation date').fill('2026-10-28');
  await d.getByLabel('Freight amount', { exact: true }).fill('100');
  await d.getByLabel('Freight currency').fill('EUR');
  await d.getByLabel('Quoted weight (kg per unit)').fill('2.5');
  await d.getByLabel('Transport mode').selectOption('road');
  const put = page.waitForResponse(r => r.url().includes(`/quotes/${fx.quotes.alpha}`) && r.request().method() === 'PUT');
  await d.getByRole('button', { name: 'Save quote' }).click();
  const res = await put;
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).data).toMatchObject({ freight_currency: 'EUR', shipping_weight_uom: 'NOS', vendor_quote_ref: 'VQ-ALPHA-7' });

  await expect(dialog(page)).toHaveCount(0);
  const row = page.locator('tr', { hasText: 'ZZ QE Alpha Supplier' });
  await expect(row).toContainText('Freight quoted');
  await expect(row.getByRole('button', { name: 'Edit quote' })).toBeVisible();
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('editing loads the complete stored quote; per-unit freight replaces the amount', async ({ page }) => {
  await signIn(page);
  await openQuotes(page);
  await page.locator('tr', { hasText: 'ZZ QE Alpha Supplier' }).getByRole('button', { name: 'Edit quote' }).click();
  const d = dialog(page);
  await expect(d.getByLabel('Vendor quotation ref')).toHaveValue('VQ-ALPHA-7');
  await expect(d.getByLabel('Freight amount', { exact: true })).toHaveValue('100.00');
  await expect(d.getByLabel('Freight currency')).toHaveValue('EUR');
  await d.getByText('Quote freight as a rate per unit').click();
  await d.getByLabel('Freight per unit', { exact: true }).fill('1.5');
  const put = page.waitForResponse(r => r.url().includes(`/quotes/${fx.quotes.alpha}`) && r.request().method() === 'PUT');
  await d.getByRole('button', { name: 'Save quote' }).click();
  const body = (await (await put).json()).data;
  expect(body.freight_amount).toBeNull();                  // never both
  expect(Number(body.freight_per_unit)).toBe(1.5);
  expect(body.vendor_quote_ref).toBe('VQ-ALPHA-7');        // untouched fields preserved
});
