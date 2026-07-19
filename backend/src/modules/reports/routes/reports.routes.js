import express from 'express';
import pool from '../../shared/db.js';
import reportsRepository from '../repositories/reports.repository.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => req.scope?.company_id ?? companyOf(req);

/* ensure saved_reports table exists */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS saved_reports (
        id           SERIAL PRIMARY KEY,
        report_name  VARCHAR(255) NOT NULL,
        module_name  VARCHAR(100),
        report_type  VARCHAR(50),
        filters_json JSONB,
        columns_json JSONB,
        created_by   INTEGER,
        is_public    BOOLEAN DEFAULT false,
        deleted_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error('[reports] saved_reports table init failed:', e.message);
  }
})();

// Saved Reports
router.get('/saved', async (req, res) => {
  try {
    const reports = await reportsRepository.findSavedReports(
      req.user?.userId ?? req.user?.id,
      cid(req)
    );
    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/saved', async (req, res) => {
  try {
    const report = await reportsRepository.createSavedReport({
      ...req.body,
      created_by: req.user?.userId ?? req.user?.id,
      company_id: cid(req),
    });
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
    const data = await reportsRepository.getAttendanceReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave', async (req, res) => {
  try {
    const data = await reportsRepository.getLeaveReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave/summary', async (req, res) => {
  try {
    const data = await reportsRepository.getLeaveSummaryReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave/liability', async (req, res) => {
  try {
    const data = await reportsRepository.getLeaveLiabilityReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave/lop', async (req, res) => {
  try {
    const data = await reportsRepository.getLOPReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave/department', async (req, res) => {
  try {
    const data = await reportsRepository.getDepartmentLeaveReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leave/approval-performance', async (req, res) => {
  try {
    const data = await reportsRepository.getApprovalPerformanceReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sales', async (req, res) => {
  try {
    const data = await reportsRepository.getSalesReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock', async (req, res) => {
  try {
    const data = await reportsRepository.getStockReport(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/project-cost', async (req, res) => {
  try {
    const data = await reportsRepository.getProjectCostReport(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/headcount', async (req, res) => {
  try {
    const data = await reportsRepository.getHeadcountReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/payroll-summary', async (req, res) => {
  try {
    const data = await reportsRepository.getPayrollSummaryReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sales-targets', async (req, res) => {
  try {
    const data = await reportsRepository.getSalesTargetsReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/outstanding-invoices', async (req, res) => {
  try {
    const data = await reportsRepository.getOutstandingInvoicesReport(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/expense-report', async (req, res) => {
  try {
    const data = await reportsRepository.getExpenseReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/gst-report', async (req, res) => {
  try {
    const data = await reportsRepository.getGSTReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/purchase-orders', async (req, res) => {
  try {
    const data = await reportsRepository.getPurchaseOrdersReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/vendor-performance', async (req, res) => {
  try {
    const data = await reportsRepository.getVendorPerformanceReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/pending-pos', async (req, res) => {
  try {
    const data = await reportsRepository.getPendingPOsReport(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stock-movement', async (req, res) => {
  try {
    const data = await reportsRepository.getStockMovementReport({ ...req.query, company_id: cid(req) });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/low-stock', async (req, res) => {
  try {
    const data = await reportsRepository.getLowStockReport(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

