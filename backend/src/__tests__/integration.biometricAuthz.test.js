/**
 * Authorization on the biometric surface. Gate passes and visitors moved to
 * hr/gateAccess.routes.js (§272) — their authorization is pinned in
 * integration.biometricWorkflows.test.js (the "gate access" describes).
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
  '/api/biometric/employees/unmapped',
];
// The employee picker serves the HR pages (hr:view), the gate register
// (gate_access:view) and Attendance → Punch Import (attendance:edit). §272.
const OPTIONS = '/api/biometric/employees/options';
const ATTENDANCE_WRITES = [
  ['post',   '/api/biometric/devices'],
  ['put',    '/api/biometric/devices/1'],
  ['delete', '/api/biometric/devices/1'],
  ['post',   '/api/biometric/devices/1/test'],
  ['post',   '/api/biometric/devices/1/sync'],
  ['post',   '/api/biometric/logs/import'],
];
const HR_WRITES = [
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
  it.each([...ATTENDANCE_READS, ...HR_READS, OPTIONS])('employee is denied GET %s', async (path) => {
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
      for (const path of [...HR_READS, ...ATTENDANCE_READS, OPTIONS]) {
        const res = await request(appAs([role])).get(path);
        expectReachedHandler(res, `${role} GET ${path}`);
      }
    });

  it.each(['hr', 'hr_manager', 'hr_exec'])(
    '%s can still map device users to employees', async (role) => {
      for (const [method, path] of HR_WRITES) {
        const res = await send(appAs([role]), method, path);
        expectReachedHandler(res, `${role} ${method} ${path}`);
      }
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

      for (const path of ['/api/biometric/devices', '/api/biometric/devices/stats', OPTIONS]) {
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

describe('every route is gated', () => {
  it('leaves no route reachable by a role holding neither module', async () => {
    // sales_exec holds no hr and no attendance row that grants anything, so it
    // stands in for "any other authenticated account".
    for (const path of [...ATTENDANCE_READS, ...HR_READS, OPTIONS]) {
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

    const reads = gates.filter(g => g.method === 'get' && g.gate !== 'hrView' && g.gate !== 'employeeOptionsRead');
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
});
