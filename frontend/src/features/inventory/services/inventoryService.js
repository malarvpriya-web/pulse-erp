import api from '@/services/api/client';

// ── Dashboard ──────────────────────────────────────────────────────────────

export const getInventoryDashboard = async () => {
  try {
    const res = await api.get('/inventory/dashboard');
    return res.data || {};
  } catch (err) {
    console.error('getInventoryDashboard failed:', err.message);
    return {};
  }
};

// ── Stock ──────────────────────────────────────────────────────────────────

export const getStockSummary = async (params = {}) => {
  try {
    const res = await api.get('/inventory/stock/summary', { params });
    return res.data?.items || res.data || [];
  } catch (err) {
    console.error('getStockSummary failed:', err.message);
    return [];
  }
};

export const getLowStock = async () => {
  try {
    const res = await api.get('/inventory/stock/low-stock');
    return res.data?.items || res.data || [];
  } catch (err) {
    console.error('getLowStock failed:', err.message);
    return [];
  }
};

export const getStockMovements = async (params = {}) => {
  try {
    const res = await api.get('/inventory/stock/movement', { params });
    return res.data?.movements || res.data || [];
  } catch (err) {
    console.error('getStockMovements failed:', err.message);
    return [];
  }
};

export const createStockMovement = async (data) => {
  const res = await api.post('/inventory/stock/movement', data);
  return res.data;
};

// ── Items ──────────────────────────────────────────────────────────────────

export const getItems = async (params = {}) => {
  try {
    const res = await api.get('/inventory/items', { params });
    return res.data?.items || res.data || [];
  } catch (err) {
    console.error('getItems failed:', err.message);
    return [];
  }
};

export const createItem = async (data) => {
  const res = await api.post('/inventory/items', data);
  return res.data;
};

export const updateItem = async (id, data) => {
  const res = await api.put(`/inventory/items/${id}`, data);
  return res.data;
};

export const deleteItem = async (id) => {
  const res = await api.delete(`/inventory/items/${id}`);
  return res.data;
};

// ── Batch Tracking ────────────────────────────────────────────────────────

export const getBatches = async (params = {}) => {
  try {
    const res = await api.get('/inventory/batches', { params });
    return res.data?.batches || res.data || [];
  } catch (err) {
    console.error('getBatches failed:', err.message);
    return [];
  }
};

export const createBatch = async (data) => {
  const res = await api.post('/inventory/batches', data);
  return res.data;
};

// ── Reservations ──────────────────────────────────────────────────────────

export const getReservations = async (params = {}) => {
  try {
    const res = await api.get('/inventory/reservations', { params });
    return res.data?.reservations || res.data || [];
  } catch (err) {
    console.error('getReservations failed:', err.message);
    return [];
  }
};

export const createReservation = async (data) => {
  const res = await api.post('/inventory/reservations', data);
  return res.data;
};

export const updateReservation = async (id, data) => {
  const res = await api.put(`/inventory/reservations/${id}`, data);
  return res.data;
};
