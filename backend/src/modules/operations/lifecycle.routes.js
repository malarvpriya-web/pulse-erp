import { Router } from 'express';
import pool from '../../config/db.js';
import { nextLifecycleNumber, nextProdOrderNumber, nextAmcNumber } from '../../shared/docNumber.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import * as drive from '../../services/googleDrive.service.js';

const router = Router();

const STAGES = ['order', 'design', 'procurement', 'production', 'testing', 'dispatch', 'installation', 'commissioning', 'sat', 'service', 'amc'];

const cid = (req) => req.scope?.company_id ?? null;

const actor = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

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

async function createProductionOrderFromSalesOrder(client, salesOrder, req, opts = {}) {
  const {
    product_name,
    quantity_planned,
    bom_id,
    planned_start_date,
    planned_end_date,
    priority = 'medium',
    notes,
  } = opts;

  const item = await client.query(
    `SELECT item_description, quantity
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
      (production_order_no, sales_order_id, product_name, quantity_planned, priority, planned_start_date, planned_end_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [orderNo, salesOrder.id, selectedProductName, selectedQty, priority, planned_start_date || null, planned_end_date || null, notes || null, a.id]
  );
  const po = createdPo.rows[0];

  if (bom_id) {
    const steps = await client.query(
      `SELECT r.id, r.step_no, r.operation, r.work_centre_id, r.std_time_hrs, w.name AS work_centre_name
       FROM routing_steps r
       LEFT JOIN work_centres w ON w.id = r.work_centre_id
       WHERE r.bom_id = $1
       ORDER BY r.step_no, r.id`,
      [bom_id]
    );
    for (const s of steps.rows) {
      await client.query(
        `INSERT INTO production_operations
          (production_order_id, routing_step_id, step_no, operation, work_centre_id, work_centre_name, std_time_hrs, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [po.id, s.id, s.step_no, s.operation, s.work_centre_id || null, s.work_centre_name || null, s.std_time_hrs || 0]
      );
    }
  }

  return po;
}

async function bootstrapLifecycleForSalesOrder(client, salesOrder, req, opts = {}) {
  const { auto_create_production_order = true } = opts;
  const existing = await client.query(
    `SELECT * FROM lifecycle_instances WHERE sales_order_id=$1 AND status IN ('active','on_hold') ORDER BY created_at DESC LIMIT 1`,
    [salesOrder.id]
  );
  if (existing.rows.length) {
    return { lifecycle: existing.rows[0], production_order: null, existed: true };
  }

  let productionOrder = null;
  if (auto_create_production_order) {
    productionOrder = await createProductionOrderFromSalesOrder(client, salesOrder, req, opts);
  }

  const lifecycleNumber = await nextLifecycleNumber(client);
  const a = actor(req);
  const lcRes = await client.query(
    `INSERT INTO lifecycle_instances
      (lifecycle_number, sales_order_id, production_order_id, project_id, customer_id, current_stage, status, stage_notes, created_by, created_by_name, company_id)
     VALUES ($1,$2,$3,$4,$5,'order','active',$6,$7,$8,$9)
     RETURNING *`,
    [
      lifecycleNumber,
      salesOrder.id,
      productionOrder?.id || null,
      opts?.project_id || null,
      salesOrder.customer_id || null,
      opts?.stage_notes || 'Lifecycle bootstrapped from sales order',
      a.id,
      a.name,
      salesOrder.company_id || null,
    ]
  );
  const lifecycle = lcRes.rows[0];
  await client.query(
    `INSERT INTO lifecycle_stage_history
      (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
     VALUES ($1,NULL,'order','advance',$2,$3,$4,'{}')`,
    [lifecycle.id, 'Lifecycle initiated from sales order', a.id, a.name]
  );
  return { lifecycle, production_order: productionOrder, existed: false };
}

function nextStage(current) {
  const i = STAGES.indexOf(current);
  if (i < 0 || i === STAGES.length - 1) return null;
  return STAGES[i + 1];
}

async function checkGates(client, instance) {
  const gates = {
    engineering_ready: false,
    bom_materials_received: false,
    production_ready: false,
    fat_passed: false,
    dispatch_recorded: false,
    commissioning_done: false,
    sat_completed: false,
    amc_created: false,
  };

  // Design gate: at least one approved engineering change or BOM marked active for order product
  const eng = await client.query(
    `SELECT
      EXISTS(SELECT 1 FROM engineering_changes ec WHERE ec.status='approved') AS has_approved_ecn,
      EXISTS(
        SELECT 1 FROM bom_headers bh
        JOIN sales_order_items soi ON soi.order_id = $1
        WHERE bh.product_name ILIKE '%' || soi.item_description || '%' AND bh.status='active'
      ) AS has_active_bom`,
    [instance.sales_order_id || 0]
  );
  gates.engineering_ready = Boolean(eng.rows[0]?.has_approved_ecn || eng.rows[0]?.has_active_bom);

  // Procurement → Production gate: all BOM materials must be received via GRN
  // We check that every bom_line component for the lifecycle's production order
  // has at least one grn_item with received quantity ≥ required quantity.
  // Falls back to true if there's no production order or no BOM lines (don't block).
  if (instance.production_order_id) {
    const poRes = await client.query(
      `SELECT bom_id FROM production_orders WHERE id = $1`, [instance.production_order_id]
    );
    const bomId = poRes.rows[0]?.bom_id;
    if (bomId) {
      const bomLines = await client.query(
        `SELECT bl.component_id, bl.qty
         FROM bom_lines bl
         WHERE bl.bom_id = $1 AND bl.component_id IS NOT NULL`,
        [bomId]
      );
      if (bomLines.rows.length > 0) {
        // For each BOM component, check total received quantity via GRN items
        const componentIds = bomLines.rows.map(r => r.component_id);
        const grnReceived = await client.query(
          `SELECT gi.item_id, COALESCE(SUM(gi.quantity_received - COALESCE(gi.quantity_rejected, 0)), 0) AS received_qty
           FROM grn_items gi
           JOIN goods_receipt_notes grn ON grn.id = gi.grn_id
           WHERE gi.item_id = ANY($1::int[])
             AND grn.deleted_at IS NULL
           GROUP BY gi.item_id`,
          [componentIds]
        );
        const receivedMap = Object.fromEntries(grnReceived.rows.map(r => [String(r.item_id), parseFloat(r.received_qty)]));
        gates.bom_materials_received = bomLines.rows.every(line => {
          const received = receivedMap[String(line.component_id)] || 0;
          return received >= parseFloat(line.qty);
        });
      } else {
        gates.bom_materials_received = true; // No BOM lines — don't block
      }
    } else {
      gates.bom_materials_received = true; // No BOM assigned — don't block
    }
  } else {
    gates.bom_materials_received = true; // No production order — don't block
  }

  // Production gate
  if (instance.production_order_id) {
    const po = await client.query(`SELECT status FROM production_orders WHERE id=$1`, [instance.production_order_id]);
    gates.production_ready = po.rows[0]?.status === 'completed';
  }

  // FAT gate
  if (instance.production_order_id) {
    const fat = await client.query(
      `SELECT COUNT(*)::INT AS n
       FROM test_runs
       WHERE production_order_id=$1 AND test_stage='FAT' AND overall_result='pass'`,
      [instance.production_order_id]
    );
    gates.fat_passed = Number(fat.rows[0]?.n || 0) > 0;
  }

  // Quality gate — check open NCRs and open punch points on the production order
  if (instance.production_order_id) {
    const openNcr = await client.query(
      `SELECT COUNT(*)::INT AS n FROM ncr_reports
       WHERE reference_type='production_order' AND reference_id=$1 AND status NOT IN ('closed')`,
      [instance.production_order_id]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    gates.no_open_ncrs = Number(openNcr.rows[0]?.n || 0) === 0;

    const openPunch = await client.query(
      `SELECT COUNT(*)::INT AS n FROM punch_points p
       JOIN test_runs tr ON tr.id = p.test_run_id
       WHERE tr.production_order_id=$1 AND p.status NOT IN ('closed','waived')`,
      [instance.production_order_id]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    gates.no_open_punch_points = Number(openPunch.rows[0]?.n || 0) === 0;
  } else {
    gates.no_open_ncrs = true;
    gates.no_open_punch_points = true;
  }

  // Dispatch gate
  if (instance.sales_order_id) {
    const shp = await client.query(
      `SELECT COUNT(*)::INT AS n FROM shipments WHERE reference_type='sales_order' AND reference_id=$1 AND status='delivered'`,
      [instance.sales_order_id]
    );
    gates.dispatch_recorded = Number(shp.rows[0]?.n || 0) > 0;
  }

  // Commissioning gate
  const comm = await client.query(
    `SELECT COUNT(*)::INT AS n FROM commissioning_reports WHERE lifecycle_instance_id=$1 AND status='completed'`,
    [instance.id]
  );
  gates.commissioning_done = Number(comm.rows[0]?.n || 0) > 0;

  // SAT gate — check project SAT tracker (new) or fall back to commissioning_done
  if (instance.project_id) {
    const sat = await client.query(
      `SELECT COUNT(*)::INT AS n FROM sat_trackers WHERE project_id=$1 AND status='passed'`,
      [instance.project_id]
    ).catch(() => ({ rows: [{ n: 0 }] }));
    gates.sat_completed = Number(sat.rows[0]?.n || 0) > 0 || gates.commissioning_done;
  } else {
    gates.sat_completed = gates.commissioning_done;
  }

  // AMC gate
  const amc = await client.query(
    `SELECT COUNT(*)::INT AS n FROM amc_contracts WHERE lifecycle_instance_id=$1 AND status='active'`,
    [instance.id]
  );
  gates.amc_created = Number(amc.rows[0]?.n || 0) > 0;

  return gates;
}

function gateAllowsTransition(from, to, g) {
  if (from === 'order' && to === 'design') return true;
  if (from === 'design' && to === 'procurement') return g.engineering_ready;
  if (from === 'procurement' && to === 'production') return g.bom_materials_received;
  if (from === 'production' && to === 'testing') return g.production_ready;
  if (from === 'testing' && to === 'dispatch') return g.fat_passed && g.no_open_ncrs && g.no_open_punch_points;
  if (from === 'dispatch' && to === 'installation') return g.dispatch_recorded;
  if (from === 'installation' && to === 'commissioning') return g.dispatch_recorded;
  if (from === 'commissioning' && to === 'sat') return g.commissioning_done;
  if (from === 'sat' && to === 'service') return g.sat_completed;
  if (from === 'service' && to === 'amc') return g.amc_created;
  // Legacy direct path: installation → service (for non-industrial projects)
  if (from === 'installation' && to === 'service') return g.commissioning_done;
  return false;
}

router.get('/instances', async (req, res) => {
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
       LEFT JOIN sales_orders so ON so.id = li.sales_order_id
       LEFT JOIN production_orders po ON po.id = li.production_order_id
       WHERE ${where.join(' AND ')}
       ORDER BY li.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/instances', async (req, res) => {
  try {
    const { sales_order_id, production_order_id, project_id, customer_id, stage_notes } = req.body;
    const companyId = cid(req);
    const lifecycleNumber = await nextLifecycleNumber();
    const a = actor(req);
    const { rows } = await pool.query(
      `INSERT INTO lifecycle_instances
        (lifecycle_number, sales_order_id, production_order_id, project_id, customer_id, current_stage, status, stage_notes, created_by, created_by_name, company_id)
       VALUES ($1,$2,$3,$4,$5,'order','active',$6,$7,$8,$9)
       RETURNING *`,
      [lifecycleNumber, sales_order_id || null, production_order_id || null, project_id || null, customer_id || null, stage_notes || null, a.id, a.name, companyId]
    );
    await pool.query(
      `INSERT INTO lifecycle_stage_history
        (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
       VALUES ($1,NULL,'order','advance',$2,$3,$4,'{}')`,
      [rows[0].id, 'Lifecycle initiated', a.id, a.name]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/instances/from-sales-order/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { auto_create_production_order = true } = req.body || {};
    await client.query('BEGIN');

    const soRes = await client.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!soRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sales order not found' });
    }
    const so = soRes.rows[0];

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
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/instances/auto-bootstrap/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const soRes = await client.query(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!soRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sales order not found' });
    }
    const so = soRes.rows[0];
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
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/instances/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM lifecycle_instances WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lifecycle instance not found' });
    const history = await pool.query(
      `SELECT * FROM lifecycle_stage_history WHERE lifecycle_instance_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    const gates = await checkGates(pool, rows[0]);
    res.json({ ...rows[0], gates, history: history.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/instances/:id/advance', async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    const companyId = cid(req);
    await client.query('BEGIN');
    const instanceRes = await client.query(
      `SELECT * FROM lifecycle_instances WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!instanceRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lifecycle instance not found' });
    }
    const instance = instanceRes.rows[0];
    if (instance.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only active lifecycle instances can advance' });
    }
    const to = nextStage(instance.current_stage);
    if (!to) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already at final stage' });
    }
    const gates = await checkGates(client, instance);
    const allowed = gateAllowsTransition(instance.current_stage, to, gates);
    if (!allowed) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Cannot advance ${instance.current_stage} -> ${to}. Required gate not satisfied.`,
        gates,
      });
    }

    const a = actor(req);
    const isFinal = to === 'amc';
    const { rows } = await client.query(
      `UPDATE lifecycle_instances
       SET current_stage=$1,
           stage_started_at=NOW(),
           stage_completed_at=NOW(),
           stage_notes=COALESCE($2, stage_notes),
           status=CASE WHEN $3 THEN 'completed' ELSE status END,
           updated_at=NOW()
       WHERE id=$4
       RETURNING *`,
      [to, remarks || null, isFinal, req.params.id]
    );
    await client.query(
      `INSERT INTO lifecycle_stage_history
        (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
       VALUES ($1,$2,$3,'advance',$4,$5,$6,$7)`,
      [req.params.id, instance.current_stage, to, remarks || null, a.id, a.name, JSON.stringify(gates)]
    );
    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'lifecycle', recordId: req.params.id, recordType: 'lifecycle_instance', action: 'workflow_transition', newData: { from: instance.current_stage, to, gates }, req });
    notifyWorkflowEvent('lifecycle_advanced', { module: `Lifecycle (${instance.current_stage}→${to})`, recordId: req.params.id, submitterUserId: instance.created_by ?? null, comments: `${instance.current_stage} → ${to}` });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/instances/:id/hold', async (req, res) => {
  try {
    const { remarks } = req.body;
    const companyId = cid(req);
    const a = actor(req);
    const { rows } = await pool.query(
      `UPDATE lifecycle_instances
       SET status='on_hold', stage_notes=COALESCE($1, stage_notes), updated_at=NOW()
       WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [remarks || null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lifecycle instance not found' });
    await pool.query(
      `INSERT INTO lifecycle_stage_history
        (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
       VALUES ($1,$2,$2,'hold',$3,$4,$5,'{}')`,
      [req.params.id, rows[0].current_stage, remarks || null, a.id, a.name]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/instances/:id/resume', async (req, res) => {
  try {
    const { remarks } = req.body;
    const companyId = cid(req);
    const a = actor(req);
    const { rows } = await pool.query(
      `UPDATE lifecycle_instances
       SET status='active', stage_notes=COALESCE($1, stage_notes), updated_at=NOW()
       WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [remarks || null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lifecycle instance not found' });
    await pool.query(
      `INSERT INTO lifecycle_stage_history
        (lifecycle_instance_id, from_stage, to_stage, action, remarks, actor_id, actor_name, gate_snapshot)
       VALUES ($1,$2,$2,'resume',$3,$4,$5,'{}')`,
      [req.params.id, rows[0].current_stage, remarks || null, a.id, a.name]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/commissioning', async (req, res) => {
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

router.put('/commissioning/:id', async (req, res) => {
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

router.post('/amc-contracts', async (req, res) => {
  try {
    const {
      lifecycle_instance_id, sales_order_id,
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
        (lifecycle_instance_id, sales_order_id, contract_number, start_date, end_date,
         sla_response_hours, preventive_visits_per_year, status, coverage_notes,
         contract_value, billing_frequency, payment_terms, serial_number, next_renewal_date,
         created_by, created_by_name, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [lifecycle_instance_id||null, sales_order_id||null, contractNo, start_date, end_date,
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

router.get('/amc-contracts', async (req, res) => {
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

router.get('/amc-contracts/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT ac.*,
         li.lifecycle_number,
         so.order_number
       FROM amc_contracts ac
       LEFT JOIN lifecycle_instances li ON li.id = ac.lifecycle_instance_id
       LEFT JOIN sales_orders so ON so.id = ac.sales_order_id
       WHERE ac.id = $1 AND ($2::int IS NULL OR ac.company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'AMC contract not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/amc-contracts/:id', async (req, res) => {
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

router.delete('/amc-contracts/:id', async (req, res) => {
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

router.post('/amc-contracts/:id/generate-visits', async (req, res) => {
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
router.post('/amc-contracts/:id/generate-invoice', async (req, res) => {
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
router.post('/amc-contracts/:id/renew', async (req, res) => {
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
    await client.query(
      `INSERT INTO amc_renewal_history (amc_contract_id, renewed_by, old_end_date, new_end_date, new_value, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [amc.id, req.user?.name || req.user?.email || 'System', amc.end_date, new_end_date, new_value || amc.contract_value, notes || null, companyId]
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
    res.json({ success: true, contract: updated[0] });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ── AMC renewal history ───────────────────────────────────────────────────────
router.get('/amc-contracts/:id/renewals', async (req, res) => {
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
router.get('/amc-contracts/export/csv', async (req, res) => {
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
    const escape = v => { const s = String(v ?? '').replace(/"/g, '""'); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s; };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="amc_contracts_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commissioning sign-off ────────────────────────────────────────────────────
router.put('/commissioning/:id/signoff', async (req, res) => {
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
router.get('/warranty', async (req, res) => {
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

router.get('/warranty/:id', async (req, res) => {
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

router.post('/warranty', async (req, res) => {
  try {
    const companyId = cid(req);
    const { serial_number, product_name, customer_name, customer_id, site_id,
            warranty_start, warranty_end, warranty_type, coverage_parts, coverage_labour,
            coverage_travel, notes, lifecycle_instance_id, sales_order_id, asset_id } = req.body;
    if (!serial_number || !warranty_start || !warranty_end) {
      return res.status(422).json({ error: 'serial_number, warranty_start, warranty_end are required' });
    }
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) FROM warranty_registrations WHERE ($1::int IS NULL OR company_id=$1)`, [companyId]
    );
    const warrantyNumber = `WR-${String(parseInt(cnt[0].count) + 1).padStart(5, '0')}`;
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

router.put('/warranty/:id', async (req, res) => {
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

router.delete('/warranty/:id', async (req, res) => {
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
router.get('/warranty-claims', async (req, res) => {
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

router.post('/warranty-claims', async (req, res) => {
  try {
    const companyId = cid(req);
    const { warranty_registration_id, ticket_id, serial_number, issue_description,
            failure_mode, parts_replaced, labour_hours, claim_value } = req.body;
    if (!issue_description) return res.status(422).json({ error: 'issue_description is required' });
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) FROM warranty_claims WHERE ($1::int IS NULL OR company_id=$1)`, [companyId]
    );
    const claimNumber = `WC-${String(parseInt(cnt[0].count) + 1).padStart(5, '0')}`;
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

router.put('/warranty-claims/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, resolution_notes, approved_by } = req.body;
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

router.get('/commissioning', async (req, res) => {
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

router.get('/commissioning/:id', async (req, res) => {
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
