import api from '@/services/api/client';

// ── Projects ───────────────────────────────────────────────────────────────

export const getProjects = async (params = {}) => {
  try {
    const res = await api.get('/projects/projects', { params });
    return res.data?.projects || res.data || [];
  } catch (err) {
    console.error('getProjects failed:', err.message);
    return [];
  }
};

export const getProject = async (id) => {
  try {
    const res = await api.get(`/projects/projects/${id}`);
    return res.data?.project || res.data || null;
  } catch (err) {
    console.error('getProject failed:', err.message);
    return null;
  }
};

export const createProject = async (data) => {
  const res = await api.post('/projects/projects', data);
  return res.data;
};

export const updateProject = async (id, data) => {
  const res = await api.put(`/projects/projects/${id}`, data);
  return res.data;
};

export const deleteProject = async (id) => {
  const res = await api.delete(`/projects/projects/${id}`);
  return res.data;
};

// ── Tasks ──────────────────────────────────────────────────────────────────

export const getTasks = async (params = {}) => {
  try {
    const res = await api.get('/projects/tasks', { params });
    return res.data?.tasks || res.data || [];
  } catch (err) {
    console.error('getTasks failed:', err.message);
    return [];
  }
};

export const createTask = async (data) => {
  const res = await api.post('/projects/tasks', data);
  return res.data;
};

export const updateTask = async (id, data) => {
  const res = await api.put(`/projects/tasks/${id}`, data);
  return res.data;
};

export const deleteTask = async (id) => {
  const res = await api.delete(`/projects/tasks/${id}`);
  return res.data;
};

// ── Costing ────────────────────────────────────────────────────────────────

export const getProjectCosting = async (projectId) => {
  try {
    const res = await api.get(`/projects/projects/${projectId}/costing`);
    return res.data || {};
  } catch (err) {
    console.error('getProjectCosting failed:', err.message);
    return {};
  }
};
