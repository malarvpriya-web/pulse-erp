/**
 * forecast.routes.js — forecast categories, submissions, overrides, snapshots
 * and accuracy.
 *
 * Mounted at /api/sales/forecasting (sales.routes.js already owns
 * /api/sales/forecasts/* for the four legacy aggregate endpoints; those stay,
 * unchanged, so nothing that reads them breaks).
 *
 * AUTHORIZATION
 *   view    — read the roll-up, drill into it, read your own submission
 *   edit    — categorise a deal, save/submit your own forecast
 *   approve — override someone else's number, approve a submission, capture a
 *             company-wide snapshot
 *
 * A rep may only submit for THEMSELVES. The owner is always resolved through
 * employeeOf() server-side and never read from the request body; letting the
 * body name the owner would let any rep file a forecast in a colleague's name.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { logAudit } from '../../../services/AuditService.js';
import {
  FORECAST_CATEGORIES, PERIOD_TYPES,
  computeForecast, forecastByOwner, forecastOpportunities, forecastAccuracy, periodBounds,
} from '../services/forecastEngine.js';

const router = express.Router();

const canView    = requirePermission('sales', 'view');
const canEdit    = requirePermission('sales', 'edit');
const canApprove = requirePermission('sales', 'approve');

/**
 * Read the period out of the query string, defaulting to the CURRENT period.
 * Rejects a malformed one with 400 rather than silently substituting today —
 * a forecast page that quietly answers for a different period than the one
 * asked about is worse than an error.
 */
function readPeriod(q) {
  const now = new Date();
  const periodType = String(q.period_type || 'monthly');
  if (!PERIOD_TYPES.includes(periodType)) {
    throw Object.assign(new Error(`period_type must be one of ${PERIOD_TYPES.join(', ')}`), { status: 400 });
  }
  const periodYear = q.period_year != null && q.period_year !== ''
    ? parseInt(q.period_year, 10) : now.getFullYear();
  if (!Number.isInteger(periodYear)) {
    throw Object.assign(new Error('period_year must be an integer'), { status: 400 });
  }

  let periodValue = null;
  if (periodType !== 'annual') {
    periodValue = q.period_value != null && q.period_value !== ''
      ? parseInt(q.period_value, 10)
      : (periodType === 'quarterly' ? Math.ceil((now.getMonth() + 1) / 3) : now.getMonth() + 1);
    if (!Number.isInteger(periodValue)) {
      throw Object.assign(new Error('period_value must be an integer'), { status: 400 });
    }
  }
  // Validates the combination (month 1-12, quarter 1-4) and throws 400 if not.
  periodBounds(periodType, periodYear, periodValue);
  return { periodType, periodYear, periodValue };
}

const fail = (res, err) =>
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });

/* ── Roll-up ─────────────────────────────────────────────────────────────── */

// GET /api/sales/forecasting/categories?period_type=&period_year=&period_value=&owner_employee_id=
router.get('/categories', canView, async (req, res) => {
  try {
    const { periodType, periodYear, periodValue } = readPeriod(req.query);
    const owner = req.query.owner_employee_id ? parseInt(req.query.owner_employee_id, 10) : null;
    const data = await computeForecast(pool, {
      companyId: companyOf(req), periodType, periodYear, periodValue, ownerEmployeeId: owner,
    });
    res.json(data);
  } catch (err) { fail(res, err); }
});

// GET /api/sales/forecasting/categories/:category/opportunities — the drill-down
router.get('/categories/:category/opportunities', canView, async (req, res) => {
  try {
    const { periodType, periodYear, periodValue } = readPeriod(req.query);
    const owner = req.query.owner_employee_id ? parseInt(req.query.owner_employee_id, 10) : null;
    const rows = await forecastOpportunities(pool, {
      companyId: companyOf(req), periodType, periodYear, periodValue,
      category: req.params.category, ownerEmployeeId: owner,
    });
    res.json({ category: req.params.category, count: rows.length, data: rows });
  } catch (err) { fail(res, err); }
});

// GET /api/sales/forecasting/by-rep — the same roll-up, one row per owner.
//
// One grouped query. The first version looped computeForecast() once per owner,
// which is an N+1 that grows with headcount — thirty reps meant thirty-one round
// trips for one page load. forecastByOwner() reuses the identical category
// expression, so a rep's row and the company total agree by construction.
router.get('/by-rep', canView, async (req, res) => {
  try {
    const { periodType, periodYear, periodValue } = readPeriod(req.query);
    const result = await forecastByOwner(pool, {
      companyId: companyOf(req), periodType, periodYear, periodValue,
    });
    res.json(result);
  } catch (err) { fail(res, err); }
});

/* ── Per-deal categorisation ─────────────────────────────────────────────── */

// PATCH /api/sales/forecasting/opportunities/:id/category  { forecast_category }
router.patch('/opportunities/:id/category', canEdit, async (req, res) => {
  try {
    const cid = companyOf(req);
    const category = req.body?.forecast_category;
    // null is a legitimate value: it clears the explicit judgement and returns
    // the deal to the engine's derived default.
    if (category !== null && !FORECAST_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `forecast_category must be null or one of ${FORECAST_CATEGORIES.join(', ')}`,
      });
    }

    const { rows: [before] } = await pool.query(
      `SELECT id, opportunity_name, forecast_category FROM opportunities
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!before) return res.status(404).json({ error: 'Opportunity not found' });

    const { rows: [after] } = await pool.query(
      `UPDATE opportunities SET forecast_category = $1, updated_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)
        RETURNING id, opportunity_name, stage, expected_value, forecast_category`,
      [category, req.params.id, cid]
    );

    logAudit({
      userId: req.user?.userId, module: 'sales', recordId: req.params.id,
      recordType: 'opportunity_forecast_category', action: 'update',
      oldData: { forecast_category: before.forecast_category },
      newData: { forecast_category: category }, req,
    });
    res.json(after);
  } catch (err) { fail(res, err); }
});

/* ── Submissions ─────────────────────────────────────────────────────────── */

// GET /api/sales/forecasting/submissions
router.get('/submissions', canView, async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = [cid];
    let where = `WHERE ($1::int IS NULL OR s.company_id = $1)`;
    for (const [col, val] of [
      ['period_type', req.query.period_type], ['period_year', req.query.period_year],
      ['period_value', req.query.period_value], ['status', req.query.status],
      ['owner_employee_id', req.query.owner_employee_id],
    ]) {
      if (val != null && val !== '') { params.push(val); where += ` AND s.${col} = $${params.length}`; }
    }
    const { rows } = await pool.query(
      `SELECT s.*, e.name AS owner_name, sb.name AS submitted_by_name, ob.name AS override_by_name
         FROM sales_forecast_submissions s
         LEFT JOIN employees e  ON e.id  = s.owner_employee_id
         LEFT JOIN employees sb ON sb.id = s.submitted_by
         LEFT JOIN employees ob ON ob.id = s.override_by
         ${where}
        ORDER BY s.period_year DESC, s.period_value DESC NULLS LAST, s.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/sales/forecasting/submissions — save or submit MY forecast.
 *
 * Idempotent on (company, owner, scope, period) via uq_sales_forecast_submission,
 * so a double-click updates the one row instead of raising a duplicate-key 500.
 * Amounts default to the engine's computed roll-up, so "submit what the system
 * says" needs no numbers in the body at all — but any figure the rep types wins,
 * because a forecast the rep cannot adjust is not a forecast.
 */
router.post('/submissions', canEdit, async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required to file a forecast' });

    const owner = await employeeOf(req, pool);
    if (owner == null) {
      return res.status(400).json({
        error: 'Your login is not linked to an employee record, so a forecast cannot be filed in your name.',
      });
    }

    const { periodType, periodYear, periodValue } = readPeriod(req.body || {});
    const status = ['draft', 'submitted'].includes(req.body?.status) ? req.body.status : 'draft';

    const computed = await computeForecast(pool, {
      companyId: cid, periodType, periodYear, periodValue, ownerEmployeeId: owner,
    });
    const num = (v, fallback) => {
      if (v == null || v === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw Object.assign(new Error('forecast amounts must be non-negative numbers'), { status: 400 });
      }
      return n;
    };

    const commit    = num(req.body?.commit_amount,    computed.totals.commit);
    const bestCase  = num(req.body?.best_case_amount, computed.totals.best_case);
    const pipeline  = num(req.body?.pipeline_amount,  computed.totals.pipeline);
    const closed    = num(req.body?.closed_amount,    computed.totals.closed);

    const { rows: [quotaRow] } = await pool.query(
      `SELECT COALESCE(SUM(target_amount), 0) AS quota
         FROM sales_targets
        WHERE company_id = $1 AND owner_id = $2
          AND period_type = $3 AND period_year = $4
          AND ($3 = 'annual' OR period_value = $5)`,
      [cid, owner, periodType, periodYear, periodValue]
    );
    const quota = num(req.body?.quota_amount, parseFloat(quotaRow?.quota) || 0);

    const { rows: [row] } = await pool.query(
      `INSERT INTO sales_forecast_submissions
         (company_id, owner_employee_id, scope, period_type, period_year, period_value,
          commit_amount, best_case_amount, pipeline_amount, closed_amount, quota_amount,
          status, notes, submitted_by, submitted_at)
       -- $11 is read twice (once as the stored status, once in the CASE), so it
       -- needs an explicit cast; without it Postgres deduces two different types
       -- for the same parameter and rejects the statement outright.
       VALUES ($1,$2,'rep',$3,$4,$5,$6,$7,$8,$9,$10,$11::varchar,$12,$2,
               CASE WHEN $11::varchar = 'submitted' THEN NOW()::timestamptz ELSE NULL END)
       ON CONFLICT (company_id, COALESCE(owner_employee_id, -1), scope,
                    period_type, period_year, COALESCE(period_value, -1))
       DO UPDATE SET
         commit_amount    = EXCLUDED.commit_amount,
         best_case_amount = EXCLUDED.best_case_amount,
         pipeline_amount  = EXCLUDED.pipeline_amount,
         closed_amount    = EXCLUDED.closed_amount,
         quota_amount     = EXCLUDED.quota_amount,
         status           = EXCLUDED.status,
         notes            = EXCLUDED.notes,
         submitted_by     = EXCLUDED.submitted_by,
         submitted_at     = CASE WHEN EXCLUDED.status = 'submitted' THEN NOW()
                                 ELSE sales_forecast_submissions.submitted_at END,
         updated_at       = NOW()
       RETURNING *`,
      [cid, owner, periodType, periodYear, periodValue,
       commit, bestCase, pipeline, closed, quota, status, req.body?.notes ?? null]
    );

    logAudit({
      userId: req.user?.userId, module: 'sales', recordId: row.id,
      recordType: 'forecast_submission', action: status === 'submitted' ? 'submit' : 'save',
      newData: row, req, company_id: cid,
    });
    res.status(201).json({ ...row, computed: computed.totals });
  } catch (err) { fail(res, err); }
});

/**
 * POST /api/sales/forecasting/submissions/:id/override — manager judgement.
 *
 * Stored ALONGSIDE the rep's number, never over it: the rep's commit_amount is
 * left untouched so "what did the rep say" and "what did the manager report"
 * both remain answerable. A reason is mandatory — an override with no rationale
 * is exactly the kind of unexplained adjustment a forecast review exists to
 * surface.
 */
router.post('/submissions/:id/override', canApprove, async (req, res) => {
  try {
    const cid = companyOf(req);
    const amount = Number(req.body?.override_commit_amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'override_commit_amount must be a non-negative number' });
    }
    const reason = String(req.body?.override_reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'override_reason is required' });

    const actor = await employeeOf(req, pool);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM sales_forecast_submissions
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!before) return res.status(404).json({ error: 'Forecast submission not found' });

    const { rows: [row] } = await pool.query(
      `UPDATE sales_forecast_submissions
          SET override_commit_amount = $1, override_reason = $2,
              override_by = $3, override_at = NOW(),
              status = 'approved', updated_at = NOW()
        WHERE id = $4 AND ($5::int IS NULL OR company_id = $5)
        RETURNING *`,
      [amount, reason, actor, req.params.id, cid]
    );

    logAudit({
      userId: req.user?.userId, module: 'sales', recordId: row.id,
      recordType: 'forecast_submission', action: 'override',
      oldData: { commit_amount: before.commit_amount, override_commit_amount: before.override_commit_amount },
      newData: { override_commit_amount: amount, override_reason: reason }, req, company_id: cid,
    });
    res.json(row);
  } catch (err) { fail(res, err); }
});

/* ── Snapshots and accuracy ──────────────────────────────────────────────── */

/**
 * POST /api/sales/forecasting/snapshots — freeze the current roll-up.
 *
 * Append-only. Accuracy is meaningless without a record of what was believed
 * DURING the period, and recomputing a finished period always agrees with
 * itself, so this is the only thing that makes /accuracy a real measurement.
 */
router.post('/snapshots', canApprove, async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required to capture a snapshot' });

    const { periodType, periodYear, periodValue } = readPeriod(req.body || {});
    const owner = req.body?.owner_employee_id ? parseInt(req.body.owner_employee_id, 10) : null;
    const actor = await employeeOf(req, pool);

    const f = await computeForecast(pool, {
      companyId: cid, periodType, periodYear, periodValue, ownerEmployeeId: owner,
    });

    const values = [];
    const params = [];
    for (const c of f.categories) {
      const i = params.length;
      values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10})`);
      params.push(cid, owner, periodType, periodYear, periodValue,
                  c.category, c.amount, c.opportunity_count, actor,
                  req.body?.source === 'scheduled' ? 'scheduled' : 'manual');
    }
    const { rows } = await pool.query(
      `INSERT INTO sales_forecast_snapshots
         (company_id, owner_employee_id, period_type, period_year, period_value,
          forecast_category, amount, opportunity_count, captured_by, source)
       VALUES ${values.join(',')} RETURNING *`,
      params
    );

    logAudit({
      userId: req.user?.userId, module: 'sales', recordId: rows[0]?.id ?? null,
      recordType: 'forecast_snapshot', action: 'create',
      newData: { period: f.period, totals: f.totals }, req, company_id: cid,
    });
    res.status(201).json({ captured: rows.length, period: f.period, totals: f.totals, rows });
  } catch (err) { fail(res, err); }
});

// GET /api/sales/forecasting/snapshots
router.get('/snapshots', canView, async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = [cid];
    let where = `WHERE ($1::int IS NULL OR s.company_id = $1)`;
    for (const [col, val] of [
      ['period_type', req.query.period_type], ['period_year', req.query.period_year],
      ['period_value', req.query.period_value], ['owner_employee_id', req.query.owner_employee_id],
    ]) {
      if (val != null && val !== '') { params.push(val); where += ` AND s.${col} = $${params.length}`; }
    }
    const { rows } = await pool.query(
      `SELECT s.*, e.name AS captured_by_name
         FROM sales_forecast_snapshots s
         LEFT JOIN employees e ON e.id = s.captured_by
         ${where}
        ORDER BY s.captured_at DESC, s.id DESC
        LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

// GET /api/sales/forecasting/accuracy?period_type=&period_year=
router.get('/accuracy', canView, async (req, res) => {
  try {
    const periodType = String(req.query.period_type || 'monthly');
    if (!PERIOD_TYPES.includes(periodType)) {
      return res.status(400).json({ error: `period_type must be one of ${PERIOD_TYPES.join(', ')}` });
    }
    const periodYear = parseInt(req.query.period_year, 10) || new Date().getFullYear();
    const owner = req.query.owner_employee_id ? parseInt(req.query.owner_employee_id, 10) : null;
    const data = await forecastAccuracy(pool, {
      companyId: companyOf(req), periodType, periodYear, ownerEmployeeId: owner,
    });
    const measured = data.filter((d) => d.accuracy_pct != null);
    res.json({
      period_type: periodType,
      period_year: periodYear,
      // Null, not 0, when nothing is measurable — see forecastAccuracy().
      overall_accuracy_pct: measured.length
        ? Math.round(measured.reduce((t, d) => t + d.accuracy_pct, 0) / measured.length * 10) / 10
        : null,
      measured_periods: measured.length,
      data,
    });
  } catch (err) { fail(res, err); }
});

export default router;
