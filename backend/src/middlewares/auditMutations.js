/**
 * auditMutations.js — automatic audit coverage for every mutating request.
 *
 * WHY THIS EXISTS
 * ---------------
 * A coverage scan on 2026-09-04 counted 1,304 mutating route handlers across the
 * backend and found 339 of them calling `logAudit()` — **26%**. Whole files
 * logged nothing: 57 of 57 attendance mutations, 31 of 51 in sales.routes, 13 of
 * 16 in marketing.routes. The brief's requirement is that every significant
 * mutation records actor, timestamp, company, entity, record, action and source.
 *
 * Hand-adding a call to ~965 handlers is a large diff that is wrong the moment
 * someone adds route 966. This closes the gap structurally instead: mount it
 * once per router and every POST/PUT/PATCH/DELETE through it is recorded,
 * including routes that do not exist yet.
 *
 * IT DOES NOT REPLACE logAudit()
 * ------------------------------
 * An explicit call carries the before-image, which is the part of an audit trail
 * that answers "what changed". This middleware only sees the request body and
 * the response, so it records what was ATTEMPTED and what came back. Where a
 * handler already calls logAudit the middleware stands down — `logAudit` marks
 * the request, and a double entry would make the log count every careful write
 * twice while leaving the careless ones single.
 *
 * SO: explicit logAudit for anything whose before-state matters; this as the
 * floor, so nothing is invisible.
 *
 * WHAT IT DELIBERATELY DOES NOT LOG
 * ---------------------------------
 *  - failed requests (4xx/5xx). An audit log is a record of what happened to the
 *    data; a rejected request changed nothing. Authentication failures are
 *    already covered by auth_audit_log.
 *  - request bodies on auth routes, and any field whose name looks like a
 *    credential. An audit trail that stores passwords is a liability, not a
 *    control.
 */

import { logAudit } from '../services/AuditService.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const VERB_ACTION = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// Field names that must never reach the audit log, matched case-insensitively
// anywhere in the key.
const SECRET = /pass|pwd|secret|token|otp|apikey|api_key|authorization|credential|cvv|card_number|private_key/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Best-effort record id from whatever the handler returned or the URL carried.
 * `null` is an honest answer — a bulk operation has no single record id, and
 * inventing one would be worse than recording none.
 */
function recordIdFrom(req, payload) {
  if (req.params?.id != null) return req.params.id;
  const body = payload?.data ?? payload;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of ['id', 'ID', 'uuid']) if (body[k] != null) return body[k];
  }
  return null;
}

/**
 * @param {string} moduleName  lowercase module key, matching role_permissions
 * @param {{ recordType?: string, skip?: (req) => boolean }} [opts]
 */
export function auditMutations(moduleName, opts = {}) {
  const module = String(moduleName).trim().toLowerCase();

  return function auditMutationsMiddleware(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    if (opts.skip && opts.skip(req)) return next();

    // Capture the body now: a handler is free to mutate req.body, and several do.
    const requestBody = redact(req.body);

    const finish = (payload) => {
      // Only successful mutations. A 422 changed nothing.
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      // The handler already wrote a richer entry, with the before-image.
      if (req._auditLogged) return;

      logAudit({
        userId:     req.user?.userId ?? null,
        module,
        recordId:   recordIdFrom(req, payload),
        recordType: opts.recordType ?? `${module}_request`,
        action:     VERB_ACTION[req.method],
        // Set by a `captureBefore(table)` on this route, where one is mounted.
        // Without it the floor records what was ATTEMPTED but not what the value
        // changed from — which is the question an audit is usually asked.
        oldData: req._auditBefore ?? null,
        newData: {
          method: req.method,
          // originalUrl carries the query string; baseUrl+path is the route.
          path: req.baseUrl + (req.route?.path ?? req.path),
          status: res.statusCode,
          request: requestBody,
        },
        req,
      });
    };

    // Hook both, because handlers in this codebase use either.
    const json = res.json.bind(res);
    res.json = (payload) => { try { finish(payload); } catch { /* audit must never break a response */ } return json(payload); };
    const send = res.send.bind(res);
    res.send = (payload) => { try { finish(null); } catch { /* as above */ } return send(payload); };

    next();
  };
}

export default auditMutations;
