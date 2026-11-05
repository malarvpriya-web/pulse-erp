/**
 * 20260928000002_employee_email_uniqueness.js
 *
 * `employees.company_email` is the de-facto identity of a person in Pulse: it is
 * the key `createEmployeeLogin` provisions the `users` row from, and the column
 * the employee-login policy is built on. It had no unique constraint.
 *
 * `addEmployee` now rejects a duplicate before inserting, but that check is a
 * check-then-act pair against a table it does not hold a lock on — two
 * simultaneous creates with the same address both read "no duplicate" and both
 * insert. The application check exists to produce a good error message; THIS is
 * what makes the invariant true.
 *
 * Per company, on LOWER(), and partial on a non-blank value — matching the
 * application check exactly, because a backstop that disagrees with the check it
 * backs is not a backstop:
 *
 *   - per company: `COALESCE(company_id, 0)`, since NULL never conflicts with
 *     NULL in a btree and an unscoped row is still a row;
 *   - on LOWER(): the application compares case-insensitively, and the login
 *     provisioner lower-cases the address before writing it to `users`;
 *   - partial: some rows carry '' rather than NULL (the INSERT defaults most
 *     text fields to the empty string), and '' is a legitimate repeat of "no
 *     company email recorded" — not a duplicate person.
 *
 * Verified 0 duplicates live before adding this, so it builds without a
 * pre-pass. The guard below reports any it finds by address rather than failing
 * with a bare index-build error.
 */

const UNIQ = 'employees_company_email_uniq';

export async function up(knex) {
  const { rows: dupes } = await knex.raw(`
    SELECT COALESCE(company_id, 0) AS company_id,
           LOWER(TRIM(company_email)) AS email,
           COUNT(*)::int AS n
      FROM employees
     WHERE NULLIF(TRIM(company_email), '') IS NOT NULL
     GROUP BY 1, 2
    HAVING COUNT(*) > 1
     ORDER BY n DESC`);
  if (dupes.length) {
    const detail = dupes.map(d => `company ${d.company_id}: ${d.email} x${d.n}`).join('; ');
    throw new Error(
      `Cannot add ${UNIQ}: duplicate company emails already exist — ${detail}. ` +
      `Merge or correct those employee records first, then re-run.`,
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQ}
        ON employees (COALESCE(company_id, 0), LOWER(TRIM(company_email)))
     WHERE NULLIF(TRIM(company_email), '') IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQ}`);
}
