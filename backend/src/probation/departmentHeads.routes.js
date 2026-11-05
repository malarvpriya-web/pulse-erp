import express from "express";
import { verifyToken, requirePermission } from "../middlewares/auth.middleware.js";
import { requireCompany, ProbationError } from "./probation.service.js";
import {
  actorOf, listDepartmentHeads, departmentHistory, assignDepartmentHead, endDepartmentHead,
} from "./departmentHeads.service.js";

/**
 * Department heads (per company). Mounted at /department-heads.
 *
 * Gated on the EXISTING `hr` permission — view to read, edit to assign or end.
 * The `department_head` role holds no `hr` permission, so a department head
 * can neither see nor change this, and no permission row is added for it.
 * Every handler also resolves the caller's company first: no company context
 * → 403 before any query runs.
 */
const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    const companyId = requireCompany(req);
    res.json(await fn(companyId, req));
  } catch (err) {
    if (err instanceof ProbationError) return res.status(err.status).json({ error: err.message });
    console.error('[DepartmentHeads]', err);
    res.status(500).json({ error: err.message });
  }
};

router.get("/", verifyToken, requirePermission('hr', 'view'),
  handle((cid) => listDepartmentHeads(cid)));
router.get("/:departmentId/history", verifyToken, requirePermission('hr', 'view'),
  handle((cid, req) => departmentHistory(cid, req.params.departmentId)));
router.put("/:departmentId", verifyToken, requirePermission('hr', 'edit'),
  handle((cid, req) => assignDepartmentHead(cid, req.params.departmentId, req.body, actorOf(req))));
router.delete("/:departmentId", verifyToken, requirePermission('hr', 'edit'),
  handle((cid, req) => endDepartmentHead(cid, req.params.departmentId, req.body, actorOf(req))));

export default router;
