import { test as setup, expect, request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const AUTH_FILE  = 'tests/.auth/user.json';
// Overridable so the suite can be pointed at a staging build, or at a second
// backend/frontend pair started from a working tree, without editing this file.
// Defaults are the documented dev ports, so nothing changes for a normal run.
const API_BASE   = process.env.PULSE_API_BASE   ?? 'http://localhost:5000';
const FRONT_BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';
// The suite lives inside the repo now, so backend/ is a sibling of tests/.
const BACKEND_DIR = path.resolve(__dirname, '../backend');

// Wait until the backend health endpoint returns {db: {status: "ok"}} — the DB
// pool settling after cold start, same gate as before.
async function waitForBackendReady(maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const ctx = await request.newContext();
      const res = await ctx.get(`${API_BASE}/api/health`, { timeout: 4_000 });
      await ctx.dispose();
      if (res.ok()) {
        const body = await res.json().catch(() => ({}));
        if (body?.db?.status === 'ok') return;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1_500));
  }
}

/**
 * Authenticate by MINTING a token, not by driving the login form.
 *
 * The form-login path used `superadmin@pulse.com` / `Pulse@123`, an account
 * deactivated 2026-07-08 — so it silently stopped working and took the whole
 * e2e suite down with it (every project depends on this setup's storageState).
 *
 * `Pulse/backend/scripts/e2e-mint-token.mjs` issues the exact token the login
 * route would, reusing the backend's own db pool + JWT_SECRET, so there is no
 * password to keep in sync and no deactivated account to depend on. We seed the
 * six localStorage keys AuthContext restores from, then persist storageState.
 *
 * Override the account with E2E_LOGIN_EMAIL if a specific role is needed.
 */
setup('authenticate via minted token', async ({ page }) => {
  // The global 45s budget is sized for a test, not for a first navigation against
  // a Vite DEV server, which compiles the module graph for a 445-page app on
  // demand. That cold compile alone can outlast the budget, and the failure
  // surfaces as "Tearing down context exceeded the test timeout" with a page
  // snapshot showing the app rendered perfectly — which reads as flakiness.
  // Every suite depends on this one step, so it gets its own budget.
  setup.setTimeout(180_000);
  await waitForBackendReady(30_000);

  // Mint in the backend's own context (its .env, its db.js). execFileSync throws
  // on non-zero exit, surfacing "user inactive" / "JWT_SECRET missing" as a
  // failed setup rather than a mysteriously empty session.
  const raw = execFileSync('node', ['scripts/e2e-mint-token.mjs'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env },
  });
  // db.js's dotenv banner shares stdout, so take only the fenced payload.
  const fenced = raw.match(/---E2E_AUTH_BEGIN---\s*([\s\S]*?)\s*---E2E_AUTH_END---/);
  expect(fenced, `mint script produced no auth payload:\n${raw}`).toBeTruthy();
  const auth = JSON.parse(fenced![1].trim());
  expect(auth.token, 'mint script returned no token').toBeTruthy();

  // Seed exactly what AuthContext reads on boot (context/AuthContext.jsx). Runs
  // before app code on every navigation. Missing any key silently degrades the
  // UI — empty `permissions` in particular makes menus vanish.
  await page.addInitScript((a) => {
    localStorage.setItem('token', a.token);
    localStorage.setItem('user', JSON.stringify(a.user));
    localStorage.setItem('role', a.role);
    localStorage.setItem('roles', JSON.stringify(a.roles));
    localStorage.setItem('permissions', JSON.stringify([]));
    localStorage.setItem('menuOverrides', JSON.stringify({}));
  }, auth);

  await page.goto(`${FRONT_BASE}/`, { waitUntil: 'domcontentloaded' });

  // NOT networkidle. The frontend under test is a Vite dev server, which holds an
  // HMR websocket open for the life of the page, so 'networkidle' can never be
  // reached and the step simply burns the whole 45s timeout — this setup was
  // failing and then passing on retry for exactly that reason, which reads as
  // flakiness rather than as a wrong wait condition.
  //
  // The assertion below is the real readiness signal and always was: the sidebar
  // renders only once AuthContext has restored a session, so waiting for it
  // proves both that the app booted and that the token was accepted.
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 });
  expect(page.url(), 'redirected to login — token rejected').not.toContain('/login');

  await page.context().storageState({ path: AUTH_FILE });
});
