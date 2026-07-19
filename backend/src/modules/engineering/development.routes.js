/**
 * development.routes.js — the Engineering Development (IPD) master grid.
 *
 * Mounted at /api/engineering/development (server.js), AHEAD of the general
 * engineering router. Replaces the dead GET /development that used to live in
 * engineering.routes.js and read a `rd_projects` table that has never existed —
 * see migration 20260717000001 for the full account.
 *
 * Product Type is INHERITED from the linked product line (product_lines is the
 * catalogue master, owned by projects) — mirroring how ips.routes.js inherits it.
 * Category (LV/MV/HV) is stored per record rather than read through the product
 * line, because a development record is created before a product line is chosen
 * and must still classify.
 *
 * Every query is company-scoped. The route this replaces was the only one in the
 * engineering module WITHOUT a scope filter; that gap is closed here.
 */

import { Router } from 'express';
import pool from '../shared/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { VOLTAGE_CLASSES } from '../../shared/projectTypes.js';
import { companyOf } from '../../shared/scope.js';
import {
  DEV_STATUSES, DEV_TYPES, ASSEMBLY_TYPES, DEV_PRIORITIES, DEV_TERMINAL_STATUSES,
} from '../../shared/engineeringDevelopment.js';

const router = Router();

// Scoped reads. Falls back to the token's company when req.scope is absent.
const cid = (req) => req.scope?.company_id ?? companyOf(req);
const engPerm = (action) => requirePermission('engineering', action);

// Product Type follows the catalogue; a record with no product line yet shows —.
const PRODUCT_TYPE_SQL = `pl.display_name`;
// Closing Date is the actual close when the record is finished, else the target.
// The grid marks the difference with closing_is_actual rather than showing a
// forecast as though it were fact.
const CLOSING_SQL = `COALESCE(d.actual_close_date, d.target_close_date)`;

const BASE_FROM = `
  FROM eng_development d
  LEFT JOIN product_lines pl ON pl.id = d.product_line_id
  LEFT JOIN projects p       ON p.id  = d.project_id
`;

// The client sends a key; free text can never reach the ORDER BY.
const SORTABLE = {
  ipd_number:    'd.ipd_number',
  title:         'd.title',
  product_type:  PRODUCT_TYPE_SQL,
  dev_type:      'd.dev_type',
  assembly_type: 'd.assembly_type',
  category:      'd.category',
  status:        'd.status',
  started_date:  'd.started_date',
  closing_date:  CLOSING_SQL,
  ipp:           'p.project_number',
  created_at:    'd.created_at',
};

function buildWhere(req) {
  const params = [cid(req)];
  const conds = [
    `d.deleted_at IS NULL`,
    `($1::int IS NULL OR d.company_id = $1)`,
  ];
  const { status, dev_type, assembly_type, category, product_line_id, project_id, search } = req.query;

  if (status)          { params.push(status);          conds.push(`d.status = $${params.length}`); }
  if (dev_type)        { params.push(dev_type);        conds.push(`d.dev_type = $${params.length}`); }
  if (assembly_type)   { params.push(assembly_type);   conds.push(`d.assembly_type = $${params.length}`); }
  if (category)        { params.push(category);        conds.push(`d.category = $${params.length}`); }
  if (product_line_id) { params.push(product_line_id); conds.push(`d.product_line_id = $${params.length}`); }
  if (project_id)      { params.push(project_id);      conds.push(`d.project_id = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conds.push(`(d.ipd_number ILIKE $${i} OR d.title ILIKE $${i} OR d.description ILIKE $${i}
                 OR d.owner_name ILIKE $${i} OR p.project_number ILIKE $${i}
                 OR ${PRODUCT_TYPE_SQL} ILIKE $${i})`);
  }
  return { where: `WHERE ${conds.join(' AND ')}`, params };
}

/**
 * Validates the taxonomy fields against the shared lists. These are not DB CHECK
 * constraints by design (see migration header), so the route layer is the only
 * thing standing between a typo and a permanently unfilterable row.
 */
function validate(body, { partial = false } = {}) {
  const errs = [];
  const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== '';

  if (!partial && !String(body.title ?? '').trim()) errs.push('title is required');
  if (has('status')        && !DEV_STATUSES.includes(body.status))          errs.push(`status must be one of: ${DEV_STATUSES.join(', ')}`);
  if (has('dev_type')      && !DEV_TYPES.includes(body.dev_type))           errs.push(`dev_type must be one of: ${DEV_TYPES.join(', ')}`);
  if (has('assembly_type') && !ASSEMBLY_TYPES.includes(body.assembly_type)) errs.push(`assembly_type must be one of: ${ASSEMBLY_TYPES.join(', ')}`);
  if (has('category')      && !VOLTAGE_CLASSES.includes(body.category))     errs.push(`category must be one of: ${VOLTAGE_CLASSES.join(', ')}`);
  if (has('priority')      && !DEV_PRIORITIES.includes(body.priority))      errs.push(`priority must be one of: ${DEV_PRIORITIES.join(', ')}`);

  if (has('started_date') && has('target_close_date') && body.target_close_date < body.started_date)
    errs.push('target_close_date cannot be before started_date');
  if (has('started_date') && has('actual_close_date') && body.actual_close_date < body.started_date)
    errs.push('actual_close_date cannot be before started_date');

  return errs;
}

const nn = (v) => (v === '' || v === undefined ? null : v);

// ── grid ──────────────────────────────────────────────────────────────────────
router.get('/', engPerm('view'), async (req, res) => {
  try {
    const { where, params } = buildWhere(req);
    const sortCol = SORTABLE[req.query.sort] ?? 'd.created_at';
    const dir     = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const size    = Math.min(200, Math.max(1, parseInt(req.query.page_size) || 20));
    const page    = Math.max(1, parseInt(req.query.page) || 1);

    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n ${BASE_FROM} ${where}`, params);
    const total = countRows[0]?.n ?? 0;

    const { rows } = await pool.query(
      `SELECT d.id,
              d.ipd_number,
              d.title,
              d.description,
              ${PRODUCT_TYPE_SQL}  AS product_type,
              d.product_line_id,
              d.dev_type,
              d.assembly_type,
              d.category,
              d.status,
              d.priority,
              d.owner_name,
              d.started_date,
              d.target_close_date,
              d.actual_close_date,
              ${CLOSING_SQL}                          AS closing_date,
              (d.actual_close_date IS NOT NULL)       AS closing_is_actual,
              d.project_id,
              p.project_number     AS ipp,
              p.project_name       AS ipp_name,
              d.created_at,
              d.updated_at
       ${BASE_FROM} ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, d.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (page - 1) * size]
    );

    res.json({ data: rows, total, page, page_size: size, total_pages: Math.ceil(total / size) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── filter options ────────────────────────────────────────────────────────────
// Static lists come from the shared constants, so a value with no record yet is
// still selectable. Product lines and projects come from their masters.
router.get('/filters', engPerm('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [lines, projects] = await Promise.all([
      pool.query(
        `SELECT id, display_name, voltage_class
           FROM product_lines
          WHERE deleted_at IS NULL AND is_active = TRUE
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY display_name`,
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
      statuses:       DEV_STATUSES,
      dev_types:      DEV_TYPES,
      assembly_types: ASSEMBLY_TYPES,
      categories:     VOLTAGE_CLASSES,
      priorities:     DEV_PRIORITIES,
      product_lines:  lines.rows,
      projects:       projects.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── create ────────────────────────────────────────────────────────────────────
router.post('/', engPerm('add'), async (req, res) => {
  const errs = validate(req.body);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  try {
    const b = req.body;
    // IPD-00001, mirroring seq_ips/IPS-00001. Generated in SQL so concurrent
    // creates can never collide on the number.
    const { rows } = await pool.query(
      `INSERT INTO eng_development
         (ipd_number, title, description, product_line_id, dev_type, assembly_type,
          category, status, priority, owner_name, started_date, target_close_date,
          actual_close_date, project_id, company_id, created_by)
       VALUES ('IPD-' || LPAD(nextval('seq_ipd')::text, 5, '0'),
               $1,$2,$3,$4,$5,$6,COALESCE($7,'design'),COALESCE($8,'medium'),$9,$10,$11,$12,$13,
               COALESCE($14, 1), $15)
       RETURNING id, ipd_number`,
      [
        String(b.title).trim(), nn(b.description), nn(b.product_line_id), nn(b.dev_type),
        nn(b.assembly_type), nn(b.category), nn(b.status), nn(b.priority), nn(b.owner_name),
        nn(b.started_date), nn(b.target_close_date), nn(b.actual_close_date), nn(b.project_id),
        cid(req), req.user?.userId ?? req.user?.id ?? null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── update ────────────────────────────────────────────────────────────────────
router.put('/:id', engPerm('edit'), async (req, res) => {
  const errs = validate(req.body, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  try {
    const b = req.body;
    // Closing a record with no actual date stamps today, so "closed" and "has a
    // close date" can never disagree. An explicit actual_close_date still wins.
    const autoClose = DEV_TERMINAL_STATUSES.includes(b.status) && !nn(b.actual_close_date);

    const { rows } = await pool.query(
      `UPDATE eng_development SET
         title             = COALESCE($1, title),
         description       = $2,
         product_line_id   = $3,
         dev_type          = $4,
         assembly_type     = $5,
         category          = $6,
         status            = COALESCE($7, status),
         priority          = COALESCE($8, priority),
         owner_name        = $9,
         started_date      = $10,
         target_close_date = $11,
         actual_close_date = CASE WHEN $12::boolean THEN CURRENT_DATE ELSE $13::date END,
         project_id        = $14,
         updated_at        = NOW()
       WHERE id = $15 AND deleted_at IS NULL
         AND ($16::int IS NULL OR company_id = $16)
       RETURNING id, ipd_number`,
      [
        nn(b.title) && String(b.title).trim(), nn(b.description), nn(b.product_line_id),
        nn(b.dev_type), nn(b.assembly_type), nn(b.category), nn(b.status), nn(b.priority),
        nn(b.owner_name), nn(b.started_date), nn(b.target_close_date),
        autoClose, nn(b.actual_close_date), nn(b.project_id),
        req.params.id, cid(req),
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Development record not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── delete ────────────────────────────────────────────────────────────────────
// Soft delete — the module's convention (deleted_at), so an IPD number is never
// reissued and history survives.
router.delete('/:id', engPerm('delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE eng_development SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::int IS NULL OR company_id = $2)
        RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Development record not found' });
    res.json({ message: 'Development record removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
