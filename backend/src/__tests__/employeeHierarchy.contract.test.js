/**
 * Reporting hierarchy: no self-reference, no cycles, no cross-tenant edges.
 *
 * `employees.reporting_manager_id` is a self-referencing FK with `ON DELETE SET
 * NULL` and nothing else. A relational constraint cannot express "no cycles", so
 * the invariant lives in `shared/employeeHierarchy.js` — and it only holds if
 * every write path calls it. Before this, two of four did:
 *
 *   PUT /orgchart/hierarchy (bulk)           → checked (wouldCreateCycle)
 *   orgChartRepository.upsert                → checked
 *   PUT /orgchart/reporting-manager (single) → NOT checked
 *   POST/PUT /employees (Add/Edit Employee)  → NOT checked
 *
 * The live consequence: employee 1 (`Malar Natesh`, designation CEO) had
 * `reporting_manager_id = 1`. Recursive walks from employees 2 and 3 reported
 * "cycles" whose paths were [2,1,1] and [3,2,1,1] — one self-loop showing up as
 * three defects. Repaired by `scripts/hr/repair-employee-data.mjs --apply`
 * (a CEO's correct manager is NULL, which is determinable, not a guess).
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
const { assertValidManager, findHierarchyDefects } = await import('../shared/employeeHierarchy.js');
const { updateEmployee } = await import('../employees/employee.service.js');

const COMPANY_ID = 1;
const OTHER_COMPANY = 565;

/**
 * Run `fn` against a client whose transaction starts from a KNOWN hierarchy:
 * every employee in `ids` has no manager. Always rolled back.
 *
 * Without this, a test asserting "a may report to b" depends on whatever the live
 * data happens to say — and the live data says employee 2 already reports to
 * employee 1, so `1 -> 2` is correctly refused as a cycle. The first version of
 * this suite failed for exactly that reason: the validator was right and the test
 * was asserting against an assumption it had not established.
 */
async function withClearedManagers(ids, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE employees SET reporting_manager_id = NULL WHERE id = ANY($1::int[])`, [ids]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('hierarchy validator', () => {
  /** Two live employees in company 1, and one in another tenant. */
  let a, b, foreign;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 2`,
      [COMPANY_ID],
    );
    [a, b] = rows.map(r => r.id);
    const { rows: f } = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 LIMIT 1`, [OTHER_COMPANY]);
    foreign = f[0]?.id ?? null;
    expect(a, 'company 1 needs at least 2 employees').toBeDefined();
    expect(b).toBeDefined();
  });

  it('clearing the manager is always allowed', async () => {
    // The top of a hierarchy has no manager, so null must never be an error.
    await expect(assertValidManager(pool, { employeeId: a, managerId: null,      companyId: COMPANY_ID })).resolves.toBeNull();
    await expect(assertValidManager(pool, { employeeId: a, managerId: undefined, companyId: COMPANY_ID })).resolves.toBeNull();
    await expect(assertValidManager(pool, { employeeId: a, managerId: '',        companyId: COMPANY_ID })).resolves.toBeNull();
  });

  it('rejects an employee as their own manager', async () => {
    // The defect that was actually in the data.
    await expect(assertValidManager(pool, { employeeId: a, managerId: a, companyId: COMPANY_ID }))
      .rejects.toThrow(/own reporting manager/i);
  });

  it('rejects a manager that does not exist', async () => {
    await expect(assertValidManager(pool, { employeeId: a, managerId: 99999999, companyId: COMPANY_ID }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a manager in another company, and does not confirm it exists', async () => {
    if (foreign == null) return;
    // Same wording as "does not exist" on purpose: telling the caller that an id
    // is real but belongs to another tenant is itself a cross-tenant leak.
    await expect(assertValidManager(pool, { employeeId: a, managerId: foreign, companyId: COMPANY_ID }))
      .rejects.toThrow(/does not exist/i);
  });

  it('rejects a non-integer manager id before querying', async () => {
    for (const bad of ['abc', -1, 0, 1.5]) {
      await expect(
        assertValidManager(pool, { employeeId: a, managerId: bad, companyId: COMPANY_ID }),
        String(bad),
      ).rejects.toThrow(/not a valid reporting manager|does not exist/i);
    }
  });

  it('accepts a legitimate manager in the same company', async () => {
    await withClearedManagers([a, b], async (client) => {
      await expect(assertValidManager(client, { employeeId: a, managerId: b, companyId: COMPANY_ID }))
        .resolves.toMatchObject({ id: b });
    });
  });

  it('rejects a two-step cycle A -> B -> A', async () => {
    // Build B -> A inside a transaction, then ask whether A -> B is allowed.
    // Rolled back, so the live hierarchy is untouched.
    await withClearedManagers([a, b], async (client) => {
      await client.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [a, b]);
      await expect(assertValidManager(client, { employeeId: a, managerId: b, companyId: COMPANY_ID }))
        .rejects.toThrow(/circular reporting chain/i);
    });
  });

  it('rejects a longer cycle A -> B -> C -> A', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 3`,
      [COMPANY_ID]);
    if (rows.length < 3) return;
    const [x, y, z] = rows.map(r => r.id);
    await withClearedManagers([x, y, z], async (client) => {
      await client.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [x, y]); // y -> x
      await client.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [y, z]); // z -> y
      // x -> z would close x -> z -> y -> x.
      await expect(assertValidManager(client, { employeeId: x, managerId: z, companyId: COMPANY_ID }))
        .rejects.toThrow(/circular reporting chain/i);
    });
  });

  it('refuses to hang a report off a PRE-EXISTING loop rather than looping forever', async () => {
    // A loop that does not include the employee being assigned. The walk must
    // terminate on the repeat and say where the corruption is, not spin.
    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 3`,
      [COMPANY_ID]);
    if (rows.length < 3) return;
    const [x, y, z] = rows.map(r => r.id);
    await withClearedManagers([x, y, z], async (client) => {
      await client.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [z, y]); // y -> z
      await client.query(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [y, z]); // z -> y  (loop)
      await expect(assertValidManager(client, { employeeId: x, managerId: y, companyId: COMPANY_ID }))
        .rejects.toThrow(/already sits in a circular reporting chain/i);
    });
  });
});

describe('hierarchy validation is wired into the employee write path', () => {
  let a;
  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [COMPANY_ID]);
    a = rows[0].id;
  });

  it('PUT /employees rejects a self-manager', async () => {
    // Proves the validator is reachable from Edit Employee, which is the path
    // that had no check at all. A unit test of the validator alone would pass
    // while this path stayed open — that is exactly how it stayed open.
    await expect(updateEmployee(a, { reporting_manager_id: a }, COMPANY_ID))
      .rejects.toThrow(/own reporting manager/i);
  });

  it('PUT /employees rejects a cross-tenant manager', async () => {
    const { rows } = await pool.query(`SELECT id FROM employees WHERE company_id = $1 LIMIT 1`, [OTHER_COMPANY]);
    if (!rows.length) return;
    await expect(updateEmployee(a, { reporting_manager_id: rows[0].id }, COMPANY_ID))
      .rejects.toThrow(/does not exist/i);
  });
});

describe('the live hierarchy is clean', () => {
  afterAll(() => { /* not pool.end() — the pool is shared across suites */ });

  it('no employee is their own manager', async () => {
    const d = await findHierarchyDefects(pool, null);
    expect(d.selfManaged.map(r => `#${r.id} ${r.name}`)).toEqual([]);
  });

  it('no circular reporting chains', async () => {
    const d = await findHierarchyDefects(pool, null);
    expect(d.cycles.map(r => r.path.join('->'))).toEqual([]);
  });

  it('no manager belongs to a different company than their report', async () => {
    const d = await findHierarchyDefects(pool, null);
    expect(d.crossTenant).toEqual([]);
  });
});
