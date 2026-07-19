import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();

// ─── Global Entity Search ─────────────────────────────────────────────────────
// GET /global-search?q=<query>&limit=<n>
// Searches employees, BOMs, production orders, customers, projects, complaints,
// invoices, and inventory items. Returns grouped results with deep-link page keys.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ groups: [] });

  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const wild  = `%${q}%`;
  // null company_id (super_admin global scope) intentionally sees all companies;
  // every other role is restricted to their own company_id.
  const companyId = req.scope?.company_id ?? null;

  try {
    const [employees, boms, prodOrders, customers, projects, complaints, inventory] =
      await Promise.allSettled([

        // Employees
        pool.query(
          `SELECT id, first_name || ' ' || last_name AS label,
                  office_id AS meta, department AS group_label
           FROM employees
           WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR office_id ILIKE $1
                  OR department ILIKE $1)
             AND status = 'active'
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY first_name LIMIT $2`,
          [wild, limit, companyId]
        ),

        // BOM headers
        pool.query(
          `SELECT id, bom_number AS label, product_name AS meta, 'BOM' AS group_label
           FROM bom_headers
           WHERE (bom_number ILIKE $1 OR product_name ILIKE $1)
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY created_at DESC LIMIT $2`,
          [wild, limit, companyId]
        ),

        // Production orders
        pool.query(
          `SELECT id, production_order_no AS label, product_name AS meta, status AS group_label
           FROM production_orders
           WHERE (production_order_no ILIKE $1 OR product_name ILIKE $1)
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY created_at DESC LIMIT $2`,
          [wild, limit, companyId]
        ),

        // Customers (from invoices)
        pool.query(
          `SELECT DISTINCT ON (party_name) id, party_name AS label,
                  '' AS meta, 'Customer' AS group_label
           FROM invoices
           WHERE party_name ILIKE $1
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY party_name, created_at DESC LIMIT $2`,
          [wild, limit, companyId]
        ),

        // Projects
        pool.query(
          `SELECT id, project_name AS label, status AS meta, 'Project' AS group_label
           FROM projects
           WHERE (project_name ILIKE $1 OR description ILIKE $1)
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY created_at DESC LIMIT $2`,
          [wild, limit, companyId]
        ),

        // Complaints / tickets
        pool.query(
          `SELECT id, title AS label, status AS meta, 'Complaint' AS group_label
           FROM complaints
           WHERE (title ILIKE $1 OR description ILIKE $1)
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY created_at DESC LIMIT $2`,
          [wild, limit, companyId]
        ),

        // Inventory items
        pool.query(
          `SELECT id, item_name AS label, item_code AS meta, category AS group_label
           FROM inventory_items
           WHERE (item_name ILIKE $1 OR item_code ILIKE $1)
             AND ($3::int IS NULL OR company_id = $3)
           ORDER BY item_name LIMIT $2`,
          [wild, limit, companyId]
        ),
      ]);

    const groups = [
      { type: 'employee',   label: 'Employees',         page: 'EmployeesData',      data: employees },
      { type: 'bom',        label: 'Bills of Materials', page: 'BOMBuilder',         data: boms },
      { type: 'production', label: 'Production Orders',  page: 'ProductionOrders',   data: prodOrders },
      { type: 'customer',   label: 'Customers',          page: 'Accounts',           data: customers },
      { type: 'project',    label: 'Projects',           page: 'ProjectsDashboard',  data: projects },
      { type: 'complaint',  label: 'Complaints',         page: 'AllComplaints',      data: complaints },
      { type: 'inventory',  label: 'Inventory Items',    page: 'ItemMaster',         data: inventory },
    ]
      .map(g => ({
        type:  g.type,
        label: g.label,
        page:  g.page,
        items: g.data.status === 'fulfilled'
          ? (g.data.value.rows || []).map(r => ({
              id:    r.id,
              label: r.label,
              meta:  r.meta,
            }))
          : [],
      }))
      .filter(g => g.items.length > 0);

    res.json({ groups, query: q });
  } catch (err) {
    console.error('[global-search] Error:', err.message);
    res.status(500).json({ error: 'Search failed', groups: [] });
  }
});

// ─── Workflow summary (for WorkflowVisualizer) ────────────────────────────────
// GET /global-search/workflow-summary
// Returns counts, alert metrics, and pipeline values per business stage
router.get('/workflow-summary', async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;

    const [leads, proposals, orders, engineering, production, quality, dispatch,
           installation, service, closed] =
      await Promise.allSettled([

        // Leads — active pipeline (not won/lost/closed)
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days' AND LOWER(status) NOT IN ('won','lost','closed')) AS overdue,
                  COALESCE(SUM(estimated_value), 0)::numeric AS value
           FROM leads
           WHERE deleted_at IS NULL
             AND LOWER(status) NOT IN ('won','lost','closed')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Proposals — quotations sent or in draft
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '14 days') AS overdue,
                  COALESCE(SUM(total_amount), 0)::numeric AS value
           FROM quotations
           WHERE status IN ('draft','sent')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Orders — active sales orders
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'pending') AS alerts,
                  COALESCE(SUM(total_amount), 0)::numeric AS value
           FROM sales_orders
           WHERE status NOT IN ('closed','cancelled')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Engineering — lifecycle instances in design stage
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'on_hold') AS alerts
           FROM lifecycle_instances
           WHERE current_stage = 'design' AND status = 'active'
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Production orders in progress
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'on_hold') AS alerts,
                  COUNT(*) FILTER (WHERE scheduled_end < NOW() AND status NOT IN ('completed','cancelled')) AS overdue
           FROM production_orders
           WHERE status NOT IN ('completed','cancelled')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Quality — inspections pending/in-progress/failed
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'failed') AS alerts
           FROM quality_inspections
           WHERE status IN ('pending','in_progress','failed')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Dispatch — lifecycle instances in dispatch stage
        pool.query(
          `SELECT COUNT(*) AS count
           FROM lifecycle_instances
           WHERE current_stage = 'dispatch' AND status = 'active'
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Installation — lifecycle instances at site
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE status = 'on_hold') AS alerts
           FROM lifecycle_instances
           WHERE current_stage = 'installation' AND status = 'active'
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Service — open tickets (overdue = open > 7 days; separate from lead count)
        pool.query(
          `SELECT COUNT(*) AS count,
                  COUNT(*) FILTER (WHERE priority IN ('critical','high')) AS alerts,
                  COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '7 days'
                                     AND status NOT IN ('resolved','closed')) AS overdue
           FROM service_tickets
           WHERE status NOT IN ('resolved','closed')
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),

        // Closed this calendar month
        pool.query(
          `SELECT COUNT(*) AS count
           FROM lifecycle_instances
           WHERE status = 'completed'
             AND updated_at >= date_trunc('month', NOW())
             AND ($1::int IS NULL OR company_id = $1)`,
          [companyId],
        ),
      ]);

    const safe = (r, field = 'count') => {
      if (r.status === 'fulfilled') return parseInt(r.value.rows[0]?.[field] ?? 0, 10);
      return 0;
    };
    const safeVal = (r, field = 'value') => {
      if (r.status === 'fulfilled') return parseFloat(r.value.rows[0]?.[field] ?? 0);
      return 0;
    };

    res.json({
      lead:         { count: safe(leads),        overdue: safe(leads, 'overdue'),        alerts: 0,                          value: safeVal(leads) },
      proposal:     { count: safe(proposals),     overdue: safe(proposals, 'overdue'),    alerts: 0,                          value: safeVal(proposals) },
      order:        { count: safe(orders),        overdue: 0,                             alerts: safe(orders, 'alerts'),     value: safeVal(orders) },
      engineering:  { count: safe(engineering),   overdue: 0,                             alerts: safe(engineering, 'alerts'), value: 0 },
      production:   { count: safe(production),    overdue: safe(production, 'overdue'),   alerts: safe(production, 'alerts'), value: 0 },
      quality:      { count: safe(quality),       overdue: 0,                             alerts: safe(quality, 'alerts'),    value: 0 },
      dispatch:     { count: safe(dispatch),      overdue: 0,                             alerts: 0,                          value: 0 },
      installation: { count: safe(installation),  overdue: 0,                             alerts: safe(installation, 'alerts'), value: 0 },
      service:      { count: safe(service),       overdue: safe(service, 'overdue'),      alerts: safe(service, 'alerts'),    value: 0 },
      closed:       { count: safe(closed),        overdue: 0,                             alerts: 0,                          value: 0 },
    });
  } catch (err) {
    console.error('[global-search] workflow-summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch workflow summary' });
  }
});

export default router;
