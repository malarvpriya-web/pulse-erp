// Per-role sidebar crawl for the Priority-1 "day in the life" audit.
//
// Mints a token for a given login email (no password needed — reuses
// backend/scripts/e2e-mint-token.mjs, same mechanism as tests/auth.setup.ts),
// fetches REAL permissions from /api/auth/permissions (auth.setup.ts always
// seeds an empty permissions array, which would make every hasPermission()-
// gated button look "missing" for every non-admin role — this script fixes
// that so findings reflect the app, not a test-harness artifact), then hovers
// each visible top-level sidebar item to read its submenu, and clicks into
// one representative page per section to catch console/network errors.
//
// Usage: node tests/role-audit/crawl-role.mjs <email> <role-label>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const API_BASE = 'http://localhost:5000/api';
const FRONT_BASE = 'http://localhost:5173';

const [, , email, roleLabel] = process.argv;
if (!email || !roleLabel) {
  console.error('Usage: node crawl-role.mjs <email> <role-label>');
  process.exit(1);
}

function mintAuth(loginEmail) {
  const raw = execFileSync('node', ['scripts/e2e-mint-token.mjs'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, E2E_LOGIN_EMAIL: loginEmail },
  });
  const fenced = raw.match(/---E2E_AUTH_BEGIN---\s*([\s\S]*?)\s*---E2E_AUTH_END---/);
  if (!fenced) throw new Error(`mint script produced no auth payload for ${loginEmail}:\n${raw}`);
  return JSON.parse(fenced[1].trim());
}

async function fetchRealPermissions(token) {
  const res = await fetch(`${API_BASE}/auth/permissions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /auth/permissions -> ${res.status}`);
  return res.json();
}

async function main() {
  const auth = mintAuth(email);
  const permsBody = await fetchRealPermissions(auth.token);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push({ url: page.url(), text: msg.text() }); });
  page.on('response', (res) => { if (res.status() >= 400) networkErrors.push({ url: page.url(), reqUrl: res.url(), status: res.status() }); });

  await context.addInitScript((a) => {
    localStorage.setItem('token', a.auth.token);
    localStorage.setItem('user', JSON.stringify(a.auth.user));
    localStorage.setItem('role', a.auth.role);
    localStorage.setItem('roles', JSON.stringify(a.auth.roles));
    localStorage.setItem('permissions', JSON.stringify(a.perms.permissions || []));
    localStorage.setItem('menuOverrides', JSON.stringify(a.perms.menuOverrides || {}));
  }, { auth, perms: permsBody });

  await page.goto(`${FRONT_BASE}/`, { waitUntil: 'networkidle' });

  const sidebarVisible = await page.locator('.sidebar').isVisible().catch(() => false);
  if (!sidebarVisible || page.url().includes('/login')) {
    writeFileSync(
      path.join(__dirname, 'results', `${roleLabel}.json`),
      JSON.stringify({ roleLabel, email, error: 'AUTH_FAILED — no sidebar / redirected to login', url: page.url() }, null, 2)
    );
    await browser.close();
    console.error(`[${roleLabel}] AUTH FAILED — see results/${roleLabel}.json`);
    process.exit(1);
  }

  // Top-level visible items, in DOM order.
  const topItems = await page.locator('.sidebar li').evaluateAll((els) =>
    els.map((el) => el.querySelector('.label')?.textContent?.trim()).filter(Boolean)
  );

  const heading = () => page.locator('h1, h2').first().textContent().catch(() => null);

  const sections = [];
  for (const name of topItems) {
    const li = page.locator('.sidebar li', { hasText: name }).first();
    await li.hover();
    await page.waitForTimeout(250); // OPEN_MENU dispatch + portal render

    const subItems = await page.locator('.submenu-panel.panel--visible button.nav-item').allTextContents();
    const cleanedSub = subItems.map((s) => s.trim()).filter(Boolean);

    // Either click the revealed submenu's first entry, or — for items with no
    // flyout (Home, Approvals, QR Codes, Notifications, Org Chart etc. render
    // no `.submenu-panel`) — click the top-level nav-item button itself, which
    // navigates directly via its own `item.page` (Sidebar.jsx:350-358).
    //
    // Match by the label text just read, not `.first()` positionally — a bare
    // `.first()` intermittently resolved to a stale/leftover portal node.
    const label = cleanedSub.length ? cleanedSub[0] : name;
    const target = cleanedSub.length
      ? page.locator('.submenu-panel.panel--visible button.nav-item', { hasText: label }).first()
      : li.locator('button.nav-item', { hasText: label }).first();
    const before = consoleErrors.length, beforeNet = networkErrors.length;
    const urlBefore = page.url();
    const headingBefore = await heading();

    await target.click();
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    // The SPA occasionally leaves the PREVIOUS page's content on screen after
    // a rapid client-side navigation (URL/history updates, component doesn't)
    // — reproduced consistently after ~4-5 fast navigations in a row (see
    // debug-nav2.mjs). Detect it by polling for the heading to actually change,
    // and recover with one re-click rather than silently recording stale content.
    let headingAfter = await heading();
    let staleContentDetected = false;
    if (headingAfter === headingBefore) {
      staleContentDetected = true;
      for (let i = 0; i < 6 && headingAfter === headingBefore; i++) {
        await page.waitForTimeout(500);
        headingAfter = await heading();
      }
      if (headingAfter === headingBefore) {
        // Still stuck — one recovery re-click before giving up.
        await target.click().catch(() => {});
        await page.waitForTimeout(1200);
        headingAfter = await heading();
      }
    }

    const navigated = page.url() !== urlBefore;
    const shot = `${roleLabel}__${name}`.replace(/[^\w-]+/g, '_').slice(0, 120) + '.png';
    await page.screenshot({ path: path.join(__dirname, 'screenshots', shot), fullPage: false }).catch(() => {});
    const visited = {
      clickedLabel: label,
      landedUrl: page.url(),
      navigated,
      heading: headingAfter,
      staleContentDetected: staleContentDetected && headingAfter === headingBefore,
      newConsoleErrors: consoleErrors.slice(before),
      newNetworkErrors: networkErrors.slice(beforeNet),
      screenshot: shot,
    };
    // Neutral cursor position so the next hover starts clean (no full reload —
    // that was itself implicated in the staleness above).
    await page.mouse.move(700, 500);
    await page.waitForTimeout(150);

    sections.push({ name, submenu: cleanedSub, visited });
  }

  const summary = {
    roleLabel,
    email,
    roles: auth.roles,
    sectionsVisibleCount: sections.length,
    sections,
    totalConsoleErrors: consoleErrors.length,
    totalNetworkErrors: networkErrors.length,
    allNetworkErrors: networkErrors,
  };
  writeFileSync(path.join(__dirname, 'results', `${roleLabel}.json`), JSON.stringify(summary, null, 2));
  console.log(`[${roleLabel}] ${sections.length} sections visited, ${networkErrors.length} network errors, ${consoleErrors.length} console errors`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
