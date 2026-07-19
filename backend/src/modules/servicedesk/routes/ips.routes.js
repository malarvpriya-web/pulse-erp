/**
 * ips.routes.js — read layer for the Service Master (IPS) grid.
 *
 * Phase 3 of the build in SERVICE_MASTER_IPS_AUDIT.md. Mounted at
 * /api/servicedesk/ips (server.js), ahead of the general servicedesk router.
 *
 * Serves field-service tickets only — `support_tickets` holds both kinds and
 * every query here is pinned to ticket_kind='service'. The internal IT/HR
 * helpdesk keeps its own grid (AllTickets.jsx) over the same table.
 *
 * Inherited columns, per the Phase 0 decisions:
 *   IPP / Sitename / Product Type  <- the linked project (support_tickets.project_id)
 *   Product Type specifically      <- projects.product_line_id -> product_lines.display_name
 *                                     ("ASTRA - 415V"), falling back to the legacy
 *                                     LV/MV/HV class in projects.product_type.
 *   Type (service_type) and Region (zone) are PER TICKET, not inherited: an EPC
 *   project can legitimately raise a Commissioning ticket.
 *
 * Days Open is computed in SQL, never stored — it stops counting at resolved_at
 * and sorts server-side. A stored column would need a cron to stay honest.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { PROJECT_TYPES } from '../../../shared/projectTypes.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = (req) => req.scope?.company_id ?? companyOf(req);
const svcAdmin = (action) => requirePermission('servicedesk', action);

const ZONES = ['North', 'South', 'East', 'West', 'Central'];
const TICKET_STATUSES = ['Open', 'Analysis', 'In Progress', 'Pending', 'Resolved', 'Closed'];

// `projects` has no site-name column; site_city is the closest thing to the
// reference's "Sitename", with the project name as a last resort.
const SITENAME_SQL     = `COALESCE(NULLIF(p.site_city, ''), p.project_name)`;
const PRODUCT_TYPE_SQL = `COALESCE(pl.display_name, p.product_type)`;
const CATEGORY_SQL     = `COALESCE(ic.name, t.category)`;
// Live per request, stops at resolution. EXTRACT(DAY FROM interval) is whole days.
const DAYS_OPEN_SQL    = `EXTRACT(DAY FROM COALESCE(t.resolved_at, NOW()) - t.created_at)::int`;

const BASE_FROM = `
  FROM support_tickets t
  LEFT JOIN projects p                  ON p.id  = t.project_id
  LEFT JOIN product_lines pl            ON pl.id = p.product_line_id
  LEFT JOIN service_issue_categories ic ON ic.id = t.issue_category_id
`;

// The client sends a key; free text can never reach the ORDER BY.
const SORTABLE = {
  ips_id:       't.ticket_number',
  sitename:     SITENAME_SQL,
  description:  't.description',
  status:       't.status',
  region:       't.zone',
  days_open:    DAYS_OPEN_SQL,
  ipp:          'p.project_number',
  type:         't.service_type',
  product_type: PRODUCT_TYPE_SQL,
  created_at:   't.created_at',
};

/**
 * Shared WHERE for the grid and the widgets, so a filtered grid and its charts
 * can never disagree about which tickets they describe.
 * Always pins ticket_kind='service' and excludes soft-deleted rows.
 */
function buildWhere(req) {
  const params = [cid(req)];
  const conds = [
    `t.ticket_kind = 'service'`,
    `t.deleted_at IS NULL`,
    `($1::int IS NULL OR t.company_id = $1)`,
  ];
  const { status, zone, service_type, category, project_id, search } = req.query;

  if (status)       { params.push(status);          conds.push(`t.status = $${params.length}`); }
  if (zone)         { params.push(zone);            conds.push(`t.zone = $${params.length}`); }
  if (service_type) { params.push(service_type);    conds.push(`t.service_type = $${params.length}`); }
  if (category)     { params.push(category);        conds.push(`${CATEGORY_SQL} = $${params.length}`); }
  if (project_id)   { params.push(project_id);      conds.push(`t.project_id = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    // serial_number is searchable because it is the one identifier the CUSTOMER
    // can read out — off the unit, over the phone. Without it a field engineer
    // could not find a ticket from the only reference the caller has.
    conds.push(`(t.ticket_number ILIKE $${i} OR t.title ILIKE $${i} OR t.description ILIKE $${i}
                 OR t.serial_number ILIKE $${i}
                 OR p.project_number ILIKE $${i} OR ${SITENAME_SQL} ILIKE $${i})`);
  }
  return { where: `WHERE ${conds.join(' AND ')}`, params };
}

// ── grid ──────────────────────────────────────────────────────────────────────
router.get('/', svcAdmin('view'), async (req, res) => {
  try {
    const { where, params } = buildWhere(req);
    const sortCol = SORTABLE[req.query.sort] ?? 't.created_at';
    const dir     = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const size    = Math.min(200, Math.max(1, parseInt(req.query.page_size) || 20));
    const page    = Math.max(1, parseInt(req.query.page) || 1);

    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n ${BASE_FROM} ${where}`, params);
    const total = countRows[0]?.n ?? 0;

    const { rows } = await pool.query(
      `SELECT t.id,
              t.ticket_number        AS ips_id,
              ${SITENAME_SQL}        AS sitename,
              t.title,
              t.description,
              t.status,
              t.zone                 AS region,
              ${DAYS_OPEN_SQL}       AS days_open,
              p.id                   AS project_id,
              p.project_number       AS ipp,
              t.service_type         AS type,
              ${PRODUCT_TYPE_SQL}    AS product_type,
              ${CATEGORY_SQL}        AS category,
              t.priority,
              t.resolved_at,
              t.created_at,
              t.updated_at,
              p.site_state, p.site_address, p.latitude, p.longitude
       ${BASE_FROM} ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, t.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (page - 1) * size]
    );

    res.json({ data: rows, total, page, page_size: size, total_pages: Math.ceil(total / size) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── filter options ────────────────────────────────────────────────────────────
// Static lists come from the shared constants (so a value with no ticket yet is
// still selectable); categories come from the master plus whatever free text is
// still on tickets, because the master is authored by the user and starts empty.
router.get('/filters', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [cats, projects] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ${CATEGORY_SQL} AS v
         ${BASE_FROM}
         WHERE t.ticket_kind = 'service' AND t.deleted_at IS NULL
           AND ($1::int IS NULL OR t.company_id = $1)
           AND ${CATEGORY_SQL} IS NOT NULL
         ORDER BY v`,
        [companyId]
      ),
      pool.query(
        `SELECT id, project_number, project_name
           FROM projects
          WHERE deleted_at IS NULL AND project_number IS NOT NULL
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY project_number`,
        [companyId]
      ),
    ]);
    res.json({
      statuses:      TICKET_STATUSES,
      zones:         ZONES,
      service_types: PROJECT_TYPES,
      categories:    cats.rows.map(r => r.v),
      projects:      projects.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── issue-category taxonomy ───────────────────────────────────────────────────
// Backs the grid's "Categories of Issues" button. The master ships EMPTY by
// design (20260716000002): this axis is the user's own taxonomy, so it is
// authored here rather than seeded with guesses. Tickets keep their legacy
// free-text `category` until rows are mapped across — reads COALESCE the two.
router.get('/categories', svcAdmin('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.category_code, c.name, c.description, c.is_active,
              COUNT(t.id)::int AS ticket_count
         FROM service_issue_categories c
         LEFT JOIN support_tickets t
                ON t.issue_category_id = c.id AND t.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
          AND ($1::int IS NULL OR c.company_id = $1)
        GROUP BY c.id
        ORDER BY c.name`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/categories', svcAdmin('add'), async (req, res) => {
  try {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO service_issue_categories (category_code, name, description, company_id)
       VALUES ($1,$2,$3,$4) RETURNING id, category_code, name, description, is_active`,
      [req.body.category_code || null, name, req.body.description || null, cid(req)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/categories/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `UPDATE service_issue_categories
          SET name=$1, category_code=$2, description=$3,
              is_active=COALESCE($4, is_active), updated_at=NOW()
        WHERE id=$5 AND deleted_at IS NULL
          AND ($6::int IS NULL OR company_id = $6)
        RETURNING id, category_code, name, description, is_active`,
      [name, req.body.category_code || null, req.body.description || null,
       req.body.is_active, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft delete. Tickets keep pointing at the row (issue_category_id is ON DELETE
// SET NULL, but we never hard-delete) so historical grouping stays intact.
router.delete('/categories/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE service_issue_categories SET deleted_at = NOW()
        WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json({ message: 'Category removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── widgets ───────────────────────────────────────────────────────────────────
// All four honour the grid's filters via the shared WHERE, so the charts always
// describe the same set the grid is showing.
router.get('/widgets', svcAdmin('view'), async (req, res) => {
  try {
    const { where, params } = buildWhere(req);

    // Issues progress — opened vs closed per month over the trailing 12 months.
    // generate_series supplies empty months so the trend line has no gaps; the
    // buckets are LEFT JOINed onto it rather than derived from ticket rows.
    const progress = pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - INTERVAL '11 months',
           date_trunc('month', NOW()),
           INTERVAL '1 month'
         ) AS m
       ),
       t AS (SELECT t.created_at, t.resolved_at ${BASE_FROM} ${where})
       SELECT to_char(months.m, 'YYYY-MM') AS month,
              COUNT(t.*) FILTER (WHERE date_trunc('month', t.created_at)  = months.m)::int AS opened,
              COUNT(t.*) FILTER (WHERE date_trunc('month', t.resolved_at) = months.m)::int AS closed
         FROM months
         LEFT JOIN t ON date_trunc('month', t.created_at)  = months.m
                     OR date_trunc('month', t.resolved_at) = months.m
        GROUP BY months.m
        ORDER BY months.m`,
      params
    );

    const byZone     = pool.query(
      `SELECT COALESCE(t.zone, 'Unassigned') AS name, COUNT(*)::int AS value
       ${BASE_FROM} ${where} GROUP BY 1 ORDER BY value DESC`, params);
    const byCategory = pool.query(
      `SELECT COALESCE(${CATEGORY_SQL}, 'Uncategorised') AS name, COUNT(*)::int AS value
       ${BASE_FROM} ${where} GROUP BY 1 ORDER BY value DESC`, params);
    const byStatus   = pool.query(
      `SELECT t.status AS name, COUNT(*)::int AS value
       ${BASE_FROM} ${where} GROUP BY 1`, params);

    const [pr, bz, bc, bs] = await Promise.all([progress, byZone, byCategory, byStatus]);

    // Status is ordered by the lifecycle, not by count — a segmented status bar
    // reads as a pipeline, so Open must sit left of Closed regardless of volume.
    const statusOrder = new Map(TICKET_STATUSES.map((s, i) => [s, i]));
    const by_status = bs.rows.sort(
      (a, b) => (statusOrder.get(a.name) ?? 99) - (statusOrder.get(b.name) ?? 99)
    );

    res.json({ progress: pr.rows, by_zone: bz.rows, by_category: bc.rows, by_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
