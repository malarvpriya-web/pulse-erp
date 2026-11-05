/**
 * HR Announcements — safety and access-control pass (2026-10-21).
 *
 * Real announcement + home routers, real verifyToken, real role_permissions
 * matrix, real logins, live database. Covers what the audit found:
 *
 *   - GET /announcements/active was PUBLIC and ran a cross-tenant DELETE of every
 *     expired row on every call. It now needs a login and writes nothing; no GET
 *     in the module writes anything (row xmin is compared before/after).
 *   - No route checked the matrix. Employee (view-only) can now create, edit,
 *     pin, hide, archive and list nothing; HR (no delete) cannot archive.
 *   - Manager-tier publishers are team-scoped: own department, own posts.
 *   - Cross-company reads and writes are refused.
 *   - Feeds (/active, Home) honour audience, From/To dates, Scheduled Publish,
 *     inactive and archived.
 *   - Delete archives; the audit row carries company, actor and before-image.
 *   - Read tracking is self-scoped and visibility-checked; counts use one
 *     population for numerator and denominator.
 *   - Notifications go through notificationsRepository.dispatchSideEffects and
 *     are sent once, including on scheduled publication and under a race.
 *
 * Registry tenants 999988 / 999989 (testTenantIds.contract.test.js). Every row is
 * removed in afterAll by those company ids and the zz.bulletin. login prefix.
 * ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { auditMutations } = await import('../middlewares/auditMutations.js');
const { default: announcementRouter, isAnnouncementReadReceipt } = await import('../announcements/announcement.routes.js');
const { default: homeRouter } = await import('../home/home.routes.js');
const { publishIfDue, publishDue, EVENT_KEY } = await import('../announcements/announcement.publisher.js');
const { default: notificationsRepository } = await import('../modules/notifications/repositories/notifications.repository.js');

const A = 999988;
const B = 999989;
const PW = 'Zz-Bulletin-Test-9!';
const MAIL = 'zz.bulletin.';
const fx = { tok: {}, user: {}, emp: {} };

// Mounted exactly as server.js mounts them (auditMutations in front).
const app = express();
app.use(express.json());
app.use('/api/announcements', auditMutations('announcements', { skip: isAnnouncementReadReceipt }), announcementRouter);
app.use('/api/home', homeRouter);
const as = (who) => (who ? { Authorization: `Bearer ${fx.tok[who]}` } : {});
const call = (who, method, path, body) => {
  const r = request(app)[method](`/api${path}`).set(as(who));
  return method === 'get' ? r : r.send(body ?? {});
};

let D; // { today, past, later } as YYYY-MM-DD in the DATABASE's time zone

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM announcement_reads WHERE announcement_id IN (SELECT id FROM announcements WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM announcements WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  await pool.query(`DELETE FROM employees WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM notification_rules WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

let seq = 0;
/** A login in `cid` with `role`; with `dept`, also an employees row linked to it. */
async function person(key, role, cid, { dept = null, status = 'Active' } = {}) {
  seq += 1;
  let emp = null;
  if (dept !== null) {
    emp = (await pool.query(
      `INSERT INTO employees (company_id, office_id, first_name, last_name, company_email, status, department, joining_date)
       VALUES ($1,$2,'Zz',$3,$4,$5,$6,'2020-01-01') RETURNING id`,
      [cid, `EMP988${String(seq).padStart(3, '0')}`, key, `${MAIL}emp.${key}@example.com`, status, dept])).rows[0].id;
  }
  const email = `${MAIL}${key}@example.com`;
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id, employee_id)
     VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
    [`Zz ${key}`, email, await bcrypt.hash(PW, 4), role, cid, emp])).rows[0].id;
  if (cid != null) await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
  fx.emp[key] = emp;
}

const body = (over = {}) => ({
  title: `Zz notice ${++seq}`, message: '<p>Hello <b>team</b></p>',
  from_date: D.today, to_date: D.later, target_type: 'all', target_value: '',
  is_active: true, is_pinned: false, publish_at: null, priority: 'medium', category: 'General',
  ...over,
});

/** Insert directly (test company only) — for states the API would refuse or notify on. */
async function rawAnnouncement(cid, over = {}) {
  const f = { title: `Zz raw ${++seq}`, message: 'raw', from_date: D.today, to_date: D.later,
              target_type: 'all', target_value: '', is_active: true, publish_at: null,
              deleted_at: null, notified_at: new Date(), created_by: null, ...over };
  return (await pool.query(
    `INSERT INTO announcements (company_id, title, message, from_date, to_date, target_type, target_value,
                                is_active, publish_at, deleted_at, notified_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [cid, f.title, f.message, f.from_date, f.to_date, f.target_type, f.target_value,
     f.is_active, f.publish_at, f.deleted_at, f.notified_at, f.created_by])).rows[0];
}

/** Every announcement / read row of both test companies, with its row version. */
const tableState = async () => (await pool.query(
  `SELECT a.xmin::text AS v, to_jsonb(a) AS row,
          (SELECT COUNT(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads
     FROM announcements a WHERE a.company_id = ANY($1::int[]) ORDER BY a.id`, [[A, B]])).rows;

const notifCount = async (annId) => Number((await pool.query(
  `SELECT COUNT(*) FROM notifications WHERE module_name = 'Announcements' AND reference_id = $1`, [annId])).rows[0].count);

const ids = (res) => (Array.isArray(res.body) ? res.body.map(r => r.id) : []);

async function waitForAudit(refId, action) {
  for (let i = 0; i < 40; i += 1) {
    const { rows } = await pool.query(
      `SELECT * FROM audit_logs WHERE module_name = 'announcements' AND reference_id = $1 AND action_type = $2`,
      [String(refId), action]);
    if (rows.length) return rows;
    await new Promise(r => { setTimeout(r, 50); });
  }
  return [];
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ Bulletin A','ZZBULLETINA'), ($2,'ZZ Bulletin B','ZZBULLETINB')`, [A, B]);
  D = (await pool.query(`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 30)::text AS past, (CURRENT_DATE + 30)::text AS later`)).rows[0];

  await person('hr',     'hr',       A, { dept: 'HR' });
  await person('admin',  'admin',    A);                                  // no employee record
  await person('mgr',    'manager',  A, { dept: 'Operations' });
  await person('eOps',   'employee', A, { dept: 'Operations' });
  await person('eOps2',  'employee', A, { dept: ' operations ', status: 'Probation' });
  await person('eSales', 'employee', A, { dept: 'Sales', status: 'Notice' });
  await person('eLeft',  'employee', A, { dept: 'Operations', status: 'Left' });
  await person('hrB',    'hr',       B, { dept: 'HR' });
  await person('adminB', 'admin',    B);
  await person('eB',     'employee', B, { dept: 'Operations' });
  await person('noco',   'employee', null);
  // No employee record: HR administrators, outside every audience count below.
  await person('hrMgr',  'hr_manager', A);
  await person('hrExec', 'hr_exec',    A);
  // Super Admin like the canonical superadmin@manifest.in: company-assigned, no
  // employee record (so outside every audience count). And one with NO company.
  await person('super',     'super_admin', A);
  await person('superNoco', 'super_admin', null);
}, 90_000);

afterAll(async () => { vi.restoreAllMocks(); await cleanup(); });

// ── 1. /active: login required, never deletes ────────────────────────────────

describe('GET /announcements/active', () => {
  it('refuses an unauthenticated caller, with or without ?company_id, and deletes nothing', async () => {
    const expired = await rawAnnouncement(A, { from_date: D.past, to_date: D.past });
    const before = await tableState();
    expect((await call(null, 'get', '/announcements/active')).status).toBe(401);
    expect((await call(null, 'get', `/announcements/active?company_id=${A}`)).status).toBe(401);
    expect((await call('eOps', 'get', '/announcements/active')).status).toBe(200);
    expect(await tableState()).toEqual(before);
    const { rows } = await pool.query('SELECT id, is_active FROM announcements WHERE id = $1', [expired.id]);
    expect(rows).toEqual([{ id: expired.id, is_active: true }]);
  });

  it('refuses a login with no company (no longer means "every company")', async () => {
    expect((await call('noco', 'get', '/announcements/active')).status).toBe(403);
  });

  it('the module source contains no DELETE on announcements', () => {
    for (const f of ['announcement.service.js', 'announcement.controller.js', 'announcement.visibility.js', 'announcement.publisher.js']) {
      const src = readFileSync(resolve(here, '../announcements', f), 'utf8');
      expect(src, f).not.toMatch(/DELETE\s+FROM\s+announcements/i);
    }
  });
});

// ── 2. every GET is read-only ────────────────────────────────────────────────

describe('GET endpoints write nothing', () => {
  it('list, active, home summary/announcements/events leave every row version unchanged', async () => {
    await rawAnnouncement(A, { from_date: D.past, to_date: D.past });           // expired, still is_active
    await rawAnnouncement(A, { publish_at: '2099-01-01T00:00' });               // scheduled
    const before = await tableState();
    for (const who of ['hr', 'admin', 'eOps', 'hrB']) {
      await call(who, 'get', '/announcements');
      await call(who, 'get', '/announcements/active');
      await call(who, 'get', '/home/announcements');
      await call(who, 'get', '/home/events/upcoming');
      await call(who, 'get', '/home/summary');
    }
    expect(await tableState()).toEqual(before);
  });
});

// ── 3. permissions, server-side ──────────────────────────────────────────────

describe('permission matrix is enforced', () => {
  it('employee cannot list, create, edit, hide, pin or archive', async () => {
    const a = (await call('hr', 'post', '/announcements', body())).body;
    const before = await tableState();
    expect((await call('eOps', 'get', '/announcements')).status).toBe(403);
    expect((await call('eOps', 'post', '/announcements', body())).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}`, body({ title: 'hijack' }))).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}/toggle`, { is_active: false })).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}/pin`, { is_pinned: true })).status).toBe(403);
    expect((await call('eOps', 'delete', `/announcements/${a.id}`)).status).toBe(403);
    expect(await tableState()).toEqual(before);
  });

  it('HR creates and edits company-wide but cannot archive (matrix: no delete); admin archives', async () => {
    const a = (await call('hr', 'post', '/announcements', body())).body;
    expect(a.company_id).toBe(A);
    expect((await call('hr', 'put', `/announcements/${a.id}`, body({ title: 'Edited by HR' }))).status).toBe(200);
    expect((await call('hr', 'delete', `/announcements/${a.id}`)).status).toBe(403);
    expect((await call('admin', 'delete', `/announcements/${a.id}`)).status).toBe(200);
  });

  it('rejects malformed input instead of 500 / NULL flags', async () => {
    expect((await call('hr', 'post', '/announcements', body({ message: '<p> </p>' }))).status).toBe(400);
    expect((await call('hr', 'post', '/announcements', body({ to_date: D.past }))).status).toBe(400);
    expect((await call('hr', 'post', '/announcements', body({ target_type: 'everyone' }))).status).toBe(400);
    expect((await call('hr', 'post', '/announcements', body({ publish_at: 'soon' }))).status).toBe(400);
    const { is_active } = body(); expect(is_active).toBe(true);
    const noFlag = body(); delete noFlag.is_active;
    expect((await call('hr', 'post', '/announcements', noFlag)).body.is_active).toBe(true);
  });
});

describe('manager-tier publishers are team-scoped', () => {
  it('may post to own department (case-insensitive) or one employee in it — nothing wider', async () => {
    expect((await call('mgr', 'post', '/announcements', body())).status).toBe(403);
    expect((await call('mgr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Sales' }))).status).toBe(403);
    expect((await call('mgr', 'post', '/announcements', body({ target_type: 'employee', target_value: String(fx.emp.eSales) }))).status).toBe(403);
    expect((await call('mgr', 'post', '/announcements', body({ target_type: 'department', target_value: 'operations' }))).status).toBe(201);
    expect((await call('mgr', 'post', '/announcements', body({ target_type: 'employee', target_value: String(fx.emp.eOps) }))).status).toBe(201);
  });

  it('may change only own posts, lists only own posts, and cannot archive (matrix)', async () => {
    const hrPost = (await call('hr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    const mine = (await call('mgr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    expect((await call('mgr', 'put', `/announcements/${hrPost.id}`, body({ target_type: 'department', target_value: 'Operations' }))).status).toBe(403);
    expect((await call('mgr', 'put', `/announcements/${hrPost.id}/pin`, { is_pinned: true })).status).toBe(403);
    expect((await call('mgr', 'put', `/announcements/${mine.id}/pin`, { is_pinned: true })).status).toBe(200);
    expect((await call('mgr', 'put', `/announcements/${mine.id}`, body({ target_type: 'all' }))).status).toBe(403);
    expect((await call('mgr', 'delete', `/announcements/${mine.id}`)).status).toBe(403);
    const list = await call('mgr', 'get', '/announcements');
    expect(list.status).toBe(200);
    expect(ids(list)).toContain(mine.id);
    expect(ids(list)).not.toContain(hrPost.id);
  });
});

// ── 4. cross-company ─────────────────────────────────────────────────────────

describe('company isolation', () => {
  it('another company cannot read or change A\'s announcements', async () => {
    const a = (await call('hr', 'post', '/announcements', body())).body;
    const before = await tableState();
    expect(ids(await call('hrB', 'get', '/announcements'))).not.toContain(a.id);
    expect(ids(await call('eB', 'get', '/announcements/active'))).not.toContain(a.id);
    expect(ids(await call('eB', 'get', '/home/announcements'))).not.toContain(a.id);
    expect((await call('hrB', 'put', `/announcements/${a.id}`, body())).status).toBe(404);
    expect((await call('hrB', 'put', `/announcements/${a.id}/toggle`, { is_active: false })).status).toBe(404);
    expect((await call('hrB', 'put', `/announcements/${a.id}/pin`, { is_pinned: true })).status).toBe(404);
    expect((await call('adminB', 'delete', `/announcements/${a.id}`)).status).toBe(404);
    expect((await call('eB', 'post', `/announcements/${a.id}/read`)).status).toBe(404);
    expect(await tableState()).toEqual(before);
  });

  it('cannot target another company\'s employee', async () => {
    expect((await call('hr', 'post', '/announcements', body({ target_type: 'employee', target_value: String(fx.emp.eB) }))).status).toBe(400);
  });

  it('a body company_id does not move the row', async () => {
    const a = (await call('hr', 'post', '/announcements', { ...body(), company_id: B })).body;
    expect(a.company_id).toBe(A);
  });
});

// ── 5. audience + lifecycle in every feed ────────────────────────────────────

describe('employee-facing visibility', () => {
  let all, ops, one;
  beforeAll(async () => {
    all = (await call('hr', 'post', '/announcements', body({ title: 'Zz to all' }))).body;
    ops = (await call('hr', 'post', '/announcements', body({ title: 'Zz to ops', target_type: 'department', target_value: 'Operations' }))).body;
    one = (await call('hr', 'post', '/announcements', body({ title: 'Zz to eOps', target_type: 'employee', target_value: String(fx.emp.eOps) }))).body;
  });

  const seen = async (who) => {
    const active = ids(await call(who, 'get', '/announcements/active'));
    const home = ids(await call(who, 'get', '/home/announcements'));
    const summary = ((await call(who, 'get', '/home/summary')).body.announcements || []).map(a => a.id);
    expect(home).toEqual(active);                 // one definition, same answer
    for (const id of summary) expect(active).toContain(id);
    return active;
  };

  it('all / department / single employee reach exactly their audience', async () => {
    const eOps = await seen('eOps');
    expect(eOps).toEqual(expect.arrayContaining([all.id, ops.id, one.id]));
    const eOps2 = await seen('eOps2');            // ' operations ' matches 'Operations'
    expect(eOps2).toEqual(expect.arrayContaining([all.id, ops.id]));
    expect(eOps2).not.toContain(one.id);
    const sales = await seen('eSales');
    expect(sales).toContain(all.id);
    expect(sales).not.toContain(ops.id);
    expect(sales).not.toContain(one.id);          // a single-employee post is never for everyone
    const admin = await seen('admin');            // no employee record: 'all' only
    expect(admin).toContain(all.id);
    expect(admin).not.toContain(ops.id);
    expect(admin).not.toContain(one.id);
  });

  it('inactive, not-started, future-scheduled, expired and archived are excluded; past schedule included', async () => {
    const inactive  = await rawAnnouncement(A, { is_active: false });
    const notStart  = await rawAnnouncement(A, { from_date: D.later, to_date: D.later });
    const scheduled = await rawAnnouncement(A, { publish_at: '2099-01-01T00:00' });
    const expired   = await rawAnnouncement(A, { from_date: D.past, to_date: D.past });
    const archived  = await rawAnnouncement(A, { deleted_at: new Date() });
    const due       = await rawAnnouncement(A, { publish_at: '2020-01-01T00:00' });
    const got = await seen('eOps');
    for (const r of [inactive, notStart, scheduled, expired, archived]) expect(got).not.toContain(r.id);
    expect(got).toContain(due.id);
  });

  it('the admin list reports lifecycle_status from dates, without writing', async () => {
    const expired = await rawAnnouncement(A, { from_date: D.past, to_date: D.past });
    const sched = await rawAnnouncement(A, { publish_at: '2099-01-01T00:00' });
    const list = (await call('hr', 'get', '/announcements')).body;
    expect(list.find(r => r.id === expired.id).lifecycle_status).toBe('expired');
    expect(list.find(r => r.id === sched.id).lifecycle_status).toBe('scheduled');
    expect((await call('hr', 'put', `/announcements/${expired.id}/toggle`, { is_active: true })).status).toBe(400);
  });
});

// ── 6. archive + audit ───────────────────────────────────────────────────────

describe('delete archives and is audited', () => {
  it('keeps the row, hides it everywhere, and audits company + actor + before-image once', async () => {
    const a = (await call('hr', 'post', '/announcements', body({ title: 'Zz to archive' }))).body;
    await call('eOps', 'post', `/announcements/${a.id}/read`);
    const res = await call('admin', 'delete', `/announcements/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);

    const { rows: [row] } = await pool.query('SELECT * FROM announcements WHERE id = $1', [a.id]);
    expect(row.title).toBe('Zz to archive');
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(fx.user.admin);
    expect(Number((await pool.query('SELECT COUNT(*) FROM announcement_reads WHERE announcement_id = $1', [a.id])).rows[0].count)).toBe(1);

    expect(ids(await call('eOps', 'get', '/announcements/active'))).not.toContain(a.id);
    expect(ids(await call('hr', 'get', '/announcements'))).not.toContain(a.id);
    expect((await call('admin', 'delete', `/announcements/${a.id}`)).status).toBe(404);
    expect((await call('hr', 'put', `/announcements/${a.id}`, body())).status).toBe(404);

    const audit = await waitForAudit(a.id, 'delete');
    expect(audit).toHaveLength(1);
    expect(audit[0].company_id).toBe(A);
    expect(audit[0].user_id).toBe(fx.user.admin);
    expect(audit[0].old_data_json.title).toBe('Zz to archive');
    expect(audit[0].new_data_json.deleted_at).toBeTruthy();
    const created = await waitForAudit(a.id, 'create');
    expect(created).toHaveLength(1);              // auditMutations stood down — no double row
    expect(created[0].company_id).toBe(A);
  });
});

// ── 7. read tracking + counts ────────────────────────────────────────────────

describe('read tracking', () => {
  it('is self-scoped, idempotent and visibility-checked', async () => {
    const all = (await call('hr', 'post', '/announcements', body())).body;
    const ops = (await call('hr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    const r1 = await call('eOps', 'post', `/announcements/${all.id}/read`, { user_id: fx.user.eSales });
    expect(r1.status).toBe(200);
    expect((await call('eOps', 'post', `/announcements/${all.id}/read`)).status).toBe(200);
    const { rows } = await pool.query('SELECT user_id FROM announcement_reads WHERE announcement_id = $1', [all.id]);
    expect(rows).toEqual([{ user_id: fx.user.eOps }]);       // body user_id ignored, no duplicate
    expect((await call('eSales', 'post', `/announcements/${ops.id}/read`)).status).toBe(404); // not in audience
    expect((await call(null, 'post', `/announcements/${all.id}/read`)).status).toBe(401);
    const feed = (await call('eOps', 'get', '/announcements/active')).body;
    expect(feed.find(a => a.id === all.id).is_read).toBe(true);
    expect(feed.find(a => a.id === ops.id).is_read).toBe(false);
  });

  it('read_count and total_audience share one population (company, current status, audience)', async () => {
    const all = (await call('hr', 'post', '/announcements', body())).body;
    const ops = (await call('hr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    for (const who of ['eOps', 'eSales']) await call(who, 'post', `/announcements/${all.id}/read`);
    await call('eOps', 'post', `/announcements/${ops.id}/read`);
    const list = (await call('hr', 'get', '/announcements')).body;
    // Linked, active logins of current A employees: hr, mgr, eOps, eOps2, eSales.
    // Not admin (no employee), not eLeft (Left), not B.
    expect(list.find(r => r.id === all.id)).toMatchObject({ total_audience: 5, read_count: 2 });
    // Operations: mgr, eOps, eOps2.
    expect(list.find(r => r.id === ops.id)).toMatchObject({ total_audience: 3, read_count: 1 });
  });
});

// ── 8. notifications ─────────────────────────────────────────────────────────

describe('notifications', () => {
  const expectedAll = () => ['hr', 'mgr', 'eOps', 'eOps2', 'eSales'].map(k => fx.user[k]).sort((x, y) => x - y);
  const recipients = async (annId) => (await pool.query(
    `SELECT user_id FROM notifications WHERE module_name = 'Announcements' AND reference_id = $1 ORDER BY user_id`,
    [annId])).rows.map(r => r.user_id);

  it('a live post notifies its population once, through the shared dispatcher', async () => {
    const spy = vi.spyOn(notificationsRepository, 'dispatchSideEffects').mockResolvedValue(undefined);
    const a = (await call('hr', 'post', '/announcements', body({ message: '<p>Office &amp; <b>canteen</b> closed</p>' }))).body;
    expect(await recipients(a.id)).toEqual(expectedAll());
    const calls = spy.mock.calls.map(c => c[0]).filter(n => n.reference_id === a.id);
    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({ event_key: EVENT_KEY, company_id: A, notification_type: 'announcement', module_name: 'Announcements' });
    expect(calls[0].message).toBe('Office & canteen closed');
    // Saving again, the job, and a direct call send nothing more.
    await call('hr', 'put', `/announcements/${a.id}`, body({ title: 'Edited' }));
    await publishDue({ companyId: A });
    expect((await publishIfDue(a.id)).claimed).toBe(false);
    expect(await notifCount(a.id)).toBe(5);
    spy.mockRestore();
  });

  it('department / employee posts notify only that audience; B is never notified', async () => {
    const ops = (await call('hr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    expect(await recipients(ops.id)).toEqual(['mgr', 'eOps', 'eOps2'].map(k => fx.user[k]).sort((x, y) => x - y));
    const one = (await call('hr', 'post', '/announcements', body({ target_type: 'employee', target_value: String(fx.emp.eSales) }))).body;
    expect(await recipients(one.id)).toEqual([fx.user.eSales]);
  });

  it('a draft or scheduled post notifies nothing until it goes live, then exactly once', async () => {
    const draft = (await call('hr', 'post', '/announcements', body({ is_active: false }))).body;
    const sched = (await call('hr', 'post', '/announcements', body({ publish_at: '2099-01-01T00:00' }))).body;
    const later = (await call('hr', 'post', '/announcements', body({ from_date: D.later, to_date: D.later }))).body;
    await publishDue({ companyId: A });
    for (const a of [draft, sched, later]) expect(await notifCount(a.id)).toBe(0);

    await call('hr', 'put', `/announcements/${draft.id}/toggle`, { is_active: true });
    expect(await notifCount(draft.id)).toBe(5);

    // The scheduled time arrives (test-owned row).
    await pool.query(`UPDATE announcements SET publish_at = '2020-01-01T00:00' WHERE id = $1`, [sched.id]);
    // The running dev server's publish job may claim it first; either way it is sent once.
    await publishDue({ companyId: A });
    await publishDue({ companyId: A });
    expect(await notifCount(sched.id)).toBe(5);
    expect(await notifCount(later.id)).toBe(0);
  });

  it('concurrent publishes of the same row send one set', async () => {
    const a = await rawAnnouncement(A, { notified_at: null });
    const results = await Promise.all([publishIfDue(a.id), publishIfDue(a.id), publishIfDue(a.id)]);
    // At most one claim — none if the dev server's job got there first.
    expect(results.filter(r => r.claimed).length).toBeLessThanOrEqual(1);
    expect(await notifCount(a.id)).toBe(5);
  });

  it('an archived or expired un-notified row is never announced', async () => {
    const arch = await rawAnnouncement(A, { notified_at: null, deleted_at: new Date() });
    const exp = await rawAnnouncement(A, { notified_at: null, from_date: D.past, to_date: D.past });
    await publishDue({ companyId: A });
    expect(await notifCount(arch.id)).toBe(0);
    expect(await notifCount(exp.id)).toBe(0);
  });
});

// ── 9. HR role boundaries (migration 20261021000005) ─────────────────────────

describe('HR administrator roles', () => {
  it('hr_manager and hr_exec administer company-wide, but cannot archive', async () => {
    for (const who of ['hrMgr', 'hrExec']) {
      expect((await call(who, 'get', '/announcements')).status).toBe(200);
      const a = await call(who, 'post', '/announcements', body({ title: `Zz by ${who}` }));
      expect(a.status).toBe(201);
      expect(a.body.company_id).toBe(A);
      expect((await call(who, 'put', `/announcements/${a.body.id}`, body({ title: `Zz edited by ${who}` }))).status).toBe(200);
      expect((await call(who, 'put', `/announcements/${a.body.id}/pin`, { is_pinned: true })).status).toBe(200);
      expect((await call(who, 'put', `/announcements/${a.body.id}/toggle`, { is_active: false })).status).toBe(200);
      expect((await call(who, 'delete', `/announcements/${a.body.id}`)).status).toBe(403);
      const { rows } = await pool.query('SELECT deleted_at FROM announcements WHERE id = $1', [a.body.id]);
      expect(rows[0].deleted_at).toBeNull();
    }
  });

  it('they can also change announcements other HR users posted (company-wide publishers)', async () => {
    const a = (await call('hr', 'post', '/announcements', body())).body;
    expect((await call('hrExec', 'put', `/announcements/${a.id}`, body({ title: 'Zz HR exec edit' }))).status).toBe(200);
  });

  it('still cannot reach another company', async () => {
    const b = (await call('hrB', 'post', '/announcements', body())).body;
    expect((await call('hrMgr', 'put', `/announcements/${b.id}`, body())).status).toBe(404);
    expect(ids(await call('hrMgr', 'get', '/announcements'))).not.toContain(b.id);
  });

  it('the matrix holds exactly the agreed boundaries — delete only for admin tiers', async () => {
    const { rows } = await pool.query(`
      SELECT r.code, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete, rp.can_approve, rp.can_export
        FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
       WHERE rp.module = 'announcements' AND r.code = ANY($1)`,
      [['hr_manager', 'hr_exec', 'hr', 'manager', 'department_head', 'employee', 'admin', 'super_admin']]);
    const m = Object.fromEntries(rows.map(r => [r.code, r]));
    const vae = { can_view: true, can_add: true, can_edit: true, can_delete: false };
    for (const code of ['hr_manager', 'hr_exec', 'hr', 'manager', 'department_head']) expect(m[code]).toMatchObject(vae);
    for (const code of ['hr_manager', 'hr_exec']) expect(m[code]).toMatchObject({ can_approve: false, can_export: false });
    expect(m.employee).toMatchObject({ can_view: true, can_add: false, can_edit: false, can_delete: false });
    for (const code of ['admin', 'super_admin']) expect(m[code].can_delete).toBe(true);
  });
});

// ── 10. announcement.published rule ──────────────────────────────────────────

describe('announcement.published notification rule', () => {
  it('exists once, for Manifest only, in-app only (no email), enabled', async () => {
    const { rows } = await pool.query(`
      SELECT nr.company_id, nr.channel, nr.enabled, c.name
        FROM notification_rules nr JOIN companies c ON c.id = nr.company_id
       WHERE nr.event_key = $1`, [EVENT_KEY]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toMatch(/^manifest/i);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].channel.split(',').map(c => c.trim())).not.toContain('email');
  });

  it('a company with the rule is still notified once per person, and re-runs add nothing', async () => {
    await pool.query(
      `INSERT INTO notification_rules (company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
       VALUES ($1, $2, 'Zz rule', 'in_app', ARRAY['employee']::text[], true, false)
       ON CONFLICT (company_id, event_key) DO NOTHING`, [A, EVENT_KEY]);
    try {
      const a = (await call('hr', 'post', '/announcements', body())).body;
      expect(await notifCount(a.id)).toBe(5);
      await publishDue({ companyId: A });
      await publishIfDue(a.id);
      expect(await notifCount(a.id)).toBe(5);
      const dupes = (await pool.query(
        `SELECT user_id FROM notifications WHERE module_name = 'Announcements' AND reference_id = $1
          GROUP BY user_id HAVING COUNT(*) > 1`, [a.id])).rows;
      expect(dupes).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM notification_rules WHERE company_id = $1 AND event_key = $2`, [A, EVENT_KEY]);
    }
  });

  it('previously published announcements are never re-notified', async () => {
    const already = await rawAnnouncement(A, { notified_at: new Date(Date.now() - 86400000) });
    await publishDue({ companyId: A });
    expect(await notifCount(already.id)).toBe(0);
    expect((await publishIfDue(already.id)).claimed).toBe(false);
  });
});

// ── 11. Super Admin — full administration inside its own company ─────────────

describe('Super Admin', () => {
  it('runs the whole workflow: draft → publish → visible → read → edit → unpublish → archive', async () => {
    // Draft (Inactive) — nobody sees it, nobody is notified.
    const draft = await call('super', 'post', '/announcements', body({ title: 'Zz SA draft', is_active: false }));
    expect(draft.status).toBe(201);
    const id = draft.body.id;
    expect(draft.body.company_id).toBe(A);
    expect(ids(await call('eOps', 'get', '/announcements/active'))).not.toContain(id);
    expect(await notifCount(id)).toBe(0);

    // Publish — appears for the audience and for the Super Admin ('all'), notifies once.
    expect((await call('super', 'put', `/announcements/${id}/toggle`, { is_active: true })).status).toBe(200);
    expect(ids(await call('eOps', 'get', '/announcements/active'))).toContain(id);
    expect(ids(await call('super', 'get', '/announcements/active'))).toContain(id);
    expect(ids(await call('super', 'get', '/home/announcements'))).toContain(id);
    expect(await notifCount(id)).toBe(5);

    // Open/read — the employee's and the Super Admin's own receipts.
    expect((await call('eOps', 'post', `/announcements/${id}/read`)).status).toBe(200);
    expect((await call('super', 'post', `/announcements/${id}/read`)).status).toBe(200);
    const feed = (await call('super', 'get', '/announcements/active')).body;
    expect(feed.find((a) => a.id === id).is_read).toBe(true);

    // Edit, pin, list.
    expect((await call('super', 'put', `/announcements/${id}`, body({ title: 'Zz SA edited' }))).status).toBe(200);
    expect((await call('super', 'put', `/announcements/${id}/pin`, { is_pinned: true })).status).toBe(200);
    const list = await call('super', 'get', '/announcements');
    expect(list.status).toBe(200);
    expect(list.body.find((a) => a.id === id)).toMatchObject({ title: 'Zz SA edited', is_pinned: true });

    // Unpublish (hide) and re-publish.
    expect((await call('super', 'put', `/announcements/${id}/toggle`, { is_active: false })).status).toBe(200);
    expect(ids(await call('eOps', 'get', '/announcements/active'))).not.toContain(id);
    expect((await call('super', 'put', `/announcements/${id}/toggle`, { is_active: true })).status).toBe(200);
    expect(await notifCount(id)).toBe(5);                 // re-publishing does not re-notify

    // Archive (the only delete there is) — gone from every list, row kept.
    expect((await call('super', 'delete', `/announcements/${id}`)).status).toBe(200);
    expect(ids(await call('super', 'get', '/announcements'))).not.toContain(id);
    expect(ids(await call('eOps', 'get', '/announcements/active'))).not.toContain(id);
    const { rows: [kept] } = await pool.query('SELECT deleted_at, deleted_by FROM announcements WHERE id = $1', [id]);
    expect(kept.deleted_at).not.toBeNull();
    expect(kept.deleted_by).toBe(fx.user.super);
    const audit = await waitForAudit(id, 'delete');
    expect(audit[0]).toMatchObject({ company_id: A, user_id: fx.user.super });
  });

  it('is not limited by HR role, department or ownership', async () => {
    // Any department (manager-tier publishers are limited to their own).
    expect((await call('super', 'post', '/announcements',
      body({ target_type: 'department', target_value: 'Sales' }))).status).toBe(201);
    // Posts by HR and by a team-scoped manager: Super Admin may change and archive both.
    const byHr  = (await call('hr',  'post', '/announcements', body())).body;
    const byMgr = (await call('mgr', 'post', '/announcements', body({ target_type: 'department', target_value: 'Operations' }))).body;
    for (const a of [byHr, byMgr]) {
      expect((await call('super', 'put', `/announcements/${a.id}`, body({ title: `Zz SA took over ${a.id}` }))).status).toBe(200);
      expect((await call('super', 'put', `/announcements/${a.id}/pin`, { is_pinned: true })).status).toBe(200);
      expect((await call('super', 'delete', `/announcements/${a.id}`)).status).toBe(200);
    }
    // And sees every post of its company in the admin list, not just its own.
    const mine = (await call('super', 'post', '/announcements', body())).body;
    const other = (await call('hr', 'post', '/announcements', body())).body;
    expect(ids(await call('super', 'get', '/announcements'))).toEqual(expect.arrayContaining([mine.id, other.id]));
  });

  it("cannot read or change another company's announcements", async () => {
    const b = (await call('hrB', 'post', '/announcements', body({ title: 'Zz company B only' }))).body;
    const before = (await tableState()).filter((r) => r.row.company_id === B);
    expect(ids(await call('super', 'get', '/announcements'))).not.toContain(b.id);
    expect(ids(await call('super', 'get', '/announcements/active'))).not.toContain(b.id);
    expect(ids(await call('super', 'get', '/home/announcements'))).not.toContain(b.id);
    expect((await call('super', 'put', `/announcements/${b.id}`, body())).status).toBe(404);
    expect((await call('super', 'put', `/announcements/${b.id}/toggle`, { is_active: false })).status).toBe(404);
    expect((await call('super', 'put', `/announcements/${b.id}/pin`, { is_pinned: true })).status).toBe(404);
    expect((await call('super', 'delete', `/announcements/${b.id}`)).status).toBe(404);
    expect((await call('super', 'post', `/announcements/${b.id}/read`)).status).toBe(404);
    // A body company_id does not move a create into B.
    expect((await call('super', 'post', '/announcements', { ...body(), company_id: B })).body.company_id).toBe(A);
    expect((await tableState()).filter((r) => r.row.company_id === B)).toEqual(before);
  });

  it('a Super Admin with NO company is refused, never treated as every company', async () => {
    for (const [m, p, b] of [['get', '/announcements'], ['get', '/announcements/active'], ['post', '/announcements', body()]]) {
      expect((await call('superNoco', m, p, b)).status).toBe(403);
    }
  });
});

describe('employees cannot administer (re-checked alongside Super Admin)', () => {
  it('every administrative action is 403 and changes nothing; reading still works', async () => {
    const a = (await call('super', 'post', '/announcements', body())).body;
    const before = (await tableState()).filter((r) => r.row.id === a.id);
    expect((await call('eOps', 'get', '/announcements')).status).toBe(403);
    expect((await call('eOps', 'post', '/announcements', body())).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}`, body())).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}/toggle`, { is_active: false })).status).toBe(403);
    expect((await call('eOps', 'put', `/announcements/${a.id}/pin`, { is_pinned: true })).status).toBe(403);
    expect((await call('eOps', 'delete', `/announcements/${a.id}`)).status).toBe(403);
    expect((await tableState()).filter((r) => r.row.id === a.id)).toEqual(before);
    expect((await call('eOps', 'post', `/announcements/${a.id}/read`)).status).toBe(200);
  });
});
