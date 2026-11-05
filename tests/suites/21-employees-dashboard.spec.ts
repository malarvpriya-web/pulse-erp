/**
 * Suite 21 — Employees ▸ Dashboard, end to end in a real browser.
 *
 * The defects this suite pins down were all invisible to the backend tests
 * because they were about what reaches the SCREEN: a chart drawn from three
 * months of an eight-month window, a KPI card that looked clickable and was
 * not, a "View all" that dropped you on an unfiltered register, a tenure axis
 * rendering double-encoded mojibake, and a page that needed 2.5 screens before
 * HR could see the alerts.
 *
 * Assertions are invariants against whatever the API returns, not golden
 * numbers, so they survive the seed data changing.
 */

import { test, expect, Page, Locator } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';

type Analytics = {
  period: { key: string; label: string; from: string; to: string; isAll: boolean };
  summary: Record<string, number>;
  statusBreakdown: { status: string; count: number }[];
  deptBreakdown: { department: string; count: number }[];
  genderBreakdown: { gender: string; count: number }[];
  skillBreakdown: { skill: string; count: number }[];
  tenureGroups: { bucket: string; count: number }[];
  hiringTrend: { monthKey: string; month: string; hires: number; exits: number }[];
  dataQuality: Record<string, number>;
};

/** Open the dashboard and hand back the analytics payload it rendered from. */
async function openDashboard(page: Page): Promise<Analytics> {
  const waitAnalytics = page.waitForResponse(
    r => r.url().includes('/employees/analytics') && r.status() === 200,
    { timeout: 25_000 },
  );
  await page.goto(`${BASE}/EmployeesDashboard`);
  const res = await waitAnalytics;
  await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
  await expect(page.locator('.empdash-kpis')).toBeVisible({ timeout: 15_000 });
  return res.json();
}

/** Change the period select and wait for the refetch it triggers. */
async function setPeriod(page: Page, value: string): Promise<Analytics> {
  const waitAnalytics = page.waitForResponse(
    r => r.url().includes('/employees/analytics') && r.status() === 200,
    { timeout: 25_000 },
  );
  await page.locator('.pl-filterbar select').first().selectOption(value);
  const res = await waitAnalytics;
  await page.waitForTimeout(400); // let recharts commit the new series
  return res.json();
}

const sum = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);

/**
 * A KPI tile by its LABEL line.
 *
 * ⚠ Not `locator('.empdash-kpi', { hasText: label })`: hasText is a
 * case-insensitive substring match over the whole tile, so 'Active' also
 * matched the Total Employees tile through its "30 active · 2 probation"
 * subtitle and .first() then returned the wrong card.
 */
function action(page: Page, label: string) {
  return page.locator('.empdash-action').filter({
    has: page.locator('.empdash-action-label', { hasText: new RegExp(`^${label}$`) }),
  });
}

function kpi(page: Page, label: string) {
  return page.locator('.empdash-kpi').filter({
    has: page.locator('.empdash-kpi-label', { hasText: new RegExp(`^${label}$`) }),
  });
}

test.describe('Employees Dashboard', () => {
  test('@P0 loads, and every breakdown reconciles to Total Employees on screen', async ({ page }) => {
    const a = await openDashboard(page);

    expect(sum(a.statusBreakdown)).toBe(a.summary.total);
    expect(sum(a.deptBreakdown)).toBe(a.summary.total);
    expect(sum(a.genderBreakdown)).toBe(a.summary.total);
    expect(sum(a.skillBreakdown)).toBe(a.summary.total);
    expect(sum(a.tenureGroups)).toBe(a.summary.total);

    // …and the number the user actually reads matches the payload.
    await expect(kpi(page, 'Current Headcount')).toContainText(String(a.summary.total));
    await expect(kpi(page, 'Active')).toContainText(String(a.summary.active));
    await expect(kpi(page, 'On Probation')).toContainText(String(a.summary.probation));

    // The donut's centre label is the same total, not a second opinion.
    const donut = page.locator('.empdash-card', { hasText: 'Employment Status' });
    await expect(donut.locator('text').filter({ hasText: new RegExp(`^${a.summary.total}$`) }).first())
      .toBeVisible();
  });

  test('@P0 the period filter offers All Time and moves activity without moving headcount', async ({ page }) => {
    const fytd = await openDashboard(page);

    const periodSelect = page.locator('.pl-filterbar select').first();
    const options = await periodSelect.locator('option').allTextContents();
    expect(options).toContain('All Time');
    expect(options).toContain('This FY');
    expect(options).toContain('Custom…');

    const all = await setPeriod(page, 'all');

    // Activity follows the period…
    expect(all.period.isAll).toBe(true);
    expect(all.summary.newHires).toBeGreaterThanOrEqual(fytd.summary.newHires);

    // …population does not. This is the guarantee the split exists for.
    expect(all.summary.total).toBe(fytd.summary.total);
    expect(all.deptBreakdown).toEqual(fytd.deptBreakdown);
    await expect(kpi(page, 'Current Headcount')).toContainText(String(fytd.summary.total));

    // And the caption says which is which, so the distinction is on screen.
    await expect(page.locator('.empdash-caption')).toContainText('as of today');
    await expect(page.locator('.empdash-caption')).toContainText('All time');
  });

  test('@P0 Hiring vs Attrition covers the whole selected period, with no hardcoded months', async ({ page }) => {
    const a = await openDashboard(page);

    // One point per month between the resolved bounds — the defect was a chart
    // that drew only the months containing a hire, so an eight-month window
    // rendered as a three-month stub.
    const months = a.hiringTrend.map(m => m.monthKey);
    expect(months[0]).toBe(a.period.from.slice(0, 7));
    expect(months[months.length - 1]).toBe(a.period.to.slice(0, 7));
    for (let i = 1; i < months.length; i += 1) {
      const [py, pm] = months[i - 1].split('-').map(Number);
      const [cy, cm] = months[i].split('-').map(Number);
      expect(cy * 12 + cm).toBe(py * 12 + pm + 1);
    }

    // Every one of those months is a tick on the rendered axis, including the
    // empty ones.
    const card = page.locator('.empdash-card', { hasText: 'Hiring vs Attrition' });
    const axis = await card.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value').allTextContents();
    for (const m of a.hiringTrend.map(x => x.month)) {
      expect(axis.join('|')).toContain(m);
    }

    // Widening to All Time must widen the axis, not redraw the same stub.
    const all = await setPeriod(page, 'all');
    expect(all.hiringTrend.length).toBeGreaterThanOrEqual(a.hiringTrend.length);
  });

  test('@P0 charts print their values, so nothing needs a hover to read', async ({ page }) => {
    const a = await openDashboard(page);

    // ⚠ Every assertion here polls. recharts plays an entry animation and the
    // <LabelList> text lands only once it finishes, so a single read a few
    // hundred ms after load sees an empty chart and the test fails on timing
    // rather than on the thing it is checking.
    const texts = async (loc: Locator) =>
      (await loc.allTextContents()).map(t => t.trim()).filter(Boolean);

    // Department: one headcount per row, in the right-hand value axis. Every
    // department must carry a number — a <LabelList> on the stack silently
    // rendered NONE, because recharts emits a rect only for non-zero values
    // and the last series was zero for every department.
    const deptCard = page.locator('.empdash-card', { hasText: 'Department Headcount' });
    // Two category axes: names on the left, "count · percent" on the right.
    // Every visible row must carry a value — and the two axes must be the
    // same length, which is what catches a row rendering without its number.
    const deptAxes = async () => {
      const groups = deptCard.locator('.recharts-yAxis-tick-labels');
      return {
        names:  await texts(groups.nth(0).locator('.recharts-cartesian-axis-tick-value')),
        values: await texts(groups.nth(1).locator('.recharts-cartesian-axis-tick-value')),
      };
    };
    await expect.poll(
      async () => {
        const { names, values } = await deptAxes();
        return names.length > 0 && names.length === values.length
          && values.every(v => /^\d+ · [\d.]+%$/.test(v));
      },
      { timeout: 15_000, message: 'every department row carries "count · percent"' },
    ).toBe(true);
    // The widest department's own figures are among them.
    const biggest = a.deptBreakdown[0];
    const biggestPct = (() => {
      const v = Math.round((biggest.count / a.summary.total) * 1000) / 10;
      return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1);
    })();
    expect((await deptAxes()).values).toContain(`${biggest.count} · ${biggestPct}%`);

    // Tenure: a value above every non-empty bar, and none invented.
    const tenureCard = page.locator('.empdash-card', { hasText: 'Tenure Distribution' });
    // "32·97%" — count AND share, so the bar can be read without a hover.
    const expectedTenure = a.tenureGroups.filter(g => g.count > 0).map(g => {
      const v = Math.round((g.count / a.summary.total) * 1000) / 10;
      return `${g.count}·${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
    });
    await expect.poll(
      () => texts(tenureCard.locator('.recharts-label-list text')).then(t => t.sort()),
      { timeout: 15_000, message: 'tenure bar labels' },
    ).toEqual([...expectedTenure].sort());

    // Trend: the non-zero monthly counts are printed on the marks.
    const trendCard = page.locator('.empdash-card', { hasText: 'Hiring vs Attrition' });
    const expectedTrend = a.hiringTrend.filter(m => m.hires > 0).map(m => String(m.hires));
    if (expectedTrend.length) {
      await expect.poll(
        () => texts(trendCard.locator('.recharts-label-list text')),
        { timeout: 15_000, message: 'hiring trend point labels' },
      ).toEqual(expect.arrayContaining(expectedTrend));
    }

    // Status donut: name + count baked into each slice label.
    // Read the SVG <text> nodes, not innerText — innerText does not descend
    // into SVG, so the labels are invisible to it even though they render.
    const statusCard = page.locator('.empdash-card', { hasText: 'Employment Status' });
    await expect.poll(
      () => texts(statusCard.locator('.recharts-wrapper text')),
      { timeout: 15_000, message: 'donut slice labels' },
    ).toEqual(expect.arrayContaining(
      // "31 (93.9%)" — the status NAME is in the legend, because spelling it
      // onto the slice clipped "Active" to "tive" at the card edge.
      a.statusBreakdown.map(x => `${x.count} (${
        (() => { const v = Math.round((x.count / a.summary.total) * 1000) / 10;
                 return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1); })()
      }%)`),
    ));
    // …and the legend carries the names.
    for (const x of a.statusBreakdown) await expect(statusCard).toContainText(x.status);
  });

  test('@P1 tenure axis labels are readable ASCII, not mojibake', async ({ page }) => {
    await openDashboard(page);
    const card = page.locator('.empdash-card', { hasText: 'Tenure Distribution' });
    const ticks = await card.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value').allTextContents();
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      // The old bucket labels reached the browser as "0<mojibake>1 yr".
      expect(t).not.toMatch(/[ÂÃâ€]/);
      expect(t).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  test('@P0 every KPI card is marked clickable and lands on the right filtered records', async ({ page }) => {
    const a = await openDashboard(page);

    // Affordance: every tile is a real button carrying the drill-through
    // arrow. The headcount tile is the exception ON PURPOSE — its three
    // composition segments are individually clickable, and nesting buttons
    // inside a button is invalid HTML, so it is a container of buttons.
    const tiles = page.locator('.empdash-kpi');
    const n = await tiles.count();
    expect(n).toBe(7);
    for (let i = 0; i < n; i += 1) {
      const tile = tiles.nth(i);
      const isHeadcount = (await tile.getAttribute('class'))?.includes('empdash-kpi--headcount');
      if (isHeadcount) {
        await expect(tile.locator('.empdash-headline')).toHaveCount(1);
        expect(await tile.locator('.empdash-part').count()).toBeGreaterThan(0);
        continue;
      }
      await expect(tile).toHaveClass(/empdash-clickable/);
      await expect(tile.locator('.empdash-go')).toHaveCount(1);
      expect(await tile.evaluate(el => el.tagName)).toBe('BUTTON');
    }

    // On Probation → the probation records, and the destination says so.
    await kpi(page, 'On Probation').click();
    await expect(page.locator('.ed-drill-chip')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ed-drill-chip')).toContainText('Probation');
    const shown = Number((await page.locator('.ed-drill-chip strong').first().innerText()).trim());
    expect(shown).toBe(a.summary.probation);
  });

  test('@P0 New Hires opens the joiners for the SELECTED period, not a fixed 30 days', async ({ page }) => {
    const a = await openDashboard(page);
    test.skip(a.summary.newHires === 0, 'no hires in the default period to drill into');

    await kpi(page, 'New Hires').click();
    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    // The chip names the same window the KPI counted.
    await expect(chip).toContainText(a.period.label);
    const shown = Number((await chip.locator('strong').first().innerText()).trim());

    /*
     * shown + (hired in the window but since left) === the KPI.
     *
     * NOT `shown === newHires`, which is what this asserted and which is false by
     * definition: New Hires counts everyone hired in the period (a hiring metric),
     * while All Employees lists current staff (ex-employees are on Ex-Employees).
     * On live data employee #42 joined 2026-07-28 and has status 'Left', so the
     * card reads 27 and the list holds 26 — both correct.
     *
     * This is a STRONGER assertion than the equality it replaces: it pins the
     * exact relationship between the two populations, so a row going missing for
     * any OTHER reason still fails. The page states the difference in the chip,
     * which is where the number is read from here.
     */
    const note = await chip.innerText();
    const sinceLeft = Number(/(\d+)\s+more\s+(?:has|have)\s+since\s+left/.exec(note)?.[1] ?? 0);
    expect(shown + sinceLeft).toBe(a.summary.newHires);
    if (sinceLeft > 0) {
      // And it must SAY so — an unexplained 26 under a card reading 27 is the
      // defect, not the 26 itself.
      expect(note).toMatch(/since left/i);
    }
  });

  test('@P1 a drill-down can be cleared, and clearing restores the full register', async ({ page }) => {
    const a = await openDashboard(page);
    await kpi(page, 'Active').click();
    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });

    await chip.getByRole('button', { name: /Clear/i }).click();
    await expect(chip).toHaveCount(0);
    // Total Staff on the list page equals Total Employees on the dashboard.
    const totalTile = page.locator('.ed-kpi-card', { hasText: 'Total Staff' });
    await expect(totalTile).toContainText(String(a.summary.total));
  });

  test('@P0 Expiring Docs opens the documents that are actually expiring', async ({ page }) => {
    const docs = page.waitForResponse(r => r.url().includes('/hr-widgets/expiring-documents'), { timeout: 20_000 });
    await openDashboard(page);
    const rows = await (await docs).json();

    const card = action(page, 'Documents');
    // The tile splits into two targets when the badge has its own list, so
    // the affordance lives on the count, not on the whole card.
    await expect(card.locator('.empdash-action-main')).toHaveCount(1);
    // Expiring and expired are two numbers, not one: the tile shows the
    // upcoming count and badges the already-expired ones separately.
    const expired = rows.filter((r: { expiry_state: string }) => r.expiry_state === 'expired').length;
    await expect(card.locator('.empdash-action-main')).toHaveText(String(rows.length - expired));
    if (expired) await expect(card.locator('.empdash-overdue-badge')).toContainText(`${expired} expired`);

    test.skip(rows.length === 0, 'no expiring documents in this dataset');

    await card.locator('.empdash-action-main').click();
    // Lands on the document register with the expiry filter already applied —
    // it used to land on the unfiltered register.
    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    // The COUNT opens the expiring set; the badge beside it owns the already
    // expired ones, so this no longer lands on the combined 'attention' view.
    await expect(page.locator('select').filter({ hasText: 'Expired or expiring' })).toHaveValue('expiring', { timeout: 15_000 });
  });

  test('@P1 Upcoming Exits and Confirmations surface overdue work rather than hiding it', async ({ page }) => {
    const exitsP = page.waitForResponse(r => r.url().includes('/hr-widgets/upcoming-exits'), { timeout: 20_000 });
    const confP  = page.waitForResponse(r => r.url().includes('/hr-widgets/pending-confirmations'), { timeout: 20_000 });
    await openDashboard(page);
    const exits = await (await exitsP).json();
    const confs = await (await confP).json();

    const exitOverdue = exits.filter((e: { exit_state: string }) => e.exit_state === 'overdue').length;
    const exitCard = action(page, 'Exits');
    await expect(exitCard.locator('.empdash-action-main')).toHaveText(String(exits.length - exitOverdue));
    if (exitOverdue) {
      // The whole point: an exit whose last working day has PASSED must stay
      // on screen, in its own badge, not vanish from a forward-looking window.
      await expect(exitCard.locator('.empdash-overdue-badge')).toContainText(`${exitOverdue} overdue`);
    }

    const confCard = action(page, 'Confirmations');
    const confLate = confs.filter((c: { confirmation_state: string }) =>
      c.confirmation_state === 'overdue' || c.confirmation_state === 'undated').length;
    const confDue = confs.length - confLate;
    await expect(confCard.locator('.empdash-action-main')).toHaveText(String(confDue));
    // A probation with no end date recorded must read as "no date set", never
    // as "nothing to do".
    if (confs.some((c: { confirmation_state: string }) => c.confirmation_state === 'undated')) {
      await expect(confCard.locator('.empdash-overdue-badge')).toContainText('no date set');
    }
  });

  test('@P1 clicking a department bar opens that department', async ({ page }) => {
    const a = await openDashboard(page);
    test.skip(a.deptBreakdown.length === 0, 'no departments');

    const target = a.deptBreakdown[0];
    const card = page.locator('.empdash-card', { hasText: 'Department Headcount' });
    // The Active segment of the widest bar.
    await card.locator('.recharts-bar-rectangle').first().click({ force: true });

    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText(target.department);
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(target.count);
  });

  test('@P1 "View all" on Recent New Hires does NOT go to the unfiltered register', async ({ page }) => {
    const a = await openDashboard(page);
    test.skip(a.summary.newHires === 0, 'no hires to drill into');

    const card = page.locator('.empdash-card', { hasText: 'Recent New Hires' });
    await card.getByRole('button', { name: /View all/i }).click();

    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBeLessThan(a.summary.total);

    // Same relationship as the New Hires KPI drill above, for the same reason:
    // New Hires counts everyone hired in the period, the register lists current
    // staff, and anyone hired-then-left is in the first and not the second. The
    // chip states how many, so the two numbers reconcile on screen.
    const note = await chip.innerText();
    const sinceLeft = Number(/(\d+)\s+more\s+(?:has|have)\s+since\s+left/.exec(note)?.[1] ?? 0);
    expect(shown + sinceLeft).toBe(a.summary.newHires);
  });

  test('@P1 On Probation opens the probation list', async ({ page }) => {
    const a = await openDashboard(page);
    // The duplicate "On Probation" list card was removed in the consolidation
    // pass; the KPI is now the single summary AND the way in.
    await kpi(page, 'On Probation').click();

    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('Probation');
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(a.summary.probation);
  });

  test('@P0 KPIs and HR alerts sit above the fold on a 1440x900 desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDashboard(page);

    // The two bands HR reads every morning must need no scroll. Measured
    // against the viewport, not the document: the app scrolls .page-content.
    // Filter bar, KPI band, action strip AND the workforce-movement row all
    // inside the first screen. `.empdash-row` first child is movement+trend.
    const actionsBottom = await page.locator('.empdash-actions').evaluate(
      el => el.getBoundingClientRect().bottom,
    );
    expect(actionsBottom, 'HR action strip must be above the fold').toBeLessThanOrEqual(900);

    const movementBottom = await page.locator('.empdash-row').first().evaluate(
      el => el.getBoundingClientRect().bottom,
    );
    expect(movementBottom, 'workforce movement + trend must be above the fold').toBeLessThanOrEqual(900);

    // The whole page is a dashboard, not a report: under two screens.
    const pageHeight = await page.locator('.page-content').evaluate(
      el => (el as HTMLElement).scrollHeight,
    );
    expect(pageHeight, 'total page height').toBeLessThan(900 * 2);
  });

  test('@P1 the layout re-flows at 1024 wide without a horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openDashboard(page);

    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.page-content') as HTMLElement | null;
      if (!el) return 0;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1); // sub-pixel rounding only

    // Re-flow, not shrink: the KPI band drops to fewer columns and the tiles
    // stay a readable size.
    const tileWidth = await page.locator('.empdash-kpi').first().evaluate(
      el => el.getBoundingClientRect().width,
    );
    expect(tileWidth).toBeGreaterThan(150);
  });

  // ── Final UX pass ─────────────────────────────────────────────────────────

  test('@P0 Upcoming Joinees is confirmed-only and never mixed with hires', async ({ page }) => {
    const joinP = page.waitForResponse(r => r.url().includes('/hr-widgets/upcoming-joinees'), { timeout: 20_000 });
    await openDashboard(page);
    const data = await (await joinP).json();

    const tile = kpi(page, 'Upcoming Joinees');
    await expect(tile).toHaveClass(/empdash-clickable/);
    await expect(tile.locator('.empdash-kpi-value')).toHaveText(String(data.summary.total));
    // Forward-looking, so it says so rather than inheriting the period.
    await expect(tile.locator('.empdash-scope')).toContainText('Next 30 days');

    // An offer that is only SENT is not confirmed and stays out of the total.
    expect(data.pending.every((p: { offer_status: string }) => p.offer_status !== 'accepted')).toBe(true);
    expect(data.summary.total).toBe(
      data.joinees.filter((j: { joinee_state: string }) => j.joinee_state !== 'overdue').length,
    );

    // A joinee has not started, so they appear in no employee list.
    const hiresCard = page.locator('.empdash-card', { hasText: 'Recent New Hires' });
    for (const j of data.joinees) {
      await expect(hiresCard).not.toContainText(String(j.name));
    }
  });

  test('@P0 percentages are shown and reconcile to 100% of the same population', async ({ page }) => {
    const a = await openDashboard(page);
    const t = a.summary.total;
    const share = (n: number, pop: number) => {
      const v = Math.round((n / pop) * 1000) / 10;
      return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
    };
    const texts = async (loc: Locator) =>
      (await loc.allTextContents()).map(x => x.trim()).filter(Boolean);

    // Department: "5 · 15.2%" per row, in the right-hand value axis.
    const deptCard = page.locator('.empdash-card', { hasText: 'Department Headcount' });
    const biggest = a.deptBreakdown[0];
    await expect.poll(
      () => texts(deptCard.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')),
      { timeout: 15_000, message: 'department count and percent' },
    ).toEqual(expect.arrayContaining([`${biggest.count} · ${share(biggest.count, t)}`]));

    // Status, gender and skill each print "n (p%)" on the slice, and each is
    // drawn from the same population as Current Headcount — so they add to 100.
    const pies: [string, { count: number }[]][] = [
      ['Employment Status', a.statusBreakdown],
      ['Gender', a.genderBreakdown],
      ['Skill Type', a.skillBreakdown],
    ];
    for (const [card, rows] of pies) {
      const loc = page.locator('.empdash-card', { hasText: card });
      const pop = rows.reduce((n, r) => n + r.count, 0);
      expect(pop, `${card} population`).toBe(t);
      const wanted = rows.map(r => `${r.count} (${share(r.count, pop)})`);
      await expect.poll(
        () => texts(loc.locator('.recharts-wrapper text')),
        { timeout: 15_000, message: `${card} slice labels` },
      ).toEqual(expect.arrayContaining(wanted));
    }

    // Tenure: "32·97%" above each non-empty bar.
    const tenure = page.locator('.empdash-card', { hasText: 'Tenure Distribution' });
    const wantedTenure = a.tenureGroups.filter(g => g.count > 0)
      .map(g => `${g.count}·${share(g.count, t)}`).sort();
    await expect.poll(
      () => texts(tenure.locator('.recharts-label-list text')).then(x => x.sort()),
      { timeout: 15_000, message: 'tenure bar labels' },
    ).toEqual(wantedTenure);
  });

  test('@P0 Workforce Movement states opening, hires, exits, closing and attrition', async ({ page }) => {
    const a = await openDashboard(page);
    const card = page.locator('.empdash-card', { hasText: 'Workforce Movement' });

    const cell = (label: string) => card.locator('.empdash-mv').filter({
      has: page.locator('.empdash-mv-label', { hasText: new RegExp(`^${label}$`) }),
    }).locator('.empdash-mv-value');

    await expect(cell('Opening')).toHaveText(String(a.summary.headcountStart));
    await expect(cell('Hires')).toHaveText(String(a.summary.newHires));
    await expect(cell('Exits')).toHaveText(String(a.summary.exits));
    await expect(cell('Closing')).toHaveText(String(a.summary.headcountEnd));
    await expect(cell('Attrition')).toHaveText(`${a.summary.attritionRate}%`);
    // Joinees are present but visibly apart from the ledger: not yet staff.
    await expect(cell('Joining')).toBeVisible();
    await expect(card).toContainText('not yet staff');
  });

  test('@P1 every department is represented — Top N plus an explicit Others', async ({ page }) => {
    const a = await openDashboard(page);
    const card = page.locator('.empdash-card', { hasText: 'Department Headcount' });

    const barLabels = async () => (await card
      .locator('.recharts-yAxis-tick-labels').first()
      .locator('.recharts-cartesian-axis-tick-value').allTextContents()).map(x => x.trim());

    const shown = await barLabels();
    if (a.deptBreakdown.length > 9) {
      // Collapsed, never silently truncated: the tail is one labelled bar
      // carrying its own count, and the toggle reveals every row.
      const others = shown.find(l => /^Others \(\d+\)$/.test(l));
      expect(others, 'an explicit Others bar').toBeTruthy();
      const tailCount = Number(/\((\d+)\)/.exec(others as string)![1]);
      expect(shown.length - 1 + tailCount).toBe(a.deptBreakdown.length);

      await card.getByRole('button', { name: new RegExp(`Show all ${a.deptBreakdown.length}`) }).click();
      await expect.poll(barLabels, { timeout: 10_000 }).toHaveLength(a.deptBreakdown.length);
    } else {
      expect(shown.length).toBe(a.deptBreakdown.length);
    }
  });

  test('@P1 average tenure reads in months, on the chart it describes', async ({ page }) => {
    const a = await openDashboard(page);
    // It is an analytical figure, not something HR acts on this morning, so
    // it sits on the Tenure card rather than taking a slot in the KPI row.
    await expect(kpi(page, 'Avg. Tenure')).toHaveCount(0);
    const card = page.locator('.empdash-card', { hasText: 'Tenure Distribution' });
    const months = a.summary.avgTenureMonths;
    if (months && months < 18) {
      await expect(card.locator('.empdash-card-sub')).toContainText(`avg ${months} mo`);
    } else if (a.summary.avgTenure) {
      await expect(card.locator('.empdash-card-sub')).toContainText('avg');
    }
  });

  test('@P0 no metric is shown twice on the page', async ({ page }) => {
    const a = await openDashboard(page);
    // Upcoming Joinees and On Probation each used to appear as a KPI AND as a
    // list card lower down, restating the same count. Summary in the KPI row,
    // detail on the destination page — never both.
    for (const title of ['Upcoming Joinees', 'On Probation']) {
      await expect(
        page.locator('.empdash-card').filter({
          has: page.locator('.empdash-card-title', { hasText: new RegExp(`^${title}`) }),
        }),
        `${title} must not also be a panel`,
      ).toHaveCount(0);
      await expect(kpi(page, title), `${title} stays a KPI`).toHaveCount(1);
    }
    // And the joinee count appears exactly once in the whole page text.
    const body = await page.locator('.empdash-page').innerText();
    const joineeMentions = (body.match(/Upcoming Joinees/g) || []).length;
    expect(joineeMentions, 'Upcoming Joinees appears once').toBe(1);
    expect(a.summary.total).toBeGreaterThan(0);
  });

  test('@P0 Current Headcount names its composition, and each part is clickable', async ({ page }) => {
    const a = await openDashboard(page);
    const tile = page.locator('.empdash-kpi--headcount');
    await expect(tile.locator('.empdash-headline')).toContainText(String(a.summary.total));
    await expect(tile.locator('.empdash-scope')).toHaveText('As of today');

    // The composition is mutually exclusive and reconciles exactly.
    expect(a.summary.active + a.summary.probation + a.summary.notice + (a.summary.other ?? 0))
      .toBe(a.summary.total);

    // Every non-zero bucket is its own button, and reads "<n> <Status>" —
    // the segments used to run together as "31 Active1 Probation".
    const parts = (await tile.locator('.empdash-part').allTextContents()).map(t => t.trim());
    for (const [count, label] of [
      [a.summary.active, 'Active'],
      [a.summary.probation, 'Probation'],
      [a.summary.notice, 'Notice'],
    ] as [number, string][]) {
      if (count > 0) expect(parts).toContain(`${count} ${label}`);
    }
    for (const p of await tile.locator('.empdash-part').all()) {
      expect(await p.evaluate(el => el.tagName)).toBe('BUTTON');
    }
  });

  test('@P0 the Notice segment of headcount opens the notice cohort', async ({ page }) => {
    const a = await openDashboard(page);
    test.skip(!a.summary.notice, 'nobody is serving notice in this dataset');

    const tile = page.locator('.empdash-kpi--headcount');
    await tile.locator('.empdash-part', { hasText: 'Notice' }).click();

    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('Notice');
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(a.summary.notice);

    // …and the destination shows what a notice period is actually about.
    for (const h of ['Last Working Day', 'Days Remaining', 'Exit Request']) {
      await expect(page.locator('table thead'), `${h} column`).toContainText(h);
    }
  });

  test('@P0 the Notice Period KPI counts only its own cohort', async ({ page }) => {
    const exitsP = page.waitForResponse(r => r.url().includes('/hr-widgets/upcoming-exits'), { timeout: 20_000 });
    const a = await openDashboard(page);
    const exits = await (await exitsP).json();

    const tile = kpi(page, 'Notice Period');
    await expect(tile.locator('.empdash-kpi-value')).toHaveText(String(a.summary.notice));

    // ⚠ The subtitle must not borrow the GLOBAL overdue-exit count. On live
    // data all the overdue exits belong to employees who are still Active or
    // already resigned, so the tile read "1 … 4 past last working day" —
    // arithmetically impossible for a cohort of one.
    const noticeOverdue = exits.filter((e: { exit_state: string; employee_status: string }) =>
      e.exit_state === 'overdue' && String(e.employee_status || '').toLowerCase().startsWith('notice')).length;
    const sub = await tile.locator('.empdash-kpi-sub').innerText();
    if (noticeOverdue === 0) {
      expect(sub).toBe('Serving notice');
    } else {
      expect(sub).toBe(`${noticeOverdue} past last working day`);
    }
  });

  test('@P1 Needs Attention counts real gaps and opens those records', async ({ page }) => {
    const a = await openDashboard(page);
    const dq = a.dataQuality;
    const tile = action(page, 'Data Quality');
    await expect(tile.locator('.empdash-action-main')).toHaveText(String(dq.critical));
    if (dq.incomplete) {
      await expect(tile.locator('.empdash-overdue-badge')).toContainText(`${dq.incomplete} incomplete`);
    }

    test.skip(dq.critical + dq.incomplete === 0, 'no data-quality gaps in this dataset');
    await tile.locator('.empdash-action-main').click();
    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    // The tile and the list it opens must count the same records.
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(dq.critical);
  });

  test('@P0 every metric states its time scope', async ({ page }) => {
    await openDashboard(page);
    for (const loc of [page.locator('.empdash-kpi'), page.locator('.empdash-action')]) {
      const n = await loc.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i += 1) {
        const scope = loc.nth(i).locator('.empdash-scope, .empdash-action-sub');
        await expect(scope, `tile ${i} has a scope line`).toHaveCount(1);
        expect((await scope.innerText()).trim().length).toBeGreaterThan(2);
      }
    }
  });

  test('@P0 nothing on the page is clipped or spills out of its chart', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDashboard(page);
    await page.waitForTimeout(1800); // let recharts settle

    // Text that had to be ellipsised because it did not fit. A scope line or
    // a composition reading "31 Active · 1 Probati…" has lost the information
    // it exists to carry.
    const clipped = await page.evaluate(() => {
      const out: string[] = [];
      const sel = '.empdash-kpi-label, .empdash-kpi-value, .empdash-scope,'
        + '.empdash-action-label, .empdash-action-sub, .empdash-mv-label,'
        + '.empdash-mv-value, .empdash-mv-note, .empdash-card-title, .empdash-overdue-badge';
      document.querySelectorAll(sel).forEach(el => {
        const e = el as HTMLElement;
        if (e.scrollWidth > e.clientWidth + 1) out.push(`${e.className}: ${e.innerText.slice(0, 44)}`);
      });
      return out;
    });
    expect(clipped, `clipped text:\n${clipped.join('\n')}`).toEqual([]);

    // No chart label may render outside its own chart box.
    const escaped = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('.recharts-wrapper').forEach(w => {
        const wb = w.getBoundingClientRect();
        w.querySelectorAll('text').forEach(t => {
          const b = t.getBoundingClientRect();
          if (!b.width) return;
          if (b.left < wb.left - 1 || b.right > wb.right + 1) {
            out.push(`${t.textContent} @${Math.round(b.left)}..${Math.round(b.right)} in ${Math.round(wb.left)}..${Math.round(wb.right)}`);
          }
        });
      });
      return out;
    });
    expect(escaped, `chart labels outside their chart:\n${escaped.join('\n')}`).toEqual([]);
  });

  test('@P1 empty states stay compact', async ({ page }) => {
    await openDashboard(page);
    // Birthdays and anniversaries with nothing in them used to be full cards
    // carrying ~150px of white space each. As tiles they cost what any other
    // tile costs, whether or not they hold anything.
    const heights = await page.locator('.empdash-action').evaluateAll(
      els => els.map(e => Math.round(e.getBoundingClientRect().height)),
    );
    expect(heights.length).toBe(6);
    expect(Math.max(...heights), 'an action tile is a tile, not a card').toBeLessThanOrEqual(90);
    expect(new Set(heights).size, 'all action tiles the same height').toBe(1);
  });

  test('@P1 Birthdays opens exactly those employees, not the whole register', async ({ page }) => {
    const bdP = page.waitForResponse(r => r.url().includes('/hr-widgets/upcoming-birthdays'), { timeout: 20_000 });
    const a = await openDashboard(page);
    const rows = await (await bdP).json();

    const tile = action(page, 'Birthdays');
    await expect(tile.locator('.empdash-action-main')).toHaveText(String(rows.length));

    await tile.click();
    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('Birthdays');
    // ⚠ The point of the id list: without it this landed on all employees
    // under a chip promising a handful of birthdays.
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(rows.length);
    if (rows.length < a.summary.total) expect(shown).toBeLessThan(a.summary.total);
  });

  test('@P0 Upcoming Joinees drills through to a working onboarding page', async ({ page }) => {
    await openDashboard(page);
    await kpi(page, 'Upcoming Joinees').click();

    // A count you can click must land somewhere real. Joinees are candidates,
    // so the destination is recruitment's onboarding hub — not the employee
    // register, which is the entire point of keeping them separate.
    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Something went wrong');
    expect(body, 'HR roles hold recruitment:view, so this must not 403')
      .not.toContain('Unauthorized');
    await expect(page.locator('.page-content')).toBeVisible();
    // And it is NOT the employee list.
    await expect(page.locator('.ed-drill-chip')).toHaveCount(0);
  });

  test('@P0 every clickable tile lands on a real page, none on an error', async ({ page }) => {
    // Coverage for the tiles whose destination no other test opens. A tile
    // that looks clickable and drops you on Unauthorized (or an
    // ErrorBoundary) is worse than one that is plainly inert.
    const targets: [string, 'kpi' | 'action'][] = [
      ['Attrition Rate',  'kpi'],
      ['Notice Period',   'kpi'],
      ['Exits',           'action'],
      ['Confirmations',   'action'],
      ['Anniversaries',   'action'],
      ['Data Quality',    'action'],
    ];

    for (const [label, kind] of targets) {
      await openDashboard(page);
      const tile = kind === 'kpi' ? kpi(page, label) : action(page, label);
      await expect(tile, `${label} tile present`).toHaveCount(1);
      await tile.click();

      await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
      const body = await page.locator('body').innerText();
      expect(body, `${label} → ErrorBoundary`).not.toContain('Something went wrong');
      expect(body, `${label} → Unauthorized`).not.toContain('You do not have permission');
      await expect(page.locator('.page-content'), `${label} destination renders`).toBeVisible();
      // It must actually have gone somewhere, not silently no-opped.
      expect(page.url(), `${label} did not navigate`).not.toContain('EmployeesDashboard');
    }
  });

  test('@P1 chart segments navigate — gender, skill and tenure', async ({ page }) => {
    const a = await openDashboard(page);

    // ⚠ Which slice the first DOM sector is cannot be assumed — recharts does
    // not guarantee sector order matches data order. Assert the chip names
    // SOME value from that dimension, and that the row count matches it.
    const cases: [string, string, { count: number }[], (r: unknown) => string][] = [
      ['Gender', 'Gender', a.genderBreakdown, (r) => (r as { gender: string }).gender],
      ['Skill Type', 'Skill type', a.skillBreakdown, (r) => (r as { skill: string }).skill],
    ];

    for (const [card, chipPrefix, rows, nameOf] of cases) {
      if (!rows.length) continue;
      await openDashboard(page);
      const loc = page.locator('.empdash-card', { hasText: card });
      // These cards sit below the fold and recharts animates the sectors in,
      // so a click fired straight after load lands on a detached or
      // zero-sized node.
      await loc.scrollIntoViewIfNeeded();
      const sector = loc.locator('.recharts-pie-sector').first();
      await expect(sector).toBeVisible({ timeout: 15_000 });
      await expect.poll(
        async () => ((await sector.boundingBox())?.width ?? 0) > 4,
        { timeout: 10_000, message: `${card} pie settled` },
      ).toBe(true);
      await sector.click({ force: true });
      const chip = page.locator('.ed-drill-chip');
      await expect(chip, `${card} slice drill-down`).toBeVisible({ timeout: 15_000 });

      const text = await chip.innerText();
      expect(text, `${card} chip names the dimension`).toContain(chipPrefix);
      const hit = rows.find(r => text.includes(`${chipPrefix}: ${nameOf(r)}`));
      expect(hit, `chip "${text}" names a real ${card} value`).toBeTruthy();
      // …and the list really is narrowed to that many people.
      const shown = Number((await chip.locator('strong').first().innerText()).trim());
      expect(shown).toBe((hit as { count: number }).count);
    }

    // Tenure bar → the same bucket, filtered.
    await openDashboard(page);
    const biggestTenure = [...a.tenureGroups].sort((x, y) => y.count - x.count)[0];
    if (biggestTenure?.count) {
      const tenure = page.locator('.empdash-card', { hasText: 'Tenure Distribution' });
      await tenure.scrollIntoViewIfNeeded();
      const bar = tenure.locator('.recharts-bar-rectangle').first();
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await bar.click({ force: true });
      const chip = page.locator('.ed-drill-chip');
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText('Tenure');
    }
  });

  test('@P0 an overdue badge is its own link, to its own list', async ({ page }) => {
    const docsP = page.waitForResponse(r => r.url().includes('/hr-widgets/expiring-documents'), { timeout: 20_000 });
    await openDashboard(page);
    const docs = await (await docsP).json();
    const expired = docs.filter((d: { expiry_state: string }) => d.expiry_state === 'expired').length;
    test.skip(expired === 0, 'no expired documents in this dataset');

    // "2 expiring" and "2 expired" are different work with different
    // destinations, so the badge is a button in its own right rather than
    // decoration on a single tile-wide click target.
    const badge = action(page, 'Documents').locator('.empdash-overdue-badge');
    expect(await badge.evaluate(el => el.tagName)).toBe('BUTTON');
    await badge.click();

    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    await expect(
      page.locator('select').filter({ hasText: 'Expired or expiring' }),
    ).toHaveValue('expired', { timeout: 15_000 });
  });

  test('@P1 the Data Quality badge opens the wider incomplete set', async ({ page }) => {
    const a = await openDashboard(page);
    const dq = a.dataQuality;
    test.skip(!dq.incomplete || !dq.critical, 'needs both a critical and an incomplete count');

    // Main count → the gaps that block a workflow. Badge → every incomplete
    // record. Two numbers on one tile, two different lists.
    const tile = action(page, 'Data Quality');
    await tile.locator('.empdash-overdue-badge').click();
    const chip = page.locator('.ed-drill-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const shown = Number((await chip.locator('strong').first().innerText()).trim());
    expect(shown).toBe(dq.recordsNeedingAttention);
    expect(shown).toBeGreaterThan(dq.critical);
  });

  /**
   * The trend summary must never be able to disagree with the chart above it
   * or the KPIs beside it.
   *
   * The failure this guards against is a caption built from a SUBSET of the
   * series — the last point, the visible points, or only the non-zero ones.
   * On live FY27 data the series is 0, 0, 1, 24, 2, 0: a caption summing the
   * last non-zero month would read "2 hires" against a New Hires KPI of 27.
   */
  async function readTrendFigures(page: Page) {
    const card = page.locator('.empdash-card', { hasText: 'Hiring vs Attrition' });
    const hint = (await card.locator('.empdash-hint').innerText()).replace(/\s+/g, ' ');
    const m = /(-?\d+) hires? · (-?\d+) exits? · net ([+-]?\d+) across (\d+) months?/.exec(hint);
    expect(m, `trend summary shape: "${hint}"`).not.toBeNull();
    const kpiNew = await kpi(page, 'New Hires').locator('.empdash-kpi-value').innerText();
    const mv = (label: string) => page.locator('.empdash-card', { hasText: 'Workforce Movement' })
      .locator('.empdash-mv')
      .filter({ has: page.locator('.empdash-mv-label', { hasText: new RegExp(`^${label}$`) }) })
      .locator('.empdash-mv-value');
    return {
      hires:   Number(m![1]),
      exits:   Number(m![2]),
      net:     Number(m![3]),
      months:  Number(m![4]),
      kpiNew:  Number(kpiNew),
      mvHires: Number(await mv('Hires').innerText()),
      mvExits: Number(await mv('Exits').innerText()),
    };
  }

  function assertTrendReconciles(f: Awaited<ReturnType<typeof readTrendFigures>>, a: Analytics) {
    const seriesHires = a.hiringTrend.reduce((n, x) => n + x.hires, 0);
    const seriesExits = a.hiringTrend.reduce((n, x) => n + x.exits, 0);
    // The caption sums the WHOLE series the chart plots…
    expect(f.hires, 'summary hires vs series').toBe(seriesHires);
    expect(f.exits, 'summary exits vs series').toBe(seriesExits);
    expect(f.months, 'summary months vs series').toBe(a.hiringTrend.length);
    // …which is the same number the KPI and the movement ledger report.
    expect(f.hires, 'summary hires vs New Hires KPI').toBe(a.summary.newHires);
    expect(f.kpiNew, 'New Hires KPI vs API').toBe(a.summary.newHires);
    expect(f.mvHires, 'movement hires vs API').toBe(a.summary.newHires);
    expect(f.exits, 'summary exits vs API').toBe(a.summary.exits);
    expect(f.mvExits, 'movement exits vs API').toBe(a.summary.exits);
    // …and the net is stated, not implied.
    expect(f.net, 'summary net').toBe(seriesHires - seriesExits);
  }

  test('@P0 the trend summary totals the whole series, not a subset', async ({ page }) => {
    const a = await openDashboard(page);
    const f = await readTrendFigures(page);
    assertTrendReconciles(f, a);

    // The specific regression: with a series whose LAST non-zero month is
    // smaller than the total, the caption must show the total.
    const lastNonZero = [...a.hiringTrend].reverse().find(m => m.hires > 0)?.hires ?? 0;
    if (lastNonZero && lastNonZero !== a.summary.newHires) {
      expect(f.hires, 'summary must not echo the last non-zero month').not.toBe(lastNonZero);
    }
  });

  test('@P0 the trend summary still reconciles after changing the period', async ({ page }) => {
    await openDashboard(page);
    for (const period of ['all', 'mtd', 'fytd']) {
      const a = await setPeriod(page, period);
      await page.waitForTimeout(600);
      assertTrendReconciles(await readTrendFigures(page), a);
    }
  });

  test('@P0 the trend summary reconciles under a department filter, and says so', async ({ page }) => {
    const all = await openDashboard(page);
    test.skip(all.deptBreakdown.length === 0, 'no departments');

    const dept = all.deptBreakdown[0].department;
    const wait = page.waitForResponse(
      r => r.url().includes('/employees/analytics') && r.status() === 200, { timeout: 25_000 });
    await page.locator('.pl-filterbar select').nth(1).selectOption(dept);
    const a = await wait.then(r => r.json());
    await page.waitForTimeout(900);

    assertTrendReconciles(await readTrendFigures(page), a);

    // ⚠ A filtered card must not look like the whole company. The department
    // filter persists in sessionStorage, so the page can come back scoped
    // from a previous visit — "2 hires" for one department against a company
    // total of 27 is indistinguishable without this.
    await expect(page.locator('.empdash-scopechip')).toContainText(dept);
    await expect(
      page.locator('.empdash-card', { hasText: 'Hiring vs Attrition' }).locator('.empdash-card-sub'),
    ).toContainText(dept);
    await expect(
      page.locator('.empdash-card', { hasText: 'Workforce Movement' }).locator('.empdash-card-sub'),
    ).toContainText(dept);

    // ⚠ "Every figure filtered to X" has to be TRUE. The HR action tiles come
    // from /hr-widgets, which ignored the department dimension entirely — so
    // the strip showed the whole company's expiring documents and overdue
    // exits beside a headcount of one department, under one heading.
    const exitsWait = page.waitForResponse(
      r => r.url().includes('/hr-widgets/upcoming-exits'), { timeout: 20_000 });
    await page.reload();
    const scopedExits = await exitsWait.then(r => r.json());
    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    for (const row of scopedExits) {
      expect(row.department, 'hr-widgets must honour the department filter').toBe(dept);
    }
  });

  // ── Filter-bar state ──────────────────────────────────────────────────────

  const FILTER_KEY = 'pulse.filters.employees-dashboard';

  async function readFilterBar(page: Page) {
    return page.evaluate(() => {
      const bar = document.querySelector('.pl-filterbar');
      const reset = bar?.querySelector('.pl-filterbar-reset') as HTMLElement | null;
      return {
        selects: Array.from(bar?.querySelectorAll('select') ?? []).map(x => (x as HTMLSelectElement).value),
        badge: reset?.querySelector('.pl-filterbar-badge')?.textContent?.trim() ?? null,
        title: reset?.title ?? null,
      };
    });
  }

  test('@P0 Reset shows nothing when no filter differs from the default', async ({ page }) => {
    await page.goto(`${BASE}/EmployeesDashboard`);
    await page.evaluate(k => sessionStorage.removeItem(k), FILTER_KEY);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    await expect(page.locator('.empdash-kpis')).toBeVisible({ timeout: 15_000 });

    const bar = await readFilterBar(page);
    expect(bar.selects).toEqual(['fytd', 'all']);
    // No badge at all, rather than a "0" the user has to interpret.
    expect(bar.badge, 'nothing to reset ⇒ no Reset control').toBeNull();
  });

  test('@P0 an active filter is counted, visible in its control, and named on Reset', async ({ page }) => {
    await openDashboard(page);
    await setPeriod(page, 'all');

    const bar = await readFilterBar(page);
    // "All Time" is a CHOSEN window, not the absence of one — Reset really
    // does change it back to This FY, so counting it is correct.
    expect(bar.selects[0], 'the period control shows the active value').toBe('all');
    expect(bar.badge).toBe('1');
    expect(bar.title, 'the badge says what it would undo').toContain('All Time');
  });

  test('@P0 a persisted dimension the page no longer has is dropped, not counted', async ({ page }) => {
    // ⚠ The regression: an orphaned dimension is invisible (no control renders
    // it) yet counted by the badge AND forwarded to the API — so "Reset 1"
    // appears beside two dropdowns that are both at their defaults.
    await page.goto(`${BASE}/EmployeesDashboard`);
    await page.evaluate(k => sessionStorage.setItem(k, JSON.stringify({
      period: 'fytd', from: '', to: '',
      dimensions: { department: 'all', location: 'Chennai' },
    })), FILTER_KEY);

    const analytics = page.waitForResponse(
      r => r.url().includes('/employees/analytics') && r.status() === 200, { timeout: 25_000 });
    await page.reload();
    const url = (await analytics).url();
    await page.waitForFunction(() => !document.querySelector('.page-loading'), { timeout: 20_000 });
    await expect(page.locator('.empdash-kpis')).toBeVisible({ timeout: 15_000 });

    const bar = await readFilterBar(page);
    expect(bar.badge, 'an orphan dimension must not inflate the badge').toBeNull();
    expect(url, 'an orphan dimension must not reach the API').not.toContain('location');

    // …and it is gone from storage, so it cannot come back on the next load.
    const stored = await page.evaluate(k => sessionStorage.getItem(k), FILTER_KEY);
    expect(JSON.parse(stored!).dimensions).toEqual({ department: 'all' });
  });

  test('@P1 a department filter is counted and named too', async ({ page }) => {
    const a = await openDashboard(page);
    test.skip(a.deptBreakdown.length === 0, 'no departments');
    const dept = a.deptBreakdown[0].department;

    const wait = page.waitForResponse(
      r => r.url().includes('/employees/analytics') && r.status() === 200, { timeout: 25_000 });
    await page.locator('.pl-filterbar select').nth(1).selectOption(dept);
    await wait;
    await page.waitForTimeout(600);

    const bar = await readFilterBar(page);
    expect(bar.selects[1]).toBe(dept);
    expect(bar.badge).toBe('1');
    expect(bar.title).toContain(dept);
  });

  test('@P1 no console errors and no failed requests on load', async ({ page }) => {
    const consoleErrors: string[] = [];
    const failed: string[] = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', r => {
      if (r.status() >= 400 && r.url().includes('/api/')) failed.push(`${r.status()} ${r.url()}`);
    });

    await openDashboard(page);
    await page.waitForTimeout(1200);

    expect(failed, `failed API calls:\n${failed.join('\n')}`).toEqual([]);
    // React key warnings and recharts defaultProps noise are not this page's
    // to fix; anything else is.
    const real = consoleErrors.filter(e => !/defaultProps|React Router Future Flag/.test(e));
    expect(real, `console errors:\n${real.join('\n')}`).toEqual([]);
  });
});
