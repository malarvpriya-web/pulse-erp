import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { setupSwagger } from "./src/docs/swaggerSetup.js";
import pool from "./src/config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Core ─────────────────────────────────────────────────────────────────────
import employeeRoutes         from "./src/employees/employee.routes.js";
import authRoutes             from "./src/auth/auth.routes.js";
import homeRoutes             from "./src/home/home.routes.js";
import noteRoutes             from "./src/notes/note.routes.js";
import announcementRoutes     from "./src/announcements/announcement.routes.js";
import probationRoutes        from "./src/probation/probation.routes.js";

// ── Finance ──────────────────────────────────────────────────────────────────
import financeRoutes          from "./src/modules/finance/routes/finance.routes.js";
import extendedFinanceRoutes  from "./src/modules/finance/routes/extended.routes.js";
import accountingRoutes       from "./src/modules/finance/accounting.routes.js";
import gstRoutes              from "./src/modules/finance/gst.routes.js";
import tdsRoutes              from "./src/modules/finance/tds.routes.js";
import tcsRoutes              from "./src/modules/finance/tcs.routes.js";
import budgetRoutes           from "./src/modules/finance/budget.routes.js";
import assetsRoutes           from "./src/modules/finance/assets.routes.js";
import forexRoutes            from "./src/modules/finance/forex.routes.js";
import statementsRoutes       from "./src/modules/finance/statements.routes.js";
import creditNotesRoutes      from "./src/modules/finance/creditNotes.routes.js";
import debitNotesRoutes       from "./src/modules/finance/debitNotes.routes.js";
import costCentersRoutes      from "./src/modules/finance/costCenters.routes.js";

// ── Procurement & Inventory ──────────────────────────────────────────────────
import procurementRoutes      from "./src/modules/procurement/routes/procurement.routes.js";
import vendorRoutes           from "./src/modules/procurement/routes/vendor.routes.js";
import inventoryRoutes        from "./src/modules/inventory/routes/inventory.routes.js";
import warehouseRoutes        from "./src/modules/warehouse/warehouse.routes.js";
import logisticsRoutes        from "./src/modules/logistics/logistics.routes.js";
import serviceLevelRoutes    from "./src/modules/logistics/serviceLevel.routes.js";
import scmPlanningRoutes    from "./src/modules/logistics/scmPlanning.routes.js";
import qualityRoutes          from "./src/modules/quality/quality.routes.js";
import testHistorianRoutes    from "./src/modules/engineering/testHistorian.routes.js";

// ── Production ───────────────────────────────────────────────────────────────
import bomRoutes              from "./src/modules/production/bom.routes.js";
import productionExecutionRoutes from "./src/modules/production/execution.routes.js";
import imrRoutes              from "./src/modules/production/imr.routes.js";
import mrpRoutes              from "./src/modules/production/mrp.routes.js";
import crpRoutes              from "./src/modules/production/crp.routes.js";
import subcontractingRoutes   from "./src/modules/production/subcontracting.routes.js";
import genealogyRoutes         from "./src/modules/production/genealogy.routes.js";
import bomModelingRoutes        from "./src/modules/production/bomModeling.routes.js";
import sopRoutes                from "./src/modules/production/sop.routes.js";

// ── Projects ─────────────────────────────────────────────────────────────────
import projectRoutes          from "./src/modules/projects/routes/projects.routes.js";
import orderHistoryRoutes     from "./src/modules/projects/routes/orderHistory.routes.js";
import taskRoutes             from "./src/modules/projects/routes/tasks.routes.js";
import projectMembersRoutes   from "./src/modules/projects/project-members.routes.js";
import ganttRoutes            from "./src/modules/projects/gantt.routes.js";

// ── HR & Payroll ─────────────────────────────────────────────────────────────
import timesheetRoutes        from "./src/modules/timesheets/routes/timesheets.routes.js";
import performanceRoutes      from "./src/modules/performance/routes/performance.routes.js";
import perfCyclesRoutes      from "./src/modules/performance/routes/cycles.routes.js";
import perfKRARoutes         from "./src/modules/performance/routes/kra.routes.js";
import perfFeedback360Routes from "./src/modules/performance/routes/feedback360.routes.js";
import perfCalibRoutes       from "./src/modules/performance/routes/calibration.routes.js";
import perfIncRoutes         from "./src/modules/performance/routes/increments.routes.js";
import perfPromoRoutes       from "./src/modules/performance/routes/promotions.routes.js";
import perfReportsRoutes     from "./src/modules/performance/routes/reports.routes.js";
import perfOKRRoutes         from "./src/modules/performance/routes/okr.routes.js";
import recruitmentRoutes      from "./src/modules/recruitment/routes/recruitment.routes.js";
import talentRoutes           from "./src/modules/talent/talent.routes.js";
import leavesNewRoutes        from "./src/modules/leaves/routes/leaves.routes.js";
import compOffRoutes          from "./src/modules/leaves/routes/compoff.routes.js";
import encashmentRoutes       from "./src/modules/leaves/routes/encashment.routes.js";
import accrualRoutes          from "./src/modules/leaves/routes/accrual.routes.js";
import attendanceRoutes       from "./src/modules/attendance/routes/attendance.routes.js";
import offlineSyncRoutes      from "./src/modules/attendance/routes/offlineSync.routes.js";
import holidaysRoutes         from "./src/modules/holidays/routes/holidays.routes.js";
import payrollRoutes          from "./src/modules/payroll/payroll.routes.js";
import salaryRoutes           from "./src/modules/payroll/salaryStructure.routes.js";
import hrRoutes               from "./src/modules/hr/hr.routes.js";
import trainingRoutes         from "./src/modules/hr/training.routes.js";
import certificationsRoutes   from "./src/modules/hr/certifications.routes.js";
import learningPathsRoutes    from "./src/modules/hr/learning-paths.routes.js";
import assessmentsRoutes      from "./src/modules/hr/assessments.routes.js";
import trainersRoutes         from "./src/modules/hr/trainers.routes.js";
import lndReportingRoutes     from "./src/modules/hr/lnd-reporting.routes.js";
import competencyRoutes       from "./src/modules/hr/competency.routes.js";
import knowledgeRoutes        from "./src/modules/hr/knowledge.routes.js";
import journeyRoutes          from "./src/modules/crm/routes/journey.routes.js";
import dealRegistrationRoutes from "./src/modules/sales/routes/dealRegistration.routes.js";
import { ingestRouter as supportMailIngestRouter, adminRouter as supportMailAdminRouter }
  from "./src/modules/servicedesk/routes/emailToCase.routes.js";
import lndSettingsRoutes      from "./src/modules/hr/lnd-settings.routes.js";
import successionRoutes       from "./src/modules/hr/succession.routes.js";
import biometricRoutes        from "./src/modules/hr/biometric.routes.js";
import selfServiceRoutes      from "./src/modules/hr/selfservice.routes.js";
import exitRoutes             from "./src/modules/hr/exit.routes.js";
import employeeAssetsRoutes   from "./src/modules/hr/employee-assets.routes.js";
import employeeSkillsRoutes   from "./src/modules/hr/employee-skills.routes.js";
import hrMasterDataRoutes     from "./src/modules/hr/master-data.routes.js";
import hrWidgetsRoutes        from "./src/modules/hr/hr-widgets.routes.js";
import onboardingRoutes       from "./src/modules/hr/onboarding.routes.js";

// ── CRM & Sales ──────────────────────────────────────────────────────────────
import crmRoutes              from "./src/modules/crm/routes/index.js";
import { trackOpenRouter }    from "./src/modules/crm/routes/email.routes.js";
import { publicRouter as webLeadPublicRoutes } from "./src/modules/crm/routes/webToLead.routes.js";
import salesRoutes            from "./src/modules/sales/routes/sales.routes.js";
import salesPartnersRoutes    from "./src/modules/sales/routes/partners.routes.js";
import salesCommandCenterRoutes from "./src/modules/sales/routes/sales-command-center.routes.js";
import pricingRoutes          from "./src/modules/sales/routes/pricing.routes.js";
import commissionRoutes       from "./src/modules/sales/routes/commission.routes.js";
import salesForecastRoutes    from "./src/modules/sales/routes/forecast.routes.js";
import fulfilmentRoutes       from "./src/modules/sales/fulfilment.routes.js";
import marketingRoutes        from "./src/modules/marketing/routes/marketing.routes.js";

// ── Master Data ──────────────────────────────────────────────────────────────
import masterRoutes            from "./src/modules/master/master.routes.js";
import wizardRoutes            from "./src/modules/wizard/wizard.routes.js";

// ── Operations & Admin ───────────────────────────────────────────────────────
import operationsRoutes       from "./src/modules/operations/operations.routes.js";
import lifecycleRoutes       from "./src/modules/operations/lifecycle.routes.js";
import maintenanceRoutes      from "./src/modules/maintenance/maintenance.routes.js";
import iotIngestRoutes        from "./src/modules/iot/routes/ingest.routes.js";
import iotDevicesRoutes       from "./src/modules/iot/routes/devices.routes.js";
import iotAlertsRoutes        from "./src/modules/iot/routes/alerts.routes.js";
import iotOpsRoutes           from "./src/modules/iot/routes/ops.routes.js";
import complianceRoutes       from "./src/modules/compliance/compliance.routes.js";
import unifiedAssetsRoutes     from "./src/modules/assets/assets.routes.js";
import rdRoutes                from "./src/modules/rd/rd.routes.js";
import tenderRoutes            from "./src/modules/tenders/tenders.routes.js";
import workflowRoutes         from "./src/modules/admin/workflow.routes.js";
import securityRoutes         from "./src/modules/admin/security.routes.js";
import adminRoutes            from "./src/modules/admin/admin.routes.js";
import settingsStatusRoutes   from "./src/modules/admin/settings-status.routes.js";
import systemHealthRoutes      from "./src/modules/admin/systemHealth.routes.js";
import companyProfileRoutes   from "./src/modules/admin/companyProfile.routes.js";
import branchManagementRoutes from "./src/modules/admin/branchManagement.routes.js";
import travelRoutes              from "./src/modules/travel/travel.routes.js";
import customerVisitsRoutes      from "./src/modules/travel/customer-visits.routes.js";
import travelReimbursementRoutes from "./src/modules/travel/travel-reimbursement.routes.js";
import travelPolicyRoutes        from "./src/modules/travel/travel-policy.routes.js";
import travelAuditRoutes         from "./src/modules/travel/travel-audit.routes.js";
import visitReportsRoutes        from "./src/modules/travel/visit-reports.routes.js";

// ── Phase X — Commercial ──────────────────────────────────────────────────────
import vendorPortalRoutes         from "./src/modules/procurement/routes/vendor-portal.routes.js";
import vendor360Routes            from "./src/modules/procurement/routes/vendor360.routes.js";
// ── Phase 49C — Vendor Registration Portal ────────────────────────────────────
import vendorRegistrationRoutes   from "./src/modules/procurement/routes/vendor-registration.routes.js";
import vendorApprovalRoutes       from "./src/modules/procurement/routes/vendor-approval.routes.js";
// ── Phase 49G — Vendor Health Score Engine ────────────────────────────────────
import vendorHealthRoutes         from "./src/modules/procurement/routes/vendorHealth.routes.js";
import supplierDevelopmentRoutes  from "./src/modules/procurement/routes/supplierDevelopment.routes.js";
// §136 — Sourcing Strategy (Porter's Five Forces + Purchasing Chessboard)
import sourcingStrategyRoutes    from "./src/modules/procurement/routes/sourcing.routes.js";
import rfxRoutes                 from "./src/modules/procurement/routes/rfx.routes.js";
import projectProfitabilityRoutes from "./src/modules/projects/routes/project-profitability.routes.js";
import project360Routes           from "./src/modules/projects/routes/project360.routes.js";
import deliveryTrackerRoutes       from "./src/modules/projects/routes/deliveryTracker.routes.js";
import projectCostEngineRoutes    from "./src/modules/projects/routes/projectCostEngine.routes.js";
import salesFunnelRoutes          from "./src/modules/sales/routes/sales-funnel.routes.js";

// ── Support ──────────────────────────────────────────────────────────────────
import reportsRoutes          from "./src/modules/reports/routes/reports.routes.js";
import documentsRoutes        from "./src/modules/documents/routes/documents.routes.js";
import signaturesRoutes       from "./src/modules/documents/routes/signatures.routes.js";
import publicSignRoutes       from "./src/modules/documents/routes/publicSign.routes.js";
import documentMasterRoutes   from "./src/modules/documents/routes/documentMaster.routes.js";
import qrShareRoutes          from "./src/modules/qrshare/qrshare.routes.js";
import publicQrRoutes         from "./src/modules/qrshare/publicQr.routes.js";
import notificationsRoutes    from "./src/modules/notifications/routes/notifications.routes.js";
import auditRoutes            from "./src/modules/audit/routes/audit.routes.js";
import orgChartRoutes         from "./src/modules/orgchart/routes/orgchart.routes.js";
import approvalsRoutes        from "./src/modules/approvals/approvals.routes.js";
import dashboardRoutes        from "./src/modules/dashboard/dashboard.routes.js";
import servicedeskRoutes      from "./src/modules/servicedesk/routes/servicedesk.routes.js";
import ipsRoutes              from "./src/modules/servicedesk/routes/ips.routes.js";
import complaintsRoutes       from "./src/modules/complaints/complaints.routes.js";

// ── Phase 51 — Customer Portal, Commissioning, Service Analytics ──────────────
import customerPortalRoutes   from "./src/modules/servicedesk/routes/customer-portal.routes.js";
import commissioningRoutes    from "./src/modules/servicedesk/routes/commissioning.routes.js";
import installationRoutes     from "./src/modules/servicedesk/routes/installation.routes.js";
import serviceAnalyticsRoutes from "./src/modules/servicedesk/routes/service-analytics.routes.js";
import failureAnalyticsRoutes from "./src/modules/servicedesk/routes/failure-analytics.routes.js";
import vocRoutes              from "./src/modules/servicedesk/routes/voc.routes.js";

// ── Integrations ─────────────────────────────────────────────────────────────
import tallyRoutes            from "./src/modules/integrations/tally.routes.js";
import whatsappRoutes         from "./src/modules/integrations/whatsapp.routes.js";
import paymentGWRoutes        from "./src/modules/integrations/payment.routes.js";
import zohoSignRoutes         from "./src/modules/integrations/zoho-sign.routes.js";
import zohoBooksRoutes        from "./src/modules/integrations/zoho-books.routes.js";
import emailIntegrationRoutes from "./src/modules/integrations/email.routes.js";
import integrationsConfigRoutes from "./src/modules/integrations/integrations-config.routes.js";
import webhooksRoutes         from "./src/routes/webhooks.routes.js";

// ── Phase 35 — Global Search ─────────────────────────────────────────────────
import globalSearchRoutes     from "./src/modules/search/global-search.routes.js";

// ── Phase 42E — Secure File Downloads ────────────────────────────────────────
import secureFilesRoutes      from "./src/modules/files/secureFiles.routes.js";

// ── Engineering ──────────────────────────────────────────────────────────────
import engineeringRoutes      from "./src/modules/engineering/engineering.routes.js";
import engDevelopmentRoutes   from "./src/modules/engineering/development.routes.js";
import ecnRoutes              from "./src/modules/engineering/ecn.routes.js";
import disturbanceRoutes      from "./src/modules/quality/disturbance.routes.js";

// ── AI ───────────────────────────────────────────────────────────────────────
import aiRoutes               from "./src/modules/intelligence/ai.routes.js";
import intelligenceRoutes     from "./src/modules/intelligence/intelligence.routes.js";
// ── Phase 49H — CEO Intelligence Dashboard ────────────────────────────────────
import ceoIntelligenceRoutes  from "./src/modules/intelligence/ceo-intelligence.routes.js";
import analyticsRoutes        from "./src/analytics/routes/analytics.routes.js";
import {
  analyticsPolicy, dashboardPolicy, aiPolicy, intelligencePolicy, reportsPolicy,
  withOpenPaths, DASHBOARD_PUBLIC_PATHS,
} from "./src/shared/analyticsAuthz.js";
import aiPayrollRoutes        from "./src/modules/analytics/aiPayroll.routes.js";
import userDashboardRoutes    from "./src/modules/analytics/user-dashboard.routes.js";
import managerRoutes         from "./src/modules/manager/manager.routes.js";
import meetingsRoutes        from "./src/modules/manager/meetings.routes.js";

import helmet from "helmet";
import { verifyToken, allowRoles } from "./src/middlewares/auth.middleware.js";
import { auditLogger }   from "./src/middlewares/auditLogger.js";
import { sanitizeErrorResponse } from "./src/middlewares/errorSanitizer.js";
import { requestId }     from "./src/middlewares/requestId.js";
import { requestLogger } from "./src/middlewares/requestLogger.js";
import { memoryRateLimit } from "./src/middlewares/rateLimit.js";
import { auditMutations } from "./src/middlewares/auditMutations.js";
import { applyFieldPermissions } from "./src/middlewares/auth.middleware.js";
import { responseCap } from "./src/middlewares/responseCap.js";
import { denialLogger } from "./src/middlewares/denialLogger.js";
import { errorHandler }  from "./src/middlewares/errorHandler.js";
import { runMigrations, verifyApplied } from "./src/config/migrations.js";
import { startProbationCron }  from "./src/jobs/probation.cron.js";
import { startHealthMonitor }  from "./src/jobs/healthMonitor.cron.js";
import { startDeliveryFollowupCron } from "./src/jobs/deliveryFollowup.cron.js";
import { startEsignReminderCron } from "./src/jobs/esignReminder.cron.js";
import { startBackupCron }     from "./src/jobs/backup.cron.js";
import { startIotMonitorCron } from "./src/jobs/iotMonitor.cron.js";
import { startIotOutboxCron } from "./src/jobs/iotOutbox.cron.js";
import { startIotPartitionCron } from "./src/jobs/iotPartitions.cron.js";
import { startAmcRenewalCron } from "./src/jobs/amcRenewal.cron.js";
import { startSubscriptionRenewalCron } from "./src/jobs/subscriptionRenewal.cron.js";
import { startWarrantyExpiryCron } from "./src/jobs/warrantyExpiry.cron.js";
import { registerEventReactions } from "./src/shared/eventReactions.js";
import { startOverdueRemindersCron } from "./src/jobs/overdueReminders.cron.js";
import { startScurveSnapshotCron } from "./src/jobs/scurveSnapshot.cron.js";
import { startKpiDigestCron } from "./src/jobs/kpiDigest.cron.js";
import { startAnomalyDetectionCron } from "./src/jobs/anomalyDetection.cron.js";
import { startQuotationExpiryCron } from "./src/jobs/quotationExpiry.cron.js";
import { startCrmFollowupCron } from "./src/jobs/crmFollowup.cron.js";
import { startTenderDeadlineCron } from "./src/jobs/tenderDeadline.cron.js";
import { startCampaignLifecycleCron } from "./src/jobs/campaignLifecycle.cron.js";
import { startMarketingJourneyCron } from "./src/jobs/marketingJourney.cron.js";
import { startReorderPrCron } from "./src/jobs/reorderPr.cron.js";
import { startDepreciationCron } from "./src/jobs/depreciation.cron.js";
import { startFnfAutoTriggerCron } from "./src/jobs/fnfAutoTrigger.cron.js";
import { startExitStatusSyncCron } from "./src/jobs/exitStatusSync.cron.js";
import { startVendorDocExpiryCron } from "./src/jobs/vendorDocExpiry.cron.js";
import { startInterviewReminderCron } from "./src/jobs/interviewReminder.cron.js";
import { startComplianceRemindersCron } from "./src/jobs/complianceReminders.cron.js";
import { startCalibrationDueAlertsCron } from "./src/jobs/calibrationDueAlerts.cron.js";
import { startNcrEscalationCron } from "./src/jobs/ncrEscalation.cron.js";
import { startPatentRenewalCron } from "./src/jobs/patentRenewal.cron.js";
import { startAssetWarrantyExpiryCron } from "./src/jobs/assetWarrantyExpiry.cron.js";
import { startMaintenanceDueCron } from "./src/jobs/maintenanceDue.cron.js";
import { startMrpAutoRunCron } from "./src/jobs/mrpAutoRun.cron.js";
import { startSlaEscalationCron } from "./src/jobs/slaEscalation.cron.js";
import { startWorkflowEscalationCron } from "./src/jobs/workflowEscalation.cron.js";
import { startDocumentExpiryCron } from "./src/jobs/documentExpiry.cron.js";
import { startCustomerHealthRecalcCron } from "./src/jobs/customerHealthRecalc.cron.js";
import { startVendorHealthRecalcCron } from "./src/jobs/vendorHealthRecalc.cron.js";
import { startProcurementAlertsCron } from "./src/jobs/procurementAlerts.cron.js";
import { startDepartmentDigestCron } from "./src/jobs/departmentDigest.cron.js";
import './src/jobs/attendance.cron.js';
import './src/jobs/leave.cron.js';
import { logFeatureFlags } from "./src/config/featureFlags.js";
import { snapshot as metricsSnapshot } from "./src/config/metrics.js";

dotenv.config();

// ── Process-level safety net ─────────────────────────────────────────────────
// Prevents silent crashes from promises that slipped through without try/catch.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException — shutting down safely:', err.stack);
  process.exit(1);
});

// ── Startup: required env var check ──────────────────────────────────────────
(function checkRequiredEnv() {
  const REQUIRED = ['JWT_SECRET'];
  const hasDb = process.env.DATABASE_URL || process.env.DB_PASSWORD;
  if (!hasDb) REQUIRED.push('DATABASE_URL or DB_PASSWORD');
  // ENCRYPTION_KEY is required in production — without it, AES-256-GCM field
  // encryption silently falls back to a weak derived key.
  if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
    REQUIRED.push('ENCRYPTION_KEY');
  }
  // BACKUP_S3_BUCKET is required in production — local backups are lost with
  // the container. ALLOW_LOCAL_BACKUPS_ONLY=true is the explicit opt-out for
  // self-contained stacks (compose demos, CI boot checks) where a named
  // volume is the accepted backup destination. Never set it on a real deploy.
  if (process.env.NODE_ENV === 'production' && !process.env.BACKUP_S3_BUCKET) {
    if (String(process.env.ALLOW_LOCAL_BACKUPS_ONLY).toLowerCase() === 'true') {
      console.warn('⚠️  ALLOW_LOCAL_BACKUPS_ONLY=true — backups live only in the backups volume.');
    } else {
      REQUIRED.push('BACKUP_S3_BUCKET');
    }
  }
  // STORAGE_PROVIDER defaults to 'local' (backend/uploads/ on disk), which does
  // not survive a redeploy on Render/Railway/most containerized hosts — the
  // next deploy silently wipes every uploaded file. Same shape of problem as
  // BACKUP_S3_BUCKET above, same opt-out convention: set ALLOW_LOCAL_STORAGE_ONLY=true
  // only if 'uploads/' is mounted on a real persistent volume.
  const storageProvider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (process.env.NODE_ENV === 'production' && storageProvider === 'local') {
    if (String(process.env.ALLOW_LOCAL_STORAGE_ONLY).toLowerCase() === 'true') {
      console.warn('⚠️  ALLOW_LOCAL_STORAGE_ONLY=true — uploaded files live only on local disk.');
    } else {
      REQUIRED.push('STORAGE_PROVIDER=s3 or r2 (or ALLOW_LOCAL_STORAGE_ONLY=true if uploads/ is on a persistent volume)');
    }
  }
  // PERMISSION_FAIL_OPEN disables authorization wherever the matrix has no row.
  // It is an emergency hatch; left set, it silently restores the vulnerability
  // that made every unseeded module reachable by any logged-in user (H-2).
  if (String(process.env.PERMISSION_FAIL_OPEN).toLowerCase() === 'true') {
    console.warn(
      '\n⚠️  PERMISSION_FAIL_OPEN=true — requests with NO permission row are ALLOWED.\n' +
      '   Any module missing from role_permissions is open to every authenticated user.\n' +
      '   This is a temporary hatch: seed the missing (module, role) rows and unset it.\n'
    );
  }

  const missing = REQUIRED.filter(k => {
    if (k === 'DATABASE_URL or DB_PASSWORD') return !hasDb;
    return !process.env[k];
  });

  if (missing.length) {
    console.error('[startup] FATAL: Required environment variables are not set:');
    missing.forEach(k => console.error(`  • ${k}`));
    console.error('  Set them in .env (see .env.example) and restart.');
    process.exit(1);
  }
})();

const app = express();

// ── Proxy trust ───────────────────────────────────────────────────────────────
// Every rate limiter keys on req.ip. Express only derives req.ip from
// X-Forwarded-For when `trust proxy` is set; without it req.ip is the proxy's
// address and ALL users share one bucket (an instant self-DoS), while any code
// reading the XFF header directly can be bypassed by forging the header.
//
// The value is the number of proxy hops in front of this process. Render and
// Railway both terminate TLS at a single edge proxy, so 1 is correct there.
// Set TRUST_PROXY_HOPS explicitly if you add a CDN or your own load balancer.
// In development there is no proxy, so trust nothing and req.ip is the socket.
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS
  ? parseInt(process.env.TRUST_PROXY_HOPS, 10)
  : (process.env.NODE_ENV === 'production' ? 1 : 0);
app.set('trust proxy', TRUST_PROXY_HOPS);

app.use(requestId);
app.use(requestLogger);
// Security headers — API-only server: CSP and crossOriginEmbedderPolicy
// are disabled (irrelevant for JSON responses; enabling them can break CORS
// preflight handling for some browser clients).
app.use(helmet({
  contentSecurityPolicy:       false,
  crossOriginEmbedderPolicy:   false,
}));

// In production, FRONTEND_URL must be set. Without it, origin: true would allow
// any website to make credentialed cross-origin requests to this API.
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  throw new Error(
    '[startup] FATAL: FRONTEND_URL is required in production.\n' +
    '  Set it to your deployed frontend origin, e.g.:\n' +
    '    FRONTEND_URL=https://app.example.com\n' +
    '  Without it CORS is open to every origin.'
  );
}

// In dev, allow any localhost/127.0.0.1 origin regardless of port (Vite picks
// ports dynamically and browsers treat 127.0.0.1 and localhost as distinct origins).
// In production, FRONTEND_URL must be set explicitly (enforced above), and dev
// origins are dropped from the allow-list entirely — a developer's local
// frontend should not be able to make credentialed requests against prod.
const corsOrigin = process.env.FRONTEND_URL
  ? (process.env.NODE_ENV === 'production'
      ? [process.env.FRONTEND_URL]
      : [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'])
  : (origin, callback) => {
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin not allowed — ${origin}`));
    };

// The web-to-lead capture endpoint is the one route on this server that is
// POSTed by a form on a CUSTOMER'S OWN website, so its origin is unknown by
// definition and cannot be in any allow-list we keep. Running it through the
// app allow-list threw `CORS: origin not allowed` before the handler — a 500,
// no `web_lead_submissions` row, and the enquiry lost — while every server-side
// test passed, because curl and fetch send no Origin header and only a browser
// does. It also made `web_lead_forms.allowed_origins` dead code: the per-form
// allow-list could never be consulted, since the global gate answered first and
// knows nothing about that table. Reflecting the origin here is what hands the
// decision back to the route, which then honours the form's own list and logs a
// `rejected` row for an origin it turns away.
//
// `credentials: false` is the load-bearing half. A public endpoint that
// reflected an arbitrary origin AND allowed credentials would let any website
// make authenticated cross-origin calls with a logged-in user's cookies. This
// route takes no session at all, so it needs none — and the exemption is scoped
// to that single path rather than the whole /public prefix, so a future public
// route has to opt in deliberately.
const PUBLIC_CAPTURE_RE = /^\/api(?:\/v1)?\/public\/web-lead\//;

app.use(cors((req, callback) => {
  if (req.method === 'OPTIONS' || req.method === 'POST') {
    if (PUBLIC_CAPTURE_RE.test(req.path)) {
      return callback(null, {
        origin: true,
        credentials: false,
        methods: ['POST', 'OPTIONS'],
        exposedHeaders: ['X-Request-ID'],
      });
    }
  }
  callback(null, {
    origin: corsOrigin,
    credentials: true,
    exposedHeaders: ['X-Request-ID'],
  });
}));
// ── Global rate limit ─────────────────────────────────────────────────────────
// Backstop only — deliberately generous so it never trips for a human at a
// keyboard. Its job is shedding scripted floods (credential spraying across many
// accounts, scraping, the 6–12-query fan-out on dashboard endpoints), not
// enforcing per-endpoint policy. Sensitive endpoints layer a tighter DB-backed
// limiter on top; see src/middlewares/rateLimit.js.
//
// In-process, so the effective cluster limit is max × instances. That is fine
// for a backstop; anything needing an exact cluster-wide cap uses dbRateLimit.
//
// Mounted AFTER cors (a 429 on a preflight breaks the browser's error reporting)
// and BEFORE the body parsers, so flood traffic is dropped before we spend
// memory parsing 5 MB bodies.
app.use(memoryRateLimit({
  windowMs: parseInt(process.env.GLOBAL_RL_WINDOW_MS || String(60 * 1000), 10),
  max:      parseInt(process.env.GLOBAL_RL_MAX       || '300', 10),
  bucket:   'global',
  // Health checks come from the platform's prober on a single IP and must never
  // be throttled — a 429 here marks the instance unhealthy and triggers a restart.
  skip: (req) => req.path === '/health' || req.path === '/api/health',
}));

// Capture raw body for webhook signature verification (Razorpay HMAC)
app.use('/api/webhooks', express.raw({ type: 'application/json' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body.toString('utf8');
    req.body    = JSON.parse(req.rawBody);
  }
  next();
});
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
// Scrub raw error messages from 5xx responses in production (info-disclosure guard).
// No-op in non-production so developers still see real messages.
app.use(sanitizeErrorResponse);
// Bounds array responses and logs which endpoints exceed the ceiling, so the
// 285 unbounded queries can be prioritised by real traffic instead of guessed at.
// Must sit AFTER sanitizeErrorResponse: both wrap res.json, and the error
// sanitiser has to be the outermost so it still sees 5xx bodies.
app.use(responseCap);
// Records 401/403 to access_denials. auditLogger only writes on 2xx, so without
// this a refused request leaves no trace and the RBAC hypothesis is untestable.
app.use(denialLogger);
// NOTE: /uploads is NOT served as public static — all file downloads go through
// /api/files/:filename which enforces JWT auth, ownership, and audit logging.

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only images, PDF, and Word documents are allowed'), { status: 415 }));
  },
});

// Apply file upload only to mutating employee requests with explicit field names
const employeeUpload = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'DELETE') return next();
  return upload.fields([
    { name: 'photo_file',            maxCount: 1 },
    { name: 'pan_file',              maxCount: 1 },
    { name: 'aadhaar_file',          maxCount: 1 },
    { name: 'cancelled_cheque_file', maxCount: 1 },
    { name: 'bank_statement_file',   maxCount: 1 },
    { name: 'resume_file',           maxCount: 1 },
    { name: 'offer_letter_file',     maxCount: 1 },
  ])(req, res, next);
};
app.use("/api/employees", verifyToken, employeeUpload);
app.use("/api/v1/employees", verifyToken, employeeUpload);

// ── All versioned routes grouped under v1Router ───────────────────────────────
// Mounted at both /api/v1 (canonical) and /api (backward compat).
const v1Router = express.Router();

// Automatic audit logging for all mutating requests (POST/PUT/PATCH/DELETE).
// Fires after verifyToken (which is applied per-route below), so req.user and
// req.scope are already populated when the middleware runs.
v1Router.use(auditLogger);

// Auth is public. Employees has verifyToken via app.use() above (lines 207-208).
// home/notes/probation have verifyToken inside their route files.
// announcements has one intentionally public route (/active) for the login screen.
v1Router.use("/auth",            authRoutes);
v1Router.use("/home",            homeRoutes);
// verifyToken for /employees is applied globally at the app level (see the
// employeeUpload mount above), so it is absent here — which is why the
// automatic pass missed this router. It carries the field rules that matter
// most: aadhaar_number, pan_number, bank details and basic_salary.
v1Router.use("/employees",       applyFieldPermissions('employees'), auditMutations('employees'), employeeRoutes);
v1Router.use("/notes",           auditMutations('admin'), noteRoutes);
v1Router.use("/announcements",   auditMutations('announcements'), announcementRoutes);
v1Router.use("/probation",       auditMutations('hr'), probationRoutes);
v1Router.use("/leaves",          verifyToken, auditMutations('leaves'), leavesNewRoutes);
v1Router.use("/comp-off",        verifyToken, auditMutations('leaves'), compOffRoutes);
v1Router.use("/leave-encashment", verifyToken, auditMutations('leaves'), encashmentRoutes);
v1Router.use("/leave-accrual",   verifyToken, auditMutations('leaves'), accrualRoutes);

// FINANCE
v1Router.use("/finance",         verifyToken, applyFieldPermissions('finance'), auditMutations('finance'), financeRoutes);
v1Router.use("/finance",         verifyToken, applyFieldPermissions('finance'), auditMutations('finance'), extendedFinanceRoutes);
v1Router.use("/statements",      verifyToken, statementsRoutes);
v1Router.use("/accounting",      verifyToken, auditMutations('finance'), accountingRoutes);
v1Router.use("/gst",             verifyToken, auditMutations('finance'), gstRoutes);
v1Router.use("/tds",             verifyToken, auditMutations('finance'), tdsRoutes);
v1Router.use("/tcs",             verifyToken, auditMutations('finance'), tcsRoutes);
v1Router.use("/budgets",         verifyToken, auditMutations('finance'), budgetRoutes);
v1Router.use("/fixed-assets",    verifyToken, auditMutations('finance'), assetsRoutes);
v1Router.use("/forex",           verifyToken, auditMutations('finance'), forexRoutes);
v1Router.use("/finance/credit-notes", verifyToken, auditMutations('finance'), creditNotesRoutes);
v1Router.use("/finance/debit-notes",  verifyToken, auditMutations('finance'), debitNotesRoutes);
v1Router.use("/finance/cost-centers", verifyToken, auditMutations('finance'), costCentersRoutes);

// PROCUREMENT & INVENTORY
v1Router.use("/procurement",     verifyToken, auditMutations('procurement'), procurementRoutes);
// vendorRoutes defines explicit top-level paths (/vendors, /rfqs, /three-way-match).
// Scope verifyToken to those prefixes — mounting it bare at "/" alongside the router
// makes verifyToken a GLOBAL auth gate that also 401s public routes registered later
// (e.g. /sign, /customer-portal). The router itself mounts at "/" without auth so it
// only matches its own paths and falls through otherwise.
v1Router.use(["/vendors", "/rfqs", "/three-way-match"], verifyToken);
v1Router.use("/",                vendorRoutes);
v1Router.use("/inventory",       verifyToken, auditMutations('inventory'), inventoryRoutes);
v1Router.use("/warehouse",       verifyToken, auditMutations('warehouse'), warehouseRoutes);
v1Router.use("/logistics",       verifyToken, auditMutations('logistics'), logisticsRoutes);
v1Router.use("/service-level",   verifyToken, serviceLevelRoutes);
v1Router.use("/scm",             verifyToken, auditMutations('inventory'), scmPlanningRoutes);
v1Router.use("/quality",                    verifyToken, auditMutations('quality'), qualityRoutes);
v1Router.use("/engineering/tests",          verifyToken, auditMutations('engineering'), testHistorianRoutes);
v1Router.use("/quality/disturbance-events", verifyToken, auditMutations('quality'), disturbanceRoutes);

// PRODUCTION
v1Router.use("/bom",             verifyToken, auditMutations('bom'), bomRoutes);
v1Router.use("/production",      verifyToken, auditMutations('production'), productionExecutionRoutes);
v1Router.use("/imr",             verifyToken, auditMutations('production'), imrRoutes);
v1Router.use("/mrp",             verifyToken, auditMutations('production'), mrpRoutes);
v1Router.use("/crp",             verifyToken, auditMutations('production'), crpRoutes);
v1Router.use("/subcontracting",  verifyToken, auditMutations('production'), subcontractingRoutes);
v1Router.use("/genealogy",       verifyToken, genealogyRoutes);
v1Router.use("/mfg",             verifyToken, auditMutations('bom'), bomModelingRoutes);
v1Router.use("/sop",             verifyToken, sopRoutes);

// PROJECTS
v1Router.use("/projects",        verifyToken, auditMutations('projects'), projectRoutes);
v1Router.use("/projects",        verifyToken, auditMutations('projects'), orderHistoryRoutes); // CEO full-history traceability
v1Router.use("/project-members", auditMutations('projects'), projectMembersRoutes);
v1Router.use("/tasks",           verifyToken, taskRoutes);
v1Router.use("/gantt",           verifyToken, auditMutations('projects'), ganttRoutes);

// HR & PAYROLL
v1Router.use("/timesheets",      verifyToken, auditMutations('timesheets'), timesheetRoutes);
v1Router.use("/performance",              verifyToken, auditMutations('performance'), performanceRoutes);
v1Router.use("/performance/cycles",       verifyToken, auditMutations('performance'), perfCyclesRoutes);
v1Router.use("/performance/kras",         verifyToken, auditMutations('performance'), perfKRARoutes);
v1Router.use("/performance/feedback",     verifyToken, auditMutations('performance'), perfFeedback360Routes);
v1Router.use("/performance/calibration",  verifyToken, auditMutations('performance'), perfCalibRoutes);
v1Router.use("/performance/increments",   verifyToken, auditMutations('performance'), perfIncRoutes);
v1Router.use("/performance/promotions",   verifyToken, auditMutations('performance'), perfPromoRoutes);
v1Router.use("/performance/reports",      verifyToken, perfReportsRoutes);
v1Router.use("/performance/okr",          verifyToken, auditMutations('performance'), perfOKRRoutes);
v1Router.use("/recruitment",     verifyToken, auditMutations('recruitment'), recruitmentRoutes);
v1Router.use("/talent",          verifyToken, auditMutations('hr'), talentRoutes);
v1Router.use("/leaves-new",      verifyToken, auditMutations('leaves'), leavesNewRoutes); // backward-compat alias
v1Router.use("/attendance",         verifyToken, auditMutations('attendance'), attendanceRoutes);
v1Router.use("/attendance/offline", verifyToken, auditMutations('attendance'), offlineSyncRoutes); // PWA offline punch sync
v1Router.use("/holidays",           verifyToken, auditMutations('leaves'), holidaysRoutes);
v1Router.use("/payroll",         verifyToken, applyFieldPermissions('payroll'), auditMutations('payroll'), payrollRoutes);
v1Router.use("/salary-structures", verifyToken, auditMutations('payroll'), salaryRoutes);
v1Router.use("/hr",              verifyToken, applyFieldPermissions('hr'), auditMutations('hr'), hrRoutes);
v1Router.use("/training",        verifyToken, auditMutations('training'), trainingRoutes);
v1Router.use("/certifications",  verifyToken, auditMutations('hr'), certificationsRoutes);
v1Router.use("/learning-paths",  verifyToken, auditMutations('training'), learningPathsRoutes);
v1Router.use("/assessments",     verifyToken, auditMutations('training'), assessmentsRoutes);
v1Router.use("/trainers",        verifyToken, auditMutations('training'), trainersRoutes);
v1Router.use("/lnd-reports",     verifyToken, lndReportingRoutes);
v1Router.use("/competencies",    verifyToken, auditMutations('training'), competencyRoutes);
v1Router.use("/knowledge",       verifyToken, auditMutations('training'), knowledgeRoutes);
v1Router.use("/lnd-settings",    verifyToken, auditMutations('training'), lndSettingsRoutes);
v1Router.use("/succession",      verifyToken, auditMutations('hr'), successionRoutes);
// biometric.routes.js defines full paths (/biometric/*, /gate-passes, /visitors).
// Scope verifyToken to those prefixes — a bare use(verifyToken, ...) mounts the guard
// at "/" and turns it into a global auth gate that blocks public routes registered later.
v1Router.use(["/biometric", "/gate-passes", "/visitors"], verifyToken);
v1Router.use(biometricRoutes);
v1Router.use("/self-service",    verifyToken, auditMutations('employees'), selfServiceRoutes);
v1Router.use("/employee-assets", auditMutations('assets'), employeeAssetsRoutes);
v1Router.use("/employee-skills", auditMutations('hr'), employeeSkillsRoutes);
v1Router.use("/hr-master",       auditMutations('hr'), hrMasterDataRoutes);
v1Router.use("/hr-widgets",      hrWidgetsRoutes);
v1Router.use("/onboarding",      verifyToken, auditMutations('hr'), onboardingRoutes);
v1Router.use("/exit",            verifyToken, auditMutations('hr'), exitRoutes);

// CRM & SALES
// The email open-tracking pixel is fetched by the RECIPIENT's mail client,
// which carries no session token. Mounted here, ahead of the authenticated
// /crm mount, so Express matches it first for that one path; everything else
// under /crm still requires a token. Inside the authenticated router it was
// unreachable by the only caller it has.
// auditMutations() is the FLOOR for audit coverage, not a replacement for
// logAudit(). A scan on 2026-09-04 found only 26% of the 1,304 mutating
// handlers writing an audit row — entire files wrote none. Mounted per router
// it records every successful POST/PUT/PATCH/DELETE, including routes added
// later. Handlers that call logAudit() themselves mark the request and this
// stands down, so a write with a proper before-image is not counted twice.
// Web-to-lead capture is posted to by a website form with no session at
// all, so it is mounted OUTSIDE verifyToken and kept to a single route
// under its own /public prefix — a public write path hidden among
// authenticated ones is how a missing gate goes unnoticed. Its defences
// (per-form key, origin allowlist, hourly cap counted from the table,
// honeypot, duplicate suppression) live in webToLead.routes.js.
// applyFieldPermissions enforces `field_permissions` in BOTH directions —
// invisible fields stripped from responses, non-editable ones stripped from
// request bodies. The table held ten correct rules (an `employee` may not see
// aadhaar_number, pan_number, bank details, basic_salary, gross, net_pay) and
// the middleware that reads them was mounted NOWHERE until 2026-09-04.
// Mounted AFTER verifyToken so roles are known, and after the audit floor so
// what gets logged is what the handler received.
v1Router.use("/public",          auditMutations('crm'), webLeadPublicRoutes);
v1Router.use("/crm",             auditMutations('crm'), trackOpenRouter);
// Journeys mount BEFORE the main crm router: /crm/journeys/* would otherwise
// fall through to crmRoutes and 404 on a path it has never heard of.
v1Router.use("/crm/journeys",    verifyToken, auditMutations('crm'), journeyRoutes);
v1Router.use("/crm",             verifyToken, applyFieldPermissions('crm'), auditMutations('crm'), crmRoutes);
// /sales/partners is mounted FIRST: Express matches in registration order, and
// the general sales router would otherwise shadow it.
v1Router.use("/sales/forecasting",      verifyToken, auditMutations('sales'), salesForecastRoutes);
v1Router.use("/sales/partners",         verifyToken, auditMutations('sales'), salesPartnersRoutes);
// Mounts BEFORE the main sales router, same reason as /crm/journeys: a
// sub-path would otherwise fall through to salesRoutes and 404.
v1Router.use("/sales/deal-registrations", verifyToken, auditMutations('sales'), dealRegistrationRoutes);

// Email-to-case. The INGEST router is mounted WITHOUT verifyToken on purpose:
// a mail provider's webhook has no ERP login. It is not open — it authenticates
// with a per-mailbox shared secret and refuses any mailbox that has none.
v1Router.use("/support-mail",    auditMutations('servicedesk'), supportMailIngestRouter);
v1Router.use("/support-mail",    verifyToken, auditMutations('service'), supportMailAdminRouter);
v1Router.use("/sales",                  verifyToken, applyFieldPermissions('sales'), auditMutations('sales'), salesRoutes);
v1Router.use("/sales-command-center",   verifyToken, auditMutations('sales'), salesCommandCenterRoutes);
v1Router.use("/pricing",                verifyToken, auditMutations('sales'), pricingRoutes);
v1Router.use("/commissions",     verifyToken, applyFieldPermissions('sales'), auditMutations('sales'), commissionRoutes);
v1Router.use("/delivery",        verifyToken, auditMutations('sales'), fulfilmentRoutes);
v1Router.use("/marketing",       verifyToken, auditMutations('marketing'), marketingRoutes);

// MASTER DATA
v1Router.use("/master",          verifyToken, auditMutations('master'), masterRoutes);
v1Router.use("/admin/config",    verifyToken, auditMutations('master'), masterRoutes);
v1Router.use("/wizard",          verifyToken, auditMutations('admin'), wizardRoutes);

// OPERATIONS & ADMIN
v1Router.use("/operations",      verifyToken, auditMutations('admin'), operationsRoutes);
v1Router.use("/lifecycle",       verifyToken, auditMutations('lifecycle'), lifecycleRoutes);
v1Router.use("/maintenance",     verifyToken, auditMutations('maintenance'), maintenanceRoutes);
v1Router.use("/workflows",       verifyToken, auditMutations('admin'), workflowRoutes);
v1Router.use("/security",        verifyToken, auditMutations('security'), securityRoutes);
v1Router.use("/admin",           verifyToken, auditMutations('admin'), adminRoutes);
v1Router.use("/settings",        verifyToken, auditMutations('settings'), settingsStatusRoutes);
v1Router.use("/system-health",   verifyToken, allowRoles('admin', 'super_admin'), systemHealthRoutes);   // live DB table introspection — admin-only diagnostic
v1Router.use("/company-profile", verifyToken, auditMutations('company_profile'), companyProfileRoutes);
v1Router.use("/branches",        verifyToken, auditMutations('branches'), branchManagementRoutes);
v1Router.use("/travel",               verifyToken, auditMutations('travel'), travelRoutes);
v1Router.use("/customer-visits",      verifyToken, auditMutations('crm'), customerVisitsRoutes);
v1Router.use("/reimbursement",        verifyToken, auditMutations('reimbursement'), travelReimbursementRoutes);
v1Router.use("/travel-policy",        verifyToken, auditMutations('travel'), travelPolicyRoutes);
v1Router.use("/travel-audit",         verifyToken, travelAuditRoutes);
v1Router.use("/visit-reports",        verifyToken, auditMutations('travel'), visitReportsRoutes);

// Phase X — Commercial, Travel & Vendor Ecosystem
v1Router.use("/vendor-portal",        verifyToken, auditMutations('procurement'), vendorPortalRoutes);
v1Router.use("/vendor-360",           verifyToken, auditMutations('procurement'), vendor360Routes);
// Phase 49C — Vendor Registration Portal (mixed auth — public submit inside the router)
v1Router.use("/vendor-registration",  auditMutations('procurement'), vendorRegistrationRoutes);
v1Router.use("/vendor-approval",      verifyToken, auditMutations('vendor_approval'), vendorApprovalRoutes);
v1Router.use("/vendor-health",        verifyToken, auditMutations('procurement'), vendorHealthRoutes);
v1Router.use("/supplier-development", verifyToken, auditMutations('procurement'), supplierDevelopmentRoutes);
// Mounted on its own path, not under /procurement: procurement.routes.js already
// owns a /:id parameter route, and a literal segment added after one is
// unreachable (a defect class this repo has hit before).
v1Router.use("/sourcing-strategy",    verifyToken, auditMutations('inventory'), sourcingStrategyRoutes);
v1Router.use("/rfx",                  verifyToken, auditMutations('procurement'), rfxRoutes);   // §136 RFI/RFP/RFQ scoring + preferred-vendor selection
v1Router.use("/project-profitability",verifyToken, auditMutations('projects'), projectProfitabilityRoutes);
v1Router.use("/project-360",          verifyToken, auditMutations('projects'), project360Routes);
v1Router.use("/delivery-tracker",     verifyToken, deliveryTrackerRoutes); // IPM<->IPP production/fulfilment grid
// Phase 46 — Project Cost & Profitability Engine
v1Router.use("/project-cost-engine",  verifyToken, auditMutations('projects'), projectCostEngineRoutes);
v1Router.use("/sales-funnel",         verifyToken, salesFunnelRoutes);

// SUPPORT
// Reports — guarded by reportsPolicy, generated from modules/reports/reportCatalog.js
// so each report takes the permission its owning module would require. This
// router previously carried verifyToken alone: every authenticated user could
// read leave-encashment liability (salary-derived, per named employee), the AR
// ledger, the GST summary and payroll totals.
v1Router.use("/reports",         verifyToken, reportsPolicy, auditMutations('reports'), reportsRoutes);
v1Router.use("/documents",       verifyToken, auditMutations('documents'), documentsRoutes);
v1Router.use("/signatures",      verifyToken, auditMutations('documents'), signaturesRoutes);
// Public no-login signing surface — token-gated inside the router (like customer-portal)
v1Router.use("/sign",            auditMutations('documents'), publicSignRoutes);
v1Router.use("/document-master", verifyToken, auditMutations('documents'), documentMasterRoutes);
v1Router.use("/qr-codes",        verifyToken, auditMutations('documents'), qrShareRoutes);
// Public QR resolution — token-gated inside the router (QR images encode /api/v1/q/:token)
v1Router.use("/q",               auditMutations('documents'), publicQrRoutes);
v1Router.use("/notifications",   verifyToken, auditMutations('notifications'), notificationsRoutes);
v1Router.use("/audit",           verifyToken, auditRoutes);
v1Router.use("/orgchart",        auditMutations('orgchart'), orgChartRoutes);
v1Router.use("/approvals",       verifyToken, auditMutations('approvals'), approvalsRoutes);
// Analytics & AI read surface — see src/shared/analyticsAuthz.js.
// These three routers previously carried verifyToken and nothing else, leaving
// 72 endpoints (full P&L, salary bands, named performance ratings) readable by
// any authenticated user. Each mount now applies a path-prefix permission policy
// that denies by default, so new routes inherit a guard instead of shipping open.
v1Router.use("/dashboard",       verifyToken, withOpenPaths(dashboardPolicy, DASHBOARD_PUBLIC_PATHS), auditMutations('dashboard'), dashboardRoutes);
// IPS (Service Master) is mounted ahead of the general servicedesk router so its
// /ips/* paths resolve here rather than falling through that router first.
v1Router.use("/servicedesk/ips", verifyToken, auditMutations('servicedesk'), ipsRoutes);
v1Router.use("/servicedesk",     verifyToken, auditMutations('servicedesk'), servicedeskRoutes);
v1Router.use("/complaints",      verifyToken, auditMutations('servicedesk'), complaintsRoutes);

// Phase 51 — Customer Portal (mixed auth), Commissioning, Service/Failure Analytics, VOC
v1Router.use("/customer-portal",    auditMutations('servicedesk'), customerPortalRoutes);      // mixed: /auth/login public, /portal/* portal-token, /accounts/* verifyToken
v1Router.use("/commissioning",      verifyToken, auditMutations('commissioning'), commissioningRoutes);
v1Router.use("/installation-requests", verifyToken, auditMutations('servicedesk'), installationRoutes);
v1Router.use("/service-analytics",  verifyToken, serviceAnalyticsRoutes);
v1Router.use("/failure-analytics",  verifyToken, auditMutations('servicedesk'), failureAnalyticsRoutes);
v1Router.use("/voc",                auditMutations('servicedesk'), vocRoutes);                  // POST /responses is public (portal submit)

// IoT / Device Telemetry — device-token auth inside the ingest router, NOT verifyToken.
// Order matters: the ingest router claims only POST /iot/ingest and
// POST /iot/gateway/heartbeat; everything else falls through to the user-authed
// routers below, each of which denies a caller with no company scope (scope.js).
v1Router.use("/iot",                auditMutations('iot'), iotIngestRoutes);              // device-token-gated
v1Router.use("/iot",                verifyToken, auditMutations('iot'), iotDevicesRoutes); // fleet + device 360 + provisioning
v1Router.use("/iot",                verifyToken, auditMutations('iot'), iotAlertsRoutes);  // alert centre + rule management
v1Router.use("/iot",                verifyToken, auditMutations('iot'), iotOpsRoutes);     // platform health, data quality, exports
v1Router.use("/compliance",         verifyToken, auditMutations('compliance'), complianceRoutes);
v1Router.use("/assets",             verifyToken, auditMutations('assets'), unifiedAssetsRoutes); // read-only consolidation over fixed_assets/assets_register/allocations
v1Router.use("/rd",                 verifyToken, auditMutations('rd'), rdRoutes); // R&D artifact repo + patents + product lifecycle (PLM)
v1Router.use("/tenders",            verifyToken, auditMutations('crm'), tenderRoutes); // Government tender workspace over opportunities

// INTEGRATIONS
v1Router.use("/integrations/tally",    verifyToken, auditMutations('finance'), tallyRoutes);
v1Router.use("/integrations/whatsapp", verifyToken, auditMutations('admin'), whatsappRoutes);
v1Router.use("/payments",              verifyToken, auditMutations('finance'), paymentGWRoutes);

// GLOBAL SEARCH (Phase 35F)
v1Router.use("/global-search",   verifyToken, globalSearchRoutes);

// SECURE FILE DOWNLOADS (Phase 42E) — replaces public /uploads static
v1Router.use("/files",           secureFilesRoutes); // verifyToken is inside the router

// ENGINEERING
// /development is mounted FIRST: Express matches in registration order, and the
// general engineering router would otherwise shadow it.
v1Router.use("/engineering/development", verifyToken, auditMutations('engineering'), engDevelopmentRoutes);
v1Router.use("/engineering",     verifyToken, auditMutations('engineering'), engineeringRoutes);
v1Router.use("/engineering/ecn", verifyToken, auditMutations('engineering'), ecnRoutes);

// AI — combined router (aiRoutes: /ceo-insights, /llm-chat, /chat, /anomalies, /predictions, /smart-search
//       aiPayrollRoutes: /payroll/trends, /payroll/departments, /payroll/anomalies, /cashflow/forecast, /query)
const aiCombined = express.Router();
aiCombined.use(aiRoutes);
aiCombined.use(aiPayrollRoutes);
v1Router.use("/ai",              verifyToken, aiPolicy, auditMutations('analytics'), aiCombined);
v1Router.use("/intelligence",      verifyToken, intelligencePolicy, auditMutations('analytics'), intelligenceRoutes);
v1Router.use("/ceo-intelligence",  verifyToken, auditMutations('crm'), ceoIntelligenceRoutes);
v1Router.use("/analytics",       verifyToken, analyticsPolicy, analyticsRoutes);
v1Router.use("/user-dashboard",  verifyToken, userDashboardRoutes);
// Manager / Ops dashboard aggregates (budget vs actual, team capacity, OKR targets).
//
// verifyToken only, deliberately. Every endpoint in this router is already
// anchored to the caller: /team-capacity and /targets cover their own direct
// reports or department (company-wide only for admin/super_admin/department_head),
// and /budget clamps a non-finance caller to their own department instead of
// 403'ing them. Adding requirePermission('dashboard','view') on top gains nothing
// against self-scoped data and costs a lot: 19 of 26 roles — production_manager,
// project_manager, sales_manager, hr_manager, finance_manager among them — have
// no `dashboard` row at all, and requirePermission fails CLOSED, so the gate
// would 403 exactly the managerial roles this dashboard exists for and rebuild
// the empty cards it was written to fix.
v1Router.use("/manager",         verifyToken, managerRoutes);
v1Router.use("/meetings",        verifyToken, auditMutations('hr'), meetingsRoutes);

// INTEGRATIONS (additions)
v1Router.use("/integrations/zoho-sign",  verifyToken, auditMutations('documents'), zohoSignRoutes);
v1Router.use("/integrations/zoho-books", verifyToken, zohoBooksRoutes);
v1Router.use("/integrations/config",     verifyToken, auditMutations('admin'), integrationsConfigRoutes);
v1Router.use("/integrations",            verifyToken, emailIntegrationRoutes);

// ── Frontend URL alias mounts — additional path prefixes expected by frontend ──
// These mirror existing routers at the URL patterns the UI actually uses.
v1Router.use("/hr/succession",                   verifyToken, auditMutations('hr'), successionRoutes);
v1Router.use("/succession/succession",           verifyToken, auditMutations('hr'), successionRoutes);   // /succession/succession/assessments
v1Router.use("/payroll/salary-structures",       verifyToken, auditMutations('payroll'), salaryRoutes);
v1Router.use("/salary-structures/salary-structures", verifyToken, auditMutations('payroll'), salaryRoutes);  // /salary-structures/salary-structures
v1Router.use("/payroll",                         verifyToken, applyFieldPermissions('payroll'), auditMutations('payroll'), selfServiceRoutes);  // /payroll/it-declarations, etc.
v1Router.use("/employees/self-service",          verifyToken, auditMutations('employees'), selfServiceRoutes);
v1Router.use("/self-service/self-service",       verifyToken, auditMutations('employees'), selfServiceRoutes);  // /self-service/self-service/it-declarations
v1Router.use("/finance/accounting",        verifyToken, auditMutations('finance'), accountingRoutes);
v1Router.use("/projects",                  verifyToken, auditMutations('projects'), timesheetRoutes); // /projects/timesheets alias

// ── HEALTH / METRICS — registered BEFORE v1Router so v1Router's "/" catch-all
// (vendorRoutes) does not intercept these public/lightly-guarded endpoints. ──
app.get("/", (req, res) => res.send("Pulse ERP running 🚀"));

app.get("/api/health", async (req, res) => {
  const t0 = Date.now();

  // ── 1. DB connectivity ──────────────────────────────────────────────────────
  let dbStatus = "ok", dbMs = 0, dbError = null;
  try {
    await pool.query("SELECT 1");
    dbMs = Date.now() - t0;
  } catch (e) {
    dbStatus = "error";
    dbError  = e.message;
  }

  // ── 2. Migration version status ─────────────────────────────────────────────
  let migrations = { status: "unknown" };
  try {
    const mv = await verifyApplied();
    // "pending" = new files on disk not yet applied (actionable)
    // "warn"    = only orphaned DB records (files deleted after apply) — informational only
    // "ok"      = schema is fully up to date with no pending migrations
    const hasPending = mv.missing.length > 0;
    // detectTamperedMigrations returns real warnings and informational
    // supersession lines in one array, the ℹ️ ones last. Counting the whole
    // array as `tamper_warnings` reported 6 on a completely healthy schema —
    // a number that reads as tampering next to a status of "ok". Split them:
    // an explained supersession is not a warning about anything.
    const superseded = mv.tamperWarnings.filter(w => w.includes('Superseded:'));
    const realWarnings = mv.tamperWarnings.filter(w => !w.includes('Superseded:'));
    const hasOrphans = realWarnings.some(w => w.includes('missing from disk'));
    const hasModified = realWarnings.some(w => w.includes('Checksum mismatch') || w.includes('was modified'));
    migrations = {
      status:  hasPending ? "pending" : (hasModified ? "warn" : "ok"),
      applied: mv.applied,
      total:   mv.total,
      pending: mv.missing.length,
      ...(mv.missing.length   && { missing_files:   mv.missing }),
      ...(realWarnings.length && { tamper_warnings: realWarnings.length }),
      ...(superseded.length   && { superseded:      superseded.length }),
      ...(hasOrphans && !hasModified && { info: "Some applied migrations have no corresponding file on disk (orphaned records — schema changes already applied)" }),
    };
  } catch (e) {
    migrations = { status: "error", error: e.message };
  }

  // ── 3. Critical table existence ─────────────────────────────────────────────
  const CRITICAL_TABLES = [
    "employees", "approvals", "notifications",
    "workflow_instances", "audit_logs", "schema_migrations",
  ];
  let tables = { status: "unknown" };
  try {
    const { rows } = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = ANY($1::text[])`,
      [CRITICAL_TABLES]
    );
    const found   = new Set(rows.map(r => r.table_name));
    const missing = CRITICAL_TABLES.filter(t => !found.has(t));
    tables = {
      status:  missing.length ? "degraded" : "ok",
      checked: CRITICAL_TABLES.length,
      ...(missing.length && { missing }),
    };
  } catch (e) {
    tables = { status: "error", error: e.message };
  }

  // ── 4. Operational metrics (process-lifetime counters) ──────────────────────
  const metrics = metricsSnapshot();

  // ── 5. Memory ───────────────────────────────────────────────────────────────
  const memMb        = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const memThreshold = parseInt(process.env.MEMORY_ALERT_MB || "450");

  // ── Overall status ──────────────────────────────────────────────────────────
  const overall =
    dbStatus === "ok" && tables.status !== "degraded" && tables.status !== "error"
      ? "ok"
      : "degraded";

  res.status(overall === "ok" ? 200 : 503).json({
    status:     overall,
    requestId:  req.id,
    timestamp:  new Date().toISOString(),
    uptime_s:   Math.floor(process.uptime()),
    version:    process.env.npm_package_version || "1.0.0",
    db:         { status: dbStatus, latency_ms: dbMs, ...(dbError && { error: dbError }) },
    migrations,
    tables,
    metrics,
    memory:     { rss_mb: memMb, threshold_mb: memThreshold, pressure: memMb > memThreshold },
    node:       process.version,
    commit:     process.env.RENDER_GIT_COMMIT  || null,
    deploy_id:  process.env.RENDER_SERVICE_ID  || null,
  });
});

app.get("/api/test-auth", verifyToken, (req, res) => res.json({ message: "✅ Auth OK", user: req.user }));

// ── PROMETHEUS-COMPATIBLE METRICS (/api/metrics) ─────────────────────────────
// Exposes in-process counters in text/plain Prometheus exposition format.
// Protect with METRICS_TOKEN env var in production (optional but recommended).
app.get("/api/metrics", (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '') || req.query.token;
    if (provided !== token) return res.status(401).json({ error: 'Unauthorized' });
  }

  const m   = metricsSnapshot();
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const lines = [
    '# HELP pulse_uptime_seconds Process uptime in seconds',
    '# TYPE pulse_uptime_seconds gauge',
    `pulse_uptime_seconds ${Math.floor(process.uptime())}`,
    '# HELP pulse_memory_rss_mb RSS memory usage in MB',
    '# TYPE pulse_memory_rss_mb gauge',
    `pulse_memory_rss_mb ${mem}`,
    '# HELP pulse_workflow_transition_failures_total Workflow transition rollbacks since process start',
    '# TYPE pulse_workflow_transition_failures_total counter',
    `pulse_workflow_transition_failures_total ${m.workflow_transition_failures}`,
    '# HELP pulse_validation_failures_total Validation engine rejections since process start',
    '# TYPE pulse_validation_failures_total counter',
    `pulse_validation_failures_total ${m.validation_failures}`,
    '# HELP pulse_rules_triggered_total Rule engine triggers since process start',
    '# TYPE pulse_rules_triggered_total counter',
    `pulse_rules_triggered_total ${m.rules_triggered}`,
    '# HELP pulse_notification_failures_total Notification delivery failures since process start',
    '# TYPE pulse_notification_failures_total counter',
    `pulse_notification_failures_total ${m.notification_failures}`,
  ];

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ── API documentation ───────────────────────────────────────────────
// swaggerSetup mounts /api/docs and /api/docs/json. It was written but never
// called, so the API Documentation page had no spec to download. Must be
// registered before v1Router, whose "/" catch-all would otherwise swallow it.
await setupSwagger(app);

// ── Mount versioned routes AFTER the public endpoints above ──────────────────
// Payment webhooks must be outside v1Router (no auth, raw body needed).
app.use("/api/webhooks", webhooksRoutes);
app.use("/api/v1", v1Router);
app.use("/api",    v1Router);

// ── GLOBAL ERROR HANDLER (must be last) ──────────────────────────────────────
app.use(errorHandler);

const REQUIRED_TABLES = [
  'users', 'employees', 'approvals', 'notifications',
  'workflow_instances', 'audit_logs', 'schema_migrations',
];

async function assertRequiredTables() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map(r => r.table_name));
  const missing = REQUIRED_TABLES.filter(t => !found.has(t));
  if (missing.length) {
    console.error('[startup] FATAL: Required DB tables are missing:');
    missing.forEach(t => console.error(`  • ${t}`));
    console.error('  Run migrations (npm run migrate) and restart.');
    process.exit(1);
  }
}

const PORT = process.env.PORT || 5000;
async function startServer() {
  await runMigrations();
  await assertRequiredTables();
  app.listen(PORT, () => {
    console.log(`✅ Pulse ERP on port ${PORT}`);
    logFeatureFlags();
    registerEventReactions();
    startProbationCron();
    startHealthMonitor(pool);
    startDeliveryFollowupCron();
    startEsignReminderCron();
    startBackupCron();
    startIotMonitorCron();
    startIotOutboxCron();
    startIotPartitionCron();
    startAmcRenewalCron();
    startSubscriptionRenewalCron();
    startWarrantyExpiryCron();
    startOverdueRemindersCron();
    startScurveSnapshotCron();
    startKpiDigestCron();
    startDepartmentDigestCron();
    startAnomalyDetectionCron();
    startQuotationExpiryCron();
    startCrmFollowupCron();
    startTenderDeadlineCron();
    startCampaignLifecycleCron();
    // Reads sequence_enrollments.next_send_at, which nothing read before —
    // every enrolment sat at step 0 while the screen called it active.
    startMarketingJourneyCron();
    startReorderPrCron();
    startDepreciationCron();
    startFnfAutoTriggerCron();
    startExitStatusSyncCron();
    startVendorDocExpiryCron();
    startInterviewReminderCron();
    startComplianceRemindersCron();
    startCalibrationDueAlertsCron();
    startNcrEscalationCron();
    startPatentRenewalCron();
    startAssetWarrantyExpiryCron();
    startMaintenanceDueCron();
    startMrpAutoRunCron();
    startSlaEscalationCron();
    startWorkflowEscalationCron();
    startDocumentExpiryCron();
    startCustomerHealthRecalcCron();
    startVendorHealthRecalcCron();
    startProcurementAlertsCron();
  });
}
startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
