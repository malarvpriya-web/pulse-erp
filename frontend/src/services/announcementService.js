/**
 * announcementService.js — centralized service layer for Announcements API calls.
 * Backend mounts at /announcements (see backend/src/routes/index.js).
 * Every mutation throws on failure — let the caller handle errors.
 */
import api from '@/services/api/client';

// ── Read ─────────────────────────────────────────────────────────────────────

export const getAnnouncements = async (params = {}) => {
  const res = await api.get('/announcements', { params });
  const d = res.data;
  if (Array.isArray(d)) return d;
  return d?.announcements ?? d?.data ?? [];
};

// ── Mutations ────────────────────────────────────────────────────────────────

export const createAnnouncement = async (data) => {
  const res = await api.post('/announcements', data);
  return res.data;
};

export const updateAnnouncement = async (id, data) => {
  const res = await api.put(`/announcements/${id}`, data);
  return res.data;
};

export const toggleAnnouncement = async (id, isActive) => {
  const res = await api.put(`/announcements/${id}/toggle`, { is_active: isActive });
  return res.data;
};

export const deleteAnnouncement = async (id) => {
  const res = await api.delete(`/announcements/${id}`);
  return res.data;
};
