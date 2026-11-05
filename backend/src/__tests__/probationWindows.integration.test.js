/**
 * One "probation ending soon" window, against the live database and the real
 * routes (mounted with the same auth + policy middleware as server.js).
 *
 *   window = stored probation_end_date from TODAY through TODAY + the
 *            company's probation_review_reminder_days (default 14), calendar
 *            dates, current probationers only, company-scoped.
 *
 * Consumers checked here:
 *   - home alert           GET /dashboard/alerts            (type 'probation')
 *   - analytics onboarding GET /analytics/onboarding        (confirmingSoon)
 *   - Employees Dashboard  GET /hr-widgets/pending-confirmations — its broader
 *     30-day overview: same calendar-day rule, today counts as due.
 *
 * Before: the analytics count compared a date with NOW() (a probation ending
 * TODAY dropped out), used a fixed 14 days, and counted only people who joined
 * in the last 90 days — with a six-month probation, nobody ending soon.
 *
 * Fixtures live in three registry tenants (testTenantIds.contract.test.js) and
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
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const {
  analyticsPolicy, dashboardPolicy, withOpenPaths, DASHBOARD_PUBLIC_PATHS,
} = await import('../shared/analyticsAuthz.js');
const { default: analyticsRoutes } = await import('../analytics/routes/analytics.routes.js');
const { default: dashboardRoutes } = await import('../modules/dashboard/dashboard.routes.js');
const { default: hrWidgetRoutes } = await import('../modules/hr/hr-widgets.routes.js');
const { probationEndingSoonSql, reminderDaysFor } = await import('../shared/probationDates.js');

const TEN = 999965;      // reminder window configured: 10 days
const DEF = 999966;      // no settings at all → 14
const BAD = 999967;      // invalid settings → 14
const COMPANIES = [TEN, DEF, BAD];
const PW = 'Zz-PWin-Test-9!';
const fx = { tok: {}, emp: {} };

const app = express();
app.use(express.json());
app.use('/api/analytics', verifyToken, analyticsPolicy, analyticsRoutes);
app.use('/api/dashboard', verifyToken, withOpenPaths(dashboardPolicy, DASHBOARD_PUBLIC_PATHS), dashboardRoutes);
app.use('/api/hr-widgets', hrWidgetRoutes);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });

let today;
const day = (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function cleanup() {
  const users = `SELECT id FROM users WHERE email LIKE 'zz.pwin.%@example.com'`;
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.pwin.%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [COMPANIES]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = ANY($1::int[])`, [COMPANIES]);
  // talent.routes.js seeds default interview questions for EVERY active company
  // whenever it loads (each dev-server reboot), and that FK blocks the delete.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [COMPANIES]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [COMPANIES]);
}

let seq = 0;
let dept; let desig;
async function emp(key, cid, { status = 'Probation', end = null, joining = '2026-01-15' } = {}) {
  seq += 1;
  fx.emp[key] = (await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, department, designation,
                            status, joining_date, probation_end_date)
     VALUES ($1,$2,'Zz',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [cid, `EMP965${String(seq).padStart(3, '0')}`, key, `zz.pwin.emp.${key}@example.com`, dept, desig,
      status, joining, end])).rows[0].id;
}
async function login(key, cid) {
  const email = `zz.pwin.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ($1,$2,$3,'hr',true,$4) RETURNING id`, [`Zz ${key}`, email, hash, cid]);
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [u.id, cid]);
  await syncPrimaryRole(u.id, 'hr', cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

const alertCount = async (who) => {
  const res = await request(app).get('/api/dashboard/alerts').set(as(who));
  expect(res.status).toBe(200);
  const a = res.body.alerts.find((x) => x.type === 'probation');
  return { count: a ? Number(a.message.split(' ')[0]) : 0, message: a?.message ?? null };
};
const analytics = async (who) => {
  const res = await request(app).get('/api/analytics/onboarding').set(as(who));
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  await cleanup();
  today = (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
  dept = (await pool.query(`SELECT name FROM master_departments WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  desig = (await pool.query(`SELECT name FROM master_designations WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].name;
  await pool.query(`INSERT INTO companies (id, name, code) VALUES
    ($1,'ZZ PWin Ten','ZZPWT'), ($2,'ZZ PWin Default','ZZPWD'), ($3,'ZZ PWin Bad','ZZPWB')`, COMPANIES);
  await pool.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at) VALUES
       ($1, 'recruitment', '{"probation_review_reminder_days": 10}'::jsonb, NOW()),
       ($2, 'recruitment', '{"probation_review_reminder_days": "soon", "probation_months": -1}'::jsonb, NOW())`,
    [TEN, BAD]);

  // TEN: window = today .. today+10
  await emp('yesterday', TEN, { end: day(-1) });          // ended — overdue, not "ending soon"
  await emp('today',     TEN, { end: day(0) });           // ends today — IN
  await emp('edge',      TEN, { end: day(10) });          // last day of the window — IN
  await emp('past',      TEN, { end: day(11) });          // one day beyond — OUT
  // Outside TEN's 10 days but inside a fixed 14: separates the company
  // setting from the old hardcoded window (a count of 3 must not be reachable
  // by dropping "today" and adding days 11-14 instead).
  await emp('twelve',    TEN, { end: day(12) });          // OUT
  await emp('undated',   TEN, { end: null });             // no stored date — OUT (never guessed)
  await emp('active',    TEN, { status: 'Active', end: day(0) });   // not on probation — OUT
  // Joined ~6 months ago: outside the onboarding "last 90 days" cohort, still ending soon — IN
  await emp('longAgo',   TEN, { end: day(3), joining: day(-178) });
  // DEF (no settings → 14) and BAD (invalid → 14)
  for (const cid of [DEF, BAD]) {
    const tag = cid === DEF ? 'def' : 'bad';
    await emp(`${tag}14`, cid, { end: day(14) });          // IN at the default
    await emp(`${tag}15`, cid, { end: day(15) });          // OUT
  }
  await emp('defToday', DEF, { end: day(0) });             // IN — ends today
  await login('ten', TEN);
  await login('def', DEF);
  await login('bad', BAD);
}, 60000);

afterAll(cleanup);

describe('the shared window', () => {
  it('is a calendar-date range, today through today + N inclusive', () => {
    expect(probationEndingSoonSql(10)).toBe('probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 10');
    expect(probationEndingSoonSql('0', 'e.probation_end_date')).toBe('e.probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 0');
  });

  it('refuses anything that is not a validated window or a column name', () => {
    for (const bad of [-1, 91, '1.5', 'abc', null, undefined, '10; DROP TABLE x']) {
      expect(() => probationEndingSoonSql(bad), String(bad)).toThrow(RangeError);
    }
    expect(() => probationEndingSoonSql(14, 'x; DROP TABLE y')).toThrow(RangeError);
  });

  it('reads the company setting; absent, invalid or company-less → 14', async () => {
    expect(await reminderDaysFor(pool, TEN)).toBe(10);
    expect(await reminderDaysFor(pool, DEF)).toBe(14);
    expect(await reminderDaysFor(pool, BAD)).toBe(14);
    expect(await reminderDaysFor(pool, null)).toBe(14);
  });
});

describe('home alert and analytics agree, on the configured window', () => {
  it('both count today and the window boundary, not yesterday or the day after', async () => {
    // IN: today, edge (today+10), longAgo (today+3) → 3
    const alert = await alertCount('ten');
    const data = await analytics('ten');
    expect(alert.count).toBe(3);
    expect(alert.message).toBe('3 employee probations ending in ≤10 days');
    expect(data.confirmingSoon).toBe(3);
    expect(data.confirmingSoonWindowDays).toBe(10);
  });

  it('a probation ending TODAY is counted (it used to fall out of the >= NOW() comparison)', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT ${probationEndingSoonSql(10)} AS in_window FROM employees WHERE id = $1`, [fx.emp.today]);
    expect(r.in_window).toBe(true);
    const { rows: [old] } = await pool.query(
      `SELECT (probation_end_date >= NOW()) AS old_rule FROM employees WHERE id = $1`, [fx.emp.today]);
    expect(old.old_rule).toBe(false);   // the defect, pinned
  });

  it('defaults to 14 days when the setting is absent', async () => {
    // DEF: ends today + ends on day 14 → 2; day 15 excluded
    expect((await alertCount('def')).count).toBe(2);
    expect((await alertCount('def')).message).toMatch(/≤14 days$/);
    expect(await analytics('def')).toMatchObject({ confirmingSoon: 2, confirmingSoonWindowDays: 14 });
  });

  it('defaults to 14 days when the setting is invalid', async () => {
    expect((await alertCount('bad')).count).toBe(1);
    expect(await analytics('bad')).toMatchObject({ confirmingSoon: 1, confirmingSoonWindowDays: 14 });
  });

  it('is company-scoped: each company counts only its own probationers', async () => {
    // DEF has two in-window probationers, BAD one; TEN's three never leak in.
    expect((await analytics('def')).confirmingSoon).toBe(2);
    expect((await analytics('bad')).confirmingSoon).toBe(1);
  });
});

describe('Employees Dashboard overview (30 days) uses the same calendar-day rule', () => {
  it('today is due, yesterday is overdue, beyond the window is absent; undated is flagged', async () => {
    const res = await request(app).get('/api/hr-widgets/pending-confirmations?days=30').set(as('ten'));
    expect(res.status).toBe(200);
    const state = Object.fromEntries(res.body.map((r) => [r.id, r.confirmation_state]));
    expect(state[fx.emp.today]).toBe('due');
    expect(state[fx.emp.edge]).toBe('due');
    expect(state[fx.emp.past]).toBe('due');          // day 11 is inside the broader 30-day overview
    expect(state[fx.emp.yesterday]).toBe('overdue');
    expect(state[fx.emp.undated]).toBe('undated');
    expect(state[fx.emp.active]).toBeUndefined();     // not on probation
    // company-scoped: no other company's rows
    const ids = new Set(Object.values(fx.emp));
    expect(res.body.every((r) => ids.has(r.id))).toBe(true);
    expect(res.body.some((r) => r.id === fx.emp.def14)).toBe(false);
  });
});
