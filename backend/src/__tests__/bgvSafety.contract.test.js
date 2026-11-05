/**
 * BGV — the safety rules added in the final audit pass.
 *
 * Every test here exists because the behaviour it pins was WRONG at some point
 * in this module's history, and in two cases wrong in a way that destroyed data
 * or silently lost an investigator's finding. They are source-contract tests:
 * they read the production file and assert the rule is still written there,
 * which is cheap enough to run on every commit. The live-behaviour
 * counterparts are in `bgvIntegration.integration.test.js` and
 * `tests/bgv.spec.ts`.
 *
 * ⚠ Every negative assertion runs against COMMENT-STRIPPED source. Five times
 * in this module's history a `.not.toMatch()` passed because the string it was
 * forbidding appeared only in a comment explaining why it was forbidden.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const ROUTES_SRC = read('../modules/hr/bgv.routes.js');
const GUARD_MIGRATION = read('../database/migrations/20261012000001_bgv_skip_and_duplicate_guard.js');
const FRONT_BGV = read('../../../frontend/src/features/employees/pages/EmployeeBGV.jsx');

/** Comments removed; string and template literals kept. */
const CODE_ONLY = ROUTES_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));

function handlerBodyOf(method, path) {
  const re = new RegExp(
    `router\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => '\\' + m)}'([\\s\\S]*?)(?=\\nrouter\\.|\\nexport default)`);
  const m = re.exec(CODE_ONLY);
  if (!m) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  return m[1];
}

// ─────────────────────────────────────────────────────────────────────────────

describe('duplicate protection does not break legitimate re-verification', () => {
  it('the guard is a PARTIAL unique index, scoped to the OPEN statuses', () => {
    // ⚠ A blanket UNIQUE (case_id, check_type) would have been the obvious fix
    // and the wrong one: it permanently forbids re-running a verification after
    // a discrepancy is resolved, which is ordinary HR work. The index covers
    // only the open statuses, so "two of these in flight at once" is impossible
    // while "a second attempt after the first finished" stays legal.
    // The predicate is asserted INSIDE the CREATE statement, not anywhere in
    // the file: the same WHERE clause also appears in the duplicate detector
    // above it, so a file-wide match passed even with the index left blanket.
    // Mutation-proved by deleting the clause from the CREATE and watching this
    // fail.
    const create = /CREATE UNIQUE INDEX[\s\S]*?;/.exec(GUARD_MIGRATION);
    expect(create, 'the migration must create the index').toBeTruthy();
    expect(create[0]).toMatch(/ux_bgv_checks_one_active_per_type/);
    expect(create[0]).toMatch(/ON bgv_checks \(case_id, LOWER\(BTRIM\(check_type\)\)\)/);
    expect(create[0], 'a BLANKET unique index would forbid legitimate re-verification')
      .toMatch(/WHERE status IN \('Pending','Initiated','In Progress'\)/);
  });

  it('the index normalises the type, so "pan card" cannot slip past "PAN Card"', () => {
    expect(GUARD_MIGRATION).toMatch(/LOWER\(BTRIM\(check_type\)\)/);
  });

  it('the migration REFUSES to run against pre-existing duplicates, naming them', () => {
    // CREATE UNIQUE INDEX on dirty data fails with Postgres' own message, which
    // names the index and not the rows. Detecting first means the operator is
    // told which case and which type to resolve.
    expect(GUARD_MIGRATION).toMatch(/HAVING COUNT\(\*\) > 1/);
    expect(GUARD_MIGRATION).toMatch(/throw new Error/);
  });

  it('a 23505 from the index becomes a 409, not a 500', () => {
    // The index is the only thing standing between two concurrent identical
    // creates; surfaced as a 500 the UI would report "server error" for what is
    // really "you already have one of those open".
    for (const body of [handlerBodyOf('post', '/cases/:id/checks'),
      handlerBodyOf('post', '/checks/:id/reverify')]) {
      expect(body).toMatch(/err\.code === '23505'/);
      expect(body).toMatch(/DUPLICATE_ACTIVE_CHECK/);
      expect(body).toMatch(/status\(409\)/);
    }
  });

  it('re-verification REFUSES while the previous check is still open', () => {
    const rv = handlerBodyOf('post', '/checks/:id/reverify');
    expect(rv).toMatch(/PREVIOUS_STILL_OPEN/);
    expect(rv).toMatch(/\['Completed', 'Cancelled'\]\.includes\(previous\.status\)/);
  });

  it('re-verification requires a reason', () => {
    expect(handlerBodyOf('post', '/checks/:id/reverify')).toMatch(/REVERIFY_REASON_REQUIRED/);
  });

  it('⚠ re-verification OPENS a new check and overwrites nothing', () => {
    const rv = handlerBodyOf('post', '/checks/:id/reverify');
    expect(rv).toMatch(/INSERT INTO bgv_checks/);
    expect(rv, 'a re-verification is a second attempt, not a correction of the first')
      .not.toMatch(/UPDATE bgv_checks/);
    expect(rv, 'nor may it remove the previous evidence')
      .not.toMatch(/DELETE FROM bgv_/);
  });

  it('the new check LINKS to the one it supersedes', () => {
    expect(handlerBodyOf('post', '/checks/:id/reverify')).toMatch(/supersedes_check_id/);
    expect(GUARD_MIGRATION).toMatch(/supersedes_check_id/);
  });

  it('⚠ the new check carries NO result and NO cost forward', () => {
    const rv = handlerBodyOf('post', '/checks/:id/reverify');
    // It starts Pending/Pending. Copying the old result forward would be the
    // "Completed means Clear" conflation in another costume; copying the cost
    // forward would double-count the spend on the dashboard.
    expect(rv).toMatch(/'Pending','Pending'/);
    for (const money of ['amount', 'tax_amount', 'invoice_number', 'payment_status']) {
      expect(rv, `${money} must not be copied from the superseded check`)
        .not.toMatch(new RegExp(`previous\\.${money}`));
    }
  });
});

describe('a redacted finding cannot be written back', () => {
  /**
   * ⚠⚠ THE DEFECT THIS PINS, found by driving the real API in the final audit:
   *
   * `hr_exec` lacks `bgv_sensitive`, so a discrepancy check comes back with its
   * findings replaced by a marker. The edit modal disabled those fields, so
   * through the UI the data was safe. A direct `PATCH /bgv/checks/:id` echoing
   * back the object it had just been given wrote the MARKER over the real
   * finding, at HTTP 200, and the audit log recorded it as an ordinary edit.
   * The investigator's note was gone.
   *
   * Hiding a field in the client is not access control. The refusal belongs in
   * the handler.
   */
  it('PATCH refuses a sensitive field on a discrepancy check without the grant', () => {
    const patch = handlerBodyOf('patch', '/checks/:id');
    expect(patch).toMatch(/SENSITIVE_TEXT/);
    expect(patch).toMatch(/isSensitiveCheck\(existing\)/);
    expect(patch).toMatch(/canSeeSensitive\(req\)/);
    expect(patch).toMatch(/BGV_SENSITIVE_REQUIRED/);
    expect(patch).toMatch(/status\(403\)/);
  });

  it('the guarded fields are exactly the ones redactCheck hides', () => {
    // Two lists that must agree: if `redactCheck` ever hides a fourth field,
    // this fails until the write guard covers it too. A field that is
    // read-protected but write-open is the whole defect.
    const sens = /const SENSITIVE_TEXT = \[([^\]]*)\]/.exec(CODE_ONLY);
    expect(sens, 'the write guard must declare its field list').toBeTruthy();
    const guarded = sens[1].match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, '')).sort();
    const redacted = /export function redactCheck[\s\S]*?\n\}/.exec(CODE_ONLY)[0];
    const hidden = [...new Set(redacted.match(/\b(remarks|followup_notes|cost_remarks)\b/g) || [])].sort();
    expect(guarded).toEqual(hidden);
  });

  it('the refusal NAMES the fields and says the rest is still editable', () => {
    const patch = handlerBodyOf('patch', '/checks/:id');
    // A bare 403 on a twelve-field form sends HR guessing. The response lists
    // the offending keys so the UI can say which ones to drop.
    expect(patch).toMatch(/fields: touchedSensitive/);
    expect(patch).toMatch(/still editable/);
  });

  it('it triggers on the field being PRESENT, not on its value', () => {
    const patch = handlerBodyOf('patch', '/checks/:id');
    // `!== undefined`, not truthiness: `remarks: ''` and the marker string are
    // both writes to a protected field. Comparing against the marker text would
    // be a blocklist, defeated by one character of whitespace.
    expect(patch).toMatch(/req\.body\?\.\[k\] !== undefined/);
    expect(patch, 'never compare against the marker text — that is a blocklist')
      .not.toMatch(/=== REDACTED|=== 'Restricted/);
  });

  it('and only on a check that IS sensitive, so a Clear check stays editable', () => {
    expect(handlerBodyOf('patch', '/checks/:id'))
      .toMatch(/touchedSensitive\.length && isSensitiveCheck\(existing\)/);
  });
});

describe('skipping an optional check is a recorded decision', () => {
  it('a REQUIRED check cannot be skipped', () => {
    const skip = handlerBodyOf('post', '/checks/:id/skip');
    // Otherwise skip is a force-close with extra steps — the exact behaviour an
    // earlier brief had removed from this module.
    expect(skip).toMatch(/applicability === 'Required'/);
    expect(skip).toMatch(/CANNOT_SKIP_REQUIRED/);
    expect(skip).toMatch(/status\(409\)/);
  });

  it('it demands a reason, stores it, and audits it', () => {
    const skip = handlerBodyOf('post', '/checks/:id/skip');
    expect(skip).toMatch(/SKIP_REASON_REQUIRED/);
    expect(skip).toMatch(/skip_reason = \$4/);
    expect(skip).toMatch(/skipped_at = NOW\(\), skipped_by = \$1/);
    expect(skip).toMatch(/action: 'skip'/);
    expect(skip).toMatch(/oldData: existing/);
  });

  it('it CANCELS the check rather than deleting it', () => {
    const skip = handlerBodyOf('post', '/checks/:id/skip');
    expect(skip).toMatch(/SET status = 'Cancelled'/);
    expect(skip, 'the skipped check and its reason ARE the record of the decision')
      .not.toMatch(/DELETE FROM/);
  });

  it('it is tenant-scoped on the write as well as the read', () => {
    const skip = handlerBodyOf('post', '/checks/:id/skip');
    expect(skip).toMatch(/loadCheck\(id, companyId\)/);
    expect(skip).toMatch(/checkScopeSql\(3\)/);
  });

  it('it refuses on a closed case, like every other check write', () => {
    expect(handlerBodyOf('post', '/checks/:id/skip')).toMatch(/case_closed_at/);
  });

  it('the skip and re-verify columns arrive in one migration', () => {
    for (const col of ['skipped_at', 'skipped_by', 'skip_reason', 'supersedes_check_id']) {
      expect(GUARD_MIGRATION).toMatch(new RegExp(col));
    }
  });

  it('the UI offers both actions against the real endpoints', () => {
    // The row actions mirror the server's own preconditions, so HR is not given
    // a button whose only possible outcome is a 409.
    expect(FRONT_BGV).toMatch(/\/skip/);
    expect(FRONT_BGV).toMatch(/\/reverify/);
    expect(FRONT_BGV).toMatch(/Re-verify/);
  });
});

describe('reopening is gated in the backend, not the UI', () => {
  it('it needs the sensitive grant, a reason, and leaves an audit row', () => {
    const reopen = handlerBodyOf('post', '/cases/:id/reopen');
    expect(reopen).toMatch(/canSeeSensitive\(req\)/);
    expect(reopen).toMatch(/BGV_SENSITIVE_REQUIRED/);
    expect(reopen).toMatch(/reopen_reason/);
    expect(reopen).toMatch(/action: 'reopen'/);
  });

  it('⚠ a foreign tenant gets 404, not 403 — a 403 would confirm it exists', () => {
    const reopen = handlerBodyOf('post', '/cases/:id/reopen');
    expect(reopen).toMatch(/loadCase\(id, companyId\)/);
    expect(reopen).toMatch(/status\(404\)/);
    expect(reopen, 'never trust a client-supplied company')
      .not.toMatch(/req\.user\.company_id/);
  });
});
