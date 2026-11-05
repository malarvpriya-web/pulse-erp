/**
 * 20260928000004_employee_office_id_canonical_format.js
 *
 * Tighten `employees_office_id_format` to the company's ACTUAL convention:
 *
 *     ^EMP[0-9]{3,}$        EMP001  EMP012  EMP013  EMP099  EMP100  EMP999  EMP1000
 *
 * and reject everything else, the hyphenated form included:
 *
 *     EMP-001   EMP-0013   EMP01   EMP1   'EMP 001'   EMPABC   ABC001
 *
 * ── Why this replaces 20260928000001's constraint ────────────────────────────
 * That one allowed `^EMP-?[0-9]{3,}$` — both the real `EMP001` shape and a
 * hyphenated `EMP-0001`. It was written believing the dashed form was canonical
 * and `EMP001` was legacy to be tolerated. That was backwards: `EMP001`…`EMP012`
 * predate the entire codebase change and ARE the convention. The 37 rows carrying
 * a hyphen (35 minted by the bad backfill, 2 by the recruitment path) were
 * renumbered by `scripts/hr/renumber-employee-codes.mjs --apply` before this
 * migration, so nothing is grandfathered and nothing needs to be.
 *
 * ── Why this does NOT break editing existing employees ───────────────────────
 * This is the trap the earlier passes documented from the other direction: a
 * CHECK is re-evaluated on every **UPDATE**, `NOT VALID` included — `NOT VALID`
 * only skips the initial table scan. So a CHECK that any live row fails turns
 * every later edit of that row into a 400: changing a phone number would be
 * rejected because of an Employee ID nobody was touching.
 *
 * The constraint is therefore added only AFTER every row satisfies it, and this
 * migration proves that itself rather than trusting the script: it counts the
 * offenders first and fails with their ids if any remain. Then it adds the
 * constraint and VALIDATEs it immediately — validation passing IS the proof that
 * no existing employee has become uneditable.
 *
 * `20260928000003` already set the column NOT NULL, which stays.
 */

const FMT = 'employees_office_id_format';
const CANON = '^EMP[0-9]{3,}$';

export async function up(knex) {
  const { rows: bad } = await knex.raw(
    `SELECT id, COALESCE(company_id, 0) AS company_id, office_id
       FROM employees
      WHERE office_id IS NOT NULL AND office_id !~ '${CANON}'
      ORDER BY id`);
  if (bad.length) {
    const detail = bad.slice(0, 20)
      .map(r => `#${r.id} (company ${r.company_id}) "${r.office_id}"`).join(', ');
    throw new Error(
      `Cannot tighten ${FMT}: ${bad.length} Employee ID(s) are not in the EMP001 convention — ` +
      `${detail}${bad.length > 20 ? ', …' : ''}. ` +
      `Run: node scripts/hr/renumber-employee-codes.mjs (dry run), review, then --apply.`,
    );
  }

  // Replaced rather than altered: Postgres has no ALTER CONSTRAINT for a CHECK
  // expression, and dropping then adding inside one migration is atomic.
  await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS ${FMT}`);
  await knex.raw(`
    ALTER TABLE employees
      ADD CONSTRAINT ${FMT}
      CHECK (office_id IS NULL OR office_id ~ '${CANON}')`);

  // Added VALID (no NOT VALID), so Postgres scans the table now and this
  // migration fails here rather than at some later UPDATE if the guard above ever
  // disagrees with reality. The `IS NULL` arm is redundant while the column is
  // NOT NULL, and kept so the constraint stays correct if that is ever relaxed.
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS ${FMT}`);
  // Restores what 20260928000001 created, so rolling back this migration leaves
  // the constraint 20260928000003's own `down` expects to find.
  await knex.raw(`
    ALTER TABLE employees
      ADD CONSTRAINT ${FMT}
      CHECK (office_id IS NULL OR office_id ~ '^EMP-?[0-9]{3,}$')
      NOT VALID`);
}
