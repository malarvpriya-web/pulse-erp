import { test } from '@playwright/test';

test('Read Sidebar Menu Names', async ({ page }) => {

  await page.goto('http://localhost:5173/login');

  await page.getByRole('textbox', { name: /email/i })
    .fill('superadmin@pulse.com');

  await page.getByRole('textbox', { name: /password/i })
    .fill('Pulse@123');

  await page.getByRole('button', { name: /sign in/i })
    .click();

  await page.waitForTimeout(5000);

  const items = await page.locator('li').allTextContents();

  console.log(items);

});