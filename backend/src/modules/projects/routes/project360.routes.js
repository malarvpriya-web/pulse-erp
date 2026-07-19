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
  let budgetScore = 100;
  const revenue = parseFloat(proj.contract_value || 0);
  const cs = costSummary || {};
  const totalCost = parseFloat(cs.total_cost || 0);
  if (revenue > 0 && totalCost > 0) {
    const pctUsed = totalCost / revenue;
    const completion = parseFloat(proj.completion_percentage || 0) / 100;
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

  const revenue = parseFloat(proj.contract_value || 0);
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

  const unpaidInvoices = invoices.filter(i => i.status !== 'Paid' && i.due_date && new Date(i.due_date) < now);
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
    const pct = parseFloat(proj.completion_percentage || 0);
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
    const pct = parseFloat(proj.completion_percentage || 0);
    return `📊 EXECUTIVE SUMMARY — ${proj.name}\n\nProject: ${proj.project_number} | Customer: ${proj.customer_name || '—'}\nStatus: ${proj.status?.toUpperCase()} | Progress: ${pct}%\n\nFinancials:\n• Revenue: ₹${(revenue/100000).toFixed(2)}L\n• Cost: ₹${(cost/100000).toFixed(2)}L\n• Profit: ₹${((revenue-cost)/100000).toFixed(2)}L\n• Margin: ${margin.toFixed(1)}%\n\nKey Alerts:\n${overdueMiles.length > 0 ? `• ${overdueMiles.length} overdue milestone(s)\n` : ''}${pendingPOs.length > 0 ? `• ${pendingPOs.length} pending PO(s)\n` : ''}${openNcrs.length > 0 ? `• ${openNcrs.length} open NCR(s)\n` : ''}${openTickets.length > 0 ? `• ${openTickets.length} open service ticket(s)\n` : ''}${overdueMiles.length === 0 && pendingPOs.length === 0 && openNcrs.length === 0 ? '• No critical alerts\n' : ''}`;
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
      pool.query(`SELECT * FROM opportunities WHERE project_id=$1${cc} LIMIT 1`, [pid]),
      pool.query(`SELECT id, quotation_number, created_at, total_amount, status, salesperson FROM quotations WHERE project_id=$1${cc} ORDER BY created_at DESC LIMIT 5`, [pid]),
      pool.query(`SELECT id, order_number, order_date, total_amount, status, customer_name FROM sales_orders WHERE project_id=$1${cc} ORDER BY order_date DESC LIMIT 5`, [pid]),
      pool.query(`
        SELECT b.id, b.bom_number, b.created_at, b.status, b.revision,
               COUNT(bi.id) AS item_count, COALESCE(SUM(bi.total_cost),0) AS bom_value
        FROM boms b LEFT JOIN bom_items bi ON bi.bom_id=b.id
        WHERE b.project_id=$1${cc} GROUP BY b.id ORDER BY b.created_at DESC LIMIT 5
      `, [pid]),
      pool.query(`SELECT id, document_name, doc_type, version, status, created_at FROM project_documents WHERE project_id=$1 ORDER BY created_at DESC LIMIT 15`, [pid]),
      pool.query(`SELECT id, pr_number, requested_date, status, total_estimated_cost FROM purchase_requests WHERE project_id=$1${cc} ORDER BY requested_date DESC LIMIT 10`, [pid]),
      pool.query(`SELECT id, po_number, order_date, total_amount, status, vendor_name FROM purchase_orders WHERE project_id=$1${cc} ORDER BY order_date DESC LIMIT 15`, [pid]),
      pool.query(`SELECT grn.id, grn.grn_number, grn.received_date, grn.status FROM goods_receipts grn WHERE grn.project_id=$1${cc} ORDER BY grn.received_date DESC LIMIT 10`, [pid]),
      pool.query(`SELECT id, order_number, planned_start, planned_end, status, quantity FROM production_orders WHERE project_id=$1${cc} ORDER BY planned_start DESC LIMIT 10`, [pid]),
      pool.query(`
        SELECT employee_name, SUM(hours) AS total_hours, SUM(hours*COALESCE(billing_rate,0)) AS cost
        FROM timesheets WHERE project_id=$1 AND status='Approved'
        GROUP BY employee_name ORDER BY total_hours DESC LIMIT 10
      `, [pid]),
      pool.query(`SELECT * FROM fat_trackers WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]),
      pool.query(`SELECT * FROM sat_trackers WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]),
      pool.query(`SELECT id, shipment_number, dispatch_date, status, destination, tracking_number FROM shipments WHERE project_id=$1${cc} ORDER BY dispatch_date DESC LIMIT 10`, [pid]),
      pool.query(`SELECT id, stage, started_at, completed_at, status, notes FROM lifecycle_events WHERE project_id=$1 ORDER BY started_at DESC LIMIT 10`, [pid]),
      pool.query(`SELECT id, ticket_number, created_at, status, priority, subject FROM service_tickets WHERE project_id=$1${cc} ORDER BY created_at DESC LIMIT 10`, [pid]),
      pool.query(`SELECT * FROM project_warranties WHERE project_id=$1 ORDER BY start_date DESC LIMIT 5`, [pid]),
      pool.query(`SELECT id, contract_number, start_date, end_date, annual_value, status FROM amc_contracts WHERE project_id=$1${cc} ORDER BY start_date DESC LIMIT 5`, [pid]),
      pool.query(`SELECT id, invoice_number, invoice_date, amount, status, due_date FROM invoices WHERE project_id=$1${cc} ORDER BY invoice_date DESC LIMIT 15`, [pid]),
      pool.query(`
        SELECT p.contract_value AS revenue,
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
               COALESCE(pcs.actual_profit,0) AS actual_profit,
               CASE WHEN p.contract_value > 0 THEN ROUND(COALESCE(pcs.actual_profit,0)/p.contract_value*100,2) ELSE 0 END AS margin_pct
        FROM projects p LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id
        WHERE p.id=$1
      `, [pid]),
      pool.query(`SELECT id, title, severity, status, created_at, is_blocker FROM project_issues WHERE project_id=$1 ORDER BY created_at DESC LIMIT 15`, [pid]),
      pool.query(`SELECT id, name, due_date, status, amount, billing_milestone, completed_at FROM project_milestones WHERE project_id=$1 ORDER BY due_date ASC`, [pid]),
      pool.query(`SELECT id, request_number, travel_type, from_date, to_date, budget, status, employee_name, destination FROM travel_requests WHERE project_id=$1${cc} ORDER BY from_date DESC LIMIT 10`, [pid]),
      pool.query(`SELECT id, task_title, status, priority, due_date, assignee_name FROM project_tasks WHERE project_id=$1 ORDER BY due_date ASC LIMIT 20`, [pid]),
      pool.query(`SELECT id, ncr_number, description, severity, status, created_at, containment_action FROM ncr_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 10`, [pid]),
      pool.query(`SELECT ca.id, ca.action_description, ca.status, ca.due_date, ca.completed_at, nr.ncr_number FROM capa_actions ca JOIN ncr_reports nr ON nr.id=ca.ncr_id WHERE nr.project_id=$1 ORDER BY ca.due_date ASC LIMIT 10`, [pid]),
      pool.query(`SELECT ri.id, ri.item_name, ri.quantity_issued, ri.issue_date, ri.batch_number FROM rm_issues ri WHERE ri.project_id=$1 ORDER BY ri.issue_date DESC LIMIT 15`, [pid]),
      pool.query(`SELECT id, report_number, inspection_type, result, created_at FROM inspection_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 10`, [pid]),
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

    const revenue      = parseFloat(cs.revenue || proj.contract_value || 0);
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

    const invoiceRevenue  = invoiceRows.filter(i => i.status === 'Paid').reduce((s, i) => s + parseFloat(i.amount||0), 0);
    const invoicePending  = invoiceRows.filter(i => i.status !== 'Paid').reduce((s, i) => s + parseFloat(i.amount||0), 0);
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
    const overdueInv = invoiceRows.filter(i => i.status !== 'Paid' && i.due_date && new Date(i.due_date) < new Date());
    if (overdueInv.length > 0) alerts.push({ type: 'Collections', level: 'critical', msg: `${overdueInv.length} overdue invoice(s)`, items: overdueInv.map(i => i.invoice_number) });
    if (serviceTicketRows.filter(t => t.priority === 'Critical' || t.priority === 'High').filter(t => t.status !== 'closed').length > 0) alerts.push({ type: 'Service', level: 'high', msg: 'Critical/High priority service tickets open', items: serviceTicketRows.filter(t => (t.priority === 'Critical' || t.priority === 'High') && t.status !== 'closed').map(t => t.ticket_number || t.subject) });

    res.json({
      project: {
        id: proj.id, name: proj.name || proj.project_name, project_number: proj.project_number,
        customer_name: proj.customer_name, status: proj.status, start_date: proj.start_date,
        end_date: proj.end_date, contract_value: parseFloat(proj.contract_value || 0),
        description: proj.description, site_name: proj.site_name,
        completion_pct: proj.completion_percentage || 0,
        project_manager: proj.project_manager || proj.manager_name,
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
      pool.query(`SELECT name, due_date, status FROM project_milestones WHERE project_id=$1`, [pid]),
      pool.query(`SELECT po_number, vendor_name, status FROM purchase_orders WHERE project_id=$1${cc}`, [pid]),
      pool.query(`SELECT ncr_number, description, status FROM ncr_reports WHERE project_id=$1`, [pid]),
      pool.query(`SELECT ticket_number, subject, priority, status FROM service_tickets WHERE project_id=$1${cc}`, [pid]),
      pool.query(`SELECT invoice_number, amount, status, due_date FROM invoices WHERE project_id=$1${cc}`, [pid]),
      pool.query(`SELECT p.contract_value AS revenue, COALESCE(pcs.actual_profit,0) AS actual_profit, CASE WHEN p.contract_value>0 THEN ROUND(COALESCE(pcs.actual_profit,0)/p.contract_value*100,2) ELSE 0 END AS margin_pct, (p.contract_value - COALESCE(pcs.material_cost,0) - COALESCE(pcs.labour_cost,0)) AS total_cost FROM projects p LEFT JOIN project_cost_summary pcs ON pcs.project_id=p.id WHERE p.id=$1`, [pid]),
    ]);

    const safe = r => r.status === 'fulfilled' ? (r.value?.rows || []) : [];
    const proj = (projR.status === 'fulfilled' ? projR.value?.rows?.[0] : null);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const finRow = finR.status === 'fulfilled' ? finR.value?.rows?.[0] : {};
    const totalCostCalc = parseFloat(proj.contract_value||0) - parseFloat(finRow?.actual_profit||0);

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
