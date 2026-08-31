/**
 * 20260811000004_field_visits_customer_rating.js
 *
 * voc.routes.js documents auto-triggering a Voice-of-Customer survey after
 * "service visit" and "AMC visit" (TRIGGER_EVENTS in that file), but neither
 * ever fired — there was no capture point anywhere in field_visits for a
 * customer rating in the first place.
 *
 * field_visits.customer_rating/customer_feedback already exist on the live
 * database (confirmed via information_schema) but in neither this migration
 * history nor baseline.sql — untracked drift, added by some prior session
 * with nothing ever built against them (zero references anywhere in
 * frontend/backend). This migration exists so a fresh install / regenerated
 * baseline gets the same columns, using ADD COLUMN IF NOT EXISTS so it's a
 * safe no-op against the already-drifted live DB. INTEGER 1-5, matching the
 * existing convention on commissioning_workflows.customer_rating and
 * customer_portal_tickets.customer_rating (not the VoC table's 1-10 NPS scale).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE field_visits
      ADD COLUMN IF NOT EXISTS customer_rating INTEGER,
      ADD COLUMN IF NOT EXISTS customer_feedback TEXT
  `);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE field_visits
        ADD CONSTRAINT field_visits_customer_rating_check
        CHECK (customer_rating IS NULL OR (customer_rating BETWEEN 1 AND 5));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE field_visits
      DROP CONSTRAINT IF EXISTS field_visits_customer_rating_check
  `);
  await knex.raw(`
    ALTER TABLE field_visits
      DROP COLUMN IF EXISTS customer_rating,
      DROP COLUMN IF EXISTS customer_feedback
  `);
}
