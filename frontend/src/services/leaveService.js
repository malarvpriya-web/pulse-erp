/**
 * leaveService.js — centralized service layer for all Leave API calls.
 * Every read function returns data or [] / null — never throws to the caller.
 */
import api from '@/services/api/client';

const normalize = (res) => {
  const d = res?.data;
  if (!d) return null;
  return d.leaves || d.data || d;
};

// ── Leave Applications ────────────────────────────────────────────────────────

export const getLeaves = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  console.error('getLeaves:', res.reason?.message);
  return [];
};

export const getMyLeaves = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves/my', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const getTeamLeaves = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves/team', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  return [];
};

export const getLeaveApplications = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves/applications', { params })]);
  if (res.status === 'fulfilled') {
    const data = normalize(res.value);
    if (Array.isArray(data)) return data;
  }
  return [];
};

// ── Leave Balance ─────────────────────────────────────────────────────────────

export const getLeaveBalance = async (employeeId, year) => {
  const params = year ? { year } : {};
  const [res] = await Promise.allSettled([
    employeeId
      ? api.get(`/leaves/balance/${employeeId}`, { params })
      : api.get('/leaves/balance', { params }),
  ]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : (d?.balance || d || []);
  }
  return [];
};

// ── Leave Calendar ────────────────────────────────────────────────────────────

export const getLeaveCalendar = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves/calendar', { params })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return d?.events || d?.data || (Array.isArray(d) ? d : []);
  }
  return [];
};

export const getLeaveAnalytics = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leaves/analytics', { params })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : [];
  }
  return [];
};

// ── Mutations ────────────────────────────────────────────────────────────────

export const applyLeave = async (data) => {
  const res = await api.post('/leaves/apply', data);
  return res.data;
};

export const approveLeaveHR = async (id, comments = '') => {
  const res = await api.post(`/leaves/approve/hr/${id}`, { comments });
  return res.data;
};

// Kept for backward compatibility — prefer approveLeaveHR for explicit HR approvals
export const approveLeave = approveLeaveHR;

export const approveLeaveL1 = async (id, comments = '') => {
  const res = await api.post(`/leaves/approve/manager/${id}`, { comments });
  return res.data;
};

export const approveLeaveL2 = async (id, comments = '') => {
  const res = await api.post(`/leaves/approve/l2/${id}`, { comments });
  return res.data;
};

export const rejectLeaveL1 = async (id, comments) => {
  const res = await api.post(`/leaves/reject/manager/${id}`, { comments });
  return res.data;
};

export const rejectLeaveL2 = async (id, comments) => {
  const res = await api.post(`/leaves/reject/l2/${id}`, { comments });
  return res.data;
};

export const rejectLeave = async (id, comments) => {
  const res = await api.post(`/leaves/reject/hr/${id}`, { comments });
  return res.data;
};

export const cancelLeave = async (id, reason = '') => {
  const res = await api.put(`/leaves/${id}/cancel`, { reason });
  return res.data;
};

export const bulkApproveLeaves = async (ids, comments = '') => {
  const res = await api.post('/leaves/bulk-approve', { ids, comments });
  return res.data;
};

// ── Leave Types ──────────────────────────────────────────────────────────────

export const getLeaveTypes = async () => {
  const [res] = await Promise.allSettled([api.get('/leaves/types')]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : [];
  }
  return [];
};

// ── Comp Off ─────────────────────────────────────────────────────────────────

export const getCompOffRecords = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/comp-off', { params })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : [];
  }
  return [];
};

export const submitCompOff = async (data) => {
  const res = await api.post('/comp-off', data);
  return res.data;
};

export const approveCompOff = async (id, comments = '') => {
  const res = await api.post(`/comp-off/approve/${id}`, { comments });
  return res.data;
};

export const rejectCompOff = async (id, comments) => {
  const res = await api.post(`/comp-off/reject/${id}`, { comments });
  return res.data;
};

export const getCompOffBalance = async (employeeId) => {
  const [res] = await Promise.allSettled([api.get(`/comp-off/balance/${employeeId}`)]);
  if (res.status === 'fulfilled') return res.value.data;
  return null;
};

// ── Leave Encashment ─────────────────────────────────────────────────────────

export const getEncashments = async (params = {}) => {
  const [res] = await Promise.allSettled([api.get('/leave-encashment', { params })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : [];
  }
  return [];
};

export const createEncashment = async (data) => {
  const res = await api.post('/leave-encashment', data);
  return res.data;
};

export const getEligibleEncashment = async (employeeId, year) => {
  const [res] = await Promise.allSettled([api.get(`/leave-encashment/eligible/${employeeId}`, { params: { year } })]);
  if (res.status === 'fulfilled') {
    const d = res.value.data;
    return Array.isArray(d) ? d : [];
  }
  return [];
};

// ── Accrual ───────────────────────────────────────────────────────────────────

export const runAccrual = async (month, year) => {
  const res = await api.post('/leave-accrual/run', { month, year });
  return res.data;
};

export const runCarryForward = async (fromYear) => {
  const res = await api.post('/leave-accrual/carry-forward', { from_year: fromYear });
  return res.data;
};
