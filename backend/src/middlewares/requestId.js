import { randomUUID }          from 'crypto';
import { runWithCorrelation }  from './correlationContext.js';

/**
 * Assigns a correlation ID to every request.
 * Respects an upstream `X-Request-ID` header (load balancers, API gateways)
 * and falls back to a fresh UUID.
 *
 * The ID is:
 *   1. Written to req.id            — available in route/middleware handlers
 *   2. Set in X-Request-ID header   — returned to callers; exposed via CORS
 *   3. Seeded into AsyncLocalStorage — lets any service call getCorrelationId()
 *      without req being passed through the call chain
 */
export const requestId = (req, res, next) => {
  const id = req.headers['x-request-id'] || randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  runWithCorrelation(id, next);
};
