import { Vendor360Repo as repo } from '../repositories/vendor360.repository.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-9  SCORECARD ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function computeScorecard({ stored, deliveryMetrics, ncrs, inspections, capas, financeMetrics }) {
  if (stored) {
    const q  = parseFloat(stored.quality_score    || 0);
    const d  = parseFloat(stored.delivery_score   || 0);
    const c  = parseFloat(stored.cost_score       || 0);
    const s  = parseFloat(stored.support_score    || 0);
    const co = parseFloat(stored.compliance_score || 0);
    const overall = Math.round(((q + d + c + s + co) / 5) * 10) / 10;
    return { quality_score: q, delivery_score: d, cost_score: c, support_score: s,
             compliance_score: co, overall_score: overall,
             source: 'stored', scored_at: stored.scored_at };
  }

  // Compute from live data when no stored scorecard exists
  const openNCRs    = ncrs.filter(n => n.status !== 'Closed').length;
  const criticalNCRs = ncrs.filter(n => n.severity === 'Critical').length;
  const totalInsp   = inspections.length;
  const passedInsp  = inspections.filter(i => i.overall_result === 'Pass').length;
  const passRate    = totalInsp > 0 ? (passedInsp / totalInsp) * 100 : 70;
  const qualityScore = Math.max(0, Math.min(100,
    passRate - openNCRs * 5 - criticalNCRs * 10
  ));

  const dm = deliveryMetrics || {};
  const otdPct = dm.total_grns > 0
    ? (dm.on_time_count / dm.total_grns) * 100 : 70;
  const deliveryScore = Math.max(0, Math.min(100, otdPct));

  const closedCAPAs  = capas.filter(c => c.status === 'closed').length;
  const capaClosurePct = capas.length > 0 ? (closedCAPAs / capas.length) * 100 : 80;
  const complianceScore = Math.max(0, Math.min(100,
    capaClosurePct - criticalNCRs * 5
  ));

  const fm = financeMetrics || {};
  const outstanding = parseFloat(fm.outstanding_amount || 0);
  const totalSpend  = parseFloat(fm.total_spend || 1);
  const costScore   = Math.max(0, Math.min(100,
    80 - (outstanding / totalSpend) * 30
  ));

  const supportScore = 70; // No direct signal; default conservative

  const overall = Math.round(
    ((qualityScore + deliveryScore + costScore + supportScore + complianceScore) / 5) * 10
  ) / 10;

  return {
    quality_score:    Math.round(qualityScore    * 10) / 10,
    delivery_score:   Math.round(deliveryScore   * 10) / 10,
    cost_score:       Math.round(costScore       * 10) / 10,
    support_score:    supportScore,
    compliance_score: Math.round(complianceScore * 10) / 10,
    overall_score:    overall,
    source:    'computed',
    scored_at: null,
  };
}

function classifyVendor(overallScore) {
  if (overallScore >= 80) return 'Preferred';
  if (overallScore >= 60) return 'Approved';
  if (overallScore >= 40) return 'Watchlist';
  return 'Blocked';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-10  RISK ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function computeRisk({ vendor, deliveryMetrics, ncrs, capas, financeMetrics, procurementMetrics }) {
  const breakdown = {};

  // Financial risk: outstanding vs credit limit
  const outstanding   = parseFloat(financeMetrics?.outstanding_amount || 0);
  const creditLimit   = parseFloat(vendor?.credit_limit || 0);
  const pendingBills  = financeMetrics?.pending_bills || 0;
  if (creditLimit > 0 && outstanding > creditLimit * 0.9)   breakdown.financial = 'High';
  else if (creditLimit > 0 && outstanding > creditLimit * 0.7) breakdown.financial = 'Medium';
  else if (pendingBills > 5)                                  breakdown.financial = 'Medium';
  else                                                        breakdown.financial = 'Low';

  // Quality risk: open & critical NCRs
  const openNCRs    = ncrs.filter(n => n.status !== 'Closed').length;
  const criticalNCRs = ncrs.filter(n => n.severity === 'Critical').length;
  if (criticalNCRs > 0) breakdown.quality = 'Critical';
  else if (openNCRs > 3) breakdown.quality = 'High';
  else if (openNCRs > 0) breakdown.quality = 'Medium';
  else                   breakdown.quality = 'Low';

  // Delivery risk: % delayed shipments + open POs backlog
  const dm  = deliveryMetrics || {};
  const delayedPct = dm.total_grns > 0
    ? (dm.delayed_count / dm.total_grns) * 100 : 0;
  const openPOs    = procurementMetrics?.open_pos || 0;
  if (delayedPct > 30 || openPOs > 15)    breakdown.delivery = 'High';
  else if (delayedPct > 15 || openPOs > 8) breakdown.delivery = 'Medium';
  else                                     breakdown.delivery = 'Low';

  // Compliance risk: overdue CAPAs + GSTIN validity
  const overdueCAPAs = capas.filter(c =>
    c.status !== 'closed' && c.due_date && new Date(c.due_date) < new Date()
  ).length;
  const gstinValid = (vendor?.gstin || vendor?.gst_number || '').length === 15;
  if (!gstinValid || overdueCAPAs > 3) breakdown.compliance = 'High';
  else if (overdueCAPAs > 0)           breakdown.compliance = 'Medium';
  else                                 breakdown.compliance = 'Low';

  // Dependency risk: single-source flag + long avg lead time
  const avgLeadDays = parseFloat(dm.avg_lead_time_days || 0);
  if (vendor?.is_single_source || avgLeadDays > 90) breakdown.dependency = 'High';
  else if (avgLeadDays > 45)                        breakdown.dependency = 'Medium';
  else                                              breakdown.dependency = 'Low';

  const levels = { Low: 1, Medium: 2, High: 3, Critical: 4 };
  const maxLevel = Math.max(...Object.values(breakdown).map(r => levels[r] || 1));
  const overall  = ['Low', 'Medium', 'High', 'Critical'][maxLevel - 1];

  return { overall, breakdown };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-12  VENDOR HEALTH ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function computeHealth(scorecard, ncrs, capas, financeMetrics) {
  const openNCRs       = ncrs.filter(n => n.status !== 'Closed').length;
  const closedCAPAs    = capas.filter(c => c.status === 'closed').length;
  const capaClosurePct = capas.length > 0 ? (closedCAPAs / capas.length) * 100 : 100;
  const outstanding    = parseFloat(financeMetrics?.outstanding_amount || 0);
  const totalSpend     = parseFloat(financeMetrics?.total_spend || 1);
  const paymentStability = Math.max(0, 100 - (outstanding / totalSpend) * 100);

  const healthScore = Math.round(
    (scorecard.quality_score  * 0.30) +
    (scorecard.delivery_score * 0.25) +
    (Math.max(0, 100 - openNCRs * 10) * 0.20) +
    (capaClosurePct           * 0.15) +
    (paymentStability         * 0.10)
  );

  let label, color;
  if      (healthScore >= 85) { label = 'Excellent'; color = '#16a34a'; }
  else if (healthScore >= 70) { label = 'Good';      color = '#2563eb'; }
  else if (healthScore >= 50) { label = 'Watchlist'; color = '#d97706'; }
  else                        { label = 'Critical';  color = '#dc2626'; }

  return {
    score: healthScore, label, color,
    breakdown: {
      quality:          scorecard.quality_score,
      delivery:         scorecard.delivery_score,
      open_ncrs:        openNCRs,
      capa_closure_pct: Math.round(capaClosurePct),
      payment_stability: Math.round(paymentStability),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-18  CRITICAL SUPPLIER ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const CRITICAL_KEYWORDS = [
  'IGBT', 'Transformer', 'Capacitor', 'Controller', 'Semiconductor',
  'Thyristor', 'Reactor', 'Inductor', 'Gate Driver', 'Rectifier',
  'Inverter Module', 'DSP', 'FPGA', 'Contactor', 'Circuit Breaker',
];

function flagCriticalSupplier(vendor, suppliedMaterials, procurementMetrics, totalCompanySpend) {
  const flags = [];

  const vendorSpend = parseFloat(procurementMetrics?.total_po_value || 0);
  if (totalCompanySpend > 0 && vendorSpend / totalCompanySpend >= 0.15) {
    flags.push({ type: 'high_spend', label: 'High Spend Supplier', severity: 'warning',
                 detail: `${((vendorSpend / totalCompanySpend) * 100).toFixed(1)}% of total procurement` });
  }

  const critItems = suppliedMaterials.filter(m =>
    CRITICAL_KEYWORDS.some(kw =>
      (m.item_name || '').toUpperCase().includes(kw.toUpperCase())
    )
  );
  if (critItems.length > 0) {
    flags.push({ type: 'critical_components', label: 'Critical Component Supplier',
                 severity: 'high', items: critItems.map(i => i.item_name) });
  }

  if (vendor?.is_single_source) {
    flags.push({ type: 'single_source', label: 'Single Source Vendor', severity: 'critical' });
  }

  return flags;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-11  TIMELINE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
function buildTimeline({ vendor, pos, grns, ncrs, bills, scorecards, rfqs }) {
  const events = [];

  if (vendor?.created_at) {
    events.push({
      type: 'registration', icon: 'building',
      title: 'Vendor Registered', description: vendor.name,
      date: vendor.created_at, status: vendor.status || 'active',
    });
  }

  const sorted_pos = [...pos].sort((a, b) => new Date(a.order_date) - new Date(b.order_date));
  if (sorted_pos.length) {
    const first = sorted_pos[0];
    events.push({
      type: 'first_po', icon: 'package',
      title: `First PO: ${first.po_number}`,
      date: first.order_date, amount: parseFloat(first.amount || 0), status: first.status,
    });
  }

  pos.slice(0, 20).forEach(p => events.push({
    type: 'po', icon: 'package',
    title: `PO: ${p.po_number}`,
    date: p.order_date, amount: parseFloat(p.amount || 0), status: p.status,
  }));

  grns.slice(0, 15).forEach(g => events.push({
    type: 'grn', icon: 'check-circle',
    title: `GRN: ${g.grn_number}`,
    date: g.date, status: g.status,
  }));

  ncrs.slice(0, 10).forEach(n => events.push({
    type: 'ncr', icon: 'alert-triangle',
    title: `NCR: ${n.ncr_number || n.id}`,
    description: n.severity,
    date: n.date, status: n.status,
  }));

  bills.slice(0, 10).forEach(b => events.push({
    type: 'bill', icon: 'file-text',
    title: `Bill: ${b.bill_number}`,
    date: b.date, amount: parseFloat(b.amount || 0), status: b.status,
  }));

  scorecards.slice(0, 5).forEach(s => events.push({
    type: 'scorecard', icon: 'star',
    title: `Scored: ${parseFloat(s.overall_score || 0).toFixed(1)}/100`,
    date: s.date, status: 'completed',
  }));

  rfqs.slice(0, 5).forEach(r => events.push({
    type: 'rfq', icon: 'mail',
    title: `RFQ: ${r.rfq_number || r.id}`,
    date: r.date, status: 'sent',
  }));

  return events
    .filter(e => e.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 80);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 49D-8  DOCUMENT STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════
function buildDocumentStructure(vendor) {
  const safeName = (vendor.vendor_name || vendor.name || `Vendor-${vendor.id}`)
    .replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
  return {
    vendor_name: safeName,
    root: `Vendors/${safeName}`,
    folders: [
      { id: '01', name: '01 Registration',    description: 'Vendor registration form & KYC documents' },
      { id: '02', name: '02 GST Certificate', description: 'GSTIN registration certificate' },
      { id: '03', name: '03 PAN Card',         description: 'PAN card copy' },
      { id: '04', name: '04 Bank Details',     description: 'Bank proof & cancelled cheque' },
      { id: '05', name: '05 MSME / Udyam',     description: 'MSME / Udyam registration certificate' },
      { id: '06', name: '06 ISO Certificates', description: 'ISO & quality certifications' },
      { id: '07', name: '07 Agreements',       description: 'Vendor agreements & NDAs' },
      { id: '08', name: '08 Quotations',       description: 'RFQ responses & quotation revisions' },
      { id: '09', name: '09 Purchase Orders',  description: 'All POs issued to vendor' },
      { id: '10', name: '10 GRN Documents',    description: 'Goods receipt notes & delivery challans' },
      { id: '11', name: '11 Quality Reports',  description: 'IQC inspection reports, NCRs & CAPAs' },
      { id: '12', name: '12 Audit Reports',    description: 'Vendor audit & site assessment reports' },
      { id: '13', name: '13 Invoices',         description: 'Vendor bills, invoices & payment records' },
    ],
    compliance: {
      gstin:          vendor.gstin || vendor.gst_number || null,
      pan:            vendor.pan || null,
      msme_status:    vendor.msme_status || null,
      udyam_number:   vendor.udyam_number || null,
      iso_certificates: vendor.iso_certificates || [],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACEABILITY BUILDERS  (49D-15 / 49D-16 / 49D-17)
// ═══════════════════════════════════════════════════════════════════════════════
function procurementTraceability(pos, grns, suppliedMaterials) {
  return {
    question_which_bom_items:   suppliedMaterials.map(m => m.item_name).filter(Boolean),
    question_which_pos:         pos.map(p => p.po_number),
    question_which_grns:        grns.map(g => g.grn_number || g.id),
    po_grn_map: pos.slice(0, 20).map(po => ({
      po_number: po.po_number,
      po_status: po.status,
      grn_numbers: grns.filter(g => g.po_id === po.id).map(g => g.grn_number || g.id),
    })),
  };
}

function qualityTraceability(ncrs, capas, inspections) {
  const passedInsp     = inspections.filter(i => i.overall_result === 'Pass').length;
  const totalInsp      = inspections.length;
  const rejectedQty    = ncrs.reduce((s, n) => s + parseFloat(n.quantity_affected || 0), 0);
  const openCAPAs      = capas.filter(c => c.status !== 'closed').length;
  const closedCAPAs    = capas.length - openCAPAs;
  return {
    ncr_count:        ncrs.length,
    open_ncrs:        ncrs.filter(n => n.status !== 'Closed').length,
    capa_count:       capas.length,
    open_capas:       openCAPAs,
    closed_capas:     closedCAPAs,
    rejected_qty:     rejectedQty,
    accepted_inspections: passedInsp,
    pass_pct: totalInsp > 0 ? parseFloat(((passedInsp / totalInsp) * 100).toFixed(1)) : null,
    rejected_items: ncrs.slice(0, 10).map(n => n.defect_description).filter(Boolean),
  };
}

function financeTraceability(bills, financeMetrics, vendor) {
  return {
    total_spend:       parseFloat(financeMetrics?.total_spend || 0),
    outstanding:       parseFloat(financeMetrics?.outstanding_amount || 0),
    pending_bills:     financeMetrics?.pending_bills || 0,
    credit_terms:      vendor?.payment_terms || null,
    avg_payment_cycle: parseFloat(financeMetrics?.avg_payment_terms_days || 0),
    latest_bills:      bills.slice(0, 5).map(b => ({
      bill_number: b.bill_number, date: b.bill_date,
      amount: parseFloat(b.total_amount || 0), status: b.status,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC SERVICE API
// ═══════════════════════════════════════════════════════════════════════════════
export const Vendor360Service = {

  // ── GET /vendor-360 (list) ────────────────────────────────────────────────
  async listVendors(companyId, filters) {
    return repo.listVendors(companyId, filters);
  },

  // ── GET /vendor-360/:vendorId (full 360) ─────────────────────────────────
  // 49D-13: all 17 sub-queries run in ONE Promise.all → target <500ms
  async getFull360(vendorId, companyId) {
    const [
      vendor, contacts, pos, procMetrics, rfqData,
      grns, delivMetrics,
      ncrs, capas, inspections, qualSnapshots,
      suppliedMaterials, criticalStock,
      projectData,
      bills, finMetrics,
      storedScorecard,
    ] = await Promise.all([
      repo.profile(vendorId, companyId),
      repo.contacts(vendorId),
      repo.procurementOrders(vendorId, companyId),
      repo.procurementMetrics(vendorId, companyId),
      repo.rfqData(vendorId, companyId),
      repo.grns(vendorId, companyId),
      repo.deliveryMetrics(vendorId, companyId),
      repo.ncrs(vendorId, companyId),
      repo.capas(vendorId, companyId),
      repo.qualityInspections(vendorId, companyId),
      repo.qualitySnapshots(vendorId, companyId),
      repo.suppliedMaterials(vendorId, companyId),
      repo.criticalStock(vendorId, companyId),
      repo.projectData(vendorId, companyId),
      repo.billsData(vendorId, companyId),
      repo.financeMetrics(vendorId, companyId),
      repo.latestScorecard(vendorId, companyId),
    ]);

    if (!vendor) return null;

    // ── Engines ──────────────────────────────────────────────────────────────
    const scorecard = computeScorecard({
      stored: storedScorecard, deliveryMetrics: delivMetrics,
      ncrs, inspections, capas, financeMetrics: finMetrics,
    });
    const risk   = computeRisk({ vendor, deliveryMetrics: delivMetrics, ncrs, capas, financeMetrics: finMetrics, procurementMetrics: procMetrics });
    const health = computeHealth(scorecard, ncrs, capas, finMetrics);
    const critFlags = flagCriticalSupplier(vendor, suppliedMaterials, procMetrics, 0);

    // ── Derived metrics ───────────────────────────────────────────────────────
    const totalGRNs   = delivMetrics?.total_grns || 0;
    const otdPct      = totalGRNs > 0
      ? parseFloat(((delivMetrics.on_time_count / totalGRNs) * 100).toFixed(1)) : null;
    const totalInsp   = inspections.length;
    const passedInsp  = inspections.filter(i => i.overall_result === 'Pass').length;
    const passRate    = totalInsp > 0 ? parseFloat(((passedInsp / totalInsp) * 100).toFixed(1)) : null;
    const rejQty      = ncrs.reduce((s, n) => s + parseFloat(n.quantity_affected || 0), 0);
    const openNCRs    = ncrs.filter(n => n.status !== 'Closed').length;
    const openCAPAs   = capas.filter(c => c.status !== 'closed').length;
    const critStock   = criticalStock.filter(s =>
      s.reorder_level != null && parseFloat(s.current_stock) <= parseFloat(s.reorder_level)
    );
    const uniqueProjects = Object.values(
      Object.fromEntries(projectData.map(p => [p.id, p]))
    );

    return {
      vendor: {
        id:            vendor.id,
        name:          vendor.vendor_name || vendor.name,
        vendor_code:   vendor.vendor_code,
        vendor_type:   vendor.vendor_type,
        category:      vendor.category,
        status:        vendor.status || vendor.approval_status,
        email:         vendor.email,
        phone:         vendor.phone,
        city:          vendor.city,
        state:         vendor.state,
        address:       vendor.address,
        website:       vendor.website,
        credit_limit:  parseFloat(vendor.credit_limit || 0),
        payment_terms: vendor.payment_terms,
      },
      contacts,
      registration: {
        gstin:            vendor.gstin || vendor.gst_number || null,
        pan:              vendor.pan || null,
        msme_status:      vendor.msme_status || null,
        udyam_number:     vendor.udyam_number || null,
        bank_name:        vendor.bank_name || null,
        bank_account:     vendor.account_number || vendor.bank_account || null,
        ifsc:             vendor.ifsc || null,
        approval_status:  vendor.approval_status || vendor.status,
        iso_certificates: vendor.iso_certificates || [],
      },
      procurement: {
        summary: {
          total_po_value:    parseFloat(procMetrics?.total_po_value    || 0),
          open_po_value:     parseFloat(procMetrics?.open_po_value     || 0),
          closed_po_value:   parseFloat(procMetrics?.closed_po_value   || 0),
          awarded_orders:    procMetrics?.awarded_orders  || 0,
          open_pos:          procMetrics?.open_pos        || 0,
          closed_pos:        procMetrics?.closed_pos      || 0,
          cancelled_pos:     procMetrics?.cancelled_pos   || 0,
          average_order_value: parseFloat(procMetrics?.avg_order_value || 0),
          rfq_count:         rfqData.length,
          rfq_wins:          rfqData.filter(r => r.is_winner).length,
        },
        purchase_orders: pos.slice(0, 20),
        rfqs:            rfqData,
        traceability:    procurementTraceability(pos, grns, suppliedMaterials),
      },
      delivery: {
        summary: {
          total_grns:              totalGRNs,
          on_time_count:           delivMetrics?.on_time_count  || 0,
          delayed_count:           delivMetrics?.delayed_count  || 0,
          partial_deliveries:      delivMetrics?.partial_count  || 0,
          on_time_delivery_percent: otdPct,
          average_lead_time:       parseFloat(delivMetrics?.avg_lead_time_days || 0),
        },
        grns: grns.slice(0, 20),
      },
      quality: {
        summary: {
          total_inspections:     totalInsp,
          inspection_pass_rate:  passRate,
          open_ncr:              openNCRs,
          open_capa:             openCAPAs,
          total_ncrs:            ncrs.length,
          critical_ncrs:         ncrs.filter(n => n.severity === 'Critical').length,
          rejection_qty:         rejQty,
          vendor_ppm:            null, // from supplier_quality_snapshots if available
        },
        ncrs:      ncrs.slice(0, 15),
        capas:     capas.slice(0, 10),
        snapshots: qualSnapshots,
        traceability: qualityTraceability(ncrs, capas, inspections),
      },
      inventory: {
        summary: {
          unique_items:     suppliedMaterials.length,
          stock_value:      suppliedMaterials.reduce((s, m) => s + parseFloat(m.total_value || 0), 0),
          critical_materials: critStock.length,
          long_lead_items:  criticalStock.filter(s => parseFloat(s.lead_time_days || 0) > 60).length,
        },
        supplied_items:  suppliedMaterials,
        critical_stock:  critStock,
        critical_flags:  critFlags,
      },
      projects: {
        summary: {
          projects_count:    uniqueProjects.length,
          active_projects:   uniqueProjects.filter(p => p.status === 'active').length,
          critical_projects: uniqueProjects.filter(p => p.priority === 'critical').length,
          total_vendor_value: uniqueProjects.reduce((s, p) => s + parseFloat(p.vendor_po_value || 0), 0),
        },
        projects: uniqueProjects,
      },
      finance: {
        summary: {
          total_spend:        parseFloat(finMetrics?.total_spend        || 0),
          paid_amount:        parseFloat(finMetrics?.paid_amount        || 0),
          outstanding_amount: parseFloat(finMetrics?.outstanding_amount || 0),
          total_bills:        finMetrics?.total_bills  || 0,
          pending_bills:      finMetrics?.pending_bills || 0,
          average_payment_days: parseFloat(finMetrics?.avg_payment_terms_days || 0),
          total_tds:          parseFloat(finMetrics?.total_tds || 0),
        },
        bills: bills.slice(0, 15),
        traceability: financeTraceability(bills, finMetrics, vendor),
      },
      documents: buildDocumentStructure(vendor),
      scorecard:  { ...scorecard, classification: classifyVendor(scorecard.overall_score) },
      risk,
      health,
    };
  },

  // ── GET /vendor-360/:vendorId/timeline ───────────────────────────────────
  async getTimeline(vendorId, companyId) {
    const [vendor, pos, grns, ncrs, bills, scorecards, rfqs] = await Promise.all([
      repo.timelineVendorInfo(vendorId, companyId),
      repo.timelinePOs(vendorId, companyId),
      repo.timelineGRNs(vendorId, companyId),
      repo.timelineNCRs(vendorId, companyId),
      repo.timelineBills(vendorId, companyId),
      repo.timelineScorecards(vendorId, companyId),
      repo.timelineRFQs(vendorId, companyId),
    ]);
    return buildTimeline({ vendor, pos, grns, ncrs, bills, scorecards, rfqs });
  },

  // ── GET /vendor-360/:vendorId/scorecard ──────────────────────────────────
  async getScorecard(vendorId, companyId) {
    const [stored, delivMetrics, ncrs, inspections, capas, finMetrics] = await Promise.all([
      repo.latestScorecard(vendorId, companyId),
      repo.deliveryMetrics(vendorId, companyId),
      repo.ncrs(vendorId, companyId),
      repo.qualityInspections(vendorId, companyId),
      repo.capas(vendorId, companyId),
      repo.financeMetrics(vendorId, companyId),
    ]);
    const sc = computeScorecard({ stored, deliveryMetrics: delivMetrics, ncrs, inspections, capas, financeMetrics: finMetrics });
    return { ...sc, classification: classifyVendor(sc.overall_score) };
  },

  async saveScorecard(vendorId, companyId, body, userId) {
    const overall = Math.round(
      (((body.quality_score    || 0) +
        (body.delivery_score   || 0) +
        (body.cost_score       || 0) +
        (body.support_score    || 0) +
        (body.compliance_score || 0)) / 5) * 10
    ) / 10;
    const classification = classifyVendor(overall);
    return repo.saveScorecard(vendorId, companyId, { ...body, overall_score: overall, classification }, userId);
  },

  // ── GET /vendor-360/:vendorId/risk ───────────────────────────────────────
  // Returns rich 5-dimension risk with strategic flags + red flags
  async getRisk(vendorId, companyId) {
    const [vendor, delivMetrics, ncrs, capas, finMetrics, procMetrics, projCount] = await Promise.all([
      repo.profile(vendorId, companyId),
      repo.deliveryMetrics(vendorId, companyId),
      repo.ncrs(vendorId, companyId),
      repo.capas(vendorId, companyId),
      repo.financeMetrics(vendorId, companyId),
      repo.procurementMetrics(vendorId, companyId),
      repo.projectCount(vendorId, companyId),
    ]);
    if (!vendor) return null;

    const simple = computeRisk({ vendor, deliveryMetrics: delivMetrics, ncrs, capas, financeMetrics: finMetrics, procurementMetrics: procMetrics });

    // Enrich with per-dimension details and metadata
    const openNCRs      = ncrs.filter(n => n.status !== 'Closed').length;
    const critNCRs      = ncrs.filter(n => n.severity === 'Critical').length;
    const outstanding   = parseFloat(finMetrics?.outstanding_amount || 0);
    const pendingBills  = finMetrics?.pending_bills || 0;
    const totalPOs      = procMetrics?.total_pos || 0;
    const openPOs       = procMetrics?.open_pos || 0;
    const delayedGRNs   = delivMetrics?.delayed_count || 0;
    const totalGRNs     = delivMetrics?.total_grns || 0;
    const delayedRatio  = totalGRNs > 0 ? parseFloat(((delayedGRNs / totalGRNs) * 100).toFixed(1)) : 0;
    const projectCount  = projCount?.project_count || 0;
    const suppliedItems = 0; // procMetrics doesn't track this; dependency uses project count + open POs
    const hasGst  = !!((vendor.gstin || vendor.gst_number || '').length);
    const hasPan  = !!vendor.pan;
    const hasBank = !!vendor.bank_name;
    const hasMsme = !!vendor.msme_status;
    const hasIso  = !!(vendor.iso_certificates && vendor.iso_certificates !== '[]' && vendor.iso_certificates !== '');
    const docScore = [hasGst, hasPan, hasBank, hasMsme, hasIso].filter(Boolean).length;
    const totalSpend = parseFloat(finMetrics?.total_spend || 0);

    const overdueCAPAs = capas.filter(c =>
      c.status !== 'closed' && c.due_date && new Date(c.due_date) < new Date()
    ).length;

    const redFlags = [
      critNCRs > 0                && `${critNCRs} critical NCR(s) unresolved`,
      openNCRs > 3                && `${openNCRs} open NCRs`,
      pendingBills > 3            && `${pendingBills} pending bill(s) — ₹${Math.round(outstanding / 1000)}K outstanding`,
      delayedGRNs > 0             && `${delayedGRNs} delayed GRN(s) out of ${totalGRNs}`,
      overdueCAPAs > 0            && `${overdueCAPAs} CAPA(s) past due date`,
      !hasGst                     && 'GST number not on record',
      !hasPan                     && 'PAN number not on record',
      docScore < 3                && 'Incomplete compliance documentation',
      projectCount > 4            && `Vendor critical to ${projectCount} active projects (single-point dependency)`,
    ].filter(Boolean);

    return {
      overall_risk: simple.overall,
      dimensions: {
        financial: {
          level:            simple.breakdown.financial,
          outstanding,
          pending_bills:    pendingBills,
          description:      'Based on outstanding payables, credit usage, and pending bills',
        },
        quality: {
          level:            simple.breakdown.quality,
          total_ncrs:       ncrs.length,
          open_ncrs:        openNCRs,
          critical_ncrs:    critNCRs,
          overdue_capas:    overdueCAPAs,
          description:      'Based on NCR count, open/critical NCRs and overdue CAPAs',
        },
        delivery: {
          level:            simple.breakdown.delivery,
          delayed_grns:     delayedGRNs,
          total_grns:       totalGRNs,
          overdue_ratio:    delayedRatio,
          avg_lead_time:    parseFloat(delivMetrics?.avg_lead_time_days || 0),
          description:      'Based on delayed GRNs vs total GRNs and open PO backlog',
        },
        dependency: {
          level:            simple.breakdown.dependency,
          projects:         projectCount,
          open_pos:         openPOs,
          description:      'Based on project dependency count and open PO concentration',
        },
        compliance: {
          level:            simple.breakdown.compliance,
          docs_complete:    docScore,
          docs_total:       5,
          has_gst:          hasGst,
          has_pan:          hasPan,
          has_bank:         hasBank,
          has_msme:         hasMsme,
          has_iso:          hasIso,
          overdue_capas:    overdueCAPAs,
          description:      'Based on document completeness, GSTIN validity, and overdue CAPAs',
        },
      },
      strategic_flags: {
        single_source:      vendor.is_single_source || false,
        long_lead_supplier: parseFloat(delivMetrics?.avg_lead_time_days || 0) > 90,
        critical_supplier:  simple.overall === 'Critical' || simple.overall === 'High',
        high_spend:         totalSpend > 5000000,
        project_critical:   projectCount >= 3,
      },
      red_flags: redFlags,
    };
  },

  // ── GET /vendor-360/:vendorId/documents ──────────────────────────────────
  async getDocuments(vendorId, companyId) {
    const vendor = await repo.profile(vendorId, companyId);
    if (!vendor) return null;
    return buildDocumentStructure(vendor);
  },

  // ── GET /vendor-360/command-center ───────────────────────────────────────
  async commandCenter(companyId) {
    return repo.commandCenterData(companyId);
  },
};
