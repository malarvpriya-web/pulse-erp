import express from 'express';
import orgChartRepository from '../repositories/orgchart.repository.js';

const router = express.Router();

router.get('/hierarchy', async (req, res) => {
  try {
    const hierarchy = await orgChartRepository.getHierarchy();
    res.json(hierarchy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/tree', async (req, res) => {
  try {
    const tree = await orgChartRepository.buildTree();
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/department/:department', async (req, res) => {
  try {
    const employees = await orgChartRepository.getByDepartment(req.params.department);
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/direct-reports/:manager_id', async (req, res) => {
  try {
    const reports = await orgChartRepository.getDirectReports(req.params.manager_id);
    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/relationship', async (req, res) => {
  try {
    const relationship = await orgChartRepository.upsert(req.body);
    res.json(relationship);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
