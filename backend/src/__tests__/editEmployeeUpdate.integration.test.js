/**
 * Edit Employee's write path — `updateEmployee` — against the live database.
 *
 * Edit Employee is now the Add Employee form in edit mode, which SENDS EVERY
 * FIELD. That made four latent defects in this path load-bearing, each
 * reproduced before it was fixed:
 *
 *  1. Every column was `col = COALESCE($n, col)`, so nothing could be cleared:
 *     deleting a wrong spouse name saved "successfully" and came straight back.
 *  2. `branch_id` and `zone_id` were not in the UPDATE at all — the form sent
 *     them, the Location/Zone text changed, the foreign keys did not.
 *  3. Salary could not be corrected. A mistyped first salary could only be
 *     overwritten by booking a second revision on top of it.
 *  4. Clearing the Reporting Manager omitted both keys, so COALESCE kept the
 *     old manager.
 *
 * updateEmployee takes its own pooled connection and commits, so these
 * fixtures cannot live in a rolled-back transaction. They sit in two
 * registry tenants (testTenantIds.contract.test.js) and are deleted in
 * afterAll. ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const pw = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { updateEmployee } = await import('../employees/employee.service.js');

const OWN = 999921;
const FOREIGN = 999922;
const fx = {};

const row = async (id) => (await pool.query(`SELECT * FROM employees WHERE id = $1`, [id])).rows[0];
const revisions = async (id) => (await pool.query(
  `SELECT id, effective_from::text AS effective_from, basic_salary::float AS basic, special_allowance::float AS allowance
     FROM employee_salary_assignments WHERE employee_id = $1 ORDER BY effective_from`, [id])).rows;

async function cleanup() {
  const ids = `SELECT id FROM employees WHERE company_id IN (${OWN}, ${FOREIGN})`;
  await pool.query(`DELETE FROM employee_salary_assignments WHERE employee_id IN (${ids})`);
  await pool.query(`UPDATE employees SET reporting_manager_id = NULL WHERE company_id IN (${OWN}, ${FOREIGN})`);
  await pool.query(`DELETE FROM employees WHERE company_id IN (${OWN}, ${FOREIGN})`);
  await pool.query(`DELETE FROM branches WHERE company_id IN (${OWN}, ${FOREIGN})`);
  await pool.query(`DELETE FROM companies WHERE id IN (${OWN}, ${FOREIGN})`);
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, code] of [[OWN, 'ZZ Edit Own', 'ZZEO'], [FOREIGN, 'ZZ Edit Foreign', 'ZZEF']]) {
    await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,$2,$3)`, [id, name, code]);
  }
  const branch = async (cid, nm, code) => (await pool.query(
    `INSERT INTO branches (company_id, name, code, city, is_active) VALUES ($1,$2,$3,'Edit City',true) RETURNING id`,
    [cid, nm, code])).rows[0].id;
  fx.ownBranch = await branch(OWN, 'ZZ Edit Branch Own', 'ZZE-1');
  fx.foreignBranch = await branch(FOREIGN, 'ZZ Edit Branch Foreign', 'ZZE-2');

  // Values the master validators accept for this tenant.
  fx.dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0]?.name;
  fx.desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0]?.name;
  fx.zone = (await pool.query(`SELECT id, name FROM master_zones WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0];

  const emp = async (cid, code, email, extra = {}) => (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, spouse_name, previous_company_2, previous_years_2,
                            pan_file, aadhaar_file, photo_url, aadhaar_number)
     VALUES ($1,$2,'Zed','Editor',$3,$4,$5,'Active','2026-01-01','Wrong Spouse','Old Co',3,
             '/uploads/zz_pan.pdf','/uploads/zz_aadhaar.pdf','/uploads/zz_photo.jpg','123412341234')
     RETURNING id`,
    [cid, code, email, extra.dept ?? fx.dept, extra.desig ?? fx.desig])).rows[0].id;
  fx.emp     = await emp(OWN, 'EMP921001', 'zz.edit.one@example.com');
  fx.manager = await emp(OWN, 'EMP921002', 'zz.edit.mgr@example.com');
  fx.other   = await emp(OWN, 'EMP921003', 'zz.edit.other@example.com');
  fx.foreign = await emp(FOREIGN, 'EMP921004', 'zz.edit.foreign@example.com');
  await pool.query(`UPDATE employees SET first_name = 'Mona', last_name = 'Manager' WHERE id = $1`, [fx.manager]);

  // The hire revision, at the joining date, with the figure HR mistyped.
  fx.hireRev = (await pool.query(
    `INSERT INTO employee_salary_assignments (employee_id, effective_from, basic_salary, special_allowance)
     VALUES ($1, '2026-01-01', 4500, 500) RETURNING id`, [fx.emp])).rows[0].id;
  fx.otherRev = (await pool.query(
    `INSERT INTO employee_salary_assignments (employee_id, effective_from, basic_salary, special_allowance)
     VALUES ($1, '2026-01-01', 70000, 0) RETURNING id`, [fx.other])).rows[0].id;
});

afterAll(async () => {
  // No pool.end(): the pool is shared per worker, and ending it here skips
  // every later suite on the same worker silently.
  await cleanup();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('a present key is SET, an absent key is kept', () => {
  it('clears an optional field sent blank — the COALESCE bug', async () => {
    await updateEmployee(fx.emp, { spouse_name: '', previous_company_2: '', previous_years_2: '' }, OWN);
    const r = await row(fx.emp);
    expect(r.spouse_name).toBeNull();
    expect(r.previous_company_2).toBeNull();
    expect(r.previous_years_2).toBeNull();
    // Untouched keys are untouched.
    expect(r.first_name).toBe('Zed');
    expect(r.aadhaar_number).toBe('123412341234');
  });

  it('writes every plain field the form sends and reads them back', async () => {
    const payload = {
      first_name: 'Zara', last_name: 'Edited', personal_email: 'zara@example.org',
      phone: '9876543210', company_phone: '9123456780', gender: 'Female', blood_group: 'O+',
      dob: '1990-05-06', marital_status: 'Married', father_name: 'F', mother_name: 'M',
      spouse_name: 'Right Spouse', anniversary_date: '2015-02-03',
      current_address: '1 Current St', permanent_address: '2 Permanent Rd',
      highest_qualification: 'MBA', basic_qualification: 'B.Com',
      employee_role: 'Manager', employment_type: 'Permanent', skill_type: 'Skilled',
      previous_company_1: 'Prev One', previous_role_1: 'Analyst', previous_years_1: '4',
      previous_company_2: 'Prev Two', previous_role_2: 'Lead', previous_years_2: '2',
      bank_name: 'State Bank of India', branch_name: 'Main', account_number: '000111222333',
      ifsc_code: 'SBIN0000001', nominee_name: 'N', emergency_name: 'E', emergency_phone: '9000000000',
      emergency_relationship: 'Spouse', pan_number: 'ABCDE1234F', aadhaar_number: '999988887777',
      pf_number: 'PF1', uan_number: 'UAN1', esic_number: 'ESIC1', notes: 'edited notes',
      is_field_employee: 'true', status: 'Probation', joining_date: '2026-01-01',
    };
    await updateEmployee(fx.emp, payload, OWN);
    const r = await row(fx.emp);
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'is_field_employee') { expect(r[k]).toBe(true); continue; }
      const got = r[k] instanceof Date ? r[k].toISOString().slice(0, 10) : r[k];
      expect(String(got).slice(0, String(v).length), k).toBe(String(v));
    }
  });

  it('refuses to clear a required field, and writes nothing', async () => {
    const err = await updateEmployee(fx.emp, { first_name: '', notes: 'should not land' }, OWN).catch(e => e);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/First name cannot be cleared/);
    expect((await row(fx.emp)).notes).toBe('edited notes');
  });

  it('never writes the mask a non-HR read would show', async () => {
    await updateEmployee(fx.emp, { aadhaar_number: 'XXXX XXXX 7777', current_address: '[RESTRICTED]' }, OWN);
    const r = await row(fx.emp);
    expect(r.aadhaar_number).toBe('999988887777');
    expect(r.current_address).toBe('1 Current St');
  });

  it('a partial caller (the Terminate modal) still changes only what it sends', async () => {
    await updateEmployee(fx.other, { status: 'Left', exit_date: '2026-09-01', exit_reason: null }, OWN);
    const r = await row(fx.other);
    expect(r.status).toBe('Left');
    expect(r.first_name).toBe('Zed');
    expect(r.spouse_name).toBe('Wrong Spouse');
    await updateEmployee(fx.other, { status: 'Active', exit_date: '' }, OWN);
  });

  it('refuses a company email another employee of the company already holds', async () => {
    const err = await updateEmployee(fx.emp, { company_email: 'ZZ.EDIT.MGR@example.com' }, OWN).catch(e => e);
    expect(err.statusCode).toBe(409);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('masters and links', () => {
  it('Location writes branch_id AND derives the location label from it', async () => {
    await updateEmployee(fx.emp, { branch_id: String(fx.ownBranch), location: 'whatever the client says' }, OWN);
    const r = await row(fx.emp);
    expect(r.branch_id).toBe(fx.ownBranch);
    expect(r.location).toBe('ZZ Edit Branch Own');
  });

  it('refuses another tenant\'s branch and rolls the whole edit back', async () => {
    const err = await updateEmployee(fx.emp, { branch_id: String(fx.foreignBranch), notes: 'rolled back' }, OWN).catch(e => e);
    expect(err.statusCode).toBe(400);
    const r = await row(fx.emp);
    expect(r.branch_id).toBe(fx.ownBranch);
    expect(r.notes).toBe('edited notes');
  });

  it('clearing Location clears both columns', async () => {
    await updateEmployee(fx.emp, { branch_id: '' }, OWN);
    const r = await row(fx.emp);
    expect(r.branch_id).toBeNull();
    expect(r.location).toBeNull();
  });

  it('Zone writes zone_id and the master name together', async () => {
    if (!fx.zone) return;
    await updateEmployee(fx.emp, { zone_id: String(fx.zone.id), zone: 'stale text' }, OWN);
    const r = await row(fx.emp);
    expect(r.zone_id).toBe(fx.zone.id);
    expect(r.zone).toBe(fx.zone.name);
  });

  it('Reporting Manager: the name is derived, and None clears both', async () => {
    await updateEmployee(fx.emp, { reporting_manager_id: String(fx.manager), reporting_manager: 'Forged Name' }, OWN);
    let r = await row(fx.emp);
    expect(r.reporting_manager_id).toBe(fx.manager);
    expect(r.reporting_manager).toBe('Mona Manager');

    await updateEmployee(fx.emp, { reporting_manager_id: '' }, OWN);
    r = await row(fx.emp);
    expect(r.reporting_manager_id).toBeNull();
    expect(r.reporting_manager).toBeNull();
  });

  it('another tenant cannot edit the record', async () => {
    const err = await updateEmployee(fx.emp, { notes: 'cross-tenant' }, FOREIGN).catch(e => e);
    expect(err.statusCode).toBe(404);
    expect((await row(fx.emp)).notes).toBe('edited notes');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('documents', () => {
  it('keeps files that are neither replaced nor removed, replaces and removes the rest', async () => {
    await updateEmployee(fx.emp, { resume_file: '/uploads/zz_resume_new.pdf', remove_files: 'pan_file' }, OWN);
    const r = await row(fx.emp);
    expect(r.resume_file).toBe('/uploads/zz_resume_new.pdf');
    expect(r.pan_file).toBeNull();
    expect(r.aadhaar_file).toBe('/uploads/zz_aadhaar.pdf');
    expect(r.photo_url).toBe('/uploads/zz_photo.jpg');
  });

  it('a new upload wins over a removal of the same slot', async () => {
    await updateEmployee(fx.emp, { photo_file: '/uploads/zz_photo_new.jpg', remove_files: 'photo_file' }, OWN);
    expect((await row(fx.emp)).photo_url).toBe('/uploads/zz_photo_new.jpg');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('salary — corrected in place, never duplicated', () => {
  it('corrects the named revision and adds none', async () => {
    const out = await updateEmployee(fx.emp, {
      basic_salary: '45000', special_allowance: '5000', salary_revision_id: String(fx.hireRev),
    }, OWN);
    const revs = await revisions(fx.emp);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ id: fx.hireRev, basic: 45000, allowance: 5000 });
    // Payroll's fallback column follows the revision in force.
    expect(Number((await row(fx.emp)).basic_salary)).toBe(45000);
    // The before/after the controller audits.
    expect(Number(out.salary_correction.before.basic_salary)).toBe(4500);
    expect(Number(out.salary_correction.after.basic_salary)).toBe(45000);
  });

  it('saving the same correction twice still leaves one revision', async () => {
    await updateEmployee(fx.emp, { basic_salary: '45000', special_allowance: '5000', salary_revision_id: String(fx.hireRev) }, OWN);
    expect(await revisions(fx.emp)).toHaveLength(1);
  });

  it('refuses a salary with no revision named when revisions exist', async () => {
    const err = await updateEmployee(fx.emp, { basic_salary: '1' }, OWN).catch(e => e);
    expect(err.statusCode).toBe(400);
    expect(await revisions(fx.emp)).toHaveLength(1);
  });

  it('refuses to correct ANOTHER employee\'s revision through this one', async () => {
    const err = await updateEmployee(fx.emp, { basic_salary: '1', salary_revision_id: String(fx.otherRev) }, OWN).catch(e => e);
    expect(err.statusCode).toBe(400);
    expect((await revisions(fx.other))[0].basic).toBe(70000);
  });

  it('refuses to clear the basic salary', async () => {
    const err = await updateEmployee(fx.emp, { basic_salary: '', salary_revision_id: String(fx.hireRev) }, OWN).catch(e => e);
    expect(err.statusCode).toBe(400);
  });

  it('an employee with no salary gets their FIRST revision at the joining date', async () => {
    await updateEmployee(fx.manager, { basic_salary: '60000', special_allowance: '' }, OWN);
    const revs = await revisions(fx.manager);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ effective_from: '2026-01-01', basic: 60000, allowance: 0 });
  });

  it('a corrected joining date carries the hire revision with it', async () => {
    await updateEmployee(fx.emp, { joining_date: '2025-12-01' }, OWN);
    const revs = await revisions(fx.emp);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ id: fx.hireRev, effective_from: '2025-12-01' });
  });

  it('a joining-date move never jumps the hire revision past a later one', async () => {
    await pool.query(
      `INSERT INTO employee_salary_assignments (employee_id, effective_from, basic_salary) VALUES ($1, '2026-04-01', 50000)`,
      [fx.emp]);
    await updateEmployee(fx.emp, { joining_date: '2026-06-01' }, OWN);
    const revs = await revisions(fx.emp);
    expect(revs.map(r => r.effective_from)).toEqual(['2025-12-01', '2026-04-01']);
  });
});
