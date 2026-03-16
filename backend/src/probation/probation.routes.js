import express from "express";
import * as controller from "./probation.controller.js";

const router = express.Router();

router.post("/", controller.createNotification);
router.get("/", controller.getNotifications);
router.put("/:id", controller.updateNotification);

export default router;
