/**
 * 20260622000002_fix_finance_settings_state.js
 *
 * Patch company_settings finance module: if place_of_supply_state was
 * previously saved as 'Maharashtra', correct it to 'Karnataka' to match
 * Manifest Technologies' registered state (Bangalore, Karnataka, state code 29).
 *
 * Also ensures the 'finance' settings row exists so the status endpoint
 * can detect a configured state (creates a minimal row if none exists).
 */
export async function up(knex) {
  // 1. Correct any Maharashtra → Karnataka in saved finance settings
  await knex.raw(`
    UPDATE company_settings
    SET settings = jsonb_set(
      settings,
      '{place_of_supply_state}',
      '"Karnataka"'
    )
    WHERE module = 'finance'
      AND settings->>'place_of_supply_state' = 'Maharashtra'
  `).catch(() => {});

  // 2. If no finance settings row exists at all, seed a minimal one
  //    so the status endpoint can evaluate GST state correctness
  await knex.raw(`
    INSERT INTO company_settings (company_id, module, settings, updated_at)
    SELECT
      c.id,
      'finance',
      jsonb_build_object(
        'place_of_supply_state', 'Karnataka',
        'base_currency',         'INR',
        'fiscal_year_start_month','April'
      ),
      NOW()
    FROM companies c
    WHERE LOWER(c.name) LIKE '%manifest%'
    ON CONFLICT (company_id, module) DO NOTHING
  `).catch(() => {});
}

export async function down(knex) {
  // Intentionally empty — data corrections are not safely reversible
}
