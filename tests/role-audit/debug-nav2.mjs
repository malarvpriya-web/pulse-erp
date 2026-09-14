import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const API_BASE = 'http://localhost:5000/api';
const FRONT_BASE = 'http://localhost:5173';

function mintAuth(loginEmail) {
  const raw = execFileSync('node', ['scripts/e2e-mint-token.mjs'], {
    cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, E2E_LOGIN_EMAIL: loginEmail },
  });
  const fenced = raw.match(/---E2E_AUTH_BEGIN---\s*([\s\S]*?)\s*---E2E_AUTH_END---/);
  return JSON.parse(fenced[1].trim());
}

const auth = mintAuth('pilot.hr@manifest.in');
const permsRes = await fetch(`${API_BASE}/auth/permissions`, { headers: { Authorization: `Bearer ${auth.token}` } });
const perms = await permsRes.json();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
await context.addInitScript((a) => {
  localStorage.setItem('token', a.auth.token);
  localStorage.setItem('user', JSON.stringify(a.auth.user));
  localStorage.setItem('role', a.auth.role);
  localStorage.setItem('roles', JSON.stringify(a.auth.roles));
  localStorage.setItem('permissions', JSON.stringify(a.perms.permissions || []));
  localStorage.setItem('menuOverrides', JSON.stringify(a.perms.menuOverrides || {}));
}, { auth, perms });

await page.goto(`${FRONT_BASE}/`, { waitUntil: 'networkidle' });
console.log('AFTER INITIAL LOAD:', page.url());

async function visit(sectionName, subLabel) {
  const li = page.locator('.sidebar li', { hasText: sectionName }).first();
  await li.hover();
  await page.waitForTimeout(300);
  const target = subLabel
    ? page.locator('.submenu-panel.panel--visible button.nav-item', { hasText: subLabel }).first()
    : li.locator('button.nav-item').first();
  await target.click();
  await page.waitForTimeout(800);
  const h1 = await page.locator('h1, h2').first().textContent().catch(() => '(none)');
  console.log(`[${sectionName} -> ${subLabel}] url=${page.url()} heading="${h1}"`);
  // Move mouse to a neutral spot so the next hover starts clean, WITHOUT reloading.
  await page.mouse.move(700, 500);
  await page.waitForTimeout(150);
}

await visit('Home', null);
await visit('Approvals', null);
await visit('Analytics & AI', 'HR Dashboard');
await visit('Employees', 'Dashboard');
await visit('HR', 'Announcements');

await page.screenshot({ path: path.join(__dirname, 'screenshots', 'debug2-final.png') });
await browser.close();
