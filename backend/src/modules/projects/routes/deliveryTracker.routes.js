/**
 * deliveryTracker.routes.js — read-only production/fulfilment tracker.
 *
 * Bridges CRM opportunities (IPM) -> projects/production (IPP) via the
 * projects.opportunity_id link added in 20260714000002. Purely a reporting
 * grid: filter + sort + paginate, no writes. Production stage and target/
 * forecast dates are maintained in the Projects module, not here.
 *
 * Mounted at /api/delivery-tracker (see server.js).
 */
import express from 'express';
import pool from '../../shared/db.js';
import { PROJECT_TYPES } from '../../../shared/projectTypes.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = (req) => req.scope?.company_id ?? companyOf(req);

// Canonical Manifest SST/HVDC production pipeline, in full lifecycle order.
// Shared shape with the frontend PRODUCTION_STAGES constant — keep the two in
// sync. Legacy values (design/fabrication/testing/pre_commission/commission/
// dispatch) were remapped onto this set in migration 20260715000003.
export const PRODUCTION_STAGES = ['created', 'handover', 'dr_approval', 'procurement', 'production', 'clearing', 'dispatched'];

// Manifest project-type categories — full reference set (mirrors GET /projects/master).
// Canonical definition now lives in shared/projectTypes.js so the servicedesk
// module can use the same list for IPS service_type. Imported (not bare
// re-exported) because this module uses it locally too; re-exported so its
// existing import surface is unchanged.
export { PROJECT_TYPES };

// Product line resolved at read time (20260716000003). product_line_id is
// authoritative where set — "ASTRA - 415V"; legacy rows fall back to the bare
// LV/MV/HV class still in p.product_type. This codebase has no triggers and a
// generated column cannot read another table, so the rollup is never synced.
// Declared above SORTABLE because SORTABLE reads it at module-eval time.
const PRODUCT_TYPE_SQL = `COALESCE(pl.display_name, p.product_type)`;

// Whitelist of sortable columns. The client sends a key; it can never reach the
// query as free text.
const SORTABLE = {
  ipm:                 'o.opportunity_number',
  ipp:                 'p.project_number',
  description:         'p.description',
  customer_name:       'customer_name',
  project_type:        'p.project_type',
  product_type:        PRODUCT_TYPE_SQL,
  zone:                'p.zone',
  production_stage:    'p.production_stage',
  target_date:         'p.target_date',
  forecast_date:       'p.forecast_date',
  actual_delivery_date:'p.actual_delivery_date',
  warranty_start_date: 'warranty_start_date',
  order_won_date:      'o.order_won_date',
  status:              'p.status',
  recent_update:       'p.updated_at',
};

// Shared WHERE builder for both the grid (/) and the kanban board (/board).
// Returns the parameterised WHERE clause, its bind params, and the next free
// placeholder index so callers can append LIMIT/OFFSET.
function buildWhere(req) {
  const { status, project_type } = req.query;
  const params = [cid(req)];
  let idx = 2;
  let where = `WHERE p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)`;

  // Multi-select status arrives as CSV ("procurement,clearing") or a repeated param.
  const stages = (Array.isArray(status) ? status.join(',') : (status || ''))
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(s => PRODUCTION_STAGES.includes(s));
  if (stages.length) {
    where += ` AND p.production_stage = ANY($${idx++}::text[])`;
    params.push(stages);
  }
  // Single project_type filter (EPC/Installation/Commissioning/HVDC/STATCOM/SST/O&M).
  if (project_type && project_type !== 'all') {
    where += ` AND p.project_type = $${idx++}`;
    params.push(project_type);
  }
  return { where, params, idx };
}

// customer_name: project's own value first, else the pursuit's account
// (opportunities carry the account name on the joined lead).
// warranty_start_date: earliest warranty across the project's serial/product
// warranties (a project can have many; the master row shows the first).
const baseFromSql = (where) => `
  FROM projects p
  LEFT JOIN opportunities o ON o.id = p.opportunity_id AND o.deleted_at IS NULL
  LEFT JOIN leads l ON l.id = o.lead_id
  LEFT JOIN product_lines pl ON pl.id = p.product_line_id
  LEFT JOIN (
    SELECT project_id, MIN(warranty_start_date) AS warranty_start_date
    FROM project_warranties
    GROUP BY project_id
  ) w ON w.project_id = p.id
  ${where}
`;

// Shared projected columns. `dispatched` (or a completed status) is the terminal
// "Delivered" state in the reference pipeline; legacy `handover` no longer maps here.
const SELECT_COLS = `
  p.id                                   AS project_id,
  p.project_number                       AS ipp,
  p.project_code,
  p.description,
  o.id                                   AS opportunity_id,
  o.opportunity_number                   AS ipm,
  COALESCE(NULLIF(p.customer_name, ''), l.company_name) AS customer_name,
  p.project_type,
  ${PRODUCT_TYPE_SQL}                      AS product_type,
  p.product_line_id,
  pl.voltage_class,
  p.zone,
  p.production_stage,
  p.target_date,
  p.forecast_date,
  p.actual_delivery_date,
  w.warranty_start_date,
  o.order_won_date,
  p.updated_at,
  CASE
    WHEN p.production_stage = 'dispatched' OR p.status = 'completed' THEN 'Delivered'
    WHEN o.order_won_date IS NOT NULL AND p.production_stage IS NULL THEN 'Won'
    ELSE 'In Progress'
  END                                    AS status
`;

router.get('/', async (req, res) => {
  try {
    const { sort, dir, page, page_size } = req.query;
    const { where, params, idx: idx0 } = buildWhere(req);
    let idx = idx0;

    const orderCol = SORTABLE[sort] || 'p.created_at';
    const orderDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), 200);
    const pg   = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pg - 1) * size;

    const baseFrom = baseFromSql(where);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total ${baseFrom}`, params);
    const total = countRows[0]?.total ?? 0;

    const dataParams = [...params, size, offset];
    const { rows } = await pool.query(`
      SELECT ${SELECT_COLS}
      ${baseFrom}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST, p.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, dataParams);

    res.json({ data: rows, total, page: pg, page_size: size, stages: PRODUCTION_STAGES, project_types: PROJECT_TYPES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /board — the whole filtered set (not paginated) for the Project Pipeline
// kanban, so per-stage column counts reflect every matching project. Capped to
// keep the payload bounded; the grid view (/) remains the paginated surface.
router.get('/board', async (req, res) => {
  try {
    const { where, params } = buildWhere(req);
    const baseFrom = baseFromSql(where);
    const dataParams = [...params, 1000];
    const { rows } = await pool.query(`
      SELECT ${SELECT_COLS}
      ${baseFrom}
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT $${params.length + 1}
    `, dataParams);

    // Pre-bucket by stage so the client renders columns directly; a NULL stage
    // (project created but not yet staged) falls into the first column, 'created'.
    const columns = {};
    for (const s of PRODUCTION_STAGES) columns[s] = [];
    for (const r of rows) {
      const key = PRODUCTION_STAGES.includes(r.production_stage) ? r.production_stage : 'created';
      columns[key].push(r);
    }
    const counts = Object.fromEntries(PRODUCTION_STAGES.map(s => [s, columns[s].length]));

    res.json({ columns, counts, total: rows.length, stages: PRODUCTION_STAGES, project_types: PROJECT_TYPES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
