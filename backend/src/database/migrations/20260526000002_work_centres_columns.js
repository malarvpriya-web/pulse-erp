/**
 * 20260526000002_work_centres_columns.js
 *
 * Adds missing columns to work_centres that are required by bom.routes.js
 * but absent when the table was created by an older minimal schema.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE work_centres
      ADD COLUMN IF NOT EXISTS capacity_hours_per_day NUMERIC(6,2)  DEFAULT 8,
      ADD COLUMN IF NOT EXISTS cost_per_hour          NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS department             VARCHAR(100),
      ADD COLUMN IF NOT EXISTS status                 VARCHAR(20)   DEFAULT 'active'
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE work_centres
      DROP COLUMN IF EXISTS capacity_hours_per_day,
      DROP COLUMN IF EXISTS cost_per_hour,
      DROP COLUMN IF EXISTS department,
      DROP COLUMN IF EXISTS status
  `);
}
