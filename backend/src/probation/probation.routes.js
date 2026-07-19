import express from "express";
import * as controller from "./probation.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/",                        verifyToken, controller.createNotification);
router.get("/",                         verifyToken, controller.getNotifications);
router.put("/by-employee/:employee_id", verifyToken, controller.updateByEmployee);
router.put("/:id",                      verifyToken, controller.updateNotification);

export default router;
