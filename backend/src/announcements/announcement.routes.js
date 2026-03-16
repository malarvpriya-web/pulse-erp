import express from "express";
import * as announcementController from "./announcement.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/", verifyToken, announcementController.createAnnouncement);
router.get("/", verifyToken, announcementController.getAllAnnouncements);
router.get("/active", announcementController.getActiveAnnouncements);
router.put("/:id", verifyToken, announcementController.updateAnnouncement);
router.put("/:id/toggle", verifyToken, announcementController.toggleStatus);
router.delete("/:id", verifyToken, announcementController.deleteAnnouncement);

export default router;
