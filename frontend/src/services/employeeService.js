/**
 * employeeService.js — centralized service layer for Employee API calls.
 * Every function returns data or [] / null — never throws to the caller.
 */
import api from '@/services/api/client';

const addName = (emp) => {
  if (!emp || emp.name) return emp;
  return { ...emp, name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() };
};

const normalize = (res) => {
  const d = res?.data;
  if (!d) return null;
  const list = d.employees || d.data || d;
  return Array.isArray(list) ? list.map(addName) : list;
};

// ── Read ─────────────────────────────────────────────────────────────────────

export const getEmployees = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/employees', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getEmployees:', res.reason?.message);
  return [];
};

export const getEmployee = async (id) => {
  const [res] = await Promise.allSettled([api.get(`/employees/${id}`)]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.employee || d || null;
  }
  console.error('getEmployee:', res.reason?.message);
  return null;
};

export const getExEmployees = async ({ exit_date_from, exit_date_to } = {}) => {
  const params = {};
  if (exit_date_from) params.exit_date_from = exit_date_from;
  if (exit_date_to)   params.exit_date_to   = exit_date_to;
  const [res] = await Promise.allSettled([api.get('/employees/ex', { params })]);
  if (res.status === 'fulfilled') {
    const data = res.value?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.employees)) return data.employees;
  }
  console.error('getExEmployees:', res.reason?.message);
  return [];
};

export const getDepartments = async () => {
  // /departments returns 404 — derive from employees
  const employees = await getEmployees();
  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))];
  return depts.map((name, i) => ({ id: i + 1, name }));
};

// ── Mutations ────────────────────────────────────────────────────────────────

export const createEmployee = async (data) => {
  const res = await api.post('/employees', data);
  return res.data;
};

export const updateEmployee = async (id, data) => {
  const res = await api.put(`/employees/${id}`, data);
  return res.data;
};

export const deleteEmployee = async (id) => {
  const res = await api.delete(`/employees/${id}`);
  return res.data;
};
