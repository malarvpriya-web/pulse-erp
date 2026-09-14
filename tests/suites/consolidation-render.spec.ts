/**
 * Render check for the role/department consolidation pass.
 *
 * Every page below either lost a duplicate role/department editor or was
 * rewired onto the shared roleCatalog / useDepartments source. A build passing
 * proves nothing here — an emptied page still compiles — so each page is opened
 * for real and asserted to paint its own content with no console error.
 */
import { test, expect, Page } from '@playwright/test';

const PAGES: Array<{ path: string; mustSee: RegExp }> = [
  { path: '/AccessControl',      mustSee: /Access Control/i        },
  { path: '/AdminDashboard',     mustSee: /Operations Dashboard/i  },
  { path: '/MasterSetup',        mustSee: /Master Data Setup/i     },
  { path: '/UserSetup',          mustSee: /User Management/i       },
  { path: '/RolesSetup',         mustSee: /Roles/i                 },
  { path: '/ApproverSetup',      mustSee: /Approver/i              },
  { path: '/SetupNotifications', mustSee: /Notification/i          },
  { path: '/WorkflowBuilder',    mustSee: /Workflow/i              },
  { path: '/SuccessionSettings', mustSee: /Succession|Settings/i   },
  { path: '/Contacts',           mustSee: /Contact/i               },
  { path: '/JobOpenings',        mustSee: /Job Opening/i           },
];

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return errors;
}

for (const { path, mustSee } of PAGES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    // The page painted its own content, not a blank shell or an error boundary.
    await expect(page.locator('body')).toContainText(mustSee, { timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText(/Something went wrong|Cannot read propert/i);

    // Ignore noise the app already emits everywhere (404s on optional widgets).
    const real = errors.filter(e =>
      !/favicon|ResizeObserver|Download the React DevTools|net::ERR_ABORTED/i.test(e));
    expect(real, `console errors on ${path}:\n${real.join('\n')}`).toHaveLength(0);
  });
}

test('role pickers offer the real registry, not a hardcoded subset', async ({ page }) => {
  await page.goto('/ApproverSetup');
  await page.waitForLoadState('networkidle');

  // The role picker lives in the create panel, which opens on demand.
  await page.getByRole('button', { name: /New Config|Add/i }).first().click();

  const select = page.locator('select').filter({ hasText: /Manager|Administrator/i }).first();
  await expect(select).toBeVisible({ timeout: 15_000 });
  const options = await select.locator('option').allTextContents();

  // The phantom codes the hardcoded list used to offer are gone…
  expect(options.join('|')).not.toMatch(/\bceo\b|\bcfo\b/i);
  // …and the registry's granular roles, which it never offered, are present.
  expect(options.join('|')).toMatch(/QC Manager|Store Keeper|Design Engineer/i);
});
