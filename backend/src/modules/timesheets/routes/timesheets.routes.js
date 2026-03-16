import express from 'express';
import timesheetRepository from '../repositories/timesheet.repository.js';
import projectCostRepository from '../../projects/repositories/projectCost.repository.js';

const router = express.Router();

router.get('/timesheets', async (req, res) => {
  try {
    const timesheets = await timesheetRepository.findAll(req.query);
    res.json(timesheets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/:id', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.findById(req.params.id);
    if (!timesheet) return res.status(404).json({ error: 'Timesheet not found' });
    res.json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.create(req.body);
    res.status(201).json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/timesheets/:id', async (req, res) => {
  try {
    const timesheet = await timesheetRepository.update(req.params.id, req.body);
    res.json(timesheet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/timesheets/:id', async (req, res) => {
  try {
    await timesheetRepository.delete(req.params.id);
    res.json({ message: 'Timesheet deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/submit-week', async (req, res) => {
  try {
    const { employee_id, week_start, week_end } = req.body;
    await timesheetRepository.submitWeek(employee_id, week_start, week_end);
    res.json({ message: 'Week submitted for approval' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/approve', async (req, res) => {
  try {
    const { ids, approved_by } = req.body;
    await timesheetRepository.approveEntries(ids, approved_by);
    
    // Update project labour costs
    const entries = await timesheetRepository.findAll({ status: 'approved' });
    const projectIds = [...new Set(entries.map(e => e.project_id))];
    for (const projectId of projectIds) {
      await projectCostRepository.updateLabourCost(projectId);
    }
    
    res.json({ message: 'Timesheets approved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/timesheets/reject', async (req, res) => {
  try {
    const { ids, approved_by, reason } = req.body;
    await timesheetRepository.rejectEntries(ids, approved_by, reason);
    res.json({ message: 'Timesheets rejected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/summary/weekly', async (req, res) => {
  try {
    const { employee_id, week_start, week_end } = req.query;
    const summary = await timesheetRepository.getWeeklySummary(employee_id, week_start, week_end);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/utilization/:employee_id', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const utilization = await timesheetRepository.getUtilization(req.params.employee_id, start_date, end_date);
    res.json(utilization);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/timesheets/pending-approvals/:manager_id', async (req, res) => {
  try {
    const pending = await timesheetRepository.getPendingApprovals(req.params.manager_id);
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

