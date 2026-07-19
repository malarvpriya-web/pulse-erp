import express from 'express';
import notificationsRepository from '../repositories/notifications.repository.js';
import { runProbationCheckNow } from '../../../jobs/probation.cron.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';
import pool from '../../../config/db.js';
import { sendPushToUser, isPushConfigured } from '../services/pushSender.js';

const router = express.Router();

// ── Mobile push registration ──────────────────────────────────────────────────
// The Capacitor app POSTs its device token here after the user grants push
// permission (src/mobile/native.js registerPush). Registered before the generic
// /:id routes so the /push paths are never shadowed by them.
router.post('/push/register', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const { token, platform = null } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });
    // A device token is unique: re-registering re-points it to the current user.
    const { rows } = await pool.query(
      `INSERT INTO device_push_tokens (user_id, company_id, token, platform)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, company_id = EXCLUDED.company_id,
             platform = EXCLUDED.platform, last_seen_at = NOW()
       RETURNING id`,
      [uid, companyOf(req), token, platform]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push/unregister', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });
    await pool.query(`DELETE FROM device_push_tokens WHERE token = $1`, [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a test push to the caller's own devices. 503 when push isn't configured
// (no FCM/APNs env) so the caller knows delivery is off, not silently dropped.
router.post('/push/test', async (req, res) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: 'push_not_configured', message: 'Set FCM/APNs env to enable delivery.' });
    const uid = req.user?.userId ?? req.user?.id;
    const result = await sendPushToUser(uid, {
      title: 'Pulse test notification',
      body: 'If you can read this on your phone, push is working. 🎉',
      data: { module: 'notifications', type: 'test' },
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


router.get('/', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    if (!uid) return res.json([]);
    const cid = req.scope?.company_id ?? companyOf(req);
    const notifications = await notificationsRepository.findByUser(uid, cid, req.query);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const cid = req.scope?.company_id ?? companyOf(req);
    const count = await notificationsRepository.getUnreadCount(uid, cid);
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const notification = await notificationsRepository.create(req.body);
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    const notification = await notificationsRepository.markAsRead(req.params.id, uid);
    res.json(notification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/mark-all-read', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    await notificationsRepository.markAllAsRead(uid);
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const uid = req.user?.userId ?? req.user?.id;
    await notificationsRepository.delete(req.params.id, uid);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Policy update notification — broadcasts to all employees in the company
router.post('/policy-update', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, version, category, changelog, effective_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    // Queue a notification for each active employee in the company
    // This is a best-effort fire-and-forget; failures are logged but don't block the save
    notificationsRepository.create({
      type: 'policy_update',
      title: `Policy Updated: ${title}`,
      message: `${category ? `[${category}] ` : ''}${title} ${version || ''} has been updated.${changelog ? ` Changes: ${changelog}` : ''}${effective_date ? ` Effective: ${effective_date}` : ''}`,
      company_id: cid,
      broadcast: true,
    }).catch(() => {});
    res.json({ success: true, message: 'Policy update notification queued.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual trigger for probation check (super_admin only)
router.post('/run-probation-check', async (req, res) => {
  // hasRole checks every role held, not just the primary one.
  if (!hasRole(req, 'super_admin', 'admin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await runProbationCheckNow();
    res.json({ message: 'Probation check completed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
