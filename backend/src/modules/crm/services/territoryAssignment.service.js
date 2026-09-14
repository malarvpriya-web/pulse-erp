/**
 * territoryAssignment.service.js — resolve which territory a record belongs to,
 * and therefore who owns it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sales_territories` had five consumers before 2026-09-03 and all five were
 * CRUD: a SELECT for the grid, an INSERT, an UPDATE, a DELETE and the CREATE
 * TABLE. Nothing read the table when a lead or opportunity was assigned, so the
 * Territories screen was a form over a table with no reader. The brief's
 * requirement is explicit — territory rules must actually influence assignment
 * — so this is the reader.
 *
 * MATCHING
 * --------
 * A territory declares any combination of `zones`, `cities`, `industries` and
 * `states` (all jsonb arrays) plus a free-text `region`. A record matches a
 * territory when EVERY dimension the territory declares is satisfied; a
 * dimension the territory leaves empty is "don't care", not "match nothing".
 * That direction matters: the opposite reading would make a territory that
 * names only a zone match no record at all, which is the shape of rule a sales
 * ops person will write first.
 *
 * SPECIFICITY BREAKS TIES, then `priority`, then id. A territory naming a city
 * beats one naming a zone, because whoever wrote the city rule meant it to be
 * the exception. Without a deterministic order the same lead would land in
 * different territories on different days depending on planner choices — the
 * kind of non-determinism nobody notices until commissions disagree.
 *
 * All matching is case- and whitespace-insensitive: the live data has 'Mumbai'
 * next to 'mumbai ' and both must reach the same territory.
 */

/** Case/space-insensitive membership over a jsonb text array. */
function contains(list, value) {
  if (!Array.isArray(list) || list.length === 0) return null;   // "don't care"
  if (value == null || String(value).trim() === '') return false;
  const want = String(value).trim().toLowerCase();
  return list.some((v) => String(v ?? '').trim().toLowerCase() === want);
}

/**
 * @param {object} territory row from sales_territories
 * @param {object} record    { zone, location, city, state, industry, region }
 * @returns {{ matched: boolean, specificity: number }}
 */
export function matchTerritory(territory, record) {
  const checks = [
    [territory.cities,     record.city ?? record.location, 4],   // most specific
    [territory.states,     record.state,                   3],
    [territory.zones,      record.zone,                    2],
    [territory.industries, record.industry,                1],
  ];

  let specificity = 0;
  let declaredAny = false;

  for (const [list, value, weight] of checks) {
    const r = contains(list, value);
    if (r === null) continue;            // territory does not constrain this dimension
    declaredAny = true;
    if (!r) return { matched: false, specificity: 0 };
    specificity += weight;
  }

  // `region` is legacy free text and is treated as one more optional dimension
  // so territories written before zones/cities existed keep working.
  if (territory.region && String(territory.region).trim()) {
    declaredAny = true;
    const want = String(territory.region).trim().toLowerCase();
    const got  = String(record.region ?? record.zone ?? '').trim().toLowerCase();
    if (!got || got !== want) return { matched: false, specificity: 0 };
    specificity += 2;
  }

  // A territory that constrains nothing is a catch-all, not a match-everything
  // accident: it matches, but at specificity 0 so any real rule outranks it.
  return { matched: declaredAny || true, specificity };
}

/**
 * The best-matching active territory for a record, or null.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number|null} companyId
 * @param {object} record { zone, location, city, state, industry, region }
 */
export async function resolveTerritory(db, companyId, record = {}) {
  if (companyId == null) return null;
  const { rows } = await db.query(
    `SELECT id, name, region, assigned_to, zones, cities, industries, states, priority
       FROM sales_territories
      WHERE company_id = $1 AND status = 'active'
      ORDER BY priority ASC, id ASC`,
    [companyId]
  );
  if (!rows.length) return null;

  let best = null;
  for (const t of rows) {
    const { matched, specificity } = matchTerritory(t, record);
    if (!matched) continue;
    if (!best ||
        specificity > best.specificity ||
        (specificity === best.specificity && t.priority < best.territory.priority)) {
      best = { territory: t, specificity };
    }
  }
  return best ? { ...best.territory, _specificity: best.specificity } : null;
}

/**
 * Territory + the employee who owns it, for the assignment pipeline.
 *
 * Returns `{ territory_id, assigned_to }`. `assigned_to` may be null when a
 * territory matches but has no owner — that is a real state (a territory can
 * exist before it is staffed) and the caller keeps its own fallback rather than
 * treating "no owner" as "no territory".
 */
export async function resolveTerritoryAssignment(db, companyId, record = {}) {
  const t = await resolveTerritory(db, companyId, record);
  if (!t) return { territory_id: null, assigned_to: null };

  // A territory owner must be a real, current employee. A stale assigned_to
  // pointing at someone who has left would otherwise route every new lead in
  // that region into a black hole.
  let ownerId = null;
  if (t.assigned_to != null) {
    const { rows } = await db.query(
      `SELECT id FROM employees
        WHERE id = $1 AND deleted_at IS NULL
          AND LOWER(COALESCE(status, 'active')) IN ('active','probation','notice')`,
      [t.assigned_to]
    );
    ownerId = rows[0]?.id ?? null;
  }
  return { territory_id: t.id, assigned_to: ownerId, territory_name: t.name };
}

export default { matchTerritory, resolveTerritory, resolveTerritoryAssignment };
