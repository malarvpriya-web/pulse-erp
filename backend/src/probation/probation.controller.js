import * as service from "./probation.service.js";

export const createNotification = async (req, res) => {
  try {
    const notification = await service.createNotification(req.body);
    res.json(notification);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getNotifications = async (req, res) => {
  try {
    const notifications = await service.getNotifications();
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateNotification = async (req, res) => {
  try {
    const notification = await service.updateNotification(req.params.id, req.body);
    res.json(notification);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
