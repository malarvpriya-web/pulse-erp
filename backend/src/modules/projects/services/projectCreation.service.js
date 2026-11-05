// backend/src/modules/projects/services/projectCreation.service.js
//
// The one place a delivery project is created or reused, together with its
// lifecycle (P1_PROJECT_LIFECYCLE_PLAN.md Phase 2). Every creator goes through
// ensureProject():
//
//   C1 opportunity moved to Won (auto)      ┐ convertOpportunityToProject()
//   C2 Convert to Project                    ┘
//   C3 sales order confirmed                   sales.routes autoBootstrapLifecycleOnOrderAccept()
//   C4 /lifecycle/instances/from-sales-order, /auto-bootstrap
//   C5 POST /lifecycle/instances
//   C6 POST /projects/projects
//
// Rules:
//  - A project comes from a WON opportunity, a CONFIRMED sales order, or a
//    manual create. One live project per opportunity; an order's project is
//    found again through its opportunity or its order number.
//  - Company ownership is taken from the business records (order, then
//    opportunity, then a named project), never from the request. Only a global
//    super admin creating a project from nothing names a company, and it must exist.
//  - Linked people and masters (project manager, product line) must be in that company.
//  - Exactly one open lifecycle per project: an existing one is reused (an
//    order is attached to it when it has none), never a second one started.
//  - Runs inside the caller's transaction and throws on any failure, so the
//    caller's ROLLBACK leaves nothing half-created. Rows are locked in a fixed
//    order — sales order, opportunity, project, lifecycle — so two creators for
//    the same opportunity or order serialise instead of both inserting, and
//    cannot deadlock each other.
//
// Database uniqueness is Phase 3; until then the row locks above are what
// prevent duplicates, so every caller must use this service.

import { nextProjectCode, nextLifecycleNumber, isSequenceProjectCode } from '../../../shared/docNumber.js';
import projectRepository from '../repositories/project.repository.js';

/** Order statuses that count as confirmed for order-driven set-up. */
export const CONFIRMED_ORDER_STATUSES = ['accepted', 'confirmed', 'won', 'approved', 'released'];

export const isConfirmedOrder = (so) => CONFIRMED_ORDER_STATUSES.includes(String(so?.order_status || '').toLowerCase());

/** A refusal the caller should return as-is: HTTP status, machine code, message. */
export class ProjectSetupError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ProjectSetupError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** The JSON body for a ProjectSetupError. */
export const setupErrorBody = (e) => ({ error: e.message, code: e.code, ...e.extra });

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const asId = (v) => (blank(v) ? null : (parseInt(v, 10) || 0));

// lifecycle_instances.customer_id holds an accounts.id (INTEGER — what the
// opportunity conversion writes), but sales_orders.customer_id is a parties
// UUID. Resolve the CRM account behind the order's party; NULL when there is
// none (the order still reaches the customer through sales_order_id).
export async function lifecycleCustomerIdForOrder(client, salesOrder) {
  if (!salesOrder?.customer_id) return null;
  const { rows } = await client.query(
    `SELECT id FROM accounts
      WHERE party_id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2)
      ORDER BY id LIMIT 1`,
    [salesOrder.customer_id, salesOrder.company_id ?? null]
  );
  return rows[0]?.id ?? null;
}

/**
 * Project manager and product line must belong to the project's company.
 * Returns an error message or null. Only the keys present are checked.
 */
export async function projectReferenceError(db, companyId, { project_manager_id, product_line_id } = {}) {
  if (!blank(project_manager_id)) {
    const { rows } = await db.query(
      `SELECT 1 FROM employees WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2`,
      [asId(project_manager_id), companyId]);
    if (!rows.length) return 'Project manager not found in your company';
  }
  if (!blank(product_line_id)) {
    const { rows } = await db.query(
      `SELECT 1 FROM product_lines WHERE id = $1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2`,
      [asId(product_line_id), companyId]);
    if (!rows.length) return 'Product line not found in your company';
  }
  return null;
}

/**
 * Create or reuse the project (and its single open lifecycle) for an
 * opportunity, a sales order, a named project, or a manual create.
 *
 * @param {import('pg').PoolClient} client  inside an open transaction
 * @param {object}  o
 * @param {number=} o.opportunityId   explicit opportunity origin — must be Won
 * @param {number=} o.salesOrderId    order origin — must be confirmed
 * @param {number=} o.projectId       attach to this existing project
 * @param {number|null} o.scopeCompanyId  the caller's company; null = global caller
 * @param {number=} o.requestedCompanyId  global caller only, when no record decides
 * @param {object=} o.attrs           manual project fields (POST /projects body)
 * @param {object=} o.actor           { userId, employeeId, name }
 * @param {'reuse'|'conflict'} [o.onExistingProject='reuse']  'conflict' = 409 when the opportunity already has a project
 * @param {boolean} [o.conflictIfLifecycleOpen=false]  409 when a lifecycle is already open (manual lifecycle create)
 * @param {object=} o.lifecycleLinks  { production_order_id, customer_id } for a new lifecycle
 * @param {string=} o.lifecycleNotes
 * @returns {Promise<{ project: object|null, lifecycle: object, projectCreated: boolean,
 *                     lifecycleCreated: boolean, lifecycleExisted: boolean }>}
 *   lifecycleExisted: the order already had its own open lifecycle (nothing was changed).
 */
export async function ensureProject(client, o = {}) {
  let step = 'sales order';
  try {
    return await run(client, o, (s) => { step = s; });
  } catch (e) {
    if (!(e instanceof ProjectSetupError) && !e.step) e.step = step;
    throw e;
  }
}

async function run(client, {
  opportunityId = null, salesOrderId = null, projectId = null,
  scopeCompanyId = null, requestedCompanyId = null,
  attrs = {}, actor = {}, onExistingProject = 'reuse', conflictIfLifecycleOpen = false,
  lifecycleLinks = {}, lifecycleNotes = null,
} = {}, setStep) {
  // ── 1. Sales order (locked first) ────────────────────────────────────────
  setStep('sales order');
  let so = null;
  if (!blank(salesOrderId)) {
    const { rows } = await client.query(
      `SELECT * FROM sales_orders
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [asId(salesOrderId), scopeCompanyId]);
    so = rows[0];
    if (!so) throw new ProjectSetupError(404, 'SALES_ORDER_NOT_FOUND', 'Sales order not found');
    if (!isConfirmedOrder(so)) {
      throw new ProjectSetupError(422, 'SALES_ORDER_NOT_CONFIRMED',
        `Sales order status '${so.order_status}' is not confirmed — project set-up needs a confirmed order`,
        { required_statuses: CONFIRMED_ORDER_STATUSES });
    }
  }
  let companyId = so?.company_id ?? null;

  // ── 2. Opportunity (locked second) ───────────────────────────────────────
  setStep('opportunity');
  let opp = null;
  const lockOpportunity = async (id, company) => (await client.query(
    `SELECT o.*, COALESCE(a.name, a.account_name) AS customer_name
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.id = $1 AND o.deleted_at IS NULL AND ($2::int IS NULL OR o.company_id = $2)
      FOR UPDATE OF o`,
    [id, company])).rows[0] || null;

  if (!blank(opportunityId)) {
    opp = await lockOpportunity(asId(opportunityId), companyId ?? scopeCompanyId);
    if (!opp) throw new ProjectSetupError(404, 'OPPORTUNITY_NOT_FOUND', 'Opportunity not found');
    if (String(opp.stage || '').toLowerCase() !== 'won') {
      throw new ProjectSetupError(422, 'OPPORTUNITY_NOT_WON',
        `Opportunity is at '${opp.stage}' — only a Won opportunity becomes a delivery project`);
    }
  } else if (so?.quotation_id) {
    // The order's own opportunity, through its quotation, in the order's company.
    // A mis-linked quotation of another company is ignored, not followed.
    const { rows } = await client.query(
      `SELECT opportunity_id FROM quotations WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2`,
      [so.quotation_id, so.company_id ?? null]);
    if (rows[0]?.opportunity_id) opp = await lockOpportunity(rows[0].opportunity_id, so.company_id ?? null);
  }
  companyId = companyId ?? opp?.company_id ?? null;

  // An order that already has its own open lifecycle is already set up.
  if (so) {
    const { rows } = await client.query(
      `SELECT * FROM lifecycle_instances
        WHERE sales_order_id = $1 AND status IN ('active','on_hold')
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [so.id]);
    if (rows[0]) {
      if (conflictIfLifecycleOpen) {
        throw new ProjectSetupError(409, 'LIFECYCLE_EXISTS',
          `This sales order already has an active lifecycle (${rows[0].lifecycle_number})`, { lifecycle_id: rows[0].id });
      }
      const project = rows[0].project_id
        ? (await client.query(`SELECT * FROM projects WHERE id = $1`, [rows[0].project_id])).rows[0] || null
        : null;
      return { project, lifecycle: rows[0], projectCreated: false, lifecycleCreated: false, lifecycleExisted: true };
    }
  }

  // ── 3. Named project (locked third) ──────────────────────────────────────
  setStep('project');
  let project = null;
  if (!blank(projectId)) {
    const { rows } = await client.query(
      `SELECT * FROM projects
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [asId(projectId), companyId ?? scopeCompanyId]);
    project = rows[0] || null;
    if (!project) throw new ProjectSetupError(400, 'PROJECT_NOT_FOUND', 'Project not found in your company');
    companyId = companyId ?? project.company_id ?? null;
  }

  // ── 4. Company ───────────────────────────────────────────────────────────
  const derived = companyId != null;
  companyId = companyId ?? scopeCompanyId;
  if (scopeCompanyId == null && !blank(requestedCompanyId)) {
    // A global caller may name the company only where no record decides it,
    // and may not contradict a record that does.
    const requested = asId(requestedCompanyId);
    if (derived && requested !== companyId) {
      throw new ProjectSetupError(400, 'COMPANY_MISMATCH', 'company_id does not match the company of the linked records');
    }
    if (!derived) {
      const { rows } = await client.query(`SELECT 1 FROM companies WHERE id = $1`, [requested]);
      if (!rows.length) throw new ProjectSetupError(400, 'COMPANY_NOT_FOUND', 'Company not found');
      companyId = requested;
    }
  }
  if (companyId == null) {
    throw new ProjectSetupError(400, 'COMPANY_REQUIRED', 'A company is required: link an opportunity or sales order, or choose a company');
  }

  const refError = await projectReferenceError(client, companyId, attrs);
  if (refError) throw new ProjectSetupError(400, 'INVALID_REFERENCE', refError);

  // ── 5. Find or create the project ────────────────────────────────────────
  let projectCreated = false;
  // An order already linked to a live project of its company stays on it
  // (sales_orders.project_id, migration 20261014000002).
  if (!project && so?.project_id) {
    const { rows } = await client.query(
      `SELECT * FROM projects
        WHERE id = $1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2
        FOR UPDATE`,
      [so.project_id, companyId]);
    project = rows[0] || null;
  }
  if (!project && opp) {
    const { rows } = await client.query(
      `SELECT * FROM projects
        WHERE opportunity_id = $1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [opp.id, companyId]);
    project = rows[0] || null;
    if (project && onExistingProject === 'conflict') {
      throw new ProjectSetupError(409, 'PROJECT_EXISTS',
        `Opportunity already has project ${project.project_code}`, { project_id: project.id });
    }
  }
  if (!project && so) {
    const { rows } = await client.query(
      `SELECT * FROM projects
        WHERE sales_order_ref = $1 AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [so.order_number, companyId]);
    project = rows[0] || null;
  }

  if (!project) {
    const createdBy = actor.employeeId ?? (actor.userId
      ? (await client.query(`SELECT employee_id FROM users WHERE id = $1`, [actor.userId])).rows[0]?.employee_id ?? null
      : null);
    // A custom code is kept; blank or one in the sequence's own format (the
    // form's preview) is assigned here.
    const project_code = blank(attrs.project_code) || isSequenceProjectCode(attrs.project_code)
      ? await nextProjectCode(client)
      : String(attrs.project_code).trim();
    const fromOrder = so ? {
      project_name: `Project for ${so.customer_name || 'Customer'} — ${so.order_number}`,
      customer_name: so.customer_name || null,
      sales_order_ref: so.order_number || String(so.id),
      project_type: 'EPC',
    } : {};
    const fromOpportunity = opp && !so ? {
      project_name: opp.opportunity_name,
      customer_name: opp.customer_name || null,
      budget_amount: opp.expected_value || 0,
      description: `Converted from opportunity ${opp.opportunity_number || opp.id}`,
    } : {};
    project = await projectRepository.create({
      ...fromOpportunity,
      ...fromOrder,
      ...attrs,
      sales_order_ref: fromOrder.sales_order_ref ?? null,
      status: attrs.status || 'planning',
      project_code,
      opportunity_id: opp?.id ?? null,
      company_id: companyId,
      created_by: createdBy,
    }, client);
    projectCreated = true;
  } else if (so && !project.sales_order_ref) {
    // The order's number on the project it joined, so the order can be found
    // from the project (Order History, and the Phase 3 backfill).
    project = (await client.query(
      `UPDATE projects SET sales_order_ref = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [project.id, so.order_number])).rows[0];
  }

  // The order's project link. An order belongs to at most one project: a link
  // to a different live project is refused, never reassigned. A link to a
  // project that is gone or deleted (not found above) is replaced.
  if (so && so.project_id !== project.id) {
    const { rows: other } = so.project_id
      ? await client.query(`SELECT id, project_code FROM projects WHERE id = $1 AND deleted_at IS NULL`, [so.project_id])
      : { rows: [] };
    if (other[0]) {
      throw new ProjectSetupError(409, 'SALES_ORDER_ON_OTHER_PROJECT',
        `Sales order ${so.order_number} already belongs to project ${other[0].project_code}`, { project_id: other[0].id });
    }
    await client.query(`UPDATE sales_orders SET project_id = $2, updated_at = NOW() WHERE id = $1`, [so.id, project.id]);
  }

  // ── 6. The project's single open lifecycle (locked last) ─────────────────
  setStep('lifecycle');
  const { rows: openRows } = await client.query(
    `SELECT * FROM lifecycle_instances
      WHERE project_id = $1 AND status IN ('active','on_hold')
      ORDER BY id LIMIT 1 FOR UPDATE`,
    [project.id]);
  let lifecycle = openRows[0] || null;
  if (lifecycle) {
    if (conflictIfLifecycleOpen) {
      throw new ProjectSetupError(409, 'LIFECYCLE_EXISTS',
        `This project already has an active lifecycle (${lifecycle.lifecycle_number})`, { lifecycle_id: lifecycle.id });
    }
    if (so && lifecycle.sales_order_id == null) {
      lifecycle = (await client.query(
        `UPDATE lifecycle_instances
            SET sales_order_id = $2, customer_id = COALESCE(customer_id, $3), updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [lifecycle.id, so.id, await lifecycleCustomerIdForOrder(client, so)])).rows[0];
    }
    return { project, lifecycle, projectCreated, lifecycleCreated: false, lifecycleExisted: false };
  }

  const customerId = asId(lifecycleLinks.customer_id)
    ?? (so ? await lifecycleCustomerIdForOrder(client, so) : null)
    ?? opp?.account_id ?? null;
  const notes = lifecycleNotes
    || (so ? 'Lifecycle bootstrapped from sales order'
      : opp ? `Created from opportunity: ${opp.opportunity_name}`
        : 'Lifecycle started with the project');
  const { rows: [created] } = await client.query(
    `INSERT INTO lifecycle_instances
       (lifecycle_number, sales_order_id, production_order_id, project_id, customer_id,
        current_stage, status, stage_notes, created_by, created_by_name, company_id)
     VALUES ($1,$2,$3,$4,$5,'order','active',$6,$7,$8,$9)
     RETURNING *`,
    [await nextLifecycleNumber(client), so?.id ?? null, asId(lifecycleLinks.production_order_id), project.id, customerId,
     notes, actor.userId ?? null, actor.name ?? null, project.company_id]);
  await client.query(
    `INSERT INTO lifecycle_stage_history
       (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
     VALUES ($1,NULL,'order','advance',$2,$3,$4,'{}')`,
    [created.id, notes, actor.userId ?? null, actor.name ?? null]);
  return { project, lifecycle: created, projectCreated, lifecycleCreated: true, lifecycleExisted: false };
}
