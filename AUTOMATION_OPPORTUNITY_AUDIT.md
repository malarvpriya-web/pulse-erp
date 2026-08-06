# Pulse ERP — Automation Opportunity Audit (Priority 5)

Date: 2026-07-27. Scope: every module named in the roadmap brief, audited against the
**live working tree** (`Pulse/backend/src`, `Pulse/frontend/src`) — not the ~300 generic
`*_AUDIT.md` files sitting at the repo root one level above `Pulse/`, which read as
templated/unverified and are excluded as evidence. Every opportunity below cites a real
file:line. Nothing here is invented, redesigned, or SaaS-wishlisted — only automation that
plugs into a workflow, table, route, or job that already exists.

Builds on, and does not repeat, three prior grounded docs from this session:
- `AUTOMATION_OPPORTUNITIES.md` (Priority 3) — 11 cron jobs inventoried, 7 gaps identified.
- `AI_OPPORTUNITY_MAP.md` (Priority 4) — AI predict/recommend/summarize/assist footprint.
- `BUSINESS_PROCESS_ARCHITECTURE.md` (Priority 2) — Hire-to-Retire / CRM-to-Renewal chain gaps.

## Status legend
- ✅ **Already Implemented** — working automation, cited so it isn't mistakenly re-proposed.
- 🟡 **Extend Existing** — the hard part (schema, scoring, logic, or a callable function)
  already exists; only the trigger/wiring is missing.
- 🔴 **New Automation** — no code path does this today.

---

## 0. Automation Infrastructure Inventory (the reusable substrate)

Everything below is cited once here and referenced by name in every module section, per the
instruction to reuse — not rebuild — existing plumbing.

| Component | State | Evidence |
|---|---|---|
| **Scheduler** | ✅ `node-cron` only — no Bull/BullMQ/Agenda/Kue anywhere (`backend/package.json` deps checked). 11 jobs in `backend/src/jobs/*.cron.js`: `probation`, `amcRenewal`, `deliveryFollowup`, `overdueReminders`, `esignReminder`, `leave`, `attendance`, `scurveSnapshot`, `iotMonitor`, `healthMonitor`, `backup`. |
| **Reminder-job pattern** | ✅ Standard shape (cleanest in `amcRenewal.cron.js`): `getReceivers()` (query `users` by role) → due-date SQL window → `insertReminder()` de-duped against `notifications` by `(user_id, module_name, reference_id, type, created_at::date)` → `node-cron.schedule(...)`. |
| **In-app notifications** | ✅ `notifications` table (`migrations/20260330000000_core_schema.js:258-270`). |
| **Push (FCM/APNs)** | ✅ Real and auto-wired: `notifications.repository.js:12-20` fires `pushSender.js` (FCM HTTP v1 lines 46-86, APNs lines 88-121) on every `create()`. |
| **Email** | ✅ Real SMTP via `backend/src/utils/mailer.js:4-22` (nodemailer), used for payslips, e-sign, OTP. |
| **SMS** | ✅ Real, provider-agnostic: `backend/src/utils/sms.js:15-83` (Twilio/MSG91/webhook via `SMS_PROVIDER`). |
| **WhatsApp** | 🟡 Built but orphaned: `modules/integrations/whatsapp.routes.js:29-82` sends via Meta Graph API, logs to `whatsapp_log` — a standalone `POST /send` endpoint nobody's cron or notification code calls. |
| **`notification_rules` table** | 🟡 Declares per-event `channel` (`in_app,email`) and `recipient_roles` (`migrations/20260623000001_notification_rules_rebuild.js:50-66`) — **no code reads it.** Config exists, has zero consumers. |
| **Critical infra gap** | 🔴 Most of the 11 crons (`overdueReminders`, `amcRenewal`, `deliveryFollowup`) do raw `INSERT INTO notifications`, bypassing the repository — so they never reach push/email/SMS despite the channels existing. Only `esignReminder.cron.js:11` calls the real mailer. |
| **Workflow engine** | 🟡 Real, generic tables exist — `workflows/workflow_steps/workflow_transitions/workflow_instances/workflow_instance_steps` (`migrations/20260429000001_workflow_engine.js`), driven by `services/WorkflowService.js` (`initiateWorkflow`/`advanceWorkflow`, lines 130-272). Feature-flagged (`flags.WORKFLOW_ENGINE_ENABLED`) and **only actually called by `leaves.routes.js` and `projects.routes.js`** — every other approval flow (procurement, travel, ECN, discounts) hand-rolls its own status column instead. |
| **Approval Center aggregator** | 🟡 `modules/approvals/approvals.controller.js` — a UI-unification layer that unions a central `approvals` table with per-module source queries and dispatches approve/reject via hand-rolled `switch` statements (lines 598-739) directly updating each module's own status column. Not a routing engine — routing logic lives per-module. |
| **Manager-hierarchy routing** | 🔴 Nowhere. All role-based approval checks (e.g. Travel's `req.user.role === 'manager'`) never query `reporting_manager_id` — any holder of a role can approve anyone's request, not just their own reports. |
| **Rule engine** | 🟡 `services/RuleEngineService.js` (`evaluateRules`, lines 19-38) evaluates JSONB conditions from `rules_master` — called synchronously in-route (e.g. `servicedesk.routes.js:613`), not event-driven pub/sub. |
| **Event emitters** | 🔴 Zero Node `EventEmitter` usage anywhere in `backend/src` — every cascade (ticket→CSAT, regularization→attendance, opportunity→project) is hand-coded inline in the route handler that causes it. |
| **Database triggers** | 🔴 Zero `CREATE TRIGGER` in any migration. One `plpgsql` function exists (`calculate_available_stock`, `20260522000001_inventory_ddl.js:332-350`) but is never attached to a trigger — callable only from application code. |
| **AI substrate** | ✅ `modules/intelligence/ai.routes.js` + `ceo-intelligence.routes.js` — GPT-optional, rule-based-fallback, never fabricates numbers. Full inventory in `AI_OPPORTUNITY_MAP.md`. |

---

## 1. Executive Command Center

### 1.1 Monthly KPI digest to leadership
**Status:** ✅ Done (2026-08-05) — new `jobs/kpiDigest.cron.js`, monthly, reuses the same narrator as `POST /api/ai/ceo-insights` (`kpiNarrator.js`) and the standard notifications pipeline (auto-mirrors to push/email). Registered in `server.js`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** Every KPI (revenue, attrition, pipeline, headcount) is already computed live behind CEO Dashboard / CEO Intelligence queries — but only surfaces when someone logs in and opens the page.
**Pain Point:** Executives who don't log in daily never see a monthly rollup; there's no push equivalent of the dashboard.
**Automation Flow:**
```
1st of month, 07:00 (new cron)
   ↓
Re-run existing CEO/department dashboard queries for prior month
   ↓
POST /ceo-insights narrates the numbers (GPT, 3 bullets) — falls back to a rule-based template
   ↓
notifications.repository.create() for admin + department heads (auto-mirrors to push/email)
```
**Existing Components Reused:** `ceo-insights` narrator (`ai.routes.js:11`), existing dashboard SQL, `notifications.repository.js` (push-wired `create()`).
**New Components Needed:** One new cron file (`kpiDigest.cron.js`) following the standard reminder-job pattern.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐⭐

### 1.2 Anomaly auto-push instead of pull
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §40. `jobs/anomalyDetection.cron.js` runs daily 06:30, calls extracted `anomalyDetector.detectAnomalies()`, routes each flagged anomaly to the relevant role via `notificationsRepository.create()`. Registered in `server.js`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `GET /api/ai/anomalies` (`ai.routes.js:349-451`) already detects invoice outliers, low attendance, PO price variance, TDS mismatch, and QC test-failure spikes — but only when a human opens the endpoint.
**Pain Point:** A real, working anomaly detector sits idle unless someone remembers to check it.
**Automation Flow:**
```
Daily cron (new)
   ↓
Call existing /api/ai/anomalies logic directly (no new detection code)
   ↓
For each flagged anomaly → notifications.repository.create() to relevant role (finance/QC/admin)
```
**Existing Components Reused:** `/api/ai/anomalies` detection logic, notification repository.
**New Components Needed:** Cron wrapper only.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

---

## 2. CRM

### 2.1 Lead / opportunity auto-assignment
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §44. New `crm/services/leadAssignment.service.js` gives `round_robin`/`load_balanced` real rotation logic (previously `load_balanced` did nothing and `round_robin` never rotated) and wires all four lead/opportunity creation paths through it; also fixed a `PUT /crm/settings` 500 (12 vs 32 live columns) that had silently blocked `auto_assign_owner` from ever persisting. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `leads.repository.js:36-60` and `crm.routes.js:851,1093` take `assigned_to` straight from the request body — a human manually picks the salesperson on every lead/opportunity.
**Pain Point:** No round-robin, territory, or workload balancing; assignment quality depends entirely on whoever fills the form remembering who's free.
**Automation Flow:**
```
New lead/opportunity created (no assigned_to in body)
   ↓
Rule check: territory match (if territory field set) → else round-robin across active salespeople
   ↓
UPDATE leads/opportunities SET assigned_to
   ↓
notifications.repository.create() to the assignee
```
**Existing Components Reused:** `leads`/`opportunities` insert path, `users` role table, notification repository.
**New Components Needed:** Assignment-rule function (small, in-route); optional `territories` lookup if not already modeled.
**Implementation Complexity:** Medium
**Business Impact:** Medium
**Estimated Time:** 1 week
**Priority:** ⭐⭐⭐

### 2.2 Lead/opportunity follow-up reminders
**Status:** ✅ Done (2026-08-05) — see §44. `jobs/crmFollowup.cron.js` runs daily 09:00, notifies a lead/opportunity's own `assigned_to` when its follow-up date has passed. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `lead_activities.next_followup_date` (migration `20260717000005`, indexed) and `opportunities.follow_up_date` (migration `20260714000001`) already exist and are exposed via GET in `pursuits.routes.js:276,302` and `crm.routes.js:1056,1094` — but no cron reads either column.
**Pain Point:** Follow-up dates are recorded and then silently ignored unless someone opens the record.
**Automation Flow:**
```
Daily cron (new)
   ↓
SELECT WHERE next_followup_date/follow_up_date <= CURRENT_DATE AND status still open
   ↓
insertReminder() to assigned_to (standard dedup pattern)
```
**Existing Components Reused:** Both due-date columns, the standard reminder-job pattern (`amcRenewal.cron.js` as template), notifications table.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐⭐

### 2.3 Tender deadline / EMD refund reminders
**Status:** ✅ Done (2026-08-05) — see §44. `jobs/tenderDeadline.cron.js` runs daily, reuses `tenders.routes.js`'s existing due-soon/overdue/EMD-stuck predicates, broadcasts to sales/admin roles via the `user_roles` junction. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `tenders.routes.js:32-38,66-71` already computes `overdue`/`due_soon` (14-day window on `submission_deadline`) and flags `emd_refund_date IS NULL` — purely inline in GET-query SQL.
**Pain Point:** A tender deadline or an EMD stuck in refund limbo is invisible unless someone opens the Tender workspace.
**Automation Flow:**
```
Daily cron (new)
   ↓
Reuse the existing due_soon/overdue SQL from tenders.routes.js
   ↓
insertReminder() to sales/tender-desk role
```
**Existing Components Reused:** Existing `due_soon`/`emd_refund_date` query logic, reminder-job pattern.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

### 2.4 Discount approval — link to quotations, route through the real engine
**Status:** ✅ Already Done — built in §21 (2026-07-30, discount-approval gate at Quotation→Sales Order), confirmed still live during §44's CRM pass. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `discount_approvals` (`20260505000001:938-951`) has no `quotation_id` column at all — only `discount_rule_id/lead_id/order_id`. It's a standalone table/route pair, disconnected from both quotations and the generic Approval Center (`approval_requests`/`module_name`/`reference_type`).
**Pain Point:** A discount tied to a quotation can't be traced back to it, and doesn't benefit from any shared approval routing.
**Automation Flow:**
```
Quotation line discount exceeds threshold
   ↓
Auto-create discount_approvals row with quotation_id (schema addition) + route via approvals.controller's existing dispatch pattern
   ↓
Approve/reject cascades back to quotation status
```
**Existing Components Reused:** `discount_approvals` table, Approval Center dispatch pattern.
**New Components Needed:** `quotation_id` FK column + migration; wiring into `pricing.routes.js:345-352`.
**Implementation Complexity:** Medium
**Business Impact:** Medium
**Estimated Time:** 1 week
**Priority:** ⭐⭐⭐

---

## 3. Sales

### 3.1 Sales Order → Production Order + Project auto-bootstrap
**Status:** ✅ Already Implemented — cite so it isn't re-proposed
**Current Process:** `sales.routes.js:658-681` (`autoBootstrapLifecycleOnOrderAccept`) auto-creates a lifecycle instance, a `projects` row (lines 64-104), and calls `createProductionOrderFromSalesOrder` (line 129) the instant a sales order is accepted — best-effort BOM-matched by product name, non-fatal on failure.
**Business Impact demonstrated:** This is the single most complete cross-module automation chain in the app (CRM/Quotation → Sales Order → Project → Production, four systems, zero manual steps on the happy path). Worth protecting in code review — don't regress it.
**Priority:** N/A (already delivering value)

### 3.2 Quotation auto-expiry
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §41. `jobs/quotationExpiry.cron.js` runs daily 09:45, flips `sent` quotations past `validity_date` to `expired`, notifies the owning salesperson (`created_by`) via `notificationsRepository.create()`. Registered in `server.js`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `quotations.repository.js:6` has a `validity_date` column; nothing reads it proactively. Conversion is two explicit manual endpoints — `PATCH /quotations/:id/convert-to-order` and `/accept-and-convert` (`sales.routes.js:323,365`).
**Pain Point:** Stale quotations sit in "sent" status indefinitely, even past their own validity date, misrepresenting the live pipeline.
**Automation Flow:**
```
Daily cron (new)
   ↓
UPDATE quotations SET status='expired' WHERE validity_date < CURRENT_DATE AND status='sent'
   ↓
insertReminder() to owning salesperson
```
**Existing Components Reused:** `validity_date` column, reminder-job pattern.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1 day
**Priority:** ⭐⭐⭐⭐

---

## 4. Marketing

### 4.1 Campaign execution is CRUD-only
**Status:** ✅ Done (2026-08-05) — see §43. `jobs/campaignLifecycle.cron.js` (daily 09:00) nudges campaigns past `end_date` still open; also fixed a verified-live P0 where `POST /marketing/campaigns` 500'd on every call (`campaign_name` NOT NULL drift). Leaving the rest of this entry as historical record of the original ask.
**Current Process:** A real `marketing` module exists (`campaigns.repository.js`, `marketing.routes.js`, 612 lines) with full CRUD, tasks, deliverables, ROI/lead-attribution analytics (`:514,534`) — but `campaigns` only stores `start_date/end_date/budget/status`; there is no send/schedule/blast mechanism. Status changes via manual `PATCH /campaigns/:id/status` (`:174`).
**Pain Point:** "Automation" here would mean building send/scheduling infrastructure that doesn't exist at all — out of scope for "automate what already exists." The only honest automation available today is status-lifecycle reminders.
**Automation Flow:**
```
Daily cron (new)
   ↓
Campaigns WHERE end_date < CURRENT_DATE AND status != 'completed'
   ↓
insertReminder() to campaign owner to close it out
```
**Existing Components Reused:** `campaigns` table, reminder pattern.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Low
**Estimated Time:** 1 day
**Priority:** ⭐⭐

---

## 5. Procurement

### 5.1 Inventory reorder → auto-draft Purchase Request
**Status:** ✅ Done (2026-08-05) — see §46. `jobs/reorderPr.cron.js` (daily 10:15) auto-converts pending `purchase_suggestions` into draft POs through the existing conversion transaction — no new detection logic needed, `stockAlerts.js` already wrote the suggestions. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** EOQ Planner on the Inventory dashboard computes Reorder Point live; AI `/prescriptive` (`ai.routes.js:846`) already *recommends* reordering items at/below reorder point — but nothing creates the PR. Confirmed: no cron in `backend/src/jobs` references `purchase_requests` or reorder logic.
**Pain Point:** A human must notice the Low Stock Alert or the prescriptive recommendation and manually raise a PR every time.
**Automation Flow:**
```
Inventory falls below reorder_point (inventory_items.current_stock <= reorder_point)
   ↓
Daily cron walks items below threshold
   ↓
Auto-draft Purchase Request (status='draft', NOT auto-approved — human stays in the loop)
   ↓
insertReminder() to procurement role: "N draft PRs awaiting review"
```
**Existing Components Reused:** `inventory_items.current_stock`/`reorder_point`, `purchase_requests` insert path, reminder pattern.
**New Components Needed:** One cron file; dedup logic so it doesn't redraft a PR already in flight for the same item.
**Implementation Complexity:** Medium
**Business Impact:** High
**Estimated Time:** 3-5 days
**Priority:** ⭐⭐⭐⭐⭐

### 5.2 Vendor auto-selection on PR→PO conversion
**Status:** ✅ Done (2026-08-05) — see §49. `PATCH /purchase-requests/:id/convert-to-po` now pre-fills the lowest RFQ-quoting vendor when `supplier_id` is left blank; an explicit caller-supplied value still always wins. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `PATCH /purchase-requests/:id/convert-to-po` (`procurement.routes.js:262-326`) auto-copies PR lines to a draft PO in one action — but `supplier_id` is a pure passthrough from `req.body` (line 284); no lowest-quote or preferred-vendor logic. Separately, `GET /rfqs` already computes `MIN(rq.unit_price) AS lowest_quote` per RFQ (line 725) — a real number, currently only displayed.
**Pain Point:** The system already knows the lowest quote per RFQ but never suggests it at PO-creation time.
**Automation Flow:**
```
PR converts to PO (existing action)
   ↓
If a matching RFQ exists for the item → pre-fill supplier_id with lowest_quote vendor (suggestion, not a lock)
   ↓
Buyer confirms or overrides before submitting for approval
```
**Existing Components Reused:** `convert-to-po` endpoint, `lowest_quote` RFQ query.
**New Components Needed:** Small lookup/pre-fill step in the conversion handler.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐

### 5.3 PO value-based tiered approval routing
**Status:** ✅ Already Implemented
**Current Process:** `procurement.authz.js:64-98` buckets PO amount into `auto/l1/l2/l3/cfo` bands against configurable thresholds (`auto_approve_below`, `l1_approval_limit`=₹25k, `l2_approval_limit`=₹100k, `cfo_approval_above`=₹500k) and blocks approval if the caller's role level is below the required band. Also auto-blocks approval if vendor's average quality/delivery/price rating is below `min_vendor_rating` (`procurement.routes.js:516-523`).
**Business Impact demonstrated:** This is the best-built approval automation in the app — genuinely value-based routing AND an automated vendor-quality gate in the same check. Worth using as the reference implementation when extending the generic Workflow Engine elsewhere.
**Priority:** N/A (already delivering value)

### 5.4 Vendor auto-notification on PO approval
**Status:** ✅ Done (2026-08-05) — see §49. New `sendPurchaseOrderToVendor()` in `mailer.js` emails the vendor a line-item breakdown on PO approval, alongside the existing internal notification. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** Approving a PO calls `notifyWorkflowEvent('approved', ...)` (`procurement.routes.js:530-532`) but `WorkflowNotificationService.js:87-134` only inserts an in-app row for the internal PO creator — no email/SMS ever reaches the vendor. A separate manual `/purchase-orders/:id/send` status-flip (`:481-495`) exists but also sends nothing externally.
**Pain Point:** Every approved PO requires a human to separately email/print/call the vendor.
**Automation Flow:**
```
PO status → approved
   ↓
Look up vendor contact email (vendors table)
   ↓
mailer.js sends PO PDF/summary to vendor (reuse e-sign's email-with-attachment pattern)
   ↓
Log to WorkflowNotificationService as before (internal), plus new external-send record
```
**Existing Components Reused:** `mailer.js`, PO approval event hook, vendor contact data.
**New Components Needed:** Vendor-facing email template; PO-to-PDF rendering if not already available (check e-sign's PDF pipeline for reuse).
**Implementation Complexity:** Medium
**Business Impact:** High
**Estimated Time:** 3-5 days
**Priority:** ⭐⭐⭐⭐

### 5.5 Vendor document expiry reminders
**Status:** ✅ Done (2026-08-05) — see §49. `jobs/vendorDocExpiry.cron.js` (daily 09:20) ports `vendorHealth.service.js`'s existing 30-day expiry predicate into a real per-document reminder. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `vendorHealth.service.js:99-100` and `vendor.service.js:95` already compute `docsExpiringSoon`/`expiredDocs` on demand (via `POST /recalculate-all`) — no cron ever calls it.
**Pain Point:** Expired vendor insurance/certification/compliance documents go unnoticed until someone runs a manual recalculation.
**Automation Flow:**
```
Daily cron (new)
   ↓
Reuse vendorHealth.service.js's existing docsExpiringSoon query
   ↓
insertReminder() to SCM/procurement role per vendor with expiring docs
```
**Existing Components Reused:** `vendorHealth.service.js` query logic, reminder pattern.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

### 5.6 GRN → automatic 3-way match
**Status:** ✅ Done (2026-08-05) — see §49. `POST /grn` now auto-fires the existing three-way-match transaction (extracted into `createThreeWayMatchRecord()`) whenever the GRN carries both a `po_id` and `vendor_invoice_no`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `POST /grn` (`:568-596`) creates the GRN and fires low-stock alerts — but three-way match (`POST /three-way-match`, `:847-881`) must be called manually with `po_id/grn_id`/invoice fields. Once invoked, variance comparison (1% tolerance) and matched/discrepancy classification are fully automatic, and approving a match auto-creates a Finance bill (`:1069-1126`).
**Pain Point:** The matching logic itself is solid automation — it's just not triggered by the event (GRN creation) that should kick it off.
**Automation Flow:**
```
GRN created (existing route)
   ↓
If matching PO + invoice already on file → auto-invoke existing three-way-match logic
   ↓
Existing variance/discrepancy classification runs unchanged
   ↓
Existing auto-bill-on-match logic runs unchanged
```
**Existing Components Reused:** Entire three-way-match implementation, auto-bill creation.
**New Components Needed:** A conditional call from the GRN-creation handler into the existing match function.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐⭐

---

## 6. Inventory

### 6.1 Reorder → auto-draft PR
Covered in **5.1** (Procurement) — same automation, cross-module boundary. Cross-referenced here per the module list, not duplicated.

### 6.2 Fix the AI inventory-prediction stub
**Status:** ✅ Done (2026-08-05) — `GET /predict/inventory` (`ai.routes.js`) now computes `consumed_last_30d` from `SUM(stock_ledger.quantity_out)` over the trailing 30 days (per item, across warehouses) instead of hardcoding `0`. `risk_level` is derived from real days-of-cover (`current_stock / avg_daily_consumption`) against a lead-time + safety-stock reorder point — the same `dailyDemand * leadTimeDays + safetyStock` formula `computeEoqMetrics` uses for the EOQ Planner, so the two endpoints now agree on "at risk". Items with no movement history in the window fall back to the old static `current_stock` vs `reorder_level` bucket (can't project a velocity from zero data points). The dev DB's `stock_ledger` is currently empty (0 rows — confirmed live, see `project_stock_three_systems_unification` memory), so this returns the same empty-velocity fallback today; it will self-activate once GRN/production postings accumulate history. Verified by hand-inserting a rolled-back test row: velocity path correctly computed `consumed_last_30d`/`days_of_cover`. No new endpoint, no schema change. Leaving the rest of this entry as historical record of the original ask.
**Current Process (historical):** `GET /predict/inventory` (`ai.routes.js:666`) buckets items critical/warning/ok from `current_stock` vs `reorder_level` — a plain threshold check the EOQ Planner already does. The column that would make it a real prediction, `consumed_last_30d`, is hardcoded to `0` (line 674).
**Pain Point:** This endpoint is labeled "predictive" but never actually factors in consumption velocity.
**Automation Flow:**
```
Wire consumed_last_30d to real stock-movement history (stock_ledger / GRN issue records)
   ↓
Recompute days-of-cover using actual velocity instead of a static bucket
   ↓
Same endpoint, same consumers, now genuinely predictive
```
**Existing Components Reused:** `/predict/inventory` endpoint, stock movement history.
**New Components Needed:** One query rewrite (no new endpoint).
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐

---

## 7. Finance

### 7.1 AR/AP overdue reminders
**Status:** ✅ Already Implemented — `overdueReminders.cron.js` (daily 09:00), AR invoice reminders + AP payment follow-up.
**Priority:** N/A (already delivering value)

### 7.2 Monthly depreciation — dead-wired, cheapest fix in the entire audit
**Status:** ✅ Done (2026-08-05) — see §47 (§46 registered the cron; §47 found `postMonthlyDepreciation()` itself was still broken against live schema and rewrote it, also collapsing a second competing annual-depreciation mechanism and fixing 2 pre-existing financial-data bugs). Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `postMonthlyDepreciation()` is fully built (SLM/WDV per Schedule II) in `finance/services/depreciation.js:100-212`; its own docstring (line 94) says "Called by the monthly cron job" — but a repo-wide check of `backend/src/jobs/*.cron.js` (all 11 files) shows zero callers. It has simply never been registered.
**Pain Point:** Real, correct depreciation logic exists and produces zero output because nobody scheduled it.
**Automation Flow:**
```
1st of month (new cron — literally just a registration)
   ↓
Call existing postMonthlyDepreciation() unchanged
   ↓
Existing function posts depreciation entries as designed
```
**Existing Components Reused:** `postMonthlyDepreciation()` in full — zero new business logic.
**New Components Needed:** One `depreciation.cron.js` file (~15 lines, copy the standard cron scaffold) + one import/invocation line in `server.js`.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** Half a day
**Priority:** ⭐⭐⭐⭐⭐

### 7.3 Three-way-match approval → auto Finance bill
**Status:** ✅ Already Implemented — approving a matched three-way-match record auto-creates a Finance bill (`procurement.routes.js:1069-1126`).
**Priority:** N/A (already delivering value)

---

## 8. Payroll

### 8.1 Payroll auto-enrollment across every employee-creation path
**Status:** ✅ Already Implemented (per prior verified audit, `project_enterprise_workflow_audit`, re-confirmed 2026-07-27 in `BUSINESS_PROCESS_ARCHITECTURE.md`) — reaches direct-add, recruitment-hire, and auto-creation-trigger paths alike.
**Note:** No further payroll-specific automation gap was found beyond what Attendance/Leave already feed into payroll runs. Not padding this section with invented items.
**Priority:** N/A (already delivering value)

---

## 9. HRMS (Employee Lifecycle)

### 9.1 Onboarding checklist auto-init on hire
**Status:** ✅ Done (2026-08-05) — see §45. New `hr/onboarding.service.js` wired into Direct Add Employee and both recruitment hire paths. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** A real checklist system exists (`hr_onboarding_checklist_templates`/`_progress`, due-dates computed from `joining_date` + offset, `hr/onboarding.routes.js:70-83`) — but initializing it is a manual `POST /onboarding/progress/:employee_id/init` (line 60). The recruitment hire cascade (`recruitment.routes.js:911-921`) writes checklist items as **logged pending TODOs** ("Onboarding checklist to be created", "Official email request pending", etc.) rather than executing them. One genuine auto-fire already exists: a welcome email on hire (`triggerEmail('hired_welcome', …)`, line 359-364).
**Pain Point:** The checklist infrastructure is real; initiating it still depends on someone remembering to call the init endpoint.
**Automation Flow:**
```
Employee record created (any of the 3 creation paths)
   ↓
Auto-call the existing onboarding.routes.js init logic instead of waiting for a manual POST
   ↓
Checklist rows created with due-dates, as designed
```
**Existing Components Reused:** Onboarding checklist tables + init logic, employee-creation hook points.
**New Components Needed:** A call from each employee-creation path into the existing init function.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐⭐

### 9.2 Exit offboarding — auto-create asset-recovery task, enforce gates
**Status:** ✅ Already Implemented — confirmed via §48: `exit.routes.js`'s `computeClearanceBlockers()` (Pass 5 Exit Clearance Engine, 2026-07-28) already gates F&F payout on asset recovery, travel advances, and active logins; this predates the audit and needed no new build. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `exit_clearance` fields (`it_assets_returned`, `documents_collected`, `noc_*`) are set only via manual `PUT /clearance/:employee_id` (`exit.routes.js:459-499`). Only `access_revoked` has a real side-effect (deactivates login, lines 481-495) — `it_assets_returned` is a plain unenforced boolean, and exit never checks outstanding travel advances at all.
**Pain Point:** The one enforcement pattern that works (`access_revoked`) was never extended to the two other checkboxes that clearly need the same treatment.
**Automation Flow:**
```
Exit initiated (existing POST /initiate)
   ↓
Auto-query employee_asset_allocations WHERE status='allocated' → auto-create a recovery task/notification
   ↓
Block employees.status='left' transition until it_assets_returned=true AND travel closure-check passes (travel-reimbursement.routes.js:598 already exposes this exact closure-check, just never called from exit)
```
**Existing Components Reused:** `access_revoked` enforcement pattern (as the template), existing travel `/closure-check` endpoint, `employee_asset_allocations`.
**New Components Needed:** A gate check inside the exit-finalize path calling the two existing endpoints.
**Implementation Complexity:** Medium
**Business Impact:** High
**Estimated Time:** 3-5 days
**Priority:** ⭐⭐⭐⭐

### 9.3 Full & Final settlement (F&F) auto-trigger
**Status:** ✅ Done (2026-08-05) — see §48. New `hr/fnf.service.js` + `jobs/fnfAutoTrigger.cron.js` (daily 09:00) auto-computes F&F once `last_working_date` passes and notifies HR/finance for review; approval/pay stay human actions. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `POST /fnf/compute/:employee_id` (`exit.routes.js:281`) is never called automatically from `POST /initiate` or any status transition — HR must remember to call it, then separately approve (`:386`) and pay (`:411`).
**Pain Point:** F&F can sit uncomputed indefinitely after an exit is initiated.
**Automation Flow:**
```
Exit initiated + notice period elapses (or last-working-day reached)
   ↓
Auto-call existing /fnf/compute/:employee_id logic
   ↓
insertReminder() to HR/finance that F&F is ready for approval (still human-approved, not auto-paid)
```
**Existing Components Reused:** `/fnf/compute` logic unchanged, reminder pattern.
**New Components Needed:** A date-triggered check (cron or hook off last-working-day field).
**Implementation Complexity:** Medium
**Business Impact:** Medium
**Estimated Time:** 3-5 days
**Priority:** ⭐⭐⭐

---

## 10. Recruitment

### 10.1 Auto-creation trigger fires on Hired status, not on manual click
**Status:** ✅ Done (2026-08-05) — see §50. Extracted `recruitmentRepository.autoCreateEmployeeFromCandidate()`, now fired from both real hire paths (`moveCandidateStage`/`acceptOffer`) instead of only the unused manual-trigger route. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `POST /recruitment/auto-creation/:candidateId/trigger` (`recruitment.routes.js:813`) already correctly cascades employee + payroll creation — but sits behind a "pending" queue someone has to open and click.
**Pain Point:** Onboarding is semi-automatic, not automatic — a human gate exists purely because nobody wired the trigger to the status change.
**Automation Flow:**
```
Candidate status → Hired / offer-accepted (existing status update route)
   ↓
Auto-invoke the existing auto-creation trigger logic (same function, new caller)
   ↓
Employee + payroll records created exactly as today, minus the manual click
```
**Existing Components Reused:** The entire auto-creation trigger function.
**New Components Needed:** A call from the status-update handler into the existing trigger.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐⭐

### 10.2 Interview reminder cron
**Status:** ✅ Done (2026-08-05) — see §50. `jobs/interviewReminder.cron.js` (daily 08:00) notifies the panelist in-app and emails the candidate directly the day before; also fixed a pre-existing silently-dead interviewer notification (UUID passed where `reference_id` is integer). Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `POST /interviews` (`:426`) fires an immediate notify+email at scheduling time — but no cron ever reminds anyone of an *upcoming* interview. Confirmed: none of the 11 cron files touch `interview_schedules`.
**Pain Point:** A panelist who doesn't act on the original notification has no second nudge before the interview.
**Automation Flow:**
```
Daily cron (new)
   ↓
interview_schedules WHERE interview_date = tomorrow
   ↓
insertReminder() to panelist + candidate-facing email (mailer.js)
```
**Existing Components Reused:** `interview_schedules` table, mailer.js, reminder pattern.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

### 10.3 Offer-letter auto-generation at offer stage
**Status:** ✅ Done (2026-08-05) — see §50. New `autoDraftOfferForCandidate()` auto-creates a draft offer (salary seeded from the job opening's range) the moment a candidate reaches Offer stage; sending still requires human approval. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** Reaching the offer stage only creates a reminder notification telling a recruiter to "create offer letter" (`:541-543`). Actual generation is a manual `POST /offers` (`:637`); sending is auto-notified once a human flips `offer_status` to `'sent'` (`:649-663`, fires `triggerEmail('offer_sent', …)`).
**Pain Point:** Two separate manual steps (generate, then flip to sent) where generation itself could reuse a template the moment the stage changes.
**Automation Flow:**
```
Candidate stage → Offer
   ↓
Auto-generate a draft offer letter from the existing template/POST /offers logic (still requires human review/approval before send)
   ↓
Existing send-on-status-flip logic runs unchanged
```
**Existing Components Reused:** `POST /offers` logic, `offer_sent` email trigger.
**New Components Needed:** Auto-draft call at stage-transition; keep sending human-gated.
**Implementation Complexity:** Medium
**Business Impact:** Medium
**Estimated Time:** 3-4 days
**Priority:** ⭐⭐⭐

---

## 11. Attendance

### 11.1 Auto-absent marking + auto-checkout
**Status:** ✅ Already Implemented — `attendance.cron.js` (daily 23:45 + 30-min sweep).
**Priority:** N/A (already delivering value)

### 11.2 Regularization approval → auto attendance-record insert
**Status:** ✅ Already Implemented — `approvals.controller.js` "reg" case (lines 620-636): approving a regularization request auto-inserts into `attendance_records` plus a notification, no separate manual data-entry step.
**Priority:** N/A (already delivering value)

---

## 12. Leave

### 12.1 Monthly accrual, carry-forward, comp-off expiry, escalation
**Status:** ✅ Already Implemented — `leave.cron.js` covers all four in one file, including a real N-day escalation (`:264-312`, flags applications pending >3 days and calls `notifyWorkflowEvent('escalated', ...)`). This is the single most complete automation surface in the app and a template worth copying into other modules' escalation gaps (Service Desk SLA, Quality NCR — see below). **2026-08-05 update:** the escalation call itself was found to be a silent no-op app-wide — `recipientIds` was never read by `notifyWorkflowEvent()` — and has been fixed; see `MODULE_FEATURE_CONNECTION_MANUAL.md` §53 for the fix, which also repaired ~15 other previously-dead notification call sites across Leave/Comp-Off/Encashment/CRM sharing the same bug.
**Priority:** N/A (already delivering value — cite as the reference implementation)

---

## 13. Projects

### 13.1 Milestone completion → auto invoice creation
**Status:** ✅ Already Implemented — `PUT /projects/milestones/:id/complete` (`projects.routes.js:516-594`) auto-creates a Finance invoice when `billing_milestone && amount > 0` (line 541), linking back via `invoice_id`.
**Priority:** N/A (already delivering value)

### 13.2 Monthly EVM S-curve snapshot
**Status:** ✅ Already Implemented — `scurveSnapshot.cron.js`.
**Priority:** N/A (already delivering value)

### 13.3 Unify the two Opportunity→Project paths
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §52/§54. New `crm/services/opportunityConversion.service.js` fires automatically whenever `PATCH /opportunities/:id/stage` lands on `won`, reusing the existing idempotency guard so it layers safely on top of the Sales Order path. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** Two separate paths exist. The **Sales Order path is fully automatic** (`sales.routes.js:76-101`, carries `opportunity_id` forward, zero manual step). The **direct CRM path is a manual button** (`crm.routes.js:1278`, `POST /opportunities/:id/convert-to-project`) — stage change to `won` (line 1141-1142) only updates `closed_date`/`probability_percentage`, it never creates a project.
**Pain Point:** Whether a Won opportunity gets a project automatically depends entirely on which path it came through — an inconsistency, not a missing feature (the automatic version already exists and works).
**Automation Flow:**
```
Opportunity stage → won (CRM direct path, not via Sales Order)
   ↓
Check projects WHERE opportunity_id=$1 (existing idempotency guard, line 1300-1307)
   ↓
If none exists, auto-invoke the existing convert-to-project logic instead of waiting for the button
```
**Existing Components Reused:** The entire `convert-to-project` implementation and its idempotency guard.
**New Components Needed:** A call from the stage-update handler into the existing conversion logic.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐

---

## 14. Manufacturing (Production)

### 14.1 Sales Order → Production Order auto-creation
**Status:** ✅ Already Implemented — part of `autoBootstrapLifecycleOnOrderAccept` (see 3.1), BOM-matched by product name.
**Priority:** N/A (already delivering value)

### 14.2 Production Order release → automatic material reservation + backflush
**Status:** ✅ Already Implemented — `autoReserveMaterials()` (`execution.routes.js:72-90`) fires automatically inside the order-release transaction (line 905); backflush consumption on operation completion (lines 92-131) is likewise automatic. No manual pick step required.
**Priority:** N/A (already delivering value)

### 14.3 Quality stop-ship / inspection gating
**Status:** ✅ Already Implemented — `routingCopy.service.js:10-27` copies `is_inspection` through to `production_operations`; `execution.routes.js:1293-1305` blocks the next operation from starting until inspection completes. Also enforced on scrap (line 1401). This is the strongest quality-automation example in the codebase.
**Priority:** N/A (already delivering value)

---

## 15. Production Planning

### 15.1 Auto-trigger MRP run on new demand
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §55. New `jobs/mrpAutoRun.cron.js` runs MRP nightly instead of waiting for the manual button; planned orders still surface for planner review as before. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `POST /mrp/run` (`production/mrp.routes.js:28`) is a manual button; `POST /planned-orders/:id/convert` / `/convert-all` (lines 161, 208) are likewise manual. Nothing runs MRP automatically when a new sales order lands (even though the order itself auto-bootstraps a production order via BOM-match — MRP is the *planning* layer above that, for components, not the immediate 1:1 order).
**Pain Point:** Planners must remember to re-run MRP after new demand appears instead of it running proactively.
**Automation Flow:**
```
New sales order accepted (existing trigger point in sales.routes.js)
   ↓
Queue existing /mrp/run logic (same computation, new caller) — nightly batch, not synchronous, to avoid blocking order acceptance
   ↓
Planned orders surface for planner review as today (convert/convert-all remain manual — human stays in the loop for committing purchase/production)
```
**Existing Components Reused:** Entire `/mrp/run` computation.
**New Components Needed:** A nightly cron calling the existing MRP function instead of waiting for the button.
**Implementation Complexity:** Medium
**Business Impact:** Medium
**Estimated Time:** 3-4 days
**Priority:** ⭐⭐⭐

### 15.2 Module Production Batch Request (IMR) auto-completion
**Status:** ✅ Already Implemented (partially, worth noting) — `deriveStatus()` (`imr.routes.js:36-40`) auto-computes `completed` inside the `/assign` call once cumulative `assigned_qty >= requested_qty` (line 338) — no separate manual "/complete" click needed for full completion.
**Priority:** N/A (already delivering value)

---

## 16. Quality

### 16.1 Auto-NCR on inspection/test failure
**Status:** ✅ Already Implemented — gated by `quality_settings.iqc_auto_ncr_on_fail`, fires on IQC inspection (`quality.routes.js:212-224,259-275`) and on quality-test result recording (`:1097-1123`), linking `quality_tests.ncr_id`. This confirms and updates the memory note — still true, verified 2026-07-27.
**Priority:** N/A (already delivering value)

### 16.2 Calibration due-alerts — make it push, not pull
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §56. New `jobs/calibrationDueAlerts.cron.js` (daily 09:25) ports the existing due-alerts query, and actually reads the per-company `quality_settings.calibration_alert_days` setting the original endpoint hardcoded to 30. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `GET /calibration/due-alerts` (`quality.routes.js:526-641`) already computes what's due, gated by `quality_settings.calibration_alert_days` — but it's a GET endpoint, queried on demand.
**Pain Point:** Calibration due-dates are correctly modeled and computed; nobody sees them unless they open the Quality module.
**Automation Flow:**
```
Daily cron (new)
   ↓
Reuse the existing due-alerts query unchanged
   ↓
insertReminder() to QC/maintenance role
```
**Existing Components Reused:** Entire due-alerts query, `calibration_alert_days` setting.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

### 16.3 NCR critical-escalation config — wire the consumer
**Status:** ✅ Done (2026-08-05) — new `jobs/ncrEscalation.cron.js` (hourly) escalates open critical `ncr_reports` past `quality_settings.ncr_escalate_critical_mins` via the same `notifyWorkflowEvent('escalated', ...)` pattern §12.1's fix repaired. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `quality_settings.ncr_escalate_critical_mins` (`:802,817`) is a stored, configurable escalation threshold — with zero code anywhere that reads it and actually escalates.
**Pain Point:** An escalation policy exists in settings and does nothing; `leave.cron.js`'s escalation pattern (12.1) is a ready-made template.
**Automation Flow:**
```
Cron sweep (new, frequency matched to ncr_escalate_critical_mins granularity)
   ↓
Critical NCRs open longer than the configured threshold
   ↓
notifyWorkflowEvent('escalated', ...) to next-level QC/management (same call shape as leave.cron.js:264-312)
```
**Existing Components Reused:** `ncr_escalate_critical_mins` setting, `leave.cron.js` escalation pattern as template.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 2 days
**Priority:** ⭐⭐⭐⭐

---

## 17. R&D

### 17.1 Patent / IP renewal reminders
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §56. New `jobs/patentRenewal.cron.js` (daily 09:35, 90-day window), ports `rd_patents.expiry_date WHERE status NOT IN ('lapsed','abandoned')` verbatim, same shape as `amcRenewal.cron.js`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `rd_patents.expiry_date` is a real column (`rd.routes.js:178,183-185`), fully populated via `POST/PUT /rd/patents` — zero consumers anywhere read it proactively.
**Pain Point:** A lapsed patent (`PATENT_STATUS` even has a `'lapsed'` state, line 25) is exactly the kind of expensive, silent miss this audit is meant to catch — the data is there, nothing watches it.
**Automation Flow:**
```
Daily/weekly cron (new)
   ↓
rd_patents WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 90 days AND status NOT IN ('lapsed','abandoned')
   ↓
insertReminder() to R&D/legal role (exact same shape as amcRenewal.cron.js — cheapest possible port)
```
**Existing Components Reused:** `rd_patents.expiry_date`, reminder-job pattern (near-identical to `amcRenewal.cron.js`).
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1 day
**Priority:** ⭐⭐⭐⭐⭐

---

## 18. Engineering / ECN

### 18.1 BOM auto-promotion on ECN implement
**Status:** ✅ Already Implemented — `/implement` (`ecn.routes.js:322-337`) auto-promotes the draft BOM to active, superseding the old version.
**Priority:** N/A (already delivering value)

### 18.2 Auto-notify affected departments on ECN implementation
**Status:** ✅ Done (2026-08-05) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §56. New `notifyEcnImplemented()` in `ecn.routes.js`, fired fire-and-forget from `/changes/:id/implement` after its transaction commits, to the three departments the audit names by role code directly (`production_manager`, `qc_manager`, `procurement_manager`). Live-tested end-to-end against the dev DB — resolved exactly the three intended role-holders. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `submit/approve/reject/implement` (`ecn.routes.js:190-259`) only call `logEvent()` (lines 15-23), writing an audit row to `engineering_change_events` — no `notify()`/email call exists anywhere in the file.
**Pain Point:** Production, Quality, and Procurement — the three departments an engineering change actually affects — learn about it only if someone tells them manually.
**Automation Flow:**
```
ECN status → implemented (existing route)
   ↓
Look up affected product_line / BOM consumers
   ↓
notifications.repository.create() to production_manager, qc_manager, procurement roles
```
**Existing Components Reused:** ECN implement route, notification repository.
**New Components Needed:** A notify call added alongside the existing `logEvent()` calls.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 2 days
**Priority:** ⭐⭐⭐⭐⭐

---

## 19. Service Desk

### 19.1 Ticket resolved/closed → auto CSAT survey
**Status:** ✅ Already Implemented — `servicedesk.routes.js:604-611` auto-creates a CSAT-request notification the instant a ticket transitions to resolved/closed.
**Priority:** N/A (already delivering value)

### 19.2 SLA escalation — config exists, nothing executes it
**Status:** ✅ Done — `jobs/slaEscalation.cron.js` (hourly :30), `notifyWorkflowEvent('escalated', ...)` to `servicedesk`-can_edit users. Also fixed a pre-existing schema-drift bug the cron exposed: `sla_policies` was missing 4 columns the entire feature (POST/PUT policies, breach dashboard, Settings sync) already assumed, so nothing in this feature had ever actually worked. See `MODULE_FEATURE_CONNECTION_MANUAL.md` §60.
**Current Process (as of the original audit):** `sla_policies.escalation_hours` (`servicedesk.routes.js:129`) is a stored, configurable field — no cron or consumer anywhere reads it.
**Pain Point:** SLA breach escalation is fully configurable in settings and entirely inert in practice.
**Automation Flow:**
```
Hourly cron (new)
   ↓
support_tickets WHERE status='open' AND age_hours > sla_policies.escalation_hours for that ticket's priority/category
   ↓
notifyWorkflowEvent('escalated', ...) to next-tier support/manager (same shape as leave.cron.js)
```
**Existing Components Reused:** `sla_policies.escalation_hours`, escalation pattern from `leave.cron.js`.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐⭐⭐

### 19.3 Customer-portal ticket → auto internal ticket
**Status:** ✅ Already Implemented — `POST /portal/tickets` auto-creates a linked internal `support_tickets` row (`customer-portal.routes.js:179-212`).
**Priority:** N/A (already delivering value)

---

## 20. AMC

### 20.1 AMC/service-contract renewal reminders
**Status:** ✅ Already Implemented — `amcRenewal.cron.js`, checks both `service_contracts` and `amc_contracts` table variants, default 30 days before expiry.
**Priority:** N/A (already delivering value)

### 20.2 `subscriptions` table — a second, disconnected renewal mechanism
**Status:** ✅ Done — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §62. `jobs/subscriptionRenewal.cron.js` (15-day window, daily 09:15) predates this audit doc (built §18, 2026-07-29). This pass fixed two real bugs found while re-verifying: `getReceivers()` read the stale legacy `users.role` column with non-existent role strings and ignored `subscriptions.company_id` entirely (a cross-tenant notification leak) — now resolves via `user_roles`/`roles`, scoped per-subscription's company; and the query silently excluded every `auto_renew=false` subscription, the segment that most needs the reminder since nothing else in the codebase auto-executes renewal — filter removed, message now differentiates auto vs. manual. Live-tested end-to-end. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `sales.routes.js` has a complete, separate `subscriptions` table (plan/billing-cycle/auto-renew/next-billing-date) with manual pause/cancel/renew endpoints — wired to zero cron jobs, not linked to `amc_contracts` or Customer 360.
**Pain Point:** Two independent renewal tracks exist; only one has a reminder job.
**Automation Flow:**
```
Daily cron (extend amcRenewal.cron.js or add a sibling job)
   ↓
subscriptions WHERE next_billing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 days AND auto_renew=false
   ↓
insertReminder() to account owner/finance
```
**Existing Components Reused:** `subscriptions` table, `amcRenewal.cron.js` pattern.
**New Components Needed:** One cron file (or extend the existing one to cover both tables the way it already covers both AMC variants).
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐

---

## 21. Customer Portal

### 21.1 Ticket status change → notify the customer
**Status:** ✅ Done (2026-08-05) — see §56. New `notifyCustomerOfStatusChange()` on `PUT /customer-portal/tickets/:id`, fires only when status actually changed, reuses `mailer.js`'s existing `sendNotificationEmail()`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `PUT /customer-portal/tickets/:id` (`customer-portal.routes.js:470-488`) lets staff update status but sends no notification/email — the customer only learns by polling `GET /portal/tickets` (line 150).
**Pain Point:** The internal→external direction of the ticket loop is silent, while the reverse direction (21.2) is already automatic.
**Automation Flow:**
```
Staff updates ticket status (existing route)
   ↓
mailer.js sends a status-change email to the customer's portal contact address
```
**Existing Components Reused:** `mailer.js`, ticket status-update route.
**New Components Needed:** A notify call added to the existing PUT handler.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐⭐

### 21.2 Customer portal ticket → auto internal ticket
**Status:** ✅ Already Implemented — see 19.3.
**Priority:** N/A (already delivering value)

---

## 22. Vendor Portal

### 22.1 4-stage auto-routed vendor approval workflow
**Status:** ✅ Already Implemented — SCM → Quality → Finance → Management, each decision auto-advancing `status` to the next queue (`vendor-approval.routes.js:98-101,129-131,159-161`), final approval auto-promotes into the `vendors` master table with a computed initial risk score (`VendorService.computeInitialRisk`, lines 200-269). A genuinely strong example of multi-stage automated routing.
**Priority:** N/A (already delivering value — reference implementation for other modules' approval chains)

### 22.2 Vendor document expiry reminders
Covered in **5.5** (Procurement) — same automation, cross-referenced here since it lives at the Vendor Portal boundary too.

---

## 23. Compliance

### 23.1 Compliance evidence / audit due-date reminders
**Status:** ✅ Done (2026-08-05) — see §54. New `jobs/complianceReminders.cron.js` (daily 09:10) ports the existing `is_expired`/`expiring_soon`/`is_overdue` read-time predicates into proactive standard-expiry and audit-due-date reminders. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `compliance.routes.js` already computes `is_expired`/`expiring_soon` (lines 33-38), `is_overdue` on audits (line 159), and dashboard KPIs (`expiring_soon`, `overdue_audits`, `audits_due_30d`, lines 218-225) — all read-time query flags, surfaced only when someone opens `/compliance/summary` or `/standards`. This is a pure-CRUD module with zero proactive reminders today.
**Pain Point:** Compliance is exactly the domain where "nobody happened to check the dashboard" is the costliest possible failure mode, and it's the one module in this audit with zero automation of any kind.
**Automation Flow:**
```
Daily cron (new)
   ↓
Reuse existing is_expired/expiring_soon/is_overdue queries unchanged
   ↓
insertReminder() to compliance officer/admin role
```
**Existing Components Reused:** Entire expiring/overdue query logic already in `compliance.routes.js`.
**New Components Needed:** One cron file — this is a pure copy-port, same as warranty/AMC.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐⭐

---

## 24. Asset Management

### 24.1 Monthly depreciation cron
Covered in **7.2** (Finance) — same dead-wired function, cross-referenced here since Fixed Assets is where the impact is felt.

### 24.2 Asset warranty expiry — pull to push
**Status:** ✅ Done (2026-08-05) — see §56. New `jobs/assetWarrantyExpiry.cron.js` (daily 09:40, 90-day window) matches `finance/assets.routes.js`'s existing dashboard predicate. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `finance/assets.routes.js:75-77` already computes `warranty_expiry BETWEEN NOW() AND NOW()+90 days` — a dashboard query, not a proactive reminder.
**Pain Point:** Same shape as every other expiry gap in this audit: the query exists, the cron doesn't.
**Automation Flow:**
```
Daily/weekly cron (new)
   ↓
Reuse existing warranty_expiry query from assets.routes.js
   ↓
insertReminder() to asset owner/facilities role
```
**Existing Components Reused:** Existing warranty query.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 1 day
**Priority:** ⭐⭐⭐⭐

### 24.3 Enforce asset-return at exit
Covered in **9.2** (HRMS) — same gap, same fix, cross-referenced.

---

## 25. Document Management

### 25.1 Document/contract expiry reminders
**Status:** ✅ Done (2026-08-06) — see §64. Added `document_master.expiry_date` (`20260806000002_document_master_expiry_date.js`, nullable/additive) and `jobs/documentExpiry.cron.js` (daily 09:55), reminding the uploader (falling back to company admins if their account is gone). Live-verified: synthetic row 5 days out produced the expected `document_expiring` notification. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `documentMaster.routes.js` (Google Drive-backed, `module_type`/`linked_entity_type`, revision history) is a real, distinct module, separate from e-sign (`documents.routes.js`/`signatures.routes.js`) — but `document_master` has no `expiry_date` field or reminder at all. Confirmed: reminders remain limited to AMC (`amcRenewal.cron.js`) and e-sign (`esignReminder.cron.js`).
**Pain Point:** Any contract or document stored purely as a document-master record (not modeled as an AMC/e-sign entity) has zero expiry tracking.
**Automation Flow:**
```
Add expiry_date to document_master (schema addition, module_type-scoped so it's optional per document type)
   ↓
Daily cron reads it the same way amcRenewal.cron.js reads AMC end_date
   ↓
insertReminder() to the document's linked_entity owner
```
**Existing Components Reused:** `document_master` table, reminder pattern.
**New Components Needed:** One migration (add column), one cron file.
**Implementation Complexity:** Medium (schema change, not just a cron)
**Business Impact:** Medium
**Estimated Time:** 3-4 days
**Priority:** ⭐⭐⭐

---

## 26. IoT

### 26.1 Device online/offline/threshold monitoring
**Status:** ✅ Already Implemented — `iotMonitor.cron.js`, every 5 minutes.
**Priority:** N/A (already delivering value)

### 26.2 Predictive maintenance via device-failure risk score
**Status:** ✅ Already Implemented — `GET /predict/device-failure` (`ai.routes.js:783`) combines open/critical alerts, connection health, a real 14-day linear-regression trend on degradation metrics, and warranty/AMC status into a 0-100 score with a labeled `recommendation` field ("Dispatch a service engineer", etc). **This already is the predictive-maintenance automation for IoT-connected equipment** — no further building needed here, only the wiring in 26.3.
**Priority:** N/A (already delivering value)

### 26.3 Non-IoT preventive maintenance — the query exists, the cron doesn't
**Status:** ✅ Done (2026-08-05) — see §56. New `jobs/maintenanceDue.cron.js` (daily 09:50, 7-day window) ports `maintenance.routes.js`'s existing due/overdue predicates. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `maintenance_schedules.next_due_date`/`frequency_days`/`overdue` and `maintenance.routes.js`'s "due within 7 days" (~line 602) / "overdue" (~line 623) queries exist — used only when someone opens the Maintenance page.
**Automation Flow:**
```
Daily cron (new)
   ↓
Reuse existing due/overdue queries unchanged
   ↓
insertReminder() to asset's assigned_to + production/maintenance roles
```
**Existing Components Reused:** Existing maintenance due/overdue queries.
**New Components Needed:** One cron file.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 1-2 days
**Priority:** ⭐⭐⭐⭐⭐

---

## 27. AI

Full existing footprint and gap analysis already lives in `AI_OPPORTUNITY_MAP.md` — summarized here, not repeated:
- ✅ Already built: revenue forecast, department attrition rate, device-failure prediction (26.2), CEO narrative summarization (`ceo-insights`), cross-module prescriptive recommendations (`/prescriptive`), nav-search, smart-search.
- 🟡 Partial: `/predict/inventory` stub (see 6.2).
- 🔴 Real gaps: department-level narrative digests (pairs with 1.1), ticket/complaint thread summarization for Service Desk handoffs, project-health narrative on top of EVM/CPI/SPI, quality defect-rate prediction from existing batch/quality-rating data, individual-level attrition risk, vendor delivery-delay prediction, extend `/prescriptive` to Sales/Service using the existing `customerHealth.service.js` scores, lead/opportunity prioritization ranking, in-context drafting assist (draft button reusing `/llm-chat` inside specific forms).

---

## 28. Analytics

Dashboards already exist per-department (CEO, Sales, Production, Inventory, Quality, etc.) live-querying real data — the only genuine automation gap is delivery, not computation: the same "monthly digest" gap already covered in **1.1**. Not duplicating here.

---

## 29. Notifications

### 29.1 Reminder crons bypass the channel-aware repository
**Status:** ✅ Done — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §25 (raw-INSERT bypass fixed in the older crons) + §37 (`WorkflowNotificationService.js`'s wider-reach instance) + §39/§42 (email coverage extended). `overdueReminders.cron.js` and every cron built since this audit's numbered pass began already call `notificationsRepository.create()`. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `notifications.repository.js`'s `create()` auto-mirrors to push (FCM/APNs) — but `overdueReminders.cron.js:15-34`, `amcRenewal.cron.js:17`, and `deliveryFollowup.cron.js:17` all do raw `INSERT INTO notifications` directly, bypassing the repository entirely. Only `esignReminder.cron.js` calls a real send function (mailer.js). Meanwhile `notification_rules` declares `channel: 'in_app,email'` per event type with zero code ever reading it.
**Pain Point:** The infrastructure for multi-channel delivery is real and built; most of what actually runs today silently degrades to in-app-only, regardless of what `notification_rules` says should happen.
**Automation Flow:**
```
Every existing reminder cron (11 files)
   ↓
Replace raw INSERT INTO notifications with notifications.repository.js's create()
   ↓
Push now fires automatically (already wired); optionally read notification_rules.channel to also fire email/SMS via existing mailer.js/sms.js
```
**Existing Components Reused:** `notifications.repository.js`, `pushSender.js`, `mailer.js`, `sms.js`, `notification_rules` table.
**New Components Needed:** None new — this is entirely a refactor of existing crons to call existing code.
**Implementation Complexity:** Low
**Business Impact:** High
**Estimated Time:** 3-4 days (touches 10 files, each a small change)
**Priority:** ⭐⭐⭐⭐⭐

### 29.2 Wire WhatsApp into at least one high-value flow
**Status:** ✅ Done (2026-08-06) — see §64. Extracted the route handler's inline logic into an exported `sendWhatsAppMessage()` in `whatsapp.routes.js` (route is now a thin wrapper over it, same response shapes/status codes), and `amcRenewal.cron.js` calls it alongside its existing in-app reminder insert — the audit's own suggested pilot flow. Live-verified: `sendWhatsAppMessage()` correctly no-op-simulates and writes to `whatsapp_log` (`skipped_no_config`, since no `WHATSAPP_TOKEN` is set in this environment); wiring itself confirmed by code read. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `modules/integrations/whatsapp.routes.js:29-82` is a fully built, real Meta Graph API sender (simulates gracefully when unconfigured) — a standalone `POST /send` endpoint nothing else calls.
**Pain Point:** A working WhatsApp channel exists and is used by zero business flows.
**Automation Flow:**
```
Pick one high-value reminder (e.g. AMC renewal or AR overdue)
   ↓
Add a WhatsApp send call alongside the existing in-app insert, reusing whatsapp.routes.js's send function directly (not the HTTP endpoint — call the underlying function)
```
**Existing Components Reused:** Entire WhatsApp send implementation.
**New Components Needed:** One integration call from one cron job, as a pilot.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 2-3 days
**Priority:** ⭐⭐⭐

---

## 30. Approval Engine

### 30.1 Extend the generic Workflow Engine beyond Leave/Projects
**Status:** 🟡 Extend Existing
**Current Process:** `WorkflowService.js` + `workflows/workflow_steps/workflow_transitions/workflow_instances` are a real, generic, multi-step, role-routed approval engine (`migrations/20260429000001_workflow_engine.js`) — but only `leaves.routes.js` and `projects.routes.js` actually call it. Procurement, Travel, ECN, and Discounts each hand-roll their own status columns and approve/reject checks instead.
**Pain Point:** Every new module reinvents approval routing instead of configuring the engine that already exists — meaning fixes (like manager-hierarchy routing, below) have to be made N times instead of once.
**Automation Flow:**
```
Pick one hand-rolled module (Travel is the clearest candidate — see 30.2)
   ↓
Define its approval chain as workflow_steps/transitions instead of inline role checks
   ↓
Route submit/approve/reject through WorkflowService.initiateWorkflow/advanceWorkflow
```
**Existing Components Reused:** Entire `WorkflowService.js` + workflow tables.
**New Components Needed:** Workflow-step configuration rows per module being migrated; a thin adapter in each module's routes.
**Implementation Complexity:** High (touches live approval flows — needs careful rollout)
**Business Impact:** High
**Estimated Time:** 2-3 weeks per module migrated
**Priority:** ⭐⭐⭐⭐

### 30.2 Manager-hierarchy-aware routing
**Status:** 🔴 New Automation
**Current Process:** Every role-based approval check (clearest example: Travel's `req.user.role === 'manager'` in `travel.routes.js:1097` and `travel-reimbursement.routes.js`) checks only the role, never `reporting_manager_id` on `employees` — confirmed by the prior Business Process Architecture audit. Any holder of the `manager` role can approve any employee's request, not just their own reports.
**Pain Point:** This is a real authorization gap, not just a missing convenience — it's the same underlying issue as the "0 real automation" finding for hierarchy routing in the infrastructure inventory (section 0).
**Automation Flow:**
```
Approval request submitted
   ↓
WorkflowService (or the hand-rolled check, if not yet migrated) resolves requester's reporting_manager_id
   ↓
Only that manager (or their own chain upward) can approve — role check becomes role+relationship check
```
**Existing Components Reused:** `employees.reporting_manager_id` (already modeled per Org Setup), `WorkflowService.js` as the natural place to add this once.
**New Components Needed:** A hierarchy-lookup helper, called from `WorkflowService.advanceWorkflow` and from each hand-rolled check until migrated.
**Implementation Complexity:** Medium
**Business Impact:** High
**Estimated Time:** 1 week
**Priority:** ⭐⭐⭐⭐⭐

---

## 31. Workflow Engine

### 31.1 Generalize N-day escalation onto the engine itself
**Status:** ✅ Done (2026-08-06) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §61. `workflow_steps.sla_hours` already existed unused; new `jobs/workflowEscalation.cron.js` (hourly :10) walks pending steps past their step's `sla_hours` and fires the existing `notifyWorkflowEvent('escalated', ...)` path. §30.1 (extend the engine to a new module) and §30.2 (hierarchy check at the engine level) deliberately left open — user scoped this pass to §31.1 only, given §30.1's own 2-3-week-per-module estimate and the real behavior-change risk to an already-correctly-working module (Travel). Leaving the rest of this entry as historical record of the original ask.
**Current Process:** Only `leave.cron.js` implements real N-day pending-approval escalation (12.1). The generic `WorkflowService`/`workflow_instances` engine that leave and projects both run on has no escalation concept of its own — each module that wants escalation must reinvent it (as Quality's and Service Desk's *unused* escalation settings, 16.3/19.2, show happening today).
**Pain Point:** Escalation is currently a per-module afterthought instead of a property of the shared engine.
**Automation Flow:**
```
Daily cron (new, engine-level)
   ↓
workflow_instances WHERE status='pending' AND updated_at < NOW() - (step's configured escalation window)
   ↓
notifyWorkflowEvent('escalated', ...) to the next role up in that workflow's chain
```
**Existing Components Reused:** `workflow_instances` table, `leave.cron.js`'s escalation logic as the template, `notifyWorkflowEvent`.
**New Components Needed:** An `escalation_hours` column on `workflow_steps` (if not already present — verify before building) + one cron file.
**Implementation Complexity:** Medium
**Business Impact:** High
**Estimated Time:** 1 week
**Priority:** ⭐⭐⭐⭐

---

## 32. Audit Logs

### 32.1 Connect anomaly detection to a daily push
**Status:** ✅ Done (2026-08-06) — see `MODULE_FEATURE_CONNECTION_MANUAL.md` §66. `anomalyDetection.cron.js` already pushed notifications for flagged anomalies (§1.2/§40); this added a `logAudit({ action: 'anomaly_flagged.<slug>' })` call per anomaly, gated by a same-day dedup check, so flagged anomalies also become a permanent `audit_logs` record. Verified at the write-path level (synthetic anomaly round-tripped through the exact call shape); current live data doesn't trigger any of the 5 heuristics, so no real rows exist yet. Leaving the rest of this entry as historical record of the original ask.
**Current Process:** `audit_logs` (via `logAudit()`, `audit.repository.js:7`) is purely a passive, query-only history — nothing automates on top of it. Separately, `GET /api/ai/anomalies` (`ai.routes.js:349-451`) already detects invoice outliers, low attendance, PO price variance, TDS mismatch, and QC failures — unrelated to `audit_logs` and itself on-demand only.
**Pain Point:** Two pieces exist (a passive log, a real anomaly detector) that could combine into "flag suspicious activity automatically" but currently don't talk to each other or push anything.
**Automation Flow:**
```
Daily cron (new — same as 1.2, listed here for the Audit Logs angle specifically)
   ↓
Call existing /api/ai/anomalies logic
   ↓
Write flagged anomalies into audit_logs as a distinct event_type AND notify security/finance reviewers
```
**Existing Components Reused:** `/api/ai/anomalies`, `logAudit()`, notification repository.
**New Components Needed:** Cron wrapper; an `anomaly_flagged` event type in `audit_logs`.
**Implementation Complexity:** Low
**Business Impact:** Medium
**Estimated Time:** 2 days
**Priority:** ⭐⭐⭐⭐

---

## 33. Workflow Orchestration / Cross-Module Event Automation (summary view)

This isn't a separate module in the app — it's the cross-cutting theme the whole audit surfaces. The single biggest structural finding: **zero Node EventEmitter usage anywhere in `backend/src`.** Every cross-module cascade found in this audit (ticket→CSAT, regularization→attendance, SO→project→production, milestone→invoice, three-way-match→bill, ECN→BOM) is hand-coded inline in the specific route that causes it, with no shared "on this event, do these things" mechanism. This works today because each cascade was built carefully — but it also explains why the same shape of gap (a table/column that should trigger a side-effect but doesn't) recurs so many times across this audit: there's no central place to register "when X happens, also do Y," so each module either remembers to add the cascade inline or doesn't. Worth a future architectural conversation, but out of scope to build here per the "no redesign" constraint — noted for awareness, not proposed as a build item.

---

# Executive Summary

Methodology note: categories below intentionally overlap — the same ~45 identified opportunities
get sliced by different lenses (ROI, quick-win, module). Where a category genuinely has fewer
than 10 qualifying items after excluding anything already implemented or not evidenced in code,
the list is left short rather than padded — per the audit's no-wishlist rule.

## Top 10 Highest ROI Automations
1. **Reorder → auto-draft PR** (5.1) — closes the last mile on the app's best-built dashboard (EOQ Planner) and its own AI recommendation.
2. **Monthly depreciation cron** (7.2) — a fully-built, correct financial function currently producing zero output for want of one cron registration.
3. **Compliance evidence/audit reminders** (23.1) — the one module with literally zero automation today, in the domain where silent misses are costliest.
4. **SLA escalation for Service Desk** (19.2) — config already exists and is inert; wiring it protects customer-facing response commitments.
5. **Reminder crons bypass channel-aware repository** (29.1) — a one-time fix that upgrades ~8 existing reminders from in-app-only to real push/email/SMS, no new features needed.
6. **Manager-hierarchy-aware approval routing** (30.2) — closes a real authorization gap (any manager can approve anyone's request), not just a convenience.
7. **Vendor auto-notification on PO approval** (5.4) — removes a manual step from every single approved PO in the system.
8. **Auto-notify departments on ECN implementation** (18.2) — production/quality/procurement currently learn of engineering changes only by word of mouth.
9. **Ticket status → notify customer** (21.1) — closes the one silent direction in an otherwise-automatic customer-portal ticket loop.
10. **Patent/IP renewal reminders** (17.1) — cheapest possible port of an existing pattern, protects genuinely expensive IP assets from silent lapse.

## Top 10 Quick Wins (cheapest to build)
1. Monthly depreciation cron (7.2) — half a day, function already exists.
2. Patent/IP renewal reminders (17.1) — 1 day.
3. Quotation auto-expiry (3.2) — 1 day.
4. Asset warranty expiry push (24.2) — 1 day.
5. Lead/opportunity follow-up reminders (2.2) — 1-2 days.
6. Tender deadline/EMD reminders (2.3) — 1-2 days.
7. Vendor document expiry reminders (5.5/22.2) — 1-2 days.
8. Compliance evidence/audit reminders (23.1) — 1-2 days.
9. Non-IoT preventive maintenance reminders (26.3) — 1-2 days.
10. Calibration due-alerts push (16.2) — 1-2 days.

## Top 10 AI Automations
1. Device-failure prediction ✅ already implemented (26.2) — cite as the model to extend elsewhere.
2. CEO narrative summarization (`ceo-insights`) ✅ already implemented.
3. Cross-module prescriptive recommendations (`/prescriptive`) ✅ already implemented — Inventory/Finance/HR only today.
4. Fix inventory-prediction stub (6.2) — wire real consumption velocity.
5. Extend `/prescriptive` to Sales/Service using existing `customerHealth.service.js` scores.
6. Department-level narrative digests (pairs with 1.1/27).
7. Ticket/complaint thread summarization for Service Desk handoffs.
8. Project-health narrative on top of existing EVM/CPI/SPI numbers.
9. Quality defect-rate prediction from existing batch/quality-rating data.
10. Lead/opportunity prioritization ranking for Sales.

*(Vendor delivery-delay prediction and individual-level attrition risk are real candidates too but land past 10 — noted in section 27, not dropped, just not in the top slice.)*

## Top 10 "Zero-Code" Automations (schema/function/config already fully built — only scheduling or wiring needed)
1. Monthly depreciation cron (7.2) — function fully built, needs only a cron registration.
2. Non-IoT preventive maintenance reminders (26.3) — query already written in `maintenance.routes.js`.
3. Compliance evidence/audit reminders (23.1) — queries already written in `compliance.routes.js`.
4. Calibration due-alerts push (16.2) — query already written.
5. Lead/opportunity follow-up reminders (2.2) — due-date columns already exist and indexed.
6. Tender deadline reminders (2.3) — due_soon/emd_refund logic already written.
7. Vendor document expiry reminders (5.5) — `docsExpiringSoon` already computed in `vendorHealth.service.js`.
8. Asset warranty expiry (24.2) — query already exists in `assets.routes.js`.
9. GRN → 3-way match auto-trigger (5.6) — matching logic fully built, just needs to be called from GRN creation.
10. IMR/ECN/vendor-approval automations already shipped (14.2, 18.1, 22.1) — zero code needed, only worth knowing they exist so nobody re-proposes them.

## Top 10 Event-Driven Automations
1. Ticket resolved → CSAT survey ✅ already implemented (19.1).
2. Customer portal ticket → internal ticket ✅ already implemented (19.3/21.2).
3. Regularization approval → attendance record ✅ already implemented (11.2).
4. Sales Order accepted → Project + Production Order ✅ already implemented (3.1/14.1).
5. Production Order release → material reservation + backflush ✅ already implemented (14.2).
6. Milestone complete → invoice ✅ already implemented (13.1).
7. Three-way-match approved → Finance bill ✅ already implemented (5.6 partial/7.3).
8. Vendor-approval stage decision → auto-advance to next queue ✅ already implemented (22.1).
9. Ticket status change → notify customer 🔴 (21.1) — the missing half of an otherwise event-driven loop.
10. ECN implementation → notify affected departments 🔴 (18.2).

## Top 10 Scheduled (Cron) Automations
1. AR/AP overdue reminders ✅ (7.1).
2. AMC renewal reminders ✅ (20.1).
3. Leave accrual/carry-forward/escalation ✅ (12.1).
4. Attendance auto-absent/auto-checkout ✅ (11.1).
5. IoT device monitoring ✅ (26.1).
6. Reorder → auto-draft PR 🔴 (5.1).
7. Monthly depreciation 🔴 (7.2).
8. Compliance reminders 🔴 (23.1).
9. Patent/IP renewal reminders 🔴 (17.1).
10. Preventive maintenance reminders 🔴 (26.3).

## Top 10 Customer Experience Automations
1. Ticket resolved → CSAT survey ✅ (19.1).
2. Customer portal → internal ticket ✅ (19.3).
3. Ticket status → notify customer 🔴 (21.1).
4. AMC renewal reminders ✅ (20.1) — protects the customer relationship, not just internal ops.
5. Subscription renewal reminders 🔴 (20.2).
6. Vendor PO auto-notification 🔴 (5.4) — vendor-as-customer-of-procurement.
7. Quotation auto-expiry 🔴 (3.2) — keeps the customer-facing pipeline honest.
8. SLA escalation 🔴 (19.2) — protects response-time commitments.
9. Asset/warranty expiry reminders 🔴 (24.2).
10. Department digest narratives 🔴 (27) — indirect, improves how fast internal teams respond to customer-facing signals.

## Top 10 Employee Productivity Automations
1. Reorder → auto-draft PR (5.1) — removes a recurring manual task from procurement staff.
2. Onboarding checklist auto-init (9.1).
3. Auto-creation trigger on Hired status (10.1) — removes a manual click recruiters currently must remember.
4. Interview reminder cron (10.2).
5. Offer-letter auto-draft at offer stage (10.3).
6. Exit offboarding auto-tasking + gate enforcement (9.2).
7. F&F auto-trigger (9.3).
8. Lead/opportunity follow-up reminders (2.2) — removes manual pipeline-checking from sales reps.
9. Vendor auto-selection suggestion on PR→PO (5.2).
10. In-context AI drafting assist (27) — reduces manual composition time across HR/QC/CRM forms.

## Top 10 Manufacturing Automations
1. Sales Order → Production Order auto-creation ✅ (14.1).
2. Material reservation + backflush on order release ✅ (14.2).
3. Quality stop-ship / inspection gating ✅ (14.3) — the strongest example in the app.
4. Auto-NCR on inspection/test failure ✅ (16.1).
5. BOM auto-promotion on ECN implement ✅ (18.1).
6. IMR auto-completion on full assignment ✅ (15.2).
7. Auto-trigger MRP run on new demand 🔴 (15.1).
8. NCR critical-escalation wiring 🔴 (16.3).
9. ECN auto-notify affected departments 🔴 (18.2).
10. Preventive maintenance reminders 🔴 (26.3).

## Top 10 Finance Automations
1. AR/AP overdue reminders ✅ (7.1).
2. Three-way-match → auto Finance bill ✅ (7.3).
3. PO value-based tiered approval routing ✅ (5.3) — includes an automated vendor-quality gate.
4. Payroll auto-enrollment across all hire paths ✅ (8.1).
5. Milestone complete → auto invoice ✅ (13.1).
6. Monthly depreciation cron 🔴 (7.2) — the single cheapest, highest-impact fix in this entire audit.
7. GRN → auto 3-way-match trigger 🟡 (5.6).
8. Quotation auto-expiry 🔴 (3.2) — keeps pipeline-to-revenue reporting honest.
9. Subscription renewal reminders 🔴 (20.2).
10. Discount-approval linkage to quotations 🔴 (2.4).

---

## Closing note on tagging discipline
Every ✅ above was confirmed by reading the actual route/service/migration file cited, not
inferred from a table name or a UI screenshot. Every 🔴/🟡 was confirmed by grepping the 11
real cron files and the relevant route file for the specific behavior claimed to be missing —
absence of a match, not assumption, is what earns the 🔴. Where the research could not reach
a definitive answer within scope (e.g., some Marketing/R&D corners), the entry says so plainly
rather than guessing.
