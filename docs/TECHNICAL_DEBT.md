# Pulse ERP — Technical Debt & Observability Report

**Generated:** 2026-05-19 (Phase 12 post-stabilisation)
**Scope:** Backend dead code, route consistency, observability gaps, scalability risks

---

## 1. Dead Code Inventory

### 1A. Dead Routing System — `src/routes/index.js`

**Risk:** Low (not mounted, already deprecated)
**Status:** `@deprecated` comment added 2026-05-19

`src/routes/index.js` is a complete parallel routing table — a ~220-line file with
all module routers imported and mounted. It is NOT imported anywhere in `server.js`.
`server.js` builds its own `v1Router` directly.

**Routes in `src/routes/index.js` but NOT in `server.js`:**

| Route Prefix | File | Risk if deleted |
|---|---|---|
| `/api/webhooks` | `src/routes/webhooks.routes.js` | Medium — Razorpay/Stripe inbound webhooks would break if payment integrations are live |
| `/api/integrations/zoho-sign` | `modules/integrations/zoho-sign.routes.js` | Low — frontend page exists but no confirmed live usage |
| `/api/integrations/zoho-books` | `modules/integrations/zoho-books.routes.js` | Low — stub implementation |
| `/api/integrations` (email) | `modules/integrations/email.routes.js` | Low — stub |
| `/api/ai` (aiPayroll) | `modules/analytics/aiPayroll.routes.js` | Medium — may be called by AI pages |
| `/api/notifications-legacy` | `src/routes/notificationRoutes.js` | Low — module version covers all cases |
| `/api/leaves-legacy` | `src/leaves/leave.routes.js` | Low — `modules/leaves` is the active version |

**Action:** Before deleting, verify via frontend network tab and server access logs
that none of these paths are receiving live traffic.

### 1B. Split Middleware Directories

**Status: RESOLVED 2026-07-19 — deleted, not moved.**

The premise above was wrong. This entry (and the file's own header comment) claimed
`security.middleware.js` was "used only by `modules/admin/security.routes.js`". It was
imported by **nothing**. All six exports — `rateLimiter`, `ipWhitelist`, `sessionTimeout`,
`twoFactorCheck`, `auditLog`, `encryptField`/`decryptField` — had zero references
repo-wide.

That made it worse than clutter: during the 2026-07-18 security audit the presence of an
apparently-implemented `rateLimiter` masked the fact that nothing outside `/auth/*` was
throttled at all. Dead security code reads as a control that exists.

It also carried a hardcoded `ENCRYPTION_KEY` fallback (`'pulse_erp_default_32byte_key_here'`)
and derived its AES key by UTF-8 padding rather than a KDF — a live footgun for anyone who
had wired it up.

Deleted along with the now-empty `src/middleware/` directory. Real rate limiting lives in
`src/middlewares/rateLimit.js`. See `SECURITY_AUDIT_2026-07-18.md` H-1.

*(The file was never committed to git, so it is not recoverable from history.)*

### 1C. Duplicate Migration Timestamp

**Risk:** Cosmetic only (runtime behaviour correct)
**Files:** `20260429000002_rule_validation.js` and `20260429000002_workflow_sla_columns.js`

Both files share timestamp prefix `20260429000002`. Migration system tracks by
filename (not timestamp), so both applied correctly. Alphabetically,
`rule_validation` sorts before `workflow_sla_columns`, ensuring correct order.

Do NOT rename if already applied to production (would trigger re-run).
Both files have been annotated with explanatory comments.

### 1D. Legacy Leaves Module

**Risk:** Low (not mounted)
**Files:** `src/leaves/leave.routes.js`, `leave.controller.js`, `leave.service.js`

Superseded by `src/modules/leaves/routes/leaves.routes.js`.
The legacy module only handles apply/approve/reject.
Annotated `@deprecated` 2026-05-19.

### 1E. Loose Root-Level Test Scripts

**Risk:** Low (not in test suite)
**Files:** `backend/test-db.js`, `test-columns.js`, `test-notes.js`,
`test-status.js`, `test-status-flow.js`, `test-status-update.js`, `test-audit-logs.js`

These are ad-hoc DB connection scripts at the backend root, not part of
the Vitest suite. They are not harmful but add noise.

**Recommended action:** Move to `scripts/` directory or delete.

### 1F. aiPayroll Module (Orphaned)

**Risk:** Medium — may be called by AI pages
**Files:** `src/modules/analytics/aiPayroll.routes.js`, `.controller.js`, `.service.js`

Not registered in `server.js`. Only referenced in the (unmounted) `routes/index.js`.
If the AI Payroll page calls `/api/ai` or `/api/analytics/ai-payroll`, it will 404.

**Action before deleting:** Audit frontend network traffic for `/api/ai/*` paths.

---

## 2. Route Consistency Issues

### 2A. Three Finance Routers on One Prefix

`/api/finance` mounts three separate routers:
- `modules/finance/routes/finance.routes.js` (core invoices, bills)
- `modules/finance/routes/extended.routes.js` (extended finance features)
- `modules/finance/finance.routes.js` (newer finance additions)

**Risk:** Low at runtime (Express handles them in sequence). Medium for maintenance
(contributor must check three files to find a finance endpoint).

**Recommended future refactor:** Merge into one cohesive `finance.routes.js`.
Do NOT do this now — high regression risk.

### 2B. Multi-Router Same-Prefix Mounts (Alias Pattern)

The following are INTENTIONAL aliases (one router, multiple access paths):

| Aliases | Router | Rationale |
|---|---|---|
| `/vendors`, `/rfq`, `/three-way-match` | vendorRoutes | Vendor module handles all three |
| `/forex`, `/statements` | forexRoutes | Forex + bank statements |
| `/logistics`, `/shipments`, `/eway-bills` | logisticsRoutes | All logistics sub-domains |
| `/biometric`, `/gate-passes`, `/visitors` | biometricRoutes | All biometric domains |
| `/leaves`, `/leaves-new` | leavesNewRoutes | Backward compat alias |
| `/delivery`, `/credit` | fulfilmentRoutes | Fulfilment sub-domains |
| `/servicedesk`, `/sla`, `/tickets` | servicedeskRoutes | All servicedesk sub-domains |
| `/ai`, `/ai-core` | aiRoutes | AI path alias |
| `/master`, `/admin/config` | masterRoutes | Master data alias |

These aliases are acceptable and documented in `docs/ARCHITECTURE.md §6`.

### 2C. `/api/v1` vs `/api` Dual Mount

Both `v1Router` paths serve identical handlers:
```js
app.use("/api/v1", v1Router);   // canonical
app.use("/api",    v1Router);   // backward compat
```

**Risk:** None at runtime. Frontend must not be migrated to `/api/v1` until a
coordinated cutover. Keep both mounts indefinitely until frontend is updated.

---

## 3. Observability Gaps (Logging Audit)

### 3A. Request-Level Logging — COVERED

`requestLogger` middleware logs all requests (except `/api/health`, `/`) as
structured JSON with: timestamp, level, requestId, method, path, status, ms, ip, userId.

Writes to `logs/access.log` when `LOG_TO_FILE=true` (auto-enabled in production).

### 3B. AuditService Coverage — PARTIAL

`logAudit()` from `src/services/AuditService.js` is called by only **8 of ~50 modules**.

**Modules WITH audit logging:**

| Module | What is Logged |
|---|---|
| `modules/inventory/routes/inventory.routes.js` | create/update/delete items, movements |
| `modules/leaves/routes/leaves.routes.js` | apply, approve, reject leave |
| `modules/projects/routes/projects.routes.js` | create/update projects |
| `modules/finance/routes/finance.routes.js` | invoice create/update |
| `modules/finance/controllers/invoice.controller.js` | invoice actions |
| `modules/admin/admin.routes.js` | admin config changes |
| `modules/admin/security.routes.js` | security events |
| `modules/servicedesk/routes/servicedesk.routes.js` | ticket actions |

**Modules MISSING audit logging (high-priority gaps):**

| Module | Risk | Missing Events |
|---|---|---|
| `modules/approvals/` | HIGH | approve, reject, bulk-approve, escalate |
| `modules/payroll/` | HIGH | payroll run, payslip generation, salary changes |
| `modules/employees/` | HIGH | employee create/update/termination |
| `modules/hr/exit.routes.js` | HIGH | exit interviews, clearance |
| `modules/crm/routes/pipeline.routes.js` | MEDIUM | deal stage changes, won/lost |
| `modules/recruitment/` | MEDIUM | hire/reject candidates |
| `modules/procurement/` | MEDIUM | PO creation, vendor selection |
| `modules/sales/routes/sales.routes.js` | MEDIUM | order status changes |
| `modules/finance/accounting.routes.js` | HIGH | journal entries |
| `modules/hr/biometric.routes.js` | MEDIUM | access grant/revoke |

**Recommended lightweight fix:**
Add `logAudit()` calls to the three highest-risk modules (approvals, payroll, employees)
in the next sprint. These are fire-and-forget — zero regression risk.

### 3C. Auth Failure Logging — PARTIAL

`verifyToken` returns 401 but does NOT log auth failures to the audit system.
Only the request logger captures these (as WARN-level access log entries).

**Recommended:** Add structured auth failure events to the audit log for
security monitoring (brute force detection, session hijacking).

### 3D. Background Job Logging — BASIC

Cron jobs (`probation.cron.js`, `healthMonitor.cron.js`, `deliveryFollowup.cron.js`)
log via `console.log`. No structured logging or alerting beyond health monitor.

---

## 4. Scalability & Future Architecture Risks

### 4A. Single Process — High Risk at Scale

The backend is a single Node.js process. All modules, crons, and DB queries
share one event loop and one pg Pool.

**Risk triggers:**
- Large `Promise.all` with many parallel DB queries in dashboard aggregation
- Heavy payroll run (all employees in one synchronous loop)
- `deliveryFollowup.cron.js` querying all pending deliveries

**Recommended future mitigation:**
- Move payroll run to a background worker (BullMQ or node-cron with DB-based locking)
- Add per-route DB query timeouts (`statement_timeout` per session)
- Consider Render's multi-instance autoscaling when traffic grows

### 4B. Dashboard Aggregation Queries — Medium Risk

`modules/dashboard/dashboard.routes.js` and `modules/analytics/` likely perform
multiple parallel DB queries to build dashboard KPIs. If these run unindexed
against large tables, response times will degrade as data grows.

**Recommended:** Add PostgreSQL indexes on:
- `leaves.status` (approvals filter)
- `inventory_items.quantity_on_hand` (low-stock queries)
- `payroll_runs.month, year` (payroll summary — index added in migration 20260518)
- `audit_logs.module_name, created_at` (audit queries)
- `approvals.approver_id, status` (pending approvals)

### 4C. CREATE TABLE IF NOT EXISTS in Route Files — Medium Debt

Several route files create tables inline in an IIFE on startup:
```js
;(async () => { await pool.query(`CREATE TABLE IF NOT EXISTS ...`); })();
```

These are safe (idempotent) but bypass the migration system.
If the schema changes, there's no migration to roll back.

**Affected modules:** inventory.routes.js, and others using the old pattern
superseded by `20260505000001_extract_inline_ddl.js`.

**Recommended:** Audit remaining inline DDL and migrate to proper migration files.

### 4D. pg Pool Tuning

`src/config/db.js` likely uses default pg Pool settings (10 max connections).
On Render's free PostgreSQL tier, the connection limit may be lower.

**Recommended:** Explicitly set:
```js
max: 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 2000,
```

And add `log: (msg) => console.warn(msg)` to surface pool warnings.

### 4E. No Caching Layer

All queries hit PostgreSQL directly. No Redis or in-memory cache.

**Acceptable now** (small data scale). As data grows:
- Dashboard aggregation should cache for 60s
- Permission lookups already have per-request cache in `requirePermission`
- Consider node-cache or Redis for recurring expensive queries

### 4F. Modular Boundary Leakage

Some modules import from other modules' directories (e.g. `config/db.js` vs
`modules/shared/db.js`). The `shared/db.js` re-export alias helps, but there
is no enforced module boundary.

**Low risk now. Document the convention:** modules should only import from
`../../../config/db.js` (or the `shared/db.js` alias), `../../../middlewares/`,
and `../../../services/`. Cross-module feature imports are a code smell.

---

## 5. Deferred Refactor Roadmap

| Priority | Refactor | Risk | Estimated Effort |
|---|---|---|---|
| P1 | Add `logAudit` to approvals, payroll, employees | Very Low | 2–4h |
| ~~P1~~ | ~~Move security.middleware.js to middlewares/~~ — DONE 2026-07-19 (deleted; was dead code) | — | — |
| P2 | Delete/clean loose `test-*.js` root scripts | None | 15min |
| P2 | Verify orphaned routes (zoho, webhooks, aiPayroll) — keep or mount | Low | 2h |
| P2 | Add DB indexes for dashboard/approval queries | Low | 1h |
| P3 | Merge three finance routers into one | Medium | 1 day |
| P3 | Move payroll run to background worker | Medium | 2–3 days |
| P3 | Add Redis caching for dashboard aggregation | Low | 1 day |
| P4 | Enforce modular boundaries (ESLint no-restricted-imports) | Low | 4h |
| P4 | Migrate remaining inline DDL to migration files | Medium | 1 day |

---

*See `docs/ARCHITECTURE.md` for the complete system reference.*
*See `docs/ERP_ENGINEERING_REPORT.md` for the final status assessment.*
