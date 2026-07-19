/**
 * Backward-compatible pagination.
 *
 * The problem (PHASE1_API_DB_PERF_AUDIT.md item 2): 1,040 of 1,069 collection
 * endpoints return every matching row. Invisible at 14 tickets; at pilot volume
 * a single request returns the entire table and the mobile client parses it.
 *
 * Why this does NOT change response shapes
 * ────────────────────────────────────────
 * The obvious fix — returning `{ data, total, page }` — breaks the frontend
 * silently. 51 call sites are written as:
 *
 *     Array.isArray(res.data) ? res.data : []
 *
 * which falls back to an EMPTY ARRAY, not to `res.data.data`. Only 3 handle both
 * shapes. So switching an endpoint to an envelope renders a blank screen with no
 * error, no failed request, and nothing in the console — the worst failure mode
 * available. Pagination metadata therefore travels in HEADERS, and the body
 * stays a bare array.
 *
 * Why the default cap is high
 * ───────────────────────────
 * Capping at, say, 50 would silently truncate lists whose UI has no paging
 * control — a dropdown showing 50 of 300 departments is a data-loss bug that
 * looks like a rendering quirk. DEFAULT_LIMIT is set well above any current
 * dataset so nothing truncates today; it is a ceiling against pathological
 * reads, not a page size. When a query does hit the ceiling it logs
 * `pagination_truncated`, which is the signal that the endpoint needs real
 * paging in the UI before the data grows further.
 *
 * Usage:
 *   const p = pageParams(req);
 *   const { rows } = await pool.query(`SELECT ... ${p.sql}`, [...params, p.limit, p.offset]);
 *   return sendPage(res, req, rows, total);          // total optional
 */

const DEFAULT_LIMIT = 1000;   // ceiling, not a page size
const MAX_LIMIT     = 5000;

/**
 * Reads ?page and ?limit, clamped. Both are optional; when absent the caller
 * still gets a bounded query rather than an unbounded one.
 *
 * @returns {{limit:number, offset:number, page:number, size:number, sql:string, explicit:boolean}}
 *   `sql` is a ready-to-append `LIMIT $n OFFSET $n+1` fragment when you pass
 *   `startIndex`; otherwise use `limit`/`offset` directly.
 */
export function pageParams(req, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT, startIndex } = {}) {
  const rawLimit = parseInt(req?.query?.limit ?? req?.query?.page_size ?? '', 10);
  const rawPage  = parseInt(req?.query?.page ?? '', 10);

  const size = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, maxLimit)
    : defaultLimit;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return {
    limit:  size,
    offset: (page - 1) * size,
    page,
    size,
    explicit: Number.isFinite(rawLimit) || Number.isFinite(rawPage),
    sql: startIndex ? `LIMIT $${startIndex} OFFSET $${startIndex + 1}` : '',
  };
}

/**
 * Sends a bare array (unchanged shape) plus pagination headers.
 *
 * @param {number|null} total  full row count when known. Omit it and the client
 *   still gets the page, just without X-Total-Count — worth supplying when a
 *   cheap COUNT is available, not worth a second expensive query when it isn't.
 */
export function sendPage(res, req, rows, total = null) {
  const p = pageParams(req);
  const list = Array.isArray(rows) ? rows : [];

  res.setHeader('X-Page', p.page);
  res.setHeader('X-Page-Size', p.size);
  if (total != null) {
    res.setHeader('X-Total-Count', total);
    res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / p.size)));
  }

  // Hitting the ceiling means rows were dropped. Log it: this is the trigger to
  // add paging UI, and without the log the truncation is invisible.
  if (list.length >= p.size) {
    res.setHeader('X-Truncated', 'true');
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN',
      event: 'pagination_truncated',
      path: req.originalUrl || req.path,
      returned: list.length, limit: p.size, total,
      message: 'Result hit the row ceiling — rows were dropped. This endpoint needs paging in the UI.',
    }));
  }

  return res.json(list);
}
