// backend/src/modules/crm/customer360.service.js
// Orchestration layer: runs all 16 aggregators in parallel, caches results,
// computes health score, builds unified timeline.
import * as repo from './customer360.repository.js';

// ── In-memory cache (TTL = 60 s) ─────────────────────────────────────────────
const _cache = new Map(); // key → { data, expiresAt }
const CACHE_TTL = 60_000;

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

export function cacheInvalidate(customerId, companyId) {
  _cache.delete(`c360_${customerId}_${companyId}`);
}

// ── 49A-2 Sales metrics ───────────────────────────────────────────────────────
function buildSalesMetrics(leads, opportunities, quotations, salesOrders) {
  const won  = opportunities.filter(o => (o.stage || '').toLowerCase() === 'won');
  const lost = opportunities.filter(o => (o.stage || '').toLowerCase() === 'lost');
  const live = opportunities.filter(o => !['won','lost'].includes((o.stage || '').toLowerCase()));
  return {
    lead_count:        leads.length,
    opportunity_count: opportunities.length,
    quotation_count:   quotations.length,
    po_count:          salesOrders.length,
    pipeline_value:    live.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0),
    won_value:         won.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0),
    lost_value:        lost.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0),
    win_rate:          (won.length + lost.length) > 0
                         ? Math.round((won.length / (won.length + lost.length)) * 100)
                         : 0,
  };
}

// ── 49A-3 Tender metrics ──────────────────────────────────────────────────────
function buildTenderMetrics(tenders) {
  const won  = tenders.filter(t => (t.stage || '').toLowerCase() === 'won');
  const lost = tenders.filter(t => (t.stage || '').toLowerCase() === 'lost');
  const live = tenders.filter(t => !['won','lost'].includes((t.stage || '').toLowerCase()));
  return {
    total:           tenders.length,
    live:            live.length,
    won:             won.length,
    lost:            lost.length,
    total_bid_value: tenders.reduce((s, t) => s + parseFloat(t.expected_value || 0), 0),
    won_value:       won.reduce((s, t) => s + parseFloat(t.loa_amount || t.expected_value || 0), 0),
    strike_rate:     tenders.length > 0 ? Math.round((won.length / tenders.length) * 100) : 0,
  };
}

// ── 49A-4 Project metrics ─────────────────────────────────────────────────────
function buildProjectMetrics(projects) {
  const totalBudget = projects.reduce((s, p) => s + parseFloat(p.budget_amount || 0), 0);
  const totalActual = projects.reduce((s, p) => s + parseFloat(p.actual_cost || 0), 0);
  return {
    total_projects:     projects.length,
    active_projects:    projects.filter(p => p.status === 'active').length,
    completed_projects: projects.filter(p => p.status === 'completed').length,
    total_budget:       totalBudget,
    total_actual_cost:  totalActual,
    margin_pct:         totalBudget > 0
                          ? Math.round(((totalBudget - totalActual) / totalBudget) * 100)
                          : 0,
  };
}

// ── 49A-13 Finance metrics ────────────────────────────────────────────────────
function buildFinanceMetrics(invoices, payments) {
  const paid      = invoices.filter(i => i.status === 'paid');
  const unpaid    = invoices.filter(i => i.status !== 'paid');
  const overdue   = invoices.filter(i => i.status === 'overdue');
  const revenue   = paid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);
  const outstanding = unpaid.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0);
  const collected = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
  const thisYear  = new Date().getFullYear();
  return {
    total_invoices:  invoices.length,
    total_revenue:   revenue,
    outstanding:     outstanding,
    collected:       collected,
    overdue_count:   overdue.length,
    lifetime_value:  revenue + outstanding,
    avg_order_value: invoices.length > 0 ? (revenue + outstanding) / invoices.length : 0,
    orders_this_year: invoices.filter(i => new Date(i.created_at).getFullYear() === thisYear).length,
  };
}

// ── 49A-12 AMC metrics ────────────────────────────────────────────────────────
function buildAMCMetrics(contracts) {
  const now = Date.now();
  const active      = contracts.filter(c => c.status === 'active');
  const expiringIn90 = contracts.filter(c => {
    if (!c.end_date) return false;
    const diff = (new Date(c.end_date) - now) / 86400000;
    return diff >= 0 && diff <= 90;
  });
  return {
    total_contracts:  contracts.length,
    active_contracts: active.length,
    expiring_soon:    expiringIn90.length,
    total_revenue:    contracts.reduce((s, c) => s + parseFloat(c.annual_value || 0), 0),
  };
}

// ── 49A-11 Service metrics ────────────────────────────────────────────────────
function buildServiceMetrics(tickets, fieldVisits) {
  const open   = tickets.filter(t => !['resolved','closed'].includes(t.status));
  const closed = tickets.filter(t => ['resolved','closed'].includes(t.status));
  const avgRes = closed.length > 0
    ? Math.round(closed.reduce((s, t) => s + (t.resolution_days || 0), 0) / closed.length)
    : 0;
  return {
    open_tickets:        open.length,
    closed_tickets:      closed.length,
    critical_open:       open.filter(t => t.priority === 'critical').length,
    total_field_visits:  fieldVisits.length,
    avg_resolution_days: avgRes,
  };
}

// ── 49A-17 Health Engine ──────────────────────────────────────────────────────
function computeHealth(financeMetrics, serviceMetrics, projectMetrics, amcMetrics, tenderMetrics) {
  // Revenue Score (0-25): based on total lifetime value
  const ltv = financeMetrics.lifetime_value || 0;
  const revenueScore =
    ltv >= 10_000_000 ? 25 :
    ltv >= 1_000_000  ? 20 :
    ltv >= 100_000    ? 15 :
    ltv > 0           ? 10 : 0;

  // Collection Score (0-20): penalise overdue invoices
  const collectionScore = Math.max(0, 20 - (financeMetrics.overdue_count || 0) * 4);

  // Margin Score (0-15): project margin
  const margin = projectMetrics.margin_pct || 0;
  const marginScore =
    margin >= 30 ? 15 :
    margin >= 20 ? 12 :
    margin >= 10 ? 8  :
    margin >  0  ? 4  : 0;

  // NCR Score (0-10): penalise open NCRs (tracked via service critical tickets as proxy)
  const ncrScore = Math.max(0, 10 - (serviceMetrics.critical_open || 0) * 3);

  // Ticket Score (0-15): resolution rate
  const total = (serviceMetrics.open_tickets || 0) + (serviceMetrics.closed_tickets || 0);
  const ticketScore = total === 0 ? 15 :
    Math.round((serviceMetrics.closed_tickets / total) * 15);

  // AMC Score (0-10): active AMC coverage
  const amcScore = amcMetrics.active_contracts > 0
    ? Math.min(10, amcMetrics.active_contracts * 4)
    : 0;

  // Project Success Score (0-5): completion rate
  const projectScore = projectMetrics.total_projects === 0 ? 5 :
    Math.round((projectMetrics.completed_projects / projectMetrics.total_projects) * 5);

  const total_score = revenueScore + collectionScore + marginScore +
                      ncrScore + ticketScore + amcScore + projectScore;

  const label =
    total_score >= 85 ? 'Excellent' :
    total_score >= 65 ? 'Good'      :
    total_score >= 40 ? 'Watchlist' : 'Critical';

  return {
    total_score,
    label,
    churn_risk: total_score >= 65 ? 'low' : total_score >= 40 ? 'medium' : 'high',
    breakdown: {
      revenue_score:        revenueScore,
      collection_score:     collectionScore,
      margin_score:         marginScore,
      ncr_score:            ncrScore,
      ticket_score:         ticketScore,
      amc_score:            amcScore,
      project_success_score: projectScore,
    },
  };
}

// ── 49A-14 Travel metrics ─────────────────────────────────────────────────────
function buildTravelMetrics(customerVisits, projectTravel) {
  const byType = {};
  projectTravel.forEach(t => {
    const key = t.travel_type || 'General';
    if (!byType[key]) byType[key] = { type: key, trips: 0, cost: 0 };
    byType[key].trips += 1;
    byType[key].cost  += parseFloat(t.actual_cost || t.budget || 0);
  });
  return {
    total_visits:       customerVisits.length,
    total_project_trips: projectTravel.length,
    total_travel_cost:  projectTravel.reduce((s, t) => s + parseFloat(t.actual_cost || t.budget || 0), 0),
    by_type:            Object.values(byType),
  };
}

// ── Primary public methods ────────────────────────────────────────────────────

export async function getCustomer360(customerId, companyId) {
  const cacheKey = `c360_${customerId}_${companyId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Fire all 15 data-domain fetches in parallel
  const [
    profileData,
    salesData,
    tenders,
    projectData,
    engineering,
    procurement,
    production,
    quality,
    logistics,
    commissioning,
    service,
    amc,
    finance,
    travel,
    documents,
    timeline,
  ] = await Promise.all([
    repo.getProfile(customerId, companyId),
    repo.getSales(customerId, companyId),
    repo.getTenders(customerId, companyId),
    repo.getProjects(customerId, companyId),
    repo.getEngineering(customerId, companyId),
    repo.getProcurement(customerId, companyId),
    repo.getProduction(customerId, companyId),
    repo.getQuality(customerId, companyId),
    repo.getLogistics(customerId, companyId),
    repo.getCommissioning(customerId, companyId),
    repo.getService(customerId, companyId),
    repo.getAMC(customerId, companyId),
    repo.getFinance(customerId, companyId),
    repo.getTravel(customerId, companyId),
    repo.getDocuments(customerId, companyId),
    repo.getTimelineEvents(customerId, companyId),
  ]);

  if (!profileData.party) return null;

  // Build domain metrics
  const salesMetrics    = buildSalesMetrics(salesData.leads, salesData.opportunities, salesData.quotations, salesData.salesOrders);
  const tenderMetrics   = buildTenderMetrics(tenders);
  const projectMetrics  = buildProjectMetrics(projectData.projects);
  const serviceMetrics  = buildServiceMetrics(service.tickets, service.fieldVisits);
  const amcMetrics      = buildAMCMetrics(amc.contracts);
  const financeMetrics  = buildFinanceMetrics(finance.invoices, finance.payments);
  const travelMetrics   = buildTravelMetrics(travel.customerVisits, travel.projectTravel);

  const health = computeHealth(financeMetrics, serviceMetrics, projectMetrics, amcMetrics, tenderMetrics);

  const result = {
    customer: {
      ...profileData.party,
      account:     profileData.account,
      contacts:    profileData.contacts,
      outstanding: profileData.outstanding,
    },
    sales: {
      leads:        salesData.leads,
      opportunities: salesData.opportunities,
      quotations:   salesData.quotations,
      sales_orders: salesData.salesOrders,
      metrics:      salesMetrics,
    },
    tenders: {
      list:    tenders,
      metrics: tenderMetrics,
    },
    projects: {
      list:      projectData.projects,
      milestones: projectData.milestones,
      metrics:   projectMetrics,
    },
    engineering: {
      boms: engineering.boms,
      ecns: engineering.ecns,
      metrics: {
        bom_count:     engineering.boms.length,
        ecn_count:     engineering.ecns.length,
        open_ecns:     engineering.ecns.filter(e => !['closed','approved'].includes((e.status || '').toLowerCase())).length,
      },
    },
    procurement: {
      purchase_requests: procurement.purchaseRequests,
      rfqs:              procurement.rfqs,
      purchase_orders:   procurement.purchaseOrders,
      grns:              procurement.grns,
      metrics: {
        pr_count:  procurement.purchaseRequests.length,
        rfq_count: procurement.rfqs.length,
        po_count:  procurement.purchaseOrders.length,
        grn_count: procurement.grns.length,
        po_value:  procurement.purchaseOrders.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0),
      },
    },
    production: {
      orders: production,
      metrics: {
        total_orders:  production.length,
        in_progress:   production.filter(o => o.status === 'in_progress').length,
        completed:     production.filter(o => o.status === 'completed').length,
      },
    },
    quality: {
      fat_reports: quality.fatReports,
      sat_reports: quality.satReports,
      ncrs:        quality.ncrs,
      metrics: {
        fat_count:     quality.fatReports.length,
        sat_count:     quality.satReports.length,
        ncr_count:     quality.ncrs.length,
        open_ncrs:     quality.ncrs.filter(n => n.status !== 'closed').length,
        fat_passed:    quality.fatReports.filter(f => f.result === 'passed').length,
        sat_accepted:  quality.satReports.filter(s => s.result === 'accepted' || s.status === 'completed').length,
      },
    },
    logistics: {
      dispatches: logistics,
      metrics: {
        total_dispatches: logistics.length,
        delivered:        logistics.filter(d => d.status === 'delivered').length,
        in_transit:       logistics.filter(d => d.status === 'in_transit').length,
      },
    },
    commissioning: {
      reports: commissioning,
      metrics: {
        total:   commissioning.length,
        pending: commissioning.filter(c => c.status === 'pending').length,
        accepted: commissioning.filter(c => c.acceptance_status === 'accepted').length,
      },
    },
    service: {
      tickets:          service.tickets,
      field_visits:     service.fieldVisits,
      service_contracts: service.serviceContracts,
      metrics:          serviceMetrics,
    },
    amc: {
      contracts:       amc.contracts,
      warranty_records: amc.warrantyRecords,
      metrics:         amcMetrics,
    },
    finance: {
      invoices: finance.invoices,
      payments: finance.payments,
      metrics:  financeMetrics,
    },
    travel: {
      customer_visits: travel.customerVisits,
      project_travel:  travel.projectTravel,
      metrics:         travelMetrics,
    },
    documents,
    timeline,
    health,
    _meta: {
      customer_id: customerId,
      company_id:  companyId,
      generated_at: new Date().toISOString(),
      cache_ttl_seconds: 60,
    },
  };

  cacheSet(cacheKey, result);
  return result;
}

export async function getTimeline(customerId, companyId) {
  return repo.getTimelineEvents(customerId, companyId);
}

export async function getHealth(customerId, companyId) {
  const cacheKey = `c360_health_${customerId}_${companyId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const [finance, service, projects, amc, tenders] = await Promise.all([
    repo.getFinance(customerId, companyId),
    repo.getService(customerId, companyId),
    repo.getProjects(customerId, companyId),
    repo.getAMC(customerId, companyId),
    repo.getTenders(customerId, companyId),
  ]);

  const financeMetrics  = buildFinanceMetrics(finance.invoices, finance.payments);
  const serviceMetrics  = buildServiceMetrics(service.tickets, service.fieldVisits);
  const projectMetrics  = buildProjectMetrics(projects.projects);
  const amcMetrics      = buildAMCMetrics(amc.contracts);
  const tenderMetrics   = buildTenderMetrics(tenders);

  const health = computeHealth(financeMetrics, serviceMetrics, projectMetrics, amcMetrics, tenderMetrics);
  cacheSet(cacheKey, health);
  return health;
}

export async function getDocuments(customerId) {
  return repo.getDocuments(customerId, null);
}
