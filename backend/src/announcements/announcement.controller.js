import * as announcementService from "./announcement.service.js";

export const createAnnouncement = async (req, res) => {
  try {
    const { title, message, from_date, to_date, target_type, target_value, is_active } = req.body;
    const announcement = await announcementService.addAnnouncement(title, message, from_date, to_date, target_type, target_value, is_active);
    res.status(201).json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getAllAnnouncements = async (req, res) => {
  try {
    const announcements = await announcementService.getAnnouncements();
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getActiveAnnouncements = async (req, res) => {
  try {
    await announcementService.deleteExpiredAnnouncements();
    const announcements = await announcementService.getActiveAnnouncements();
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, message, from_date, to_date, target_type, target_value, is_active } = req.body;
    const announcement = await announcementService.updateAnnouncement(id, title, message, from_date, to_date, target_type, target_value, is_active);
    res.json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const toggleStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const announcement = await announcementService.toggleAnnouncementStatus(id, is_active);
    res.json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    await announcementService.deleteAnnouncement(id);
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
