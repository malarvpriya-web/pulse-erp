import api from './client';

export const dashboardAPI = {
  getDashboardData: async () => {
    try {
      const res = await api.get('/dashboard/data');
      return res.data;
    } catch (err) {
      console.error('getDashboardData error:', err);
      return {};
    }
  },

  getDashboardInsights: async () => {
    try {
      const res = await api.get('/dashboard/insights');
      return res.data;
    } catch (err) {
      console.error('getDashboardInsights error:', err);
      return {};
    }
  },

  getRevenue: async () => {
    try {
      const res = await api.get('/dashboard/revenue');
      return res.data;
    } catch (err) {
      return {};
    }
  },

  getExpenses: async () => {
    try {
      const res = await api.get('/dashboard/expenses');
      return res.data;
    } catch (err) {
      return {};
    }
  },
};

export default dashboardAPI;