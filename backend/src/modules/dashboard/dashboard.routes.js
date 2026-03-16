import express from "express";
import { getFinanceDashboard } from "./dashboard.controller.js";
import {
  getDashboardData,
  getDashboardInsights,
  getDashboardRevenue,
  getDashboardExpenses,
  getDashboardWorkforce,
  getDashboardApprovals,
  getDashboardActivity,
  getDashboardAlerts,
  getDashboardCashPosition,
  getDashboardSalesPipeline,
} from "./dashboard.controller.js";

const router = express.Router();

router.get("/data",      getDashboardData);
router.get("/insights",  getDashboardInsights);
router.get("/revenue",   getDashboardRevenue);
router.get("/expenses",  getDashboardExpenses);
router.get("/workforce", getDashboardWorkforce);
router.get("/approvals", getDashboardApprovals);
router.get("/activity",  getDashboardActivity);
router.get("/alerts",    getDashboardAlerts);
router.get("/cash",      getDashboardCashPosition);
router.get("/sales",     getDashboardSalesPipeline);

router.get("/finance", getFinanceDashboard);
export default router;