/**
 * RFx evaluation routes — selecting a preferred vendor (§136, spec 1.7.5).
 *
 * Base: /api/rfx  (also served under /api/v1/rfx)
 *
 * Sits beside the existing /procurement/rfqs endpoints rather than replacing
 * them: those raise an event and collect quotes, these evaluate it. The event
 * table is the same `rfqs` row, now carrying an `rfx_type`.
 *
 * As in sourcing.routes.js, no handler swallows a query error into an empty
 * result. A 500 that someone can see beats a zero nobody questions.
 */
import express from 'express';
import svc from '../services/rfxScoring.service.js';
import { RFX_MODELS, RFX_TYPES, MIN_COVERAGE_PCT } from '../engines/rfxScoringEngine.js';
import { companyOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';
/**
 * AUTHORIZATION. This router was mounted behind `verifyToken` and NOTHING else,
 * so every route below was reachable by any authenticated account regardless of
 * role — including the writes. `requireProcurement(action, ...alsoAllowRoles)`
 * ORs the role_permissions matrix with named roles, which is how the rest of the
 * module is gated; the named roles are the documented exceptions, not a bypass.
 */

const router = express.Router();

const scopeOf = (req) => req.scope?.company_id ?? companyOf(req);

/**
 * The acting user's **users.id**.
 *
 * `verifyToken` assigns `req.user = decoded`, the raw JWT payload, and that
 * payload's field is `userId` — `req.user.id` is undefined. Reading `.id`
 * alone stores NULL for the actor, which is exactly the "who decided this"
 * gap the frozen snapshots exist to close. The fallback chain matches the
 * 410 other call sites in this codebase.
 */
const actorUserId = (req) => req.user?.userId ?? req.user?.id ?? null;

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

// ── Static routes first ───────────────────────────────────────────────────────

/** The three scoring models, so the UI renders criteria it cannot drift from. */
router.get('/models', requireProcurement('view'), (req, res) => {
  res.json({
    types: RFX_TYPES,
    models: RFX_MODELS,
    min_coverage_pct: MIN_COVERAGE_PCT,
  });
});

/** RFx events with their invitation / response / scoring counts. */
router.get('/events', requireProcurement('view'), async (req, res) => {
  try {
    const rfxType = req.query.type ? String(req.query.type).toUpperCase() : null;
    if (rfxType && !RFX_TYPES.includes(rfxType)) {
      return res.status(400).json({ error: `Unknown RFx type '${rfxType}'` });
    }
    res.json(await svc.listEvents(scopeOf(req), { rfxType }));
  } catch (err) {
    fail(res, err);
  }
});

// ── Per-event ─────────────────────────────────────────────────────────────────

/** The full scorecard: model, every bid, per-criterion scores, and the ranking. */
router.get('/:rfqId/scorecard', requireProcurement('view'), async (req, res) => {
  try {
    const card = await svc.getScorecard(scopeOf(req), req.params.rfqId);
    if (!card) return res.status(404).json({ error: 'RFx event not found' });
    res.json(card);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Record a human's assessment of one or more criteria for one vendor.
 *
 * Body: { scores: [{ criterion_key, score, note }] }. Criteria are validated
 * against the event's own model, so a score cannot be filed against a criterion
 * the model does not contain.
 */
router.post('/:rfqId/vendors/:vendorId/scores', requireProcurement('edit'), async (req, res) => {
  try {
    const scores = Array.isArray(req.body?.scores) ? req.body.scores : [];
    if (!scores.length) return res.status(400).json({ error: 'No scores supplied' });
    // users.id — the JWT's id space, named on the column to match.
    const userId = actorUserId(req);
    const written = await svc.saveScores(scopeOf(req), req.params.rfqId, req.params.vendorId, scores, userId);
    res.status(201).json({ saved: written.length, scores: written });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Make this vendor the preferred source for everything the event covered.
 *
 * Refuses with 409 when the engine's verdict is anything but `recommended`
 * unless the caller passes `acknowledge_override`. That is not bureaucracy: the
 * two verdicts it blocks on are "the leader's margin is inside the uncertainty
 * from unscored criteria" and "not enough of the model is complete to rank
 * from", and clicking through either without noticing is the failure this whole
 * scorecard exists to prevent.
 */
router.post('/:rfqId/preferred-vendor', requireProcurement('approve'), async (req, res) => {
  try {
    const userId = actorUserId(req);
    const result = await svc.selectPreferredVendor(
      scopeOf(req), req.params.rfqId, req.body?.vendor_id, req.body || {}, userId
    );
    res.status(201).json(result);
  } catch (err) {
    fail(res, err);
  }
});

export default router;
