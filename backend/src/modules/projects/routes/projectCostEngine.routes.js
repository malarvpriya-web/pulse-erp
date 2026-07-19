/**
 * Phase 46 — Project Cost Engine
 * Unified cost transaction ledger + profitability engine + CEO Command Center
 *
 * Mounted at: /api/v1/project-cost-engine
 */
import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = (req) => req.scope?.company_id ?? companyOf(req);
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

// ── Bootstrap tables if migration hasn't run yet ──────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cost_centers (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER,
        code          VARCHAR(30) NOT NULL,
        name          VARCHAR(120) NOT NULL,
        department    VARCHAR(100),
        department_id INTEGER,
        parent_id     INTEGER,
        description   TEXT,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_cost_transactions (
        id                SERIAL PRIMARY KEY,
        company_id        INTEGER,
        customer_id       INTEGER,
        customer_name     VARCHAR(255),
        project_id        INTEGER,
        project_code      VARCHAR(50),
        site_id           INTEGER,
        site_name         VARCHAR(255),
        sales_order_id    INTEGER,
        po_number         VARCHAR(100),
        cost_center_id    INTEGER,
        cost_type         VARCHAR(40) NOT NULL,
        reference_module  VARCHAR(60),
        reference_id      INTEGER,
        reference_code    VARCHAR(100),
        amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
        currency          CHAR(3) DEFAULT 'INR',
        transaction_date  DATE NOT NULL DEFAULT CURRENT_DATE,
        description       TEXT,
        remarks           TEXT,
        is_unallocated    BOOLEAN DEFAULT FALSE,
        unallocated_reason TEXT,
        created_by        INTEGER,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_revenue_summary (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER,
        project_id            INTEGER UNIQUE,
        quotation_value       NUMERIC(15,2) DEFAULT 0,
        order_value           NUMERIC(15,2) DEFAULT 0,
        invoice_value         NUMERIC(15,2) DEFAULT 0,
        collection_value      NUMERIC(15,2) DEFAULT 0,
        retention_value       NUMERIC(15,2) DEFAULT 0,
        pending_collection    NUMERIC(15,2) DEFAULT 0,
        advance_received      NUMERIC(15,2) DEFAULT 0,
        last_invoice_date     DATE,
        last_collection_date  DATE,
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add missing columns to project_cost_summary
    await pool.query(`
      ALTER TABLE project_cost_summary
        ADD COLUMN IF NOT EXISTS sales_travel_cost      NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS app_engineering_cost   NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS engineering_cost       NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS procurement_cost       NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS inventory_cost         NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS production_cost        NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS fat_cost               NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS transport_cost         NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS amc_cost               NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS other_cost             NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gross_margin_pct       NUMERIC(8,2)  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS net_margin_pct         NUMERIC(8,2)  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cost_variance          NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS budget_variance        NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS collection_pct         NUMERIC(8,2)  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_revenue          NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS amc_revenue            NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS procurement_overhead   NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS manufacturing_cost     NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS expense_cost           NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS subcontractor_cost     NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS travel_cost            NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS margin_pct             NUMERIC(8,2)  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS planned_value          NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS earned_value           NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS actual_cost_evm        NUMERIC(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cost_performance_index NUMERIC(8,3)  DEFAULT 1,
        ADD COLUMN IF NOT EXISTS schedule_performance_index NUMERIC(8,3) DEFAULT 1,
        ADD COLUMN IF NOT EXISTS last_calculated_at     TIMESTAMPTZ
    `);
  } catch (e) {
    console.error('[project-cost-engine] bootstrap error:', e.message);
  }
})();

// ── COST TYPES reference list ─────────────────────────────────────────────────
const COST_TYPES = [
  'SALES_TRAVEL','APPLICATION_ENGINEERING','ENGINEERING','PROCUREMENT',
  'MATERIAL','INVENTORY','PRODUCTION','LABOUR','QUALITY','FAT',
  'TRANSPORT','INSTALLATION','COMMISSIONING','SERVICE','AMC','OTHER',
];

// ── Helper: detect if a transaction is unallocated ───────────────────────────
function checkUnallocated(body) {
  const reasons = [];
  if (!body.project_id)    reasons.push('No project linked');
  if (!body.customer_id)   reasons.push('No customer linked');
  if (!body.po_number)     reasons.push('No PO number');
  if (!body.cost_center_id) reasons.push('No cost centre');
  return { is_unallocated: reasons.length > 0, unallocated_reason: reasons.join('; ') || null };
}

// ── Helper: build profitability object from cost summary row ─────────────────
function buildProfitability(p, pcs, prs) {
  const budget   = parseFloat(p?.budget_amount || p?.budget || 0);
  const revenue  = parseFloat(prs?.order_value || pcs?.total_revenue || pcs?.revenue || budget);
  const invoiced = parseFloat(prs?.invoice_value || pcs?.revenue || 0);
  const collected = parseFloat(prs?.collection_value || 0);
  const retention = parseFloat(prs?.retention_value || 0);
  const pending   = parseFloat(prs?.pending_collection || Math.max(0, invoiced - collected));

  const salesTravel      = parseFloat(pcs?.sales_travel_cost || pcs?.travel_cost || 0);
  const appEng           = parseFloat(pcs?.app_engineering_cost || 0);
  const engineering      = parseFloat(pcs?.engineering_cost || pcs?.labour_cost || 0);
  const procurement      = parseFloat(pcs?.procurement_cost || pcs?.procurement_overhead || 0);
  const material         = parseFloat(pcs?.material_cost || 0);
  const inventory        = parseFloat(pcs?.inventory_cost || 0);
  const production       = parseFloat(pcs?.production_cost || pcs?.manufacturing_cost || 0);
  const labour           = parseFloat(pcs?.labour_cost || 0);
  const quality          = parseFloat(pcs?.quality_cost || 0);
  const fat              = parseFloat(pcs?.fat_cost || 0);
  const transport        = parseFloat(pcs?.transport_cost || 0);
  const installation     = parseFloat(pcs?.installation_cost || 0);
  const commissioning    = parseFloat(pcs?.commissioning_cost || 0);
  const service          = parseFloat(pcs?.service_cost || 0);
  const amc              = parseFloat(pcs?.amc_cost || pcs?.amc_revenue || 0);
  const other            = parseFloat(pcs?.other_cost || 0);

  const totalCost = salesTravel + appEng + engineering + procurement + material +
    inventory + production + quality + fat + transport + installation +
    commissioning + service + amc + other;

  const grossProfit = revenue - totalCost;
  const grossMarginPct = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const budgetVariance = budget - totalCost;
  const costVariance = revenue - totalCost;
  const collectionPct = invoiced > 0 ? (collected / invoiced) * 100 : 0;

  return {
    budget, revenue, invoiced_revenue: invoiced,
    collection_value: collected, retention_value: retention,
    pending_collection: pending,
    cost_breakdown: {
      sales_travel: salesTravel, app_engineering: appEng,
      engineering, procurement, material, inventory, production,
      labour, quality, fat, transport, installation,
      commissioning, service, amc, other,
    },
    total_cost: totalCost,
    gross_profit: grossProfit,
    gross_margin_pct: parseFloat(grossMarginPct.toFixed(2)),
    net_profit: grossProfit,
    net_margin_pct: parseFloat(grossMarginPct.toFixed(2)),
    budget_variance: budgetVariance,
    cost_variance: costVariance,
    collection_pct: parseFloat(collectionPct.toFixed(2)),
    cpi: parseFloat(pcs?.cost_performance_index || 1),
    spi: parseFloat(pcs?.schedule_performance_index || 1),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COST TRANSACTIONS — CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/transactions
router.get('/transactions', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const {
      project_id, customer_id, cost_type, cost_center_id, po_number,
      from_date, to_date, unallocated, limit = 500, offset = 0,
    } = req.query;

    const params = [];
    const conds  = [];
    let i = 1;

    if (cid(req)) { conds.push(`pct.company_id=$${i++}`); params.push(cid(req)); }
    if (project_id)    { conds.push(`pct.project_id=$${i++}`);    params.push(project_id); }
    if (customer_id)   { conds.push(`pct.customer_id=$${i++}`);   params.push(customer_id); }
    if (cost_type)     { conds.push(`pct.cost_type=$${i++}`);     params.push(cost_type); }
    if (cost_center_id){ conds.push(`pct.cost_center_id=$${i++}`); params.push(cost_center_id); }
    if (po_number)     { conds.push(`pct.po_number=$${i++}`);     params.push(po_number); }
    if (from_date)     { conds.push(`pct.transaction_date>=$${i++}`); params.push(from_date); }
    if (to_date)       { conds.push(`pct.transaction_date<=$${i++}`); params.push(to_date); }
    if (unallocated === 'true') { conds.push(`pct.is_unallocated=TRUE`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT pct.*,
             p.project_name, p.project_code AS project_code_name,
             cc.name AS cost_center_name, cc.code AS cost_center_code,
             e.first_name||' '||e.last_name AS created_by_name
      FROM project_cost_transactions pct
      LEFT JOIN projects p       ON p.id = pct.project_id
      LEFT JOIN cost_centers cc  ON cc.id = pct.cost_center_id
      LEFT JOIN employees e      ON e.id  = pct.created_by
      ${where}
      ORDER BY pct.transaction_date DESC, pct.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, params);

    const totalRes = await pool.query(
      `SELECT COUNT(*) AS total FROM project_cost_transactions pct ${where}`, params
    ).catch(() => ({ rows: [{ total: rows.length }] }));

    res.json({ rows, total: parseInt(totalRes.rows[0]?.total || rows.length) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /project-cost-engine/transactions
router.post('/transactions', requirePermission('projects', 'add'), async (req, res) => {
  try {
    const {
      customer_id, customer_name, project_id, project_code,
      site_id, site_name, sales_order_id, po_number,
      cost_center_id, cost_type, reference_module, reference_id, reference_code,
      amount, currency, transaction_date, description, remarks,
    } = req.body;

    if (!COST_TYPES.includes(cost_type)) {
      return res.status(422).json({ error: `Invalid cost_type. Must be one of: ${COST_TYPES.join(', ')}` });
    }

    const { is_unallocated, unallocated_reason } = checkUnallocated(req.body);

    const { rows: [tx] } = await pool.query(`
      INSERT INTO project_cost_transactions
        (company_id, customer_id, customer_name, project_id, project_code,
         site_id, site_name, sales_order_id, po_number, cost_center_id,
         cost_type, reference_module, reference_id, reference_code,
         amount, currency, transaction_date, description, remarks,
         is_unallocated, unallocated_reason, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *
    `, [
      cid(req), customer_id||null, customer_name||null, project_id||null, project_code||null,
      site_id||null, site_name||null, sales_order_id||null, po_number||null, cost_center_id||null,
      cost_type, reference_module||null, reference_id||null, reference_code||null,
      amount||0, currency||'INR', transaction_date||new Date().toISOString().slice(0,10),
      description||null, remarks||null, is_unallocated, unallocated_reason, uid(req),
    ]);

    logAudit({ userId: uid(req), module: 'project_cost_engine', recordId: tx.id, recordType: 'cost_transaction', action: 'create', newData: tx, req });
    res.status(201).json(tx);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /project-cost-engine/transactions/:id
router.put('/transactions/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const {
      customer_id, customer_name, project_id, project_code,
      site_id, site_name, po_number, cost_center_id, cost_type,
      amount, transaction_date, description, remarks,
    } = req.body;

    const { is_unallocated, unallocated_reason } = checkUnallocated(req.body);

    const { rows: [tx] } = await pool.query(`
      UPDATE project_cost_transactions SET
        customer_id=$1, customer_name=$2, project_id=$3, project_code=$4,
        site_id=$5, site_name=$6, po_number=$7, cost_center_id=$8, cost_type=$9,
        amount=$10, transaction_date=$11, description=$12, remarks=$13,
        is_unallocated=$14, unallocated_reason=$15, updated_at=NOW()
      WHERE id=$16 AND ($17::int IS NULL OR company_id=$17)
      RETURNING *
    `, [
      customer_id||null, customer_name||null, project_id||null, project_code||null,
      site_id||null, site_name||null, po_number||null, cost_center_id||null, cost_type,
      amount||0, transaction_date, description||null, remarks||null,
      is_unallocated, unallocated_reason,
      req.params.id, cid(req),
    ]);

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json(tx);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /project-cost-engine/transactions/:id
router.delete('/transactions/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_cost_transactions WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE SUMMARY — per project
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/revenue/:project_id
router.get('/revenue/:project_id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const pid = req.params.project_id;

    // Pull from project_revenue_summary + live invoice/collection data
    const [prsRes, projRes, invoiceRes, collectionRes] = await Promise.allSettled([
      pool.query(
        `SELECT * FROM project_revenue_summary WHERE project_id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [pid, cid(req)]
      ),
      pool.query(
        `SELECT id, project_name, project_code, COALESCE(budget_amount, budget, 0) AS contract_value,
                COALESCE(customer_name, client_name) AS customer_name, status
         FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [pid, cid(req)]
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS invoice_value, COUNT(*) AS invoice_count
         FROM sales_invoices WHERE project_id=$1 AND ($2::int IS NULL OR company_id=$2)
           AND status NOT IN ('cancelled','void')`,
        [pid, cid(req)]
      ).catch(() => ({ rows: [{ invoice_value: 0, invoice_count: 0 }] })),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS collection_value
         FROM payment_receipts WHERE project_id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [pid, cid(req)]
      ).catch(() => ({ rows: [{ collection_value: 0 }] })),
    ]);

    const prs  = prsRes.status === 'fulfilled'  ? prsRes.value.rows[0]  : null;
    const proj = projRes.status === 'fulfilled' ? projRes.value.rows[0] : null;
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const contractValue  = parseFloat(proj.contract_value || 0);
    const invoiceValue   = parseFloat(invoiceRes.status === 'fulfilled' ? invoiceRes.value.rows[0]?.invoice_value || 0 : prs?.invoice_value || 0);
    const collectionValue = parseFloat(collectionRes.status === 'fulfilled' ? collectionRes.value.rows[0]?.collection_value || 0 : prs?.collection_value || 0);
    const retention      = parseFloat(prs?.retention_value || 0);
    const pending        = Math.max(0, invoiceValue - collectionValue);

    res.json({
      project_id:        pid,
      project_name:      proj.project_name,
      project_code:      proj.project_code,
      customer_name:     proj.customer_name,
      quotation_value:   parseFloat(prs?.quotation_value || 0),
      order_value:       parseFloat(prs?.order_value || contractValue),
      invoice_value:     invoiceValue,
      collection_value:  collectionValue,
      retention_value:   retention,
      pending_collection: pending,
      advance_received:  parseFloat(prs?.advance_received || 0),
      collection_pct:    invoiceValue > 0 ? parseFloat(((collectionValue / invoiceValue) * 100).toFixed(2)) : 0,
      billing_pct:       contractValue > 0 ? parseFloat(((invoiceValue / contractValue) * 100).toFixed(2)) : 0,
      last_invoice_date: prs?.last_invoice_date,
      last_collection_date: prs?.last_collection_date,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /project-cost-engine/revenue/:project_id
router.put('/revenue/:project_id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { quotation_value, order_value, invoice_value, collection_value,
            retention_value, advance_received } = req.body;
    const pending = Math.max(0, parseFloat(invoice_value||0) - parseFloat(collection_value||0));

    const { rows: [prs] } = await pool.query(`
      INSERT INTO project_revenue_summary
        (company_id, project_id, quotation_value, order_value, invoice_value,
         collection_value, retention_value, pending_collection, advance_received)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (project_id) DO UPDATE SET
        quotation_value=$3, order_value=$4, invoice_value=$5,
        collection_value=$6, retention_value=$7, pending_collection=$8,
        advance_received=$9, updated_at=NOW()
      RETURNING *
    `, [
      cid(req), req.params.project_id,
      quotation_value||0, order_value||0, invoice_value||0,
      collection_value||0, retention_value||0, pending, advance_received||0,
    ]);
    res.json(prs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFITABILITY ENGINE — per project (Project 360 / Part 7)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/profitability/:project_id
router.get('/profitability/:project_id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const pid = req.params.project_id;

    const [projRes, pcsRes, prsRes, txRes, invRes] = await Promise.allSettled([
      pool.query(
        `SELECT p.*, COALESCE(p.budget_amount, p.budget, 0) AS contract_value,
                COALESCE(p.customer_name, p.client_name) AS cust_name
         FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2)`,
        [pid, cid(req)]
      ),
      pool.query(`SELECT * FROM project_cost_summary WHERE project_id=$1`, [pid]),
      pool.query(
        `SELECT * FROM project_revenue_summary WHERE project_id=$1`,
        [pid]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT cost_type, SUM(amount) AS total
         FROM project_cost_transactions
         WHERE project_id=$1 AND ($2::int IS NULL OR company_id=$2)
         GROUP BY cost_type`,
        [pid, cid(req)]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS invoice_value
         FROM sales_invoices WHERE project_id=$1 AND status NOT IN ('cancelled','void')`,
        [pid]
      ).catch(() => ({ rows: [{ invoice_value: 0 }] })),
    ]);

    const proj = projRes.status === 'fulfilled' ? projRes.value.rows[0] : null;
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const pcs = pcsRes.status === 'fulfilled' ? pcsRes.value.rows[0] : null;
    const prs = prsRes.status === 'fulfilled' ? prsRes.value.rows[0] : null;
    const txRows = txRes.status === 'fulfilled' ? txRes.value.rows : [];
    const invoicedTotal = parseFloat(invRes.status === 'fulfilled' ? invRes.value.rows[0]?.invoice_value || 0 : 0);

    // Build cost from transactions if available (most accurate), else from summary
    const txMap = {};
    COST_TYPES.forEach(t => { txMap[t] = 0; });
    txRows.forEach(r => { txMap[r.cost_type] = parseFloat(r.total || 0); });

    const hasTxData = txRows.length > 0;
    const pcsForCalc = hasTxData ? {
      sales_travel_cost:    txMap['SALES_TRAVEL'],
      app_engineering_cost: txMap['APPLICATION_ENGINEERING'],
      engineering_cost:     txMap['ENGINEERING'],
      procurement_cost:     txMap['PROCUREMENT'],
      material_cost:        txMap['MATERIAL'],
      inventory_cost:       txMap['INVENTORY'],
      production_cost:      txMap['PRODUCTION'],
      labour_cost:          txMap['LABOUR'],
      quality_cost:         txMap['QUALITY'],
      fat_cost:             txMap['FAT'],
      transport_cost:       txMap['TRANSPORT'],
      installation_cost:    txMap['INSTALLATION'],
      commissioning_cost:   txMap['COMMISSIONING'],
      service_cost:         txMap['SERVICE'],
      amc_cost:             txMap['AMC'],
      other_cost:           txMap['OTHER'],
      cost_performance_index:      pcs?.cost_performance_index || 1,
      schedule_performance_index:  pcs?.schedule_performance_index || 1,
      total_revenue: prs?.order_value || proj.contract_value || 0,
    } : pcs;

    const profitability = buildProfitability(proj, pcsForCalc, {
      ...prs,
      invoice_value: invoicedTotal || prs?.invoice_value,
    });

    res.json({
      project_id:   pid,
      project_name: proj.project_name,
      project_code: proj.project_code,
      customer_name: proj.cust_name,
      project_type: proj.project_type,
      status:       proj.status,
      start_date:   proj.start_date,
      end_date:     proj.end_date,
      progress_pct: proj.progress_percentage,
      ...profitability,
      tx_breakdown: txMap,
      has_live_transactions: hasTxData,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFITABILITY DASHBOARD — all projects (Part 5)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/dashboard
router.get('/dashboard', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cWhere = companyId ? 'WHERE p.company_id=$1' : 'WHERE TRUE';
    const params = companyId ? [companyId] : [];

    const [overviewRes, projectsRes, costTypeRes, monthlyTrendRes, overBudgetRes] = await Promise.allSettled([
      // Top-level KPIs
      pool.query(`
        SELECT
          COUNT(p.id)::int                                       AS total_projects,
          COUNT(CASE WHEN p.status='active' THEN 1 END)::int    AS active_projects,
          COUNT(CASE WHEN p.status='completed' THEN 1 END)::int AS completed_projects,
          COALESCE(SUM(COALESCE(p.budget_amount, p.budget, 0)),0)        AS total_contract_value,
          COALESCE(SUM(COALESCE(pcs.total_cost, 0)),0)                   AS total_cost,
          COALESCE(SUM(COALESCE(pcs.revenue, 0)),0)                      AS total_invoiced,
          COALESCE(SUM(COALESCE(pcs.profit, 0)),0)                       AS total_profit,
          COALESCE(
            SUM(COALESCE(pcs.profit,0)) /
            NULLIF(SUM(COALESCE(p.budget_amount, p.budget, 0)),0) * 100
          , 0)                                                            AS avg_margin_pct,
          COUNT(CASE WHEN COALESCE(pcs.total_cost,0) > COALESCE(p.budget_amount, p.budget,0)*1.05 THEN 1 END)::int AS over_budget_count,
          COUNT(CASE WHEN COALESCE(pcs.profit,0) < 0 THEN 1 END)::int   AS loss_projects
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
        ${cWhere}
      `, params),

      // Per-project profitability list
      pool.query(`
        SELECT
          p.id, p.project_code, p.project_name, p.status, p.project_type,
          COALESCE(p.customer_name, p.client_name) AS customer_name,
          COALESCE(p.budget_amount, p.budget, 0)             AS contract_value,
          COALESCE(pcs.total_cost, 0)                        AS total_cost,
          COALESCE(pcs.revenue, pcs.total_revenue, 0)        AS invoiced,
          COALESCE(pcs.profit, 0)                            AS profit,
          COALESCE(pcs.margin_pct, 0)                        AS margin_pct,
          COALESCE(pcs.labour_cost, 0)                       AS labour_cost,
          COALESCE(pcs.material_cost, 0)                     AS material_cost,
          COALESCE(pcs.installation_cost, 0)                 AS installation_cost,
          COALESCE(pcs.commissioning_cost, 0)                AS commissioning_cost,
          COALESCE(pcs.service_cost, 0)                      AS service_cost,
          COALESCE(pcs.travel_cost, pcs.sales_travel_cost, 0) AS travel_cost,
          COALESCE(pcs.last_calculated_at, p.updated_at)     AS last_updated,
          p.progress_percentage
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
        ${cWhere}
        ORDER BY COALESCE(pcs.profit,0) DESC
        LIMIT 100
      `, params),

      // Cost type breakdown across all projects
      pool.query(`
        SELECT cost_type, SUM(amount) AS total
        FROM project_cost_transactions
        ${companyId ? 'WHERE company_id=$1' : ''}
        GROUP BY cost_type ORDER BY total DESC
      `, companyId ? [companyId] : []).catch(() => ({ rows: [] })),

      // Monthly cost/revenue trend (last 12 months)
      pool.query(`
        SELECT
          TO_CHAR(transaction_date,'YYYY-MM') AS month,
          SUM(amount)                          AS total_cost
        FROM project_cost_transactions
        WHERE transaction_date >= CURRENT_DATE - INTERVAL '12 months'
          ${companyId ? 'AND company_id=$1' : ''}
        GROUP BY month ORDER BY month ASC
      `, companyId ? [companyId] : []).catch(() => ({ rows: [] })),

      // Over-budget projects
      pool.query(`
        SELECT
          p.id, p.project_code, p.project_name,
          COALESCE(p.customer_name, p.client_name) AS customer_name,
          COALESCE(p.budget_amount, p.budget, 0)    AS budget,
          COALESCE(pcs.total_cost, 0)               AS actual_cost,
          COALESCE(pcs.total_cost,0) - COALESCE(p.budget_amount,p.budget,0) AS overrun
        FROM projects p
        JOIN project_cost_summary pcs ON pcs.project_id = p.id
        ${cWhere}
        AND COALESCE(pcs.total_cost,0) > COALESCE(p.budget_amount, p.budget,0)*1.05
        ORDER BY overrun DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),
    ]);

    const ov       = overviewRes.status === 'fulfilled'   ? overviewRes.value.rows[0]   : {};
    const projects = projectsRes.status === 'fulfilled'   ? projectsRes.value.rows       : [];
    const costTypes = costTypeRes.status === 'fulfilled'  ? costTypeRes.value.rows       : [];
    const trend     = monthlyTrendRes.status === 'fulfilled' ? monthlyTrendRes.value.rows : [];
    const overBudget = overBudgetRes.status === 'fulfilled' ? overBudgetRes.value.rows   : [];

    const numFmt = v => parseFloat(v || 0);

    // Sort for top/bottom tables
    const sortedByProfit = [...projects].sort((a,b) => numFmt(b.profit) - numFmt(a.profit));
    const topProfitable   = sortedByProfit.slice(0, 10);
    const topLoss         = [...projects].sort((a,b) => numFmt(a.profit) - numFmt(b.profit)).slice(0, 10);
    const negMargin       = projects.filter(p => numFmt(p.margin_pct) < 0);

    res.json({
      kpis: {
        total_projects:      parseInt(ov.total_projects || 0),
        active_projects:     parseInt(ov.active_projects || 0),
        completed_projects:  parseInt(ov.completed_projects || 0),
        total_contract_value: numFmt(ov.total_contract_value),
        total_cost:          numFmt(ov.total_cost),
        total_invoiced:      numFmt(ov.total_invoiced),
        total_profit:        numFmt(ov.total_profit),
        avg_margin_pct:      parseFloat(numFmt(ov.avg_margin_pct).toFixed(2)),
        over_budget_count:   parseInt(ov.over_budget_count || 0),
        loss_projects:       parseInt(ov.loss_projects || 0),
      },
      projects: projects.map(p => ({
        ...p,
        contract_value: numFmt(p.contract_value),
        total_cost:     numFmt(p.total_cost),
        invoiced:       numFmt(p.invoiced),
        profit:         numFmt(p.profit),
        margin_pct:     numFmt(p.margin_pct),
      })),
      cost_type_breakdown: costTypes.map(r => ({ cost_type: r.cost_type, total: numFmt(r.total) })),
      monthly_trend:       trend.map(r => ({ month: r.month, total_cost: numFmt(r.total_cost) })),
      over_budget_projects: overBudget,
      top_profitable:      topProfitable,
      top_loss:            topLoss,
      negative_margin:     negMargin,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CEO COMMAND CENTER (Part 8)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/ceo-command-center
router.get('/ceo-command-center', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? 'AND p.company_id=$1' : '';
    const txFilter = companyId ? 'AND company_id=$1' : '';
    const params = companyId ? [companyId] : [];

    const [
      thisMonthRes, kpiRes, top10Res, expensiveRes, profitableRes,
      outstandingRes, costBreakdownRes, statusRes,
    ] = await Promise.allSettled([
      // Revenue this month
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN TO_CHAR(si.invoice_date,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')
                       THEN si.total_amount ELSE 0 END),0) AS revenue_this_month,
          COALESCE(SUM(si.total_amount),0)                  AS total_invoiced,
          COUNT(DISTINCT si.project_id)                     AS billed_projects
        FROM sales_invoices si
        JOIN projects p ON p.id=si.project_id
        WHERE si.status NOT IN ('cancelled','void') ${cFilter}
      `, params).catch(() => ({ rows: [{}] })),

      // Core profitability KPIs
      pool.query(`
        SELECT
          COUNT(p.id)::int                              AS total_projects,
          COUNT(CASE WHEN p.status='active' THEN 1 END)::int AS active_projects,
          COALESCE(SUM(COALESCE(p.budget_amount,p.budget,0)),0)  AS total_order_value,
          COALESCE(SUM(COALESCE(pcs.total_cost,0)),0)            AS total_actual_cost,
          COALESCE(SUM(COALESCE(pcs.profit,0)),0)                AS total_profit,
          COALESCE(SUM(COALESCE(pcs.profit,0))/NULLIF(SUM(COALESCE(p.budget_amount,p.budget,0)),0)*100,0) AS portfolio_margin,
          COUNT(CASE WHEN COALESCE(pcs.profit,0)<0 THEN 1 END)::int AS loss_projects,
          COUNT(CASE WHEN COALESCE(pcs.total_cost,0)>COALESCE(p.budget_amount,p.budget,0)*1.1 THEN 1 END)::int AS over_budget
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE TRUE ${cFilter}
      `, params).catch(() => ({ rows: [{}] })),

      // Top 10 projects by contract value
      pool.query(`
        SELECT p.id, p.project_code, p.project_name, p.status,
               COALESCE(p.customer_name,p.client_name) AS customer_name,
               COALESCE(p.budget_amount,p.budget,0)   AS contract_value,
               COALESCE(pcs.total_cost,0)             AS actual_cost,
               COALESCE(pcs.profit,0)                 AS profit,
               COALESCE(pcs.margin_pct,0)             AS margin_pct,
               COALESCE(p.progress_percentage,0)      AS progress
        FROM projects p
        LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE TRUE ${cFilter}
        ORDER BY COALESCE(p.budget_amount,p.budget,0) DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),

      // Most expensive projects (highest actual cost)
      pool.query(`
        SELECT p.id, p.project_code, p.project_name,
               COALESCE(p.customer_name,p.client_name) AS customer_name,
               COALESCE(pcs.total_cost,0) AS actual_cost,
               COALESCE(p.budget_amount,p.budget,0)   AS budget,
               COALESCE(pcs.total_cost,0)-COALESCE(p.budget_amount,p.budget,0) AS overrun
        FROM projects p
        JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE COALESCE(pcs.total_cost,0)>0 ${cFilter}
        ORDER BY actual_cost DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),

      // Most profitable projects
      pool.query(`
        SELECT p.id, p.project_code, p.project_name,
               COALESCE(p.customer_name,p.client_name) AS customer_name,
               COALESCE(pcs.profit,0)      AS profit,
               COALESCE(pcs.margin_pct,0)  AS margin_pct,
               COALESCE(pcs.revenue,0)     AS revenue
        FROM projects p
        JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE COALESCE(pcs.profit,0)>0 ${cFilter}
        ORDER BY profit DESC LIMIT 10
      `, params).catch(() => ({ rows: [] })),

      // Outstanding collections
      pool.query(`
        SELECT
          COALESCE(SUM(si.total_amount),0) AS total_invoiced,
          COALESCE(SUM(CASE WHEN si.status='paid' THEN si.total_amount ELSE 0 END),0) AS collected,
          COALESCE(SUM(CASE WHEN si.status<>'paid' THEN si.total_amount ELSE 0 END),0) AS outstanding,
          COUNT(CASE WHEN si.status<>'paid' AND si.due_date<CURRENT_DATE THEN 1 END)::int AS overdue_invoices
        FROM sales_invoices si
        JOIN projects p ON p.id=si.project_id
        WHERE si.status NOT IN ('cancelled','void') ${cFilter}
      `, params).catch(() => ({ rows: [{}] })),

      // Cost type breakdown across portfolio
      pool.query(`
        SELECT cost_type, SUM(amount) AS total
        FROM project_cost_transactions
        WHERE TRUE ${txFilter.replace('AND ','')}
        GROUP BY cost_type ORDER BY total DESC
      `, params).catch(() => ({ rows: [] })),

      // Project status breakdown
      pool.query(`
        SELECT status, COUNT(*)::int AS count,
               COALESCE(SUM(COALESCE(budget_amount,budget,0)),0) AS value
        FROM projects p WHERE TRUE ${cFilter}
        GROUP BY status ORDER BY count DESC
      `, params).catch(() => ({ rows: [] })),
    ]);

    const fm = res => res.status === 'fulfilled' ? res.value.rows : [];
    const f1 = res => res.status === 'fulfilled' ? res.value.rows[0] : {};
    const n  = v => parseFloat(v || 0);

    const monthData   = f1(thisMonthRes);
    const kpi         = f1(kpiRes);
    const outstanding = f1(outstandingRes);

    res.json({
      revenue_this_month:    n(monthData.revenue_this_month),
      total_invoiced:        n(monthData.total_invoiced),
      billed_projects:       parseInt(monthData.billed_projects || 0),
      total_projects:        parseInt(kpi.total_projects || 0),
      active_projects:       parseInt(kpi.active_projects || 0),
      total_order_value:     n(kpi.total_order_value),
      total_actual_cost:     n(kpi.total_actual_cost),
      total_profit:          n(kpi.total_profit),
      portfolio_margin_pct:  parseFloat(n(kpi.portfolio_margin).toFixed(2)),
      loss_projects:         parseInt(kpi.loss_projects || 0),
      over_budget_projects:  parseInt(kpi.over_budget || 0),
      outstanding_collection: n(outstanding.outstanding),
      overdue_invoices:      parseInt(outstanding.overdue_invoices || 0),
      top_10_projects:       fm(top10Res).map(r => ({ ...r, contract_value: n(r.contract_value), actual_cost: n(r.actual_cost), profit: n(r.profit), margin_pct: n(r.margin_pct) })),
      most_expensive:        fm(expensiveRes).map(r => ({ ...r, actual_cost: n(r.actual_cost), budget: n(r.budget), overrun: n(r.overrun) })),
      most_profitable:       fm(profitableRes).map(r => ({ ...r, profit: n(r.profit), margin_pct: n(r.margin_pct), revenue: n(r.revenue) })),
      cost_breakdown:        fm(costBreakdownRes).map(r => ({ cost_type: r.cost_type, total: n(r.total) })),
      status_breakdown:      fm(statusRes).map(r => ({ status: r.status, count: r.count, value: n(r.value) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COST CENTRES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /project-cost-engine/cost-centers
router.get('/cost-centers', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cc.*,
              p.name AS parent_name,
              d.department_name AS dept_name,
              (SELECT COUNT(*) FROM project_cost_transactions pct WHERE pct.cost_center_id=cc.id) AS tx_count,
              (SELECT COALESCE(SUM(amount),0) FROM project_cost_transactions pct WHERE pct.cost_center_id=cc.id) AS total_spend
       FROM cost_centers cc
       LEFT JOIN cost_centers p  ON p.id=cc.parent_id
       LEFT JOIN departments  d  ON d.id=cc.department_id
       WHERE ($1::int IS NULL OR cc.company_id=$1) AND cc.is_active=TRUE
       ORDER BY cc.code`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /project-cost-engine/cost-centers
router.post('/cost-centers', requirePermission('projects', 'add'), async (req, res) => {
  try {
    const { code, name, department, department_id, parent_id, description } = req.body;
    const { rows: [cc] } = await pool.query(`
      INSERT INTO cost_centers (company_id, code, name, department, department_id, parent_id, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [cid(req), code, name, department||null, department_id||null, parent_id||null, description||null]);
    res.status(201).json(cc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /project-cost-engine/cost-centers/:id
router.put('/cost-centers/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { code, name, department, department_id, parent_id, description, is_active } = req.body;
    const { rows: [cc] } = await pool.query(`
      UPDATE cost_centers SET code=$1, name=$2, department=$3, department_id=$4,
        parent_id=$5, description=$6, is_active=$7, updated_at=NOW()
      WHERE id=$8 AND ($9::int IS NULL OR company_id=$9)
      RETURNING *
    `, [code, name, department||null, department_id||null, parent_id||null, description||null, is_active??true, req.params.id, cid(req)]);
    if (!cc) return res.status(404).json({ error: 'Cost centre not found' });
    res.json(cc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── UNALLOCATED COSTS ─────────────────────────────────────────────────────────
// GET /project-cost-engine/unallocated
router.get('/unallocated', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pct.*,
             e.first_name||' '||e.last_name AS created_by_name
      FROM project_cost_transactions pct
      LEFT JOIN employees e ON e.id=pct.created_by
      WHERE pct.is_unallocated=TRUE
        AND ($1::int IS NULL OR pct.company_id=$1)
      ORDER BY pct.transaction_date DESC, pct.amount DESC
      LIMIT 200
    `, [cid(req)]);
    const total = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    res.json({ unallocated_costs: rows, total_unallocated: total, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MODULE CAPTURE — bulk ingest from other modules ───────────────────────────
// POST /project-cost-engine/capture-module-costs
router.post('/capture-module-costs', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { project_id, modules = ['all'] } = req.body;
    const companyId = cid(req);
    const captureAll = modules.includes('all');
    const captured = [];

    // Helper: insert if not already captured
    const capture = async (row) => {
      if (!row.amount || parseFloat(row.amount) === 0) return;
      const exists = await pool.query(
        `SELECT id FROM project_cost_transactions
         WHERE reference_module=$1 AND reference_id=$2 AND company_id=$3
         LIMIT 1`,
        [row.reference_module, row.reference_id, companyId]
      ).catch(() => ({ rows: [] }));
      if (exists.rows.length) return;

      const ua = checkUnallocated(row);
      await pool.query(`
        INSERT INTO project_cost_transactions
          (company_id, customer_id, project_id, project_code, po_number, cost_center_id,
           cost_type, reference_module, reference_id, amount, transaction_date, description,
           is_unallocated, unallocated_reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        companyId, row.customer_id||null, row.project_id||null, row.project_code||null,
        row.po_number||null, row.cost_center_id||null,
        row.cost_type, row.reference_module, row.reference_id,
        row.amount, row.transaction_date||new Date().toISOString().slice(0,10),
        row.description||null, ua.is_unallocated, ua.unallocated_reason, uid(req),
      ]);
      captured.push({ module: row.reference_module, id: row.reference_id, amount: row.amount, cost_type: row.cost_type });
    };

    // TRAVEL — sales travel costs
    if (captureAll || modules.includes('travel')) {
      const { rows: travelRows } = await pool.query(`
        SELECT tr.id, tr.project_id, tr.total_amount AS amount,
               tr.purpose AS description, tr.created_at::date AS transaction_date,
               COALESCE(p.customer_name, p.client_name) AS customer_name,
               p.project_code
        FROM travel_requests tr
        LEFT JOIN projects p ON p.id=tr.project_id
        WHERE tr.status NOT IN ('Rejected','Cancelled')
          AND ($1::int IS NULL OR tr.company_id=$1)
          ${project_id ? 'AND tr.project_id=$2' : ''}
      `, project_id ? [companyId, project_id] : [companyId]).catch(() => ({ rows: [] }));

      for (const r of travelRows) {
        await capture({ ...r, cost_type: 'SALES_TRAVEL', reference_module: 'travel', reference_id: r.id });
      }
    }

    // PROCUREMENT — purchase orders
    if (captureAll || modules.includes('procurement')) {
      const { rows: poRows } = await pool.query(`
        SELECT po.id, po.project_id, po.total_amount AS amount,
               po.po_number, po.created_at::date AS transaction_date,
               po.notes AS description
        FROM purchase_orders po
        WHERE po.status NOT IN ('cancelled','rejected')
          AND ($1::int IS NULL OR po.company_id=$1)
          ${project_id ? 'AND po.project_id=$2' : ''}
      `, project_id ? [companyId, project_id] : [companyId]).catch(() => ({ rows: [] }));

      for (const r of poRows) {
        await capture({ ...r, cost_type: 'PROCUREMENT', reference_module: 'procurement', reference_id: r.id });
      }
    }

    // TIMESHEETS — engineering/labour
    if (captureAll || modules.includes('timesheets')) {
      const { rows: tsRows } = await pool.query(`
        SELECT te.id, te.project_id,
               COALESCE(te.hours, te.hours_worked, 0) * COALESCE(pm.billing_rate, 500) AS amount,
               te.work_date AS transaction_date,
               te.description
        FROM timesheet_entries te
        LEFT JOIN project_members pm ON pm.project_id=te.project_id AND pm.employee_id=te.employee_id
        WHERE te.deleted_at IS NULL
          AND ($1::int IS NULL OR te.company_id=$1)
          ${project_id ? 'AND te.project_id=$2' : ''}
      `, project_id ? [companyId, project_id] : [companyId]).catch(() => ({ rows: [] }));

      for (const r of tsRows) {
        await capture({ ...r, cost_type: 'ENGINEERING', reference_module: 'timesheets', reference_id: r.id });
      }
    }

    res.json({ captured_count: captured.length, captured });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REFERENCE DATA ─────────────────────────────────────────────────────────────
router.get('/reference/cost-types', async (_req, res) => {
  res.json(COST_TYPES.map(t => ({ value: t, label: t.replace(/_/g, ' ') })));
});

router.get('/reference/projects', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, project_code, project_name, COALESCE(customer_name, client_name) AS customer_name
       FROM projects WHERE ($1::int IS NULL OR company_id=$1) AND deleted_at IS NULL
       ORDER BY project_name LIMIT 500`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
