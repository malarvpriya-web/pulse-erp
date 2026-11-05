import express from "express";
import { verifyToken, requirePermission } from "../middlewares/auth.middleware.js";
import { requireCompany, ProbationError } from "./probation.service.js";
import { companyOf } from "../shared/scope.js";
import {
  worklist, employeeReviews, requestReview, myReviews, submitReview, mySummary, reassignReview,
} from "./probationReviews.service.js";

/**
 * Probation reviews. Mounted at /probation-reviews (with auditMutations('hr')).
 *
 * HR side — the EXISTING `hr` permission: view for the worklist and an
 * employee's review history, add to request a review.
 *
 * Reviewer side (/mine) — no module permission at all, by design: a
 * department head holds no `hr` grant and gets none here. Authorization is
 * identity: the caller's linked employee record must be the review's
 * assigned reviewer, in the caller's company (see probationReviews.service).
 *
 * Every route resolves the caller's company first; none → 403.
 */
const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    const companyId = requireCompany(req);
    res.json(await fn(companyId, req));
  } catch (err) {
    if (err instanceof ProbationError) return res.status(err.status).json({ error: err.message });
    console.error('[ProbationReviews]', err);
    res.status(500).json({ error: err.message });
  }
};
const actorOf = (req) => req?.user?.userId ?? req?.user?.id ?? null;

// Reviewer (identity-scoped). Registered before the HR routes' params.
// /mine/summary drives the "My Probation Reviews" menu entry: it never errors
// for a non-head (is_head: false), so the entry simply stays hidden.
router.get("/mine/summary", verifyToken, async (req, res) => {
  try {
    res.json(await mySummary(companyOf(req), req));
  } catch (err) {
    console.error('[ProbationReviews] summary', err);
    res.status(500).json({ error: err.message });
  }
});
router.get("/mine", verifyToken,
  handle((cid, req) => myReviews(cid, req)));
router.post("/mine/:reviewId/submit", verifyToken,
  handle((cid, req) => submitReview(cid, req.params.reviewId, req.body, req)));

// HR
router.get("/", verifyToken, requirePermission('hr', 'view'),
  handle((cid, req) => worklist(cid, req.query)));
router.get("/employees/:employeeId", verifyToken, requirePermission('hr', 'view'),
  handle((cid, req) => employeeReviews(cid, req.params.employeeId)));
router.post("/", verifyToken, requirePermission('hr', 'add'),
  handle((cid, req) => requestReview(cid, req.body, actorOf(req), req)));
// Move an unsubmitted review to the employee's CURRENT department head (the
// server resolves who; the body carries only the reason). Existing hr:edit.
router.post("/:reviewId/reassign", verifyToken, requirePermission('hr', 'edit'),
  handle((cid, req) => reassignReview(cid, req.params.reviewId, req.body, actorOf(req), req)));

export default router;
