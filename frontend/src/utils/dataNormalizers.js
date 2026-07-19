/**
 * dataNormalizers.js
 * Pure helper functions for normalizing API response shapes across Pulse ERP.
 * All functions are side-effect-free and safe to call with null/undefined.
 */

// ── Array extraction ──────────────────────────────────────────────────────────

/**
 * Safely extract an array from various API response shapes.
 * Handles: raw array, { rows }, { data }, { items }, { key }, { data: { key } }
 */
export function extractArray(data, key = null) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (key) {
    if (Array.isArray(data[key])) return data[key];
    if (data.data && Array.isArray(data.data[key])) return data.data[key];
  }
  if (Array.isArray(data.rows))   return data.rows;
  if (Array.isArray(data.data))   return data.data;
  if (Array.isArray(data.items))  return data.items;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * Extract a summary/stats object from various API response shapes.
 */
export function extractSummary(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.summary && typeof data.summary === 'object') return data.summary;
  if (data.stats   && typeof data.stats   === 'object') return data.stats;
  if (data.data    && typeof data.data    === 'object' && !Array.isArray(data.data)) return data.data;
  return data;
}

// ── Date / Currency formatters ────────────────────────────────────────────────

/**
 * Format a date value to a locale string.
 * @param {string|Date} d
 * @param {Intl.DateTimeFormatOptions} opts
 */
export function fmtDate(d, opts = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch {
    return '—';
  }
}

/**
 * Format a number as Indian Rupee.
 * @param {number|string} n
 * @param {boolean} compact  — use L/K/Cr suffixes when true (default true)
 */
export function formatINR(n, compact = true) {
  const num = parseFloat(n || 0);
  if (isNaN(num)) return '₹0';
  if (!compact) return `₹${num.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  if (num >= 10000000) return `₹${(num / 10000000).toFixed(2)}Cr`;
  if (num >= 100000)   return `₹${(num / 100000).toFixed(1)}L`;
  if (num >= 1000)     return `₹${(num / 1000).toFixed(0)}K`;
  return `₹${num.toFixed(0)}`;
}

// ── Entity normalizers ────────────────────────────────────────────────────────

/**
 * Normalize a raw employee row from the API into a consistent shape.
 */
export function normalizeEmployee(e) {
  if (!e) return {};
  return {
    id:               e.id,
    office_id:        e.office_id        || e.employee_id || '',
    first_name:       e.first_name       || '',
    last_name:        e.last_name        || '',
    full_name:        `${e.first_name || ''} ${e.last_name || ''}`.trim(),
    company_email:    e.company_email    || e.email || '',
    personal_email:   e.personal_email   || '',
    personal_phone:   e.personal_phone   || e.phone || '',
    department:       e.department       || '',
    designation:      e.designation      || e.role || '',
    status:           e.status           || 'active',
    joining_date:     e.joining_date     ? e.joining_date.split('T')[0] : '',
    date_of_birth:    e.date_of_birth    ? e.date_of_birth.split('T')[0] : '',
    gender:           e.gender           || '',
    skill_level:      e.skill_level      || '',
    reporting_manager:e.reporting_manager|| '',
    work_location:    e.work_location    || '',
    basic_salary:     parseFloat(e.basic_salary || 0),
    annual_ctc:       parseFloat(e.annual_ctc   || 0),
  };
}

/**
 * Normalize a raw invoice row.
 */
export function normalizeInvoice(inv) {
  if (!inv) return {};
  return {
    id:             inv.id,
    invoice_number: inv.invoice_number || inv.number || '',
    party_name:     inv.party_name     || inv.customer_name || inv.vendor_name || '',
    total_amount:   parseFloat(inv.total_amount || inv.amount || 0),
    status:         (inv.status || 'draft').toLowerCase(),
    due_date:       inv.due_date   ? inv.due_date.split('T')[0]   : '',
    invoice_date:   inv.invoice_date ? inv.invoice_date.split('T')[0] : '',
    type:           inv.type || 'sales',
  };
}

/**
 * Normalize a raw CRM lead row.
 */
export function normalizeLead(l) {
  if (!l) return {};
  return {
    id:             l.id,
    company_name:   l.company_name   || l.company || '',
    contact_person: l.contact_person || l.name    || '',
    email:          l.email          || '',
    phone:          l.phone          || '',
    lead_source:    l.lead_source    || l.source  || 'Manual',
    industry:       l.industry       || '',
    status:         (l.status || 'new').toLowerCase(),
    lead_score:     parseInt(l.lead_score || l.score || 0),
    location:       l.location       || '',
    assigned_to_name: l.assigned_to_name || l.assigned_to || '',
    created_at:     l.created_at     || '',
    notes:          l.notes          || '',
  };
}

/**
 * Normalize a support ticket row.
 */
export function normalizeTicket(t) {
  if (!t) return {};
  return {
    id:               t.id,
    ticket_number:    t.ticket_number    || t.number || `TKT-${String(t.id).padStart(4,'0')}`,
    title:            t.title            || t.subject || '',
    description:      t.description      || '',
    category:         t.category         || '',
    priority:         t.priority         || 'Medium',
    status:           t.status           || 'Open',
    team:             t.team             || '',
    requester_name:   t.requester_name   || t.requester || '',
    requester_email:  t.requester_email  || '',
    assigned_to_name: t.assigned_to_name || t.assigned_to || '',
    created_at:       t.created_at       || '',
    comments:         Array.isArray(t.comments) ? t.comments : [],
  };
}

/**
 * Normalize a project row.
 */
export function normalizeProject(p) {
  if (!p) return {};
  return {
    id:              p.id,
    project_code:    p.project_code   || p.code || '',
    project_name:    p.project_name   || p.name || '',
    customer_name:   p.customer_name  || p.client || '',
    manager_name:    p.manager_name   || p.manager || '',
    status:          (p.status || 'planning').toLowerCase(),
    budget_amount:   parseFloat(p.budget_amount || p.budget || 0),
    actual_cost:     parseFloat(p.actual_cost   || p.cost   || 0),
    total_tasks:     parseInt(p.total_tasks     || 0),
    completed_tasks: parseInt(p.completed_tasks || 0),
    start_date:      p.start_date  ? p.start_date.split('T')[0]  : '',
    end_date:        p.end_date    ? p.end_date.split('T')[0]    : '',
    team_size:       parseInt(p.team_size || 0),
  };
}
