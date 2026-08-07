/**
 * 20260806000005_customer_health_customer_id_uuid.js
 *
 * Automation Opportunity Audit §27.2 — extending /prescriptive to Sales/Service
 * surfaced that the whole Phase 49F Customer Health Score engine has never
 * written a single row: 20260616000030_customer_health_engine.js declared
 * customer_id as INTEGER on all three tables, but the real customer identity
 * space (parties.id) is uuid. calculateAndStore()'s INSERT has thrown on
 * every call since the feature shipped, silently caught by a bare
 * console.error — so customer_health_scores/_history/_alerts have been
 * empty in every environment, and every dashboard that reads them
 * (CEO/Sales/Service/Finance/Project) has always returned zero rows.
 * Safe to retype directly: the bug guarantees these tables hold 0 rows
 * everywhere this migration will ever run. No FK added — the original
 * migration didn't have one either (parties covers non-customer types too),
 * keeping this a narrow type fix, not a redesign.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE customer_health_scores
      ALTER COLUMN customer_id TYPE uuid USING customer_id::text::uuid
  `);
  await knex.raw(`
    ALTER TABLE customer_health_history
      ALTER COLUMN customer_id TYPE uuid USING customer_id::text::uuid
  `);
  await knex.raw(`
    ALTER TABLE customer_health_alerts
      ALTER COLUMN customer_id TYPE uuid USING customer_id::text::uuid
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE customer_health_scores
      ALTER COLUMN customer_id TYPE integer USING NULL
  `);
  await knex.raw(`
    ALTER TABLE customer_health_history
      ALTER COLUMN customer_id TYPE integer USING NULL
  `);
  await knex.raw(`
    ALTER TABLE customer_health_alerts
      ALTER COLUMN customer_id TYPE integer USING NULL
  `);
}
