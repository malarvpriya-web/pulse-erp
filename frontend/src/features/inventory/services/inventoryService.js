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

// ── Categories (component category master) ──────────────────────────────────

export const getCategories = async (params = {}) => {
  try {
    const res = await api.get('/inventory/catalog/categories', { params });
    return res.data?.categories || res.data || [];
  } catch (err) {
    console.error('getCategories failed:', err.message);
    return [];
  }
};

export const createCategory = async (data) => {
  const res = await api.post('/inventory/catalog/categories', data);
  return res.data;
};

export const updateCategory = async (id, data) => {
  const res = await api.put(`/inventory/catalog/categories/${id}`, data);
  return res.data;
};

export const deleteCategory = async (id) => {
  const res = await api.delete(`/inventory/catalog/categories/${id}`);
  return res.data;
};

// ── Vendor prices (component × vendor × store) ──────────────────────────────

export const getItemVendorPrices = async (itemId, params = {}) => {
  try {
    const res = await api.get(`/inventory/catalog/items/${itemId}/vendor-prices`, { params });
    return res.data?.prices || res.data || [];
  } catch (err) {
    console.error('getItemVendorPrices failed:', err.message);
    return [];
  }
};

export const createItemVendorPrice = async (itemId, data) => {
  const res = await api.post(`/inventory/catalog/items/${itemId}/vendor-prices`, data);
  return res.data;
};

export const updateItemVendorPrice = async (id, data) => {
  const res = await api.put(`/inventory/catalog/vendor-prices/${id}`, data);
  return res.data;
};

export const deleteItemVendorPrice = async (id) => {
  const res = await api.delete(`/inventory/catalog/vendor-prices/${id}`);
  return res.data;
};

export const getVendorPriceComparison = async (params = {}) => {
  try {
    const res = await api.get('/inventory/catalog/vendor-price-comparison', { params });
    return res.data || {};
  } catch (err) {
    console.error('getVendorPriceComparison failed:', err.message);
    return {};
  }
};

// ── Batch Tracking ────────────────────────────────────────────────────────

export const getBatches = async (params = {}) => {
  try {
    const res = await api.get('/inventory/advanced/batches', { params });
    return res.data?.batches || res.data || [];
  } catch (err) {
    console.error('getBatches failed:', err.message);
    return [];
  }
};

export const createBatch = async (data) => {
  const res = await api.post('/inventory/advanced/batches', data);
  return res.data;
};

// ── Reservations ──────────────────────────────────────────────────────────

export const getReservations = async (params = {}) => {
  try {
    const res = await api.get('/inventory/advanced/reservations', { params });
    return res.data?.reservations || res.data || [];
  } catch (err) {
    console.error('getReservations failed:', err.message);
    return [];
  }
};

export const createReservation = async (data) => {
  const res = await api.post('/inventory/advanced/reservations', data);
  return res.data;
};
