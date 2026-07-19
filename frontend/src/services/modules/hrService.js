import api from '../api/client';

export const hrService = {
  // Employees  — GET /  POST /  PUT /:id  (no single-GET or DELETE in backend)
  getAll:            (params = {})       => api.get('/employees', { params }),
  create:            (data)              => api.post('/employees', data),
  update:            (id, data)          => api.put(`/employees/${id}`, data),
  getStats:          ()                  => api.get('/employees/analytics'),

  // Leaves (legacy /api/leaves)
  getLeaves:         (params = {})       => api.get('/leaves', { params }),
  applyLeave:        (data)              => api.post('/leaves', data),
  approveLeave:      (id)                => api.patch(`/leaves/${id}/approve`),
  rejectLeave:       (id, reason)        => api.patch(`/leaves/${id}/reject`, { reason }),
  getMyLeaves:       ()                  => api.get('/leaves/my'),
  // Balance lives under the canonical leaves module, requires employee id
  getLeaveBalance:   (employeeId)        => api.get(`/leaves/balance/${employeeId}`),

  // Attendance  — POST /mark  GET /employee/:id  GET /summary/:id
  getAttendance:     (employeeId, params = {}) => api.get(`/attendance/employee/${employeeId}`, { params }),
  getAttendanceSummary: (employeeId, params = {}) => api.get(`/attendance/summary/${employeeId}`, { params }),
  // Backend uses a single /mark endpoint for both clock-in and clock-out;
  // callers supply { employee_id, attendance_date, check_in_time } or { ...check_out_time }
  markAttendance:    (data)              => api.post('/attendance/mark', data),

  // Payroll  — GET /  GET /summary  POST /run
  getPayroll:        (params = {})       => api.get('/payroll', { params }),
  getPayrollSummary: ()                  => api.get('/payroll/summary'),
  runPayroll:        (data)              => api.post('/payroll/run', data),
};

export default hrService;
