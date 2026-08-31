/**
 * 20260811000005_projects_closure_customer_rating.js
 *
 * Third and last of voc.routes.js's documented but never-fired trigger
 * events: 'project_closure' (the other two, 'commissioning' and
 * 'service_visit'/'amc_visit', were wired in
 * 20260811000004_field_visits_customer_rating.js and the commissioning
 * sign-off route). No existing column on `projects` captures a client's
 * closure-time satisfaction, unlike commissioning_workflows/field_visits.
 * projects.repository.js's update() uses pickUpdatable('projects', data) —
 * a schema-derived whitelist, not a hardcoded column list — so these two
 * columns become writable via the existing PUT /projects/:id the moment
 * they exist, no repository change required.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS customer_rating INTEGER,
      ADD COLUMN IF NOT EXISTS customer_feedback TEXT
  `);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE projects
        ADD CONSTRAINT projects_customer_rating_check
        CHECK (customer_rating IS NULL OR (customer_rating BETWEEN 1 AND 5));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE projects
      DROP CONSTRAINT IF EXISTS projects_customer_rating_check
  `);
  await knex.raw(`
    ALTER TABLE projects
      DROP COLUMN IF EXISTS customer_rating,
      DROP COLUMN IF EXISTS customer_feedback
  `);
}
