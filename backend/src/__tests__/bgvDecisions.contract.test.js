/**
 * BGV — the four decisions settled after the first pass, held in place.
 *
 *   1. The agency master is the ONLY place a contact is entered.
 *   2. Discrepancy findings are gated separately from the right to run BGV.
 *   3. An open check blocks case closure outright — no force override.
 *   4. BGV evidence is retired, never erased.
 *
 * Source and schema text only; no database, no server.
 * `bgvIntegration.integration.test.js` runs the behavioural half.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const ROUTES_SRC = read('../modules/hr/bgv.routes.js');
const SECURE     = read('../modules/files/secureFiles.routes.js');
const SENSITIVE_MIGRATION = read('../database/migrations/20260930000011_bgv_sensitive_permission.js');
const RETENTION_MIGRATION = read('../database/migrations/20260930000012_bgv_document_retention.js');
const FRONT_BGV  = read('../../../frontend/src/features/employees/pages/EmployeeBGV.jsx');
const FRONT_HUB  = read('../../../frontend/src/features/employees/pages/BackgroundVerification.jsx');

/**
 * The router with comments stripped.
 *
 * ⚠ Every "must NOT appear" assertion below runs on this, not the raw file. A
 * negative source assertion that reads comments fails on its own documentation —
 * and, far worse, would PASS if someone deleted the warning and kept the bug.
 * Four assertions in the first BGV pass had exactly that fault.
 */
const CODE_ONLY = ROUTES_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));

/** One route handler's body, comment-stripped, addressed by verb + path. */
function handlerBodyOf(method, path) {
  const re = new RegExp(
    `router\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => '\\' + m)}'([\\s\\S]*?)(?=\\nrouter\\.|\\nexport default)`);
  const m = re.exec(CODE_ONLY);
  if (!m) throw new Error(`handler not found: ${method.toUpperCase()} ${path}`);
  return m[1];
}

// ═════════════════════════════════════════════════════════════════════════════

describe('1 — the agency master is the only place a contact is entered', () => {
  it('a check resolves its contact from the agency, and says which it used', () => {
    // Computed once in SQL so the detail page, the folder view and any later
    // export cannot disagree about which contact a check actually used.
    expect(ROUTES_SRC).toMatch(/export const CHECK_CONTACT_SELECT/);
    expect(CODE_ONLY).toMatch(/COALESCE\(ch\.contact_person, ag\.contact_person\) AS effective_contact_person/);
    expect(CODE_ONLY).toMatch(/COALESCE\(ch\.contact_email,\s+ag\.email\)\s+AS effective_contact_email/);
    expect(CODE_ONLY).toMatch(/COALESCE\(ch\.contact_phone,\s+ag\.phone\)\s+AS effective_contact_phone/);
    expect(CODE_ONLY, 'the UI must be told whether to draw the agency card or an override')
      .toMatch(/AS contact_is_override/);
  });

  it('the detail page ships the agency card alongside every check', () => {
    // Without these the modal cannot populate the read-only fields, and HR is
    // straight back to retyping them.
    expect(CODE_ONLY).toMatch(/ag\.contact_person AS agency_contact_person/);
    expect(CODE_ONLY).toMatch(/\$\{CHECK_CONTACT_SELECT\}/);
  });

  it('a contact that merely repeats the agency is stored as NULL, on BOTH write paths', () => {
    // "Do not create duplicate agency/contact records." Enforced server-side:
    // the API is reachable without the UI, and a client can round-trip the
    // read-only values straight back, minting the duplicate the master exists to
    // prevent and freezing it at today's value.
    expect(CODE_ONLY).toMatch(/function dedupeContact/);
    expect(handlerBodyOf('post', '/cases/:id/checks'),
      'the create path must de-duplicate').toMatch(/dedupeContact\(/);
    expect(handlerBodyOf('patch', '/checks/:id'),
      'the update path must de-duplicate').toMatch(/dedupeContact\(/);
  });

  it('the PATCH de-duplicates against the INCOMING agency, not the stored one', () => {
    // Moving a check from agency A to B while sending B's contact card would
    // otherwise be compared against A, kept as an "override", and frozen at the
    // value it had on the day of the move.
    const patch = handlerBodyOf('patch', '/checks/:id');
    expect(patch).toMatch(/const effectiveAgencyId = agencyId !== undefined \? agencyId : existing\.agency_id/);
    expect(patch).toMatch(/agencyContact\(effectiveAgencyId, companyId\)/);
  });

  it('matching is case- and whitespace-insensitive', () => {
    // A copy-paste picks up stray case and spaces; "Ravi Kumar " must not become
    // an override of "Ravi Kumar".
    expect(CODE_ONLY).toMatch(/String\(a\)\.trim\(\)\.toLowerCase\(\) === String\(b\)\.trim\(\)\.toLowerCase\(\)/);
  });

  it('the three contact columns are written on EVERY patch, not only when mentioned', () => {
    // Changing the agency has to re-resolve them even if the caller said nothing
    // about the contact, or the check keeps the old agency's card.
    const patch = handlerBodyOf('patch', '/checks/:id');
    expect(patch).toMatch(/true, patchContact\.contact_person/);
    expect(patch).toMatch(/true, patchContact\.contact_email/);
    expect(patch).toMatch(/true, patchContact\.contact_phone/);
  });

  it('⚠ no $n is bound without being referenced', () => {
    // An unreferenced binding is a "could not determine data type of parameter
    // $4" error, not dead weight. The CASE WHEN shape is kept for exactly that
    // reason. [[project_pg_unreferenced_param_bind_error]]
    const patch = handlerBodyOf('patch', '/checks/:id');
    expect(patch).toMatch(/contact_person = CASE WHEN \$4 THEN \$5 ELSE contact_person END/);
    expect(patch).toMatch(/contact_email {2}= CASE WHEN \$6 THEN \$7 ELSE contact_email END/);
    expect(patch).toMatch(/contact_phone {2}= CASE WHEN \$8 THEN \$9 ELSE contact_phone END/);
  });

  it('the UI shows the agency contact read-only, with an explicit override action', () => {
    expect(FRONT_BGV).toMatch(/Use a different contact for this check/);
    expect(FRONT_BGV).toMatch(/Go back to the agency contact/);
    expect(FRONT_BGV).toMatch(/readOnly value=\{agency\.contact_person \|\| '—'\}/);
    expect(FRONT_BGV).toMatch(/readOnly value=\{agency\.email \|\| '—'\}/);
    expect(FRONT_BGV).toMatch(/readOnly value=\{agency\.phone \|\| '—'\}/);
    // Dropping the override must CLEAR the fields, or the typed values go back.
    expect(FRONT_BGV).toMatch(/contact_person: '', contact_email: '', contact_phone: ''/);
  });
});

describe('2 — discrepancy findings are gated separately from BGV itself', () => {
  it('the grant is a permission row, not a role list in the route', () => {
    // A hardcoded role list cannot be administered, and a tenant that adds an HR
    // tier cannot adjust it.
    expect(CODE_ONLY).toMatch(/permissionFor\(req, 'bgv_sensitive'\)/);
    expect(CODE_ONLY, 'no role names may decide this').not.toMatch(/hr_manager/);
  });

  it('hr_exec is NOT granted it, and the HR/Admin tier is', () => {
    expect(SENSITIVE_MIGRATION).toMatch(
      /BGV_SENSITIVE_ROLES = \['super_admin', 'admin', 'hr', 'hr_manager'\]/);
    expect(SENSITIVE_MIGRATION, "hr_exec is the 'HR operations' tier the brief distinguishes")
      .not.toMatch(/'hr_exec'/);
  });

  it('the matrix is seeded for every role, so a denial is a decision not an omission', () => {
    expect(SENSITIVE_MIGRATION).toMatch(/FROM roles r\s*\n\s*WHERE r\.code IS NOT NULL/);
  });

  it('only a Discrepancy result restricts anything', () => {
    // 'Unable to Verify' means the agency could not reach the source — ordinary
    // follow-up the HR executive chasing it must be able to read. Restricting it
    // would leave the check looking abandoned.
    expect(CODE_ONLY).toMatch(/const isSensitiveCheck = \(row\) => row\?\.result === 'Discrepancy'/);
  });

  it('the STATUS and the RESULT are never redacted — only the findings are', () => {
    // "Normal HR users can see the BGV status/result at the level permitted by
    // the existing workflow." A redaction that hid the result would make a
    // finding look like unfinished work, and HR would chase it forever.
    const redact = /function redactCheck\(row\) \{[\s\S]*?\n\}/.exec(CODE_ONLY);
    expect(redact, 'redactCheck not found').toBeTruthy();
    for (const kept of ['status', 'result', 'check_type', 'amount', 'agency_id']) {
      expect(redact[0], `redactCheck must not touch ${kept}`)
        .not.toMatch(new RegExp(`\\b${kept}:`));
    }
    for (const hidden of ['remarks', 'followup_notes', 'cost_remarks']) {
      expect(redact[0], `${hidden} must be redacted`).toMatch(new RegExp(`${hidden}:`));
    }
  });

  it('a redaction is a visible marker, not an empty string', () => {
    // A blank reads as "nothing was written", which is a different and wrong
    // answer from "you may not read this".
    expect(CODE_ONLY).toMatch(/const REDACTED = 'Restricted/);
  });

  it('it is applied to the case page, the contact history, the folders AND the exports', () => {
    // "Apply this consistently to list, employee case page, reports and document
    // access." One surface left open makes the other three decorative.
    expect(handlerBodyOf('get', '/employees/:employeeId'), 'case page').toMatch(/canSeeSensitive\(req\)/);
    expect(handlerBodyOf('get', '/checks/:id/contacts'), 'contact history').toMatch(/canSeeSensitive\(req\)/);
    expect(handlerBodyOf('get', '/cases/:id/documents'), 'folder view').toMatch(/canSeeSensitive\(req\)/);
    expect(handlerBodyOf('get', '/reports/:kind'), 'exports').toMatch(/canSeeSensitive\(req\)/);
  });

  it('the Discrepancy Report export is refused without the grant', () => {
    const body = handlerBodyOf('get', '/reports/:kind');
    expect(body).toMatch(/kind === 'discrepancy' && !\(await canSeeSensitive\(req\)\)/);
    expect(body).toMatch(/BGV_SENSITIVE_REQUIRED/);
  });

  it('the file route enforces it too, or the folder view would be decorative', () => {
    // Hiding a report in the folder view while GET /api/files still served the
    // bytes is a gate with a hole behind it —
    // [[project_pulse01_env_write_rbac_killswitch]], where a gated endpoint had
    // seven ungated aliases.
    expect(SECURE).toMatch(/async function bgvSensitivePermission/);
    expect(SECURE).toMatch(/permissionFor\(req, 'bgv_sensitive'\)/);
    expect(SECURE, 'the owner lookup must carry the result to decide on')
      .toMatch(/ch\.check_type, ch\.result/);
    // HEAD and GET must ask the same question, or the probe leaks what the
    // download refuses.
    const hits = SECURE.match(/bgvSensitivePermission\(req\)/g) || [];
    expect(hits.length, 'canReadFile (HEAD) and the GET handler must both check it')
      .toBeGreaterThanOrEqual(2);
  });

  it('a restricted folder is distinguishable from an empty one', () => {
    // "No report attached yet" is a job to do; "you may not see this" is a
    // permission. Drawn alike, HR chases an agency that already delivered.
    expect(CODE_ONLY).toMatch(/restricted: !sensitive && isSensitiveCheck\(r\)/);
    expect(CODE_ONLY).toMatch(/restricted_file_count/);
    expect(FRONT_BGV).toMatch(/restricted to HR Manager \/ Admin/);
    expect(FRONT_BGV).toMatch(/No report attached for this check yet/);
  });

  it('⚠⚠ a redacted value is never posted back as data loss', () => {
    // The modal is seeded from the check row, which for a restricted caller
    // carries the placeholder. Saving would overwrite the real finding with
    // "Restricted — visible to HR Manager / Admin only". Silent destruction of
    // the very data the redaction exists to protect.
    expect(FRONT_BGV).toMatch(/const restricted = initial\?\.detail_restricted === true/);
    expect(FRONT_BGV).toMatch(/SENSITIVE_TEXT = \['remarks', 'followup_notes', 'cost_remarks'\]/);
    expect(FRONT_BGV).toMatch(/!\(restricted && SENSITIVE_TEXT\.includes\(k\)\)/);
  });

  it('the hub disables the export the caller cannot use, rather than 403ing them', () => {
    expect(FRONT_HUB).toMatch(/hasPermission\('bgv_sensitive', 'view'\)/);
    expect(FRONT_HUB).toMatch(/const blocked = !canExport \|\| \(sensitive && !canSeeSensitive\)/);
  });
});

describe('3 — an open check blocks closure outright', () => {
  const close = () => handlerBodyOf('post', '/cases/:id/close');

  it('there is no force override anywhere in the module', () => {
    // Removed, not merely unused: a confirm-anyway dialog put a real gap in the
    // record behind a button that read like a warning.
    expect(CODE_ONLY, 'the force escape must be gone from the code').not.toMatch(/\bforce\b/);
    expect(FRONT_BGV, 'and from the UI').not.toMatch(/closeCase\(true\)/);
    expect(FRONT_BGV).not.toMatch(/Close the case anyway/);
  });

  it('an open check is refused with 409, unconditionally', () => {
    const body = close();
    expect(body).toMatch(/if \(open\.length > 0\) \{/);
    expect(body).toMatch(/code: 'OPEN_CHECKS'/);
    expect(body).toMatch(/return res\.status\(409\)/);
    // Nothing in the body may soften it.
    expect(body).not.toMatch(/open\.length > 0 && /);
  });

  it('the refusal NAMES the open checks', () => {
    // "3 checks are still open" sends HR hunting; "Employment Verification (In
    // Progress)" tells them what to finish.
    expect(close()).toMatch(/checks: open/);
    expect(close()).toMatch(/o\.check_type/);
  });

  it('Pending, Initiated and In Progress all count as open', () => {
    expect(close()).toMatch(/status IN \('Pending','Initiated','In Progress'\)/);
  });

  it('a Cancelled check does NOT block closure', () => {
    // Cancelling a check HR has genuinely abandoned is the honest way to close a
    // case, and the reason lands on the check where it belongs.
    expect(close()).not.toMatch(/'Cancelled'/);
  });

  it('closing writes no result — the status/result distinction is untouched', () => {
    expect(close(), 'closing a case must not imply anything about a finding')
      .not.toMatch(/\bresult\s*=/);
  });

  it('the UI tells HR what to finish instead of offering a button that can only fail', () => {
    expect(FRONT_BGV).toMatch(/Complete or cancel each one before closing the case/);
  });
});

describe('4 — BGV evidence is retired, never erased', () => {
  it('nothing in the BGV module can delete a stored file', () => {
    // The strongest form: the capability is ABSENT, not merely unused.
    expect(CODE_ONLY).not.toMatch(/deleteFile/);
    expect(CODE_ONLY).not.toMatch(/\bunlink/);
    expect(CODE_ONLY).not.toMatch(/rmSync|fsp\.rm\b/);
    expect(SECURE, 'the file route must not delete either').not.toMatch(/deleteFile|unlink/);
  });

  it('removing a document is a soft delete, so the file stays JOINED to its check', () => {
    // A hard delete kept the bytes and threw away the only thing that said what
    // they were: an unnamed file in uploads/ that no query could tie back to an
    // employee, a check or an agency.
    const body = handlerBodyOf('delete', '/documents/:id');
    expect(body).toMatch(/UPDATE bgv_documents/);
    expect(body).toMatch(/SET deleted_at = NOW\(\), deleted_by = \$3/);
    expect(body, 'a hard DELETE would lose the metadata').not.toMatch(/DELETE FROM bgv_documents/);
    expect(body).toMatch(/retained: true/);
  });

  it('the retire is idempotent — a second call cannot re-stamp it', () => {
    expect(handlerBodyOf('delete', '/documents/:id')).toMatch(/AND deleted_at IS NULL/);
  });

  it('the migration adds the columns and a partial index on the live rows', () => {
    expect(RETENTION_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
    expect(RETENTION_MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS deleted_by INTEGER/);
    expect(RETENTION_MIGRATION).toMatch(/ON bgv_documents \(check_id\) WHERE deleted_at IS NULL/);
  });

  it('every active view filters retired records out', () => {
    // Otherwise a retired report keeps appearing and "removed" means nothing.
    for (const q of [
      /NOT EXISTS \(SELECT 1 FROM bgv_documents d WHERE d\.check_id = ch\.id AND d\.deleted_at IS NULL\)/,
      /FROM bgv_documents d WHERE d\.check_id = ch\.id AND d\.deleted_at IS NULL\) AS document_count/,
      /LEFT JOIN bgv_documents d ON d\.check_id = ch\.id AND d\.deleted_at IS NULL/,
      /WHERE ch\.case_id = \$1 AND d\.deleted_at IS NULL/,
    ]) {
      expect(CODE_ONLY, `an active-view query is missing its deleted_at filter: ${q}`).toMatch(q);
    }
  });

  it('access to a retired report is UNCHANGED, not widened', () => {
    // Retention that quietly opened access would be worse than deletion. The
    // owner lookup deliberately does NOT filter deleted_at — after retirement the
    // record's job is precisely to keep answering who the file belongs to, under
    // the same company scope and the same grants.
    const lookup = /async function bgvDocumentOwner[\s\S]*?\n\}/.exec(SECURE);
    expect(lookup, 'bgvDocumentOwner not found').toBeTruthy();
    expect(lookup[0], 'a retired report must still resolve to its employee')
      .not.toMatch(/d\.deleted_at IS NULL/);
    expect(lookup[0]).toMatch(/e\.company_id/);
    expect(lookup[0]).toMatch(/e\.deleted_at IS NULL/);
  });

  it('the check-deletion guard counts only LIVE documents', () => {
    // Otherwise a check whose only report was retired stays undeletable forever.
    expect(CODE_ONLY).toMatch(/FROM bgv_documents d WHERE d\.check_id = \$1 AND d\.deleted_at IS NULL\) AS docs/);
  });

  it('the UI does not tell HR the file is gone', () => {
    expect(FRONT_BGV).toMatch(/RETAINED for/);
    expect(FRONT_BGV).toMatch(/the file is retained for audit/);
  });
});
