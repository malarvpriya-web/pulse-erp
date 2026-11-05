/**
 * Suite 25 — Administration ▸ Master Data, and the "+ Add new…" round trip.
 *
 * THE CLAIM THIS SUITE EXISTS TO PROVE
 * ------------------------------------
 * "No master value can be created from the Add Employee form that HR cannot
 * find and manage afterwards." That is an INTEGRATION claim spanning two
 * screens and the API between them, and neither half can prove it alone:
 *
 *   - a unit test can prove MasterSelect POSTs to the canonical endpoint, but
 *     not that the value then appears on the management screen;
 *   - an API test can prove both endpoints read the same table, but not that
 *     the management screen actually renders a tab for that master.
 *
 * So this creates a value from the employee form and then goes and finds it in
 * Administration ▸ Master Data, renames it, checks its usage count, retires it,
 * confirms Add Employee stops offering it, and brings it back.
 *
 * ⚠ It creates real master rows. Every one is prefixed `ZZ Test ` and removed
 * at the end, and the suite only ever touches rows it created — it never
 * renames or retires a value the business uses.
 */

import { test, expect, Page, Locator } from '@playwright/test';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';

/** Unique per run, so a crashed run cannot collide with the next one. */
const STAMP = Date.now().toString().slice(-6);
const DEPT = `ZZ Test Dept ${STAMP}`;
const DEPT_RENAMED = `ZZ Test Dept ${STAMP} R`;

const menuOf = (page: Page) => page.locator('[data-master-menu]');

async function openAddEmployee(page: Page) {
  await page.goto(`${BASE}/AddEmployee`);
  await expect(page.locator('form.add-employee-form')).toBeVisible({ timeout: 25_000 });
}

async function openSection(page: Page, heading: string) {
  const header = page.locator('.accordion-header', { hasText: heading }).first();
  await header.click();
  await expect(header.locator('xpath=..').locator('.accordion-body')).toBeVisible();
}

/**
 * The EMPLOYEE master-management screen.
 *
 * ⚠ /EmployeeMasters, not /MasterSetup. As of 2026-09-29 each master has ONE
 * place it is managed from: the employee masters live under
 * Employees → Manage Employee Masters, and the Settings view excludes them.
 * Same component, same endpoints — two scoped doors, no duplication.
 */
async function openMasterData(page: Page) {
  await page.goto(`${BASE}/EmployeeMasters`);
  await expect(page.locator('.ms-tabs').first()).toBeVisible({ timeout: 25_000 });
}

/** The SETTINGS view, which now holds only the non-employee masters. */
async function openSettingsMasters(page: Page) {
  await page.goto(`${BASE}/MasterSetup`);
  await expect(page.locator('.ms-tabs').first()).toBeVisible({ timeout: 25_000 });
}

/** Switch to a tab by its visible label. */
async function masterTab(page: Page, label: string) {
  await page.locator('.ms-tab', { hasText: new RegExp(`^${label}$`) }).first().click();
  await expect(page.locator('.ms-card')).toBeVisible();
}

/** The Master Data row whose name matches, after searching for it. */
async function findRow(page: Page, name: string): Promise<Locator> {
  await page.locator('.ms-search-input').fill(name);
  const row = page.locator('.ms-item', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  return row;
}

/**
 * An authenticated API call.
 *
 * ⚠ `page.request` does NOT carry this app's credentials. Auth is a bearer
 * token in localStorage (see tests/auth.setup.ts), not a cookie, so an
 * APIRequestContext call goes out unauthenticated and comes back with an error
 * OBJECT where the test expected an array — `rows.some is not a function`
 * rather than a clean 401. The token has to be read out of the page and passed
 * explicitly.
 */
async function apiGet(page: Page, path: string) {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `${path} -> ${res.status()}`).toBe(true);
  return res.json();
}

async function apiDelete(page: Page, path: string) {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  return page.request.delete(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Teardown, as an afterAll rather than a final test.
 *
 * ⚠ It was a test at the end of a `mode: 'serial'` describe, and that is a trap:
 * when an earlier case in a serial block fails, every later one is SKIPPED —
 * including the cleanup. Two runs of this suite failed early and left
 * `ZZ Test Dept <stamp>` rows in the live department master, while the run
 * reported only the original failure. An afterAll runs whatever happened.
 *
 * ⚠ `browser.newPage()` carries NO storageState, so a context has to be made
 * explicitly — otherwise teardown 401s and reports clean while leaving rows
 * behind. Same trap as [[project_master_data_vocabulary_registry]].
 *
 * It sweeps the whole `ZZ Test Dept ` prefix, not just this run's stamp, so a
 * run also clears debris an earlier crashed run left.
 */
test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'tests/.auth/user.json' });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/MasterSetup`);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const res = await page.request.get(`${BASE}/api/master/departments?include_inactive=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok()) {
      for (const r of await res.json()) {
        if (r.id != null && String(r.name).startsWith('ZZ Test Dept ')) {
          await page.request.delete(`${BASE}/api/master/departments/${r.id}?hard=1`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      }
    }
  } finally {
    await ctx.close();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('Master Data — the management screen', () => {
  test('every employee master has a tab', async ({ page }) => {
    // The gap this whole pass was about: a master that Add Employee can write
    // but nothing can govern.
    await openMasterData(page);
    const normalised = (await page.locator('.ms-tab').allTextContents()).map(t => t.trim().toLowerCase());

    for (const expected of [
      'departments', 'designations', 'grades', 'bands', 'zones',
      'employment type', 'asset type', 'bank', 'qualification', 'skill type',
    ]) {
      expect(normalised, `no tab for ${expected}`).toContain(expected);
    }
  });

  test('ONE canonical place — Settings no longer duplicates the employee masters', async ({ page }) => {
    // ⚠ The same screen, scoped two ways. Settings keeps the masters other
    // modules own (Units, HSN/SAC, industries…) and points at Employees for
    // the rest, so no master is managed from two places.
    await openSettingsMasters(page);
    const normalised = (await page.locator('.ms-tab').allTextContents()).map(t => t.trim().toLowerCase());

    for (const gone of ['departments', 'designations', 'grades', 'bands', 'zones',
                        'employment type', 'asset type', 'bank', 'qualification', 'skill type']) {
      expect(normalised, `${gone} is still duplicated in Settings`).not.toContain(gone);
    }
    // …and the masters other modules own are untouched.
    for (const kept of ['units (uom)', 'hsn / sac', 'industry']) {
      expect(normalised, `Settings lost ${kept}`).toContain(kept);
    }

    // It says where the employee masters went, and the link works.
    await expect(page.locator('.ms-note-elsewhere')).toContainText(/Employee masters/i);
    await page.getByRole('button', { name: /Open Employee Masters/i }).click();
    await expect(page).toHaveURL(/EmployeeMasters/);
  });

  test('search narrows the list', async ({ page }) => {
    await openMasterData(page);
    await masterTab(page, 'Departments');
    const before = await page.locator('.ms-item').count();
    expect(before).toBeGreaterThan(1);

    await page.locator('.ms-search-input').fill('engineering');
    await expect(page.locator('.ms-item')).toHaveCount(1);
    await expect(page.locator('.ms-item').first()).toContainText(/engineering/i);

    // Normalised: lower-case input finds the capitalised value, which is the
    // same rule the duplicate guard and the usage count use.
    await page.locator('.ms-search-input').fill('ENGINEERING');
    await expect(page.locator('.ms-item')).toHaveCount(1);

    await page.locator('.ms-search-input').fill('zzzz-no-such-department');
    await expect(page.locator('.ms-item')).toHaveCount(0);
    await expect(page.locator('.ms-empty')).toContainText(/no department matches/i);
  });

  test('every row states its status and usage in words', async ({ page }) => {
    // "Engineering / Active · Used by 8 employees" — the two halves of "can I
    // safely change this?", together, rather than a badge reading "8 uses".
    await openMasterData(page);
    await masterTab(page, 'Departments');
    const row = page.locator('.ms-item').first();
    await expect(row.locator('.ms-status-word')).toHaveText(/^(Active|Inactive)$/);
    await expect(row.locator('.ms-status')).toContainText(/Used by \d+ |Not used anywhere/);
    await expect(row.locator('.ms-item-meta')).toContainText(/Added \d{2} [A-Z][a-z]{2} \d{2}/);
  });

  test('Delete and Deactivate are separate, and Delete is disabled when in use', async ({ page }) => {
    // ⚠ The brief's rule: never silently turn Delete into Deactivate. Both
    // buttons are always present; Delete is DISABLED (not hidden) with a title
    // saying why, so the user learns the rule rather than losing the control.
    await openMasterData(page);
    await masterTab(page, 'Departments');

    const used = page.locator('.ms-item').filter({ hasText: /Used by \d+/ }).first();
    await expect(used, 'no department is in use — fixture assumption broken').toBeVisible();
    await expect(used.locator('.ms-btn-delete')).toBeDisabled();
    await expect(used.locator('.ms-btn-delete')).toHaveAttribute(
      'title', /currently used by .*Deactivate it instead/i);
    await expect(used.locator('.ms-btn-deactivate')).toBeEnabled();
    await expect(used.locator('.ms-btn-edit')).toBeEnabled();

    const unused = page.locator('.ms-item').filter({ hasText: /Not used anywhere/ }).first();
    if (await unused.count()) {
      await expect(unused.locator('.ms-btn-delete')).toBeEnabled();
      await expect(unused.locator('.ms-btn-deactivate')).toBeEnabled();
    }
  });

  test('Branches is a pointer to the Branches screen, not a name editor', async ({ page }) => {
    // Branches live in the SETTINGS view — a branch is an entity, not an
    // employee vocabulary, so it is not on the Employee Masters screen.
    await openSettingsMasters(page);
    await masterTab(page, 'Branches / Locations');
    await expect(page.locator('.ms-card')).toContainText(/Locations are managed as Branches/i);
    // The tab names the real path, hop by hop, so it can be followed by hand.
    await expect(page.locator('.ms-card')).toContainText(/Settings → Company Setup → Branch Management/);
    await page.getByRole('button', { name: /open branch management/i }).click();
    await expect(page).toHaveURL(/BranchManagement/);
    await expect(page.locator('input[aria-label="Search branches"]')).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('"+ Add new" from Add Employee reaches Master Data', () => {
  test.describe.configure({ mode: 'serial' });   // the cases build on each other

  test('the option is visually separated from the real values', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    const menu = menuOf(page).first();
    await expect(menu).toBeVisible();

    const add = menu.locator('[data-master-add]');
    await expect(add).toHaveCount(1);
    // A separator rule and its own colour, so it does not read as a department.
    const sep = await add.evaluate(el => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(sep)).toBeGreaterThan(0);
    // It is the LAST option, after every real value.
    const opts = menu.locator('[role="option"]');
    const last = opts.nth((await opts.count()) - 1);
    await expect(last).toHaveAttribute('data-master-add', '/master/departments');
  });

  test('clicking it opens a modal, and saving selects the new value', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    await menuOf(page).first().locator('[data-master-add]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The 2026-09-29 wording. Title and submit button both read "Add
    // Department" — an imperative the user can act on, not a noun phrase.
    await expect(dialog).toHaveAttribute('aria-label', 'Add Department');
    await expect(dialog.locator('strong').first()).toHaveText('Add Department');
    await expect(dialog.getByLabel(/^Department Name/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Cancel$/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Add Department$/ })).toBeVisible();

    // It is an ADD dialog, not an admin screen: no editing of existing values.
    for (const forbidden of [/rename/i, /delete/i, /deactivate/i]) {
      await expect(dialog.getByRole('button', { name: forbidden })).toHaveCount(0);
    }

    // …and a real, clickable "Manage Departments →" control.
    await expect(dialog.getByRole('button', { name: /Manage Departments/i })).toBeVisible();

    // ⚠ The picker must still be in the form behind the modal. The previous
    // inline-row version REPLACED it, so the field and its required marker
    // vanished mid-edit.
    await expect(page.locator('label[for="ae-department"]')).toBeVisible();

    await dialog.getByLabel(/department/i).fill(DEPT);
    await dialog.getByRole('button', { name: /add department/i }).click();

    await expect(dialog).toBeHidden();
    // Auto-selected, not merely created.
    await expect(input).toHaveValue(DEPT);
    // …and a success message that names the value.
    await expect(page.getByText(new RegExp(`${DEPT} added successfully`, 'i'))).toBeVisible();
  });

  test('a duplicate is refused inside the modal, with the reason', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    await menuOf(page).first().locator('[data-master-add]').click();

    const dialog = page.getByRole('dialog');
    // A case variant of what the previous case created.
    await dialog.getByLabel(/department/i).fill(DEPT.toUpperCase());
    await dialog.getByRole('button', { name: /add department/i }).click();

    await expect(dialog.getByRole('alert')).toContainText(/already a department/i);
    await expect(dialog.getByRole('alert')).toContainText(/ignoring case and spacing/i);
    // Still open, so the value can be corrected rather than retyped.
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
  });

  test('Escape closes the modal without creating anything', async ({ page }) => {
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    await menuOf(page).first().locator('[data-master-add]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/department/i).fill('ZZ Test Never Saved');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const rows = await apiGet(page, '/api/master/departments?include_inactive=1');
    expect(rows.some((r: { name: string }) => r.name === 'ZZ Test Never Saved')).toBe(false);
  });

  test('the new value is on the Master Data screen, and can be renamed there', async ({ page }) => {
    // The whole point: nothing created from the employee form is orphaned.
    await openMasterData(page);

    // ⚠ Confirm via the API FIRST. This case depends on the previous one's
    // side effect, so a bare DOM miss is ambiguous — "the create did not
    // happen" and "the screen does not show it" look identical, and only the
    // second is a defect in what this case is testing.
    const rows = await apiGet(page, '/api/master/departments?include_inactive=1');
    const made = rows.find((r: { name: string }) => r.name === DEPT);
    expect(made, `"${DEPT}" was never created by the previous case`).toBeTruthy();
    expect(made.is_active, `"${DEPT}" exists but is retired`).not.toBe(false);

    await masterTab(page, 'Departments');
    const row = await findRow(page, DEPT);
    // Nobody uses it yet, so the status line says so and Delete is available.
    await expect(row.locator('.ms-status')).toContainText(/Active/);
    await expect(row.locator('.ms-status')).toContainText(/Not used anywhere/);
    await expect(row.locator('.ms-btn-delete')).toBeEnabled();

    await row.locator('.ms-btn-edit').click();
    const editor = page.locator('.ms-input-inline');
    await editor.fill(DEPT_RENAMED);
    await page.locator('.ms-btn-save').click();

    await expect(page.locator('.ms-toast-success')).toBeVisible();
    await findRow(page, DEPT_RENAMED);
  });

  test('retiring it removes it from Add Employee', async ({ page }) => {
    await openMasterData(page);
    await masterTab(page, 'Departments');
    const row = await findRow(page, DEPT_RENAMED);

    // Unused, so the button offers a real delete — deactivate it through the
    // API instead, which is the path a USED value takes, so the assertion below
    // is about retirement rather than removal.
    const rows = await apiGet(page, '/api/master/departments?include_inactive=1');
    const id = rows.find((r: { name: string }) => r.name === DEPT_RENAMED)?.id;
    expect(id, 'the renamed department is not in the master').toBeTruthy();
    const off = await apiDelete(page, `/api/master/departments/${id}`);
    expect(off.ok()).toBe(true);
    expect((await off.json()).deleted).toBe('deactivated');
    await expect(row).toBeTruthy();

    // Add Employee must no longer offer it.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    const menu = menuOf(page).first();
    await expect(menu).toBeVisible();
    await expect(menu.locator(`[data-master-option="${DEPT_RENAMED}"]`)).toHaveCount(0);
  });

  test('…and Master Data can still see it and bring it back', async ({ page }) => {
    await openMasterData(page);
    await masterTab(page, 'Departments');

    // Hidden by default even here — the common task is the live list.
    await page.locator('.ms-search-input').fill(DEPT_RENAMED);
    await expect(page.locator('.ms-item')).toHaveCount(0);

    await page.locator('.ms-toggle input').check();
    const row = page.locator('.ms-item', { hasText: DEPT_RENAMED }).first();
    await expect(row).toBeVisible();
    // Retired: the status line says Inactive, and the only actions are Edit
    // and Reactivate — re-deleting something already switched off is not a
    // thing anyone wants.
    await expect(row.locator('.ms-status-word')).toHaveText('Inactive');
    await expect(row.locator('.ms-btn-reactivate')).toBeVisible();
    await expect(row.locator('.ms-btn-delete')).toHaveCount(0);

    await row.getByRole('button', { name: /reactivate/i }).click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    // Selectable again on Add Employee.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/master/departments"]').first();
    await input.click();
    await expect(menuOf(page).first().locator(`[data-master-option="${DEPT_RENAMED}"]`)).toHaveCount(1);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('the dropdown stays correct at every width', () => {
  for (const vp of [
    { name: '1280', width: 1280, height: 800 },
    { name: '1440', width: 1440, height: 900 },
    { name: '1920', width: 1920, height: 1080 },
  ]) {
    test(`the add modal fits and the menu is unbroken @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openAddEmployee(page);
      await openSection(page, 'Job Information');

      const input = page.locator('input[data-master="/master/designations"]').first();
      await input.click();
      const menu = menuOf(page).first();
      await expect(menu).toBeVisible();

      // The regression fence from suite 24 — the modal work must not have
      // reintroduced the horizontal strip.
      const hOverflow = await menu.evaluate(el => el.scrollWidth - el.clientWidth);
      expect(hOverflow, 'menu scrolls horizontally').toBeLessThanOrEqual(1);
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);

      await menu.locator('[data-master-add]').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const d = (await dialog.boundingBox())!;
      expect(d.x, 'modal runs off the left').toBeGreaterThanOrEqual(0);
      expect(d.x + d.width, 'modal runs off the right').toBeLessThanOrEqual(vp.width + 1);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y + d.height, 'modal runs below the fold').toBeLessThanOrEqual(vp.height + 1);

      // And the page itself still does not scroll sideways.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// "Where do I edit this?" — the deep link, end to end.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Manage links land on the right tab', () => {
  for (const c of [
    { endpoint: '/master/departments',      section: 'Job Information',  link: 'Manage Departments',      tab: 'Departments' },
    { endpoint: '/master/designations',     section: 'Job Information',  link: 'Manage Designations',     tab: 'Designations' },
    { endpoint: '/master/v/employment-types', section: 'Job Information', link: 'Manage Employment Types', tab: 'Employment Type' },
    { endpoint: '/master/v/banks',          section: 'Bank Details',     link: 'Manage Banks',            tab: 'Bank' },
    { endpoint: '/master/v/asset-types',    section: 'Assets Allocated', link: 'Manage Asset Types',      tab: 'Asset Type' },
  ]) {
    test(`${c.link} opens its own Master Data tab`, async ({ page }) => {
      // ⚠ The whole point: NOT a generic Master Data landing page. A
      // destination with 24 tabs is not an answer to "where do I edit this?".
      await openAddEmployee(page);
      await openSection(page, c.section);

      const input = page.locator(`input[data-master^="${c.endpoint}"]`).first();
      await expect(input, `${c.endpoint} is not a searchable picker`).toBeVisible({ timeout: 15_000 });
      await input.click();
      await menuOf(page).first().locator('[data-master-add]').click();

      const dialog = page.getByRole('dialog');
      const manage = dialog.getByRole('button', { name: new RegExp(c.link, 'i') });
      await expect(manage).toBeVisible();
      await manage.click();

      // ⚠ EmployeeMasters, not MasterSetup: HR manages these from the
      // Employees area, not from an administrator's Settings menu.
      await expect(page).toHaveURL(/EmployeeMasters\?tab=/);
      // …and the tab it landed on is the ACTIVE one, not merely present.
      await expect(page.locator('.ms-tab-active')).toHaveText(new RegExp(c.tab, 'i'));
    });
  }

  test('the Location picker links to Branches, and offers no "+ Add new"', async ({ page }) => {
    // A branch is an entity with a code, an address and contact details. It is
    // not a vocabulary, so it is not creatable from here.
    await openAddEmployee(page);
    await openSection(page, 'Job Information');
    const input = page.locator('input[data-master="/branches"]').first();
    await input.click();
    const menu = menuOf(page).first();
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-master-add]')).toHaveCount(0);

    const manage = page.getByRole('button', { name: /Manage Locations/i });
    await expect(manage).toBeVisible();
    await manage.click();
    await expect(page).toHaveURL(/BranchManagement/);
    await expect(page.locator('input[aria-label="Search branches"]')).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// State loss while typing — the exact regression from the in-render <Field> bug.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('typing in one field does not disturb another', () => {
  test('selection, search text and success message all survive', async ({ page }) => {
    // ⚠ THE BUG THIS GUARDS. `Field` was declared inside AddEmployee's render
    // body, so it was a new component type every render and React remounted
    // every field on every keystroke: each MasterSelect refetched, lost its
    // menu, lost its search text and lost the success message it had just set.
    // The unit test for that message PASSED — an isolated render has no parent
    // re-render — so only this level catches it.
    const requests: string[] = [];
    page.on('request', r => {
      if (/\/api\/master\/departments/.test(r.url())) requests.push(r.url());
    });

    await openAddEmployee(page);
    await openSection(page, 'Job Information');

    const dept = page.locator('input[data-master="/master/departments"]').first();
    await expect(dept).toBeVisible({ timeout: 15_000 });

    // 1-3. Open, search, select.
    await dept.click();
    await dept.fill('eng');
    const menu = menuOf(page).first();
    await expect(menu.locator('[data-master-option]').first()).toContainText(/eng/i);
    const picked = (await menu.locator('[data-master-option]').first().textContent())!.trim();
    await menu.locator('[data-master-option]').first().click();
    await expect(dept).toHaveValue(picked);

    const afterSelect = requests.length;

    // 4. Type a full name in ANOTHER section's field.
    await openSection(page, 'Basic Information');
    const first = page.locator('#ae-first-name');
    await first.click();
    await first.pressSequentially('Rajalakshmi', { delay: 15 });
    await expect(first).toHaveValue('Rajalakshmi');

    // ⚠ No refetch storm. A remount per keystroke meant one GET per character.
    expect(requests.length - afterSelect,
      `department master refetched ${requests.length - afterSelect} times while typing 11 characters`)
      .toBeLessThanOrEqual(1);

    // 5-6. Reopen Department — the selection is still there.
    await openSection(page, 'Job Information');
    await expect(page.locator('input[data-master="/master/departments"]').first()).toHaveValue(picked);

    // 7-8. Add a new department; the success message appears and stays.
    const NEW = `ZZ Test Dept ${Date.now().toString().slice(-6)}`;
    const dept2 = page.locator('input[data-master="/master/departments"]').first();
    await dept2.click();
    await menuOf(page).first().locator('[data-master-add]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Department Name/).fill(NEW);
    await dialog.getByRole('button', { name: /^Add Department$/ }).click();
    await expect(dialog).toBeHidden();

    const success = page.getByText(new RegExp(`${NEW} added successfully`, 'i'));
    await expect(success).toBeVisible();

    // 9. The new value is selected.
    await expect(dept2).toHaveValue(NEW);

    // 10. Keep typing elsewhere — the success message must NOT be torn down.
    await openSection(page, 'Basic Information');
    await page.locator('#ae-last-name').pressSequentially('Iyer', { delay: 15 });
    await openSection(page, 'Job Information');
    await expect(page.locator('input[data-master="/master/departments"]').first()).toHaveValue(NEW);

    // Clean up the department this case created.
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const rows = await (await page.request.get(`${BASE}/api/master/departments?include_inactive=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const made = rows.find((r: { name: string }) => r.name === NEW);
    if (made?.id) {
      await page.request.delete(`${BASE}/api/master/departments/${made.id}?hard=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// Employee Masters — the HR door into the same management screen.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('Employee Masters is reachable from Employees', () => {
  test('All Employees offers "Manage Employee Masters"', async ({ page }) => {
    await page.goto(`${BASE}/EmployeesData`);
    await expect(page.locator('.ed-table, .ed-empty')).toBeVisible({ timeout: 25_000 });

    const btn = page.getByRole('button', { name: /Manage Employee Masters/i });
    await expect(btn, 'no Manage Employee Masters action on All Employees').toBeVisible();
    await btn.click();
    await expect(page).toHaveURL(/EmployeeMasters/);
    await expect(page.locator('.plh-hero, [class*="hero"]').first()).toContainText(/Employee Masters/);
  });

  test('it shows the employee masters and nothing else', async ({ page }) => {
    await page.goto(`${BASE}/EmployeeMasters`);
    await expect(page.locator('.ms-tabs').first()).toBeVisible({ timeout: 25_000 });
    const tabs = (await page.locator('.ms-tab').allTextContents()).map(x => x.trim().toLowerCase());

    for (const expected of ['departments', 'designations', 'grades', 'bands', 'zones',
                            'employment type', 'asset type', 'bank', 'qualification', 'skill type']) {
      expect(tabs, `no tab for ${expected}`).toContain(expected);
    }
    // Items & Tax masters belong to Settings, not to HR.
    for (const absent of ['units (uom)', 'hsn / sac', 'industry']) {
      expect(tabs, `${absent} should not be here`).not.toContain(absent);
    }
    // Branch is an entity with its own screen.
    expect(tabs).not.toContain('branches / locations');
  });

  test('it is the SAME screen — add, edit, deactivate, reactivate, delete', async ({ page }) => {
    // ⚠ Proves no second implementation: the same controls, on the same rows,
    // with the same usage-aware delete rule.
    const NAME = `ZZ Test Dept ${Date.now().toString().slice(-6)}`;
    await page.goto(`${BASE}/EmployeeMasters?tab=departments`);
    await expect(page.locator('.ms-card')).toBeVisible({ timeout: 25_000 });
    // ⚠ Assert the TAB before touching anything. This case adds and then
    // DELETES a master value; if the deep link ever failed and left another
    // tab active, it would be creating and deleting rows in the wrong master.
    await expect(page.locator('.ms-tab-active')).toHaveText(/^Departments$/);

    await page.locator('.ms-add-row .ms-input').fill(NAME);
    await page.locator('.ms-btn-add').click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    await page.locator('.ms-search-input').fill(NAME);
    const row = page.locator('.ms-item', { hasText: NAME }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('.ms-status')).toContainText(/Active/);
    await expect(row.locator('.ms-status')).toContainText(/Not used anywhere/);

    await row.locator('.ms-btn-edit').click();
    await page.locator('.ms-input-inline').fill(`${NAME} R`);
    await page.locator('.ms-btn-save').click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    await page.locator('.ms-search-input').fill(`${NAME} R`);
    const row2 = page.locator('.ms-item', { hasText: `${NAME} R` }).first();
    await row2.locator('.ms-btn-deactivate').click();
    // ⚠ Scoped to the dialog. A bare getByRole matches the ROW's Deactivate
    // button too, and Playwright's strict mode fails on two matches.
    await page.getByRole('dialog').getByRole('button', { name: /^Deactivate$/ }).click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    await page.locator('.ms-toggle input').check();
    await page.locator('.ms-search-input').fill(`${NAME} R`);
    const retired = page.locator('.ms-item', { hasText: `${NAME} R` }).first();
    await expect(retired.locator('.ms-status-word')).toHaveText('Inactive');
    await retired.locator('.ms-btn-reactivate').click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    await page.locator('.ms-search-input').fill(`${NAME} R`);
    const live = page.locator('.ms-item', { hasText: `${NAME} R` }).first();
    await expect(live.locator('.ms-btn-delete')).toBeEnabled();
    await live.locator('.ms-btn-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: /^Delete$/ }).click();
    await expect(page.locator('.ms-toast-success')).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const rows = await (await page.request.get(`${BASE}/api/master/departments?include_inactive=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    expect(rows.some((r: { name: string }) => r.name === `${NAME} R`)).toBe(false);
  });
});
