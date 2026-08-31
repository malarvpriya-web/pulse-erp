import { test } from '@playwright/test';

test('Pulse ERP Menu Audit', async ({ page }) => {

const menus = [
'Home',
'Approvals',
'Analytics & AI',
'Employees',
'HR',
'Learning Center',
'Attendance',
'Leaves',
'Finance',
'Recruitment',
'Talent',
'CRM',
'Sales',
'Marketing',
'Procurement',
'Inventory',
'Production',
'Quality',
'Engineering',
'Projects',
'Operations',
'Timesheets',
'Performance',
'Complaints',
'Service Desk',
'Travel Desk',
'Reports',
'Settings',
'Notifications',
'Org Chart',
'Audit Logs'
];

const failures: string[] = [];

await page.goto('http://localhost:5173/login');

await page.locator('input[type="email"]').click();
await page.keyboard.type('superadmin@pulse.com');

await page.locator('input[type="password"]').click();
await page.keyboard.type('Pulse@123');

await page.getByRole('button', { name: /sign in/i }).click();

await page.waitForTimeout(8000);

console.log('LOGIN URL:', page.url());

for (const menu of menus) {


try {

  console.log('TESTING:', menu);

  const menuLocator = page.getByText(menu, {
    exact: true
  });

  await menuLocator.scrollIntoViewIfNeeded();

  await menuLocator.click({
    timeout: 5000
  });

  await page.waitForTimeout(3000);

  const safeName = menu.replace(/[^a-zA-Z0-9]/g, '_');

  await page.screenshot({
    path: 'audit-' + safeName + '.png',
    fullPage: true
  });

  console.log('PASS:', +menu);

} catch (error) {

  failures.push(menu);

  console.log('FAIL:', menu);

}


}

console.log('========================');
console.log('FAILED MODULES');
console.log('========================');

failures.forEach(item => console.log(item));

});
