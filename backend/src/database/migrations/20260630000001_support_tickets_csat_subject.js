/**
 * 20260630000001_support_tickets_csat_subject.js
 * Add csat_rating to support_tickets.
 * Fixes service-analytics dashboard/engineer queries that reference this column.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_rating NUMERIC(3,2)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS csat_rating`);
}
