/**
 * pursuits.routes.js — analytics, forecast and Excel export for the unified
 * CRM Pursuits page. Sourced from the opportunities table (the real pipeline),
 * joined to leads for the zone split. Everything is company-scoped via
 * req.scope.company_id and FY-scoped to a single financial year.
 *
 * Mounted under /crm by modules/crm/routes/index.js.
 */

import express from 'express';
import XLSX from 'xlsx';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';

const router = express.Router();

const OPEN_STAGES = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation'];

/** Resolve the FY start month + selected FY + FY options for a company. */
async function resolveFy(cid, fyQuery) {
  let fyStartMonth = 4;
  if (cid != null) {
    const { rows } = await pool
      .query('SELECT fiscal_year_start_month FROM crm_settings WHERE company_id = $1', [cid])
      .catch(() => ({ rows: [] }));
    const m = parseInt(rows[0]?.fiscal_year_start_month, 10);
    if (m >= 1 && m <= 12) fyStartMonth = m;
  }

  const now = new Date();
  const currentFy = (now.getMonth() + 1) >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;

  const { rows: fyRows } = await pool.query(
    `SELECT DISTINCT
            EXTRACT(YEAR FROM (created_at::date - make_interval(months => $2::int - 1)))::int AS fy
       FROM opportunities
      WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
      ORDER BY 1 DESC`,
    [cid, fyStartMonth]
  ).catch(() => ({ rows: [] }));

  const fyOptions = fyRows.map(r => r.fy);
  const fyRaw = parseInt(fyQuery, 10);
  const fy = fyRaw >= 1990 && fyRaw <= 2999
    ? fyRaw
    : (fyOptions.includes(currentFy) ? currentFy : (fyOptions[0] ?? currentFy));

  return { fyStartMonth, fy, currentFy, fyOptions };
}

/** Parse ?assigned_to / ?value_min / ?value_max into safe numbers (or null). */
function parseFilters(q) {
  let assignedTo = null;
  if (q.assigned_to) {
    if (!/^\d+$/.test(String(q.assigned_to))) return { error: 'assigned_to must be an employee id' };
    assignedTo = parseInt(q.assigned_to, 10);
  }
  const num = v => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null);
  return { assignedTo, valueMin: num(q.value_min), valueMax: num(q.value_max) };
}

// ── GET /pursuits/analytics ───────────────────────────────────────────────────
// Monthwise, by-zone, by-status, and the Value/Estimate summary table — one trip.
router.get('/pursuits/analytics', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { fyStartMonth, fy, currentFy, fyOptions } = await resolveFy(cid, req.query.fy);

    const f = parseFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });

    const params = [cid, fy, fyStartMonth, f.assignedTo, f.valueMin, f.valueMax];

    const { rows } = await pool.query(
      `
      WITH b AS (
        SELECT make_date($2::int, $3::int, 1)                             AS fy_start,
               (make_date($2::int, $3::int, 1) + INTERVAL '1 year')::date AS fy_end
      ),
      months AS (
        SELECT generate_series(
                 (SELECT fy_start FROM b)::timestamp,
                 (SELECT fy_end   FROM b)::timestamp - INTERVAL '1 day',
                 INTERVAL '1 month'
               )::date AS m
      ),
      op AS (
        SELECT o.id,
               o.stage,
               o.created_at,
               COALESCE(NULLIF(TRIM(l.zone), ''), 'Unassigned')  AS zone,
               COALESCE(o.expected_value, 0)::numeric            AS val,
               COALESCE(o.estimate_value, 0)::numeric            AS est
          FROM opportunities o
          LEFT JOIN leads l ON l.id = o.lead_id
         WHERE o.deleted_at IS NULL
           AND ($1::int IS NULL OR o.company_id = $1)
           AND o.created_at >= (SELECT fy_start FROM b)
           AND o.created_at <  (SELECT fy_end   FROM b)
           AND ($4::int IS NULL OR o.assigned_to = $4::int)
           AND ($5::numeric IS NULL OR COALESCE(o.expected_value,0) >= $5::numeric)
           AND ($6::numeric IS NULL OR COALESCE(o.expected_value,0) <  $6::numeric)
      )
      SELECT
        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT to_char(m.m, 'Mon YY')                    AS month,
                  COUNT(op.id)::int                         AS count,
                  COALESCE(SUM(op.val), 0)::float8          AS value
             FROM months m
             LEFT JOIN op ON date_trunc('month', op.created_at)::date = m.m
            GROUP BY m.m
            ORDER BY m.m
        ) t) AS monthly,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT op.zone                                   AS zone,
                  COUNT(op.id)::int                         AS count,
                  COALESCE(SUM(op.val), 0)::float8          AS value
             FROM op
            GROUP BY op.zone
            ORDER BY 2 DESC
        ) t) AS by_zone,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT s.stage                                   AS stage,
                  COUNT(op.id)::int                         AS count,
                  COALESCE(SUM(op.val), 0)::float8          AS value
             FROM (VALUES ('Prospecting',1),('Qualification',2),('Proposal',3),
                          ('Negotiation',4),('Won',5),('Lost',6),('Shelved',7)) AS s(stage, ord)
             LEFT JOIN op ON LOWER(op.stage) = LOWER(s.stage)
            GROUP BY s.stage, s.ord
            ORDER BY s.ord
        ) t) AS by_status,

        (SELECT row_to_json(x) FROM (
           SELECT
             json_build_object(
               'count', COUNT(*)::int,
               'value', COALESCE(SUM(val), 0)::float8,
               'estimate', COALESCE(SUM(est), 0)::float8) AS total,
             json_build_object(
               'count', COUNT(*) FILTER (WHERE LOWER(stage) = 'won')::int,
               'value', COALESCE(SUM(val) FILTER (WHERE LOWER(stage) = 'won'), 0)::float8,
               'estimate', COALESCE(SUM(est) FILTER (WHERE LOWER(stage) = 'won'), 0)::float8) AS won,
             json_build_object(
               'count', COUNT(*) FILTER (WHERE LOWER(stage) = 'lost')::int,
               'value', COALESCE(SUM(val) FILTER (WHERE LOWER(stage) = 'lost'), 0)::float8,
               'estimate', COALESCE(SUM(est) FILTER (WHERE LOWER(stage) = 'lost'), 0)::float8) AS lost,
             json_build_object(
               'count', COUNT(*) FILTER (WHERE LOWER(stage) = 'shelved')::int,
               'value', COALESCE(SUM(val) FILTER (WHERE LOWER(stage) = 'shelved'), 0)::float8,
               'estimate', COALESCE(SUM(est) FILTER (WHERE LOWER(stage) = 'shelved'), 0)::float8) AS shelved,
             ROUND(
               COUNT(*) FILTER (WHERE LOWER(stage) = 'won')::numeric
               / NULLIF(COUNT(*), 0) * 100, 1)::float8 AS conversion_rate
           FROM op
        ) x) AS summary
      `,
      params
    );

    const { rows: owners } = await pool.query(
      `SELECT DISTINCT e.id, e.name
         FROM employees e
        WHERE ($1::int IS NULL OR e.company_id = $1)
          AND LOWER(COALESCE(e.status, 'active')) IN ('active','probation')
          AND EXISTS (
            SELECT 1 FROM opportunities o
             WHERE (o.assigned_to = e.id OR o.held_by = e.id)
               AND o.deleted_at IS NULL
               AND ($1::int IS NULL OR o.company_id = $1))
        ORDER BY e.name`,
      [cid]
    ).catch(() => ({ rows: [] }));

    const r = rows[0] || {};
    res.json({
      fy,
      current_fy: currentFy,
      fy_options: fyOptions,
      fiscal_year_start_month: fyStartMonth,
      owners,
      monthly:   r.monthly   || [],
      by_zone:   r.by_zone   || [],
      by_status: r.by_status || [],
      summary:   r.summary   || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /pursuits/forecast ────────────────────────────────────────────────────
// Probability-weighted pipeline by expected-close month for the selected FY,
// plus committed (Won) / best-case (open) / weighted headline totals.
router.get('/pursuits/forecast', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { fyStartMonth, fy, currentFy, fyOptions } = await resolveFy(cid, req.query.fy);
    const f = parseFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });

    const openList = OPEN_STAGES.map(s => `'${s.toLowerCase()}'`).join(',');
    const params = [cid, fy, fyStartMonth, f.assignedTo];

    const { rows } = await pool.query(
      `
      WITH b AS (
        SELECT make_date($2::int, $3::int, 1)                             AS fy_start,
               (make_date($2::int, $3::int, 1) + INTERVAL '1 year')::date AS fy_end
      ),
      months AS (
        SELECT generate_series(
                 (SELECT fy_start FROM b)::timestamp,
                 (SELECT fy_end   FROM b)::timestamp - INTERVAL '1 day',
                 INTERVAL '1 month'
               )::date AS m
      ),
      op AS (
        SELECT o.stage,
               COALESCE(o.expected_value, 0)::numeric                     AS val,
               COALESCE(o.probability_percentage, 0)::numeric / 100.0     AS p,
               COALESCE(o.expected_closing_date, o.created_at::date)      AS close_date
          FROM opportunities o
         WHERE o.deleted_at IS NULL
           AND ($1::int IS NULL OR o.company_id = $1)
           AND COALESCE(o.expected_closing_date, o.created_at::date) >= (SELECT fy_start FROM b)
           AND COALESCE(o.expected_closing_date, o.created_at::date) <  (SELECT fy_end   FROM b)
           AND ($4::int IS NULL OR o.assigned_to = $4::int)
      )
      SELECT
        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT to_char(m.m, 'Mon YY') AS month,
                  COALESCE(SUM(op.val) FILTER (WHERE LOWER(op.stage) IN (${openList})), 0)::float8       AS best_case,
                  COALESCE(SUM(op.val * op.p) FILTER (WHERE LOWER(op.stage) IN (${openList})), 0)::float8 AS weighted,
                  COALESCE(SUM(op.val) FILTER (WHERE LOWER(op.stage) = 'won'), 0)::float8                 AS committed
             FROM months m
             LEFT JOIN op ON date_trunc('month', op.close_date)::date = m.m
            GROUP BY m.m
            ORDER BY m.m
        ) t) AS monthly,
        COALESCE(SUM(val) FILTER (WHERE LOWER(stage) IN (${openList})), 0)::float8        AS best_case_total,
        COALESCE(SUM(val * p) FILTER (WHERE LOWER(stage) IN (${openList})), 0)::float8    AS weighted_total,
        COALESCE(SUM(val) FILTER (WHERE LOWER(stage) = 'won'), 0)::float8                 AS committed_total
      FROM op
      `,
      params
    );

    const r = rows[0] || {};
    res.json({
      fy,
      current_fy: currentFy,
      fy_options: fyOptions,
      monthly:         r.monthly || [],
      best_case_total: r.best_case_total || 0,
      weighted_total:  r.weighted_total  || 0,
      committed_total: r.committed_total || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /pursuits/export ──────────────────────────────────────────────────────
// Real .xlsx of the pursuit grid, respecting the same scope + filters.
router.get('/pursuits/export', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const f = parseFilters(req.query);
    if (f.error) return res.status(400).json({ error: f.error });

    const { rows } = await pool.query(
      `SELECT o.opportunity_number, o.opportunity_name, l.company_name, o.stage,
              o.expected_value, o.probability_percentage, o.estimate_value,
              o.expected_closing_date, o.follow_up_date,
              e.name AS owner_name, h.name AS held_by_name
         FROM opportunities o
         LEFT JOIN leads     l ON l.id = o.lead_id
         LEFT JOIN employees e ON e.id = o.assigned_to
         LEFT JOIN employees h ON h.id = o.held_by
        WHERE o.deleted_at IS NULL
          AND ($1::int IS NULL OR o.company_id = $1)
          AND ($2::int IS NULL OR o.assigned_to = $2::int)
          AND ($3::numeric IS NULL OR COALESCE(o.expected_value,0) >= $3::numeric)
          AND ($4::numeric IS NULL OR COALESCE(o.expected_value,0) <  $4::numeric)
        ORDER BY o.id DESC`,
      [cid, f.assignedTo, f.valueMin, f.valueMax]
    );

    const d = v => (v ? new Date(v).toLocaleDateString('en-GB') : '');
    const data = rows.map(r => ({
      ID:              r.opportunity_number,
      Pursuit:         r.opportunity_name,
      Customer:        r.company_name || '',
      Owner:           r.owner_name || '',
      'Held By':       r.held_by_name || '',
      Status:          r.stage,
      'Value':         Number(r.expected_value || 0),
      'Probability %': Number(r.probability_percentage || 0),
      'Estimate':      Number(r.estimate_value || 0),
      'Follow-up':     d(r.follow_up_date),
      'Close Date':    d(r.expected_closing_date),
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pursuits');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pursuits_${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
