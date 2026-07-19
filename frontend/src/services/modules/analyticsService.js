import api from '../api/client';

export const analyticsService = {
  // Workforce — GET /api/analytics/headcount|attrition|dept-workforce
  getHeadcount:     (params = {})    => api.get('/analytics/headcount', { params }),
  getAttrition:     (params = {})    => api.get('/analytics/attrition', { params }),
  getDeptBreakdown: (params = {})    => api.get('/analytics/dept-workforce', { params }),

  // Revenue & Sales — GET /api/analytics/revenue|sales|ceo/kpis
  getRevenueTrend:  (params = {})    => api.get('/analytics/revenue', { params }),
  getCEOKPIs:       ()               => api.get('/analytics/ceo/kpis'),

  // Timesheets — GET /api/timesheets/timesheets/utilization/:employee_id
  getUtilization:   (employeeId, params = {}) =>
    api.get(`/timesheets/timesheets/utilization/${employeeId}`, { params }),
};

export default analyticsService;
