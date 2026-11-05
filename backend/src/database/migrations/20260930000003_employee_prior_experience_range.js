/**
 * 20260930000003 — a believable range for prior-service years.
 *
 * `employees.previous_years_1` / `previous_years_2` are plain integer columns
 * with nothing to say about what an integer may be. One live record held
 * `previous_years_2 = 123`, and View Employee's Overview dutifully added it to
 * the service-here figure and displayed **"124 years"** of total experience.
 *
 * The service layer now rejects anything outside 0–60 on both the create and
 * the update path. This is the backstop: application validation is a
 * check-then-act pair the database does not participate in, and every other
 * writer — a script, a seed, a future import — bypasses it entirely.
 *
 * NOT VALID, deliberately: it checks every new write and every UPDATE of an
 * existing row without demanding that historical rows pass first. There is
 * nothing to grandfather right now (the one bad row was corrected to 0 on
 * 2026-09-30), but the pattern matters — a plain ADD CONSTRAINT here would make
 * this migration fail on any deployment that still holds one, which is exactly
 * the database that most needs the constraint.
 *
 * 60 rather than 50: a 78-year-old who started at 18 is implausible but not
 * impossible, and a constraint that rejects a true value is worse than one that
 * lets an unlikely one through. It is a typo catcher, not a policy.
 */

const CHECKS = [
  ['employees_previous_years_1_range', 'previous_years_1'],
  ['employees_previous_years_2_range', 'previous_years_2'],
];

export async function up(knex) {
  const { rows: bad } = await knex.raw(`
    SELECT id, office_id, previous_years_1, previous_years_2
      FROM employees
     WHERE previous_years_1 < 0 OR previous_years_1 > 60
        OR previous_years_2 < 0 OR previous_years_2 > 60
     ORDER BY id`);
  if (bad.length) {
    // Reported, not rewritten: which figure is correct is HR's call, not a
    // migration's. NOT VALID means these rows do not block the constraint.
    console.warn(
      `[20260930000003] ${bad.length} employee row(s) hold a prior-service figure outside 0-60 ` +
      `and are grandfathered by NOT VALID: ` +
      bad.map(b => `${b.office_id || b.id} (${b.previous_years_1}/${b.previous_years_2})`).join(', '),
    );
  }

  for (const [name, column] of CHECKS) {
    await knex.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'employees'::regclass AND conname = '${name}'
        ) THEN
          ALTER TABLE employees
            ADD CONSTRAINT ${name}
            CHECK (${column} IS NULL OR (${column} >= 0 AND ${column} <= 60)) NOT VALID;
        END IF;
      END $$;
    `);
  }
}

export async function down(knex) {
  for (const [name] of CHECKS) {
    await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS ${name}`);
  }
}
