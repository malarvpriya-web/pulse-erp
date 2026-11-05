/**
 * Notification list + unread count: recipient and tenant isolation, against the
 * live database and the real routes.
 *
 * The defect: findByUser() and getUnreadCount() filtered on users.company_id.
 * Company 1's HR logins carry users.company_id NULL — their company comes from
 * user_scope and their linked employee — so the bell and the badge showed them
 * 0 of the notifications they had actually been sent (21 / 21 / 16 on live
 * data), probation reminders included.
 *
 * Now a caller sees exactly their own rows (n.user_id), and with a company
 * context only when they belong to that company by users.company_id, their
 * employee's company or a user_scope row. A company-less caller still sees
 * only their own rows — never a wider set.
 *
 * Fixtures live in two registry tenants (testTenantIds.contract.test.js) and
 * are deleted in afterAll. ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: jwt } = await import('jsonwebtoken');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { default: notificationsRouter } = await import('../modules/notifications/routes/notifications.routes.js');
const { runProbationCheck } = await import('../jobs/probation.cron.js');

const A = 999963;
const B = 999964;
const PW = 'Zz-Notif-Test-9!';
const fx = { tok: {}, user: {}, emp: {}, notif: {} };

const app = express();
app.use(express.json());
app.use('/api/notifications', verifyToken, notificationsRouter);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const list = async (who) => {
  const res = await request(app).get('/api/notifications?limit=100').set(as(who));
  expect(res.status).toBe(200);
  return res.body;
};
const unread = async (who) => {
  const res = await request(app).get('/api/notifications/unread-count').set(as(who));
  expect(res.status).toBe(200);
  return res.body.count;
};

async function cleanup() {
  const c = [A, B];
  const emps = `SELECT id FROM employees WHERE company_id = ANY($1::int[])`;
  const users = `SELECT id FROM users WHERE email LIKE 'zz.nvis.%@example.com'`;
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM probation_reminder_log WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.nvis.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE id IN (${emps})`, [c]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
async function emp(key, cid, extra = {}) {
  seq += 1;
  const dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  const desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, probation_end_date)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,'2026-01-15',$8) RETURNING id`,
    [cid, `EMP963${String(seq).padStart(3, '0')}`, key, `zz.nvis.emp.${key}@example.com`, dept, desig,
      extra.status ?? 'Active', extra.end ?? null])).rows[0].id;
  return fx.emp[key];
}
/**
 * A login. `usersCompany` is users.company_id; `scope` adds a user_scope row;
 * `employee` links an employee record.
 */
async function login(key, role, { usersCompany = null, scope = null, employee = null } = {}) {
  const email = `zz.nvis.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`, [`Zz ${key}`, email, hash, role, usersCompany, employee])).rows[0].id;
  if (scope != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], scope]);
  await syncPrimaryRole(fx.user[key], role, usersCompany ?? scope);
  fx.tok[key] = (await loginUser(email, PW)).token;
}
/** One read + one unread notification addressed to `key`. */
async function seedFor(key) {
  const ids = [];
  for (const read of [true, false]) {
    ids.push((await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, notification_type, is_read)
       VALUES ($1, $2, 'fixture', 'zz-test', 'info', $3) RETURNING id`,
      [fx.user[key], `zz ${key} ${read ? 'read' : 'unread'}`, read])).rows[0].id);
  }
  fx.notif[key] = ids;
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ NVis A','ZZNVA'), ($2,'ZZ NVis B','ZZNVB')`, [A, B]);

  // The live defect's shape: users.company_id NULL, company via user_scope + employee.
  await login('hrNull', 'hr', { scope: A, employee: await emp('hrNull', A) });
  // A normal login with users.company_id populated.
  await login('normal', 'employee', { usersCompany: A, scope: A, employee: await emp('normal', A) });
  // Linked to a company-A employee but with no scope row: verifyToken gives no company context.
  await login('noScope', 'employee', { employee: await emp('noScope', A) });
  // No company by any route at all.
  await login('noCompany', 'employee');
  // Another company.
  await login('bUser', 'employee', { usersCompany: B, scope: B, employee: await emp('bUser', B) });
  await login('bHrNull', 'hr', { scope: B, employee: await emp('bHrNull', B) });

  for (const k of ['hrNull', 'normal', 'noScope', 'noCompany', 'bUser', 'bHrNull']) await seedFor(k);
}, 60000);

afterAll(cleanup);

describe('a login with users.company_id NULL', () => {
  it('sees its own notifications and the matching unread count (was 0 and 0)', async () => {
    const rows = await list('hrNull');
    expect(rows.map((n) => n.id).sort()).toEqual([...fx.notif.hrNull].sort());
    expect(await unread('hrNull')).toBe(1);
  });

  it('membership through the linked employee alone is enough', async () => {
    // users.company_id NULL and no user_scope row left — the server-signed
    // token still carries company A (minted while the scope row existed), and
    // the login's employee belongs to A. That employee link is the same rule
    // the reminder jobs use to choose recipients, so it must also let the
    // recipient read what they were sent.
    await login('empOnly', 'hr', { scope: A, employee: await emp('empOnly', A) });
    await pool.query(`DELETE FROM user_scope WHERE user_id = $1`, [fx.user.empOnly]);
    await seedFor('empOnly');
    expect((await list('empOnly')).map((n) => n.id).sort()).toEqual([...fx.notif.empOnly].sort());
    expect(await unread('empOnly')).toBe(1);
  });

  it('the same holds in another company', async () => {
    expect((await list('bHrNull')).map((n) => n.id).sort()).toEqual([...fx.notif.bHrNull].sort());
    expect(await unread('bHrNull')).toBe(1);
  });
});

describe('a login with users.company_id populated', () => {
  it('is unchanged: its own rows and count', async () => {
    expect((await list('normal')).map((n) => n.id).sort()).toEqual([...fx.notif.normal].sort());
    expect(await unread('normal')).toBe(1);
  });
});

describe('recipient and company isolation', () => {
  it('nobody sees a notification addressed to someone else — same company or not', async () => {
    const all = Object.values(fx.notif).flat();
    for (const who of ['hrNull', 'normal', 'noScope', 'noCompany', 'bUser', 'bHrNull']) {
      const ids = (await list(who)).map((n) => n.id).filter((id) => all.includes(id));
      expect(ids.sort(), who).toEqual([...fx.notif[who]].sort());
    }
  });

  it('a token claiming a company the login does not belong to sees nothing', async () => {
    // A stale or tampered claim: an A login presenting company B. The scope
    // comes from the server-signed token, never from the request body or
    // query, so this is the only way a "foreign company" reaches the filter.
    const decoded = jwt.decode(fx.tok.normal);
    const { iat: _iat, exp: _exp, ...claims } = decoded;
    fx.tok.staleB = jwt.sign({ ...claims, company_id: B }, process.env.JWT_SECRET, { expiresIn: '5m' });
    expect(await list('staleB')).toEqual([]);
    expect(await unread('staleB')).toBe(0);
  });

  it('a company id in the query string is ignored', async () => {
    const res = await request(app).get(`/api/notifications?limit=100&company_id=${B}`).set(as('normal'));
    expect(res.body.map((n) => n.id).sort()).toEqual([...fx.notif.normal].sort());
  });
});

describe('a login with no company context', () => {
  it('sees only its own notifications — no fallback to any company', async () => {
    for (const who of ['noScope', 'noCompany']) {
      const rows = await list(who);
      expect(rows.map((n) => n.id).sort(), who).toEqual([...fx.notif[who]].sort());
      expect(rows.every((n) => n.user_id === fx.user[who]), who).toBe(true);
      expect(await unread(who), who).toBe(1);
    }
  });
});

describe('probation reminders reach a NULL-company HR login', () => {
  it('are visible in the list and badge, and a re-run adds no duplicate', async () => {
    const probationer = await emp('probationer', A, { status: 'Probation', end: '2026-11-30' });
    const before = await unread('hrNull');

    const first = await runProbationCheck({ asOf: '2026-11-25', companyId: A });
    expect(first.due_soon).toBe(1);
    const reminders = (await list('hrNull')).filter((n) => n.reference_id === probationer);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ module_name: 'probation', notification_type: 'probation_warning', is_read: false });
    expect(await unread('hrNull')).toBe(before + 1);

    const again = await runProbationCheck({ asOf: '2026-11-26', companyId: A });
    expect(again.due_soon).toBe(0);
    expect((await list('hrNull')).filter((n) => n.reference_id === probationer)).toHaveLength(1);
    expect(await unread('hrNull')).toBe(before + 1);
    // ...and company B's NULL-company HR is not told about company A's probationer.
    expect((await list('bHrNull')).filter((n) => n.reference_id === probationer)).toHaveLength(0);
  });
});

describe('read/delete keep working on the now-visible rows', () => {
  it('marking one read lowers the badge by one', async () => {
    const before = await unread('bHrNull');
    const target = (await list('bHrNull')).find((n) => !n.is_read);
    expect((await request(app).put(`/api/notifications/${target.id}/read`).set(as('bHrNull'))).status).toBe(200);
    expect(await unread('bHrNull')).toBe(before - 1);
  });
});
