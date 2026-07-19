import express from "express";
import * as controller from "./approvals.controller.js";
import { canActOnApproval, requireApproverRole } from "./approvals.authz.js";

const router = express.Router();

// Reads: the controller already scopes these to the caller
// (getPendingApprovals filters on approver_id), so no extra gate here.
router.get("/",            controller.getAllApprovals);
router.get("/pending",     controller.getPendingApprovals);
router.get("/history",     controller.getApprovalHistory);
router.get("/stats",       controller.getApprovalStats);
router.get("/delegates",   controller.getDelegateUsers);
router.get("/:id/chain",   controller.getApprovalChain);

// Writes: every route below decides someone else's request. Until 2026-07-19
// these were gated by verifyToken alone — any authenticated user, including a
// plain `employee`, could approve anything. See approvals.authz.js.
router.post("/bulk-approve", requireApproverRole, controller.bulkApprove);
router.post("/bulk-reject",  requireApproverRole, controller.bulkReject);
router.post("/delegate",     requireApproverRole, controller.delegateApprovals);

router.post("/:id/approve",  canActOnApproval, controller.approveRequest);
router.post("/:id/reject",   canActOnApproval, controller.rejectRequest);
router.post("/:id/escalate", canActOnApproval, controller.escalateRequest);

export default router;
