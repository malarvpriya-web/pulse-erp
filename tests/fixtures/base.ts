import { test as base, expect } from '@playwright/test';
import { navigateTo, assertPageHealthy, waitForToast, screenshot } from '../helpers/page-helpers';
import { attachConsoleCapture, ConsoleCapture } from '../helpers/console-capture';
import { attachNetworkCapture, NetworkCapture }  from '../helpers/network-capture';

/**
 * Extended Playwright fixture with:
 * - Pre-authenticated session (via storageState from auth.setup)
 * - Console error capture (automatically attaches to bug report on failure)
 * - Network failure capture (tracks 4xx/5xx by module)
 * - Helper methods attached to the test context
 */
export const test = base.extend<{
  /** Navigate to a path and assert the page is healthy */
  goto: (path: string) => Promise<void>;
  /** Assert the current page has no error boundary and has content */
  assertHealthy: () => Promise<void>;
  /** Wait for a toast notification and return its text */
  expectToast: () => Promise<string>;
  /** Take a named screenshot */
  snap: (label: string) => Promise<void>;
  /** Console capture instance — access captured errors / warnings */
  consoleCapture: ConsoleCapture;
  /** Network capture instance — access network failures by module */
  networkCapture: NetworkCapture;
}>({
  // ── Console capture ─────────────────────────────────────────────────────────
  consoleCapture: async ({ page }, use, testInfo) => {
    const capture = attachConsoleCapture(page);
    await use(capture);

    // On test end: attach to report if there were errors
    if (capture.errors().length > 0) {
      await capture.attachToReport(testInfo);
    }

    capture.detach();
  },

  // ── Network capture ─────────────────────────────────────────────────────────
  networkCapture: async ({ page }, use, testInfo) => {
    const capture = attachNetworkCapture(page);
    await use(capture);

    // On test end: attach network failures to report
    if (capture.failures().length > 0) {
      await capture.attachToReport(testInfo);
    }

    capture.detach();
  },

  // ── Navigation helper ────────────────────────────────────────────────────────
  goto: async ({ page }, use) => {
    await use(async (path: string) => {
      await navigateTo(page, path);
    });
  },

  // ── Page health assertion ─────────────────────────────────────────────────────
  assertHealthy: async ({ page }, use) => {
    await use(async () => {
      await assertPageHealthy(page);
    });
  },

  // ── Toast helper ──────────────────────────────────────────────────────────────
  expectToast: async ({ page }, use) => {
    await use(async () => waitForToast(page));
  },

  // ── Screenshot helper ─────────────────────────────────────────────────────────
  snap: async ({ page }, use) => {
    await use(async (label: string) => {
      await screenshot(page, label);
    });
  },
});

export { expect };
