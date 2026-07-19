/**
 * 20260630000002_email_templates_schema_fix.js
 * Adds missing columns to email_templates so recruitment repository
 * methods (createEmailTemplate, findEmailTemplates, etc.) don't error.
 *
 * The table was created with columns: name, category, stage_trigger, variables
 * The repository expects: template_name, template_type, variables_json, updated_at, deleted_at
 *
 * We add the new columns and backfill from existing ones.
 */
export async function up(knex) {
  // Add missing columns
  await knex.raw(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS template_name  TEXT`);
  await knex.raw(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS template_type  VARCHAR(100)`);
  await knex.raw(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS variables_json JSONB`);
  await knex.raw(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW()`);
  await knex.raw(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ`);

  // Backfill template_name from name
  await knex.raw(`UPDATE email_templates SET template_name = name WHERE template_name IS NULL AND name IS NOT NULL`).catch(() => {});
  // Backfill template_type from category or stage_trigger
  await knex.raw(`UPDATE email_templates SET template_type = COALESCE(category, stage_trigger) WHERE template_type IS NULL`).catch(() => {});
  // Backfill variables_json from variables
  await knex.raw(`UPDATE email_templates SET variables_json = variables WHERE variables_json IS NULL AND variables IS NOT NULL`).catch(() => {});
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE email_templates DROP COLUMN IF EXISTS template_name`);
  await knex.raw(`ALTER TABLE email_templates DROP COLUMN IF EXISTS template_type`);
  await knex.raw(`ALTER TABLE email_templates DROP COLUMN IF EXISTS variables_json`);
  await knex.raw(`ALTER TABLE email_templates DROP COLUMN IF EXISTS updated_at`);
  await knex.raw(`ALTER TABLE email_templates DROP COLUMN IF EXISTS deleted_at`);
}
