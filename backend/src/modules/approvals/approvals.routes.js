import express from "express";
import * as controller from "./approvals.controller.js";

const router = express.Router();

router.get("/pending", controller.getPendingApprovals);
router.get("/history", controller.getApprovalHistory);
router.get("/stats", controller.getApprovalStats);
router.post("/:id/approve", controller.approveRequest);
router.post("/:id/reject", controller.rejectRequest);
router.post("/bulk-approve", controller.bulkApprove);

export default router;
