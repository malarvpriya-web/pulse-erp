/**
 * integration.crmCustomerIntegrity.test.js — the CRM canonical-customer
 * invariants, against the REAL database.
 *
 * DELIBERATELY NOT MOCKED, for the same reason as integration.salesPartners:
 * everything asserted here is a property of the *schema* — a unique index, a
 * trigger, a tenant filter. A mocked pool would pass while the constraint was
 * absent, which is exactly how the failures below survived a "closed" audit.
 *
 * Each test corresponds to a defect that was live on 21 Aug 2026:
 *
 *  1. `accounts_company_normname_unique` had been silently dropped. Migration
 *     20260819000002 created it on `crm_norm_name(COALESCE(name, account_name))`;
 *     20260819000004 then ran `ALTER TABLE accounts DROP COLUMN account_name`,
 *     and Postgres removes every index whose expression mentions a dropped
 *     column — without an error. Duplicate-customer prevention was gone for two
 *     days and nothing noticed, because no test looked at indexes.
 *
 *  2. `accounts.party_id` was NOT NULL with a foreign key but never UNIQUE, so
 *     the "one party → at most one CRM account extension" rule was documentation
 *     rather than a constraint.
 *
 *  3. `quotations` could name three different customers at once — the seeding
 *     sweep produced a row whose opportunity resolved to one party, whose
 *     customer_id pointed at a second, and whose customer_name was a third.
 *
 *  4. `/crm/customer360/:partyId*` took the customer id straight from the URL
 *     and queried it unfiltered, so any authenticated user could read any
 *     tenant's customer profile and receivables.
 *
 * Self-cleaning in both directions: beforeAll sweeps ZZCRMTEST_ debris an
 * interrupted run may have left (the unique indexes under test would otherwise
 * make an abandoned row 409 every future run), afterAll removes this run's rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// Real DB credentials — see the note in integration.salesPartners.test.js.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error(
      'Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.'
    );
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }             = await import('../config/db.js');
const { default: customer360Routes } = await import('../modules/crm/routes/customer360.routes.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { makeToken }                 = await import('./helpers/tokens.js');

const app = buildApp(['/api/crm', verifyToken, customer360Routes]);

let ADMIN_ID;
const auth = () => `Bearer ${makeToken({ userId: ADMIN_ID, role: 'admin' })}`;

const TAG = 'ZZCRMTEST_';
const created = { quotations: [], opportunities: [], accounts: [], parties: [], companies: [], invoices: [] };

async function sweepDebris() {
  // Child-first. `LIKE 'ZZCRMTEST\_%'` — the underscore is a LIKE wildcard.
  await pool.query(`DELETE FROM quotations    WHERE quotation_number  LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM opportunity_stage_history WHERE opportunity_id IN
                      (SELECT id FROM opportunities WHERE opportunity_name LIKE 'ZZCRMTEST\\_%')`).catch(() => {});
  await pool.query(`DELETE FROM opportunities WHERE opportunity_name LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM invoices      WHERE invoice_number    LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM accounts      WHERE name              LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM parties       WHERE name              LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM companies     WHERE name              LIKE 'ZZCRMTEST\\_%'`).catch(() => {});
}

// Creates a party (+ optional account) inside a given company.
async function makeParty(companyId, name, code) {
  const { rows } = await pool.query(
    `INSERT INTO parties (company_id, name, party_type, party_code)
     VALUES ($1, $2, 'customer', $3) RETURNING id`,
    [companyId, name, code]
  );
  created.parties.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  await sweepDebris();
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
      WHERE u.is_active = true AND (u.logout_at IS NULL OR u.logout_at <= NOW()) AND us.company_id = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) IN ('admin','super_admin'))
      ORDER BY u.id LIMIT 1`
  );
  if (!rows[0]) throw new Error('No active company-scoped admin found — these tests need a seeded DB.');
  ADMIN_ID = rows[0].id;
});

afterAll(async () => {
  await sweepDebris();
});

// ── 1. Duplicate customer prevention lives in the database ────────────────────
describe('accounts duplicate prevention', () => {
  it('has a unique index on (company_id, normalised name)', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'accounts_company_normname_unique'`
    );
    expect(rows).toHaveLength(1);
    // Must not reference account_name: that column is GENERATED, and an index
    // expression naming it is dropped without warning the next time the column
    // is rebuilt — which is how this index disappeared before.
    expect(rows[0].indexdef).not.toMatch(/account_name/);
  });

  it('rejects a legal-form variant of an existing account name', async () => {
    const partyA = await makeParty(1, `${TAG}Acme Industries Pvt Ltd`, 'ZZCRMA');
    const partyB = await makeParty(1, `${TAG}Acme Industries Private Limited`, 'ZZCRMB');

    const a = await pool.query(
      `INSERT INTO accounts (company_id, name, party_id) VALUES (1, $1, $2) RETURNING id`,
      [`${TAG}Acme Industries Pvt Ltd`, partyA]
    );
    created.accounts.push(a.rows[0].id);

    // Same organisation under a different legal-form spelling and trailing dot.
    await expect(
      pool.query(
        `INSERT INTO accounts (company_id, name, party_id) VALUES (1, $1, $2)`,
        [`${TAG}Acme Industries Private Limited.`, partyB]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'accounts_company_normname_unique' });
  });

  it('allows one CRM account extension per party and refuses a second', async () => {
    const party = await makeParty(1, `${TAG}Solo Party`, 'ZZCRMS');
    const first = await pool.query(
      `INSERT INTO accounts (company_id, name, party_id) VALUES (1, $1, $2) RETURNING id`,
      [`${TAG}Extension One`, party]
    );
    created.accounts.push(first.rows[0].id);

    await expect(
      pool.query(
        `INSERT INTO accounts (company_id, name, party_id) VALUES (1, $1, $2)`,
        [`${TAG}Extension Two`, party]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'accounts_party_id_unique' });
  });
});

// ── 2. A quotation cannot disagree with its opportunity about the customer ────
describe('quotation ↔ opportunity party invariant', () => {
  let party, account, opportunity, otherParty;

  beforeAll(async () => {
    party      = await makeParty(1, `${TAG}Quote Customer`, 'ZZCRMQ');
    otherParty = await makeParty(1, `${TAG}Different Customer`, 'ZZCRMD');
    const a = await pool.query(
      `INSERT INTO accounts (company_id, name, party_id) VALUES (1, $1, $2) RETURNING id`,
      [`${TAG}Quote Customer`, party]
    );
    account = a.rows[0].id;
    created.accounts.push(account);
    const o = await pool.query(
      `INSERT INTO opportunities (opportunity_name, company_id, account_id, stage, expected_value)
       VALUES ($1, 1, $2, 'Proposal', 100000) RETURNING id`,
      [`${TAG}Quote Deal`, account]
    );
    opportunity = o.rows[0].id;
    created.opportunities.push(opportunity);
  });

  it('rejects a quotation whose customer is not the opportunity’s party', async () => {
    await expect(
      pool.query(
        `INSERT INTO quotations (quotation_number, company_id, customer_id, opportunity_id,
                                 quotation_date, total_amount, status)
         VALUES ($1, 1, $2, $3, CURRENT_DATE, 100000, 'draft')`,
        [`${TAG}Q1`, otherParty, opportunity]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('inherits the opportunity’s party when customer_id is omitted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO quotations (quotation_number, company_id, opportunity_id,
                               quotation_date, total_amount, status)
       VALUES ($1, 1, $2, CURRENT_DATE, 100000, 'draft')
       RETURNING id, customer_id, customer_name`,
      [`${TAG}Q2`, opportunity]
    );
    created.quotations.push(rows[0].id);
    expect(rows[0].customer_id).toBe(party);
    // customer_name is stamped from parties.name, so the denormalised copy
    // cannot drift from its own foreign key the way the seeded row did.
    expect(rows[0].customer_name).toBe(`${TAG}Quote Customer`);
  });

  it('re-stamps a stale customer_name rather than storing it', async () => {
    const { rows } = await pool.query(
      `INSERT INTO quotations (quotation_number, company_id, customer_id, customer_name,
                               quotation_date, total_amount, status)
       VALUES ($1, 1, $2, 'Somebody Else Entirely', CURRENT_DATE, 100000, 'draft')
       RETURNING id, customer_name`,
      [`${TAG}Q3`, party]
    );
    created.quotations.push(rows[0].id);
    expect(rows[0].customer_name).toBe(`${TAG}Quote Customer`);
  });
});

// ── 3. Customer 360 is tenant-scoped on every panel ───────────────────────────
describe('Customer 360 tenant isolation', () => {
  let foreignCompany, foreignParty, ownParty;

  beforeAll(async () => {
    const c = await pool.query(
      `INSERT INTO companies (name, code, is_active) VALUES ($1, 'ZZCRMX', true) RETURNING id`,
      [`${TAG}Foreign Tenant`]
    );
    foreignCompany = c.rows[0].id;
    created.companies.push(foreignCompany);
    foreignParty = await makeParty(foreignCompany, `${TAG}Foreign Customer`, 'ZZCRMF');
    const inv = await pool.query(
      `INSERT INTO invoices (invoice_number, company_id, customer_id, invoice_date, total_amount, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 9999999, 'pending') RETURNING id`,
      [`${TAG}SECRET`, foreignCompany, foreignParty]
    );
    created.invoices.push(inv.rows[0].id);

    const own = await pool.query(
      `SELECT id FROM parties WHERE company_id = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`
    );
    ownParty = own.rows[0]?.id;
  });

  // The panels a company-1 user must never be able to point at company-2 data.
  const PANELS = ['', '/pipeline', '/payments', '/aging', '/tickets', '/projects', '/service'];

  it.each(PANELS)('refuses a foreign party on /customer360/:partyId%s', async (panel) => {
    const res = await request(app)
      .get(`/api/crm/customer360/${foreignParty}${panel}`)
      .set('Authorization', auth());
    // 404 rather than 403 on purpose: whether an id exists in another tenant is
    // itself information this caller is not entitled to.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/Foreign Customer|9999999/);
  });

  it.each(PANELS)('still serves the caller’s own party on %s', async (panel) => {
    if (!ownParty) return; // seeded DB has no company-1 party — nothing to assert
    const res = await request(app)
      .get(`/api/crm/customer360/${ownParty}${panel}`)
      .set('Authorization', auth());
    expect(res.status).toBe(200);
  });

  it('404s a malformed party id instead of surfacing 22P02', async () => {
    const res = await request(app)
      .get('/api/crm/customer360/not-a-uuid')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});
