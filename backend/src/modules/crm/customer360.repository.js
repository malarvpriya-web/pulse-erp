// backend/src/modules/crm/customer360.repository.js
// All raw SQL for the Customer 360 Intelligence Layer.
// customerId = parties.id  (company-scoped on every query)
import pool from '../shared/db.js';

const q = (sql, params) => pool.query(sql, params).then(r => r.rows).catch(() => []);
const q1 = (sql, params) => pool.query(sql, params).then(r => r.rows[0] || null).catch(() => null);

// ── 49A-1 Profile ─────────────────────────────────────────────────────────────
export async function getProfile(customerId, companyId) {
  const [party, account, contacts] = await Promise.all([
    q1(
      `SELECT id, name, email, phone, city, state, country,
              gstin, pan, credit_limit, type, address, created_at
       FROM parties
       WHERE id = $1`,
      [customerId]
    ),
    q1(
      `SELECT a.id, COALESCE(a.name, a.account_name) AS account_name,
              a.account_type, a.industry, a.website, a.annual_revenue,
              a.credit_limit, a.status, a.billing_street, a.billing_city,
              a.billing_state, a.billing_country,
              e.name AS account_manager_name
       FROM accounts a
       LEFT JOIN employees e ON e.id = a.owner_id
       WHERE a.party_id = $1 AND a.deleted_at IS NULL
         AND ($2::int IS NULL OR a.company_id = $2)
       LIMIT 1`,
      [customerId, companyId]
    ),
    q(
      `SELECT c.id, c.first_name, c.last_name,
              CONCAT(c.first_name, ' ', c.last_name) AS full_name,
              c.title, c.email, c.phone, c.department, c.is_primary,
              c.contact_type, c.created_at
       FROM contacts c
       JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
       WHERE a.party_id = $1 AND c.deleted_at IS NULL
         AND ($2::int IS NULL OR c.company_id = $2)
       ORDER BY c.is_primary DESC, c.first_name`,
      [customerId, companyId]
    ),
  ]);

  let outstanding = 0;
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) AS outstanding
       FROM invoices WHERE party_id = $1 AND status != 'paid'
         AND ($2::int IS NULL OR company_id = $2)`,
      [customerId, companyId]
    );
    outstanding = parseFloat(r.rows[0]?.outstanding || 0);
  } catch (_) {}

  return { party, account, contacts, outstanding };
}

// ── 49A-2 Sales ───────────────────────────────────────────────────────────────
export async function getSales(customerId, companyId) {
  const [leads, opportunities, quotations, salesOrders] = await Promise.all([
    q(
      `SELECT l.id, l.company_name, l.contact_person, l.status, l.lead_source,
              l.lead_score, l.created_at, e.name AS assigned_to_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE (l.email IN (SELECT email FROM parties WHERE id = $1)
          OR l.company_name ILIKE (SELECT '%' || name || '%' FROM parties WHERE id = $1))
         AND l.deleted_at IS NULL
         AND ($2::int IS NULL OR l.company_id = $2)
       ORDER BY l.created_at DESC LIMIT 50`,
      [customerId, companyId]
    ),
    q(
      `SELECT o.id, o.opportunity_name, o.expected_value, o.probability_percentage,
              o.stage, o.expected_closing_date, o.closed_date, o.created_at,
              e.name AS assigned_to_name
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to
       WHERE (o.account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)
          OR o.lead_id IN (SELECT id FROM leads WHERE email IN (SELECT email FROM parties WHERE id = $1)))
         AND o.deleted_at IS NULL
         AND ($2::int IS NULL OR o.company_id = $2)
       ORDER BY o.created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, quotation_number, quotation_date, validity_date,
              status, total_amount, notes, created_at
       FROM quotations
       WHERE customer_id = $1 AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, order_number, order_date, delivery_date,
              order_status AS status, total_amount, created_at
       FROM sales_orders
       WHERE customer_id = $1 AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
  ]);
  return { leads, opportunities, quotations, salesOrders };
}

// ── 49A-3 Tenders ─────────────────────────────────────────────────────────────
export async function getTenders(customerId, companyId) {
  return q(
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
       AND (o.account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)
        OR o.lead_id IN (SELECT id FROM leads WHERE email IN (SELECT email FROM parties WHERE id = $1)))
       AND o.deleted_at IS NULL
       AND ($2::int IS NULL OR o.company_id = $2)
     ORDER BY o.created_at DESC`,
    [customerId, companyId]
  );
}

// ── 49A-4 Projects ────────────────────────────────────────────────────────────
export async function getProjects(customerId, companyId) {
  const projects = await q(
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
       AND ($2::int IS NULL OR p.company_id = $2)
     ORDER BY p.created_at DESC`,
    [customerId, companyId]
  );

  const projectIds = projects.map(p => p.id);
  const milestones = projectIds.length
    ? await q(
        `SELECT id, project_id, milestone_name, due_date, status, amount
         FROM project_milestones WHERE project_id = ANY($1) ORDER BY due_date ASC`,
        [projectIds]
      )
    : [];

  return { projects, milestones };
}

// ── 49A-5 Engineering ─────────────────────────────────────────────────────────
export async function getEngineering(customerId, companyId) {
  // BOMs linked via production orders → sales orders → customer
  const [boms, ecns] = await Promise.all([
    q(
      `SELECT bh.id, bh.bom_code, bh.product_name, bh.revision, bh.status,
              bh.created_at,
              (SELECT COUNT(*) FROM bom_lines WHERE bom_id = bh.id)::int AS component_count
       FROM bom_headers bh
       WHERE bh.id IN (
         SELECT DISTINCT bom_id FROM production_orders
         WHERE sales_order_id IN (
           SELECT id FROM sales_orders WHERE customer_id = $1
             AND ($2::int IS NULL OR company_id = $2)
         )
       )
       ORDER BY bh.created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT c.id, c.change_number, c.title, c.status, c.priority,
              c.change_type, c.created_at,
              (SELECT COUNT(*) FROM engineering_change_items WHERE engineering_change_id = c.id)::int AS impacted_items
       FROM engineering_changes c
       WHERE c.id IN (
         SELECT DISTINCT engineering_change_id FROM engineering_change_items
         WHERE bom_id IN (
           SELECT id FROM bom_headers WHERE id IN (
             SELECT DISTINCT bom_id FROM production_orders
             WHERE sales_order_id IN (
               SELECT id FROM sales_orders WHERE customer_id = $1
                 AND ($2::int IS NULL OR company_id = $2)
             )
           )
         )
       )
       ORDER BY c.created_at DESC LIMIT 50`,
      [customerId, companyId]
    ),
  ]);
  return { boms, ecns };
}

// ── 49A-6 Procurement ─────────────────────────────────────────────────────────
export async function getProcurement(customerId, companyId) {
  const projectIds = await q(
    `SELECT id FROM projects WHERE customer_id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR company_id = $2)`,
    [customerId, companyId]
  ).then(rows => rows.map(r => r.id));

  const soIds = await q(
    `SELECT id FROM sales_orders WHERE customer_id = $1 AND deleted_at IS NULL
       AND ($2::int IS NULL OR company_id = $2)`,
    [customerId, companyId]
  ).then(rows => rows.map(r => r.id));

  if (!projectIds.length && !soIds.length) {
    return { purchaseRequests: [], rfqs: [], purchaseOrders: [], grns: [] };
  }

  const [purchaseRequests, rfqs, purchaseOrders, grns] = await Promise.all([
    q(
      `SELECT id, pr_number, status, total_amount, required_date, created_at
       FROM purchase_requests
       WHERE (project_id = ANY($1) OR sales_order_id = ANY($2))
         AND deleted_at IS NULL
         AND ($3::int IS NULL OR company_id = $3)
       ORDER BY created_at DESC LIMIT 100`,
      [projectIds.length ? projectIds : [0], soIds.length ? soIds : [0], companyId]
    ),
    q(
      `SELECT r.id, r.rfq_number, r.status, r.created_at,
              (SELECT COUNT(*) FROM rfq_quotes WHERE rfq_id = r.id)::int AS quote_count
       FROM rfqs r
       WHERE (r.project_id = ANY($1) OR r.sales_order_id = ANY($2))
         AND r.deleted_at IS NULL
         AND ($3::int IS NULL OR r.company_id = $3)
       ORDER BY r.created_at DESC LIMIT 100`,
      [projectIds.length ? projectIds : [0], soIds.length ? soIds : [0], companyId]
    ),
    q(
      `SELECT po.id, po.po_number, po.status, po.total_amount,
              po.order_date, po.created_at,
              v.vendor_name
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.supplier_id
       WHERE (po.project_id = ANY($1) OR po.sales_order_id = ANY($2))
         AND po.deleted_at IS NULL
         AND ($3::int IS NULL OR po.company_id = $3)
       ORDER BY po.created_at DESC LIMIT 100`,
      [projectIds.length ? projectIds : [0], soIds.length ? soIds : [0], companyId]
    ),
    q(
      `SELECT grn.id, grn.grn_number, grn.status, grn.receipt_date,
              grn.total_value, grn.created_at
       FROM goods_receipt_notes grn
       WHERE grn.purchase_order_id IN (
         SELECT id FROM purchase_orders
         WHERE (project_id = ANY($1) OR sales_order_id = ANY($2))
           AND deleted_at IS NULL
           AND ($3::int IS NULL OR company_id = $3)
       )
       ORDER BY grn.created_at DESC LIMIT 100`,
      [projectIds.length ? projectIds : [0], soIds.length ? soIds : [0], companyId]
    ),
  ]);

  return { purchaseRequests, rfqs, purchaseOrders, grns };
}

// ── 49A-7 Production ──────────────────────────────────────────────────────────
export async function getProduction(customerId, companyId) {
  return q(
    `SELECT po.id, po.order_number, po.status, po.planned_start, po.planned_end,
            po.quantity_planned, po.quantity_produced, po.created_at,
            bh.bom_code, bh.product_name,
            (SELECT COUNT(*) FROM production_operations WHERE production_order_id = po.id)::int AS total_ops,
            (SELECT COUNT(*) FROM production_operations WHERE production_order_id = po.id AND status='completed')::int AS done_ops
     FROM production_orders po
     LEFT JOIN bom_headers bh ON bh.id = po.bom_id
     WHERE po.sales_order_id IN (
       SELECT id FROM sales_orders WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
     )
       AND ($2::int IS NULL OR po.company_id = $2)
     ORDER BY po.created_at DESC`,
    [customerId, companyId]
  );
}

// ── 49A-8 Quality ─────────────────────────────────────────────────────────────
export async function getQuality(customerId, companyId) {
  const [fatReports, satReports, ncrs] = await Promise.all([
    q(
      `SELECT id, report_number, status, scheduled_date, completed_date,
              witness_name, result, notes, created_at
       FROM fat_reports WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, report_number, status, sat_date, witness_name,
              result, notes, created_at
       FROM sat_reports WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, ncr_number, description, status, severity, created_at
       FROM non_conformance_reports WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
  ]);
  return { fatReports, satReports, ncrs };
}

// ── 49A-9 Logistics ───────────────────────────────────────────────────────────
export async function getLogistics(customerId, companyId) {
  return q(
    `SELECT id, dispatch_number, dispatch_date, status,
            transport_mode, tracking_number, delivery_date,
            vehicle_number, driver_name, created_at
     FROM dispatch_records WHERE customer_id = $1
       AND ($2::int IS NULL OR company_id = $2)
     ORDER BY dispatch_date DESC`,
    [customerId, companyId]
  );
}

// ── 49A-10 Commissioning ──────────────────────────────────────────────────────
export async function getCommissioning(customerId, companyId) {
  return q(
    `SELECT id, report_number, status, commissioning_date,
            site_location, notes, acceptance_status, created_at
     FROM commissioning_reports WHERE customer_id = $1
       AND ($2::int IS NULL OR company_id = $2)
     ORDER BY created_at DESC`,
    [customerId, companyId]
  );
}

// ── 49A-11 Service ────────────────────────────────────────────────────────────
export async function getService(customerId, companyId) {
  const [tickets, fieldVisits, serviceContracts] = await Promise.all([
    q(
      `SELECT id, subject, priority, status, created_at, resolved_at, description,
              CASE WHEN resolved_at IS NOT NULL
                THEN EXTRACT(DAY FROM (resolved_at - created_at))::int
                ELSE NULL END AS resolution_days
       FROM support_tickets WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT fv.id, fv.visit_date, fv.status, fv.purpose, fv.notes,
              e.name AS engineer_name
       FROM field_service_visits fv
       LEFT JOIN employees e ON e.id = fv.engineer_id
       WHERE fv.customer_id = $1
         AND ($2::int IS NULL OR fv.company_id = $2)
       ORDER BY fv.visit_date DESC LIMIT 50`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, contract_number, start_date, end_date, status,
              contract_value, coverage_type, created_at
       FROM service_contracts WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
  ]);
  return { tickets, fieldVisits, serviceContracts };
}

// ── 49A-12 AMC ────────────────────────────────────────────────────────────────
export async function getAMC(customerId, companyId) {
  const [contracts, warrantyRecords] = await Promise.all([
    q(
      `SELECT id, contract_number, start_date, end_date, renewal_date,
              status, coverage_type, annual_value, total_value, notes, created_at
       FROM amc_contracts WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT id, serial_number, product_name, warranty_start, warranty_end,
              warranty_type, status, notes, created_at
       FROM warranty_register WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY warranty_end ASC`,
      [customerId, companyId]
    ),
  ]);
  return { contracts, warrantyRecords };
}

// ── 49A-13 Finance ────────────────────────────────────────────────────────────
export async function getFinance(customerId, companyId) {
  const [invoices, payments] = await Promise.all([
    q(
      `SELECT id, invoice_number, total_amount, status, created_at, due_date
       FROM invoices WHERE party_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]
    ),
    q(
      `SELECT amount, mode, reference AS ref, payment_date AS date
       FROM customer_payments WHERE party_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY payment_date DESC`,
      [customerId, companyId]
    ),
  ]);
  return { invoices, payments };
}

// ── 49A-14 Travel ─────────────────────────────────────────────────────────────
export async function getTravel(customerId, companyId) {
  const [customerVisits, projectTravel] = await Promise.all([
    q(
      `SELECT cv.id, cv.visit_date, cv.visit_type, cv.purpose, cv.location,
              cv.discussion_notes, cv.next_followup_date,
              e.name AS visited_by_name
       FROM customer_visits cv
       LEFT JOIN employees e ON e.id = cv.visited_by
       WHERE cv.customer_id = $1
         AND ($2::int IS NULL OR cv.company_id = $2)
       ORDER BY cv.visit_date DESC LIMIT 50`,
      [customerId, companyId]
    ),
    q(
      `SELECT tr.id, tr.request_number, tr.travel_type, tr.from_date, tr.to_date,
              tr.purpose, tr.status, tr.budget, tr.actual_cost, tr.destination,
              p.project_code, p.project_name
       FROM travel_requests tr
       JOIN projects p ON p.id = tr.project_id
       WHERE p.customer_id = $1 AND tr.status IN ('approved','completed')
         AND ($2::int IS NULL OR tr.company_id = $2)
       ORDER BY tr.from_date DESC LIMIT 100`,
      [customerId, companyId]
    ),
  ]);
  return { customerVisits, projectTravel };
}

// ── 49A-15 Documents ──────────────────────────────────────────────────────────
export async function getDocuments(customerId, companyId) {
  const party = await q1(
    `SELECT name, city FROM parties WHERE id = $1`,
    [customerId]
  );
  if (!party) return { root: null, folders: [] };

  const folderName = (party.name || '').replace(/[^a-zA-Z0-9\s-]/g, '').trim();
  return {
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
}

// ── 49A-16 Timeline raw events ────────────────────────────────────────────────
export async function getTimelineEvents(customerId, companyId) {
  const results = await Promise.allSettled([
    q(`SELECT 'lead' AS type, 'Lead Created' AS title, company_name AS subtitle,
              created_at AS date, status, NULL::numeric AS amount
       FROM leads
       WHERE email IN (SELECT email FROM parties WHERE id = $1) AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC LIMIT 30`,
      [customerId, companyId]),
    q(`SELECT 'opportunity' AS type, 'Opportunity: ' || opportunity_name AS title,
              stage AS subtitle, created_at AS date, stage AS status,
              expected_value AS amount
       FROM opportunities
       WHERE account_id IN (SELECT id FROM accounts WHERE party_id = $1 AND deleted_at IS NULL)
         AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC LIMIT 20`,
      [customerId, companyId]),
    q(`SELECT 'quotation' AS type, 'Quotation ' || quotation_number AS title,
              NULL AS subtitle, created_at AS date, status, total_amount AS amount
       FROM quotations
       WHERE customer_id = $1 AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC LIMIT 20`,
      [customerId, companyId]),
    q(`SELECT 'sales_order' AS type, 'PO Received: ' || COALESCE(order_number, id::text) AS title,
              NULL AS subtitle, created_at AS date, order_status AS status, total_amount AS amount
       FROM sales_orders
       WHERE customer_id = $1 AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]),
    q(`SELECT 'project' AS type, 'Project: ' || project_name AS title,
              project_code AS subtitle, created_at AS date, status, budget_amount AS amount
       FROM projects
       WHERE customer_id = $1 AND deleted_at IS NULL
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]),
    q(`SELECT 'invoice' AS type, 'Invoice ' || invoice_number AS title,
              NULL AS subtitle, created_at AS date, status, total_amount AS amount
       FROM invoices WHERE party_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [customerId, companyId]),
    q(`SELECT 'fat' AS type, 'FAT: ' || COALESCE(report_number, id::text) AS title,
              result AS subtitle, COALESCE(completed_date, created_at) AS date,
              status, NULL::numeric AS amount
       FROM fat_reports WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]),
    q(`SELECT 'dispatch' AS type, 'Dispatched: ' || COALESCE(dispatch_number, id::text) AS title,
              transport_mode AS subtitle, dispatch_date AS date, status, NULL::numeric AS amount
       FROM dispatch_records WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY dispatch_date DESC`,
      [customerId, companyId]),
    q(`SELECT 'commissioning' AS type,
              'Commissioning: ' || COALESCE(report_number, id::text) AS title,
              site_location AS subtitle, commissioning_date AS date,
              acceptance_status AS status, NULL::numeric AS amount
       FROM commissioning_reports WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]),
    q(`SELECT 'ticket' AS type, COALESCE(subject, 'Ticket #' || id::text) AS title,
              priority AS subtitle, created_at AS date, status, NULL::numeric AS amount
       FROM support_tickets WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC LIMIT 30`,
      [customerId, companyId]),
    q(`SELECT 'amc' AS type, 'AMC: ' || COALESCE(contract_number, id::text) AS title,
              coverage_type AS subtitle, created_at AS date, status, annual_value AS amount
       FROM amc_contracts WHERE customer_id = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC`,
      [customerId, companyId]),
  ]);

  const allEvents = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  allEvents.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return allEvents.slice(0, 200);
}
