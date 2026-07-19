/**
 * payrollService.js — centralized service layer for Payroll API calls.
 * Every function returns data or [] / null — never throws to the caller.
 */
import api from '@/services/api/client';

const normalize = (res) => {
  const d = res?.data;
  if (!d) return null;
  if (Array.isArray(d)) return d;
  return d.payroll || d.records || d.data || d;
};

// ── Read ─────────────────────────────────────────────────────────────────────

export const getPayroll = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/payroll', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  if (res.status === 'rejected') console.error('getPayroll:', res.reason?.message);
  return [];
};

export const getPayslip = async (id) => {
  const [res] = await Promise.allSettled([api.get(`/payroll/payslips/${id}`)]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.payslip || d || null;
  }
  console.error('getPayslip:', res.reason?.message);
  return null;
};

export const getMyPayslips = async (employeeId) => {
  const [res] = await Promise.allSettled([
    api.get('/payroll/payslips', { params: { employee_id: employeeId } }),
  ]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  console.error('getMyPayslips:', res.reason?.message);
  return [];
};

export const getPayrollSummary = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/payroll/summary', { params })]);
  if (res.status === 'fulfilled') return res.value.data;
  console.error('getPayrollSummary:', res.reason?.message);
  return null;
};

export const getPayrollTrend = async () => {
  const [res] = await Promise.allSettled([api.get('/payroll/trend')]);
  if (res.status === 'fulfilled') return res.value.data;
  console.error('getPayrollTrend:', res.reason?.message);
  return [];
};

// ── Mutations ────────────────────────────────────────────────────────────────

export const runPayroll = async (data) => {
  // POST /payroll/generate (or /payroll/run — both are active)
  const res = await api.post('/payroll/generate', data);
  return res.data;
};

export const markPaid = async (employeeId, data) => {
  const res = await api.post(`/payroll/${employeeId}/mark-paid`, data);
  return res.data;
};

export const updatePayroll = async (id, data) => {
  const res = await api.put(`/payroll/${id}`, data);
  return res.data;
};
