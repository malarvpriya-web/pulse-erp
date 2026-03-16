import api from '@/services/api/client';

// ── Payroll ────────────────────────────────────────────────────────────────

export const getPayroll = async (month) => {
  try {
    const res = await api.get(`/payroll`, { params: { month } });
    return res.data?.rows || res.data?.payroll || res.data || [];
  } catch (err) {
    console.error('getPayroll failed:', err.message);
    return [];
  }
};

export const getPayrollSummary = async () => {
  try {
    const res = await api.get('/payroll/summary');
    return res.data || {};
  } catch (err) {
    console.error('getPayrollSummary failed:', err.message);
    return {};
  }
};

export const getPayrollTrend = async () => {
  try {
    const res = await api.get('/payroll/trend');
    return res.data || [];
  } catch (err) {
    console.error('getPayrollTrend failed:', err.message);
    return [];
  }
};

export const generatePayroll = async (data) => {
  const res = await api.post('/payroll/generate', data);
  return res.data;
};

// ── Policies ──────────────────────────────────────────────────────────────

export const getPolicies = async (params = {}) => {
  try {
    const res = await api.get('/hr/policies', { params });
    return res.data?.policies || res.data || [];
  } catch (err) {
    console.error('getPolicies failed:', err.message);
    return [];
  }
};

export const createPolicy = async (data) => {
  const res = await api.post('/hr/policies', data);
  return res.data;
};

export const updatePolicy = async (id, data) => {
  const res = await api.put(`/hr/policies/${id}`, data);
  return res.data;
};

// ── Announcements ─────────────────────────────────────────────────────────

export const getAnnouncements = async (params = {}) => {
  try {
    const res = await api.get('/hr/announcements', { params });
    return res.data?.announcements || res.data || [];
  } catch (err) {
    console.error('getAnnouncements failed:', err.message);
    return [];
  }
};

export const createAnnouncement = async (data) => {
  const res = await api.post('/hr/announcements', data);
  return res.data;
};

// ── Holiday Calendar ──────────────────────────────────────────────────────

export const getHolidays = async (params = {}) => {
  try {
    const res = await api.get('/hr/holidays', { params });
    return res.data?.holidays || res.data || [];
  } catch (err) {
    console.error('getHolidays failed:', err.message);
    return [];
  }
};

// ── Probation ─────────────────────────────────────────────────────────────

export const getProbationEmployees = async (params = {}) => {
  try {
    const res = await api.get('/hr/probation', { params });
    return res.data?.employees || res.data || [];
  } catch (err) {
    console.error('getProbationEmployees failed:', err.message);
    return [];
  }
};

export const updateProbationStatus = async (id, data) => {
  const res = await api.put(`/hr/probation/${id}`, data);
  return res.data;
};
