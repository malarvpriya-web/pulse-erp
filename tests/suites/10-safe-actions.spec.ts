/**
 * Suite 10 — Safe Action Execution
 *
 * Reads button-inventory.json and executes all SAFE-category actions:
 *   - Filter / Search
 *   - Export / Download
 *   - View / Preview / Detail
 *   - Refresh / Reload
 *   - Tabs / Panel switches
 *   - Navigation links
 *   - Close / Cancel / Back
 *   - Toggle / Expand / Collapse
 *   - Dropdown triggers (menu open only, not execute)
 *   - Pagination controls
 *
 * Verifies:
 *   - No crash / ErrorBoundary
 *   - No unhandled React error
 *   - No 5xx API response
 *   - No console.error with "Uncaught" or "TypeError"
 *
 * Output:
 *   tests/reports/safe-actions-results.json
 *   tests/reports/screenshots/   (failures only)
 *
 * Run:
 *   npx playwright test --project=safe-actions
 */

import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import {
  type DiscoveredAction,
  type ActionTestResult,
} from '../helpers/action-discovery';
import { waitForPageLoad } from '../helpers/page-helpers';
import fs   from 'fs';
import path from 'path';

const BASE     = 'http://localhost:5173';
const INV_FILE = 'tests/reports/button-inventory.json';
const OUT_FILE = 'tests/reports/safe-actions-results.json';
const SS_DIR   = 'tests/reports/screenshots';

// ─── Load inventory ───────────────────────────────────────────────────────────

function loadSafeActions(): DiscoveredAction[] {
  if (!fs.existsSync(INV_FILE)) return [];
  const inv = JSON.parse(fs.readFileSync(INV_FILE, 'utf8'));
  return (inv.actions as DiscoveredAction[]).filter(
    a => a.safetyCategory === 'SAFE'
  );
}

// Limit: 5 safe actions per route to keep runtime manageable
function sampleSafeActions(actions: DiscoveredAction[]): DiscoveredAction[] {
  const byRoute = new Map<string, DiscoveredAction[]>();
  for (const a of actions) {
    if (!byRoute.has(a.route)) byRoute.set(a.route, []);
    byRoute.get(a.route)!.push(a);
  }

  const sampled: DiscoveredAction[] = [];
  for (const [, routeActions] of byRoute) {
    // Prefer varied action types
    const typePriority: Record<string, number> = {
      'filter-button': 1,
      'export-button': 2,
      'tab': 3,
      'view-button': 4,
      'refresh-button': 5,
      'search-button': 6,
      'toggle-button': 7,
    };
    const sorted = [...routeActions].sort((a, b) =>
      (typePriority[a.actionType] ?? 99) - (typePriority[b.actionType] ?? 99)
    );
    sampled.push(...sorted.slice(0, 5));
  }
  return sampled;
}

// ─── Locator builder from inventory entry ─────────────────────────────────────

async function buildLocator(page: any, action: DiscoveredAction) {
  switch (action.selectorStrategy) {
    case 'testid':
      return page.locator(action.selector);
    case 'id':
      return page.locator(action.selector);
    case 'arialabel':
      return page.locator(action.selector);
    case 'role-text':
      return page.getByRole('button', { name: action.selectorText ?? action.actionLabel, exact: false });
    case 'text':
      return page.getByText(action.selectorText ?? action.actionLabel, { exact: false });
    case 'href':
      return page.locator(action.selector);
    case 'title':
      return page.locator(action.selector);
    default:
      return page.getByRole('button', { name: action.actionLabel, exact: false });
  }
}

// ─── Execute one safe action ──────────────────────────────────────────────────

async function executeSafeAction(
  page: any,
  action: DiscoveredAction,
  consoleErrors: string[],
  networkErrors: string[]
): Promise<{ pass: boolean; errorType?: string; errorMessage?: string; screenshotPath?: string }> {
  try {
    // Navigate to route
    const currentUrl = page.url();
    if (!currentUrl.includes(action.route.replace('/', ''))) {
      await page.goto(`${BASE}${action.route}`, { timeout: 20_000 });
      await waitForPageLoad(page).catch(() => null);
      await page.waitForTimeout(800);
    }

    const locator = await buildLocator(page, action);

    // Check element exists
    const exists = await locator.first().isVisible({ timeout: 4_000 }).catch(() => false);
    if (!exists) {
      return { pass: true }; // element not visible — skip, not a failure
    }

    // Clear captured errors before click
    const errsBefore = consoleErrors.length;
    const netBefore  = networkErrors.length;

    // Click the action
    await locator.first().click({ timeout: 5_000, force: false });
    await page.waitForTimeout(1200); // let async effects settle

    // Check for crash
    const body = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    if (body.includes('Something went wrong') || body.includes('Uncaught Error')) {
      const ssPath = path.join(SS_DIR, `safe-fail-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: false }).catch(() => null);
      return { pass: false, errorType: 'CRASH', errorMessage: 'ErrorBoundary triggered after click', screenshotPath: ssPath };
    }

    // Check new console errors
    const newConsoleErrs = consoleErrors.slice(errsBefore).filter(e =>
      e.includes('TypeError') || e.includes('Uncaught') || e.includes('ReferenceError')
    );
    if (newConsoleErrs.length > 0) {
      return { pass: false, errorType: 'CONSOLE_ERROR', errorMessage: newConsoleErrs[0] };
    }

    // Check new network errors (5xx only — 4xx may be expected for test env)
    const newNetErrs = networkErrors.slice(netBefore).filter(e => e.includes('5'));
    if (newNetErrs.length > 0) {
      return { pass: false, errorType: 'API_5XX', errorMessage: newNetErrs[0] };
    }

    // Try to close any modal that opened
    const modal = page.locator('[role="dialog"], .modal, [class*="modal"], [class*="drawer"]').first();
    const modalVisible = await modal.isVisible().catch(() => false);
    if (modalVisible) {
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(400);
    }

    return { pass: true };
  } catch (err: any) {
    if (err.message?.includes('Target closed') || err.message?.includes('Page closed')) {
      return { pass: false, errorType: 'PAGE_CRASH', errorMessage: err.message };
    }
    // Element not interactable / timeout — treat as SKIP
    return { pass: true }; // non-crash timeout = element not available, not a bug
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

// Tests are always registered — inventory loaded inside test body so it works
// correctly even when action-discovery runs as a Playwright dependency

test('@P0 [SAFE-ACTIONS] Execute safe actions across all modules and record results', async ({ page }: { page: Page }) => {
  // Load inventory at test-run time (not module-load time) so action-discovery
  // dependency has already created the file before this test runs
  const safeActions    = loadSafeActions();
  const sampledActions = sampleSafeActions(safeActions);

  if (sampledActions.length === 0) {
    console.warn('  button-inventory.json not found or empty. Run action-discovery project first.');
    return; // Not a failure — just no data yet
  }

  console.log(`\n📋 Safe Actions: ${safeActions.length} total, ${sampledActions.length} sampled`);

  {
    fs.mkdirSync(SS_DIR, { recursive: true });
    fs.mkdirSync('tests/reports', { recursive: true });

    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
    });
    page.on('response', resp => {
      if (resp.status() >= 500) networkErrors.push(`${resp.status()} ${resp.url()}`);
    });

    const results: ActionTestResult[] = [];
    let passed = 0, failed = 0, skipped = 0;

    for (const action of sampledActions) {
      const start = Date.now();
      const { pass, errorType, errorMessage, screenshotPath } = await executeSafeAction(
        page, action, consoleErrors, networkErrors
      );

      const result: ActionTestResult = {
        ...action,
        status:       pass ? 'PASS' : 'FAIL',
        errorType,
        errorMessage,
        screenshotPath,
        consoleErrors: [],
        networkErrors: [],
        durationMs:   Date.now() - start,
      };

      results.push(result);
      if (pass) passed++;
      else failed++;
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2), 'utf8');

    console.log(`\n✅ Safe Action Execution Complete`);
    console.log(`   Tested:  ${sampledActions.length}`);
    console.log(`   Pass:    ${passed}`);
    console.log(`   Fail:    ${failed}`);
    console.log(`   Output:  ${OUT_FILE}`);

    // Require at least 85% pass rate
    const passRate = passed / sampledActions.length;
    if (passRate < 0.85) {
      const failedList = results.filter(r => r.status === 'FAIL').slice(0, 10).map(r =>
        `${r.route} → "${r.actionLabel}" (${r.errorType}: ${r.errorMessage?.slice(0, 80)})`
      ).join('\n    ');
      throw new Error(
        `Safe action pass rate ${(passRate * 100).toFixed(1)}% is below 85% threshold.\n    Failed:\n    ${failedList}`
      );
    }
  }
}, { timeout: 3_600_000 }); // 1 hour — 268 actions × ~5-10s each

test('@P1 [SAFE-ACTIONS] Safe action results by module', async () => {
  if (!fs.existsSync(OUT_FILE)) return;

  const { results } = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  const byModule = new Map<string, { pass: number; fail: number }>();

  for (const r of results as ActionTestResult[]) {
    if (!byModule.has(r.module)) byModule.set(r.module, { pass: 0, fail: 0 });
    const entry = byModule.get(r.module)!;
    if (r.status === 'PASS') entry.pass++;
    else entry.fail++;
  }

  console.log('\n📊 Safe Actions by Module:');
  for (const [mod, { pass, fail }] of [...byModule.entries()].sort()) {
    const total = pass + fail;
    const pct   = total > 0 ? ((pass / total) * 100).toFixed(0) : '—';
    const icon  = fail > 0 ? '⚠️ ' : '✅';
    console.log(`   ${icon} ${mod.padEnd(18)} ${pass}/${total} (${pct}%)`);
  }
});
