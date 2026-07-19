import api from '../api/client';

// NOTE: The timesheets router is mounted at /api/timesheets but its internal
// route paths include the /timesheets segment, so all URLs resolve to
// /api/timesheets/timesheets/...  This matches the pattern already used by
// the timesheet page components (MyTimesheet, Timesheets, TimesheetApprovals).

const BASE = '/timesheets/timesheets';

export const timesheetService = {
  // Reads
  getAll:              (params = {})          => api.get(BASE, { params }),
  getById:             (id)                   => api.get(`${BASE}/${id}`),
  getByEmployee:       (employeeId, params = {}) => api.get(BASE, { params: { ...params, employee_id: employeeId } }),
  // Requires managerId; pass the logged-in manager's employee id
  getPendingApprovals: (managerId)            => api.get(`${BASE}/pending-approvals/${managerId}`),
  getWeeklySummary:    (params = {})          => api.get(`${BASE}/summary/weekly`, { params }),
  // Requires employeeId
  getUtilization:      (employeeId, params = {}) => api.get(`${BASE}/utilization/${employeeId}`, { params }),

  // Mutations
  create:              (data)                 => api.post(BASE, data),
  update:              (id, data)             => api.put(`${BASE}/${id}`, data),
  remove:              (id)                   => api.delete(`${BASE}/${id}`),
  submitWeek:          (data)                 => api.post(`${BASE}/submit-week`, data),
  // Backend uses POST /approve with body { timesheet_id }, not PATCH /:id/approve
  approve:             (timesheetId)          => api.post(`${BASE}/approve`, { timesheet_id: timesheetId }),
  reject:              (timesheetId, reason)  => api.post(`${BASE}/reject`, { timesheet_id: timesheetId, reason }),
};

export default timesheetService;
