import api from '@/services/api/client';

// ── Dashboard ──────────────────────────────────────────────────────────────

export const getFinanceDashboard = async (params = {}) => {
  try {
    const res = await api.get('/finance/dashboard', { params });
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
  try {
    const res = await api.post('/finance/invoices', data);
    return res.data;
  } catch (err) {
    console.error('createInvoice failed:', err.message);
    throw err;
  }
};

export const updateInvoice = async (id, data) => {
  try {
    const res = await api.put(`/finance/invoices/${id}`, data);
    return res.data;
  } catch (err) {
    console.error('updateInvoice failed:', err.message);
    throw err;
  }
};

export const deleteInvoice = async (id) => {
  try {
    const res = await api.delete(`/finance/invoices/${id}`);
    return res.data;
  } catch (err) {
    console.error('deleteInvoice failed:', err.message);
    throw err;
  }
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
  try {
    const res = await api.post('/finance/parties', data);
    return res.data;
  } catch (err) {
    console.error('createParty failed:', err.message);
    throw err;
  }
};

export const updateParty = async (id, data) => {
  try {
    const res = await api.put(`/finance/parties/${id}`, data);
    return res.data;
  } catch (err) {
    console.error('updateParty failed:', err.message);
    throw err;
  }
};

export const togglePartyStatus = async (id, isActive) => {
  try {
    const res = await api.patch(`/finance/parties/${id}/status`, { is_active: isActive });
    return res.data;
  } catch (err) {
    console.error('togglePartyStatus failed:', err.message);
    throw err;
  }
};

export const getPartyTransactions = async (id) => {
  try {
    const res = await api.get(`/finance/parties/${id}/transactions`);
    return res.data || [];
  } catch {
    return [];
  }
};

export const getPartyAgeing = async (id) => {
  try {
    const res = await api.get(`/finance/parties/${id}/ageing`);
    return res.data || {};
  } catch {
    return {};
  }
};

export const importParties = async (rows) => {
  try {
    const res = await api.post('/finance/parties/import', { rows });
    return res.data;
  } catch (err) {
    console.error('importParties failed:', err.message);
    throw err;
  }
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
  try {
    const res = await api.post('/finance/bills', data);
    return res.data;
  } catch (err) {
    console.error('createBill failed:', err.message);
    throw err;
  }
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
  try {
    const res = await api.post('/finance/payments', data);
    return res.data;
  } catch (err) {
    console.error('createPayment failed:', err.message);
    throw err;
  }
};
