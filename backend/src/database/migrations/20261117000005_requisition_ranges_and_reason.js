/**
 * 20261117000005_requisition_ranges_and_reason.js — Jobs page review 2026-11-17.
 *
 * job_requisitions.experience_required / salary_range were free text ("3-5 yrs",
 * "12-18L"), while the opening raised from the requisition stores numeric
 * ranges. Nothing could carry the approved budget over to the opening or check
 * the opening against it. They are replaced by experience_min/max (years) and
 * salary_min/max (₹ per year). Both text columns were empty on every row
 * (checked before writing this), so nothing is lost; the copy below is for any
 * other database that does hold values it can parse.
 *
 * hiring_reason / replacing_employee_id / justification: what an approver needs
 * to decide — is this new headcount or a backfill, and why.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE job_requisitions
    ADD COLUMN IF NOT EXISTS experience_min integer,
    ADD COLUMN IF NOT EXISTS experience_max integer,
    ADD COLUMN IF NOT EXISTS salary_min numeric(14,2),
    ADD COLUMN IF NOT EXISTS salary_max numeric(14,2),
    ADD COLUMN IF NOT EXISTS hiring_reason varchar(20) NOT NULL DEFAULT 'new_position',
    ADD COLUMN IF NOT EXISTS replacing_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS justification text`);
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_requisitions_hiring_reason_check') THEN
      ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_hiring_reason_check
        CHECK (hiring_reason IN ('new_position', 'replacement'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_requisitions_ranges_check') THEN
      ALTER TABLE job_requisitions ADD CONSTRAINT job_requisitions_ranges_check
        CHECK ((experience_min IS NULL OR experience_min BETWEEN 0 AND 60)
           AND (experience_max IS NULL OR experience_max BETWEEN 0 AND 60)
           AND (experience_min IS NULL OR experience_max IS NULL OR experience_min <= experience_max)
           AND (salary_min IS NULL OR salary_min >= 0)
           AND (salary_max IS NULL OR salary_max >= 0)
           AND (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max));
    END IF;
  END $$`);

  // "3-5", "3 - 5 years" → 3 / 5. Anything else is left NULL.
  const hasText = await knex.raw(`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'job_requisitions' AND column_name = 'experience_required'`);
  if (hasText.rows.length) {
    await knex.raw(`UPDATE job_requisitions
       SET experience_min = (regexp_match(experience_required, '^\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})'))[1]::int,
           experience_max = (regexp_match(experience_required, '^\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})'))[2]::int
     WHERE experience_min IS NULL AND experience_required ~ '^\\s*\\d{1,2}\\s*-\\s*\\d{1,2}'
       AND (regexp_match(experience_required, '^\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})'))[1]::int
        <= (regexp_match(experience_required, '^\\s*(\\d{1,2})\\s*-\\s*(\\d{1,2})'))[2]::int`);
    await knex.raw(`ALTER TABLE job_requisitions
      DROP COLUMN IF EXISTS experience_required,
      DROP COLUMN IF EXISTS salary_range`);
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE job_requisitions
    ADD COLUMN IF NOT EXISTS experience_required varchar(100),
    ADD COLUMN IF NOT EXISTS salary_range varchar(100)`);
  await knex.raw(`ALTER TABLE job_requisitions
    DROP CONSTRAINT IF EXISTS job_requisitions_ranges_check,
    DROP CONSTRAINT IF EXISTS job_requisitions_hiring_reason_check,
    DROP COLUMN IF EXISTS justification,
    DROP COLUMN IF EXISTS replacing_employee_id,
    DROP COLUMN IF EXISTS hiring_reason,
    DROP COLUMN IF EXISTS salary_max,
    DROP COLUMN IF EXISTS salary_min,
    DROP COLUMN IF EXISTS experience_max,
    DROP COLUMN IF EXISTS experience_min`);
}
