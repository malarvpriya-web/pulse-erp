import { Router } from 'express';
import pool from '../../config/db.js';
import { nextProdOrderNumber, nextAmcNumber, nextWarrantyNumber, nextWarrantyClaimNumber } from '../../shared/docNumber.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import * as drive from '../../services/googleDrive.service.js';
import { copyRoutingToProductionOperations } from '../production/routingCopy.service.js';
import invoiceService from '../finance/services/invoice.service.js';
import { requiresRenewalApproval, isAuthorizedRenewalApprover, RENEWAL_APPROVAL_THRESHOLD } from '../../shared/renewalApproval.js';
import { requirePermission, permissionFor } from '../../middlewares/auth.middleware.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { toCsvObjects } from '../../shared/csv.js';
import {
  ensureProject, ProjectSetupError, setupErrorBody, lifecycleCustomerIdForOrder,
} from '../projects/services/projectCreation.service.js';
import {
  stageModel, nextStage, earlierStages, ENTRY_GATES, FINAL_STAGE, OPEN_STATUSES, isLegacyStage, derivedProductionStage,
} from '../../shared/projectStages.js';
import { checkGates, lifecycleScope } from './services/lifecycleGates.service.js';
import { getProjectClosureBlockers } from '../projects/services/projectClosure.service.js';
import { CLOSED_PROJECT_STATUSES } from '../projects/projectStatus.js';

const router = Router();

const cid = (req) => req.scope?.company_id ?? null;

const actor = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

/*
 * Commissioning-report, warranty and warranty-claim routes only
 * (LEGACY_MIS_TO_PULSE_AUDIT.md, P0 Task 4). cid() above is
 * `req.scope?.company_id ?? null`, and every query here reads null as "all
 * companies" — so a login with no company and no global scope used to read and
 * write every company's records. These routes now refuse it, and refuse links
 * to another company's lifecycle / sales order / warranty / ticket / asset.
 */
const requireCompanyScope = (req, res, next) => {
  if (cid(req) == null && req.scope?.isGlobal !== true) {
    return res.status(403).json({ error: 'No company is assigned to this login.' });
  }
  next();
};

/** First link that does not belong to `companyId`, as an error message; else null. */
async function foreignLinkIn(companyId, links) {
  for (const [table, value, label] of links) {
    if (value === undefined || value === null || value === '') continue;
    const { rows } = await pool.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [parseInt(value, 10) || 0, companyId]
    );
    if (!rows.length) return `${label} not found in your company`;
  }
  return null;
}

/** First link that does not belong to the caller's company, as an error message; else null. */
const foreignLink = (req, links) => foreignLinkIn(cid(req), links);

/*
 * Lifecycle-instance routes (P1_PROJECT_LIFECYCLE_PLAN.md Phase 1, T1/T2): the
 * same company rules. A bootstrap reads the sales order in the caller's
 * company only, and the BOM / project a request names must be in the ORDER's
 * company (a global caller included).
 */
const bootstrapLinkError = (so, body = {}) => foreignLinkIn(so.company_id ?? null, [
  ['bom_headers', body.bom_id, 'BOM'],
  ['projects', body.project_id, 'Project'],
]);

/* ─── table migrations ─────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      ALTER TABLE lifecycle_instances     ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE commissioning_reports   ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE amc_contracts           ADD COLUMN IF NOT EXISTS company_id INTEGER;
    `);
  } catch (e) { console.error('[lifecycle] migration error:', e.message); }
})();

export async function createProductionOrderFromSalesOrder(client, salesOrder, req, opts = {}) {
  const {
    product_name,
    quantity_planned,
    bom_id,
    project_id,
    planned_start_date,
    planned_end_date,
    priority = 'medium',
    notes,
  } = opts;

  const item = await client.query(
    `SELECT description AS item_description, quantity
     FROM sales_order_items
     WHERE order_id = $1
     ORDER BY id
     LIMIT 1`,
    [salesOrder.id]
  );
  const fallbackProductName = item.rows[0]?.item_description || `SO-${salesOrder.order_number || salesOrder.id}`;
  const fallbackQty = Number(item.rows[0]?.quantity || 1);
  const selectedProductName = product_name || fallbackProductName;
  const selectedQty = Number(quantity_planned || fallbackQty);

  const orderNo = await nextProdOrderNumber(client);
  const a = actor(req);

  const createdPo = await client.query(
    `INSERT INTO production_orders
      (production_order_no, sales_order_id, bom_id, project_id, product_name, quantity_planned, priority, planned_start_date, planned_end_date, notes, created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [orderNo, salesOrder.id, bom_id || null, project_id || null, selectedProductName, selectedQty, priority, planned_start_date || null, planned_end_date || null, notes || null, a.id, salesOrder.company_id || null]
  );
  const po = createdPo.rows[0];

  if (bom_id) {
    await copyRoutingToProductionOperations(client, bom_id, po.id);
  }

  return po;
}

// Moved to the project creator, which is now its only internal user; kept
// exported from here for existing imports.
export { lifecycleCustomerIdForOrder };

// C4: order -> project + lifecycle (ensureProject(), the one project creator:
// confirmed order, order's company, reuse of the order's / its opportunity's
// project and of that project's single open lifecycle), then the production
// order — reused when the order already has one. Runs in the caller's
// transaction; any failure throws and the caller rolls everything back.
async function bootstrapLifecycleForSalesOrder(client, salesOrder, req, opts = {}) {
  const { auto_create_production_order = true } = opts;
  const a = actor(req);
  const setup = await ensureProject(client, {
    salesOrderId: salesOrder.id,
    projectId: opts.project_id || null,
    scopeCompanyId: cid(req),
    actor: { userId: a.id, name: a.name },
    lifecycleNotes: opts.stage_notes || 'Lifecycle bootstrapped from sales order',
  });
  if (setup.lifecycleExisted) {
    return { lifecycle: setup.lifecycle, production_order: null, existed: true };
  }

  let lifecycle = setup.lifecycle;
  let productionOrder = null;
  if (auto_create_production_order) {
    const { rows: existingPo } = await client.query(
      `SELECT id FROM production_orders WHERE sales_order_id = $1 ORDER BY id LIMIT 1`, [salesOrder.id]);
    productionOrder = existingPo[0]
      ? (await client.query(
        `UPDATE production_orders SET project_id = COALESCE(project_id, $2) WHERE id = $1 RETURNING *`,
        [existingPo[0].id, setup.project.id])).rows[0]
      : await createProductionOrderFromSalesOrder(client, salesOrder, req, { ...opts, project_id: setup.project.id });
    lifecycle = (await client.query(
      `UPDATE lifecycle_instances SET production_order_id = COALESCE(production_order_id, $1), updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [productionOrder.id, lifecycle.id])).rows[0];
  }
  return { lifecycle, production_order: productionOrder, existed: false };
}

// Gated on the owning module 2026-09-04. A live probe with a plain
// `employee` token returned other people's records from this router, and an
// employee has no routine need for this register — their own record reaches
// them through self-service. `employee` is denied servicedesk in role_permissions,
// which is what makes this gate real rather than decorative.
router.get('/instances', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { sales_order_id, current_stage, status } = req.query;
    const params = [companyId];
    const where = ['($1::int IS NULL OR li.company_id = $1)'];
    if (sales_order_id) { params.push(sales_order_id); where.push(`li.sales_order_id = $${params.length}`); }
    if (current_stage) { params.push(current_stage); where.push(`li.current_stage = $${params.length}`); }
    if (status) { params.push(status); where.push(`li.status = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT li.*,
         so.order_number,
         po.production_order_no
       FROM lifecycle_instances li
       -- Only an order / production order of the lifecycle's own company is
       -- shown: a mis-linked id must not leak another company's numbers.
       LEFT JOIN sales_orders so ON so.id = li.sales_order_id AND so.company_id IS NOT DISTINCT FROM li.company_id
       LEFT JOIN production_orders po ON po.id = li.production_order_id AND po.company_id IS NOT DISTINCT FROM li.company_id
       WHERE ${where.join(' AND ')}
       ORDER BY li.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// C5: a manual lifecycle. It belongs to a project — named, or the confirmed
// order's (created through ensureProject() when the order has none) — and a
// project or order that already has an open lifecycle is refused (409) rather
// than given a second one.
router.post('/instances', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  const { sales_order_id, production_order_id, project_id, customer_id, stage_notes } = req.body || {};
  const given = (v) => v !== undefined && v !== null && v !== '';
  if (!given(sales_order_id) && !given(project_id)) {
    return res.status(400).json({ error: 'A lifecycle belongs to a project or a confirmed sales order: give project_id or sales_order_id' });
  }
  // A global caller has no company of its own: the lifecycle takes the
  // company of what it links to, and every link must share it.
  let companyId = cid(req);
  if (companyId == null) {
    for (const [table, value] of [['projects', project_id], ['sales_orders', sales_order_id]]) {
      if (!given(value)) continue;
      const { rows: owner } = await pool.query(`SELECT company_id FROM ${table} WHERE id = $1`, [parseInt(value, 10) || 0]);
      if (owner[0]?.company_id != null) { companyId = owner[0].company_id; break; }
    }
    if (companyId == null) return res.status(400).json({ error: 'A project or sales order is required to place the lifecycle in a company' });
  }
  const foreign = await foreignLinkIn(companyId, [
    ['sales_orders', sales_order_id, 'Sales order'],
    ['production_orders', production_order_id, 'Production order'],
    ['projects', project_id, 'Project'],
    ['accounts', customer_id, 'Customer'],
  ]);
  if (foreign) return res.status(400).json({ error: foreign });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = actor(req);
    const setup = await ensureProject(client, {
      salesOrderId: given(sales_order_id) ? sales_order_id : null,
      projectId: given(project_id) ? project_id : null,
      scopeCompanyId: companyId,
      actor: { userId: a.id, name: a.name },
      lifecycleNotes: stage_notes || 'Lifecycle initiated',
      lifecycleLinks: { production_order_id, customer_id },
      conflictIfLifecycleOpen: true,
    });
    await client.query('COMMIT');
    res.status(201).json(setup.lifecycle);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof ProjectSetupError) return res.status(e.status).json(setupErrorBody(e));
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/instances/from-sales-order/:id', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const soRes = await client.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]
    );
    if (!soRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sales order not found' });
    }
    const so = soRes.rows[0];
    const linkError = await bootstrapLinkError(so, req.body || {});
    if (linkError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: linkError });
    }

    const { lifecycle, production_order, existed } = await bootstrapLifecycleForSalesOrder(client, so, req, req.body || {});

    await client.query('COMMIT');
    res.status(existed ? 200 : 201).json({
      lifecycle,
      production_order,
      existed,
      sales_order: { id: so.id, order_number: so.order_number, customer_id: so.customer_id },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    // 422 SALES_ORDER_NOT_CONFIRMED: set-up needs a confirmed order.
    if (e instanceof ProjectSetupError) return res.status(e.status).json(setupErrorBody(e));
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/instances/auto-bootstrap/:id', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const soRes = await client.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, cid(req)]
    );
    if (!soRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sales order not found' });
    }
    const so = soRes.rows[0];
    const linkError = await bootstrapLinkError(so, req.body || {});
    if (linkError) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: linkError });
    }
    const status = String(so.order_status || '').toLowerCase();
    const eligible = ['accepted', 'confirmed', 'won', 'approved', 'released'].includes(status);
    if (!eligible) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Sales order status '${so.order_status}' is not eligible for auto-bootstrap`,
        required_statuses: ['accepted', 'confirmed', 'won', 'approved', 'released'],
      });
    }
    const { lifecycle, production_order, existed } = await bootstrapLifecycleForSalesOrder(client, so, req, req.body || {});
    await client.query('COMMIT');
    res.status(existed ? 200 : 201).json({ lifecycle, production_order, existed });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e instanceof ProjectSetupError) return res.status(e.status).json(setupErrorBody(e));
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Stage model, transitions and gates (P1_PROJECT_LIFECYCLE_PLAN.md Phase 4) ──
//
// The stage list, the only forward step from each stage and the gate that
// guards each stage all come from shared/projectStages.js; the evidence comes
// from services/lifecycleGates.service.js. Every route below:
//  - reads the lifecycle in the caller's company only (404 otherwise);
//  - locks it FOR UPDATE, so two transitions of one lifecycle serialise;
//  - writes one lifecycle_stage_history row (actor, reason, gate snapshot) —
//    history is never edited or deleted;
//  - leaves projects.status alone: the administrative state is not a stage.
//
// Permissions: view = servicedesk:view; advance / hold / resume =
// servicedesk:edit; going backwards, cancelling, reopening and completing =
// servicedesk:approve, and those need a written reason.

const REASON_MIN = 5;
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k]]));

/** A refusal with its HTTP status and machine code. */
class TransitionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const reasonOf = (body) => String(body?.reason ?? body?.remarks ?? '').trim();
const requireReason = (body, what) => {
  const reason = reasonOf(body);
  if (reason.length < REASON_MIN) {
    throw new TransitionError(400, 'REASON_REQUIRED', `A reason (at least ${REASON_MIN} characters) is required to ${what}`);
  }
  return reason;
};

/** Refuse moving a lifecycle whose project is administratively closed. */
function assertProjectOpen(scope) {
  if (scope.project && CLOSED_PROJECT_STATUSES.includes(scope.project.status)) {
    throw new TransitionError(409, 'PROJECT_CLOSED',
      `The project is ${scope.project.status}; reopen the project before moving its lifecycle`);
  }
}

async function writeHistory(client, { id, from, to, action, remarks, actor: a, snapshot = {} }) {
  await client.query(
    `INSERT INTO lifecycle_stage_history
       (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, from, to, action, remarks || null, a.id, a.name, JSON.stringify(snapshot)]);
}

/**
 * Run one transition: lock the caller-company lifecycle, call fn, commit.
 * fn(client, instance, a) returns the updated row; a TransitionError becomes
 * its status, anything else a 500, and the transaction is rolled back.
 */
function transition(action, fn) {
  return async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM lifecycle_instances WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
        [req.params.id, cid(req)]);
      if (!rows.length) throw new TransitionError(404, 'NOT_FOUND', 'Lifecycle instance not found');
      const a = actor(req);
      const { row, from, to } = await fn(client, rows[0], a, req);
      await client.query('COMMIT');
      logAudit({ userId: a.id, module: 'lifecycle', recordId: req.params.id, recordType: 'lifecycle_instance',
        action: 'workflow_transition', newData: { action, from, to, status: row.status }, req });
      if (action === 'advance') {
        notifyWorkflowEvent('lifecycle_advanced', { module: `Lifecycle (${from}→${to})`, recordId: req.params.id,
          submitterUserId: rows[0].created_by ?? null, comments: `${from} → ${to}` });
      }
      res.json(row);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e instanceof TransitionError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
      // ux_lifecycle_open_per_project / _sales_order (Phase 3): another open lifecycle exists.
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Another open lifecycle already exists for this project or sales order', code: 'LIFECYCLE_EXISTS' });
      }
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  };
}

// The stage model: stages in order, reserved ones, statuses, and the gate per stage.
router.get('/stages', requireCompanyScope, requirePermission('servicedesk', 'view'), (req, res) => {
  res.json(stageModel());
});

router.get('/instances/:id', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    // order_number: the linked order's number, the same field the list returns.
    // Joined only when the order is in the lifecycle's own company and not
    // deleted — otherwise null, never another company's number.
    const { rows } = await pool.query(
      `SELECT li.*, so.order_number
         FROM lifecycle_instances li
         LEFT JOIN sales_orders so
           ON so.id = li.sales_order_id AND so.company_id IS NOT DISTINCT FROM li.company_id AND so.deleted_at IS NULL
        WHERE li.id=$1 AND ($2::int IS NULL OR li.company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lifecycle instance not found' });
    const history = await pool.query(
      `SELECT * FROM lifecycle_stage_history WHERE lifecycle_instance_id=$1 ORDER BY created_at DESC, id DESC`,
      [req.params.id]
    );
    const { gates, details, errors } = await checkGates(pool, rows[0]);
    const next = rows[0].status === 'active' ? nextStage(rows[0].current_stage) : null;
    res.json({
      ...rows[0],
      gates,
      gate_details: details,
      gate_errors: errors,
      next_stage: next,
      next_stage_gates: next ? ENTRY_GATES[next] || [] : [],
      derived_production_stage: derivedProductionStage(rows[0].current_stage),
      history: history.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Forward, one stage, through the stage's gate. An explicit to_stage must be
// that next stage (jumps and reserved stages are refused).
router.post('/instances/:id/advance', requireCompanyScope, requirePermission('servicedesk', 'edit'),
  transition('advance', async (client, inst, a, req) => {
    if (inst.status !== 'active') {
      throw new TransitionError(409, 'NOT_ACTIVE', inst.status === 'on_hold'
        ? 'The lifecycle is on hold; resume it before advancing'
        : `A ${inst.status} lifecycle cannot advance`);
    }
    if (isLegacyStage(inst.current_stage)) {
      throw new TransitionError(409, 'LEGACY_STAGE', `'${inst.current_stage}' is a legacy stage with no transitions`);
    }
    const to = nextStage(inst.current_stage);
    if (!to) throw new TransitionError(409, 'FINAL_STAGE', `Already at ${inst.current_stage}; complete the lifecycle instead`);
    const requested = req.body?.to_stage;
    if (requested && requested !== to) {
      throw new TransitionError(422, 'INVALID_TRANSITION',
        `Cannot move ${inst.current_stage} -> ${requested}; the next stage is ${to}`, { allowed_next: to });
    }
    const evaluation = await checkGates(client, inst);
    assertProjectOpen(evaluation.scope);
    const required = ENTRY_GATES[to] || [];
    const failing = required.filter(k => !evaluation.gates[k]);
    if (failing.length) {
      throw new TransitionError(422, 'GATE_NOT_SATISFIED',
        `Cannot advance ${inst.current_stage} -> ${to}: ${failing.join(', ')} not satisfied`,
        { gates: evaluation.gates, failing, gate_details: pick(evaluation.details, required), gate_errors: evaluation.errors });
    }
    const { rows } = await client.query(
      `UPDATE lifecycle_instances
          SET current_stage=$1, stage_started_at=NOW(), stage_completed_at=NULL,
              stage_notes=COALESCE($2, stage_notes), updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [to, req.body?.remarks || null, inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to, action: 'advance', remarks: req.body?.remarks, actor: a,
      snapshot: { required, gates: pick(evaluation.gates, required), details: pick(evaluation.details, required) } });
    return { row: rows[0], from: inst.current_stage, to };
  }));

// Backwards, to any earlier active stage (default: the previous one). Approver only, with a reason.
router.post('/instances/:id/rollback', requireCompanyScope, requirePermission('servicedesk', 'approve'),
  transition('rollback', async (client, inst, a, req) => {
    const reason = requireReason(req.body, 'move a lifecycle back');
    if (inst.status !== 'active') {
      throw new TransitionError(409, 'NOT_ACTIVE', `A ${inst.status} lifecycle cannot be moved back`);
    }
    const allowed = earlierStages(inst.current_stage);
    const to = req.body?.to_stage || allowed[allowed.length - 1];
    if (!to || !allowed.includes(to)) {
      throw new TransitionError(422, 'INVALID_TRANSITION',
        `Cannot move ${inst.current_stage} back to ${to || '(none)'}`, { allowed_previous: allowed });
    }
    assertProjectOpen(await lifecycleScope(client, inst));
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET current_stage=$1, stage_started_at=NOW(), stage_completed_at=NULL, updated_at=NOW()
        WHERE id=$2 RETURNING *`, [to, inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to, action: 'rollback', remarks: reason, actor: a });
    return { row: rows[0], from: inst.current_stage, to };
  }));

router.post('/instances/:id/hold', requireCompanyScope, requirePermission('servicedesk', 'edit'),
  transition('hold', async (client, inst, a, req) => {
    if (inst.status !== 'active') throw new TransitionError(409, 'NOT_ACTIVE', `Only an active lifecycle can be put on hold (this one is ${inst.status})`);
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET status='on_hold', stage_notes=COALESCE($1, stage_notes), updated_at=NOW()
        WHERE id=$2 RETURNING *`, [req.body?.remarks || null, inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to: inst.current_stage, action: 'hold', remarks: req.body?.remarks, actor: a });
    return { row: rows[0], from: inst.current_stage, to: inst.current_stage };
  }));

// Resume is only the way back from on_hold. A completed or cancelled
// lifecycle is reopened (approver, reason) — never resumed.
router.post('/instances/:id/resume', requireCompanyScope, requirePermission('servicedesk', 'edit'),
  transition('resume', async (client, inst, a, req) => {
    if (inst.status !== 'on_hold') {
      throw new TransitionError(409, 'NOT_ON_HOLD', ['completed', 'cancelled'].includes(inst.status)
        ? `A ${inst.status} lifecycle cannot be resumed; an approver can reopen it`
        : 'Only a lifecycle on hold can be resumed');
    }
    assertProjectOpen(await lifecycleScope(client, inst));
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET status='active', stage_notes=COALESCE($1, stage_notes), updated_at=NOW()
        WHERE id=$2 RETURNING *`, [req.body?.remarks || null, inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to: inst.current_stage, action: 'resume', remarks: req.body?.remarks, actor: a });
    return { row: rows[0], from: inst.current_stage, to: inst.current_stage };
  }));

router.post('/instances/:id/cancel', requireCompanyScope, requirePermission('servicedesk', 'approve'),
  transition('cancel', async (client, inst, a, req) => {
    const reason = requireReason(req.body, 'cancel a lifecycle');
    if (!OPEN_STATUSES.includes(inst.status)) throw new TransitionError(409, 'NOT_OPEN', `A ${inst.status} lifecycle cannot be cancelled`);
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`, [inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to: inst.current_stage, action: 'cancel', remarks: reason, actor: a });
    return { row: rows[0], from: inst.current_stage, to: inst.current_stage };
  }));

// The explicit, authorised way back from completed / cancelled. Refused while
// another lifecycle of the same project or order is open (Phase 3 indexes).
router.post('/instances/:id/reopen', requireCompanyScope, requirePermission('servicedesk', 'approve'),
  transition('reopen', async (client, inst, a, req) => {
    const reason = requireReason(req.body, 'reopen a lifecycle');
    if (!['completed', 'cancelled'].includes(inst.status)) {
      throw new TransitionError(409, 'NOT_CLOSED', `Only a completed or cancelled lifecycle can be reopened (this one is ${inst.status})`);
    }
    assertProjectOpen(await lifecycleScope(client, inst));
    const { rows: open } = await client.query(
      `SELECT id, lifecycle_number FROM lifecycle_instances
        WHERE id <> $1 AND status IN ('active','on_hold')
          AND ((project_id IS NOT NULL AND project_id = $2) OR (sales_order_id IS NOT NULL AND sales_order_id = $3))
        LIMIT 1`, [inst.id, inst.project_id, inst.sales_order_id]);
    if (open.length) {
      throw new TransitionError(409, 'LIFECYCLE_EXISTS',
        `Lifecycle ${open[0].lifecycle_number} is already open for this project or order`, { lifecycle_id: open[0].id });
    }
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET status='active', stage_completed_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to: inst.current_stage, action: 'reopen', remarks: reason, actor: a });
    return { row: rows[0], from: inst.current_stage, to: inst.current_stage };
  }));

// Completion: only at Closure, approver only, with the project's closure
// blockers (open tasks, unbilled billing milestones, pending timesheets)
// cleared. An approver may complete over blockers only with a written
// override_reason, which is recorded with the blockers in the history.
// The project's own status is not changed here.
router.post('/instances/:id/complete', requireCompanyScope, requirePermission('servicedesk', 'approve'),
  transition('complete', async (client, inst, a, req) => {
    if (inst.status !== 'active') throw new TransitionError(409, 'NOT_ACTIVE', `A ${inst.status} lifecycle cannot be completed`);
    if (inst.current_stage !== FINAL_STAGE) {
      throw new TransitionError(409, 'NOT_AT_CLOSURE', `Only a lifecycle at ${FINAL_STAGE} can be completed (this one is at ${inst.current_stage})`);
    }
    const scope = await lifecycleScope(client, inst);
    const blockers = scope.projectId ? await getProjectClosureBlockers(client, scope.projectId) : [];
    const override = String(req.body?.override_reason ?? '').trim();
    if (blockers.length && override.length < REASON_MIN) {
      throw new TransitionError(422, 'CLOSURE_BLOCKED',
        'The project is not ready to close: ' + blockers.map(b => `${b.count} ${b.type.replace(/_/g, ' ')}`).join(', ')
        + `. An approver may complete anyway with an override_reason (at least ${REASON_MIN} characters).`,
        { blockers });
    }
    const { rows } = await client.query(
      `UPDATE lifecycle_instances SET status='completed', stage_completed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [inst.id]);
    await writeHistory(client, { id: inst.id, from: inst.current_stage, to: inst.current_stage, action: 'complete',
      remarks: override || req.body?.remarks || null, actor: a,
      snapshot: { blockers, overridden: blockers.length > 0 } });
    return { row: rows[0], from: inst.current_stage, to: inst.current_stage };
  }));

router.post('/commissioning', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  try {
    const {
      lifecycle_instance_id,
      sales_order_id,
      site_name,
      site_address,
      commissioning_date,
      engineer_name,
      status = 'open',
      checklist = [],
      punch_points = [],
      remarks,
    } = req.body;
    const companyId = cid(req);
    // A report on another company's lifecycle would satisfy that lifecycle's
    // commissioning gate (it counts reports by lifecycle_instance_id).
    const foreign = await foreignLink(req, [
      ['lifecycle_instances', lifecycle_instance_id, 'Lifecycle'],
      ['sales_orders', sales_order_id, 'Sales order'],
    ]);
    if (foreign) return res.status(400).json({ error: foreign });
    const { rows } = await pool.query(
      `INSERT INTO commissioning_reports
        (lifecycle_instance_id, sales_order_id, site_name, site_address, commissioning_date, engineer_name, status, checklist, punch_points, remarks, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [lifecycle_instance_id || null, sales_order_id || null, site_name || null, site_address || null, commissioning_date || null, engineer_name || null, status, JSON.stringify(checklist), JSON.stringify(punch_points), remarks || null, companyId]
    );
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'lifecycle', recordId: rows[0].id, recordType: 'commissioning_report', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/commissioning/:id', requireCompanyScope, requirePermission('servicedesk', 'edit'), captureBefore('commissioning_reports'), async (req, res) => {
  try {
    const { status, checklist, punch_points, remarks, site_name, site_address, commissioning_date, engineer_name } = req.body;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE commissioning_reports
       SET status              = COALESCE($1,  status),
           checklist           = COALESCE($2::jsonb, checklist),
           punch_points        = COALESCE($3::jsonb, punch_points),
           remarks             = COALESCE($4,  remarks),
           site_name           = COALESCE($5,  site_name),
           site_address        = COALESCE($6,  site_address),
           commissioning_date  = COALESCE($7,  commissioning_date),
           engineer_name       = COALESCE($8,  engineer_name),
           updated_at          = NOW()
       WHERE id=$9 AND ($10::int IS NULL OR company_id = $10)
       RETURNING *`,
      [
        status || null,
        checklist ? JSON.stringify(checklist) : null,
        punch_points ? JSON.stringify(punch_points) : null,
        remarks || null,
        site_name || null,
        site_address || null,
        commissioning_date || null,
        engineer_name || null,
        req.params.id,
        companyId,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Commissioning report not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/amc-contracts', requirePermission('servicedesk', 'add'), async (req, res) => {
  try {
    const {
      lifecycle_instance_id, sales_order_id, commissioning_workflow_id,
      start_date, end_date,
      sla_response_hours = 24,
      preventive_visits_per_year = 4,
      status = 'active',
      coverage_notes,
      contract_value = 0,
      billing_frequency = 'Annual',
      payment_terms = 'Net 30',
      serial_number,
    } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });
    const companyId = cid(req);
    const contractNo = await nextAmcNumber();
    const a = actor(req);

    // Auto compute next renewal date
    const endD = new Date(end_date);
    const nextRenewal = new Date(endD);
    nextRenewal.setDate(nextRenewal.getDate() - 30);

    const { rows } = await pool.query(
      `INSERT INTO amc_contracts
        (lifecycle_instance_id, sales_order_id, commissioning_workflow_id, contract_number, start_date, end_date,
         sla_response_hours, preventive_visits_per_year, status, coverage_notes,
         contract_value, billing_frequency, payment_terms, serial_number, next_renewal_date,
         created_by, created_by_name, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [lifecycle_instance_id||null, sales_order_id||null, commissioning_workflow_id||null, contractNo, start_date, end_date,
       sla_response_hours, preventive_visits_per_year, status, coverage_notes||null,
       Number(contract_value)||0, billing_frequency, payment_terms, serial_number||null,
       nextRenewal.toISOString().slice(0,10), a.id, a.name, companyId]
    );
    logAudit({ userId: a.id, module: 'lifecycle', recordId: rows[0].id, recordType: 'amc_contract', action: 'create', newData: rows[0], req });
    notifyWorkflowEvent('amc_created', { module: 'AMC Contract', recordId: rows[0].contract_number, submitterUserId: a.id });

    // Auto-upload AMC document to Drive under customer folder
    if (drive.isDriveConfigured() && rows[0].sales_order_id) {
      pool.query(`SELECT customer_name FROM sales_orders WHERE id=$1`, [rows[0].sales_order_id])
        .then(async soRes => {
          const customerName = soRes.rows[0]?.customer_name;
          if (!customerName) return;
          const driveRes = await drive.uploadJsonRecord({
            data:         rows[0],
            fileName:     `AMC-${rows[0].contract_number}.json`,
            customerName,
            docType:      drive.DOC_TYPES.AMC_DOCUMENT,
            companyId,
          });
          await pool.query(
            `UPDATE amc_contracts SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
            [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
          ).catch(() => {});
        }).catch(e => console.error('[amc/create/drive]', e.message));
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/amc-contracts', requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { lifecycle_instance_id, status } = req.query;
    const params = [companyId];
    const where = ['($1::int IS NULL OR ac.company_id = $1)'];
    if (lifecycle_instance_id) { params.push(lifecycle_instance_id); where.push(`ac.lifecycle_instance_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`ac.status = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT ac.*,
         li.lifecycle_number,
         so.order_number
       FROM amc_contracts ac
       LEFT JOIN lifecycle_instances li ON li.id = ac.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id = ac.sales_order_id
       WHERE ${where.join(' AND ')}
       ORDER BY ac.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/amc-contracts/:id', requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT ac.*,
         li.lifecycle_number,
         so.order_number,
         wr.id AS linked_warranty_id, wr.warranty_end AS linked_warranty_end,
         wr.status AS linked_warranty_status
       FROM amc_contracts ac
       LEFT JOIN lifecycle_instances li ON li.id = ac.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id = ac.sales_order_id
       LEFT JOIN LATERAL (
         SELECT id, warranty_end, status FROM warranty_registrations w
          WHERE w.amc_contract_id = ac.id
             OR (w.serial_number IS NOT NULL AND w.serial_number = ac.serial_number)
          ORDER BY (w.amc_contract_id = ac.id) DESC, w.warranty_end DESC
          LIMIT 1
       ) wr ON true
       WHERE ac.id = $1 AND ($2::int IS NULL OR ac.company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'AMC contract not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/amc-contracts/:id', requirePermission('servicedesk', 'edit'), captureBefore('amc_contracts'), async (req, res) => {
  try {
    const { status, sla_response_hours, preventive_visits_per_year, coverage_notes, end_date,
            contract_value, billing_frequency, payment_terms, serial_number, start_date } = req.body;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE amc_contracts
       SET status                     = COALESCE($1,  status),
           sla_response_hours         = COALESCE($2,  sla_response_hours),
           preventive_visits_per_year = COALESCE($3,  preventive_visits_per_year),
           coverage_notes             = COALESCE($4,  coverage_notes),
           end_date                   = COALESCE($5,  end_date),
           contract_value             = COALESCE($6,  contract_value),
           billing_frequency          = COALESCE($7,  billing_frequency),
           payment_terms              = COALESCE($8,  payment_terms),
           serial_number              = COALESCE($9,  serial_number),
           start_date                 = COALESCE($10, start_date),
           next_renewal_date = CASE
             WHEN $5 IS NOT NULL THEN ($5::date - INTERVAL '30 days')::date
             ELSE next_renewal_date
           END,
           updated_at = NOW()
       WHERE id = $11 AND ($12::int IS NULL OR company_id = $12)
       RETURNING *`,
      [status||null, sla_response_hours||null, preventive_visits_per_year||null, coverage_notes||null,
       end_date||null, contract_value != null ? Number(contract_value) : null,
       billing_frequency||null, payment_terms||null, serial_number||null, start_date||null,
       req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'AMC contract not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/amc-contracts/:id', requirePermission('servicedesk', 'delete'), captureBefore('amc_contracts'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM amc_contracts WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'AMC contract not found' });
    res.json({ success: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/amc-contracts/:id/generate-visits', requirePermission('servicedesk', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    await client.query('BEGIN');
    const amcRes = await client.query(
      `SELECT * FROM amc_contracts WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!amcRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'AMC contract not found' });
    }
    const amc = amcRes.rows[0];
    const start = new Date(amc.start_date);
    const end   = new Date(amc.end_date);
    const visitsPerYear  = Number(amc.preventive_visits_per_year) || 4;
    const intervalMonths = Math.max(1, Math.round(12 / visitsPerYear));
    const visits = [];

    let visitDate = new Date(start);
    while (visitDate <= end) {
      const dateStr = visitDate.toISOString().slice(0, 10);
      const inserted = await client.query(
        `INSERT INTO field_visits
          (customer_name, address, visit_date, visit_time, engineer_name, purpose,
           status, notes, amc_contract_id, serial_number, visit_type, company_id)
         VALUES ($1,$2,$3,'10:00','','Preventive Maintenance (AMC)','Scheduled',$4,$5,$6,'AMC',$7)
         RETURNING *`,
        [
          `AMC Contract #${amc.contract_number}`,
          '',
          dateStr,
          `Auto-generated from AMC contract ${amc.contract_number}`,
          amc.id,
          amc.serial_number || null,
          companyId,
        ]
      );
      visits.push(inserted.rows[0]);
      visitDate.setMonth(visitDate.getMonth() + intervalMonths);
    }

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: req.params.id, recordType: 'amc_contract', action: 'generate_visits', newData: { count: visits.length }, req });
    res.status(201).json({ generated: visits.length, visits });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── AMC generate-invoice ──────────────────────────────────────────────────────
router.post('/amc-contracts/:id/generate-invoice', requirePermission('servicedesk', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM amc_contracts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'AMC contract not found' });
    const amc = rows[0];
    if (!amc.contract_value || parseFloat(amc.contract_value) === 0) {
      return res.status(422).json({ error: 'contract_value not set. Update the AMC contract first.' });
    }
    let billingAmount = parseFloat(amc.contract_value);
    if (amc.billing_frequency === 'Quarterly')  billingAmount /= 4;
    else if (amc.billing_frequency === 'Monthly')    billingAmount /= 12;
    else if (amc.billing_frequency === 'Half-Yearly') billingAmount /= 2;

    const invoiceData = {
      amc_contract_id  : amc.id,
      contract_number  : amc.contract_number,
      billing_amount   : Math.round(billingAmount * 100) / 100,
      billing_frequency: amc.billing_frequency || 'Annual',
      serial_number    : amc.serial_number,
      due_date         : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      status           : 'draft',
      notes            : `AMC Invoice — contract ${amc.contract_number}`,
      company_id       : companyId,
    };
    await pool.query(`UPDATE amc_contracts SET last_invoice_date=NOW() WHERE id=$1`, [amc.id]);
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: amc.id, recordType: 'amc_contract', action: 'invoice_generated', newData: invoiceData, req });
    res.status(201).json({ success: true, invoice: invoiceData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AMC renew ─────────────────────────────────────────────────────────────────
// Renewal Engine (Priority 5): added an approval gate (renewals above
// RENEWAL_APPROVAL_THRESHOLD need finance/admin sign-off — this endpoint had
// no role check at all before) and a real Payment step (an actual invoice,
// not just a contract-value field update), matching the same pattern applied
// to subscription renewal (sales.routes.js). Invoice creation happens before
// the contract is updated so a credit-limit (or other) failure blocks the
// renewal instead of silently proceeding.
router.post('/amc-contracts/:id/renew', requirePermission('servicedesk', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const { new_end_date, new_value, notes } = req.body;
    if (!new_end_date) return res.status(422).json({ error: 'new_end_date is required' });
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM amc_contracts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'AMC contract not found' }); }
    const amc = rows[0];
    const renewalValue = new_value || amc.contract_value;

    if (requiresRenewalApproval(renewalValue) && !isAuthorizedRenewalApprover(req)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `Renewals above ₹${RENEWAL_APPROVAL_THRESHOLD.toLocaleString('en-IN')} require finance/admin approval`,
      });
    }

    // Resolve the customer via sales_order_id -> sales_orders.customer_id —
    // the same real uuid link customer360.routes.js already uses for this
    // exact table, since amc_contracts has no customer_id of its own.
    let invoiceId = null;
    if (amc.sales_order_id) {
      const { rows: soRows } = await client.query(
        `SELECT customer_id FROM sales_orders WHERE id=$1`, [amc.sales_order_id]
      );
      const customerId = soRows[0]?.customer_id;
      if (customerId) {
        try {
          const invoice = await invoiceService.createInvoice({
            customer_id: customerId,
            invoice_date: new Date().toISOString().split('T')[0],
            due_date: new_end_date,
            subtotal: renewalValue,
            tax_amount: 0,
            total_amount: renewalValue,
            company_id: companyId,
            items: [{
              description: `AMC renewal — ${amc.contract_number}`,
              quantity: 1, unit_price: renewalValue, tax_rate: 0, amount: renewalValue,
            }],
          }, req.user?.employee_id ?? null);
          invoiceId = invoice.id;
        } catch (invErr) {
          await client.query('ROLLBACK');
          return res.status(invErr.status || 500).json({ error: invErr.message, code: invErr.code });
        }
      }
    }

    await client.query(
      `INSERT INTO amc_renewal_history (amc_contract_id, renewed_by, old_end_date, new_end_date, new_value, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [amc.id, req.user?.name || req.user?.email || 'System', amc.end_date, new_end_date, renewalValue, notes || null, companyId]
    );
    const nextRenewal = new Date(new_end_date);
    nextRenewal.setDate(nextRenewal.getDate() - 30);
    const { rows: updated } = await client.query(
      `UPDATE amc_contracts
       SET end_date=$1, contract_value=COALESCE($2,contract_value),
           status='active', renewal_count=COALESCE(renewal_count,0)+1,
           next_renewal_date=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [new_end_date, new_value || null, nextRenewal.toISOString().slice(0, 10), amc.id]
    );
    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: amc.id, recordType: 'amc_contract', action: 'renew', newData: { old_end_date: amc.end_date, new_end_date }, req });
    res.json({ success: true, contract: updated[0], invoice_id: invoiceId });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ── AMC renewal history ───────────────────────────────────────────────────────
router.get('/amc-contracts/:id/renewals', requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM amc_renewal_history
       WHERE amc_contract_id=$1 AND ($2::int IS NULL OR company_id=$2)
       ORDER BY created_at DESC`,
      [req.params.id, companyId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AMC export CSV ────────────────────────────────────────────────────────────
router.get('/amc-contracts/export/csv', requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT ac.contract_number, ac.serial_number, ac.start_date, ac.end_date,
              ac.contract_value, ac.billing_frequency, ac.payment_terms, ac.status,
              ac.sla_response_hours, ac.preventive_visits_per_year, ac.coverage_notes,
              ac.next_renewal_date, ac.renewal_count, ac.last_invoice_date,
              li.lifecycle_number, so.order_number
       FROM amc_contracts ac
       LEFT JOIN lifecycle_instances li ON li.id=ac.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id=ac.sales_order_id
       WHERE ($1::int IS NULL OR ac.company_id=$1) AND ac.deleted_at IS NULL
       ORDER BY ac.created_at DESC`,
      [companyId]
    );
    const cols = ['contract_number','serial_number','start_date','end_date','contract_value',
      'billing_frequency','payment_terms','status','sla_response_hours','preventive_visits_per_year',
      'coverage_notes','next_renewal_date','renewal_count','last_invoice_date','lifecycle_number','order_number'];
    // Shared writer: same conditional quoting, plus neutralisation of values a
    // spreadsheet would evaluate as formulas. See shared/csv.js.
    const csv = toCsvObjects(rows, { columns: cols, minimal: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="amc_contracts_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commissioning sign-off ────────────────────────────────────────────────────
router.put('/commissioning/:id/signoff', requireCompanyScope, requirePermission('servicedesk', 'edit'), captureBefore('commissioning_reports'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { serial_number, customer_signature, witness_name, witness_signature, iec_standard, ambient_temp_c, test_voltage_kv } = req.body;
    const { rows } = await pool.query(
      `UPDATE commissioning_reports
       SET serial_number       = COALESCE($1, serial_number),
           customer_signature  = COALESCE($2, customer_signature),
           witness_name        = COALESCE($3, witness_name),
           witness_signature   = COALESCE($4, witness_signature),
           iec_standard        = COALESCE($5, iec_standard),
           ambient_temp_c      = COALESCE($6, ambient_temp_c),
           test_voltage_kv     = COALESCE($7, test_voltage_kv),
           status = CASE WHEN status='in_progress' THEN 'completed' ELSE status END,
           updated_at = NOW()
       WHERE id=$8 AND ($9::int IS NULL OR company_id=$9) RETURNING *`,
      [serial_number||null, customer_signature||null, witness_name||null, witness_signature||null,
       iec_standard||null, ambient_temp_c||null, test_voltage_kv||null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Commissioning report not found' });
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: req.params.id, recordType: 'commissioning_report', action: 'sign_off', newData: rows[0], req });

    // Auto-upload commissioning report to Drive under customer folder
    if (drive.isDriveConfigured() && rows[0].sales_order_id) {
      pool.query(
        `SELECT so.customer_name FROM sales_orders so WHERE so.id=$1`,
        [rows[0].sales_order_id]
      ).then(async soRes => {
        const customerName = soRes.rows[0]?.customer_name;
        if (!customerName) return;
        const driveRes = await drive.uploadJsonRecord({
          data:         rows[0],
          fileName:     `Commissioning-Report-${rows[0].id}-${Date.now()}.json`,
          customerName,
          docType:      drive.DOC_TYPES.COMMISSIONING_REPORT,
          companyId:    cid(req),
        });
        await pool.query(
          `UPDATE commissioning_reports SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
          [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
        );
      }).catch(e => console.error('[commissioning/signoff/drive]', e.message));
    }

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Warranty Registrations ────────────────────────────────────────────────────
router.get('/warranty', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, expiring_days } = req.query;
    let q = `SELECT * FROM warranty_registrations WHERE ($1::int IS NULL OR company_id=$1)`;
    const params = [companyId];
    if (status) { params.push(status); q += ` AND status=$${params.length}`; }
    if (expiring_days) {
      const days = parseInt(expiring_days) || 30;
      params.push(days);
      q += ` AND warranty_end <= NOW() + ($${params.length} || ' days')::INTERVAL AND warranty_end >= NOW()`;
    }
    q += ' ORDER BY warranty_end ASC';
    const now = new Date();
    const { rows } = await pool.query(q, params);
    res.json(rows.map(r => ({
      ...r,
      is_expired    : r.warranty_end && new Date(r.warranty_end) < now,
      days_remaining: r.warranty_end ? Math.ceil((new Date(r.warranty_end) - now) / 86400000) : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/warranty/:id', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT wr.*, wr.warranty_end < NOW() AS is_expired
       FROM warranty_registrations wr
       WHERE wr.id=$1 AND ($2::int IS NULL OR wr.company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Warranty not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/warranty', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { serial_number, product_name, customer_name, customer_id, site_id,
            warranty_start, warranty_end, warranty_type, coverage_parts, coverage_labour,
            coverage_travel, notes, lifecycle_instance_id, sales_order_id, asset_id } = req.body;
    if (!serial_number || !warranty_start || !warranty_end) {
      return res.status(422).json({ error: 'serial_number, warranty_start, warranty_end are required' });
    }
    const foreign = await foreignLink(req, [
      ['lifecycle_instances', lifecycle_instance_id, 'Lifecycle'],
      ['sales_orders', sales_order_id, 'Sales order'],
      ['assets_register', asset_id, 'Asset'],
    ]);
    if (foreign) return res.status(400).json({ error: foreign });
    const warrantyNumber = await nextWarrantyNumber();
    const { rows } = await pool.query(
      `INSERT INTO warranty_registrations
         (warranty_number, asset_id, sales_order_id, lifecycle_instance_id, serial_number,
          product_name, customer_name, customer_id, site_id, warranty_start, warranty_end,
          warranty_type, coverage_parts, coverage_labour, coverage_travel, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [warrantyNumber, asset_id||null, sales_order_id||null, lifecycle_instance_id||null,
       serial_number, product_name||serial_number, customer_name||'Unknown',
       customer_id||null, site_id||null, warranty_start, warranty_end,
       warranty_type||'Comprehensive', coverage_parts !== false, coverage_labour !== false,
       coverage_travel === true, notes||null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: rows[0].id, recordType: 'warranty_registration', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/warranty/:id', requireCompanyScope, requirePermission('servicedesk', 'edit'), captureBefore('warranty_registrations'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { warranty_end, warranty_type, coverage_parts, coverage_labour, coverage_travel, notes, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE warranty_registrations
       SET warranty_end    = COALESCE($1, warranty_end),
           warranty_type   = COALESCE($2, warranty_type),
           coverage_parts  = COALESCE($3, coverage_parts),
           coverage_labour = COALESCE($4, coverage_labour),
           coverage_travel = COALESCE($5, coverage_travel),
           notes           = COALESCE($6, notes),
           status          = COALESCE($7, status),
           updated_at      = NOW()
       WHERE id=$8 AND ($9::int IS NULL OR company_id=$9) RETURNING *`,
      [warranty_end||null, warranty_type||null,
       coverage_parts != null ? coverage_parts : null,
       coverage_labour != null ? coverage_labour : null,
       coverage_travel != null ? coverage_travel : null,
       notes||null, status||null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Warranty not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/warranty/:id', requireCompanyScope, requirePermission('servicedesk', 'delete'), captureBefore('warranty_registrations'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM warranty_registrations WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Warranty not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Warranty Claims ───────────────────────────────────────────────────────────
router.get('/warranty-claims', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, warranty_registration_id } = req.query;
    let q = `SELECT wc.*, wr.serial_number AS warranty_serial, wr.product_name
             FROM warranty_claims wc
             LEFT JOIN warranty_registrations wr ON wr.id=wc.warranty_registration_id
             WHERE ($1::int IS NULL OR wc.company_id=$1)`;
    const params = [companyId];
    if (status) { params.push(status); q += ` AND wc.status=$${params.length}`; }
    if (warranty_registration_id) { params.push(warranty_registration_id); q += ` AND wc.warranty_registration_id=$${params.length}`; }
    q += ' ORDER BY wc.created_at DESC';
    res.json((await pool.query(q, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/warranty-claims', requireCompanyScope, requirePermission('servicedesk', 'add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { warranty_registration_id, ticket_id, serial_number, issue_description,
            failure_mode, parts_replaced, labour_hours, claim_value } = req.body;
    if (!issue_description) return res.status(422).json({ error: 'issue_description is required' });
    const foreign = await foreignLink(req, [
      ['warranty_registrations', warranty_registration_id, 'Warranty'],
      ['support_tickets', ticket_id, 'Ticket'],
    ]);
    if (foreign) return res.status(400).json({ error: foreign });
    const claimNumber = await nextWarrantyClaimNumber();
    const { rows } = await pool.query(
      `INSERT INTO warranty_claims
         (claim_number, warranty_registration_id, ticket_id, serial_number, issue_description,
          failure_mode, parts_replaced, labour_hours, claim_value, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [claimNumber, warranty_registration_id||null, ticket_id||null, serial_number||null,
       issue_description, failure_mode||null, JSON.stringify(parts_replaced||[]),
       labour_hours||0, claim_value||0, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'lifecycle', recordId: rows[0].id, recordType: 'warranty_claim', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/warranty-claims/:id', requireCompanyScope, requirePermission('servicedesk', 'edit'), captureBefore('warranty_claims'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, resolution_notes } = req.body;
    // Deciding a claim is an approval: it needs servicedesk:approve, and the
    // approver recorded is the logged-in user, never body.approved_by.
    const deciding = ['approved', 'rejected'].includes(status);
    let approved_by = null;
    if (deciding) {
      const perm = await permissionFor(req, 'servicedesk');
      if (!perm?.can_approve) {
        return res.status(403).json({ error: 'Approving or rejecting a warranty claim needs servicedesk approve permission' });
      }
      const { rows: me } = await pool.query(`SELECT name, email FROM users WHERE id = $1`, [actor(req).id]);
      approved_by = me[0]?.name || me[0]?.email || String(actor(req).id);
    }
    const { rows } = await pool.query(
      `UPDATE warranty_claims
       SET status           = COALESCE($1, status),
           resolution_notes = COALESCE($2, resolution_notes),
           approved_by      = COALESCE($3, approved_by),
           approved_at = CASE WHEN $1='approved' AND approved_at IS NULL THEN NOW() ELSE approved_at END,
           closed_at   = CASE WHEN $1 IN ('closed','rejected') AND closed_at IS NULL THEN NOW() ELSE closed_at END,
           updated_at  = NOW()
       WHERE id=$4 AND ($5::int IS NULL OR company_id=$5) RETURNING *`,
      [status||null, resolution_notes||null, approved_by||null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Claim not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/commissioning', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { lifecycle_instance_id, status } = req.query;
    const params = [companyId];
    const where = ['($1::int IS NULL OR cr.company_id = $1)'];
    if (lifecycle_instance_id) { params.push(lifecycle_instance_id); where.push(`cr.lifecycle_instance_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`cr.status = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT cr.*,
         li.lifecycle_number,
         so.order_number
       FROM commissioning_reports cr
       LEFT JOIN lifecycle_instances li ON li.id = cr.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id = cr.sales_order_id
       WHERE ${where.join(' AND ')}
       ORDER BY cr.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/commissioning/:id', requireCompanyScope, requirePermission('servicedesk', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT cr.*,
         li.lifecycle_number,
         so.order_number
       FROM commissioning_reports cr
       LEFT JOIN lifecycle_instances li ON li.id = cr.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id = cr.sales_order_id
       WHERE cr.id = $1 AND ($2::int IS NULL OR cr.company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Commissioning report not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
