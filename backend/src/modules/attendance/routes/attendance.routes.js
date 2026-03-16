import express from 'express';
import attendanceRepository from '../repositories/attendance.repository.js';

const router = express.Router();

router.post('/mark', async (req, res) => {
  try {
    const attendance = await attendanceRepository.markAttendance(req.body);
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/employee/:employee_id', async (req, res) => {
  try {
    const records = await attendanceRepository.findByEmployee(req.params.employee_id, req.query);
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/date/:date', async (req, res) => {
  try {
    const records = await attendanceRepository.findByDate(req.params.date, req.query);
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/summary/:employee_id', async (req, res) => {
  try {
    const { month, year } = req.query;
    const summary = await attendanceRepository.getEmployeeSummary(
      req.params.employee_id,
      month || new Date().getMonth() + 1,
      year || new Date().getFullYear()
    );
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/team/:manager_id', async (req, res) => {
  try {
    const { date } = req.query;
    const team = await attendanceRepository.getTeamSummary(
      req.params.manager_id,
      date || new Date().toISOString().split('T')[0]
    );
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/late-arrivals', async (req, res) => {
  try {
    const lateArrivals = await attendanceRepository.getLateArrivals(req.query);
    res.json(lateArrivals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/trend/:employee_id', async (req, res) => {
  try {
    const { year } = req.query;
    const trend = await attendanceRepository.getMonthlyTrend(
      req.params.employee_id,
      year || new Date().getFullYear()
    );
    res.json(trend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
