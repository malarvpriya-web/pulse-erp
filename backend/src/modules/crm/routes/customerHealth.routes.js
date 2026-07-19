// backend/src/modules/crm/routes/customerHealth.routes.js
// Phase 49F — Customer Health Score Engine
//
// Mount: /api/v1/crm/health-engine
//
// GET  /health-engine/dashboard          — CEO dashboard (49F-18)
// GET  /health-engine/sales              — Sales dashboard (49F-19)
// GET  /health-engine/service            — Service dashboard (49F-20)
// GET  /health-engine/finance            — Finance dashboard (49F-21)
// GET  /health-engine/projects           — Project dashboard (49F-22)
// GET  /health-engine/alerts             — Early warning system (49F-14)
// GET  /health-engine/alerts/:id/resolve — Resolve alert
// GET  /health-engine/customer/:id       — Single customer health
// GET  /health-engine/customer/:id/trend — 12-month trend (49F-13)
// POST /health-engine/recalculate/:id   — Recalculate for one customer
// POST /health-engine/recalculate-all   — Recalculate all (admin/nightly)

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import * as svc from '../customerHealth.service.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

// ── CEO DASHBOARD  (49F-18) ──────────────────────────────────────────────────
router.get('/dashboard', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const data = await svc.getCEODashboard(companyId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SALES DASHBOARD  (49F-19) ────────────────────────────────────────────────
router.get('/sales', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const data = await svc.getSalesDashboard(companyId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVICE DASHBOARD  (49F-20) ──────────────────────────────────────────────
router.get('/service', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const data = await svc.getServiceDashboard(companyId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FINANCE DASHBOARD  (49F-21) ──────────────────────────────────────────────
router.get('/finance', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const data = await svc.getFinanceDashboard(companyId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PROJECT DASHBOARD  (49F-22) ──────────────────────────────────────────────
router.get('/projects', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const data = await svc.getProjectDashboard(companyId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── EARLY WARNING ALERTS  (49F-14) ───────────────────────────────────────────
router.get('/alerts', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const alerts = await svc.getActiveAlerts(companyId);
    res.json(alerts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RESOLVE ALERT ─────────────────────────────────────────────────────────────
router.patch('/alerts/:alertId/resolve', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { alertId } = req.params;
    const companyId = companyOf(req);
    const employeeId = req.user?.employee_id || req.user?.id;

    await pool.query(
      `UPDATE customer_health_alerts
       SET is_resolved=TRUE, resolved_at=NOW(), resolved_by=$1
       WHERE id=$2 AND company_id=$3`,
      [employeeId, alertId, companyId]
    );

    // Invalidate alerts cache
    svc.invalidateCache(0, companyId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SINGLE CUSTOMER HEALTH  (49F-25 CEO traceability) ────────────────────────
router.get('/customer/:customerId', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    // Try stored score first (fast)
    let stored = await svc.getStoredHealth(customerId, companyId);

    // If stale (>24h) or missing, recalculate
    if (!stored || parseFloat(stored.age_minutes || 0) > 1440) {
      stored = await svc.calculateAndStore(customerId, companyId);
    }

    res.json(stored);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 12-MONTH TREND  (49F-13, 49F-24) ────────────────────────────────────────
router.get('/customer/:customerId/trend', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    const trend = await svc.getHealthTrend(customerId, companyId);
    res.json(trend);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RECALCULATE ONE CUSTOMER ──────────────────────────────────────────────────
router.post('/recalculate/:customerId', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    const result = await svc.calculateAndStore(customerId, companyId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RECALCULATE ALL (admin / nightly) ────────────────────────────────────────
router.post('/recalculate-all', requirePermission('crm', 'admin'), async (req, res) => {
  try {
    const companyId = companyOf(req);

    // Fire async — respond immediately with 202
    res.status(202).json({ message: 'Recalculation started', company_id: companyId });
    svc.recalculateAll(companyId).then(r =>
      console.log(`[customerHealth] Recalculation complete: ${r.processed}/${r.total}`)
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
