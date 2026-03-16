import express from 'express';
import projectRepository from '../repositories/project.repository.js';
import taskRepository from '../repositories/task.repository.js';
import projectCostRepository from '../repositories/projectCost.repository.js';

const router = express.Router();

// Projects
router.get('/projects', async (req, res) => {
  try {
    const projects = await projectRepository.findAll(req.query);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/projects/dashboard', async (req, res) => {
  try {
    const dashboard = await projectRepository.getDashboard();
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/projects/next-code', async (req, res) => {
  try {
    const code = await projectRepository.getNextProjectCode();
    res.json({ code });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/projects/:id', async (req, res) => {
  try {
    const project = await projectRepository.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/projects', async (req, res) => {
  try {
    const project = await projectRepository.create({ ...req.body, created_by: req.user?.id });
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/projects/:id', async (req, res) => {
  try {
    const project = await projectRepository.update(req.params.id, req.body);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    await projectRepository.delete(req.params.id);
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tasks
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await taskRepository.findAll(req.query);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks/overdue', async (req, res) => {
  try {
    const tasks = await taskRepository.getOverdueTasks();
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks/kanban/:project_id', async (req, res) => {
  try {
    const board = await taskRepository.getKanbanBoard(req.params.project_id);
    res.json(board);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks/:id', async (req, res) => {
  try {
    const task = await taskRepository.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const task = await taskRepository.create({ ...req.body, created_by: req.user?.id });
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    const task = await taskRepository.update(req.params.id, req.body);
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await taskRepository.delete(req.params.id);
    res.json({ message: 'Task deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Project Costs
router.get('/projects/:id/costs', async (req, res) => {
  try {
    const costs = await projectCostRepository.findByProject(req.params.id);
    res.json(costs || { labour_cost: 0, material_cost: 0, expense_cost: 0, total_cost: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/projects/:id/costs', async (req, res) => {
  try {
    const costs = await projectCostRepository.upsert(req.params.id, req.body);
    res.json(costs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/projects/analytics/profitability', async (req, res) => {
  try {
    const data = await projectCostRepository.getProjectProfitability();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
