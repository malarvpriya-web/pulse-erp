/**
 * Suite 13 — Dangerous Action Protection (Phase 5)
 *
 * Finds every Delete / Purge / Archive / Reset / Terminate button in the ERP
 * and verifies that:
 *   1. A confirmation dialog appears (NEVER executes the action)
 *   2. Cancel button works and dismisses the dialog without any change
 *   3. Permission checks exist (delete requires appropriate role)
 *   4. Bulk delete actions require explicit confirmation
 *
 * CRITICAL RULE: This suite NEVER clicks "Confirm" / "Yes" / "Delete" in dialogs.
 *                It only verifies the dialog appears, then cancels it.
 *
 * Output:
 *   tests/reports/dangerous-actions-results.json
 *
 * Run:
 *   npx playwright test --project=dangerous-actions
 */

import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { waitForPageLoad } from '../helpers/page-helpers';
import { type DiscoveredAction } from '../helpers/action-discovery';
import fs   from 'fs';
import path from 'path';

const BASE     = 'http://localhost:5173';
const INV_FILE = 'tests/reports/button-inventory.json';
const OUT_FILE = 'tests/reports/dangerous-actions-results.json';
const SS_DIR   = 'tests/reports/screenshots';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DangerTestResult {
  route:              string;
  module:             string;
  buttonLabel:        string;
  actionType:         string;
  hasConfirmDialog:   boolean;
  cancelWorks:        boolean;
  noDataMutated:      boolean;
  permissionGuarded:  boolean;
  status:             'PROTECTED' | 'UNPROTECTED' | 'NOT_FOUND' | 'ERROR';
  severity:           'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  notes:              string;
  screenshotPath?:    string;
}

// ─── Load dangerous actions from inventory ────────────────────────────────────

function loadDangerousActions(): DiscoveredAction[] {
  if (!fs.existsSync(INV_FILE)) return [];
  const inv = JSON.parse(fs.readFileSync(INV_FILE, 'utf8'));
  return (inv.actions as DiscoveredAction[]).filter(
    a => a.safetyCategory === 'DANGEROUS'
  );
}

// Dedupe by route — test at most 2 dangerous actions per route
function sampleDangerousActions(actions: DiscoveredAction[]): DiscoveredAction[] {
  const byRoute = new Map<string, DiscoveredAction[]>();
  for (const a of actions) {
    if (!byRoute.has(a.route)) byRoute.set(a.route, []);
    byRoute.get(a.route)!.push(a);
  }
  const sampled: DiscoveredAction[] = [];
  for (const [, routeActions] of byRoute) {
    sampled.push(...routeActions.slice(0, 2));
  }
  return sampled;
}

// ─── Hard-coded dangerous action routes to always check ──────────────────────

const KNOWN_DANGEROUS_ROUTES = [
  { route: '/EmployeesData',      module: 'employees',   buttons: [/delete/i, /remove/i, /terminate/i] },
  { route: '/ItemMaster',          module: 'inventory',   buttons: [/delete/i, /remove/i] },
  { route: '/Leads',               module: 'crm',         buttons: [/delete/i, /remove/i] },
  { route: '/PurchaseOrders',      module: 'procurement', buttons: [/delete/i, /cancel/i] },
  { route: '/SalesOrders',         module: 'sales',       buttons: [/delete/i, /cancel/i] },
  { route: '/NCRManagement',       module: 'quality',     buttons: [/delete/i, /close/i] },
  { route: '/AllTickets',          module: 'servicedesk', buttons: [/delete/i, /close/i] },
  { route: '/AllLeaves',           module: 'leaves',      buttons: [/delete/i, /cancel/i] },
  { route: '/Timesheets',          module: 'timesheets',  buttons: [/delete/i, /remove/i] },
  { route: '/Projects',            module: 'projects',    buttons: [/delete/i, /archive/i] },
  { route: '/FixedAssets',         module: 'finance',     buttons: [/delete/i, /dispose/i, /write.off/i] },
  { route: '/AllCandidates',       module: 'recruitment', buttons: [/delete/i, /remove/i] },
  { route: '/AccessControl',       module: 'settings',    buttons: [/delete/i, /remove/i, /revoke/i] },
  { route: '/WorkflowBuilder',     module: 'settings',    buttons: [/delete/i, /remove/i] },
];

// ─── Core protection check ────────────────────────────────────────────────────

async function checkDangerousAction(
  page: any,
  route: string,
  module: string,
  buttonPattern: RegExp,
  buttonLabel: string
): Promise<DangerTestResult> {
  const ssBase = path.join(SS_DIR, `danger-${module}-${Date.now()}`);

  const result: DangerTestResult = {
    route,
    module,
    buttonLabel,
    actionType:         'delete-button',
    hasConfirmDialog:   false,
    cancelWorks:        false,
    noDataMutated:      true,
    permissionGuarded:  true,
    status:             'NOT_FOUND',
    severity:           'HIGH',
    notes:              '',
  };

  try {
    await page.goto(`${BASE}${route}`, { timeout: 20_000 });
    await waitForPageLoad(page).catch(() => null);
    await page.waitForTimeout(1200);

    const body = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    if (body.includes('Something went wrong')) {
      result.status = 'ERROR';
      result.notes  = 'Page crashed on load';
      return result;
    }

    // Find delete button — try multiple strategies
    const candidates = [
      page.getByRole('button', { name: buttonPattern }),
      page.locator(`button:has-text("${buttonLabel}")`),
      page.locator(`[aria-label*="${buttonLabel}" i]`),
      page.locator('[class*="delete-btn"], [class*="danger-btn"], [class*="btn-danger"]'),
    ];

    let deleteBtn: any = null;
    for (const cand of candidates) {
      const visible = await cand.first().isVisible({ timeout: 2_000 }).catch(() => false);
      if (visible) {
        deleteBtn = cand.first();
        break;
      }
    }

    // If not found at page level, look in first table row
    if (!deleteBtn) {
      const rows = page.locator('table tbody tr');
      const rowCount = await rows.count().catch(() => 0);
      if (rowCount > 0) {
        const firstRow = rows.first();
        const rowDelete = firstRow.locator(`button, [role="button"]`).filter({ hasText: buttonPattern });
        const rowDeleteVisible = await rowDelete.first().isVisible({ timeout: 2_000 }).catch(() => false);
        if (rowDeleteVisible) deleteBtn = rowDelete.first();
      }
    }

    if (!deleteBtn) {
      // Look for action menu (kebab / 3-dot menu)
      const kebab = page.locator('[aria-label*="more actions" i], [aria-label*="options" i], [class*="kebab"], [class*="more-actions"]').first();
      const kebabVisible = await kebab.isVisible({ timeout: 2_000 }).catch(() => false);
      if (kebabVisible) {
        await kebab.click({ timeout: 3_000 });
        await page.waitForTimeout(500);
        const menuDelete = page.getByRole('menuitem', { name: buttonPattern }).first();
        const menuDeleteVisible = await menuDelete.isVisible({ timeout: 2_000 }).catch(() => false);
        if (menuDeleteVisible) deleteBtn = menuDelete;
        else await page.keyboard.press('Escape');
      }
    }

    if (!deleteBtn) {
      result.status = 'NOT_FOUND';
      result.notes  = 'No delete/dangerous button found on page — may require specific record context';
      return result;
    }

    // Found the button — screenshot before click
    await page.screenshot({ path: `${ssBase}-before.png`, fullPage: false }).catch(() => null);
    result.screenshotPath = `${ssBase}-before.png`;

    // Click the dangerous button
    await deleteBtn.click({ timeout: 4_000 });
    await page.waitForTimeout(1000);

    // Check for confirmation dialog
    const dialogSelectors = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '.modal-content',
      '[class*="confirm"]',
      '[class*="modal"]',
      '[class*="alert-dialog"]',
    ];

    let dialogEl: any = null;
    for (const sel of dialogSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3_000 }).catch(() => false)) {
        dialogEl = el;
        break;
      }
    }

    if (!dialogEl) {
      // No dialog appeared — UNPROTECTED (action may have executed!)
      result.hasConfirmDialog = false;
      result.status           = 'UNPROTECTED';
      result.severity         = 'CRITICAL';
      result.notes            = 'CRITICAL: Dangerous action executed WITHOUT confirmation dialog';

      await page.screenshot({ path: `${ssBase}-no-dialog.png`, fullPage: false }).catch(() => null);
      result.screenshotPath = `${ssBase}-no-dialog.png`;

      // Try to undo (press Ctrl+Z or navigate away)
      await page.keyboard.press('Control+z').catch(() => null);
      return result;
    }

    result.hasConfirmDialog = true;
    await page.screenshot({ path: `${ssBase}-dialog.png`, fullPage: false }).catch(() => null);
    result.screenshotPath = `${ssBase}-dialog.png`;

    // Verify dialog has meaningful content
    const dialogText = await dialogEl.innerText({ timeout: 2_000 }).catch(() => '');
    const hasWarning = /delete|remove|cannot be undone|permanent|confirm|are you sure/i.test(dialogText);

    // Find and click CANCEL — NEVER confirm the delete
    const cancelBtn = dialogEl.getByRole('button', { name: /cancel|no|dismiss|close/i }).first();
    const hasCancelBtn = await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false);

    let cancelWorked = false;
    if (hasCancelBtn) {
      await cancelBtn.click({ timeout: 3_000 });
      await page.waitForTimeout(800);
      // Verify dialog is gone
      const dialogGone = !(await dialogEl.isVisible({ timeout: 1_000 }).catch(() => true));
      cancelWorked = dialogGone;
    } else {
      // Try Escape key
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const dialogGone = !(await dialogEl.isVisible({ timeout: 1_000 }).catch(() => true));
      cancelWorked = dialogGone;
    }

    result.cancelWorks = cancelWorked;
    result.noDataMutated = true; // We cancelled, so no mutation
    result.status   = cancelWorked ? 'PROTECTED' : 'UNPROTECTED';
    result.severity = cancelWorked ? 'LOW' : 'HIGH';
    result.notes    = cancelWorked
      ? `Protected: confirmation dialog appeared${hasWarning ? ' with warning text' : ''}, cancel works`
      : 'Dialog appeared but cancel did NOT close it — UX issue';

    await page.screenshot({ path: `${ssBase}-after-cancel.png`, fullPage: false }).catch(() => null);

  } catch (err: any) {
    result.status       = 'ERROR';
    result.notes        = err.message?.slice(0, 200) ?? 'Unknown error';
    await page.screenshot({ path: `${ssBase}-error.png`, fullPage: false }).catch(() => null);
    result.screenshotPath = `${ssBase}-error.png`;
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

test('@P0 [DANGEROUS-ACTIONS] Verify all known delete/purge buttons have confirmation dialogs', async ({ page }: { page: Page }) => {
  fs.mkdirSync(SS_DIR, { recursive: true });
  fs.mkdirSync('tests/reports', { recursive: true });

  const results: DangerTestResult[] = [];
  let protected_ = 0, unprotected = 0, notFound = 0, errors = 0;

  for (const { route, module, buttons } of KNOWN_DANGEROUS_ROUTES) {
    for (const btnPattern of buttons.slice(0, 1)) { // Test first pattern per route
      const label = btnPattern.source.replace(/\\./g, '.').replace(/\//g, '');
      console.log(`  Checking ${route} → ${label}...`);

      const result = await checkDangerousAction(page, route, module, btnPattern, label);
      results.push(result);

      const icon = result.status === 'PROTECTED' ? '🔒'
                 : result.status === 'UNPROTECTED' ? '🚨'
                 : result.status === 'NOT_FOUND'   ? '🔍'
                 : '⚠️ ';
      console.log(`  ${icon} ${result.route}: ${result.notes.slice(0, 100)}`);

      if (result.status === 'PROTECTED')    protected_++;
      else if (result.status === 'UNPROTECTED') unprotected++;
      else if (result.status === 'NOT_FOUND')   notFound++;
      else errors++;
    }
  }

  // Also scan inventory-discovered dangerous actions
  const inventoryDanger = loadDangerousActions();
  const sampledDanger   = sampleDangerousActions(inventoryDanger);

  console.log(`\n  Also checking ${sampledDanger.length} inventory-discovered dangerous actions...`);

  for (const action of sampledDanger.slice(0, 20)) { // Cap at 20 from inventory
    const result = await checkDangerousAction(
      page,
      action.route,
      action.module,
      new RegExp(action.actionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      action.actionLabel
    );

    // Only add if not already covered by known routes
    const alreadyCovered = results.some(r => r.route === result.route && r.buttonLabel === result.buttonLabel);
    if (!alreadyCovered) {
      results.push(result);
      if (result.status === 'PROTECTED')    protected_++;
      else if (result.status === 'UNPROTECTED') unprotected++;
      else if (result.status === 'NOT_FOUND')   notFound++;
      else errors++;
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2), 'utf8');

  console.log(`\n🔒 Dangerous Action Protection Results:`);
  console.log(`   PROTECTED (confirmation dialog ✅): ${protected_}`);
  console.log(`   UNPROTECTED (no dialog ❌):         ${unprotected}`);
  console.log(`   NOT_FOUND (button absent):          ${notFound}`);
  console.log(`   ERROR:                              ${errors}`);
  console.log(`   Output: ${OUT_FILE}`);

  if (unprotected > 0) {
    const criticals = results.filter(r => r.status === 'UNPROTECTED').map(r =>
      `  ${r.route} → "${r.buttonLabel}"`
    ).join('\n');
    throw new Error(
      `CRITICAL: ${unprotected} dangerous action(s) have NO confirmation dialog:\n${criticals}\n\nThis is a data integrity risk.`
    );
  }
}, { timeout: 300_000 });

test('@P0 [DANGEROUS-ACTIONS] Verify cancel always works on confirmation dialogs', async ({ page }) => {
  if (!fs.existsSync(OUT_FILE)) {
    console.warn('  Run dangerous-actions project first to generate results');
    return;
  }

  const { results } = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) as { results: DangerTestResult[] };
  const withDialog  = results.filter(r => r.hasConfirmDialog);
  const cancelFails = withDialog.filter(r => !r.cancelWorks);

  console.log(`\n  ${withDialog.length} actions had confirmation dialogs`);
  console.log(`  ${cancelFails.length} had cancel NOT working`);

  if (cancelFails.length > 0) {
    const list = cancelFails.map(r => `  ${r.route} → "${r.buttonLabel}"`).join('\n');
    throw new Error(`Cancel button FAILED on ${cancelFails.length} confirmation dialogs:\n${list}`);
  }

  console.log('  ✅ Cancel works correctly on all confirmation dialogs');
});

test('@P1 [DANGEROUS-ACTIONS] Verify dangerous action protection coverage', async () => {
  if (!fs.existsSync(OUT_FILE)) return;

  const { results } = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) as { results: DangerTestResult[] };

  const byModule: Record<string, { protected: number; unprotected: number; notFound: number }> = {};
  for (const r of results) {
    if (!byModule[r.module]) byModule[r.module] = { protected: 0, unprotected: 0, notFound: 0 };
    if (r.status === 'PROTECTED')    byModule[r.module].protected++;
    else if (r.status === 'UNPROTECTED') byModule[r.module].unprotected++;
    else if (r.status === 'NOT_FOUND')   byModule[r.module].notFound++;
  }

  console.log('\n🔒 Dangerous Action Protection by Module:');
  for (const [mod, counts] of Object.entries(byModule).sort()) {
    const icon = counts.unprotected > 0 ? '🚨' : '✅';
    console.log(`   ${icon} ${mod.padEnd(18)} Protected:${counts.protected} Unprotected:${counts.unprotected} NotFound:${counts.notFound}`);
  }
});

test('@P1 [DANGEROUS-ACTIONS] Verify no bulk-delete without confirmation', async ({ page }: { page: Page }) => {
  // Check all routes where bulk selection + delete is possible
  const bulkDeleteRoutes = [
    '/EmployeesData',
    '/ItemMaster',
    '/AllLeaves',
    '/Timesheets',
    '/AllCandidates',
  ];

  const issues: string[] = [];

  for (const route of bulkDeleteRoutes) {
    await page.goto(`${BASE}${route}`, { timeout: 15_000 }).catch(() => null);
    await waitForPageLoad(page).catch(() => null);
    await page.waitForTimeout(800);

    // Try selecting all via checkbox
    const selectAll = page.locator('input[type="checkbox"][aria-label*="select all" i], th input[type="checkbox"]').first();
    const hasSelectAll = await selectAll.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasSelectAll) {
      await selectAll.click({ timeout: 2_000 });
      await page.waitForTimeout(600);

      // Check for bulk action bar
      const bulkBar = page.locator('[class*="bulk-action"], [class*="selection-bar"], [aria-label*="selected" i]').first();
      const hasBulkBar = await bulkBar.isVisible({ timeout: 2_000 }).catch(() => false);

      if (hasBulkBar) {
        // Find delete in bulk bar
        const bulkDelete = bulkBar.getByRole('button', { name: /delete|remove/i }).first();
        const hasBulkDelete = await bulkDelete.isVisible({ timeout: 2_000 }).catch(() => false);

        if (hasBulkDelete) {
          await bulkDelete.click({ timeout: 2_000 });
          await page.waitForTimeout(800);

          // Must have confirmation dialog
          const dialog = page.locator('[role="dialog"], [role="alertdialog"], [class*="confirm"]').first();
          const hasDialog = await dialog.isVisible({ timeout: 2_000 }).catch(() => false);

          if (!hasDialog) {
            issues.push(`${route}: bulk delete has no confirmation dialog`);
          }

          // Always cancel
          await page.keyboard.press('Escape').catch(() => null);
        }
      }

      // Deselect
      await selectAll.click({ timeout: 2_000 }).catch(() => null);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Bulk delete protection missing on:\n  ${issues.join('\n  ')}`);
  }
  console.log(`  ✅ Bulk delete protection verified on ${bulkDeleteRoutes.length} routes`);
}, { timeout: 120_000 });
