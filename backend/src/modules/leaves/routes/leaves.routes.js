import express from 'express';
import leavesRepository from '../repositories/leaves.repository.js';

const router = express.Router();

// Leave Types
router.get('/types', async (req, res) => {
  try {
    const types = await leavesRepository.getLeaveTypes();
    res.json(types);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Leave Balance
router.get('/balance/:employee_id', async (req, res) => {
  try {
    const { year } = req.query;
    const balance = await leavesRepository.getLeaveBalance(req.params.employee_id, year);
    res.json(balance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/balance/initialize', async (req, res) => {
  try {
    const { employee_id, year } = req.body;
    await leavesRepository.initializeLeaveBalance(employee_id, year || new Date().getFullYear());
    res.json({ message: 'Leave balance initialized' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Leave Applications
router.get('/applications', async (req, res) => {
  try {
    const applications = await leavesRepository.findApplications(req.query);
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/applications/:id', async (req, res) => {
  try {
    const application = await leavesRepository.findById(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/apply', async (req, res) => {
  try {
    const application = await leavesRepository.applyLeave(req.body);
    res.status(201).json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manager Approval
router.post('/approve/manager/:id', async (req, res) => {
  try {
    const { manager_id, comments } = req.body;
    const application = await leavesRepository.approveByManager(req.params.id, manager_id, comments);
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reject/manager/:id', async (req, res) => {
  try {
    const { manager_id, comments } = req.body;
    const application = await leavesRepository.rejectByManager(req.params.id, manager_id, comments);
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HR Approval
router.post('/approve/hr/:id', async (req, res) => {
  try {
    const { hr_id, comments } = req.body;
    const application = await leavesRepository.approveByHR(req.params.id, hr_id, comments);
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reject/hr/:id', async (req, res) => {
  try {
    const { hr_id, comments } = req.body;
    const application = await leavesRepository.rejectByHR(req.params.id, hr_id, comments);
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Calendar & Analytics
router.get('/calendar', async (req, res) => {
  try {
    const calendar = await leavesRepository.getLeaveCalendar(req.query);
    res.json(calendar);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics', async (req, res) => {
  try {
    const analytics = await leavesRepository.getLeaveAnalytics(req.query);
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
