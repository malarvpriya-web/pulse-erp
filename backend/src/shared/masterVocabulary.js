/**
 * masterVocabulary.js — server-side reads of the master vocabularies.
 *
 * WHY
 * ---
 * Three route modules validated `service_type` / `project_type` against a
 * hardcoded `PROJECT_TYPES` array, and three validated `zone` against a
 * hardcoded `['North','South','East','West','Central']`. §172 moved both of
 * those vocabularies behind a master a user can extend from the form that needs
 * them — which leaves a gap the frontend change alone does not close:
 *
 *   complaints.routes.js did `PROJECT_TYPES.includes(body.service_type) ? … : null`
 *
 * so a project type added through the new picker would have been accepted by the
 * master, offered in the dropdown, chosen by the user, and then written as NULL.
 * A validator that does not read the master is not a validator, it is a second
 * master that silently disagrees with the first.
 *
 * CACHING
 * -------
 * These lists change when an administrator adds a value, which is rare, and they
 * are consulted on ordinary write paths, which is not. Each (type, company) pair
 * is cached for TTL_MS. Every successful write through the master router
 * (modules/master/master.routes.js) calls invalidateVocabularyCache() before it
 * responds, so a value added, renamed or retired there is seen by the very next
 * validation in this process. The TTL remains the bound for writes made by
 * another backend instance or outside the API (migrations, scripts).
 *
 * FALLBACK
 * --------
 * Every getter takes the list it replaced as its fallback and returns it if the
 * query fails. A database blip must not turn every zone and service type in an
 * incoming request into NULL — refusing to narrow is the safe direction here,
 * since these values are recorded, not authorising.
 */

import pool from '../config/db.js';

const TTL_MS = 60_000;
const cache = new Map();   // `${type}:${companyId}` → { at, values }

/**
 * Masters that predate `master_values` and live in their own table. Zones,
 * departments and designations each got a table of their own in §170 and are
 * not going to be folded into master_values — moving them would break the
 * `/master/:type` routes and every picker already reading them. So the lookup
 * knows about both shapes rather than pretending there is only one.
 *
 * None of these three tables carries a company_id, hence `scoped: false`.
 */
const TABLE_BACKED = {
  ZONE:        { table: 'master_zones',        column: 'name', scoped: false },
  DEPARTMENT:  { table: 'master_departments',  column: 'name', scoped: false },
  DESIGNATION: { table: 'master_designations', column: 'name', scoped: false },
};

export function invalidateVocabularyCache() { cache.clear(); }

/**
 * Active values of one vocabulary, as a plain array of strings.
 *
 * @param {string}   type       'PROJECT_TYPE', 'ZONE', … — a master_values.type
 *                              or a key of TABLE_BACKED
 * @param {number?}  companyId  caller's company; shared (NULL) rows always included
 * @param {string[]} fallback   returned verbatim if the read fails
 */
export async function vocabularyValues(type, companyId = null, fallback = []) {
  const key = `${type}:${companyId ?? 'shared'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.values;

  const own = TABLE_BACKED[type];
  try {
    const { rows } = own
      ? await pool.query(
          `SELECT ${own.column} AS value FROM ${own.table}
            WHERE is_active = true ORDER BY ${own.column}`
        )
      : await pool.query(
          `SELECT value FROM master_values
            WHERE type = $1 AND is_active = true
              AND (company_id IS NULL OR company_id = $2)
            ORDER BY sort_order NULLS LAST, value`,
          [type, companyId]
        );
    const values = rows.map(r => r.value);
    // An empty master means the seeds have not run yet, not that the vocabulary
    // is genuinely empty — fall back rather than reject everything.
    const out = values.length ? values : fallback;
    cache.set(key, { at: Date.now(), values: out });
    return out;
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'vocabulary_read_failed',
      type, message: err.message,
    }));
    return fallback;
  }
}

/**
 * Case-insensitive membership, returning the value as the MASTER spells it.
 *
 * Callers were written as `LIST.includes(x) ? x : null`, which is exact-match —
 * and exact-match on a free-text column is what produced four spellings of the
 * same issue type. Matching case-insensitively and returning the master's
 * spelling makes the column converge instead of fan out.
 *
 * @returns {string|null} the canonical value, or null if it is not in the list
 */
export async function canonicalValue(type, raw, companyId = null, fallback = []) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const values = await vocabularyValues(type, companyId, fallback);
  return values.find(v => v.toLowerCase() === t.toLowerCase()) ?? null;
}

export default { vocabularyValues, canonicalValue, invalidateVocabularyCache };
