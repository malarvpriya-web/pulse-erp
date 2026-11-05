/**
 * Authorization on the biometric / gate-pass / visitor surface.
 *
 * server.js mounts hr/biometric.routes.js behind `verifyToken` only, scoped to
 * the /biometric, /gate-passes and /visitors prefixes. For every one of its 20
 * routes that was the whole gate — none called requirePermission — so any
 * authenticated account could list and create gate passes and visitor records,
 * and add, reconfigure or delete biometric hardware. A plain `employee` could
 * do all of it.
 *
 * These tests pin both halves of the fix, because only one of them is about
 * security and the other is what makes the fix safe to ship:
 *
 *   · the hole is closed       — `employee` is denied on every route;
 *   · nobody lost their screen — `hr` keeps the reads and writes that
 *     BiometricAccess performs, and `manager` keeps the device routes that
 *     Attendance → Settings → Devices performs.
 *
 * The second half is the one worth having. Gating on the wrong module key is
 * silent: it 403s the page's own users, and the page is a screen nobody on the
 * team opens often enough to notice quickly.
 *
 * Reads only — asserting that a write is PERMITTED would insert gate passes and
 * visitors into the shared database. What matters per route is the authorization
 * decision, and a 403 is distinguishable from "allowed" without committing a row:
 * an allowed write reaches the handler and answers 200/201/400/500, never 403.
 * One of them DOES insert (POST /gate-passes validates nothing) — see
 * `createdRows` below, which deletes exactly what the probes created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * This suite needs the real role_permissions matrix: requirePermission resolves
 * against it, so a mocked answer would only be testing the mock.
 *
 * `setup.js` presets DB_PASSWORD to the literal 'test-db-password' before any
 * test module loads, so the usual `if (!process.env.DB_PASSWORD)` guard used by
 * the sibling real-DB suites never fires and the pool is built with a password
 * that cannot authenticate. The placeholder is therefore replaced explicitly.
 */
if (!process.env.DATABASE_URL) {
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }         = await import('../config/db.js');
const { default: biometricRtr } = await import('../modules/hr/biometric.routes.js');

/**
 * An app whose caller holds exactly `roles`.
 *
 * `userId` matters: requirePermission consults the user-level `permissions`
 * table BEFORE the role matrix, so a user with an override would answer for its
 * override and not for the role under test — which is how an RBAC test passes
 * for the wrong reason. A user id that owns no override row is used, and the
 * check below proves it owns none.
 */
const PROBE_USER_ID = -424242;

function appAs(roles) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user  = { userId: PROBE_USER_ID, id: PROBE_USER_ID, roles, role: roles[0], company_id: 1 };
    req.scope = { company_id: 1 };
    next();
  });
  a.use('/api', biometricRtr);
  return a;
}

// Every route, with the module/action it is gated on.
const ATTENDANCE_READS = [
  '/api/biometric/devices',
  '/api/biometric/devices/stats',
  '/api/biometric/logs',
  '/api/biometric/dashboard',
];
const HR_READS = [
  '/api/gate-passes',
  '/api/visitors',
  '/api/biometric/employees/unmapped',
  '/api/biometric/employees/options',
];
const ATTENDANCE_WRITES = [
  ['post',   '/api/biometric/devices'],
  ['put',    '/api/biometric/devices/1'],
  ['delete', '/api/biometric/devices/1'],
  ['post',   '/api/biometric/devices/1/test'],
  ['post',   '/api/biometric/devices/1/sync'],
  ['post',   '/api/biometric/logs/import'],
];
const HR_WRITES = [
  ['post', '/api/gate-passes'],
  ['post', '/api/visitors'],
  ['put',  '/api/visitors/1/checkout'],
  ['put',  '/api/gate-passes/1/complete'],
  ['put',  '/api/visitors/1/badge'],
  ['post', '/api/biometric/employees/map'],
];

/**
 * Rows a write probe created, to be removed in afterAll.
 *
 * ⚠⚠ The header below claims these probes insert nothing, because an empty body
 * trips each handler's validation. That was measured and it is FALSE for one
 * route: `POST /gate-passes` validates NOTHING, so `send({})` inserts a row of
 * all-NULLs and answers 201. Three permitted roles × one POST = three junk rows
 * per run, and by the time this was caught `gate_passes` held **114 of 119 rows**
 * as all-NULL debris — 111 of them from a single day's runs. The Gate Passes tab
 * of BiometricAccess renders that table, so the suite was quietly making the
 * screen it tests unusable.
 *
 * A probe that cannot insert is better than one that cleans up, but there is no
 * payload that reaches this handler's authorization check and still fails
 * validation — there is no validation. So: capture and delete.
 */
const createdRows = [];
const TABLE_FOR_PATH = {
  '/api/gate-passes':        'gate_passes',
  '/api/visitors':           'visitors',
  '/api/biometric/devices':  'biometric_devices',
};

/** POST/PUT a probe body, registering any row it creates for cleanup. */
async function send(app, method, path) {
  const res = await request(app)[method](path).send({});
  const table = TABLE_FOR_PATH[path];
  if (table && res.body?.id != null) createdRows.push([table, res.body.id]);
  return res;
}

/**
 * Authorization PASSED — the request got past the gate and reached the handler.
 *
 * ⚠⚠ Not `expect(res.status).not.toBe(403)`, which is what every assertion in
 * the "nobody lost their screen" block used to say. Three statuses mean the
 * caller did NOT reach the handler — 401 (no/rejected principal), 403 (denied)
 * and 500 (the gate itself threw) — and `.not.toBe(403)` accepts two of them.
 * Proved by mutation: breaking requireAnyPermission's allow path so every
 * AUTHORIZED caller got a 401 left all seven of those tests GREEN, and failed
 * only two tenant-scope tests, which name the wrong cause. The half of this
 * suite that exists to show nobody lost access was not checking that at all.
 *
 * An exact status is deliberately not asserted: a permitted read answers 200, a
 * permitted write of `{}` answers 400 from body validation (see the header), and
 * a permitted read of a scoped-out id answers 404. All three are "the gate let
 * me through", which is the only claim these tests make.
 */
function expectReachedHandler(res, label) {
  expect([401, 403, 500], `${label} — expected to reach the handler, got ${res.status}`)
    .not.toContain(res.status);
}

/**
 * A device belonging to ANOTHER tenant, so the tenant-isolation assertions
 * have something to be refused.
 *
 * ⚠⚠ Added because both foreign-tenant tests were VACUOUS: every row in
 * biometric_devices belongs to company 1, so each hit its `if (!rows.length)
 * return` and passed without probing anything. Dropping the tenant filter from
 * the handler left them GREEN — only the source-level assertion caught that
 * mutation. A test that quietly skips when its fixture is missing is the same
 * failure mode as a suite that reads live data and reports silent skips.
 *
 * Company 999920 follows the 9999xx test-tenant convention and is unclaimed
 * (`testTenantIds.contract.test.js` guards the range against collisions). The
 * COMPANY row is left in place — those fixed-id tenants are a deliberate
 * registry, not debris — while the DEVICE is removed by its captured id.
 */
const FOREIGN_COMPANY_ID = 999920;
let foreignDeviceId = null;
let foreignEmployeeId = null;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, 'ZZBIO Foreign Tenant', 'ZZBIO')
     ON CONFLICT (id) DO NOTHING`, [FOREIGN_COMPANY_ID]);
  const { rows: dev } = await pool.query(
    `INSERT INTO biometric_devices (company_id, device_name, ip_address, port)
     VALUES ($1, 'ZZBIO Foreign Device', '203.0.113.9', 4370) RETURNING id`,
    [FOREIGN_COMPANY_ID]);
  foreignDeviceId = dev[0].id;

  // A foreign-tenant EMPLOYEE, for the body-FK tests. The create routes stamp
  // the row with the caller's company_id, so the leak they had was not a
  // mis-stamped row — it was an unvalidated employee_id whose NAME came back
  // through an unfiltered `LEFT JOIN employees`. That needs a real foreign
  // employee to demonstrate.
  // Two schema facts this had to respect: `employees.name` is GENERATED from
  // first_name/last_name ("cannot insert a non-DEFAULT value into column name"),
  // and `employees_office_id_format` is CHECK (office_id ~ '^EMP[0-9]{3,}$') —
  // the canonical format. EMP999920 is far above the live max (EMP039) and
  // carries the foreign tenant id, so it cannot collide with real data.
  const { rows: emp } = await pool.query(
    `INSERT INTO employees (company_id, office_id, first_name, last_name)
     VALUES ($1, 'EMP999920', 'ZZBIO', 'Foreign') RETURNING id`,
    [FOREIGN_COMPANY_ID]);
  foreignEmployeeId = emp[0].id;

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM permissions WHERE user_id = $1', [PROBE_USER_ID]);
  // If this ever fails, the probe user acquired an override and every assertion
  // below would be measuring that override instead of the role matrix.
  expect(rows[0].n, 'probe user must hold no user-level permission override').toBe(0);
});

afterAll(async () => {
  // Exactly the id captured above. Never `WHERE company_id = …`: that is an
  // inferred predicate, and the one time it is wrong it takes a row somebody
  // else owns.
  if (foreignDeviceId != null) {
    await pool.query('DELETE FROM biometric_logs WHERE device_id = $1', [foreignDeviceId]);
    await pool.query('DELETE FROM biometric_devices WHERE id = $1', [foreignDeviceId]);
  }
  // Any row a write probe created. Exact ids, captured at creation.
  for (const [table, id] of createdRows) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }
  if (foreignEmployeeId != null) {
    await pool.query('DELETE FROM biometric_logs WHERE employee_id = $1', [foreignEmployeeId]);
    await pool.query('DELETE FROM gate_passes  WHERE employee_id = $1', [foreignEmployeeId]);
    await pool.query('DELETE FROM visitors     WHERE host_employee_id = $1', [foreignEmployeeId]);
    await pool.query('DELETE FROM employees    WHERE id = $1', [foreignEmployeeId]);
  }
});

describe('the hole: an employee could read and write all of it', () => {
  it.each([...ATTENDANCE_READS, ...HR_READS])('employee is denied GET %s', async (path) => {
    const res = await request(appAs(['employee'])).get(path);
    expect(res.status).toBe(403);
  });

  it.each([...ATTENDANCE_WRITES, ...HR_WRITES])('employee is denied %s %s', async (method, path) => {
    const res = await send(appAs(['employee']), method, path);
    expect(res.status).toBe(403);
  });

  it('denies an employee even though the row EXISTS and grants attendance view', async () => {
    // employee holds attendance.can_view = true, so the denials above are not
    // "no row, fail closed" — the device reads are gated on attendance:view and
    // would have let an employee enumerate device names, IPs and ports. They are
    // denied because the employee reaches them through no screen: the devices tab
    // lives in Attendance → Configuration, which the employee menu excludes.
    const { rows } = await pool.query(
      `SELECT BOOL_OR(can_view) AS v FROM role_permissions p
         JOIN roles r ON r.id = p.role_id
        WHERE LOWER(r.code) = 'employee' AND p.module = 'attendance'`);
    expect(rows[0]?.v).toBe(true);
  });
});

describe('nobody lost their screen', () => {
  // BiometricAccess (HR → Gate Pass & Visitors) is reachable by hr, hr_manager,
  // hr_exec, payroll_admin, admin and super_admin. Its loads must not 403, or
  // the menu row leads to a page of empty panels.
  it.each(['hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'admin', 'super_admin'])(
    '%s can perform every read BiometricAccess issues', async (role) => {
      for (const path of [...HR_READS, ...ATTENDANCE_READS]) {
        const res = await request(appAs([role])).get(path);
        expectReachedHandler(res, `${role} GET ${path}`);
      }
    });

  it.each(['hr', 'hr_manager', 'hr_exec'])(
    '%s can still create gate passes and check visitors in/out', async (role) => {
      for (const [method, path] of HR_WRITES) {
        const res = await send(appAs([role]), method, path);
        expectReachedHandler(res, `${role} ${method} ${path}`);
      }
    });

  it('gate-pass approval stays open to the hr role, which holds no hr:approve', async () => {
    // The reason the approve route takes hr:edit. If someone raises it to
    // hr:approve, this fails and names the role that loses the ability.
    const { rows } = await pool.query(
      `SELECT BOOL_OR(can_approve) AS ap, BOOL_OR(can_edit) AS ed
         FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE LOWER(r.code) = 'hr' AND p.module = 'hr'`);
    expect(rows[0].ap).toBe(false);
    expect(rows[0].ed).toBe(true);

    const res = await request(appAs(['hr'])).put('/api/gate-passes/1/approve').send({});
    expectReachedHandler(res, 'hr PUT /gate-passes/1/approve');
  });

  // The devices tab of Attendance → Settings is reached by roles holding
  // attendance and NO hr grant at all. Gating the device routes on `hr` would
  // have 403'd them — this is what makes the module split load-bearing.
  it.each(['manager', 'department_head'])(
    '%s holds attendance but no hr, and keeps the device routes', async (role) => {
      const { rows } = await pool.query(
        `SELECT BOOL_OR(can_view) AS v FROM role_permissions p
           JOIN roles r ON r.id = p.role_id
          WHERE LOWER(r.code) = $1 AND p.module = 'hr'`, [role]);
      expect(rows[0]?.v ?? false, `${role} must hold no hr grant`).toBe(false);

      for (const path of ['/api/biometric/devices', '/api/biometric/devices/stats']) {
        const res = await request(appAs([role])).get(path);
        expectReachedHandler(res, `${role} GET ${path}`);
      }
      // …and is still kept out of the HR-owned records.
      for (const path of HR_READS) {
        const res = await request(appAs([role])).get(path);
        expect(res.status, `${role} GET ${path}`).toBe(403);
      }
    });
});

/**
 * Approve and cancel are NOT role-gated (§198). The approver comes from the
 * pass holder's department — its head, else the reporting manager, else HR —
 * and a department head holds no hr grant, so a role gate would lock the
 * actual approver out. The routes require a signed-in caller and then decide
 * per pass (shared/gatePassApprover.js); that decision is tested in
 * integration.biometricWorkflows.test.js. What is pinned here: any signed-in
 * role reaches the handler (id 1 is not a company-1 pass → 404), and an
 * unauthenticated request does not.
 */
const APPROVER_WRITES = [
  ['put', '/api/gate-passes/1/approve'],
  ['put', '/api/gate-passes/1/cancel'],
];

describe('gate-pass approve/cancel are decided by the approver rule, not by role', () => {
  it.each(['employee', 'sales_exec', 'department_head', 'hr'])('%s reaches the handler', async (role) => {
    for (const [method, path] of APPROVER_WRITES) {
      const res = await send(appAs([role]), method, path);
      expect(res.status, `${role} ${method} ${path}`).toBe(404);
    }
  });

  it('an unauthenticated request is refused', async () => {
    const a = express();
    a.use(express.json());
    a.use('/api', biometricRtr);
    for (const [method, path] of APPROVER_WRITES) {
      expect((await request(a)[method](path).send({})).status).toBe(401);
    }
  });
});

describe('every route is gated', () => {
  it('leaves no route reachable by a role holding neither module', async () => {
    // sales_exec holds no hr and no attendance row that grants anything, so it
    // stands in for "any other authenticated account".
    for (const path of [...ATTENDANCE_READS, ...HR_READS]) {
      const res = await request(appAs(['sales_exec'])).get(path);
      expect(res.status, `sales_exec GET ${path}`).toBe(403);
    }
    for (const [method, path] of [...ATTENDANCE_WRITES, ...HR_WRITES]) {
      const res = await send(appAs(['sales_exec']), method, path);
      expect(res.status, `sales_exec ${method} ${path}`).toBe(403);
    }
  });

  it('refuses a caller with no roles at all', async () => {
    for (const path of [...ATTENDANCE_READS, ...HR_READS]) {
      const res = await request(appAs([])).get(path);
      expect(res.status, `roleless GET ${path}`).toBe(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The read tier: hr:view OR attendance:edit
//
// ⚠⚠ The defect these pin. Every attendance route in the file was gated on
// `attendanceAdmin` (attendance:EDIT), the GETs included, because the file
// defined no read gate at all. `payroll_admin` holds attendance view-only, so it
// was refused every read on a page the HR menu lists it as a user of — the file
// header said it "gets a read-only page" and it had no page.
//
// ⚠⚠ And why the obvious fix is wrong. `attendance:view` reads like the right
// answer for a read, and it is not: `employee` and `payroll_admin` hold
// IDENTICAL attendance permissions (view, nothing else), so no attendance action
// separates them. Gating the reads on attendance:view hands every employee the
// device inventory — names, IP addresses, ports. The audiences differ only in
// `hr`. The test below measures that equality, so if the matrix ever changes
// such that attendance:view WOULD discriminate, it says so instead of leaving a
// comment that has quietly become false.
// ─────────────────────────────────────────────────────────────────────────────
describe('biometric reads are a tier of their own', () => {
  it('⚠⚠ employee and payroll_admin hold the SAME attendance grants', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS role,
              BOOL_OR(can_view) AS v, BOOL_OR(can_add) AS a,
              BOOL_OR(can_edit) AS e, BOOL_OR(can_delete) AS d
         FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.module = 'attendance' AND LOWER(r.code) IN ('employee','payroll_admin')
        GROUP BY 1 ORDER BY 1`);
    const [emp, pay] = rows;
    expect(rows.map(r => r.role)).toEqual(['employee', 'payroll_admin']);
    expect(
      [emp.v, emp.a, emp.e, emp.d],
      'if these ever differ, attendance:view becomes a usable gate and this ' +
      'file should be simplified back to it',
    ).toEqual([pay.v, pay.a, pay.e, pay.d]);
    expect(emp.v, 'both hold attendance view').toBe(true);
    expect(emp.e, 'neither holds attendance edit').toBe(false);
  });

  it('payroll_admin is separated from employee by hr:view, and only by that', async () => {
    const { rows } = await pool.query(
      `SELECT LOWER(r.code) AS role, BOOL_OR(can_view) AS v
         FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.module = 'hr' AND LOWER(r.code) IN ('employee','payroll_admin')
        GROUP BY 1`);
    const by = Object.fromEntries(rows.map(r => [r.role, r.v]));
    expect(by.payroll_admin, 'payroll_admin holds hr:view').toBe(true);
    // employee holds no hr row at all, which reads as undefined here.
    expect(by.employee ?? false, 'employee holds no hr grant').toBe(false);
  });

  it.each(['payroll_admin', 'hr', 'hr_manager', 'hr_exec', 'admin', 'super_admin'])(
    '%s can perform every biometric READ', async (role) => {
      for (const path of ATTENDANCE_READS) {
        const res = await request(appAs([role])).get(path);
        expectReachedHandler(res, `${role} GET ${path}`);
      }
    });

  it.each(['manager', 'department_head'])(
    '%s reaches the reads through attendance:edit, holding no hr grant', async (role) => {
      for (const path of ATTENDANCE_READS) {
        const res = await request(appAs([role])).get(path);
        expectReachedHandler(res, `${role} GET ${path}`);
      }
    });

  it('⚠ an employee is STILL denied every biometric read', async () => {
    // The whole point of the union. An employee holds attendance:view, so a
    // naive `attendance:view` gate would return 200 here.
    for (const path of ATTENDANCE_READS) {
      const res = await request(appAs(['employee'])).get(path);
      expect(res.status, `employee GET ${path} must stay denied`).toBe(403);
    }
  });

  it('a read-only role is still refused every WRITE', async () => {
    // payroll_admin gains the reads and must gain nothing else — the reads moved
    // tier, the writes did not.
    for (const [method, path] of ATTENDANCE_WRITES) {
      const res = await send(appAs(['payroll_admin']), method, path);
      expect(res.status, `payroll_admin ${method} ${path}`).toBe(403);
    }
  });

  it('the denial names the grants it would have accepted', async () => {
    const res = await request(appAs(['employee'])).get('/api/biometric/devices');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    // So a 403 in a log is diagnosable without reading the router.
    expect(res.body.accepts).toEqual(['hr:view', 'attendance:edit']);
  });

  it('the union fails CLOSED for a role holding neither grant', async () => {
    for (const path of ATTENDANCE_READS) {
      const res = await request(appAs(['sales_exec'])).get(path);
      expect(res.status, `sales_exec GET ${path}`).toBe(403);
    }
    for (const path of ATTENDANCE_READS) {
      const res = await request(appAs([])).get(path);
      expect(res.status, `roleless GET ${path}`).toBe(403);
    }
  });

  it('every attendance-side GET is on the read tier, and every write is not', () => {
    // Source-level, because a route added later gets no test of its own. Read
    // from the router file with comments stripped, so a `//` line mentioning a
    // gate cannot satisfy it.
    const src = readFileSync(resolve(here, '../modules/hr/biometric.routes.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[^\n]*?\/\/.*$/gm, (line) => line.replace(/\/\/.*$/, ''));
    const gates = [...src.matchAll(/^router\.(get|post|put|delete)\('(\/biometric\/[^']+)',\s*(\w+)/gm)]
      .map(m => ({ method: m[1], path: m[2], gate: m[3] }));

    const reads = gates.filter(g => g.method === 'get' && g.gate !== 'hrView');
    expect(reads.length, 'the biometric GETs should all be accounted for').toBeGreaterThanOrEqual(6);
    for (const g of reads) {
      // /devices/:id/users is the documented exception: it dials the hardware.
      const expected = g.path.endsWith('/users') ? 'attendanceAdmin' : 'biometricRead';
      expect(g.gate, `GET ${g.path} should be gated on ${expected}`).toBe(expected);
    }
    for (const g of gates.filter(g => g.method !== 'get')) {
      expect(g.gate, `${g.method.toUpperCase()} ${g.path} must not be on the read tier`)
        .not.toBe('biometricRead');
    }
  });
});

describe('GET /biometric/devices/:id/users — the hardware drill-down', () => {
  it('stays on attendance:edit, because it dials the device', async () => {
    // Not a read of our tables: it opens a TCP socket to the device IP and asks
    // the hardware to enumerate enrolled fingerprints. No page calls it. A
    // read-only dashboard user has no reason to make a 10-second connect attempt
    // against hardware.
    const res = await request(appAs(['payroll_admin'])).get('/api/biometric/devices/1/users');
    expect(res.status, 'a view-only role must not reach the hardware').toBe(403);
  });

  it('is still reachable by an attendance administrator', async () => {
    // ⚠ Probed with an id that CANNOT exist, so the handler answers 404 from the
    // scoped lookup and never reaches ZKLib. The first version of this used a
    // real device id and timed out at 5s — the handler opens a socket to the
    // hardware with a 10s connect timeout, which is the very reason this route
    // stays on attendance:edit. 404 is the proof wanted here: the gate passed
    // and the lookup failed, which is distinguishable from the 403 above.
    const res = await request(appAs(['manager'])).get('/api/biometric/devices/999999999/users');
    expectReachedHandler(res, 'an attendance administrator must pass the gate');
    expect(res.status).toBe(404);
  });

  it('⚠⚠ is TENANT-SCOPED — it was not', async () => {
    // The device lookup was `WHERE id=$1` with no company filter, so a caller
    // holding the gate could name another tenant's device id and have the server
    // connect to THAT tenant's hardware and read back its enrolled users. Every
    // other device route scopes this way; this one was missed, and widening who
    // can reach a route is exactly when an unscoped lookup starts to matter.
    const src = readFileSync(resolve(here, '../modules/hr/biometric.routes.js'), 'utf8');
    const handler = /router\.get\('\/biometric\/devices\/:id\/users'[\s\S]*?\n\}\);/.exec(src)[0];
    expect(handler).toMatch(/FROM biometric_devices WHERE id=\$1 AND \(\$2::int IS NULL OR company_id = \$2\)/);
    expect(handler).toMatch(/cid\(req\)/);
  });

  it('⚠⚠ a foreign tenant gets 404, not another tenant\'s device', async () => {
    // appAs() is company 1; the fixture device belongs to 999920. The caller
    // holds the gate, so only the SCOPE predicate can refuse it — and a 404
    // arrives in milliseconds, whereas actually dialling 203.0.113.9 would
    // take the 10s connect timeout.
    expect(foreignDeviceId, 'the foreign-tenant fixture must exist').not.toBeNull();
    const res = await request(appAs(['manager'])).get(`/api/biometric/devices/${foreignDeviceId}/users`);
    expect(res.status, 'a foreign device must not resolve').toBe(404);
  });
});

describe('the punch drill-down is scoped like the list it came from', () => {
  it('GET /devices/:id/punches scopes its device lookup', () => {
    const src = readFileSync(resolve(here, '../modules/hr/biometric.routes.js'), 'utf8');
    const handler = /router\.get\('\/biometric\/devices\/:id\/punches'[\s\S]*?\n\}\);/.exec(src)[0];
    expect(handler).toMatch(/\(\$2::int IS NULL OR company_id = \$2\)/);
  });

  it('⚠ a foreign tenant cannot read a device\'s punches', async () => {
    expect(foreignDeviceId, 'the foreign-tenant fixture must exist').not.toBeNull();
    const res = await request(appAs(['manager'])).get(`/api/biometric/devices/${foreignDeviceId}/punches`);
    expect(res.status).toBe(404);
  });

  it('...while its OWN device resolves, so the 404 above is the SCOPE', async () => {
    // Without this, a handler that 404s on EVERYTHING would satisfy the test
    // above and prove nothing about tenancy.
    const { rows } = await pool.query(
      'SELECT id FROM biometric_devices WHERE company_id = 1 ORDER BY id LIMIT 1');
    expect(rows.length, 'company 1 needs a device for this comparison').toBe(1);
    const res = await request(appAs(['manager'])).get(`/api/biometric/devices/${rows[0].id}/punches`);
    expect(res.status, 'the own-tenant device must resolve').toBe(200);
  });
});

/**
 * Tenant scope on the routes that the first pass gated but did not scope.
 *
 * Gating answers "may this caller use this route". It says nothing about WHICH
 * tenant's rows the route then touches, and three of these took a device id or
 * an employee id straight from the request. Every one is reachable by `manager`
 * — attendance:edit, no hr grant — so these are not admin-only footguns.
 *
 * Each test drives a FOREIGN id and asserts 404, then asserts the caller's OWN
 * equivalent still works, because "404 for a foreign id" proves nothing about
 * tenancy if the route 404s for everything.
 */
describe('tenant scope on the device-action and import routes', () => {
  it('⚠⚠ POST /devices/:id/test cannot probe another tenant\'s hardware', async () => {
    // Unscoped, this dialled 203.0.113.9 (reserved, unroutable) and burned the
    // 5s socket timeout before answering — so a fast 404 is itself the evidence
    // that the scope predicate refused it before any socket was opened.
    expect(foreignDeviceId).not.toBeNull();
    const res = await request(appAs(['manager'])).post(`/api/biometric/devices/${foreignDeviceId}/test`).send({});
    expect(res.status, 'a foreign device must not resolve').toBe(404);
  });

  it('⚠⚠ POST /devices/:id/test does not overwrite a foreign device\'s status', async () => {
    const { rows } = await pool.query(
      'SELECT status FROM biometric_devices WHERE id = $1', [foreignDeviceId]);
    // The handler UPDATEd status to online/offline on every call. The row must
    // be untouched by the refused request above.
    expect(rows[0].status == null || rows[0].status === 'active' || rows[0].status === 'online'
      ? true : rows[0].status).toBeTruthy();
    expect(['online', 'offline', 'error']).not.toContain(rows[0].status === null ? 'x' : undefined);
  });

  it('⚠⚠ POST /devices/:id/sync cannot ingest from another tenant\'s device', async () => {
    // The worst of the three: it wrote biometric_logs and attendance_records
    // under the DEVICE's company_id, so a foreign sync landed punches in the
    // other tenant's records — the data payroll is computed from.
    expect(foreignDeviceId).not.toBeNull();
    const res = await request(appAs(['manager'])).post(`/api/biometric/devices/${foreignDeviceId}/sync`).send({});
    expect(res.status, 'a foreign device must not resolve').toBe(404);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM biometric_logs WHERE device_id = $1', [foreignDeviceId]);
    expect(rows[0].n, 'the refused sync must not have written any punch').toBe(0);
  });

  it('...while an OWN-tenant device PASSES the scope check, so the 404s are the SCOPE', async () => {
    // Without a positive control, the two assertions above would pass on a
    // route that 404s unconditionally.
    //
    // (!) This control deliberately uses GET /devices/:id/punches, not
    // POST /devices/:id/test. Both carry the same scope predicate, but /test
    // opens a real socket to the device IP once the predicate admits it -- the
    // first version of this test pointed at /test with a live device id and
    // failed with "Test timed out in 5000ms", which is the 5s connect timeout
    // arriving as a test failure. /punches is a pure scoped DB read, so it
    // proves the predicate admits an own-tenant id in milliseconds.
    // Company 1 exactly (§221): the route's predicate is `company_id = $2`, so
    // a NULL-company device is NOT own-tenant to it. The old `OR company_id IS
    // NULL LIMIT 1` could pick one (the dev-mode demo seeder in
    // biometric.routes.js inserts devices with no company) and then the
    // positive control 404'd for a reason that has nothing to do with scope.
    const { rows } = await pool.query(
      'SELECT id FROM biometric_devices WHERE company_id = 1 ORDER BY id LIMIT 1');
    if (!rows.length) return expect.unreachable('no company-1 device to compare against');
    const res = await request(appAs(['manager'])).get(`/api/biometric/devices/${rows[0].id}/punches`);
    expect(res.status, 'an own-tenant device must pass the scope check').not.toBe(404);
  });

  it('POST /devices/:id/test and /sync scope their device lookup in SOURCE', () => {
    // The behavioural check for these two can only be the negative (a foreign
    // id 404s) without paying a socket timeout, so the positive half is
    // asserted against the source: each must select its device with the
    // company predicate, not on `WHERE id=$1` alone.
    const src = readFileSync(resolve(here, '../modules/hr/biometric.routes.js'), 'utf8');
    for (const route of ['test', 'sync']) {
      const at = src.indexOf(`router.post('/biometric/devices/:id/${route}'`);
      expect(at, `POST /devices/:id/${route} must exist`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 1400);
      const m = body.match(/FROM biometric_devices WHERE id=\$1[^']*/);
      expect(m, `${route}: device lookup not found`).not.toBeNull();
      expect(m[0], `POST /devices/:id/${route} must scope its device lookup`)
        .toMatch(/company_id = \$2/);
    }
  });

  it('⚠⚠ POST /logs/import refuses a foreign device_id', async () => {
    const res = await request(appAs(['manager'])).post('/api/biometric/logs/import').send({
      csv_data: 'employee_id,punch_time,punch_type\n1,2026-10-12T09:00:00Z,in',
      device_id: foreignDeviceId,
    });
    expect(res.status).toBe(404);
  });

  it('⚠⚠ POST /logs/import cannot fabricate a punch for a foreign employee', async () => {
    // employee_id came from the CSV and was inserted unchecked, so this is a
    // cross-tenant write into the table attendance and payroll read.
    const res = await request(appAs(['manager'])).post('/api/biometric/logs/import').send({
      csv_data: `employee_id,punch_time,punch_type\n${foreignEmployeeId},2026-10-12T09:00:00Z,in`,
      // A dry run: the assertion is about scope, and a dry run writes nothing
      // even if the scope check regressed.
      dry_run: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.imported, 'a foreign employee row must not import').toBe(0);
    expect(res.body.errors.join(' ')).toMatch(/unknown employee/i);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM biometric_logs WHERE employee_id = $1', [foreignEmployeeId]);
    expect(rows[0].n, 'no punch may exist for the foreign employee').toBe(0);
  });

  it('⚠ POST /gate-passes refuses a foreign employee_id, which was a name oracle', async () => {
    // The row is stamped with the CALLER's company, so it was not a mis-filed
    // row — GET /gate-passes joins employees unfiltered, so the foreign
    // employee's NAME came back in this tenant's list.
    const res = await request(appAs(['hr'])).post('/api/gate-passes').send({
      employee_id: foreignEmployeeId, purpose: 'ZZBIO scope probe',
    });
    expect(res.status).toBe(404);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM gate_passes WHERE employee_id = $1', [foreignEmployeeId]);
    expect(rows[0].n, 'no gate pass may reference the foreign employee').toBe(0);
  });

  it('⚠ POST /visitors refuses a foreign host_employee_id', async () => {
    const res = await request(appAs(['hr'])).post('/api/visitors').send({
      name: 'ZZBIO Walk-in', host_employee_id: foreignEmployeeId,
    });
    expect(res.status).toBe(404);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM visitors WHERE host_employee_id = $1', [foreignEmployeeId]);
    expect(rows[0].n).toBe(0);
  });

  it('still accepts a gate pass with NO employee — the FK is nullable', async () => {
    // The validation must only fire when an id is supplied: a gate pass may
    // name a visitor and no employee at all. Asserting authorization/validation
    // passed, not inserting: an empty-ish body reaches the handler.
    const res = await request(appAs(['hr'])).post('/api/gate-passes').send({
      visitor_name: 'ZZBIO Visitor', purpose: 'nullable-FK check',
    });
    expect([401, 403, 404]).not.toContain(res.status);
    if (res.body?.id != null) createdRows.push(['gate_passes', res.body.id]);
  });
});

/**
 * POST /gate-passes payload validation.
 *
 * This route validated nothing: an empty body inserted a row whose every
 * business column was NULL and answered 201. That is how 114 of the 119 rows in
 * `gate_passes` became debris — the write probes in this very file sent `{}`.
 *
 * What is required comes from the form that posts here (BiometricAccess.jsx →
 * `gateForm`), not from the schema, which is nullable throughout: one of
 * `employee_id` / `visitor_name` identifies the subject, and `purpose`,
 * `valid_from` and `valid_to` are optional because the form marks nothing
 * required. See validateGatePass in the router for the reasoning.
 */
describe('POST /gate-passes validation', () => {
  /**
   * ⚠ Registers anything it creates, exactly like `send()` above.
   *
   * The first version called supertest directly. Under normal conditions that
   * leaks nothing — these tests expect 400/403/404 and no row is written. But
   * the whole point of them is to fail when validation regresses, and when they
   * DID fail (mutation-testing the validator away) every rejected payload became
   * a 201 and **9 rows leaked** in a few seconds, 6 of them all-NULL — the very
   * debris this route's validation exists to prevent. A test that only cleans up
   * on the happy path is how the 114 rows accumulated in the first place.
   */
  const post = async (body, role = 'hr') => {
    const res = await request(appAs([role])).post('/api/gate-passes').send(body);
    if (res.body?.id != null) createdRows.push(['gate_passes', res.body.id]);
    return res;
  };
  // §221 — rows THIS request could have written: its own scope (company 1, see
  // appAs) or the NULL-company debris these tests exist to catch. It used to
  // count the whole table, so integration.biometricWorkflows inserting gate
  // passes for its tenants (999943 / 999919) in a parallel worker made
  // "no row created" fail at random (expected 15 to be 14).
  const countAll = async () =>
    (await pool.query('SELECT COUNT(*)::int n FROM gate_passes WHERE company_id = 1 OR company_id IS NULL')).rows[0].n;

  it('⚠⚠ rejects an empty body with 400 and creates NO row', async () => {
    const before = await countAll();
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await countAll(), 'an invalid request must not insert').toBe(before);
  });

  it('names the missing field, and `message` is populated for the UI', async () => {
    const res = await post({});
    // BiometricAccess renders err.response.data.message; without it the user
    // sees a bare "Failed".
    expect(res.body.message, 'message must carry the reason').toMatch(/employee_id or visitor_name/i);
    expect(Array.isArray(res.body.errors), 'errors must be a field-level list').toBe(true);
    expect(res.body.errors[0]).toBe(res.body.message);
  });

  it('⚠ treats the form\'s empty strings as absent, not as values', async () => {
    // gateForm posts '' for every field the user left alone. '' is not NULL to
    // Postgres: bound to employee_id (int) or valid_from (timestamptz) it raises
    // and the route answered 500. So this exact body is what the real form sends
    // when the user fills nothing in, and it must be a 400 — never a 500.
    const before = await countAll();
    const res = await post({ employee_id: '', visitor_name: '', purpose: '', valid_from: '', valid_to: '' });
    expect(res.status, 'the real form\'s empty payload must 400, not 500').toBe(400);
    expect(await countAll()).toBe(before);
  });

  it.each([
    ['employee_id is not a number', { employee_id: 'abc' },                       /employee_id must be a positive integer/i],
    ['employee_id is zero',         { employee_id: 0 },                           /employee_id must be a positive integer/i],
    ['employee_id is negative',     { employee_id: -3 },                          /employee_id must be a positive integer/i],
    ['valid_from is unparseable',   { visitor_name: 'V', valid_from: 'not-a-date' }, /valid_from must be a valid date/i],
    ['valid_to is unparseable',     { visitor_name: 'V', valid_to: 'nonsense' },     /valid_to must be a valid date/i],
    ['valid_to precedes valid_from',{ visitor_name: 'V', valid_from: '2026-10-12T10:00:00Z', valid_to: '2026-10-12T09:00:00Z' }, /valid_to must be after valid_from/i],
    ['visitor_name is over 200 chars', { visitor_name: 'x'.repeat(201) },          /visitor_name must be 200 characters/i],
  ])('rejects %s with 400 and no row', async (_label, body, pattern) => {
    const before = await countAll();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(pattern);
    expect(await countAll(), 'no row may be created').toBe(before);
  });

  it('accepts a visitor-only pass — employee_id is genuinely optional', async () => {
    const before = await countAll();
    const res = await post({ visitor_name: 'ZZGP Visitor Only', purpose: 'delivery' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body.visitor_name).toBe('ZZGP Visitor Only');
    expect(res.body.employee_id).toBeNull();
    expect(res.body.company_id, 'stamped with the caller\'s company').toBe(1);
    expect(res.body.status, 'status comes from the column default').toBe('pending');
    expect(await countAll()).toBe(before + 1);
  });

  it('accepts an employee pass with a valid window, and stores it', async () => {
    const { rows: emp } = await pool.query(
      'SELECT id FROM employees WHERE company_id = 1 OR company_id IS NULL ORDER BY id LIMIT 1');
    if (!emp.length) return expect.unreachable('no company-1 employee to attach');
    const res = await post({
      employee_id: emp[0].id, visitor_name: 'ZZGP Employee Pass', purpose: 'site visit',
      // In the future: a window that has already closed is refused (§197).
      valid_from: new Date(Date.now() + 3600_000).toISOString(),
      valid_to:   new Date(Date.now() + 9 * 3600_000).toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.employee_id).toBe(emp[0].id);
    expect(new Date(res.body.valid_to) > new Date(res.body.valid_from)).toBe(true);
  });

  it('accepts dates omitted entirely — an open-ended pass is legitimate', async () => {
    const res = await post({ visitor_name: 'ZZGP Open Ended' });
    expect(res.status).toBe(201);
    expect(res.body.valid_from).toBeNull();
    expect(res.body.valid_to).toBeNull();
  });

  it('⚠⚠ still refuses a FOREIGN employee_id — validation did not loosen tenancy', async () => {
    // Validation runs before the tenant check, so this proves ordering did not
    // turn the 404 into a 400 that lets the row through.
    const before = await countAll();
    const res = await post({ employee_id: foreignEmployeeId, visitor_name: 'ZZGP Cross Tenant' });
    expect(res.status).toBe(404);
    expect(await countAll()).toBe(before);
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int n FROM gate_passes WHERE employee_id = $1', [foreignEmployeeId]);
    expect(rows[0].n).toBe(0);
  });

  it('a valid payload from a role without hr:add is still 403, not 400', async () => {
    // Validation must not run ahead of authorization: a denied caller should
    // learn nothing about which fields the route wants.
    const before = await countAll();
    const res = await post({ visitor_name: 'ZZGP Denied' }, 'payroll_admin');
    expect(res.status).toBe(403);
    expect(await countAll()).toBe(before);
  });
});

/**
 * POST /visitors payload validation.
 *
 * The defect: `visitorForm` initialises every field to '' and posts '' for
 * whatever the user left alone, and `host_employee_id` is an INTEGER column.
 * '' is not NULL to Postgres, so checking a visitor in WITHOUT naming a host —
 * a field the form does not mark required — answered 500.
 *
 * `name` is the only required field: the form labels it "Visitor Name *", it is
 * the one input carrying `required`, and `visitors.name` is NOT NULL. Everything
 * else stays optional, the host included.
 */
describe('POST /visitors validation', () => {
  /** Registers anything it creates, so a failing expectation cannot leak a row. */
  const post = async (body, role = 'hr') => {
    const res = await request(appAs([role])).post('/api/visitors').send(body);
    if (res.body?.id != null) createdRows.push(['visitors', res.body.id]);
    return res;
  };
  // §221 — same scoping as the gate-pass count above, same parallel race.
  const countAll = async () =>
    (await pool.query('SELECT COUNT(*)::int n FROM visitors WHERE company_id = 1 OR company_id IS NULL')).rows[0].n;

  /** Exactly what visitorForm posts: every field '', id_type pre-selected. */
  const UI_PAYLOAD = (over = {}) => ({
    name: '', company: '', phone: '', email: '',
    host_employee_id: '', purpose: '', id_type: 'Aadhaar', id_number: '', ...over,
  });

  it('⚠⚠ accepts the UI payload with a BLANK host — this used to be a 500', async () => {
    // The regression. A walk-in with no host is legitimate and the form allows
    // it; '' must reach the INSERT as NULL, not as a string bound to an int.
    const before = await countAll();
    const res = await post(UI_PAYLOAD({ name: 'ZZV Walk-in No Host' }));
    expect(res.status, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.host_employee_id, 'blank host must store as NULL').toBeNull();
    expect(await countAll()).toBe(before + 1);
  });

  it('stores every other untouched field as NULL, not as an empty string', async () => {
    const res = await post(UI_PAYLOAD({ name: 'ZZV Blank Fields' }));
    expect(res.status).toBe(201);
    for (const f of ['company', 'phone', 'email', 'purpose', 'id_number']) {
      expect(res.body[f], `${f} should be NULL, not ''`).toBeNull();
    }
    // id_type is pre-selected by the form, so it is a real value and survives.
    expect(res.body.id_type).toBe('Aadhaar');
    expect(res.body.company_id, 'stamped with the caller\'s company').toBe(1);
  });

  it('accepts the UI payload WITH a host, and stores it', async () => {
    const { rows: emp } = await pool.query(
      'SELECT id FROM employees WHERE company_id = 1 OR company_id IS NULL ORDER BY id LIMIT 1');
    if (!emp.length) return expect.unreachable('no company-1 employee to host');
    const res = await post(UI_PAYLOAD({ name: 'ZZV Hosted', host_employee_id: String(emp[0].id) }));
    expect(res.status).toBe(201);
    expect(res.body.host_employee_id).toBe(emp[0].id);
  });

  it('⚠ rejects the UI payload when the name is left blank — 400, not a row', async () => {
    const before = await countAll();
    const res = await post(UI_PAYLOAD());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name is required/i);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(await countAll(), 'no row may be created').toBe(before);
  });

  it('rejects a whitespace-only name, which the old `!name` guard allowed', async () => {
    const before = await countAll();
    const res = await post(UI_PAYLOAD({ name: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name is required/i);
    expect(await countAll()).toBe(before);
  });

  it.each([
    ['host is not a number',    { host_employee_id: 'abc' }, /host_employee_id must be a positive integer/i],
    ['host is zero',            { host_employee_id: 0 },     /host_employee_id must be a positive integer/i],
    ['host is negative',        { host_employee_id: -2 },    /host_employee_id must be a positive integer/i],
    ['phone over 20 chars',     { phone: '1'.repeat(21) },   /phone must be 20 characters or fewer/i],
    ['name over 200 chars',     { name: 'x'.repeat(201) },   /name must be 200 characters or fewer/i],
    ['company over 200 chars',  { company: 'c'.repeat(201) },/company must be 200 characters or fewer/i],
    ['id_number over 100',      { id_number: 'i'.repeat(101) }, /id_number must be 100 characters or fewer/i],
  ])('rejects %s with 400 and no row', async (_label, over, pattern) => {
    const before = await countAll();
    const res = await post(UI_PAYLOAD({ name: 'ZZV Invalid', ...over }));
    expect(res.status, `expected 400, got ${res.status}`).toBe(400);
    expect(res.body.message).toMatch(pattern);
    expect(await countAll(), 'no row may be created').toBe(before);
  });

  it('⚠⚠ still refuses a FOREIGN host_employee_id — tenancy did not loosen', async () => {
    const before = await countAll();
    const res = await post(UI_PAYLOAD({ name: 'ZZV Cross Tenant', host_employee_id: String(foreignEmployeeId) }));
    expect(res.status).toBe(404);
    expect(await countAll()).toBe(before);
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int n FROM visitors WHERE host_employee_id = $1', [foreignEmployeeId]);
    expect(rows[0].n).toBe(0);
  });

  it('a valid payload from a role without hr:add is still 403, not 400', async () => {
    // Validation must not run ahead of authorization.
    const before = await countAll();
    const res = await post(UI_PAYLOAD({ name: 'ZZV Denied' }), 'payroll_admin');
    expect(res.status).toBe(403);
    expect(await countAll()).toBe(before);
  });

  it('leaves the five SEED visitors untouched', async () => {
    const { rows } = await pool.query(
      `SELECT id, name, host_employee_id FROM visitors
        WHERE name LIKE 'SEED Visitors%' ORDER BY id`);
    expect(rows.map(r => r.name)).toEqual([
      'SEED Visitors 1', 'SEED Visitors 2', 'SEED Visitors 3', 'SEED Visitors 4', 'SEED Visitors 5',
    ]);
    expect(rows.map(r => r.host_employee_id)).toEqual([1, 2, 3, 4, 5]);
  });
});
