/**
 * No test or fixture may run an UNSCOPED destructive statement.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A BGV fixture cleanup ran a DELETE against `bgv_cases` with no WHERE clause.
 * It was written to remove the three cases that fixture had created, and it
 * removed every case in the database — including one a user had created through
 * the UI minutes earlier. The row was recoverable only because `audit_logs`
 * happened to hold its before-image.
 *
 * The lesson is not "be careful". It is that a teardown must be scoped by an
 * identifier the fixture itself created, and that nothing else is acceptable —
 * so this asserts it mechanically across every test and fixture file, because
 * the next person writing a teardown at 2am will not remember.
 *
 * ── How the detection works, and why it is shaped this way ──────────────────
 * The first version of this produced 23 hits, 20 of which were FALSE:
 *
 *   · `UPDATE bgv_checks SET status='In Progress' WHERE id=$1` was reported as
 *     unscoped, because the tail-matching regex stopped at the first `'` and
 *     never reached the WHERE. Fixed by blanking SQL string literals first.
 *   · `expect(body).not.toMatch(/DELETE FROM bgv_documents/)` was reported as a
 *     statement. It is an assertion ABOUT a statement. Fixed by skipping
 *     matches inside a matcher call or a regex literal.
 *   · `DROP TABLE x` in captureBefore.test.js is a fixture dropping the temp
 *     table it created two lines earlier. Fixed by allowing a DROP of a table
 *     the same file also CREATEs.
 *
 * A checker that cries wolf twenty times gets deleted, which would leave the
 * real defect unguarded — so the precision matters as much as the rule.
 *
 * ⚠ This scans SOURCE TEXT. It cannot catch a statement assembled at runtime
 * from pieces, and it is not trying to: the failure it exists to prevent was a
 * literal string in a file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../../..');           // workspace root
const SELF = fileURLToPath(import.meta.url);

/** Every directory that holds tests or fixtures, backend and workspace-wide. */
const ROOTS = [
  resolve(here),                                     // backend/src/__tests__
  resolve(REPO, 'Pulse/backend/scripts'),
  resolve(REPO, 'Pulse/frontend/src/__tests__'),
  resolve(REPO, 'tests'),                            // Playwright specs + fixtures
];

const EXT = /\.(m?js|cjs|ts|tsx|jsx)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'reports' || name === 'verify-results') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

const FILES = [...new Set(ROOTS.flatMap(r => walk(r)))].filter(f => f !== SELF);

/**
 * ── DECLARED, PRE-EXISTING UNSCOPED CLEANUPS ────────────────────────────────
 * Each one is unscoped on purpose and predates this checker. Listed so they are
 * visible and reviewed rather than silently tolerated — the same pattern
 * `npm run check:sql-refs` uses for its unimplemented references.
 *
 * ⚠ Adding to this list is a decision, not a fix. A new fixture must scope its
 * teardown; nothing about BGV is in here.
 */
const DECLARED = new Map([
  // A rate limiter has no per-test rows to scope to — the table IS the state
  // being reset, and leaving another test's attempts in it is what makes auth
  // suites flake. Emptying it is the intent, not an accident.
  ['Pulse/backend/src/__tests__/integration.procurementVendorSurface.test.js', ['DELETE FROM auth_rate_limit']],
  ['Pulse/backend/scripts/procurement-lifecycle-probe.mjs', ['DELETE FROM auth_rate_limit']],
]);

/**
 * Source prepared for statement detection:
 *   - comments removed (a warning in prose is not a statement)
 *   - SQL string literals blanked, so a quote inside SQL cannot end the scan
 *   - regex literals blanked, so an assertion's pattern is not read as SQL
 *   - a string literal that IS the subject of expect(...) blanked: it is a value
 *     under assertion, never executed. employeeEmailLoginSeparation's
 *     `expect(\`UPDATE employees SET first_name=$1, company_email=$2\`).not.toMatch(…)`
 *     — a sample statement fed to a regex test — was reported as an unscoped
 *     teardown (2026-10-20). Only the literal DIRECTLY inside `expect(` is
 *     blanked; `expect(await db.query(\`…\`))` still executes and is still read.
 */
const EXPECT_SUBJECT = /\bexpect\(\s*(?:`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;

function scannable(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''))
    .replace(EXPECT_SUBJECT, 'expect(EXPECT_SUBJECT')
    // A regex literal: /.../ with flags. Blanked before SQL literals so a `'`
    // inside a pattern does not confuse the next step.
    .replace(/\/(?![/*])(?:[^/\n\\]|\\.)+\/[gimsuy]*/g, ' REGEX_LITERAL ')
    // SQL single-quoted literals -> '' so a quote cannot cut the tail scan short.
    //
    // ⚠⚠ ONLY runs that contain no destructive keyword. Blanking every
    // single-quoted run also blanked SQL WRITTEN in a single-quoted JS string —
    // and `q('DELETE FROM bgv_cases')` is exactly how the defect that deleted a
    // user's case was written, so the scanner was blind to the one statement it
    // exists to catch. Proven by reintroducing that line: the scanner passed.
    // Now `status='Cancelled'` is still neutralised while SQL stays visible.
    .replace(/'(?:[^'\\\n]|\\.)*'/g,
      (lit) => (/\b(?:DELETE|UPDATE|TRUNCATE|DROP)\b/i.test(lit) ? lit : "''"));
}

/** Tables this file creates itself — dropping one of those is fixture hygiene. */
function ownTables(code) {
  const out = new Set();
  for (const m of code.matchAll(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * Is this match a SQL-INJECTION TEST PAYLOAD rather than a statement?
 *
 * Three real examples, all of which a validator is expected to REJECT:
 *
 *     "x'; DROP TABLE invoices; --"          metricRegistry.contract.test.js
 *     'users; DROP TABLE x'                  captureBefore.test.js
 *     'sort_by=id; DROP TABLE candidates--'  integration.recruitmentRegression
 *
 * The tell is a SEMICOLON (with or without a preceding quote) immediately before
 * the statement keyword: a chained statement. Every destructive statement this
 * checker cares about is a single query passed to `query()`, so a keyword that
 * follows a semicolon is never one of them.
 *
 * ⚠ The trade: a genuinely chained `…; DELETE FROM x` in a test would be
 * skipped. That is accepted deliberately — none exists, and the alternative
 * (blanking every quoted string) was a blind spot for the exact statement this
 * file exists to catch.
 */
// ⚠ A SEMICOLON is required. An earlier version allowed a bare quote too
// (`/[;']\s*;?\s*$/`), which skipped `q('DELETE FROM bgv_cases')` — the very
// statement this file exists to catch — because the character before DELETE was
// the opening quote. The semicolon is the whole tell; the quote is incidental.
const isInjectionPayload = (code, index) =>
  /;\s*$/.test(code.slice(Math.max(0, index - 12), index));

/**
 * A captured table name, cleaned.
 *
 * The character class allows `"` so a quoted identifier (`"myTable"`) is matched
 * whole — which also means a bare name followed by the closing quote of the JS
 * string captures that quote too (`bgv_cases"`). Trimmed here rather than by
 * complicating the pattern.
 */
const tableName = (raw) => String(raw).replace(/"/g, '');

/** Destructive statements with no WHERE, plus TRUNCATE and foreign DROP TABLE. */
function unscopedStatements(code) {
  const own = ownTables(code);
  const hits = [];
  // The tail runs to the end of the SQL string (a backtick or a semicolon) —
  // literals have already been blanked, so a quote cannot cut it short.
  const tailEnds = '[^`;]*';

  for (const m of code.matchAll(new RegExp(`DELETE\\s+FROM\\s+([A-Za-z_][A-Za-z0-9_."]*)(${tailEnds})`, 'gi'))) {
    if (isInjectionPayload(code, m.index)) continue;
    if (!/\bWHERE\b/i.test(m[2] || '')) hits.push(`DELETE FROM ${tableName(m[1])}`);
  }
  for (const m of code.matchAll(new RegExp(`UPDATE\\s+([A-Za-z_][A-Za-z0-9_."]*)\\s+SET\\b(${tailEnds})`, 'gi'))) {
    if (isInjectionPayload(code, m.index)) continue;
    if (!/\bWHERE\b/i.test(m[2] || '')) hits.push(`UPDATE ${tableName(m[1])} SET`);
  }
  // TRUNCATE is never scoped, by definition.
  for (const m of code.matchAll(/TRUNCATE\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_."]*)/gi)) {
    if (isInjectionPayload(code, m.index)) continue;
    hits.push(`TRUNCATE ${tableName(m[1])}`);
  }
  // A DROP of a table the file did not create would take real schema with it.
  for (const m of code.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_."]*)/gi)) {
    if (isInjectionPayload(code, m.index)) continue;
    if (!own.has(tableName(m[1]).toLowerCase())) hits.push(`DROP TABLE ${tableName(m[1])}`);
  }
  return [...new Set(hits)];
}

describe('test and fixture cleanup is always scoped', () => {
  it('found the test and fixture files to scan', () => {
    // If this collapses, every assertion below passes vacuously — which is how a
    // scorecard comes to certify nothing.
    expect(FILES.length, `scanned ${FILES.length} files under ${ROOTS.join(', ')}`)
      .toBeGreaterThan(80);
  });

  it('the detector actually detects (self-test)', () => {
    // A checker whose regex has rotted reports nothing and reads as a pass.
    expect(unscopedStatements(scannable('await db.query(`DELETE FROM bgv_cases`);')))
      .toEqual(['DELETE FROM bgv_cases']);
    // ⚠ The SAME statement written in a SINGLE-QUOTED JS string. This is how the
    // defect that deleted a user's BGV case was actually written, and an earlier
    // version of scannable() blanked it away — the scanner was blind to the one
    // shape it exists to catch.
    expect(unscopedStatements(scannable("await q('DELETE FROM bgv_cases');")))
      .toEqual(['DELETE FROM bgv_cases']);
    expect(unscopedStatements(scannable('await q("DELETE FROM bgv_cases");')))
      .toEqual(['DELETE FROM bgv_cases']);
    expect(unscopedStatements(scannable('await db.query(`UPDATE t SET a=1`);')))
      .toEqual(['UPDATE t SET']);
    expect(unscopedStatements(scannable('await db.query(`TRUNCATE t`);')))
      .toEqual(['TRUNCATE t']);
    // …and does NOT fire on a scoped statement, an assertion, or an own temp table.
    expect(unscopedStatements(scannable("await db.query(`UPDATE t SET a='x' WHERE id=$1`, [1]);")))
      .toEqual([]);
    expect(unscopedStatements(scannable('expect(src).not.toMatch(/DELETE FROM bgv_cases/);')))
      .toEqual([]);
    expect(unscopedStatements(scannable('await db.query(`CREATE TABLE tmp_x (id int)`); await db.query(`DROP TABLE tmp_x`);')))
      .toEqual([]);
    // Injection payloads a validator is meant to REJECT are not statements.
    expect(unscopedStatements(scannable(`const bad = "x'; DROP TABLE invoices; --";`)))
      .toEqual([]);
    expect(unscopedStatements(scannable("captureBefore('users; DROP TABLE x')")))
      .toEqual([]);
    expect(unscopedStatements(scannable("search('sort_by=id; DROP TABLE candidates--')")))
      .toEqual([]);
  });

  it('an expect() SUBJECT is not a statement — an executed one is, even inside expect()', () => {
    // Values under assertion are never run …
    expect(unscopedStatements(scannable('expect(`UPDATE t SET a=1`).not.toMatch(LOOKUP);'))).toEqual([]);
    expect(unscopedStatements(scannable("expect('DELETE FROM t').toBe(x);"))).toEqual([]);
    expect(unscopedStatements(scannable('expect( "TRUNCATE t" ).toBeTruthy();'))).toEqual([]);
    // … but a query that runs is still read, wherever it sits.
    expect(unscopedStatements(scannable('expect(await db.query(`UPDATE t SET a=1`)).toBeTruthy();')))
      .toEqual(['UPDATE t SET']);
    expect(unscopedStatements(scannable('await db.query(`DELETE FROM t`); expect(1).toBe(1);')))
      .toEqual(['DELETE FROM t']);
    expect(unscopedStatements(scannable("const sql = 'UPDATE t SET a=1'; expect(sql).toBeTruthy();")))
      .toEqual(['UPDATE t SET']);
  });

  it('employeeEmailLoginSeparation tears down only its own tenants and its own login prefix', () => {
    const file = resolve(here, 'employeeEmailLoginSeparation.integration.test.js');
    const src = readFileSync(file, 'utf8');
    const body = src.slice(src.indexOf('async function cleanup'), src.indexOf('beforeAll('));
    const deletes = [...body.matchAll(/DELETE\s+FROM\s+([a-z_]+)\s+WHERE\s+([^`]*)`/gi)];
    expect(deletes.length, 'found the teardown statements').toBeGreaterThanOrEqual(4);
    for (const [, table, where] of deletes) {
      const owned = /company_id IN \(\$\{OWN\}, \$\{FOREIGN\}\)/.test(where)
        || /id IN \(\$\{OWN\}, \$\{FOREIGN\}\)/.test(where)
        || /zz\.ident\.%@example\.com/.test(where)
        || /user_id IN \(\$\{users\}\)/.test(where);
      expect(owned, `DELETE FROM ${table} WHERE ${where}`).toBe(true);
    }
    // Its two tenants are registry tenants (testTenantIds.contract.test.js gives
    // each to one suite). Matched by shape, not spelled out, so this file does
    // not itself claim them in that registry.
    expect(src).toMatch(/const OWN = 9999\d\d;/);
    expect(src).toMatch(/const FOREIGN = 9999\d\d;/);
    expect(body).toMatch(/const users = `SELECT id FROM users WHERE email LIKE 'zz\.ident\.%@example\.com'`/);
  });

  it('⚠ no file runs an unscoped DELETE / UPDATE / TRUNCATE / DROP TABLE', () => {
    const offenders = [];
    for (const file of FILES) {
      const rel = relative(REPO, file).split('\\').join('/');
      const hits = unscopedStatements(scannable(readFileSync(file, 'utf8')));
      const declared = DECLARED.get(rel) ?? [];
      const undeclared = hits.filter(h => !declared.includes(h));
      if (undeclared.length) offenders.push(`${rel}: ${undeclared.join(', ')}`);
    }
    expect(offenders,
      'A teardown must delete only what its own fixture created, by id or by a ' +
      'prefix it owns. An unscoped destructive statement in a shared development ' +
      'database removes real records — exactly this removed a BGV case a user had ' +
      'just created through the UI:\n  ' + offenders.join('\n  '))
      .toEqual([]);
  });

  it('every declared exception still exists, so the list cannot rot', () => {
    // A stale entry would quietly bless a statement nobody has looked at.
    for (const [rel, statements] of DECLARED) {
      const file = resolve(REPO, rel);
      const hits = unscopedStatements(scannable(readFileSync(file, 'utf8')));
      for (const s of statements) {
        expect(hits, `${rel} no longer contains "${s}" — remove it from DECLARED`).toContain(s);
      }
    }
  });
});

describe('the BGV fixtures tear down only what they created', () => {
  const spec = () => readFileSync(resolve(REPO, 'tests/bgv.spec.ts'), 'utf8');

  /**
   * The spec with comments removed.
   *
   * ⚠ Needed by the negative assertions below. The spec's own warning says
   * "`case_id === null`, NOT `status: 'Not Started'`" — so a raw match fired on
   * the documentation of the very rule it was checking. That is the fourth time
   * this class of fault has bitten in this work: a "must NOT appear" assertion
   * has to read code, never prose.
   */
  const specCode = () => scannable(spec());

  it('the fixture keeps an OWNERSHIP REGISTER and deletes only from it', () => {
    // Ownership is RECORDED at create time, never inferred at teardown time.
    // Both previous incidents came from inferring it — once from an unscoped
    // DELETE, once from `status = 'Not Started'`.
    expect(specCode()).toMatch(/const owned = \{/);
    for (const kind of ['agencies', 'cases', 'checks', 'documents', 'contacts', 'files']) {
      // ⚠ Plain string matching, not a built regex. The bracket and `$`
      // escaping needed to express `[]` and `$1::int[]` inside a `new RegExp`
      // template is exactly the kind that collapses silently — one earlier
      // version produced `/agencies: []/`, an EMPTY CHARACTER CLASS that matched
      // nothing, so the assertion failed on correct code.
      expect(specCode(), `the register has no ${kind} bucket`)
        .toContain(`${kind}: []`);
    }
    // Every destructive statement is `id = ANY($1::int[])` over a captured list.
    for (const table of ['bgv_check_contacts', 'bgv_documents', 'bgv_checks', 'bgv_cases', 'bgv_agencies']) {
      expect(specCode(), `${table} is not deleted from the register`)
        .toContain(`DELETE FROM ${table} WHERE id = ANY($1::int[])`);
    }
  });

  it('it deletes CHILDREN FIRST, in dependency order', () => {
    // Relying on ON DELETE CASCADE makes the blast radius implicit — whatever
    // the FK graph says, rather than what the register names. Explicit order
    // means a surprise child added by a future feature is visible.
    const code = specCode();
    const at = (t) => code.indexOf(`DELETE FROM ${t} WHERE id = ANY`);
    const order = ['bgv_check_contacts', 'bgv_documents', 'bgv_checks', 'bgv_cases', 'bgv_agencies'];
    const positions = order.map(at);
    expect(positions.every(p => p > 0), 'a delete is missing').toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `${order[i]} must be deleted after ${order[i - 1]}`)
        .toBeGreaterThan(positions[i - 1]);
    }
  });

  it('it registers a case\'s children at create time, not at teardown', () => {
    expect(specCode()).toMatch(/async function registerCaseChildren/);
    expect(specCode()).toMatch(/async function rememberCase/);
  });

  it('there is exactly ONE recorder — no block-scoped shadow', () => {
    // A block-scoped `rememberCase` shadowed the module-level one and recorded
    // only the case id, so its checks, documents and contacts leaked.
    const recorders = (specCode().match(/function rememberCase|rememberCase = async/g) || []);
    expect(recorders.length, 'more than one rememberCase means one of them is a shadow')
      .toBe(1);
  });

  it('it names its rows with a unique, owned prefix', () => {
    // So a teardown can still find them if an id is lost, and so a RETRY cannot
    // collide with its own previous attempt.
    expect(spec()).toMatch(/const TAG = `ZZBGV-E2E-\$\{Date\.now\(\)\}`/);
  });

  it('⚠⚠ it attaches to an employee with NO CASE AT ALL, not merely "Not Started"', () => {
    // This assertion previously required `status: 'Not Started'` and BLESSED the
    // bug it was meant to prevent. The derived status of an employee who HAS a
    // case with no checks yet is ALSO 'Not Started' — so the fixture claimed a
    // real, empty case a user had created through the UI, and the teardown
    // deleted it. That happened TWICE to the same record.
    //
    // `case_id === null` is the only predicate that means "no case".
    expect(spec(), 'the fixture must select on case_id, not on a derived status')
      .toMatch(/case_id === null/);
    expect(specCode(), "'Not Started' must not be used to mean 'has no case'")
      .not.toMatch(/status: 'Not Started'/);
  });

  it('teardown refuses a case that is not in the register', () => {
    // Belt and braces: even a correct id list gets re-checked before the delete.
    expect(specCode()).toMatch(/teardown refused: case/);
  });
});
