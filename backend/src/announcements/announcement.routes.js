import express from "express";
import * as announcementController from "./announcement.controller.js";
import { verifyToken, requirePermission } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Every route needs a login. /active used to be public: with no token it read —
// and deleted from — every company's announcements.
router.use(verifyToken);

// Employee-facing, self-scoped: the caller's own company, audience and reads.
// Deliberately NOT behind the matrix — many roles (e.g. service_engineer) hold no
// 'announcements' row, and what these return is limited to what is addressed to
// the caller anyway.
router.get("/active",     announcementController.getActiveAnnouncements);
router.post("/:id/read",  announcementController.markRead);

// Management. role_permissions module 'announcements' decides; Employee holds
// view only, so it reaches none of these. The list is gated on `add` rather than
// `view` because it includes drafts, scheduled posts and other audiences.
router.get("/",           requirePermission('announcements', 'add'),    announcementController.getAllAnnouncements);
router.post("/",          requirePermission('announcements', 'add'),    announcementController.createAnnouncement);
router.put("/:id",        requirePermission('announcements', 'edit'),   announcementController.updateAnnouncement);
router.put("/:id/toggle", requirePermission('announcements', 'edit'),   announcementController.toggleStatus);
router.put("/:id/pin",    requirePermission('announcements', 'edit'),   announcementController.togglePin);
router.delete("/:id",     requirePermission('announcements', 'delete'), announcementController.deleteAnnouncement);

/** The read-receipt route, for auditMutations' skip (server.js). */
export const isAnnouncementReadReceipt = (req) => req.method === 'POST' && /^\/\d+\/read\/?$/.test(req.path);

export default router;
