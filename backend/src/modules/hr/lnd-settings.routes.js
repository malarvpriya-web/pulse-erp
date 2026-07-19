// backend/src/modules/hr/lnd-settings.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => req.scope?.company_id ?? null;
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','lnd_admin','HR','Admin','SuperAdmin'];

/* ── GET /lnd-settings ──────────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM lnd_settings WHERE company_id IS NOT DISTINCT FROM $1 LIMIT 1`,
      [companyId]
    );
    if (!rows.length) {
      // Return defaults if not configured yet
      return res.json({
        company_id: companyId,
        training_categories: ['Technical','Soft Skills','Safety','Compliance','Leadership','Onboarding'],
        default_pass_score: 70,
        reminder_days_before: 7,
        cert_expiry_reminder_days: 30,
        enable_email_notifications: true,
        enable_manager_notifications: true,
        mandatory_training_freq_days: 365,
        feedback_required: true,
        min_feedback_chars: 10,
        allow_self_enrollment: true,
        max_concurrent_enrollments: 5,
      });
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /lnd-settings ──────────────────────────────────────── */
router.put('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const companyId = cid(req);
  const {
    training_categories,
    default_pass_score,
    reminder_days_before,
    cert_expiry_reminder_days,
    enable_email_notifications,
    enable_manager_notifications,
    mandatory_training_freq_days,
    feedback_required,
    min_feedback_chars,
    allow_self_enrollment,
    max_concurrent_enrollments,
  } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO lnd_settings (
        company_id, training_categories, default_pass_score,
        reminder_days_before, cert_expiry_reminder_days,
        enable_email_notifications, enable_manager_notifications,
        mandatory_training_freq_days, feedback_required,
        min_feedback_chars, allow_self_enrollment, max_concurrent_enrollments
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (company_id) DO UPDATE SET
        training_categories          = COALESCE($2, lnd_settings.training_categories),
        default_pass_score           = COALESCE($3, lnd_settings.default_pass_score),
        reminder_days_before         = COALESCE($4, lnd_settings.reminder_days_before),
        cert_expiry_reminder_days    = COALESCE($5, lnd_settings.cert_expiry_reminder_days),
        enable_email_notifications   = COALESCE($6, lnd_settings.enable_email_notifications),
        enable_manager_notifications = COALESCE($7, lnd_settings.enable_manager_notifications),
        mandatory_training_freq_days = COALESCE($8, lnd_settings.mandatory_training_freq_days),
        feedback_required            = COALESCE($9, lnd_settings.feedback_required),
        min_feedback_chars           = COALESCE($10, lnd_settings.min_feedback_chars),
        allow_self_enrollment        = COALESCE($11, lnd_settings.allow_self_enrollment),
        max_concurrent_enrollments   = COALESCE($12, lnd_settings.max_concurrent_enrollments),
        updated_at                   = NOW()
      RETURNING *`,
      [companyId,
       training_categories ? JSON.stringify(training_categories) : null,
       default_pass_score, reminder_days_before, cert_expiry_reminder_days,
       enable_email_notifications, enable_manager_notifications,
       mandatory_training_freq_days, feedback_required,
       min_feedback_chars, allow_self_enrollment, max_concurrent_enrollments]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
