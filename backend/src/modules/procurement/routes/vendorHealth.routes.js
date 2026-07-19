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

const router = express.Router();

// ── Static routes ─────────────────────────────────────────────────────────────────

// GET /vendor-health/dashboard — procurement dashboard cards + charts
router.get('/dashboard', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.getDashboard(cid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/heatmap — supplier risk heatmap (sorted highest risk first)
router.get('/heatmap', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getHeatmap(cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/early-warnings — active early warnings for SCM/Quality/Management
router.get('/early-warnings', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getEarlyWarnings(cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vendor-health/ceo-command-center — CEO summary view
router.get('/ceo-command-center', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const data = await svc.getCEOCommandCenter(cid);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /vendor-health/recalculate-all — bulk recalculate all vendors
router.post('/recalculate-all', async (req, res) => {
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
router.patch('/warnings/:warningId/acknowledge', async (req, res) => {
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
router.get('/:vendorId', async (req, res) => {
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
router.post('/:vendorId/recalculate', async (req, res) => {
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
router.get('/:vendorId/trend', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? companyOf(req);
    const rows = await svc.getHealthTrend(req.params.vendorId, cid);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
