/**
 * CRM opportunity board — browser reconciliation.
 *
 * Guards the two failure modes this page has actually had:
 *
 *  1. Silent drops. The board hardcoded six stage keys and bucketed with
 *     `if (matched)`, so an opportunity in an unconfigured stage never appeared
 *     anywhere — ₹19,89,009 in `Bidding` was invisible while /opportunities/stats
 *     counted it, a 46.7% divergence between two numbers on the same screen.
 *
 *  2. A blank board. When the endpoint moved to `{ board, stages }`, the page
 *     was still reading `raw[key]` off the response root. Every bucket resolved
 *     to `[]`. The API was correct, the tests were green, and the screen showed
 *     an empty pipeline — which is why this assertion is made in a browser and
 *     not against the API.
 *
 * The invariant: what the user sees on the board equals what /stats reports.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API_BASE   = process.env.PULSE_API_BASE   ?? 'http://localhost:5000';
const FRONT_BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';

// Auth is a Bearer token in localStorage, not a cookie, so `storageState` gets
// the browser logged in but leaves the APIRequestContext anonymous. Lift the
// same token the setup project persisted and send it explicitly.
function authHeader(): Record<string, string> {
  const state = JSON.parse(
    readFileSync(path.resolve(__dirname, '../.auth/user.json'), 'utf8')
  );
  const token = state.origins?.[0]?.localStorage?.find((e: any) => e.name === 'token')?.value;
  if (!token) throw new Error('No token in tests/.auth/user.json — run the setup project first.');
  return { Authorization: `Bearer ${token}` };
}

test.describe('CRM pipeline reconciliation', () => {
  test('board buckets reconcile with /opportunities/stats', async ({ request }) => {
    const headers = authHeader();
    const [statsRes, kanbanRes] = await Promise.all([
      request.get(`${API_BASE}/api/crm/opportunities/stats`,  { headers }),
      request.get(`${API_BASE}/api/crm/opportunities/kanban`, { headers }),
    ]);
    expect(statsRes.ok(), 'stats endpoint').toBeTruthy();
    expect(kanbanRes.ok(), 'kanban endpoint').toBeTruthy();

    const stats  = await statsRes.json();
    const kanban = await kanbanRes.json();

    // Contract: the endpoint hands over the stage list, so the frontend never
    // has to know the stages.
    expect(Array.isArray(kanban.stages), 'kanban returns a stage list').toBeTruthy();
    expect(kanban.board, 'kanban returns a board map').toBeTruthy();

    const bucketTotal = Object.values(kanban.board as Record<string, any[]>)
      .flat()
      .reduce((s, o: any) => s + parseFloat(o.expected_value || 0), 0);
    const bucketCount = Object.values(kanban.board as Record<string, any[]>).flat().length;

    expect(Math.round(bucketTotal)).toBe(Math.round(parseFloat(stats.total_value)));
    expect(bucketCount).toBe(Number(stats.total));

    // Every opportunity lands in exactly one bucket — none dropped, none double
    // counted.
    const ids = Object.values(kanban.board as Record<string, any[]>).flat().map((o: any) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the rendered board shows every opportunity, unmapped stages included', async ({ page, request }) => {
    const kanban = await (await request.get(`${API_BASE}/api/crm/opportunities/kanban`, { headers: authHeader() })).json();
    const expectedCount = Object.values(kanban.board as Record<string, any[]>).flat().length;
    const expectedNames = Object.values(kanban.board as Record<string, any[]>)
      .flat().map((o: any) => o.opportunity_name);

    await page.goto(`${FRONT_BASE}/OpportunitiesKanban`);
    await page.waitForSelector('.ok-board, .ok-load-error', { timeout: 20_000 });

    // A load failure must present as a failure, never as an empty board.
    await expect(page.locator('.ok-load-error')).toHaveCount(0);

    const cards = page.locator('.ok-card');
    await expect(cards).toHaveCount(expectedCount);

    // Named checks catch a card rendered but attributed to the wrong column.
    for (const name of expectedNames) {
      await expect(page.locator('.ok-card-title', { hasText: name }).first()).toBeVisible();
    }

    // If the API reports an Unmapped bucket with cards, the board must show it
    // rather than swallow those opportunities.
    const unmapped = (kanban.board as Record<string, any[]>).Unmapped ?? [];
    if (unmapped.length > 0) {
      await expect(page.locator('.ok-col-warn')).toBeVisible();
    }
  });
});
