/**
 * dashboardBuilder.service.js — executing a saved widget, safely.
 *
 * WHY THIS EXISTS
 * ---------------
 * The DASHBOARD BUILDER section of intelligence.routes.js stored a
 * `query_config` payload that nothing ever executed, over a table that never
 * existed, behind a 501 short-circuit. This is the half that was missing: the
 * thing that turns a stored config into a number.
 *
 * THE TWO RULES
 * -------------
 * 1. A config NAMES a metric; it never describes one. Nothing from the request
 *    or from the stored row is interpolated into SQL. `validateQueryConfig`
 *    rejects an unknown metric, an unsupported dimension, a malformed date and
 *    an unknown chart type, and the SQL itself is assembled inside
 *    `metricRegistry.js` from fragments that file owns.
 *
 * 2. A widget is readable exactly when the module it draws from is. Every
 *    metric declares the `[module, action]` its owning module would require, and
 *    that permission is checked PER VIEWER at execution time — not at save time,
 *    and not once for the board.
 *
 * Rule 2 is the one that is easy to get wrong. A shared dashboard is otherwise a
 * permission-laundering device: a finance manager builds a board with a payroll
 * tile, shares it company-wide, and every employee reads salary aggregates the
 * Payroll module would have refused them. So a viewer who lacks a tile's
 * permission gets that tile back marked `permitted: false` with no data, while
 * the rest of the board renders. The board is shared; the authority is not.
 *
 * WHY VALIDATION RUNS AGAIN ON READ
 * ---------------------------------
 * A metric can be retired after a widget was saved. Re-validating on read means
 * such a widget reports `error: "Unknown metric 'x'"` instead of rendering an
 * empty chart — the failure is visible rather than looking like "no data for
 * this period", which is exactly how the Procurement Reports page stayed dead
 * for weeks.
 */
import pool from '../../../config/db.js';
import { permissionFor, permissionColumn } from '../../../middlewares/auth.middleware.js';
import {
  validateQueryConfig, buildMetricQuery, getMetric, listMetrics,
} from '../../../shared/metricRegistry.js';

/** pg returns NUMERIC as a string; a KPI tile must not render "1919000.0000". */
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Does this caller hold the permission a metric declares?
 *
 * Mirrors `requirePermission`'s precedence exactly by reusing `permissionFor`,
 * rather than re-implementing user-override-over-role-union — a second copy of
 * that logic would drift and drift silently.
 *
 * A null permission row FAILS CLOSED, as the middleware does. An absent matrix
 * row is not an all-false row, but treating it as permission would reopen the
 * hole that let an `employee` account edit maintenance assets.
 */
async function canRead(req, metric) {
  const [module, action] = metric.permission;
  const col = permissionColumn(action);
  if (!col) return false;
  const perm = await permissionFor(req, module);
  if (perm === null) return false;
  return perm[col] === true;
}

/**
 * The metric picker, filtered to what this caller could actually chart.
 *
 * Offering a metric the viewer cannot read produces a widget that always says
 * "not permitted" — so the picker is filtered rather than the save being
 * refused later.
 */
export async function catalogFor(req) {
  const all = listMetrics();
  const out = [];
  for (const m of all) {
    const metric = getMetric(m.id);
    if (await canRead(req, metric)) out.push(m);
  }
  return out;
}

/**
 * Run one widget's config and return `{ rows, meta }`, or a reason it did not.
 *
 * Never throws for an expected condition — a bad config, a retired metric and a
 * permission failure are all DATA about the widget, returned alongside the
 * others so one broken tile cannot blank a whole board.
 */
export async function executeConfig(req, rawConfig, { companyId }) {
  const v = validateQueryConfig(rawConfig);
  if (!v.ok) return { ok: false, error: v.error, rows: [] };

  const metric = getMetric(v.config.metric);
  if (!(await canRead(req, metric))) {
    return {
      ok: false,
      permitted: false,
      error: `This metric requires ${metric.permission[0]}:${metric.permission[1]}.`,
      rows: [],
    };
  }

  try {
    const { sql, params } = buildMetricQuery(v.config, { companyId });
    const { rows } = await pool.query(sql, params);
    return {
      ok: true,
      permitted: true,
      config: v.config,
      meta: {
        metric: metric.id,
        label: metric.label,
        unit: metric.unit,
        dimension: v.config.dimension,
        chart_type: v.config.chart_type,
        row_count: rows.length,
        // A metric truncated at the limit is a partial answer, and a chart that
        // does not say so invites a share-of-total read off a top-N list — the
        // exact defect the spend cube shipped with.
        truncated: rows.length >= v.config.limit,
      },
      rows: rows.map((r) => ({ label: r.label, value: num(r.value) })),
    };
  } catch (err) {
    // A genuine SQL failure is a bug in the registry, not a user error. Surface
    // it rather than swallowing it into an empty array — `.catch(() => [])` is
    // how nineteen always-failing statements survived into a release here.
    return { ok: false, error: err.message, rows: [] };
  }
}

/** Boards this caller may see: their own, plus company-visible ones. */
export async function listDashboards(req, { companyId, userId }) {
  const { rows } = await pool.query(
    `SELECT d.*,
            (SELECT COUNT(*)::INT FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count
       FROM dashboards d
      WHERE d.deleted_at IS NULL
        AND ($1::INTEGER IS NULL OR d.company_id = $1::INTEGER)
        AND (d.visibility = 'company' OR d.owner_user_id = $2)
      ORDER BY d.is_default DESC, d.name ASC`,
    [companyId ?? null, userId ?? null]
  );
  return rows;
}

/** One board with every widget executed for THIS viewer. */
export async function loadDashboard(req, id, { companyId, userId }) {
  const { rows: boards } = await pool.query(
    `SELECT * FROM dashboards
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::INTEGER IS NULL OR company_id = $2::INTEGER)
        AND (visibility = 'company' OR owner_user_id = $3)`,
    [id, companyId ?? null, userId ?? null]
  );
  const board = boards[0];
  if (!board) return null;

  const { rows: widgets } = await pool.query(
    `SELECT * FROM dashboard_widgets
      WHERE dashboard_id = $1 AND is_visible = TRUE
      ORDER BY position_y, position_x, id`,
    [id]
  );

  const executed = [];
  for (const w of widgets) {
    const result = await executeConfig(req, w.query_config, { companyId });
    executed.push({
      id: w.id,
      title: w.title,
      chart_type: w.chart_type,
      layout: { x: w.position_x, y: w.position_y, w: w.width, h: w.height },
      query_config: w.query_config,
      ...result,
    });
  }

  return { ...board, widgets: executed };
}

export default {
  catalogFor, executeConfig, listDashboards, loadDashboard,
};
