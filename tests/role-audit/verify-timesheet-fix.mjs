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

const networkErrors = [];
page.on('response', (res) => { if (res.status() >= 400) networkErrors.push({ reqUrl: res.url(), status: res.status() }); });
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

await context.addInitScript((a) => {
  localStorage.setItem('token', a.auth.token);
  localStorage.setItem('user', JSON.stringify(a.auth.user));
  localStorage.setItem('role', a.auth.role);
  localStorage.setItem('roles', JSON.stringify(a.auth.roles));
  localStorage.setItem('permissions', JSON.stringify(a.perms.permissions || []));
  localStorage.setItem('menuOverrides', JSON.stringify(a.perms.menuOverrides || {}));
}, { auth, perms });

await page.goto(`${FRONT_BASE}/MyTimesheet`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const heading = await page.locator('h1, h2').first().textContent().catch(() => '(none)');
console.log('Heading:', heading);
console.log('Network errors:', JSON.stringify(networkErrors));

await page.screenshot({ path: path.join(__dirname, 'screenshots', 'my-timesheet-fixed.png') });
await browser.close();
