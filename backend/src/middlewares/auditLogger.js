/**
 * auditLogger middleware
 *
 * Automatically captures all mutating HTTP requests (POST, PUT, PATCH, DELETE)
 * and writes an audit log entry via AuditService.
 * Fire-and-forget — audit failures never block the primary response.
 *
 * Registration (server.js):
 *   import { auditLogger } from './src/middlewares/auditLogger.js';
 *   v1Router.use(auditLogger);   // after verifyToken
 */

import { logAudit } from '../services/AuditService.js';
import { companyOf } from '../shared/scope.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const METHOD_TO_ACTION = {
  POST:   'CREATE',
  PUT:    'UPDATE',
  PATCH:  'UPDATE',
  DELETE: 'DELETE',
};

// Paths that produce too much noise or are handled by dedicated audit calls
const SKIP_PATHS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/refresh',
  '/audit',
  '/ai',
  '/global-search',
]);

function shouldSkip(path) {
  for (const prefix of SKIP_PATHS) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function deriveModule(path) {
  // path is relative to the v1Router mount point, e.g. "/leaves/123"
  const parts = path.split('/').filter(Boolean);
  return parts[0] || 'system';
}

function deriveEntityType(path) {
  const parts = path.split('/').filter(Boolean);
  return parts[1] || parts[0] || 'record';
}

export function auditLogger(req, res, next) {
  if (!MUTATING.has(req.method) || !req.user) return next();
  if (shouldSkip(req.path)) return next();

  const originalJson = res.json.bind(res);

  res.json = function auditedJson(body) {
    // Only log on success (2xx)
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const module     = deriveModule(req.path);
      const entityType = deriveEntityType(req.path);
      const action     = METHOD_TO_ACTION[req.method];

      // Best-effort record ID extraction from response body or URL params
      const recordId =
        body?.id ??
        body?.data?.id ??
        req.params?.id ??
        null;

      logAudit({
        userId     : req.user.userId ?? req.user.id ?? null,
        company_id : req.scope?.company_id ?? companyOf(req),
        module,
        action,
        recordId,
        recordType : entityType,
        req,
      });
    }
    return originalJson(body);
  };

  next();
}
