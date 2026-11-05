/**
 * 20260928000001_employee_id_integrity.js
 *
 * Employee ID (`employees.office_id`) had NO database-level protection at all.
 * The only unique indexes on the table were the primary key and
 * `employees_source_candidate_uniq`. Everything else was application-level, and
 * the application level was broken — `POST /employees` minted and inserted a
 * second 'EMP001' into company 1 on 2026-09-28, alongside employee id=1 which
 * had held that code since February. Verified live, then rolled back.
 *
 * Two guards, and one deliberate omission.
 *
 * ── 1. Unique per company, on LOWER(), partial on NOT NULL ──────────────────
 * Per COMPANY, not globally: Employee IDs are a company's own numbering and two
 * tenants may legitimately both have EMP-0001. On LOWER() because the
 * application's duplicate check compares case-insensitively, and an index that
 * disagrees with the check it backs is no backstop at all. Partial on
 * `office_id IS NOT NULL` because 24 live rows have none — a plain unique index
 * would permit those anyway (NULLs never conflict in btree), but writing the
 * predicate makes that intent explicit rather than incidental.
 *
 * `company_id` is nullable, and NULL never equals NULL in an index either, so
 * rows with no company are not constrained against each other. COALESCE(...,0)
 * closes that: an unscoped row is still a row, and the global generator branch
 * can still mint for it.
 *
 * ── 2. Format CHECK that accepts BOTH live families ─────────────────────────
 * `^EMP-?[0-9]{3,}$` matches the canonical 'EMP-0001' and the 8 legacy 'EMP001'
 * rows. It is NOT the strict canonical pattern, on purpose:
 *
 *   ⚠ A CHECK constraint is evaluated on every INSERT **and every UPDATE**,
 *     including with NOT VALID. NOT VALID only skips the initial full-table
 *     scan; it does not exempt the grandfathered rows from later writes. A
 *     strict `^EMP-[0-9]{4,}$` CHECK would therefore let the 8 legacy rows sit
 *     there and then 400 the moment HR edited one of those employees' phone
 *     numbers — a constraint that breaks editing the exact records it was added
 *     because of.
 *
 * So the DB rejects the shape of garbage that was actually reachable ('EMP0-1',
 * which the old generator was one row away from emitting) while leaving both
 * real families writable. The strict canonical format is enforced in
 * `shared/employeeCode.js`, which is the only thing that MINTS a code.
 *
 * ── The omission: no NOT NULL ───────────────────────────────────────────────
 * 24 live rows in company 1 have no office_id (created by
 * `scripts/security/pilot-provision.mjs`, which inserts employees directly and
 * never sets one). NOT NULL cannot be added until they are backfilled, and
 * backfilling is a data change that gets reported and approved, not smuggled
 * into a schema migration. `scripts/hr/backfill-employee-codes.mjs --dry-run`
 * previews it; the follow-up migration adds NOT NULL once it has run.
 */

const UNIQ = 'employees_office_id_company_uniq';
const FMT  = 'employees_office_id_format';

export async function up(knex) {
  // Report the duplicates rather than failing with a bare index-build error
  // three screens deep in a migration log.
  const { rows: dupes } = await knex.raw(`
    SELECT COALESCE(company_id, 0) AS company_id, LOWER(office_id) AS code, COUNT(*)::int AS n
      FROM employees
     WHERE office_id IS NOT NULL
     GROUP BY 1, 2
    HAVING COUNT(*) > 1
     ORDER BY n DESC`);
  if (dupes.length) {
    const detail = dupes.map(d => `company ${d.company_id}: ${d.code} x${d.n}`).join('; ');
    throw new Error(
      `Cannot add ${UNIQ}: duplicate Employee IDs already exist — ${detail}. ` +
      `Resolve them first (scripts/hr/backfill-employee-codes.mjs --report), then re-run.`,
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQ}
        ON employees (COALESCE(company_id, 0), LOWER(office_id))
     WHERE office_id IS NOT NULL`);

  // Idempotent: ADD CONSTRAINT has no IF NOT EXISTS, and a migration that
  // cannot be re-run on a partially-applied database is a migration that has to
  // be fixed by hand at the worst possible moment.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'employees'::regclass AND conname = '${FMT}'
      ) THEN
        ALTER TABLE employees
          ADD CONSTRAINT ${FMT}
          CHECK (office_id IS NULL OR office_id ~ '^EMP-?[0-9]{3,}$')
          NOT VALID;
      END IF;
    END $$;`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS ${FMT}`);
  await knex.raw(`DROP INDEX IF EXISTS ${UNIQ}`);
}
