/**
 * 20261116000002_rd_inputs_ticket_field_visit.js — §277.1.
 *
 * Service engineers raise R&D points from support tickets and field visits
 * (an AMC visit is a field visit with visit_type 'AMC' / an amc_contract_id).
 * Source 'service' existed in §277 with nothing to attach it to.
 *
 *   ticket_id       → support_tickets(id)  ON DELETE SET NULL
 *   field_visit_id  → field_visits(id)     ON DELETE SET NULL
 *   a 'service' input names a ticket or a visit (NOT VALID: new rows only)
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE rd_improvement_inputs
      ADD COLUMN IF NOT EXISTS ticket_id      INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS field_visit_id INTEGER REFERENCES field_visits(id)    ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE rd_improvement_inputs DROP CONSTRAINT IF EXISTS rd_inputs_service_has_record`);
  await knex.raw(`
    ALTER TABLE rd_improvement_inputs ADD CONSTRAINT rd_inputs_service_has_record
      CHECK (source <> 'service' OR ticket_id IS NOT NULL OR field_visit_id IS NOT NULL) NOT VALID`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS rd_inputs_ticket ON rd_improvement_inputs (ticket_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS rd_inputs_field_visit ON rd_improvement_inputs (field_visit_id) WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE rd_improvement_inputs DROP CONSTRAINT IF EXISTS rd_inputs_service_has_record`);
  await knex.raw(`ALTER TABLE rd_improvement_inputs DROP COLUMN IF EXISTS ticket_id, DROP COLUMN IF EXISTS field_visit_id`);
}
