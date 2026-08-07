/**
 * 20260806000001_sla_policies_missing_columns.js
 *
 * servicedesk.routes.js's SLA-policy CRUD (POST/PUT /sla/policies) and one of
 * its two dashboard SLA-status queries assume sla_policies has
 * first_response_hours/resolution_hours/escalation_hours/business_hours_only.
 * The live table only ever had an older-generation shape:
 * response_time_hours/resolution_time_hours/is_active (still correctly read
 * by finance/repositories/ticket.repository.js and the file's OTHER
 * dashboard SLA-status query — a half-completed column rename, not a dead
 * twin, so those call sites are left untouched). Every POST/PUT to
 * /sla/policies has been throwing "column ... does not exist" and 500ing —
 * confirmed live: zero rows exist in sla_policies despite the feature having
 * a full settings UI, because no create/update has ever actually landed.
 * Discovered while building the Automation Opportunity Audit's §19.2 SLA
 * escalation cron, which needs escalation_hours to exist as a real,
 * settable-per-policy column to have anything to read.
 *
 * Purely additive, same approach as 20260805000006's crm_settings fix: the
 * old columns aren't renamed or dropped, so nothing that already reads them
 * breaks.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE sla_policies
      ADD COLUMN IF NOT EXISTS first_response_hours   NUMERIC DEFAULT 4,
      ADD COLUMN IF NOT EXISTS resolution_hours        NUMERIC DEFAULT 24,
      ADD COLUMN IF NOT EXISTS escalation_hours         NUMERIC DEFAULT 8,
      ADD COLUMN IF NOT EXISTS business_hours_only      BOOLEAN DEFAULT true
  `);
  // Backfill from the old-generation columns for any pre-existing rows, so a
  // policy created before this migration doesn't silently read the bare
  // column defaults instead of its own already-configured values.
  await knex.raw(`
    UPDATE sla_policies
       SET first_response_hours = COALESCE(first_response_hours, response_time_hours),
           resolution_hours     = COALESCE(resolution_hours, resolution_time_hours)
     WHERE response_time_hours IS NOT NULL OR resolution_time_hours IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE sla_policies
      DROP COLUMN IF EXISTS first_response_hours,
      DROP COLUMN IF EXISTS resolution_hours,
      DROP COLUMN IF EXISTS escalation_hours,
      DROP COLUMN IF EXISTS business_hours_only
  `);
}
