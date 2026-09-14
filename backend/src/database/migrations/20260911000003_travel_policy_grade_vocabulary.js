/**
 * One grade vocabulary: fold travel policy's L1-L6 onto `master_grades`.
 *
 * `travel-policy.routes.js` resolves an employee's expense limits by reading
 * `employees.grade` and matching it against `travel_policy_rules.grade`:
 *
 *     SELECT grade, designation, department FROM employees WHERE id=$1
 *     ...  AND (grade=$2 OR role=$3 OR department=$4)
 *
 * Those two columns were populated from different vocabularies:
 *
 *   master_grades           G1 … G7   (seeds/defaultSeed.js, validated against
 *                                      employees.grade on every save)
 *   travel_policy_rules     L1 … L6   (phase-47 migration seed)
 *
 * so a grade rule could never match an employee and every request silently fell
 * through to the role/department rules — or to no rule at all. Same defect class
 * as the opportunity-stage and vendor-status drifts: an equality join across two
 * spellings of the same concept fails quietly, it does not error.
 *
 * It was unreachable until now only because `employees.grade` was NULL on every
 * row — no form wrote it. Wiring the Grade picker into the employee form (and
 * fixing updateEmployee, which validated the column and then never wrote it)
 * makes the grade path live, which makes this mismatch live too.
 *
 * `master_grades` wins. It is the master table: it has CRUD in Master Setup, it
 * is company-scoped, and `employee.service.js` already validates every saved
 * grade against it. `travel_policy_rules.grade` is free text in a downstream
 * module.
 *
 * MAPPING ASSUMPTION, stated because it is a judgement call: both scales are
 * seeded in ascending seniority — L1 'Junior Engineer' → L6 'Director / VP', and
 * G1 → G7 in that order — so Ln maps to Gn. G7 is left with no travel rule
 * rather than inventing limits for it; that grade falls through to the role and
 * department rules exactly as any unconfigured grade does, and an admin can add
 * a G7 rule from the Travel Policy screen.
 *
 * The screen's grade field is a <MasterSelect> over /master/grades now, so a new
 * rule can only be written against a value the master actually holds.
 */

// Ln → Gn, in ascending seniority on both sides.
const GRADE_MAP = { L1: 'G1', L2: 'G2', L3: 'G3', L4: 'G4', L5: 'G5', L6: 'G6' };

export async function up(knex) {
  const { rows: tableThere } = await knex.raw(`
    SELECT to_regclass('public.travel_policy_rules') IS NOT NULL AS present
  `);
  if (!tableThere?.[0]?.present) {
    console.log('[20260911000003] travel_policy_rules absent — nothing to migrate');
    return;
  }

  // Only remap onto a grade the master actually holds. On a database whose
  // grades have been renamed, leaving the L-value untouched is the honest
  // outcome — it stays visibly unmatched instead of pointing at a grade that
  // does not exist.
  const { rows: masterGrades } = await knex.raw(`SELECT name FROM master_grades WHERE is_active = true`);
  const known = new Set(masterGrades.map(r => r.name));

  let moved = 0;
  const skipped = [];
  for (const [from, to] of Object.entries(GRADE_MAP)) {
    if (!known.has(to)) { skipped.push(`${from}→${to}`); continue; }
    const { rows } = await knex.raw(
      `UPDATE travel_policy_rules SET grade = $1 WHERE grade = $2 RETURNING id`,
      [to, from]
    );
    moved += rows?.length ?? 0;
  }

  if (moved) console.log(`[20260911000003] remapped ${moved} travel policy rule(s) onto master_grades`);
  if (skipped.length) {
    console.log(`[20260911000003] left alone (target grade not in master_grades): ${skipped.join(', ')}`);
  }

  const { rows: orphans } = await knex.raw(`
    SELECT grade, count(*)::int AS n
      FROM travel_policy_rules
     WHERE rule_type = 'grade'
       AND grade IS NOT NULL
       AND grade NOT IN (SELECT name FROM master_grades WHERE is_active = true)
     GROUP BY grade
  `);
  if (orphans?.length) {
    console.log(`[20260911000003] ⚠ grade rules still outside the master: ${orphans.map(o => `${o.grade}×${o.n}`).join(', ')}`);
  }
}

/**
 * No down. Restoring L1-L6 reinstates a vocabulary nothing else in the database
 * uses, and re-breaks the join this exists to repair.
 */
export async function down() {
  // intentionally empty
}
