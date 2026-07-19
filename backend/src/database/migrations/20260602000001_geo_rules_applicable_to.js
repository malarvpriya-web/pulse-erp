/**
 * 20260602000001_geo_rules_applicable_to.js
 *
 * Adds applicable_to + applicable_department to attendance_geo_rules so that
 * a zone can be scoped to "all employees", a specific department, or be left
 * open for future per-employee targeting.
 *
 * applicable_to: 'all' | 'department'
 * applicable_department: department name string, used when applicable_to = 'department'
 *
 * Existing rows default to 'all' (no change in enforcement behaviour).
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE attendance_geo_rules
      ADD COLUMN IF NOT EXISTS applicable_to        VARCHAR(20)  NOT NULL DEFAULT 'all'
        CHECK (applicable_to IN ('all', 'department')),
      ADD COLUMN IF NOT EXISTS applicable_department VARCHAR(100);
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE attendance_geo_rules
      DROP COLUMN IF EXISTS applicable_department,
      DROP COLUMN IF EXISTS applicable_to;
  `);
}
