/**
 * BGV — the checklist workflow, applicability, progress, and reopen.
 *
 * Source and schema text; the behavioural half is in
 * bgvIntegration.integration.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { APPLICABILITY, APPLICABLE, PROFILE_KEYS, profileChecklist } from '../modules/hr/bgv.routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const ROUTES_SRC = read('../modules/hr/bgv.routes.js');
const APPLIC_MIGRATION = read('../database/migrations/20260930000013_bgv_check_applicability.js');
const REOPEN_MIGRATION = read('../database/migrations/20260930000014_bgv_case_reopen_reason.js');
const FRONT_SHARED = read('../../../frontend/src/features/employees/bgv.js');
const FRONT_BGV = read('../../../frontend/src/features/employees/pages/EmployeeBGV.jsx');

const CODE_ONLY = ROUTES_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));

function handlerBodyOf(method, path) {
  const re = new RegExp(
    `router\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => '\\' + m)}'([\\s\\S]*?)(?=\\nrouter\\.|\\nexport default)`);
  const m = re.exec(CODE_ONLY);
  if (!m) throw new Error(`handler not found: ${method.toUpperCase()} ${path}`);
  return m[1];
}

/**
 * The FILTER predicate that produces one aliased aggregate.
 *
 * Walks BACKWARDS from `AS <alias>` to the nearest `COUNT(*) FILTER (`.
 *
 * A forward lazy match from the start of the rollup spans every EARLIER
 * aggregate, so "this one does not mention Cancelled" was being asserted against
 * a different aggregate's predicate entirely and failed on working code.
 */
function filterFor(rollup, alias) {
  const at = rollup.indexOf('AS ' + alias);
  if (at < 0) return null;
  const open = rollup.lastIndexOf('COUNT(*) FILTER (', at);
  if (open < 0) return null;
  return rollup.slice(open, at);
}

describe('applicability is a real, constrained state', () => {
  it('the API list and the CHECK constraint are identical', () => {
    const m = /CHECK \(applicability IN \(([^)]*)\)\)/.exec(APPLIC_MIGRATION);
    expect(m, 'no CHECK constraint on applicability').toBeTruthy();
    const dbValues = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
    expect([...APPLICABILITY].sort()).toEqual([...dbValues].sort());
  });

  it('the frontend offers exactly the same three', () => {
    const m = /export const APPLICABILITY = \[([^\]]*)\]/.exec(FRONT_SHARED);
    expect(m).toBeTruthy();
    expect([...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).sort())
      .toEqual([...APPLICABILITY].sort());
  });

  it('APPLICABLE is Required + Optional — Not Applicable is never work', () => {
    expect([...APPLICABLE].sort()).toEqual(['Optional', 'Required']);
    expect(APPLICABLE).not.toContain('Not Applicable');
  });

  it('the column defaults to Required, which fails SAFE', () => {
    // A default of Optional or Not Applicable would let a caller that forgot the
    // field create a check no progress figure counts and no closure guard
    // notices — a verification that looks done because nothing looks for it.
    expect(APPLIC_MIGRATION).toMatch(/applicability VARCHAR\(20\) NOT NULL DEFAULT 'Required'/);
  });

  it('the constraint is added guarded, so the migration can re-run', () => {
    // ADD CONSTRAINT is not idempotent; an unguarded re-run aborts the migration.
    expect(APPLIC_MIGRATION).toMatch(/FROM pg_constraint WHERE conname = 'bgv_checks_applicability_chk'/);
  });

  it('there is NO unique index on (case, type) — a repeat verification is legal', () => {
    // A re-check after a discrepancy is resolved is ordinary work. The duplicate
    // rule belongs on the CHECKLIST path, not in the schema, or the legitimate
    // case becomes impossible.
    expect(APPLIC_MIGRATION).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*?bgv_checks/);
    expect(APPLIC_MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_bgv_checks_case_type/);
  });
});

describe('the rollup never counts a Not Applicable check as work', () => {
  const rollup = () => /export const CHECK_ROLLUP = `([\s\S]*?)`;/.exec(ROUTES_SRC)[1];

  /** Every aggregate that means "outstanding work" must exclude Not Applicable. */
  const WORK_AGGREGATES = [
    'pending', 'working', 'open_applicable', 'missing_reports', 'overdue',
  ];

  for (const name of WORK_AGGREGATES) {
    it(`${name} filters on applicability`, () => {
      const r = rollup();
      // Find the FILTER clause that produces this alias and require it to
      // mention applicability.
      const predicate = filterFor(r, name);
      expect(predicate, `aggregate ${name} not found in CHECK_ROLLUP`).toBeTruthy();
      expect(predicate,
        `${name} counts Not Applicable checks as work — that is the misleading ` +
        'count the brief called out')
        .toMatch(/applicability IN \('Required','Optional'\)/);
    });
  }

  it('the REQUIRED breakdown the brief asked for all exists', () => {
    const r = rollup();
    for (const alias of ['required_total', 'required_completed', 'required_in_progress',
      'required_pending', 'required_discrepancies', 'optional_total',
      'not_applicable', 'applicable_total']) {
      expect(r, `CHECK_ROLLUP is missing ${alias}`).toMatch(new RegExp(`AS ${alias}\\b`));
    }
  });

  it('⚠ COST is deliberately NOT filtered by applicability', () => {
    // A check ruled Not Applicable after an agency was already paid still cost
    // money; a spend report that hid it would not reconcile against the invoices.
    const r = rollup();
    const cost = /SUM\(ch\.total_amount\)\s+AS total_cost/.exec(r);
    expect(cost, 'total_cost not found').toBeTruthy();
    const line = r.slice(Math.max(0, cost.index - 120), cost.index + 60);
    expect(line).not.toMatch(/applicability/);
  });

  it('completion percentage is over REQUIRED only, and NULL when none', () => {
    const select = /export const CASE_SELECT = `([\s\S]*?)`;/.exec(ROUTES_SRC)[1];
    expect(select).toMatch(/WHEN COALESCE\(k\.required_total, 0\) = 0 THEN NULL/);
    expect(select).toMatch(/100\.0 \* k\.required_completed \/ k\.required_total/);
  });

  it('Cancelled counts as RESOLVED but not as completed', () => {
    // Finished work that verified nothing: it must not hold the case open, and
    // must not inflate the completion figure.
    const r = rollup();
    expect(r).toMatch(/AS required_cancelled/);
    const predicate = filterFor(r, 'required_completed');
    expect(predicate).toMatch(/status = 'Completed'/);
    expect(predicate, 'a cancelled check verified nothing — it must not count as completed')
      .not.toMatch(/Cancelled/);
  });

  it('the frontend progress label counts REQUIRED, not every check', () => {
    expect(FRONT_SHARED).toMatch(/export const requiredProgressLabel/);
    expect(FRONT_SHARED).toMatch(/required checks completed/);
    // The old all-checks label must be gone from the pages.
    expect(FRONT_BGV, 'the misleading all-checks count must not be rendered')
      .not.toMatch(/progressLabel\(/);
  });

  it('the percentage helper returns null — not 0 — when nothing is required', () => {
    expect(FRONT_SHARED).toMatch(/export const requiredPct/);
    expect(FRONT_SHARED).toMatch(/if \(!total\) return null/);
  });
});

describe('the checklist workflow', () => {
  it('profiles are served by the API, not hardcoded in the page', () => {
    // "What does a fresher need verified" is a business rule; a copy in the page
    // drifts the first time either changes.
    expect(CODE_ONLY).toMatch(/router\.get\('\/profiles'/);
    expect(FRONT_BGV).toMatch(/api\.get\('\/bgv\/profiles'\)/);
    expect(FRONT_BGV, 'the page must not carry its own profile table')
      .not.toMatch(/PROFILE_DEFAULTS|'Identity Verification':\s*'Required'/);
  });

  it('three profiles: fresher, experienced, custom', () => {
    expect([...PROFILE_KEYS].sort()).toEqual(['custom', 'experienced', 'fresher']);
  });

  it('⚠ Fresher marks Employment Verification NOT APPLICABLE', () => {
    // The whole point of the profile. Leaving it out loses the record that it was
    // considered; creating it Required leaves a check that can never be
    // satisfied sitting in the pending queue forever.
    const types = ['Identity Verification', 'Address Verification', 'Education Verification',
      'Criminal/Court Check', 'Employment Verification', 'Reference Check'];
    const f = profileChecklist('fresher', types);
    const row = (t) => f.checks.find(c => c.check_type === t);
    expect(row('Employment Verification').applicability).toBe('Not Applicable');
    expect(row('Employment Verification').selected,
      'it must still be CREATED, so the decision is on the record').toBe(true);
    for (const t of ['Identity Verification', 'Address Verification',
      'Education Verification', 'Criminal/Court Check']) {
      expect(row(t).applicability, `${t} should be Required for a fresher`).toBe('Required');
      expect(row(t).selected).toBe(true);
    }
  });

  it('⚠ Experienced marks Employment Verification REQUIRED', () => {
    const x = profileChecklist('experienced', ['Employment Verification', 'Identity Verification']);
    expect(x.checks.find(c => c.check_type === 'Employment Verification').applicability)
      .toBe('Required');
  });

  it('Custom pre-selects nothing', () => {
    const c = profileChecklist('custom', ['Identity Verification', 'Employment Verification']);
    expect(c.checks.every(r => r.selected === false)).toBe(true);
  });

  it('the checklist is built over the LIVE master, so a tenant-added type appears', () => {
    // A hardcoded list would have made the check-type master read-only.
    const f = profileChecklist('fresher', ['Identity Verification', 'ZZ Tenant Drug Screen']);
    const added = f.checks.find(c => c.check_type === 'ZZ Tenant Drug Screen');
    expect(added, 'a type the tenant added must be offered').toBeTruthy();
    expect(added.selected, 'but not pre-selected by a profile that never heard of it').toBe(false);
    expect(added.applicability, 'and it carries a sensible default for when it is ticked')
      .toBe('Required');
  });

  it('a profile type missing from the master is FLAGGED, not dropped', () => {
    // Silently dropping it turns a renamed vocabulary value into a check that
    // stopped being offered with no explanation.
    const f = profileChecklist('fresher', ['Identity Verification']);
    const gone = f.checks.find(c => c.check_type === 'Employment Verification');
    expect(gone).toBeTruthy();
    expect(gone.missing_from_master).toBe(true);
  });

  it('the master query only offers ACTIVE types, and is tenant-scoped', () => {
    expect(CODE_ONLY).toMatch(/type = 'BGV_CHECK_TYPE' AND is_active = true/);
    expect(CODE_ONLY).toMatch(/\(company_id IS NULL OR company_id = \$1::int\)/);
  });

  it('bulk creation runs in ONE transaction', () => {
    // A checklist that creates four of six and then fails leaves HR to work out
    // which four, and the profile they picked no longer describes the case.
    expect(CODE_ONLY).toMatch(/async function createChecksBulk/);
    const fn = /async function createChecksBulk[\s\S]*?\n\}/.exec(CODE_ONLY)[0];
    expect(fn).toMatch(/await client\.query\('BEGIN'\)/);
    expect(fn).toMatch(/await client\.query\('COMMIT'\)/);
    expect(fn).toMatch(/ROLLBACK/);
    expect(fn, 'the connection must be released even on a throw').toMatch(/finally \{[\s\S]*?client\.release\(\)/);
  });

  it('⚠ no second pool connection is taken while the transaction is held', () => {
    // Asking the pool for another connection mid-transaction is how a small pool
    // deadlocks under concurrency and reports a bare 500 that reads as a flake.
    const fn = /async function createChecksBulk[\s\S]*?\n\}/.exec(CODE_ONLY)[0];
    const connects = fn.match(/pool\.connect\(\)/g) || [];
    expect(connects.length).toBe(1);
    // Helpers called inside must be handed the client, not left to take their own.
    expect(fn).toMatch(/agencyInScope\(agencyId, companyId, client\)/);
    expect(fn).toMatch(/agencyContact\(agencyId, companyId, client\)/);
  });

  it('the checklist path SKIPS a type the case already has, and says so', () => {
    const fn = /async function createChecksBulk[\s\S]*?\n\}/.exec(CODE_ONLY)[0];
    expect(fn).toMatch(/skipped\.push/);
    // ⚠ The two cases are NOT the same message. An OPEN check of that type is
    // a duplicate; a RESOLVED one is a completed verification HR may
    // legitimately want to run again — so the skip points them at Re-verify
    // rather than reading as a flat refusal.
    expect(fn).toMatch(/already has an open \$\{check_type\} check/);
    expect(fn).toMatch(/use Re-verify to run it again/);
  });

  it('but the single-check endpoint still allows a deliberate repeat', () => {
    // A re-check after a discrepancy is resolved is ordinary work.
    const single = handlerBodyOf('post', '/cases/:id/checks');
    expect(single).not.toMatch(/already has that verification/);
  });

  it('one action opens the case AND creates the checklist', () => {
    const start = handlerBodyOf('post', '/employees/:employeeId/start');
    expect(start).toMatch(/INSERT INTO bgv_cases/);
    expect(start).toMatch(/ON CONFLICT \(employee_id\) DO NOTHING/);
    expect(start).toMatch(/createChecksBulk/);
  });

  it('both checklist endpoints refuse an empty selection', () => {
    for (const body of [handlerBodyOf('post', '/employees/:employeeId/start'),
      handlerBodyOf('post', '/cases/:id/checks/bulk')]) {
      expect(body).toMatch(/Select at least one verification check/);
    }
  });

  it('both refuse to add checks to a CLOSED case', () => {
    for (const body of [handlerBodyOf('post', '/employees/:employeeId/start'),
      handlerBodyOf('post', '/cases/:id/checks/bulk')]) {
      expect(body).toMatch(/closed_at/);
      expect(body).toMatch(/Reopen it to add checks/);
    }
  });

  it('the UI lets HR add and remove before creating', () => {
    expect(FRONT_BGV).toMatch(/type="checkbox"/);
    expect(FRONT_BGV).toMatch(/setRow\(r\.check_type, \{ selected: e\.target\.checked \}\)/);
    expect(FRONT_BGV).toMatch(/aria-label=\{`\$\{r\.check_type\} applicability`\}/);
    // And says what will happen, including the Not Applicable rows.
    expect(FRONT_BGV).toMatch(/will be created/);
  });

  it('the UI shows an already-present type as disabled rather than hiding it', () => {
    expect(FRONT_BGV).toMatch(/already on this case/);
    expect(FRONT_BGV).toMatch(/disabled=\{r\.already\}/);
  });
});

describe('closure and reopening', () => {
  it('only REQUIRED checks block closure — Optional does not', () => {
    const close = handlerBodyOf('post', '/cases/:id/close');
    // The final rule. An earlier pass blocked on `IN ('Required','Optional')`,
    // which made "Optional" mean nothing: a nice-to-have reference check held
    // the whole case open with no exit but cancelling it.
    expect(close).toMatch(/applicability = 'Required'/);
    expect(close, 'Optional must not become a blocker again')
      .not.toMatch(/applicability IN \('Required','Optional'\)/);
    expect(close, 'the refusal must say REQUIRED, or HR hunts the wrong checks')
      .toMatch(/required verification check/);
    expect(close, 'a Not Applicable check must never hold a case open')
      .toMatch(/status IN \('Pending','Initiated','In Progress'\)/);
  });

  it('⚠⚠ the UI close guard filters on APPLICABILITY, not status alone', () => {
    // Found in the browser: the client-side pre-check was
    // `['Pending','Initiated','In Progress'].includes(ch.status)`, which ignored
    // applicability — so for a fresher it named Employment Verification
    // (Not Applicable) as a blocker and told HR to resolve a check that by
    // definition cannot be resolved. The server's guard was right; this one
    // contradicted it.
    //
    // The fix reuses the SHARED helper rather than restating the rule, because
    // two copies of "what counts as outstanding" is how they came to disagree.
    expect(FRONT_BGV).toMatch(/const openNow = \(data\.checks \|\| \[\]\)\.filter\(blocksClosure\)/);
    expect(FRONT_BGV, 'a status-only filter must not come back')
      .not.toMatch(/ch => \['Pending', 'Initiated', 'In Progress'\]\.includes\(ch\.status\)\)/);
    // And the shared helper is the one place the rule lives.
    // There are TWO shared helpers, because they answer different questions:
    // `isOutstanding` is "is this work?" (the progress strip, Optional
    // included); `blocksClosure` is "will the server refuse to close?"
    // (Required only). The close guard must use the SECOND — using the first
    // is exactly how the UI came to name a check as a blocker that the server
    // would have let through.
    expect(FRONT_SHARED).toMatch(/export const isOutstanding = \(check\) =>[\s\S]{0,40}APPLICABLE\.includes/);
    expect(FRONT_SHARED).toMatch(/export const blocksClosure = \(check\) =>[\s\S]{0,60}'Required'/);
  });

  it('there is still no force override', () => {
    expect(CODE_ONLY).not.toMatch(/\bforce\b/);
    expect(FRONT_BGV).not.toMatch(/closeCase\(true\)/);
  });

  it('reopening requires bgv_sensitive AND a reason', () => {
    const reopen = handlerBodyOf('post', '/cases/:id/reopen');
    expect(reopen).toMatch(/canSeeSensitive\(req\)/);
    expect(reopen).toMatch(/BGV_SENSITIVE_REQUIRED/);
    expect(reopen).toMatch(/REOPEN_REASON_REQUIRED/);
    // A one-character reason is a way round the requirement, not a reason.
    expect(reopen).toMatch(/reason\.length < 5/);
  });

  it('reopening keeps the ordinary edit gate as well', () => {
    // Swapping the gate for bgv_sensitive would let a reader with no edit grant
    // reopen a case; BOTH must hold.
    expect(ROUTES_SRC).toMatch(
      /router\.post\('\/cases\/:id\/reopen', requirePermission\('bgv', 'edit'\)/);
  });

  it('the reason is stored on the case AND written to the audit log', () => {
    const reopen = handlerBodyOf('post', '/cases/:id/reopen');
    expect(reopen).toMatch(/reopened_at = NOW\(\), reopened_by = \$1, reopen_reason = \$4/);
    expect(reopen).toMatch(/action: 'reopen'/);
    expect(reopen, 'the reason must be explicit in the audit payload')
      .toMatch(/reopen_reason: reason/);
    expect(REOPEN_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS reopened_at/);
    expect(REOPEN_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS reopen_reason/);
  });

  it('reopening an already-open case is refused', () => {
    expect(handlerBodyOf('post', '/cases/:id/reopen')).toMatch(/not closed/);
  });

  it('the closing reason and the reopening reason are different columns', () => {
    // Reusing closure_remarks would overwrite why it was closed with why that was
    // undone, and lose the first.
    expect(REOPEN_MIGRATION).not.toMatch(/closure_remarks\s*=/);
  });

  it('the UI asks for the reason and hides the button without the grant', () => {
    expect(FRONT_BGV).toMatch(/Why is this closed BGV case being reopened\?/);
    expect(FRONT_BGV).toMatch(/canEdit && closed && canSeeSensitive/);
    expect(FRONT_BGV).toMatch(/Reopening is restricted to HR Manager \/ Admin/);
  });
});

describe('an applicability change is audited as its own action', () => {
  it('PATCH accepts applicability and names the change', () => {
    const patch = handlerBodyOf('patch', '/checks/:id');
    expect(patch).toMatch(/oneOf\(req\.body\.applicability, APPLICABILITY\)/);
    expect(patch).toMatch(/applicabilityChanged/);
    expect(patch).toMatch(/action: applicabilityChanged \? 'applicability_change'/);
  });

  it('a Not Applicable check is never drawn as overdue or owing a report', () => {
    expect(FRONT_BGV).toMatch(/const applies = ch\.applicability !== 'Not Applicable'/);
    expect(FRONT_BGV).toMatch(/const overdue = applies &&/);
  });

  it('needsReport ignores a Not Applicable check, and fails SAFE without one', () => {
    // It consults APPLICABLE…
    const fn = /export const needsReport = \(check\) =>([\s\S]*?);\n/.exec(FRONT_SHARED);
    expect(fn, 'needsReport not found').toBeTruthy();
    expect(fn[1]).toMatch(/APPLICABLE\.includes/);
    // …and a MISSING applicability counts as applicable, so a stale payload
    // shows the outstanding report rather than silently hiding it. Asserted
    // because the fail-safe direction is the whole point: requiring the field
    // strictly made an older response report no missing reports at all.
    expect(fn[1]).toMatch(/check\?\.applicability == null \|\|/);
  });
});
