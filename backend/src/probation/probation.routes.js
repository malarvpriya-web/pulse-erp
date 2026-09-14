import express from "express";
import * as controller from "./probation.controller.js";
import { verifyToken, requirePermission } from "../middlewares/auth.middleware.js";

const router = express.Router();

/**
 * Probation notifications are employment-status records: who is on probation,
 * until when, and what was decided. Every route here carried verifyToken alone,
 * so a live probe on 2026-09-04 with a plain `employee` token returned 39 rows
 * covering four people's probation state.
 *
 * Gated on `hr` rather than scoped to the caller: unlike leave balance, an
 * employee has no routine need to read the probation register at all, and their
 * own status reaches them through onboarding and self-service. `hr`.`view` is
 * granted to hr, hr_manager, hr_exec, admin and super_admin.
 */
router.post("/",                        verifyToken, requirePermission('hr', 'add'),  controller.createNotification);
router.get("/",                         verifyToken, requirePermission('hr', 'view'), controller.getNotifications);
router.put("/by-employee/:employee_id", verifyToken, requirePermission('hr', 'edit'), controller.updateByEmployee);
router.put("/:id",                      verifyToken, requirePermission('hr', 'edit'), controller.updateNotification);

export default router;
