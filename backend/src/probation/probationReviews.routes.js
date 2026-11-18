import express from "express";
import { verifyToken, requirePermission, can } from "../middlewares/auth.middleware.js";
import pool from "../config/db.js";
import { employeeOf } from "../shared/scope.js";
import { learningSnapshot } from "../modules/hr/lnd/lndSnapshot.js";
import { requireCompany, ProbationError } from "./probation.service.js";
import { companyOf } from "../shared/scope.js";
import { buildProbationLetterPdf } from "../utils/probationLetterPdf.js";
import {
  worklist, employeeReviews, requestReview, myReviews, submitReview, mySummary, reassignReview, decideReview, cancelReview, letterContent,
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
// HR's decision on a SUBMITTED review, applied to the employee record in the
// same transaction (confirm / extend / not confirmed → exit). Existing hr:edit,
// the grant that edits the employee record.
router.post("/:reviewId/decide", verifyToken, requirePermission('hr', 'edit'),
  handle((cid, req) => decideReview(cid, req.params.reviewId, req.body, actorOf(req), req)));

// Withdraw an open review (requested or submitted) with a reason. hr:edit.
router.post("/:reviewId/cancel", verifyToken, requirePermission('hr', 'edit'),
  handle((cid, req) => cancelReview(cid, req.params.reviewId, req.body, actorOf(req), req)));

// Confirmation / extension letter of a decided review, as a PDF. hr:view.
router.get("/:reviewId/letter", verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const companyId = requireCompany(req);
    const content = await letterContent(companyId, req.params.reviewId);
    const pdf = await buildProbationLetterPdf(content);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${content.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (err) {
    if (err instanceof ProbationError) return res.status(err.status).json({ error: err.message });
    console.error('[ProbationReviews] letter', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /probation-reviews/:reviewId/learning — the employee's learning during
 * the probation period (trainings, tests, mandatory status, certificates,
 * skills, before/after self-review) beside the review (Learning Center,
 * 2026-11-18). HR (hr:view) or the review's assigned reviewer only.
 */
router.get("/:reviewId/learning", verifyToken, async (req, res) => {
  try {
    const companyId = requireCompany(req);
    const { rows: [r] } = await pool.query(
      `SELECT r.employee_id, r.reviewer_employee_id, r.period_start::text AS period_start, e.joining_date::text AS joining_date
         FROM probation_reviews r JOIN employees e ON e.id = r.employee_id
        WHERE r.id = $1 AND r.company_id = $2`, [req.params.reviewId, companyId]);
    if (!r) return res.status(404).json({ error: 'Review not found' });
    const me = await employeeOf(req, pool);
    if (!(await can(req, 'hr', 'view')) && (me == null || me !== r.reviewer_employee_id)) {
      return res.status(403).json({ error: 'Only HR or the assigned reviewer can see this.' });
    }
    res.json(await learningSnapshot(pool, companyId, r.employee_id, { since: r.period_start || r.joining_date }));
  } catch (err) {
    if (err instanceof ProbationError) return res.status(err.status).json({ error: err.message });
    console.error('[ProbationReviews] learning', err);
    res.status(500).json({ error: 'Could not load the learning record' });
  }
});

export default router;
