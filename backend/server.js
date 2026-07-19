import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
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
import salesRoutes            from "./src/modules/sales/routes/sales.routes.js";
import salesPartnersRoutes    from "./src/modules/sales/routes/partners.routes.js";
import salesCommandCenterRoutes from "./src/modules/sales/routes/sales-command-center.routes.js";
import pricingRoutes          from "./src/modules/sales/routes/pricing.routes.js";
import commissionRoutes       from "./src/modules/sales/routes/commission.routes.js";
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
import aiPayrollRoutes        from "./src/modules/analytics/aiPayroll.routes.js";
import userDashboardRoutes    from "./src/modules/analytics/user-dashboard.routes.js";

import helmet from "helmet";
import { verifyToken, allowRoles } from "./src/middlewares/auth.middleware.js";
import { auditLogger }   from "./src/middlewares/auditLogger.js";
import { sanitizeErrorResponse } from "./src/middlewares/errorSanitizer.js";
import { requestId }     from "./src/middlewares/requestId.js";
import { requestLogger } from "./src/middlewares/requestLogger.js";
import { memoryRateLimit } from "./src/middlewares/rateLimit.js";
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
// In production, FRONTEND_URL must be set explicitly (enforced above).
const corsOrigin = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000']
  : (origin, callback) => {
      if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin not allowed — ${origin}`));
    };

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  exposedHeaders: ['X-Request-ID'],
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
v1Router.use("/employees",       employeeRoutes);
v1Router.use("/notes",           noteRoutes);
v1Router.use("/announcements",   announcementRoutes);
v1Router.use("/probation",       probationRoutes);
v1Router.use("/leaves",          verifyToken, leavesNewRoutes);
v1Router.use("/comp-off",        verifyToken, compOffRoutes);
v1Router.use("/leave-encashment", verifyToken, encashmentRoutes);
v1Router.use("/leave-accrual",   verifyToken, accrualRoutes);

// FINANCE
v1Router.use("/finance",         verifyToken, financeRoutes);
v1Router.use("/finance",         verifyToken, extendedFinanceRoutes);
v1Router.use("/statements",      verifyToken, statementsRoutes);
v1Router.use("/accounting",      verifyToken, accountingRoutes);
v1Router.use("/gst",             verifyToken, gstRoutes);
v1Router.use("/tds",             verifyToken, tdsRoutes);
v1Router.use("/tcs",             verifyToken, tcsRoutes);
v1Router.use("/budgets",         verifyToken, budgetRoutes);
v1Router.use("/fixed-assets",    verifyToken, assetsRoutes);
v1Router.use("/forex",           verifyToken, forexRoutes);
v1Router.use("/finance/credit-notes", verifyToken, creditNotesRoutes);
v1Router.use("/finance/debit-notes",  verifyToken, debitNotesRoutes);
v1Router.use("/finance/cost-centers", verifyToken, costCentersRoutes);

// PROCUREMENT & INVENTORY
v1Router.use("/procurement",     verifyToken, procurementRoutes);
// vendorRoutes defines explicit top-level paths (/vendors, /rfqs, /three-way-match).
// Scope verifyToken to those prefixes — mounting it bare at "/" alongside the router
// makes verifyToken a GLOBAL auth gate that also 401s public routes registered later
// (e.g. /sign, /customer-portal). The router itself mounts at "/" without auth so it
// only matches its own paths and falls through otherwise.
v1Router.use(["/vendors", "/rfqs", "/three-way-match"], verifyToken);
v1Router.use("/",                vendorRoutes);
v1Router.use("/inventory",       verifyToken, inventoryRoutes);
v1Router.use("/warehouse",       verifyToken, warehouseRoutes);
v1Router.use("/logistics",       verifyToken, logisticsRoutes);
v1Router.use("/quality",                    verifyToken, qualityRoutes);
v1Router.use("/engineering/tests",          verifyToken, testHistorianRoutes);
v1Router.use("/quality/disturbance-events", verifyToken, disturbanceRoutes);

// PRODUCTION
v1Router.use("/bom",             verifyToken, bomRoutes);
v1Router.use("/production",      verifyToken, productionExecutionRoutes);
v1Router.use("/imr",             verifyToken, imrRoutes);
v1Router.use("/mrp",             verifyToken, mrpRoutes);
v1Router.use("/crp",             verifyToken, crpRoutes);
v1Router.use("/subcontracting",  verifyToken, subcontractingRoutes);
v1Router.use("/genealogy",       verifyToken, genealogyRoutes);
v1Router.use("/mfg",             verifyToken, bomModelingRoutes);
v1Router.use("/sop",             verifyToken, sopRoutes);

// PROJECTS
v1Router.use("/projects",        verifyToken, projectRoutes);
v1Router.use("/projects",        verifyToken, orderHistoryRoutes); // CEO full-history traceability
v1Router.use("/project-members", projectMembersRoutes);
v1Router.use("/tasks",           verifyToken, taskRoutes);
v1Router.use("/gantt",           verifyToken, ganttRoutes);

// HR & PAYROLL
v1Router.use("/timesheets",      verifyToken, timesheetRoutes);
v1Router.use("/performance",              verifyToken, performanceRoutes);
v1Router.use("/performance/cycles",       verifyToken, perfCyclesRoutes);
v1Router.use("/performance/kras",         verifyToken, perfKRARoutes);
v1Router.use("/performance/feedback",     verifyToken, perfFeedback360Routes);
v1Router.use("/performance/calibration",  verifyToken, perfCalibRoutes);
v1Router.use("/performance/increments",   verifyToken, perfIncRoutes);
v1Router.use("/performance/promotions",   verifyToken, perfPromoRoutes);
v1Router.use("/performance/reports",      verifyToken, perfReportsRoutes);
v1Router.use("/performance/okr",          verifyToken, perfOKRRoutes);
v1Router.use("/recruitment",     verifyToken, recruitmentRoutes);
v1Router.use("/talent",          verifyToken, talentRoutes);
v1Router.use("/leaves-new",      verifyToken, leavesNewRoutes); // backward-compat alias
v1Router.use("/attendance",         verifyToken, attendanceRoutes);
v1Router.use("/attendance/offline", verifyToken, offlineSyncRoutes); // PWA offline punch sync
v1Router.use("/holidays",           verifyToken, holidaysRoutes);
v1Router.use("/payroll",         verifyToken, payrollRoutes);
v1Router.use("/salary-structures", verifyToken, salaryRoutes);
v1Router.use("/hr",              verifyToken, hrRoutes);
v1Router.use("/training",        verifyToken, trainingRoutes);
v1Router.use("/certifications",  verifyToken, certificationsRoutes);
v1Router.use("/learning-paths",  verifyToken, learningPathsRoutes);
v1Router.use("/assessments",     verifyToken, assessmentsRoutes);
v1Router.use("/trainers",        verifyToken, trainersRoutes);
v1Router.use("/lnd-reports",     verifyToken, lndReportingRoutes);
v1Router.use("/competencies",    verifyToken, competencyRoutes);
v1Router.use("/knowledge",       verifyToken, knowledgeRoutes);
v1Router.use("/lnd-settings",    verifyToken, lndSettingsRoutes);
v1Router.use("/succession",      verifyToken, successionRoutes);
// biometric.routes.js defines full paths (/biometric/*, /gate-passes, /visitors).
// Scope verifyToken to those prefixes — a bare use(verifyToken, ...) mounts the guard
// at "/" and turns it into a global auth gate that blocks public routes registered later.
v1Router.use(["/biometric", "/gate-passes", "/visitors"], verifyToken);
v1Router.use(biometricRoutes);
v1Router.use("/self-service",    verifyToken, selfServiceRoutes);
v1Router.use("/employee-assets", employeeAssetsRoutes);
v1Router.use("/employee-skills", employeeSkillsRoutes);
v1Router.use("/hr-master",       hrMasterDataRoutes);
v1Router.use("/hr-widgets",      hrWidgetsRoutes);
v1Router.use("/onboarding",      verifyToken, onboardingRoutes);
v1Router.use("/exit",            verifyToken, exitRoutes);

// CRM & SALES
v1Router.use("/crm",             verifyToken, crmRoutes);
// /sales/partners is mounted FIRST: Express matches in registration order, and
// the general sales router would otherwise shadow it.
v1Router.use("/sales/partners",         verifyToken, salesPartnersRoutes);
v1Router.use("/sales",                  verifyToken, salesRoutes);
v1Router.use("/sales-command-center",   verifyToken, salesCommandCenterRoutes);
v1Router.use("/pricing",                verifyToken, pricingRoutes);
v1Router.use("/commissions",     verifyToken, commissionRoutes);
v1Router.use("/delivery",        verifyToken, fulfilmentRoutes);
v1Router.use("/marketing",       verifyToken, marketingRoutes);

// MASTER DATA
v1Router.use("/master",          verifyToken, masterRoutes);
v1Router.use("/admin/config",    verifyToken, masterRoutes);
v1Router.use("/wizard",          verifyToken, wizardRoutes);

// OPERATIONS & ADMIN
v1Router.use("/operations",      verifyToken, operationsRoutes);
v1Router.use("/lifecycle",       verifyToken, lifecycleRoutes);
v1Router.use("/maintenance",     verifyToken, maintenanceRoutes);
v1Router.use("/workflows",       verifyToken, workflowRoutes);
v1Router.use("/security",        verifyToken, securityRoutes);
v1Router.use("/admin",           verifyToken, adminRoutes);
v1Router.use("/settings",        verifyToken, settingsStatusRoutes);
v1Router.use("/system-health",   verifyToken, allowRoles('admin', 'super_admin'), systemHealthRoutes);   // live DB table introspection — admin-only diagnostic
v1Router.use("/company-profile", verifyToken, companyProfileRoutes);
v1Router.use("/branches",        verifyToken, branchManagementRoutes);
v1Router.use("/travel",               verifyToken, travelRoutes);
v1Router.use("/customer-visits",      verifyToken, customerVisitsRoutes);
v1Router.use("/reimbursement",        verifyToken, travelReimbursementRoutes);
v1Router.use("/travel-policy",        verifyToken, travelPolicyRoutes);
v1Router.use("/travel-audit",         verifyToken, travelAuditRoutes);
v1Router.use("/visit-reports",        verifyToken, visitReportsRoutes);

// Phase X — Commercial, Travel & Vendor Ecosystem
v1Router.use("/vendor-portal",        verifyToken, vendorPortalRoutes);
v1Router.use("/vendor-360",           verifyToken, vendor360Routes);
// Phase 49C — Vendor Registration Portal (mixed auth — public submit inside the router)
v1Router.use("/vendor-registration",  vendorRegistrationRoutes);
v1Router.use("/vendor-approval",      verifyToken, vendorApprovalRoutes);
v1Router.use("/vendor-health",        verifyToken, vendorHealthRoutes);
v1Router.use("/project-profitability",verifyToken, projectProfitabilityRoutes);
v1Router.use("/project-360",          verifyToken, project360Routes);
v1Router.use("/delivery-tracker",     verifyToken, deliveryTrackerRoutes); // IPM<->IPP production/fulfilment grid
// Phase 46 — Project Cost & Profitability Engine
v1Router.use("/project-cost-engine",  verifyToken, projectCostEngineRoutes);
v1Router.use("/sales-funnel",         verifyToken, salesFunnelRoutes);

// SUPPORT
v1Router.use("/reports",         verifyToken, reportsRoutes);
v1Router.use("/documents",       verifyToken, documentsRoutes);
v1Router.use("/signatures",      verifyToken, signaturesRoutes);
// Public no-login signing surface — token-gated inside the router (like customer-portal)
v1Router.use("/sign",            publicSignRoutes);
v1Router.use("/document-master", verifyToken, documentMasterRoutes);
v1Router.use("/qr-codes",        verifyToken, qrShareRoutes);
// Public QR resolution — token-gated inside the router (QR images encode /api/v1/q/:token)
v1Router.use("/q",               publicQrRoutes);
v1Router.use("/notifications",   verifyToken, notificationsRoutes);
v1Router.use("/audit",           verifyToken, auditRoutes);
v1Router.use("/orgchart",        orgChartRoutes);
v1Router.use("/approvals",       verifyToken, approvalsRoutes);
v1Router.use("/dashboard",       verifyToken, dashboardRoutes);
// IPS (Service Master) is mounted ahead of the general servicedesk router so its
// /ips/* paths resolve here rather than falling through that router first.
v1Router.use("/servicedesk/ips", verifyToken, ipsRoutes);
v1Router.use("/servicedesk",     verifyToken, servicedeskRoutes);
v1Router.use("/complaints",      verifyToken, complaintsRoutes);

// Phase 51 — Customer Portal (mixed auth), Commissioning, Service/Failure Analytics, VOC
v1Router.use("/customer-portal",    customerPortalRoutes);      // mixed: /auth/login public, /portal/* portal-token, /accounts/* verifyToken
v1Router.use("/commissioning",      verifyToken, commissioningRoutes);
v1Router.use("/service-analytics",  verifyToken, serviceAnalyticsRoutes);
v1Router.use("/failure-analytics",  verifyToken, failureAnalyticsRoutes);
v1Router.use("/voc",                vocRoutes);                  // POST /responses is public (portal submit)

// IoT / Device Telemetry (Phase 1) — device-token auth inside the router, NOT verifyToken
v1Router.use("/iot",                iotIngestRoutes);            // POST /iot/ingest is device-token-gated
v1Router.use("/iot",                verifyToken, iotDevicesRoutes); // fleet API — falls through from ingest, user-authed
v1Router.use("/compliance",         verifyToken, complianceRoutes);
v1Router.use("/assets",             verifyToken, unifiedAssetsRoutes); // read-only consolidation over fixed_assets/assets_register/allocations
v1Router.use("/rd",                 verifyToken, rdRoutes); // R&D artifact repo + patents + product lifecycle (PLM)
v1Router.use("/tenders",            verifyToken, tenderRoutes); // Government tender workspace over opportunities

// INTEGRATIONS
v1Router.use("/integrations/tally",    verifyToken, tallyRoutes);
v1Router.use("/integrations/whatsapp", verifyToken, whatsappRoutes);
v1Router.use("/payments",              verifyToken, paymentGWRoutes);

// GLOBAL SEARCH (Phase 35F)
v1Router.use("/global-search",   verifyToken, globalSearchRoutes);

// SECURE FILE DOWNLOADS (Phase 42E) — replaces public /uploads static
v1Router.use("/files",           secureFilesRoutes); // verifyToken is inside the router

// ENGINEERING
// /development is mounted FIRST: Express matches in registration order, and the
// general engineering router would otherwise shadow it.
v1Router.use("/engineering/development", verifyToken, engDevelopmentRoutes);
v1Router.use("/engineering",     verifyToken, engineeringRoutes);
v1Router.use("/engineering/ecn", verifyToken, ecnRoutes);

// AI — combined router (aiRoutes: /ceo-insights, /llm-chat, /chat, /anomalies, /predictions, /smart-search
//       aiPayrollRoutes: /payroll/trends, /payroll/departments, /payroll/anomalies, /cashflow/forecast, /query)
const aiCombined = express.Router();
aiCombined.use(aiRoutes);
aiCombined.use(aiPayrollRoutes);
v1Router.use("/ai",              verifyToken, aiCombined);
v1Router.use("/intelligence",      verifyToken, intelligenceRoutes);
v1Router.use("/ceo-intelligence",  verifyToken, ceoIntelligenceRoutes);
v1Router.use("/analytics",       verifyToken, analyticsRoutes);
v1Router.use("/user-dashboard",  verifyToken, userDashboardRoutes);

// INTEGRATIONS (additions)
v1Router.use("/integrations/zoho-sign",  verifyToken, zohoSignRoutes);
v1Router.use("/integrations/zoho-books", verifyToken, zohoBooksRoutes);
v1Router.use("/integrations/config",     verifyToken, integrationsConfigRoutes);
v1Router.use("/integrations",            verifyToken, emailIntegrationRoutes);

// ── Frontend URL alias mounts — additional path prefixes expected by frontend ──
// These mirror existing routers at the URL patterns the UI actually uses.
v1Router.use("/hr/succession",                   verifyToken, successionRoutes);
v1Router.use("/succession/succession",           verifyToken, successionRoutes);   // /succession/succession/assessments
v1Router.use("/payroll/salary-structures",       verifyToken, salaryRoutes);
v1Router.use("/salary-structures/salary-structures", verifyToken, salaryRoutes);  // /salary-structures/salary-structures
v1Router.use("/payroll",                         verifyToken, selfServiceRoutes);  // /payroll/it-declarations, etc.
v1Router.use("/employees/self-service",          verifyToken, selfServiceRoutes);
v1Router.use("/self-service/self-service",       verifyToken, selfServiceRoutes);  // /self-service/self-service/it-declarations
v1Router.use("/finance/accounting",        verifyToken, accountingRoutes);
v1Router.use("/finance/gst",               verifyToken, gstRoutes);
v1Router.use("/projects",                  verifyToken, timesheetRoutes); // /projects/timesheets alias

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
    const hasOrphans = mv.tamperWarnings.some(w => w.includes('missing from disk'));
    const hasModified = mv.tamperWarnings.some(w => w.includes('Checksum mismatch') || w.includes('was modified'));
    migrations = {
      status:  hasPending ? "pending" : (hasModified ? "warn" : "ok"),
      applied: mv.applied,
      total:   mv.total,
      pending: mv.missing.length,
      ...(mv.missing.length        && { missing_files:    mv.missing }),
      ...(mv.tamperWarnings.length && { tamper_warnings:  mv.tamperWarnings.length }),
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
    startProbationCron();
    startHealthMonitor(pool);
    startDeliveryFollowupCron();
    startEsignReminderCron();
    startBackupCron();
    startIotMonitorCron();
  });
}
startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
