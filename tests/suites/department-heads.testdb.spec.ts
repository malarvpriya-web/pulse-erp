/**
 * HR › Department Heads — every button on the page, in a real browser,
 * against the ISOLATED TEST DATABASE only (playwright.testdb.config.ts).
 *
 * It writes department-head assignments, so it refuses to run anywhere else.
 * The fixture (backend/scripts/test-db/department-heads-ui-fixture.mjs) gives
 * the E2E Test Company two employees with active logins and no heads, and
 * removes them afterwards.
 *
 *   collapse/expand · History (empty, then with entries) · Assign (no choice →
 *   error; choose → saved) · Cancel · Change (no reason → error; reason →
 *   saved) · Change to the same person (no change) · Remove (no reason →
 *   error; reason → removed) · the "No login" flag.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? '';
const API = process.env.PULSE_API_BASE ?? '';
const BACKEND = path.resolve(__dirname, '../../backend');

function fixture(...args: string[]) {
  const outText = execFileSync(process.execPath, ['scripts/test-db/department-heads-ui-fixture.mjs', ...args], {
    cwd: BACKEND, env: process.env, encoding: 'utf8',
  });
  return JSON.parse(outText.split('---FIXTURE---')[1]);
}

let fx: { department: string; heads: { name: string; email: string; office_id: string }[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (process.env.PULSE_TEST_DB !== '1' || !BASE || !API || /:5000(\/|$)/.test(API) || /:5173(\/|$)/.test(BASE)) {
    throw new Error('department-heads.testdb.spec writes assignments: run it with  npx playwright test -c playwright.testdb.config.ts');
  }
  execFileSync(process.execPath, ['scripts/test-db/assert-server.mjs', API], { cwd: BACKEND, stdio: 'inherit', env: process.env });
  fx = fixture('seed');
});
test.afterAll(() => { fixture('clean'); });

const row = (page: Page, dept: string) => page.locator(`tr[data-department="${dept}"]`);
const msg = (page: Page) => page.locator('.prob-dh-msg');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/DepartmentHeads`);
  await expect(page.getByRole('heading', { name: 'Department Heads' }).first()).toBeVisible();
  await expect(row(page, fx.department)).toBeVisible();
  return errors;
}

test('lists every active Master Data department, with collapse/expand', async ({ page }) => {
  const errors = await open(page);
  const rows = page.locator('tr[data-department]');
  expect(await rows.count()).toBeGreaterThan(1);
  await expect(row(page, fx.department)).toContainText('Not assigned');

  const toggle = page.getByRole('button', { name: /Department Heads/ });
  await toggle.click();
  await expect(page.locator('.prob-dh-table')).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('.prob-dh-table')).toBeVisible();
  expect(errors).toEqual([]);
});

test('History, Assign, Cancel, Change, same-person, Remove', async ({ page }) => {
  const errors = await open(page);
  const r = row(page, fx.department);
  const [alpha, bravo] = fx.heads;

  // History on a department never assigned
  await r.getByRole('button', { name: `History for ${fx.department}` }).click();
  await expect(page.getByText('No heads have been assigned yet.')).toBeVisible();
  await r.getByRole('button', { name: `History for ${fx.department}` }).click();
  await expect(page.getByText('No heads have been assigned yet.')).toHaveCount(0);

  // Assign → Cancel closes the editor
  await r.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByLabel(`Head for ${fx.department}`)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel(`Head for ${fx.department}`)).toHaveCount(0);

  // Assign without a choice → error; then choose Alpha → saved
  await r.getByRole('button', { name: 'Assign' }).click();
  const picker = page.getByLabel(`Head for ${fx.department}`);
  const options = await picker.locator('option').allTextContents();
  expect(options.some((o) => o.includes(alpha.name))).toBe(true);
  expect(options.some((o) => o.includes(bravo.name))).toBe(true);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(msg(page)).toHaveText('Choose a head.');
  await picker.selectOption({ label: options.find((o) => o.includes(alpha.name))! });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(msg(page)).toHaveText(`Head saved for ${fx.department}.`);
  await expect(r).toContainText(alpha.name);
  await expect(r).toContainText(alpha.office_id);
  await expect(r.getByRole('button', { name: 'Change' })).toBeVisible();
  await expect(r.getByRole('button', { name: 'Remove' })).toBeVisible();

  // Change to Bravo without a reason → error; with a reason → saved
  await r.getByRole('button', { name: 'Change' }).click();
  const picker2 = page.getByLabel(`Head for ${fx.department}`);
  await picker2.selectOption({ label: (await picker2.locator('option').allTextContents()).find((o) => o.includes(bravo.name))! });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(msg(page)).toHaveText('A reason is required to change the head.');
  await page.getByLabel(`Reason for ${fx.department}`).fill('Alpha moved to another team');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(msg(page)).toHaveText(`Head saved for ${fx.department}.`);
  await expect(r).toContainText(bravo.name);

  // Change to the same person → "No change"
  await r.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(msg(page)).toHaveText('No change — that person is already the head.');

  // History now lists both, with the reason
  await r.getByRole('button', { name: `History for ${fx.department}` }).click();
  const hist = page.getByRole('list', { name: `Assignment history for ${fx.department}` });
  await expect(hist.locator('li')).toHaveCount(2);
  await expect(hist).toContainText('Alpha moved to another team');
  await expect(hist).toContainText('current');
  await r.getByRole('button', { name: `History for ${fx.department}` }).click();

  // Remove without a reason → error; with a reason → removed
  await r.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove head' }).click();
  await expect(msg(page)).toHaveText('A reason is required to remove a head.');
  await page.getByLabel(`Reason for ${fx.department}`).fill('Department merged');
  await page.getByRole('button', { name: 'Remove head' }).click();
  await expect(msg(page)).toHaveText(`Head removed from ${fx.department}.`);
  await expect(r).toContainText('Not assigned');
  await expect(r.getByRole('button', { name: 'Assign' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('flags a head whose login was switched off', async ({ page }) => {
  await open(page);
  const r = row(page, fx.department);
  const [alpha] = fx.heads;
  await r.getByRole('button', { name: 'Assign' }).click();
  const picker = page.getByLabel(`Head for ${fx.department}`);
  await picker.selectOption({ label: (await picker.locator('option').allTextContents()).find((o) => o.includes(alpha.name))! });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(r).toContainText(alpha.name);

  fixture('drop-login', alpha.email);
  await page.reload();
  await expect(row(page, fx.department)).toContainText('No login');
});
