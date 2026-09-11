/**
 * integration.deliveryFollowupCron.test.js
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The 2026-09-04 re-verification checked all seven procurement crons and
 * recorded, under check 22, that six "expose a manual entry point and all six
 * were run" while `deliveryFollowup` "is scheduled but has no on-demand entry
 * point". That was written down as an observation and left there.
 *
 * Because it could not be run, it was never run — and it was the only one of
 * the seven carrying three real defects:
 *
 *   1. NO TENANT SCOPING. `getReceivers()` selected every active admin/manager
 *      in the entire database and the caller then sent each of them a reminder
 *      naming a PO number and a supplier name. The audit's tenant sweep drove
 *      HTTP endpoints; a cron has no endpoint, so nothing in the sweep reached
 *      it. This is the same class as D1/D2/D3, in the one place they were not
 *      looked for.
 *   2. A PHANTOM ROLE CODE. The receiver list named 'procurement', which is not
 *      a role code in this system (they are procurement_manager and
 *      procurement_exec), so the one team this reminder is addressed to never
 *      received it. Check 05 diffed role strings against `SELECT code FROM
 *      roles` and reported zero phantom codes — it swept route middleware, not
 *      cron SQL.
 *   3. A STATUS LITERAL THAT MATCHES NOTHING. `status NOT IN ('completed',
 *      'cancelled')` — `purchase_orders.status` never holds 'completed'; an
 *      arrived order is 'received'. So a fully-received order stayed eligible
 *      and the buyer was chased for goods already in stock. Same shape as the
 *      `closed_won` defect this codebase already has a note about.
 *
 * WHAT THIS SUITE REFUSES TO DO
 * -----------------------------
 * Run against whatever the database happens to hold. Invoked as-is on this
 * database the job returns `{companies: 0, pos: 0, notified: 0}` — both live
 * orders are 'received' and neither falls in the window — and every assertion
 * below would be vacuously true. That is precisely the failure the sourcing
 * resolver hit: a test that silently declines to run reports a pass.
 *
 * So it seeds TWO populated tenants and asserts both directions of the
 * boundary, and it asserts a non-zero notified count first, so the suite fails
 * loudly if the fixture ever stops matching rather than going quietly green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
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

const { default: pool } = await import('../config/db.js');
const { runDeliveryFollowupCheckNow } = await import('../jobs/deliveryFollowup.cron.js');

// Same expression the job uses, so the fixture lands in the window the job asks
// for even if the env var is set.
const DAYS = parseInt(process.env.PO_DELIVERY_REMINDER_DAYS || '7', 10);

const TAG  = 'ZZDF';
const CO_A = 999907;
const CO_B = 999908;

const fx = { users: [], vendors: [], pos: [] };

async function seedCompany(companyId, label) {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [companyId, `${TAG} tenant ${label}`, `${TAG}${label}`]
  );

  const { rows: [vendor] } = await pool.query(
    `INSERT INTO vendors (vendor_name, company_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`${TAG} vendor ${label}`, companyId]
  );
  fx.vendors.push(vendor.id);

  // A procurement_manager — the role the old code's phantom 'procurement' could
  // never match — plus an admin, so the assertions can tell "scoped correctly"
  // from "notified nobody at all".
  const users = {};
  for (const code of ['procurement_manager', 'admin']) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, role, is_active, company_id, must_change_password)
       VALUES ($1, 'user', true, $2, false) RETURNING id`,
      [`${TAG.toLowerCase()}.${code}.${label}@example.test`, companyId]
    );
    fx.users.push(u.id);
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id, company_id)
       SELECT $1, r.id, $2 FROM roles r WHERE r.code = $3`,
      [u.id, companyId, code]
    );
    users[code] = u.id;
  }
  return { vendorId: vendor.id, users };
}

async function seedPo(companyId, vendorId, number, status) {
  const { rows: [po] } = await pool.query(
    `INSERT INTO purchase_orders (po_number, supplier_id, company_id, status, expected_delivery_date)
     VALUES ($1, $2, $3, $4, CURRENT_DATE + ($5 * INTERVAL '1 day')) RETURNING id`,
    [number, vendorId, companyId, status, DAYS]
  );
  fx.pos.push(po.id);
  return po.id;
}

/** Which of our seeded users were told about this PO. */
async function notifiedAbout(poId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM notifications
     WHERE notification_type = 'delivery_followup' AND reference_id = $1
     ORDER BY user_id`,
    [poId]
  );
  return rows.map((r) => r.user_id);
}

let A, B, poAOpen, poAReceived, poBOpen, counters;

beforeAll(async () => {
  A = await seedCompany(CO_A, 'A');
  B = await seedCompany(CO_B, 'B');

  poAOpen     = await seedPo(CO_A, A.vendorId, `${TAG}-A-OPEN`, 'approved');
  poAReceived = await seedPo(CO_A, A.vendorId, `${TAG}-A-RECV`, 'received');
  poBOpen     = await seedPo(CO_B, B.vendorId, `${TAG}-B-OPEN`, 'approved');

  counters = await runDeliveryFollowupCheckNow();
}, 60_000);

afterAll(async () => {
  if (fx.pos.length) {
    await pool.query(
      `DELETE FROM notifications WHERE notification_type='delivery_followup' AND reference_id = ANY($1::int[])`,
      [fx.pos]
    );
    await pool.query(`DELETE FROM purchase_orders WHERE id = ANY($1::int[])`, [fx.pos]);
  }
  if (fx.users.length) {
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::int[])`, [fx.users]);
    await pool.query(`DELETE FROM user_roles  WHERE user_id = ANY($1::int[])`, [fx.users]);
    await pool.query(`DELETE FROM users       WHERE id      = ANY($1::int[])`, [fx.users]);
  }
  if (fx.vendors.length) {
    await pool.query(`DELETE FROM vendors WHERE id = ANY($1::int[])`, [fx.vendors]);
  }
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [[CO_A, CO_B]]);
});

describe('deliveryFollowup cron', () => {
  it('has an on-demand entry point that reports what it did', () => {
    // Check 22 recorded this as the one cron without one. Without it the job
    // cannot be exercised, and everything below is unreachable.
    expect(typeof runDeliveryFollowupCheckNow).toBe('function');
    expect(counters).toMatchObject({
      companies: expect.any(Number),
      pos: expect.any(Number),
      notified: expect.any(Number),
    });
  });

  it('actually did work — the fixture is in the window', () => {
    // Asserted BEFORE the boundary checks on purpose. Every "did not leak"
    // assertion below passes trivially against a job that notified nobody, so
    // a fixture that stops matching has to fail here rather than pass there.
    expect(counters.notified).toBeGreaterThan(0);
    expect(counters.companies).toBeGreaterThanOrEqual(2);
  });

  it('notifies the tenant that owns the order — including its procurement team', async () => {
    const told = await notifiedAbout(poAOpen);
    expect(told).toContain(A.users.procurement_manager);
    expect(told).toContain(A.users.admin);
  });

  it('does not tell one tenant about the purchase order of another', async () => {
    const toldAboutA = await notifiedAbout(poAOpen);
    const toldAboutB = await notifiedAbout(poBOpen);

    // Both directions. An empty second tenant cannot tell "correctly scoped"
    // from "returns nothing to anybody", and cannot catch the reverse leak.
    expect(toldAboutA).not.toContain(B.users.procurement_manager);
    expect(toldAboutA).not.toContain(B.users.admin);
    expect(toldAboutB).not.toContain(A.users.procurement_manager);
    expect(toldAboutB).not.toContain(A.users.admin);

    expect(toldAboutB).toContain(B.users.procurement_manager);
  });

  it('does not chase a purchase order that has already been received', async () => {
    // 'received' is the state an arrived order reaches. The predicate this
    // replaced excluded 'completed', a value the column never holds.
    expect(await notifiedAbout(poAReceived)).toEqual([]);
  });

  it('does not send the same reminder twice on the same day', async () => {
    const before = await notifiedAbout(poAOpen);
    await runDeliveryFollowupCheckNow();
    expect(await notifiedAbout(poAOpen)).toEqual(before);
  });
});
