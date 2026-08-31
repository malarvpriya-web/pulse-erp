import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);

// ── Health Score Engine ────────────────────────────────────────────────────────
function calcHealthScores(data) {
  const {
    proj, milestones, tasks, prodOrders, purchaseOrders,
    ncrs, fatRows, satRows, serviceTickets, lifecycle,
    costSummary,
  } = data;

  const today = new Date();

  // Schedule Score (0-100)
  let scheduleScore = 100;
  const totalMiles = milestones.length;
  const overdueMiles = milestones.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < today).length;
  const totalTasks = tasks.length;
  const overdueTasks = tasks.filter(t => t.status !== 'done' && t.due_date && new Date(t.due_date) < today).length;
  if (totalMiles > 0) scheduleScore -= (overdueMiles / totalMiles) * 40;
  if (totalTasks > 0) scheduleScore -= (overdueTasks / totalTasks) * 30;
  if (proj.end_date && new Date(proj.end_date) < today && proj.status !== 'completed') scheduleScore -= 20;
  scheduleScore = Math.max(0, Math.round(scheduleScore));

  // Budget Score (0-100)
  // projects has no contract_value/completion_percentage columns — real names are
  // budget_amount/progress_percentage (confirmed live; every reference here and below
  // silently read undefined→0, so budget scoring/alerts always treated revenue as 0).
  let budgetScore = 100;
  const revenue = parseFloat(proj.budget_amount || 0);
  const cs = costSummary || {};
  const totalCost = parseFloat(cs.total_cost || 0);
  if (revenue > 0 && totalCost > 0) {
    const pctUsed = totalCost / revenue;
    const completion = parseFloat(proj.progress_percentage || 0) / 100;
    if (pctUsed > 0.9) budgetScore -= 40;
    else if (pctUsed > 0.75) budgetScore -= 20;
    if (completion > 0 && pctUsed / completion > 1.2) budgetScore -= 20;
  }
  budgetScore = Math.max(0, Math.round(budgetScore));

  // Quality Score (0-100)
  let qualityScore = 100;
  const openNcrs = ncrs.filter(n => n.status !== 'closed').length;
  const totalNcrs = ncrs.length;
  if (openNcrs > 0) qualityScore -= Math.min(50, openNcrs * 15);
  const fatPassed = fatRows.filter(f => f.status === 'passed').length;
  if (fatRows.length > 0 && fatPassed === 0) qualityScore -= 20;
  qualityScore = Math.max(0, Math.round(qualityScore));

  // Procurement Score (0-100)
  let procScore = 100;
  const pendingPOs = purchaseOrders.filter(p => ['pending', 'sent', 'draft'].includes((p.status||'').toLowerCase())).length;
  if (purchaseOrders.length > 0) procScore -= (pendingPOs / purchaseOrders.length) * 40;
  procScore = Math.max(0, Math.round(procScore));

  // Production Score (0-100)
  let prodScore = 100;
  const doneProd = prodOrders.filter(p => p.status === 'completed').length;
  if (prodOrders.length > 0) prodScore = Math.round((doneProd / prodOrders.length) * 100);
  else prodScore = 80;

  // Commissioning Score (0-100)
  let commScore = 100;
  const commDone = lifecycle.filter(l => l.stage === 'commissioning' && l.status === 'completed').length;
  const commTotal = lifecycle.filter(l => l.stage === 'commissioning').length;
  if (commTotal > 0 && commDone === 0) commScore = 40;
  else if (commTotal === 0) commScore = 70;
  commScore = Math.max(0, commScore);

  // Service Score (0-100)
  let serviceScore = 100;
  const openTickets = serviceTickets.filter(t => t.status !== 'closed' && t.status !== 'Closed').length;
  if (openTickets > 5) serviceScore -= 40;
  else if (openTickets > 2) serviceScore -= 20;
  else if (openTickets > 0) serviceScore -= 10;
  serviceScore = Math.max(0, serviceScore);

  const overall = Math.round(
    scheduleScore * 0.25 + budgetScore * 0.20 + qualityScore * 0.15 +
    procScore * 0.15 + prodScore * 0.10 + commScore * 0.10 + serviceScore * 0.05
  );

  const label = overall >= 85 ? 'Excellent' : overall >= 70 ? 'Good' : overall >= 50 ? 'Watchlist' : 'Critical';
  const color = overall >= 85 ? '#16a34a' : overall >= 70 ? '#2563eb' : overall >= 50 ? '#d97706' : '#dc2626';

  return {
    overall, label, color,
    schedule: scheduleScore, budget: budgetScore, quality: qualityScore,
    procurement: procScore, production: prodScore,
    commissioning: commScore, service: serviceScore,
  };
}

// ── Risk Engine ────────────────────────────────────────────────────────────────
function calcRisks(data) {
  const { proj, milestones, purchaseOrders, ncrs, serviceTickets, lifecycle, invoices, today } = data;

  const risks = [];
  const now = today || new Date();

  const overdueMiles = milestones.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < now);
  if (overdueMiles.length > 0) risks.push({ category: 'Schedule', level: overdueMiles.length > 2 ? 'Critical' : 'High', description: `${overdueMiles.length} milestone(s) overdue` });

  const revenue = parseFloat(proj.budget_amount || 0);
  const totalCost = parseFloat(data.costSummary?.total_cost || 0);
  if (revenue > 0 && totalCost > revenue * 0.85) risks.push({ category: 'Cost', level: totalCost > revenue ? 'Critical' : 'High', description: `Cost at ${Math.round(totalCost/revenue*100)}% of budget` });

  const pendingPOs = purchaseOrders.filter(p => ['pending','sent','draft'].includes((p.status||'').toLowerCase()));
  if (pendingPOs.length > 3) risks.push({ category: 'Procurement', level: 'High', description: `${pendingPOs.length} purchase orders pending` });

  const openNcrs = ncrs.filter(n => n.status !== 'closed');
  if (openNcrs.length > 0) risks.push({ category: 'Quality', level: openNcrs.length > 3 ? 'Critical' : 'Medium', description: `${openNcrs.length} open NCR(s)` });

  const openTickets = serviceTickets.filter(t => t.status !== 'closed' && t.status !== 'Closed');
  if (openTickets.length > 3) risks.push({ category: 'Service', level: 'Medium', description: `${openTickets.length} open service tickets` });

  const commStarted = lifecycle.some(l => l.stage === 'commissioning');
  if (!commStarted && proj.end_date && new Date(proj.end_date) < new Date(Date.now() + 60*24*60*60*1000)) {
    risks.push({ category: 'Commissioning', level: 'High', description: 'Commissioning not started, project end approaching' });
  }

  const unpaidInvoices = invoices.filter(i => (i.status||'').toLowerCase() !== 'paid' && i.due_date && new Date(i.due_date) < now);
  if (unpaidInvoices.length > 0) risks.push({ category: 'Customer', level: unpaidInvoices.length > 2 ? 'Critical' : 'Medium', description: `${unpaidInvoices.length} overdue invoice(s)` });

  return risks.length ? risks : [{ category: 'Overall', level: 'Low', description: 'No significant risks identified' }];
}

// ── Timeline Builder ──────────────────────────────────────────────────────────
function buildTimeline(data) {
  const events = [];
  const push = (date, label, icon, color) => {
    if (date) events.push({ date: new Date(date), label, icon, color, display: new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) });
  };
  const { proj, quotations, salesOrders, milestones, fatRows, satRows, dispatches, lifecycle, amcContracts, serviceTickets } = data;

  if (quotations[0]?.created_at) push(quotations[0].created_at, `Quotation ${quotations[0].quotation_number || ''} Created`, '📋', '#6366f1');
  if (salesOrders[0]?.order_date) push(salesOrders[0].order_date, `PO ${salesOrders[0].order_number || ''} Received`, '📦', '#7c3aed');
  push(proj.start_date, 'Project Started', '🚀', '#2563eb');
  milestones.forEach(m => {
    if (m.status === 'completed' && m.completed_at) push(m.completed_at, `Milestone: ${m.name}`, '🏁', '#16a34a');
    else if (m.due_date) push(m.due_date, `Milestone Due: ${m.name}`, '📅', m.status === 'completed' ? '#16a34a' : '#d97706');
  });
  fatRows.forEach(f => push(f.completed_date || f.scheduled_date, `FAT ${f.fat_number || ''} ${f.status === 'passed' ? 'Passed' : 'Scheduled'}`, '🔬', f.status === 'passed' ? '#16a34a' : '#2563eb'));
  dispatches.forEach(d => push(d.dispatch_date, `Dispatch ${d.shipment_number || ''}`, '🚛', '#0891b2'));
  satRows.forEach(s => push(s.client_signoff_date || s.scheduled_date, `SAT ${s.sat_number || ''} ${s.status === 'passed' ? 'Accepted' : 'Scheduled'}`, '✅', s.status === 'passed' ? '#16a34a' : '#2563eb'));
  lifecycle.forEach(l => {
    if (l.started_at) push(l.started_at, `${l.stage.charAt(0).toUpperCase() + l.stage.slice(1)} Started`, '⚙️', '#7c3aed');
    if (l.completed_at) push(l.completed_at, `${l.stage.charAt(0).toUpperCase() + l.stage.slice(1)} Completed`, '✅', '#16a34a');
  });
  amcContracts.forEach(a => push(a.start_date, `AMC ${a.contract_number || ''} Activated`, '🛡️', '#0891b2'));
  push(proj.end_date, proj.status === 'completed' ? 'Project Completed' : 'Project End (Planned)', proj.status === 'completed' ? '🏆' : '🎯', proj.status === 'completed' ? '#16a34a' : '#6b7280');

  events.sort((a, b) => a.date - b.date);
  return events.map(({ date, ...rest }) => rest);
}

// ── AI Copilot ────────────────────────────────────────────────────────────────
function generateAIAnswer(question, projectData) {
  const { proj, milestones, purchaseOrders, ncrs, serviceTickets, timesheets, finance, timeline } = projectData;
  const today = new Date();
  const q = (question || '').toLowerCase();

  const overdueMiles = milestones.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < today);
  const pendingPOs = purchaseOrders.filter(p => ['pending','sent','draft'].includes((p.status||'').toLowerCase()));
  const openNcrs = ncrs.filter(n => n.status !== 'closed');
  const openTickets = serviceTickets.filter(t => t.status !== 'closed' && t.status !== 'Closed');
  const margin = parseFloat(finance?.margin_pct || 0);

  if (q.includes('delay') || q.includes('schedule')) {
    if (overdueMiles.length === 0) return `✅ Project ${proj.project_number} is on schedule. No milestones are overdue.`;
    return `⚠️ Project is delayed. ${overdueMiles.length} milestone(s) overdue:\n${overdueMiles.map(m => `• ${m.name} (due ${new Date(m.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })})`).join('\n')}\nRecommendation: Escalate and replanning required.`;
  }
  if (q.includes('material') || q.includes('block')) {
    if (pendingPOs.length === 0) return `✅ All purchase orders are confirmed. No material blocking.`;
    return `🔴 ${pendingPOs.length} PO(s) are pending — these may be blocking material readiness:\n${pendingPOs.slice(0,5).map(p => `• ${p.po_number} — ${p.vendor_name || 'Unknown vendor'} (${p.status})`).join('\n')}`;
  }
  if (q.includes('supplier') || q.includes('vendor') || q.includes('risk')) {
    const riskVendors = [...new Set(pendingPOs.map(p => p.vendor_name).filter(Boolean))];
    if (riskVendors.length === 0) return `✅ No risky suppliers identified. All POs confirmed.`;
    return `⚠️ Risky suppliers (pending POs):\n${riskVendors.slice(0,5).map(v => `• ${v}`).join('\n')}\nAction: Follow up on delivery timelines.`;
  }
  if (q.includes('margin') || q.includes('profit')) {
    const status = margin >= 20 ? '✅ Excellent' : margin >= 15 ? '✅ Good' : margin >= 10 ? '⚠️ Acceptable' : '🔴 Below target';
    return `${status} — Current margin: ${margin.toFixed(1)}%\nRevenue: ₹${(parseFloat(finance?.revenue||0)/100000).toFixed(2)}L | Cost: ₹${(parseFloat(finance?.total_cost||0)/100000).toFixed(2)}L | Profit: ₹${(parseFloat(finance?.actual_profit||0)/100000).toFixed(2)}L`;
  }
  if (q.includes('overdue') || q.includes('task')) {
    if (overdueMiles.length === 0) return `✅ No overdue milestones. Project tasks are on track.`;
    return `📋 ${overdueMiles.length} overdue milestone(s) found:\n${overdueMiles.map(m => `• ${m.name}`).join('\n')}`;
  }
  if (q.includes('finish') || q.includes('complete') || q.includes('end')) {
    const pct = parseFloat(proj.progress_percentage || 0);
    const endDate = proj.end_date ? new Date(proj.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'Not set';
    return `📅 Planned completion: ${endDate}\nCurrent progress: ${pct}%\n${pct >= 90 ? '✅ Near completion' : pct >= 50 ? '🔄 In progress' : '⚠️ Early stage'}`;
  }
  if (q.includes('ncr') || q.includes('quality')) {
    if (openNcrs.length === 0) return `✅ No open NCRs. Quality is in good standing.`;
    return `🔴 ${openNcrs.length} open NCR(s) require attention. CAPA closure should be prioritized.`;
  }
  if (q.includes('service') || q.includes('ticket')) {
    if (openTickets.length === 0) return `✅ No open service tickets.`;
    return `🔧 ${openTickets.length} open service ticket(s). Ensure timely resolution to maintain customer satisfaction.`;
  }
  if (q.includes('summary') || q.includes('executive')) {
    const revenue = parseFloat(finance?.revenue || 0);
    const cost = parseFloat(finance?.total_cost || 0);
    const pct = parseFloat(proj.progress_percentage || 0);
    return `📊 EXECUTIVE SUMMARY — ${proj.project_name}\n\nProject: ${proj.project_number} | Customer: ${proj.customer_name || '—'}\nStatus: ${proj.status?.toUpperCase()} | Progress: ${pct}%\n\nFinancials:\n• Revenue: ₹${(revenue/100000).toFixed(2)}L\n• Cost: ₹${(cost/100000).toFixed(2)}L\n• Profit: ₹${((revenue-cost)/100000).toFixed(2)}L\n• Margin: ${margin.toFixed(1)}%\n\nKey Alerts:\n${overdueMiles.length > 0 ? `• ${overdueMiles.length} overdue milestone(s)\n` : ''}${pendingPOs.length > 0 ? `• ${pendingPOs.length} pending PO(s)\n` : ''}${openNcrs.length > 0 ? `• ${openNcrs.length} open NCR(s)\n` : ''}${openTickets.length > 0 ? `• ${openTickets.length} open service ticket(s)\n` : ''}${overdueMiles.length === 0 && pendingPOs.length === 0 && openNcrs.length === 0 ? '• No critical alerts\n' : ''}`;
  }
  return `I can help you with: delay analysis, material blocking, supplier risk, margin/profit, overdue tasks, completion date, quality/NCR, service tickets, or generate an executive summary. Please ask a specific question.`;
}

// ── GET /project-360/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const pid = req.params.id;
    const companyId = cid(req);
    const cc = companyId ? ` AND company_id=${companyId}` : '';

    const [
      projectR, opportunityR, quotationsR, salesOrdersR, bomR, drawingDocsR,
      purchaseReqsR, purchaseOrdersR, grnsR, prodOrdersR, timesheetsR,
      fatTrackersR, satTrackersR, dispatchesR, commissionsR, serviceTicketsR,
      warrantyR, amcContractsR, invoicesR, costSummaryR, issuesR, milestonesR,
      travelRequestsR, tasksR, ncrsR, capasR, rmIssuesR, inspectionsR,
    ] = await Promise.allSettled([
      pool.query(`SELECT * FROM projects WHERE id=$1`, [pid]),
      // opportunities/quotations/sales_orders/invoices have no project_id column — but
      // projects.opportunity_id IS a real, correctly-populated FK on both live
      // project-creation paths (opportunityConversion.service.js's auto-convert-on-won,
      // sales.routes.js's sales-order bootstrap) — it's just NULL on this pilot's 3
      // manually-created projects (thin data, not a broken mechanism). Bridged through it:
      // opportunities directly, quotations via opportunity_id, sales_orders via
      // quotations.opportunity_id, invoices via sales_orders further down.
      pool.query(`
        SELECT o.* FROM opportunities o
        WHERE o.id = (SELECT opportunity_id FROM projects WHERE id=$1)${cc.replace(/company_id/g, 'o.company_id')}
        LIMIT 1
      `, [pid]),
      // quotations has no salesperson column and no real substitute (only created_by,
      // a user id, not a name) — dropped rather than fabricated.
      pool.query(`
        SELECT id, quotation_number, created_at, total_amount, status FROM quotations
        WHERE opportunity_id = (SELECT opportunity_id FROM projects WHERE id=$1)${cc}
        ORDER BY created_at DESC LIMIT 5
      `, [pid]),
      pool.query(`
        SELECT so.id, so.order_number, so.order_date, so.total_amount, so.order_status AS status, so.customer_name
        FROM sales_orders so
        JOIN quotations q ON q.id = so.quotation_id
        WHERE q.opportunity_id = (SELECT opportunity_id FROM projects WHERE id=$1)${cc.replace(/company_id/g, 'so.company_id')}
        ORDER BY so.order_date DESC LIMIT 5
      `, [pid]),
      // boms/bom_items don't exist — BOMs are product-scoped (bom_headers.product_id),
      // not project-scoped, so there's no direct FK either. Real bridge: a project's
      // production_orders each reference a bom_id.
      pool.query(`
        SELECT DISTINCT bh.id, bh.bom_number, bh.created_at, bh.status,
               (SELECT COUNT(*) FROM bom_lines WHERE bom_id = bh.id) AS item_count,
               (SELECT COALESCE(SUM(unit_cost * qty), 0) FROM bom_lines WHERE bom_id = bh.id) AS bom_value
        FROM bom_headers bh
        JOIN production_orders po ON po.bom_id = bh.id
        WHERE po.project_id=$1${cc.replace(/company_id/g, 'po.company_id')}
        ORDER BY bh.created_at DESC LIMIT 5
      `, [pid]),
      // project_documents has no doc_type column — real is document_type.
      pool.query(`SELECT id, document_name, document_type AS doc_type, revision AS version, status, created_at FROM project_documents WHERE project_id=$1 ORDER BY created_at DESC LIMIT 15`, [pid]),
      // purchase_requests has no project_id column at all, and — unlike opportunities/
      // quotations/sales_orders/invoices above — no opportunity_id/quotation_id either, so
      // there's no bridge to build even via projects.opportunity_id. Checked
      // purchase_request_items too, in case the link lived one level down — it doesn't.
      // Genuinely unfixable without a new column; left throwing/caught.
      pool.query(`SELECT id, pr_number, request_date AS requested_date, status, total_amount AS total_estimated_cost FROM purchase_requests WHERE project_id=$1${cc} ORDER BY request_date DESC LIMIT 10`, [pid]),
      // purchase_orders has no vendor_name column — real vendor identity is supplier_id,
      // joined to vendors. Every pendingPOs alert/risk line downstream had always shown
      // "PO0006 — undefined" for the vendor half of that string.
      pool.query(`
        SELECT po.id, po.po_number, po.order_date, po.total_amount, po.status, v.vendor_name
        FROM purchase_orders po
        LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE po.project_id=$1${cc.replace(/company_id/g, 'po.company_id')}
        ORDER BY po.order_date DESC LIMIT 15
      `, [pid]),
      // goods_receipts doesn't exist and goods_receipt_notes has no project_id — bridge
      // through purchase_orders.project_id (same pattern as vendorHealth.service.js's fix).
      pool.query(`
        SELECT grn.id, grn.grn_number, grn.received_date, grn.status
        FROM goods_receipt_notes grn
        JOIN purchase_orders po ON po.id = grn.po_id
        WHERE po.project_id=$1 AND grn.deleted_at IS NULL${companyId ? ` AND po.company_id=${companyId}` : ''}
        ORDER BY grn.received_date DESC LIMIT 10
      `, [pid]),
      // production_orders: real columns are production_order_no/planned_start_date/
      // planned_end_date/quantity_planned, not order_number/planned_start/planned_end/quantity.
      pool.query(`SELECT id, production_order_no AS order_number, planned_start_date AS planned_start, planned_end_date AS planned_end, status, quantity_planned AS quantity FROM production_orders WHERE project_id=$1${cc} ORDER BY planned_start_date DESC LIMIT 10`, [pid]),
      // timesheets has no project_id/employee_name/hours/billing_rate at all — it's a
      // weekly per-employee approval header, not a project-hours ledger. The real
      // per-project detail table is timesheet_entries (has project_id, hours_worked,
      // billable_amount already computed); joined to employees for the name.
      pool.query(`
        SELECT e.name AS employee_name, SUM(te.hours_worked) AS total_hours, SUM(COALESCE(te.billable_amount,0)) AS cost
        FROM timesheet_entries te
        LEFT JOIN employees e ON e.id = te.employee_id
        WHERE te.project_id=$1 AND te.status='Approved'${companyId ? ` AND te.company_id=${companyId}` : ''}
        GROUP BY e.name ORDER BY total_hours DESC LIMIT 10
      `, [pid]),
      pool.query(`SELECT * FROM fat_trackers WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]),
      pool.query(`SELECT * FROM sat_trackers WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]),
      // shipments has no project_id/shipment_number/destination — it's polymorphic
      // (reference_type/reference_id, only 'purchase_order'/'sales_order' in practice).
      // Bridges to this project's purchase orders; the sales_order side is left out —
      // see the opportunities/quotations/sales_orders note above, same missing-link gap.
      pool.query(`
        SELECT s.id, s.id AS shipment_number, s.dispatch_date, s.status,
               s.to_address AS destination, s.tracking_number
        FROM shipments s
        WHERE s.reference_type='purchase_order'
          AND s.reference_id IN (SELECT id FROM purchase_orders WHERE project_id=$1${cc})
        ORDER BY s.dispatch_date DESC LIMIT 10
      `, [pid]),
      // lifecycle_events doesn't exist. lifecycle_instances looked like the obvious real-schema
      // match (has project_id) but its current_stage check constraint only allows
      // order/design/procurement/production/testing/dispatch/installation/service/amc — never
      // 'commissioning', the one literal calcHealthScores/calcRisks below actually check for, so
      // it can never satisfy that logic even joined correctly. commissioning_workflows is the
      // real, purpose-built table: direct project_id, real status values including 'completed'
      // (confirmed in commissioning.routes.js's own status transitions).
      pool.query(`
        SELECT id, 'commissioning' AS stage,
               COALESCE(checkin_time, scheduled_date) AS started_at,
               completed_date AS completed_at,
               status, notes
        FROM commissioning_workflows
        WHERE project_id=$1${cc}
        ORDER BY COALESCE(completed_date, scheduled_date) DESC LIMIT 10
      `, [pid]),
      // service_tickets doesn't exist — the real table is support_tickets, which (unlike
      // Customer Health's contact/account bridge) already carries project_id directly; no
      // column called `subject` either, it's `title`.
      pool.query(`SELECT id, ticket_number, created_at, status, priority, title AS subject FROM support_tickets WHERE project_id=$1 AND deleted_at IS NULL${cc} ORDER BY created_at DESC LIMIT 10`, [pid]),
      // project_warranties has no start_date column — real is warranty_start_date.
      pool.query(`SELECT * FROM project_warranties WHERE project_id=$1 ORDER BY warranty_start_date DESC LIMIT 5`, [pid]),
      // amc_contracts has no annual_value column — real is contract_value (output key kept as annual_value).
      pool.query(`SELECT id, contract_number, start_date, end_date, contract_value AS annual_value, status FROM amc_contracts WHERE project_id=$1${cc} ORDER BY start_date DESC LIMIT 5`, [pid]),
      // invoices has no project_id — only sales_order_id (and no `amount` column, real is
      // total_amount). Bridged through the same opportunity_id chain as sales_orders above.
      pool.query(`
        SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount AS amount, i.status, i.due_date
        FROM invoices i
        JOIN sales_orders so ON so.id = i.sales_order_id
        JOIN quotations q ON q.id = so.quotation_id
        WHERE q.opportunity_id = (SELECT opportunity_id FROM projects WHERE id=$1)${cc.replace(/company_id/g, 'i.company_id')}
        ORDER BY i.invoice_date DESC LIMIT 15
      `, [pid]),
      // projects has no contract_value column — real is budget_amount (output key kept as revenue).
      pool.query(`
        SELECT p.budget_amount AS revenue,
               COALESCE(pcs.material_cost,0) AS material_cost,
               COALESCE(pcs.labour_cost,0) AS labour_cost,
               COALESCE(pcs.travel_cost,0) AS travel_cost,
               COALESCE(pcs.procurement_overhead,0) AS overhead,
               COALESCE(pcs.engineering_cost,0) AS engineering_cost,
               COALESCE(pcs.production_cost,0) AS production_cost,
               COALESCE(pcs.quality_cost,0) AS quality_cost,
               COALESCE(pcs.transport_cost,0) AS transport_cost,
               COALESCE(pcs.installation_cost,0) AS installation_cost,
               COALESCE(pcs.commissioning_cost,0) AS commissioning_cost,
               COALESCE(pcs.service_cost,0) AS service_cost,
               COALESCE(pcs.amc_cost,0) AS amc_cost,
               COALESCE(pcs.profit,0) AS actual_profit,
               CASE WHEN p.budget_amount > 0 THEN ROUND(COALESCE(pcs.profit,0)/p.budget_amount*100,2) ELSE 0 END AS margin_pct
        FROM projects p LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE p.id=$1
      `, [pid]),
      pool.query(`SELECT id, title, severity, status, created_at, is_blocker FROM project_issues WHERE project_id=$1 ORDER BY created_at DESC LIMIT 15`, [pid]),
      // project_milestones has no name/completed_at — real are title/completed_date.
      pool.query(`SELECT id, title AS name, due_date, status, amount, billing_milestone, completed_date AS completed_at FROM project_milestones WHERE project_id=$1 ORDER BY due_date ASC`, [pid]),
      pool.query(`SELECT id, request_number, travel_type, from_date, to_date, budget, status, employee_name, destination FROM travel_requests WHERE project_id=$1${cc} ORDER BY from_date DESC LIMIT 10`, [pid]),
      // project_tasks was always empty (Gantt's dead-end legacy table, fixed in §95/96
      // to write the same unified `tasks` table Task List/Kanban use) — repointed here
      // so this widget finally shows real data instead of a permanently empty list.
      // COALESCE(due_date, end_date) covers tasks created from either surface.
      pool.query(`
        SELECT t.id, t.task_title, t.status, COALESCE(t.due_date, t.end_date) AS due_date,
               CONCAT(e.first_name, ' ', e.last_name) AS assignee_name
        FROM tasks t LEFT JOIN employees e ON e.id = t.assigned_to
        WHERE t.project_id=$1 AND t.deleted_at IS NULL
        ORDER BY COALESCE(t.due_date, t.end_date) ASC NULLS LAST LIMIT 20
      `, [pid]),
      pool.query(`SELECT id, ncr_number, description, severity, status, created_at, containment_action FROM ncr_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 10`, [pid]),
      // capa_actions has no action_description — real is description (same drift already
      // fixed in vendor360.repository.js's identical query).
      pool.query(`SELECT ca.id, ca.description AS action_description, ca.status, ca.due_date, ca.completion_date AS completed_at, nr.ncr_number FROM capa_actions ca JOIN ncr_reports nr ON nr.id=ca.ncr_id WHERE nr.project_id=$1 ORDER BY ca.due_date ASC LIMIT 10`, [pid]),
      // rm_issues doesn't exist — real table is material_issue_logs, bridged through
      // production_orders.project_id (material_issue_logs itself has no project_id).
      pool.query(`
        SELECT mil.id, mil.item_name, mil.qty_issued AS quantity_issued, mil.issued_at AS issue_date, NULL AS batch_number
        FROM material_issue_logs mil
        JOIN production_orders po ON po.id = mil.production_order_id
        WHERE po.project_id=$1${cc.replace(/company_id/g, 'po.company_id')}
        ORDER BY mil.issued_at DESC LIMIT 15
      `, [pid]),
      // inspection_reports has no project_id/report_number/inspection_type/result — real
      // are (bridge via grn_id → goods_receipt_notes → purchase_orders.project_id, same
      // pattern as the GRN fix above)/id/stage/overall_result.
      pool.query(`
        SELECT ir.id, ir.id AS report_number, ir.stage AS inspection_type, ir.overall_result AS result, ir.inspected_at AS created_at
        FROM inspection_reports ir
        JOIN goods_receipt_notes grn ON grn.id = ir.grn_id
        JOIN purchase_orders po ON po.id = grn.po_id
        WHERE po.project_id=$1${cc.replace(/company_id/g, 'po.company_id')}
        ORDER BY ir.inspected_at DESC LIMIT 10
      `, [pid]),
    ]);

    const safe = r => r.status === 'fulfilled' ? (r.value?.rows || []) : [];
    const safeOne = r => r.status === 'fulfilled' ? (r.value?.rows?.[0] || null) : null;

    const proj = safeOne(projectR);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const cs = safeOne(costSummaryR) || {};
    const milestoneRows  = safe(milestonesR);
    const invoiceRows    = safe(invoicesR);
    const purchaseOrderRows = safe(purchaseOrdersR);
    const ncrsRows       = safe(ncrsR);
    const serviceTicketRows = safe(serviceTicketsR);
    const lifecycleRows  = safe(commissionsR);
    const fatRows        = safe(fatTrackersR);
    const satRows        = safe(satTrackersR);
    const dispatchRows   = safe(dispatchesR);
    const amcRows        = safe(amcContractsR);
    const quotationRows  = safe(quotationsR);
    const salesOrderRows = safe(salesOrdersR);
    const taskRows       = safe(tasksR);
    const tsRows         = safe(timesheetsR);
    const prodOrderRows  = safe(prodOrdersR);

    const revenue      = parseFloat(cs.revenue || proj.budget_amount || 0);
    const materialCost = parseFloat(cs.material_cost || 0);
    const labourCost   = parseFloat(cs.labour_cost || 0);
    const travelCost   = parseFloat(cs.travel_cost || 0);
    const overhead     = parseFloat(cs.overhead || 0);
    const engCost      = parseFloat(cs.engineering_cost || 0);
    const prodCost     = parseFloat(cs.production_cost || 0);
    const qualCost     = parseFloat(cs.quality_cost || 0);
    const transCost    = parseFloat(cs.transport_cost || 0);
    const installCost  = parseFloat(cs.installation_cost || 0);
    const commCost     = parseFloat(cs.commissioning_cost || 0);
    const serviceCost  = parseFloat(cs.service_cost || 0);
    const amcCost      = parseFloat(cs.amc_cost || 0);
    const totalCost    = materialCost + labourCost + travelCost + overhead + engCost + prodCost + qualCost + transCost + installCost + commCost + serviceCost + amcCost;
    const actualProfit = revenue - totalCost;
    const marginPct    = revenue > 0 ? parseFloat(((actualProfit / revenue) * 100).toFixed(2)) : 0;

    const invoiceRevenue  = invoiceRows.filter(i => (i.status||'').toLowerCase() === 'paid').reduce((s, i) => s + parseFloat(i.amount||0), 0);
    const invoicePending  = invoiceRows.filter(i => (i.status||'').toLowerCase() !== 'paid').reduce((s, i) => s + parseFloat(i.amount||0), 0);
    const milestoneRevenue = milestoneRows.filter(m => m.status === 'completed').reduce((s, m) => s + parseFloat(m.amount||0), 0);

    const financeData = {
      revenue, material_cost: materialCost, labour_cost: labourCost, travel_cost: travelCost,
      overhead, engineering_cost: engCost, production_cost: prodCost, quality_cost: qualCost,
      transport_cost: transCost, installation_cost: installCost, commissioning_cost: commCost,
      service_cost: serviceCost, amc_cost: amcCost, total_cost: totalCost,
      actual_profit: actualProfit, margin_pct: marginPct,
      invoices: invoiceRows, invoice_revenue: invoiceRevenue,
      invoice_pending: invoicePending, milestone_revenue: milestoneRevenue,
    };

    // Health + Risk + Timeline
    const healthScores = calcHealthScores({
      proj, milestones: milestoneRows, tasks: taskRows, prodOrders: prodOrderRows,
      purchaseOrders: purchaseOrderRows, ncrs: ncrsRows, fatRows, satRows,
      serviceTickets: serviceTicketRows, lifecycle: lifecycleRows,
      costSummary: { total_cost: totalCost },
    });

    const riskItems = calcRisks({
      proj, milestones: milestoneRows, purchaseOrders: purchaseOrderRows,
      ncrs: ncrsRows, serviceTickets: serviceTicketRows,
      lifecycle: lifecycleRows, invoices: invoiceRows,
      costSummary: { total_cost: totalCost }, today: new Date(),
    });

    const timelineEvents = buildTimeline({
      proj, quotations: quotationRows, salesOrders: salesOrderRows,
      milestones: milestoneRows, fatRows, satRows,
      dispatches: dispatchRows, lifecycle: lifecycleRows, amcContracts: amcRows,
    });

    // War Room alerts
    const alerts = [];
    const overdueMiles = milestoneRows.filter(m => m.status !== 'completed' && m.due_date && new Date(m.due_date) < new Date());
    if (overdueMiles.length > 0) alerts.push({ type: 'Schedule', level: 'critical', msg: `${overdueMiles.length} milestone(s) overdue`, items: overdueMiles.map(m => m.name) });
    const pendingPOs = purchaseOrderRows.filter(p => ['pending','sent','draft'].includes((p.status||'').toLowerCase()));
    if (pendingPOs.length > 2) alerts.push({ type: 'Procurement', level: 'high', msg: `${pendingPOs.length} POs pending confirmation`, items: pendingPOs.slice(0,5).map(p => `${p.po_number} — ${p.vendor_name||''}`) });
    if (ncrsRows.filter(n => n.status !== 'closed').length > 0) alerts.push({ type: 'Quality', level: 'high', msg: `${ncrsRows.filter(n => n.status !== 'closed').length} open NCR(s)`, items: ncrsRows.filter(n => n.status !== 'closed').map(n => n.ncr_number || n.description) });
    if (totalCost > revenue * 0.9) alerts.push({ type: 'Budget', level: 'critical', msg: `Cost at ${Math.round(totalCost/revenue*100)}% of revenue`, items: [] });
    const overdueInv = invoiceRows.filter(i => (i.status||'').toLowerCase() !== 'paid' && i.due_date && new Date(i.due_date) < new Date());
    if (overdueInv.length > 0) alerts.push({ type: 'Collections', level: 'critical', msg: `${overdueInv.length} overdue invoice(s)`, items: overdueInv.map(i => i.invoice_number) });
    if (serviceTicketRows.filter(t => t.priority === 'Critical' || t.priority === 'High').filter(t => t.status !== 'closed').length > 0) alerts.push({ type: 'Service', level: 'high', msg: 'Critical/High priority service tickets open', items: serviceTicketRows.filter(t => (t.priority === 'Critical' || t.priority === 'High') && t.status !== 'closed').map(t => t.ticket_number || t.subject) });

    res.json({
      project: {
        id: proj.id, name: proj.name || proj.project_name, project_number: proj.project_number,
        customer_name: proj.customer_name, status: proj.status, start_date: proj.start_date,
        end_date: proj.end_date, contract_value: parseFloat(proj.budget_amount || 0),
        description: proj.description, site_name: proj.site_name,
        completion_pct: proj.progress_percentage || 0,
        project_manager: proj.project_manager || proj.manager_name,
        // sales_engineer/application_engineer/site_name/po_number: no such columns on
        // projects (checked live) and no unambiguous real-schema equivalent found —
        // left as-is rather than guessing a join; flagged, not fixed.
        sales_engineer: proj.sales_engineer || proj.salesperson,
        application_engineer: proj.application_engineer,
        po_number: proj.po_number,
      },
      health: healthScores,
      alerts,
      risks: riskItems,
      timeline: timelineEvents,
      sales: {
        opportunity: safeOne(opportunityR),
        quotations: quotationRows,
        sales_orders: salesOrderRows,
      },
      engineering: {
        boms: safe(bomR),
        drawings: safe(drawingDocsR),
      },
      procurement: {
        purchase_requests: safe(purchaseReqsR),
        purchase_orders:   purchaseOrderRows,
        grns:              safe(grnsR),
      },
      inventory: {
        rm_issues: safe(rmIssuesR),
      },
      manufacturing: {
        production_orders: prodOrderRows,
        timesheets: tsRows,
        total_hours: tsRows.reduce((s, t) => s + parseFloat(t.total_hours || 0), 0),
        labour_cost: tsRows.reduce((s, t) => s + parseFloat(t.cost || 0), 0),
      },
      quality: {
        ncrs:        ncrsRows,
        capas:       safe(capasR),
        inspections: safe(inspectionsR),
        fat_trackers: fatRows,
        sat_trackers: satRows,
        ncr_open:    ncrsRows.filter(n => n.status !== 'closed').length,
        capa_open:   safe(capasR).filter(c => c.status !== 'completed').length,
        pass_rate:   fatRows.length > 0 ? Math.round(fatRows.filter(f => f.status === 'passed').length / fatRows.length * 100) : null,
      },
      site: {
        fat_trackers: fatRows,
        sat_trackers: satRows,
        dispatches:   dispatchRows,
        lifecycle:    lifecycleRows,
      },
      service: {
        tickets:    serviceTicketRows,
        warranty:   safe(warrantyR),
        amc:        amcRows,
        travel:     safe(travelRequestsR),
      },
      issues:     safe(issuesR),
      milestones: milestoneRows,
      tasks:      taskRows,
      finance:    financeData,
    });
  } catch (err) {
    console.error('[project360]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /project-360/:id/ask ─ AI Copilot ────────────────────────────────────
router.post('/:id/ask', async (req, res) => {
  try {
    const pid = req.params.id;
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    const companyId = cid(req);
    const cc = companyId ? ` AND company_id=${companyId}` : '';

    const [projR, milesR, posR, ncrsR, ticketsR, invoicesR, finR] = await Promise.allSettled([
      pool.query(`SELECT * FROM projects WHERE id=$1`, [pid]),
      // project_milestones has no name column — real is title.
      pool.query(`SELECT title AS name, due_date, status FROM project_milestones WHERE project_id=$1`, [pid]),
      pool.query(`
        SELECT po.po_number, v.vendor_name, po.status
        FROM purchase_orders po
        LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE po.project_id=$1${cc.replace(/company_id/g, 'po.company_id')}
      `, [pid]),
      pool.query(`SELECT ncr_number, description, status FROM ncr_reports WHERE project_id=$1`, [pid]),
      pool.query(`SELECT ticket_number, title AS subject, priority, status FROM support_tickets WHERE project_id=$1 AND deleted_at IS NULL${cc}`, [pid]),
      // Same opportunity_id-chain bridge and amount->total_amount rename as the main handler.
      pool.query(`
        SELECT i.invoice_number, i.total_amount AS amount, i.status, i.due_date
        FROM invoices i
        JOIN sales_orders so ON so.id = i.sales_order_id
        JOIN quotations q ON q.id = so.quotation_id
        WHERE q.opportunity_id = (SELECT opportunity_id FROM projects WHERE id=$1)${cc.replace(/company_id/g, 'i.company_id')}
      `, [pid]),
      // projects has no contract_value column (real: budget_amount); project_cost_summary
      // has no actual_profit column (real: profit).
      pool.query(`SELECT p.budget_amount AS revenue, COALESCE(pcs.profit,0) AS actual_profit, CASE WHEN p.budget_amount>0 THEN ROUND(COALESCE(pcs.profit,0)/p.budget_amount*100,2) ELSE 0 END AS margin_pct, (p.budget_amount - COALESCE(pcs.material_cost,0) - COALESCE(pcs.labour_cost,0)) AS total_cost FROM projects p LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id WHERE p.id=$1`, [pid]),
    ]);

    const safe = r => r.status === 'fulfilled' ? (r.value?.rows || []) : [];
    const proj = (projR.status === 'fulfilled' ? projR.value?.rows?.[0] : null);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const finRow = finR.status === 'fulfilled' ? finR.value?.rows?.[0] : {};
    const totalCostCalc = parseFloat(proj.budget_amount||0) - parseFloat(finRow?.actual_profit||0);

    const answer = generateAIAnswer(question, {
      proj, milestones: safe(milesR), purchaseOrders: safe(posR),
      ncrs: safe(ncrsR), serviceTickets: safe(ticketsR),
      timesheets: [], timeline: [],
      finance: { revenue: finRow?.revenue, actual_profit: finRow?.actual_profit, margin_pct: finRow?.margin_pct, total_cost: totalCostCalc },
    });

    res.json({ question, answer, project: proj.project_number });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
