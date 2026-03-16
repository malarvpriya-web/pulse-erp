import express from "express";
import * as homeController from "./home.controller.js";

const router = express.Router();

router.get("/announcements", homeController.getAnnouncements);
router.get("/events/upcoming", homeController.getUpcomingEvents);
router.get("/celebrations", homeController.getCelebrations);
router.get("/policies", homeController.getPolicies);
router.get("/resources", homeController.getResources);
router.get("/holidays", homeController.getHolidays);
router.get("/holidays/all", homeController.getAllHolidays);

export default router;
