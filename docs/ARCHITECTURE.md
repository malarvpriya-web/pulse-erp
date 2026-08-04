# Pulse ERP — Architecture Reference

**Generated:** 2026-05-18 (Phase 12 post-stabilisation)
**Stack:** React 18 + Vite (frontend) · Node.js + Express 5 (backend) · PostgreSQL (database)
**Deployment:** Render.com — managed PostgreSQL, Node.js web service, static frontend

---

## 1. High-Level Architecture

```
Browser / PWA
      │
      │ HTTPS
      ▼
┌─────────────────────────────────────────────────────┐
│  Frontend  (Render static)                          │
│  React 18 + Vite — SPA + lazy-loaded pages          │
│  baseURL: https://erp.manifest-tech.in               │
└────────────────────┬────────────────────────────────┘
                     │ Axios  /api/...
                     ▼
┌─────────────────────────────────────────────────────┐
│  Backend  (Render web service — Node.js)            │
│  Express 5 · single process                        │
│  PORT: 10000 (Render) / 5000 (local)               │
│  Entry: backend/server.js                          │
└────────────────────┬────────────────────────────────┘
                     │ pg Pool
                     ▼
┌─────────────────────────────────────────────────────┐
│  PostgreSQL  (Render managed — pulse-db)           │
│  Migrations: src/database/migrations/ (31 files)   │
│  Schema tracking: schema_migrations table          │
└─────────────────────────────────────────────────────┘
```

---

## 2. Frontend Structure

```
frontend/src/
├── components/           # Shared UI: Layout, Topbar, Sidebar, ErrorBoundary, PWAInstallBanner
│   ├── analytics/        # AIAssistant (floating), AnomalyDetection
│   ├── auth/             # AuthContext wrapper
│   ├── core/             # Common inputs, modals
│   └── dashboard/        # DashboardEngine, widgets
├── config/
│   ├── routes.jsx        # ROUTES map — all 120+ lazy-loaded pages
│   ├── moduleRegistry.js # Module permission keys
│   └── autoRouter.js     # Dynamic route helpers
├── context/              # AuthContext (JWT + role + permissions)
├── features/             # Feature-by-module pages (see §4)
├── hooks/                # usePWA, custom hooks
├── pages/                # Top-level pages: Login, Home, dashboards
├── services/             # api/client.js (Axios, baseURL /api)
└── utils/                # Indian number formatting (₹, lakh/crore), helpers
```

**Routing pattern:** App.jsx has only two routes: `/login` and `/:page?`.
All page routing is done via `ROUTES[page]` in Layout.jsx.
Page names are simple strings (e.g. `"Payroll"`, `"GSTModule"`).

**Style convention:**
- Inline JSX styles only — no Tailwind, no CSS UI libraries
- Primary purple: `#7c3aed` · Light: `#f5f3ff` · Border: `#e9e4ff`
- Card: `background #fff`, `border 1px solid #f0f0f4`, `borderRadius 12px`

**API client:** `import api from '@/services/api/client'` — Axios instance,
`baseURL: http://localhost:5000/api` (dev) / `VITE_API_URL` (prod).
Interceptor attaches `Authorization: Bearer <token>` from localStorage.

**DEV fallback pattern:** `import.meta.env.DEV` guard + `Promise.allSettled`
so pages degrade gracefully when backend is offline.

---

## 3. Backend Structure

```
backend/
├── server.js             # Entry point — app setup, route registration, startup
├── src/
│   ├── auth/             # auth.routes.js — login, refresh, password
│   ├── employees/        # employee.routes.js — CRUD + file uploads
│   ├── home/             # home.routes.js — public home data
│   ├── notes/            # note.routes.js
│   ├── announcements/    # announcement.routes.js
│   ├── probation/        # probation.routes.js + cron job
│   ├── config/
│   │   ├── db.js         # pg Pool (SINGLE instance for entire app)
│   │   ├── migrations.js # Migration runner + tamper detection
│   │   ├── featureFlags.js
│   │   ├── metrics.js    # In-process request/error counters
│   │   └── knex.js       # Knex shim (used only by migration runner)
│   ├── database/
│   │   └── migrations/   # 31 migration files (see §7)
│   ├── middlewares/       # auth.middleware.js, rateLimit.js, errorHandler,
│   │                      #   requestLogger, requestId, correlationContext
│   ├── modules/           # Feature modules (see §4)
│   ├── routes/            # DEPRECATED parallel routing (see §9)
│   ├── services/          # WorkflowService, PermissionService, AuditService,
│   │                      #   RuleEngineService, ValidationEngineService,
│   │                      #   WorkflowNotificationService
│   ├── analytics/         # analytics.routes.js (top-level analytics)
│   ├── jobs/              # probation.cron.js, healthMonitor.cron.js,
│   │                      #   deliveryFollowup.cron.js
│   └── __tests__/         # Vitest test suite (see §8)
```

**DB pool:** `src/config/db.js` is the ONLY pool instance. Modules import via:
- `import pool from '../../config/db.js'`  (from modules/X/routes/)
- `import pool from '../../../config/db.js'` (from modules/X/sub/routes/)
- `import pool from '../shared/db.js'` — re-exports config/db.js (alias)

---

## 4. Module Map

| Domain | Backend Module | Frontend Feature | API Prefix |
|--------|---------------|-----------------|------------|
| Auth | `src/auth/` | `pages/Login` | `/api/auth` |
| Employees | `src/employees/` | `features/employees/` | `/api/employees` |
| HR | `modules/hr/` | `features/hr/` | `/api/hr` |
| Leaves | `modules/leaves/` | `features/leaves/` | `/api/leaves` |
| Attendance | `modules/attendance/` | `features/attendance/` | `/api/attendance` |
| Payroll | `modules/payroll/` | `features/hr/pages/Payroll` | `/api/payroll` |
| Salary Structure | `modules/payroll/salaryStructure.routes.js` | `features/hr/pages/SalaryStructure` | `/api/salary-structures` |
| Performance | `modules/performance/` | `features/performance/` | `/api/performance` |
| Recruitment | `modules/recruitment/` | `features/recruitment/` | `/api/recruitment` |
| Talent | `modules/talent/` | `features/talent/` | `/api/talent` |
| Training | `modules/hr/training.routes.js` | `features/hr/pages/LearningDevelopment` | `/api/training` |
| Succession | `modules/hr/succession.routes.js` | `features/hr/pages/SuccessionPlanning` | `/api/succession` |
| Biometric | `modules/hr/biometric.routes.js` | `features/hr/pages/BiometricAccess` | `/api/biometric` |
| Self-Service | `modules/hr/selfservice.routes.js` | `features/hr/pages/EmployeeSelfService` | `/api/self-service` |
| Exit | `modules/hr/exit.routes.js` | `features/hr/pages/ExitManagement` | `/api/exit` |
| Finance | `modules/finance/routes/finance.routes.js` | `features/finance/` | `/api/finance` |
| Finance (ext) | `modules/finance/routes/extended.routes.js` | same | `/api/finance` |
| Finance (new) | `modules/finance/finance.routes.js` | same | `/api/finance` |
| Accounting | `modules/finance/accounting.routes.js` | `pages/AccountingEngine` | `/api/accounting` |
| GST | `modules/finance/gst.routes.js` | `pages/GSTModule` | `/api/gst` |
| TDS | `modules/finance/tds.routes.js` | finance pages | `/api/tds` |
| Budgets | `modules/finance/budget.routes.js` | `pages/BudgetManagement` | `/api/budgets` |
| Fixed Assets | `modules/finance/assets.routes.js` | `pages/FixedAssets` | `/api/fixed-assets` |
| Forex | `modules/finance/forex.routes.js` | `pages/ForexManagement` | `/api/forex` |
| Procurement | `modules/procurement/routes/procurement.routes.js` | `features/procurement/` | `/api/procurement` |
| Vendors/RFQ | `modules/procurement/routes/vendor.routes.js` | `pages/VendorManagement` | `/api/vendors` |
| Inventory | `modules/inventory/routes/inventory.routes.js` | `features/inventory/` | `/api/inventory` |
| Adv. Inventory | `modules/inventory/routes/advancedInventory.routes.js` | same | `/api/inventory` |
| Warehouse | `modules/warehouse/warehouse.routes.js` | inventory pages | `/api/warehouse` |
| Logistics | `modules/logistics/logistics.routes.js` | inventory pages | `/api/logistics` |
| Quality | `modules/quality/quality.routes.js` | features/quality | `/api/quality` |
| Test Historian | `modules/quality/testHistorian.routes.js` | same | `/api/quality/tests` |
| BOM/MRP | `modules/production/bom.routes.js` | `pages/BOMBuilder` | `/api/bom` |
| Production Exec | `modules/production/execution.routes.js` | production pages | `/api/production` |
| Engineering | `modules/engineering/engineering.routes.js` | `features/engineering/` | `/api/engineering` |
| ECN | `modules/engineering/ecn.routes.js` | same | `/api/engineering` |
| Projects | `modules/projects/routes/projects.routes.js` | `features/projects/` | `/api/projects` |
| Tasks | `modules/projects/routes/tasks.routes.js` | same | `/api/tasks` |
| Gantt | `modules/projects/gantt.routes.js` | `pages/GanttChart` | `/api/gantt` |
| Timesheets | `modules/timesheets/routes/timesheets.routes.js` | `features/timesheets/` | `/api/timesheets` |
| CRM | `modules/crm/routes/crm.routes.js` | `features/crm/` | `/api/crm` |
| CRM Email | `modules/crm/routes/email.routes.js` | `pages/CRMEmail` | `/api/crm` |
| Customer 360 | `modules/crm/routes/customer360.routes.js` | `pages/Customer360` | `/api/crm` |
| Pipeline | `modules/crm/routes/pipeline.routes.js` | `pages/PipelineAutomation` | `/api/pipeline` |
| Sales | `modules/sales/routes/sales.routes.js` | `features/sales/` | `/api/sales` |
| Pricing Engine | `modules/sales/routes/pricing.routes.js` | `pages/PricingEngine` | `/api/pricing` |
| Commissions | `modules/sales/routes/commission.routes.js` | `pages/CommissionManagement` | `/api/commissions` |
| Fulfilment | `modules/sales/fulfilment.routes.js` | sales pages | `/api/delivery` |
| Marketing | `modules/marketing/routes/marketing.routes.js` | `features/marketing/` | `/api/marketing` |
| Master Data | `modules/master/master.routes.js` | `pages/MasterSetup` | `/api/master` |
| Operations | `modules/operations/operations.routes.js` | `features/operations/` | `/api/operations` |
| Lifecycle | `modules/operations/lifecycle.routes.js` | same | `/api/lifecycle` |
| Maintenance | `modules/maintenance/maintenance.routes.js` | same | `/api/maintenance` |
| Workflow Builder | `modules/admin/workflow.routes.js` | `pages/WorkflowBuilder` | `/api/workflows` |
| Security | `modules/admin/security.routes.js` | `pages/SecurityCenter` | `/api/security` |
| Admin | `modules/admin/admin.routes.js` | `features/admin/` | `/api/admin` |
| Travel | `modules/travel/travel.routes.js` | `features/travel/` | `/api/travel` |
| Reports | `modules/reports/routes/reports.routes.js` | `features/reports/` | `/api/reports` |
| Documents | `modules/documents/routes/documents.routes.js` | `features/documents/` | `/api/documents` |
| Notifications | `modules/notifications/routes/notifications.routes.js` | `features/notifications/` | `/api/notifications` |
| Audit | `modules/audit/routes/audit.routes.js` | `features/audit/` | `/api/audit` |
| Org Chart | `modules/orgchart/routes/orgchart.routes.js` | `features/orgchart/` | `/api/orgchart` |
| Approvals | `modules/approvals/approvals.routes.js` | `features/approvals/` | `/api/approvals` |
| Dashboard | `modules/dashboard/dashboard.routes.js` | `components/dashboard/` | `/api/dashboard` |
| Servicedesk | `modules/servicedesk/routes/servicedesk.routes.js` | `features/servicedesk/` | `/api/servicedesk` |
| Complaints | `modules/complaints/complaints.routes.js` | `features/complaints/` | `/api/complaints` |
| Tally | `modules/integrations/tally.routes.js` | `pages/TallyIntegration` | `/api/integrations/tally` |
| WhatsApp | `modules/integrations/whatsapp.routes.js` | integrations hub | `/api/integrations/whatsapp` |
| Payment GW | `modules/integrations/payment.routes.js` | `pages/PaymentGateway` | `/api/payments` |
| AI/Intelligence | `modules/intelligence/ai.routes.js` + `intelligence.routes.js` | `features/ai/` | `/api/ai`, `/api/intelligence` |
| Analytics | `analytics/routes/analytics.routes.js` | `features/analytics/` | `/api/analytics` |
| Holidays | `modules/holidays/routes/holidays.routes.js` | `pages/HolidayCalendar` | `/api/holidays` |

---

## 5. Auth & Permission Flow

```
Request → requestId middleware → requestLogger middleware
       → verifyToken (JWT decode + user hydration)
       → route handler
             │
             └─ optional: requirePermission(module, action)
                          → DB lookup: user_permissions, role_permissions
                          → 403 if denied
```

**JWT payload:** `{ userId, role, iat, exp }`
**Roles:** `super_admin`, `admin`, `hr`, `manager`, `employee`
**Auth middleware:** `src/middlewares/auth.middleware.js`
- `verifyToken` — decodes JWT, sets `req.user`
- `allowRoles(...roles)` — hard role gate
- `requirePermission(module, action)` — soft permission check with DB lookup + per-request cache

**Permission actions:** `can_view`, `can_add`, `can_edit`, `can_delete`, `can_approve`
Shorthand aliases: `view`, `add`, `edit`, `delete`, `approve`

**Passthrough rule:** If no permission row exists for (user/role, module), access is ALLOWED.
This is an intentional open-by-default design.

---

## 6. Route Versioning & Aliases

The backend serves the same v1Router at two paths:
```
/api/v1/...  ← canonical versioned path (future)
/api/...     ← backward-compat alias (all existing frontend calls)
```

**Route aliases in use (multiple prefixes → same router):**

| Prefixes | Router |
|----------|--------|
| `/api/vendors`, `/api/rfq`, `/api/three-way-match` | vendorRoutes |
| `/api/forex`, `/api/statements` | forexRoutes |
| `/api/shipments`, `/api/eway-bills`, `/api/logistics` | logisticsRoutes |
| `/api/biometric`, `/api/gate-passes`, `/api/visitors` | biometricRoutes |
| `/api/leaves`, `/api/leaves-new` | leavesNewRoutes |
| `/api/delivery`, `/api/credit` | fulfilmentRoutes |
| `/api/servicedesk`, `/api/sla`, `/api/tickets` | servicedeskRoutes |
| `/api/master`, `/api/admin/config` | masterRoutes |
| `/api/engineering` | engineeringRoutes + ecnRoutes (two routers) |
| `/api/bom`, `/api/mrp`, `/api/work-centres`, `/api/capacity` | bomRoutes |
| `/api/crm` | crmRoutes + crmEmailRoutes + customer360Routes (three routers) |
| `/api/finance` | financeRoutes + extendedFinanceRoutes + financeNewRoutes (three routers) |
| `/api/ai`, `/api/ai-core` | aiRoutes |
| `/api/inventory` | inventoryRoutes + advInventoryRoutes |

**Note:** Multiple routers on the same prefix is intentional (modular separation
within a domain). Express handles them sequentially; only the first matching handler
responds.

---

## 7. Database Migrations

Located: `backend/src/database/migrations/`
Runner: `src/config/migrations.js` — file-sorted, checksum-tracked, transactional

| File | Purpose |
|------|---------|
| `20260330000000_core_schema.js` | users, employees, core tables |
| `20260422000001_observability.js` | audit_logs, request_logs |
| `20260423000001_accounting_schema.js` | chart_of_accounts, journal_entries |
| `20260424000001_leaves_schema.js` | leave_types, leave_requests |
| `20260424000002_payroll_schema.js` | payroll_runs, salary_components |
| `20260426000001_module_tables.js` | CRM, sales, procurement tables |
| `20260427000001_remaining_tables.js` | projects, timesheets, inventory |
| `20260427000002_performance_columns.js` | performance review columns |
| `20260428000001_platform_foundation.js` | workflow_definitions, notifications |
| `20260428000002_company_branch_columns.js` | multi-branch support |
| `20260429000001_workflow_engine.js` | workflow_instances, workflow_steps |
| `20260429000002_rule_validation.js` | rules_master, validation_rules ⚠️ |
| `20260429000002_workflow_sla_columns.js` | workflow SLA timestamps ⚠️ |
| `20260430000001_audit_log_columns.js` | audit_log enhancements |
| `20260505000001_extract_inline_ddl.js` | Migrates inline DDL from route files |
| `20260506000001_fix_accounting_schema.js` | Accounting schema corrections |
| `20260506000002_fix_invoice_gst_columns.js` | GST column fixes |
| `20260506000003_gstin_validation_constraint.js` | GSTIN format constraint |
| `20260506000004_hsn_sac_codes.js` | HSN/SAC reference table |
| `20260506000005_credit_debit_notes.js` | Credit/debit note tables |
| `20260506000006_expand_chart_of_accounts.js` | Extended CoA |
| `20260506000007_tds_lower_deduction.js` | TDS lower deduction certs |
| `20260506000008_rcm_self_invoices.js` | RCM self-invoicing |
| `20260506000009_engineering_change_control.js` | ECN tables |
| `20260506000010_production_execution.js` | Work orders, production runs |
| `20260506000011_test_historian.js` | Quality test historian tables |
| `20260506000012_lifecycle_state_machine.js` | Asset/lifecycle state machine |
| `20260506000013_shift_assignments_rotations.js` | Shift management |
| `20260506000014_offboarding_checklists.js` | Exit/offboarding checklists |
| `20260507000001_bom_ecn_linkage.js` | BOM ↔ ECN foreign keys |
| `20260518000001_payroll_stabilization.js` | Payroll schema stabilisation (RC4) |

⚠️ Two files share timestamp `20260429000002`. Both run correctly (tracked by filename).
Do NOT rename if already applied to production — see comments in those files.

---

## 8. Test Suite

**Runner:** Vitest · `backend/npm run test`
**Location:** `backend/src/__tests__/`

| File | What is Covered |
|------|----------------|
| `auth.middleware.test.js` | verifyToken — valid/expired/wrong-secret/malformed tokens |
| `permissions.test.js` | requirePermission — allow/deny/passthrough for 7 modules |
| `payrollEngine.test.js` | computeIncomeTax (new/old regime, 87A rebate, cess), computePT |
| `workflowTransitions.test.js` | advanceWorkflow — valid/closed/invalid/skip-step/wrong-role/SLA/terminal |
| `auditLog.test.js` | AuditService.log() — writes + queries |
| `engineHooks.test.js` | RuleEngineService + ValidationEngineService hooks |
| `integration.criticalFlow.test.js` | Sales order → BOM/MRP → dispatch (mocked DB) |
| `smoke.auth.test.js` | POST /api/auth/login, /register, /logout |
| `smoke.employees.test.js` | CRUD /api/employees — 401 gate, list, create |
| `smoke.leaves.test.js` | Leaves CRUD — apply, approve, reject |
| `smoke.payroll.test.js` | Payroll list, summary, run, payslip endpoints |
| `smoke.sales.test.js` | Sales orders — create, list, status transitions |
| `phase1.test.js` | Phase 1 integration regression |
| `phase2.test.js` | Phase 2 integration regression |
| `phase3.test.js` | Phase 3 integration regression |

**Missing coverage (Phase 12D additions):**
- Inventory transactions (stock-in / stock-out / movement)
- Approval workflow end-to-end
- CRM pipeline stage conversion

---

## 9. Known Technical Debt

See `docs/TECHNICAL_DEBT.md` for full details.

Quick reference:
1. **Dead parallel routing** — `src/routes/index.js` not mounted (annotated `@deprecated`)
2. **Split middleware dirs** — `src/middleware/` vs `src/middlewares/` (single stray file)
3. **Duplicate migration timestamp** — `20260429000002` x2 (safe, documented)
4. **Three finance routers** on `/api/finance` — should be one cohesive file
5. **Legacy leaves module** — `src/leaves/` superseded by `modules/leaves/` (annotated)
6. **Orphaned integration routes** — zoho-sign, zoho-books, email, webhooks not in server.js
7. **aiPayroll module** — `modules/analytics/aiPayroll.*` not in server.js
8. **Loose backend test scripts** — `test-*.js` at `backend/` root (not in `__tests__/`)

---

## 10. Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `JWT_SECRET` | Yes | — | JWT signing secret (min 32 chars recommended) |
| `DATABASE_URL` | Yes* | — | PostgreSQL connection string |
| `DB_PASSWORD` | Yes* | — | Alternative to DATABASE_URL |
| `PORT` | No | 5000 | HTTP listen port |
| `NODE_ENV` | No | development | `production` enables CORS restriction |
| `FRONTEND_URL` | Yes (prod) | — | Allowed CORS origin in production |
| `ALERT_WEBHOOK_URL` | No | — | Slack/PagerDuty webhook for health alerts |
| `ALERT_THRESHOLD_MS` | No | 800 | DB latency (ms) before alert fires |
| `MEMORY_ALERT_MB` | No | 450 | RSS memory (MB) threshold for alert |
| `LOG_TO_FILE` | No | false | Write JSONL logs to `logs/*.log` |
| `WORKFLOW_ENGINE_ENABLED` | No | true | Feature flag — workflow engine |
| `RULE_ENGINE_ENABLED` | No | true | Feature flag — rule engine |
| `VALIDATION_ENGINE_ENABLED` | No | true | Feature flag — validation engine |
| `NOTIFICATION_ENGINE_ENABLED` | No | true | Feature flag — notification engine |
| `VITE_API_URL` | Yes (prod FE) | — | Frontend: backend API base URL |
| `RENDER_GIT_COMMIT` | Auto (Render) | null | Injected by Render — shown in /api/health |
| `RENDER_SERVICE_ID` | Auto (Render) | null | Injected by Render — shown in /api/health |

*Either `DATABASE_URL` or `DB_PASSWORD` must be set.

---

## 11. Deployment

**Platform:** Render.com (`render.yaml` at repo root)

```
npm run deploy
  = npm run pre-deploy
  + npm run migrate
  + npm run post-deploy
```

**Health check:** `GET /api/health` — returns DB status, migration status, metrics, memory.
- HTTP 200 = healthy
- HTTP 503 = degraded (DB error or missing tables)

**Startup sequence:**
1. Check required env vars (fatal exit if missing)
2. runMigrations() — apply pending migrations
3. assertRequiredTables() — fatal exit if core tables missing
4. app.listen() → logFeatureFlags, start cron jobs

**Cron jobs started at startup:**
- `startProbationCron()` — evaluates probation periods
- `startHealthMonitor(pool)` — periodic DB latency check + alerts
- `startDeliveryFollowupCron()` — delivery follow-up reminders

---

## 12. PWA (Progressive Web App)

Frontend is a full PWA:
- `public/manifest.json` — name "Pulse ERP", theme `#7c3aed`, standalone display
- `public/sw.js` — cache-first static, network-first API, offline fallback, background sync
- `src/hooks/usePWA.js` — install prompt, SW registration, update detection
- `src/components/PWAInstallBanner.jsx` — offline/update/install banners

---

*This document was generated during Phase 12 post-stabilisation cleanup.*
*Update when adding new modules, routes, or environment variables.*
