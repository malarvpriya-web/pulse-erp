import express from 'express';
import reportsRepository from '../repositories/reports.repository.js';

const router = express.Router();

// Saved Reports
router.get('/saved', async (req, res) => {
  try {
    const reports = await reportsRepository.findSavedReports(req.user?.id);
    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/saved', async (req, res) => {
  try {
    const report = await reportsRepository.createSavedReport({ ...req.body, created_by: req.user?.id });
    res.status(201).json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    await reportsRepository.deleteSavedReport(req.params.id);
    res.json({ message: 'Report deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prebuilt Reports
router.get('/attendance', async (req, res) => {
  try {
    const data = await reportsRepository.getAttendanceReport(req.query);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave', async (req, res) => {
  try {
    const data = await reportsRepository.getLeaveReport(req.query);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sales', async (req, res) => {
  try {
    const data = await reportsRepository.getSalesReport(req.query);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock', async (req, res) => {
  try {
    const data = await reportsRepository.getStockReport();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/project-cost', async (req, res) => {
  try {
    const data = await reportsRepository.getProjectCostReport();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

