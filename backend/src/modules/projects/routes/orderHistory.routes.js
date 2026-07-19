/**
 * CEO Order History — unified Lead→AMC traceability API.
 *
 * GET /projects/:id/full-history
 * (mounted under /projects in server.js, so path is just /:id/full-history)
 */

import { Router } from 'express';
import pool from '../../shared/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = Router();

const cid = req => companyOf(req) ?? req.scope?.company_id ?? null;

async function safeQuery(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (_) {
    return [];
  }
}

router.get('/:id/full-history', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const companyId = cid(req);

    // ── Core project ─────────────────────────────────────────────────────
    const [project] = await safeQuery(
      `SELECT p.*,
              e.name AS manager_name,
              pcs.labour_cost, pcs.material_cost, pcs.travel_cost,
              pcs.manufacturing_cost, pcs.procurement_overhead, pcs.quality_cost,
              pcs.installation_cost, pcs.commissioning_cost, pcs.service_cost,
              pcs.total_cost, pcs.amc_revenue, pcs.total_revenue,
              pcs.revenue, pcs.profit, pcs.margin_pct,
              pcs.cost_performance_index AS cpi,
              pcs.schedule_performance_index AS spi,
              pcs.last_calculated_at
       FROM projects p
       LEFT JOIN employees e ON e.id = p.project_manager_id
       LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
       WHERE p.id=$1 AND p.deleted_at IS NULL
         AND ($2::int IS NULL OR p.company_id=$2)`,
      [projectId, companyId]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // ── Lifecycle instance ────────────────────────────────────────────────
    const [li] = await safeQuery(
      `SELECT li.*,
              so.order_number, so.order_status, so.total_amount AS order_value,
              so.quotation_id
       FROM lifecycle_instances li
       LEFT JOIN sales_orders so ON so.id = li.sales_order_id
       WHERE li.project_id=$1
       ORDER BY li.created_at DESC
       LIMIT 1`,
      [projectId]
    );

    // Also try via sales_order_ref if lifecycle not found by project_id
    const salesOrderRef = project.sales_order_ref;
    const [liFromRef] = (!li && salesOrderRef) ? await safeQuery(
      `SELECT li.*, so.order_number, so.order_status, so.total_amount AS order_value, so.quotation_id
       FROM lifecycle_instances li
       JOIN sales_orders so ON so.id = li.sales_order_id
       WHERE so.order_number = $1
       ORDER BY li.created_at DESC LIMIT 1`,
      [salesOrderRef]
    ) : [null];

    const lifecycle = li || liFromRef || null;

    // ── Lifecycle stage history ───────────────────────────────────────────
    const stageHistory = lifecycle ? await safeQuery(
      `SELECT lsh.*, e.name AS actor_name_resolved
       FROM lifecycle_stage_history lsh
       LEFT JOIN employees e ON e.id = lsh.actor_id
       WHERE lsh.lifecycle_instance_id=$1
       ORDER BY lsh.created_at ASC`,
      [lifecycle.id]
    ) : [];

    // ── Sales order ───────────────────────────────────────────────────────
    const salesOrderId = lifecycle?.sales_order_id || null;
    const [salesOrder] = salesOrderId ? await safeQuery(
      `SELECT so.*, e.name AS created_by_name
       FROM sales_orders so
       LEFT JOIN employees e ON e.id = so.created_by
       WHERE so.id=$1`,
      [salesOrderId]
    ) : [null];

    // ── Quotation ─────────────────────────────────────────────────────────
    const quotationId = salesOrder?.quotation_id || lifecycle?.quotation_id;
    const [quotation] = quotationId ? await safeQuery(
      `SELECT q.*, e.name AS created_by_name
       FROM quotations q
       LEFT JOIN employees e ON e.id = q.created_by
       WHERE q.id=$1`,
      [quotationId]
    ) : [null];

    const quotationRevisions = quotation ? await safeQuery(
      `SELECT id, quotation_number, revision, status, total_amount, created_at
       FROM quotations
       WHERE COALESCE(original_id, id) = COALESCE($1::int, $2::int)
       ORDER BY revision ASC`,
      [quotation.original_id, quotation.id]
    ) : [];

    // ── Opportunity ───────────────────────────────────────────────────────
    const [opportunity] = quotation?.opportunity_id ? await safeQuery(
      `SELECT o.*, e.name AS assigned_to_name,
              a.name AS account_name
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to
       LEFT JOIN accounts  a ON a.id = o.account_id
       WHERE o.id=$1`,
      [quotation.opportunity_id]
    ) : [null];

    const opportunityStageHistory = opportunity ? await safeQuery(
      `SELECT * FROM opportunity_stage_history
       WHERE opportunity_id=$1 ORDER BY changed_at ASC`,
      [opportunity.id]
    ) : [];

    // ── Technical & Commercial Proposals ─────────────────────────────────
    const [technicalProposal] = opportunity?.tech_proposal_id ? await safeQuery(
      `SELECT tp.*, e.name AS prepared_by_name
       FROM technical_proposals tp
       LEFT JOIN employees e ON e.id = tp.prepared_by
       WHERE tp.id=$1`,
      [opportunity.tech_proposal_id]
    ) : [null];

    const [commercialProposal] = opportunity?.comm_proposal_id ? await safeQuery(
      `SELECT cp.*, e.name AS prepared_by_name
       FROM commercial_proposals cp
       LEFT JOIN employees e ON e.id = cp.prepared_by
       WHERE cp.id=$1`,
      [opportunity.comm_proposal_id]
    ) : [null];

    // ── Lead (origin) ─────────────────────────────────────────────────────
    const [lead] = opportunity?.lead_id ? await safeQuery(
      `SELECT l.*, e.name AS assigned_to_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE l.id=$1`,
      [opportunity.lead_id]
    ) : [null];

    // ── BOM ───────────────────────────────────────────────────────────────
    const boms = await safeQuery(
      `SELECT bh.*, e.name AS created_by_name
       FROM bom_headers bh
       LEFT JOIN employees e ON e.id = bh.created_by
       WHERE bh.project_id=$1 OR bh.sales_order_id=$2
       ORDER BY bh.created_at DESC`,
      [projectId, salesOrderId]
    );

    // ── Production Orders ─────────────────────────────────────────────────
    const productionOrders = await safeQuery(
      `SELECT po.*, b.bom_number, b.revision AS bom_revision
       FROM production_orders po
       LEFT JOIN bom_headers b ON b.id = po.bom_id
       WHERE po.project_id=$1 OR po.sales_order_id=$2
       ORDER BY po.created_at DESC`,
      [projectId, salesOrderId]
    );

    // ── Purchase Orders ───────────────────────────────────────────────────
    const purchaseOrders = await safeQuery(
      `SELECT po.*, v.vendor_name,
              COALESCE(po.total_amount, 0) AS spend
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.supplier_id
       WHERE po.project_id=$1 OR po.sales_order_id=$2
       ORDER BY po.created_at DESC`,
      [projectId, salesOrderId]
    );
    const procurementSpend = purchaseOrders.reduce((s, r) => s + parseFloat(r.spend || 0), 0);

    // ── Vendors ───────────────────────────────────────────────────────────
    const vendors = purchaseOrders.length ? await safeQuery(
      `SELECT DISTINCT v.id, v.vendor_name, v.gstin, v.rating,
              COUNT(po.id)::int AS po_count,
              SUM(po.total_amount) AS total_spend
       FROM purchase_orders po
       JOIN vendors v ON v.id = po.supplier_id
       WHERE po.id = ANY($1::int[])
       GROUP BY v.id, v.vendor_name, v.gstin, v.rating`,
      [purchaseOrders.map(p => p.id)]
    ) : [];

    // ── GRN ───────────────────────────────────────────────────────────────
    const grns = purchaseOrders.length ? await safeQuery(
      `SELECT g.* FROM grn g
       WHERE g.purchase_order_id = ANY($1::int[])
       ORDER BY g.receipt_date DESC`,
      [purchaseOrders.map(p => p.id)]
    ) : [];

    // ── Batch / material consumption ──────────────────────────────────────
    const batches = productionOrders.length ? await safeQuery(
      `SELECT bt.* FROM batch_tracking bt
       WHERE bt.production_order_id = ANY($1::int[])
       ORDER BY bt.created_at DESC`,
      [productionOrders.map(p => p.id)]
    ) : [];

    // ── FAT / SAT / NCR ───────────────────────────────────────────────────
    const fatReports = await safeQuery(
      `SELECT * FROM fat_trackers WHERE project_id=$1 ORDER BY actual_date DESC`,
      [projectId]
    );
    const satReports = await safeQuery(
      `SELECT * FROM sat_trackers WHERE project_id=$1 ORDER BY actual_date DESC`,
      [projectId]
    );
    const ncrs = productionOrders.length ? await safeQuery(
      `SELECT n.* FROM quality_ncrs n
       WHERE n.production_order_id = ANY($1::int[])
       ORDER BY n.created_at DESC`,
      [productionOrders.map(p => p.id)]
    ) : [];

    // ── Shipments ─────────────────────────────────────────────────────────
    const shipments = salesOrderId ? await safeQuery(
      `SELECT s.* FROM shipments s
       WHERE s.reference_type='sales_order' AND s.reference_id=$1
       ORDER BY s.created_at DESC`,
      [salesOrderId]
    ) : [];

    // ── Commissioning ─────────────────────────────────────────────────────
    const commissioningReports = lifecycle ? await safeQuery(
      `SELECT cr.* FROM commissioning_reports cr
       WHERE cr.lifecycle_instance_id=$1
       ORDER BY cr.commissioning_date DESC`,
      [lifecycle.id]
    ) : [];

    // ── Warranty ──────────────────────────────────────────────────────────
    const warranties = await safeQuery(
      `SELECT pw.*,
              CASE WHEN pw.warranty_end_date >= CURRENT_DATE THEN 'active' ELSE 'expired' END AS computed_status
       FROM project_warranties pw WHERE pw.project_id=$1
       ORDER BY pw.warranty_end_date DESC`,
      [projectId]
    );

    // ── Service Tickets ───────────────────────────────────────────────────
    const serviceTickets = await safeQuery(
      `SELECT st.*, e.name AS assigned_to_name
       FROM support_tickets st
       LEFT JOIN employees e ON e.id = st.assigned_to
       WHERE st.project_id=$1 AND st.deleted_at IS NULL
       ORDER BY st.created_at DESC`,
      [projectId]
    );

    // ── AMC Contracts ─────────────────────────────────────────────────────
    const amcContracts = await safeQuery(
      `SELECT ac.*,
              (SELECT COUNT(*)::int FROM amc_renewals ar WHERE ar.amc_contract_id=ac.id) AS renewal_count
       FROM amc_contracts ac
       WHERE ac.project_id=$1
          OR (ac.lifecycle_instance_id IS NOT NULL AND ac.lifecycle_instance_id=$2)
       ORDER BY ac.start_date DESC`,
      [projectId, lifecycle?.id || null]
    );

    // ── Documents ─────────────────────────────────────────────────────────
    const documents = await safeQuery(
      `SELECT dm.file_name, dm.drive_link, dm.module_type,
              dm.linked_entity_type, dm.revision, dm.revision_label,
              dm.approval_status, dm.signed_status, dm.created_at
       FROM document_master dm
       WHERE (dm.linked_entity_type='project' AND dm.linked_entity_id=$1)
          OR ($2::int IS NOT NULL AND dm.linked_entity_type='sales_order' AND dm.linked_entity_id=$2)
       ORDER BY dm.created_at DESC`,
      [projectId, salesOrderId]
    );

    // ── Milestones ────────────────────────────────────────────────────────
    const milestones = await safeQuery(
      `SELECT pm.*, e.name AS owner_name
       FROM project_milestones pm
       LEFT JOIN employees e ON e.id = pm.owner_id
       WHERE pm.project_id=$1
       ORDER BY pm.due_date ASC`,
      [projectId]
    );

    // ── Build chronological timeline ──────────────────────────────────────
    const timeline = [
      lead && {
        stage: 'Lead', date: lead.created_at, entity: 'lead', id: lead.id,
        title: `${lead.full_name || lead.name || ''} (${lead.company_name || ''})`,
        owner: lead.assigned_to_name, status: lead.status, source: lead.lead_source,
      },
      opportunity && {
        stage: 'Opportunity', date: opportunity.created_at, entity: 'opportunity', id: opportunity.id,
        title: opportunity.opportunity_name, owner: opportunity.assigned_to_name,
        value: opportunity.expected_value, status: opportunity.stage,
      },
      technicalProposal && {
        stage: 'Technical Proposal', date: technicalProposal.created_at,
        entity: 'technical_proposal', id: technicalProposal.id,
        title: technicalProposal.proposal_number, owner: technicalProposal.prepared_by_name,
        status: technicalProposal.status, drive_link: technicalProposal.drive_link,
      },
      commercialProposal && {
        stage: 'Commercial Proposal', date: commercialProposal.created_at,
        entity: 'commercial_proposal', id: commercialProposal.id,
        title: commercialProposal.proposal_number, owner: commercialProposal.prepared_by_name,
        value: commercialProposal.total_amount, status: commercialProposal.status,
        drive_link: commercialProposal.drive_link,
      },
      quotation && {
        stage: 'Quotation', date: quotation.created_at, entity: 'quotation', id: quotation.id,
        title: quotation.quotation_number, owner: quotation.created_by_name,
        value: quotation.total_amount, status: quotation.status,
        revision: quotation.revision, drive_link: quotation.drive_link,
        revisions: quotationRevisions,
      },
      salesOrder && {
        stage: 'Sales Order / PO', date: salesOrder.created_at,
        entity: 'sales_order', id: salesOrder.id,
        title: salesOrder.order_number, owner: salesOrder.created_by_name,
        value: salesOrder.total_amount, status: salesOrder.order_status,
      },
      project && {
        stage: 'Project', date: project.created_at, entity: 'project', id: project.id,
        title: project.project_code, owner: project.manager_name, status: project.status,
      },
      ...boms.map(b => ({
        stage: 'Engineering BOM', date: b.created_at, entity: 'bom', id: b.id,
        title: b.bom_number, owner: b.created_by_name, status: b.status, revision: b.revision,
      })),
      ...purchaseOrders.map(po => ({
        stage: 'Procurement / PO', date: po.created_at, entity: 'purchase_order', id: po.id,
        title: po.po_number, vendor: po.vendor_name, value: po.total_amount, status: po.status,
      })),
      ...grns.map(g => ({
        stage: 'GRN', date: g.receipt_date || g.created_at, entity: 'grn', id: g.id,
        title: g.grn_number, status: g.status,
      })),
      ...productionOrders.map(po => ({
        stage: 'Production', date: po.created_at, entity: 'production_order', id: po.id,
        title: po.production_order_no, status: po.status, bom_revision: po.bom_revision,
      })),
      ...fatReports.map(f => ({
        stage: 'FAT', date: f.actual_date || f.created_at, entity: 'fat_report', id: f.id,
        title: `FAT-${f.id}`, status: f.status, certificate: f.certificate_number,
        drive_link: f.drive_link,
      })),
      ...shipments.map(s => ({
        stage: 'Dispatch / Transport', date: s.dispatch_date || s.created_at,
        entity: 'shipment', id: s.id,
        title: s.shipment_number || s.tracking_number, status: s.status,
        carrier: s.carrier_name, pod_uploaded: !!s.pod_url,
      })),
      ...commissioningReports.map(c => ({
        stage: 'Commissioning', date: c.commissioning_date || c.created_at,
        entity: 'commissioning_report', id: c.id,
        title: `CR-${c.id}`, engineer: c.engineer_name, site: c.site_name,
        status: c.status, signed: !!c.customer_signature, drive_link: c.drive_link,
      })),
      ...satReports.map(s => ({
        stage: 'SAT', date: s.actual_date || s.created_at, entity: 'sat_report', id: s.id,
        title: s.sat_number, engineer: s.engineer_name, site: s.site_name,
        status: s.status, client_signed: s.client_signed_off, drive_link: s.drive_link,
      })),
      ...warranties.map(w => ({
        stage: 'Warranty', date: w.warranty_start_date || w.created_at,
        entity: 'warranty', id: w.id,
        title: `WR-${w.id}`, end_date: w.warranty_end_date, status: w.computed_status,
      })),
      ...serviceTickets.map(t => ({
        stage: 'Service', date: t.created_at, entity: 'service_ticket', id: t.id,
        title: t.ticket_number || `TKT-${t.id}`, type: t.ticket_type,
        priority: t.priority, status: t.status,
        cost: parseFloat(t.service_cost || 0) + parseFloat(t.parts_cost || 0),
      })),
      ...amcContracts.map(a => ({
        stage: 'AMC', date: a.start_date || a.created_at, entity: 'amc_contract', id: a.id,
        title: a.contract_number, value: a.contract_value, status: a.status,
        renewal_count: a.renewal_count, next_renewal: a.next_renewal_date,
        drive_link: a.drive_link,
      })),
    ].filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date));

    // ── CEO Traceability Answers (12 questions) ───────────────────────────
    const ceoAnswers = {
      q1_salesperson:         lead?.assigned_to_name || salesOrder?.created_by_name || 'Unknown',
      q2_approved_quotation:  quotationRevisions.find(q => q.status === 'accepted') || quotation,
      q3_bom_manufactured:    boms[0] ? { bom_number: boms[0].bom_number, revision: boms[0].revision } : null,
      q4_vendors_supplied:    vendors,
      q5_batches_consumed:    batches,
      q6_fat_report:          fatReports[0] || null,
      q7_shipment:            shipments[0] || null,
      q8_commissioning_engineer: commissioningReports[0]?.engineer_name || null,
      q9_service_tickets:     serviceTickets,
      q10_amc_contract:       amcContracts[0] || null,
      q11_profitability: {
        revenue:              parseFloat(project.revenue || 0),
        amc_revenue:          parseFloat(project.amc_revenue || 0),
        total_revenue:        parseFloat(project.total_revenue || 0),
        material_cost:        parseFloat(project.material_cost || 0),
        labour_cost:          parseFloat(project.labour_cost || 0),
        travel_cost:          parseFloat(project.travel_cost || 0),
        manufacturing_cost:   parseFloat(project.manufacturing_cost || 0),
        procurement_overhead: parseFloat(project.procurement_overhead || 0),
        quality_cost:         parseFloat(project.quality_cost || 0),
        installation_cost:    parseFloat(project.installation_cost || 0),
        commissioning_cost:   parseFloat(project.commissioning_cost || 0),
        service_cost:         parseFloat(project.service_cost || 0),
        total_cost:           parseFloat(project.total_cost || 0),
        profit:               parseFloat(project.profit || 0),
        margin_pct:           parseFloat(project.margin_pct || 0),
        cpi:                  parseFloat(project.cpi || 1),
        spi:                  parseFloat(project.spi || 1),
        last_calculated_at:   project.last_calculated_at,
      },
      q12_full_trace_available: stageHistory.length > 0 || !!lead,
    };

    res.json({
      project,
      ceo_answers:           ceoAnswers,
      timeline,
      stage_history:         stageHistory,
      opportunity_history:   opportunityStageHistory,
      procurement_spend_total: procurementSpend,
      detail: {
        lead,
        opportunity,
        technical_proposal:    technicalProposal,
        commercial_proposal:   commercialProposal,
        quotation,
        quotation_revisions:   quotationRevisions,
        sales_order:           salesOrder,
        lifecycle_instance:    lifecycle,
        boms,
        purchase_orders:       purchaseOrders,
        vendors,
        grns,
        batches_consumed:      batches,
        production_orders:     productionOrders,
        ncrs,
        fat_reports:           fatReports,
        sat_reports:           satReports,
        shipments,
        commissioning_reports: commissioningReports,
        warranties,
        service_tickets:       serviceTickets,
        amc_contracts:         amcContracts,
        milestones,
        documents,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
