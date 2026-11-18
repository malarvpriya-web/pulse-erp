// backend/src/modules/hr/lnd-settings.routes.js
//
// L&D settings — every field here is read by the code (2026-11-18):
//   training_categories        category list on trainings + certifications
//   default_pass_score / default_max_attempts   new tests
//   default_refresher_months   new mandatory trainings
//   reminder_days_before       daily job: upcoming-training reminder
//   cert_expiry_reminder_days  daily job: certificate expiry reminder
//   enable_email_notifications mail beside in-app (needs SMTP)
//   enable_manager_notifications  managers hear about their team's overdue items
//   feedback_required / min_feedback_chars   My Learning feedback
//   allow_self_enrollment / max_concurrent_enrollments   My Learning enrolment
// Save used to fail outright (a JSON string into a text[] column).
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { requireCompanyScope } from '../../shared/scope.js';
import { cid, getSettings, sendError, httpError, SETTINGS_DEFAULTS } from './lnd/lndShared.js';

const router = express.Router();
router.use(requireCompanyScope);

router.get('/', requirePermission('training', 'view'), async (req, res) => {
  try { res.json({ company_id: cid(req), ...(await getSettings(cid(req))) }); }
  catch (err) { sendError(res, err, 'Could not load settings'); }
});

const INT_RANGES = {
  default_pass_score: [1, 100], default_max_attempts: [1, 20], reminder_days_before: [0, 60],
  cert_expiry_reminder_days: [1, 365], default_refresher_months: [1, 60], min_feedback_chars: [0, 2000],
  max_concurrent_enrollments: [1, 50],
};
const BOOLS = ['enable_email_notifications', 'enable_manager_notifications', 'feedback_required', 'allow_self_enrollment'];

router.put('/', requirePermission('training', 'edit'), async (req, res) => {
  const companyId = cid(req);
  const b = req.body || {};
  try {
    const cur = await getSettings(companyId);
    const next = { ...cur };
    if (b.training_categories !== undefined) {
      if (!Array.isArray(b.training_categories)) throw httpError(400, 'Categories must be a list');
      const cats = [...new Set(b.training_categories.map(c => String(c).trim()).filter(Boolean))];
      if (!cats.length) throw httpError(400, 'Keep at least one training category');
      if (cats.some(c => c.length > 60)) throw httpError(400, 'A category name is too long');
      next.training_categories = cats;
    }
    for (const [k, [lo, hi]] of Object.entries(INT_RANGES)) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw httpError(400, `${k.replace(/_/g, ' ')} must be a whole number from ${lo} to ${hi}`);
      next[k] = v;
    }
    for (const k of BOOLS) if (b[k] !== undefined) next[k] = !!b[k];
    const { rows: prior } = await pool.query(`SELECT * FROM lnd_settings WHERE company_id IS NOT DISTINCT FROM $1::int`, [companyId]);
    req._auditBefore = prior[0] ?? null;
    const keys = Object.keys(SETTINGS_DEFAULTS);
    const vals = keys.map(k => next[k]);
    const ph = keys.map((k, i) => (k === 'training_categories' ? `$${i + 2}::text[]` : `$${i + 2}`));
    const { rows } = await pool.query(
      `INSERT INTO lnd_settings (company_id, ${keys.join(', ')}) VALUES ($1, ${ph.join(', ')})
       ON CONFLICT (company_id) DO UPDATE SET ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = NOW()
       RETURNING *`, [companyId, ...vals]);
    res.json(rows[0]);
  } catch (err) { sendError(res, err, 'Settings were not saved'); }
});

export default router;
