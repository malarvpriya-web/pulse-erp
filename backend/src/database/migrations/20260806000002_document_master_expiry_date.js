/**
 * 20260806000002_document_master_expiry_date.js
 *
 * Automation Opportunity Audit §25.1 — document_master (Google Drive-backed,
 * module_type/linked_entity_type, revision history) has no expiry tracking
 * at all today; reminders are limited to AMC contracts and e-sign documents.
 * Adds a nullable expiry_date so it stays optional per document type — most
 * rows (drawings, specs, general attachments) will never set it; only
 * genuinely time-bound documents (certifications, licenses, contracts
 * uploaded as plain document_master rows rather than modeled as their own
 * AMC/e-sign entity) need to. Purely additive.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE document_master
      ADD COLUMN IF NOT EXISTS expiry_date DATE
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE document_master
      DROP COLUMN IF EXISTS expiry_date
  `);
}
