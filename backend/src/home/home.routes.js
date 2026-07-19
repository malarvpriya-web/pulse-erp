import express from "express";
import * as homeController from "./home.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/summary",        verifyToken, homeController.getHomeSummary);
router.get("/announcements",  verifyToken, homeController.getAnnouncements);
router.get("/events/upcoming",verifyToken, homeController.getUpcomingEvents);
router.get("/celebrations",   verifyToken, homeController.getCelebrations);
router.get("/policies",       verifyToken, homeController.getPolicies);
router.get("/resources",      verifyToken, homeController.getResources);
router.get("/holidays",       verifyToken, homeController.getHolidays);
router.get("/holidays/all",   verifyToken, homeController.getAllHolidays);

export default router;
