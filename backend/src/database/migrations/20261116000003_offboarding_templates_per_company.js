/**
 * 20261116000003_offboarding_templates_per_company.js — HR audit 2026-11-16, B2.
 *
 * hr_offboarding_checklist_templates had no company_id: every company read the
 * same checklist, and PUT /hr/offboarding/templates deactivated ALL companies'
 * rows before writing its own — one company's save wiped everyone else's.
 *
 * - company_id (nullable). Existing rows stay NULL = the shared default, which a
 *   company sees only until it saves a checklist of its own. Nothing is deleted.
 * - UNIQUE (category, item_label) becomes UNIQUE NULLS NOT DISTINCT
 *   (company_id, category, item_label): two companies may use the same item, and
 *   the shared default keeps one row per item. Needs PostgreSQL 15+ (dev: 18).
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE hr_offboarding_checklist_templates
                    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id)`);
  await knex.raw(`ALTER TABLE hr_offboarding_checklist_templates
                    DROP CONSTRAINT IF EXISTS hr_offboarding_checklist_templates_category_item_label_key`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_offboarding_templates_company_item_key') THEN
        ALTER TABLE hr_offboarding_checklist_templates
          ADD CONSTRAINT hr_offboarding_templates_company_item_key
          UNIQUE NULLS NOT DISTINCT (company_id, category, item_label);
      END IF;
    END $$`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hr_offboarding_templates_company
                    ON hr_offboarding_checklist_templates (company_id) WHERE is_active`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_hr_offboarding_templates_company`);
  await knex.raw(`ALTER TABLE hr_offboarding_checklist_templates
                    DROP CONSTRAINT IF EXISTS hr_offboarding_templates_company_item_key`);
  // Company rows would collide on the old global key; keep only the shared default.
  await knex.raw(`DELETE FROM hr_offboarding_checklist_templates WHERE company_id IS NOT NULL`);
  await knex.raw(`ALTER TABLE hr_offboarding_checklist_templates
                    ADD CONSTRAINT hr_offboarding_checklist_templates_category_item_label_key
                    UNIQUE (category, item_label)`);
  await knex.raw(`ALTER TABLE hr_offboarding_checklist_templates DROP COLUMN IF EXISTS company_id`);
}
