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
