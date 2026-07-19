/**
 * 20260713000002_drop_dead_crm_tables.js
 *
 * Removes the dead CRM "twin" table cluster. The app writes to and reads from
 * the canonical bare tables — accounts, leads, contacts, opportunities — while
 * this old crm_* family (a different, flatter schema) only ever held duplicated
 * seed data. As of 2026-07-13 the last stray reads (analytics / dashboard /
 * CEO intelligence / global search) were repointed to the canonical tables, so
 * these have ZERO code references and only self-referential foreign keys.
 *
 * Verified before writing this migration:
 *   - no foreign keys from any live table point into the cluster
 *   - no views depend on the cluster
 *   - intra-cluster FKs: crm_contacts->crm_accounts,
 *                        crm_opportunities->crm_leads,
 *                        crm_lead_activities->crm_leads
 *
 * Also drops `pipeline_stages` (0 rows, dead) — the live stage table is
 * `crm_pipeline_stages`, which is intentionally kept.
 *
 * Tables are dropped child-first (no CASCADE) so an unexpected dependency would
 * fail loudly rather than silently cascade.
 */
export async function up(knex) {
  // Children first
  await knex.raw(`DROP TABLE IF EXISTS crm_lead_activities`);
  await knex.raw(`DROP TABLE IF EXISTS crm_opportunities`);
  await knex.raw(`DROP TABLE IF EXISTS crm_contacts`);
  // Parents
  await knex.raw(`DROP TABLE IF EXISTS crm_leads`);
  await knex.raw(`DROP TABLE IF EXISTS crm_accounts`);
  // Independent dead table (live one is crm_pipeline_stages)
  await knex.raw(`DROP TABLE IF EXISTS pipeline_stages`);
}

export async function down() {
  // Intentionally irreversible. These were dead duplicates carrying only stale
  // seed data; recreating them would just reintroduce the schema drift this
  // migration removed. Restore from a backup if they are ever needed again.
}
