/**
 * 20260531000005_salary_structure_ctc_model.js
 *
 * Updates existing salary_structures rows so the Live Preview and payroll engine
 * use the correct Indian CTC model:
 *
 *   Basic            : fixed / 0      → percentage_of_ctc / 40
 *   Special Allowance: fixed / 0      → balancing (CTC − other earnings)
 *
 * Only touches rows where Basic is still the legacy fixed/0 form to avoid
 * overwriting structures that have already been manually edited.
 */

export async function up(knex) {
  await knex.raw(`
    UPDATE salary_structures
    SET components = (
      SELECT jsonb_agg(
        CASE
          -- Basic: fixed with value 0  →  percentage_of_ctc with value 40
          WHEN (comp->>'name') = 'Basic'
           AND (comp->>'calculation_type') = 'fixed'
           AND (comp->>'value')::numeric = 0
          THEN comp
            || '{"calculation_type":"percentage_of_ctc"}'::jsonb
            || jsonb_build_object('value', 40)

          -- Special Allowance: any fixed  →  balancing
          WHEN (comp->>'name') = 'Special Allowance'
           AND (comp->>'calculation_type') = 'fixed'
          THEN comp
            || '{"calculation_type":"balancing"}'::jsonb

          ELSE comp
        END
      )
      FROM jsonb_array_elements(components) AS comp
    ),
    updated_at = NOW()
    WHERE components IS NOT NULL
      AND jsonb_typeof(components) = 'array'
  `);
}

export async function down(knex) {
  await knex.raw(`
    UPDATE salary_structures
    SET components = (
      SELECT jsonb_agg(
        CASE
          WHEN (comp->>'name') = 'Basic'
           AND (comp->>'calculation_type') = 'percentage_of_ctc'
          THEN comp
            || '{"calculation_type":"fixed"}'::jsonb
            || jsonb_build_object('value', 0)

          WHEN (comp->>'name') = 'Special Allowance'
           AND (comp->>'calculation_type') = 'balancing'
          THEN comp
            || '{"calculation_type":"fixed"}'::jsonb
            || jsonb_build_object('value', 0)

          ELSE comp
        END
      )
      FROM jsonb_array_elements(components) AS comp
    ),
    updated_at = NOW()
    WHERE components IS NOT NULL
      AND jsonb_typeof(components) = 'array'
  `);
}
