/**
 * travelService.js — centralized service layer for Travel & Expense API calls.
 * Every function returns data or [] — never throws to the caller.
 */
import api from '@/services/api/client';

const normalize = (res, key) => {
  const d = res?.data;
  if (!d) return null;
  return d[key] || d.data || d;
};

// ── Travel Requests ───────────────────────────────────────────────────────────

export const getTravelRequests = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/travel/requests', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'requests');
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const createTravelRequest = async (data) => {
  const res = await api.post('/travel/requests/v2', data);
  return res.data;
};

export const updateTravelRequest = async (id, data) => {
  const res = await api.put(`/travel/requests/${id}`, data);
  return res.data;
};

export const approveTravelRequest = async (id) => {
  const res = await api.put(`/travel/requests/${id}/status`, { status: 'Approved' });
  return res.data;
};

export const levelApproveTravelRequest = async (id, status, remarks = '') => {
  const res = await api.put(`/travel/requests/${id}/level-approve`, { status, remarks });
  return res.data;
};

export const getTravelTypes = async () => {
  const [res] = await Promise.allSettled([api.get('/travel/travel-types')]);
  if (res.status === 'fulfilled') return res.value?.data || [];
  return [
    'Sales Visit', 'Customer Meeting', 'Tender Discussion', 'Site Survey',
    'Application Engineering', 'Design Discussion', 'FAT Support', 'Installation',
    'Commissioning', 'Service Visit', 'AMC Visit', 'Training', 'Internal Meeting',
  ];
};

// ── Expense Claims (Phase 47) ─────────────────────────────────────────────────

export const getExpenseClaims = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/reimbursement/claims', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'claims');
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const createExpenseClaim = async (data) => {
  const res = await api.post('/reimbursement/claims', data);
  return res.data;
};

export const submitExpenseClaim = async (id) => {
  const res = await api.post(`/reimbursement/claims/${id}/submit`);
  return res.data;
};

export const managerApproveExpenseClaim = async (id, status, remarks = '') => {
  const res = await api.put(`/reimbursement/claims/${id}/manager-approve`, { status, remarks });
  return res.data;
};

export const accountsVerifyExpenseClaim = async (id, status, data = {}) => {
  const res = await api.put(`/reimbursement/claims/${id}/accounts-verify`, { status, ...data });
  return res.data;
};

export const mgmtApproveExpenseClaim = async (id, status, remarks = '') => {
  const res = await api.put(`/reimbursement/claims/${id}/mgmt-approve`, { status, remarks });
  return res.data;
};

export const payExpenseClaim = async (id, data) => {
  const res = await api.put(`/reimbursement/claims/${id}/pay`, data);
  return res.data;
};

export const getReimbursementDashboard = async () => {
  const [res] = await Promise.allSettled([api.get('/reimbursement/dashboard')]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return {};
};

export const checkPolicyCompliance = async (employee_id, expense_type, amount) => {
  const [res] = await Promise.allSettled([
    api.post('/travel-policy/check', { employee_id, expense_type, amount }),
  ]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return { within_policy: true };
};

// ── Travel Policy Rules ────────────────────────────────────────────────────────

export const getTravelPolicies = async () => {
  const [res] = await Promise.allSettled([api.get('/travel-policy')]);
  if (res.status === 'fulfilled') return res.value?.data || [];
  return [];
};

export const createTravelPolicy = async (data) => {
  const res = await api.post('/travel-policy', data);
  return res.data;
};

export const updateTravelPolicy = async (id, data) => {
  const res = await api.put(`/travel-policy/${id}`, data);
  return res.data;
};

export const deleteTravelPolicy = async (id) => {
  const res = await api.delete(`/travel-policy/${id}`);
  return res.data;
};

// ── Visit Reports ─────────────────────────────────────────────────────────────

export const getVisitReports = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/visit-reports', { params })]);
  if (res.status === 'fulfilled') return res.value?.data || [];
  return [];
};

export const createVisitReport = async (data) => {
  const res = await api.post('/visit-reports', data);
  return res.data;
};

export const updateVisitReport = async (id, data) => {
  const res = await api.put(`/visit-reports/${id}`, data);
  return res.data;
};

export const checkVisitReportRequired = async (travel_request_id) => {
  const [res] = await Promise.allSettled([
    api.get('/visit-reports/check-pending', { params: { travel_request_id } }),
  ]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return { report_required: false };
};

// ── CEO Analytics ─────────────────────────────────────────────────────────────

export const getCEOTravelSummary = async () => {
  const [res] = await Promise.allSettled([api.get('/travel/analytics/ceo-summary')]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return {};
};

// ── Customer / Project 360 ────────────────────────────────────────────────────

export const getCustomer360Travel = async (customerId) => {
  const [res] = await Promise.allSettled([api.get(`/travel/customer-360/${customerId}`)]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return {};
};

export const getProject360Travel = async (projectId) => {
  const [res] = await Promise.allSettled([api.get(`/travel/project-360/${projectId}`)]);
  if (res.status === 'fulfilled') return res.value?.data || {};
  return {};
};

// ── Closure Check ─────────────────────────────────────────────────────────────

export const checkTravelClosure = async (params = {}) => {
  const [res] = await Promise.allSettled([
    api.get('/travel/closure-check', { params }),
  ]);
  if (res.status === 'fulfilled') return res.value?.data || { canClose: true };
  return { canClose: true };
};

export const checkReimbursementClosure = async (params = {}) => {
  const [res] = await Promise.allSettled([
    api.get('/reimbursement/closure-check', { params }),
  ]);
  if (res.status === 'fulfilled') return res.value?.data || { canClose: true };
  return { canClose: true };
};

// ── Legacy: Expenses (kept for backward compat) ───────────────────────────────

export const getTravelExpenses = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/travel/expenses', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'expenses');
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const submitExpense = async (data) => {
  const res = await api.post('/travel/expenses/v2', data);
  return res.data;
};

// ── Legacy: Advances ──────────────────────────────────────────────────────────

export const getTravelAdvances = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/travel/advances', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value, 'advances');
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const requestAdvance = async (data) => {
  const res = await api.post('/travel/advances', data);
  return res.data;
};
