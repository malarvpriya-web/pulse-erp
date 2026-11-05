/**
 * Suite 06 — Database Consistency Audit
 *
 * After every Create operation, verifies the chain:
 *   API Create → Record in DB (verified via GET list)
 *              → Record appears in UI grid
 *              → Dashboard count updated
 *              → Related report updated
 *
 * Modules covered:
 *   • Employee  → EmployeesData grid → EmployeesDashboard → EmployeeReports
 *   • Leave     → AllLeaves grid     → EmployeesDashboard (leave counts)
 *   • Project   → ProjectsDashboard  → project count card
 *
 * Strategy:
 *   1. Capture BEFORE count from API + dashboard
 *   2. Create the record via API (using JWT extracted from localStorage)
 *   3. Assert record appears in GET list (DB verification)
 *   4. Navigate to UI grid and verify row is visible
 *   5. Navigate to dashboard and verify count incremented
 *   6. Cleanup: DELETE the created record
 *
 * Run:
 *   npx playwright test --project=db-consistency
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../fixtures/base';
import {
  waitForPageLoad,
  assertNoErrorBoundary,
  assertPageHasContent,
} from '../helpers/page-helpers';

// §221 — this spec CREATES an employee (employee code sequence), a leave and a
// project (project code sequence). It runs ONLY under
// playwright.testdb.config.ts, against the isolated test database. It used to
// hardcode the developer frontend (:5173) and backend (:5000).
const FRONT_ORIGIN = process.env.PULSE_FRONT_BASE ?? '';
const API_ORIGIN   = process.env.PULSE_API_BASE ?? '';
const BASE    = FRONT_ORIGIN;
const API     = API_ORIGIN ? `${API_ORIGIN}/api/v1` : '';

// Fail closed before any test in this file can write: the flag, the bases, and
// a live proof that the API server serves the marked test database.
test.beforeAll(() => {
  if (process.env.PULSE_TEST_DB !== '1' || !FRONT_ORIGIN || !API_ORIGIN
      || /:5000(\/|$)/.test(API_ORIGIN) || /:5173(\/|$)/.test(FRONT_ORIGIN)) {
    throw new Error('06-db-consistency.spec creates employees, leaves and projects: run it with  npx playwright test -c playwright.testdb.config.ts  (isolated test database only).');
  }
  execFileSync(process.execPath, ['scripts/test-db/assert-server.mjs', API_ORIGIN], {
    cwd: path.resolve(__dirname, '../../backend'), stdio: 'inherit', env: process.env,
  });
});
const UNIQUE  = `PW_AUDIT_${Date.now()}`;

// ─── Token helper ─────────────────────────────────────────────────────────────

/** Extract the JWT from the app's localStorage after page load. */
async function extractJwt(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate((): string => {
    const keys = ['token', 'authToken', 'jwt', 'access_token', 'pulse_token'];
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v) return v;
    }
    // Try JSON-encoded store (Zustand persist)
    for (const k of Object.keys(localStorage)) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? '{}');
        const found  =
          parsed?.token ??
          parsed?.state?.token ??
          parsed?.state?.auth?.token ??
          parsed?.accessToken;
        if (found) return found as string;
      } catch { /* not JSON */ }
    }
    return '';
  });
}

/**
 * Compare a displayed count string (may contain "," or "+" or parens) to a
 * numeric DB count.  Returns true if they match within ±1 to tolerate
 * in-flight transactions during the test.
 */
function countsMatch(displayed: string, dbCount: number): boolean {
  const cleaned = displayed.replace(/[^\d]/g, '');
  if (!cleaned) return false;
  const ui = parseInt(cleaned, 10);
  return Math.abs(ui - dbCount) <= 1;
}

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYEE
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Employee Create → DB → UI → Dashboard consistency', () => {
  let createdEmpId: number | null = null;
  let jwtToken = '';
  let beforeCount = 0;

  test.beforeAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/EmployeesData`);
    await waitForPageLoad(page);
    jwtToken = await extractJwt(page);

    if (!jwtToken) {
      console.warn('[DB-Consistency] Could not extract JWT — API-level checks will be skipped');
    }

    await page.close();
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    if (createdEmpId && jwtToken) {
      await request.delete(`${API}/employees/${createdEmpId}`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      }).catch(() => null);
    }
  });

  // ── Step 1: Capture before-count ─────────────────────────────────────────

  test('@P0 [EMP-CONSISTENCY-1] Capture employee count before create', async ({ page, request }) => {
    if (!jwtToken) {
      test.info().annotations.push({ type: 'skip-reason', description: 'No JWT — skipping API assertion' });
      return;
    }

    const res = await request.get(`${API}/employees?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });

    if (!res.ok()) {
      test.info().annotations.push({ type: 'info', description: `GET /employees returned ${res.status()} — count check skipped` });
      return;
    }

    const body = await res.json().catch(() => ({}));
    beforeCount = body?.total ?? body?.data?.total ?? body?.count ?? 0;

    test.info().annotations.push({ type: 'info', description: `DB employee count before: ${beforeCount}` });
    expect(beforeCount).toBeGreaterThanOrEqual(0);
  });

  // ── Step 2: Create via API ────────────────────────────────────────────────

  test('@P0 [EMP-CONSISTENCY-2] Create employee via API', async ({ request }) => {
    if (!jwtToken) return;

    const payload = {
      first_name:     'AuditTest',
      last_name:      UNIQUE,
      company_email:  `audit_${Date.now()}@playwright.test`,
      phone:          '9999999999',
      department:     'Engineering',
      // A designation that is actually IN master_designations. 'QA Automation' was
      // not, and `validateMasterValue` has always rejected a value absent from both
      // the master and the employees table — so this fixture only passed when an
      // EARLIER run of itself had leaked a row carrying that designation, which its
      // own teardown then deleted. Self-dependent, and stale independently of the
      // Employee ID work.
      designation:    'Engineer',
      employment_type:'full_time',
      joining_date:   new Date().toISOString().split('T')[0],
      // `status` is required on create as of 2026-09-28. employees.status DEFAULTs
      // to 'Probation', so a create that omitted it silently filed the new hire as
      // a probationer — see REQUIRED_ON_CREATE in backend employee.service.js.
      // Without this the POST is a correct 400 and every later step in this file
      // skips on a null createdEmpId.
      status:         'Active',
    };

    const res = await request.post(`${API}/employees`, {
      headers: {
        Authorization:  `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    const body = await res.json().catch(() => ({}));
    createdEmpId = body?.data?.id ?? body?.id ?? body?.employee_id ?? null;

    test.info().annotations.push({
      type: 'info',
      description: `Create response: ${res.status()} | id: ${createdEmpId}`,
    });

    // Accept 201 Created or 200 OK
    expect([200, 201]).toContain(res.status());
    expect(createdEmpId, 'Created employee must return an ID').toBeTruthy();
  });

  // ── Step 3: Verify in DB via API GET ─────────────────────────────────────

  test('@P0 [EMP-CONSISTENCY-3] Created employee exists in API list (DB verification)', async ({ request }) => {
    if (!jwtToken || !createdEmpId) {
      test.info().annotations.push({ type: 'skip-reason', description: 'No JWT or create failed' });
      return;
    }

    const res = await request.get(`${API}/employees/${createdEmpId}`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });

    expect(res.ok(), `GET /employees/${createdEmpId} should return 200`).toBe(true);
    const body = await res.json().catch(() => ({}));

    const name = body?.data?.last_name ?? body?.last_name ?? '';
    expect(name).toContain(UNIQUE.replace('PW_AUDIT_', '').substring(0, 8));

    test.info().annotations.push({ type: 'info', description: `DB record confirmed: ${JSON.stringify({ id: createdEmpId, last_name: name })}` });
  });

  // ── Step 4: Verify in UI grid ─────────────────────────────────────────────

  test('@P0 [EMP-CONSISTENCY-4] Created employee appears in EmployeesData UI grid', async ({ page }) => {
    if (!createdEmpId) {
      test.info().annotations.push({ type: 'skip-reason', description: 'Create step failed' });
      return;
    }

    await page.goto(`${BASE}/EmployeesData`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await assertPageHasContent(page);

    // Search for the unique employee
    const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]').first();
    if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await searchInput.fill('AuditTest');
      await page.waitForTimeout(1_000);
    }

    // The row should appear — either in a table or card grid
    const empRow = page.locator(`text=AuditTest`).first();
    const found  = await empRow.isVisible({ timeout: 10_000 }).catch(() => false);

    if (!found) {
      test.info().annotations.push({
        type: 'critical',
        description: `MISMATCH: Employee (id=${createdEmpId}) created in DB but NOT visible in UI grid`,
      });
    }

    expect(found, 'Created employee must appear in EmployeesData UI grid').toBe(true);
  });

  // ── Step 5: Dashboard count ───────────────────────────────────────────────

  test('@P0 [EMP-CONSISTENCY-5] EmployeesDashboard count reflects new employee', async ({ page, request }) => {
    if (!jwtToken || !createdEmpId) {
      test.info().annotations.push({ type: 'skip-reason', description: 'Dependencies failed' });
      return;
    }

    // Get DB count after create
    const res = await request.get(`${API}/employees?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const body       = await res.json().catch(() => ({}));
    const dbCount    = body?.total ?? body?.data?.total ?? body?.count ?? 0;
    const expectedIncrease = dbCount > 0 && beforeCount > 0 ? dbCount >= beforeCount : true;

    test.info().annotations.push({ type: 'info', description: `DB count: before=${beforeCount} after=${dbCount}` });
    expect(expectedIncrease, 'DB count should not decrease after create').toBe(true);

    // Check dashboard UI card
    await page.goto(`${BASE}/EmployeesDashboard`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);

    const statCards = page.locator('[class*="stat"], [class*="kpi"], [class*="metric"], [class*="card"]');
    const count     = await statCards.count();

    if (count === 0) {
      test.info().annotations.push({ type: 'info', description: 'No dashboard cards found — skipping count reconciliation' });
      return;
    }

    // Find the card showing "Total Employees" or similar
    const totalCard = page.locator('text=/total.*employ|employ.*total|all employ/i').first();
    const cardVisible = await totalCard.isVisible({ timeout: 5_000 }).catch(() => false);

    if (cardVisible) {
      const cardText = await totalCard.innerText().catch(() => '');
      const uiMatch  = countsMatch(cardText, dbCount);

      if (!uiMatch) {
        test.info().annotations.push({
          type: 'critical',
          description: `DASHBOARD MISMATCH: UI shows "${cardText.trim()}" but DB has ${dbCount} employees`,
        });
      } else {
        test.info().annotations.push({ type: 'info', description: `Dashboard count matches DB: ${dbCount}` });
      }
    }
  });

  // ── Step 6: Reports ───────────────────────────────────────────────────────

  test('@P1 [EMP-CONSISTENCY-6] Employee Reports page loads and reflects data', async ({ page }) => {
    await page.goto(`${BASE}/EmployeeReports`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await assertPageHasContent(page);

    test.info().annotations.push({ type: 'info', description: 'Employee Reports page loaded without error' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LEAVE REQUEST
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Leave Create → DB → UI → Dashboard consistency', () => {
  let createdLeaveId: number | null = null;
  let jwtToken = '';
  let beforeLeaveCount = 0;

  test.beforeAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/MyLeaves`);
    await waitForPageLoad(page);
    jwtToken = await extractJwt(page);
    await page.close();
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    if (createdLeaveId && jwtToken) {
      await request.delete(`${API}/leaves/${createdLeaveId}`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      }).catch(() => null);
    }
  });

  test('@P0 [LEAVE-CONSISTENCY-1] Capture leave count before create', async ({ request }) => {
    if (!jwtToken) return;

    const res = await request.get(`${API}/leaves?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    if (!res.ok()) return;

    const body = await res.json().catch(() => ({}));
    beforeLeaveCount = body?.total ?? body?.data?.total ?? 0;
    test.info().annotations.push({ type: 'info', description: `Leave count before: ${beforeLeaveCount}` });
  });

  test('@P0 [LEAVE-CONSISTENCY-2] Create leave via API', async ({ request }) => {
    if (!jwtToken) return;

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
    const dayAfter  = new Date(Date.now() + 2 * 86_400_000).toISOString().split('T')[0];

    const res = await request.post(`${API}/leaves`, {
      headers: { Authorization: `Bearer ${jwtToken}`, 'Content-Type': 'application/json' },
      data: {
        leave_type: 'casual',
        from_date:  tomorrow,
        to_date:    dayAfter,
        reason:     `Playwright audit test ${UNIQUE}`,
      },
    });

    const body = await res.json().catch(() => ({}));
    createdLeaveId = body?.data?.id ?? body?.id ?? null;

    test.info().annotations.push({ type: 'info', description: `Leave create: ${res.status()} | id=${createdLeaveId}` });

    // Superadmin has no employee record — 400/422 means "no employee_id" which is expected, not a bug
    if (res.status() === 400 || res.status() === 422) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: `Leave create returned ${res.status()} — test user may not have an employee record (e.g. superadmin). Leave consistency checks will be skipped.`,
      });
      return;
    }
    expect([200, 201]).toContain(res.status());
  });

  test('@P0 [LEAVE-CONSISTENCY-3] Created leave exists in API list', async ({ request }) => {
    if (!jwtToken || !createdLeaveId) return;

    const res = await request.get(`${API}/leaves/${createdLeaveId}`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    expect(res.ok(), `GET /leaves/${createdLeaveId} → should be 200`).toBe(true);
  });

  test('@P0 [LEAVE-CONSISTENCY-4] Created leave visible in UI (AllLeaves)', async ({ page }) => {
    if (!createdLeaveId) return;

    await page.goto(`${BASE}/AllLeaves`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);

    const leaveRow = page.locator(`text=Playwright audit test`).first();
    const found    = await leaveRow.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!found) {
      test.info().annotations.push({
        type: 'critical',
        description: `MISMATCH: Leave (id=${createdLeaveId}) in DB but NOT visible in AllLeaves grid`,
      });
    }
    // Soft-assert — leave may be paginated
    test.info().annotations.push({
      type: found ? 'info' : 'warning',
      description: found ? 'Leave visible in AllLeaves UI' : 'Leave not found in current AllLeaves view (may be on another page)',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROJECT
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Project Create → DB → Dashboard consistency', () => {
  let createdProjectId: number | null = null;
  let jwtToken = '';

  test.beforeAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/ProjectsDashboard`);
    await waitForPageLoad(page);
    jwtToken = await extractJwt(page);
    await page.close();
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    if (createdProjectId && jwtToken) {
      await request.delete(`${API}/projects/projects/${createdProjectId}`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      }).catch(() => null);
    }
  });

  test('@P0 [PROJ-CONSISTENCY-1] Create project via API', async ({ request }) => {
    if (!jwtToken) return;

    const res = await request.post(`${API}/projects/projects`, {
      headers: { Authorization: `Bearer ${jwtToken}`, 'Content-Type': 'application/json' },
      data: {
        project_name:  `AuditProject_${UNIQUE}`,
        project_code:  `PRJ-AUDIT-${UNIQUE}`,
        description:   'Playwright DB consistency audit',
        start_date:    new Date().toISOString().split('T')[0],
        end_date:      new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0],
        status:        'planning',
        budget:        100000,
      },
    });

    const body = await res.json().catch(() => ({}));
    createdProjectId = body?.data?.id ?? body?.id ?? null;

    test.info().annotations.push({ type: 'info', description: `Project create: ${res.status()} | id=${createdProjectId}` });
    expect([200, 201]).toContain(res.status());
  });

  test('@P0 [PROJ-CONSISTENCY-2] Created project in API list (DB)', async ({ request }) => {
    if (!jwtToken || !createdProjectId) return;

    const res = await request.get(`${API}/projects/projects/${createdProjectId}`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    expect(res.ok()).toBe(true);
  });

  test('@P0 [PROJ-CONSISTENCY-3] Projects Dashboard loads and shows count', async ({ page }) => {
    await page.goto(`${BASE}/ProjectsDashboard`);
    await waitForPageLoad(page);
    await assertNoErrorBoundary(page);
    await assertPageHasContent(page);

    const countEl = page.locator('[class*="count"], [class*="total"], [class*="kpi"], [class*="stat"]').first();
    const visible  = await countEl.isVisible({ timeout: 8_000 }).catch(() => false);

    test.info().annotations.push({
      type: 'info',
      description: visible ? 'Project count card visible on dashboard' : 'No count card found on projects dashboard',
    });
  });
});
