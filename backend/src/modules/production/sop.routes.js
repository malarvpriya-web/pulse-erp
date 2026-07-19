// backend/src/modules/production/sop.routes.js
// Rough-Cut Capacity Planning (RCCP) + Sales & Operations Planning (S&OP). Mounted /sop.
import { Router } from 'express';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { runRCCP, runSOP } from './sopEngine.service.js';

const router = Router();
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);
const clampH = (v, d) => Math.max(7, Math.min(730, parseInt(v, 10) || d));
const clampB = (v, d) => Math.max(1, Math.min(90, parseInt(v, 10) || d));

/* GET /sop/rccp?horizon_days=&bucket_days= — rough-cut capacity from MPS */
router.get('/rccp', requirePermission('production', 'view'), async (req, res) => {
  try {
    const result = await runRCCP({
      companyId: cidOf(req),
      horizonDays: clampH(req.query.horizon_days, 168),
      bucketDays: clampB(req.query.bucket_days, 28),
    });
    res.json(result);
  } catch (e) { console.error('[sop/rccp]', e); res.status(500).json({ error: e.message }); }
});

/* GET /sop/plan?horizon_days=&bucket_days= — aggregate demand/supply/inventory */
router.get('/plan', requirePermission('production', 'view'), async (req, res) => {
  try {
    const result = await runSOP({
      companyId: cidOf(req),
      horizonDays: clampH(req.query.horizon_days, 168),
      bucketDays: clampB(req.query.bucket_days, 28),
    });
    res.json(result);
  } catch (e) { console.error('[sop/plan]', e); res.status(500).json({ error: e.message }); }
});

export default router;
