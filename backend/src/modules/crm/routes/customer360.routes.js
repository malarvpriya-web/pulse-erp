// backend/src/modules/crm/routes/customer360.routes.js
import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';
import { respondError } from '../../../shared/pgErrors.js';

// ── Customer 360 ──────────────────────────────────────────────────────────────
// The party-keyed endpoints below (`/customer360/:partyId/*`) are the live ones —
// they are what Customer360.jsx calls.
//
// REMOVED (audit C-20): a second set of `/customer-360/:customerId` routes and
// the customer360.controller → service → repository stack behind them. Those
// were unreachable dead code: routes/index.js mounts crm.routes.js BEFORE this
// file, and crm.routes.js registers `/customer-360/:accountId`, which Express
// matches first for every request to that path. ~1,000 lines that could never
// execute, and whose SQL referenced six tables that do not exist
// (fat_reports, sat_reports, warranty_register, dispatch_records,
// field_service_visits, crm_activities-as-was) plus several phantom columns on
// accounts/contacts/projects — all of which sat in the CI baseline as
// permanently-accepted debt because nothing could ever run them.
//
// If a unified party-keyed 360 is wanted again, add it here and give it a path
// that does not collide with crm.routes.js.
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

// ── Tenant gate for every /customer360/:partyId* route ────────────────────────
// These endpoints take a customer id straight from the URL and, before this
// guard, went to the database with it unfiltered: `SELECT * FROM parties WHERE
// id = $1`, `... FROM invoices WHERE customer_id = $1`, and so on across 19
// routes. A company-1 token reading a company-29 party id got 200 and that
// company's data back — proven with a synthetic tenant: `/customer360/:id`
// returned the foreign customer's profile and `/aging` returned their
// ₹99,99,999 receivable.
//
// The earlier remediation scoped `/customer-360/:accountId` in crm.routes.js,
// but that route is the shadowed legacy one. These party-keyed routes are what
// Customer360.jsx actually calls, and they were never covered.
//
// `router.param` runs once per request carrying `:partyId`, so a route added
// below inherits the check instead of having to remember it. `companyOf(req)`
// returning null means genuinely global scope (super_admin without a company),
// which stays unrestricted — the same convention as the `$n::int IS NULL OR
// company_id = $n` clauses elsewhere in CRM.
router.param('partyId', async (req, res, next, partyId) => {
  // A malformed uuid would otherwise reach the query and surface as 22P02.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partyId)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  const cid = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, company_id FROM parties
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [partyId, cid]
    );
    // Deliberately 404, not 403: whether a customer id exists in another tenant
    // is itself information this caller is not entitled to.
    if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
    req.party = rows[0];
    next();
  } catch (e) {
    respondError(res, e);
  }
});

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
    // The column is `party_type`, not `type` — this selected and filtered on a
    // column that does not exist, so the endpoint 500'd on every call and the
    // Customer 360 customer picker could never load (audit C-12). Also had no
    // company filter, which would have leaked the full customer list across
    // tenants the moment it started working.
    const cid = companyOf(req);
    params.push(cid);
    const cidParam = `$${params.length}`;
    const r = await pool.query(
      `SELECT id, name, city, state, email, phone, gstin, party_type AS type
       FROM parties
       WHERE deleted_at IS NULL
         AND (LOWER(party_type) = 'customer' OR party_type IS NULL)
         AND (${cidParam}::int IS NULL OR company_id = ${cidParam})
         ${extra}
       ORDER BY name LIMIT 200`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    respondError(res, e);
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
       FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    invoices = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      // credit_limit and the billing_* address fields live on `parties`, the
      // canonical customer master — they were never columns on `accounts`, so
      // this whole SELECT threw 42703 and the empty catch below turned the
      // account panel into a permanent blank (audit C-31). Ownership is
      // `assigned_to` on accounts; `owner_id` never existed either.
      `SELECT a.id, a.account_name, a.account_type, a.industry, a.website,
              a.annual_revenue, a.status, a.assigned_to AS owner_id,
              p.credit_limit,
              p.address AS billing_street, p.city AS billing_city,
              p.state   AS billing_state,  p.country AS billing_country,
              e.name AS account_manager_name
       FROM accounts a
       LEFT JOIN parties   p ON p.id = a.party_id
       LEFT JOIN employees e ON e.id = a.assigned_to
       WHERE a.party_id = $1 AND a.deleted_at IS NULL
       LIMIT 1`,
      [partyId]
    );
    if (r.rows.length) accountData = r.rows[0];
  } catch (_) {}

  try {
    // contact_type never existed as a column; the schema's equivalent is
    // customer_role (User/Admin). Selecting the phantom name threw 42703 and the
    // empty catch below rendered the contacts panel permanently blank.
    const r = await pool.query(
      `SELECT c.id, c.first_name, c.last_name,
              CONCAT(c.first_name, ' ', c.last_name) AS full_name,
              c.title, c.email, c.phone, c.department,
              c.customer_role AS contact_type, c.is_primary, c.created_at
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

  const unpaid = invoices.filter(i => String(i.status).toLowerCase() !== 'paid');
  const paid   = invoices.filter(i => String(i.status).toLowerCase() === 'paid');
  const outstanding_balance = unpaid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);
  const total_revenue       = paid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);

  let avg_days_to_pay = 0;
  try {
    const r = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400))::int AS avg_days
       FROM invoices
       WHERE customer_id = $1 AND LOWER(status) = 'paid' AND updated_at > created_at`,
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
                (SELECT SUM(total_cost) FROM project_cost_summary WHERE project_id = p.id), 0
              ) AS actual_cost,
              (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = p.id) AS milestone_count,
              (SELECT COUNT(*)::int FROM project_milestones pm WHERE pm.project_id = p.id AND pm.status = 'completed') AS milestones_done
       FROM projects p
       LEFT JOIN employees e ON e.id = p.project_manager_id
       LEFT JOIN opportunities o ON o.id = p.opportunity_id
       LEFT JOIN accounts     a ON a.id = o.account_id AND a.deleted_at IS NULL
       LEFT JOIN parties      pt ON pt.id = $1
       WHERE p.deleted_at IS NULL
         AND ( a.party_id = $1
               OR (pt.id IS NOT NULL AND crm_norm_name(p.customer_name) = crm_norm_name(pt.name)) )
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

  // None of these three tables has a working direct link to `parties.id`
  // (this route's `partyId`) — all three previously queried a `customer_id`
  // column/table that either doesn't exist or is 100% unpopulated (verified
  // live: support_tickets.customer_id and .contact_id, accounts.party_id are
  // all NULL on every row), so every query here threw and was silently
  // swallowed by the catch, leaving this whole tab permanently empty.
  // support_tickets does have a real `contact_id` FK chain
  // (contacts.account_id -> accounts.party_id) even though it's unpopulated
  // today; service_contracts/field_visits have no FK at all, only free-text
  // `customer_name`, so those fall back to a best-effort name match against
  // `parties.name` (same discipline as the vendor/bill party-match fixes
  // elsewhere in this codebase — see [[project_enterprise_workflow_audit]]).
  try {
    const r = await pool.query(
      `SELECT st.id, st.title AS subject, st.priority, st.status, st.created_at, st.resolved_at, st.description,
              CASE WHEN st.resolved_at IS NOT NULL
                THEN EXTRACT(DAY FROM (st.resolved_at - st.created_at))::int
                ELSE NULL END AS resolution_days
       FROM support_tickets st
       LEFT JOIN contacts c ON c.id = st.contact_id
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE a.party_id = $1
       ORDER BY st.created_at DESC`,
      [partyId]
    );
    tickets = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      // service_contracts carries no contract_number column — selecting it threw
      // 42703 and blanked the panel. The table's own identifier is its id, so a
      // readable reference is synthesised from that.
      `SELECT sc.id, ('SC-' || sc.id::text) AS contract_number,
              sc.start_date, sc.end_date, sc.status,
              sc.value AS contract_value, sc.contract_type AS coverage_type, sc.created_at
       FROM service_contracts sc
       JOIN parties p ON LOWER(sc.customer_name) = LOWER(p.name)
       WHERE p.id = $1
       ORDER BY sc.created_at DESC`,
      [partyId]
    );
    serviceContracts = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT fv.id, fv.visit_date, fv.status, fv.purpose, fv.notes,
              e.name AS engineer_name
       FROM field_visits fv
       JOIN parties p ON LOWER(fv.customer_name) = LOWER(p.name)
       LEFT JOIN employees e ON e.id = fv.engineer_id
       WHERE p.id = $1
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
    // amc_contracts has no customer_id column at all (it links to a customer
    // only indirectly, via sales_order_id/lifecycle_instance_id/project_id) —
    // this queried columns (customer_id, coverage_type, annual_value,
    // total_value) that don't exist on the live table, 500ing this tab on
    // every call. lifecycle_instances.customer_id is a legacy `integer` (not
    // parties.id uuid) so it's not usable here; resolve via sales_orders,
    // the one linked table with a real uuid customer_id.
    const r = await pool.query(
      `SELECT ac.id, ac.contract_number, ac.start_date, ac.end_date, ac.renewal_date,
              ac.status, ac.scope_of_work AS coverage_type,
              ac.contract_value AS annual_value, ac.contract_value AS total_value,
              ac.coverage_notes AS notes, ac.created_at
       FROM amc_contracts ac
       JOIN sales_orders so ON so.id = ac.sales_order_id
       WHERE so.customer_id = $1
       ORDER BY ac.created_at DESC`,
      [partyId]
    );
    amcContracts = r.rows;
  } catch (_) {}

  try {
    // Same class of bug as amc_contracts above: wrong table name
    // (warranty_register -> warranty_registrations) plus a customer_id that's
    // a legacy, 100%-unpopulated `integer` on this table — resolved instead
    // via sales_order_id, the same real uuid link used for amc_contracts.
    // Unified Warranty Engine (Priority 3): commissioning-activated warranties
    // carry equipment_id, not sales_order_id — added a second path through
    // customer_equipment.crm_account_id -> accounts.party_id (the same bridge
    // Priority 2's upsell-to-opportunity work uses) so those show up here too,
    // deduplicated since a row could theoretically satisfy both paths.
    const r = await pool.query(
      `SELECT DISTINCT wr.id, wr.serial_number, wr.product_name, wr.warranty_start, wr.warranty_end,
              wr.warranty_type, wr.status, wr.notes, wr.created_at
       FROM warranty_registrations wr
       LEFT JOIN sales_orders so ON so.id = wr.sales_order_id
       LEFT JOIN customer_equipment ce ON ce.id = wr.equipment_id
       LEFT JOIN accounts a ON a.id = ce.crm_account_id
       WHERE so.customer_id = $1 OR a.party_id = $1
       ORDER BY wr.warranty_end ASC`,
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

// ── GET /customer360/:partyId/subscriptions — SaaS-style recurring billing ────
// Subscriptions (Sales module) and AMC (above) are legitimately different
// commercial products — service contract vs. recurring billing plan — and
// deliberately stay separate tables (see MODULE_FEATURE_CONNECTION_MANUAL.md
// §18/§62). What was actually missing wasn't a schema merge, it was that
// `subscriptions.customer_id` (uuid, same parties.id space as everything else
// on this page) was never populated by the creation form, so no query could
// ever have surfaced them here even if one existed. Fixed at the source in
// `sales.routes.js`'s POST /subscriptions; this is the read side.
router.get('/customer360/:partyId/subscriptions', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  try {
    const { rows: subs } = await pool.query(
      `SELECT id, plan_name, amount, currency, billing_cycle, status,
              start_date, next_billing_date, end_date, auto_renew, created_at
       FROM subscriptions WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [partyId]
    );
    const active = subs.filter(s => s.status === 'active');
    const mrr = active.reduce((sum, s) => {
      const amt = parseFloat(s.amount) || 0;
      if (s.billing_cycle === 'quarterly') return sum + amt / 3;
      if (s.billing_cycle === 'annual')    return sum + amt / 12;
      return sum + amt;
    }, 0);
    res.json({
      subscriptions: subs,
      summary: { total: subs.length, active: active.length, mrr },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      // fat_reports never existed; the real table is `fat_trackers`, which keys
      // off project_id (there is no customer column on it), so the customer is
      // reached the same way the Projects panel reaches it.
      `SELECT ft.id, ft.fat_number AS report_number, ft.status,
              ft.scheduled_date, ft.actual_date AS completed_date,
              ft.client_witness AS witness_name, ft.serial_number, ft.product_name,
              ft.certificate_number, ft.remarks AS notes, ft.created_at
       FROM fat_trackers ft
       JOIN projects p       ON p.id = ft.project_id AND p.deleted_at IS NULL
       LEFT JOIN opportunities o ON o.id = p.opportunity_id
       LEFT JOIN accounts     a ON a.id = o.account_id AND a.deleted_at IS NULL
       WHERE a.party_id = $1
       ORDER BY ft.created_at DESC`,
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
      // sat_reports never existed; the real table is `sat_trackers`.
      `SELECT st.id, st.sat_number AS report_number, st.status,
              st.actual_date AS sat_date, st.client_representative AS witness_name,
              st.site_name, st.serial_number, st.product_name,
              st.remarks AS notes, st.created_at
       FROM sat_trackers st
       JOIN projects p       ON p.id = st.project_id AND p.deleted_at IS NULL
       LEFT JOIN opportunities o ON o.id = p.opportunity_id
       LEFT JOIN accounts     a ON a.id = o.account_id AND a.deleted_at IS NULL
       WHERE a.party_id = $1
       ORDER BY st.created_at DESC`,
      [partyId]
    );
    satReports = r.rows;
  } catch (_) {}

  try {
    const r = await pool.query(
      // dispatch_records never existed. `delivery_notes` is the real table; it
      // carries only a denormalised customer_name, so it is matched on the
      // normalised party name rather than an id that is not there.
      `SELECT dn.id, dn.dn_number AS dispatch_number, dn.delivery_date AS dispatch_date,
              dn.status, dn.delivered_by, dn.items_delivered, dn.delivery_date,
              dn.notes, dn.created_at
       FROM delivery_notes dn
       JOIN parties pt ON pt.id = $1
        AND crm_norm_name(dn.customer_name) = crm_norm_name(pt.name)
       WHERE ($2::int IS NULL OR dn.company_id = $2)
       ORDER BY dn.delivery_date DESC NULLS LAST`,
      [partyId, companyOf(req)]
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
      `SELECT COUNT(*)::int AS cnt FROM invoices WHERE customer_id = $1 AND LOWER(status) = 'overdue'`,
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
       WHERE customer_id = $1 AND created_at >= NOW() - INTERVAL '12 months'`,
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
    // support_tickets.customer_id FKs accounts(id), not parties.id — the same
    // dead-join bug already fixed at this file's /service, /timeline, and
    // /tickets endpoints (contact_id -> accounts.party_id), just missed here.
    // Was silently caught by this try/catch, always returning 0 and inflating
    // every customer's support_score to its maximum.
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM support_tickets st
       LEFT JOIN contacts c ON c.id = st.contact_id
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE a.party_id = $1 AND st.status != 'resolved' AND st.priority = 'critical'`,
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
       FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`,
      [partyId]
    );
    r.rows.forEach(inv => events.push({
      type: 'invoice', title: `Invoice ${inv.invoice_number}`, date: inv.created_at,
      amount: parseFloat(inv.total_amount), status: inv.status, icon: '🧾',
    }));
  } catch (_) {}

  try {
    const r = await pool.query(
      `SELECT st.id, st.title AS subject, st.priority, st.status, st.created_at
       FROM support_tickets st
       LEFT JOIN contacts c ON c.id = st.contact_id
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE a.party_id = $1 ORDER BY st.created_at DESC LIMIT 20`,
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
      // projects.customer_id never existed — projects reach a customer through
      // opportunity_id (the Won→Project bridge), with the denormalised
      // customer_name as a fallback for rows predating it.
      `SELECT p.id, p.project_code, p.project_name, p.status, p.created_at
         FROM projects p
         LEFT JOIN opportunities o ON o.id = p.opportunity_id
         LEFT JOIN accounts a      ON a.id = o.account_id AND a.deleted_at IS NULL
         LEFT JOIN parties pt      ON pt.id = $1
        WHERE p.deleted_at IS NULL
          AND ( a.party_id = $1
                OR (pt.id IS NOT NULL AND crm_norm_name(p.customer_name) = crm_norm_name(pt.name)) )
        ORDER BY p.created_at DESC`,
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
      `SELECT ac.id, ac.contract_number, ac.start_date, ac.status, ac.created_at
       FROM amc_contracts ac
       JOIN sales_orders so ON so.id = ac.sales_order_id
       WHERE so.customer_id = $1 ORDER BY ac.created_at DESC`,
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
      `SELECT st.id, st.title AS subject, st.priority, st.status, st.created_at, st.resolved_at,
              CASE WHEN st.resolved_at IS NOT NULL
                THEN EXTRACT(DAY FROM (st.resolved_at - st.created_at))::int
                ELSE NULL END AS resolution_days
       FROM support_tickets st
       LEFT JOIN contacts c ON c.id = st.contact_id
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE a.party_id = $1 ORDER BY st.created_at DESC`,
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
    // customer_payments.party_id is a legacy `integer` — not usable against
    // parties.id (uuid). No customer_id column exists here either; resolve
    // via the one real link, invoice_id -> invoices.customer_id.
    const r = await pool.query(
      `SELECT cp.amount, cp.mode, cp.reference AS ref, cp.payment_date AS date
       FROM customer_payments cp
       JOIN invoices i ON i.id = cp.invoice_id
       WHERE i.customer_id = $1 ORDER BY cp.payment_date DESC`,
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
       FROM invoices WHERE customer_id = $1 AND LOWER(status) IN ('overdue','pending')`,
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
      // nps_responses carries customer_id only — there is no customer_name
      // column, so writing one threw 42703 and every NPS submission failed. The
      // name is resolved from `parties` on read (see /nps/responses below),
      // which is the right place for it: one customer, one name, one source.
      `INSERT INTO nps_responses (customer_id, score, comment, survey_date, category)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [customer_id, score, comment || null,
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
      SELECT nr.*, COALESCE(p.name, 'Unknown') AS customer_name
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
      // travel_requests has budget and estimated_amount; actual_cost never
      // existed. estimated_amount is surfaced under the name the callers below
      // already read, so the cost roll-ups keep working.
      `SELECT tr.id, tr.request_number, tr.travel_type, tr.from_date, tr.to_date,
              tr.purpose, tr.status, tr.budget,
              tr.estimated_amount AS actual_cost, tr.destination,
              p.project_code, p.project_name
       FROM travel_requests tr
       JOIN projects p ON p.id = tr.project_id AND p.deleted_at IS NULL
       LEFT JOIN opportunities o ON o.id = p.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id AND a.deleted_at IS NULL
       LEFT JOIN parties pt      ON pt.id = $1
       WHERE ( a.party_id = $1
               OR (pt.id IS NOT NULL AND crm_norm_name(p.customer_name) = crm_norm_name(pt.name)) )
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

// ── GET /customer360/:partyId/products ────────────────────────────────────────
// "What has this customer actually bought from us — which product, on what date,
//  at what price." The header-level invoice list on `/customer360/:partyId` only
//  ever showed a total per invoice; the line detail lives one table deeper.
//
// Purchases = invoice lines + sales-order lines. Quotation lines are returned
// separately as `quotes`: a quote is an offer, not a purchase, and folding it
// into the same totals would overstate what the customer ever bought.
//
// Line→component linkage is best-effort by design. sales_order_items and
// quotation_items carry a free-text `item_code`; invoice_items carries neither
// an item_id nor a code, only `description`. So the code is matched against
// inventory_items.item_code where it resolves — that gives the row a live link
// to the component's sourcing page — and rows that do not resolve still appear,
// keyed on their text. Nothing is dropped for failing to match.
router.get('/customer360/:partyId/products', requirePermission('crm', 'view'), async (req, res) => {
  const { partyId } = req.params;
  try {
    const [purchaseRes, quoteRes] = await Promise.all([
      pool.query(
        `SELECT 'Invoice'::text AS doc_type, i.id AS doc_id, i.invoice_number AS doc_number,
                COALESCE(i.invoice_date, i.created_at::date) AS doc_date,
                i.status, i.currency,
                NULL::varchar AS item_code,
                NULLIF(TRIM(ii.description), '') AS product_name,
                ii.quantity, NULL::varchar AS unit, ii.unit_price,
                NULL::numeric AS discount_pct, ii.tax_rate,
                COALESCE(ii.amount, ii.quantity * ii.unit_price) AS amount
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id AND i.deleted_at IS NULL
          WHERE i.customer_id = $1
          UNION ALL
         SELECT 'Sales Order', so.id, so.order_number,
                COALESCE(so.order_date, so.created_at::date),
                so.order_status, NULL,
                NULLIF(TRIM(soi.item_code), ''),
                COALESCE(NULLIF(TRIM(soi.description), ''), NULLIF(TRIM(soi.item_code), '')),
                soi.quantity, soi.unit, soi.unit_price, soi.discount_pct, soi.tax_rate,
                COALESCE(soi.total_amount, soi.quantity * soi.unit_price)
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.order_id AND so.deleted_at IS NULL
          WHERE so.customer_id = $1
          ORDER BY doc_date DESC NULLS LAST, doc_number DESC
          LIMIT 500`,
        [partyId]
      ),
      pool.query(
        `SELECT q.id AS doc_id, q.quotation_number AS doc_number,
                COALESCE(q.quotation_date, q.created_at::date) AS doc_date,
                q.status, q.validity_date,
                NULLIF(TRIM(qi.item_code), '') AS item_code,
                COALESCE(NULLIF(TRIM(qi.description), ''),
                         NULLIF(TRIM(qi.item_description), ''),
                         NULLIF(TRIM(qi.item_code), '')) AS product_name,
                qi.quantity, qi.unit,
                COALESCE(qi.unit_price, qi.rate) AS unit_price,
                qi.discount_pct, COALESCE(qi.tax_rate, qi.tax_percentage) AS tax_rate,
                COALESCE(qi.total_amount, qi.total, qi.quantity * COALESCE(qi.unit_price, qi.rate)) AS amount
           FROM quotation_items qi
           JOIN quotations q ON q.id = qi.quotation_id AND q.deleted_at IS NULL
          WHERE q.customer_id = $1
          ORDER BY doc_date DESC NULLS LAST
          LIMIT 300`,
        [partyId]
      ),
    ]);

    // Resolve the free-text codes we did get against the component master, so a
    // matched row can deep-link to that component's vendor comparison.
    const codes = [...new Set(
      [...purchaseRes.rows, ...quoteRes.rows]
        .map(r => r.item_code).filter(Boolean)
    )];
    let codeMap = {};
    if (codes.length) {
      const { rows } = await pool.query(
        `SELECT id, item_code, item_name, unit_of_measure
           FROM inventory_items
          WHERE deleted_at IS NULL AND UPPER(item_code) = ANY($1::text[])`,
        [codes.map(c => c.toUpperCase())]
      );
      codeMap = Object.fromEntries(rows.map(r => [r.item_code.toUpperCase(), r]));
    }

    const n = v => {
      if (v == null || v === '') return null;
      const x = parseFloat(v);
      return Number.isFinite(x) ? x : null;
    };
    const decorate = (r) => {
      const match = r.item_code ? codeMap[r.item_code.toUpperCase()] : null;
      return {
        ...r,
        item_id:      match?.id ?? null,
        product_name: match?.item_name || r.product_name || 'Unnamed line',
        unit:         r.unit || match?.unit_of_measure || null,
        quantity:     n(r.quantity),
        unit_price:   n(r.unit_price),
        discount_pct: n(r.discount_pct),
        tax_rate:     n(r.tax_rate),
        amount:       n(r.amount),
      };
    };

    const lines  = purchaseRes.rows.map(decorate);
    const quotes = quoteRes.rows.map(r => ({ ...decorate(r), doc_type: 'Quotation' }));

    // Roll purchases up per product. Key on the resolved component when we have
    // one, otherwise on the line text — two invoice lines reading the same thing
    // are the same product as far as the customer is concerned.
    const byProduct = new Map();
    for (const l of lines) {
      const key = l.item_id != null ? `id:${l.item_id}` : `txt:${(l.product_name || '').toLowerCase()}`;
      const agg = byProduct.get(key) || {
        item_id: l.item_id, item_code: l.item_code, product_name: l.product_name,
        unit: l.unit, line_count: 0, total_qty: 0, total_value: 0,
        first_purchased: null, last_purchased: null,
        last_price: null, min_price: null, max_price: null,
        doc_types: new Set(),
      };
      agg.line_count += 1;
      agg.total_qty   += l.quantity || 0;
      agg.total_value += l.amount   || 0;
      agg.doc_types.add(l.doc_type);
      if (l.unit_price != null) {
        agg.min_price = agg.min_price == null ? l.unit_price : Math.min(agg.min_price, l.unit_price);
        agg.max_price = agg.max_price == null ? l.unit_price : Math.max(agg.max_price, l.unit_price);
        // Rows arrive newest-first, so the first price seen is the most recent.
        if (agg.last_price == null) agg.last_price = l.unit_price;
      }
      if (l.doc_date) {
        if (!agg.last_purchased  || l.doc_date > agg.last_purchased)  agg.last_purchased  = l.doc_date;
        if (!agg.first_purchased || l.doc_date < agg.first_purchased) agg.first_purchased = l.doc_date;
      }
      if (!agg.item_code && l.item_code) agg.item_code = l.item_code;
      byProduct.set(key, agg);
    }

    const products = [...byProduct.values()]
      .map(a => ({
        ...a,
        doc_types:   [...a.doc_types],
        total_qty:   +a.total_qty.toFixed(3),
        total_value: +a.total_value.toFixed(2),
        avg_price:   a.total_qty > 0 ? +(a.total_value / a.total_qty).toFixed(2) : null,
      }))
      .sort((a, b) => b.total_value - a.total_value);

    const dates = lines.map(l => l.doc_date).filter(Boolean).sort();

    res.json({
      summary: {
        line_count:     lines.length,
        product_count:  products.length,
        quote_count:    quotes.length,
        total_value:    +lines.reduce((s, l) => s + (l.amount || 0), 0).toFixed(2),
        linked_products: products.filter(p => p.item_id != null).length,
        first_purchase: dates[0] || null,
        last_purchase:  dates[dates.length - 1] || null,
      },
      products,
      lines,
      quotes,
    });
  } catch (e) {
    respondError(res, e);
  }
});

export default router;
