# Manifest ERP — Complete Functional Audit

**Date:** 2026-09-17 · **Scope:** all modules · **Method:** static inventory + live API probe + database introspection + full test-suite execution
**Environment audited:** local dev stack — backend `localhost:5000` (live), PostgreSQL `Pulse` (631 tables), frontend `Pulse/frontend`
**Data handling:** read-only. No row was created, updated or deleted. Every live call issued was a `GET`.

---

## Remediation status — updated 2026-09-17, after the audit

The findings below are preserved as found. This is what has since been fixed
(architecture manual §174 and §175; backend suite **1,822 passed / 0 failed**):

| # | Finding | Status |
|---|---|---|
| C-1 | Phantom 159 pending leave approvals | **FIXED** — 18 query sites + 4 files repointed to `leave_applications`; `pendingApprovals` **170 → 11**, pending queue now empty |
| C-2 | Cash Flow Statement 500 | **FIXED** — `cost` → `purchase_cost`; screen and CSV export both **200** |
| C-4 | Test suite red | **FIXED** — CSV guard no longer walks `database/migrations/` |
| §E-1 | `/leaves` exposed colleagues' records | **FIXED** — server-side `scopeToSelf()` / `canSeeApplication()`; a client-supplied `employee_id` is now overwritten, detail route 404s |
| — | New leave applications had NULL `company_id` | **FIXED** — derived from the employee on insert |
| — | WhatsApp webhook had never processed a message (`employees.mobile` does not exist) | **FIXED** — found during C-1 remediation; see §174.2 |
| C-3 | Biometric unmapped 500 | **FIXED** (§175.5) — `employee_id` → `office_id`; 200, mutation-checked |
| C-6 | `/roles` 404 + hardcoded fallback | **FIXED** (§175.5) — picker now reads the role registry; 26 roles selectable, was 4 |
| C-7 | Dead duplicate tables | **RESOLVED** (§175.2–.3) — the 8 GL lines proven to be a redundant copy, not lost detail; `unit.deadTableGuard.test.js` now fails CI if any dead table is referenced again |
| C-8 | Attendance had zero tests | **FIXED** (§175.6) — `integration.attendanceContract.test.js`, 23 real-DB tests |
| C-10 | `company_id` nullable schema-wide | **CLOSED for the ten transactional tables** (§175.4, §176) — all 36 NULL rows resolved, **19 write paths fixed so new rows carry a tenant**, and `company_id` is now `NOT NULL` on all ten. Tables with NULL rows 27 → 17; `NOT NULL` columns 114 → 124. The remaining 17 are shared reference data and platform audit logs. One sub-claim of this finding was **wrong and has been corrected** — see §E. |
| — | Attendance tiles read 0% forever — `attendance` frozen since 2026-03-29, plus a Title-Case/lowercase status mismatch | **FIXED** (§175.1) — found while writing the tests; 10 query sites repointed, all now use `sqlAttendancePresent()` |
| — | "Low Attendance" anomaly detector had never fired | **FIXED** (§175.1) |
| C-5 | IoT never ingested | open — blocked on hardware |
| C-9 | Missing pagination / date filters | open |

**Deliberately not done:** the 769 rows in `leave_requests` are untouched. Nothing
reads them for counts any more and the subject-access export reads both tables, so
they are correctly preserved history. Migrating the 159 still marked `pending` into
the live ledger would recreate the queue C-1 removed — six months stale, in the
right table. Archiving or purging is a data decision, not a code one.

---

## 0. How to read this report

The brief said: *do not assume a feature exists merely because its page, button, API, or database
table exists.* That rule turned out to be the single most important thing about this system, because
of one fact established in §1.3:

> **305 of 631 tables (48%) contain exactly 5 rows**, generated on 2026-08-20 by
> `backend/scripts/seed/seed-empty-tables.mjs --rows=5` — a schema-introspection fixture generator
> whose stated purpose is "so that code paths which only run when a table has data actually execute".

That means **"the endpoint returns 200 with rows in it" is not evidence that a workflow works.** For
roughly half this system it is evidence that a fixture row exists. Every classification below states
which kind of evidence backs it. Where I did not test something, I say so rather than inferring.

**Evidence classes used throughout:**

| Class | Meaning |
|---|---|
| `LIVE` | I called it against the running server and read the response |
| `DB` | I queried the live database directly |
| `TEST` | Covered by an automated test that executed in this audit's suite run |
| `CODE` | Read from source; behaviour inferred, not executed |
| `NOT TESTED` | Outside this pass — see §14 coverage statement |

---

## A. Executive summary

| Metric | Value | Evidence |
|---|---|---|
| Backend modules | 48 source modules | `CODE` |
| Route files mounted | 208 (0 orphaned) | `CODE` |
| HTTP endpoints registered | **3,288** unique method+path | `CODE` |
| Frontend page components | 517 | `CODE` |
| Frontend routes registered | 472 manual + convention-based auto-discovery | `CODE` |
| Navigation entries | 366 distinct, **0 broken** | `CODE` |
| Database tables | **631** | `DB` |
| Automated tests | **1,655 pass / 1 fail / 9 skipped** (77 files, 132s) | `TEST` |
| RBAC regression probe | **27 / 27 pass** | `LIVE` |
| Background jobs | 43 cron files, **all 43 registered at boot** | `CODE` |
| Live GET probe (list routes) | **1,182 of 1,272 returned 200** | `LIVE` |
| Live GET probe (detail `:id` routes) | **117 of 119 returned 200, zero 5xx** | `LIVE` |
| Field-level PII filtering | **Verified** — 81 fields to admin, 50 to employee, all PII stripped | `LIVE` |
| Tenant isolation | **Verified** — zero cross-tenant rows across 11 tenants | `LIVE` |

### The headline

**Manifest ERP is structurally sound and unusually well-wired.** The things that normally rot in a
system this size — orphan routers, dead menu links, frontend calling endpoints that don't exist,
unregistered cron jobs — are essentially absent here. That is a genuine and uncommon result, and it
is evidenced, not assumed:

- 0 of 208 route files unmounted (25 initially looked orphaned; all 25 resolved as nested or aliased sub-routers)
- 0 of 366 navigation entries point at a missing page
- 2,051 of 2,101 distinct frontend API calls resolve to a real backend endpoint; of the 50 that
  didn't, 49 were artifacts of my own path normaliser and **1 was a real defect**
- 43 of 43 cron jobs are actually started by `server.js`

**What is weak is not the wiring — it is proof of operation.** Half the database is fixture data,
eight modules carrying 557 endpoints have no automated test at all, and the modules that look
healthiest by endpoint count (Service Desk, Performance, Training, Payroll, Recruitment,
Engineering/R&D, Documents) have **zero tables containing organic business data**.

### Critical issues (detail in §C)

| # | Severity | Finding |
|---|---|---|
| 1 | **P0** | Dashboard "Pending Approvals" reports **159 phantom leave approvals** from a table the leave workflow abandoned on 2026-03-30. Approvers see work that cannot be actioned. |
| 2 | **P1** | `GET /statements/cash-flow` returns **HTTP 500** — the Cash Flow Statement is entirely unavailable. Cause: `SELECT SUM(cost) FROM fixed_assets`; the column is `purchase_cost`. |
| 3 | **P1** | `GET /biometric/employees/unmapped` returns **HTTP 500** — cause: `employees.employee_id` does not exist. |
| 4 | **P1** | The test suite is **red on main** (1 failure) from another session's in-flight migration. |
| 5 | **P1** | `GET /leaves` returns **other employees' leave records and reasons** to any employee — every employee holds the module-level `leaves:view` grant that opens the unscoped list route. |
| 6 | **P2** | IoT is fully built and **has never ingested a single reading** — 19 of its 24 tables are empty. |
| 7 | **P2** | `GET /roles` 404s; the IoT Alert Rules escalation picker silently falls back to 4 hardcoded roles out of 26 real ones. |
| 8 | **P2** | 5 dead duplicate tables still carry rows, including 8 rows in an orphaned `journal_entry_lines`. |
| 9 | **P1** | **9 of 14 major list endpoints have no pagination** and return the whole table; **13 of 14 cannot filter by date range.** Invisible at today's 39-row volumes, breaks at production scale. |
| 10 | **P1** | `company_id` is nullable on **77% of the 489 tables that carry it**; 14,356 rows hold NULL. Two incompatible scoping idioms are in live use, so a NULL-tenant row is either invisible to all tenants or visible to all of them. Tenant-scoped unique indexes are provably bypassed. |
| 11 | **P2** | 8 modules / 557 endpoints have **zero automated test coverage**. |

---

## B. Module-wise status

Measured, not estimated. `GET ok` = parameterless GET endpoints that returned 200 in the live probe.
`seed5` = backing tables holding exactly the 5-row fixture. `organic` = tables holding data that did
not come from the fixture generator.

| Module | APIs | GET ok | fail | tables | empty | seed5 | organic | tests |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Finance & Accounting | 314 | 127/137 | 1 | 40 | 0 | 28 | 3 | 2 |
| CRM | 199 | 63/66 | 0 | 23 | 0 | 7 | 3 | 5 |
| Inventory / Materials | 196 | 81/82 | 0 | 43 | 4 | 9 | **8** | 6 |
| Service Desk | 195 | 66/72 | 0 | 40 | 3 | 28 | **0** | 2 |
| HRM (core) | 191 | 57/67 | 0 | 31 | 0 | 20 | 3 | 2 |
| Sales | 182 | 73/74 | 0 | 40 | 0 | 19 | 3 | 4 |
| Admin & Settings | 175 | 54/59 | 0 | 31 | 1 | 9 | 9 | 4 |
| Procurement | 168 | 52/59 | 0 | 43 | 7 | 17 | 3 | **14** |
| Dashboard & Analytics | 165 | 113/122 | **9** | 5 | 1 | 0 | 1 | 4 |
| Attendance | 149 | 61/64 | 1 | 22 | 0 | 13 | 4 | **0** |
| Projects | 135 | 45/47 | 0 | 15 | 0 | 9 | 0 | 1 |
| Production / Mfg | 129 | 31/40 | 0 | 43 | 1 | 11 | **9** | 3 |
| Leave | 104 | 29/32 | 0 | 10 | 0 | 4 | 3 | 1 |
| Performance Mgmt | 89 | 33/33 | 0 | 24 | 0 | 21 | **0** | **0** |
| Travel & Expense | 87 | 43/43 | 0 | 11 | 0 | 6 | 2 | **0** |
| Training / L&D | 84 | 34/34 | 0 | 14 | 0 | 9 | **0** | **0** |
| Documents & e-Sign | 83 | 11/11 | 0 | 16 | 0 | 8 | **0** | 1 |
| Recruitment / ATS | 77 | 30/30 | 0 | 16 | 0 | 6 | 1 | **0** |
| Payroll | 65 | 19/27 | 0 | 13 | 0 | 11 | **0** | 2 |
| Quality | 61 | 20/20 | 0 | 19 | 0 | 14 | 1 | 1 |
| Engineering / R&D | 59 | 15/15 | 0 | 17 | 0 | 10 | **0** | 1 |
| IoT | 58 | 15/15 | 0 | 24 | **19** | 1 | 2 | 5 |
| Approvals | 54 | 12/13 | 0 | 15 | 0 | 5 | 1 | 4 |
| Assets | 37 | 11/11 | 0 | 5 | 0 | 2 | 0 | **0** |
| Marketing | 34 | 16/16 | 0 | 10 | 2 | 7 | 0 | 1 |
| Timesheets | 22 | 9/11 | 0 | 2 | 0 | 0 | 1 | **0** |
| Audit & Security | 19 | 5/6 | 0 | 10 | 0 | 4 | 4 | 4 |
| Compliance | 12 | 3/3 | 0 | 3 | 0 | 2 | 0 | **0** |
| Notifications | 11 | 2/2 | 0 | 2 | 0 | 0 | 2 | 1 |
| Reports & BI | 8 | 4/4 | 0 | 1 | 0 | 0 | 0 | 1 |

*(3,162 of 3,288 endpoints map to a named module; the remainder are auth, health, webhooks, public
portal and QR-share paths.)*

### Reading the table

- **`organic = 0` is the column that matters.** Service Desk, Performance, Training/L&D, Payroll,
  Documents/e-Sign and Engineering/R&D each expose 59–195 endpoints over tables that have never held
  anything but fixture rows. Their code may well be correct — but nothing in this system demonstrates it.
- **Procurement is the best-evidenced module**: 14 test files, real lifecycle coverage.
- **Production and Inventory have the deepest organic data**: `mrp_planned_orders` 14,135 ·
  `mrp_time_phased` 18,334 · `crp_load` 12,240 · `mrp_exceptions` 6,223 · `inventory_planning_run_items`
  4,222 · `demand_forecasts` 2,637 · `inventory_fifo_layers` 1,288 · `stock_ledger` 449. The planning
  spine is genuinely running, not decorative.
- **Dashboard's 9 failures are honest**: nine `/intelligence/*` endpoints return `501` with the message
  *"This capability is not implemented — it has no backing table in the schema."* That is the correct
  way to ship an unimplemented capability, and I am classifying it as such, not as a defect.
- **Detail (`:id`) routes are clean.** A second live sweep resolved a real id from each endpoint's
  sibling list route and called the detail route: **117 of 119 returned 200, with zero 5xx.** The two
  non-200s were correct 404s (`/attendance/policies/type/3` → "No active policy of this type";
  `/vendor-registration/status/25` → "Not found"). The record-retrieval leg of CRUD is in good shape
  across every module that exposes one.

---

## C. Critical findings, with evidence

### C-1 · P0 — The Pending Approvals KPI counts 159 approvals nobody can action

**Status: BROKEN.** Evidence: `LIVE` + `DB` + `CODE`.

There are two leave tables. The leave workflow writes one; the dashboards read the other.

```
DB:  leave_applications   4 rows   last written 2026-04-25   <- the leave module's INSERT target
DB:  leave_requests     769 rows   last written 2026-03-30   <- what the dashboards count
DB:  leaves               1 row    last written 2026-02-26   <- legacy, dead
```

The only `INSERT INTO leave_applications` in the codebase is
`src/modules/leaves/repositories/leaves.repository.js:102` — the real "apply for leave" path. The only
`INSERT INTO leave_requests` is in `src/modules/integrations/whatsapp.routes.js:125`.

`GET /api/v1/leaves` returns rows from `leave_applications`. But
`src/modules/dashboard/dashboard.controller.js:44` defines the canonical pending-approvals query
against `leave_requests`, with a comment asserting that table is "the live ledger". **That comment is
wrong** — it was true when written, but the write path moved.

Live, right now:

```
GET /api/v1/dashboard/approvals
  {"summary":[{"type":"Leave","count":159}, ...],
   "pending":[{"id":6,"employee_name":"Anu Natesh","status":"pending",
               "created_at":"2026-03-17","days_waiting":184}, ...]}

GET /api/v1/dashboard/summary     -> "pendingApprovals": 170
GET /api/v1/dashboard/live-kpis   -> finance.pendingApprovals: 170
```

**Business impact.** Every approver's home screen shows 159 leave approvals pending for 184 days.
They are unactionable: the Leave screens read the other table. The number can never go down, because
nothing writes to `leave_requests` any more. This also poisons `pendingApprovals: 170` on the
executive summary and live-KPI endpoints.

**Fix.** Decide which table is canonical (it should be `leave_applications` — it is where the workflow
writes), repoint `PENDING_APPROVALS_SQL` and the four other `leave_requests` readers
(`aiPayroll.service.js:482`, `ai.routes.js`, `whatsapp.routes.js`, `security.routes.js`), migrate any
still-genuinely-pending rows across, and archive `leave_requests`. Correct the misleading comment at
`dashboard.controller.js:34-42` in the same change — it is what will cause this to regress.

---

### C-2 · P1 — The Cash Flow Statement is dead

**Status: BROKEN.** Evidence: `LIVE` + `DB` + `CODE`.

```
LIVE: GET /api/v1/statements/cash-flow        -> HTTP 500 {"error":"column \"cost\" does not exist"}
LIVE: GET /api/v1/statements/export/cash-flow -> HTTP 500 {"error":"column \"cost\" does not exist"}
```

**Both the on-screen statement and its CSV export are down** — the export path shares the same query.
Its four siblings are healthy: `export/balance-sheet`, `export/income-statement` and
`accounting/trial-balance/export` all return `200 text/csv`.

`src/modules/finance/statements.routes.js:217`:

```sql
SELECT COALESCE(SUM(cost),0) AS total FROM fixed_assets WHERE DATE(purchase_date) BETWEEN $1 AND $2 ...
```

`DB`: `fixed_assets` has no `cost` column. It has `purchase_cost`, `salvage_value`,
`current_book_value`, `cost_center_id`.

This is a one-word fix (`cost` → `purchase_cost`), but note *why* it reached production: the file
was deliberately hardened so a failed query raises instead of silently returning zero (see the
comment at lines 20–31 — "A financial figure that could not be computed is an error, not a zero").
That hardening is correct and is what surfaced this. Before it, the capex line would have read ₹0 and
the statement would have rendered as if balanced.

`FinancialStatements.jsx` calls this endpoint, so the Cash Flow tab is broken in the UI.

---

### C-3 · P1 — Unmapped-biometric employee list is dead

**Status: BROKEN.** Evidence: `LIVE` + `DB` + `CODE`.

```
LIVE: GET /api/v1/biometric/employees/unmapped -> HTTP 500 {"error":"column \"employee_id\" does not exist"}
```

`src/modules/hr/biometric.routes.js:723` selects `employee_id AS emp_code FROM employees`. `DB`
confirms `employees` has no `employee_id` column (the employee-code-ish columns are `office_id`,
`employment_type`, `employee_role`).

**Business impact.** This is the screen an HR admin uses to find employees who have no biometric
enrolment. While it 500s, biometric rollout gaps are invisible — which silently degrades attendance
capture completeness.

---

### C-4 · P1 — Test suite is red on main

**Status: BROKEN (build).** Evidence: `TEST`.

```
Test Files  1 failed | 76 passed (77)
     Tests  1 failed | 1655 passed | 9 skipped (1665)
```

Failure: `unit.csvWriter.test.js > repo guard — nothing re-rolls its own CSV escaping`.

Offender: `src/database/migrations/20260917000004_pct_family_seed_purge.js` — a migration dated
**today**, from a concurrently-running session.

I verified the flagged line is **not** a CSV-injection vector. Line 145 is:

```js
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;   // SQL identifier quoting
```

That is SQL identifier quoting, the same construct the guard already allowlists for
`modules/admin/systemHealth.routes.js`. The guard's regex cannot distinguish the two, and it walks
`src/database/migrations/` as well as routes and services.

**So: the build is broken, but no security defect exists here.** Fix is to scope the guard's walk to
exclude `database/migrations/`, or allowlist this file. Worth doing promptly — a red suite trains
people to ignore the suite.

---

### C-5 · P2 — IoT has never received a reading

**Status: NOT IMPLEMENTED (operationally) / FULLY IMPLEMENTED (code).** Evidence: `DB` + `TEST`.

19 of IoT's 24 tables are empty, including every one that would carry operational data:

```
device_telemetry(0)  device_telemetry_2026_07(0)  device_telemetry_2026_08(0)
device_telemetry_2026_09(0)  device_telemetry_default(0)  device_latest(0)
device_alerts(0)  device_alert_rules(0)  iot_gateways(0)  iot_device_tokens(0)
iot_device_events(0)  iot_ingest_batches(0)  iot_outbox(0)  iot_rejected_samples(0)
iot_rule_state(0)  iot_maintenance_windows(0)  iot_service_parts(0)
iot_hardware_pilots(0)  iot_hardware_pilot_readings(0)
```

Non-empty: `iot_metric_definitions(42)`, `iot_legacy_quarantine(35)`, `iot_device_profiles(3)`,
`iot_notification_log(4)` — registry and config, no telemetry.

This is **not** a code defect. IoT has the best test-to-size ratio in the system (5 test files for 58
endpoints, including `iot.ingest.e2e` and `iot.pilot.e2e`), the partition cron is registered, and the
monthly telemetry partitions for Jul/Aug/Sep 2026 have been created on schedule. The module is
waiting for hardware.

**Classification:** `BLOCKED / REQUIRES EXTERNAL INTEGRATION`. What is missing is a provisioned
device and a token, not software. Until then no claim about IoT→Assets or IoT→Service data flow can
be substantiated, because no data has ever traversed it.

---

### C-6 · P2 — `/roles` 404s; IoT alert escalation silently falls back to 4 hardcoded roles

**Status: BROKEN (masked).** Evidence: `LIVE` + `DB` + `CODE`.

```
LIVE: GET /api/roles      -> 404
LIVE: GET /api/admin/roles -> 404
LIVE: GET /api/security/roles -> 404
```

`features/iot/pages/AlertRules.jsx:98` calls `api.get('/roles')` to populate the **"Notify these
roles"** multi-select. The call 404s, `roles` stays `[]`, and line 499 falls back to a hardcoded
literal:

```js
{(roles.length ? roles.map((r) => r.code || r) : ['service_manager','service_engineer','admin','production_manager'])
```

`DB` confirms `roles` holds **26** active role codes. So an admin configuring IoT alert escalation can
target 4 of them; the other 22 — including `qc_manager`, `project_manager`, `finance_manager`,
`department_head`, `l2_approver` — are unreachable from that screen.

This is the dangerous shape of bug: the page renders, the dropdown populates, nothing errors. Only the
404 in the network tab tells you the list is fabricated.

**Fix.** Add a `GET /roles` read endpoint (or repoint the call at whatever the canonical roles read is),
and **remove the fallback array** — an empty dropdown that says "could not load roles" is safer than a
plausible wrong one.

---

### C-7 · P2 — Dead duplicate tables still holding rows

**Status:** Evidence: `DB` + `CODE`. Non-migration source files referencing each:

| Table | Rows | Source refs | Verdict |
|---|---:|---:|---|
| `journal_entry_lines` | **8** | 0 | **DEAD** — `journal_lines` (30 rows, 19 refs) is live |
| `stock_movements` | 5 | 0 | DEAD — `stock_ledger` (449 rows, 25 refs) is live |
| `payroll_slips` | 5 | 0 | DEAD — `payslips` is live |
| `putaway_tasks` | 0 | 0 | DEAD — `put_away_tasks` (4 rows) is live |
| `talent_pool_candidates` | 5 | 0 | DEAD — `talent_pool_members` is live |
| `leaves` | 1 | 1 | Near-dead legacy (see C-1) |
| `non_conformance_reports` | 5 | 2 | Secondary to `ncr_reports` (13 rows, 19 refs) |

`journal_entry_lines` holding 8 rows is the one to look at first: those are **general-ledger lines in a
table no code reads**. Either they are orphaned history (archive them) or something historically wrote
GL detail to the wrong table, in which case the ledger is short 8 lines.

---

### C-8 · P2 — Eight modules have no automated test coverage

**Status:** Evidence: `TEST` (absence).

| Module | Endpoints | Test files |
|---|---:|---:|
| Attendance | 149 | 0 |
| Performance Management | 89 | 0 |
| Travel & Expense | 87 | 0 |
| Training / L&D | 84 | 0 |
| Recruitment / ATS | 77 | 0 |
| Assets | 37 | 0 |
| Timesheets | 22 | 0 |
| Compliance | 12 | 0 |
| **Total** | **557** | **0** |

Attendance is the one that should worry you most: 149 endpoints, 22 tables, payroll-affecting, with
geo-fencing, face capture, biometric sync, offline PWA punch queue, regularisation and OT — and no
regression test at all. It is also the module with a live 500 (C-3).

---

## D. Business-process gaps

Derived from `DB` emptiness plus `CODE` reference counts — these are workflows the system can perform
but has never performed.

| Workflow | Evidence | Status |
|---|---|---|
| **Warranty claim** | `warranty_claims(0)`, 2 source refs; `warranty_registrations(5)` are fixtures | NOT EXERCISED — registration exists, claim path never run |
| **AMC contract lifecycle** | `amc_contracts(0)` with **12** source refs, and `amcRenewal.cron.js` registered | The renewal cron runs nightly over an empty table. Contract creation has never happened. |
| **RFx award** | `rfx_vendor_selections(0)`, `procurement_award_decisions(0)` | Scoring is tested (`rfxScoringEngine`), but no award has ever been recorded — the last step of source-to-contract is unproven |
| **Supplier development** | `supplier_development_plans(0)`, `supplier_development_actions(0)` | Module built + tested (`integration.supplierDevelopment`), zero real plans |
| **Savings register** | `savings_initiatives(0)`, `savings_events(0)` | Built + tested, never used |
| **Email-to-case** | `support_mailboxes(0)`, `inbound_emails(0)` | Ingest router mounted at `/support-mail`; **no mailbox is configured**, so no email can become a ticket |
| **Knowledge base lifecycle** | `knowledge_article_versions(0)`, `_feedback(0)`, `_cases(0)` | Articles exist (5 fixtures); versioning, feedback and case-linking never used |
| **Landed cost** | `landed_costs(0)` | Costing path never exercised — affects inventory valuation accuracy |
| **Production order BOM explosion** | `production_order_bom_lines(0)` with 11 production orders | Orders exist without exploded BOM lines. Per-order material planning cannot be reconstructed from this table. |
| **Partner deal registration** | `partner_deal_registrations(0)`, `_events(0)` | Built + tested (`dealRegistration`), never used |
| **Component installation tracking** | `component_installations(0)` | Serial→install linkage never recorded |

**The pattern.** These are not missing features. In most cases the code, tests and cron are all
present — what is missing is the first real transaction. That distinction matters for planning: these
need **pilot data and an owner**, not development.

---

## E. Security gaps

**Overall: strong.** This is the best-defended part of the system, and unusually so.

| Control | Status | Evidence |
|---|---|---|
| RBAC regression probe | **27/27 pass** | `LIVE` — `npm run check:authz` |
| Role model | Many-to-many via `user_roles` (157 rows), 26 roles, 962 role-permission grants | `DB` |
| Field-level permissions | `applyFieldPermissions()` mounted on employees, finance, payroll, hr, crm, sales | `CODE` |
| Audit floor | `auditMutations(module)` mounted per-router — records every successful POST/PUT/PATCH/DELETE | `CODE` · `audit_logs` = 47,581 rows (`DB`) |
| Denial logging | `access_denials` = 8,985 rows | `DB` |
| Auth audit | `auth_audit_log` = 681 rows; lockout after 5 failures / 15 min | `DB` · `CODE` |
| Tenant scoping | Verified in probe: employee sees 1 person where admin sees 34, on both `/leaves/allocations` and `/leaves/accrual-history` | `LIVE` |
| Public routes | Deliberately scoped — the `verifyToken` mount for `vendorRoutes` and `biometricRoutes` is pinned to explicit prefixes, with source comments explaining that a bare mount would become a global auth gate | `CODE` |
| CSV injection guard | Enforced by test (currently false-positiving, see C-4) | `TEST` |
| Response cap / rate limit / helmet / request-id | All mounted | `CODE` |

### Verified live in this audit

**Tenant isolation holds — tested, not assumed.** `admin@manifest.in`'s JWT carries
`company_id: null`, and scoped queries use the `($1::int IS NULL OR company_id = $1)` idiom, so the
obvious worry is that a null company id reads across all tenants. **It does not.** Measured:

```
LIVE: GET /api/v1/employees as admin -> 33 rows, company_id distribution {"1": 33}
DB:   employees span 11 companies — company 1 (34) plus 10 others holding 1 each
```

Zero cross-tenant rows were returned. `companyOf(req)` resolves the caller's real tenant rather than
trusting the token claim, which is exactly the documented contract. The same held for `pilot.hr` and
a plain employee.

**Module-level RBAC holds.** `LIVE` — comparing three identities on the same endpoints:

| Endpoint | admin | pilot.hr (`hr`) | john.doe (`employee`) |
|---|---|---|---|
| `/crm/leads` | 200 (20 rows) | **403** | **403** |
| `/sales/orders` | 200 (39) | **403** | **403** |
| `/procurement/purchase-orders` | 200 (5) | **403** | **403** |
| `/projects` | 200 (6) | **403** | **403** |

**Field-level permissions holds, and is doing real work.** `LIVE` — the same `/employees` call:

| Caller | Fields returned | Sensitive fields |
|---|---:|---|
| admin | **81** | `aadhaar_number`, `pan_number`, `account_number`, `ifsc_code`, `basic_salary`, `pf_number`, `uan_number`, `esic_number`, `passport_number`, `dob`, document file paths |
| employee | **50** | **all of the above stripped** |

`applyFieldPermissions('employees')` is genuinely filtering payroll and identity PII out of the
employee-facing directory. This is the control most systems claim and few implement.

### Gaps found

1. **P1 — `GET /api/v1/leaves` returns other employees' leave records to any employee.**
   `LIVE` + `DB` + `CODE`. Measured: john.doe (`employee_id` 10, role `employee`) receives 4 leave
   applications, **all belonging to `employee_id` 1** — including each one's `reason` free-text.

   Cause is a design seam, not a bug in the handler. `leaves.routes.js:1238` gates `GET /` on
   `requirePermission('leaves','view')` — a **module-level** grant — and then returns the whole
   company's applications. `DB` confirms the `employee` role holds `leaves: view, add`. The correctly
   scoped self-service route already exists beside it (`GET /leaves/my`, line 1256, hard-scoped to
   `req.user.employee_id`, deliberately ungated, with a comment explaining why).

   So the two routes are correct individually; what is wrong is that every employee holds the
   module grant that opens the unscoped one. Today this exposes 4 fixture rows. It exposes the whole
   company's medical and personal leave reasons the moment leave is actually used.

   **Fix options:** (a) drop `leaves:view` from the `employee` role and point self-service at
   `/leaves/my` — cleanest; (b) make `GET /` self-scope when the caller holds only a base grant.
   Option (a) is consistent with how attendance already carves out self-service.

2. **P1 — `company_id` is nullable almost everywhere, and two incompatible scoping idioms read it.**
   `DB` + `CODE`. This is the most systemic issue found in this audit.

   ```
   DB: tables carrying a company_id column        : 489
   DB: …where company_id is declared NOT NULL     : 114  (23%)
   DB: rows currently holding NULL company_id     : 14,356  across 27 tables
   ```

   Two different scoping predicates are in live use across the codebase:

   ```
   CODE: "company_id = $1"                          — 1,136 occurrences
   CODE: "... OR company_id IS NULL"                —   285 occurrences in 92 files
   ```

   A row with `company_id = NULL` therefore behaves in **opposite** ways depending on which query
   reaches it: it is **invisible to every tenant** under the first idiom, and **visible to every
   tenant** under the second.

   **Some of this is deliberate and correct.** `chart_of_accounts` (132/132 NULL), `master_values`,
   `iot_metric_definitions`, `geo_locations`, `validation_rules`, `email_templates` and `roles` are
   shared reference data, and `accounting.routes.js:435` reads them with the explicit
   `AND (company_id = $1 OR company_id IS NULL)` — a global default chart every tenant inherits.
   I initially suspected a scoped finance user would see zero accounts; reading the SQL disproved
   that. **That design is fine.**

   **The concern is the transactional tables that have picked up NULL-tenant rows:**

   | Table | NULL / total |
   |---|---|
   | `journal_lines` | 12 / 30 |
   | `production_operations` | 7 / 14 |
   | `pick_lists` | 5 / 6 |
   | `bom_lines` | 3 / 13 |
   | `quotations` | 3 / 9 |
   | `lifecycle_instances` | 2 / 19 |
   | `leads` | 1 / 22 |
   | `attendance_records` | 1 / 74 |
   | `engineering_changes` | 1 / 4 |
   | `travel_requests` | 1 / 285 |

   These are not reference data. A general-ledger line, a quotation or a BOM line with no tenant is
   either lost or leaked, and which one depends on the accident of which query reads it.

   **Correction (2026-09-26) — this claim was wrong.** The original text read:

   > *Proven consequence — tenant-scoped uniqueness does not bind. `test@dbtest.com` appears twice in
   > `leads`, once under company 1 and once under no company at all. Because `NULL <> NULL` in
   > Postgres, a NULL-tenant row slips past every composite unique index that leads with `company_id`.*

   Re-tested when the remediation reached this finding. The two rows are:

   ```
   leads_company_email_unique ON leads (company_id, email)
     WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL

   id  9   company_id 1     test@dbtest.com   deleted_at NULL
   id 10   company_id NULL  test@dbtest.com   deleted_at 2026-07-09   ← excluded by the partial WHERE
   ```

   Row 10 is excluded from the index by `deleted_at IS NULL`, **regardless of its `company_id`**. The
   NULL tenant is not what lets the pair coexist, so this was not evidence of a uniqueness bypass. A
   sweep of all **68** company-led unique indexes found **no** NULL-tenant row anywhere in this
   database duplicating a stamped value.

   The mechanism is real in principle — `NULL <> NULL` does mean a NULL-tenant row cannot collide on a
   `(company_id, …)` index — but it had no live instance here, and this report should not have called
   it proven. The ordering, scoping and reporting consequences described above are unaffected;
   duplicate prevention (see below) stands as measured.

   **Fix direction.** Classify each of the 489 tables as *shared reference* or *tenant-owned*. For
   tenant-owned tables, backfill the NULL rows and add `NOT NULL`. For shared reference tables, keep
   NULL and standardise on the explicit `OR company_id IS NULL` read. Today the distinction lives only
   in the reader's choice of predicate, which is why it drifts.

3. **P2 — 41 companies for 44 employees.** `DB`. 10 tenants hold exactly one employee each. A
   `purge-leaked-test-tenants.mjs` script exists in `scripts/audit/`, which suggests test-tenant
   leakage is a known recurring issue. Isolation testing is much weaker against 41 near-empty
   tenants than against a real set, so reconcile this before any pilot.

4. **Duplicate prevention — verified, and strong.** `DB`. Of 12 natural business keys checked, 10
   carry a unique index and **all 10 hold zero duplicate values**:

   `sales_orders.order_number` · `invoices.invoice_number` · `purchase_orders.po_number` ·
   `quotations.quotation_number` · `goods_receipt_notes.grn_number` · `journal_entries.entry_number` ·
   `vendors.vendor_code` · `inventory_items.item_code` · `projects.project_code` · `leads.email`

   Two gaps: **`employees.office_id` has no unique index** (employee codes could collide — currently
   0 duplicates, but nothing prevents it), and `accounts.name` has none (defensible — real companies
   can share a name).

3. **Inconclusive, not clean.** `/performance/goals`, `/performance/reviews` and `/approvals`
   returned **0 rows** to the employee. That is consistent with correct scoping *and* with an empty
   table; it is not evidence of either. Re-test once those tables hold data for more than one person.

5. **Still not tested:** session fixation, JWT refresh under clock skew, file-upload authorisation,
   and per-role export permissions. See §14.

---

## F. UX & usability gaps

| Finding | Evidence | Note |
|---|---|---|
| Navigation integrity is clean | `CODE` — 366 nav entries, 0 unresolved | 17 entries that appear "missing" from `ROUTES` are resolved by `autoRouter.js` convention discovery. Verified each has a matching page file. |
| 4 orphaned page files | `CODE` | `CustomerHealthTrend.jsx`, `CustomerHealthWidget.jsx` (widgets misfiled under `pages/`), `_DataTablePage.jsx` (template), `NotFound.jsx` (fallback). Only the two CRM widgets are real clutter. |
| 123 routes not linked from any menu | `CODE` | Mostly correct — these are drill-down detail pages (`AccountDetail`, `CandidateDetail`, `ProjectDetail`, `EditEmployee`) reached from lists. `routes.jsx:316` documents this deliberately. |
| …but some look genuinely stranded | `CODE` | `WarrantyManagement`, `AMCManagement`, `FinancialStatements`, `GSTModule`, `TDSManagement`, `TCSManagement`, `PayrollForm16`, `SalesFunnel`, `VendorManagement`, `Tickets`, `FieldService` are full workspace pages with no nav entry. **NOT TESTED:** whether each is reachable from a hub/tab page. Worth one pass with the app running. |
| Fabricated fallback data | `CODE` | C-6 is one instance. A repo-wide sweep for `: [` fallback literals after a failed fetch was **NOT** performed in this pass and is recommended — this pattern hides exactly the bugs an audit is meant to find. |
| Empty states | `NOT TESTED` | Requires the UI running; see §14. |
| Click-depth / bulk actions / keyboard / responsive | `NOT TESTED` | Requires browser-driven testing. |

---

## F-2. Search, filter and pagination coverage

The brief asked whether important fields can be searched and filtered. I tested this directly against
14 of the highest-traffic list endpoints, **alias-aware**: a capability counts as present if *any*
conventional parameter name changes the result. Aliases tried per concept:

- pagination — `limit`, `pageSize`, `per_page`, `size`, `take`
- search — `search`, `q`, `keyword`, `term`, `name`
- status — `status`, `state`, `stage`
- date range — `from/to`, `start_date/end_date`, `date_from/date_to`, `fromDate/toDate`

(The `from/to` and `start_date/end_date` spellings were taken from the source, not guessed —
`leads.repository.js` uses `from`/`to`, `inventory.routes.js` uses both vocabularies.)

| Endpoint | rows | pagination | search | status | date range |
|---|---:|---|---|---|---|
| `/crm/leads` | 20 | **NO** | yes (`search`) | yes (`status`) | **NO** |
| `/crm/opportunities` | 6 | **NO** | **NO** | yes (`stage`) | **NO** |
| `/crm/accounts` | 9 | **NO** | yes (`search`) | **NO** | **NO** |
| `/sales/orders` | 39 | **NO** | yes (`search`) | **NO** | **NO** |
| `/procurement/purchase-orders` | 5 | **NO** | **NO** | yes (`status`) | **NO** |
| `/vendors` | 10 | **NO** | yes (`search`) | yes (`status`) | **NO** |
| `/employees` | 33 | yes (`limit`) | **NO** | yes (`status`) | **NO** |
| `/projects` | 6 | **NO** | **NO** | yes (`status`) | yes (`from`) |
| `/inventory/items` | 14 | **NO** | yes (`search`) | **NO** | **NO** |
| `/production/orders` | 10 | **NO** | yes (`search`) | yes (`status`) | **NO** |
| `/servicedesk/tickets` | 15 | yes (`limit`) | yes (`search`) | yes (`status`) | **NO** |
| `/finance/journal-entries` | 15 | yes (`limit`) | **NO** | **NO** | **NO** |
| `/travel/requests` | 200 | yes (`limit`) | **NO** | yes (`status`) | **NO** |
| `/notifications` | 50 | yes (`limit`) | **NO** | **NO** | **NO** |
| **Supported** | | **5 / 14** | **7 / 14** | **9 / 14** | **1 / 14** |

### Export — works where it exists, absent from the manufacturing core

`LIVE` + `CODE`. There are **31 export/download endpoints**. I called eight of them and confirmed they
return real files, not JSON pretending to be one:

| Endpoint | Result |
|---|---|
| `/crm/leads/export` | 200 · **XLSX** (`…spreadsheetml.sheet`) |
| `/procurement/purchase-orders/export` | 200 · `text/csv` |
| `/statements/export/balance-sheet` | 200 · `text/csv` |
| `/statements/export/income-statement` | 200 · `text/csv` |
| `/accounting/trial-balance/export` | 200 · `text/csv` |
| `/sales/quotations/export` | 200 · `text/csv` |
| `/servicedesk/export/tickets` | 200 · `text/csv` |
| `/statements/export/cash-flow` | **500** — see C-2 |

Counting source files that actually emit `text/csv` / `Content-Disposition` / `toCsvObjects`:

| Has export | Finance (5 files) · Quality (2) · Payroll (2) · CRM (2) · Analytics (2) · Attendance · Engineering · HR · IoT · Performance · Sales · Service Desk · Procurement · Documents · Security |
|---|---|
| **No export at all** | **Reports & BI** · **Inventory** · **Production** · **Projects** · Timesheets · Recruitment · Travel · Assets · Compliance · Marketing · Leaves · R&D |

**P2 finding.** For a manufacturing and power-electronics business, the modules with no export are
the wrong ones. Stock positions, production orders, BOM/routing data and project cost lines are
exactly what gets pulled into Excel for planning, costing and customer reporting. And the
**Reports & BI module — whose entire purpose is producing reports — has no export endpoint of its
own.** Worth confirming against how users actually work before building, but this is the most
likely source of "I have to copy it off the screen" complaints.

### Two further findings come out of the filter probe

**1. P1 — Date-range filtering is absent from 13 of 14 list endpoints.**

For an ERP this is the single most conspicuous functional gap in the API surface. "Sales orders for
last quarter", "purchase orders raised this month", "journal entries for the financial year",
"tickets opened this week" — none of these can be expressed as an API call on the endpoints that
should answer them. Only `/projects` honours a date range.

This does not mean date filtering is absent from the product: dedicated report endpoints under
`/reports` and `/analytics` do take periods, and several took `fyStart`/`fyEnd` in the GET sweep. But
the transactional list endpoints — the ones behind every module's main grid — do not.

**2. P1 — Nine of fourteen list endpoints return the entire table with no pagination.**

`/crm/leads`, `/crm/opportunities`, `/crm/accounts`, `/sales/orders`,
`/procurement/purchase-orders`, `/vendors`, `/projects`, `/inventory/items` and
`/production/orders` ignore every pagination alias and return every row the query matches.

At today's volumes this is completely invisible — the largest of them returns 39 rows. That is
exactly why it is worth flagging now: **this is a defect that only appears in production.** A
manufacturing business running Manifest for two years will have tens of thousands of sales orders and
purchase orders, and these endpoints will try to serialise all of them into one response. The
`responseCap` middleware will truncate the payload, which turns an unbounded list into a *silently
incomplete* one — arguably worse than a slow one, because the grid will look fine and simply be
missing records.

**Caveat, stated honestly.** Absence of five conventional aliases is strong evidence, not proof —
an endpoint could implement pagination under a bespoke name I did not try. The finding to act on is
therefore partly about consistency: `search` vs `q`, `status` vs `stage`, `from/to` vs
`start_date/end_date` are all in live use, which means frontend authors must know each endpoint's
private vocabulary. A documented, uniform list-query contract (`limit`/`offset`/`q`/`status`/`from`/`to`)
applied across list endpoints would fix the consistency problem and the scalability problem together.

---

## G. Performance gaps

Measured from the live probe (`LIVE`, single-user, warm DB, fixture-sized data):

- 1,272 GET endpoints completed in well under the 25s timeout; **no endpoint timed out**.
- Slowest responses were in the analytics/intelligence family, which is expected.
- **This tells you very little about production performance.** Every timing was taken against tables
  holding 5 rows. The tables with real volume (`mrp_time_phased` 18,334, `crp_load` 12,240,
  `audit_logs` 47,581) are the only ones where these numbers mean anything.

**The one performance finding that is real today** is in §F-2: nine of fourteen major list endpoints
have no pagination and return the whole result set. That is a latent production defect, and it is
invisible at current data volumes — which is precisely why a latency measurement taken now would give
false comfort.

**Not tested:** concurrent load, N+1 query patterns, index coverage on the high-volume tables, and the
response-cap middleware's behaviour when an unbounded list exceeds it. A `perf-probe.mjs` and
`scale-fixture.mjs` already exist in `scripts/audit/` — running those against a scaled fixture is the
right next step, not re-measuring what I measured.

---

## H. Cross-module integration gaps

| Integration | Status | Evidence |
|---|---|---|
| Procurement ↔ Inventory | **VERIFIED** | `TEST` — `integration.supplyChain`, `integration.procurementLifecycle` |
| Production ↔ Inventory | **VERIFIED** | `TEST` — `integration.planToProduce`, `integration.materialIssueAttribution` |
| Inventory ↔ Traceability/Genealogy | **VERIFIED** | `TEST` — `integration.traceabilitySpine`, `.traceabilityClosure`, `.genealogyTraceability` |
| Quality ↔ Suppliers | **VERIFIED** | `TEST` — `integration.supplierLoopClosure` |
| CRM ↔ Customer integrity | **VERIFIED** | `TEST` — `integration.crmCustomerIntegrity`, `crmGraphAndCapture` |
| Projects ↔ tenant scoping | **VERIFIED** | `TEST` — `integration.projectsTenantIsolation` |
| Approvals ↔ Workflow | **VERIFIED** | `TEST` — `workflowEngine`, `workflowTransitions`, `workflowNotifications`, `smoke.approvals` |
| **Leave ↔ Dashboard/Approvals** | **BROKEN** | C-1 — reads a table the workflow abandoned |
| **IoT ↔ Assets / IoT ↔ Service** | **UNPROVEN** | C-5 — code + tests exist; zero telemetry has ever flowed |
| Sales ↔ Finance | **CODE OK / DATA INCONSISTENT** | See below — the write path is correct, the stored data is not |
| Projects ↔ Timesheets | Partially evidenced | `DB` — `timesheet_entries` = 680 (organic). Not covered by a named integration test. |
| Recruitment ↔ Onboarding ↔ Employee | `NOT TESTED` | `recruitment_employee_creation_log` = 1 row. No test file. |
| Service ↔ Inventory (spare parts) | `NOT TESTED` | `spare_parts(16)` organic, `spare_parts_movements(5)` fixture, `iot_service_parts(0)` |

### Header-without-lines: the code is right, the data is wrong

`invoices` = 35 but `invoice_items` = 3 looked like a silent data-loss bug in the Sales→Finance seam.
I chased it down. `DB`:

```
invoices with zero line items        : 32 of 35   (INV-001 … INV-008 carry totals of
                                                   125000, 87500, 145000 … with 0 lines)
sales_orders with zero line items    :  6 of 39
purchase_orders with zero line items :  1 of 6
```

**The write path is correct.** `src/modules/finance/repositories/invoice.repository.js:29` does
`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, tax_rate, amount)`. So
invoices created through the application do get lines. The 32 line-less invoices are **legacy demo
headers** seeded with a `total_amount` and no detail.

**Why it still matters.** The dashboard's `revenueYTD: 241,900` is derived from invoice *headers*.
Any report that derives revenue from invoice *lines* — revenue by item, by category, by HSN, margin
analysis — will read **zero for 32 of 35 invoices** and silently disagree with the headline number.
That is a reconciliation trap waiting for whoever builds the first line-level revenue report.

**Recommendation:** either backfill lines for the demo invoices or delete them. Do not leave headers
and lines telling different stories. This is a data-cleanup task, not a development task.

---

## I. Priority roadmap

Ranked by: business impact × (evidence of live breakage) ÷ implementation cost. Basis stated per item.

### P0 — this week

| # | Item | Basis |
|---|---|---|
| 1 | **Fix the leave-table split-brain (C-1)** | Live, user-visible, affects every approver's home screen, and corrupts three KPI endpoints. The wrong-table comment will cause regression if not corrected with it. |
| 2 | **Fix `statements/cash-flow` (C-2)** | One-word fix; unblocks a core statutory financial statement that is currently a 500. |
| 3 | **Green the test suite (C-4)** | A red suite disables your best regression defence. Cause is known and benign; fix is to scope the guard's file walk. |

### P1 — this month

| # | Item | Basis |
|---|---|---|
| 3b | **Close the `/leaves` exposure (§E gap 1)** | Any employee can read every colleague's leave dates and reasons. Harmless at 4 fixture rows, a privacy incident once leave is used. Fix is a permission change, not code: drop `leaves:view` from the `employee` role and point self-service at the already-correct `/leaves/my`. Pairs naturally with J-1, which touches the same module. |
| 4 | **Fix `/biometric/employees/unmapped` (C-3)** | 500 on an HR screen; feeds attendance-capture completeness. |
| 5 | **Add `GET /roles`, delete the fallback array (C-6)** | Silent wrong-data bug; 22 of 26 roles unreachable for alert escalation. The fallback is the real defect. |
| 6 | **Attendance test coverage** | 149 endpoints, payroll-affecting, zero tests, and already carrying a live 500. Highest risk-per-test-written in the system. |
| 7 | **Resolve dead duplicate tables (C-7)** | Start with `journal_entry_lines`' 8 GL rows — decide whether that is orphaned history or lost ledger detail. |
| 7b | **Classify all 489 `company_id` tables as shared-reference vs tenant-owned (§E gap 2)** | The most systemic finding in this audit. Backfill + `NOT NULL` the tenant-owned ones; standardise the `OR company_id IS NULL` read for the shared ones. Until this is done, tenant-scoped unique indexes have a proven hole and NULL-tenant transactional rows behave unpredictably. Do the 10 transactional tables first — they are small (35 rows total). |
| 8 | **Reconcile 41 companies → real tenant set** | Blocks any credible tenant-isolation assertion; a purge script already exists. |
| 8b | **Add a unique index on `employees.office_id`** | Employee-code collisions are currently prevented by nothing. Zero duplicates today, so the index will apply cleanly. |
| 9 | **Backfill or delete the 32 line-less demo invoices** | Resolved during this audit (§H): the write path is correct, but header-derived and line-derived revenue will disagree by 32 invoices. Data cleanup, not development. |

### P2 — next quarter

| # | Item | Basis |
|---|---|---|
| 9b | **Add pagination to the 9 unpaginated list endpoints (§F-2)** | Latent production defect. Invisible today (39 rows), breaks at real volume, and `responseCap` will make it fail *silently incomplete* rather than slow. Cheapest to fix now while result sets are small enough to verify by eye. |
| 9c | **Add date-range filtering to transactional list endpoints (§F-2)** | 13 of 14 cannot answer "this quarter". The most conspicuous functional gap in the API surface for an ERP. Do it alongside 9b as one uniform list-query contract. |
| 10 | Test coverage for Performance, Travel, Training, Recruitment, Assets, Timesheets, Compliance | 408 further untested endpoints; lower transactional risk than Attendance. |
| 11 | Repo-wide sweep for fabricated fallback literals | C-6 is one confirmed instance; the pattern hides bugs from exactly this kind of audit. |
| 12 | Run `perf-probe.mjs` + `scale-fixture.mjs` | Performance is currently unmeasured at realistic volume. |
| 13 | Browser-driven UX pass (Playwright suite exists, `tests/suites/`) | Empty states, click depth, bulk actions, responsive — none testable without it. |
| 14 | Pilot-data programme for the 11 never-exercised workflows (§D) | These need an owner and first transactions, not code. |
| 15 | Object-level authorisation (IDOR) probe on `:id` routes | RBAC probe covers route admission, not object ownership. |

### P3 — enhancement

| # | Item | Basis |
|---|---|---|
| 16 | Decide and document the 9 `/intelligence/*` 501 capabilities | They are honestly declared; they just need a roadmap decision — build or remove. |
| 17 | Nav entries for the stranded workspace pages (§F) | Pending confirmation they aren't hub-reachable. |
| 18 | Move `CustomerHealthTrend/Widget.jsx` out of `pages/` | Cosmetic; prevents autoRouter registering widgets as pages. |

---

## J. Implementation plan — the P0 items

### J-1 · Unify the leave ledger

- **Business purpose.** An approver's pending queue must be actionable and its count must be true.
- **User workflow.** Employee applies → manager approves → HR approves → balance decrements. The
  approver's dashboard count must equal what the Leave screens show.
- **Backend.** Repoint `PENDING_APPROVALS_SQL` (`dashboard.controller.js:44`) and the `leave_requests`
  readers in `aiPayroll.service.js:482`, `ai.routes.js`, `security.routes.js` to
  `leave_applications`. Change `whatsapp.routes.js:125` to insert into `leave_applications` so the
  WhatsApp channel joins the same ledger. Rewrite the comment block at `dashboard.controller.js:34-42`.
- **Database.** Triage the 159 `leave_requests` rows still marked `pending` (some are 184 days old and
  almost certainly abandoned). Migrate any genuinely live ones; archive the table as
  `leave_requests_archived_2026q3`. **Do not drop it** until the migration is verified.
- **Integration.** Approvals, Dashboard, AI payroll narrative, WhatsApp, Security screens.
- **Permissions.** Unchanged — same module key (`leaves`).
- **Testing.** Extend `smoke.leaves`: assert `/dashboard/approvals` leave count equals
  `SELECT COUNT(*) FROM leave_applications WHERE status='pending'`. That assertion is what makes this
  non-regressable.
- **Dependencies.** None. Do this first.

### J-2 · Repair the Cash Flow Statement

- **Business purpose.** Cash Flow is a statutory statement; it currently 500s.
- **Frontend.** None — `FinancialStatements.jsx` already calls it correctly.
- **Backend.** `statements.routes.js:217`: `SUM(cost)` → `SUM(purchase_cost)`.
- **Database.** None.
- **Testing.** Add a statements smoke test asserting 200 + a balanced response for all six statement
  endpoints (`income-statement`, `balance-sheet`, `cash-flow`, `funds-flow`, `breakeven-analysis`,
  `ratios`). Finance has only 2 test files against 314 endpoints — this is the cheapest place to add value.
- **Dependencies.** None.

### J-3 · Green the suite

- **Backend.** In `unit.csvWriter.test.js`, exclude `database/migrations/` from `walk()`, or add
  `20260917000004_pct_family_seed_purge.js` to `ALLOWED`. Excluding migrations is better: migrations
  are not routes or services, and this will recur.
- **Coordination.** That migration belongs to a **concurrently running session**. Confirm before
  editing — do not revert someone else's in-flight work.
- **Testing.** `npx vitest run` → expect 1,656 pass / 0 fail.

---

## 14. Coverage statement — what this audit did NOT establish

Stated plainly, because the brief's rules 1, 5 and 6 require it.

**Tested:** 1,272 parameterless GET endpoints + 119 parameterised detail endpoints (live, real ids
resolved from sibling list endpoints), 1,665 automated tests, 27 RBAC assertions, a 3-identity
authorisation comparison (admin / hr / employee) covering module gating, field-level PII filtering
and tenant isolation, 631 tables' exact row counts, full route/nav/page/contract inventories, and
cron registration.

**Not tested:**

1. **Write paths.** I issued no POST/PUT/PATCH/DELETE. 1,625 of 3,288 endpoints — every mutation —
   were not called. Where I claim a write path works, the evidence is an integration test, not my own
   execution. Of the 364 parameterised GETs, 119 were exercised with real ids; the remaining 245
   had no resolvable list endpoint to draw an id from.
2. **The UI.** No browser was driven. Every frontend finding is static analysis. Click depth, form
   validation behaviour, empty states, error toasts, loading states, responsive layout and mobile
   usability are unassessed. A Playwright suite exists at `tests/suites/` and should be run.
3. **Per-module CRUD matrices.** The brief asked for create/view/edit/delete/validate/duplicate/
   search/filter/sort/paginate/bulk/export verification per feature. I verified the *read* leg and the
   *validation* leg (53 endpoints correctly rejected missing parameters with actionable 400s, which is
   good evidence validation is real). Also now covered: **duplicate prevention** (§E — 10 natural
   keys, unique indexes verified, zero duplicate values), **filter / search / pagination** (§F-2,
   14 endpoints, alias-aware) and **export** (§F-2, 8 endpoints called and content-type checked).
   Still **not verified**: create, edit, delete, bulk actions, and sorting.
4. **Import mechanisms.** CSV/Excel import, PDF extraction, email capture, external sync — inventoried
   by table presence only. `support_mailboxes(0)` proves email-to-case is unconfigured; everything else
   in that section is `NOT TESTED`. One asymmetry worth chasing in Pass 2: export exists in 15
   modules, but **no bulk-import endpoint surfaced in any module** during this pass.
5. **Search & filtering.** Covered in this pass for 14 major list endpoints (§F-2), alias-aware.
   **Not** covered: the remaining list endpoints, saved filters, advanced multi-filter combinations,
   sorting, export-of-filtered-results, and search *accuracy* (I tested only whether a parameter
   changes the result, not whether it returns the right rows). Global search (`/global-search`) is
   mounted and returns 200 but its result quality was not assessed.
6. **Object-level authorisation.** Partially closed in this pass: module gating, field filtering and
   tenant isolation were verified live, and one real gap was found (`/leaves`, §E). But ownership
   checks on individual `:id` records — can employee A fetch employee B's expense claim by id? —
   remain untested, and three endpoints returned 0 rows so their scoping is unproven either way.
7. **Mobile application.** Capacitor Android/iOS shells exist in `frontend/android`, `frontend/ios`.
   Not built, not run, not audited.

**Recommended Pass 2**, in priority order: run the Playwright suite → write-path smoke across the 8
untested modules → per-module CRUD matrix → import/integration verification → search/filter coverage.

---

## Appendix — audit method

Reproducible. All probes were read-only.

| Step | Command / artifact |
|---|---|
| Endpoint inventory | Recursive parse of `server.js` + nested `router.use()` → 3,288 endpoints |
| Live GET sweep | 1,272 GETs, concurrency 12, 25s timeout, admin bearer token |
| DB introspection | `information_schema` + exact `COUNT(*)` per table (planner stats are unreliable here) |
| Test suite | `npx vitest run` (77 files, 132s) |
| RBAC | `npm run check:authz` (27 assertions) |
| Detail-route sweep | 354 parameterised GETs; id resolved from each sibling list endpoint; 119 exercised |
| Authorisation comparison | 3 identities (admin / `hr` / `employee`) over the same endpoints; module gating, field filtering and tenant distribution compared |
| Frontend contract | 692 files scanned, 2,101 distinct API calls extracted and matched against the endpoint inventory |
| Reachability | `NAV_ITEMS` × `ROUTES` × `autoRouter.js` glob × 517 page files |

**Login used:** `admin@manifest.in` (role `admin`, `company_id: null`).

**False positives I corrected rather than reported** — recorded so the next audit doesn't re-raise them:

- 25 route files looked unmounted; all 25 are nested or aliased sub-routers (`crm/routes/index.js`,
  `aiCombined`, `{ ingestRouter as ... }`). **Zero orphan routers.**
- 17 nav entries looked broken; all 17 resolve through `autoRouter.js` convention discovery. **Zero broken nav links.**
- 49 of 50 "missing" frontend API calls were my normaliser mangling query-string template holes
  (`/heatmap?${qs}`) and dynamic path segments (`/comp-off/${action}/${id}` → the real route is
  `/comp-off/approve/:id`). Only `/roles` was real.
- The CSV-guard failure is SQL identifier quoting, not CSV escaping — a red build, not a vulnerability.
- `company_id: null` on the admin and the four `pilot.*` role accounts **looked** like a cross-tenant
  read, given the `($1::int IS NULL OR company_id = $1)` scoping idiom. Tested directly: admin sees
  33 rows, all `company_id = 1`, while 10 other tenants hold employees. `companyOf(req)` resolves the
  real tenant rather than trusting the claim. **Not a leak.** An earlier draft of this report asserted
  it was; that assertion was wrong and has been corrected.

**One side effect I caused:** `npm run check:authz` kills and restarts `node server.js` by design, so
the backend was restarted once during this audit and my first bearer token expired mid-sweep. The
parameterised-GET sweep was re-run against a fresh token; no other probe was affected. No data was
written at any point.

---

**Architecture Impact: ✅ None.** This audit made no code, schema, route, workflow or permission
changes. `MODULE_FEATURE_CONNECTION_MANUAL.md` requires no update. The remediation work in §I and §J
will require one — in particular J-1, which changes which table the Leave↔Approvals↔Dashboard seam
reads, and that seam is documented in the manual's lifecycle flows.
