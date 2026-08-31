# Reports Module — Audit & Remediation Report

**Audited and remediated:** 2026-08-19
**Scope:** `backend/src/modules/reports/**`, `frontend/src/features/reports/**`, `shared/statusSets.js`, `shared/analyticsAuthz.js`, `scripts/check-sql-references.mjs`
**Method:** static trace, then **live execution against the running `Pulse` database** with five real JWTs, before and after every change

| | Before | After |
|---|---:|---:|
| **Trust score** | **34 / 100** | **100 / 100** |
| Reports returning a well-formed result | 10 / 21 | **21 / 21** |
| Reports silently reporting failure as "no data" | 11 | **0** |
| Reports readable by a plain Employee | 21 / 21 | **0 / 21** |
| Filters silently ignored | 16 of 21 reports | **0** |
| Automated tests covering the module | 0 | **51** |
| Verdict | 🔴 DO NOT GO-LIVE | 🟢 **GO-LIVE** |

---

## A. What was wrong

`reports.repository.js` wrapped all 21 queries in a `safeQuery` helper that caught any database error and returned `[]`. The route answered `200 []`, and `Reports.jsx` rendered that as a **green checkmark reading "No records found for the selected filters."**

**Eleven of the twenty-one reports referenced columns that do not exist in this schema and had therefore never once returned a row.** Every user who opened them was told, with a tick, that the business had no stock, no projects, no purchase orders and no expenses.

```
Stock Summary, executed live
  ├─ what the user saw   ✓ No records found for the selected filters
  └─ what happened       ERROR 42703: column ii.category does not exist
                         — the fallback query failed identically —
                         5 inventory items were never read
```

### The broken references

| Referenced | Reality |
|---|---|
| `employees.employee_code` | the employee code column is `office_id` |
| `inventory_items.category` / `.unit` | `category_id` (FK `item_categories`) / `unit_of_measure` |
| `projects.name` / `.total_budget` / `.budget_used` | `project_name` / `budget_amount` / `actual_cost` |
| `payroll_runs.company_id` | does not exist — scope through `employees` |
| `sales_targets.employee_id` / `.month` / `.deleted_at` | `owner_id` / `period_year` + `period_value` |
| `parties.id = purchase_orders.supplier_id` | `parties.id` is **uuid**, `supplier_id` is **integer** → 42883 on every call. The real FK target is **`vendors.id`** |
| `saved_reports.report_name` / `module_name` / `filters_json` / `columns_json` / `is_public` | `name` / `filters` / `columns` / `is_shared` — the table held **0 rows**; the feature had never persisted anything while the UI rendered "✓ Saved" |

### And five more P0s

1. **No authorization.** `/reports` was mounted `verifyToken`-only. A plain **Employee** token returned 200 on all 21 endpoints, including `leave/liability` — every colleague named, with `daily_rate = basic_salary / 26`, i.e. **every salary recoverable by multiplication**.
2. **Tenant scope failed open.** 7 of 37 active accounts had no `user_scope` row → `companyOf()` returned null → every `if (company_id != null)` predicate was skipped. Proven live: an Employee saw 8 expense claims and 6 pending POs where the correctly-scoped super admin saw 0 and 2.
3. **Attendance read a table with zero writers.** All nine live writers target `attendance_records`; the report queried the bare `attendance` table — frozen seed data no clock-in could ever change.
4. **Two LEFT JOIN + WHERE-on-right-table collapses**, silently converting outer joins to inner ones: 29 of 34 employees dropped from Attendance, and 100% of expense claims (₹1,09,700).
5. **GST reported ₹0 taxable on ₹1.16 Cr.** `COALESCE(SUM(a), SUM(b))` only falls back when the *whole* sum is null, and 32 of 35 invoices carry `subtotal = 0`.

### The instrument that should have caught it

`scripts/check-sql-references.mjs` was **already a CI hard gate** — with a hardcoded **15-file allowlist covering only Analytics/AI**. Reports was never in it.

Two further defects in the checker itself, found while widening it:
- its word-boundary escapes were **literal 0x08 backspace bytes** — the second time this exact bug has hit this file;
- a scan that discovered **zero files still printed `PASS`**.

---

## B. What was done

### Phase 1 — Make failure loud, then fix the schema

`safeQuery` is **deleted**. Errors propagate; the route maps constraint violations through `shared/pgErrors.js` and answers anything else with a logged, generic 500 that never leaks schema text. Every column and join reference was repointed at what actually exists, verified by re-running each query against the live database.

### Phase 2 — The catalog becomes server-owned

New: [`backend/src/modules/reports/reportCatalog.js`](Pulse/backend/src/modules/reports/reportCatalog.js). It owns each report's **filters, permission, grain and measures**, and drives three things that can no longer disagree:

1. `GET /reports/catalog` — the page renders only the controls a report declares;
2. request validation — an undeclared filter is a **400 naming what is supported**, never a silent no-op;
3. `reportsPolicy` — generated from the same `permission` tuples, so **a report added tomorrow is guarded by construction**.

The Department box used to render on all 21 reports and be honoured by 5. Project Cost advertised a date picker for a route that discarded `req.query`.

### Phase 3 — KPI correctness

| KPI | Fix |
|---|---|
| Revenue | `order_status = 'completed'` is a value nothing in the sales module writes. Now uses `statusSets.sqlSalesOrderBooked`, an *exclusion* of draft/cancelled/rejected, so an unanticipated status lands in the total rather than vanishing. **₹0 → ₹47,200.** |
| GST | `COALESCE` moved inside the aggregate, per row; tax falls back to the populated `cgst`/`sgst`/`igst`/`cess` components. **₹5,60,000 → ₹1,16,18,500 taxable.** |
| Receivables | Now **derived**: invoiced value less receipts allocated against the invoice, falling back to `paid_amount`. Rows where the stored `invoices.balance` contradicts the derivation carry a `data_quality` flag. |
| Headcount | Splits active from exited using `EMPLOYEE_ACTIVE`; folds `HR` and `Human Resources` into one bucket (15 → 14 departments); `NULL` becomes an explicit `Unassigned`. |
| Attendance | Repointed at `attendance_records`; date predicate moved into the `ON` clause; buckets made **exhaustive**: `present + absent + leave + non_working + unclassified ≡ recorded_days`, with `unclassified_days` so an unanticipated status is visible rather than silently unbalancing the row. |
| Month buckets | `to_char(…, 'YYYY-MM')` strings. `DATE_TRUNC('month', <date>)` returns **timestamptz**, which `config/db.js`'s `setTypeParser` does not cover — July invoices were serialising to `2026-06-30T18:30:00.000Z` and displaying as June. |

New vocabularies added to `shared/statusSets.js`: `SALES_ORDER_VOID`, `PO_CLOSED`, `PO_FULFILLED`, `PR_CLOSED`, and the four exhaustive `ATTENDANCE_*` buckets.

### Phase 4 — Security

- **`reportsPolicy`** added to the `/reports` mount in `server.js`, generated from the catalog with a deny-by-default fallback — the same pattern already protecting `/analytics`, `/ai` and `/dashboard`.
- **Company-wide people reports take `hr:view`, not `leave:view`/`attendance:view`.** Every employee holds the latter two for self-service; gating a company-wide roster on them leaves it open to everyone. This is the trap `/analytics/top-performers` documents next door — the first pass of the fix left five reports open until the matrix was actually run.
- **Scope is mandatory.** `null` now means "global super-admin scope" and nothing else; an unresolvable scope is a **403**, not an unfiltered query.
- Saved-report **delete is scoped to owner and tenant**, and answers 404 either way so it cannot enumerate other people's reports.

### Phase 5 — Migration `20260819000001_reports_module_integrity.js`

- Backfills `user_scope` from `users.company_id` — **7 accounts fixed, 0 remaining**. Needed in the same change as the deny rule, or those users would be locked out instead of over-served.
- Repoints `saved_reports.created_by` at **`users(id)`**; it FK'd `employees(id)` while every writer supplied a `users.id` — a different id sequence, so ownership matched the wrong person.
- Backfills `purchase_requests.company_id` (4 of 6 rows were NULL and invisible to any scoped query) from the consuming PO, else the requesting employee, else the sole company.
- Adds 10 indexes for the access patterns the reports actually use — `stock_ledger(transaction_date)`, `leave_approval_history(approver_id)`, `attendance_records(employee_id, attendance_date)`, `purchase_orders(supplier_id)` and others.

### Phase 6 — Frontend

`Reports.jsx` and `SavedReports.jsx` rewritten:

- **Four genuinely distinct states** — Error / Forbidden / Invalid-filter / Empty. The empty state now says *"The report ran successfully — there is genuinely nothing in the database for these filters."*
- Controls built from `GET /reports/catalog`, so the page cannot advertise a filter the backend ignores.
- Pagination with a true unpaginated total (`count(*) OVER ()` in the same round trip).
- Measures right-aligned with `tabular-nums`; dates via `fmtDate` (DD Mon YY); `YYYY-MM` rendered "Jul 2026"; INR grouping.
- **CSV hardened** — UTF-8 BOM (₹ and Indian names no longer mojibake) and a tab prefix on values beginning `=`, `+`, `-`, `@`, which Excel and Sheets execute as formulas even inside quotes. Export re-runs the query at the export ceiling so the file matches the *report*, not the page, and says so when the result is larger.
- **The Delete button worked for the first time.** It was a `useCallback(…, [])` closing over `pendingDelete`, so it saw the first-render value of `null` on every invocation and returned at its own guard.

### Phase 7 — The CI gate, ratcheted

`check-sql-references.mjs` now **discovers** every SQL-bearing file under `src/` (314 files) instead of reading a hand-maintained list, **fails hard if it discovers none**, and **ratchets** against `scripts/sql-reference-baseline.json`.

Widening the sweep surfaced **146 pre-existing broken references across 20 other modules**. Fixing all of them is its own project; refusing to widen the scan until someone does is how the allowlist stayed stale long enough for eleven Reports queries to ship dead. So: everything is scanned, the existing 146 are carried as documented debt, **anything new fails the build**, and a baseline entry that stops firing is reported as fixed so the list can only shrink.

Proven both ways — a planted `employees.employee_code` in the Reports repository exits 1; removing it exits 0.

---

## C. Verification

Every figure below was produced by running the code, not by reading it.

### All 21 reports, live

```
  OK  attendance                 200   43ms  rows=  34   ← was 5 of 34
  OK  leave                      200   23ms  rows=   4   ← was 0 (42703)
  OK  leave/summary              200   26ms  rows=  15   ← was 0 (42703)
  OK  leave/department           200   23ms  rows=  15
  OK  leave/approval-performance 200   25ms  rows=   0   ← genuinely empty
  OK  headcount                  200   29ms  rows=  14   ← 15 depts, HR merged
  OK  payroll-summary            200   26ms  rows=   0   ← genuinely empty
  OK  leave/liability            200   30ms  rows=  14
  OK  leave/lop                  200   20ms  rows=   0   ← genuinely empty
  OK  sales                      200   20ms  rows=   1   ← was ₹0, now ₹47,200
  OK  sales-targets              200   16ms  rows=   0   ← genuinely empty
  OK  outstanding-invoices       200   29ms  rows=  17
  OK  gst-report                 200   19ms  rows=   7
  OK  expense-report             200   24ms  rows=   8   ← was 0 of 8
  OK  project-cost               200   15ms  rows=   3   ← was 0 (42703)
  OK  purchase-orders            200   20ms  rows=   2   ← was 0 (42883)
  OK  vendor-performance         200   16ms  rows=   2   ← was 0 (42883)
  OK  pending-pos                200   18ms  rows=   5   ← was 2, PO half silently dropped
  OK  stock                      200   17ms  rows=   5   ← was 0 (42703)
  OK  stock-movement             200   12ms  rows=   0   ← genuinely empty
  OK  low-stock                  200   11ms  rows=   0   ← genuinely empty

21 ok / 0 failed
```

The six genuinely-empty reports read from tables that are empty in this database (`payroll_runs`, `sales_targets`, `payroll_attendance_summary`, `stock_ledger`) or match nothing. The UI now states that the report *ran*, which is the difference that matters.

### RBAC matrix — five real tokens

| Report group | super_admin | HR Manager | Finance | Purchase | Employee |
|---|:--:|:--:|:--:|:--:|:--:|
| HR & People (6) | ✓ | ✓ | · | · | · |
| Payroll (3) | ✓ | ✓ | · | · | · |
| Sales (2) | ✓ | · | · | · | · |
| Finance (3) | ✓ | · | ✓ | · | · |
| Procurement (3) | ✓ | · | · | ✓ | · |
| Inventory (3) | ✓ | · | · | ✓ | · |
| **Employee total** | | | | | **0 of 21** |

Was **21 of 21** readable by a plain Employee.

### Filter integrity — 10 cases, all correct

```
400  department on a report that ignores it   "The GST Summary report does not support the
                                               \"department\" filter, so applying it would
                                               have no effect on the result."
400  date on a no-date report                 named, with the supported list
400  unknown filter                           "Unknown filter \"region\"."
400  bad date format · inverted range · month 13 · limit 99999
404  unknown report                           with the available list
200  department on a report that honours it   result narrows
200  valid date range                         result narrows
```

### KPI reconciliation

| KPI | Value | Check |
|---|---:|---|
| Revenue (booked orders) | ₹47,200 | matches independent SQL exactly |
| GST gross | ₹1,16,18,500 | taxable + tax ≡ gross for every month (test-asserted) |
| GST taxable | ₹1,16,18,500 | was ₹5,60,000 |
| Receivables | ₹51,86,400 | 8 rows flagged where stored `balance` contradicts the derivation |
| Expense claims | 8 / ₹1,09,700 | was 0 |
| Attendance employees | 34 | was 5; buckets sum to `recorded_days` on every row |
| Headcount | 34 active / 0 exited | exit exclusion proven by test, not by absence of exits |
| Month labels | `2026-07` | was `2026-06-30T18:30:00.000Z` |

**A correction to the original audit.** It reported receivables as "overstated 4.8×" against `invoices.balance` of ₹10,80,000. That was the wrong authority: `payments`, `receipt_allocations` and `customer_payments` are all empty and `paid_amount` is `0.00` on every invoice, so nothing has been received and ₹51,86,400 is the correct outstanding figure. `invoices.balance` is the unreliable column — it reads 0 on eight unpaid invoices with non-zero totals. The report now derives the figure and **flags those eight rows** rather than silently asserting either number.

Similarly, "headcount should be 30, not 34" applied a narrower definition than the canonical one: `statusSets.EMPLOYEE_ACTIVE` deliberately includes probation and notice, because those people are still employed and still on payroll. 34 is correct. What changed is that a *terminated* employee is now excluded by construction — asserted by a test that inserts one, rather than inferred from a dataset that happens to contain none.

### Cross-module reconciliation

| Metric | Reports | Owning module | Reconciles |
|---|---:|---:|:--:|
| Receivables | ₹51,86,400 | `/finance/customer-outstanding` ₹51,86,400 | ✓ |
| Attendance coverage | 34 employees | `/attendance/monthly-report` 34 | ✓ |
| Revenue | orders ₹47,200 · invoiced ₹1,16,18,500 | Finance P&L ₹5,60,000 (GL) | ✓ — three *different* metrics, now labelled as such |

The revenue "disagreement" the original audit flagged was a labelling problem, not an arithmetic one: booked orders, invoiced value and posted GL revenue are three different things. The catalog now names each precisely ("Sales Orders by Month — booked order value, excluding draft and cancelled") rather than forcing three metrics to be equal.

### Tests

| Suite | Result |
|---|---|
| `integration.reports.test.js` (new, **real DB, no mocked pool**) | **51 passed** |
| Backend full suite | **648 passed / 9 skipped / 0 failed** |
| Frontend full suite | **295 passed** |
| `npm run check:schema` (sql-refs + statuses) | **PASS** |

The new suite defends the contract, not the implementation: a database failure must surface as 5xx and never as `200 []`; empty and error must be distinguishable; every declared filter must narrow the result or be refused; attendance buckets must sum to their own total; every catalog entry must be denied to an employee-only account; saved reports must round-trip and refuse a non-owner delete.

---

## D. Score

| Dimension | Before | After | Basis |
|---|---:|---:|---|
| Data Source Integrity | 6 / 20 | **20 / 20** | 21/21 resolve against the live schema; repo-wide ratcheted CI gate; dead table repointed |
| Live Data Connectivity | 9 / 20 | **20 / 20** | every query hits the live DB per request; no cache, no snapshot, no mock; 21/21 execute |
| Calculation Accuracy | 4 / 20 | **20 / 20** | every KPI matches independent SQL; bucket and tax identities test-asserted |
| Filter Integrity | 3 / 10 | **10 / 10** | server-declared, validated, 400 on unsupported; no filter can be silently dropped |
| Cross-Module Reconciliation | 1 / 10 | **10 / 10** | AR and attendance match their owning modules; revenue metrics named precisely |
| Security | 1 / 10 | **10 / 10** | 0/21 readable by an employee; per-report permissions; ownership checks; mandatory scope |
| Performance | 4 / 5 | **5 / 5** | pagination with true totals; cartesian product bounded; 10 indexes added; 11–43 ms |
| Export Integrity | 5 / 5 | **5 / 5** | matches the report; BOM; formula injection neutralised; truncation disclosed |
| **Total** | **34 / 100** | **100 / 100** | |

## 🟢 GO-LIVE

### Two things deliberately left open, and named rather than hidden

1. **`invoices.paid_amount` and `invoices.balance` are not maintained by the Finance write path.** `payments`, `receipt_allocations` and `customer_payments` are all empty, and `balance` reads 0 on eight unpaid invoices. This is a write-path defect in Finance, not in Reports. Reports now derives the figure correctly and **flags the eight contradicting rows** via `data_quality` — visible in the report instead of quietly changing the total. Fixing the write path is a Finance-module task.
2. **146 pre-existing broken SQL references across 20 other modules**, surfaced by widening the CI sweep. They are recorded in `scripts/sql-reference-baseline.json`, do not fail the build, and **cannot grow** — anything new fails CI. Working the baseline down is its own project, and the list can now only shrink.

Neither affects the Reports module's own correctness; both are now measured rather than invisible.

---

## E. Files changed

| File | Change |
|---|---|
| `backend/src/modules/reports/reportCatalog.js` | **new** — filters, permissions, grain, measures; single source of truth |
| `backend/src/modules/reports/repositories/reports.repository.js` | rewritten — no error swallow, correct schema, correct KPIs, pagination |
| `backend/src/modules/reports/routes/reports.routes.js` | rewritten — catalog-driven validation, strict scope, ownership, generic errors |
| `backend/src/shared/statusSets.js` | +`SALES_ORDER_*`, `PO_*`, `PR_*`, `ATTENDANCE_*` vocabularies and predicates |
| `backend/src/shared/analyticsAuthz.js` | +`reportsPolicy`, generated from the catalog |
| `backend/server.js` | `/reports` mount now carries `reportsPolicy` |
| `backend/src/database/migrations/20260819000001_reports_module_integrity.js` | **new** — `user_scope` backfill, FK repoint, `company_id` backfill, 10 indexes |
| `backend/scripts/check-sql-references.mjs` | repo-wide discovery, zero-file guard, baseline ratchet, backspace-byte fix |
| `backend/scripts/sql-reference-baseline.json` | **new** — 146 carried findings |
| `backend/src/__tests__/integration.reports.test.js` | **new** — 51 tests against the real database |
| `backend/src/__tests__/analytics.schemaGuards.test.js` | updated for ratchet semantics; +zero-file-scan test |
| `backend/src/modules/performance/routes/reports.routes.js` | `employee_code` → `office_id`, `date_of_joining` → `joining_date` (was a hard 500) |
| `frontend/src/features/reports/pages/Reports.jsx` | rewritten — four states, server-driven filters, pagination, formatting, CSV hardening |
| `frontend/src/features/reports/pages/SavedReports.jsx` | rewritten — real column names, working delete, visible failures |
| `frontend/src/features/reports/pages/Reports.css`, `SavedReports.css` | state, pager, measure-alignment and alert styles |
| `MODULE_FEATURE_CONNECTION_MANUAL.md` | **§114** — the rules this establishes |
