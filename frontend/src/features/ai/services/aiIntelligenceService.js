import api from '@/services/api/client';

export const aiIntelligenceService = {
  async queryERP(query) {
    const { data } = await api.post('/ai/query', { query });
    return data;
  },

  async getCashFlowForecast(days = 30) {
    const { data } = await api.get(`/ai/cashflow/forecast?days=${days}`);
    return data;
  },

  async getAttritionPrediction() {
    const { data } = await api.get('/ai/predict/attrition');
    return data;
  },

  async getSalesForecast(days = 30) {
    const { data } = await api.get(`/ai/predict/sales?days=${days}`);
    return data;
  },

  async getInventoryDemand() {
    const { data } = await api.get('/ai/predict/inventory');
    return data;
  },

  async getAnomalies() {
    const { data } = await api.get('/ai/anomalies');
    return data;
  },

  async getPrescriptiveRecommendations() {
    const { data } = await api.get('/ai/prescriptive');
    return data;
  },
};
