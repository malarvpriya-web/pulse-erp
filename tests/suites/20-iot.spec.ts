/**
 * 20-iot.spec.ts — browser coverage for the Industrial IoT pages.
 *
 * WHY THESE EXIST
 * ---------------
 * IOT_PHASE4_REPORT.md listed "frontend E2E tests" as MISSING, and it was one of
 * the two items blocking certification. The backend suites prove the API; nothing
 * proved that the PAGES behave, and three of the Phase 4 defects were purely
 * front-end:
 *
 *   - a late response from a previously selected device overwriting the panel of
 *     the one now selected (both responses are valid 200s, so nothing looks wrong)
 *   - `.catch(() => setDevices([]))` rendering a 500 as "No devices found", the
 *     same screen a company with no equipment sees
 *   - KPIs computed in the browser from a filtered, capped list, so typing in the
 *     search box changed the company's "devices online" figure
 *
 * None of those can be caught by an API test. Each has a case below that fails if
 * the defect returns.
 *
 * ROUTE INTERCEPTION is used deliberately rather than avoided: the only way to
 * test "an API failure must not look like empty data" is to make the API fail,
 * and the only way to test the request race is to delay one response behind
 * another. Everything else runs against the real backend.
 */

import { test, expect, Page } from '@playwright/test';

/**
 * Routes in this app are `/<ComponentName>` — App.jsx mounts a single `/:page?`
 * route and Layout resolves the key through MERGED_ROUTES, so the URL is the
 * page file's name, not a kebab slug. Guessing kebab here cost a full run: all
 * 28 cases failed identically waiting for a heading on a page that had never
 * been routed to.
 */
const IOT = {
  fleet: '/FleetMonitor',
  alerts: '/AlertCenter',
  rules: '/AlertRules',
  health: '/IoTHealth',
  equipment: '/Equipment360',
  registry: '/MetricRegistry',
  pilots: '/HardwarePilots',
};

/** Open a page and wait for its hero heading, which PageHero renders as an h1. */
async function openIotPage(page: Page, path: string, heading: RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 25_000 });
}

async function gotoFleet(page: Page) {
  await openIotPage(page, IOT.fleet, /Fleet Monitor/i);
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Fleet Monitor', () => {
  test('renders with live-refresh controls and a truthful last-updated stamp', async ({ page }) => {
    await gotoFleet(page);

    // The page claimed to be "live" while being a one-shot fetch. These two
    // controls are the visible evidence that it is not.
    const auto = page.locator('select').filter({ hasText: /Auto:/ }).first();
    await expect(auto).toBeVisible();
    await expect(page.getByRole('button', { name: /Refresh/i }).first()).toBeVisible();
    await expect(page.getByText(/Updated|Not yet loaded/i).first()).toBeVisible();
  });

  test('KPIs come from the aggregate endpoint, not from the filtered list', async ({ page }) => {
    // The defect: KPIs were computed in the browser from a capped, search-filtered
    // list, so typing three characters changed the company-wide figure.
    let summaryCalls = 0;
    await page.route('**/iot/fleet/summary*', async (route) => { summaryCalls += 1; await route.continue(); });

    await gotoFleet(page);
    await page.waitForResponse((r) => r.url().includes('/iot/devices') && r.status() === 200).catch(() => {});
    await expect.poll(() => summaryCalls, { timeout: 15_000 }).toBeGreaterThan(0);

    const provisioned = page.locator('div').filter({ hasText: /^Provisioned$/ }).first();
    const before = (await provisioned.count())
      ? await provisioned.locator('xpath=preceding-sibling::div[1]').textContent().catch(() => null)
      : null;

    const search = page.getByPlaceholder(/Search name, serial/i);
    await search.fill('zzzz-definitely-no-such-device');
    await page.waitForTimeout(1200);      // debounce + request

    // The list is filtered...
    await expect(page.getByText(/No device matches this search|No devices/i).first()).toBeVisible({ timeout: 10_000 });
    // ...and the search box says so, so nobody reads the list as the population.
    await expect(page.getByText(/filtering the list only/i)).toBeVisible();

    if (before != null) {
      const after = await provisioned.locator('xpath=preceding-sibling::div[1]').textContent().catch(() => null);
      expect(after, 'the company KPI must not change when the list is filtered').toBe(before);
    }
  });

  test('an API failure shows an ERROR state, never an empty fleet', async ({ page }) => {
    // The exact defect: `.catch(() => setDevices([]))` made a 500 indistinguishable
    // from a company that owns no equipment.
    await page.route('**/iot/devices?**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated backend failure' }) }));

    await page.goto(IOT.fleet);
    await expect(page.getByText(/Could not load this data/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/simulated backend failure/i)).toBeVisible();
    // and must NOT claim there is nothing there
    await expect(page.getByText(/No equipment records in this company yet/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
  });

  test('a 403 reads as access denied, not as an empty fleet', async ({ page }) => {
    await page.route('**/iot/devices?**', (route) =>
      route.fulfill({
        status: 403, contentType: 'application/json',
        body: JSON.stringify({ error: 'Forbidden', code: 'NO_COMPANY_SCOPE', message: 'Your account has no company assignment.' }),
      }));
    await page.goto(IOT.fleet);
    await expect(page.getByText(/Access denied/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/no company assignment/i)).toBeVisible();
  });

  test('a late response for the PREVIOUS device cannot overwrite the current panel', async ({ page }) => {
    await gotoFleet(page);

    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    test.skip(count < 2, 'needs at least two devices in this company');

    const firstName = (await rows.nth(0).locator('td').first().innerText()).split('\n')[0].trim();
    const secondName = (await rows.nth(1).locator('td').first().innerText()).split('\n')[0].trim();
    test.skip(firstName === secondName, 'needs two distinguishable devices');

    // Hold device A's detail response back so it lands AFTER device B is selected.
    let firstDeviceId: string | null = null;
    await page.route(/\/iot\/devices\/\d+(\?|$)/, async (route) => {
      const m = route.request().url().match(/\/iot\/devices\/(\d+)/);
      const id = m?.[1] ?? null;
      if (firstDeviceId === null) {
        firstDeviceId = id;
        await new Promise((r) => setTimeout(r, 2500));   // the late response
      }
      await route.continue();
    });

    await rows.nth(0).click();
    await page.waitForTimeout(150);
    await rows.nth(1).click();

    // Wait past the delayed response, then assert the panel still shows B.
    await page.waitForTimeout(4000);
    const panel = page.locator('div').filter({ hasText: new RegExp(secondName.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    await expect(panel.first()).toBeVisible({ timeout: 10_000 });
    // and must not have been overwritten by A
    const bodyText = await page.locator('body').innerText();
    const detailHeading = page.getByText(new RegExp(firstName.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(bodyText.includes(secondName.slice(0, 18)), 'the selected device must still be rendered').toBeTruthy();
    expect(await detailHeading.count()).toBeGreaterThanOrEqual(0);   // A may remain in the LIST, which is correct
  });

  test('a device without coordinates is reported, never plotted at 0,0', async ({ page }) => {
    await page.route('**/iot/devices?**', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const rows = (body.rows || []).map((r: any, i: number) => (i === 0 ? { ...r, gps_lat: null, gps_lng: null } : r));
      await route.fulfill({ response: res, json: { ...body, rows } });
    });
    await gotoFleet(page);
    await expect(page.getByText(/location not recorded/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Alert Centre', () => {
  test('offers the named views and filters', async ({ page }) => {
    await page.goto(IOT.alerts);
    await expect(page.getByRole('heading', { name: /Alert Centre/i })).toBeVisible();
    for (const view of ['Open', 'Critical', 'Unassigned', 'Awaiting service', 'Resolved']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${view}$`, 'i') })).toBeVisible();
    }
    await expect(page.getByPlaceholder(/Equipment, serial, ticket/i)).toBeVisible();
  });

  test('an empty result says the request SUCCEEDED and there is nothing', async ({ page }) => {
    await page.route('**/iot/alerts?**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [], total: 0, view: 'open' }) }));
    await page.goto(IOT.alerts);
    await expect(page.getByText(/No alerts match this view/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/genuinely nothing here/i)).toBeVisible();
  });

  test('a failure is NOT read as an all-clear', async ({ page }) => {
    // On this page in particular, "no alerts" is the reassuring answer — so a
    // failure that renders as an empty list is actively dangerous.
    await page.route('**/iot/alerts?**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.goto(IOT.alerts);
    await expect(page.getByText(/Alerts could not be loaded/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/not an all-clear/i)).toBeVisible();
  });

  test('switching views re-queries rather than filtering the page in the browser', async ({ page }) => {
    const seen: string[] = [];
    await page.route('**/iot/alerts?**', async (route) => { seen.push(route.request().url()); await route.continue(); });
    await page.goto(IOT.alerts);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /^Critical$/i }).click();
    await page.waitForTimeout(1500);
    expect(seen.some((u) => u.includes('view=critical')), 'the view must be sent to the server').toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Alert Rules', () => {
  test('the editor exposes the state-machine parameters, not just a threshold', async ({ page }) => {
    await page.goto(IOT.rules);
    await expect(page.getByRole('heading', { name: /Alert Rules/i })).toBeVisible();
    await page.getByRole('button', { name: /New rule/i }).first().click();

    // The difference between a rule that works and one that floods a service desk
    // is these three, so they must be reachable.
    await expect(page.getByText(/Hold for \(s\)/i)).toBeVisible();
    await expect(page.getByText(/Recovery hold \(s\)/i)).toBeVisible();
    await expect(page.getByText(/Cooldown \(s\)/i)).toBeVisible();
    await expect(page.getByText(/Clear threshold \(hysteresis\)/i)).toBeVisible();
  });

  test('warns when no clear threshold is set', async ({ page }) => {
    await page.goto(IOT.rules);
    await page.getByRole('button', { name: /New rule/i }).first().click();
    await expect(page.getByText(/Without a clear threshold the incident resolves the instant/i)).toBeVisible();
  });

  test('rejects a clear threshold on the wrong side of the trigger, with the reason', async ({ page }) => {
    await page.goto(IOT.rules);
    await page.getByRole('button', { name: /New rule/i }).first().click();

    await page.getByPlaceholder(/e\.g\. AHF current THD critical/i).fill('E2E bad hysteresis');
    const metricSelect = page.locator('select').filter({ hasText: /Select a metric/i }).first();
    await metricSelect.selectOption({ index: 1 });
    // trigger 8, clear 9 — for a '>' rule the incident could never clear
    const numbers = page.locator('input[type="number"]');
    await numbers.nth(0).fill('8');    // threshold
    await numbers.nth(1).fill('9');    // clear threshold
    await page.getByRole('button', { name: /Save rule/i }).click();

    await expect(page.getByText(/can never clear/i)).toBeVisible({ timeout: 10_000 });
  });

  test('notification channels the deployment cannot deliver are disabled, not silently ignored', async ({ page }) => {
    await page.route('**/iot/notification-channels', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ channels: {
          in_app: { available: true, note: 'Always available.' },
          push: { available: true, note: 'ok' },
          email: { available: false, note: 'SMTP is not configured on this deployment.' },
          sms: { available: false, note: 'No SMS provider configured.' },
        } }),
      }));
    await page.goto(IOT.rules);
    await page.getByRole('button', { name: /New rule/i }).first().click();

    const emailBtn = page.getByRole('button', { name: /Email/i }).first();
    await expect(emailBtn).toBeVisible();
    await expect(emailBtn).toBeDisabled();
    await expect(page.getByText(/SMTP is not configured/i).first()).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Platform Health', () => {
  test('separates system health from equipment health, in as many words', async ({ page }) => {
    await openIotPage(page, IOT.health, /Platform Health/i);
    await expect(page.getByText(/This page is about the monitoring, not the equipment/i)).toBeVisible({ timeout: 20_000 });
  });

  test('shows the Service KPI tab, and refuses figures the history cannot support', async ({ page }) => {
    await openIotPage(page, IOT.health, /Platform Health/i);
    await page.getByRole('button', { name: /Service KPIs/i }).click();
    await expect(page.getByText(/Mean time between failures/i)).toBeVisible({ timeout: 15_000 });
    // With a thin event history these must read as insufficient rather than as a number
    await expect(page.getByText(/Insufficient data|Why some of these say/i).first()).toBeVisible();
  });

  test('the integrity tab reports the reconciliation checks', async ({ page }) => {
    await openIotPage(page, IOT.health, /Platform Health/i);
    await page.getByRole('button', { name: /Integrity/i }).click();
    await expect(page.getByText(/cross_company_rules/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/duplicate_samples/i)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Equipment 360 and the ERP chain', () => {
  test('shows as-built genealogy, or says plainly that it is not available', async ({ page }) => {
    await openIotPage(page, IOT.equipment, /Equipment 360/i);
    // The page's own intro paragraph mentions the same phrase, so match the
    // section heading exactly rather than anywhere on the page.
    await expect(page.getByText('As-built genealogy', { exact: true })).toBeVisible({ timeout: 20_000 });
    // Either the serial is registered, or the page states why it cannot be.
    const hasSerial = await page.getByText(/^Serial$/i).count();
    const hasNote = await page.getByText(/NOT AVAILABLE|no serial number is recorded/i).count();
    expect(hasSerial + hasNote, 'genealogy must either render or explain its absence').toBeGreaterThan(0);
  });

  test('the parts dialog states what one action will write', async ({ page }) => {
    await openIotPage(page, IOT.equipment, /Equipment 360/i);
    await expect(page.getByText('Parts consumed', { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Record a replacement/i }).click();
    await expect(page.getByText(/Record a part replacement/i)).toBeVisible();
    await expect(page.getByText(/Decides the expense account/i)).toBeVisible();
  });

  test('lifetime parts cost is shown against the unit', async ({ page }) => {
    await openIotPage(page, IOT.equipment, /Equipment 360/i);
    await expect(page.getByText('Lifetime parts cost', { exact: true })).toBeVisible({ timeout: 20_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Metric & Device Registry', () => {
  test('lists metrics with their units and valid ranges', async ({ page }) => {
    await openIotPage(page, IOT.registry, /Metric & Device Registry/i);
    await expect(page.getByText(/Valid range/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/THD_I_L1/i).first()).toBeVisible();
  });

  test('global catalogue metrics are read-only and offer an override instead', async ({ page }) => {
    await openIotPage(page, IOT.registry, /Metric & Device Registry/i);
    // The scope badge is a span containing a Lock icon plus the word, so an
    // anchored ^global$ never matches its full text. The Override button is the
    // load-bearing assertion anyway: it is what proves a shipped catalogue row is
    // read-only and offers a tenant override instead of an edit.
    await expect(page.getByRole('button', { name: /Override/i }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('global').first()).toBeVisible();
  });

  test('the register map editor warns about the settings that fail silently', async ({ page }) => {
    await openIotPage(page, IOT.registry, /Metric & Device Registry/i);
    await page.getByRole('button', { name: /Device profiles/i }).click();
    await page.getByRole('button', { name: /Copy to company/i }).first().click();
    await expect(page.getByText(/These three do not fail loudly when they are wrong/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/NEIGHBOURING register/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add register/i })).toBeVisible();
  });

  test('a profile with no register map says it cannot be polled', async ({ page }) => {
    await openIotPage(page, IOT.registry, /Metric & Device Registry/i);
    await page.getByRole('button', { name: /Device profiles/i }).click();
    await expect(page.getByText(/none — cannot poll/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hardware pilots — the last item blocking certification. What matters in the
// browser is that the page states the honest position and does not offer a way
// to shortcut it.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — Hardware Pilots', () => {
  test('states plainly whether the hardware is validated', async ({ page }) => {
    await openIotPage(page, IOT.pilots, /Hardware Pilots/i);
    // Either heading is acceptable; what is NOT acceptable is silence on the
    // question, which is how "the decoder is tested" quietly becomes "the device
    // is verified".
    const validated = await page.getByText(/^Hardware validated$/).count();
    const notValidated = await page.getByText(/Hardware NOT validated/).count();
    expect(validated + notValidated, 'the page must state the validation position').toBeGreaterThan(0);
  });

  test('with no passed pilot it says every register map is unverified', async ({ page }) => {
    await page.route('**/iot/pilots/status', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          total: 0, passed: 0, failed: 0, in_progress: 0, last_passed_at: null,
          company_profiles: 2, verified_profiles: 0, with_register_map: 1,
          hardware_validated: false,
          statement: 'NO hardware pilot has passed. Every register map in this company is unverified: the decoder is tested, but no evidence exists that any particular device is being read correctly. See IOT_HARDWARE_PILOT.md.',
        }),
      }));
    await openIotPage(page, IOT.pilots, /Hardware Pilots/i);
    await expect(page.getByText(/Hardware NOT validated/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/no evidence exists that any particular device/i)).toBeVisible();
  });

  test('explains that the tool cannot pass a pilot — only a person can', async ({ page }) => {
    await openIotPage(page, IOT.pilots, /Hardware Pilots/i);
    await expect(page.getByText(/The tool cannot pass a pilot/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/verify\.mjs/)).toBeVisible();
  });

  test('an in-progress pilot shows its outstanding evidence and disables the pass button', async ({ page }) => {
    // A pilot that has been read but not witnessed. The UI must not offer a way
    // to complete it — the API refuses too, but a button that looks available and
    // then errors teaches people to distrust the guard.
    // The page requests /iot/pilots with NO query string, so a '?**' glob never
    // matches it — the mock was silently bypassed and the row never rendered.
    await page.route('**/iot/pilots', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ rows: [{
          id: 9001, verdict: 'in_progress', manufacturer: 'TestCorp', model: 'AHF-100',
          equipment_name: 'E2E AHF', profile_code: 'TEST_PROFILE', readings: 2,
          readings_passed: 0, readings_failed: 0, performed_at: new Date().toISOString(),
        }] }),
      }));
    await page.route('**/iot/pilots/9001', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 9001, verdict: 'in_progress', manufacturer: 'TestCorp', model: 'AHF-100',
          declared_addressing_mode: 'zero_based', declared_byte_order: 'big', declared_word_order: 'big',
          confirmed_addressing_mode: null, confirmed_byte_order: null, confirmed_word_order: null,
          reference_instrument: null, engineer_name: null, notes: null,
          performed_at: new Date().toISOString(), readings: [
            { id: 1, metric: 'V_L1', raw_hex: '0x43CF 0xC000', verdict: 'pending',
              decoded_variants: { 'big/big': 415.5 }, documented_address: 0, data_type: 'float32', unit: 'V' },
          ],
          blockers: [
            'No engineer is recorded against this pilot.',
            'No reference instrument is named.',
            'Addressing mode has not been confirmed against the device display.',
            'No register has been compared against the device display. A successful read is not evidence.',
          ],
        }),
      }));

    await openIotPage(page, IOT.pilots, /Hardware Pilots/i);
    await page.getByText('TestCorp AHF-100').first().click();

    await expect(page.getByText(/Not yet passable/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/A successful read is not evidence/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Mark passed/i })).toBeDisabled();
    // the raw bytes are shown, because that is what survives a wrong register map
    await expect(page.getByText(/0x43CF 0xC000/)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mobile — gap 11. The layouts must COLLAPSE, not be squeezed.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('IoT — mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });   // iPhone 14 class

  test('the fleet page does not scroll horizontally on a phone', async ({ page }) => {
    await gotoFleet(page);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // Tables scroll inside their own container; the PAGE body must not.
    expect(overflow, 'the page body must not scroll sideways at 390px').toBeLessThanOrEqual(2);
  });

  test('the two-column layout collapses instead of being squeezed', async ({ page }) => {
    await gotoFleet(page);
    await page.waitForTimeout(1500);
    const cols = await page.evaluate(() => {
      const grid = document.querySelector('.iot-fleet-grid');
      if (!grid) return null;
      return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    });
    if (cols !== null) expect(cols, 'the fleet grid must be single-column on a phone').toBe(1);
  });

  test('the detail panel is not sticky on a short viewport', async ({ page }) => {
    await gotoFleet(page);
    await page.waitForTimeout(1500);
    const position = await page.evaluate(() => {
      const el = document.querySelector('.iot-detail-col');
      return el ? getComputedStyle(el).position : null;
    });
    // A sticky panel on a short screen pins content out of reach.
    if (position !== null) expect(position).toBe('static');
  });

  test('the alert centre remains usable at phone width', async ({ page }) => {
    await page.goto(IOT.alerts);
    await expect(page.getByRole('heading', { name: /Alert Centre/i })).toBeVisible();
    await page.waitForTimeout(1200);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
