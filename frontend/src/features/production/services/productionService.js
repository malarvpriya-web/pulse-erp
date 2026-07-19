import api from '@/services/api/client';

export const getProductionOrders = () =>
  api.get('/production/orders').then(r => r.data);

export const getProductionOrder = (id) =>
  api.get(`/production/orders/${id}`).then(r => r.data);

export const createProductionOrder = (data) =>
  api.post('/production/orders', data).then(r => r.data);

export const updateProductionOrder = (id, data) =>
  api.put(`/production/orders/${id}`, data).then(r => r.data);

export const deleteProductionOrder = (id) =>
  api.delete(`/production/orders/${id}`).then(r => r.data);

export const releaseOrder = (id) =>
  api.post(`/production/orders/${id}/release`).then(r => r.data);

export const getBOMs = () =>
  api.get('/bom/bom').then(r => r.data);

// Operations
export const startOperation = (id, data) =>
  api.post(`/production/operations/${id}/start`, data).then(r => r.data);

export const completeOperation = (id, data) =>
  api.post(`/production/operations/${id}/complete`, data).then(r => r.data);

export const holdOperation = (id, data) =>
  api.post(`/production/operations/${id}/hold`, data).then(r => r.data);

// Order lifecycle
export const cancelOrder = (id, data) =>
  api.post(`/production/orders/${id}/cancel`, data).then(r => r.data);

export const holdOrder = (id, data) =>
  api.post(`/production/orders/${id}/hold`, data).then(r => r.data);

export const resumeOrder = (id, data) =>
  api.post(`/production/orders/${id}/resume`, data).then(r => r.data);

// Material flows
export const reserveMaterials = (id) =>
  api.post(`/production/orders/${id}/reserve-materials`).then(r => r.data);

export const issueMaterial = (id, data) =>
  api.post(`/production/orders/${id}/issue-material`, data).then(r => r.data);

export const recordScrap = (id, data) =>
  api.post(`/production/orders/${id}/scrap`, data).then(r => r.data);

// Shop floor & WIP
export const getWIPSummary = () =>
  api.get('/production/wip-summary').then(r => r.data);

export const getShopFloor = (params) =>
  api.get('/production/shop-floor', { params }).then(r => r.data);

// Test historian
export const getTestRuns = (productionOrderId) =>
  api.get('/engineering/tests/runs', { params: { production_order_id: productionOrderId } }).then(r => r.data);

export const createTestRun = (data) =>
  api.post('/engineering/tests/runs', data).then(r => r.data);

export const getTestRun = (id) =>
  api.get(`/engineering/tests/runs/${id}`).then(r => r.data);

export const addMeasurement = (runId, data) =>
  api.post(`/engineering/tests/runs/${runId}/measurements`, data).then(r => r.data);

export const completeTestRun = (runId, data) =>
  api.post(`/engineering/tests/runs/${runId}/complete`, data).then(r => r.data);

export const getComplianceScore = (runId) =>
  api.get(`/engineering/tests/runs/${runId}/compliance-score`).then(r => r.data);

export const downloadCertificate = async (runId, runNumber, testStage) => {
  const res = await api.get(`/engineering/tests/runs/${runId}/certificate`, { responseType: 'blob' });
  const url  = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href     = url;
  link.download = `${testStage || 'FAT'}-${runNumber || runId}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
};
