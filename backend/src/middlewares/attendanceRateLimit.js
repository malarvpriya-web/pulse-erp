/**
 * attendanceRateLimit.js
 * In-memory rate limiter for attendance clock-in/out endpoint.
 * Prevents an employee from submitting more than CLOCK_MAX_PER_WINDOW
 * clock events within CLOCK_WINDOW_MS. Works across all workers when
 * using a single Node.js process (PM2 cluster: replace Map with Redis).
 */

const CLOCK_WINDOW_MS     = 30_000;  // 30-second window
const CLOCK_MAX_PER_WINDOW = 3;      // max 3 punches per 30s per employee

// Map<employeeKey, { count: number, windowStart: number }>
const clockAttempts = new Map();

// Cleanup stale entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - CLOCK_WINDOW_MS * 2;
  for (const [key, entry] of clockAttempts.entries()) {
    if (entry.windowStart < cutoff) clockAttempts.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Express middleware — apply only to POST /attendance/clock.
 * Identifies the caller by employee_id (body) + IP address.
 */
export function clockRateLimit(req, res, next) {
  const employeeId = req.body?.employee_id ?? req.user?.employee_id ?? 'unknown';
  const ip         = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const key        = `${employeeId}:${ip}`;
  const now        = Date.now();

  const entry = clockAttempts.get(key);

  if (!entry || now - entry.windowStart > CLOCK_WINDOW_MS) {
    // New window
    clockAttempts.set(key, { count: 1, windowStart: now });
    return next();
  }

  if (entry.count >= CLOCK_MAX_PER_WINDOW) {
    const retryAfterSec = Math.ceil((CLOCK_WINDOW_MS - (now - entry.windowStart)) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: 'too_many_requests',
      message: `Too many clock events. Please wait ${retryAfterSec}s before trying again.`,
      retry_after_seconds: retryAfterSec,
    });
  }

  entry.count += 1;
  next();
}
