import express from 'express';
import { verifyToken } from '../../middlewares/auth.middleware.js';
import { 
  payrollTrends, 
  departmentCosts, 
  anomalyFlags,
  cashflowForecast,
  erpQuery 
} from './aiPayroll.controller.js';

const router = express.Router();

// ── Validation middleware ───────────────────────────────────────────────────
const validateTrends = (req, res, next) => {
  const months = parseInt(req.query.months);
  if (req.query.months !== undefined && (isNaN(months) || months < 1 || months > 24)) {
    return res.status(400).json({ success: false, message: 'months must be an integer between 1 and 24' });
  }
  next();
};

const validateAnomalies = (req, res, next) => {
  const threshold = parseFloat(req.query.threshold);
  if (req.query.threshold !== undefined && (isNaN(threshold) || threshold < 0 || threshold > 1)) {
    return res.status(400).json({ success: false, message: 'threshold must be a number between 0 and 1' });
  }
  next();
};

router.get('/payroll/trends',      verifyToken, validateTrends,    payrollTrends);
router.get('/payroll/departments',  verifyToken,                    departmentCosts);
router.get('/payroll/anomalies',    verifyToken, validateAnomalies, anomalyFlags);
router.get('/cashflow/forecast',    verifyToken,                    cashflowForecast);
router.post('/query',               verifyToken,                    erpQuery);

export default router;
