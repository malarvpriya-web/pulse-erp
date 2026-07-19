import api from '@/services/api/client';

// ── Projects ───────────────────────────────────────────────────────────────
export const getProjects = async (params = {}) => {
  const res = await api.get('/projects/projects', { params });
  return res.data?.projects || res.data || [];
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

export const getProjectDashboard = async () => {
  const res = await api.get('/projects/projects/dashboard');
  return res.data || {};
};

export const getNextProjectCode = async () => {
  const res = await api.get('/projects/projects/next-code');
  return res.data?.code || '';
};

export const getProjectEmployees = async () => {
  const res = await api.get('/projects/employees');
  return res.data || [];
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

export const getKanbanBoard = async (project_id) => {
  const res = await api.get(`/projects/tasks/kanban/${project_id}`);
  return res.data || { todo: [], in_progress: [], review: [], done: [] };
};

// ── Costing — FIXED: was /costing, now also has /costs alias ─────────────
export const getProjectCosting = async (projectId) => {
  try {
    const res = await api.get(`/projects/projects/${projectId}/costs`);
    return res.data || {};
  } catch (err) {
    console.error('getProjectCosting failed:', err.message);
    return {};
  }
};

export const recalculateProjectCost = async (projectId) => {
  const res = await api.post(`/projects/projects/${projectId}/costs/recalculate`);
  return res.data;
};

export const getProjectProfitability = async () => {
  const res = await api.get('/projects/projects/analytics/profitability');
  return res.data || [];
};

// ── Budget Lines ───────────────────────────────────────────────────────────
export const getBudgetLines = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/budget-lines`);
  return res.data || [];
};

export const createBudgetLine = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/budget-lines`, data);
  return res.data;
};

export const updateBudgetLine = async (id, data) => {
  const res = await api.put(`/projects/projects/budget-lines/${id}`, data);
  return res.data;
};

export const deleteBudgetLine = async (id) => {
  const res = await api.delete(`/projects/projects/budget-lines/${id}`);
  return res.data;
};

// ── Members ────────────────────────────────────────────────────────────────
export const getProjectMembers = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/members`);
  return res.data?.members || res.data || [];
};

export const addProjectMember = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/resources`, data);
  return res.data;
};

export const removeProjectMember = async (projectId, employeeId) => {
  const res = await api.delete(`/projects/projects/${projectId}/resources/${employeeId}`);
  return res.data;
};

// ── Milestones ─────────────────────────────────────────────────────────────
export const getProjectMilestones = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/milestones`);
  return res.data || [];
};

export const createProjectMilestone = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/milestones`, data);
  return res.data;
};

export const updateProjectMilestone = async (id, data) => {
  const res = await api.put(`/projects/projects/milestones/${id}`, data);
  return res.data;
};

export const completeProjectMilestone = async (milestoneId) => {
  const res = await api.put(`/projects/projects/milestones/${milestoneId}/complete`);
  return res.data;
};

export const deleteProjectMilestone = async (id) => {
  const res = await api.delete(`/projects/projects/milestones/${id}`);
  return res.data;
};

// ── Risks ──────────────────────────────────────────────────────────────────
export const getProjectRisks = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/risks`);
  return res.data || [];
};

export const createProjectRisk = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/risks`, data);
  return res.data;
};

export const updateProjectRisk = async (id, data) => {
  const res = await api.put(`/projects/projects/risks/${id}`, data);
  return res.data;
};

export const deleteProjectRisk = async (id) => {
  const res = await api.delete(`/projects/projects/risks/${id}`);
  return res.data;
};

// ── Issues ─────────────────────────────────────────────────────────────────
export const getProjectIssues = async (projectId, params = {}) => {
  const res = await api.get(`/projects/projects/${projectId}/issues`, { params });
  return res.data || [];
};

export const createProjectIssue = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/issues`, data);
  return res.data;
};

export const updateProjectIssue = async (id, data) => {
  const res = await api.put(`/projects/projects/issues/${id}`, data);
  return res.data;
};

export const deleteProjectIssue = async (id) => {
  const res = await api.delete(`/projects/projects/issues/${id}`);
  return res.data;
};

// ── FAT Tracker ────────────────────────────────────────────────────────────
export const getProjectFAT = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/fat`);
  return res.data || [];
};

export const createFATRecord = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/fat`, data);
  return res.data;
};

export const updateFATRecord = async (id, data) => {
  const res = await api.put(`/projects/projects/fat/${id}`, data);
  return res.data;
};

// ── SAT Tracker ────────────────────────────────────────────────────────────
export const getProjectSAT = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/sat`);
  return res.data || [];
};

export const createSATRecord = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/sat`, data);
  return res.data;
};

export const updateSATRecord = async (id, data) => {
  const res = await api.put(`/projects/projects/sat/${id}`, data);
  return res.data;
};

// ── Warranties ─────────────────────────────────────────────────────────────
export const getProjectWarranties = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/warranties`);
  return res.data || [];
};

export const createProjectWarranty = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/warranties`, data);
  return res.data;
};

// ── Documents ──────────────────────────────────────────────────────────────
export const getProjectDocuments = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/documents`);
  return res.data || [];
};

export const uploadProjectDocument = async (projectId, data) => {
  const res = await api.post(`/projects/projects/${projectId}/documents`, data);
  return res.data;
};

export const deleteProjectDocument = async (id) => {
  const res = await api.delete(`/projects/projects/documents/${id}`);
  return res.data;
};

// ── Timesheets ─────────────────────────────────────────────────────────────
export const getProjectTimesheets = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/timesheets`);
  return res.data || { entries: [], summary: {} };
};

// ── Invoices ───────────────────────────────────────────────────────────────
export const getProjectInvoices = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/invoices`);
  return res.data || [];
};

// ── Capacity ───────────────────────────────────────────────────────────────
export const getCapacityOverview = async (params = {}) => {
  const res = await api.get('/projects/capacity/overview', { params });
  return res.data || [];
};

// ── S-Curve ────────────────────────────────────────────────────────────────
export const getProjectScurve = async (projectId) => {
  const res = await api.get(`/projects/projects/${projectId}/scurve`);
  return res.data || [];
};

// ── Settings ───────────────────────────────────────────────────────────────
export const getProjectSettings = async () => {
  const res = await api.get('/projects/settings');
  return res.data || {};
};

export const saveProjectSettings = async (data) => {
  const res = await api.put('/projects/settings', data);
  return res.data;
};

// ── Gantt ──────────────────────────────────────────────────────────────────
export const getGanttTasks = async (projectId) => {
  const res = await api.get('/gantt/tasks', { params: { project_id: projectId } });
  return res.data || [];
};

export const createGanttTask = async (data) => {
  const res = await api.post('/gantt/tasks', data);
  return res.data;
};

export const updateGanttTask = async (id, data) => {
  const res = await api.put(`/gantt/tasks/${id}`, data);
  return res.data;
};

export const deleteGanttTask = async (id) => {
  const res = await api.delete(`/gantt/tasks/${id}`);
  return res.data;
};

export const getCriticalPath = async (projectId) => {
  const res = await api.get(`/gantt/critical-path/${projectId}`);
  return res.data || { tasks: [], critical_path_task_ids: [] };
};
