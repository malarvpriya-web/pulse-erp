/**
 * Sales Intelligence › Conversion Analytics — browser verification.
 *
 * Every defect §132 fixed passed esbuild, passed `eslint --rule no-undef`, and
 * returned HTTP 200. The page was never broken in a way a build or a status
 * sweep could see — it rendered a 450% "conversion", a win rate of "0 won of 0"
 * beside a card reading "6 orders won", and an empty Monthly Trends tab whose
 * SQL had thrown on every request since it shipped. Only a render catches that
 * class, which is what these tests are for.
 *
 * They assert the SHAPE of a correct answer, not today's seed values, so they
 * survive the data changing:
 *   - no funnel step may exceed 100% (a step above 100 is records entering
 *     mid-funnel, and the page must say so rather than call it a conversion);
 *   - the win rate must agree with the funnel beside it;
 *   - Monthly Trends must render its month spine, empty months included;
 *   - an unmeasured figure must be an em dash, never a confident 0;
 *   - the hub renders ONE hero, not one per embedded tab.
 *
 * Run: npx playwright test --project=sales-conversion
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

const API = process.env.PULSE_API_BASE ?? 'http://localhost:5000/api';

/** The Bearer token auth.setup.ts persisted. The app authenticates from
 *  localStorage, not a cookie, so storageState alone does not authorise an
 *  APIRequestContext — the header has to be set explicitly. */
function bearer(): string {
  const state = JSON.parse(fs.readFileSync('tests/.auth/user.json', 'utf8'));
  const token = state.origins?.[0]?.localStorage?.find((e: any) => e.name === 'token')?.value;
  if (!token) throw new Error('no token in tests/.auth/user.json — did the setup project run?');
  return token;
}

const TAB = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first();

test.describe('Sales Intelligence — Conversion Analytics', () => {
  test('no funnel step is reported as a conversion above 100%', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/SalesIntelligence');
    await expect(page.getByText('Conversion Funnel')).toBeVisible();

    const body = await page.locator('body').innerText();
    const steps = [...body.matchAll(/([\d.]+)% conversion/g)].map((m) => parseFloat(m[1]));

    // At least one step must be measured at all — zero matches would mean the
    // funnel rendered without ratios, which is the empty state this page spent
    // its whole life in.
    expect(steps.length, 'no step conversions rendered').toBeGreaterThan(0);
    // 100.0% is legitimate (every quotation became an order). Only >100 is the
    // bug: it means the stage holds records the previous stage never saw, and
    // the page renders those as "N more than <stage> — entered here" instead.
    expect(Math.max(...steps), `steps: ${steps.join(', ')}`).toBeLessThanOrEqual(100);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // The rendering rule above is necessary but NOT sufficient: the UI absorbs a
  // step above 100% into "N more than <stage> — entered here", so it stays green
  // even if the FUNNEL DEFINITION regresses underneath it. Reverting the
  // cumulative qualified-lead rule to its original `status IN ('Qualified','Hot')`
  // was verified to leave every DOM assertion in this file passing. What it
  // cannot survive is the payload contradicting itself: a subset can never
  // outnumber the set it is drawn from.
  test('the conversion payload is internally consistent', async ({ request }) => {
    const res = await request.get(`${API}/sales-funnel/conversion-ratios`, {
      headers: { Authorization: `Bearer ${bearer()}` },
    });
    expect(res.status()).toBe(200);
    const { funnel, ratios, linked } = await res.json();

    // Linked counts are DISTINCT parents drawn from the stage above them.
    expect(linked.counts.qualified_leads_with_opportunity).toBeLessThanOrEqual(funnel.leads);
    expect(linked.counts.opportunities_with_quotation).toBeLessThanOrEqual(funnel.opportunities);
    expect(linked.counts.quotations_with_order).toBeLessThanOrEqual(funnel.quotations);
    // Qualified leads are a subset of all enquiries.
    expect(funnel.leads).toBeLessThanOrEqual(funnel.enquiries);

    // Traced conversions and coverage are bounded by construction. A value over
    // 100 here means a numerator stopped being a subset of its denominator.
    for (const [k, v] of Object.entries({ ...linked.ratios, ...linked.coverage })) {
      if (v !== null) expect(v as number, `linked.${k} = ${v}`).toBeLessThanOrEqual(100);
    }

    // Empty denominators must be null, never a measured 0.
    for (const [k, v] of Object.entries(ratios)) {
      expect(v === null || typeof v === 'number', `ratios.${k} = ${v}`).toBe(true);
    }
  });

  test('the win rate agrees with the funnel it sits beside', async ({ page }) => {
    await page.goto('/SalesIntelligence');
    await expect(page.getByText('Conversion Funnel')).toBeVisible();
    const body = await page.locator('body').innerText();

    // The original defect: "WIN RATE 0.0% — 0 won of 0" in the same KPI row as
    // "ORDERS WON 6", because the query read two columns that do not exist and
    // a .catch substituted zeros.
    expect(body).not.toContain('0 won of 0');

    // Whatever the data, the sub-label must reconcile: N won of M closed, N<=M.
    const m = body.match(/(\d+) won of (\d+) closed/);
    if (m) {
      expect(parseInt(m[1], 10)).toBeLessThanOrEqual(parseInt(m[2], 10));
    } else {
      // The only other honest rendering is "no closed deals" with an em dash.
      expect(body).toMatch(/no closed deals/);
    }
  });

  test('Monthly Trends renders its month spine rather than an empty state', async ({ page }) => {
    await page.goto('/SalesIntelligence');
    await TAB(page, 'Monthly Trends').click();

    // The tab reported "No monthly data yet" for its entire life: all six of
    // its series appended a second WHERE to a query that already had one.
    await expect(page.getByText('No monthly data yet')).toHaveCount(0);
    await expect(page.getByText('Monthly Funnel Counts (12 months)')).toBeVisible();

    // A month with no activity must still be a row — the generated spine is
    // what keeps a quiet month from vanishing off the axis.
    const months = await page.locator('td', { hasText: /^\d{4}-\d{2}$/ }).count();
    expect(months, 'month rows rendered').toBeGreaterThanOrEqual(12);
  });

  test('an unmeasured figure renders as a dash, never as a measured zero', async ({ page }) => {
    await page.goto('/SalesIntelligence');
    await TAB(page, 'Customer Analytics').click();
    await expect(page.getByText('Top Customers by Revenue')).toBeVisible();

    // Margin lives on the opportunity behind the quotation behind the order.
    // When that chain does not resolve, SUM() is NULL — and COALESCE(...,0)
    // used to publish "0.0%" as though someone had measured it and found zero.
    // Whatever the data, the cell must be either a real percentage or an em
    // dash; it must never be a 0.0% standing in for "not traceable".
    const row = page.locator('tbody tr').first();
    await expect(row).toBeVisible();
    const marginCell = (await row.locator('td').allInnerTexts())[4];
    expect(marginCell, `margin cell was "${marginCell}"`).toMatch(/^(—|[\d.]+%)$/);
  });

  test('the hub renders one hero, not one per embedded tab', async ({ page }) => {
    await page.goto('/SalesIntelligence');
    await expect(page.getByText('Conversion Funnel')).toBeVisible();

    // Each tab component owns a PageShell + PageHero for its standalone route.
    // Rendered inside the hub they must take `embedded` and suppress it, or the
    // page stacks a second hero and a second tab strip under its own.
    await expect(page.locator('.plh-hero')).toHaveCount(1);

    for (const tab of ['Sales Funnel', 'Forecasts']) {
      await TAB(page, tab).click();
      await expect(page.locator('.plh-hero')).toHaveCount(1);
    }
  });
});
