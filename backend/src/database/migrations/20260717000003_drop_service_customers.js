/**
 * 20260717000003_drop_service_customers.js
 *
 * Drops `service_customers`, retired by 20260717000001 when the Service
 * Customers grid moved onto the CRM master (accounts 1-N contacts).
 *
 * Safe at audit time (2026-07-17): 0 rows, 0 inbound FKs, and the last readers
 * (GET/POST /servicedesk/customers) now query `contacts`. The route module's
 * inline CREATE TABLE was removed in the same change, so the table will not be
 * recreated on server boot.
 *
 * GUARDED: the drop is skipped if the table has somehow accumulated rows on
 * this database — dropping it would then be data loss, and that deserves a
 * human look rather than a silent DROP. `service_sites.customer_id` is left
 * alone: it is a plain INTEGER with no FK to this table.
 */

export async function up(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.service_customers') AS t`);
  if (!rows[0]?.t) return; // already gone / fresh DB

  const { rows: cnt } = await knex.raw(`SELECT COUNT(*)::int AS n FROM service_customers`);
  if (cnt[0].n > 0) {
    console.warn(
      `[20260717000003] service_customers has ${cnt[0].n} row(s) — skipping DROP. ` +
      `Migrate them into contacts/accounts, then drop the table manually.`
    );
    return;
  }

  await knex.raw(`DROP TABLE IF EXISTS service_customers`);
}

export async function down(knex) {
  // Recreated empty for rollback symmetry only — the data was already gone.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS service_customers (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT,
      phone         TEXT,
      company       TEXT,
      address       TEXT,
      customer_type TEXT DEFAULT 'Standard',
      contract_id   INTEGER,
      status        TEXT DEFAULT 'Active',
      company_id    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
