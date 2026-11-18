/**
 * §254 — the settlement screen in a real browser, on a throwaway company in the test database.
 *
 * Run: npx playwright test -c playwright.testdb.config.ts --project=settlement
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

let fx: any;
let auth: any;
const problems: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fx = backend('scripts/e2e-settlement-fixture.mjs', ['setup']);
  auth = backend('scripts/e2e-mint-token.mjs', [], { E2E_LOGIN_EMAIL: fx.email }, 'E2E_AUTH');
  if (auth.user.email !== fx.email) throw new Error(`minted ${auth.user.email}, wanted ${fx.email}`);
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
  await page.goto('/ExitManagement');
}

test('computing shows every line, how it was worked out, and what is not confirmed', async ({ page }) => {
  await open(page);
  const row = page.locator('tr', { hasText: 'Leaver' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /F&F|Calculate|Settle/i }).first().click();

  const table = page.locator('table', { hasText: 'How it was worked out' });
  await expect(table).toBeVisible();
  await expect(table.getByText('Final month salary')).toBeVisible();
  await expect(table.getByText('Earned Leave encashment')).toBeVisible();
  await expect(table.getByText('Statutory bonus')).toBeVisible();
  await expect(table.getByText('Gratuity', { exact: true })).toBeVisible();
  await expect(table.getByText('Notice shortfall')).toBeVisible();
  await expect(page.getByText(/Settlement, version 1/)).toBeVisible();
  await expect(page.getByText('Rules not yet confirmed by your adviser')).toBeVisible();
  await expect(page.getByText(/Provisional figures/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/settlement-computed.png', fullPage: true });

  // An input changes the result, and adds a version rather than overwriting.
  await page.getByLabel('Resignation date').fill('2026-10-12');
  await page.getByRole('button', { name: 'Recalculate' }).click();
  await expect(page.getByText(/Settlement, version 2/)).toBeVisible();
  await expect(table.getByText(/10 short/)).toBeVisible();
  expect(problems).toEqual([]);
});

test('a rule can be entered on screen, and then counts as confirmed', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settlement Rules' }).click();
  await expect(page.getByText(/rules are not confirmed/)).toBeVisible();
  const banner = await page.getByText(/rules are not confirmed/).innerText();
  const open0 = Number(banner.match(/^(\d+) of/)?.[1]);

  const card = page.locator('[data-rule="settlement.bonus"]');
  await card.getByLabel(/Calculation wage/i).fill('7500');
  await card.getByLabel(/Source, such as/).fill('Adviser letter, browser test');
  await card.getByRole('button', { name: 'Save and confirm' }).click();

  await expect(page.getByText(`${open0 - 1} of`, { exact: false })).toBeVisible();
  await expect(page.locator('[data-rule="settlement.bonus"]').getByText('Confirmed')).toBeVisible();
  await page.screenshot({ path: 'test-results/settlement-rules.png', fullPage: true });
  expect(problems).toEqual([]);
});
