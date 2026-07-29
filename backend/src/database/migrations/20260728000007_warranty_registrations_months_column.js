/**
 * Follow-up to 20260728000006 — warranty_registrations never had a
 * `warranty_months` column (that only existed on the now-superseded
 * `project_warranties`); commissioning.routes.js and projects.routes.js both
 * reference it. Caught by a live smoke test of the activate-warranty path
 * (INSERT failed: "column warranty_months does not exist") before this ever
 * reached a real user.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE warranty_registrations
      ADD COLUMN IF NOT EXISTS warranty_months INTEGER
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE warranty_registrations DROP COLUMN IF EXISTS warranty_months`);
}
