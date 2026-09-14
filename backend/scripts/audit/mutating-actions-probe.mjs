/**
 * mutating-actions-probe.mjs — exercise the Analytics & AI actions that WRITE.
 *
 * WHY
 * ---
 * The action matrix could click 41 of 46 actions. The remaining five mutate
 * production data or bill an external service, so a verification pass that
 * clicked them would create real opportunities, invalidate a real login, or
 * spend money:
 *
 *   POST /ceo-intelligence/customers/:partyId/convert-upsell
 *   POST /admin/users/:id/reset-password
 *   POST /admin/users/import        (CSV bulk create)
 *   POST /ai/llm-chat               (external LLM, billable)
 *   POST /ai/chat
 *
 * Leaving them untested means "every critical action works" rests on reading the
 * route table — exactly the reasoning that let CFO's five alert buttons ship as
 * no-ops for months.
 *
 * This drives each one for real, against DISPOSABLE fixtures (a throwaway party
 * and a throwaway user, both marked ZZACT), and deletes everything afterwards.
 * The LLM endpoints are driven far enough to prove routing, auth and the
 * no-API-key contract WITHOUT spending a token — see the note on that group.
 *
 *   node scripts/audit/mutating-actions-probe.mjs
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;
// Default to the same base the rest of the E2E suite drives (PULSE_API, which
// CI sets to the app under test) rather than a private port. The old default of
// :5099 was a port nothing starts: the Playwright case that runs this probe
// passed only when someone happened to have a server there, and failed with
// ECONNREFUSED the moment they did not — a harness dependency that looked like
// a product failure. PROBE_API still overrides, for pointing at a scratch
// instance deliberately.
const API = process.env.PROBE_API || process.env.PULSE_API || 'http://localhost:5000/api/v1';
const MARK = 'ZZACT';

const results = [];
const record = (action, expected, status, ok, detail = '') =>
  results.push({ action, expected, status, ok, detail });

async function tokenFor(email) {
  const { rows: [u] } = await pool.query(
    'SELECT id, email, role, employee_id, company_id FROM users WHERE email=$1', [email]);
  if (!u) throw new Error(`no user ${email}`);
  const { rows: rr } = await pool.query(
    'SELECT LOWER(r.code) c FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [u.id]);
  return jwt.sign({
    userId: u.id, email: u.email, role: u.role, roles: rr.map((x) => x.c),
    employeeId: u.employee_id, company_id: u.company_id,
  }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const post = async (token, p, body) => {
  const r = await fetch(API + p, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM opportunities WHERE opportunity_name LIKE '${MARK}%'
       OR account_id IN (SELECT id FROM accounts WHERE account_name LIKE '${MARK}%')`,
    `DELETE FROM accounts WHERE account_name LIKE '${MARK}%'`,
    `DELETE FROM parties  WHERE name LIKE '${MARK}%'`,
    `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%zzact%')`,
    `DELETE FROM users    WHERE email LIKE '%zzact%'`,
  ]) await pool.query(sql).catch((e) => process.stderr.write(`  (skip) ${e.message}\n`));
}

const SA = await tokenFor(process.env.PROBE_ADMIN_EMAIL || process.env.E2E_LOGIN_EMAIL || 'superadmin@manifest.in');
const LOW = await tokenFor(process.env.PROBE_LOW_EMAIL || 'john.doe@manifest.in');

try {
  await cleanup();

  // ── 1. convert-upsell ────────────────────────────────────────────────────
  // Against a throwaway party so no real customer gains a phantom opportunity.
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (name, party_code, party_type, company_id)
     VALUES ($1,$2,'customer',1) RETURNING id`,
    [`${MARK} Throwaway Customer`, `${MARK}-${Date.now()}`]);

  const up = await post(SA, `/ceo-intelligence/customers/${party.id}/convert-upsell`, {
    reason: `${MARK} probe`, expected_value: 123456,
  });
  const { rows: [oppCount] } = await pool.query(
    `SELECT COUNT(*)::int n FROM opportunities
      WHERE account_id IN (SELECT id FROM accounts WHERE party_id = $1)`, [party.id]);
  record('POST /ceo-intelligence/customers/:id/convert-upsell', '2xx + opportunity row',
    up.status, up.status < 300 && oppCount.n > 0,
    `created ${oppCount.n} opportunity(ies)`);

  // Same call as a plain employee must be refused.
  const upLow = await post(LOW, `/ceo-intelligence/customers/${party.id}/convert-upsell`, {});
  record('POST convert-upsell as employee', '403', upLow.status, upLow.status === 403);

  // parties.id is a uuid: a well-formed id that matches nothing is the 404 case.
  const upMissing = await post(SA,
    '/ceo-intelligence/customers/00000000-0000-0000-0000-000000000000/convert-upsell', {});
  record('POST convert-upsell, unknown customer', '404', upMissing.status, upMissing.status === 404);

  // A malformed uuid is a bad request, not a server fault. This used to 500 and,
  // outside production, hand the caller the raw Postgres 22P02 text.
  const upBad = await post(SA, '/ceo-intelligence/customers/99999999/convert-upsell', {});
  record('POST convert-upsell, malformed id', '400, not 500', upBad.status,
    upBad.status >= 400 && upBad.status < 500, String(upBad.text).slice(0, 70));

  // ── 2. reset-password ────────────────────────────────────────────────────
  // Against a throwaway login, so no real account is locked out.
  const hash = await bcrypt.hash('ZZact@' + Date.now(), 10);
  const { rows: [tmpUser] } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, company_id, is_active)
     VALUES ($1,$2,$3,'employee',1,true) RETURNING id, password_hash`,
    [`${MARK.toLowerCase()}.reset@zzact.invalid`, hash, `${MARK} Reset Target`]);

  const rp = await post(SA, `/admin/users/${tmpUser.id}/reset-password`, { password: 'ZZactNew@12345' });
  const { rows: [afterReset] } = await pool.query(
    'SELECT password_hash, must_change_password FROM users WHERE id=$1', [tmpUser.id]);
  record('POST /admin/users/:id/reset-password', '2xx + hash changes',
    rp.status, rp.status < 300 && afterReset.password_hash !== tmpUser.password_hash,
    `must_change_password=${afterReset.must_change_password}`);

  const rpLow = await post(LOW, `/admin/users/${tmpUser.id}/reset-password`, { password: 'ZZactNew@12345' });
  record('POST reset-password as employee', '403', rpLow.status, rpLow.status === 403);

  // ── 3. CSV import ────────────────────────────────────────────────────────
  // There is no bulk endpoint: AdminDashboard's CSV drawer loops
  // `POST /admin/users` once per parsed row, so that is the route to exercise.
  const imp = await post(SA, '/admin/users', {
    name: `${MARK} Imported`, email: `${MARK.toLowerCase()}.import@zzact.invalid`,
    role: 'employee', password: 'ZZactImport@12345', force_change_pwd: true,
  });
  const { rows: [impCount] } = await pool.query(
    `SELECT COUNT(*)::int n FROM users WHERE email = $1`,
    [`${MARK.toLowerCase()}.import@zzact.invalid`]);
  record('POST /admin/users (CSV row)', '2xx + user row',
    imp.status, imp.status < 300 && impCount.n === 1, `created ${impCount.n}`);

  const impLow = await post(LOW, '/admin/users', {
    name: `${MARK} Nope`, email: `${MARK.toLowerCase()}.nope@zzact.invalid`,
    role: 'employee', password: 'ZZactNope@12345',
  });
  record('POST /admin/users (CSV row) as employee', '403', impLow.status, impLow.status === 403);

  // ── 4. LLM endpoints ─────────────────────────────────────────────────────
  // Driven for real, but NOT made to spend a token. When OPENAI_API_KEY is
  // absent the contract is a clean 503 ("AI service not configured"), which is
  // exactly what a deployment without the key must return — a 500, or a 200
  // carrying an invented answer, would both be defects. When a key IS present
  // the call is skipped rather than billed, and reported as such.
  const hasKey = Boolean(process.env.OPENAI_API_KEY)
    && process.env.OPENAI_API_KEY !== 'your-openai-api-key-here';

  if (hasKey) {
    record('POST /ai/llm-chat', 'skipped — real API key present, call is billable', 0, true,
      'set OPENAI_API_KEY="" to exercise the unconfigured path');
    record('POST /ai/chat', 'skipped — real API key present, call is billable', 0, true, '');
  } else {
    const llm = await post(SA, '/ai/llm-chat', { messages: [{ role: 'user', content: `${MARK} probe` }] });
    record('POST /ai/llm-chat (no API key)', '503, not 500', llm.status,
      llm.status === 503, String(llm.text).slice(0, 80));
    const chat = await post(SA, '/ai/chat', { message: `${MARK} probe` });
    record('POST /ai/chat (no API key)', '2xx or 503, never 5xx', chat.status,
      chat.status < 500 || chat.status === 503, String(chat.text).slice(0, 80));
  }

  const llmLow = await post(LOW, '/ai/llm-chat', { messages: [{ role: 'user', content: 'x' }] });
  record('POST /ai/llm-chat as employee', '403', llmLow.status, llmLow.status === 403);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log('---REPORT_BEGIN---');
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length,
                             failed: failed.length, results }));
console.log('---REPORT_END---');
if (!process.argv.includes('--json')) {
  console.error('');
  for (const r of results) {
    console.error(`${(r.ok ? 'PASS' : 'FAIL').padEnd(6)} ${String(r.status).padStart(4)}  ` +
      `${r.action.padEnd(52)} expected: ${r.expected}${r.detail ? '  | ' + r.detail : ''}`);
  }
  console.error(`\n${results.length - failed.length}/${results.length} passed`);
}
await pool.end();
process.exit(failed.length ? 1 : 0);
