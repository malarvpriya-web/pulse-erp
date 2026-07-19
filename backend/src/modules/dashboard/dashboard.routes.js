import express from "express";
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
  getDashboardOperations,
  getFinanceDashboard,
  getDashboardHires,
  getDashboardLeaveSummary,
  getDashboardSummary,
  getTopCustomers,
  getTopVendors,
  getHeadcountTrend,
  getLiveKPIs,
  getDashboardProjectHealth,
  getDashboardCelebrations,
  getDashboardManufacturing,
  getCFODashboard,
  getCelebrationsToday,
  getCelebrationWishes,
  postCelebrationWish,
} from "./dashboard.controller.js";

const router = express.Router();

// Cache-Control for authenticated dashboard reads.
// live-kpis gets a short window; all other aggregations get 60s.
// Keyed to the authenticated user (private) so CDNs never share data across tenants.
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  // Wishes must reflect a just-sent reaction instantly — never cache
  if (req.path === '/celebration-wishes') {
    res.set('Cache-Control', 'no-store');
    return next();
  }
  const ttl = req.path === '/live-kpis' ? 15 : 60;
  res.set('Cache-Control', `private, max-age=${ttl}`);
  next();
});

router.get("/data",       getDashboardData);
router.get("/insights",   getDashboardInsights);
router.get("/revenue",    getDashboardRevenue);
router.get("/expenses",   getDashboardExpenses);
router.get("/workforce",  getDashboardWorkforce);
router.get("/approvals",  getDashboardApprovals);
router.get("/activity",   getDashboardActivity);
router.get("/alerts",     getDashboardAlerts);
router.get("/cash",       getDashboardCashPosition);
router.get("/sales",      getDashboardSalesPipeline);
router.get("/operations", getDashboardOperations);
router.get("/finance",          getFinanceDashboard);
router.get("/hires",            getDashboardHires);
router.get("/leave-summary",    getDashboardLeaveSummary);
router.get("/summary",          getDashboardSummary);
router.get("/top-customers",    getTopCustomers);
router.get("/top-vendors",      getTopVendors);
router.get("/headcount-trend",  getHeadcountTrend);
router.get("/live-kpis",        getLiveKPIs);
router.get("/project-health",   getDashboardProjectHealth);
router.get("/celebrations",     getDashboardCelebrations);
router.get("/celebrations-today",   getCelebrationsToday);
router.get("/celebration-wishes",   getCelebrationWishes);
router.post("/celebration-wishes",  postCelebrationWish);
router.get("/manufacturing",    getDashboardManufacturing);
router.get("/cfo",             getCFODashboard);

export default router;