/**
 * rdInputs.routes.js — the R&D improvement-input register (§277).
 *
 * Mounted /rd-inputs + verifyToken. One register fed from two places:
 *   - Sales, when a bid closes (won or lost): POST /crm/opportunities/:id/close
 *     writes the points in the same transaction as the close, and the closed
 *     deal's drawer can add more later through POST / here.
 *   - Service, after commissioning: the commissioning workflow page.
 *
 * Who may do what (no new permission module — the raisers already hold one):
 *   raise a sales input           crm:edit, on a CLOSED opportunity of the caller's company
 *   raise a commissioning input   servicedesk:edit, on a workflow of the caller's company
 *   read inputs of one record     crm:view (opportunity) / servicedesk:view (workflow)
 *   read the whole register       rd:view
 *   review (status + response)    rd:edit
 *   withdraw                      the person who raised it, while still 'new'; or rd:delete
 */
import { Router } from 'express';
import pool from '../../config/db.js';
import { can } from '../../middlewares/auth.middleware.js';
import { companyOf, callerIdentity } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';

export const SOURCES    = ['sales_won', 'sales_lost', 'commissioning', 'service'];
export const CATEGORIES = ['product_feature', 'performance', 'quality', 'cost', 'documentation', 'installation', 'software', 'other'];
export const PRIORITIES = ['low', 'medium', 'high'];
export const STATUSES   = ['new', 'under_review', 'accepted', 'rejected', 'implemented'];
export const MAX_POINTS = 20;

const SELECT = `
  SELECT i.*, o.opportunity_name, o.opportunity_number, o.stage AS opportunity_stage,
         c.workflow_number
    FROM rd_improvement_inputs i
    LEFT JOIN opportunities o           ON o.id = i.opportunity_id
    LEFT JOIN commissioning_workflows c ON c.id = i.commissioning_id`;

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Validate a list of points as sent by a form: [{ requirement, category, priority }].
 * Blank rows are dropped (a form always has one empty row); anything else
 * malformed is refused rather than quietly fixed.
 */
export function cleanPoints(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { throw new InputError('R&D points must be a JSON list'); }
  }
  if (list == null) return [];
  if (!Array.isArray(list)) throw new InputError('R&D points must be a list');
  const out = [];
  for (const p of list) {
    const requirement = String(p?.requirement ?? '').trim();
    if (!requirement) continue;
    if (requirement.length > 2000) throw new InputError('An R&D point is limited to 2000 characters');
    const category = p?.category || 'other';
    const priority = p?.priority || 'medium';
    if (!CATEGORIES.includes(category)) throw new InputError(`Unknown R&D category: ${category}`);
    if (!PRIORITIES.includes(priority)) throw new InputError(`Unknown priority: ${priority}`);
    out.push({ requirement, category, priority });
  }
  if (out.length > MAX_POINTS) throw new InputError(`At most ${MAX_POINTS} R&D points at a time`);
  return out;
}

/** Insert cleaned points. `db` is a client inside the caller's transaction, or the pool. */
export async function insertPoints(db, points, ctx) {
  const rows = [];
  for (const p of points) {
    const { rows: r } = await db.query(
      `INSERT INTO rd_improvement_inputs
         (company_id, source, opportunity_id, commissioning_id, customer_name, product_line,
          category, requirement, priority, raised_by, raised_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.company_id, ctx.source, ctx.opportunity_id ?? null, ctx.commissioning_id ?? null,
       ctx.customer_name ?? null, ctx.product_line ?? null,
       p.category, p.requirement, p.priority, ctx.raised_by ?? null, ctx.raised_by_name ?? null],
    );
    rows.push(r[0]);
  }
  return rows;
}

/** The record a point is raised against, checked for company and state. */
async function resolveContext(req, body) {
  const cid = companyOf(req);
  if (body.opportunity_id) {
    if (!(await can(req, 'crm', 'edit'))) throw new InputError('You need CRM edit rights to add sales inputs', 403);
    const { rows } = await pool.query(
      `SELECT o.id, o.stage, o.company_id, o.product_line, o.product_category,
              COALESCE(a.account_name, a.name, l.company_name) AS customer_name
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
         LEFT JOIN leads l    ON l.id = o.lead_id
        WHERE o.id = $1 AND o.deleted_at IS NULL AND ($2::int IS NULL OR o.company_id = $2)`,
      [body.opportunity_id, cid],
    );
    const o = rows[0];
    if (!o) throw new InputError('Opportunity not found', 404);
    const stage = String(o.stage || '').toLowerCase();
    if (stage !== 'won' && stage !== 'lost') {
      throw new InputError('R&D inputs from sales are recorded once the bid is won or lost', 409);
    }
    return {
      company_id: o.company_id ?? cid,
      source: stage === 'won' ? 'sales_won' : 'sales_lost',
      opportunity_id: o.id,
      customer_name: o.customer_name,
      product_line: o.product_line || o.product_category || null,
    };
  }
  if (body.commissioning_id) {
    if (!(await can(req, 'servicedesk', 'edit'))) throw new InputError('You need Service Desk edit rights to add commissioning inputs', 403);
    const { rows } = await pool.query(
      `SELECT id, company_id, customer_name FROM commissioning_workflows
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [body.commissioning_id, cid],
    );
    const w = rows[0];
    if (!w) throw new InputError('Commissioning workflow not found', 404);
    return { company_id: w.company_id ?? cid, source: 'commissioning', commissioning_id: w.id, customer_name: w.customer_name };
  }
  throw new InputError('Say which opportunity or commissioning the point is for');
}

const router = Router();

const fail = (res, e) => {
  if (e instanceof InputError) return res.status(e.status).json({ error: e.message });
  console.error('[rd-inputs]', e);
  return res.status(500).json({ error: 'Something went wrong' });
};

/** GET /rd-inputs — the whole register, for R&D. */
router.get('/', async (req, res) => {
  try {
    if (!(await can(req, 'rd', 'view'))) return res.status(403).json({ error: 'Forbidden' });
    const cid = companyOf(req);
    const params = [];
    let where = ` WHERE i.deleted_at IS NULL`;
    if (cid != null) where += ` AND i.company_id = $${params.push(cid)}`;
    const { source, status, category, priority, search } = req.query;
    if (source === 'sales') where += ` AND i.source IN ('sales_won','sales_lost')`;
    else if (SOURCES.includes(source)) where += ` AND i.source = $${params.push(source)}`;
    if (STATUSES.includes(status))     where += ` AND i.status = $${params.push(status)}`;
    if (status === 'open')             where += ` AND i.status IN ('new','under_review')`;
    if (CATEGORIES.includes(category)) where += ` AND i.category = $${params.push(category)}`;
    if (PRIORITIES.includes(priority)) where += ` AND i.priority = $${params.push(priority)}`;
    if (search && String(search).trim()) {
      const p = `$${params.push(`%${String(search).trim()}%`)}`;
      where += ` AND (i.requirement ILIKE ${p} OR i.customer_name ILIKE ${p} OR i.product_line ILIKE ${p}
                      OR o.opportunity_name ILIKE ${p} OR c.workflow_number ILIKE ${p})`;
    }
    const { rows } = await pool.query(
      `${SELECT}${where}
        ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,
                 CASE i.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 i.created_at DESC
        LIMIT 500`, params);

    const sp = cid != null ? [cid] : [];
    const { rows: [summary] } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('new','under_review'))::int AS open,
              COUNT(*) FILTER (WHERE status = 'new')::int AS new,
              COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE status = 'implemented')::int AS implemented,
              COUNT(*) FILTER (WHERE source IN ('sales_won','sales_lost'))::int AS from_sales,
              COUNT(*) FILTER (WHERE source IN ('commissioning','service'))::int AS from_service
         FROM rd_improvement_inputs
        WHERE deleted_at IS NULL${cid != null ? ' AND company_id = $1' : ''}`, sp);
    res.json({ data: rows, summary });
  } catch (e) { fail(res, e); }
});

/** GET /rd-inputs/for?opportunity_id=… | ?commissioning_id=… — the points on one record. */
router.get('/for', async (req, res) => {
  try {
    const cid = companyOf(req);
    const { opportunity_id, commissioning_id } = req.query;
    let col; let mod;
    if (opportunity_id)        { col = 'opportunity_id';   mod = 'crm'; }
    else if (commissioning_id) { col = 'commissioning_id'; mod = 'servicedesk'; }
    else return res.status(400).json({ error: 'opportunity_id or commissioning_id is required' });
    if (!(await can(req, mod, 'view')) && !(await can(req, 'rd', 'view'))) return res.status(403).json({ error: 'Forbidden' });
    const params = [opportunity_id || commissioning_id];
    const { rows } = await pool.query(
      `${SELECT} WHERE i.deleted_at IS NULL AND i.${col} = $1
         ${cid != null ? `AND i.company_id = $${params.push(cid)}` : ''}
       ORDER BY i.created_at`, params);
    res.json({ data: rows });
  } catch (e) { fail(res, e); }
});

/** POST /rd-inputs — { opportunity_id | commissioning_id, points: [{ requirement, category, priority }] } */
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const points = cleanPoints(body.points ?? [body]);
    if (!points.length) throw new InputError('Write at least one R&D point');
    const ctx = await resolveContext(req, body);
    const who = await callerIdentity(req, pool, ctx.company_id);
    const rows = await insertPoints(pool, points, {
      ...ctx, raised_by: req.user?.userId ?? null, raised_by_name: who.name,
    });
    logAudit({ userId: req.user?.userId, module: 'rd', recordType: 'rd_improvement_input',
               recordId: rows[0]?.id, action: 'create', newData: { ...ctx, count: rows.length }, req });
    res.status(201).json({ data: rows });
  } catch (e) { fail(res, e); }
});

/** PATCH /rd-inputs/:id/review — R&D decides. { status, rd_response } */
router.patch('/:id/review', async (req, res) => {
  try {
    if (!(await can(req, 'rd', 'edit'))) return res.status(403).json({ error: 'Only the R&D team can review inputs' });
    const { status } = req.body || {};
    const rd_response = String(req.body?.rd_response ?? '').trim() || null;
    if (!STATUSES.includes(status) || status === 'new') throw new InputError('Choose Under review, Accepted, Rejected or Implemented');
    if (status === 'rejected' && !rd_response) throw new InputError('Say why the input is rejected — the person who raised it reads this');
    const cid = companyOf(req);
    const who = await callerIdentity(req, pool, cid);
    const params = [status, rd_response, req.user?.userId ?? null, who.name, req.params.id];
    const { rows } = await pool.query(
      `UPDATE rd_improvement_inputs
          SET status = $1, rd_response = COALESCE($2, rd_response),
              reviewed_by = $3, reviewed_by_name = $4, reviewed_at = now(), updated_at = now()
        WHERE id = $5 AND deleted_at IS NULL
          ${cid != null ? `AND company_id = $${params.push(cid)}` : ''}
        RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Input not found' });
    logAudit({ userId: req.user?.userId, module: 'rd', recordType: 'rd_improvement_input',
               recordId: rows[0].id, action: 'review', newData: { status, rd_response }, req });
    res.json({ data: rows[0] });
  } catch (e) { fail(res, e); }
});

/** DELETE /rd-inputs/:id — withdraw. The raiser while 'new', or rd:delete. */
router.delete('/:id', async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = [req.params.id];
    const { rows } = await pool.query(
      `SELECT id, raised_by, status FROM rd_improvement_inputs
        WHERE id = $1 AND deleted_at IS NULL ${cid != null ? `AND company_id = $${params.push(cid)}` : ''}`, params);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Input not found' });
    const own = String(row.raised_by) === String(req.user?.userId) && row.status === 'new';
    if (!own && !(await can(req, 'rd', 'delete'))) {
      return res.status(403).json({ error: 'Only the person who raised it can withdraw it, and only before R&D reviews it' });
    }
    await pool.query(`UPDATE rd_improvement_inputs SET deleted_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
    logAudit({ userId: req.user?.userId, module: 'rd', recordType: 'rd_improvement_input',
               recordId: row.id, action: 'delete', req });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

export default router;
