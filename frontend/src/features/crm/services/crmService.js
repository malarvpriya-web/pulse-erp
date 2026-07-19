import api from '@/services/api/client';

// ── Leads ──────────────────────────────────────────────────────────────────

export const getLeads = async (params = {}) => {
  try {
    const res = await api.get('/crm/leads', { params });
    return res.data?.leads || res.data || [];
  } catch (err) {
    console.error('getLeads failed:', err.message);
    return [];
  }
};

export const getLeadsStats = async () => {
  try {
    const res = await api.get('/crm/leads/stats');
    return res.data?.data ?? res.data ?? {};
  } catch (err) {
    console.error('getLeadsStats failed:', err.message);
    return {};
  }
};

// ── IEM (enquiry master) ───────────────────────────────────────────────────

// Count / Value / Estimate per bucket + conversion rate.
export const getLeadsSummary = async (params = {}) => {
  try {
    const res = await api.get('/crm/leads/summary', { params });
    return res.data || { conversion_rate: 0, rows: [] };
  } catch (err) {
    console.error('getLeadsSummary failed:', err.message);
    return { conversion_rate: 0, rows: [] };
  }
};

// Toolbar dropdown options: owners, partners, zones, fiscal years.
export const getLeadsFilters = async () => {
  try {
    const res = await api.get('/crm/leads/filters');
    return res.data || { users: [], partners: [], zones: [], fiscal_years: [] };
  } catch (err) {
    console.error('getLeadsFilters failed:', err.message);
    return { users: [], partners: [], zones: [], fiscal_years: [] };
  }
};

// Monthwise / by-zone / by-status aggregates for the IEM widget row.
export const getLeadAnalytics = async (params = {}) => {
  try {
    const res = await api.get('/crm/analytics/lead-dashboard', { params });
    return res.data?.data ?? res.data ?? null;
  } catch (err) {
    console.error('getLeadAnalytics failed:', err.message);
    return null;
  }
};

// ── Enquiry activity trail (lead_activities) ───────────────────────────────
// Backed by migration 20260717000005. Before it, both of these 500'd with
// 42P01 — the table the routes query had never been created.
export const getLeadActivities = async (leadId) => {
  try {
    const res = await api.get(`/crm/leads/${leadId}/activities`);
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('getLeadActivities failed:', err.message);
    return [];
  }
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
  try {
    const res = await api.get('/crm/won-lost-leads', { params });
    return res.data || { data: [], total_value: 0 };
  } catch (err) {
    console.error('getWonLostLeads failed:', err.message);
    return { data: [], total_value: 0 };
  }
};

export const getWonLostLeadsFilters = async () => {
  try {
    const res = await api.get('/crm/won-lost-leads/filters');
    return res.data || { users: [], fiscal_years: [] };
  } catch (err) {
    console.error('getWonLostLeadsFilters failed:', err.message);
    return { users: [], fiscal_years: [] };
  }
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
  try {
    const res = await api.get('/crm/opportunities/kanban');
    return res.data || {};
  } catch (err) {
    console.error('getOpportunitiesKanban failed:', err.message);
    return {};
  }
};

export const getOpportunities = async (params = {}) => {
  try {
    const res = await api.get('/crm/opportunities', { params });
    return res.data?.opportunities || res.data || [];
  } catch (err) {
    console.error('getOpportunities failed:', err.message);
    return [];
  }
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
  try {
    const res = await api.get('/crm/accounts', { params });
    return res.data?.accounts || res.data || [];
  } catch (err) {
    console.error('getAccounts failed:', err.message);
    return [];
  }
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
  try {
    const res = await api.get('/crm/contacts', { params });
    return res.data?.contacts || res.data || [];
  } catch (err) {
    console.error('getContacts failed:', err.message);
    return [];
  }
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
  try {
    const res = await api.get('/crm/stats');
    return res.data || {};
  } catch (err) {
    console.error('getCrmStats failed:', err.message);
    return {};
  }
};
