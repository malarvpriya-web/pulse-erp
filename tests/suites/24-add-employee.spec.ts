/**
 * Suite 24 — Employees ▸ Add Employee, in a real browser.
 *
 * WHY A BROWSER SUITE AND NOT ONLY UNIT TESTS
 * -------------------------------------------
 * The defect this page was reported for is a LAYOUT defect, and jsdom does no
 * layout. The Department / Designation / Asset Type dropdowns opened as a
 * narrow horizontally-scrolling strip with the option text clipped to two or
 * three characters and scroll-arrow buttons under it. Every one of those
 * pickers rendered the right options, fired the right events and posted the
 * right value — a unit test could not see anything wrong. Only measured boxes
 * can:
 *
 *   • is the menu wider than a few characters?
 *   • does it scroll horizontally?
 *   • is it clipped by the accordion it sits in?
 *   • is the whole of it inside the viewport?
 *
 * ROOT CAUSE, for the record. AddEmployee.css carried
 *     .form-grid div > div { display: flex; gap: 16px; align-items: center; }
 * for an inline radio row. The selector matches EVERY nested div under
 * .form-grid, and MasterSelect's popup is `cell > wrapper > combo > MENU`, so
 * the menu became a horizontal flex row. Compounded by
 * `.accordion { overflow: hidden }`, which clipped whatever stuck out.
 *
 * Only Department (14+ rows), Designation (24) and Asset Type (13) showed it:
 * they are the pickers past MasterSelect's SEARCH_THRESHOLD of 12, so only
 * they take the custom-combobox path. Grade, Band, Qualification (7),
 * Employment Type (9) and Skill Type (3) stay native <select>s, whose popup
 * the OS draws outside the page.
 *
 * WIDTHS. 1280 is the tightest supported desktop and the one where the 4-up
 * grid gives each field ~230px — the width at which the clipping was worst.
 * 1440 is the default in playwright.config.ts. 1920 is the common large
 * monitor, where a menu placed with the wrong containing block goes furthest
 * off-target.
 */

import { test, expect, Page, Locator } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';

const WIDTHS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1280x900', width: 1280, height: 900 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

/** The three pickers the bug was reported for, by the section that holds them. */
const COMBOS = [
  { label: 'Department',  section: 'Job Information',  hook: '[data-master="/master/departments"]' },
  { label: 'Designation', section: 'Job Information',  hook: '[data-master="/master/designations"]' },
  { label: 'Asset Type',  section: 'Assets Allocated', hook: '[data-master^="/master/v/asset-types"]' },
];

async function openAddEmployee(page: Page) {
  await page.goto(`${BASE}/AddEmployee`);
  await expect(page.locator('form.add-employee-form')).toBeVisible({ timeout: 25_000 });
}

/** Open an accordion section by its heading and wait for the body to mount. */
async function openSection(page: Page, heading: string) {
  const header = page.locator('.accordion-header', { hasText: heading }).first();
  await header.click();
  await expect(header.locator('xpath=..').locator('.accordion-body')).toBeVisible();
}

/** The one visible portalled menu, whatever picker opened it. */
const menuOf = (page: Page) => page.locator('[data-master-menu]');

/** Click a combobox input open and hand back the input and its menu. */
async function openCombo(page: Page, hook: string): Promise<{ input: Locator; menu: Locator }> {
  const input = page.locator(`input${hook}`).first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.click();
  const menu = menuOf(page).first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return { input, menu };
}

// ═════════════════════════════════════════════════════════════════════════════
for (const vp of WIDTHS) {
  test.describe(`Add Employee @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the page renders with no console errors and no horizontal overflow', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

      await openAddEmployee(page);
      await openSection(page, 'Job Information');

      // The document must not scroll sideways. A +1 tolerance because a
      // sub-pixel layout can round scrollWidth up by one.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'document scrolls horizontally').toBeLessThanOrEqual(1);

      // React key warnings and the like are noise; a thrown error is not.
      const real = errors.filter(e => !/favicon|ResizeObserver loop|Download the React DevTools/i.test(e));
      expect(real, real.join('\n')).toEqual([]);
    });

    for (const combo of COMBOS) {
      test(`${combo.label} dropdown opens as a readable vertical list`, async ({ page }) => {
        await openAddEmployee(page);
        await openSection(page, combo.section);
        const { input, menu } = await openCombo(page, combo.hook);

        const inputBox = (await input.boundingBox())!;
        const menuBox  = (await menu.boundingBox())!;

        // ── 1. NOT a narrow strip ──────────────────────────────────────────
        // The reported symptom. The menu must be at least as wide as the field
        // it belongs to; the broken one was the field's width with its content
        // laid out sideways inside it.
        expect(menuBox.width, 'menu narrower than its field').toBeGreaterThanOrEqual(inputBox.width - 1);

        // ── 2. NO horizontal scrolling ─────────────────────────────────────
        // This is the scroll-arrow control the report described. scrollWidth
        // exceeding clientWidth is exactly what puts one there.
        const hOverflow = await menu.evaluate(el => el.scrollWidth - el.clientWidth);
        expect(hOverflow, 'menu scrolls horizontally').toBeLessThanOrEqual(1);

        // ── 3. VERTICAL, not horizontal ────────────────────────────────────
        // The direct test of the flex-row bug: consecutive options must be
        // stacked, i.e. each one starts below the previous, not beside it.
        const options = menu.locator('[role="option"]');
        const n = await options.count();
        expect(n, 'no options rendered').toBeGreaterThan(1);

        const boxes = [];
        for (let i = 0; i < Math.min(n, 6); i++) boxes.push((await options.nth(i).boundingBox())!);
        for (let i = 1; i < boxes.length; i++) {
          expect(boxes[i].y, `option ${i} sits beside option ${i - 1}, not below it`)
            .toBeGreaterThan(boxes[i - 1].y + boxes[i - 1].height - 2);
          expect(Math.abs(boxes[i].x - boxes[0].x), `option ${i} is offset horizontally`)
            .toBeLessThanOrEqual(1);
        }

        // ── 4. NO CLIPPED TEXT ─────────────────────────────────────────────
        // Every option must show its whole label: no element wider than its
        // own scroll box, and no rendered text ending in an ellipsis.
        for (let i = 0; i < Math.min(n, 10); i++) {
          const opt = options.nth(i);
          const clipped = await opt.evaluate(el => el.scrollWidth - el.clientWidth);
          const text = (await opt.textContent())?.trim() ?? '';
          expect(clipped, `option "${text}" is clipped`).toBeLessThanOrEqual(1);
          expect(text.length, 'option rendered with no text').toBeGreaterThan(0);
          expect(text, `option "${text}" is truncated`).not.toMatch(/…$|\.\.\.$/);
        }

        // ── 5. INSIDE THE VIEWPORT, and not clipped by the accordion ───────
        expect(menuBox.x, 'menu starts off the left edge').toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width, 'menu runs past the right edge')
          .toBeLessThanOrEqual(vp.width + 1);
        expect(menuBox.y, 'menu starts above the viewport').toBeGreaterThanOrEqual(0);
        expect(menuBox.y + menuBox.height, 'menu runs below the fold')
          .toBeLessThanOrEqual(vp.height + 1);

        // The clipping half of the root cause: the menu must not be a
        // descendant of the accordion, whose `overflow: hidden` would cut it.
        const escaped = await menu.evaluate(el => el.parentElement === document.body);
        expect(escaped, 'menu is still inside the form, so the accordion can clip it').toBe(true);

        // ── 6. IT OVERLAYS what is below it ────────────────────────────────
        // A menu that renders *behind* the next accordion section is as
        // unusable as one that is clipped by it. Ask the browser what is
        // actually on top at the menu's own centre.
        const onTop = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return !!el?.closest('[data-master-menu]');
        }, { x: menuBox.x + menuBox.width / 2, y: menuBox.y + Math.min(20, menuBox.height / 2) });
        expect(onTop, 'something is painted over the menu').toBe(true);
      });

      test(`${combo.label} selects on click, closes, and keeps the value`, async ({ page }) => {
        await openAddEmployee(page);
        await openSection(page, combo.section);
        const { input, menu } = await openCombo(page, combo.hook);

        // Pick a real option — never the "+ Add new…" row, which would write
        // to the master.
        const option = menu.locator('[data-master-option]').first();
        const chosen = (await option.textContent())!.trim();
        await option.click();

        await expect(menu).toHaveCount(0);
        await expect(input).toHaveValue(chosen);

        // …and it survives re-opening and dismissing, which is where a picker
        // that re-derives its label from a mis-typed comparison loses it.
        await input.click();
        await expect(menuOf(page).first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menuOf(page)).toHaveCount(0);
        await expect(input).toHaveValue(chosen);
      });
    }

    test('Location is a searchable dropdown over the branch master', async ({ page }) => {
      // It was a free-text input, which is why employees.location holds
      // 'Srivil', 'Srivi' and 'czxzx' in company 1.
      await openAddEmployee(page);
      await openSection(page, 'Job Information');

      const input = page.locator('input[data-master="/branches"]').first();
      await expect(input, 'Location is not a picker').toBeVisible({ timeout: 15_000 });
      await expect(input).toHaveAttribute('role', 'combobox');
      // The label must actually point at it.
      await expect(page.locator('label[for="ae-location"]')).toHaveText(/Location/);

      await input.click();
      const menu = menuOf(page).first();
      await expect(menu).toBeVisible();
      // Creating a branch needs an address and a code — it belongs on
      // Administration ▸ Branches, not behind a "+" here.
      await expect(menu.locator('[data-master-add]')).toHaveCount(0);
    });

    test('Bank Name is a searchable dropdown with an "Other" path', async ({ page }) => {
      await openAddEmployee(page);
      await openSection(page, 'Bank Details');

      const input = page.locator('input[data-master^="/master/v/banks"]').first();
      await expect(input, 'Bank Name is not a picker').toBeVisible({ timeout: 15_000 });
      await input.click();
      const menu = menuOf(page).first();
      await expect(menu).toBeVisible();

      // Search narrows it…
      await input.fill('hdfc');
      await expect(menu.locator('[data-master-option]')).toHaveCount(1);
      await expect(menu.locator('[data-master-option]').first()).toHaveText('HDFC Bank');

      // …and a bank outside the RBI seed is still reachable, rather than being
      // silently rejected. That is the "Other" mechanism.
      await input.fill('');
      await expect(menu.locator('[data-master-add]')).toHaveCount(1);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Behaviour that does not need repeating at three widths.
test.describe('Add Employee — keyboard, ARIA and form behaviour', () => {
  test('keyboard alone can open, navigate and choose', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');

    const input = page.locator('input[data-master="/master/designations"]').first();
    await input.focus();
    const menu = menuOf(page).first();
    await expect(menu).toBeVisible();          // focus opens it

    await page.keyboard.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant');
    expect(active, 'no active option after ArrowDown').toBeTruthy();
    const label = (await page.locator(`#${active}`).textContent())!.trim();

    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(input).toHaveValue(label);
  });

  test('Escape closes the menu without clearing the field', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();

    await input.click();
    await expect(menuOf(page).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuOf(page)).toHaveCount(0);
    // The input is still focusable and the page has not navigated.
    await expect(input).toBeVisible();
  });

  test('every mandatory field is marked, and the Employee ID is read-only', async ({ page }) => {
    await openAddEmployee(page);

    // Employee ID is generated by the server and must not be typeable.
    const code = page.locator('#ae-employee-id');
    await expect(code).toBeDisabled();
    const value = await code.inputValue();
    // Either a real EMP### preview or an honest placeholder — never a
    // locally-invented code, and never a hyphenated one.
    expect(value, `unexpected Employee ID "${value}"`).toMatch(/^(EMP\d{3,}|Fetching ID…|Assigned on save)$/);
    expect(value).not.toContain('-');

    for (const id of ['ae-first-name', 'ae-last-name', 'ae-company-email']) {
      await expect(page.locator(`label[for="${id}"] .req`), `${id} is not marked required`).toHaveCount(1);
      await expect(page.locator(`#${id}`)).toHaveAttribute('required', '');
    }

    await openSection(page, 'Job Information');
    for (const id of ['ae-department', 'ae-designation', 'ae-joining-date', 'ae-status']) {
      await expect(page.locator(`label[for="${id}"] .req`), `${id} is not marked required`).toHaveCount(1);
    }
  });

  test('a validation failure names the fields, opens the right section, and keeps what was typed', async ({ page }) => {
    await openAddEmployee(page);

    // Type into two sections, then submit with the mandatory ones blank.
    await page.locator('#ae-first-name').fill('Rekha');
    await openSection(page, 'Notes');
    await page.locator('.notes-textarea').fill('Joining via campus drive.');

    await page.locator('button.save-btn').click();

    // The error lands ON the first offending field, and its section is opened.
    await expect(page.locator('#ae-last-name-err')).toBeVisible();
    await expect(page.locator('#ae-last-name-err')).toHaveText(/required/i);

    // ⚠ Nothing the user typed is lost — including the note in a section that
    // is now collapsed, which is where a form that remounts its sections on
    // error drops data silently.
    await expect(page.locator('#ae-first-name')).toHaveValue('Rekha');
    await openSection(page, 'Notes');
    await expect(page.locator('.notes-textarea')).toHaveValue('Joining via campus drive.');

    // Nothing was created.
    await expect(page.locator('form.add-employee-form')).toBeVisible();
  });

  test('the Save button is reachable without scrolling to the bottom of the form', async ({ page }) => {
    // Twelve accordion sections tall. A Save pinned to the end of the document
    // is a Save you have to hunt for.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const btn = page.locator('button.save-btn');
    await expect(btn).toBeInViewport();
  });

  test('no dropdown menu is left behind on the body after use', async ({ page }) => {
    // A portalled node that outlives its picker would swallow clicks over the
    // rest of the page — the failure mode a portal introduces if closing is
    // incomplete.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');

    for (const hook of ['/master/departments', '/master/designations']) {
      const input = page.locator(`input[data-master="${hook}"]`).first();
      await input.click();
      await expect(menuOf(page).first()).toBeVisible();
      await page.keyboard.press('Escape');
    }
    // Click somewhere outside any picker. NOT a field in another accordion
    // section: only one section is open at a time, so #ae-first-name does not
    // exist while Job Information is the open one — an earlier draft of this
    // test timed out on exactly that.
    await page.locator('.accordion-header', { hasText: 'Job Information' }).first().click();
    await expect(page.locator('body > [data-master-menu]')).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Page chrome: exactly one Back button, a title that describes THIS page.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Add Employee — page chrome', () => {
  test('there is exactly ONE Back button, and it is the standard Topbar one', async ({ page }) => {
    // ⚠ Add Employee used to draw its OWN back button under the hero, six
    // pixels below the Topbar's. The Topbar's is the standard control on every
    // Pulse page, so the page-level duplicate was removed — not the Topbar's.
    await openAddEmployee(page);

    const allBack = page.getByRole('button', { name: /back/i });
    await expect(allBack, 'more than one Back control on the page').toHaveCount(1);

    await expect(page.locator('.tb-back-btn'), 'the standard Topbar Back is missing').toHaveCount(1);
    await expect(page.locator('.add-page-back-btn'), 'the page-level duplicate is back').toHaveCount(0);
  });

  test('the Topbar Back returns to the previous page', async ({ page }) => {
    await page.goto(`${BASE}/EmployeesData`);
    await expect(page.locator('.ed-table, .ed-empty')).toBeVisible({ timeout: 25_000 });
    await page.goto(`${BASE}/AddEmployee`);
    await expect(page.locator('form.add-employee-form')).toBeVisible({ timeout: 25_000 });

    await page.locator('.tb-back-btn').click();
    await expect(page).toHaveURL(/EmployeesData/);
  });

  test('the title bar describes Add Employee, not Employee Assets', async ({ page }) => {
    await openAddEmployee(page);
    const hero = page.locator('.plh-hero, .ph-root, [class*="hero"]').first();
    await expect(hero).toContainText(/Add Employee/);
    await expect(hero).toContainText(/Create a new employee record/i);
    await expect(hero).not.toContainText(/Employee Assets/i);
    await expect(hero).not.toContainText(/Manage returns/i);
  });
});

test.describe('Add Employee — accessibility', () => {
  test('every master picker has a label tied to it', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');

    for (const id of ['ae-department', 'ae-designation', 'ae-grade', 'ae-band',
                      'ae-location', 'ae-employment-type', 'ae-skill-type', 'ae-zone']) {
      const label = page.locator(`label[for="${id}"]`);
      await expect(label, `no <label for="${id}">`).toHaveCount(1);
      const control = page.locator(`#${id}`);
      await expect(control, `no control with id ${id}`).toHaveCount(1);
    }
  });

  test('Escape closes the Add-new modal and focus returns to the picker', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    await menuOf(page).first().locator('[data-master-add]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The field is still there and still usable — the modal did not replace it.
    await expect(input).toBeVisible();
    await expect(page.locator('label[for="ae-department"]')).toBeVisible();
  });

  test('no nested buttons anywhere on the form', async ({ page }) => {
    // A button inside a button is invalid HTML that browsers resolve
    // unpredictably, and it makes the inner control unreachable by keyboard.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const nested = await page.locator('button button').count();
    expect(nested, 'a button is nested inside another button').toBe(0);
  });

  test('the required marker is not read aloud as "star"', async ({ page }) => {
    await openAddEmployee(page);
    // The glyph is decorative; `required` on the control carries the meaning.
    const marker = page.locator('label[for="ae-first-name"] .req');
    await expect(marker).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#ae-first-name')).toHaveAttribute('required', '');
  });
});
