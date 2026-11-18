/**
 * §255 — statutory rules as inputs, in a real browser, on a throwaway company in the test database.
 *
 * Run: npx playwright test -c playwright.testdb.config.ts --project=statutory-rules
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BACKEND_DIR = path.resolve(__dirname, '../../backend');

function backend(script: string, args: string[], env: Record<string, string> = {}, fence = 'E2E') {
  const raw = execFileSync('node', [script, ...args], { cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, ...env } });
  const m = raw.match(new RegExp(`---${fence}_BEGIN---\\s*([\\s\\S]*?)\\s*---${fence}_END---`));
  if (!m) throw new Error(`${script} printed no payload:\n${raw}`);
  return JSON.parse(m[1].trim());
}

let auth: any;
const problems: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const fx = backend('scripts/e2e-settlement-fixture.mjs', ['setup']);
  auth = backend('scripts/e2e-mint-token.mjs', [], { E2E_LOGIN_EMAIL: fx.email }, 'E2E_AUTH');
  if (auth.user.email !== fx.email) throw new Error(`minted ${auth.user.email}, wanted ${fx.email}`);
  const saved = await request.post(`${process.env.PULSE_API_BASE}/api/settings/payroll`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    data: { statutory_state: 'Tamil Nadu', pt_local_body: 'municipality', pt_local_body_name: 'Test Town', pay_day_of_month: 25, payroll_cutoff_day: 20 },
  });
  if (!saved.ok()) throw new Error(`settings: ${saved.status()} ${await saved.text()}`);
});

test.afterAll(() => { backend('scripts/e2e-settlement-fixture.mjs', ['teardown']); });

async function open(page: Page) {
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript((a) => {
    localStorage.setItem('token', a.token);
    localStorage.setItem('user', JSON.stringify(a.user));
    localStorage.setItem('role', a.role);
    localStorage.setItem('roles', JSON.stringify(a.roles));
    localStorage.setItem('permissions', JSON.stringify([]));
    localStorage.setItem('menuOverrides', JSON.stringify({}));
  }, auth);
  await page.goto('/PayrollCenter?tab=settings&view=rules');
  await expect(page.getByRole('heading', { name: 'Provident Fund' })).toBeVisible();
}
const card = (page: Page, key: string) => page.locator(`[data-rule="${key}"]`);

test('a law change is entered with its date, and appears in the history', async ({ page }) => {
  await open(page);
  const c = card(page, 'pf.wage_ceiling');
  await c.getByLabel(/Wage ceiling/).fill('30000');
  await c.getByLabel('Applies from').fill('2031-04-01');
  await c.getByLabel(/Source, such as/).fill('S.O. test notification');
  await c.getByRole('button', { name: 'Save and confirm' }).click();
  // Today's value is unchanged: the new version waits for its date.
  const after = card(page, 'pf.wage_ceiling');
  await expect(after.getByLabel(/Wage ceiling/)).toHaveValue('25000');
  await after.getByText(/Version history/).click();
  await expect(after.getByText('S.O. test notification')).toBeVisible();
  await expect(after.getByText('2031-04-01')).toBeVisible();
});

test('Tamil Nadu LWF is edited for that state and becomes confirmed', async ({ page }) => {
  await open(page);
  const c = card(page, 'lwf.rates');
  await expect(c.getByRole('heading', { name: /\(TN\)/ })).toBeVisible();
  await expect(c.getByText('Not verified')).toBeVisible();
  await expect(c.getByText(/Rule 12 was NOT read/)).toBeVisible();
  await c.getByLabel(/Wage months/).fill('6');
  await c.getByLabel(/Source, such as/).fill('TN LWF Rules r.12');
  await c.getByRole('button', { name: 'Save and confirm' }).click();
  const after = card(page, 'lwf.rates');
  await expect(after.getByText('Verified', { exact: true })).toBeVisible();
  await expect(after.getByLabel(/Wage months/)).toHaveValue('6');
  await page.screenshot({ path: 'test-results/statutory-rules.png', fullPage: true });
});

test('the CTC definition can be recorded on this page', async ({ page }) => {
  await open(page);
  const c = card(page, 'ctc.definition');
  await expect(c.getByText('Your decision')).toBeVisible();
  await c.getByLabel(/Source, such as/).fill('Finance approval');
  await c.getByRole('button', { name: 'Save and confirm' }).click();
  await expect(card(page, 'ctc.definition').getByText('Recorded', { exact: true })).toBeVisible();
});

test('a bonus plan is entered on the page and kept', async ({ page }) => {
  await open(page);
  const c = card(page, 'bonus.plans');
  await c.getByRole('button', { name: 'Add plan' }).click();
  await c.getByLabel('Plan 1 name').fill('Diwali');
  await c.getByLabel('Plan 1 type').selectOption('pct_basic');
  await c.getByLabel('Plan 1 amount').fill('8.33');
  await c.getByLabel('Plan 1 months').fill('10');
  await c.getByLabel(/Source, such as/).fill('Management note');
  await c.getByRole('button', { name: 'Save and confirm' }).click();
  await expect(card(page, 'bonus.plans').getByLabel('Plan 1 name')).toHaveValue('Diwali');
  await page.reload();
  const after = card(page, 'bonus.plans');
  await expect(after.getByLabel('Plan 1 amount')).toHaveValue('8.33');
  await expect(after.getByText('Company setting')).toBeVisible();
  await page.screenshot({ path: 'test-results/bonus-plans.png', fullPage: true });
});

test('every old payroll setup link lands in Payroll Center Settings', async ({ page }) => {
  await open(page);
  for (const url of ['/SetupCenter?tab=payroll', '/PayrollSetupWizard']) {
    await page.goto(url);
    await expect(page).toHaveURL(/\/PayrollCenter\?tab=settings/);
    await expect(page.getByRole('tab', { name: 'Pay cycle & switches' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Statutory rules & bonus' })).toBeVisible();
  }
  await page.goto('/SetupCenter');
  await expect(page.getByRole('button', { name: 'Attendance Setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Payroll Setup' })).toHaveCount(0);
  await page.getByRole('button', { name: 'First-Time Setup' }).click();
  await expect(page.getByText('Payroll Structure').first()).toBeVisible();
});

test('an impossible value is refused with a reason and nothing changes', async ({ page }) => {
  await open(page);
  const c = card(page, 'tax.new');
  await c.getByLabel('Band 2 Rate (%)').fill('500');
  await c.getByLabel(/Source, such as/).fill('typo');
  await c.getByRole('button', { name: 'Save and confirm' }).click();
  await expect(c.getByRole('alert')).toContainText('rate is not valid');
  await page.reload();
  await expect(card(page, 'tax.new').getByLabel('Band 2 Rate (%)')).toHaveValue('5');
});

test('no page error or server failure on the way', () => { expect(problems).toEqual([]); });
