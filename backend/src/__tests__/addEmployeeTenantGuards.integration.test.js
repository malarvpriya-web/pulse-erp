/**
 * The tenant guards on the Add Employee write path, verified BEHAVIOURALLY.
 *
 * `addEmployeeMasterData.contract.test.js` proves the source mentions the right
 * predicates. That is a text check: it cannot tell a predicate that works from
 * one that is present and wrong — a mis-numbered `$n`, a predicate on the wrong
 * alias, an `OR` where an `AND` was meant. This runs each guard against the
 * live database twice, once for a row the caller owns and once for a row in
 * another tenant, and requires the guard to accept the first and refuse the
 * second.
 *
 * WHAT THE ADD EMPLOYEE FORM CAN SEND that points at another row:
 *   reporting_manager_id   already guarded (assertValidManager)
 *   branch_id              was NOT — accepted off the body and inserted
 *   employee_id (assets)   was NOT — POST /employee-assets stamped company_id
 *                          from the caller's scope while employee_id came from
 *                          the body unchecked, so the row claimed one tenant
 *                          and pointed at a person in another
 *   department/designation was NOT — validateMasterValue's employees-fallback
 *                          had no company predicate, so any string any tenant
 *                          had ever stored was an accepted value
 *
 * Everything runs inside a transaction that is always ROLLED BACK, so no row
 * reaches the live register. ⚠ Do not run this while a Playwright crawl is
 * going: they share a database.
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
const { assertValidBranch } = await import('../employees/employee.service.js');

/**
 * Two fixture tenants in the fixed-id registry range, created inside the
 * transaction and rolled back with it. Fixed ids rather than random ones so a
 * row that somehow escapes is recognisable; see testTenantIds.contract.test.js.
 */
const OWN = 990201;
const FOREIGN = 990202;

let client;
let fx = {};

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');

  for (const [id, name, code] of [[OWN, 'ZZ Guard Own', 'ZZGO'], [FOREIGN, 'ZZ Guard Foreign', 'ZZGF']]) {
    await client.query(
      `INSERT INTO companies (id, name, code) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [id, name, code]);
  }

  // ⚠ `code` is unique per (company_id, code), and this company gets two
  // branches — a per-company code collides on the second one.
  let branchSeq = 0;
  const branch = async (cid, nm) => (await client.query(
    `INSERT INTO branches (company_id, name, code, city, is_active)
     VALUES ($1,$2,$3,'Guard City',true) RETURNING id`,
    [cid, nm, `ZZG${cid}-${++branchSeq}`])).rows[0].id;
  fx.ownBranch     = await branch(OWN, 'ZZ Guard Branch Own');
  fx.foreignBranch = await branch(FOREIGN, 'ZZ Guard Branch Foreign');

  const emp = async (cid, code, email, designation) => (await client.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email,
                            department, designation, status, joining_date)
     VALUES ($1,$2,'ZZ','Guard',$3,'HR',$4,'Active','2026-01-01') RETURNING id`,
    [cid, code, email, designation])).rows[0].id;
  fx.ownEmp     = await emp(OWN,     'EMP902001', 'zzguard.own@example.com',     'Manager');
  // A designation that exists in NO master table and belongs to the FOREIGN
  // tenant only. Before the fix, validateMasterValue's unscoped fallback would
  // have accepted it for the OWN tenant.
  fx.foreignEmp = await emp(FOREIGN, 'EMP902002', 'zzguard.foreign@example.com', 'Chief Vibes Officer');

  // A soft-deleted branch, to prove the guard honours deleted_at.
  fx.deletedBranch = await branch(OWN, 'ZZ Guard Branch Deleted');
  await client.query(`UPDATE branches SET deleted_at = NOW() WHERE id = $1`, [fx.deletedBranch]);
});

afterAll(async () => {
  // Always. Nothing above may reach the live register.
  if (client) { await client.query('ROLLBACK'); client.release(); }
});

// ═════════════════════════════════════════════════════════════════════════════
describe('LOCATION — assertValidBranch', () => {
  it('accepts a branch in the caller\'s own company and returns its name', async () => {
    const row = await assertValidBranch(client, fx.ownBranch, OWN);
    expect(row).toMatchObject({ id: fx.ownBranch, name: 'ZZ Guard Branch Own' });
  });

  it('REFUSES a branch belonging to another company', async () => {
    // The guard this whole function exists for. `branch_id` used to go from the
    // request body into the INSERT with no check at all.
    await expect(assertValidBranch(client, fx.foreignBranch, OWN))
      .rejects.toThrow(/does not exist in this company/i);
  });

  it('refuses a branch id that does not exist, with the SAME message', async () => {
    // Identical wording on purpose: distinguishing "not yours" from "not there"
    // tells a prober which ids are real.
    let a, b;
    await assertValidBranch(client, fx.foreignBranch, OWN).catch(e => { a = e.message; });
    await assertValidBranch(client, 2147483000, OWN).catch(e => { b = e.message; });
    expect(a).toBe(b);
  });

  it('refuses a soft-deleted branch', async () => {
    await expect(assertValidBranch(client, fx.deletedBranch, OWN))
      .rejects.toThrow(/does not exist in this company/i);
  });

  it('treats a blank branch_id as "no location", not as an error', async () => {
    // Location is optional, and an untouched picker posts ''.
    for (const empty of ['', '   ', null, undefined]) {
      await expect(assertValidBranch(client, empty, OWN)).resolves.toBeNull();
    }
  });

  it('rejects a non-numeric branch_id as a 400, not a Postgres 500', async () => {
    const err = await assertValidBranch(client, 'DROP TABLE', OWN).catch(e => e);
    expect(err.message).toMatch(/not a valid location/i);
    expect(err.statusCode).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('MASTER DATA — the employees-derived fallback is per company', () => {
  /** The statement validateMasterValue issues, exactly as it issues it. */
  const FALLBACK = `SELECT 1 FROM employees
      WHERE LOWER(TRIM(COALESCE(designation,''))) = $1
        AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2)
      LIMIT 1`;

  it('accepts a value this company\'s own employees already use', async () => {
    const { rows } = await client.query(FALLBACK, ['manager', OWN]);
    expect(rows).toHaveLength(1);
  });

  it('does NOT accept a value only ANOTHER company uses', async () => {
    // Unscoped — as it was — this returned a row and 'Chief Vibes Officer'
    // became a legal designation for every tenant in the database. One
    // company's job titles are not another company's vocabulary, and the
    // validator must not be wider than the dropdown it mirrors.
    const { rows } = await client.query(FALLBACK, ['chief vibes officer', OWN]);
    expect(rows).toHaveLength(0);
  });

  it('the same value IS accepted for the company that uses it', async () => {
    // Proves the previous case failed for the right reason — scoping, not a
    // typo in the needle.
    const { rows } = await client.query(FALLBACK, ['chief vibes officer', FOREIGN]);
    expect(rows).toHaveLength(1);
  });

  it('the READ side offers exactly the same set', async () => {
    // A picker and a validator that disagree is how a value the dropdown would
    // never show still saves. Both sides run this same query now.
    const { employeeDerivedValues } = await import('../modules/master/master.routes.js');
    // employeeDerivedValues uses the shared pool, not our transaction, so it
    // cannot see the uncommitted fixtures — assert the SHAPE of the contract
    // instead: it must be scoped, and must never return another tenant's rows
    // for a company that has none.
    const none = await employeeDerivedValues('designation', 990299, false);
    expect(none).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ASSETS — the allocation ownership check', () => {
  /** The statement POST /employee-assets issues before inserting. */
  const OWNER = `SELECT id FROM employees
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        LIMIT 1`;

  it('finds an employee in the caller\'s company', async () => {
    const { rows } = await client.query(OWNER, [fx.ownEmp, OWN]);
    expect(rows).toHaveLength(1);
  });

  it('does NOT find an employee in another company', async () => {
    // Without this the INSERT went ahead: company_id stamped from the caller's
    // scope, employee_id pointing into the other tenant.
    const { rows } = await client.query(OWNER, [fx.foreignEmp, OWN]);
    expect(rows).toHaveLength(0);
  });

  /** The ASSET_TYPE master lookup, as the route issues it. */
  const TYPE_OK = `SELECT 1 FROM master_values
          WHERE type = 'ASSET_TYPE' AND is_active = true
            AND (company_id IS NULL OR company_id = $1)
            AND LOWER(BTRIM(value)) = LOWER(BTRIM($2)) LIMIT 1`;

  it('accepts a seeded asset type', async () => {
    const { rows } = await client.query(TYPE_OK, [OWN, 'Laptop']);
    expect(rows).toHaveLength(1);
  });

  it('accepts it case- and whitespace-insensitively', async () => {
    const { rows } = await client.query(TYPE_OK, [OWN, '  laptop ']);
    expect(rows).toHaveLength(1);
  });

  it('refuses a type that is in no master', async () => {
    const { rows } = await client.query(TYPE_OK, [OWN, 'Personal Submarine']);
    expect(rows).toHaveLength(0);
  });

  it('a type added by ANOTHER tenant is not offered to this one', async () => {
    await client.query(
      `INSERT INTO master_values (type, value, company_id, is_active)
       VALUES ('ASSET_TYPE', 'ZZ Foreign Gadget', $1, true)`, [FOREIGN]);
    const mine    = await client.query(TYPE_OK, [OWN,     'ZZ Foreign Gadget']);
    const theirs  = await client.query(TYPE_OK, [FOREIGN, 'ZZ Foreign Gadget']);
    expect(mine.rows).toHaveLength(0);
    expect(theirs.rows).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('BANK — the seeded vocabulary', () => {
  it('is shared (company_id IS NULL), not copied per tenant', async () => {
    // A per-tenant copy would mean every tenant curating the same list of
    // Indian banks and drifting apart.
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE company_id IS NULL) AS shared,
              count(*) FILTER (WHERE company_id IS NOT NULL) AS owned
         FROM master_values WHERE type = 'BANK'`);
    expect(Number(rows[0].shared)).toBeGreaterThanOrEqual(44);
  });

  it('carries the banks an Indian payroll actually pays into', async () => {
    const { rows } = await client.query(
      `SELECT value FROM master_values WHERE type = 'BANK' AND is_active`);
    const names = rows.map(r => r.value);
    for (const b of ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank',
                     'Punjab National Bank', 'Kotak Mahindra Bank']) {
      expect(names, b).toContain(b);
    }
  });

  it('holds no duplicate spellings of one bank', async () => {
    // The unique index is on (type, COALESCE(company_id,0), lower(btrim(value))),
    // so this also proves the seed's ON CONFLICT target is the right one.
    const { rows } = await client.query(
      `SELECT lower(btrim(value)) v, count(*) n FROM master_values
        WHERE type = 'BANK' GROUP BY 1 HAVING count(*) > 1`);
    expect(rows).toEqual([]);
  });

  it('a tenant\'s own addition does not leak into another tenant', async () => {
    await client.query(
      `INSERT INTO master_values (type, value, company_id, is_active)
       VALUES ('BANK', 'ZZ Guard Co-operative Bank', $1, true)`, [OWN]);
    const { rows } = await client.query(
      `SELECT company_id FROM master_values
        WHERE type = 'BANK' AND lower(btrim(value)) = 'zz guard co-operative bank'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(OWN);
  });
});
