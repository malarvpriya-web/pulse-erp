/**
 * Suite 23 — All Employees, acceptance walkthrough from a COLD session.
 *
 * Suite 22 tests behaviour. This one tests what a person who has never opened the
 * page sees, which is a different question and one the other suite cannot answer:
 * it runs with `localStorage` CLEARED for the origin, so the defaults are the real
 * defaults rather than whatever a previous run left in `pulse_emp_cols` and
 * `pulse_emp_page_size`.
 *
 * That matters here specifically because this page persists both the column set and
 * the page size. Suite 22 deliberately switches every column on and changes the page
 * size, and Playwright's storageState carries localStorage between runs — so "default
 * 20 rows" and "the default column set" are exactly the claims a warm session is
 * least able to verify.
 *
 * Each test gets its own cold context. Assertions are invariants against whatever
 * the API returns, not golden numbers.
 */

import { test, expect, Page, BrowserContext, Browser } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';
const AUTH = 'tests/.auth/user.json';

type Employee = {
  id: number; office_id: string | null; first_name: string; last_name: string;
  name?: string | null;
  department: string | null; designation: string | null; status: string | null;
  company_email: string | null; personal_email?: string | null;
  reporting_manager: string | null; joining_date?: string | null;
};

const EXITED = [
  'left', 'inactive', 'terminated', 'resigned',
  'ex-employee', 'ex employee', 'exited', 'relieved', 'absconded',
];
const bucketOf = (s: string | null) => {
  const v = String(s ?? '').trim().toLowerCase() || 'active';
  if (EXITED.includes(v)) return 'Exited';
  if (v === 'probation') return 'Probation';
  if (['notice', 'notice_period', 'notice period'].includes(v)) return 'Notice';
  if (v === 'active') return 'Active';
  return 'Other';
};
const currentOf = (rows: Employee[]) => rows.filter(e => bucketOf(e.status) !== 'Exited');

const blankValue = (v: unknown) => {
  if (v == null) return true;
  const t = String(v).trim();
  return !t || ['null', 'undefined', 'nan', 'n/a', 'na', '-', '--'].includes(t.toLowerCase());
};
const MANDATORY = ['office_id', 'department', 'designation', 'status', 'joining_date'] as const;
const isIncomplete = (e: Employee) =>
  MANDATORY.some(k => blankValue((e as Record<string, unknown>)[k]));

/**
 * A browser context that is authenticated but has NEVER seen this page.
 *
 * storageState carries localStorage as well as cookies, so it is wiped for the
 * origin after the first navigation. Without that wipe, "the default page size is
 * 20" can pass purely because the last run happened to leave 20 there.
 */
async function coldSession(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: AUTH });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.evaluate(() => {
    try {
      localStorage.removeItem('pulse_emp_cols');
      localStorage.removeItem('pulse_emp_page_size');
    } catch { /* blocked storage — the page must cope with that anyway */ }
  });
  return { ctx, page };
}

/** Open All Employees in a cold session and hand back the rows it rendered from. */
async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page; rows: Employee[] }> {
  const { ctx, page } = await coldSession(browser);
  const wait = page.waitForResponse(
    r => /\/employees(\?|$)/.test(r.url()) && r.request().method() === 'GET' && r.status() === 200,
    { timeout: 25_000 });
  await page.goto(`${BASE}/EmployeesData`);
  const res = await wait;
  await expect(page.locator('.ed-table, .ed-empty')).toBeVisible({ timeout: 20_000 });
  const body = await res.json();
  return { ctx, page, rows: Array.isArray(body) ? body : [] };
}

test.describe('All Employees — cold-session acceptance', () => {
  test('the page renders without an error boundary and with no console errors', async ({ browser }) => {
    const { ctx, page } = await coldSession(browser);
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

    await page.goto(`${BASE}/EmployeesData`);
    await expect(page.locator('.ed-table, .ed-empty')).toBeVisible({ timeout: 20_000 });

    // The TDZ bug in an earlier pass showed as this heading, not as a bad number.
    await expect(page.getByRole('heading', { name: /something went wrong/i })).toHaveCount(0);

    // Network noise (favicons, aborted fetches on unmount) is not a page defect;
    // a React error or an unhandled rejection is.
    const real = errors.filter(e =>
      !/favicon|ERR_ABORTED|Failed to load resource|net::/i.test(e));
    expect(real, `console errors: ${real.join(' | ')}`).toEqual([]);
    await ctx.close();
  });

  test('Employee ID column shows EMP001-style codes for every row, none blank', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);

    // Read the rendered Emp ID cells, not the API payload.
    const headers = await page.locator('.ed-table thead th').allInnerTexts();
    const idx = headers.findIndex(h => /Emp ID/i.test(h));
    expect(idx, 'the Emp ID column must be visible by default').toBeGreaterThan(-1);

    const cells = await page.locator('.ed-table tbody tr').evaluateAll(
      (trs, i) => trs.map(tr => (tr.children[i] as HTMLElement)?.innerText.trim() ?? ''),
      idx);
    expect(cells.length).toBeGreaterThan(0);

    for (const c of cells) {
      expect(c, `"${c}" is not in the EMP001 convention`).toMatch(/^EMP\d{3,}$/);
      expect(c, 'no hyphen in an Employee ID').not.toContain('-');
    }
    // And no row is showing the "Not assigned" gap chip for Employee ID.
    expect(await page.locator('.ed-table tbody td .ed-missing').filter({ hasText: 'Not assigned' }).count())
      .toBe(0);
    expect(currentOf(rows).every(e => /^EMP\d{3,}$/.test(e.office_id ?? ''))).toBe(true);
    await ctx.close();
  });

  test('no cell renders a raw null, undefined, NaN or Invalid Date — every column on', async ({ browser }) => {
    const { ctx, page } = await open(browser);

    await page.locator('.ed-col-btn').click();
    const items = page.locator('.ed-col-panel .ed-col-item');
    for (let i = 0; i < await items.count(); i++) {
      const it = items.nth(i);
      if (await it.locator('.ed-col-check-icon.on').count() === 0) await it.click();
    }
    await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });

    const cells = await page.locator('.ed-table tbody td').allInnerTexts();
    const offenders = cells.map(t => t.trim())
      .filter(t => /^(null|undefined|NaN|Invalid Date|\[object Object\])$/i.test(t));
    expect(offenders, `${offenders.length} cells render a raw sentinel`).toEqual([]);
    await ctx.close();
  });

  test('DEFAULTS: rows per page is 20, at the top, with 10/20/50/100', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const current = currentOf(rows).length;

    const top = page.locator('#ed-page-size-top');
    await expect(top).toBeVisible();
    // The claim a warm session cannot make: this is the DEFAULT, not a leftover.
    await expect(top).toHaveValue('20');
    for (const n of ['10', '20', '50', '100']) {
      await expect(top.locator(`option[value="${n}"]`)).toHaveCount(1);
    }

    // Above the table and within the first screen.
    const selBox = await top.boundingBox();
    const tableBox = await page.locator('.ed-table').boundingBox();
    expect(selBox!.y).toBeLessThan(tableBox!.y);
    expect(selBox!.y).toBeLessThan(900);

    // "Showing 1-20 of 32 employees"
    const count = page.locator('.ed-table-count');
    await expect(count).toContainText(String(current));
    expect(await count.innerText()).toMatch(/Showing\s+1(–\d+)?\s+of/);
    await expect(page.locator('.ed-table tbody tr')).toHaveCount(Math.min(20, current));
    await ctx.close();
  });

  test('DEFAULTS: the default column set is the documented one', async ({ browser }) => {
    const { ctx, page } = await open(browser);
    // ⚠ Upper-cased on purpose. `.ed-th` carries `text-transform: uppercase` and
    // `innerText` reports the RENDERED text, so these come back as "EMPLOYEE",
    // "EMP ID" and so on. A case-sensitive `includes('Employee')` reported the
    // Employee column as missing when the page was perfectly correct — the first
    // version of this test did exactly that, and the defect was in the assertion.
    const headers = (await page.locator('.ed-table thead th').allInnerTexts())
      .map(h => h.replace(/\s+/g, ' ').trim().toUpperCase());
    const shows = (label: string) => headers.some(h => h.includes(label.toUpperCase()));

    // COLUMN_DEFS marks these always/defaultOn — a cold session must show exactly
    // these, so a stray persisted set cannot be mistaken for the product default.
    for (const want of ['Employee', 'Emp ID', 'Department', 'Role', 'Status', 'Joined', 'Manager', 'Actions']) {
      expect(shows(want), `default column "${want}" is missing`).toBe(true);
    }
    // And NOT the off-by-default ones.
    for (const off of ['PAN', 'Aadhaar', 'Blood Group', 'Total Experience']) {
      expect(shows(off), `"${off}" should be off by default`).toBe(false);
    }
    await ctx.close();
  });

  test('Total Staff matches the API, and the KPI tiles sum to it', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const read = async (label: string) => {
      const card = page.locator('.ed-kpi-card', { hasText: label });
      return (await card.count()) === 0 ? 0
        : Number((await card.locator('.ed-kpi-val').innerText()).trim());
    };
    const total = await read('Total Staff');
    expect(total).toBe(currentOf(rows).length);
    expect((await read('Active')) + (await read('Probation'))
         + (await read('On Notice')) + (await read('Other'))).toBe(total);
    await ctx.close();
  });

  test('pagination: page 2 holds different people and the last page closes the range', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const current = currentOf(rows).length;
    test.skip(current <= 20, 'needs more than 20 employees to paginate at the default size');

    await expect(page.locator('.ed-page-btn', { hasText: 'Next' })).toBeVisible();
    await expect(page.locator('.ed-page-btn-current')).toHaveText('1');
    const firstOnP1 = await page.locator('.ed-table tbody tr .ed-name').first().innerText();

    await page.locator('.ed-page-btn', { hasText: 'Next' }).click();
    await expect(page.locator('.ed-page-btn-current')).toHaveText('2');
    expect(await page.locator('.ed-table tbody tr .ed-name').first().innerText()).not.toBe(firstOnP1);
    // Row numbering continues rather than restarting.
    await expect(page.locator('.ed-table tbody tr .ed-num-label').first()).toHaveText('21');
    // Last page closes on the total: "21-32 of 32".
    await expect(page.locator('.ed-table-count')).toContainText(`of ${current}`);
    await ctx.close();
  });

  test('search finds an employee by every advertised field', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const current = currentOf(rows);

    const placeholder = await page.locator('.ed-search').getAttribute('placeholder') ?? '';
    const claims: [string, keyof Employee][] = [
      ['name', 'first_name'], ['ID', 'office_id'], ['email', 'company_email'],
      ['dept', 'department'], ['role', 'designation'], ['manager', 'reporting_manager'],
    ];
    for (const [word] of claims) {
      expect(placeholder.toLowerCase(), `placeholder must advertise ${word}`)
        .toContain(word.toLowerCase());
    }

    const untested: string[] = [];
    for (const [word, field] of claims) {
      const hit = current.find(e => {
        const v = String(e[field] ?? '').trim();
        return v.length > 2 && !blankValue(v);
      });
      if (!hit) { untested.push(word); continue; }
      await page.locator('.ed-search').fill(String(hit[field]).trim());
      const name = `${hit.first_name ?? ''} ${hit.last_name ?? ''}`.trim();
      await expect(
        page.locator('.ed-table tbody tr', { hasText: name }).first(),
        `search by ${word} ("${String(hit[field]).trim()}") did not find ${name}`,
      ).toBeVisible({ timeout: 10_000 });
    }
    // Every advertised field must be exercisable against the live data — an
    // advertised field with no data to test it on is itself worth surfacing.
    expect(untested, `no data to exercise: ${untested.join(', ')}`).toEqual([]);
    await ctx.close();
  });

  test('filters combine and the count tracks the filtered set', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const current = currentOf(rows);
    const seed = current.find(e => e.department && e.designation);
    test.skip(!seed, 'no employee has both a department and a role');

    const dept = seed!.department!, role = seed!.designation!;
    const status = bucketOf(seed!.status);
    const dSel = page.locator('.ed-filter-selects .ed-select').nth(0);
    const sSel = page.locator('.ed-filter-selects .ed-select').nth(1);
    const rSel = page.locator('.ed-filter-selects .ed-select').nth(2);

    await dSel.selectOption(dept);
    await expect(page.locator('.ed-table-count'))
      .toContainText(`of ${current.filter(e => e.department === dept).length}`);
    await sSel.selectOption(status);
    await rSel.selectOption(role);
    const expected = current.filter(e =>
      e.department === dept && e.designation === role && bucketOf(e.status) === status).length;
    await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);

    // Clear restores the controls, not just the rows.
    await page.locator('.ed-clear-btn').click();
    await expect(page.locator('.ed-table-count')).toContainText(`of ${current.length}`);
    for (const sel of [dSel, sSel, rSel]) await expect(sel).toHaveValue('All');
    await ctx.close();
  });

  test('Incomplete filter count equals the rows it returns, and names the gaps', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const expected = currentOf(rows).filter(isIncomplete).length;
    const toggle = page.locator('.ed-incomplete-btn');

    if (expected === 0) {
      await expect(toggle).toHaveCount(0);
      await ctx.close();
      return;
    }
    await expect(toggle.locator('.ed-incomplete-count')).toHaveText(String(expected));
    await toggle.click();
    await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);

    const badges = await page.locator('.ed-table tbody tr .ed-gap-badge').allInnerTexts();
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) {
      expect(/Employee ID|Department|Role|Status|Joining date/.test(b),
        `badge "${b}" names no mandatory field`).toBe(true);
    }
    await ctx.close();
  });

  test('bulk status change cannot apply in one click, and names who it affects', async ({ browser }) => {
    const { ctx, page } = await open(browser);
    await page.locator('.ed-table tbody tr .ed-row-check').first().check();
    await expect(page.locator('.ed-bulk-bar')).toBeVisible();
    await page.locator('.ed-bulk-btn', { hasText: 'Change Status' }).click();

    const modal = page.locator('.ed-modal', { hasText: 'Change Status' });
    await expect(modal).toBeVisible();
    // No exit status in bulk — a bulk change carries no last working day.
    const values = await modal.locator('select option')
      .evaluateAll(os => os.map(o => (o as HTMLOptionElement).value).filter(Boolean));
    expect(values.sort()).toEqual(['Active', 'Notice', 'Probation']);

    await modal.locator('select').selectOption('Notice');
    // The first button REVIEWS. It must not be able to apply.
    await expect(modal.locator('button', { hasText: /^Review/ })).toBeVisible();
    await modal.locator('button', { hasText: /^Review/ }).click();
    await expect(modal.locator('.ed-modal-newval')).toHaveText('On Notice');
    await expect(modal.locator('.ed-affected-list li')).toHaveCount(1);
    await expect(modal.locator('button', { hasText: /^Set 1 to On Notice$/ })).toBeVisible();

    // Cancellable, and nothing written.
    await modal.locator('.ed-modal-cancel').click();   // Back
    await modal.locator('.ed-modal-cancel').click();   // Cancel
    await expect(modal).toBeHidden();
    await ctx.close();
  });

  test('Export names how many rows it will write and follows the filters', async ({ browser }) => {
    const { ctx, page, rows } = await open(browser);
    const btn = page.locator('.plh-cta', { hasText: 'Export' }).first();
    await expect(btn).toContainText(String(currentOf(rows).length));

    const byDept = new Map<string, number>();
    for (const e of currentOf(rows)) if (e.department) byDept.set(e.department, (byDept.get(e.department) ?? 0) + 1);
    const top = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      await page.locator('.ed-filter-selects .ed-select').first().selectOption(top[0]);
      await expect(btn).toContainText(String(top[1]));
    }
    await ctx.close();
  });

  test('row actions are present and the Terminate dialog is cancellable', async ({ browser }) => {
    const { ctx, page } = await open(browser);
    const row = page.locator('.ed-table tbody tr').first();
    await expect(row.locator('.ed-btn-view')).toBeVisible();
    await expect(row.locator('.ed-btn-edit')).toBeVisible();
    await expect(row.locator('.ed-btn-deact')).toBeVisible();

    await row.locator('.ed-btn-deact').click();
    const modal = page.locator('.ed-modal', { hasText: 'Terminate Employee' });
    await expect(modal).toBeVisible();
    // A last working day is required — that is what makes an exit dateable.
    await expect(modal.locator('input[type="date"]')).toBeVisible();
    await modal.locator('.ed-modal-cancel').click();
    await expect(modal).toBeHidden();
    await ctx.close();
  });

  test.describe('KPI drill-down', () => {
    /**
     * Every KPI card must be a real, whole-card, keyboard-operable control.
     *
     * They were `<div onClick>`: the entire band was unreachable by keyboard and
     * had no role or accessible name, and the Total Staff card had no handler at
     * all — it looked identical to the three that worked and did nothing.
     */
    test('all KPI cards are whole-card buttons with an accessible name', async ({ browser }) => {
      const { ctx, page } = await open(browser);
      const cards = page.locator('.ed-kpi-row .ed-kpi-card');
      const n = await cards.count();
      expect(n).toBeGreaterThanOrEqual(4);

      for (let i = 0; i < n; i++) {
        const card = cards.nth(i);
        // ⚠ Lower-cased. `.ed-kpi-label` carries `text-transform: uppercase` and
        // `innerText` reports the RENDERED text, so this comes back "ACTIVE", not
        // "Active" — the same trap that made an earlier version of the column-set
        // test declare a present column missing. Compare case-insensitively.
        const label = (await card.locator('.ed-kpi-label').innerText()).trim();
        const labelLc = label.toLowerCase();

        // A real button, so Enter/Space and focus come from the platform.
        expect(await card.evaluate(el => el.tagName), `${label} must be a BUTTON`).toBe('BUTTON');
        expect(await card.getAttribute('type'), `${label} needs type=button`).toBe('button');

        // Named for a screen reader — the visible text is a bare number plus a
        // two-word label, which reads as "32 Total Staff" out of context.
        const name = (await card.getAttribute('aria-label')) ?? '';
        expect(name.length, `${label} has no accessible name`).toBeGreaterThan(10);
        expect(name.toLowerCase(), `${label}'s accessible name should mention it`)
          .toContain(labelLc.split(' ')[0].slice(0, 5));

        // A toggle, so it reports its state.
        expect(await card.getAttribute('aria-pressed'), `${label} needs aria-pressed`).toMatch(/true|false/);

        // No nested interactive element — that would be invalid HTML inside a button.
        expect(await card.locator('button, a[href], input, select, textarea').count(),
          `${label} must not nest an interactive element`).toBe(0);

        // The WHOLE card is the target, not just the number.
        const cardBox = await card.boundingBox();
        const valBox = await card.locator('.ed-kpi-val').boundingBox();
        expect(cardBox!.width).toBeGreaterThan(valBox!.width * 1.5);
        expect(await card.evaluate(el => getComputedStyle(el).cursor)).toBe('pointer');
      }
      await ctx.close();
    });

    test('each status KPI opens its own cohort and the counts reconcile', async ({ browser }) => {
      const { ctx, page, rows } = await open(browser);
      const current = currentOf(rows);

      for (const [label, bucket] of [['Active', 'Active'], ['Probation', 'Probation'], ['On Notice', 'Notice']]) {
        const expected = current.filter(e => bucketOf(e.status) === bucket).length;
        const card = page.locator('.ed-kpi-card', { hasText: label });
        if (await card.count() === 0) continue;

        // The card's own number must equal the cohort it opens.
        expect(Number((await card.locator('.ed-kpi-val').innerText()).trim())).toBe(expected);
        await card.click();
        await expect(card).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);
        // And the status control shows the applied filter, not just the rows.
        await expect(page.locator('.ed-filter-selects .ed-select').nth(1)).toHaveValue(bucket);

        // Clicking again releases it — these are toggles.
        await card.click();
        await expect(card).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('.ed-table-count')).toContainText(`of ${current.length}`);
      }
      await ctx.close();
    });

    /** The review's nine steps, in order. */
    test('Total Staff opens the current-staff population, shows a chip, and clears', async ({ browser }) => {
      // 1. Open All Employees.
      const { ctx, page, rows } = await open(browser);
      const current = currentOf(rows);
      const exited = rows.length - current.length;

      // 2. Read the Total Staff KPI — from the page, not from a hardcoded 32.
      const card = page.locator('.ed-kpi-card', { hasText: 'Total Staff' });
      await expect(card).toBeVisible();
      const kpi = Number((await card.locator('.ed-kpi-val').innerText()).trim());
      expect(kpi, 'Total Staff must equal the non-exited rows the API returned').toBe(current.length);

      // Active + Probation + Notice (+ Other) must equal it — the calculation is
      // not what this task changes, so it is asserted rather than assumed.
      const read = async (l: string) => {
        const c = page.locator('.ed-kpi-card', { hasText: l });
        return (await c.count()) === 0 ? 0 : Number((await c.locator('.ed-kpi-val').innerText()).trim());
      };
      expect((await read('Active')) + (await read('Probation'))
           + (await read('On Notice')) + (await read('Other'))).toBe(kpi);

      // Narrow first, so "clears the other filters" is actually exercised rather
      // than being true because nothing was set.
      await page.locator('.ed-filter-selects .ed-select').nth(1).selectOption('Active');
      await expect(page.locator('.ed-table-count'))
        .toContainText(`of ${current.filter(e => bucketOf(e.status) === 'Active').length}`);

      // 3. Click the Total Staff KPI — on the card body, not the number, to prove
      //    the whole tile is the target.
      await card.locator('.ed-kpi-label').click();

      // 4-5. The list is the current-staff population, and the count equals the KPI.
      await expect(page.locator('.ed-table-count')).toContainText(`of ${kpi}`);
      await expect(page.locator('.ed-filter-selects .ed-select').nth(1)).toHaveValue('All');
      await expect(card).toHaveAttribute('aria-pressed', 'true');

      // 6. The filter is VISIBLE — the list did not silently change.
      const chip = page.locator('.ed-drill-chip');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('Current Staff');
      await expect(chip).toContainText(String(kpi));

      // 7. No exited employee is included, and the chip says where they are.
      const shownIds = await page.locator('.ed-table tbody tr .ed-emp-id, .ed-table tbody tr .ed-missing')
        .allInnerTexts();
      const exitedCodes = rows.filter(e => bucketOf(e.status) === 'Exited')
        .map(e => (e.office_id ?? '').trim()).filter(Boolean);
      for (const code of exitedCodes) {
        expect(shownIds.map(t => t.trim()), `exited ${code} must not be listed`).not.toContain(code);
      }
      if (exited > 0) {
        // The 34-vs-32 gap is the one fact the plain register hides.
        await expect(chip).toContainText(String(exited));
        await expect(chip).toContainText(/Ex-Employees/i);
      }

      // 8. Remove the filter.
      await chip.getByRole('button', { name: /Clear/i }).click();

      // 9. The normal register returns.
      await expect(chip).toHaveCount(0);
      await expect(card).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.ed-table-count')).toContainText(`of ${current.length}`);
      await ctx.close();
    });

    test('Total Staff is operable from the keyboard', async ({ browser }) => {
      const { ctx, page } = await open(browser);
      const card = page.locator('.ed-kpi-card', { hasText: 'Total Staff' });

      // Focusable at all — a div never was.
      await card.focus();
      expect(await card.evaluate(el => el === document.activeElement)).toBe(true);

      // Space activates a button. No onKeyDown handler needed, which is the point
      // of using the right element.
      await page.keyboard.press(' ');
      await expect(page.locator('.ed-drill-chip')).toBeVisible();
      await expect(card).toHaveAttribute('aria-pressed', 'true');

      // And Enter releases it again.
      await card.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.ed-drill-chip')).toHaveCount(0);
      await expect(card).toHaveAttribute('aria-pressed', 'false');
      await ctx.close();
    });
  });

  for (const width of [1280, 1440, 1920]) {
    test(`no horizontal page scroll at ${width}px, every column on`, async ({ browser }) => {
      const { ctx, page } = await open(browser);
      await page.setViewportSize({ width, height: 900 });

      await page.locator('.ed-col-btn').click();
      const items = page.locator('.ed-col-panel .ed-col-item');
      for (let i = 0; i < await items.count(); i++) {
        const it = items.nth(i);
        if (await it.locator('.ed-col-check-icon.on').count() === 0) await it.click();
      }
      await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });

      const o = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(o.doc, `document scrolls ${o.doc}px sideways`).toBeLessThanOrEqual(1);
      expect(o.body).toBeLessThanOrEqual(1);

      // The scroll belongs to the table container, and the top control stays reachable.
      expect(await page.locator('.ed-table-scroll')
        .evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await expect(page.locator('#ed-page-size-top')).toBeVisible();

      // Headers not clipped, and header/body column counts agree.
      const ths = await page.locator('.ed-table thead th').count();
      const tds = await page.locator('.ed-table tbody tr').first().locator('td').count();
      expect(tds).toBe(ths);
      for (const th of await page.locator('.ed-table thead th').all()) {
        expect((await th.boundingBox())?.height ?? 0).toBeGreaterThan(8);
      }
      await ctx.close();
    });
  }
});
