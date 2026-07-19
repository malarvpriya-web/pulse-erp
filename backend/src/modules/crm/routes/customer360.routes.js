// backend/src/modules/crm/routes/customer360.routes.js
import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import * as ctrl from '../customer360.controller.js';

// ── 49A Unified Customer 360 Intelligence Layer ───────────────────────────────
// GET /api/v1/crm/customer-360/:customerId          — full 360 in one call
// GET /api/v1/crm/customer-360/:customerId/timeline — unified timeline
// GET /api/v1/crm/customer-360/:customerId/health   — health engine
// GET /api/v1/crm/customer-360/:customerId/documents — document folder map
//
// customerId = parties.id (same as partyId used in legacy routes below)
// All queries enforce company_id scoping. Cache TTL = 60s (in-memory).
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

// ── Unified endpoints (49A) ───────────────────────────────────────────────────
router.get('/customer-360/:customerId',           requirePermission('crm', 'view'), ctrl.getCustomer360);
router.get('/customer-360/:customerId/timeline',  requirePermission('crm', 'view'), ctrl.getTimeline);
router.get('/customer-360/:customerId/health',    requirePermission('crm', 'view'), ctrl.getHealth);
router.get('/customer-360/:customerId/documents', requirePermission('crm', 'view'), ctrl.getDocuments);


function npsCategory(score) {
  if (score <= 6) return 'detractor';
  if (score <= 8) return 'passive';
  return 'promoter';
}

// ── GET /parties — customer picker list ───────────────────────────────────────
router.get('/parties', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];
    let extra = '';
    if (search) {
      params.push(`%${search}%`);
      extra = `AND (name ILIKE $1 OR gstin ILIKE $1)`;
    }
    const r = await pool.query(
      `SELECT id, name, city, state, email, phone, gstin, type
       FROM parties
       WHERE (type = 'customer' OR type IS NULL) ${extra}
       ORDER BY name LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /customer360/:partyId — core profile + financial summary ──────────────
router.get('/customer360/:partyId', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;

  let party = null;
  try {
    const r = await pool.query('SELECT * FROM parties WHERE id = $1', [partyId]);
    if (r.rows.length > 0) party = r.rows[0];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!party) return res.status(404).json({ error: 'Customer not found' });

  let invoices = [], contacts = [], crmEmails = [], accountData = null;

  try {
    const r = await pool.query(
      `SELECT id, invoice_number, total_amount, status, created_at, due_date
       FROM invoices WHERE party_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    invoices = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT a.id, a.account_name, a.account_type, a.industry, a.website,
              a.annual_revenue, a.credit_limit, a.owner_id, a.status,
              a.billing_street, a.billing_city, a.billing_state, a.billing_country,
              e.name AS account_manager_name
       FROM accounts a
       LEFT JOIN employees e ON e.id = a.owner_id
       WHERE a.party_id = $1 AND a.deleted_at IS NULL
       LIMIT 1`,
      [partyId]
    );
    if (r.rows.length) accountData = r.rows[0];
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT c.id, c.first_name, c.last_name,
              CONCAT(c.first_name, ' ', c.last_name) AS full_name,
              c.title, c.email, c.phone, c.department,
              c.contact_type, c.created_at
       FROM contacts c
       JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
       WHERE a.party_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.first_name, c.last_name`,
      [partyId]
    );
    contacts = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT ce.id, ce.subject, ce.status, ce.sent_at
       FROM crm_emails ce
       JOIN accounts a ON a.id = ce.account_id AND a.deleted_at IS NULL
       WHERE a.party_id = $1
       ORDER BY ce.sent_at DESC LIMIT 20`,
      [partyId]
    );
    crmEmails = r.rows;
  } catch (_) {}

  const unpaid = invoices.filter(i => i.status !== 'paid');
  const paid   = invoices.filter(i => i.status === 'paid');
  const outstanding_balance = unpaid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);
  const total_revenue       = paid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);

  let avg_days_to_pay = 0;
  try {
    const r = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400))::int AS avg_days
       FROM invoices
       WHERE party_id = $1 AND status = 'paid' AND updated_at > created_at`,
      [partyId]
    );
    avg_days_to_pay = parseInt(r.rows[0]?.avg_days || 0);
  } catch (_) {}

  const thisYear = new Date().getFullYear();

  res.json({
    party,
    account: accountData,
    invoices,
    contacts,
    crm_emails: crmEmails,
    outstanding_balance,
    total_revenue,
    avg_days_to_pay,
    total_invoices: invoices.length,
    lifetime_value: total_revenue + outstanding_balance,
    avg_order_value: invoices.length > 0 ? (total_revenue + outstanding_balance) / invoices.length : 0,
    orders_this_year: invoices.filter(i => new Date(i.created_at).getFullYear() === thisYear).length,
  });
});

// ── GET /customer360/:partyId/pipeline — sales pipeline summary ───────────────
router.get('/customer360/:partyId/pipeline', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let leads = [], opportunities = [], quotations = [], salesOrders = [];

  try {
    const r = await pool.query(
      `SELECT l.id, l.company_name, l.contact_person, l.status, l.lead_source,
              l.created_at, e.name AS assigned_to_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE l.email IN (SELECT email FROM parties WHERE id = $1)
          OR l.company_name ILIKE (SELECT '%' || name || '%' FROM parties WHERE id = $1)
       ORDER BY l.created_at DESC LIMIT 20`,
      [partyId]
    );
    leads = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT o.id, o.opportunity_name, o.expected_value, o.probability_percentage,
              o.stage, o.expected_closing_date, o.created_at,
              e.name AS assigned_to_name
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to
       WHERE o.lead_id IN (
         SELECT l.id FROM leads l WHERE l.email IN (SELECT email FROM parties WHERE id = $1)
       )
       ORDER BY o.created_at DESC`,
      [partyId]
    );
    opportunities = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, quotation_number, quotation_date, validity_date,
              status, total_amount, notes, created_at
       FROM quotations
       WHERE customer_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [partyId]
    );
    quotations = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, order_number, order_date, delivery_date,
              order_status AS status, total_amount, created_at
       FROM sales_orders
       WHERE customer_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [partyId]
    );
    salesOrders = r.rows;
  } catch (_) {}

  const totalPipeline = opportunities
    .filter(o => !['won','lost'].includes((o.stage||'').toLowerCase()))
    .reduce((s, o) => s + parseFloat(o.expected_value || 0), 0);
  const wonValue = opportunities
    .filter(o => (o.stage||'').toLowerCase() === 'won')
    .reduce((s, o) => s + parseFloat(o.expected_value || 0), 0);
  const wonCount = opportunities.filter(o => (o.stage||'').toLowerCase() === 'won').length;
  const totalQuoted = quotations.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0);
  const acceptedQuotes = quotations.filter(q => q.status === 'accepted').length;
  const winRate = opportunities.length > 0
    ? Math.round((wonCount / opportunities.length) * 100)
    : 0;

  res.json({
    leads,
    opportunities,
    quotations,
    sales_orders: salesOrders,
    summary: {
      lead_count: leads.length,
      opportunity_count: opportunities.length,
      quotation_count: quotations.length,
      po_count: salesOrders.length,
      total_pipeline_value: totalPipeline,
      won_value: wonValue,
      won_count: wonCount,
      total_quoted: totalQuoted,
      accepted_quotes: acceptedQuotes,
      win_rate: winRate,
    },
  });
});

// ── GET /customer360/:partyId/projects — all projects ─────────────────────────
router.get('/customer360/:partyId/projects', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let projects = [];

  try {
    const r = await pool.query(
      `SELECT p.id, p.project_code, p.project_name, p.status,
              p.start_date, p.end_date, p.budget_amount, p.health_score,
              p.billing_model, p.project_type, p.created_at,
              e.name AS project_manager_name,
              COALESCE(
                (SELECT SUM(actual_cost) FROM project_cost_summary WHERE project_id = p.id), 0
              ) AS actual_cost,
              (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = p.id) AS milestone_count,
              (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = p.id AND pm.status = 'completed') AS milestones_done
       FROM projects p
       LEFT JOIN employees e ON e.id = p.project_manager_id
       WHERE p.customer_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC`,
      [partyId]
    );
    projects = r.rows;
  } catch (_) {}

  // Fetch milestones for each project
  const projectIds = projects.map(p => p.id);
  let milestones = [];
  if (projectIds.length > 0) {
    try {
      const r = await pool.query(
        `SELECT id, project_id, milestone_name, due_date, status, amount
         FROM project_milestones
         WHERE project_id = ANY($1)
         ORDER BY due_date ASC`,
        [projectIds]
      );
      milestones = r.rows;
    } catch (_) {}
  }

  // Lifecycle stages per project
  let lifecycle = [];
  if (projectIds.length > 0) {
    try {
      const r = await pool.query(
        `SELECT * FROM lifecycle_instances
         WHERE project_id = ANY($1) OR sales_order_id IN (
           SELECT id FROM sales_orders WHERE customer_id = $2
         )`,
        [projectIds, partyId]
      );
      lifecycle = r.rows;
    } catch (_) {}
  }

  const projectsWithMilestones = projects.map(p => ({
    ...p,
    milestones: milestones.filter(m => m.project_id === p.id),
    lifecycle: lifecycle.find(l => l.project_id === p.id) || null,
  }));

  const totalBudget = projects.reduce((s, p) => s + parseFloat(p.budget_amount || 0), 0);
  const totalActual = projects.reduce((s, p) => s + parseFloat(p.actual_cost || 0), 0);

  res.json({
    projects: projectsWithMilestones,
    summary: {
      total_projects: projects.length,
      active_projects: projects.filter(p => p.status === 'active').length,
      completed_projects: projects.filter(p => p.status === 'completed').length,
      total_budget: totalBudget,
      total_actual_cost: totalActual,
      margin: totalBudget > 0 ? Math.round(((totalBudget - totalActual) / totalBudget) * 100) : 0,
    },
  });
});

// ── GET /customer360/:partyId/service — tickets & service contracts ───────────
router.get('/customer360/:partyId/service', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let tickets = [], serviceContracts = [], fieldVisits = [];

  try {
    const r = await pool.query(
      `SELECT id, subject, priority, status, created_at, resolved_at, description,
              CASE WHEN resolved_at IS NOT NULL
                THEN EXTRACT(DAY FROM (resolved_at - created_at))::int
                ELSE NULL END AS resolution_days
       FROM support_tickets
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    tickets = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, contract_number, start_date, end_date, status,
              contract_value, coverage_type, created_at
       FROM service_contracts
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    serviceContracts = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT fv.id, fv.visit_date, fv.status, fv.purpose, fv.notes,
              e.name AS engineer_name
       FROM field_service_visits fv
       LEFT JOIN employees e ON e.id = fv.engineer_id
       WHERE fv.customer_id = $1
       ORDER BY fv.visit_date DESC LIMIT 20`,
      [partyId]
    );
    fieldVisits = r.rows;
  } catch (_) {}

  const openTickets   = tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed');
  const closedTickets = tickets.filter(t => t.status === 'resolved' || t.status === 'closed');
  const avgRes = closedTickets.length > 0
    ? Math.round(closedTickets.reduce((s, t) => s + (t.resolution_days || 0), 0) / closedTickets.length)
    : 0;

  res.json({
    tickets,
    service_contracts: serviceContracts,
    field_visits: fieldVisits,
    summary: {
      open_tickets: openTickets.length,
      closed_tickets: closedTickets.length,
      total_visits: fieldVisits.length,
      avg_resolution_days: avgRes,
      critical_open: openTickets.filter(t => t.priority === 'critical').length,
    },
  });
});

// ── GET /customer360/:partyId/amc — AMC contracts ─────────────────────────────
router.get('/customer360/:partyId/amc', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let amcContracts = [], warrantyRecords = [];

  try {
    const r = await pool.query(
      `SELECT id, contract_number, start_date, end_date, renewal_date,
              status, coverage_type, annual_value, total_value, notes, created_at
       FROM amc_contracts
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    amcContracts = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, serial_number, product_name, warranty_start, warranty_end,
              warranty_type, status, notes, created_at
       FROM warranty_register
       WHERE customer_id = $1
       ORDER BY warranty_end ASC`,
      [partyId]
    );
    warrantyRecords = r.rows;
  } catch (_) {}

  const now = new Date();
  const activeAMC   = amcContracts.filter(a => a.status === 'active');
  const expiringIn90 = amcContracts.filter(a => {
    if (!a.end_date) return false;
    const diff = (new Date(a.end_date) - now) / (1000 * 86400);
    return diff >= 0 && diff <= 90;
  });
  const totalAMCRevenue = amcContracts.reduce((s, a) => s + parseFloat(a.annual_value || 0), 0);

  res.json({
    amc_contracts: amcContracts,
    warranty_records: warrantyRecords,
    summary: {
      total_contracts: amcContracts.length,
      active_contracts: activeAMC.length,
      expiring_soon: expiringIn90.length,
      total_amc_revenue: totalAMCRevenue,
    },
  });
});

// ── GET /customer360/:partyId/manufacturing — production orders ───────────────
router.get('/customer360/:partyId/manufacturing', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let productionOrders = [], fatRecords = [], ncrs = [], bomList = [];

  try {
    const r = await pool.query(
      `SELECT po.id, po.order_number, po.status, po.planned_start, po.planned_end,
              po.quantity_planned, po.quantity_produced, po.work_centre_id,
              po.created_at, bh.bom_code, bh.product_name
       FROM production_orders po
       LEFT JOIN bom_headers bh ON bh.id = po.bom_id
       WHERE po.sales_order_id IN (
         SELECT id FROM sales_orders WHERE customer_id = $1
       )
       ORDER BY po.created_at DESC`,
      [partyId]
    );
    productionOrders = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, report_number, status, scheduled_date, completed_date,
              witness_name, result, notes, created_at
       FROM fat_reports
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    fatRecords = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT bh.id, bh.bom_code, bh.product_name, bh.revision,
              bh.status, bh.created_at
       FROM bom_headers bh
       WHERE bh.id IN (
         SELECT DISTINCT bom_id FROM production_orders
         WHERE sales_order_id IN (
           SELECT id FROM sales_orders WHERE customer_id = $1
         )
       )
       ORDER BY bh.created_at DESC`,
      [partyId]
    );
    bomList = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, ncr_number, description, status, severity, created_at
       FROM non_conformance_reports
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    ncrs = r.rows;
  } catch (_) {}

  res.json({
    production_orders: productionOrders,
    fat_records: fatRecords,
    ncrs,
    boms: bomList,
    summary: {
      total_production_orders: productionOrders.length,
      fat_count: fatRecords.length,
      ncr_count: ncrs.length,
      bom_count: bomList.length,
      open_ncrs: ncrs.filter(n => n.status !== 'closed').length,
    },
  });
});

// ── GET /customer360/:partyId/commissioning — commissioning & dispatch ─────────
router.get('/customer360/:partyId/commissioning', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let commReports = [], satReports = [], dispatches = [];

  try {
    const r = await pool.query(
      `SELECT id, report_number, status, commissioning_date, engineer_id,
              site_location, notes, acceptance_status, created_at
       FROM commissioning_reports
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    commReports = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, report_number, status, sat_date, witness_name,
              result, notes, created_at
       FROM sat_reports
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    satReports = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, dispatch_number, dispatch_date, status,
              transport_mode, tracking_number, delivery_date,
              vehicle_number, driver_name, created_at
       FROM dispatch_records
       WHERE customer_id = $1
       ORDER BY dispatch_date DESC`,
      [partyId]
    );
    dispatches = r.rows;
  } catch (_) {}

  res.json({
    commissioning_reports: commReports,
    sat_reports: satReports,
    dispatch_records: dispatches,
    summary: {
      commissioning_count: commReports.length,
      sat_count: satReports.length,
      dispatch_count: dispatches.length,
      pending_commissioning: commReports.filter(c => c.status === 'pending').length,
      accepted_sat: satReports.filter(s => s.result === 'accepted' || s.status === 'completed').length,
    },
  });
});

// ── GET /customer360/:partyId/health-score ────────────────────────────────────
router.get('/customer360/:partyId/health-score', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;

  let overdueCount = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM invoices WHERE party_id = $1 AND status = 'overdue'`,
      [partyId]
    );
    overdueCount = r.rows[0]?.cnt || 0;
  } catch (_) {}
  const payment_score = Math.max(0, 25 - overdueCount * 5);

  let emailCount = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM crm_emails
       WHERE account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)`,
      [partyId]
    );
    emailCount = r.rows[0]?.cnt || 0;
  } catch (_) {}
  const engagement_score =
    emailCount >= 10 ? 25 :
    emailCount >= 4  ? 20 :
    emailCount >= 1  ? 10 : 0;

  let recentOrders = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM invoices
       WHERE party_id = $1 AND created_at >= NOW() - INTERVAL '12 months'`,
      [partyId]
    );
    recentOrders = r.rows[0]?.cnt || 0;
  } catch (_) {}
  const order_frequency_score =
    recentOrders >= 12 ? 25 :
    recentOrders >= 6  ? 20 :
    recentOrders >= 3  ? 15 :
    recentOrders >= 1  ? 10 : 0;

  let unresolvedCritical = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM support_tickets
       WHERE customer_id = $1 AND status != 'resolved' AND priority = 'critical'`,
      [partyId]
    );
    unresolvedCritical = r.rows[0]?.cnt || 0;
  } catch (_) {}
  const support_score = Math.max(0, 25 - unresolvedCritical * 8);

  const total = payment_score + engagement_score + order_frequency_score + support_score;
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : 'D';
  const churn_risk = (grade === 'A' || grade === 'B') ? 'low' : grade === 'C' ? 'medium' : 'high';
  const label = total >= 90 ? 'Excellent' : total >= 75 ? 'Good' : total >= 60 ? 'Watchlist' : 'At Risk';

  res.json({
    score: total,
    grade,
    label,
    churn_risk,
    breakdown: { payment_score, engagement_score, order_frequency_score, support_score },
  });
});

// ── GET /customer360/:partyId/timeline — full chronological timeline ───────────
router.get('/customer360/:partyId/timeline', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  const events = [];

  try {
    const r = await pool.query(
      `SELECT ce.id, ce.subject, ce.sent_at, ce.status
       FROM crm_emails ce
       WHERE ce.account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)
       ORDER BY ce.sent_at DESC LIMIT 30`,
      [partyId]
    );
    r.rows.forEach(e => events.push({
      type: 'email', title: e.subject || 'Email', date: e.sent_at, status: e.status, icon: '✉',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, invoice_number, total_amount, status, created_at
       FROM invoices WHERE party_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(inv => events.push({
      type: 'invoice', title: `Invoice ${inv.invoice_number}`, date: inv.created_at,
      amount: parseFloat(inv.total_amount), status: inv.status, icon: '🧾',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, subject, priority, status, created_at
       FROM support_tickets WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [partyId]
    );
    r.rows.forEach(t => events.push({
      type: 'ticket', title: t.subject || `Ticket #${t.id}`, date: t.created_at,
      status: t.status, icon: '🎫',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, order_number, total_amount, order_status AS status, created_at
       FROM sales_orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(o => events.push({
      type: 'order', title: `PO ${o.order_number || o.id}`, date: o.created_at,
      amount: parseFloat(o.total_amount), status: o.status, icon: '📦',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, quotation_number, total_amount, status, created_at
       FROM quotations WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(q => events.push({
      type: 'quotation', title: `Quotation ${q.quotation_number}`, date: q.created_at,
      amount: parseFloat(q.total_amount), status: q.status, icon: '📋',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, project_code, project_name, status, created_at
       FROM projects WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(p => events.push({
      type: 'project', title: `Project: ${p.project_name}`, date: p.created_at,
      status: p.status, icon: '🏗',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, report_number, acceptance_status AS status, commissioning_date AS date, created_at
       FROM commissioning_reports WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(c => events.push({
      type: 'commissioning', title: `Commissioning ${c.report_number || c.id}`,
      date: c.date || c.created_at, status: c.status, icon: '⚙',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT id, contract_number, start_date, status, created_at
       FROM amc_contracts WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(a => events.push({
      type: 'amc', title: `AMC ${a.contract_number}`, date: a.created_at,
      status: a.status, icon: '🔄',
    }));
  } catch (_) {}

  events.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  res.json(events.slice(0, 80));
});

// ── GET /customer360/:partyId/tickets ─────────────────────────────────────────
router.get('/customer360/:partyId/tickets', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, subject, priority, status, created_at, resolved_at,
              CASE WHEN resolved_at IS NOT NULL
                THEN EXTRACT(DAY FROM (resolved_at - created_at))::int
                ELSE NULL END AS resolution_days
       FROM support_tickets WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.params.partyId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /customer360/:partyId/payments ────────────────────────────────────────
router.get('/customer360/:partyId/payments', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT amount, mode, reference AS ref, payment_date AS date
       FROM customer_payments WHERE party_id = $1 ORDER BY payment_date DESC`,
      [req.params.partyId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /customer360/:partyId/aging ───────────────────────────────────────────
router.get('/customer360/:partyId/aging', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT total_amount, created_at
       FROM invoices WHERE party_id = $1 AND status IN ('overdue','pending')`,
      [req.params.partyId]
    );
    const buckets = { 'Current': 0, '1–30 days': 0, '31–60 days': 0, '61–90 days': 0, '90+ days': 0 };
    const now = Date.now();
    r.rows.forEach(inv => {
      const days = Math.floor((now - new Date(inv.created_at)) / 86400000);
      const amt  = parseFloat(inv.total_amount || 0);
      if (days <= 0)       buckets['Current']    += amt;
      else if (days <= 30) buckets['1–30 days']  += amt;
      else if (days <= 60) buckets['31–60 days'] += amt;
      else if (days <= 90) buckets['61–90 days'] += amt;
      else                 buckets['90+ days']   += amt;
    });
    res.json(
      Object.entries(buckets)
        .filter(([, v]) => v > 0)
        .map(([range, amount]) => ({ range, amount }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /customer360/:partyId/drive-folders — Google Drive folder structure ────
router.get('/customer360/:partyId/drive-folders', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query('SELECT name, city FROM parties WHERE id = $1', [req.params.partyId]);
    const party = r.rows[0];
    if (!party) return res.status(404).json({ error: 'Customer not found' });

    const folderName = party.name.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
    const structure = {
      root: `Customers/${folderName}`,
      folders: [
        { id: '01', name: '01 Opportunities',         description: 'Lead and opportunity documents' },
        { id: '02', name: '02 Quotations',            description: 'All quotation revisions' },
        { id: '03', name: '03 Purchase Orders',       description: 'Customer PO documents' },
        { id: '04', name: '04 Contracts',             description: 'Signed contracts & agreements' },
        { id: '05', name: '05 Drawings',              description: 'Engineering drawings & revisions' },
        { id: '06', name: '06 BOM',                   description: 'Bill of Materials revisions' },
        { id: '07', name: '07 FAT Reports',           description: 'Factory Acceptance Test reports' },
        { id: '08', name: '08 SAT Reports',           description: 'Site Acceptance Test reports' },
        { id: '09', name: '09 Commissioning Reports', description: 'Commissioning documentation' },
        { id: '10', name: '10 Service Reports',       description: 'Service visit & maintenance reports' },
        { id: '11', name: '11 AMC',                   description: 'AMC contracts & renewals' },
        { id: '12', name: '12 Invoices',              description: 'All customer invoices' },
        { id: '13', name: '13 Correspondence',        description: 'Email & letter correspondence' },
      ],
    };
    res.json(structure);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /nps ─────────────────────────────────────────────────────────────────
router.post('/nps', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const { customer_id, customer_name, score, comment, survey_date } = req.body;
    if (score === undefined || score < 0 || score > 10)
      return res.status(400).json({ error: 'Score must be between 0 and 10' });
    const r = await pool.query(
      `INSERT INTO nps_responses (customer_id, customer_name, score, comment, survey_date, category)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [customer_id, customer_name || null, score, comment || null,
       survey_date || new Date().toISOString().split('T')[0], npsCategory(score)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /nps/summary ──────────────────────────────────────────────────────────
router.get('/nps/summary', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT category, COUNT(*)::int AS count FROM nps_responses GROUP BY category`
    );
    let promoters = 0, passives = 0, detractors = 0, total = 0;
    r.rows.forEach(row => {
      total += row.count;
      if (row.category === 'promoter') promoters += row.count;
      else if (row.category === 'passive') passives += row.count;
      else detractors += row.count;
    });
    const promoters_pct  = total > 0 ? Math.round((promoters  / total) * 100) : 0;
    const passives_pct   = total > 0 ? Math.round((passives   / total) * 100) : 0;
    const detractors_pct = total > 0 ? Math.round((detractors / total) * 100) : 0;
    const nps_score      = promoters_pct - detractors_pct;

    let monthly_trend = [];
    try {
      const tr = await pool.query(`
        SELECT TO_CHAR(survey_date, 'Mon YYYY') AS month,
               DATE_TRUNC('month', survey_date) AS month_start,
               SUM(CASE WHEN category='promoter'  THEN 1 ELSE 0 END)::int AS p,
               SUM(CASE WHEN category='detractor' THEN 1 ELSE 0 END)::int AS d,
               COUNT(*)::int AS t
        FROM nps_responses
        WHERE survey_date >= NOW() - INTERVAL '6 months'
        GROUP BY month, month_start ORDER BY month_start
      `);
      monthly_trend = tr.rows.map(row => ({
        month: row.month,
        nps: row.t > 0 ? Math.round(((row.p - row.d) / row.t) * 100) : 0,
      }));
    } catch (_) {}

    res.json({ nps_score, promoters_pct, passives_pct, detractors_pct, total_responses: total, monthly_trend });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /nps/responses ────────────────────────────────────────────────────────
router.get('/nps/responses', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT nr.*, COALESCE(p.name, nr.customer_name, 'Unknown') AS customer_name
      FROM nps_responses nr
      LEFT JOIN parties p ON p.id = nr.customer_id
      ORDER BY nr.survey_date DESC LIMIT 100
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /customer360/:partyId/tenders — tender/bid tracking ───────────────────
router.get('/customer360/:partyId/tenders', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  let tenders = [];

  // opportunities with tender_number set, linked via lead email match or account
  try {
    const r = await pool.query(
      `SELECT o.id, o.opportunity_name, o.tender_number, o.tender_source,
              o.expected_value, o.probability_percentage, o.stage,
              o.submission_deadline, o.bid_type,
              o.emd_amount, o.emd_status,
              o.loa_received, o.loa_date, o.loa_amount,
              o.expected_closing_date, o.created_at,
              e.name AS assigned_to_name
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to
       WHERE o.tender_number IS NOT NULL
         AND (
           o.lead_id IN (
             SELECT l.id FROM leads l
             WHERE l.email IN (SELECT email FROM parties WHERE id = $1)
                OR l.company_name ILIKE (SELECT '%' || name || '%' FROM parties WHERE id = $1)
           )
           OR o.account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)
         )
       ORDER BY o.created_at DESC`,
      [partyId]
    );
    tenders = r.rows;
  } catch (_) {}

  const won   = tenders.filter(t => (t.stage || '').toLowerCase() === 'won');
  const lost  = tenders.filter(t => (t.stage || '').toLowerCase() === 'lost');
  const live  = tenders.filter(t => !['won','lost'].includes((t.stage || '').toLowerCase()));
  const totalBid = tenders.reduce((s, t) => s + parseFloat(t.expected_value || 0), 0);
  const wonValue  = won.reduce((s, t) => s + parseFloat(t.loa_amount || t.expected_value || 0), 0);

  res.json({
    tenders,
    summary: {
      total: tenders.length,
      live: live.length,
      won: won.length,
      lost: lost.length,
      total_bid_value: totalBid,
      won_value: wonValue,
      strike_rate: tenders.length > 0 ? Math.round((won.length / tenders.length) * 100) : 0,
    },
  });
});

// ── GET /customer360/:partyId/travel — travel cost breakdown ──────────────────
router.get('/customer360/:partyId/travel', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;

  let salesVisits = [], projectTravel = [], customerVisitsList = [];

  // Customer visits (sales/pre-sales travel)
  try {
    const r = await pool.query(
      `SELECT cv.id, cv.visit_date, cv.visit_type, cv.purpose, cv.location,
              cv.discussion_notes, cv.next_followup_date,
              e.name AS visited_by_name
       FROM customer_visits cv
       LEFT JOIN employees e ON e.id = cv.visited_by
       WHERE cv.customer_id = $1
       ORDER BY cv.visit_date DESC LIMIT 30`,
      [partyId]
    );
    customerVisitsList = r.rows;
  } catch (_) {}

  // Project-linked travel (commissioning/engineering travel)
  try {
    const r = await pool.query(
      `SELECT tr.id, tr.request_number, tr.travel_type, tr.from_date, tr.to_date,
              tr.purpose, tr.status, tr.budget, tr.actual_cost, tr.destination,
              p.project_code, p.project_name
       FROM travel_requests tr
       JOIN projects p ON p.id = tr.project_id
       WHERE p.customer_id = $1
         AND tr.status IN ('approved','completed')
       ORDER BY tr.from_date DESC LIMIT 50`,
      [partyId]
    );
    projectTravel = r.rows;
  } catch (_) {}

  // Summarise by travel type
  const byType = {};
  projectTravel.forEach(t => {
    const key = t.travel_type || 'General';
    if (!byType[key]) byType[key] = { type: key, trips: 0, cost: 0 };
    byType[key].trips += 1;
    byType[key].cost  += parseFloat(t.actual_cost || t.budget || 0);
  });

  const totalProjectTravel = projectTravel.reduce((s, t) => s + parseFloat(t.actual_cost || t.budget || 0), 0);

  res.json({
    customer_visits: customerVisitsList,
    project_travel: projectTravel,
    by_type: Object.values(byType),
    summary: {
      total_visits: customerVisitsList.length,
      total_project_trips: projectTravel.length,
      total_travel_cost: totalProjectTravel,
    },
  });
});

export default router;
