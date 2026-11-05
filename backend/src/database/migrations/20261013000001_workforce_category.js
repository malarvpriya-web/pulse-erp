/**
 * 20261013000001 — Workforce Category: master list + employee reference.
 *
 * Workforce Analytics needs to answer "how many Housekeeping / Security /
 * Driver / Engineering staff do we have", and nothing on the employee record
 * says so. Designation cannot stand in for it: it is free text, filled on a
 * minority of records, and "Supervisor" belongs to several categories.
 *
 * WHAT THIS DOES
 *   1. Seeds WORKFORCE_CATEGORY as SHARED rows in master_values (company_id
 *      NULL), exactly as 20260916000010 seeded the other HR vocabularies.
 *      Tenants add their own through Settings -> Master Data like any other
 *      vocabulary. ON CONFLICT targets ux_master_values_type_company_value, so
 *      re-running is a no-op.
 *   2. Adds employees.workforce_category_id — NULLABLE, no default, no backfill.
 *      Every existing employee keeps every value it has and gets NULL here,
 *      which Workforce Analytics reports as "Not recorded". Categories are
 *      assigned by HR, never inferred.
 *   3. A real foreign key, ON DELETE RESTRICT. The other master_values
 *      vocabularies are referenced by NAME; this one is referenced by id, so a
 *      rename follows through to every employee and a hard delete of a value
 *      in use is refused by the database instead of silently clearing it.
 *   4. A trigger that checks what the FK cannot: the referenced row must be a
 *      WORKFORCE_CATEGORY, and either shared or owned by the employee's own
 *      company. The service validates the same thing first and returns a 400;
 *      this is the backstop for every other writer (scripts, imports, seeds).
 *      It deliberately does NOT require is_active: deactivating a category
 *      stops it being offered, it must not make the employees already filed
 *      under it unsaveable.
 *
 * NOT DONE HERE
 *   No employee is assigned a category. No Employment Type value is touched.
 */

const SEEDS = [
  'Engineering', 'Production', 'Quality', 'Service', 'Sales',
  'Administration', 'Housekeeping', 'Security', 'Driver',
];

export async function up(knex) {
  // 1. Shared seeds. `knex` is a pg shim: $1-style bindings only.
  for (let i = 0; i < SEEDS.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('WORKFORCE_CATEGORY', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [SEEDS[i], i + 1]
    );
  }

  // 2 + 3. The column and its foreign key. Nullable, no default: no existing
  // row is rewritten.
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS workforce_category_id INTEGER
        REFERENCES master_values(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_employees_workforce_category_id
      ON employees (workforce_category_id)
      WHERE workforce_category_id IS NOT NULL
  `);

  // 4. Type and tenant guard.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION employees_workforce_category_guard() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.workforce_category_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM master_values m
         WHERE m.id = NEW.workforce_category_id
           AND m.type = 'WORKFORCE_CATEGORY'
           AND (m.company_id IS NULL OR m.company_id = NEW.company_id)
      ) THEN
        RAISE EXCEPTION 'workforce_category_id % is not a workforce category available to company %',
          NEW.workforce_category_id, NEW.company_id
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_employees_workforce_category_guard ON employees`);
  await knex.raw(`
    CREATE TRIGGER trg_employees_workforce_category_guard
      BEFORE INSERT OR UPDATE OF workforce_category_id, company_id ON employees
      FOR EACH ROW EXECUTE FUNCTION employees_workforce_category_guard()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_employees_workforce_category_guard ON employees`);
  await knex.raw(`DROP FUNCTION IF EXISTS employees_workforce_category_guard()`);
  // Dropping the column drops its index and foreign key with it.
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS workforce_category_id`);
  // Only the shared seeds this migration created. A tenant's own categories
  // (company_id NOT NULL) are their data and are never removed by a rollback.
  await knex.raw(
    `DELETE FROM master_values
      WHERE type = 'WORKFORCE_CATEGORY' AND company_id IS NULL AND code IS NULL
        AND value = ANY ($1::text[])`,
    [SEEDS]
  );
}
