/**
 * Phase 49G — Vendor Health Routes
 *
 * Base: /api/v1/vendor-health
 *
 * Static routes MUST come before /:vendorId to avoid conflicts.
 */
import express from 'express';
import svc from '../services/vendorHealth.service.js';
import { companyOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';
/**
 * AUTHORIZATION. This router was mounted behind `verifyToken` and NOTHING else,
 * so every route below was reachable by any authenticated account regardless of
 * role — including the writes. `requireProcurement(action, ...alsoAllowRoles)`
 * ORs the role_permissions matrix with named roles, which is how the rest of the
 * module is gated; the named roles are the documented exceptions, not a bypass.
 */

const router = express.Router();

/**
 * `:vendorId` reaches an integer column. A non-numeric segment used to be passed
 * straight through to the query, so `/vendor-health/undefined` — which a client
 * produces the moment a vendor id is missing from its state — answered 500 with
 * the raw `invalid input syntax for type integer` from Postgres. That reads to
 * the user as "the system broke" and leaks the column type; it is a bad request.
 */
router.param('vendorId', (req, res, next, value) => {
  if (!/^\d+$/.test(String(value))) {
    return res.status(400).json({ error: 'vendorId must be a numeric vendor id.' });
  }
  next();
});

// ── Static routes ─────────────────────────────────────────────────────────────────

// GET /vendor-health/dashboard — procurement dashboard cards + charts
router.get('/dashboard', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.getDashboard(cid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/heatmap — supplier risk heatmap (sorted highest risk first)
router.get('/heatmap', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getHeatmap(cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/early-warnings — active early warnings for SCM/Quality/Management
router.get('/early-warnings', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getEarlyWarnings(cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/ceo-command-center — CEO summary view
router.get('/ceo-command-center', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.getCEOCommandCenter(cid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /vendor-health/recalculate-all — bulk recalculate all vendors
router.post('/recalculate-all', requireProcurement('approve'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const { rows: vendors } = await import('../../../config/db.js')
      .then(m => m.default.query(
        `SELECT id FROM vendors WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id`,
        [cid]
      ));

    const results = { success: 0, failed: 0, errors: [] };
    for (const v of vendors) {
      try {
        await svc.computeAndSave(v.id, cid);
        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({ vendor_id: v.id, error: err.message });
      }
    }
    res.json({ message: 'Bulk recalculation complete', ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /vendor-health/warnings/:warningId/acknowledge
router.patch('/warnings/:warningId/acknowledge', requireProcurement('edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const row = await svc.acknowledgeWarning(
      req.params.warningId,
      req.user.id,
      cid
    );
    if (!row) return res.status(404).json({ error: 'Warning not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Per-vendor routes (must come after static routes) ────────────────────────────

// GET /vendor-health/:vendorId — fetch stored health (no recalculate)
router.get('/:vendorId', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.getVendorHealth(req.params.vendorId, cid);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /vendor-health/:vendorId/recalculate — force full recalculation
router.post('/:vendorId/recalculate', requireProcurement('edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.computeAndSave(req.params.vendorId, cid);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /vendor-health/:vendorId/trend — 12-month health timeline
router.get('/:vendorId/trend', requireProcurement('view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getHealthTrend(req.params.vendorId, cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
