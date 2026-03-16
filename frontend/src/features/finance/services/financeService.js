import api from '@/services/api/client';

// ── Dashboard ──────────────────────────────────────────────────────────────

export const getFinanceDashboard = async () => {
  try {
    const res = await api.get('/finance/dashboard');
    return res.data || {};
  } catch (err) {
    console.error('getFinanceDashboard failed:', err.message);
    return {};
  }
};

// ── Invoices ───────────────────────────────────────────────────────────────

export const getInvoices = async (params = {}) => {
  try {
    const res = await api.get('/finance/invoices', { params });
    return res.data?.rows || res.data?.invoices || res.data || [];
  } catch (err) {
    console.error('getInvoices failed:', err.message);
    return [];
  }
};

export const createInvoice = async (data) => {
  const res = await api.post('/finance/invoices', data);
  return res.data;
};

export const updateInvoice = async (id, data) => {
  const res = await api.put(`/finance/invoices/${id}`, data);
  return res.data;
};

export const deleteInvoice = async (id) => {
  const res = await api.delete(`/finance/invoices/${id}`);
  return res.data;
};

// ── Parties ────────────────────────────────────────────────────────────────

export const getParties = async (params = {}) => {
  try {
    const res = await api.get('/finance/parties', { params });
    return res.data?.rows || res.data?.parties || res.data || [];
  } catch (err) {
    console.error('getParties failed:', err.message);
    return [];
  }
};

export const createParty = async (data) => {
  const res = await api.post('/finance/parties', data);
  return res.data;
};

export const updateParty = async (id, data) => {
  const res = await api.put(`/finance/parties/${id}`, data);
  return res.data;
};

export const togglePartyStatus = async (id, isActive) => {
  const res = await api.patch(`/finance/parties/${id}/status`, { is_active: isActive });
  return res.data;
};

// ── Accounts ───────────────────────────────────────────────────────────────

export const getAccounts = async (params = {}) => {
  try {
    const res = await api.get('/finance/accounts', { params });
    return res.data || [];
  } catch (err) {
    console.error('getAccounts failed:', err.message);
    return [];
  }
};

// ── Bills ──────────────────────────────────────────────────────────────────

export const getBills = async (params = {}) => {
  try {
    const res = await api.get('/finance/bills', { params });
    return res.data?.rows || res.data?.bills || res.data || [];
  } catch (err) {
    console.error('getBills failed:', err.message);
    return [];
  }
};

export const createBill = async (data) => {
  const res = await api.post('/finance/bills', data);
  return res.data;
};

// ── Payments ──────────────────────────────────────────────────────────────

export const getPayments = async (params = {}) => {
  try {
    const res = await api.get('/finance/payments', { params });
    return res.data?.rows || res.data?.payments || res.data || [];
  } catch (err) {
    console.error('getPayments failed:', err.message);
    return [];
  }
};

export const createPayment = async (data) => {
  const res = await api.post('/finance/payments', data);
  return res.data;
};
