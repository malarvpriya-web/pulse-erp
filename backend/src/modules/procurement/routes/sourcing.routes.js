/**
 * Sourcing strategy routes — the category board (1.7.4).
 *
 * Base: /api/procurement-sourcing  (also served under /api/v1/...)
 *
 * Nothing here catches a query error and substitutes an empty array. A failed
 * SQL statement must reach the client as a 500 that someone can see, because
 * the alternative — the `.catch(() => [])` this codebase has been bitten by
 * nineteen times in one module alone — renders as a confident zero.
 */
import express from 'express';
import svc from '../services/sourcingStrategy.service.js';
import { CHESSBOARD, FORCES, allMethods, MIN_COVERAGE_PCT } from '../engines/sourcingStrategyEngine.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const scopeOf = (req) => req.scope?.company_id ?? companyOf(req);

const windowOpts = (req) => ({
  months: req.query.months ? Number(req.query.months) : 12,
  from: req.query.from || null,
  to: req.query.to || null,
});

const fail = (res, err) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message });
};

// ── Static routes first — /:categoryKey would otherwise swallow them ──────────

/**
 * The frameworks themselves, so the UI can render the board and the method
 * picker without hard-coding sixty-four strings it would then have to keep in
 * step with the engine.
 */
router.get('/taxonomy', (req, res) => {
  res.json({
    forces: FORCES,
    quadrants: Object.values(CHESSBOARD).map((q) => ({
      key: q.key,
      quadrant: q.quadrant,
      axis: q.axis,
      thesis: q.thesis,
      levers: q.levers.map((l) => ({
        key: l.key,
        label: l.label,
        methods: l.methods.map((m) => ({ key: m.key, label: m.label, requires: m.requires })),
      })),
    })),
    method_count: allMethods().length,
    min_coverage_pct: MIN_COVERAGE_PCT,
  });
});

/** The whole board: every category, positioned, with its top plays. */
router.get('/portfolio', async (req, res) => {
  try {
    res.json(await svc.getPortfolio(scopeOf(req), windowOpts(req)));
  } catch (err) {
    fail(res, err);
  }
});

// ── Per-category ──────────────────────────────────────────────────────────────

/**
 * One category in full: all sixteen methods of its quadrant, the five forces
 * with their drivers, and the suppliers who serve it with their §49G health
 * band — the "category AND supplier segment" half of the brief.
 *
 * `:categoryKey` is an item_categories id, or the literal `uncategorised` for
 * spend whose item carries no category. That bucket is a first-class row, not
 * an error case.
 */
router.get('/categories/:categoryKey', async (req, res) => {
  try {
    const data = await svc.getCategory(scopeOf(req), req.params.categoryKey, windowOpts(req));
    if (!data) return res.status(404).json({ error: 'Category not found on the sourcing board' });
    res.json(data);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Record the approach chosen for this category.
 *
 * The body carries `method_key` and the human's reasoning; the lever and
 * quadrant are resolved from the engine's taxonomy server-side, so a client
 * cannot file a method under a quadrant it does not belong to.
 */
router.post('/categories/:categoryKey/strategy', async (req, res) => {
  try {
    // users.id — the JWT's id space. Named on the column for the same reason
    // (`decided_by_user_id`), because employees(id) and users(id) have been
    // confused four separate times in this codebase.
    const userId = req.user?.id ?? null;
    const saved = await svc.saveStrategy(scopeOf(req), req.params.categoryKey, req.body || {}, userId);
    res.status(201).json(saved);
  } catch (err) {
    fail(res, err);
  }
});

export default router;
