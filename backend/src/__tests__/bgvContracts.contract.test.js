/**
 * BGV — the contracts the module cannot be allowed to break silently.
 *
 * Three classes of invariant, each chosen because the failure it catches is
 * invisible in code review:
 *
 * 1. VOCABULARY AGREEMENT. The lists bgv.routes.js accepts must be exactly the
 *    lists the CHECK constraints allow, and exactly the lists the frontend
 *    offers. A value one side accepts and another rejects is either a bare 500
 *    on save or a dropdown pick that empties the row — the
 *    [[project_item_master_type_vocabulary_drift]] failure (filter options
 *    plural, stored values singular) and the
 *    [[project_recruitment_redesign_2026-09-27]] one (a stage vocabulary in two
 *    copies, bulk accepted three values the single path 400'd on).
 *
 * 2. STATUS IS NOT RESULT. The two vocabularies must not overlap in a way that
 *    lets one be rendered as the other, and the workflow list must not contain
 *    an outcome.
 *
 * 3. SCOPE. Every write statement in the router must mention a tenant predicate.
 *    A text check, deliberately — bgvIntegration.integration.test.js proves the
 *    predicates WORK; this proves a newly added handler has one at all.
 *
 * No database and no server: this file is about source and schema text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CHECK_STATUSES, CHECK_RESULTS, PAYMENT_STATUSES,
  CONTACT_METHODS, CONTACT_RESPONSES, CASE_STATUSES,
} from '../modules/hr/bgv.routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_SRC    = readFileSync(resolve(here, '../modules/hr/bgv.routes.js'), 'utf8');

/**
 * The router with every comment removed.
 *
 * ⚠ Used by every "this string must NOT appear" assertion. The first run of this
 * file failed on `no handler reads req.user.company_id directly` — and the only
 * match was the file header saying "companyOf(req) — never req.user.company_id".
 * A negative source assertion that reads comments fails on its own documentation
 * and, worse, would PASS if someone deleted the warning and kept the bug.
 */
const CODE_ONLY = ROUTES_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));
const MIGRATION_SRC = readFileSync(
  resolve(here, '../database/migrations/20260930000010_bgv_foundation.js'), 'utf8');
const FRONTEND_SRC  = readFileSync(
  resolve(here, '../../../frontend/src/features/employees/bgv.js'), 'utf8');

/** Pull the values out of a `CHECK (col IN ('a','b'))` clause in the migration. */
function checkConstraintValues(column) {
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(MIGRATION_SRC);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
}

/** Pull an exported array literal out of the frontend module. */
function frontendList(name) {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(FRONTEND_SRC);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
}

describe('BGV vocabularies agree across the column, the API and the UI', () => {
  const CASES = [
    ['bgv_checks.status',          'status',         CHECK_STATUSES,   'CHECK_STATUSES'],
    ['bgv_checks.result',          'result',         CHECK_RESULTS,    'CHECK_RESULTS'],
    ['bgv_checks.payment_status',  'payment_status', PAYMENT_STATUSES, 'PAYMENT_STATUSES'],
    ['bgv_check_contacts.method',  'method',         CONTACT_METHODS,  'CONTACT_METHODS'],
    ['bgv_check_contacts.response','response',       CONTACT_RESPONSES,'CONTACT_RESPONSES'],
  ];

  for (const [label, column, apiList, frontName] of CASES) {
    it(`${label}: the CHECK constraint and the API list are identical`, () => {
      const dbValues = checkConstraintValues(column);
      expect(dbValues, `no CHECK constraint found for ${column}`).toBeTruthy();
      expect([...apiList].sort()).toEqual([...dbValues].sort());
    });

    it(`${label}: the frontend offers exactly what the API accepts`, () => {
      const ui = frontendList(frontName);
      expect(ui, `frontend does not export ${frontName}`).toBeTruthy();
      expect([...ui].sort()).toEqual([...apiList].sort());
    });
  }

  it('the frontend and backend agree on the DERIVED case statuses', () => {
    // These are not a column — they come out of the CASE_STATUS SQL expression —
    // so nothing but this test keeps the filter dropdown and the KPI cards
    // speaking the same language as the query.
    expect([...(frontendList('CASE_STATUSES') || [])].sort()).toEqual([...CASE_STATUSES].sort());
  });

  it('every derived case status is actually produced by the CASE_STATUS expression', () => {
    // A status offered in the filter that the SQL never returns is a filter that
    // always comes back empty — indistinguishable, on screen, from "nobody is in
    // that state".
    // ⚠ `ELSE 'Initiated'` is a branch as much as `THEN 'Completed'` is. The
    // first version of this matched only THEN and reported 'Initiated' as
    // unreachable — a false positive that would have sent the next reader
    // hunting a bug in working SQL.
    const caseExpr = /const CASE_STATUS = `([\s\S]*?)`;/.exec(ROUTES_SRC);
    expect(caseExpr, 'CASE_STATUS expression not found').toBeTruthy();
    const emitted = [...caseExpr[1].matchAll(/(?:THEN|ELSE) '([^']+)'/g)].map(m => m[1]);
    for (const s of CASE_STATUSES) {
      expect(emitted, `CASE_STATUS never returns '${s}', so filtering on it can only ever be empty`)
        .toContain(s);
    }
  });
});

describe('status and result stay separate concerns', () => {
  it('the workflow list contains no outcome', () => {
    for (const outcome of ['Clear', 'Discrepancy', 'Unable to Verify']) {
      expect(CHECK_STATUSES,
        `'${outcome}' is a RESULT. Putting it in the status vocabulary is how "Completed" comes to be read as "Clear".`)
        .not.toContain(outcome);
    }
  });

  it('the result list contains no workflow state', () => {
    for (const state of ['Initiated', 'In Progress', 'Completed', 'Cancelled']) {
      expect(CHECK_RESULTS, `'${state}' is a STATUS, not a finding`).not.toContain(state);
    }
  });

  it("both carry 'Pending', which is the only legitimate overlap", () => {
    // Deliberate: work not started, and a question not answered. Asserted so a
    // future tidy-up does not "deduplicate" them into one column.
    expect(CHECK_STATUSES).toContain('Pending');
    expect(CHECK_RESULTS).toContain('Pending');
  });

  /**
   * The guard must be in BOTH the create and the update handler.
   *
   * ⚠ This was first written as `CODE.match(/STATUS_NEEDS_RESULT/g).length >= 2`
   * and mutation-testing showed it did not bite: the file header also says
   * "(STATUS_NEEDS_RESULT)", so deleting the create-path guard left two matches
   * and the suite stayed green. Counting occurrences in a whole file is not the
   * same question as "does this handler enforce it" — the second one is asked
   * here, per handler, over comment-stripped source.
   */
  const handlerBody = (method, path) => {
    const re = new RegExp(
      `router\\.${method}\\(\\s*'${path.replace(/[/:]/g, m => '\\' + m)}'([\\s\\S]*?)(?=\\nrouter\\.|\\nexport default)`);
    const m = re.exec(CODE_ONLY);
    return m ? m[1] : null;
  };

  for (const [method, path, label] of [
    ['post',  '/cases/:id/checks', 'the create path'],
    ['patch', '/checks/:id',       'the update path'],
  ]) {
    it(`${label} refuses Completed while the result is still Pending`, () => {
      const body = handlerBody(method, path);
      expect(body, `${method.toUpperCase()} ${path} not found`).toBeTruthy();
      expect(body,
        `${method.toUpperCase()} ${path} does not enforce STATUS_NEEDS_RESULT. ` +
        'Without it, "Completed" can be stored with no stated outcome and reads as "Clear".')
        .toMatch(/STATUS_NEEDS_RESULT/);
    });
  }
});

describe('every BGV write is tenant-scoped and permission-gated', () => {
  /**
   * One entry per `router.<verb>(...)` registration, sliced from the source.
   * Crude on purpose: it cannot be fooled by a handler that "looks" scoped,
   * because it only asks whether the words are present at all.
   */
  const handlers = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)(?=\n(?:router\.|export default))/g;
  for (const m of ROUTES_SRC.matchAll(re)) {
    handlers.push({ method: m[1].toUpperCase(), path: m[2], body: m[3] });
  }

  it('found every route (sanity check on the slicing itself)', () => {
    // If this drops to a handful the regex has broken and every assertion below
    // would pass vacuously — the way a scorecard comes to certify nothing.
    expect(handlers.length).toBeGreaterThanOrEqual(18);
  });

  for (const h of handlers) {
    it(`${h.method} ${h.path} declares a bgv permission`, () => {
      expect(h.body, 'no requirePermission on this route').toMatch(/requirePermission\('bgv',/);
    });
  }

  const WRITES = handlers.filter(h => h.method !== 'GET');
  it('there is at least one write to check', () => {
    expect(WRITES.length).toBeGreaterThanOrEqual(8);
  });

  for (const h of WRITES) {
    it(`${h.method} ${h.path} resolves the caller's company`, () => {
      // Either companyOf(req) directly, or via a loader that takes it.
      expect(h.body, 'a write that never asks which tenant it is in cannot be scoped')
        .toMatch(/companyOf\(req\)/);
    });

    it(`${h.method} ${h.path} carries a tenant predicate or a scoped loader`, () => {
      // Three legitimate shapes, and no fourth:
      //   - a scoped loader (loadCase/loadCheck) resolved the record first;
      //   - the statement carries an explicit company predicate;
      //   - the statement is an INSERT that STAMPS company_id from the resolved
      //     companyId. POST /agencies is the only one of these, and it is
      //     genuinely scoped — it refuses outright when companyOf() is null
      //     rather than writing a NULL company that every tenant would then see.
      const scoped =
        /caseScopeSql\(|checkScopeSql\(|loadCase\(|loadCheck\(/.test(h.body) ||
        /company_id = \$\d+/.test(h.body) ||
        /INSERT INTO \w+[\s\S]*?company_id/.test(h.body);
      expect(scoped,
        `${h.method} ${h.path} has no visible tenant predicate. ` +
        'These tables have no company_id of their own — scope MUST come through employees.')
        .toBe(true);
    });
  }

  // ── The stricter rule, and why it is separate ────────────────────────────────
  // The rule above accepts a scoped LOADER (loadCase/loadCheck) in place of a
  // predicate on the statement. Mutation-testing this file showed that is too
  // weak: stripping `WHERE ${checkScopeSql(38)}` off the check UPDATE left the
  // suite green, because loadCheck() was still there.
  //
  // In that state the handler is not exploitable — loadCheck 404s a foreign id
  // before the UPDATE runs — but the UPDATE has become a statement that would
  // hit any tenant's row if it were ever reached another way, copied into a new
  // handler, or if the loader were refactored out. A mutating statement carries
  // its own predicate; the loader is the second line, not the only one.
  // ⚠ `\s+`, not a literal space. This was `/UPDATE \w+ SET/`, and the moment the
  // document DELETE became a multi-line `UPDATE bgv_documents SET deleted_at =
  // NOW()` for evidence retention, it stopped matching — so the new statement
  // silently dropped out of the scope guard and the suite went from 88 tests to
  // 87 while staying green. Reading the COUNT caught it, not the colour.
  const MUTATING = WRITES.filter(h => /UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w+/.test(h.body));

  it('found the mutating statements (sanity check)', () => {
    expect(MUTATING.length).toBeGreaterThanOrEqual(6);
  });

  for (const h of MUTATING) {
    it(`${h.method} ${h.path} — the UPDATE/DELETE itself is scoped, not just its loader`, () => {
      const predicateOnStatement =
        /caseScopeSql\(\d+\)|checkScopeSql\(\d+\)/.test(h.body) ||
        /company_id = \$\d+/.test(h.body) ||
        /e\.company_id = \$\d+::int/.test(h.body);
      expect(predicateOnStatement,
        `${h.method} ${h.path} relies on its loader alone. The mutating statement ` +
        'must carry caseScopeSql()/checkScopeSql() or its own company predicate.')
        .toBe(true);
    });
  }

  it('POST /agencies refuses to write a NULL-company row', () => {
    // A row with company_id NULL is visible to every tenant under the standard
    // `($1::int IS NULL OR company_id = $1)` predicate.
    // [[project_company_id_null_scoping_gotcha]]
    const h = handlers.find(x => x.method === 'POST' && x.path === '/agencies');
    expect(h).toBeTruthy();
    expect(h.body).toMatch(/if \(companyId == null\) return bad\(/);
  });

  it('no handler reads company_id from the request body', () => {
    // The tenant a record is filed under is never the client's to state.
    // [[project_company_of_scope_helper]]
    expect(CODE_ONLY).not.toMatch(/req\.body[^\n]*company_id/);
    expect(CODE_ONLY).not.toMatch(/company_id[^\n]*req\.body/);
  });

  it('no handler reads req.user.company_id directly', () => {
    // It skips companyOf()'s DB fallback, and a null company_id means "no filter"
    // in the standard predicate — i.e. the query fails OPEN across every tenant.
    expect(CODE_ONLY).not.toMatch(/req\.user\??\.company_id/);
  });
});

describe('cost columns keep "not captured" distinct from "free"', () => {
  it('amount and tax_amount have no DEFAULT 0', () => {
    // [[project_tco_freight_inputs_never_captured]] — DEFAULT 0 makes
    // "unmeasured" and "free of charge" the same stored value, and no report can
    // separate them afterwards.
    expect(MIGRATION_SRC).toMatch(/amount\s+NUMERIC\(12,2\),/);
    expect(MIGRATION_SRC).toMatch(/tax_amount\s+NUMERIC\(12,2\),/);
    expect(MIGRATION_SRC).not.toMatch(/amount\s+NUMERIC\(12,2\)\s+(NOT NULL\s+)?DEFAULT 0/);
  });

  it('total_amount is GENERATED, so it cannot disagree with its parts', () => {
    expect(MIGRATION_SRC).toMatch(/total_amount\s+NUMERIC\(12,2\) GENERATED ALWAYS AS/);
  });

  it('total_amount is NULL — not 0 — when neither part is captured', () => {
    expect(MIGRATION_SRC).toMatch(/CASE WHEN amount IS NULL AND tax_amount IS NULL THEN NULL/);
  });

  it('the UI formats money with a helper that renders null as an em-dash', () => {
    // utils/format.js's fmt() is `₹${Number(v ?? 0)}` and would print ₹0 for an
    // uncaptured cost, undoing the column design above.
    expect(FRONTEND_SRC).toMatch(/export function money/);
    expect(FRONTEND_SRC).toMatch(/if \(v === null \|\| v === undefined \|\| v === ''\) return '—'/);
  });
});

describe('the case has no stored status', () => {
  it('bgv_cases carries no status column', () => {
    // A stored rollup of the checks is a second source of truth that drifts the
    // moment one is edited by a path that forgets to recompute it.
    const table = /CREATE TABLE IF NOT EXISTS bgv_cases \(([\s\S]*?)\n {4}\)/.exec(MIGRATION_SRC);
    expect(table, 'bgv_cases DDL not found').toBeTruthy();
    expect(table[1]).not.toMatch(/\bstatus\b/);
  });

  it('closed_at is the only stored lifecycle fact', () => {
    expect(MIGRATION_SRC).toMatch(/closed_at\s+TIMESTAMPTZ/);
  });
});

describe('contact history is append-only', () => {
  it('there is no PATCH, PUT or DELETE route for a contact record', () => {
    // "This should create a history rather than overwriting previous contact
    // attempts." Enforced by the absence of a route, so it cannot be worked
    // around from the UI.
    expect(CODE_ONLY).not.toMatch(/router\.(patch|put|delete)\('\/(checks\/:id\/)?contacts/);
    expect(CODE_ONLY).not.toMatch(/router\.(patch|put|delete)\([^)]*contacts/);
  });
});

describe('BGV reports are never public and never in employee_documents', () => {
  it('the upload goes through StorageService, not a second writer', () => {
    expect(ROUTES_SRC).toMatch(/uploadFile\(req\.file\.buffer/);
  });

  it('a failed upload writes NO row', () => {
    // A document record with no document behind it lists as uploaded and opens
    // nothing — the defect the employee Documents tab shipped with.
    expect(ROUTES_SRC).toMatch(/return res\.status\(502\)/);
  });

  it('BGV documents are NOT filed in employee_documents', () => {
    // A criminal-record or reference report must not be listable through the
    // self-service documents API, which lets an employee read their own rows.
    expect(CODE_ONLY).not.toMatch(/employee_documents/);
  });

  it('the secure file route resolves bgv_documents and gates it on bgv:view', () => {
    const SECURE = readFileSync(resolve(here, '../modules/files/secureFiles.routes.js'), 'utf8');
    expect(SECURE, 'without this branch a BGV filename falls through to admin-only')
      .toMatch(/FROM bgv_documents d/);
    expect(SECURE).toMatch(/permissionFor\(req, 'bgv'\)/);
    // No self-ownership branch for BGV: the subject of the check is exactly who
    // must not be able to pull the report.
    const bgvBranch = /const bgv = await bgvDocumentOwner\(filename\);[\s\S]{0,400}?\n {4}\}/.exec(SECURE);
    expect(bgvBranch).toBeTruthy();
    expect(bgvBranch[0]).not.toMatch(/user_id/);
  });
});
