/**
 * Correlation-ID context via AsyncLocalStorage.
 *
 * requestId.js sets req.id and calls runWithCorrelation(id, next) so that the
 * full async call chain for each HTTP request shares the same context store.
 * Any code — including deep service functions — can call getCorrelationId()
 * without receiving `req` as a parameter.
 *
 * Usage in services:
 *   import { getCorrelationId } from '../middlewares/correlationContext.js';
 *   console.error(`[MyService] error cid=${getCorrelationId()}`, err.message);
 */

import { AsyncLocalStorage } from 'async_hooks';

const _als = new AsyncLocalStorage();

/** Returns the correlation ID for the current async context, or null outside a request. */
export function getCorrelationId() {
  return _als.getStore()?.cid ?? null;
}

/**
 * Runs `fn` inside an ALS context keyed to `cid`.
 * Called once per request from requestId middleware.
 */
export function runWithCorrelation(cid, fn) {
  return _als.run({ cid }, fn);
}
