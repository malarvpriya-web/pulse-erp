/**
 * Rate limiting — two tiers.
 *
 *   memoryRateLimit — in-process, per-instance. Cheap (no I/O). Used for the
 *                     global tier where the goal is shedding load, and an
 *                     approximate limit per instance is fine.
 *
 *   dbRateLimit     — DB-backed, shared across every instance. One upsert per
 *                     request, so reserve it for low-volume sensitive endpoints
 *                     (login, OTP send) where the limit must actually hold
 *                     cluster-wide.
 *
 * BOTH key on `req.ip`, never on the raw X-Forwarded-For header. Express derives
 * req.ip from XFF using the `trust proxy` setting, discarding hops the client
 * could have forged. Reading the header directly makes any limiter bypassable by
 * sending a different X-Forwarded-For on each request — which is exactly the bug
 * this module was written to fix. Do not "simplify" it back.
 *
 * Requires `app.set('trust proxy', …)` to be configured in server.js.
 */
import pool from '../config/db.js';

/** Shared 429 response so clients see one shape regardless of tier. */
function reject(res, retryAfterSec) {
  res.setHeader('Retry-After', retryAfterSec);
  return res.status(429).json({
    error: 'Too many requests. Please try again in a few minutes.',
    retry_after: retryAfterSec,
  });
}

function logExceeded(req, bucket, count) {
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'WARN',
    event: 'rate_limit_exceeded',
    bucket,
    ip: req.ip,
    path: req.path,
    count,
  }));
}

/**
 * In-process sliding-window-ish limiter (fixed window, per instance).
 *
 * @param {object}   opts
 * @param {number}   opts.windowMs
 * @param {number}   opts.max        requests per window per key
 * @param {string}   opts.bucket     label for logs
 * @param {Function} [opts.key]      req → string (default: req.ip)
 * @param {Function} [opts.skip]     req → boolean; true bypasses the limiter
 */
export function memoryRateLimit({ windowMs, max, bucket, key, skip }) {
  const store = new Map(); // key → { count, windowStart }

  // Evict stale entries so the Map can't grow without bound under IP churn.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of store) if (v.windowStart < cutoff) store.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    if (skip?.(req)) return next();

    const k   = key ? key(req) : (req.ip || 'unknown');
    const now = Date.now();
    const e   = store.get(k);

    if (!e || now - e.windowStart > windowMs) {
      store.set(k, { count: 1, windowStart: now });
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', max - 1);
      return next();
    }

    e.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - e.count));

    if (e.count > max) {
      logExceeded(req, bucket, e.count);
      return reject(res, Math.max(1, Math.ceil((windowMs - (now - e.windowStart)) / 1000)));
    }
    next();
  };
}

/**
 * DB-backed limiter — shared across instances via an atomic upsert.
 *
 * Fails OPEN on DB error: a database blip must not lock everyone out of login.
 * That trade is deliberate; it means a sustained DB outage also disables this
 * limiter, so it is a throttle, not a security boundary of last resort.
 *
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max
 * @param {string} opts.bucket   namespaces the counter (e.g. 'auth', 'otp_send')
 * @param {Function} [opts.key]  req → string appended to the bucket key
 */
export function dbRateLimit({ windowMs, max, bucket, key }) {
  const windowInterval = `${windowMs} milliseconds`;

  return async (req, res, next) => {
    // auth_rate_limit.ip is VARCHAR(64); keep keys inside it so two callers
    // can't collide via silent truncation.
    const id = `${bucket}:${key ? key(req) : (req.ip || 'unknown')}`.slice(0, 64);

    try {
      const { rows } = await pool.query(
        `INSERT INTO auth_rate_limit (ip, count, window_start)
         VALUES ($1, 1, NOW())
         ON CONFLICT (ip) DO UPDATE
           SET count = CASE
                 WHEN auth_rate_limit.window_start < NOW() - ($2::text)::INTERVAL THEN 1
                 ELSE auth_rate_limit.count + 1
               END,
               window_start = CASE
                 WHEN auth_rate_limit.window_start < NOW() - ($2::text)::INTERVAL THEN NOW()
                 ELSE auth_rate_limit.window_start
               END
         RETURNING count, window_start`,
        [id, windowInterval]
      );

      const count = rows[0]?.count ?? 1;
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

      if (count > max) {
        logExceeded(req, bucket, count);
        const elapsed = Date.now() - new Date(rows[0].window_start).getTime();
        return reject(res, Math.max(1, Math.ceil((windowMs - elapsed) / 1000)));
      }
    } catch {
      // DB down — fail open (see note above).
    }
    next();
  };
}
