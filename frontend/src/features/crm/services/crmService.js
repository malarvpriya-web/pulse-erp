import api from '@/services/api/client';

/**
 * CRM data access.
 *
 * These functions deliberately do NOT catch. The CRM audit (2026-08-19) found
 * 29 exported functions here with 13 catch blocks and ZERO rethrows — every
 * failure resolved to an empty array or object, so a 500 from the API rendered
 * as a calm "no records found" state and was indistinguishable from real
 * emptiness. The worst case returned `{ conversion_rate: 0, rows: [] }`, which
 * painted a confident 0% conversion rate on the dashboard whenever the endpoint
 * was down (audit C-18).
 *
 * Errors now propagate to the calling component, which is responsible for
 * showing an error state. Unmeasured must never render as zero.
 */

// ── Leads ──────────────────────────────────────────────────────────────────

export const getLeads = async (params = {}) => {
    const res = await api.get('/crm/leads', { params });
    return res.data?.leads || res.data || [];
};

export const getLeadsStats = async () => {
    const res = await api.get('/crm/leads/stats');
    return res.data?.data ?? res.data ?? {};
};

// ── IEM (enquiry master) ───────────────────────────────────────────────────

// Count / Value / Estimate per bucket + conversion rate.
export const getLeadsSummary = async (params = {}) => {
    const res = await api.get('/crm/leads/summary', { params });
    return res.data || { conversion_rate: 0, rows: [] };
};

// Toolbar dropdown options: owners, partners, zones, fiscal years.
export const getLeadsFilters = async () => {
    const res = await api.get('/crm/leads/filters');
    return res.data || { users: [], partners: [], zones: [], fiscal_years: [] };
};

// Monthwise / by-zone / by-status aggregates for the IEM widget row.
export const getLeadAnalytics = async (params = {}) => {
    const res = await api.get('/crm/analytics/lead-dashboard', { params });
    return res.data?.data ?? res.data ?? null;
};

// ── Enquiry activity trail (lead_activities) ───────────────────────────────
// Backed by migration 20260717000005. Before it, both of these 500'd with
// 42P01 — the table the routes query had never been created.
export const getLeadActivities = async (leadId) => {
    const res = await api.get(`/crm/leads/${leadId}/activities`);
    return Array.isArray(res.data) ? res.data : [];
};

export const addLeadActivity = async (leadId, data) => {
  const res = await api.post(`/crm/leads/${leadId}/activities`, data);
  return res.data;
};

export const exportLeads = async (params = {}) => {
  const res = await api.get('/crm/leads/export', { params, responseType: 'blob' });
  const url  = URL.createObjectURL(new Blob([res.data]));
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `iem_enquiries_${new Date().toISOString().split('T')[0]}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const createLead = async (data) => {
  const res = await api.post('/crm/leads', data);
  return res.data;
};

export const updateLead = async (id, data) => {
  const res = await api.put(`/crm/leads/${id}`, data);
  return res.data;
};

export const deleteLead = async (id) => {
  const res = await api.delete(`/crm/leads/${id}`);
  return res.data;
};

export const assignLead = async (id, owner_id) => {
  const res = await api.patch(`/crm/leads/${id}/assign`, { owner_id });
  return res.data;
};

export const bulkAssignLeads = async (lead_ids, owner_id) => {
  const res = await api.post('/crm/leads/bulk-assign', { lead_ids, owner_id });
  return res.data;
};

export const importLeads = async (file) => {
  const form = new FormData();
  form.append('file', file);
  const res = await api.post('/crm/leads/import', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
};

// ── IEM Won / Lost Leads report ─────────────────────────────────────────────
export const getWonLostLeads = async (params = {}) => {
    const res = await api.get('/crm/won-lost-leads', { params });
    return res.data || { data: [], total_value: 0 };
};

export const getWonLostLeadsFilters = async () => {
    const res = await api.get('/crm/won-lost-leads/filters');
    return res.data || { users: [], fiscal_years: [] };
};

export const exportWonLostLeads = async (params = {}) => {
  const res = await api.get('/crm/won-lost-leads/export', { params, responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = `won_lost_leads_${Date.now()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};

// Atomic transactional conversion — creates opportunity + marks lead converted + writes activity
export const convertLead = async (id, data) => {
  const res = await api.post(`/crm/leads/${id}/convert`, data);
  return res.data;
};

// ── Opportunities ──────────────────────────────────────────────────────────

export const getOpportunitiesKanban = async () => {
    const res = await api.get('/crm/opportunities/kanban');
    return res.data || {};
};

export const getOpportunities = async (params = {}) => {
    const res = await api.get('/crm/opportunities', { params });
    return res.data?.opportunities || res.data || [];
};

export const createOpportunity = async (data) => {
  const res = await api.post('/crm/opportunities', data);
  return res.data;
};

export const updateOpportunity = async (id, data) => {
  const res = await api.put(`/crm/opportunities/${id}`, data);
  return res.data;
};

// ── Accounts ───────────────────────────────────────────────────────────────

export const getAccounts = async (params = {}) => {
    const res = await api.get('/crm/accounts', { params });
    return res.data?.accounts || res.data || [];
};

export const createAccount = async (data) => {
  const res = await api.post('/crm/accounts', data);
  return res.data;
};

export const updateAccount = async (id, data) => {
  const res = await api.put(`/crm/accounts/${id}`, data);
  return res.data;
};

// ── Contacts ───────────────────────────────────────────────────────────────

export const getContacts = async (params = {}) => {
    const res = await api.get('/crm/contacts', { params });
    return res.data?.contacts || res.data || [];
};

export const createContact = async (data) => {
  const res = await api.post('/crm/contacts', data);
  return res.data;
};

export const updateContact = async (id, data) => {
  const res = await api.put(`/crm/contacts/${id}`, data);
  return res.data;
};

// ── Stats & Dashboard ─────────────────────────────────────────────────────

export const getCrmStats = async () => {
    const res = await api.get('/crm/stats');
    return res.data || {};
};
