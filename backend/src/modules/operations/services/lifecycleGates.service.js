// backend/src/modules/operations/services/lifecycleGates.service.js
//
// Evidence for each lifecycle stage gate (P1_PROJECT_LIFECYCLE_PLAN.md Phase 4).
// Which gate guards which stage is in shared/projectStages.js ENTRY_GATES; this
// file only answers "is the evidence there?".
//
// Every check is held to the lifecycle's own company AND to its own project:
// the project, the project's sales orders (sales_orders.project_id plus the
// lifecycle's own order) and the non-cancelled production orders of those.
// Nothing is accepted because a matching record exists somewhere else.
//
// Every check fails CLOSED: a query that errors makes its gate false and is
// reported in `errors`, never silently treated as "nothing open".

const OPEN_ECN_STATUSES = ['draft', 'submitted'];

/** The records a lifecycle's evidence is drawn from. */
export async function lifecycleScope(db, instance) {
  const co = instance.company_id ?? null;
  const { rows: prj } = instance.project_id
    ? await db.query(
      `SELECT id, status, company_id FROM projects WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2`,
      [instance.project_id, co])
    : { rows: [] };
  const project = prj[0] || null;            // null for a historical orphan whose project is gone
  const projectId = project?.id ?? null;
  const { rows: so } = await db.query(
    `SELECT id FROM sales_orders
      WHERE company_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL
        AND (id = $1 OR ($2::int IS NOT NULL AND project_id = $2))
      ORDER BY id`,
    [instance.sales_order_id || 0, projectId, co]);
  const salesOrderIds = so.map(r => r.id);
  const { rows: po } = await db.query(
    `SELECT id, status, bom_id FROM production_orders
      WHERE company_id IS NOT DISTINCT FROM $4 AND status <> 'cancelled'
        AND (id = $1 OR ($2::int IS NOT NULL AND project_id = $2) OR sales_order_id = ANY($3::int[]))
      ORDER BY id`,
    [instance.production_order_id || 0, projectId, salesOrderIds, co]);
  return { co, project, projectId, salesOrderIds, productionOrders: po, productionOrderIds: po.map(r => r.id) };
}

// ── individual gates: each returns { pass, detail } ─────────────────────────

/** Design released: an active BOM for this project, with no ECN still open against it. */
async function engineeringReady(db, s) {
  const { rows } = await db.query(
    `SELECT bh.id, bh.status, ec.status AS ecn_status
       FROM bom_headers bh
       LEFT JOIN engineering_changes ec ON ec.id = bh.ecn_id AND ec.company_id IS NOT DISTINCT FROM bh.company_id
      WHERE bh.company_id IS NOT DISTINCT FROM $1
        AND (($2::int IS NOT NULL AND bh.project_id = $2)
             OR bh.sales_order_id = ANY($3::int[])
             OR bh.id IN (SELECT bom_id FROM production_orders WHERE id = ANY($4::int[]) AND bom_id IS NOT NULL))`,
    [s.co, s.projectId, s.salesOrderIds, s.productionOrderIds]);
  const active = rows.filter(r => r.status === 'active');
  const pendingEcn = active.filter(r => OPEN_ECN_STATUSES.includes(r.ecn_status)).map(r => r.id);
  return {
    pass: active.length > 0 && pendingEcn.length === 0,
    detail: { active_boms: active.map(r => r.id), boms_with_open_ecn: pendingEcn },
  };
}

/** Every BOM component received against THIS project's purchase orders (net of rejections). */
async function bomMaterialsReceived(db, s) {
  const { rows: boms } = await db.query(
    `SELECT DISTINCT id FROM bom_headers
      WHERE company_id IS NOT DISTINCT FROM $1 AND status = 'active'
        AND (id IN (SELECT bom_id FROM production_orders WHERE id = ANY($2::int[]) AND bom_id IS NOT NULL)
             OR ($3::int IS NOT NULL AND project_id = $3) OR sales_order_id = ANY($4::int[]))`,
    [s.co, s.productionOrderIds, s.projectId, s.salesOrderIds]);
  const bomIds = boms.map(r => r.id);
  const { rows: lines } = await db.query(
    `SELECT component_id, SUM(qty)::numeric AS required
       FROM bom_lines WHERE bom_id = ANY($1::int[]) AND component_id IS NOT NULL
      GROUP BY component_id`,
    [bomIds]);
  if (!lines.length) return { pass: true, detail: { boms: bomIds, components: 0, basis: 'no BOM components to procure' } };
  const { rows: got } = await db.query(
    `SELECT gi.item_id, COALESCE(SUM(gi.quantity_received - COALESCE(gi.quantity_rejected, 0)), 0) AS received
       FROM grn_items gi
       JOIN goods_receipt_notes g ON g.id = gi.grn_id
       JOIN purchase_orders po ON po.id = g.po_id
      WHERE gi.item_id = ANY($1::int[])
        AND g.deleted_at IS NULL AND COALESCE(g.status, '') NOT IN ('cancelled', 'rejected')
        AND g.company_id IS NOT DISTINCT FROM $2 AND po.company_id IS NOT DISTINCT FROM $2
        AND (($3::int IS NOT NULL AND po.project_id = $3) OR po.sales_order_id = ANY($4::int[]))
      GROUP BY gi.item_id`,
    [lines.map(l => l.component_id), s.co, s.projectId, s.salesOrderIds]);
  const received = Object.fromEntries(got.map(r => [String(r.item_id), Number(r.received)]));
  const short = lines.filter(l => (received[String(l.component_id)] || 0) < Number(l.required))
    .map(l => ({ component_id: l.component_id, required: Number(l.required), received: received[String(l.component_id)] || 0 }));
  return { pass: short.length === 0, detail: { boms: bomIds, components: lines.length, short } };
}

/** Every (non-cancelled) production order of the project is completed. */
function productionReady(db, s) {
  const open = s.productionOrders.filter(p => p.status !== 'completed').map(p => p.id);
  return { pass: s.productionOrders.length > 0 && open.length === 0,
    detail: { production_orders: s.productionOrderIds, not_completed: open } };
}

/** A passed FAT for every production order of the project. */
async function fatPassed(db, s) {
  if (!s.productionOrderIds.length) return { pass: false, detail: { production_orders: [], reason: 'no production orders' } };
  const { rows } = await db.query(
    `SELECT DISTINCT production_order_id FROM test_runs
      WHERE production_order_id = ANY($1::int[]) AND test_stage = 'FAT' AND overall_result = 'pass'
        AND deleted_at IS NULL AND company_id IS NOT DISTINCT FROM $2`,
    [s.productionOrderIds, s.co]);
  const passed = new Set(rows.map(r => r.production_order_id));
  const missing = s.productionOrderIds.filter(id => !passed.has(id));
  return { pass: missing.length === 0, detail: { production_orders: s.productionOrderIds, without_passed_fat: missing } };
}

async function noOpenNcrs(db, s) {
  const { rows } = await db.query(
    `SELECT id FROM ncr_reports
      WHERE company_id IS NOT DISTINCT FROM $1 AND status NOT IN ('closed')
        AND (($2::int IS NOT NULL AND project_id = $2)
             OR (LOWER(reference_type) = 'production_order' AND reference_id = ANY($3::int[])))`,
    [s.co, s.projectId, s.productionOrderIds]);
  return { pass: rows.length === 0, detail: { open_ncrs: rows.map(r => r.id) } };
}

async function noOpenPunchPoints(db, s) {
  const { rows } = await db.query(
    // Aliased `pp`, not `p`: check-status-literals reads `p.status` as
    // projects.status in any file that queries projects, as this one does.
    `SELECT pp.id FROM punch_points pp
       JOIN test_runs tr ON tr.id = pp.test_run_id
      WHERE pp.status NOT IN ('closed', 'waived') AND pp.company_id IS NOT DISTINCT FROM $1
        AND (tr.production_order_id = ANY($2::int[]) OR ($3::int IS NOT NULL AND tr.project_id = $3))`,
    [s.co, s.productionOrderIds, s.projectId]);
  return { pass: rows.length === 0, detail: { open_punch_points: rows.map(r => r.id) } };
}

/** A delivered shipment for the project's sales order(s). */
async function dispatchRecorded(db, s) {
  if (!s.salesOrderIds.length) {
    // A project with no sales order has no dispatch record type today; how a
    // manual project proves dispatch is an open business decision. Not passed.
    return { pass: false, detail: { reason: 'no sales order: dispatch evidence for manual projects is not defined' } };
  }
  const { rows } = await db.query(
    `SELECT id FROM shipments
      WHERE company_id IS NOT DISTINCT FROM $1 AND status = 'delivered'
        AND ((reference_type = 'sales_order' AND reference_id = ANY($2::int[])) OR sales_order_id = ANY($2::int[]))`,
    [s.co, s.salesOrderIds]);
  return { pass: rows.length > 0, detail: { delivered_shipments: rows.map(r => r.id), sales_orders: s.salesOrderIds } };
}

/** Installation finished and accepted by the customer — every non-cancelled request. */
async function installationAccepted(db, s) {
  const { rows } = await db.query(
    `SELECT id, status, customer_accepted FROM installation_requests
      WHERE company_id IS NOT DISTINCT FROM $1 AND status <> 'cancelled'
        AND (($2::int IS NOT NULL AND project_id = $2) OR sales_order_id = ANY($3::int[]))`,
    [s.co, s.projectId, s.salesOrderIds]);
  const notAccepted = rows.filter(r => !(r.status === 'completed' && r.customer_accepted === true)).map(r => r.id);
  return { pass: rows.length > 0 && notAccepted.length === 0,
    detail: { installation_requests: rows.map(r => r.id), not_completed_or_accepted: notAccepted } };
}

/**
 * Commissioning certified: every non-cancelled commissioning workflow of the
 * project has the customer's sign-off and an issued certificate (status
 * 'completed', reachable only through sign-off then the approver's certificate
 * issue). Legacy commissioning_reports are listed, not counted.
 */
async function commissioningDone(db, s) {
  if (!s.projectId) return { pass: false, detail: { reason: 'no project' } };
  const { rows } = await db.query(
    `SELECT id, status, certificate_issued FROM commissioning_workflows
      WHERE company_id IS NOT DISTINCT FROM $1 AND project_id = $2 AND status <> 'cancelled'`,
    [s.co, s.projectId]);
  const notCertified = rows.filter(r => !(r.status === 'completed' && r.certificate_issued === true)).map(r => r.id);
  return { pass: rows.length > 0 && notCertified.length === 0,
    detail: { commissioning_workflows: rows.map(r => r.id), not_certified: notCertified } };
}

/** SAT passed with the client's sign-off. */
async function satCompleted(db, s) {
  if (!s.projectId) return { pass: false, detail: { reason: 'no project' } };
  const { rows } = await db.query(
    `SELECT id, status, client_signed_off FROM sat_trackers
      WHERE company_id IS NOT DISTINCT FROM $1 AND project_id = $2`,
    [s.co, s.projectId]);
  const signed = rows.filter(r => r.status === 'passed' && r.client_signed_off === true).map(r => r.id);
  return { pass: signed.length > 0, detail: { sat_trackers: rows.map(r => r.id), passed_and_signed_off: signed } };
}

const GATES = {
  engineering_ready:      engineeringReady,
  bom_materials_received: bomMaterialsReceived,
  production_ready:       productionReady,
  fat_passed:             fatPassed,
  no_open_ncrs:           noOpenNcrs,
  no_open_punch_points:   noOpenPunchPoints,
  dispatch_recorded:      dispatchRecorded,
  installation_accepted:  installationAccepted,
  commissioning_done:     commissioningDone,
  sat_completed:          satCompleted,
};

/**
 * Evaluate every gate for a lifecycle.
 * @returns {Promise<{ gates: Record<string, boolean>, details: object, errors: Array<{gate, error}> }>}
 */
export async function checkGates(db, instance) {
  const gates = {}, details = {}, errors = [];
  let scope;
  try {
    scope = await lifecycleScope(db, instance);
  } catch (e) {
    for (const k of Object.keys(GATES)) gates[k] = false;
    return { gates, details, errors: [{ gate: '*', error: e.message }] };
  }
  // Inside a transaction (a pool client), each gate gets a SAVEPOINT so one
  // failed query fails only its own gate instead of aborting the transaction.
  const inTx = typeof db.release === 'function';
  for (const [key, fn] of Object.entries(GATES)) {
    if (inTx) await db.query('SAVEPOINT lifecycle_gate');
    try {
      const { pass, detail } = await fn(db, scope);
      gates[key] = Boolean(pass);
      details[key] = detail;
      if (inTx) await db.query('RELEASE SAVEPOINT lifecycle_gate');
    } catch (e) {
      if (inTx) await db.query('ROLLBACK TO SAVEPOINT lifecycle_gate');
      gates[key] = false;                       // fail closed
      errors.push({ gate: key, error: e.message });
    }
  }
  return { gates, details, errors, scope };
}
