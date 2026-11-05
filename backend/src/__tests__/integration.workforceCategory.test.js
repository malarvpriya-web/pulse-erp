/**
 * Workforce Category — master list, employee field, validation, tenant scope.
 *
 * Migration 20261013000001 seeds WORKFORCE_CATEGORY into master_values and adds
 * employees.workforce_category_id (FK, ON DELETE RESTRICT) with a trigger that
 * checks type and company. The service validates the same rules first.
 *
 * Real database, real routers. Only `verifyToken` is replaced — by a stub that
 * reads the caller from a test header — so the employee router's own
 * `allowRoles`, the controller's companyOf() scoping, validation and the INSERT
 * and UPDATE all run as in production.
 *
 * Fixtures: two fixed test companies (999933 own, 999934 foreign; see
 * testTenantIds.contract.test.js), each with one category of its own. Every row
 * created here is deleted by captured id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

// Only verifyToken is stubbed: the caller comes from an `x-test-user` header.
// allowRoles and every other export are the real ones.
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    verifyToken: (req, res, next) => {
      const raw = req.headers['x-test-user'];
      if (!raw) return res.status(401).json({ error: 'Unauthorized' });
      const u = JSON.parse(raw);
      req.user  = { id: null, userId: null, roles: u.roles, role: u.roles[0], company_id: u.company_id };
      req.scope = { company_id: u.company_id };
      next();
    },
  };
});

const { default: pool }           = await import('../config/db.js');
const { default: employeeRoutes } = await import('../employees/employee.routes.js');
const { default: masterRoutes }   = await import('../modules/master/master.routes.js');
const { verifyToken }             = await import('../middlewares/auth.middleware.js');
const { getWorkforceAnalytics }   = await import('../employees/employee.service.js');
const { REGISTRY, BY_KEY }        = await import('../modules/master/vocabularies.js');
const { usageForVocab }           = await import('../modules/master/usage.js');
const migration = await import('../database/migrations/20261013000001_workforce_category.js');

const OWN = 999933;
const FOREIGN = 999934;
const SEEDS = ['Engineering', 'Production', 'Quality', 'Service', 'Sales',
               'Administration', 'Housekeeping', 'Security', 'Driver'];

const app = express();
app.use(express.json());
app.use('/api/employees', employeeRoutes);
app.use('/api/master', verifyToken, masterRoutes);

const as = (roles, company_id = OWN) => ({ 'x-test-user': JSON.stringify({ roles, company_id }) });
const HR = as(['hr']);

const created = { employees: [], categories: [] };
const cat = {};          // name → id
let dept, desig;         // live master values the employee validator accepts
const stamp = Date.now();
let seq = 0;

function newHire(extra = {}) {
  seq += 1;
  return {
    first_name: 'ZZWC', last_name: `Hire${seq}`,
    company_email: `zz.wfcat.${stamp}.${seq}@example.com`,
    department: dept, designation: desig, status: 'Active', joining_date: '2026-06-01',
    // mandatory on Add Employee since §202
    account_number: '123456789012', ifsc_code: 'HDFC0001234', current_address: '1 Fixture Street',
    ...extra,
  };
}

async function hire(extra, headers = HR) {
  const res = await request(app).post('/api/employees').set(headers).send(newHire(extra));
  const id = res.body?.id ?? res.body?.employee?.id;
  if (id != null) created.employees.push(id);
  return { res, id };
}

const categoryOf = async (id) =>
  (await pool.query('SELECT workforce_category_id FROM employees WHERE id = $1', [id])).rows[0]?.workforce_category_id ?? null;

async function addCategory(company_id, value, is_active = true) {
  const { rows } = await pool.query(
    `INSERT INTO master_values (type, value, sort_order, company_id, is_active)
     VALUES ('WORKFORCE_CATEGORY', $1, 100, $2, $3) RETURNING id`, [value, company_id, is_active]);
  created.categories.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  for (const [id, code] of [[OWN, 'ZZWCA'], [FOREIGN, 'ZZWCB']]) {
    await pool.query(
      `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `${code} Category Fixture`, code]);
  }
  const { rows: shared } = await pool.query(
    `SELECT id, value FROM master_values WHERE type = 'WORKFORCE_CATEGORY' AND company_id IS NULL`);
  for (const r of shared) cat[r.value] = r.id;
  cat.ownCrew     = await addCategory(OWN, 'ZZWC Alpha Crew');
  cat.foreignCrew = await addCategory(FOREIGN, 'ZZWC Beta Crew');
  cat.retired     = await addCategory(OWN, 'ZZWC Retired Crew');
  ({ rows: [{ id: cat.skillTypeRow }] } = await pool.query(
    `SELECT id FROM master_values WHERE type = 'SKILL_TYPE' ORDER BY id LIMIT 1`));
  ({ rows: [{ name: dept }] }  = await pool.query(`SELECT name FROM master_departments  WHERE is_active ORDER BY id LIMIT 1`));
  ({ rows: [{ name: desig }] } = await pool.query(`SELECT name FROM master_designations WHERE is_active ORDER BY id LIMIT 1`));
}, 30000);

afterAll(async () => {
  if (created.employees.length) {
    const ids = created.employees;
    // Login rows addEmployee provisions. users.employee_id is ON DELETE SET
    // NULL, so they would outlive the employee as orphans if not removed here.
    const { rows: users } = await pool.query('SELECT id FROM users WHERE employee_id = ANY($1::int[])', [ids]);
    const uids = users.map(u => u.id);
    if (uids.length) {
      await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::int[])', [uids]);
      await pool.query('DELETE FROM user_scope WHERE user_id = ANY($1::int[])', [uids]);
      await pool.query('DELETE FROM users      WHERE id      = ANY($1::int[])', [uids]);
    }
    await pool.query('DELETE FROM employees WHERE id = ANY($1::int[])', [ids]);
  }
  if (created.categories.length) {
    await pool.query('DELETE FROM master_values WHERE id = ANY($1::int[])', [created.categories]);
  }
});

// ── Migration ─────────────────────────────────────────────────────────────────
describe('migration 20261013000001', () => {
  it('adds a nullable column with no default, an FK that RESTRICTs deletes, and the guard trigger', async () => {
    const { rows: [col] } = await pool.query(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'workforce_category_id'`);
    expect(col).toEqual({ is_nullable: 'YES', column_default: null, data_type: 'integer' });
    const { rows: [fk] } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'employees'::regclass AND conname = 'employees_workforce_category_id_fkey'`);
    expect(fk.d).toBe('FOREIGN KEY (workforce_category_id) REFERENCES master_values(id) ON DELETE RESTRICT');
    const { rows: trg } = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_employees_workforce_category_guard' AND NOT tgisinternal`);
    expect(trg).toHaveLength(1);
  });

  it('seeds the nine categories as shared, active rows in order', async () => {
    const { rows } = await pool.query(
      `SELECT value FROM master_values
        WHERE type = 'WORKFORCE_CATEGORY' AND company_id IS NULL AND is_active ORDER BY sort_order`);
    expect(rows.map(r => r.value)).toEqual(SEEDS);
  });

  it('is written to be safe to re-run, and never updates or deletes an employee', async () => {
    // ⚠ Checked from the statements, NOT by executing up() again. Re-running it
    // here issued ALTER TABLE / DROP TRIGGER on `employees` — an ACCESS
    // EXCLUSIVE lock — while other suites held open transactions on that table
    // in parallel. Every later query queued behind the lock, the shared pool
    // ran dry, and a whole test run hung until it was killed, leaking those
    // suites' fixtures into company 1. A test must not take DDL locks on a
    // shared live table.
    const statements = [];
    await migration.up({ raw: (sql) => { statements.push(String(sql)); return { rows: [] }; } });
    const ddl = statements.map(s => s.replace(/\s+/g, ' ').trim());

    for (const s of ddl) {
      if (/^INSERT INTO master_values/i.test(s)) expect(s, s).toMatch(/ON CONFLICT .* DO NOTHING/i);
      if (/^ALTER TABLE employees/i.test(s))     expect(s, s).toMatch(/ADD COLUMN IF NOT EXISTS/i);
      if (/^CREATE INDEX/i.test(s))              expect(s, s).toMatch(/IF NOT EXISTS/i);
      if (/^CREATE (OR REPLACE )?FUNCTION/i.test(s)) expect(s, s).toMatch(/^CREATE OR REPLACE FUNCTION/i);
    }
    const createTrigger = ddl.findIndex(s => /^CREATE TRIGGER/i.test(s));
    const dropTrigger   = ddl.findIndex(s => /^DROP TRIGGER IF EXISTS/i.test(s));
    expect(dropTrigger).toBeGreaterThan(-1);
    expect(dropTrigger).toBeLessThan(createTrigger);
    // No statement rewrites or removes an employee row.
    expect(ddl.filter(s => /^(UPDATE|DELETE FROM) employees/i.test(s))).toEqual([]);
    // Nine seeds, all shared.
    expect(ddl.filter(s => /^INSERT INTO master_values/i.test(s))).toHaveLength(SEEDS.length);
  });

  it('applied once: exactly one shared row per seed', async () => {
    const { rows } = await pool.query(
      `SELECT value, COUNT(*)::int AS n FROM master_values
        WHERE type = 'WORKFORCE_CATEGORY' AND company_id IS NULL GROUP BY value`);
    expect(Object.fromEntries(rows.map(r => [r.value, r.n])))
      .toEqual(Object.fromEntries(SEEDS.map(s => [s, 1])));
  });
});

// ── Master list ───────────────────────────────────────────────────────────────
describe('the master list', () => {
  it('is registered as an HR vocabulary referenced by id', () => {
    const e = BY_KEY['workforce-categories'];
    expect(e).toMatchObject({ type: 'WORKFORCE_CATEGORY', label: 'Workforce Category', module: 'HR',
                              columns: [], idColumns: ['employees.workforce_category_id'] });
    expect(REGISTRY.filter(v => v.type === 'WORKFORCE_CATEGORY')).toHaveLength(1);
    expect(usageForVocab('workforce-categories')).toEqual([
      { table: 'employees', column: 'workforce_category_id', label: 'employee', byId: true, type: 'WORKFORCE_CATEGORY' }]);
  });

  it('a company sees the shared categories and its own — never another company\'s', async () => {
    const res = await request(app).get('/api/master/v/workforce-categories').set(HR);
    expect(res.status).toBe(200);
    const names = res.body.map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([...SEEDS, 'ZZWC Alpha Crew', 'ZZWC Retired Crew']));
    expect(names).not.toContain('ZZWC Beta Crew');
    const foreign = await request(app).get('/api/master/v/workforce-categories').set(as(['hr'], FOREIGN));
    expect(foreign.body.map(r => r.name)).not.toContain('ZZWC Alpha Crew');
  });
});

// ── Add / Edit persistence ────────────────────────────────────────────────────
describe('Add Employee and Edit Employee', () => {
  it('creates an employee with a shared category and returns its name on read', async () => {
    const { res, id } = await hire({ workforce_category_id: String(cat.Security) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await categoryOf(id)).toBe(cat.Security);
    const read = await request(app).get(`/api/employees/${id}`).set(HR);
    expect(read.body).toMatchObject({ workforce_category_id: cat.Security, workforce_category_name: 'Security' });
  });

  it('creates with the company\'s own category', async () => {
    const { res, id } = await hire({ workforce_category_id: cat.ownCrew });
    expect(res.status).toBe(200);
    expect(await categoryOf(id)).toBe(cat.ownCrew);
  });

  it.each([[''], [null], ['null'], [undefined]])('creates with no category when given %j', async (v) => {
    const { res, id } = await hire(v === undefined ? {} : { workforce_category_id: v });
    expect(res.status).toBe(200);
    expect(await categoryOf(id)).toBeNull();
  });

  it('changes, keeps and clears the category on edit', async () => {
    const { id } = await hire({ workforce_category_id: cat.Driver });
    const put = (body) => request(app).put(`/api/employees/${id}`).set(HR).send(body);

    expect((await put({ workforce_category_id: String(cat.Housekeeping) })).status).toBe(200);
    expect(await categoryOf(id)).toBe(cat.Housekeeping);

    // A field absent from the body is left alone.
    expect((await put({ notes: 'unrelated edit' })).status).toBe(200);
    expect(await categoryOf(id)).toBe(cat.Housekeeping);

    // Blank clears.
    expect((await put({ workforce_category_id: '' })).status).toBe(200);
    expect(await categoryOf(id)).toBeNull();
    const read = await request(app).get(`/api/employees/${id}`).set(HR);
    expect(read.body.workforce_category_name).toBeNull();
  });
});

// ── Validation and tenant isolation ───────────────────────────────────────────
describe('validation and tenant isolation', () => {
  it.each([
    ['another company\'s category', () => cat.foreignCrew],
    ['a master_values row of a different type', () => cat.skillTypeRow],
    ['an id that does not exist', () => 2147483000],
    ['a non-numeric value', () => 'Security'],
  ])('refuses %s on create — 400 and no employee written', async (_label, value) => {
    const before = (await pool.query('SELECT COUNT(*)::int n FROM employees WHERE company_id = $1', [OWN])).rows[0].n;
    const { res } = await hire({ workforce_category_id: value() });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/workforce category/i);
    const after = (await pool.query('SELECT COUNT(*)::int n FROM employees WHERE company_id = $1', [OWN])).rows[0].n;
    expect(after).toBe(before);
  });

  it('gives the same message for "missing" and "another company\'s" — no existence oracle', async () => {
    const a = (await hire({ workforce_category_id: cat.foreignCrew })).res.body;
    const b = (await hire({ workforce_category_id: 2147483000 })).res.body;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('refuses another company\'s category on edit and leaves the stored one', async () => {
    const { id } = await hire({ workforce_category_id: cat.Sales });
    const res = await request(app).put(`/api/employees/${id}`).set(HR).send({ workforce_category_id: cat.foreignCrew });
    expect(res.status).toBe(400);
    expect(await categoryOf(id)).toBe(cat.Sales);
  });

  it('a deactivated category cannot be newly assigned, but an employee already holding it can still be saved', async () => {
    const { id } = await hire({ workforce_category_id: cat.retired });
    await pool.query('UPDATE master_values SET is_active = false WHERE id = $1', [cat.retired]);
    try {
      const fresh = await hire({ workforce_category_id: cat.retired });
      expect(fresh.res.status).toBe(400);
      expect(JSON.stringify(fresh.res.body)).toMatch(/no longer an active workforce category/);

      const resave = await request(app).put(`/api/employees/${id}`).set(HR)
        .send({ workforce_category_id: String(cat.retired), notes: 'resave' });
      expect(resave.status).toBe(200);
      expect(await categoryOf(id)).toBe(cat.retired);
      const read = await request(app).get(`/api/employees/${id}`).set(HR);
      expect(read.body).toMatchObject({ workforce_category_name: 'ZZWC Retired Crew', workforce_category_active: false });
    } finally {
      await pool.query('UPDATE master_values SET is_active = true WHERE id = $1', [cat.retired]);
    }
  });

  it('only HR roles may create or edit (the existing allowRoles gate)', async () => {
    const res = await request(app).post('/api/employees').set(as(['employee']))
      .send(newHire({ workforce_category_id: cat.Security }));
    expect(res.status).toBe(403);
  });

  it('the database trigger refuses a cross-company or wrong-type reference from any writer', async () => {
    const { id } = await hire({});
    await expect(pool.query('UPDATE employees SET workforce_category_id = $1 WHERE id = $2', [cat.foreignCrew, id]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(pool.query('UPDATE employees SET workforce_category_id = $1 WHERE id = $2', [cat.skillTypeRow, id]))
      .rejects.toMatchObject({ code: '23503' });
    expect(await categoryOf(id)).toBeNull();
  });

  it('the FK refuses a hard delete of a category in use', async () => {
    // RESTRICT reports restrict_violation (23001), not foreign_key_violation.
    await expect(pool.query('DELETE FROM master_values WHERE id = $1', [cat.ownCrew]))
      .rejects.toMatchObject({ code: '23001' });
  });
});

// ── Master Data usage and delete guard ────────────────────────────────────────
describe('usage counts in Master Data', () => {
  it('counts employees by id, scoped to the caller\'s company', async () => {
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int n FROM employees WHERE company_id = $1 AND deleted_at IS NULL
          AND workforce_category_id = $2`, [OWN, cat.ownCrew]);
    expect(n).toBeGreaterThan(0);
    const res = await request(app).get('/api/master/v/workforce-categories?usage=1').set(HR);
    expect(res.body.find(r => r.id === cat.ownCrew).usage_count).toBe(n);
    // The foreign company sees zero for a shared category this company uses.
    const foreign = await request(app).get('/api/master/v/workforce-categories?usage=1').set(as(['hr'], FOREIGN));
    expect(foreign.body.find(r => r.id === cat.Security).usage_count).toBe(0);
  });

  it('a hard delete of a category in use is refused; a plain delete only deactivates', async () => {
    const hard = await request(app).delete(`/api/master/v/workforce-categories/${cat.ownCrew}?hard=1`).set(HR);
    expect(hard.status).toBe(409);
    const soft = await request(app).delete(`/api/master/v/workforce-categories/${cat.ownCrew}`).set(HR);
    expect(soft.status).toBe(200);
    expect(soft.body.deleted).toBe('deactivated');
    const { rows: [row] } = await pool.query('SELECT is_active FROM master_values WHERE id = $1', [cat.ownCrew]);
    expect(row.is_active).toBe(false);
    await pool.query('UPDATE master_values SET is_active = true WHERE id = $1', [cat.ownCrew]);
  });
});

// ── Workforce Analytics ───────────────────────────────────────────────────────
describe('Workforce Analytics reports the category', () => {
  it('counts each category and Not recorded, and the completeness matches', async () => {
    const d = await getWorkforceAnalytics({ company_id: OWN, filters: {}, period: 'all' });
    const { rows } = await pool.query(
      `SELECT COALESCE(m.value, 'Not recorded') AS value, COUNT(*)::int AS count
         FROM employees e LEFT JOIN master_values m ON m.id = e.workforce_category_id
        WHERE e.company_id = $1 AND e.deleted_at IS NULL
        GROUP BY 1`, [OWN]);
    const expected = Object.fromEntries(rows.map(r => [r.value, r.count]));
    const got = Object.fromEntries(d.breakdowns.workforceCategory.buckets.map(b => [b.value, b.count]));
    expect(got).toEqual(expected);
    expect(got.Security).toBeGreaterThan(0);
    const c = d.completeness.find(f => f.field === 'workforceCategory');
    expect(c.recorded).toBe(d.population.total - (expected['Not recorded'] ?? 0));
  });

  it('another company\'s analytics carries none of these categories', async () => {
    const d = await getWorkforceAnalytics({ company_id: FOREIGN, filters: {}, period: 'all' });
    expect(JSON.stringify(d.breakdowns.workforceCategory)).not.toMatch(/ZZWC Alpha Crew|Security/);
  });
});
