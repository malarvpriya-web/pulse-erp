/**
 * 20260722000002_missing_integrations_bridges.js
 *
 * Adds three small bridge columns identified by a "Missing Integrations" pass
 * over the app's cross-module handoffs. Each closes a gap where one module
 * writes state that a sibling module has no column to read back.
 *
 * 1. sales_orders.production_completed_at — production order completion never
 *    surfaced back to the originating Sales Order; dispatch had no signal that
 *    production had actually finished. Additive-only (no existing order_status
 *    semantics touched, so none of the many `order_status IN (...)` report
 *    queries need updating).
 *
 * 2. amc_contracts.commissioning_workflow_id — commissioning's `amc_eligible`
 *    flag (set on warranty activation) had no forward link to the AMC contract
 *    system at all; nothing ever read it. This is the traceability column so
 *    a contract created off the back of a commissioning sign-off can record
 *    where it came from.
 *
 * 3. vendors.party_id — procurement's vendor master (`vendors`, integer PK)
 *    and Finance's party ledger (`parties`, uuid PK) had no join key in either
 *    direction (same class of gap already fixed for bills.supplier_id — see
 *    parties_schema_hardening). Backfilled by exact GSTIN match against
 *    vendor-type parties only, so vendor spend can be traced to the AP ledger
 *    going forward. Named `party_id` (not `supplier_id`) since, unlike bills,
 *    vendors had no pre-existing legacy integer column of that name to collide
 *    with — but the type is uuid, same as every other post-hardening link.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_missintg_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. sales_orders: production completion signal ──────────────────────────
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS production_completed_at TIMESTAMPTZ`);

  // ── 2. amc_contracts: commissioning traceability ────────────────────────────
  await safe(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS commissioning_workflow_id INTEGER REFERENCES commissioning_workflows(id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_amc_contracts_commissioning ON amc_contracts(commissioning_workflow_id)`);

  // ── 3. vendors <-> parties join key ─────────────────────────────────────────
  await safe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS party_id UUID REFERENCES parties(id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_vendors_party ON vendors(party_id)`);

  // Deterministic backfill: exact GSTIN match against vendor/both-type parties
  // only. No name-matching (would fabricate links) — same discipline as the
  // opportunity->project backfill in delivery_tracker_link.
  await safe(`
    UPDATE vendors v
       SET party_id = p.id
      FROM parties p
     WHERE v.party_id IS NULL
       AND v.gstin IS NOT NULL
       AND p.gstin = v.gstin
       AND (p.party_type ILIKE 'vendor' OR p.party_type ILIKE 'both')
       AND p.deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_vendors_party`);
  await knex.raw(`ALTER TABLE vendors DROP COLUMN IF EXISTS party_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_amc_contracts_commissioning`);
  await knex.raw(`ALTER TABLE amc_contracts DROP COLUMN IF EXISTS commissioning_workflow_id`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS production_completed_at`);
}
