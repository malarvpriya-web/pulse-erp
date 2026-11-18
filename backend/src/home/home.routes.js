import express from "express";
import * as homeController from "./home.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";
import { getMyEmploymentHandler } from "./myEmployment.js";
import { getMyRecordHandler } from "./myRecord.js";
import { getMySalesTargetHandler } from "./mySalesTarget.js";

const router = express.Router();

router.get("/summary",        verifyToken, homeController.getHomeSummary);
// HR > My Dashboard: the caller's own probation / notice / attendance status.
router.get("/my-employment",  verifyToken, getMyEmploymentHandler);
// HR > Self Service > My Details: the caller's own employee record, read-only.
router.get("/my-record",      verifyToken, getMyRecordHandler);
// HR > My Dashboard: the caller's own yearly sales target, by month, with achievement.
router.get("/my-sales-target", verifyToken, getMySalesTargetHandler);
router.get("/announcements",  verifyToken, homeController.getAnnouncements);
router.get("/events/upcoming",verifyToken, homeController.getUpcomingEvents);
router.get("/celebrations",   verifyToken, homeController.getCelebrations);
router.get("/policies",       verifyToken, homeController.getPolicies);
router.get("/resources",      verifyToken, homeController.getResources);
router.get("/holidays",       verifyToken, homeController.getHolidays);
router.get("/holidays/all",   verifyToken, homeController.getAllHolidays);
router.get("/documents/:kind/:id/download", verifyToken, homeController.downloadDocument);

export default router;
