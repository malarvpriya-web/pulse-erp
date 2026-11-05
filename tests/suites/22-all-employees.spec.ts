/**
 * Suite 22 — Employees ▸ All Employees, end to end in a real browser.
 *
 * Everything here is about what reaches the SCREEN, which is why none of it was
 * caught by the backend suites:
 *
 *   - the Manager column printed the literal text `null` (the column holds the
 *     four-character STRING 'null' on three rows, and 'null' is truthy, so every
 *     `value ? value : '—'` guard in the page waved it through);
 *   - "Showing 20 of 32 employees" with no rows-per-page control and no page
 *     numbers, so 12 employees were reachable only through a `›` glyph;
 *   - Employee ID, Department and Role rendering as a neutral em-dash on 24
 *     rows, indistinguishable from "nothing to say here";
 *   - a bulk status change that applied on one click, and reported a blanket
 *     failure while having already changed most of the selection.
 *
 * Assertions are invariants against whatever the API returns, not golden
 * numbers, so they survive the seed data changing.
 */

import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';

type Employee = {
  id: number; office_id: string | null; first_name: string; last_name: string;
  department: string | null; designation: string | null; status: string | null;
  company_email: string | null; reporting_manager: string | null;
};

/** The canonical READ vocabulary, mirrored from features/employees/employeeStatus.js. */
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

/** Open the register and hand back the rows it rendered from. */
async function openRegister(page: Page): Promise<Employee[]> {
  const wait = page.waitForResponse(
    r => /\/employees(\?|$)/.test(r.url()) && r.request().method() === 'GET' && r.status() === 200,
    { timeout: 25_000 },
  );
  await page.goto(`${BASE}/EmployeesData`);
  const res = await wait;
  await expect(page.locator('.ed-table, .ed-empty')).toBeVisible({ timeout: 20_000 });
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

const currentOf = (rows: Employee[]) => rows.filter(e => bucketOf(e.status) !== 'Exited');

/**
 * Sentinel-aware blankness, mirroring `isBlank` in displayValue.js: the string
 * 'null' is present and truthy but carries no information.
 */
const blankValue = (v: unknown) => {
  if (v == null) return true;
  const t = String(v).trim();
  return !t || ['null', 'undefined', 'nan', 'n/a', 'na', '-', '--'].includes(t.toLowerCase());
};

/**
 * Mirror of MANDATORY_FIELDS in employeeListFilter.js — "would this row fail
 * POST /employees today?".
 *
 * ⚠ This lived inline in two tests with two different field lists, and the
 * narrower one failed the moment the page's definition was widened to include
 * joining date: the page said 27, the test insisted on 26, and the PAGE was
 * right. A definition that has to agree in three places needs to exist in one.
 */
const MANDATORY: (keyof Employee | 'joining_date')[] = [
  'office_id', 'department', 'designation', 'status', 'joining_date',
];
const isIncomplete = (e: Employee) =>
  MANDATORY.some(k => blankValue((e as Record<string, unknown>)[k as string]));

/**
 * Switch every optional column on — the worst case for table width, and the only
 * way to exercise renderCell's default arm.
 *
 * Clicks the LABEL, not the checkbox. `.ed-col-item input[type="checkbox"]` is
 * `display: none` (the panel draws its own tick icon), so `.check()` times out
 * on an element that is not visible and never will be. Clicking the label is
 * also what a person does.
 */
async function enableAllColumns(page: Page) {
  await page.locator('.ed-col-btn').click();
  const panel = page.locator('.ed-col-panel');
  await expect(panel).toBeVisible();

  const items = panel.locator('.ed-col-item');
  const n = await items.count();
  expect(n, 'the column panel should offer optional columns').toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    // `.on` is the class the page puts on the tick icon when the column is shown.
    if (await item.locator('.ed-col-check-icon.on').count() === 0) {
      await item.click();
    }
  }
  // Close via an outside click — the panel closes on mousedown outside itself.
  await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });
  await expect(panel).toBeHidden();
}

test.describe('All Employees register', () => {
  test('no cell anywhere on the page renders a raw null/undefined', async ({ page }) => {
    const rows = await openRegister(page);
    // Prove the fixture is capable of catching the bug: if the API stops
    // returning a 'null'-shaped value the assertion below becomes vacuous, and
    // silently-vacuous tests are how a fixed bug comes back.
    const sentinelRows = rows.filter(e =>
      ['null', 'undefined', 'NaN'].includes(String(e.reporting_manager ?? '').trim()));
    test.info().annotations.push({
      type: 'fixture',
      description: `rows holding a literal 'null' manager: ${sentinelRows.length}`,
    });

    await enableAllColumns(page);

    const cells = await page.locator('.ed-table tbody td').allInnerTexts();
    expect(cells.length).toBeGreaterThan(0);
    const offenders = cells
      .map(t => t.trim())
      .filter(t => /^(null|undefined|NaN|Invalid Date|\[object Object\])$/i.test(t));
    expect(offenders, `raw sentinel values rendered in ${offenders.length} cells`).toEqual([]);
  });

  test('Total Staff equals the non-exited rows the API returned', async ({ page }) => {
    const rows = await openRegister(page);
    const tile = page.locator('.ed-kpi-card', { hasText: 'Total Staff' });
    await expect(tile).toBeVisible();
    const shown = Number((await tile.locator('.ed-kpi-val').innerText()).trim());
    expect(shown).toBe(currentOf(rows).length);
  });

  test('the KPI tiles sum to Total Staff', async ({ page }) => {
    await openRegister(page);
    const read = async (label: string) => {
      const card = page.locator('.ed-kpi-card', { hasText: label });
      return (await card.count()) === 0 ? 0 : Number((await card.locator('.ed-kpi-val').innerText()).trim());
    };
    const total = await read('Total Staff');
    const parts = (await read('Active')) + (await read('Probation'))
                + (await read('On Notice')) + (await read('Other'));
    expect(parts).toBe(total);
  });

  test.describe('pagination', () => {
    test('shows a range, a rows-per-page control and numbered pages', async ({ page }) => {
      const rows = await openRegister(page);
      const current = currentOf(rows).length;
      test.skip(current < 2, 'needs at least 2 employees');

      const select = page.locator('#ed-page-size-top');
      await expect(select).toBeVisible();
      await expect(select).toHaveValue('20');
      for (const n of ['10', '20', '50', '100']) {
        await expect(select.locator(`option[value="${n}"]`)).toHaveCount(1);
      }

      // The TOP control must be reachable without scrolling — that is the whole
      // point of duplicating it. Assert it sits above the table, in the filter
      // row, rather than merely existing somewhere on the page.
      const selBox = await select.boundingBox();
      const tableBox = await page.locator('.ed-table').boundingBox();
      expect(selBox!.y, 'rows-per-page must sit above the table').toBeLessThan(tableBox!.y);
      expect(selBox!.y, 'and within the first screen').toBeLessThan(900);

      // "Showing 1–20 of 32", not "Showing 20 of 32".
      const count = page.locator('.ed-table-count');
      await expect(count).toContainText(String(current));
      const text = await count.innerText();
      expect(text).toMatch(/Showing\s+1(–\d+)?\s+of/);
    });

    test('the top and bottom rows-per-page controls stay in step', async ({ page }) => {
      const rows = await openRegister(page);
      test.skip(currentOf(rows).length <= 10, 'needs more than 10 employees to show the bottom bar');

      const top = page.locator('#ed-page-size-top');
      const bottom = page.locator('#ed-page-size-bottom');
      await expect(top).toBeVisible();
      await expect(bottom).toBeVisible();

      // One piece of state behind both, so changing either moves both. Two
      // independent selects would pass a test that only ever drove one of them.
      await top.selectOption('50');
      await expect(bottom).toHaveValue('50');
      await bottom.selectOption('10');
      await expect(top).toHaveValue('10');
      await expect(page.locator('.ed-table tbody tr')).toHaveCount(10);
    });

    test('changing page size preserves the active search and filters', async ({ page }) => {
      const rows = await openRegister(page);
      const current = currentOf(rows);
      const byDept = new Map<string, number>();
      for (const e of current) if (e.department) byDept.set(e.department, (byDept.get(e.department) ?? 0) + 1);
      const dept = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0];
      test.skip(!dept, 'no department has any employees');
      const [name, expected] = dept;

      await page.locator('.ed-select').first().selectOption(name);
      await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);

      // The filtered count must survive a page-size change — resetting the
      // filters would silently widen the export and the bulk selection too.
      await page.locator('#ed-page-size-top').selectOption('50');
      await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);
      await expect(page.locator('.ed-select').first()).toHaveValue(name);
    });

    test('rows per page changes the rows rendered, and 10 always paginates', async ({ page }) => {
      const rows = await openRegister(page);
      const current = currentOf(rows).length;
      test.skip(current <= 10, 'needs more than 10 employees to page');

      await page.locator('#ed-page-size-top').selectOption('10');
      await expect(page.locator('.ed-table tbody tr')).toHaveCount(10);

      // Numbered pages, Previous and Next — all three were missing.
      await expect(page.locator('.ed-page-btn', { hasText: 'Next' })).toBeVisible();
      await expect(page.locator('.ed-page-btn', { hasText: 'Previous' })).toBeVisible();
      await expect(page.locator('.ed-page-btn-current')).toHaveText('1');
      await expect(page.locator('.ed-page-btn', { hasText: /^2$/ })).toBeVisible();

      // Page 2 must hold DIFFERENT people, and its row numbers must continue.
      const firstOnP1 = await page.locator('.ed-table tbody tr .ed-name').first().innerText();
      await page.locator('.ed-page-btn', { hasText: 'Next' }).click();
      await expect(page.locator('.ed-page-btn-current')).toHaveText('2');
      const firstOnP2 = await page.locator('.ed-table tbody tr .ed-name').first().innerText();
      expect(firstOnP2).not.toBe(firstOnP1);
      await expect(page.locator('.ed-table tbody tr .ed-num-label').first()).toHaveText('11');
    });

    test('a filter re-counts and re-pages, rather than filtering one page', async ({ page }) => {
      const rows = await openRegister(page);
      const current = currentOf(rows);
      const byDept = new Map<string, number>();
      for (const e of current) if (e.department) byDept.set(e.department, (byDept.get(e.department) ?? 0) + 1);
      const dept = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0];
      test.skip(!dept, 'no department has any employees');

      const [name, expected] = dept;
      await page.locator('.ed-select').first().selectOption(name);

      // The count must be the FILTERED total, and it must be that total even
      // when it exceeds one page — the failure mode being excluded is filtering
      // the current page's 20 rows and reporting whatever survived.
      await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);
      const perPage = Number(await page.locator('#ed-page-size-top').inputValue());
      await expect(page.locator('.ed-table tbody tr')).toHaveCount(Math.min(expected, perPage));
    });

    test('paging back from beyond the end cannot leave an empty table', async ({ page }) => {
      const rows = await openRegister(page);
      test.skip(currentOf(rows).length <= 10, 'needs more than 10 employees');

      await page.locator('#ed-page-size-top').selectOption('10');
      await page.locator('.ed-page-btn', { hasText: 'Next' }).click();
      await expect(page.locator('.ed-page-btn-current')).toHaveText('2');

      // Narrow hard while sitting on page 2. The old code kept page=2 and sliced
      // rows 10-20 of a 1-row result, rendering an empty tbody under a count
      // that claimed rows existed.
      await page.locator('.ed-search').fill(currentOf(rows)[0].first_name);
      const bodyRows = page.locator('.ed-table tbody tr');
      const empty = page.locator('.ed-empty');
      await expect
        .poll(async () => (await bodyRows.count()) > 0 || (await empty.count()) > 0)
        .toBe(true);
      if (await bodyRows.count() > 0) {
        const shown = await bodyRows.count();
        await expect(page.locator('.ed-table-count')).toContainText(String(shown));
      }
    });
  });

  test.describe('search', () => {
    test('matches every field the placeholder advertises', async ({ page }) => {
      const rows = await openRegister(page);
      const current = currentOf(rows);

      const placeholder = await page.locator('.ed-search').getAttribute('placeholder') ?? '';
      // Nothing may be advertised that is not searched, which is why each claim
      // below is exercised against real data rather than assumed.
      const claims: [string, keyof Employee][] = [
        ['name',    'first_name'],
        ['ID',      'office_id'],
        ['email',   'company_email'],
        ['dept',    'department'],
        ['role',    'designation'],
        ['manager', 'reporting_manager'],
      ];
      for (const [word] of claims) {
        expect(placeholder.toLowerCase(), `placeholder must mention ${word}`)
          .toContain(word.toLowerCase());
      }

      for (const [word, field] of claims) {
        const hit = current.find(e => {
          const v = String(e[field] ?? '').trim();
          return v.length > 2 && !['null', 'undefined'].includes(v.toLowerCase());
        });
        if (!hit) {
          test.info().annotations.push({ type: 'skipped-field', description: `${word}: no usable value in the data` });
          continue;
        }
        const term = String(hit[field]).trim();
        await page.locator('.ed-search').fill(term);
        // The row that provided the term must be among the results.
        const expectedName = `${hit.first_name ?? ''} ${hit.last_name ?? ''}`.trim();
        await expect(
          page.locator('.ed-table tbody tr', { hasText: expectedName }).first(),
          `searching ${word} ("${term}") must find ${expectedName}`,
        ).toBeVisible({ timeout: 10_000 });
      }
      await page.locator('.ed-search').fill('');
    });

    test('searching "null" does not match the rows whose manager is the STRING null', async ({ page }) => {
      const rows = await openRegister(page);
      const sentinel = currentOf(rows).filter(e =>
        String(e.reporting_manager ?? '').trim().toLowerCase() === 'null');
      test.skip(sentinel.length === 0, 'no row holds a literal null manager');

      await page.locator('.ed-search').fill('null');
      // A value that is not really there must not be searchable as if it were.
      const names = sentinel.map(e => `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim());
      for (const n of names) {
        await expect(page.locator('.ed-table tbody tr', { hasText: n })).toHaveCount(0);
      }
    });
  });

  test('status filter cohorts match the KPI tile counts', async ({ page }) => {
    const rows = await openRegister(page);
    const current = currentOf(rows);
    const statusSelect = page.locator('.ed-filter-selects .ed-select').nth(1);

    for (const [option, label] of [['Active', 'Active'], ['Probation', 'Probation'], ['Notice', 'On Notice']]) {
      const expected = current.filter(e => bucketOf(e.status) === option).length;
      if (expected === 0) continue;
      const card = page.locator('.ed-kpi-card', { hasText: label });
      expect(Number((await card.locator('.ed-kpi-val').innerText()).trim())).toBe(expected);
      await statusSelect.selectOption(option);
      await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);
    }
    await statusSelect.selectOption('All');
  });

  test('incomplete records are marked, not silently shown as complete', async ({ page }) => {
    const rows = await openRegister(page);
    const incomplete = currentOf(rows).filter(isIncomplete);
    test.skip(incomplete.length === 0, 'every record is complete — nothing to mark');

    const toggle = page.locator('.ed-incomplete-btn');
    await expect(toggle).toBeVisible();
    await expect(toggle.locator('.ed-incomplete-count')).toHaveText(String(incomplete.length));

    await toggle.click();
    await expect(page.locator('.ed-table-count')).toContainText(`of ${incomplete.length}`);
    // Every visible row carries the badge; none is presented as complete.
    const visible = await page.locator('.ed-table tbody tr').count();
    expect(await page.locator('.ed-table tbody tr .ed-gap-badge').count()).toBe(visible);

    // The badge must NAME what is missing, not just say "Incomplete" — HR cannot
    // act on a record whose defect is unstated.
    const badges = await page.locator('.ed-table tbody tr .ed-gap-badge').allInnerTexts();
    for (const text of badges) {
      expect(text.trim(), 'badge must name a field').not.toBe('');
      expect(
        /Employee ID|Department|Role|Status|Joining date/.test(text),
        `badge "${text}" names no mandatory field`,
      ).toBe(true);
    }

    // And the full list is in the title, for the rows where the visible text is
    // truncated to the first two.
    const title = await page.locator('.ed-table tbody tr .ed-gap-badge').first().getAttribute('title');
    expect(title).toMatch(/missing/i);

    await toggle.click();
  });

  test('the Incomplete count equals the number of rows the filter returns', async ({ page }) => {
    const rows = await openRegister(page);
    const expected = currentOf(rows).filter(isIncomplete).length;

    const toggle = page.locator('.ed-incomplete-btn');
    if (expected === 0) {
      // The control is hidden when there is nothing to show — assert that rather
      // than skipping, so a regression that always hides it is caught.
      await expect(toggle).toHaveCount(0);
      return;
    }
    await expect(toggle.locator('.ed-incomplete-count')).toHaveText(String(expected));
    await toggle.click();
    await expect(page.locator('.ed-table-count')).toContainText(`of ${expected}`);
    await toggle.click();
  });

  test('Incomplete combines with the other filters rather than replacing them', async ({ page }) => {
    const rows = await openRegister(page);
    const toggle = page.locator('.ed-incomplete-btn');
    test.skip(await toggle.count() === 0, 'no incomplete records');

    await toggle.click();
    const incompleteOnly = Number(
      (await page.locator('.ed-table-count').innerText()).match(/of\s+(\d+)/)![1]);

    // Adding a status filter on top must narrow, never widen or reset.
    await page.locator('.ed-filter-selects .ed-select').nth(1).selectOption('Active');
    const combined = Number(
      (await page.locator('.ed-table-count').innerText()).match(/of\s+(\d+)/)![1]);
    expect(combined).toBeLessThanOrEqual(incompleteOnly);
    // Both controls still show as applied.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ed-filter-selects .ed-select').nth(1)).toHaveValue('Active');
  });

  test('Department + Status + Role + Incomplete combine, and the count matches', async ({ page }) => {
    const rows = await openRegister(page);
    const current = currentOf(rows);

    // Pick values that actually co-occur, so the expected count is not trivially
    // zero — a combined-filter test that lands on 0 rows proves nothing.
    const seed = current.find(e => e.department && e.designation);
    test.skip(!seed, 'no employee has both a department and a role');
    const dept = seed!.department!;
    const role = seed!.designation!;
    const status = bucketOf(seed!.status);

    const expectAll = current.filter(e =>
      e.department === dept && e.designation === role && bucketOf(e.status) === status).length;

    const deptSel   = page.locator('.ed-filter-selects .ed-select').nth(0);
    const statusSel = page.locator('.ed-filter-selects .ed-select').nth(1);
    const roleSel   = page.locator('.ed-filter-selects .ed-select').nth(2);

    // One at a time, asserting the count after each — so a filter that silently
    // replaces the previous one instead of narrowing is caught at the step where
    // it happens, not at the end where the total merely looks wrong.
    await deptSel.selectOption(dept);
    const afterDept = current.filter(e => e.department === dept).length;
    await expect(page.locator('.ed-table-count')).toContainText(`of ${afterDept}`);

    await statusSel.selectOption(status);
    const afterStatus = current.filter(e =>
      e.department === dept && bucketOf(e.status) === status).length;
    await expect(page.locator('.ed-table-count')).toContainText(`of ${afterStatus}`);

    await roleSel.selectOption(role);
    await expect(page.locator('.ed-table-count')).toContainText(`of ${expectAll}`);
    expect(expectAll).toBeGreaterThan(0);

    // All three still show as applied — none was reset by the others.
    await expect(deptSel).toHaveValue(dept);
    await expect(statusSel).toHaveValue(status);
    await expect(roleSel).toHaveValue(role);

    // And the fourth: Incomplete narrows the already-narrowed set.
    const toggle = page.locator('.ed-incomplete-btn');
    if (await toggle.count()) {
      const withIncomplete = current.filter(e =>
        e.department === dept && e.designation === role &&
        bucketOf(e.status) === status && isIncomplete(e)).length;
      await toggle.click();
      if (withIncomplete === 0) {
        await expect(page.locator('.ed-empty')).toBeVisible();
      } else {
        await expect(page.locator('.ed-table-count')).toContainText(`of ${withIncomplete}`);
      }
      await toggle.click();
    }

    // Clear puts everything back — including the controls, not just the rows.
    await page.locator('.ed-clear-btn').click();
    await expect(page.locator('.ed-table-count')).toContainText(`of ${current.length}`);
    await expect(deptSel).toHaveValue('All');
    await expect(statusSel).toHaveValue('All');
    await expect(roleSel).toHaveValue('All');
  });

  test('Export states how many rows it will write, and follows the filters', async ({ page }) => {
    const rows = await openRegister(page);
    const current = currentOf(rows).length;
    const exportBtn = page.locator('.plh-cta', { hasText: 'Export' }).first();

    // Unfiltered: the count is the whole register, so "Export" cannot be mistaken
    // for "export everything" when it is not.
    await expect(exportBtn).toContainText(String(current));

    const byDept = new Map<string, number>();
    for (const e of currentOf(rows)) if (e.department) byDept.set(e.department, (byDept.get(e.department) ?? 0) + 1);
    const dept = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!dept) return;
    await page.locator('.ed-select').first().selectOption(dept[0]);
    // Filtered: the label tracks the filtered set, not the full one.
    await expect(exportBtn).toContainText(String(dept[1]));
  });

  test('a bulk status change requires a review step naming who it affects', async ({ page }) => {
    await openRegister(page);
    const firstCheck = page.locator('.ed-table tbody tr .ed-row-check').first();
    test.skip(await firstCheck.count() === 0, 'no rows to select');

    await firstCheck.check();
    await expect(page.locator('.ed-bulk-bar')).toBeVisible();
    await page.locator('.ed-bulk-btn', { hasText: 'Change Status' }).click();

    const modal = page.locator('.ed-modal', { hasText: 'Change Status' });
    await expect(modal).toBeVisible();

    // No exited status is offerable in bulk — a bulk change carries no last
    // working day, so bulk-exiting would create undateable departures.
    const values = await modal.locator('select option').evaluateAll(
      os => os.map(o => (o as HTMLOptionElement).value));
    expect(values.filter(Boolean).sort()).toEqual(['Active', 'Notice', 'Probation']);

    // The first button must REVIEW, never apply. This is the one-click path the
    // review asked to remove.
    await modal.locator('select').selectOption('Notice');
    const review = modal.locator('button', { hasText: /^Review/ });
    await expect(review).toBeVisible();
    await review.click();

    // The confirm step states the new value and lists the affected employees.
    await expect(modal.locator('.ed-modal-newval')).toHaveText('On Notice');
    await expect(modal.locator('.ed-affected-list li')).toHaveCount(1);
    await expect(modal.locator('button', { hasText: /^Set 1 to On Notice$/ })).toBeVisible();

    // Cancellable at the confirm step, and nothing written.
    await modal.locator('.ed-modal-cancel').click();      // Back
    await expect(modal.locator('select')).toBeVisible();
    await modal.locator('.ed-modal-cancel').click();      // Cancel
    await expect(modal).toBeHidden();
  });

  test('hiding a column removes it, and the choice survives a reload', async ({ page }) => {
    await openRegister(page);

    const header = (label: string) =>
      page.locator('.ed-table thead th', { hasText: new RegExp(`^\\s*${label}`) });

    // Manager is on by default, so it is a fair subject for a hide.
    await expect(header('Manager')).toHaveCount(1);

    await page.locator('.ed-col-btn').click();
    const item = page.locator('.ed-col-panel .ed-col-item', { hasText: 'Manager' }).first();
    await expect(item.locator('.ed-col-check-icon.on')).toHaveCount(1);
    await item.click();
    await expect(item.locator('.ed-col-check-icon.on')).toHaveCount(0);
    await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });

    // Gone from the header AND from every body row — a column that disappears
    // from the header while its cells remain shifts every value one column left.
    await expect(header('Manager')).toHaveCount(0);
    const ths = await page.locator('.ed-table thead th').count();
    const tds = await page.locator('.ed-table tbody tr').first().locator('td').count();
    expect(tds).toBe(ths);

    // Persisted: the page writes the set to localStorage, so a reload must not
    // silently restore a column the user turned off.
    await page.reload();
    await expect(page.locator('.ed-table')).toBeVisible({ timeout: 20_000 });
    await expect(header('Manager')).toHaveCount(0);

    // Reset, so the next test starts from the documented defaults rather than
    // from this one's leftovers.
    await page.locator('.ed-col-btn').click();
    await page.locator('.ed-col-reset').click();
    await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });
    await expect(header('Manager')).toHaveCount(1);
  });

  test('the rows-per-page choice survives a reload', async ({ page }) => {
    const rows = await openRegister(page);
    test.skip(currentOf(rows).length <= 10, 'needs more than 10 employees');

    await page.locator('#ed-page-size-top').selectOption('50');
    await page.reload();
    await expect(page.locator('.ed-table')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#ed-page-size-top')).toHaveValue('50');
    await expect(page.locator('#ed-page-size-bottom')).toHaveValue('50');

    // Back to the default so the pagination tests are not affected by ordering.
    await page.locator('#ed-page-size-top').selectOption('20');
  });

  test('the essential columns cannot be turned off', async ({ page }) => {
    await openRegister(page);
    await page.locator('.ed-col-btn').click();
    const labels = await page.locator('.ed-col-panel .ed-col-item-label').allInnerTexts();
    // #, Employee and Actions are `always: true` and must not be offerable — a
    // table with no name column and no actions is unusable, and there would be no
    // way back to it from the panel itself.
    for (const essential of ['Employee', 'Actions']) {
      expect(labels.map(l => l.trim()), `${essential} must not be toggleable`)
        .not.toContain(essential);
    }
    await page.locator('.ed-kpi-row').click({ position: { x: 2, y: 2 } });
  });

  for (const width of [1280, 1440, 1920]) {
    test(`no horizontal PAGE overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openRegister(page);

      await enableAllColumns(page);

      const overflow = await page.evaluate(() => ({
        doc:  document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      // 1px of tolerance for sub-pixel layout rounding.
      expect(overflow.doc, `document scrolls ${overflow.doc}px sideways`).toBeLessThanOrEqual(1);
      expect(overflow.body).toBeLessThanOrEqual(1);

      // The scroll belongs to the TABLE container, which is what keeps the page
      // still — assert it is actually there and actually scrollable.
      const scroller = page.locator('.ed-table-scroll');
      const canScroll = await scroller.evaluate(el => el.scrollWidth > el.clientWidth);
      expect(canScroll, 'every column is on, so the table itself must scroll').toBe(true);

      // Headers must not be clipped, and the header count must match the body.
      const ths = await page.locator('.ed-table thead th').count();
      const tds = await page.locator('.ed-table tbody tr').first().locator('td').count();
      expect(ths).toBe(tds);
      for (const th of await page.locator('.ed-table thead th').all()) {
        const box = await th.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThan(8);
      }

      // The pagination control stays reachable at every width.
      await expect(page.locator('#ed-page-size-top')).toBeVisible();
    });
  }
});
