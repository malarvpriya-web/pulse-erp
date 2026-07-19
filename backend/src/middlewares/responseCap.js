/**
 * Response row ceiling.
 *
 * 285 GET endpoints run a query with no LIMIT at all and return every matching
 * row (PHASE1_API_DB_PERF_AUDIT.md item 2). Fixing that properly means editing
 * 285 hand-written SQL statements — each with its own joins, ORDER BY and
 * filters — which is a large, risky change to make blind.
 *
 * This is the cheap half of the fix. It cannot reduce the work the DATABASE
 * does (the query has already run by the time we see the rows), but it does:
 *
 *   1. bound the response payload, so one client cannot pull an entire table
 *      into memory on both ends;
 *   2. name, in the logs, exactly which endpoints actually exceed the ceiling.
 *
 * (2) is the point. The audit can say 285 endpoints are unbounded; only
 * production traffic can say which twelve of them matter. Fix those, not all
 * 285.
 *
 * Shape is preserved: an array response stays an array. Switching to
 * `{ data, total }` would silently break 51 frontend call sites written as
 * `Array.isArray(res.data) ? res.data : []`, which fall back to an empty array
 * rather than to `.data.data` — a blank screen with no error. Metadata goes in
 * headers for exactly that reason.
 *
 * The ceiling is deliberately far above any legitimate list so that nothing
 * truncates today. It is a backstop against pathological reads, not a page size.
 */

const CAP = parseInt(process.env.RESPONSE_ROW_CAP || '2000', 10);

// Observation threshold — logs row counts WITHOUT truncating.
//
// The cap alone cannot answer "which endpoints will not scale". An 8-person
// pilot generates a few hundred rows per table; projected out, no collection
// reaches CAP even at 90 days, so `response_row_cap_exceeded` would never fire
// and the silence would read as "nothing to fix" rather than "not enough data".
//
// Logging every response above a low threshold turns the pilot into a
// distribution study instead: rank endpoints by rows-returned-per-request and
// by growth against activity, and the ones that will break at 500 users are
// visible at 8. Set to 0 to disable.
const OBSERVE = parseInt(process.env.RESPONSE_ROW_OBSERVE || '100', 10);

export const responseCap = (req, res, next) => {
  const origJson = res.json.bind(res);

  res.json = (body) => {
    if (Array.isArray(body) && OBSERVE > 0 && body.length >= OBSERVE && body.length <= CAP) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        event: 'response_rows',
        path: req.originalUrl || req.path,
        rows: body.length,
        userId: req.user?.userId ?? null,
      }));
    }
    if (Array.isArray(body) && body.length > CAP) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'WARN',
        event: 'response_row_cap_exceeded',
        path: req.originalUrl || req.path,
        returned: body.length,
        cap: CAP,
        userId: req.user?.userId ?? null,
        message: 'Endpoint returned more rows than the ceiling and was truncated. ' +
                 'Add LIMIT/OFFSET to this query and paging to its UI.',
      }));
      res.setHeader('X-Truncated', 'true');
      res.setHeader('X-Total-Count', body.length);
      res.setHeader('X-Row-Cap', CAP);
      return origJson(body.slice(0, CAP));
    }
    return origJson(body);
  };

  next();
};
