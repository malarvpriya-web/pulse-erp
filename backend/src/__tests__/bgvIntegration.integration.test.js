/**
 * BGV — behaviour, against the real database.
 *
 * `bgvContracts.contract.test.js` proves the predicates are PRESENT. That is a
 * text check: it cannot tell a predicate that works from one that is present and
 * wrong — a mis-numbered `$n`, a predicate on the wrong alias, an OR where an AND
 * was meant. Both cross-tenant defects in the employee work were single missing
 * or misplaced clauses in otherwise ordinary handlers, so the STATEMENT is the
 * unit worth running.
 *
 * Three things are verified here and nowhere else:
 *
 * 1. SCOPE WORKS. Each scope predicate is run twice — once for a record the
 *    caller owns, once for one in another tenant — and required to return 1 row
 *    and 0 rows.
 *
 * 2. THE DERIVED CASE STATUS IS ONE ANSWER. The same CASE expression drives the
 *    list, the dashboard counts and the detail page, so a fixture is walked
 *    through every state and each is required to come out as the state the UI
 *    names.
 *
 * 3. A KPI CARD OPENS THE POPULATION IT COUNTED. The dashboard publishes the
 *    filter behind each number; every count is re-derived through that filter and
 *    required to match. This is the check that caught the real defect in this
 *    pass — "Employees Under BGV" counted 1 and its (empty) filter opened 32.
 *
 * Everything runs inside ONE transaction that is always rolled back, so nothing
 * here reaches the register. The fixtures are created here rather than assumed,
 * because the BGV tables start empty.
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
 * The SQL the router issues — IMPORTED, not copied and not scraped.
 *
 * These are exported from bgv.routes.js for exactly this reason. The first
 * version of this file lifted them out of the source with a regex, which is a
 * copy by another name: it would keep passing after the text it was scraping
 * changed shape, and it in fact produced a bind error ("could not determine data
 * type of parameter $1") because the scraper never resolved the nested `${n}`.
 * Importing them means this suite runs the same string production runs.
 */
const {
  CASE_SELECT, CASE_FROM, caseScopeSql, checkScopeSql, CHECK_CONTACT_SELECT,
} = await import('../modules/hr/bgv.routes.js');

const ROUTES_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../modules/hr/bgv.routes.js'), 'utf8');

let client;
let ownEmp, foreignEmp, ownAgency, foreignAgency, ownCase, foreignCase, ownCheck;

/**
 * The list CTE, exactly as buildListQuery composes it, with an arbitrary tail.
 *
 * ⚠ `listSql()` must not be concatenated with another `, cte AS (...)`: the
 * statement already ends in a SELECT, so appending a second CTE is a bare
 * "syntax error at or near (". Anything that needs to aggregate over the rows
 * passes its own tail here instead.
 */
const withRows = (tail) => `
  WITH rows AS (
    SELECT ${CASE_SELECT}
    ${CASE_FROM}
  )
  ${tail}`;

const listSql = (extra = '') => withRows(`SELECT * FROM rows${extra}`);

/**
 * Run something that is EXPECTED to violate a constraint.
 *
 * ⚠ Necessary, not decoration. A failed statement poisons the surrounding
 * transaction — every later query returns "current transaction is aborted", so
 * one deliberate 23505 turned 18 unrelated assertions red and the real failure
 * was buried at the top of the list. The savepoint contains the damage.
 */
async function expectViolation(sql, params) {
  await client.query('SAVEPOINT v');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT v');
    return null;                      // it did NOT fail — the caller asserts that
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT v');
    return err;
  }
}

/** The derived status of one employee, through the production expression. */
async function statusOf(employeeId, companyId = OWN) {
  const { rows } = await client.query(
    `${listSql(' WHERE employee_id = $2')}`, [companyId, employeeId]);
  return rows[0] ?? null;
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');

  const { rows: [own] } = await client.query(
    `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, [OWN]);
  const { rows: [foreign] } = await client.query(
    `SELECT id FROM employees WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1`, [FOREIGN]);
  ownEmp = own?.id;
  foreignEmp = foreign?.id;
  expect(ownEmp, `company ${OWN} needs an employee`).toBeDefined();
  expect(foreignEmp, `company ${FOREIGN} needs an employee`).toBeDefined();

  const mkAgency = async (companyId, name) => (await client.query(
    `INSERT INTO bgv_agencies (company_id, agency_name) VALUES ($1, $2) RETURNING id`,
    [companyId, name])).rows[0].id;
  ownAgency     = await mkAgency(OWN, 'ZZBGV Own Agency');
  foreignAgency = await mkAgency(FOREIGN, 'ZZBGV Foreign Agency');

  const mkCase = async (employeeId, agencyId) => (await client.query(
    `INSERT INTO bgv_cases (employee_id, primary_agency_id, initiated_on)
     VALUES ($1, $2, CURRENT_DATE) RETURNING id`, [employeeId, agencyId])).rows[0].id;
  ownCase     = await mkCase(ownEmp, ownAgency);
  foreignCase = await mkCase(foreignEmp, foreignAgency);

  ownCheck = (await client.query(
    `INSERT INTO bgv_checks (case_id, check_type, agency_id, amount, tax_amount)
     VALUES ($1, 'Identity Verification', $2, 500, 90) RETURNING id`,
    [ownCase, ownAgency])).rows[0].id;
});

afterAll(async () => {
  // Always rolled back — no BGV fixture reaches the database.
  if (client) { await client.query('ROLLBACK'); client.release(); }
});

describe('the scope predicates actually work', () => {
  it('caseScopeSql reaches a case in the caller\'s tenant', async () => {
    const r = await client.query(
      `SELECT id FROM bgv_cases WHERE ${caseScopeSql(1)} AND id = $2`, [OWN, ownCase]);
    expect(r.rowCount).toBe(1);
  });

  it('caseScopeSql cannot reach another tenant\'s case', async () => {
    const r = await client.query(
      `SELECT id FROM bgv_cases WHERE ${caseScopeSql(1)} AND id = $2`, [OWN, foreignCase]);
    expect(r.rowCount, 'a cross-tenant BGV case must not be reachable').toBe(0);
  });

  it('checkScopeSql reaches a check in the caller\'s tenant', async () => {
    const r = await client.query(
      `SELECT id FROM bgv_checks WHERE ${checkScopeSql(1)} AND id = $2`, [OWN, ownCheck]);
    expect(r.rowCount).toBe(1);
  });

  it('checkScopeSql cannot reach a check under another tenant\'s case', async () => {
    const foreignCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1, 'Address Verification') RETURNING id`,
      [foreignCase])).rows[0].id;
    const r = await client.query(
      `SELECT id FROM bgv_checks WHERE ${checkScopeSql(1)} AND id = $2`, [OWN, foreignCheck]);
    expect(r.rowCount).toBe(0);
  });

  it('a global (null company) scope is genuinely global, not a forgotten filter', async () => {
    // `($n::int IS NULL OR ...)` is the house pattern. Asserted so nobody
    // "tightens" it into a predicate that locks a super-admin out.
    const r = await client.query(
      `SELECT id FROM bgv_cases WHERE ${caseScopeSql(1)} AND id = ANY($2)`,
      [null, [ownCase, foreignCase]]);
    expect(r.rowCount).toBe(2);
  });

  it('the employee list never returns another tenant\'s employee', async () => {
    const { rows } = await client.query(listSql(), [OWN]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.employee_id === foreignEmp)).toBe(false);
  });

  it('an agency from another tenant is not selectable', async () => {
    // The same lookup agencyInScope() performs before any write accepts an
    // agency_id. The FK proves the agency EXISTS, never that it is ours.
    const q = `SELECT 1 FROM bgv_agencies WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int)`;
    expect((await client.query(q, [ownAgency, OWN])).rowCount).toBe(1);
    expect((await client.query(q, [foreignAgency, OWN])).rowCount).toBe(0);
  });
});

describe('the case status is derived, and there is only one of it', () => {
  it('an employee with no case at all reads as Not Started', async () => {
    const { rows } = await client.query(
      `${listSql(' WHERE case_id IS NULL')}`, [OWN]);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(r => r.bgv_status))).toEqual(new Set(['Not Started']));
  });

  it('a case with no checks is Not Started, not Initiated', async () => {
    const empty = (await client.query(
      `SELECT id FROM employees WHERE company_id=$1 AND deleted_at IS NULL AND id <> $2 ORDER BY id LIMIT 1`,
      [OWN, ownEmp])).rows[0].id;
    await client.query(`INSERT INTO bgv_cases (employee_id) VALUES ($1)`, [empty]);
    const row = await statusOf(empty);
    expect(row.bgv_status).toBe('Not Started');
    expect(Number(row.checks_total)).toBe(0);
  });

  it('checks that all sit at Pending make the case Initiated', async () => {
    const row = await statusOf(ownEmp);
    expect(row.bgv_status).toBe('Initiated');
  });

  it('a check in flight makes the case In Progress', async () => {
    await client.query(`UPDATE bgv_checks SET status='In Progress' WHERE id=$1`, [ownCheck]);
    expect((await statusOf(ownEmp)).bgv_status).toBe('In Progress');
  });

  it('every check Completed makes the case Completed', async () => {
    await client.query(
      `UPDATE bgv_checks SET status='Completed', result='Clear', completed_date=CURRENT_DATE WHERE id=$1`,
      [ownCheck]);
    expect((await statusOf(ownEmp)).bgv_status).toBe('Completed');
  });

  it('a Cancelled check does not hold the case open', async () => {
    const extra = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, status) VALUES ($1,'Reference Check','Cancelled') RETURNING id`,
      [ownCase])).rows[0].id;
    expect((await statusOf(ownEmp)).bgv_status).toBe('Completed');
    await client.query(`DELETE FROM bgv_checks WHERE id=$1`, [extra]);
  });

  it('⚠ a discrepancy OUTRANKS "all done" — a finished case with a finding is not Completed', async () => {
    // The single most important line in this file. "Completed" must never be
    // readable as "cleared": a case whose every check is finished but one of
    // which found a discrepancy reports Discrepancy, not Completed.
    await client.query(`UPDATE bgv_checks SET result='Discrepancy' WHERE id=$1`, [ownCheck]);
    const row = await statusOf(ownEmp);
    expect(row.bgv_status).toBe('Discrepancy');
    expect(Number(row.checks_completed)).toBe(Number(row.checks_total));
  });

  it('Closed is stored and overrides everything the checks say', async () => {
    await client.query(`UPDATE bgv_cases SET closed_at=NOW() WHERE id=$1`, [ownCase]);
    expect((await statusOf(ownEmp)).bgv_status).toBe('Closed');
    await client.query(`UPDATE bgv_cases SET closed_at=NULL WHERE id=$1`, [ownCase]);
    expect((await statusOf(ownEmp)).bgv_status, 'reopening restores the derived state')
      .toBe('Discrepancy');
  });
});

describe('the rollup counts what it says it counts', () => {
  it('cost sums only what was captured — NULL contributes nothing', async () => {
    const free = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, amount, tax_amount)
       VALUES ($1, 'Document Verification', 0, 0) RETURNING id, total_amount`,
      [ownCase])).rows[0];
    const unknown = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1, 'Other') RETURNING id, total_amount`,
      [ownCase])).rows[0];

    // A genuinely free check totals 0. An uncaptured one totals NULL. That
    // distinction is the whole reason amount has no DEFAULT.
    expect(Number(free.total_amount)).toBe(0);
    expect(unknown.total_amount).toBeNull();

    const row = await statusOf(ownEmp);
    expect(Number(row.total_cost), '590 from the priced check + 0 from the free one').toBe(590);

    await client.query(`DELETE FROM bgv_checks WHERE id = ANY($1)`, [[free.id, unknown.id]]);
  });

  it('reports_missing counts checks with no document, ignoring cancelled ones', async () => {
    let row = await statusOf(ownEmp);
    const before = Number(row.reports_missing);
    expect(before).toBe(1);

    await client.query(
      `INSERT INTO bgv_documents (check_id, document_name, file_url)
       VALUES ($1, 'ZZ report.pdf', '/uploads/zz-not-real.pdf')`, [ownCheck]);
    row = await statusOf(ownEmp);
    expect(Number(row.reports_missing), 'attaching a report clears the flag').toBe(0);

    const cancelled = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, status) VALUES ($1,'Other','Cancelled') RETURNING id`,
      [ownCase])).rows[0].id;
    row = await statusOf(ownEmp);
    expect(Number(row.reports_missing), 'a cancelled check needs no report').toBe(0);
    await client.query(`DELETE FROM bgv_checks WHERE id=$1`, [cancelled]);
  });

  it('the rollup does NOT fan out when a check has several documents', async () => {
    // A GROUP BY over two child joins double-counts silently.
    // [[project_sql_fanout_multi_child_join]] — the LATERAL is what prevents it.
    const before = await statusOf(ownEmp);
    await client.query(
      `INSERT INTO bgv_documents (check_id, document_name, file_url)
       VALUES ($1,'ZZ second.pdf','/uploads/zz-2.pdf'), ($1,'ZZ third.pdf','/uploads/zz-3.pdf')`,
      [ownCheck]);
    await client.query(
      `INSERT INTO bgv_check_contacts (check_id, contact_type) VALUES ($1,'Previous Employer'), ($1,'Reference')`,
      [ownCheck]);
    const after = await statusOf(ownEmp);
    expect(Number(after.checks_total), 'documents and contacts must not multiply the check count')
      .toBe(Number(before.checks_total));
    expect(Number(after.total_cost), 'nor the cost').toBe(Number(before.total_cost));
  });

  it('one case per employee is a constraint, not a convention', async () => {
    // A double-click on "Start BGV" must not be able to split an employee's
    // checks and spend across two records.
    const err = await expectViolation(
      `INSERT INTO bgv_cases (employee_id) VALUES ($1)`, [ownEmp]);
    expect(err, 'a second case for the same employee was accepted').toBeTruthy();
    expect(err.code).toBe('23505');
  });

  it('agency names are unique per tenant, case-insensitively', async () => {
    // An exact-case index would let 'ABC Verification' and 'abc verification'
    // both in, and split the vendor's spend across the two.
    const err = await expectViolation(
      `INSERT INTO bgv_agencies (company_id, agency_name) VALUES ($1, $2)`,
      [OWN, '  zzbgv OWN agency ']);
    expect(err, 'a case/whitespace variant of an existing agency was accepted').toBeTruthy();
    expect(err.code).toBe('23505');
  });

  it('the same agency name IS allowed in a different tenant', async () => {
    const r = await client.query(
      `INSERT INTO bgv_agencies (company_id, agency_name) VALUES ($1,$2) RETURNING id`,
      [FOREIGN, 'ZZBGV Own Agency']);
    expect(r.rowCount).toBe(1);
  });
});

describe('every dashboard KPI reproduces its own count through its own filter', () => {
  /**
   * The published filters, read out of the router's KPI block so this cannot
   * drift from what the dashboard actually sends the frontend.
   *
   * ⚠ This is the check that found the real defect in this pass: the
   * "Employees Under BGV" card was published with `filter: {}`, so it counted 1
   * and opened a list of 32 — a card whose number and whose population disagreed,
   * which is precisely the "fake filter that doesn't actually change the
   * population" the brief forbids. Reading the code did not reveal it; comparing
   * each count against its own filter did.
   */
  const KPI_SQL = {
    // count expression                      ->  the filter clause it must equal
    'under_bgv':       ['checks_total > 0',                       'checks_total > 0'],
    'not_started':     [`bgv_status = 'Not Started'`,             `bgv_status = 'Not Started'`],
    'in_progress':     [`bgv_status = 'In Progress'`,             `bgv_status = 'In Progress'`],
    'completed':       [`bgv_status = 'Completed'`,               `bgv_status = 'Completed'`],
    'discrepancy':     [`bgv_status = 'Discrepancy'`,             `bgv_status = 'Discrepancy'`],
    'pending_reports': ['reports_missing > 0',                    'reports_missing > 0'],
  };

  it('the router publishes a filter for every KPI, and none is empty', () => {
    const block = /kpis: \[([\s\S]*?)\n {6}\],/.exec(ROUTES_SRC);
    expect(block, 'KPI block not found in bgv.routes.js').toBeTruthy();
    const filters = [...block[1].matchAll(/filter: (\{[^}]*\})/g)].map(m => m[1].trim());
    expect(filters.length).toBe(Object.keys(KPI_SQL).length);
    for (const f of filters) {
      expect(f, 'a KPI with an empty filter opens a population it did not count').not.toBe('{}');
    }
  });

  for (const [key, [countExpr, filterExpr]] of Object.entries(KPI_SQL)) {
    it(`${key}: COUNT(${countExpr}) === the row count under "${filterExpr}"`, async () => {
      const { rows: [c] } = await client.query(
        withRows(`SELECT COUNT(*) FILTER (WHERE ${countExpr})::int AS n FROM rows`), [OWN]);
      const { rows: listed } = await client.query(listSql(` WHERE ${filterExpr}`), [OWN]);
      expect(c.n, `the card says ${c.n} but its filter opens ${listed.length} rows`)
        .toBe(listed.length);
    });
  }

  it('the KPI counts partition the population without overlap or gap', async () => {
    // Not Started + Initiated + In Progress + Completed + Discrepancy + Closed
    // must be every row exactly once, or some employee is in a state no card
    // counts and no filter can find.
    const { rows: [t] } = await client.query(
      withRows(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE bgv_status IN
                         ('Not Started','Initiated','In Progress','Completed','Discrepancy','Closed'))::int AS classified
                  FROM rows`), [OWN]);
    expect(t.classified, 'every row must fall into exactly one named status').toBe(t.total);
  });
});

describe('file access resolves a BGV report back to its employee and company', () => {
  it('the ownership lookup finds the report and names the right tenant', async () => {
    // The query secureFiles.routes.js runs (bgvDocumentOwner). Run here against
    // real rows because a wrong join here is a 403 on a report HR just uploaded,
    // or — worse — a 200 on another tenant's.
    const { rows } = await client.query(
      `SELECT e.company_id, e.id AS employee_id, ch.check_type
         FROM bgv_documents d
         JOIN bgv_checks ch ON ch.id = d.check_id
         JOIN bgv_cases  c  ON c.id  = ch.case_id
         JOIN employees  e  ON e.id  = c.employee_id AND e.deleted_at IS NULL
        WHERE d.file_url LIKE $1
        LIMIT 1`,
      ['%zz-not-real.pdf']);
    expect(rows.length).toBe(1);
    expect(rows[0].company_id).toBe(OWN);
    expect(rows[0].employee_id).toBe(ownEmp);
    expect(rows[0].check_type).toBe('Identity Verification');
  });

  it('a foreign tenant\'s report resolves to a different company, so the check refuses it', async () => {
    const fCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1,'Education Verification') RETURNING id`,
      [foreignCase])).rows[0].id;
    await client.query(
      `INSERT INTO bgv_documents (check_id, document_name, file_url)
       VALUES ($1, 'ZZ foreign.pdf', '/uploads/zz-foreign.pdf')`, [fCheck]);
    const { rows } = await client.query(
      `SELECT e.company_id FROM bgv_documents d
         JOIN bgv_checks ch ON ch.id = d.check_id
         JOIN bgv_cases  c  ON c.id  = ch.case_id
         JOIN employees  e  ON e.id  = c.employee_id
        WHERE d.file_url LIKE $1 LIMIT 1`, ['%zz-foreign.pdf']);
    expect(rows[0].company_id).toBe(FOREIGN);
    expect(rows[0].company_id).not.toBe(OWN);
  });
});

describe('the permission matrix is seeded for every role', () => {
  it('no role is left with PERMISSION_NOT_CONFIGURED on bgv', async () => {
    // requirePermission fails CLOSED on a missing row, so an unseeded role gets a
    // 403 that reads like a bug rather than a decision.
    const { rows: [r] } = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM roles WHERE code IS NOT NULL) AS roles,
              (SELECT COUNT(*)::int FROM role_permissions WHERE module = 'bgv') AS seeded`);
    expect(r.seeded).toBe(r.roles);
  });

  it('the HR tier can view, and hr_manager / hr_exec are not forgotten', async () => {
    // These two hold NO `employees` row at all, so a gate copied from that module
    // would 403 the exact roles BGV exists for.
    const { rows } = await client.query(
      `SELECT LOWER(r.code) AS code, rp.can_view, rp.can_add, rp.can_edit, rp.can_export
         FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.module='bgv' AND LOWER(r.code) = ANY($1)`,
      [['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']]);
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.can_view, `${row.code} must be able to view BGV`).toBe(true);
      expect(row.can_add, `${row.code} must be able to record BGV`).toBe(true);
      expect(row.can_edit).toBe(true);
      expect(row.can_export).toBe(true);
    }
  });

  it('no non-HR role can view BGV', async () => {
    const { rows } = await client.query(
      `SELECT LOWER(r.code) AS code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.module='bgv' AND rp.can_view = true
          AND LOWER(r.code) <> ALL($1)`,
      [['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec']]);
    expect(rows.map(r => r.code), 'BGV holds criminal-record and reference findings').toEqual([]);
  });

  it('nobody holds can_approve — BGV has no approval step', async () => {
    // A flag nothing reads is the [[project_comp_off_flag_noop_and_silent_catches]]
    // trap: it looks like a control and enforces nothing.
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM role_permissions WHERE module='bgv' AND can_approve = true`);
    expect(rows[0].n).toBe(0);
  });
});

describe('the check-type vocabulary is the shared master', () => {
  it('BGV_CHECK_TYPE is seeded as a shared vocabulary, not per tenant', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM master_values
        WHERE type='BGV_CHECK_TYPE' AND company_id IS NULL AND is_active = true`);
    expect(rows[0].n).toBeGreaterThanOrEqual(9);
  });

  it('bgv_checks.check_type is TEXT, not an FK — so a rename must carry history', async () => {
    // Every master in this app is referenced by NAME. That is what makes
    // deactivating a used value safe and a hard delete unsafe.
    // [[project_master_data_governance_2026-09-29]]
    const { rows } = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='bgv_checks' AND column_name='check_type'`);
    expect(rows[0].data_type).toBe('character varying');
  });

  it('the usage count for a check type is scoped to the tenant, not global', async () => {
    // bgv_checks has no company_id, so usage.js counts it through SCOPE_VIA.
    // Without that it would report another tenant's volume — the leak usage.js's
    // own header warns about.
    const { countUsage, __resetUsageSchemaCache } = await import('../modules/master/usage.js');
    __resetUsageSchemaCache();
    const refs = [{ table: 'bgv_checks', column: 'check_type', label: 'check' }];

    // ⚠ Both probe values are created HERE, under a known tenant. The first
    // version used two of the seeded check types and assumed no live row carried
    // the "foreign" one — which was true when written and false as soon as a
    // fixture elsewhere used 'Education Verification'. It passed alone and failed
    // in the full run: a test that depends on what the register happens to hold
    // is testing the register.
    const OWN_TYPE     = 'ZZ Usage Own Type';
    const FOREIGN_TYPE = 'ZZ Usage Foreign Type';
    await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1, $2)`, [ownCase, OWN_TYPE]);
    await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1, $2)`, [foreignCase, FOREIGN_TYPE]);

    const own     = await countUsage(refs, OWN_TYPE, OWN, false, client);
    const foreign = await countUsage(refs, FOREIGN_TYPE, OWN, false, client);
    expect(own.total, "the caller's own check is counted").toBe(1);
    expect(foreign.total, "another tenant's check must NOT be counted").toBe(0);

    // And a global scope sees both, so the predicate is a tenant filter rather
    // than a blanket exclusion.
    const globalForeign = await countUsage(refs, FOREIGN_TYPE, null, true, client);
    expect(globalForeign.total).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The four post-pass decisions, verified against the database rather than the
// source text. bgvDecisions.contract.test.js proves the code says the right
// thing; this proves the statements DO the right thing.
// ═════════════════════════════════════════════════════════════════════════════

describe('agency contact: the master is the single source of truth', () => {
  let contactAgency, contactCase, plainCheck, overrideCheck;

  beforeAll(async () => {
    contactAgency = (await client.query(
      `INSERT INTO bgv_agencies (company_id, agency_name, contact_person, email, phone)
       VALUES ($1, 'ZZBGV Contact Agency', 'Ravi Kumar', 'ravi@zzbgv.test', '9800000001')
       RETURNING id`, [OWN])).rows[0].id;

    // A fresh employee so this block does not disturb the status walk above.
    const emp = (await client.query(
      `SELECT id FROM employees WHERE company_id=$1 AND deleted_at IS NULL
        AND id NOT IN (SELECT employee_id FROM bgv_cases) ORDER BY id LIMIT 1`, [OWN])).rows[0];
    contactCase = (await client.query(
      `INSERT INTO bgv_cases (employee_id, primary_agency_id) VALUES ($1,$2) RETURNING id`,
      [emp.id, contactAgency])).rows[0].id;

    // The normal case: no per-check contact stored at all.
    plainCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, agency_id)
       VALUES ($1, 'Employment Verification', $2) RETURNING id`,
      [contactCase, contactAgency])).rows[0].id;

    // The exception: a genuinely different contact for one check.
    overrideCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, agency_id, contact_person, contact_email, contact_phone)
       VALUES ($1, 'Education Verification', $2, 'Priya Menon', 'priya@college.test', '9800000099')
       RETURNING id`, [contactCase, contactAgency])).rows[0].id;
  });

  /** The production expression, run for one check. */
  const contactOf = async (checkId) => (await client.query(
    `SELECT ${CHECK_CONTACT_SELECT}
       FROM bgv_checks ch LEFT JOIN bgv_agencies ag ON ag.id = ch.agency_id
      WHERE ch.id = $1`, [checkId])).rows[0];

  it('a check with NO stored contact resolves to the agency master', async () => {
    const c = await contactOf(plainCheck);
    expect(c.effective_contact_person).toBe('Ravi Kumar');
    expect(c.effective_contact_email).toBe('ravi@zzbgv.test');
    expect(c.effective_contact_phone).toBe('9800000001');
    expect(c.contact_is_override, 'nothing was overridden').toBe(false);
  });

  it('⚠ updating the AGENCY updates every check that uses it', async () => {
    // The whole point. A retyped copy on each check would have frozen the old
    // number and the record would say who we used to call.
    await client.query(
      `UPDATE bgv_agencies SET contact_person='Ravi Kumar (new)', phone='9811111111' WHERE id=$1`,
      [contactAgency]);
    const c = await contactOf(plainCheck);
    expect(c.effective_contact_person).toBe('Ravi Kumar (new)');
    expect(c.effective_contact_phone).toBe('9811111111');
  });

  it('an override survives an agency change, because that is what an override means', async () => {
    const c = await contactOf(overrideCheck);
    expect(c.effective_contact_person).toBe('Priya Menon');
    expect(c.effective_contact_phone).toBe('9800000099');
    expect(c.contact_is_override).toBe(true);
    // And it still reports the agency's card, so the UI can offer "go back to it".
    expect(c.agency_contact_person).toBe('Ravi Kumar (new)');
  });

  it('dedupeContact collapses a retyped copy, case- and whitespace-insensitively', async () => {
    const { dedupeContact } = await import('../modules/hr/bgv.routes.js');
    const agency = { contact_person: 'Ravi Kumar', email: 'ravi@zzbgv.test', phone: '9800000001' };

    // A client that round-trips the read-only values must NOT mint an override.
    expect(dedupeContact(
      { contact_person: 'Ravi Kumar', contact_email: 'ravi@zzbgv.test', contact_phone: '9800000001' },
      agency)).toEqual({ contact_person: null, contact_email: null, contact_phone: null });

    // Copy-paste picks up case and stray spaces.
    expect(dedupeContact(
      { contact_person: '  ravi KUMAR ', contact_email: 'RAVI@ZZBGV.TEST', contact_phone: ' 9800000001' },
      agency)).toEqual({ contact_person: null, contact_email: null, contact_phone: null });

    // A genuinely different contact is kept.
    expect(dedupeContact(
      { contact_person: 'Priya Menon', contact_email: null, contact_phone: null },
      agency)).toEqual({ contact_person: 'Priya Menon', contact_email: null, contact_phone: null });

    // No agency selected: nothing to compare against, keep what was given.
    expect(dedupeContact({ contact_person: 'X', contact_email: null, contact_phone: null }, null))
      .toEqual({ contact_person: 'X', contact_email: null, contact_phone: null });
  });
});

describe('closing a case requires every check to be resolved', () => {
  it('the open-check query treats Pending / Initiated / In Progress as open', async () => {
    // The statement the close handler runs. A Cancelled check must NOT appear,
    // or cancelling an abandoned check would never unblock the case.
    //
    // ⚠ Creates its OWN open check rather than relying on the fixture. By this
    // point the status-walk block above has driven every check on ownCase to
    // Completed, so the first version of this asserted against 0 open checks and
    // failed on the previous describe's leftovers — a test that passes or fails
    // on block ordering is testing the ordering.
    await client.query('SAVEPOINT closeable');
    await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, status)
       VALUES ($1, 'ZZ Open For Close Test', 'In Progress')`, [ownCase]);

    const { rows: before } = await client.query(
      `SELECT check_type, status FROM bgv_checks
        WHERE case_id = $1 AND status IN ('Pending','Initiated','In Progress')
        ORDER BY check_type`, [ownCase]);
    expect(before.length, 'an In Progress check must read as open').toBeGreaterThan(0);

    await client.query(`UPDATE bgv_checks SET status='Cancelled' WHERE case_id=$1`, [ownCase]);
    const { rows: after } = await client.query(
      `SELECT 1 FROM bgv_checks
        WHERE case_id = $1 AND status IN ('Pending','Initiated','In Progress')`, [ownCase]);
    expect(after.length, 'a Cancelled check must not block closure').toBe(0);
    await client.query('ROLLBACK TO SAVEPOINT closeable');
  });

  it('a Completed check does not block closure either', async () => {
    await client.query('SAVEPOINT completed');
    await client.query(
      `UPDATE bgv_checks SET status='Completed', result='Clear' WHERE case_id=$1`, [ownCase]);
    const { rows } = await client.query(
      `SELECT 1 FROM bgv_checks
        WHERE case_id = $1 AND status IN ('Pending','Initiated','In Progress')`, [ownCase]);
    expect(rows.length).toBe(0);
    await client.query('ROLLBACK TO SAVEPOINT completed');
  });
});

describe('sensitive discrepancy detail is gated by its own permission', () => {
  it('bgv_sensitive is seeded for every role, and only the HR/Admin tier holds it', async () => {
    const { rows: [counts] } = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM roles WHERE code IS NOT NULL) AS roles,
              (SELECT COUNT(*)::int FROM role_permissions WHERE module='bgv_sensitive') AS seeded`);
    expect(counts.seeded, 'an unseeded role gets a 403 that reads like a bug').toBe(counts.roles);

    const { rows: granted } = await client.query(
      `SELECT LOWER(r.code) AS code FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
        WHERE rp.module='bgv_sensitive' AND rp.can_view = true ORDER BY 1`);
    expect(granted.map(r => r.code)).toEqual(['admin', 'hr', 'hr_manager', 'super_admin']);
  });

  it('⚠ hr_exec can run BGV but cannot read a discrepancy', async () => {
    // The whole distinction the brief asked for, in one assertion.
    const { rows } = await client.query(
      `SELECT rp.module, rp.can_view FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
        WHERE LOWER(r.code)='hr_exec' AND rp.module IN ('bgv','bgv_sensitive')
        ORDER BY rp.module`);
    const byModule = Object.fromEntries(rows.map(r => [r.module, r.can_view]));
    expect(byModule.bgv, 'hr_exec must be able to run BGV').toBe(true);
    expect(byModule.bgv_sensitive, 'hr_exec must NOT read the findings').toBe(false);
  });

  it('can_export mirrors can_view, so the report is not an ungated alias', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM role_permissions
        WHERE module='bgv_sensitive' AND can_view <> can_export`);
    expect(rows[0].n, 'gating the screen and leaving the export open is a gate with a hole').toBe(0);
  });

  it('nobody holds a WRITE flag on bgv_sensitive — it grants read only', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM role_permissions
        WHERE module='bgv_sensitive' AND (can_add OR can_edit OR can_delete OR can_approve)`);
    expect(rows[0].n).toBe(0);
  });

  it('only a Discrepancy result is sensitive — Unable to Verify is not', async () => {
    const { isSensitiveCheck } = await import('../modules/hr/bgv.routes.js');
    expect(isSensitiveCheck({ result: 'Discrepancy' })).toBe(true);
    expect(isSensitiveCheck({ result: 'Unable to Verify' }),
      'the agency could not reach the source — operational work, not a finding').toBe(false);
    expect(isSensitiveCheck({ result: 'Clear' })).toBe(false);
    expect(isSensitiveCheck({ result: 'Pending' })).toBe(false);
    expect(isSensitiveCheck(null)).toBe(false);
  });

  it('redactCheck keeps the status and the result, and hides only the findings', async () => {
    const { redactCheck } = await import('../modules/hr/bgv.routes.js');
    const row = {
      id: 7, check_type: 'Criminal/Court Check', status: 'Completed', result: 'Discrepancy',
      agency_id: 3, amount: '500.00', total_amount: '590.00',
      remarks: 'conviction found', followup_notes: 'escalate', cost_remarks: 'invoice 12',
    };
    const out = redactCheck(row);
    expect(out.status).toBe('Completed');
    expect(out.result, 'hiding the result would make a finding look like unfinished work')
      .toBe('Discrepancy');
    expect(out.check_type).toBe('Criminal/Court Check');
    expect(out.total_amount).toBe('590.00');
    expect(out.remarks).not.toBe('conviction found');
    expect(out.followup_notes).not.toBe('escalate');
    expect(out.cost_remarks).not.toBe('invoice 12');
    expect(out.detail_restricted).toBe(true);
  });

  it('a Clear check is returned untouched, and says so', async () => {
    const { redactCheck } = await import('../modules/hr/bgv.routes.js');
    const out = redactCheck({ result: 'Clear', remarks: 'all good' });
    expect(out.remarks).toBe('all good');
    expect(out.detail_restricted).toBe(false);
  });

  it('a null finding stays null rather than becoming the placeholder', async () => {
    // "Restricted" on a field nobody ever filled in would invent a finding.
    const { redactCheck } = await import('../modules/hr/bgv.routes.js');
    const out = redactCheck({ result: 'Discrepancy', remarks: null, followup_notes: null });
    expect(out.remarks).toBeNull();
    expect(out.followup_notes).toBeNull();
  });
});

describe('BGV evidence is retired, never erased', () => {
  let retireCheck, retireDoc;

  beforeAll(async () => {
    retireCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1,'Document Verification') RETURNING id`,
      [ownCase])).rows[0].id;
    retireDoc = (await client.query(
      `INSERT INTO bgv_documents (check_id, document_name, file_url)
       VALUES ($1, 'ZZ retention.pdf', '/uploads/zz-retention.pdf') RETURNING id`,
      [retireCheck])).rows[0].id;
  });

  it('the retire statement stamps deleted_at and keeps the row AND the file_url', async () => {
    const { rows } = await client.query(
      `UPDATE bgv_documents SET deleted_at = NOW(), deleted_by = $3
        WHERE id = $1 AND deleted_at IS NULL
          AND check_id IN (SELECT ch.id FROM bgv_checks ch
                             JOIN bgv_cases c ON c.id = ch.case_id
                             JOIN employees e ON e.id = c.employee_id AND e.deleted_at IS NULL
                            WHERE ($2::int IS NULL OR e.company_id = $2::int))
        RETURNING *`,
      [retireDoc, OWN, 1]);
    expect(rows.length).toBe(1);
    expect(rows[0].deleted_at, 'the row must be retired, not gone').not.toBeNull();
    expect(rows[0].file_url, 'the pointer to the evidence must survive')
      .toBe('/uploads/zz-retention.pdf');
    expect(rows[0].document_name).toBe('ZZ retention.pdf');
    expect(rows[0].check_id, 'and it must stay joined to its check').toBe(retireCheck);
  });

  it('the retire is idempotent — a second call touches nothing', async () => {
    const { rowCount } = await client.query(
      `UPDATE bgv_documents SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [retireDoc]);
    expect(rowCount).toBe(0);
  });

  it('a retired report disappears from the active views', async () => {
    const { rows: [n] } = await client.query(
      `SELECT COUNT(*)::int AS live FROM bgv_documents
        WHERE check_id = $1 AND deleted_at IS NULL`, [retireCheck]);
    expect(n.live).toBe(0);

    // And the check counts as missing its report again — the work is outstanding.
    const row = await statusOf(ownEmp);
    expect(Number(row.reports_missing)).toBeGreaterThan(0);
  });

  it('⚠ but it is STILL resolvable by filename, under the same scope', async () => {
    // secureFiles.bgvDocumentOwner deliberately does not filter deleted_at: after
    // retirement the record's job is precisely to keep answering who the file
    // belongs to, so an auditor can still identify it. Retention that lost the
    // link would keep the bytes and throw away their meaning.
    const { rows } = await client.query(
      `SELECT e.company_id, e.id AS employee_id, ch.check_type, ch.result
         FROM bgv_documents d
         JOIN bgv_checks ch ON ch.id = d.check_id
         JOIN bgv_cases  c  ON c.id  = ch.case_id
         JOIN employees  e  ON e.id  = c.employee_id AND e.deleted_at IS NULL
        WHERE d.file_url LIKE $1 LIMIT 1`, ['%zz-retention.pdf']);
    expect(rows.length, 'a retired report must still resolve to its employee').toBe(1);
    expect(rows[0].company_id, 'and to the same tenant, with no widening').toBe(OWN);
    expect(rows[0].check_type).toBe('Document Verification');
  });

  it('a check whose only report was retired can be deleted again', async () => {
    // The HAS_EVIDENCE guard counts live documents only, or a check would be
    // undeletable forever after its report was retired.
    const { rows: [counts] } = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM bgv_documents d
                WHERE d.check_id = $1 AND d.deleted_at IS NULL) AS docs,
              (SELECT COUNT(*)::int FROM bgv_check_contacts t WHERE t.check_id = $1) AS contacts`,
      [retireCheck]);
    expect(counts.docs).toBe(0);
    expect(counts.contacts).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Applicability, progress, and the checklist — against the database.
// ═════════════════════════════════════════════════════════════════════════════

describe('applicability changes what counts as work', () => {
  let applCase, reqCheck, optCheck, naCheck;

  beforeAll(async () => {
    const emp = (await client.query(
      `SELECT id FROM employees WHERE company_id=$1 AND deleted_at IS NULL
         AND id NOT IN (SELECT employee_id FROM bgv_cases) ORDER BY id DESC LIMIT 1`,
      [OWN])).rows[0];
    applCase = (await client.query(
      `INSERT INTO bgv_cases (employee_id) VALUES ($1) RETURNING id, employee_id`,
      [emp.id])).rows[0];

    const mk = (type, applicability) => client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability) VALUES ($1,$2,$3) RETURNING id`,
      [applCase.id, type, applicability]).then(r => r.rows[0].id);
    reqCheck = await mk('Identity Verification', 'Required');
    optCheck = await mk('Reference Check', 'Optional');
    naCheck  = await mk('Employment Verification', 'Not Applicable');
  });

  const progressOf = async () => (await client.query(
    withRows('SELECT * FROM rows WHERE employee_id = $2'), [OWN, applCase.employee_id])).rows[0];

  it('the CHECK constraint refuses an unknown applicability', async () => {
    const err = await expectViolation(
      `INSERT INTO bgv_checks (case_id, check_type, applicability) VALUES ($1,'Other','Maybe')`,
      [applCase.id]);
    expect(err, 'an unknown applicability was accepted').toBeTruthy();
    expect(err.code).toBe('23514');          // check_violation
  });

  it('an existing row defaults to Required, so behaviour is unchanged', async () => {
    const { rows: [row] } = await client.query(
      `INSERT INTO bgv_checks (case_id, check_type) VALUES ($1,'Document Verification')
       RETURNING applicability`, [applCase.id]);
    expect(row.applicability).toBe('Required');
    await client.query(`DELETE FROM bgv_checks WHERE case_id=$1 AND check_type='Document Verification'`,
      [applCase.id]);
  });

  it('the breakdown separates Required / Optional / Not Applicable', async () => {
    const p = await progressOf();
    expect(Number(p.required_total)).toBe(1);
    expect(Number(p.optional_total)).toBe(1);
    expect(Number(p.not_applicable)).toBe(1);
    expect(Number(p.applicable_total), 'Required + Optional').toBe(2);
    expect(Number(p.checks_total), 'every row, including the Not Applicable one').toBe(3);
  });

  it('⚠ the Not Applicable check is NOT pending and does NOT block closure', async () => {
    const p = await progressOf();
    expect(Number(p.checks_pending), 'pending counts only applicable checks').toBe(2);
    expect(Number(p.open_applicable), 'the closure guard population').toBe(2);
    // The closure statement itself — the one the handler runs.
    const { rows: blockers } = await client.query(
      `SELECT check_type FROM bgv_checks
        WHERE case_id = $1 AND applicability IN ('Required','Optional')
          AND status IN ('Pending','Initiated','In Progress')`, [applCase.id]);
    expect(blockers.map(b => b.check_type).sort())
      .toEqual(['Identity Verification', 'Reference Check']);
    expect(blockers.map(b => b.check_type),
      'a Not Applicable check must never hold a case open')
      .not.toContain('Employment Verification');
  });

  it('⚠ the Not Applicable check does not owe a report either', async () => {
    const p = await progressOf();
    // 2 applicable, neither has a document.
    expect(Number(p.reports_missing)).toBe(2);
  });

  it('progress is 0 / 1 required, not 0 / 3 checks', async () => {
    const p = await progressOf();
    expect(`${p.required_completed} / ${p.required_total}`).toBe('0 / 1');
    expect(p.required_completion_pct).toBe(0);
  });

  it('completing the required check gives 1 / 1 and 100%, with the optional still open', async () => {
    await client.query(
      `UPDATE bgv_checks SET status='Completed', result='Clear' WHERE id=$1`, [reqCheck]);
    const p = await progressOf();
    expect(`${p.required_completed} / ${p.required_total}`).toBe('1 / 1');
    expect(p.required_completion_pct).toBe(100);
    expect(Number(p.open_applicable), 'the Optional check is still real work').toBe(1);
  });

  it('cancelling the optional check clears the closure guard', async () => {
    await client.query(`UPDATE bgv_checks SET status='Cancelled' WHERE id=$1`, [optCheck]);
    const p = await progressOf();
    expect(Number(p.open_applicable)).toBe(0);
    expect(Number(p.not_applicable), 'and the Not Applicable row is still recorded').toBe(1);
  });

  it('a Cancelled required check does NOT count as completed', async () => {
    // Finished work that verified nothing must not inflate the figure.
    const extra = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability, status)
       VALUES ($1,'Criminal/Court Check','Required','Cancelled') RETURNING id`,
      [applCase.id])).rows[0].id;
    const p = await progressOf();
    expect(Number(p.required_total)).toBe(2);
    expect(Number(p.required_completed), 'still only the genuinely completed one').toBe(1);
    expect(Number(p.required_cancelled)).toBe(1);
    expect(Number(p.open_applicable), 'but it no longer blocks closure').toBe(0);
    await client.query(`DELETE FROM bgv_checks WHERE id=$1`, [extra]);
  });

  it('a case whose only check is Not Applicable reports NO required checks', async () => {
    // The 0/1 the brief called out: this must read as "nothing required", not
    // "nothing done".
    const solo = (await client.query(
      `SELECT id FROM employees WHERE company_id=$1 AND deleted_at IS NULL
         AND id NOT IN (SELECT employee_id FROM bgv_cases) ORDER BY id DESC LIMIT 1`,
      [OWN])).rows[0];
    const soloCase = (await client.query(
      `INSERT INTO bgv_cases (employee_id) VALUES ($1) RETURNING id`, [solo.id])).rows[0].id;
    await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability)
       VALUES ($1,'Employment Verification','Not Applicable')`, [soloCase]);

    const { rows: [p] } = await client.query(
      withRows('SELECT * FROM rows WHERE employee_id = $2'), [OWN, solo.id]);
    expect(Number(p.required_total)).toBe(0);
    expect(p.required_completion_pct, 'NULL, not 0 — there is nothing to do').toBeNull();
    expect(Number(p.checks_pending), 'and nothing is pending').toBe(0);
    expect(Number(p.open_applicable), 'so the case can be closed').toBe(0);
    await client.query(`DELETE FROM bgv_cases WHERE id=$1`, [soloCase]);
  });

  it('ruling a check Not Applicable removes it from the pending count', async () => {
    const before = await progressOf();
    await client.query(
      `UPDATE bgv_checks SET status='Pending', applicability='Required' WHERE id=$1`, [naCheck]);
    const middle = await progressOf();
    expect(Number(middle.open_applicable),
      'as Required + Pending it is work').toBe(Number(before.open_applicable) + 1);

    await client.query(
      `UPDATE bgv_checks SET applicability='Not Applicable' WHERE id=$1`, [naCheck]);
    const after = await progressOf();
    expect(Number(after.open_applicable),
      'ruled Not Applicable, it stops being work').toBe(Number(before.open_applicable));
  });
});

describe('the profile checklists resolve against the live master', () => {
  it('BGV_CHECK_TYPE holds every type the profiles name', async () => {
    // A profile naming a type the master lost would be flagged
    // `missing_from_master` and effectively stop being offered.
    const { PROFILE_KEYS: keys, profileChecklist: build } =
      await import('../modules/hr/bgv.routes.js');
    const { rows } = await client.query(
      `SELECT value FROM master_values
        WHERE type='BGV_CHECK_TYPE' AND is_active = true
          AND (company_id IS NULL OR company_id = $1::int)`, [OWN]);
    const types = rows.map(r => r.value);

    for (const key of keys) {
      const missing = build(key, types).checks.filter(c => c.missing_from_master);
      expect(missing.map(m => m.check_type),
        `profile "${key}" names check types the master does not hold`).toEqual([]);
    }
  });

  it('a deactivated check type stops being offered', async () => {
    const { profileChecklist: build } = await import('../modules/hr/bgv.routes.js');
    await client.query('SAVEPOINT deact');
    await client.query(
      `UPDATE master_values SET is_active = false
        WHERE type='BGV_CHECK_TYPE' AND value = 'Reference Check'`);
    const { rows } = await client.query(
      `SELECT value FROM master_values
        WHERE type='BGV_CHECK_TYPE' AND is_active = true
          AND (company_id IS NULL OR company_id = $1::int)`, [OWN]);
    const offered = build('experienced', rows.map(r => r.value)).checks
      .filter(c => !c.missing_from_master).map(c => c.check_type);
    expect(offered).not.toContain('Reference Check');
    await client.query('ROLLBACK TO SAVEPOINT deact');
  });
});

describe('reopening a closed case', () => {
  it('the reopen columns exist and start NULL', async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='bgv_cases' AND column_name IN ('reopened_at','reopened_by','reopen_reason')
        ORDER BY 1`);
    expect(rows.map(r => r.column_name)).toEqual(['reopen_reason', 'reopened_at', 'reopened_by']);
  });

  it('the reopen statement records when, who and why — and clears closed_at', async () => {
    await client.query(
      `UPDATE bgv_cases SET closed_at = NOW(), closed_by = 1, closure_remarks = 'done' WHERE id = $1`,
      [ownCase]);
    const { rows: [row] } = await client.query(
      `UPDATE bgv_cases
          SET closed_at = NULL, closed_by = NULL,
              reopened_at = NOW(), reopened_by = $1, reopen_reason = $4,
              updated_by = $1, updated_at = NOW()
        WHERE ${caseScopeSql(3)} AND id = $2
        RETURNING *`,
      [1, ownCase, OWN, 'client asked for a re-check']);
    expect(row.closed_at).toBeNull();
    expect(row.reopened_at).not.toBeNull();
    expect(row.reopened_by).toBe(1);
    expect(row.reopen_reason).toBe('client asked for a re-check');
    expect(row.closure_remarks,
      'the CLOSING reason must survive — it is a different fact').toBe('done');
  });

  it('the reopen statement is tenant-scoped', async () => {
    const r = await client.query(
      `UPDATE bgv_cases SET reopened_at = NOW() WHERE ${caseScopeSql(2)} AND id = $1`,
      [foreignCase, OWN]);
    expect(r.rowCount, "another tenant's case must not be reopenable").toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The duplicate guard, run as an index against the real planner.
//
// A source test can prove the CREATE statement says `WHERE status IN (...)`. It
// cannot prove the resulting index does what that was meant to buy: forbid two
// checks of one type IN FLIGHT, while still allowing a second attempt after the
// first is resolved. Those are the two halves of the brief — "prevent accidental
// duplicates" and "do not add a blanket uniqueness constraint that prevents
// legitimate re-verification" — and they pull in opposite directions, so both
// are exercised here against the index that actually exists.
// ─────────────────────────────────────────────────────────────────────────────
describe('the duplicate guard forbids two OPEN checks and permits a re-verification', () => {
  let dupCase;

  beforeAll(async () => {
    // Not `id <> ownEmp`: one case per employee is a UNIQUE constraint
    // (ux_bgv_cases_employee), and by this point in the transaction several
    // employees already have a fixture case. Excluding one known id left the
    // insert free to pick another that was already taken, which aborted the
    // transaction — and vitest reports an aborted beforeAll as SKIPPED tests,
    // so the run still said "73 passed | 16 skipped" and read as green.
    dupCase = (await client.query(
      `INSERT INTO bgv_cases (employee_id, initiated_on)
       SELECT e.id, CURRENT_DATE FROM employees e
        WHERE e.company_id = $1 AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bgv_cases c WHERE c.employee_id = e.id)
        ORDER BY e.id LIMIT 1
       RETURNING id`, [OWN])).rows[0].id;
  });

  const addCheck = (type, status = 'Pending', result = 'Pending') => client.query(
    `INSERT INTO bgv_checks (case_id, check_type, status, result)
     VALUES ($1, $2, $3, $4) RETURNING id`, [dupCase, type, status, result]);

  it('the index exists, is UNIQUE, and is PARTIAL', async () => {
    const { rows: [ix] } = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'bgv_checks' AND indexname = 'ux_bgv_checks_one_active_per_type'`);
    // ⚠ Read from pg_indexes, not from the migration file. A migration that was
    // written but never applied reads identically on disk.
    expect(ix, 'the guard must be an index, not a hope').toBeDefined();
    expect(ix.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(ix.indexdef).toMatch(/WHERE \(\(status\)::text = ANY/);
  });

  it('⚠ a second OPEN check of the same type is refused by the database', async () => {
    await addCheck('Education Verification');
    const err = await expectViolation(
      `INSERT INTO bgv_checks (case_id, check_type, status, result)
       VALUES ($1, 'Education Verification', 'Pending', 'Pending')`, [dupCase]);
    expect(err, 'the insert should have violated the unique index').not.toBeNull();
    expect(err.code).toBe('23505');
  });

  it('...and a CASE / WHITESPACE variant is refused too', async () => {
    // The index keys on LOWER(BTRIM(check_type)), because the duplicate HR
    // actually creates is "PAN Card" next to " pan card ", not a byte-identical
    // repeat.
    const err = await expectViolation(
      `INSERT INTO bgv_checks (case_id, check_type, status, result)
       VALUES ($1, '  education verification ', 'Initiated', 'Pending')`, [dupCase]);
    expect(err).not.toBeNull();
    expect(err.code).toBe('23505');
  });

  it('all three OPEN statuses collide, not just an identical pair', async () => {
    // Pending vs Initiated vs In Progress: the duplicate is "two in flight",
    // whatever stage each has reached.
    for (const status of ['Initiated', 'In Progress']) {
      const err = await expectViolation(
        `INSERT INTO bgv_checks (case_id, check_type, status, result)
         VALUES ($1, 'Education Verification', $2, 'Pending')`, [dupCase, status]);
      expect(err, `${status} should have collided with the open Pending check`).not.toBeNull();
      expect(err.code).toBe('23505');
    }
  });

  it('⚠ once the first is RESOLVED, a second check of that type is allowed', async () => {
    // This is the half that a blanket UNIQUE(case_id, check_type) would break.
    await client.query(
      `UPDATE bgv_checks SET status = 'Completed', result = 'Discrepancy'
        WHERE case_id = $1 AND LOWER(BTRIM(check_type)) = 'education verification'`, [dupCase]);
    const again = await addCheck('Education Verification');
    expect(again.rows[0].id, 'a re-verification after a resolution is ordinary HR work')
      .toBeDefined();
  });

  it('a CANCELLED check does not block a re-run either', async () => {
    await addCheck('Reference Check', 'Cancelled', 'Pending');
    const again = await addCheck('Reference Check');
    expect(again.rows[0].id).toBeDefined();
  });

  it('two RESOLVED checks of a type may coexist, so the history survives', async () => {
    // The superseded attempt is not deleted or overwritten — the point of
    // re-verification is a second attempt ON the record.
    const { rows: [n] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM bgv_checks
        WHERE case_id = $1 AND LOWER(BTRIM(check_type)) = 'education verification'`, [dupCase]);
    expect(n.n).toBeGreaterThanOrEqual(2);
  });

  it('the guard is per CASE, so another employee is unaffected', async () => {
    const other = await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, status, result)
       VALUES ($1, 'Education Verification', 'Pending', 'Pending') RETURNING id`, [ownCase]);
    expect(other.rows[0].id).toBeDefined();
  });

  it('the supersede link is a real FK that nulls out rather than cascading', async () => {
    const { rows } = await client.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'bgv_checks'::regclass AND contype = 'f'
          AND conkey = (SELECT ARRAY[attnum] FROM pg_attribute
                         WHERE attrelid = 'bgv_checks'::regclass
                           AND attname = 'supersedes_check_id')`);
    expect(rows.length, 'supersedes_check_id must be an FK to bgv_checks').toBe(1);
    // ⚠ 'n' = SET NULL, not 'c' = CASCADE. If deleting a superseded check
    // cascaded, removing an old attempt would silently take the CURRENT one too.
    expect(rows[0].confdeltype).toBe('n');
  });
});

describe('a skipped optional check is cancelled, reasoned and still there', () => {
  let optional;

  beforeAll(async () => {
    optional = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability, status, result)
       VALUES ($1, 'Social Media Check', 'Optional', 'In Progress', 'Pending')
       RETURNING id`, [ownCase])).rows[0].id;
  });

  it('the skip columns exist on the table, all nullable', async () => {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'bgv_checks' AND column_name LIKE 'skip%'
        ORDER BY column_name`);
    expect(rows.map(r => r.column_name)).toEqual(['skip_reason', 'skipped_at', 'skipped_by']);
    // "not skipped" is the ordinary state and must not need a value.
    expect(rows.every(r => r.is_nullable === 'YES')).toBe(true);
  });

  it('the skip statement cancels the check and records who, when and why', async () => {
    const { rows: [row] } = await client.query(
      `UPDATE bgv_checks
          SET status = 'Cancelled',
              skipped_at = NOW(), skipped_by = $1, skip_reason = $4,
              updated_by = $1, updated_at = NOW()
        WHERE ${checkScopeSql(3)} AND id = $2
        RETURNING *`,
      [1, optional, OWN, 'candidate withdrew consent for this one']);
    expect(row.status).toBe('Cancelled');
    expect(row.skip_reason).toBe('candidate withdrew consent for this one');
    expect(row.skipped_by).toBe(1);
    expect(row.skipped_at).not.toBeNull();
    expect(row.result, 'a skip finds nothing — it must not write a result').toBe('Pending');
  });

  it('⚠ a skipped check no longer counts as outstanding work', async () => {
    const { rows: [n] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM bgv_checks
        WHERE case_id = $1 AND id = $2
          AND status IN ('Pending','Initiated','In Progress')`, [ownCase, optional]);
    expect(n.n, 'it is Cancelled, so every open-work filter excludes it').toBe(0);
  });

  it('the skip statement is tenant-scoped', async () => {
    const foreignCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability, status, result)
       VALUES ($1, 'Social Media Check', 'Optional', 'Pending', 'Pending') RETURNING id`,
      [foreignCase])).rows[0].id;
    const r = await client.query(
      `UPDATE bgv_checks SET status = 'Cancelled', skip_reason = 'nope'
        WHERE ${checkScopeSql(2)} AND id = $1`, [foreignCheck, OWN]);
    expect(r.rowCount, "another tenant's check must not be skippable").toBe(0);
  });
});

describe('an OPTIONAL check does not hold a case open', () => {
  let optCase, reqCheck, optCheck;

  beforeAll(async () => {
    optCase = (await client.query(
      `INSERT INTO bgv_cases (employee_id, initiated_on)
       SELECT e.id, CURRENT_DATE FROM employees e
        WHERE e.company_id = $1 AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bgv_cases c WHERE c.employee_id = e.id)
        ORDER BY e.id LIMIT 1
       RETURNING id`, [OWN])).rows[0].id;
    reqCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability, status, result)
       VALUES ($1, 'Identity Verification', 'Required', 'Completed', 'Clear')
       RETURNING id`, [optCase])).rows[0].id;
    optCheck = (await client.query(
      `INSERT INTO bgv_checks (case_id, check_type, applicability, status, result)
       VALUES ($1, 'Reference Check', 'Optional', 'In Progress', 'Pending')
       RETURNING id`, [optCase])).rows[0].id;
  });

  /** The closure guard exactly as POST /cases/:id/close issues it. */
  const blockers = () => client.query(
    `SELECT check_type, status, applicability FROM bgv_checks
      WHERE case_id = $1
        AND applicability = 'Required'
        AND status IN ('Pending','Initiated','In Progress')
      ORDER BY check_type`, [optCase]);

  it('⚠ an open OPTIONAL check is NOT a blocker', async () => {
    const { rows } = await blockers();
    expect(rows, 'blocking on Optional would make "optional" mean nothing').toEqual([]);
    expect(optCheck, 'and the optional check really is open').toBeDefined();
  });

  it('...but an open REQUIRED check still is', async () => {
    await client.query(
      `UPDATE bgv_checks SET status = 'In Progress', result = 'Pending' WHERE id = $1`, [reqCheck]);
    const { rows } = await blockers();
    expect(rows.map(r => r.check_type)).toEqual(['Identity Verification']);
  });

  it('a Not Applicable check is never a blocker, whatever its status', async () => {
    await client.query(
      `UPDATE bgv_checks SET applicability = 'Not Applicable', status = 'Pending' WHERE id = $1`,
      [reqCheck]);
    const { rows } = await blockers();
    expect(rows).toEqual([]);
  });
});
