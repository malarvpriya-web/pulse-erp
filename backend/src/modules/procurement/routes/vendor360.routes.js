import express from 'express';
import { Vendor360Controller as ctrl } from '../controllers/vendor360.controller.js';

const router = express.Router();

// ── Static routes FIRST (before /:vendorId) ───────────────────────────────────
// GET /vendor-360
router.get('/',                        ctrl.listVendors);

// GET /vendor-360/command-center  ← MUST be before /:vendorId
router.get('/command-center',          ctrl.commandCenter);

// ── Per-vendor routes ─────────────────────────────────────────────────────────
// GET /vendor-360/:vendorId  (full 360 — all tabs in one call)
router.get('/:vendorId',               ctrl.getFull360);

// Lightweight sub-views (lazy-loaded on tab click)
router.get('/:vendorId/timeline',      ctrl.getTimeline);
router.get('/:vendorId/scorecard',     ctrl.getScorecard);
router.post('/:vendorId/scorecard',    ctrl.saveScorecard);
router.get('/:vendorId/risk',          ctrl.getRisk);
router.get('/:vendorId/documents',     ctrl.getDocuments);

export default router;
