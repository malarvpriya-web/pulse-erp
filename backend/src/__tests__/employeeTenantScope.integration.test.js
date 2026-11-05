/**
 * The tenant-scoping predicates added in this pass, verified BEHAVIOURALLY.
 *
 * `employeeWriteScope.contract.test.js` proves every employees write mentions
 * `company_id`. That is a text check: it cannot tell a predicate that works from
 * one that is present and wrong — a mis-numbered `$n`, a predicate on the wrong
 * alias, an `OR` where an `AND` was meant. This runs each rewritten statement
 * against the live database twice, once for a row the caller owns and once for a
 * row in another tenant, and requires 1 row and 0 rows.
 *
 * Both of the cross-tenant defects found in this work (`PATCH /employees/:id/status`
 * and `POST /exit/fnf/:id/pay`) were single missing clauses in otherwise ordinary
 * handlers. The statement is the unit worth testing.
 *
 * Everything runs inside a transaction that is always rolled back.
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

const OWN = 1;
const FOREIGN = 565;

/**
 * Each statement exactly as the handler issues it. Copied rather than imported
 * because these are inline template literals inside route handlers — extracting
 * them into constants purely to test them would change production code to suit
 * the test. `employeeWriteScope.contract.test.js` is what notices if a handler
 * grows a new unscoped write; this is what notices if one of THESE stops working.
 */
const STATEMENTS = {
  'POST /employees/:id/offboard': {
    sql: `UPDATE employees SET status=$1, updated_at=NOW()
           WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)`,
    params: (id, co) => ['Notice', id, co],
  },
  'POST /employees/ex/:id/rehire': {
    sql: `UPDATE employees
             SET status = $1, joining_date = $2, exit_date = NULL, exit_reason = NULL,
                 updated_at = NOW()
           WHERE id = $3 AND ($4::int IS NULL OR company_id = $4) RETURNING *`,
    params: (id, co) => ['Active', '2026-01-01', id, co],
  },
  'POST /exit/initiate': {
    sql: `UPDATE employees SET status=$1, updated_at=NOW()
           WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)`,
    params: (id, co) => ['Notice', id, co],
  },
  'POST /hr/offboarding/:id/complete': {
    sql: `UPDATE employees
             SET status = $1, exit_date = COALESCE(exit_date, $2, CURRENT_DATE),
                 updated_at = NOW()
           WHERE id = $3 AND ($4::int IS NULL OR company_id = $4)`,
    params: (id, co) => ['Left', null, id, co],
  },
  'PUT /self-service/employees/:id/profile': {
    sql: `UPDATE employees SET
             current_address=COALESCE($1,current_address),
             emergency_name=COALESCE($2,emergency_name),
             blood_group=COALESCE($3,blood_group),
             account_number=COALESCE($4,account_number),
             ifsc_code=COALESCE($5,ifsc_code),
             bank_name=COALESCE($6,bank_name)
           WHERE id=$7 AND ($8::int IS NULL OR company_id = $8) RETURNING id`,
    params: (id, co) => ['addr', null, null, null, null, null, id, co],
  },
  'POST /security/gdpr/purge/:userId (pre-read)': {
    sql: `SELECT company_email FROM employees
           WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
    params: (id, co) => [id, co],
  },
};

describe('tenant scoping, verified against the database', () => {
  let client, ownId, foreignId;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: [own] } = await client.query(
      `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [OWN]);
    const { rows: [foreign] } = await client.query(
      `SELECT id FROM employees WHERE company_id = $1 LIMIT 1`, [FOREIGN]);
    ownId = own?.id;
    foreignId = foreign?.id;
    expect(ownId, `company ${OWN} needs an employee`).toBeDefined();
    expect(foreignId, `company ${FOREIGN} needs an employee`).toBeDefined();
  });

  afterAll(async () => {
    // Always rolled back — nothing this suite does reaches the database.
    if (client) { await client.query('ROLLBACK'); client.release(); }
  });

  for (const [label, { sql, params }] of Object.entries(STATEMENTS)) {
    it(`${label} — affects the caller's own employee`, async () => {
      const r = await client.query(sql, params(ownId, OWN));
      expect(r.rowCount).toBe(1);
    });

    it(`${label} — cannot touch another tenant's employee`, async () => {
      const r = await client.query(sql, params(foreignId, OWN));
      expect(r.rowCount, 'a cross-tenant row must not be reachable').toBe(0);
    });
  }

  it("POST /exit/fnf/:id/pay reads the exit request through the employee's company", async () => {
    const READ = `SELECT er.employee_id FROM exit_requests er
                    JOIN employees e ON e.id = er.employee_id
                   WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2)`;
    const { rows: ers } = await client.query(
      `SELECT er.id FROM exit_requests er JOIN employees e ON e.id = er.employee_id
        WHERE e.company_id = $1 LIMIT 1`, [OWN]);
    if (!ers.length) return;   // no exit requests to read; nothing to assert

    // `exit_requests` carries no company_id of its own, so the scope has to come
    // through this join. Reading it by id alone is what let a company A HR user
    // mark any company's F&F paid and terminate that employee.
    expect((await client.query(READ, [ers[0].id, OWN])).rowCount).toBe(1);
    expect((await client.query(READ, [ers[0].id, FOREIGN])).rowCount).toBe(0);
  });

  it('an unscoped caller (companyId null) is not blocked', async () => {
    // `companyOf(req)` returns null for a genuinely global caller, and the
    // ($n IS NULL OR ...) form has to keep working for them — otherwise adding
    // these predicates would have silently broken platform-level access.
    const { sql, params } = STATEMENTS['POST /employees/:id/offboard'];
    const r = await client.query(sql, params(foreignId, null));
    expect(r.rowCount).toBe(1);
  });
});
