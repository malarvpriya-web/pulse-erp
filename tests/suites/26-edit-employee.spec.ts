/**
 * Suite 26 — Employees ▸ Edit Employee, in a real browser against the live API.
 *
 * Edit Employee is the Add Employee form in edit mode (EditEmployee.jsx is a
 * loader). The jsdom suite (frontend editEmployeeParity.test.jsx) proves the
 * two screens render the same fields; this one proves the round trip on the
 * running stack: open Edit from All Employees, change fields in several
 * sections — including a CLEAR, a salary CORRECTION and a document REMOVAL —
 * save, read the database, then REOPEN Edit and see the saved values.
 *
 * The fixture employee is inserted by SQL (no login account, so nothing else
 * is created) in the signed-in user's company and deleted in afterAll.
 * ⚠ Do not run the backend vitest suite at the same time: shared database.
 */
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BASE = process.env.PULSE_FRONT_BASE ?? 'http://localhost:5173';
const BACKEND = path.resolve(__dirname, '../../backend');
const CODE = 'EMP926001';
const MGR_CODE = 'EMP926002';

/** Run SQL through the backend's own pool; returns rows of the LAST statement. */
function sql(query: string, params: unknown[] = []): any[] {
  const script = `
    import pool from './src/config/db.js';
    const [q, p] = JSON.parse(process.argv[1]);
    try { const r = await pool.query(q, p); console.log(JSON.stringify(r.rows ?? [])); }
    finally { await pool.end(); }`;
  const out = execFileSync('node', ['--input-type=module', '-e', script, JSON.stringify([query, params])], {
    cwd: BACKEND, encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  });
  const line = out.trim().split('\n').filter(l => l.startsWith('[')).pop() ?? '[]';
  return JSON.parse(line);
}

let companyId: number | null = null;
let empId = 0;
let revId = 0;

async function signedInCompany(page: Page): Promise<number | null> {
  await page.goto(BASE);
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
  return payload.company_id ?? null;
}

function cleanup() {
  sql(`DELETE FROM employee_salary_assignments WHERE employee_id IN (SELECT id FROM employees WHERE office_id IN ($1,$2))`, [CODE, MGR_CODE]);
  sql(`UPDATE employees SET reporting_manager_id = NULL WHERE office_id IN ($1,$2)`, [CODE, MGR_CODE]);
  sql(`DELETE FROM employees WHERE office_id IN ($1,$2)`, [CODE, MGR_CODE]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: 'tests/.auth/user.json' });
  companyId = await signedInCompany(page);
  await page.close();
  cleanup();

  const dept = sql(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)[0]?.name;
  const desig = sql(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)[0]?.name;
  const mgr = sql(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation, status, joining_date)
     VALUES ($1,$2,'Zz','Boss','zz.e2e.boss@example.com',$3,$4,'Active','2025-01-01') RETURNING id`,
    [companyId, MGR_CODE, dept, desig])[0].id;
  empId = sql(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, spouse_name, permanent_address, previous_company_2, previous_role_2,
                            account_number, pan_number, emergency_name, notes, pan_file,
                            reporting_manager_id, reporting_manager)
     VALUES ($1,$2,'Zz','Editcheck','zz.e2e.edit@example.com',$3,$4,'Active','2026-01-01','Wrong Spouse',
             'Old Permanent Rd','Old Co','Old Role','111122223333','ABCDE1234F','Old Emergency','old notes',
             '/uploads/zz_e2e_pan.pdf',$5,'Zz Boss') RETURNING id`,
    [companyId, CODE, dept, desig, mgr])[0].id;
  // The mistyped hire salary this test corrects.
  revId = sql(
    `INSERT INTO employee_salary_assignments (employee_id, effective_from, basic_salary, special_allowance)
     VALUES ($1,'2026-01-01',4500,500) RETURNING id`, [empId])[0].id;
});

test.afterAll(() => cleanup());

const openSection = async (page: Page, heading: string) => {
  const header = page.locator('.accordion-header', { hasText: heading }).first();
  await header.click();
  await expect(header.locator('xpath=..').locator('.accordion-body')).toBeVisible();
};

/**
 * The control beside a label. Several cells on this form are a bare
 * `<label>` + `<input>` with no htmlFor, so getByLabel cannot see them.
 */
const field = (page: Page, label: string) =>
  page.locator('.accordion-body .form-grid > div')
    .filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input, textarea, select').first();

const SECTIONS = [
  'Basic Information', 'Family Information', 'Address', 'Education', 'Job Information',
  'Previous Experience', 'Bank Details', 'Compliance Documents', 'Emergency Contact',
  'Assets Allocated', 'Upload Documents', 'Notes',
];

async function labelsBySection(page: Page) {
  const out: Record<string, string[]> = {};
  for (const s of SECTIONS) {
    await openSection(page, s);
    out[s] = await page.locator('.accordion-body').first().evaluate(body => [
      ...[...body.querySelectorAll('label')].map(l => l.textContent || ''),
      ...[...body.querySelectorAll('.upload-box > span:first-child')].map(x => x.textContent || ''),
    ].map(t => t.replace(/[✓*]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  }
  return out;
}

/** The real path: All Employees → search → the row's Edit button. */
async function openEditFromList(page: Page) {
  await page.goto(`${BASE}/EmployeesData`);
  const search = page.getByPlaceholder('Search name, ID, email, dept, role, manager…');
  await expect(search).toBeVisible({ timeout: 25_000 });
  await search.fill(CODE);
  const row = page.locator('tr', { hasText: CODE }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('.ed-btn-edit').click();
  await expect(page.locator('form.add-employee-form')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('heading', { name: 'Edit Employee' })).toBeVisible();
}

test('every field on Add Employee is on Edit Employee', async ({ page }) => {
  await page.goto(`${BASE}/AddEmployee`);
  await expect(page.locator('form.add-employee-form')).toBeVisible({ timeout: 25_000 });
  const add = await labelsBySection(page);

  await openEditFromList(page);
  const edit = await labelsBySection(page);

  for (const s of SECTIONS) {
    for (const l of add[s]) expect(edit[s], `${s}: "${l}" is on Add but not on Edit`).toContain(l);
  }
});

test('edit → save → database → reopen shows the saved values', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await openEditFromList(page);
  await expect(page.locator('#ae-first-name')).toHaveValue('Zz');

  // Basic
  await page.locator('#ae-last-name').fill('Edited');
  // Family — a CLEAR
  await openSection(page, 'Family Information');
  await field(page, 'Spouse Name').fill('');
  // Address
  await openSection(page, 'Address');
  await field(page, 'Permanent Address').fill('New Permanent Rd');
  // Job — status, manager None, salary CORRECTION
  await openSection(page, 'Job Information');
  await expect(page.locator('#ae-reporting-manager')).toHaveValue(/\d+/);
  await page.locator('#ae-reporting-manager').selectOption('');
  await page.locator('#ae-status').selectOption('Probation');
  await expect(page.locator('#ae-basic-salary')).toHaveValue('4500');
  await expect(page.locator('#ae-basic-salary')).toBeEditable();
  await page.locator('#ae-basic-salary').fill('45000');
  await page.locator('#ae-special-allowance').fill('5000');
  // Experience — a CLEAR
  await openSection(page, 'Previous Experience');
  await field(page, 'Company 2').fill('');
  await field(page, 'Role 2').fill('');
  // Bank / Compliance / Emergency
  await openSection(page, 'Bank Details');
  await field(page, 'Account Number').fill('999988887777');
  await openSection(page, 'Compliance Documents');
  await page.locator('#ae-pan').fill('PQRSX6789Z');
  await openSection(page, 'Emergency Contact');
  await field(page, 'Name').fill('New Emergency');
  // Documents — a REMOVAL
  await openSection(page, 'Upload Documents');
  await page.getByRole('button', { name: 'Remove PAN' }).click();
  await expect(page.getByText('Will be removed on save.')).toBeVisible();
  // Notes
  await openSection(page, 'Notes');
  await page.locator('.notes-textarea').fill('new notes');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Employee Updated', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/with exceptions/)).toHaveCount(0);

  // ── The database ─────────────────────────────────────────────────────────
  const [r] = sql(`SELECT * FROM employees WHERE id = $1`, [empId]);
  expect(r.last_name).toBe('Edited');
  expect(r.spouse_name).toBeNull();
  expect(r.permanent_address).toBe('New Permanent Rd');
  expect(r.status).toBe('Probation');
  expect(r.reporting_manager_id).toBeNull();
  expect(r.reporting_manager).toBeNull();
  expect(r.previous_company_2).toBeNull();
  expect(r.previous_role_2).toBeNull();
  expect(r.account_number).toBe('999988887777');
  expect(r.pan_number).toBe('PQRSX6789Z');
  expect(r.emergency_name).toBe('New Emergency');
  expect(r.notes).toBe('new notes');
  expect(r.pan_file).toBeNull();
  expect(Number(r.basic_salary)).toBe(45000);
  const revs = sql(`SELECT id, basic_salary::float AS b, special_allowance::float AS a FROM employee_salary_assignments WHERE employee_id = $1`, [empId]);
  expect(revs, 'corrected in place — still exactly one revision').toHaveLength(1);
  expect(revs[0]).toMatchObject({ id: revId, b: 45000, a: 5000 });

  // ── Reopen ───────────────────────────────────────────────────────────────
  await openEditFromList(page);
  await expect(page.locator('#ae-last-name')).toHaveValue('Edited');
  await openSection(page, 'Family Information');
  await expect(field(page, 'Spouse Name')).toHaveValue('');
  await openSection(page, 'Address');
  await expect(field(page, 'Permanent Address')).toHaveValue('New Permanent Rd');
  await openSection(page, 'Job Information');
  await expect(page.locator('#ae-status')).toHaveValue('Probation');
  await expect(page.locator('#ae-reporting-manager')).toHaveValue('');
  await expect(page.locator('#ae-basic-salary')).toHaveValue('45000');
  await expect(page.locator('#ae-special-allowance')).toHaveValue('5000');
  await openSection(page, 'Previous Experience');
  await expect(field(page, 'Company 2')).toHaveValue('');
  await openSection(page, 'Bank Details');
  await expect(field(page, 'Account Number')).toHaveValue('999988887777');
  await openSection(page, 'Compliance Documents');
  await expect(page.locator('#ae-pan')).toHaveValue('PQRSX6789Z');
  await openSection(page, 'Upload Documents');
  await expect(page.getByRole('button', { name: 'Remove PAN' })).toHaveCount(0);
  await openSection(page, 'Notes');
  await expect(page.locator('.notes-textarea')).toHaveValue('new notes');

  expect(errors, errors.join('\n')).toEqual([]);
});
