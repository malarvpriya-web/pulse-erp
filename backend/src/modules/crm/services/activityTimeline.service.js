/**
 * activityTimeline.service.js — one chronological history, across every table
 * that records one.
 *
 * Reads `v_activity_timeline` (migration 20260904000003), which maps the seven
 * activity tables onto a single column contract. See that migration for why the
 * unification is a view rather than a data migration.
 *
 * TWO QUESTIONS, TWO FUNCTIONS
 * ----------------------------
 * `timelineFor()` answers "what happened on THIS record" — one entity, direct
 * links only.
 *
 * `customerTimeline()` answers "what happened with this CUSTOMER", which is the
 * question Customer 360 actually asks and the one that was unanswerable before.
 * It first resolves everything hanging off the account — its opportunities, its
 * leads, its quotations, its orders, its cases, its projects — and then pulls
 * every activity attached to any of them. An activity logged against a service
 * case is part of the customer's history even though it names no account.
 */

/** Every entity column the timeline can be filtered on. */
export const TIMELINE_KEYS = [
  'lead_id', 'opportunity_id', 'account_id', 'contact_id',
  'project_id', 'campaign_id', 'ticket_id', 'quotation_id', 'sales_order_id',
];

const MAX_LIMIT = 500;

function clampLimit(v, fallback = 100) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Activities directly attached to one or more entities.
 *
 * Filters are OR-ed, not AND-ed. An activity linked to an opportunity is part of
 * that opportunity's history whether or not it also names the account, so
 * requiring every supplied key to match would return almost nothing.
 *
 * @param {import('pg').Pool} db
 * @param {object} opts
 * @param {number|null} opts.companyId
 * @param {object} opts.filters   subset of TIMELINE_KEYS → id
 * @param {string} [opts.from]    ISO date, inclusive
 * @param {string} [opts.to]      ISO date, exclusive
 * @param {number} [opts.limit]
 */
export async function timelineFor(db, { companyId, filters = {}, from, to, limit, types } = {}) {
  const params = [companyId];
  const where = [`($1::int IS NULL OR t.company_id = $1)`];

  const ors = [];
  for (const key of TIMELINE_KEYS) {
    const val = filters[key];
    if (val === undefined || val === null || val === '') continue;
    params.push(val);
    ors.push(`t.${key} = $${params.length}`);
  }
  if (ors.length) where.push(`(${ors.join(' OR ')})`);

  if (from) { params.push(from); where.push(`t.occurred_at >= $${params.length}::timestamptz`); }
  if (to)   { params.push(to);   where.push(`t.occurred_at <  $${params.length}::timestamptz`); }

  if (Array.isArray(types) && types.length) {
    params.push(types.map((s) => String(s).toLowerCase()));
    where.push(`LOWER(t.activity_type) = ANY($${params.length})`);
  }

  params.push(clampLimit(limit));

  const { rows } = await db.query(
    `SELECT t.*, e.name AS actor_name, e.designation AS actor_designation
       FROM v_activity_timeline t
       LEFT JOIN employees e ON e.id = t.actor_employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.occurred_at DESC NULLS LAST, t.source, t.source_id
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Everything that has happened with one customer.
 *
 * The account's own activities are only a fraction of its history. This resolves
 * the account's opportunities, leads, quotations, orders, cases and projects
 * first, then returns every activity attached to any of them — which is what
 * makes a service case or a project task show up on the customer's timeline.
 *
 * Returns `{ related, activities }` so the caller can show WHY a row is on the
 * timeline rather than presenting a flat list whose provenance is invisible.
 */
export async function customerTimeline(db, { companyId, accountId, limit, from, to, types } = {}) {
  if (accountId == null) {
    throw Object.assign(new Error('accountId is required'), { status: 400 });
  }

  // One round trip for every related id. Doing this as six separate queries is
  // the N+1 shape this codebase has been bitten by before.
  const { rows: [related] } = await db.query(
    `SELECT
       COALESCE((SELECT array_agg(o.id)   FROM opportunities o
                  WHERE o.account_id = $1 AND o.deleted_at IS NULL), '{}')            AS opportunity_ids,
       COALESCE((SELECT array_agg(l.id)   FROM leads l
                  JOIN opportunities o2 ON o2.lead_id = l.id
                 WHERE o2.account_id = $1 AND l.deleted_at IS NULL), '{}')            AS lead_ids,
       COALESCE((SELECT array_agg(q.id)   FROM quotations q
                  JOIN opportunities o3 ON o3.id = q.opportunity_id
                 WHERE o3.account_id = $1), '{}')                                     AS quotation_ids,
       COALESCE((SELECT array_agg(so.id)  FROM sales_orders so
                  JOIN quotations q2 ON q2.id = so.quotation_id
                  JOIN opportunities o4 ON o4.id = q2.opportunity_id
                 WHERE o4.account_id = $1 AND so.deleted_at IS NULL), '{}')           AS sales_order_ids,
       COALESCE((SELECT array_agg(p.id)   FROM projects p
                  JOIN opportunities o5 ON o5.id = p.opportunity_id
                 WHERE o5.account_id = $1 AND p.deleted_at IS NULL), '{}')            AS project_ids`,
    [accountId]
  );

  const ids = {
    account_id:     [accountId],
    opportunity_id: related?.opportunity_ids ?? [],
    lead_id:        related?.lead_ids ?? [],
    quotation_id:   related?.quotation_ids ?? [],
    sales_order_id: related?.sales_order_ids ?? [],
    project_id:     related?.project_ids ?? [],
  };

  const params = [companyId];
  const ors = [];
  for (const [key, list] of Object.entries(ids)) {
    if (!list || !list.length) continue;
    params.push(list);
    ors.push(`t.${key} = ANY($${params.length}::int[])`);
  }

  const where = [`($1::int IS NULL OR t.company_id = $1)`];
  // An account with nothing hanging off it still has itself; `ors` can never be
  // empty because account_id is always present. Guarded anyway so a future
  // caller cannot produce an unfiltered scan of every activity in the tenant.
  where.push(ors.length ? `(${ors.join(' OR ')})` : 'FALSE');

  if (from) { params.push(from); where.push(`t.occurred_at >= $${params.length}::timestamptz`); }
  if (to)   { params.push(to);   where.push(`t.occurred_at <  $${params.length}::timestamptz`); }
  if (Array.isArray(types) && types.length) {
    params.push(types.map((s) => String(s).toLowerCase()));
    where.push(`LOWER(t.activity_type) = ANY($${params.length})`);
  }
  params.push(clampLimit(limit));

  const { rows } = await db.query(
    `SELECT t.*, e.name AS actor_name, e.designation AS actor_designation
       FROM v_activity_timeline t
       LEFT JOIN employees e ON e.id = t.actor_employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.occurred_at DESC NULLS LAST, t.source, t.source_id
      LIMIT $${params.length}`,
    params
  );

  return {
    account_id: accountId,
    related: {
      opportunities: ids.opportunity_id.length,
      leads:         ids.lead_id.length,
      quotations:    ids.quotation_id.length,
      sales_orders:  ids.sales_order_id.length,
      projects:      ids.project_id.length,
    },
    count: rows.length,
    activities: rows,
  };
}

export default { TIMELINE_KEYS, timelineFor, customerTimeline };
