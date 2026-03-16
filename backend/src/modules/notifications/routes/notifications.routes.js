import express from 'express';
import notificationsRepository from '../repositories/notifications.repository.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const notifications = await notificationsRepository.findByUser(req.user?.id, req.query);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const count = await notificationsRepository.getUnreadCount(req.user?.id);
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
    const notification = await notificationsRepository.markAsRead(req.params.id, req.user?.id);
    res.json(notification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/mark-all-read', async (req, res) => {
  try {
    await notificationsRepository.markAllAsRead(req.user?.id);
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await notificationsRepository.delete(req.params.id, req.user?.id);
    res.json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
