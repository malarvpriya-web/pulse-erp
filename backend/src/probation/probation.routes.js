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
// Every route is also company-scoped in the controller: no company context → 403.
// /settings and /calculate are registered before /:id so they are not read as ids.
router.get("/settings",                 verifyToken, requirePermission('hr', 'view'), controller.getPolicy);
router.put("/settings",                 verifyToken, requirePermission('hr', 'edit'), controller.updatePolicy);
router.get("/calculate",                verifyToken, requirePermission('hr', 'view'), controller.calculate);
router.post("/",                        verifyToken, requirePermission('hr', 'add'),  controller.createNotification);
router.get("/",                         verifyToken, requirePermission('hr', 'view'), controller.getNotifications);
router.put("/by-employee/:employee_id", verifyToken, requirePermission('hr', 'edit'), controller.updateByEmployee);
router.put("/:id",                      verifyToken, requirePermission('hr', 'edit'), controller.updateNotification);

export default router;
