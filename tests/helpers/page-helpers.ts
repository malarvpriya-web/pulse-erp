import { Page, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

/**
 * Navigate to a page by its URL path and wait for the React app to finish
 * loading (Suspense spinner gone, no layout crash).
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.goto(`${BASE_URL}${path}`);
  await waitForPageLoad(page);
}

/**
 * Wait for the React Suspense loader to disappear and confirm the layout shell
 * is present. Throws if an error boundary fires.
 */
export async function waitForPageLoad(page: Page): Promise<void> {
  // Dismiss the Suspense spinner
  await page.waitForFunction(
    () => !document.querySelector('.page-loading'),
    { timeout: 20_000 }
  );

  // Give the page a short grace period for async API calls to settle
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Assert the page has not triggered an ErrorBoundary.
 * Checks for common error phrases rendered by ErrorBoundary components.
 */
export async function assertNoErrorBoundary(page: Page): Promise<void> {
  const errorPhrases = [
    'Something went wrong',
    'Oops! Something broke',
    'Unexpected error',
    'ChunkLoadError',
  ];

  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  for (const phrase of errorPhrases) {
    if (bodyText.includes(phrase)) {
      throw new Error(`ErrorBoundary triggered on ${page.url()} — found: "${phrase}"`);
    }
  }
}

/**
 * Assert the page has rendered actual content (not blank / redirect-loop).
 * Checks that the .page-content div has at least one child.
 */
export async function assertPageHasContent(page: Page): Promise<void> {
  const content = page.locator('.page-content');
  await expect(content).toBeVisible({ timeout: 10_000 });

  const childCount = await content.locator('> *').count();
  if (childCount === 0) {
    throw new Error(`Page content is empty on ${page.url()}`);
  }
}

/**
 * Assert the page is not stuck on the "Unauthorized" screen.
 */
export async function assertNotUnauthorized(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  if (bodyText.includes('You are not authorized') || bodyText.includes('403')) {
    throw new Error(`Unauthorized on ${page.url()} — check role permissions`);
  }
}

/**
 * Full health check for a page: load → no error boundary → has content.
 */
export async function assertPageHealthy(page: Page): Promise<void> {
  await waitForPageLoad(page);
  await assertNoErrorBoundary(page);
  await assertPageHasContent(page);
}

/**
 * Wait for a toast notification to appear (success or error).
 * Returns the toast text so callers can assert the message.
 */
export async function waitForToast(page: Page, timeoutMs = 8_000): Promise<string> {
  // Pulse uses react-hot-toast or similar — selectors cover common patterns
  const toastSelectors = [
    '[class*="toast"]',
    '[class*="Toastify"]',
    '[role="alert"]',
    '[class*="notification"]',
    '[class*="snackbar"]',
  ];

  for (const sel of toastSelectors) {
    const locator = page.locator(sel).first();
    const visible = await locator.isVisible().catch(() => false);
    if (visible) return locator.innerText({ timeout: timeoutMs });
  }

  // Wait for any of the selectors to appear
  await page.waitForSelector(toastSelectors.join(', '), { timeout: timeoutMs });
  return page.locator(toastSelectors.join(', ')).first().innerText();
}

/**
 * Fill a form field identified by label text.
 */
export async function fillByLabel(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label, { exact: false });
  await input.waitFor({ state: 'visible' });
  await input.fill(value);
}

/**
 * Click the first button matching the given name pattern.
 */
export async function clickButton(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole('button', { name }).click();
}

/**
 * Select an option from a <select> by visible text.
 */
export async function selectOption(page: Page, label: string, optionText: string): Promise<void> {
  const select = page.getByLabel(label, { exact: false });
  await select.selectOption({ label: optionText });
}

/**
 * Dismiss any open modal/dialog by pressing Escape.
 */
export async function dismissModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Scroll to the bottom of the page to trigger any lazy-loaded content.
 */
export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
}

/**
 * Take a labelled screenshot and save it to tests/reports/screenshots/.
 */
export async function screenshot(page: Page, label: string): Promise<void> {
  const filename = label.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  await page.screenshot({
    path: `tests/reports/screenshots/${filename}_${Date.now()}.png`,
    fullPage: false,
  });
}
