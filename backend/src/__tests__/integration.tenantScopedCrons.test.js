/**
 * integration.tenantScopedCrons.test.js
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * §170 fixed `deliveryFollowup.cron.js`, which resolved its notification
 * recipients from every active admin/manager in the database with no company
 * predicate at all. The sweep that found it found the class: `overdueReminders`
 * (finance) and `amcRenewal` (service) carried the IDENTICAL unscoped
 * `getReceivers()`.
 *
 * What each was disclosing across tenants:
 *   - overdueReminders — invoice/bill number, customer or vendor name, and the
 *     outstanding rupee balance, for every overdue row in every tenant.
 *   - amcRenewal — customer name and contract expiry, and the same values
 *     pushed out over WhatsApp through the real Meta Graph API, so in a
 *     configured environment the disclosure leaves the building entirely.
 *
 * Neither was reachable by any of the isolation sweeps that certified this
 * system's tenant boundary: those drive HTTP endpoints from a foreign token,
 * and a cron has no endpoint.
 *
 * A SECOND DEFECT, FOUND ONLY BY RUNNING IT
 * -----------------------------------------
 * `amcRenewal` queried `service_contracts WHERE status = 'Active'` — capital A,
 * case-sensitive — and every row in that table stores 'active'. That half of
 * the job matched ZERO rows and had never sent one reminder, while five live
 * contracts sat inside the renewal window. Same class as the vendor-status case
 * drift: the read layer lowercases, the writer did not. Pinned below.
 *
 * WHAT THIS SUITE REFUSES TO DO
 * -----------------------------
 * Pass vacuously. Every "did not leak" assertion is trivially true against a job
 * that notified nobody, so each cron asserts it did non-zero work BEFORE any
 * negative assertion is made.
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
const { runOverdueCheckNow } = await import('../jobs/overdueReminders.cron.js');
const { runAmcRenewalCheckNow } = await import('../jobs/amcRenewal.cron.js');

const AMC_DAYS = parseInt(process.env.AMC_RENEWAL_REMINDER_DAYS || '30', 10);

const TAG  = 'ZZTS';
const CO_A = 999911;
const CO_B = 999912;
const TYPES = ['ar_overdue', 'ap_overdue', 'amc_renewal', 'amc_contract_renewal'];

const fx = { users: [], invoices: [], bills: [], serviceContracts: [] };
// Everything these jobs write for rows that are NOT ours — this database holds
// five live service contracts inside the renewal window — is removed by id, so
// the suite cannot delete a notification that existed before it ran.
let notifMark = 0;
let whatsappMark = 0;

async function seedTenant(companyId, label, roleCode) {
  await pool.query(
    `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [companyId, `${TAG} tenant ${label}`, `${TAG}${label}`]
  );
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, role, is_active, company_id, must_change_password)
     VALUES ($1, 'user', true, $2, false) RETURNING id`,
    [`${TAG.toLowerCase()}.${roleCode}.${label}@example.test`, companyId]
  );
  fx.users.push(u.id);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, company_id)
     SELECT $1, r.id, $2 FROM roles r WHERE r.code = $3`,
    [u.id, companyId, roleCode]
  );
  return u.id;
}

async function notifiedAbout(type, referenceId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM notifications
     WHERE notification_type = $1 AND reference_id = $2 ORDER BY user_id`,
    [type, referenceId]
  );
  return rows.map((r) => r.user_id);
}

let financeA, financeB, serviceA, serviceB;
let invA, invB, billA, scA, scB, invDraftA;
let overdueCounters, amcCounters;

beforeAll(async () => {
  const { rows: [n] } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM notifications`);
  notifMark = Number(n.m);
  const { rows: [w] } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM whatsapp_log`).catch(() => ({ rows: [{ m: 0 }] }));
  whatsappMark = Number(w.m);

  financeA = await seedTenant(CO_A, 'A', 'finance_manager');
  financeB = await seedTenant(CO_B, 'B', 'finance_manager');
  serviceA = await seedTenant(CO_A, 'SA', 'service_manager');
  serviceB = await seedTenant(CO_B, 'SB', 'service_manager');

  const overdue = async (co, num) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO invoices (invoice_number, party_name, due_date, balance, status, company_id)
       VALUES ($1, $2, CURRENT_DATE - INTERVAL '10 day', 5000, 'pending', $3) RETURNING id`,
      [num, `${TAG} customer`, co]
    );
    fx.invoices.push(r.id);
    return r.id;
  };
  invA = await overdue(CO_A, `${TAG}-INV-A`);
  invB = await overdue(CO_B, `${TAG}-INV-B`);

  // A draft invoice, past due, carrying a balance. The predicate this replaced
  // excluded only ('paid','cancelled') and would have chased it as a real
  // receivable; INVOICE_VOID also names 'void' and 'draft'. No such row exists
  // in this database, so without seeding one the fix is untestable — and an
  // untestable fix is one a later edit can silently undo.
  const { rows: [d] } = await pool.query(
    `INSERT INTO invoices (invoice_number, party_name, due_date, balance, status, company_id)
     VALUES ($1, $2, CURRENT_DATE - INTERVAL '10 day', 9000, 'draft', $3) RETURNING id`,
    [`${TAG}-INV-DRAFT`, `${TAG} customer`, CO_A]
  );
  fx.invoices.push(d.id);
  invDraftA = d.id;

  const { rows: [b] } = await pool.query(
    `INSERT INTO bills (bill_number, party_name, due_date, balance, status, company_id)
     VALUES ($1, $2, CURRENT_DATE - INTERVAL '10 day', 3000, 'pending', $3) RETURNING id`,
    [`${TAG}-BILL-A`, `${TAG} vendor`, CO_A]
  );
  fx.bills.push(b.id);
  billA = b.id;

  // Stored lowercase, the way every real row in this table is stored — which is
  // exactly what the old `status = 'Active'` predicate could not match.
  const contract = async (co, name) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO service_contracts (customer_name, contract_type, status, start_date, end_date, company_id)
       VALUES ($1, 'AMC', 'active', CURRENT_DATE, CURRENT_DATE + ($2 * INTERVAL '1 day'), $3) RETURNING id`,
      [name, Math.max(1, AMC_DAYS - 1), co]
    );
    fx.serviceContracts.push(r.id);
    return r.id;
  };
  scA = await contract(CO_A, `${TAG} customer A`);
  scB = await contract(CO_B, `${TAG} customer B`);

  overdueCounters = await runOverdueCheckNow();
  amcCounters     = await runAmcRenewalCheckNow();
}, 120_000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM notifications WHERE id > $1 AND notification_type = ANY($2)`,
    [notifMark, TYPES]
  );
  if (fx.users.length) {
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::int[])`, [fx.users]);
    await pool.query(`DELETE FROM user_roles  WHERE user_id = ANY($1::int[])`, [fx.users]);
    await pool.query(`DELETE FROM users       WHERE id      = ANY($1::int[])`, [fx.users]);
  }
  if (fx.invoices.length) await pool.query(`DELETE FROM invoices WHERE id = ANY($1::int[])`, [fx.invoices]);
  if (fx.bills.length)    await pool.query(`DELETE FROM bills    WHERE id = ANY($1::int[])`, [fx.bills]);
  if (fx.serviceContracts.length) {
    await pool.query(`DELETE FROM service_contracts WHERE id = ANY($1::int[])`, [fx.serviceContracts]);
  }
  await pool.query(`DELETE FROM whatsapp_log WHERE id > $1`, [whatsappMark]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [[CO_A, CO_B]]);
});

describe('overdueReminders cron', () => {
  it('has an on-demand entry point and did non-zero work', () => {
    expect(typeof runOverdueCheckNow).toBe('function');
    // Asserted first: every leak assertion below is vacuously true against a
    // job that notified nobody.
    expect(overdueCounters.notified).toBeGreaterThan(0);
    expect(overdueCounters.companies).toBeGreaterThanOrEqual(2);
  });

  it('tells a tenant about its own overdue receivable', async () => {
    expect(await notifiedAbout('ar_overdue', invA)).toContain(financeA);
    expect(await notifiedAbout('ap_overdue', billA)).toContain(financeA);
  });

  it('does not chase a draft invoice as a real receivable', async () => {
    // 'draft' is in INVOICE_VOID beside 'cancelled' and 'void'; the predicate
    // this replaced named only paid/cancelled.
    expect(await notifiedAbout('ar_overdue', invDraftA)).toEqual([]);
  });

  it('does not disclose one tenant’s ledger to another', async () => {
    const aboutA = await notifiedAbout('ar_overdue', invA);
    const aboutB = await notifiedAbout('ar_overdue', invB);

    // Both directions — an empty second tenant cannot tell "scoped correctly"
    // from "notified nobody", and cannot catch the reverse leak at all.
    expect(aboutA).not.toContain(financeB);
    expect(aboutB).not.toContain(financeA);
    expect(aboutB).toContain(financeB);

    // The service-side receivers have no business in the finance ledger either.
    expect(aboutA).not.toContain(serviceB);
  });
});

describe('amcRenewal cron', () => {
  it('has an on-demand entry point and did non-zero work', () => {
    expect(typeof runAmcRenewalCheckNow).toBe('function');
    expect(amcCounters.notified).toBeGreaterThan(0);
    expect(amcCounters.companies).toBeGreaterThanOrEqual(2);
  });

  it('finds contracts stored with a lowercase status', async () => {
    // The predicate this replaced was `status = 'Active'`, and no row in this
    // table has ever been stored that way — so this half of the job matched
    // nothing at all. A count, not just a boolean: it has to find BOTH.
    expect(amcCounters.service_contracts).toBeGreaterThanOrEqual(2);
    expect(await notifiedAbout('amc_renewal', scA)).toContain(serviceA);
  });

  it('does not disclose one tenant’s customer to another', async () => {
    const aboutA = await notifiedAbout('amc_renewal', scA);
    const aboutB = await notifiedAbout('amc_renewal', scB);

    expect(aboutA).not.toContain(serviceB);
    expect(aboutB).not.toContain(serviceA);
    expect(aboutB).toContain(serviceB);

    // This one matters more than the in-app row: an unscoped receiver here is
    // also the WhatsApp recipient.
    expect(aboutA).not.toContain(financeB);
  });

  it('does not send the same reminder twice on the same day', async () => {
    const before = await notifiedAbout('amc_renewal', scA);
    await runAmcRenewalCheckNow();
    expect(await notifiedAbout('amc_renewal', scA)).toEqual(before);
  });
});
