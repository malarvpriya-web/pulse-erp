/**
 * §215 — exchange rates in the browser, on a THROWAWAY company only.
 *
 * backend/scripts/e2e-fx-fixture.mjs creates company ZZFXE2E with two admin
 * logins, an RFQ with a USD and an INR quote, and draft rates; this suite mints
 * its own token for the approver (it does not use the shared superadmin
 * session) and tears everything down afterwards. No live data is touched.
 *
 * Run: npx playwright test --project=fx
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_DIR = path.resolve(__dirname, '../../backend');

function backend(script: string, args: string[], env: Record<string, string> = {}, fence = 'E2E_FX') {
  const raw = execFileSync('node', [script, ...args], { cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, ...env } });
  const m = raw.match(new RegExp(`---${fence}_BEGIN---\\s*([\\s\\S]*?)\\s*---${fence}_END---`));
  if (!m) throw new Error(`${script} printed no payload:\n${raw}`);
  return JSON.parse(m[1].trim());
}

let fx: any;
let auth: any;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fx = backend('scripts/e2e-fx-fixture.mjs', ['setup']);
  auth = backend('scripts/e2e-mint-token.mjs', [], { E2E_LOGIN_EMAIL: fx.approver.email }, 'E2E_AUTH');
  // The env var, not an argument — and assert it took (project_browser_verification_recipe).
  if (auth.user.email !== fx.approver.email) throw new Error(`minted ${auth.user.email}, wanted ${fx.approver.email}`);
});

test.afterAll(() => { backend('scripts/e2e-fx-fixture.mjs', ['teardown']); });

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
  const row = page.locator('tr', { hasText: fx.rfq_number });
  await row.getByRole('button', { name: /Award Winner|View Quotes/ }).click();
  await expect(page.getByRole('heading', { name: `Quotes — ${fx.rfq_number}` })).toBeVisible();
  return page.locator('tr', { hasText: 'ZZ FX US Supplier' });
}

test('a USD quote with only a DRAFT rate is not ranked, and says why', async ({ page }) => {
  await signIn(page);
  const usd = await openQuotes(page);
  // Shown in its own currency — it used to print "₹10".
  await expect(usd).toContainText('USD 10');
  await expect(usd).toContainText('USD quote — needs exchange rate');
  // §217: an eligible quote the comparison cannot convert withholds the
  // recommendation — the INR supplier is NOT crowned by default.
  await expect(page.getByText('No recommendation — comparison incomplete.')).toBeVisible();
  await expect(page.getByText(/ZZ FX US Supplier — Exchange rate: No approved USD rate/)).toBeVisible();
  await expect(page.getByText('Lowest TCO')).toHaveCount(0);
});

test('Rate Approval: the approver approves the enterer\'s rate, never their own', async ({ page }) => {
  await signIn(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/PaymentBatch');
  await page.getByRole('tab', { name: 'Forex', exact: true }).click();
  await page.getByRole('button', { name: 'Rate Approval', exact: true }).click();

  const usdRow = page.locator('tr', { hasText: 'USD' }).filter({ hasText: 'Awaiting approval' });
  const eurRow = page.locator('tr', { hasText: 'EUR' }).filter({ hasText: 'Awaiting approval' });
  await expect(usdRow).toContainText('ZZ FX enterer');
  await expect(eurRow).toContainText('You entered this');
  await expect(eurRow.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  await usdRow.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('USD');
  await page.getByRole('button', { name: 'Approved', exact: true }).click();
  await expect(page.locator('tr', { hasText: 'USD' }).filter({ hasText: 'Approved' })).toContainText('ZZ FX approver');
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('once approved, the quote is converted at that rate and shows where it came from', async ({ page }) => {
  await signIn(page);
  const usd = await openQuotes(page);
  await expect(usd).not.toContainText('needs exchange rate');
  await expect(usd).toContainText('USD @ ₹84.5000');
  // 1,000 USD x 84.5 = 84,500, dearer than the INR quote's 90,000? No — cheaper,
  // so the USD supplier now wins on total cost.
  await expect(usd).toContainText('Lowest TCO');
});

test('a Finance approver records a documented override, and it is labelled', async ({ page }) => {
  await signIn(page);
  const usd = await openQuotes(page);
  await usd.getByRole('button', { name: 'Set rate override' }).click();
  await usd.getByLabel('Override rate').fill('83');
  await usd.getByLabel('Override reason').fill('fx');
  await usd.getByRole('button', { name: 'Save rate' }).click();
  await expect(usd).toContainText('at least 10 characters');      // refused, with the server's reason
  await usd.getByLabel('Override reason').fill('Forward contract FC-17 booked with bank');
  await usd.getByRole('button', { name: 'Save rate' }).click();
  const after = page.locator('tr', { hasText: 'ZZ FX US Supplier' });
  await expect(after).toContainText('USD @ ₹83.0000 · override');
});

test('Default Currency is saved and survives a reload', async ({ page }) => {
  await signIn(page);
  const open = async () => {
    await page.goto('/ProcurementSettings');
    await page.getByText('Currency', { exact: true }).first().click();
    return page.locator('xpath=//*[normalize-space(text())="Default Currency"]/ancestor::*[.//select][1]//select').first();
  };
  let sel = await open();
  await expect(sel).toHaveValue('INR');
  await sel.selectOption('EUR');
  const put = page.waitForResponse(r => r.url().includes('/procurement/settings') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  const res = await put;
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).data.default_currency).toBe('EUR');
  sel = await open();
  await expect(sel).toHaveValue('EUR');
  // The dead control is gone.
  await expect(page.getByText('Enable Multi-Currency POs')).toHaveCount(0);
});

// Moved from tco-comparison.spec.ts, which wrote company 1's live settings.
test('TCO day-count basis and FX max age save and survive a reload', async ({ page }) => {
  await signIn(page);
  const open = async () => {
    await page.goto('/ProcurementSettings');
    await page.getByText('Total Cost of Ownership', { exact: true }).first().click();
    const row = (label: string) => page.locator(`xpath=//*[normalize-space(text())="${label}"]/ancestor::*[.//select or .//input][1]`).first();
    return { basis: row('Day-Count Basis (days / yr)').locator('select'), age: row('Exchange Rate Max Age (days)').locator('input') };
  };
  let f = await open();
  await expect(f.basis).toHaveValue('365');
  await expect(f.age).toHaveValue('30');
  await f.basis.selectOption('360');
  await f.age.fill('14');
  const put = page.waitForResponse(r => r.url().includes('/procurement/settings') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  const res = await put;
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).tco).toMatchObject({ tco_day_count_basis: 360, tco_fx_max_age_days: 14 });
  f = await open();
  await expect(f.basis).toHaveValue('360');
  await expect(f.age).toHaveValue('14');
  // The earlier save of Default Currency in this run was not reset by this one.
  await page.getByText('Currency', { exact: true }).first().click();
  await expect(page.locator('xpath=//*[normalize-space(text())="Default Currency"]/ancestor::*[.//select][1]//select').first()).toHaveValue('EUR');
});
