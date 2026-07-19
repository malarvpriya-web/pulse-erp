/**
 * projectCostRollup.service.js
 *
 * Full project profitability rollup covering ALL cost categories:
 *   material_cost        — raw material issued (rm_issues)
 *   labour_cost          — timesheet hours × billing rate
 *   travel_cost          — approved travel requests
 *   manufacturing_cost   — production order actual/estimated cost
 *   procurement_overhead — purchase order spend (direct procurement)
 *   quality_cost         — quality inspections + NCR resolution
 *   installation_cost    — field visit labour + parts (service_tickets type=installation)
 *   commissioning_cost   — commissioning report cost fields
 *   service_cost         — support tickets (type=service / break-fix)
 *   amc_revenue          — AMC contract value collected (offset)
 *   revenue              — invoiced milestones + sales order amount
 *
 * Actual Margin = Revenue + AMC Revenue
 *               − material − labour − travel − manufacturing
 *               − procurement_overhead − quality − installation
 *               − commissioning − service
 */

import pool from '../../shared/db.js';
import projectCostRepository from '../repositories/projectCost.repository.js';

/* ── Helper: safe column/table existence checks ────────────────────────── */
async function tableExists(name) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS ok`,
    [name]
  );
  return !!rows[0]?.ok;
}

async function columnExists(table, column) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, column]
  );
  return !!rows[0]?.ok;
}

/* ── 1. Material cost — raw material issues ─────────────────────────────── */
async function getMaterialCost(projectId) {
  const hasIssues   = await tableExists('rm_issues');
  const hasItems    = await tableExists('rm_issue_items');
  const hasProjCol  = hasIssues && await columnExists('rm_issues', 'project_id');
  if (!hasIssues || !hasItems || !hasProjCol) return 0;

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(rii.quantity * COALESCE(rii.rate, 0)), 0) AS total
     FROM rm_issue_items rii
     JOIN rm_issues ri ON ri.id = rii.issue_id
     WHERE ri.project_id = $1 AND ri.deleted_at IS NULL`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 2. Labour cost — timesheets ────────────────────────────────────────── */
async function getLabourCost(projectId) {
  if (!await tableExists('timesheet_entries')) return 0;

  const hasHoursWorked = await columnExists('timesheet_entries', 'hours_worked');
  const hasHours       = await columnExists('timesheet_entries', 'hours');
  const hasProjId      = await columnExists('timesheet_entries', 'project_id');
  if (!hasProjId || (!hasHoursWorked && !hasHours)) return 0;

  const hoursExpr = hasHoursWorked ? 'te.hours_worked' : 'te.hours';
  const hasPM     = await tableExists('project_members');
  const hasBR     = hasPM && await columnExists('project_members', 'billing_rate');
  const hasHR     = await columnExists('timesheet_entries', 'hourly_rate');

  let rateExpr = '500';
  if (hasBR)      rateExpr = `COALESCE(pm.billing_rate, COALESCE(te.hourly_rate, 500))`;
  else if (hasHR) rateExpr = `COALESCE(te.hourly_rate, 500)`;

  const query = hasBR
    ? `SELECT COALESCE(SUM(${hoursExpr} * ${rateExpr}), 0) AS total
       FROM timesheet_entries te
       LEFT JOIN project_members pm ON pm.project_id=te.project_id AND pm.employee_id=te.employee_id
       WHERE te.project_id=$1 AND te.deleted_at IS NULL`
    : `SELECT COALESCE(SUM(${hoursExpr} * ${rateExpr}), 0) AS total
       FROM timesheet_entries te
       WHERE te.project_id=$1 AND te.deleted_at IS NULL`;

  const { rows } = await pool.query(query, [projectId]);
  return parseFloat(rows[0]?.total || 0);
}

/* ── 3. Travel cost — approved travel requests ─────────────────────────── */
async function getTravelCost(projectId) {
  if (!await tableExists('travel_requests')) return 0;
  const hasProjId    = await columnExists('travel_requests', 'project_id');
  if (!hasProjId) return 0;

  const hasTotalAmt  = await columnExists('travel_requests', 'total_amount');
  const hasBudget    = await columnExists('travel_requests', 'budget');
  const amtExpr      = hasTotalAmt ? 'COALESCE(total_amount,0)' : hasBudget ? 'COALESCE(budget,0)' : '0';

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${amtExpr}), 0) AS total
     FROM travel_requests
     WHERE project_id=$1 AND status NOT IN ('Rejected','Cancelled')`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 4. Manufacturing cost — production orders ──────────────────────────── */
async function getManufacturingCost(projectId) {
  if (!await tableExists('production_orders')) return 0;
  const hasProjId = await columnExists('production_orders', 'project_id');
  if (!hasProjId) return 0;

  const hasTotalCost = await columnExists('production_orders', 'total_cost');
  const hasEstCost   = await columnExists('production_orders', 'estimated_cost');
  const costExpr     = hasTotalCost ? 'COALESCE(total_cost,0)' : hasEstCost ? 'COALESCE(estimated_cost,0)' : '0';

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${costExpr}), 0) AS total
     FROM production_orders
     WHERE project_id=$1`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 5. Procurement overhead — purchase orders linked to project ─────────── */
async function getProcurementCost(projectId) {
  if (!await tableExists('purchase_orders')) return 0;
  const hasProjId = await columnExists('purchase_orders', 'project_id');
  if (!hasProjId) return 0;

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(total_amount, 0)), 0) AS total
     FROM purchase_orders
     WHERE project_id=$1 AND status NOT IN ('cancelled', 'rejected')
       AND deleted_at IS NULL`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 6. Quality cost — inspection + NCR resolution labour ───────────────── */
async function getQualityCost(projectId) {
  let total = 0;

  // NCR resolution cost (if column exists)
  if (await tableExists('quality_ncrs') && await columnExists('quality_ncrs', 'project_id')) {
    const hasCost = await columnExists('quality_ncrs', 'resolution_cost');
    if (hasCost) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(COALESCE(resolution_cost,0)),0) AS total
         FROM quality_ncrs WHERE project_id=$1`,
        [projectId]
      );
      total += parseFloat(rows[0]?.total || 0);
    }
  }

  // Inspection cost via production_order project link (quality_inspections)
  if (await tableExists('quality_inspections') && await columnExists('quality_inspections', 'inspection_cost')) {
    const hasPO = await columnExists('quality_inspections', 'production_order_id');
    if (hasPO && await tableExists('production_orders') && await columnExists('production_orders', 'project_id')) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(COALESCE(qi.inspection_cost,0)),0) AS total
         FROM quality_inspections qi
         JOIN production_orders po ON po.id = qi.production_order_id
         WHERE po.project_id=$1`,
        [projectId]
      );
      total += parseFloat(rows[0]?.total || 0);
    }
  }

  return total;
}

/* ── 7. Installation cost — field service tickets of type installation ───── */
async function getInstallationCost(projectId) {
  if (!await tableExists('support_tickets')) return 0;
  const hasProjId = await columnExists('support_tickets', 'project_id');
  if (!hasProjId) return 0;

  const hasType     = await columnExists('support_tickets', 'ticket_type');
  const hasSvcCost  = await columnExists('support_tickets', 'service_cost');
  const hasParts    = await columnExists('support_tickets', 'parts_cost');

  const costExpr = [
    hasSvcCost ? 'COALESCE(service_cost,0)' : null,
    hasParts   ? 'COALESCE(parts_cost,0)'   : null,
  ].filter(Boolean).join(' + ') || '0';

  const typeFilter = hasType ? `AND LOWER(ticket_type) IN ('installation','commissioning')` : '';

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${costExpr}), 0) AS total
     FROM support_tickets
     WHERE project_id=$1 ${typeFilter} AND deleted_at IS NULL`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 8. Commissioning cost — commissioning_reports cost fields ──────────── */
async function getCommissioningCost(projectId) {
  if (!await tableExists('commissioning_reports')) return 0;
  if (!await tableExists('lifecycle_instances'))   return 0;

  const hasLiProjId  = await columnExists('lifecycle_instances', 'project_id');
  const hasCommCost  = await columnExists('commissioning_reports', 'commissioning_cost');
  const hasTravCost  = await columnExists('commissioning_reports', 'travel_cost');
  if (!hasLiProjId) return 0;

  const costExpr = [
    hasCommCost ? 'COALESCE(cr.commissioning_cost,0)' : null,
    hasTravCost ? 'COALESCE(cr.travel_cost,0)'        : null,
  ].filter(Boolean).join(' + ') || '0';

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${costExpr}), 0) AS total
     FROM commissioning_reports cr
     JOIN lifecycle_instances li ON li.id = cr.lifecycle_instance_id
     WHERE li.project_id=$1`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 9. Service cost — break-fix support tickets ────────────────────────── */
async function getServiceCost(projectId) {
  if (!await tableExists('support_tickets')) return 0;
  const hasProjId = await columnExists('support_tickets', 'project_id');
  if (!hasProjId) return 0;

  const hasType    = await columnExists('support_tickets', 'ticket_type');
  const hasSvcCost = await columnExists('support_tickets', 'service_cost');
  const hasParts   = await columnExists('support_tickets', 'parts_cost');

  const costExpr = [
    hasSvcCost ? 'COALESCE(service_cost,0)' : null,
    hasParts   ? 'COALESCE(parts_cost,0)'   : null,
  ].filter(Boolean).join(' + ') || '0';

  // Exclude installation tickets (already counted above)
  const typeFilter = hasType
    ? `AND LOWER(ticket_type) NOT IN ('installation','commissioning')`
    : '';

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${costExpr}), 0) AS total
     FROM support_tickets
     WHERE project_id=$1 ${typeFilter} AND deleted_at IS NULL`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 10. AMC revenue — active AMC contracts linked to this project ──────── */
async function getAmcRevenue(projectId) {
  if (!await tableExists('amc_contracts')) return 0;
  const hasProjId = await columnExists('amc_contracts', 'project_id');
  if (!hasProjId) return 0;

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(contract_value,0)),0) AS total
     FROM amc_contracts
     WHERE project_id=$1 AND status IN ('active','completed')`,
    [projectId]
  );
  return parseFloat(rows[0]?.total || 0);
}

/* ── 11. Revenue — invoiced milestones + sales order amount ─────────────── */
async function getRevenue(projectId) {
  let revenue = 0;

  // From invoiced milestones (most accurate)
  if (await tableExists('project_milestones')) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(amount,0)),0) AS total
       FROM project_milestones
       WHERE project_id=$1 AND status='completed' AND billing_milestone=TRUE`,
      [projectId]
    );
    revenue = parseFloat(rows[0]?.total || 0);
  }

  // Fallback: from project budget_amount / contract value
  if (revenue === 0) {
    const { rows } = await pool.query(
      `SELECT COALESCE(budget_amount, budget, 0) AS contract_value FROM projects WHERE id=$1`,
      [projectId]
    );
    revenue = parseFloat(rows[0]?.contract_value || 0);
  }

  return revenue;
}

/* ── Main: full recalculation ───────────────────────────────────────────── */
export async function recalculateProjectCost(projectId) {
  const [
    materialCost,
    labourCost,
    travelCost,
    manufacturingCost,
    procurementOverhead,
    qualityCost,
    installationCost,
    commissioningCost,
    serviceCost,
    amcRevenue,
    revenue,
  ] = await Promise.all([
    getMaterialCost(projectId),
    getLabourCost(projectId),
    getTravelCost(projectId),
    getManufacturingCost(projectId),
    getProcurementCost(projectId),
    getQualityCost(projectId),
    getInstallationCost(projectId),
    getCommissioningCost(projectId),
    getServiceCost(projectId),
    getAmcRevenue(projectId),
    getRevenue(projectId),
  ]);

  const totalCost = materialCost + labourCost + travelCost + manufacturingCost
    + procurementOverhead + qualityCost + installationCost + commissioningCost + serviceCost;

  const totalRevenue = revenue + amcRevenue;
  const profit       = totalRevenue - totalCost;
  const marginPct    = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

  // Persist to project_cost_summary with all new columns
  try {
    await pool.query(
      `INSERT INTO project_cost_summary
         (project_id, labour_cost, material_cost, expense_cost, travel_cost,
          manufacturing_cost, subcontractor_cost, procurement_overhead,
          quality_cost, installation_cost, commissioning_cost, service_cost,
          amc_revenue, total_revenue, total_cost, revenue, profit, margin_pct,
          last_calculated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
       ON CONFLICT (project_id) DO UPDATE SET
         labour_cost          = $2,
         material_cost        = $3,
         expense_cost         = $4,
         travel_cost          = $5,
         manufacturing_cost   = $6,
         procurement_overhead = $7,
         quality_cost         = $8,
         installation_cost    = $9,
         commissioning_cost   = $10,
         service_cost         = $11,
         amc_revenue          = $12,
         total_revenue        = $13,
         total_cost           = $14,
         revenue              = $15,
         profit               = $16,
         margin_pct           = $17,
         last_calculated_at   = NOW(),
         updated_at           = NOW()`,
      [
        projectId,
        labourCost, materialCost,
        travelCost + manufacturingCost,  // expense_cost (legacy compat)
        travelCost, manufacturingCost,
        procurementOverhead, qualityCost,
        installationCost, commissioningCost, serviceCost,
        amcRevenue, totalRevenue, totalCost,
        revenue, profit,
        parseFloat(marginPct.toFixed(2)),
      ]
    );
  } catch (err) {
    // Fallback: use legacy upsert if new columns don't exist yet
    await projectCostRepository.upsert(projectId, {
      labour_cost:       labourCost,
      material_cost:     materialCost,
      expense_cost:      travelCost + manufacturingCost,
      travel_cost:       travelCost,
      manufacturing_cost: manufacturingCost,
      revenue,
    });
  }

  return {
    project_id:          parseInt(projectId, 10),
    material_cost:       materialCost,
    labour_cost:         labourCost,
    travel_cost:         travelCost,
    manufacturing_cost:  manufacturingCost,
    procurement_overhead: procurementOverhead,
    quality_cost:        qualityCost,
    installation_cost:   installationCost,
    commissioning_cost:  commissioningCost,
    service_cost:        serviceCost,
    total_cost:          totalCost,
    amc_revenue:         amcRevenue,
    invoice_revenue:     revenue,
    total_revenue:       totalRevenue,
    profit,
    margin_pct:          parseFloat(marginPct.toFixed(2)),
  };
}
