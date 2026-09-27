/**
 * integrations-config.routes.js — tenant integration credential administration.
 *
 * SECURITY (PULSE-01, audit 2026-09-20/21)
 * ========================================
 * This router was the vulnerability. It was mounted with `verifyToken` only, and
 * its PUT handler wrote every key of the request body into `process.env`. An
 * ordinary `employee` could therefore set PERMISSION_FAIL_OPEN=true and turn a
 * fail-closed RBAC gate into a 200, or NODE_ENV=development and have the
 * password-reset OTP returned in an API response. The full account is in the
 * header of ./integrationConfig.js.
 *
 * Four controls close it, and all four are load-bearing:
 *
 *  1. AUTHORIZATION. `requirePermission('admin', 'view')` guards the whole router
 *     and 'edit' guards the write. The gate lives HERE, at the router, not at the
 *     mount in server.js — a router reached through a second mount path would
 *     otherwise arrive ungated, and this repo has shipped alias mounts before
 *     (see server.js "Frontend URL alias mounts"). The matrix already grants
 *     admin:edit to exactly `admin` and `super_admin`, so no migration is needed
 *     and every other role fails closed.
 *
 *  2. TENANT OWNERSHIP. The company is taken from `companyOf(req)` and from
 *     nowhere else. A `company_id` in the body, query or params is rejected
 *     outright rather than ignored, because a caller who sends one is asking for
 *     something this endpoint will not do and a silent drop reads as success.
 *
 *  3. SCHEMA. `validateFields()` accepts only allowlisted field names with
 *     validated values. An unknown field is a 400.
 *
 *  4. NO ENVIRONMENT MUTATION. Nothing on this path assigns to `process.env`.
 *     Credentials live in `company_integrations`, encrypted per tenant, and
 *     consumers read them through `resolveConfig(companyOf(req), key)`.
 *
 * ⚠ If a future change needs a saved credential to take effect "immediately"
 * without a restart, that is already how it works — resolveConfig() reads the row
 * on each call. Do not reintroduce a write to process.env to achieve it.
 */

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import {
  INTEGRATION_KEYS,
  isKnownIntegration,
  validateFields,
  readStored,
  resolveStatus,
  saveConfig,
  maskSecrets,
  allRequiredPresent,
} from './integrationConfig.js';

const router = Router();

/**
 * Baseline gate for the whole router, including routes added later.
 *
 * Reads need admin:view; the write adds admin:edit below. requirePermission
 * fails closed when no row exists, which is the behaviour we want for a
 * credential store.
 */
router.use(requirePermission('admin', 'view'));

/**
 * A tenant may not name another tenant.
 *
 * `companyOf(req)` is the only accepted source. This middleware exists so the
 * refusal is explicit and audited rather than an ignored field, and so it covers
 * every route in the router at once.
 */
function rejectClientCompanyOverride(req, res, next) {
  const named = ['company_id', 'companyId', 'company'];
  const found = named.filter(
    (k) =>
      (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) ||
      (req.query && Object.prototype.hasOwnProperty.call(req.query, k))
  );
  if (found.length) {
    logAudit({
      userId: req.user?.userId ?? null,
      module: 'admin',
      recordType: 'integration_config',
      recordId: req.params?.key ?? null,
      action: 'security_denied',
      newData: { reason: 'client_supplied_company_scope', fields: found, path: req.originalUrl },
      req,
    });
    return res.status(400).json({
      error: 'Invalid request',
      code: 'COMPANY_SCOPE_NOT_ACCEPTED',
      message:
        'The company is taken from your session and cannot be supplied in the request. ' +
        'Remove ' + found.join(', ') + ' and retry.',
    });
  }
  next();
}

router.use(rejectClientCompanyOverride);

// ── GET /config/all — per-tenant status for every integration ─────────────────
router.get('/all', async (req, res) => {
  const cid = companyOf(req);
  const STATUS_LABEL = { connected: 'Connected', configured: 'Not Configured', not_configured: 'Not Configured' };

  try {
    const result = {};
    // Sequential on purpose: eight small indexed lookups, and a Promise.all here
    // would take eight pool connections for a page-load endpoint. See the pool
    // budget note in vitest.config.js.
    for (const key of INTEGRATION_KEYS) {
      const status = await resolveStatus(cid, key);
      result[key] = { status: STATUS_LABEL[status] ?? 'Not Configured', last: null };
    }

    // last_tested_at is per-tenant metadata, not a credential.
    const { rows } = await pool.query(
      `SELECT integration_key, last_tested_at FROM company_integrations WHERE company_id = $1`,
      [cid ?? 0]
    );
    for (const row of rows) {
      if (result[row.integration_key]) result[row.integration_key].last = row.last_tested_at ?? null;
    }

    res.json(result);
  } catch (err) {
    console.error('[integrations-config] /all failed:', err.message);
    res.status(500).json({ error: 'Failed to load integration status' });
  }
});

// ── GET /config/:key — masked credentials for pre-filling the form ────────────
router.get('/:key', async (req, res) => {
  const { key } = req.params;
  if (!isKnownIntegration(key)) return res.status(404).json({ error: 'Unknown integration key' });

  const cid = companyOf(req);
  try {
    // Deliberately the STORED row, not resolveConfig(): the form must show what
    // this tenant has configured, and folding the deployment's env fallback into
    // it would display another scope's values as if the tenant had entered them.
    const stored = await readStored(cid, key);
    const status = allRequiredPresent(key, stored)
      ? 'connected'
      : (Object.keys(stored).length ? 'configured' : 'not_configured');

    const { rows } = await pool.query(
      `SELECT last_tested_at FROM company_integrations
        WHERE company_id = $1 AND integration_key = $2 LIMIT 1`,
      [cid ?? 0, key]
    );

    res.json({
      key,
      status,
      credentials: maskSecrets(key, stored),
      last_tested_at: rows[0]?.last_tested_at ?? null,
    });
  } catch (err) {
    console.error('[integrations-config] GET /:key failed:', err.message);
    res.status(500).json({ error: 'Failed to load integration configuration' });
  }
});

// ── PUT /config/:key — save this tenant's credentials ────────────────────────
router.put('/:key', requirePermission('admin', 'edit'), async (req, res) => {
  const { key } = req.params;
  if (!isKnownIntegration(key)) return res.status(404).json({ error: 'Unknown integration key' });

  const cid = companyOf(req);
  const validation = validateFields(key, req.body);

  if (!validation.ok) {
    // Field NAMES only. The values are the credentials.
    logAudit({
      userId: req.user?.userId ?? null,
      module: 'admin',
      recordType: 'integration_config',
      recordId: key,
      action: 'security_denied',
      newData: {
        reason: 'schema_rejected',
        unknown_fields: validation.unknown,
        invalid_fields: validation.invalid.map((i) => i.field),
      },
      req,
    });

    return res.status(400).json({
      error: 'Invalid configuration',
      code: validation.unknown.length ? 'UNKNOWN_FIELD' : 'INVALID_VALUE',
      unknown_fields: validation.unknown,
      invalid_fields: validation.invalid,
      message: validation.unknown.length
        ? `These fields are not part of the ${key} configuration: ${validation.unknown.join(', ')}`
        : 'One or more values failed validation.',
    });
  }

  if (!Object.keys(validation.fields).length) {
    return res.status(400).json({
      error: 'Invalid configuration',
      code: 'NO_FIELDS',
      message: 'No configuration values were supplied.',
    });
  }

  try {
    const { status, changedFields } = await saveConfig(cid, key, validation.fields);

    // Explicit entry so the trail records WHICH fields a privileged config change
    // touched. auditMutations() at the mount is the floor and records the
    // attempt; logAudit sets req._auditLogged so this supersedes it rather than
    // doubling it.
    logAudit({
      userId: req.user?.userId ?? null,
      module: 'admin',
      recordType: 'integration_config',
      recordId: key,
      action: 'update',
      newData: { integration: key, company_id: cid, changed_fields: changedFields, status },
      req,
    });

    res.json({ success: true, status, key });
  } catch (err) {
    console.error('[integrations-config] PUT /:key failed:', err.message);
    res.status(500).json({ error: 'Failed to save integration configuration' });
  }
});

export default router;
