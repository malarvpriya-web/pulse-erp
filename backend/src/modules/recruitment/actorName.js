/**
 * Who did this, in words a recruiter reads.
 *
 * `candidate_activity.actor_name` is denormalised on purpose (see migration
 * 20260927000001): the FK to users is ON DELETE SET NULL, and an audit trail that
 * forgets who did something the moment that person leaves the company is not an
 * audit trail. So every write needs a name, and this is the one place that
 * resolves it.
 *
 * Cached for five minutes per user. The lookup is one small query, but the
 * timeline is written on every mutation in the module — a per-write join to
 * `employees` would add a round trip to every note, every rating save and every
 * row of a bulk action. Five minutes is short enough that a renamed employee is
 * not stale for long, and long enough that a recruiter working through eighty
 * candidates pays for it once.
 *
 * Falls back to the JWT's email, then to null. A null name is honest — the
 * actor_user_id is still recorded — whereas a fabricated one would not be.
 */

import pool from '../shared/db.js';

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function actorNameOf(req) {
  const userId = req?.user?.userId ?? req?.user?.id ?? null;
  if (!userId) return null;

  const hit = cache.get(userId);
  if (hit && hit.at > Date.now() - TTL_MS) return hit.name;

  let name = req.user?.email || null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(e.name, u.email) AS name
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id
        WHERE u.id = $1`,
      [userId]
    );
    if (rows[0]?.name) name = rows[0].name;
  } catch {
    // The JWT email is a perfectly good fallback, and a failed name lookup must
    // never fail the mutation it was being resolved for.
  }

  cache.set(userId, { name, at: Date.now() });
  return name;
}

/** Test seam: the five-minute cache would otherwise outlive a test's fixtures. */
export function _clearActorNameCache() {
  cache.clear();
}
