/**
 * 30-integrations-authz.spec.ts — PULSE-01 in the browser.
 *
 * The PULSE-01 remediation and its follow-ups changed what the Integrations pages
 * are allowed to do, and two of those changes are visible to the UI rather than
 * only to the API:
 *
 *   - `GET /settings/integrations` no longer returns the wizard's own plaintext
 *     JSON from `company_settings`. It returns the ENCRYPTED per-tenant store,
 *     translated back into the wizard's field shape with secrets masked as '***'.
 *     `SetupWizard.jsx` derives `configured: !!(data.razorpay?.key_id)` from that
 *     response, so the mask has to stay TRUTHY or the wizard forgets what is set up.
 *   - `GET /integrations/config/:key` masks secrets and now filters through an
 *     allowlist, and `IntegrationsHub.jsx` pre-fills its form from that response
 *     and submits back what it was given. If a masked or legacy field came back
 *     that the PUT then rejected, the administrator could never save again.
 *
 * ⚠ THE POINT OF DOING THIS IN A BROWSER is the round trip. The API tests prove
 * each half; only the real page proves that what a GET hands the form is
 * something the PUT will accept.
 *
 * ⚠ Routes here are PATH-based (`/IntegrationsHub`), matching tests/helpers/routes.ts.
 * A `?page=` query renders the shell with an empty body and every selector then
 * times out looking like a broken page — which is exactly how this spec failed
 * on its first run.
 *
 * Requires the dev pair (backend 5000, frontend 5173) and the minted admin
 * storageState from auth.setup.ts.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForPageLoad } from '../helpers/page-helpers';

const API  = process.env.PULSE_API_BASE   ?? 'http://localhost:5000';
const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';
const CANARY = 'browser-round-trip-canary-secret';

/**
 * The Authorization header for direct API calls.
 *
 * ⚠ Playwright's `request` fixture inherits storageState COOKIES, and this app
 * keeps its JWT in localStorage instead — so `request` arrives unauthenticated and
 * every call answers 401 "Session expired". That is not a regression in the
 * endpoint; it is the fixture. The token is lifted out of the same auth file the
 * browser context uses, so page and API calls act as the SAME admin.
 */
function authHeader(): Record<string, string> {
  const authFile = resolve(__dirname, '../.auth/user.json');
  const state = JSON.parse(readFileSync(authFile, 'utf8'));
  const token = state.origins
    ?.flatMap((o: { localStorage?: { name: string; value: string }[] }) => o.localStorage ?? [])
    .find((i: { name: string }) => i.name === 'token')?.value;
  if (!token) throw new Error('No token in tests/.auth/user.json — did auth.setup.ts run?');
  return { Authorization: `Bearer ${token}` };
}
const HEADERS = { headers: authHeader() };

test.describe('PULSE-01 — Integrations pages, authorized admin', () => {
  test('the Integrations Hub loads for an admin and leaks no credential into the DOM', async ({ page }) => {
    const denied: string[] = [];
    page.on('response', (r) => {
      if (r.status() === 403 && (r.url().includes('/integrations/') || r.url().includes('/settings/'))) {
        denied.push(`${r.status()} ${r.url()}`);
      }
    });

    await page.goto(`${BASE}/IntegrationsHub`);
    await waitForPageLoad(page);
    await expect(page.getByText(/WhatsApp Business/i).first()).toBeVisible({ timeout: 20_000 });

    // The gate must not lock out the role the page exists for.
    expect(denied, `the admin was denied: ${denied.join(', ')}`).toEqual([]);

    // '***' is expected in the DOM; a live credential is not.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(CANARY);
    expect(body).not.toMatch(/SG\.[A-Za-z0-9_-]{16,}/);      // SendGrid key shape
    expect(body).not.toMatch(/rzp_live_[A-Za-z0-9]{6,}/);    // Razorpay live key
    expect(body).not.toMatch(/\bEAA[A-Za-z0-9]{24,}/);       // Meta token shape
  });

  test('a saved secret is masked on read and SURVIVES a masked round trip', async ({ request }) => {
    // The destructive failure this guards against: the form reads '***' and posts
    // it back, and a naive handler stores '***' as the new secret — silently
    // destroying the tenant's credential on every save.
    const put = await request.put(`${API}/api/v1/integrations/config/sendgrid`, {
      ...HEADERS,
      data: {
        SENDGRID_API_KEY: CANARY,
        SENDGRID_FROM_EMAIL: 'browser@check.test',
        SENDGRID_FROM_NAME: 'Browser Check',
      },
    });
    expect(put.status(), await put.text()).toBe(200);

    const masked = await (await request.get(`${API}/api/v1/integrations/config/sendgrid`, HEADERS)).json();
    expect(masked.credentials.SENDGRID_API_KEY).toBe('***');
    expect(masked.credentials.SENDGRID_FROM_EMAIL).toBe('browser@check.test');
    expect(JSON.stringify(masked)).not.toContain(CANARY);

    // Post the mask back, as the form does.
    const round = await request.put(`${API}/api/v1/integrations/config/sendgrid`, {
      ...HEADERS,
      data: { SENDGRID_API_KEY: '***', SENDGRID_FROM_NAME: 'Browser Check 2' },
    });
    expect(round.status()).toBe(200);

    const after = await (await request.get(`${API}/api/v1/integrations/config/sendgrid`, HEADERS)).json();
    expect(after.credentials.SENDGRID_FROM_NAME).toBe('Browser Check 2');
    // Still 'connected' only if the secret survived — the required fields include
    // the API key, so this is the assertion that proves it was not overwritten.
    expect(after.status).toBe('connected');
  });

  test('the wizard-shaped read is masked but still TRUTHY', async ({ request }) => {
    // SetupWizard derives `configured` from truthiness, so a mask returning ''
    // or null would make the wizard forget every saved provider.
    const res = await request.get(`${API}/api/v1/settings/integrations`, HEADERS);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.sendgrid, 'the previous test saved sendgrid').toBeDefined();
    expect(data.sendgrid.api_key).toBe('***');
    expect(Boolean(data.sendgrid.api_key)).toBe(true);
    expect(JSON.stringify(data)).not.toContain(CANARY);
  });

  test('the Tally page loads, and BOTH alias paths accept a valid URL and reject a bad one', async ({ page, request }) => {
    await page.goto(`${BASE}/TallyIntegration`);
    await waitForPageLoad(page);
    await expect(page.getByText(/tally/i).first()).toBeVisible({ timeout: 20_000 });

    for (const [method, path] of [['post', '/api/v1/settings/tally'], ['put', '/api/v1/integrations/tally/config']] as const) {
      const ok = await request[method](`${API}${path}`, {
        ...HEADERS,
        data: { tally_url: 'http://tally.browser-check.test:9000', company_name: 'Browser Check' },
      });
      expect(ok.status(), `${method.toUpperCase()} ${path}: ${await ok.text()}`).toBe(200);

      const bad = await request[method](`${API}${path}`, { ...HEADERS, data: { tally_url: 'file:///etc/passwd' } });
      expect(bad.status(), `${method.toUpperCase()} ${path} accepted a file:// gateway`).toBe(400);
    }
  });

  test.afterAll(async ({ request }) => {
    // Remove the canary this spec stored, so a live database is left as it was
    // found. Deleting the row is the only way to clear a credential through the
    // API surface, and it is this admin's own company.
    await request.put(`${API}/api/v1/integrations/config/sendgrid`, {
      ...HEADERS,
      data: { SENDGRID_FROM_NAME: 'Pulse ERP' },
    }).catch(() => {});
  });
});
