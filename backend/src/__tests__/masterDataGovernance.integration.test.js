/**
 * Master-data governance, verified BEHAVIOURALLY against the live database.
 *
 * The contract file proves the source SAYS the right thing. It cannot tell a
 * normalised unique index that works from one that is present and wrong — an
 * index on the wrong expression, a partial predicate that excludes the rows it
 * was meant to cover, a usage query whose company predicate lands on the wrong
 * table. Those are the failures that matter here, and only Postgres can answer
 * them.
 *
 * Everything runs inside a transaction that is always ROLLED BACK.
 * ⚠ Do not run this while a Playwright crawl is going: they share a database.
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
const { USAGE, countUsage, countUsageBulk } = await import('../modules/master/usage.js');

const OWN = 990501;
const FOREIGN = 990502;

let client;
const fx = {};

/** Insert inside a savepoint so a refusal does not poison the transaction. */
async function attempt(sql, params = []) {
  await client.query('SAVEPOINT sp');
  try { await client.query(sql, params); await client.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await client.query('ROLLBACK TO SAVEPOINT sp'); return e; }
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');

  for (const [id, name, code] of [[OWN, 'ZZ Gov Own', 'ZZGVO'], [FOREIGN, 'ZZ Gov Foreign', 'ZZGVF']]) {
    await client.query(`INSERT INTO companies (id,name,code) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [id, name, code]);
  }

  fx.dept = (await client.query(
    `INSERT INTO master_departments (name, is_active) VALUES ('ZZ Gov Dept', true) RETURNING id`)).rows[0].id;

  // Two employees in OWN, one in FOREIGN, all on the same department name — the
  // shape that catches an unscoped usage count.
  await client.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email,
                            department, designation, status, joining_date)
     VALUES ($1,'EMP904001','ZZ','A','zzgov.a@example.com','ZZ Gov Dept','Manager','Active','2026-01-01'),
            ($1,'EMP904002','ZZ','B','zzgov.b@example.com','ZZ Gov Dept','Manager','Active','2026-01-01'),
            ($2,'EMP904003','ZZ','C','zzgov.c@example.com','ZZ Gov Dept','Manager','Active','2026-01-01')`,
    [OWN, FOREIGN]);

  // A soft-deleted employee, which must NOT be counted.
  await client.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email,
                            department, designation, status, joining_date, deleted_at)
     VALUES ($1,'EMP904004','ZZ','D','zzgov.d@example.com','ZZ Gov Dept','Manager','Active','2026-01-01', NOW())`,
    [OWN]);
});

afterAll(async () => {
  if (client) { await client.query('ROLLBACK'); client.release(); }
});

// ═════════════════════════════════════════════════════════════════════════════
describe('normalised uniqueness, at the database', () => {
  it('refuses every case and whitespace variant of an existing name', async () => {
    for (const v of ['zz gov dept', 'ZZ GOV DEPT', 'ZZ Gov Dept ', '  ZZ Gov Dept', 'zZ gOv DePt']) {
      const err = await attempt(`INSERT INTO master_departments (name, is_active) VALUES ($1, true)`, [v]);
      expect(err?.code, `"${v}" was accepted`).toBe('23505');
      expect(err?.constraint).toBe('ux_master_departments_name_norm');
    }
  });

  it('still accepts a genuinely different name', async () => {
    const err = await attempt(`INSERT INTO master_departments (name, is_active) VALUES ('ZZ Gov Other', true)`);
    expect(err).toBeNull();
  });

  it('frees the name when a value is RETIRED, and takes it back on reactivate', async () => {
    // The index is partial on is_active on purpose: retiring "Sales &
    // Marketing" must not reserve the name forever.
    await client.query(`UPDATE master_departments SET is_active = false WHERE id = $1`, [fx.dept]);
    const free = await attempt(`INSERT INTO master_departments (name, is_active) VALUES ('ZZ Gov Dept', true)`);
    expect(free, 'a retired name could not be re-used').toBeNull();

    // …and now reactivating the original WOULD collide, which is exactly why
    // the reactivate route re-checks before updating.
    const clash = await attempt(`UPDATE master_departments SET is_active = true WHERE id = $1`, [fx.dept]);
    expect(clash?.code).toBe('23505');

    // put it back for the remaining cases
    await client.query(`DELETE FROM master_departments WHERE name = 'ZZ Gov Dept' AND id <> $1`, [fx.dept]);
    await client.query(`UPDATE master_departments SET is_active = true WHERE id = $1`, [fx.dept]);
  });

  it('grades stay PER COMPANY — the same name in two tenants is fine', async () => {
    await client.query(`INSERT INTO master_grades (company_id, name, is_active) VALUES ($1,'ZZ Gov Grade',true)`, [OWN]);
    const same = await attempt(`INSERT INTO master_grades (company_id,name,is_active) VALUES ($1,'zz gov grade',true)`, [OWN]);
    expect(same?.code, 'a case variant in the SAME company was accepted').toBe('23505');
    const other = await attempt(`INSERT INTO master_grades (company_id,name,is_active) VALUES ($1,'ZZ Gov Grade',true)`, [FOREIGN]);
    expect(other, 'another tenant was wrongly blocked').toBeNull();
  });

  it('master_values keeps its own normalised index', async () => {
    await client.query(
      `INSERT INTO master_values (type, value, company_id, is_active) VALUES ('BANK','ZZ Gov Bank',$1,true)`, [OWN]);
    const err = await attempt(
      `INSERT INTO master_values (type, value, company_id, is_active) VALUES ('BANK','zz GOV bank',$1,true)`, [OWN]);
    expect(err?.code).toBe('23505');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('usage counting', () => {
  it('counts this company only', async () => {
    const u = await countUsage(USAGE.departments, 'ZZ Gov Dept', OWN, false, client);
    expect(u.total).toBe(2);                       // not 3 — FOREIGN's row is not ours
    expect(u.breakdown[0]).toMatchObject({ label: 'employee', count: 2 });
  });

  it('the other tenant sees its own one', async () => {
    const u = await countUsage(USAGE.departments, 'ZZ Gov Dept', FOREIGN, false, client);
    expect(u.total).toBe(1);
  });

  it('does not count soft-deleted rows', async () => {
    // There are 3 rows in OWN carrying the name; one is deleted_at. A count
    // that ignored deleted_at would say 3 and block a delete that is fine.
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM employees WHERE company_id = $1 AND department = 'ZZ Gov Dept'`, [OWN]);
    expect(rows[0].n).toBe(3);
    const u = await countUsage(USAGE.departments, 'ZZ Gov Dept', OWN, false, client);
    expect(u.total).toBe(2);
  });

  it('matches case- and whitespace-insensitively', async () => {
    // An exact-match count reports 0 for a department stored as 'engineering '
    // and invites a delete that strands it.
    for (const v of ['zz gov dept', '  ZZ GOV DEPT  ']) {
      const u = await countUsage(USAGE.departments, v, OWN, false, client);
      expect(u.total, v).toBe(2);
    }
  });

  it('returns 0 for a value nothing uses', async () => {
    const u = await countUsage(USAGE.departments, 'ZZ Gov Other', OWN, false, client);
    expect(u.total).toBe(0);
    expect(u.breakdown).toEqual([]);
  });

  it('the bulk form agrees with the single form', async () => {
    // The list endpoint uses the bulk one; a disagreement means the badge on
    // the row and the number in the confirm dialog differ.
    const bulk = await countUsageBulk(USAGE.departments, ['ZZ Gov Dept', 'ZZ Gov Other'], OWN, false, client);
    expect(bulk['zz gov dept'].total).toBe(2);
    expect(bulk['zz gov other'].total).toBe(0);
    const single = await countUsage(USAGE.departments, 'ZZ Gov Dept', OWN, false, client);
    expect(bulk['zz gov dept'].total).toBe(single.total);
  });

  it('survives a reference whose table does not exist', async () => {
    // These declarations span modules a deployment may not have migrated.
    const u = await countUsage(
      [{ table: 'zz_no_such_table', column: 'department', label: 'ghost' },
       ...USAGE.departments],
      'ZZ Gov Dept', OWN, false, client);
    expect(u.total).toBe(2);
  });

  it('every declared reference resolves against the real schema', async () => {
    // The check that stops a typo in usage.js silently reporting 0 for ever.
    const all = Object.values(USAGE).flat();
    const { rows } = await pool.query(
      `SELECT table_name || '.' || column_name AS ref FROM information_schema.columns
        WHERE table_schema = 'public'`);
    const known = new Set(rows.map(r => r.ref));
    const missing = all.filter(r => !known.has(`${r.table}.${r.column}`));
    expect(missing.map(r => `${r.table}.${r.column}`)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('deactivation is lossless', () => {
  it('the employees keep the value after the master row is retired', async () => {
    await client.query(`UPDATE master_departments SET is_active = false WHERE id = $1`, [fx.dept]);
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM employees
        WHERE company_id = $1 AND department = 'ZZ Gov Dept' AND deleted_at IS NULL`, [OWN]);
    expect(rows[0].n).toBe(2);
    await client.query(`UPDATE master_departments SET is_active = true WHERE id = $1`, [fx.dept]);
  });

  it('the usage count is unchanged by retirement', async () => {
    // The value is still on those records — which is precisely why it must not
    // be hard-deleted.
    await client.query(`UPDATE master_departments SET is_active = false WHERE id = $1`, [fx.dept]);
    const u = await countUsage(USAGE.departments, 'ZZ Gov Dept', OWN, false, client);
    expect(u.total).toBe(2);
    await client.query(`UPDATE master_departments SET is_active = true WHERE id = $1`, [fx.dept]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the seeded workforce vocabulary is really there', () => {
  it('has the departments housekeeping/security/admin staff need', async () => {
    const { rows } = await pool.query(
      `SELECT name FROM master_departments WHERE is_active
        AND name IN ('Facilities','Security','Administration')`);
    expect(rows.map(r => r.name).sort()).toEqual(['Administration', 'Facilities', 'Security']);
  });

  it('has their designations', async () => {
    const { rows } = await pool.query(
      `SELECT name FROM master_designations WHERE is_active
        AND name IN ('Housekeeping Staff','Security Guard','Driver','Office Assistant')`);
    expect(rows).toHaveLength(4);
  });

  it('the agency-labour model exists and is separate', async () => {
    // Requirement 6: an externally supplied worker is NOT forced into
    // `employees`. contract_labour is company-scoped and carries the
    // contractor, the compliance flags and the contract window.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'contract_labour'`);
    const cols = rows.map(r => r.column_name);
    for (const c of ['company_id', 'contractor_company', 'contract_start', 'contract_expiry',
                     'pf_member', 'esi_covered', 'safety_certified']) {
      expect(cols, c).toContain(c);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('provenance columns are writable', () => {
  it('created_by / updated_by accept a users.id', async () => {
    const { rows: [u] } = await pool.query(`SELECT id FROM users LIMIT 1`);
    const err = await attempt(
      `UPDATE master_departments SET updated_at = NOW(), updated_by = $2 WHERE id = $1`, [fx.dept, u.id]);
    expect(err).toBeNull();
    const { rows } = await client.query(
      `SELECT updated_at, updated_by FROM master_departments WHERE id = $1`, [fx.dept]);
    expect(rows[0].updated_at).toBeTruthy();
    expect(rows[0].updated_by).toBe(u.id);
  });

  it('every governed master has the three columns', async () => {
    const tables = ['master_departments', 'master_designations', 'master_zones',
                    'master_grades', 'master_bands', 'master_values'];
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1)
          AND column_name IN ('updated_at','created_by','updated_by')`, [tables]);
    for (const t of tables) {
      const got = rows.filter(r => r.table_name === t).map(r => r.column_name).sort();
      expect(got, t).toEqual(['created_by', 'updated_at', 'updated_by']);
    }
  });
});
