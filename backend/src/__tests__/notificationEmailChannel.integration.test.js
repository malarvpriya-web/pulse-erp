/**
 * Notification email channel — who it can reach (2026-11-10).
 *
 * dispatchRuleChannels used to find the notification rule by joining
 * users.company_id, which is NULL on most employee logins (their company comes
 * from the linked employee or user_scope). An event with channel 'email' then
 * silently skipped them. It also checked SMTP against the caller's hint, so a
 * caller passing no company skipped everyone, and it put the title and message
 * into the email HTML unescaped.
 *
 * The mailer is mocked: nothing is sent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const mail = vi.hoisted(() => ({ sent: [], configured: new Set() }));
vi.mock('../utils/mailer.js', async (orig) => ({
  ...(await orig()),
  isEmailConfigured: vi.fn(async (cid) => mail.configured.has(cid == null ? null : Number(cid))),
  sendNotificationEmail: vi.fn(async (to, opts) => { mail.sent.push({ to, ...opts }); return { sent: true }; }),
}));

const { default: pool } = await import('../config/db.js');
const { default: repo, recipientCompany, dispatchRuleChannels } = await import('../modules/notifications/repositories/notifications.repository.js');
const { escapeHtml } = await vi.importActual('../utils/mailer.js');

const A = 999909;
const B = 999910;
const MAIL = 'zz.mailchan.';
const EVENT = 'zz.mailchan.event';
const u = {};

async function cleanup() {
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [[A, B]]);
  await pool.query(`DELETE FROM notification_rules WHERE company_id = ANY($1::int[])`, [[A, B]]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [[A, B]]);
}

let seq = 0;
async function login(key, { userCompany = null, employeeCompany = null, scopes = [] } = {}) {
  seq += 1;
  let emp = null;
  if (employeeCompany != null) {
    emp = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date)
       VALUES ($1,$2,'Zz',$3,$4,'Active','Ops','2020-01-01') RETURNING id`,
      [employeeCompany, `EMP977${String(seq).padStart(3, '0')}`, key, `${MAIL}emp.${key}@example.com`])).rows[0].id;
  }
  u[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,'x','employee',true,$3,$4) RETURNING id`,
    [`Zz ${key}`, `${MAIL}${key}@example.com`, userCompany, emp])).rows[0].id;
  for (const [i, c] of scopes.entries())
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,$3)`, [u[key], c, i === 0]);
}

const rule = (cid, channel) => pool.query(
  `INSERT INTO notification_rules (company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
   VALUES ($1,$2,'Zz rule',$3,ARRAY['employee']::text[],true,false)`, [cid, EVENT, channel]);

/** dispatchSideEffects is fire-and-forget: poll (generously) until the mock has seen `n` sends. */
async function sentCount(n) {
  for (let i = 0; i < 200 && mail.sent.length < n; i += 1) await new Promise(r => { setTimeout(r, 25); });
  return mail.sent.length;
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Mail A','ZZMAILA'), ($2,'ZZ Mail B','ZZMAILB')`, [A, B]);
  await login('direct',   { userCompany: A });                          // users.company_id set
  await login('employee', { employeeCompany: A });                      // the common case: users.company_id NULL
  await login('scoped',   { scopes: [A] });                             // only a user_scope row
  await login('multi',    { scopes: [A, B] });                          // two scopes: needs the hint
  await login('nobody');                                                // no company by any link
  await rule(A, 'in_app,email');
  await rule(B, 'in_app');
}, 60_000);

afterAll(async () => { await cleanup(); });
beforeEach(() => { mail.sent.length = 0; mail.configured = new Set([A, B]); });

// Awaited directly, so a "nothing was sent" assertion is not a race.
const send = (key, company_id = null) =>
  dispatchRuleChannels(u[key], EVENT, 'Zz title', 'Zz body', company_id);

describe('recipientCompany', () => {
  it('resolves users.company_id, then the employee, then a hinted scope, then a single scope', async () => {
    expect((await recipientCompany(u.direct)).companyId).toBe(A);
    expect((await recipientCompany(u.employee)).companyId).toBe(A);
    expect((await recipientCompany(u.scoped)).companyId).toBe(A);
    expect((await recipientCompany(u.multi)).companyId).toBeNull();      // ambiguous without a hint
    expect((await recipientCompany(u.multi, B)).companyId).toBe(B);
    expect((await recipientCompany(u.nobody, A)).companyId).toBeNull();  // a hint never invents membership
  });
});

describe('email channel', () => {
  it('reaches an employee login whose users.company_id is NULL (it used to be skipped)', async () => {
    await send('employee');
    expect(mail.sent.map(m => m.to)).toEqual([`${MAIL}employee@example.com`]);
    expect(mail.sent[0].companyId).toBe(A);
  });

  it('dispatchSideEffects (the path every notification takes) wires it, with no company hint', async () => {
    await repo.dispatchSideEffects({
      user_id: u.employee, title: 'Zz title', message: 'Zz body', module_name: 'Zz',
      notification_type: 'x', event_key: EVENT, company_id: null,
    });
    expect(await sentCount(1)).toBe(1);
    expect(mail.sent[0].to).toBe(`${MAIL}employee@example.com`);
  });

  it('reaches direct and scope-only logins, even when the caller passes no company', async () => {
    await send('direct');
    await send('scoped');
    expect(mail.sent.map(m => m.to).sort()).toEqual([`${MAIL}direct@example.com`, `${MAIL}scoped@example.com`]);
  });

  it("follows the recipient's company rule: B is in-app only, so no email", async () => {
    await send('multi', B);
    expect(mail.sent).toEqual([]);
    await send('multi', A);
    expect(mail.sent.map(m => m.companyId)).toEqual([A]);
  });

  it('sends nothing without SMTP for the recipient company, or with no company at all', async () => {
    mail.configured = new Set([B]);
    await send('employee', B);           // hint B, but the person belongs to A, whose SMTP is off
    await send('nobody', A);
    expect(mail.sent).toEqual([]);
  });

  it('escapes title and message in the email HTML', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)> & "q"')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
    const src = readFileSync(resolve(here, '../utils/mailer.js'), 'utf8');
    const fn = src.slice(src.indexOf('export async function sendNotificationEmail'), src.indexOf('export async function sendPayslipEmail'));
    expect(fn).toContain('${escapeHtml(title');
    expect(fn).toContain('${escapeHtml(message');
  });
});
