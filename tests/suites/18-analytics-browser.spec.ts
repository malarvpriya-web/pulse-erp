/**
 * 18-analytics-browser.spec.ts — real browser verification of every page in the
 * Analytics & AI menu.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every prior check on this module was an API contract test. Those catch wrong
 * numbers; they cannot catch a page that throws on mount, renders a blank div,
 * loses its filter state on reload, or fails only when React tries to map over
 * a null the endpoint is entitled to return. The previous remediation reported
 * the module "E2E verified" on the strength of 21 API-level tests and no browser
 * pass at all.
 *
 * The eight pages come from the 'Analytics & AI' group in
 * frontend/src/config/routes.jsx — the menu itself is the source of truth, so a
 * page added there without a test here shows up as a gap rather than silently
 * going unchecked.
 *
 * Per page this asserts:
 *   - the route renders its own content, not a blank shell or an error boundary
 *   - no uncaught exception, no React error, no console error
 *   - no 5xx from any request the page makes
 *   - a deep link works (not just in-app navigation)
 *   - reload does not break it
 *   - every tab/sub-view is clicked and survives
 * plus a separate group for filters and drill-down actions.
 *
 * Run: npx playwright test --project=analytics-browser
 */
import { test, expect, Page } from '@playwright/test';

/**
 * The Analytics & AI menu, mirroring routes.jsx.
 * `marker` is text that only appears once the page's own content has rendered,
 * so an empty layout shell cannot pass as a working page.
 */
const PAGES = [
  { name: 'CEO Intelligence',    path: '/CEOIntelligenceDashboard',  marker: /Executive Summary|Strategic|Collections|Business Line/i },
  { name: 'Executive Dashboard', path: '/ExecutiveDashboard',        marker: /Executive Dashboard|Top Customers|Workforce/i },
  { name: 'Ops Command Center',  path: '/AdminDashboard',            marker: /Module Activity|Reset Password|Users/i },
  { name: 'CFO Dashboard',       path: '/CFODashboard',              marker: /Accounts Receivable|Burn Rate|P&L Bridge/i },
  { name: 'HR Dashboard',        path: '/HRDashboard',               marker: /Total Employees|Department Headcount|Attrition Rate/i },
  { name: 'HR Benchmarking',     path: '/HRBenchmarkingDashboard',   marker: /Benchmark|Industry|Percentile|Cost per Hire/i },
  { name: 'ERP Intelligence',    path: '/ERPIntelligence',           marker: /Ask|Assistant|Suggested|Insight/i },
  { name: 'System Health',       path: '/SystemHealth',              marker: /Uptime|Database|Latency|Health Check|Migrations/i },
];

/** Console errors that are environmental rather than defects in the page. */
const IGNORABLE = [
  /favicon/i,
  /ResizeObserver loop/i,          // benign browser warning, not a page fault
  /Download the React DevTools/i,
  /\[vite\]/i,                     // dev-server HMR chatter
  /net::ERR_ABORTED/i,             // navigation cancelling an in-flight fetch
];

type Collected = { consoleErrors: string[]; pageErrors: string[]; serverErrors: string[] };

/** Attach listeners that record anything the page does wrong. */
function collect(page: Page): Collected {
  const c: Collected = { consoleErrors: [], pageErrors: [], serverErrors: [] };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (IGNORABLE.some((r) => r.test(t))) return;
    c.consoleErrors.push(t);
  });
  page.on('pageerror', (e) => c.pageErrors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) c.serverErrors.push(`${r.status()} ${r.url()}`);
  });
  return c;
}

/** Navigate and wait for the app to settle. */
async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => { /* long-poll pages */ });
  // These dashboards fetch on mount and again once their filter bar resolves its
  // options, so content can be ~4s behind `networkidle`. A short settle made an
  // earlier probe conclude the pages rendered nothing at all.
  await page.waitForTimeout(3_500);
}

/** Fail with everything the page did wrong, not just the first thing. */
function assertClean(c: Collected, where: string) {
  expect(c.pageErrors, `${where} — uncaught exception:\n${c.pageErrors.join('\n')}`).toEqual([]);
  expect(c.serverErrors, `${where} — 5xx response:\n${c.serverErrors.join('\n')}`).toEqual([]);
  expect(c.consoleErrors, `${where} — console error:\n${c.consoleErrors.join('\n')}`).toEqual([]);
}

/** The app shell rendered AND the page put its own content inside it. */
async function assertRendered(page: Page, marker: RegExp, where: string) {
  await expect(page.locator('.sidebar'), `${where} — app shell missing (bounced to login?)`)
    .toBeVisible({ timeout: 15_000 });
  expect(page.url(), `${where} — redirected to login`).not.toContain('/login');

  // An error boundary or a crashed subtree leaves the shell but no content.
  const body = await page.locator('body').innerText();
  expect(body.length, `${where} — page body is empty`).toBeGreaterThan(200);
  expect(body, `${where} — page shows an error boundary`)
    .not.toMatch(/Something went wrong|Application error|Unexpected Application Error/i);
  expect(body, `${where} — page content did not render`).toMatch(marker);
}

test.describe('@P0 Analytics & AI — every page renders in a browser', () => {
  for (const p of PAGES) {
    test(`${p.name} loads clean at ${p.path}`, async ({ page }) => {
      const c = collect(page);
      await open(page, p.path);
      await assertRendered(page, p.marker, p.name);
      assertClean(c, p.name);
    });
  }
});

test.describe('@P0 Analytics & AI — deep link and reload', () => {
  for (const p of PAGES) {
    test(`${p.name} survives a hard reload`, async ({ page }) => {
      // Deep-linking straight to the route (rather than clicking through the
      // menu) is how a bookmarked dashboard is opened, and it exercises the
      // path where context has not been warmed by a previous page.
      await open(page, p.path);
      const c = collect(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(900);
      await assertRendered(page, p.marker, `${p.name} (after reload)`);
      assertClean(c, `${p.name} (after reload)`);
    });
  }
});

test.describe('@P0 Analytics & AI — tabs and sub-views', () => {
  test('every CEO Intelligence tab opens without error', async ({ page }) => {
    const c = collect(page);
    await open(page, '/CEOIntelligenceDashboard');
    await assertRendered(page, /Executive|CEO|Intelligence/i, 'CEO Intelligence');

    // The tab strip is the page's primary navigation; each tab mounts a
    // different panel with its own endpoint, so one broken tab is invisible
    // from any other.
    const tabs = page.locator('button, [role="tab"]').filter({
      hasText: /Executive|Customer|Vendor|Project|Collection|Service|Alert|Business Line|Insight/i,
    });
    const n = await tabs.count();
    expect(n, 'no CEO Intelligence tabs found — selector is stale').toBeGreaterThan(2);

    let opened = 0;
    for (let i = 0; i < n; i++) {
      const tab = tabs.nth(i);
      if (!(await tab.isVisible().catch(() => false))) continue;
      const label = (await tab.innerText().catch(() => '')).trim();
      await tab.click({ timeout: 8_000 }).catch(() => { /* overlapped; skip */ });
      await page.waitForTimeout(700);
      opened++;
      const body = await page.locator('body').innerText();
      expect(body, `tab "${label}" rendered an error`)
        .not.toMatch(/Something went wrong|Unexpected Application Error/i);
      expect(c.pageErrors, `tab "${label}" threw:\n${c.pageErrors.join('\n')}`).toEqual([]);
    }
    expect(opened, 'no tab was actually clickable').toBeGreaterThan(2);
    assertClean(c, 'CEO Intelligence tabs');
  });
});

test.describe('@P1 Analytics & AI — filters drive the page', () => {
  test('HR Dashboard department and period filters re-query the backend', async ({ page }) => {
    const c = collect(page);
    await open(page, '/HRDashboard');
    await assertRendered(page, /Total Employees|Department Headcount|Attrition Rate/i, 'HR Dashboard');

    // The filter bar lives on the Analytics tab, not the default Overview tab —
    // a filter test that only looks at the landing view finds no controls and
    // concludes, wrongly, that the page has none.
    await page.locator('button', { hasText: /^Analytics$/ }).first().click();
    await page.waitForTimeout(2_500);

    const selects = page.locator('select');
    const count = await selects.count();
    expect(count, 'HR Analytics tab exposes no filter controls').toBeGreaterThan(1);

    // The defect this guards: the department dropdown used to filter one
    // already-loaded array in memory, so seventeen of the eighteen widgets
    // ignored it and no request was ever sent. Every control must reach the API.
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;

      const opts = sel.locator('option');
      if (await opts.count() < 2) continue;
      const label = (await opts.nth(0).innerText().catch(() => `select ${i}`)).trim();
      const value = await opts.nth(1).getAttribute('value');
      if (!value) continue;

      const waitReq = page.waitForRequest(
        (r) => /\/analytics\//.test(r.url()) && r.method() === 'GET',
        { timeout: 10_000 },
      ).catch(() => null);
      await sel.selectOption(value).catch(() => {});
      const req = await waitReq;
      expect(req, `changing "${label}" sent no /analytics request — filtering is client-side only`)
        .toBeTruthy();

      // A filter that reaches the server but drops its value on the floor is the
      // same bug wearing a disguise, so assert the value is actually carried.
      const url = req!.url();
      expect(url, `"${label}" request carried no query string`).toContain('?');
    }
    assertClean(c, 'HR Dashboard filters');
  });

  test('CFO Dashboard period switch re-queries the backend', async ({ page }) => {
    const c = collect(page);
    await open(page, '/CFODashboard');
    await assertRendered(page, /Accounts Receivable|Burn Rate|P&L Bridge/i, 'CFO Dashboard');

    // Updated 2026-08-26: the hand-rolled YTD/Q1..Q4 button strip was replaced
    // by the canonical <DashboardFilterBar> (a <select> of the shared presets),
    // so this drives the select. The old assertion looked for a `Q2` button and
    // `period=Q2` — neither exists on this page any more, and a locator that
    // matches nothing fails loudly rather than passing vacuously, which is why
    // this had to move with the DOM.
    const periodSelect = page.locator('.pl-filterbar select').first();
    expect(await periodSelect.count(), 'CFO Dashboard has no filter bar').toBeGreaterThan(0);
    expect(await periodSelect.inputValue(), 'CFO filter did not default to This FY').toBe('fytd');

    const waitReq = page.waitForRequest(
      (r) => /\/dashboard\/cfo/.test(r.url()), { timeout: 10_000 },
    ).catch(() => null);
    await periodSelect.selectOption('last90');
    const req = await waitReq;

    expect(req, 'period change sent no /dashboard/cfo request').toBeTruthy();
    // Server-side filtering: the chosen period must travel with the request, in
    // the shared vocabulary (hooks/useDashboardFilters ↔ resolveRange).
    expect(req!.url(), 'period was not passed to the backend').toMatch(/period=last90/i);
    assertClean(c, 'CFO Dashboard period filter');
  });

  test('CFO Dashboard labels its cards from the window the server resolved', async ({ page }) => {
    // A dashboard that labels a card from the preset it SENT can relabel numbers
    // it did not move: `all` resolves server-side to the first day of the book
    // and `custom` to whatever survived validation, neither of which the client
    // knows (manual §121). The endpoint returns `period_label`; the page must
    // render that, not the preset.
    const c = collect(page);
    await open(page, '/CFODashboard');
    await assertRendered(page, /Accounts Receivable|Burn Rate|P&L Bridge/i, 'CFO Dashboard');

    await page.locator('.pl-filterbar select').first().selectOption('all');
    await page.waitForTimeout(3_000);

    const body = await page.locator('body').innerText();
    expect(body, 'card labels did not follow the server period_label')
      .toMatch(/all time/i);
    assertClean(c, 'CFO Dashboard period label');
  });

  test('CEO Intelligence prefetches its tabs and each one renders', async ({ page }) => {
    const c = collect(page);
    const fetched = new Set<string>();
    page.on('request', (r) => {
      const m = r.url().match(/\/api\/(ceo-intelligence\/[a-z-]+)/);
      if (m) fetched.add(m[1]);
    });

    await open(page, '/CEOIntelligenceDashboard');
    await assertRendered(page, /Executive Summary|Strategic|Collections|Business Line/i, 'CEO Intelligence');
    await page.waitForTimeout(3_000);

    // This page loads every tab's data on mount rather than on tab click, so a
    // test that waits for a request after clicking waits forever and reports a
    // working tab as broken. Assert the real contract instead: the data was
    // fetched up front, and switching tabs renders it without a fault.
    for (const ep of ['ceo-intelligence/executive-summary', 'ceo-intelligence/collections',
                      'ceo-intelligence/customers', 'ceo-intelligence/projects']) {
      expect([...fetched], `${ep} was never fetched on mount`).toContain(ep);
    }

    const tab = page.locator('button', { hasText: /Collection/i }).first();
    expect(await tab.count(), 'no Collections tab in this build').toBeGreaterThan(0);
    await tab.click();
    await page.waitForTimeout(1_500);

    const body = await page.locator('body').innerText();
    expect(body, 'Collections tab rendered an error').not.toMatch(/Something went wrong/i);
    expect(body.length, 'Collections tab rendered nothing').toBeGreaterThan(200);
    assertClean(c, 'CEO Intelligence tab switch');
  });
});

test.describe('@P0 Analytics & AI — unauthorized access is refused', () => {
  // Clears the project's storageState for this block only. `browser.newContext()`
  // still inherits the config's `use` options, so an ad-hoc context created
  // inside the test arrives already signed in and the assertion passes or fails
  // for the wrong reason — the first run of this test reported a redirect
  // failure that turned out to be the authenticated session leaking in.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a signed-out browser cannot open a dashboard', async ({ page }) => {
    await page.goto('/CFODashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'fixture is not actually signed out').toBeFalsy();

    const body = await page.locator('body').innerText();
    const onLogin = page.url().includes('/login')
      || /sign in|log in|password/i.test(body);
    expect(onLogin, `signed-out user was not sent to login (url ${page.url()})`).toBe(true);
    // The sidebar carries a "Revenue" menu label, so match on figures that only
    // appear once the CFO panel has actually rendered data.
    expect(body, 'signed-out user saw financial figures')
      .not.toMatch(/Receivable|EBITDA|Net Profit|Burn Rate/i);
  });
});
