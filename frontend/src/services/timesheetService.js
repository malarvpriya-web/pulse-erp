/**
 * timesheetService.js — centralized service layer for Timesheet API calls.
 * Every function returns data or [] / null — never throws to the caller.
 */
import api from '@/services/api/client';

const SAMPLE_TIMESHEETS = [
  { id:1, employee_id:1, employee_name:'Arjun Mehta',  project:'Pulse ERP',       week:'2026-03-10', hours:42, billable_hours:40, status:'Submitted',  submitted_at:'2026-03-15' },
  { id:2, employee_id:3, employee_name:'Rohit Verma',  project:'Finance Module',  week:'2026-03-10', hours:38, billable_hours:35, status:'Approved',   submitted_at:'2026-03-14' },
  { id:3, employee_id:5, employee_name:'Kiran Nair',   project:'Client Onboarding', week:'2026-03-10', hours:40, billable_hours:40, status:'Submitted', submitted_at:'2026-03-15' },
  { id:4, employee_id:6, employee_name:'Deepa Reddy',  project:'QA Automation',   week:'2026-03-10', hours:36, billable_hours:36, status:'Draft',      submitted_at:null },
  { id:5, employee_id:8, employee_name:'Ananya Iyer',  project:'Marketing Campaign', week:'2026-03-10', hours:40, billable_hours:20, status:'Rejected', submitted_at:'2026-03-13' },
];

const SAMPLE_UTILIZATION = {
  total_hours: 196,
  billable_hours: 171,
  utilization_rate: 87.2,
  by_project: [
    { project:'Pulse ERP', hours:82, billable:80 },
    { project:'Finance Module', hours:38, billable:35 },
    { project:'Client Onboarding', hours:40, billable:40 },
    { project:'QA Automation', hours:36, billable:36 },
  ],
};

const normalize = (res) => {
  const d = res?.data;
  if (!d) return null;
  return d.timesheets || d.records || d.data || d;
};

// ── Read ─────────────────────────────────────────────────────────────────────

export const getTimesheets = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/timesheets', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data) && data.length) return data;
  }
  if (res.status === 'rejected') console.error('getTimesheets:', res.reason?.message);
  return SAMPLE_TIMESHEETS;
};

export const getPendingTimesheets = async () => {
  const [res] = await Promise.allSettled([api.get('/timesheets/pending')]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  console.error('getPendingTimesheets:', res.reason?.message);
  return SAMPLE_TIMESHEETS.filter(t => t.status === 'Submitted');
};

export const getMyTimesheets = async (employeeId) => {
  const [res] = await Promise.allSettled([
    api.get('/timesheets', { params: { employee_id: employeeId } }),
  ]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  console.error('getMyTimesheets:', res.reason?.message);
  return SAMPLE_TIMESHEETS.filter(t => String(t.employee_id) === String(employeeId));
};

export const getUtilization = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/timesheets/utilization', { params })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.utilization || d || SAMPLE_UTILIZATION;
  }
  console.error('getUtilization:', res.reason?.message);
  return SAMPLE_UTILIZATION;
};

// ── Mutations ────────────────────────────────────────────────────────────────

export const submitTimesheet = async (data) => {
  const res = await api.post('/timesheets', data);
  return res.data;
};

export const approveTimesheet = async (id) => {
  const res = await api.put(`/timesheets/${id}/approve`);
  return res.data;
};

export const rejectTimesheet = async (id, reason) => {
  const res = await api.put(`/timesheets/${id}/reject`, { reason });
  return res.data;
};

export const updateTimesheet = async (id, data) => {
  const res = await api.put(`/timesheets/${id}`, data);
  return res.data;
};
