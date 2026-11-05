// FINAL AUDIT DRIVE — the 11 evidence items, over real HTTP against :5000.
//
// ⚠ OWNERSHIP REGISTER, not inference. Every row this script creates is recorded
// by id at create time; teardown deletes children-first from that register and
// nothing else. Fixture employees are chosen by `case_id === null` — never by a
// business status.
//
// Run it with the backend up:   node scripts/bgv-audit-drive.mjs
//
// It is NOT part of `npm test`: it drives a RUNNING server and writes real rows,
// so it is a deliberate act, not something a CI run does by accident. The
// permanent regression coverage for the same rules lives in
// src/__tests__/bgvSafety.contract.test.js, bgvIntegration.integration.test.js
// and tests/bgv.spec.ts.
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });

const BASE = (process.env.AUDIT_BASE || 'http://localhost:5000') + '/api';
const UPLOADS = path.join(BACKEND, 'uploads');
const tok = (o) => jwt.sign({ company_id: 1, ...o }, process.env.JWT_SECRET, { expiresIn: '1h' });
const HR_MGR = tok({ userId: 883, role: 'hr', email: 'hr@manifest.in' });

let fails = 0, pass = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fails++; console.log('  FAIL ' + n + '  >> ' + x); } };
const head = (t) => console.log('\n=== ' + t + ' ===');

async function call(method, p, opts = {}) {
  const { token = HR_MGR, body } = opts;
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : await res.text() };
}

const db = new pg.Client({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
await db.connect();

const owned = { agencies: [], cases: [], checks: [], documents: [], contacts: [], files: [] };
const own = (k, v) => { if (v != null && !owned[k].includes(v)) owned[k].push(v); };
const registerCase = async (caseId) => {
  own('cases', caseId);
  for (const c of (await db.query('SELECT id FROM bgv_checks WHERE case_id=$1', [caseId])).rows) {
    own('checks', c.id);
    for (const d of (await db.query('SELECT id, file_url FROM bgv_documents WHERE check_id=$1', [c.id])).rows) {
      own('documents', d.id); own('files', d.file_url);
    }
    for (const t of (await db.query('SELECT id FROM bgv_check_contacts WHERE check_id=$1', [c.id])).rows) own('contacts', t.id);
  }
};

// REAL data, recorded before anything is created — the survival baseline.
const realCases = (await db.query('SELECT id FROM bgv_cases ORDER BY id')).rows.map(r => r.id);
const realAgencies = (await db.query('SELECT id FROM bgv_agencies ORDER BY id')).rows.map(r => r.id);
const realChecks = (await db.query('SELECT id FROM bgv_checks ORDER BY id')).rows.map(r => r.id);
console.log('REAL baseline — cases ' + JSON.stringify(realCases) + ' agencies ' + JSON.stringify(realAgencies) + ' checks ' + JSON.stringify(realChecks));

const listed = (await call('GET', '/bgv/cases?has_checks=false&current_only=true')).data;
const freeEmps = (Array.isArray(listed) ? listed : []).filter(r => r.case_id === null).map(r => r.employee_id);
if (freeEmps.length < 3) { console.log('need 3 employees with NO case; have ' + freeEmps.length); process.exit(1); }
const [E_FRESH, E_EXP, E_DUP] = freeEmps;
console.log('fixture employees (case_id === null): ' + [E_FRESH, E_EXP, E_DUP].join(', '));

try {

const profiles = (await call('GET', '/bgv/profiles')).data;
const byKey = Object.fromEntries(profiles.profiles.map(p => [p.key, p]));
const sel = (p) => p.checks.filter(c => c.selected).map(c => ({ check_type: c.check_type, applicability: c.applicability }));

// ── 1 ────────────────────────────────────────────────────────────────────────
head('1. Fresher checklist creation');
let r = await call('POST', '/bgv/employees/' + E_FRESH + '/start', { body: { profile: 'fresher', checks: sel(byKey.fresher) } });
check('created in ONE action', r.status === 201, r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
await registerCase(r.data.case.id);
let F = (await call('GET', '/bgv/employees/' + E_FRESH)).data;
check('6 checks created from the profile', F.checks.length === 6, String(F.checks.length));
check('Employment Verification recorded as Not Applicable',
  F.checks.find(c => c.check_type === 'Employment Verification')?.applicability === 'Not Applicable', '');
check('HR can change it to Required', (await call('PATCH', '/bgv/checks/' +
  F.checks.find(c => c.check_type === 'Employment Verification').id, { body: { applicability: 'Required' } })).data.applicability === 'Required', '');
await call('PATCH', '/bgv/checks/' + F.checks.find(c => c.check_type === 'Employment Verification').id, { body: { applicability: 'Not Applicable' } });

// ── 2 ────────────────────────────────────────────────────────────────────────
head('2. Experienced checklist creation');
r = await call('POST', '/bgv/employees/' + E_EXP + '/start', { body: { profile: 'experienced', checks: sel(byKey.experienced) } });
check('created in ONE action', r.status === 201, r.status + '');
await registerCase(r.data.case.id);
const X = (await call('GET', '/bgv/employees/' + E_EXP)).data;
check('Employment Verification included and Required',
  X.checks.find(c => c.check_type === 'Employment Verification')?.applicability === 'Required', '');

// ── 3 ────────────────────────────────────────────────────────────────────────
head('3. Optional and Not Applicable closure rules');
F = (await call('GET', '/bgv/employees/' + E_FRESH)).data;
check('open_required and open_optional are reported separately',
  F.open_required !== undefined && F.open_optional !== undefined,
  JSON.stringify({ req: F.open_required, opt: F.open_optional }));
check('Not Applicable is not counted as outstanding',
  Number(F.checks_pending) === Number(F.applicable_total), F.checks_pending + ' vs ' + F.applicable_total);
// Resolve the REQUIRED ones only, leaving the Optional one open.
for (const c of F.checks.filter(c => c.applicability === 'Required')) {
  await call('PATCH', '/bgv/checks/' + c.id, { body: { status: 'Completed', result: 'Clear' } });
}
F = (await call('GET', '/bgv/employees/' + E_FRESH)).data;
check('an OPTIONAL check is still open', Number(F.open_optional) === 1, String(F.open_optional));
r = await call('POST', '/bgv/cases/' + F.case_id + '/close', { body: { closure_remarks: 'required done' } });
check('⚠ an open OPTIONAL check does NOT block closure', r.status === 200 && !!r.data.closed_at,
  r.status + ' ' + JSON.stringify(r.data?.code));
await call('POST', '/bgv/cases/' + F.case_id + '/reopen', { body: { reason: 'continue the audit drive' } });

head('3b. Controlled skip of an optional check, with a reason + audit');
F = (await call('GET', '/bgv/employees/' + E_FRESH)).data;
const opt = F.checks.find(c => c.applicability === 'Optional' && !['Completed', 'Cancelled'].includes(c.status));
r = await call('POST', '/bgv/checks/' + opt.id + '/skip', { body: {} });
check('skip with no reason is refused', r.status === 400 && r.data?.code === 'SKIP_REASON_REQUIRED', r.status + '');
r = await call('POST', '/bgv/checks/' + opt.id + '/skip', { body: { reason: 'not required for this grade of hire' } });
check('skip with a reason succeeds', r.status === 200 && r.data.status === 'Cancelled', r.status + '');
check('the reason is stored on the check', r.data.skip_reason === 'not required for this grade of hire', String(r.data.skip_reason));
check('skipped_at / skipped_by recorded', !!r.data.skipped_at && !!r.data.skipped_by, '');
let a = (await db.query(`SELECT action_type, new_data_json->>'skip_reason' AS reason FROM audit_logs
  WHERE module_name='bgv' AND reference_type='bgv_check' AND reference_id=$1 ORDER BY created_at DESC LIMIT 1`,
  [String(opt.id)])).rows[0];
check('the skip is audited with its reason', a?.action_type === 'skip' && a?.reason?.includes('not required'), JSON.stringify(a));
const req1 = F.checks.find(c => c.applicability === 'Required');
r = await call('POST', '/bgv/checks/' + req1.id + '/skip', { body: { reason: 'trying to bypass the guard' } });
check('⚠ a REQUIRED check cannot be skipped (409)', r.status === 409 && r.data?.code === 'CANNOT_SKIP_REQUIRED', r.status + '');

// ── 4 ────────────────────────────────────────────────────────────────────────
head('4. Required unresolved checks block closure');
r = await call('POST', '/bgv/cases/' + X.case_id + '/close', { body: {} });
check('refused with 409 OPEN_CHECKS', r.status === 409 && r.data?.code === 'OPEN_CHECKS', r.status + '');
check('only REQUIRED checks are named as blockers',
  (r.data?.checks || []).every(c => c.applicability === 'Required'), JSON.stringify(r.data?.checks?.map(c => c.applicability)));
r = await call('POST', '/bgv/cases/' + X.case_id + '/close', { body: { force: true } });
check('force:true is ignored', r.status === 409, r.status + '');

// ── 5 ────────────────────────────────────────────────────────────────────────
head('5. Discrepancy is never Clear');
const dchk = X.checks.find(c => c.applicability === 'Required');
r = await call('PATCH', '/bgv/checks/' + dchk.id, { body: { status: 'Completed' } });
check('Completed with result still Pending is refused', r.status === 400 && r.data?.code === 'STATUS_NEEDS_RESULT', r.status + '');
r = await call('PATCH', '/bgv/checks/' + dchk.id, { body: { status: 'Completed', result: 'Discrepancy', remarks: 'dates mismatch' } });
check('Completed + Discrepancy is stored as such', r.data.status === 'Completed' && r.data.result === 'Discrepancy', '');
let XD = (await call('GET', '/bgv/employees/' + E_EXP)).data;
check('the case reads Discrepancy, NOT Completed', XD.bgv_status === 'Discrepancy', XD.bgv_status);
check('it is not counted as Clear', Number(XD.checks_clear) === 0, String(XD.checks_clear));
check('required_discrepancies reports it', Number(XD.required_discrepancies) === 1, String(XD.required_discrepancies));

// ── 6 ────────────────────────────────────────────────────────────────────────
head('6. Authorized and unauthorized reopening + tenant isolation');
const role = (await db.query("SELECT id FROM roles WHERE code='hr_exec' LIMIT 1")).rows[0];
const u = (await db.query(`INSERT INTO users (name, email, role, is_active, company_id)
  VALUES ('ZZBGV6 HR Exec','zzbgv6.hrexec@manifest.in','hr_exec',true,1)
  ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING id`)).rows[0];
await db.query('INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING', [u.id, role.id]);
const HR_EXEC = tok({ userId: u.id, role: 'hr_exec', email: 'zzbgv6.hrexec@manifest.in' });
const FOREIGN = tok({ userId: 883, role: 'hr', email: 'hr@manifest.in', company_id: 565 });

F = (await call('GET', '/bgv/employees/' + E_FRESH)).data;
await call('POST', '/bgv/cases/' + F.case_id + '/close', { body: { closure_remarks: 'for the reopen test' } });
r = await call('POST', '/bgv/cases/' + F.case_id + '/reopen', { body: {} });
check('missing reason refused', r.status === 400 && r.data?.code === 'REOPEN_REASON_REQUIRED', r.status + '');
r = await call('POST', '/bgv/cases/' + F.case_id + '/reopen', { token: HR_EXEC, body: { reason: 'a perfectly good reason' } });
check('⚠ hr_exec refused BY THE BACKEND (403)', r.status === 403 && r.data?.code === 'BGV_SENSITIVE_REQUIRED', r.status + '');
r = await call('POST', '/bgv/cases/' + F.case_id + '/reopen', { token: FOREIGN, body: { reason: 'cross tenant attempt' } });
check('⚠ another TENANT cannot reopen it (404)', r.status === 404, r.status + '');
r = await call('POST', '/bgv/cases/' + F.case_id + '/reopen', { body: { reason: 'authorised reopen for the audit' } });
check('HR Manager with a reason can reopen', r.status === 200, r.status + '');
// ⚠ logAudit() is deliberately fire-and-forget, so the row can land AFTER the
// HTTP response. Polling for the SPECIFIC reason beats taking "the latest" —
// the first version of this read an earlier reopen's row and failed on correct
// behaviour.
a = null;
for (let i = 0; i < 20 && !a; i++) {
  a = (await db.query(`SELECT user_id, created_at, new_data_json->>'reopen_reason' AS reason FROM audit_logs
    WHERE module_name='bgv' AND reference_type='bgv_case' AND action_type='reopen'
      AND reference_id=$1 AND new_data_json->>'reopen_reason' = $2
    ORDER BY created_at DESC LIMIT 1`, [String(F.case_id), 'authorised reopen for the audit'])).rows[0] || null;
  if (!a) await new Promise(r => setTimeout(r, 100));
}
check('audit has actor, timestamp AND reason',
  a?.user_id === 883 && !!a?.created_at && a?.reason === 'authorised reopen for the audit', JSON.stringify(a));

// ── 7 ────────────────────────────────────────────────────────────────────────
head('7. Duplicate prevention and legitimate re-verification');
r = await call('POST', '/bgv/employees/' + E_DUP + '/start', { body: { profile: 'custom', checks: [{ check_type: 'Identity Verification', applicability: 'Required' }] } });
await registerCase(r.data.case.id);
const D = (await call('GET', '/bgv/employees/' + E_DUP)).data;
const dup = D.checks[0];
r = await call('POST', '/bgv/cases/' + D.case_id + '/checks', { body: { check_type: 'Identity Verification' } });
check('⚠ a 2nd ACTIVE check of the same type is refused (409)',
  r.status === 409 && r.data?.code === 'DUPLICATE_ACTIVE_CHECK', r.status + ' ' + JSON.stringify(r.data?.code));
r = await call('POST', '/bgv/cases/' + D.case_id + '/checks', { body: { check_type: ' identity VERIFICATION ' } });
check('...and a case/whitespace variant is refused too', r.status === 409, r.status + '');
// CONCURRENCY: ten simultaneous creates of the same type.
const burst = await Promise.all(Array.from({ length: 10 }, () =>
  call('POST', '/bgv/cases/' + D.case_id + '/checks', { body: { check_type: 'Address Verification' } })));
const created = burst.filter(b => b.status === 201);
check('⚠⚠ 10 CONCURRENT identical creates produced exactly ONE check',
  created.length === 1, 'created=' + created.length + ' statuses=' + JSON.stringify(burst.map(b => b.status)));
for (const c of created) own('checks', c.data.id);
r = await call('POST', '/bgv/checks/' + dup.id + '/reverify', { body: { reason: 'client asked for a second look' } });
check('re-verify is REFUSED while the previous is open (409)',
  r.status === 409 && r.data?.code === 'PREVIOUS_STILL_OPEN', r.status + ' ' + JSON.stringify(r.data?.code));
await call('PATCH', '/bgv/checks/' + dup.id, { body: { status: 'Completed', result: 'Discrepancy', remarks: 'first attempt found a mismatch' } });
r = await call('POST', '/bgv/checks/' + dup.id + '/reverify', { body: {} });
check('re-verify with no reason is refused', r.status === 400 && r.data?.code === 'REVERIFY_REASON_REQUIRED', r.status + '');
r = await call('POST', '/bgv/checks/' + dup.id + '/reverify', { body: { reason: 'client asked for a second look' } });
check('⚠ re-verify SUCCEEDS once the previous is resolved', r.status === 201, r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
const newCheck = r.data?.check;
if (newCheck) own('checks', newCheck.id);
check('the new check supersedes the old one', newCheck?.supersedes_check_id === dup.id, String(newCheck?.supersedes_check_id));
check('the new check starts Pending/Pending', newCheck?.status === 'Pending' && newCheck?.result === 'Pending', '');
const old = (await db.query('SELECT status, result, remarks FROM bgv_checks WHERE id=$1', [dup.id])).rows[0];
check('⚠ the PREVIOUS result and remarks are untouched',
  old.status === 'Completed' && old.result === 'Discrepancy' && old.remarks === 'first attempt found a mismatch',
  JSON.stringify(old));
check('the new check carries NO cost from the old one', newCheck?.amount === null && newCheck?.total_amount === null, '');

// ── 10 + 11 ─────────────────────────────────────────────────────────────────
head('10. Tenant isolation and sensitive report access');
r = await call('GET', '/bgv/employees/' + E_EXP, { token: FOREIGN });
check('foreign tenant cannot read a case (404)', r.status === 404, r.status + '');
r = await call('PATCH', '/bgv/checks/' + dchk.id, { token: FOREIGN, body: { remarks: 'tampered' } });
check('foreign tenant cannot edit a check (404)', r.status === 404, r.status + '');
r = await call('POST', '/bgv/checks/' + dchk.id + '/skip', { token: FOREIGN, body: { reason: 'cross tenant skip' } });
check('foreign tenant cannot skip a check (404)', r.status === 404, r.status + '');
r = await call('POST', '/bgv/checks/' + dchk.id + '/reverify', { token: FOREIGN, body: { reason: 'cross tenant reverify' } });
check('foreign tenant cannot re-verify a check (404)', r.status === 404, r.status + '');

head('11. Document upload, view, download and soft deletion');
const pdf = Buffer.from(['%PDF-1.4', '1 0 obj<</Type/Catalog>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n'));
const clearChk = X.checks.find(c => c.applicability === 'Optional') || X.checks[1];
await call('PATCH', '/bgv/checks/' + clearChk.id, { body: { status: 'Completed', result: 'Clear' } });
const fd = new FormData();
fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'ZZAUDIT_Clear.pdf');
let res = await fetch(BASE + '/bgv/checks/' + clearChk.id + '/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + HR_MGR }, body: fd });
const doc = await res.json();
check('upload succeeds', res.status === 201, String(res.status));
own('documents', doc.id); own('files', doc.file_url);
const fname = path.basename(String(doc.file_url));
const getFile = async (fn, t) => (await fetch(BASE + '/files/' + encodeURIComponent(fn), { headers: { Authorization: 'Bearer ' + t } })).status;
check('HR Manager can download it', await getFile(fname, HR_MGR) === 200, '');
check('hr_exec can download a CLEAR check report', await getFile(fname, HR_EXEC) === 200, String(await getFile(fname, HR_EXEC)));
const headSt = (await fetch(BASE + '/files/' + encodeURIComponent(fname), { method: 'HEAD', headers: { Authorization: 'Bearer ' + HR_MGR } })).status;
check('HEAD agrees with GET', headSt === 200, String(headSt));
// A report on the DISCREPANCY check: restricted.
const fd2 = new FormData();
fd2.append('file', new Blob([pdf], { type: 'application/pdf' }), 'ZZAUDIT_Disc.pdf');
res = await fetch(BASE + '/bgv/checks/' + dchk.id + '/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + HR_MGR }, body: fd2 });
const dDoc = await res.json();
own('documents', dDoc.id); own('files', dDoc.file_url);
const dName = path.basename(String(dDoc.file_url));
check('⚠ hr_exec is REFUSED a DISCREPANCY report (403)', await getFile(dName, HR_EXEC) === 403, String(await getFile(dName, HR_EXEC)));
const dHead = (await fetch(BASE + '/files/' + encodeURIComponent(dName), { method: 'HEAD', headers: { Authorization: 'Bearer ' + HR_EXEC } })).status;
check('...and HEAD refuses it too', dHead === 403, String(dHead));
r = await call('GET', '/bgv/reports/discrepancy', { token: HR_EXEC });
check('hr_exec cannot export the Discrepancy Report (403)', r.status === 403, r.status + '');
// Redaction cannot be written back.
const seen = (await call('GET', '/bgv/employees/' + E_EXP, { token: HR_EXEC })).data.checks.find(c => c.id === dchk.id);
check('hr_exec sees the result but not the findings',
  seen.result === 'Discrepancy' && seen.remarks !== 'dates mismatch' && seen.detail_restricted === true,
  JSON.stringify({ result: seen.result, remarks: seen.remarks }));
r = await call('PATCH', '/bgv/checks/' + dchk.id, { token: HR_EXEC, body: { remarks: seen.remarks } });
check('⚠⚠ writing the REDACTED value back is REFUSED by the backend (403)',
  r.status === 403 && r.data?.code === 'BGV_SENSITIVE_REQUIRED', r.status + ' ' + JSON.stringify(r.data?.code));
const after = (await db.query('SELECT remarks FROM bgv_checks WHERE id=$1', [dchk.id])).rows[0];
check('⚠⚠ ...and the real finding is intact', after.remarks === 'dates mismatch', JSON.stringify(after));
// The rest of the check is still editable by that role.
r = await call('PATCH', '/bgv/checks/' + dchk.id, { token: HR_EXEC, body: { expected_date: '2026-11-30' } });
check('hr_exec can still edit the NON-sensitive fields', r.status === 200, r.status + ' ' + JSON.stringify(r.data?.code));
// Soft deletion preserves the file.
const onDisk = path.join(UPLOADS, fname);
check('the evidence file is on disk', fs.existsSync(onDisk), fname);
r = await call('DELETE', '/bgv/documents/' + doc.id);
check('document removal reports retention', r.status === 200 && r.data?.retained === true, JSON.stringify(r.data));
check('⚠ the evidence FILE is still on disk', fs.existsSync(onDisk), 'FILE WAS DELETED');
const soft = (await db.query('SELECT deleted_at, file_url FROM bgv_documents WHERE id=$1', [doc.id])).rows[0];
check('the ROW survives, soft-deleted, with its file_url', !!soft?.deleted_at && !!soft?.file_url, JSON.stringify(soft));
check('it is gone from the active view',
  !((await call('GET', '/bgv/employees/' + E_EXP)).data.documents || []).some(d => d.id === doc.id), '');
check('⚠ but still downloadable under the same grants', await getFile(fname, HR_MGR) === 200, '');

// ── 9 ───────────────────────────────────────────────────────────────────────
head('9. Cleanup is restricted to fixture-owned ids');
console.log('  register: ' + JSON.stringify({ cases: owned.cases.length, checks: owned.checks.length, documents: owned.documents.length, agencies: owned.agencies.length }));
check('no REAL case id is in the register', !realCases.some(id => owned.cases.includes(id)),
  'real=' + JSON.stringify(realCases) + ' owned=' + JSON.stringify(owned.cases));
check('no REAL check id is in the register', !realChecks.some(id => owned.checks.includes(id)), '');
check('no REAL agency id is in the register', !realAgencies.some(id => owned.agencies.includes(id)), '');

} finally {
  head('teardown — children first, from the register only');
  for (const u of owned.files) {
    const f = path.join(UPLOADS, path.basename(String(u)));
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('  removed file ' + path.basename(f)); } } catch {}
  }
  if (owned.contacts.length)  await db.query('DELETE FROM bgv_check_contacts WHERE id = ANY($1::int[])', [owned.contacts]);
  if (owned.documents.length) await db.query('DELETE FROM bgv_documents      WHERE id = ANY($1::int[])', [owned.documents]);
  if (owned.checks.length)    await db.query('DELETE FROM bgv_checks         WHERE id = ANY($1::int[])', [owned.checks]);
  if (owned.cases.length)     await db.query('DELETE FROM bgv_cases          WHERE id = ANY($1::int[])', [owned.cases]);
  if (owned.agencies.length)  await db.query('DELETE FROM bgv_agencies       WHERE id = ANY($1::int[])', [owned.agencies]);
  await db.query(`DELETE FROM users WHERE email = 'zzbgv6.hrexec@manifest.in'`);

  head('8. Case 49 and every real record survived');
  const afterCases = (await db.query('SELECT id FROM bgv_cases ORDER BY id')).rows.map(r => r.id);
  const afterAg = (await db.query('SELECT id FROM bgv_agencies ORDER BY id')).rows.map(r => r.id);
  const afterCk = (await db.query('SELECT id FROM bgv_checks ORDER BY id')).rows.map(r => r.id);
  check('every real CASE survived', realCases.every(id => afterCases.includes(id)), 'before=' + JSON.stringify(realCases) + ' after=' + JSON.stringify(afterCases));
  check('case 49 specifically survived', afterCases.includes(49), JSON.stringify(afterCases));
  check('every real AGENCY survived', realAgencies.every(id => afterAg.includes(id)), JSON.stringify(afterAg));
  check('every real CHECK survived', realChecks.every(id => afterCk.includes(id)), JSON.stringify(afterCk));
  check('no fixture row was left behind',
    !owned.cases.some(id => afterCases.includes(id)) && !owned.agencies.some(id => afterAg.includes(id)),
    'cases=' + JSON.stringify(afterCases) + ' agencies=' + JSON.stringify(afterAg));
  console.log('  final: cases ' + JSON.stringify(afterCases) + ' agencies ' + JSON.stringify(afterAg) + ' checks ' + JSON.stringify(afterCk));
  await db.end();
  console.log('\n' + pass + ' passed / ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
}
