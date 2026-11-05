/**
 * 20260928000003_employee_office_id_not_null.js
 *
 * Final state of the Employee ID work: `employees.office_id` becomes NOT NULL.
 *
 * `20260928000001` deliberately stopped short of this, because 35 live rows had
 * no code and NOT NULL cannot be added over them. Those rows were backfilled by
 * `scripts/hr/backfill-employee-codes.mjs --apply` (reported, dry-run first,
 * approved) and re-verified: 45 of 45 employees now hold a code, 0 duplicates,
 * the 8 legacy `EMP001`-format codes untouched.
 *
 * ── Why NOT NULL is safe here and a strict CHECK is not ─────────────────────
 * The distinction matters, and it is the trap the first pass on this table
 * identified:
 *
 *   A CHECK is re-evaluated on every UPDATE of the row, `NOT VALID` included —
 *   so a CHECK demanding the canonical `EMP-0001` shape would reject the next
 *   edit to any of the 8 legacy `EMP001` employees. That is why
 *   `employees_office_id_format` accepts both shapes.
 *
 *   A NOT NULL constraint on a column that is never set back to NULL has no such
 *   effect. Every row satisfies it, no UPDATE in the codebase writes NULL to
 *   office_id (`updateEmployee` does not touch the column at all — it is absent
 *   from its field list, which is what already made an existing ID unchangeable
 *   through the Edit form), and the only writers are the shared generator and the
 *   validated caller-supplied path. So it constrains new INSERTs and nothing else.
 *
 * ── Guarded rather than assumed ─────────────────────────────────────────────
 * The migration re-counts the blanks itself. If anything has been inserted
 * without a code since the backfill, it fails with the ids rather than with
 * Postgres' bare "column contains null values" — and does not half-apply.
 *
 * SET NOT NULL takes a brief ACCESS EXCLUSIVE lock and scans the table. At this
 * size that is milliseconds; on a large table this is the statement to run in a
 * maintenance window.
 */

export async function up(knex) {
  const { rows: blanks } = await knex.raw(
    `SELECT id, COALESCE(company_id, 0) AS company_id, company_email
       FROM employees
      WHERE NULLIF(TRIM(office_id), '') IS NULL
      ORDER BY id`,
  );
  if (blanks.length) {
    const detail = blanks.slice(0, 20)
      .map(r => `#${r.id} (company ${r.company_id}, ${r.company_email || 'no email'})`)
      .join(', ');
    throw new Error(
      `Cannot set employees.office_id NOT NULL: ${blanks.length} row(s) still have no Employee ID — ` +
      `${detail}${blanks.length > 20 ? ', …' : ''}. ` +
      `Run: node scripts/hr/backfill-employee-codes.mjs --dry-run, review, then --apply.`,
    );
  }

  // Blank strings satisfy NOT NULL but are exactly as useless as NULL, and the
  // application treats them as missing. Tighten the existing format CHECK to
  // exclude them rather than adding a second constraint that says nearly the
  // same thing: '' does not match the pattern, so a non-null column plus this
  // CHECK means "present and well-formed".
  await knex.raw(`ALTER TABLE employees ALTER COLUMN office_id SET NOT NULL`);

  // Validate the format CHECK now that every row is known-good. It was added
  // NOT VALID so it would not fail over the pre-existing rows; they have all been
  // confirmed to match both accepted shapes, so the constraint can be promoted to
  // fully valid — which is what lets the planner trust it and makes a future
  // tightening honest about what it is changing.
  await knex.raw(`ALTER TABLE employees VALIDATE CONSTRAINT employees_office_id_format`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees ALTER COLUMN office_id DROP NOT NULL`);
  // A validated constraint cannot be un-validated; dropping and re-adding it
  // NOT VALID is the only way back, and is what 20260928000001's own `down`
  // expects to find.
  await knex.raw(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_office_id_format`);
  await knex.raw(`
    ALTER TABLE employees
      ADD CONSTRAINT employees_office_id_format
      CHECK (office_id IS NULL OR office_id ~ '^EMP-?[0-9]{3,}$')
      NOT VALID`);
}
