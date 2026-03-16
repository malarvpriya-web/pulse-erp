import express from "express";
import * as leaveController from "./leave.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/", verifyToken, leaveController.createLeave);
router.get("/my", verifyToken, leaveController.getMyLeaves);
router.get("/team", verifyToken, leaveController.getTeamLeaves);
router.get("/", verifyToken, leaveController.getAllLeaves);
router.patch("/:id/approve", verifyToken, leaveController.approveLeave);
router.patch("/:id/reject", verifyToken, leaveController.rejectLeave);

export default router;
