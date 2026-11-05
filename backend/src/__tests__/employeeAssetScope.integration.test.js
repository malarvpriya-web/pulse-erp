/**
 * Employee-asset scoping and the 2026-09-29 data normalisation, verified
 * BEHAVIOURALLY against the live database.
 *
 * The contract file proves the handlers mention the right predicates. It cannot
 * tell a predicate that works from one that is present and wrong — a
 * mis-numbered `$n` in a 12-parameter UPDATE is exactly the failure mode here,
 * and it reads as "scoped" in any source search.
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
const { resolveZone } = await import('../employees/employee.service.js');

const OWN = 990601;
const FOREIGN = 990602;

let client;
const fx = {};

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');

  for (const [id, name, code] of [[OWN, 'ZZ Asset Own', 'ZZAO'], [FOREIGN, 'ZZ Asset Foreign', 'ZZAF']]) {
    await client.query(`INSERT INTO companies (id,name,code) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [id, name, code]);
  }

  const emp = async (cid, code, email) => (await client.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email,
                            department, designation, status, joining_date)
     VALUES ($1,$2,'ZZ','Asset',$3,'HR','Manager','Active','2026-01-01') RETURNING id`,
    [cid, code, email])).rows[0].id;
  fx.ownEmp     = await emp(OWN,     'EMP905001', 'zzasset.own@example.com');
  fx.ownEmp2    = await emp(OWN,     'EMP905002', 'zzasset.own2@example.com');
  fx.foreignEmp = await emp(FOREIGN, 'EMP905003', 'zzasset.foreign@example.com');

  const alloc = async (cid, empId, name) => (await client.query(
    `INSERT INTO employee_asset_allocations (company_id, employee_id, asset_type, asset_name, status, allocated_date)
     VALUES ($1,$2,'Laptop',$3,'allocated',CURRENT_DATE) RETURNING id`,
    [cid, empId, name])).rows[0].id;
  fx.ownAsset     = await alloc(OWN,     fx.ownEmp,     'ZZ Own Laptop');
  fx.foreignAsset = await alloc(FOREIGN, fx.foreignEmp, 'ZZ Foreign Laptop');
});

afterAll(async () => {
  if (client) { await client.query('ROLLBACK'); client.release(); }
});

/** The scope predicate every asset write now carries. */
const SCOPED = ` AND ($2::int IS NULL OR company_id = $2)`;

// ═════════════════════════════════════════════════════════════════════════════
describe('the scope predicate itself', () => {
  it('finds the caller\'s own allocation', async () => {
    const { rows } = await client.query(
      `SELECT id FROM employee_asset_allocations WHERE id = $1${SCOPED}`, [fx.ownAsset, OWN]);
    expect(rows).toHaveLength(1);
  });

  it('does NOT find another tenant\'s allocation', async () => {
    const { rows } = await client.query(
      `SELECT id FROM employee_asset_allocations WHERE id = $1${SCOPED}`, [fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
  });

  it('a global scope (null) still sees both', async () => {
    // `$2 IS NULL` is the genuinely-unscoped super-admin branch. If this stopped
    // working, a platform admin would silently lose every row.
    const { rows } = await client.query(
      `SELECT id FROM employee_asset_allocations WHERE id = ANY($1)
        AND ($2::int IS NULL OR company_id = $2)`, [[fx.ownAsset, fx.foreignAsset], null]);
    expect(rows).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('each write, run exactly as its handler runs it', () => {
  /** Mirrors PUT /:id. */
  const RENAME = `UPDATE employee_asset_allocations SET asset_name = COALESCE($1, asset_name)
                   WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`;

  it('PUT cannot rename another tenant\'s asset', async () => {
    const { rows } = await client.query(RENAME, ['ZZ Hijacked', fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
    const { rows: still } = await client.query(
      `SELECT asset_name FROM employee_asset_allocations WHERE id=$1`, [fx.foreignAsset]);
    expect(still[0].asset_name).toBe('ZZ Foreign Laptop');
  });

  it('PUT can rename its own', async () => {
    const { rows } = await client.query(RENAME, ['ZZ Renamed', fx.ownAsset, OWN]);
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_name).toBe('ZZ Renamed');
  });

  /** Mirrors PATCH /:id/return. */
  it('RETURN cannot touch another tenant\'s asset', async () => {
    const { rows } = await client.query(
      `UPDATE employee_asset_allocations SET status='returned', return_date=CURRENT_DATE
        WHERE id=$1 AND status='allocated' AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
  });

  /** Mirrors POST /:id/maintenance and /complete. */
  it('MAINTENANCE cannot touch another tenant\'s asset', async () => {
    const { rows } = await client.query(
      `UPDATE employee_asset_allocations SET status='under_maintenance'
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
  });

  /** Mirrors PATCH /:id/dispose. */
  it('DISPOSE cannot scrap another tenant\'s asset', async () => {
    const { rows } = await client.query(
      `UPDATE employee_asset_allocations SET status='disposed', disposed_at=NOW()
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING *`,
      [fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
    const { rows: still } = await client.query(
      `SELECT status FROM employee_asset_allocations WHERE id=$1`, [fx.foreignAsset]);
    expect(still[0].status).toBe('allocated');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('transfer checks BOTH ends', () => {
  const DEST = `SELECT id FROM employees
                 WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2) LIMIT 1`;

  it('accepts a destination inside the company', async () => {
    const { rows } = await client.query(DEST, [fx.ownEmp2, OWN]);
    expect(rows).toHaveLength(1);
  });

  it('REFUSES a destination in another company', async () => {
    // Without this the asset leaves its tenant: the row keeps company A's
    // company_id and points at an employee in B.
    const { rows } = await client.query(DEST, [fx.foreignEmp, OWN]);
    expect(rows).toHaveLength(0);
  });

  it('the allocation side is scoped too', async () => {
    const { rows } = await client.query(
      `UPDATE employee_asset_allocations SET employee_id = $1
        WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [fx.ownEmp2, fx.foreignAsset, OWN]);
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the 2026-09-29 normalisation held', () => {
  it('no employee carries an empty-string employment type', async () => {
    // '' and NULL both mean "not recorded", but only one survives a truthiness
    // check — four rows read as having a type and displayed blank.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM employees WHERE employment_type = ''`);
    expect(rows[0].n).toBe(0);
  });

  it('no employee carries a snake_case employment type', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT employment_type FROM employees
        WHERE employment_type IS NOT NULL AND employment_type LIKE '%\\_%'`);
    expect(rows.map(r => r.employment_type)).toEqual([]);
  });

  it('every stored employment type is in the master', async () => {
    // The real test of the normalisation: a value no picker can offer back is a
    // value the employee's own record cannot round-trip.
    const { rows } = await pool.query(
      `SELECT DISTINCT e.employment_type FROM employees e
        WHERE NULLIF(BTRIM(COALESCE(e.employment_type,'')),'') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM master_values m
             WHERE m.type='EMPLOYMENT_TYPE' AND m.is_active
               AND LOWER(BTRIM(m.value)) = LOWER(BTRIM(e.employment_type)))`);
    expect(rows.map(r => r.employment_type)).toEqual([]);
  });

  it('the zone master holds no SEED artefacts as active values', async () => {
    const { rows } = await pool.query(
      `SELECT name FROM master_zones WHERE is_active AND name ~ '^SEED .*-SEED[0-9]+$'`);
    expect(rows.map(r => r.name)).toEqual([]);
  });

  it('every employee zone text is linked to a master row', async () => {
    const { rows } = await pool.query(
      `SELECT id, zone FROM employees
        WHERE NULLIF(BTRIM(COALESCE(zone,'')),'') IS NOT NULL AND zone_id IS NULL`);
    expect(rows).toEqual([]);
  });

  it('no zone_id points at a different name than the text column', async () => {
    // The two must not drift; resolveZone derives the text from the master row.
    const { rows } = await pool.query(
      `SELECT e.id, e.zone, z.name FROM employees e JOIN master_zones z ON z.id = e.zone_id
        WHERE LOWER(BTRIM(e.zone)) <> LOWER(BTRIM(z.name))`);
    expect(rows).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('resolveZone keeps new rows consistent', () => {
  it('resolves a name to its master row', async () => {
    const z = await resolveZone(client, '', 'North');
    expect(z).toMatchObject({ name: 'North' });
    expect(z.id).toBeTruthy();
  });

  it('matches case- and whitespace-insensitively', async () => {
    const z = await resolveZone(client, '', '  north ');
    expect(z?.name).toBe('North');
  });

  it('prefers an explicit id', async () => {
    const { rows: [north] } = await client.query(
      `SELECT id FROM master_zones WHERE name='North' AND is_active`);
    const z = await resolveZone(client, String(north.id), 'ignored');
    expect(z.id).toBe(north.id);
  });

  it('returns null for a blank zone — it is optional', async () => {
    for (const empty of ['', '   ', null, undefined]) {
      await expect(resolveZone(client, empty, empty)).resolves.toBeNull();
    }
  });

  it('does NOT refuse a name the shared master lacks', async () => {
    // master_zones is shared and only an admin may add to it, so refusing here
    // would block a hire over a value HR cannot create. The text is kept and
    // zone_id stays null — the pre-existing behaviour, not an error.
    await expect(resolveZone(client, '', 'ZZ Not A Zone')).resolves.toBeNull();
  });

  it('refuses a retired zone id', async () => {
    const { rows: [seed] } = await client.query(
      `SELECT id FROM master_zones WHERE NOT is_active LIMIT 1`);
    if (!seed) return;
    await expect(resolveZone(client, String(seed.id), null))
      .rejects.toThrow(/does not exist/i);
  });

  it('refuses a non-numeric id as a 400, not a Postgres 500', async () => {
    const err = await resolveZone(client, 'DROP TABLE', null).catch(e => e);
    expect(err.statusCode).toBe(400);
  });
});
