import { test } from '@playwright/test';

test('Inspect Sidebar', async ({ page }) => {

  await page.goto('http://localhost:5173/login');

  await page.getByRole('textbox', { name: /email/i })
    .fill('superadmin@pulse.com');

  await page.getByRole('textbox', { name: /password/i })
    .fill('Pulse@123');

  await page.getByRole('button', { name: /sign in/i })
    .click();

  await page.waitForTimeout(5000);

  const buttons = await page.locator('button').count();

  const links = await page.locator('a').count();

  const listItems = await page.locator('li').count();

  console.log('Buttons:', buttons);
  console.log('Links:', links);
  console.log('List Items:', listItems);

});