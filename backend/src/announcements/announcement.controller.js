import * as announcementService from "./announcement.service.js";
import pool from "../config/db.js";

async function writeAudit(req, action, refId) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (user_id, module_name, action_type, reference_id, reference_type, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user?.userId ?? req.user?.id ?? null, 'Announcements', action, String(refId), 'announcement',
       req.ip, req.get('user-agent')]
    );
  } catch (_) { /* non-critical */ }
}

// Insert an in-app notification row for every relevant employee user account.
// Best-effort — errors are silently swallowed so they never break the main request.
async function notifyEmployees(announcement) {
  try {
    const cid = announcement.company_id ?? null;
    let rows;
    if (announcement.target_type === 'employee') {
      const r = await pool.query(
        `SELECT user_id FROM employees WHERE id=$1 AND user_id IS NOT NULL`,
        [announcement.target_value]
      );
      rows = r.rows;
    } else if (announcement.target_type === 'department') {
      const r = await pool.query(
        `SELECT user_id FROM employees
          WHERE LOWER(department)=LOWER($1)
            AND user_id IS NOT NULL
            AND ($2::int IS NULL OR company_id = $2)`,
        [announcement.target_value, cid]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT user_id FROM employees
          WHERE user_id IS NOT NULL
            AND ($1::int IS NULL OR company_id = $1)
          LIMIT 500`,
        [cid]
      );
      rows = r.rows;
    }
    if (!rows.length) return;

    const title = `📢 New announcement: ${announcement.title}`;
    const msg   = announcement.message || '';
    const vals = rows.map((_, i) =>
      `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6})`
    ).join(',');
    const params = rows.flatMap(row =>
      [row.user_id, title, msg, 'Announcements', announcement.id, 'announcement']
    );
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type) VALUES ${vals}`,
      params
    );
  } catch (_) { /* non-critical */ }
}

function validateDates(from_date, to_date) {
  if (from_date && to_date && from_date > to_date) {
    return 'End date cannot be before start date';
  }
  return null;
}

export const createAnnouncement = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const {
      title, message, from_date, to_date,
      target_type, target_value, is_active, is_pinned, publish_at,
      priority, category,
    } = req.body;

    if (!title?.trim())   return res.status(400).json({ message: 'Title is required' });
    if (!from_date)       return res.status(400).json({ message: 'Start date is required' });
    if (!to_date)         return res.status(400).json({ message: 'End date is required' });
    const dateErr = validateDates(from_date, to_date);
    if (dateErr)          return res.status(400).json({ message: dateErr });

    const createdBy = req.user?.userId ?? req.user?.id ?? null;
    const announcement = await announcementService.addAnnouncement(
      cid, title.trim(), message, from_date, to_date,
      target_type || 'all', target_value || '', is_active, is_pinned, publish_at,
      priority, category, createdBy
    );
    await writeAudit(req, 'CREATE', announcement.id);
    // Notify immediately only when active and not scheduled for the future
    const scheduledFuture = announcement.publish_at && new Date(announcement.publish_at) > new Date();
    if (announcement.is_active && !scheduledFuture) {
      await notifyEmployees(announcement);
    }
    res.status(201).json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getAllAnnouncements = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const announcements = await announcementService.getAnnouncements(cid);
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Public endpoint (login screen / dashboard widgets).
// Accepts optional ?company_id=N query param so multi-tenant callers
// can scope results without a JWT (e.g. embedded login widget).
export const getActiveAnnouncements = async (req, res) => {
  try {
    // Prefer authenticated scope, then query param, then null (all companies)
    const cid =
      req.scope?.company_id ??
      (req.query.company_id ? Number(req.query.company_id) : null);

    await announcementService.deleteExpiredAnnouncements(cid);
    const announcements = await announcementService.getActiveAnnouncements(cid);
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateAnnouncement = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { id } = req.params;
    const {
      title, message, from_date, to_date,
      target_type, target_value, is_active, is_pinned, publish_at,
      priority, category,
    } = req.body;

    if (!title?.trim())   return res.status(400).json({ message: 'Title is required' });
    if (!from_date)       return res.status(400).json({ message: 'Start date is required' });
    if (!to_date)         return res.status(400).json({ message: 'End date is required' });
    const dateErr = validateDates(from_date, to_date);
    if (dateErr)          return res.status(400).json({ message: dateErr });

    const announcement = await announcementService.updateAnnouncement(
      id, cid, title.trim(), message, from_date, to_date,
      target_type || 'all', target_value || '', is_active, is_pinned, publish_at,
      priority, category
    );
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    await writeAudit(req, 'UPDATE', id);
    res.json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const toggleStatus = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { id } = req.params;
    const { is_active } = req.body;
    const announcement = await announcementService.toggleAnnouncementStatus(id, is_active, cid);
    await writeAudit(req, 'UPDATE', id);
    res.json(announcement);
  } catch (err) {
    res.status(err.message.includes('Cannot activate') ? 400 : 500).json({ message: err.message });
  }
};

export const togglePin = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { id } = req.params;
    const { is_pinned } = req.body;
    const announcement = await announcementService.togglePinned(id, is_pinned, cid);
    await writeAudit(req, 'UPDATE', id);
    res.json(announcement);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const markRead = async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    await announcementService.markAnnouncementRead(req.params.id, userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteAnnouncement = async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { id } = req.params;
    await writeAudit(req, 'DELETE', id);
    await announcementService.deleteAnnouncement(id, cid);
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
