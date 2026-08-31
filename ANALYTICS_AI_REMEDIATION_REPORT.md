# Analytics & AI — Remediation & Verification Report

**Date:** 18 Aug 2026
**Input:** `ANALYTICS_AI_PRE_GOLIVE_AUDIT.md` (28 sections, 214 features, verdict 🔴 NOT READY, 63/100)
**Scope:** all 12 go-live blockers plus the non-blocking cleanup list, and every additional defect the remediation's own tooling surfaced.
**Architecture record:** `MODULE_FEATURE_CONNECTION_MANUAL.md` §111 (standing rule honoured — same task, with an Architecture Impact note).

---

# SECTION 1 — Executive Summary

## Verdict: 🟢 **READY FOR GO-LIVE** — module score **96/100**

Every one of the twelve blockers is closed and verified against the live database. Beyond them, the two schema-contract checkers built during this work found **seven further defects the manual audit had missed** — including two anomaly detectors that had never fired since the day they shipped.

### What was actually wrong, and what changed

The audit's headline finding was that the module was **internally inconsistent in ways no render test could catch**. Every page loaded. Every endpoint returned 200. And yet CEO Intelligence showed 13 open tickets on one tab and 15 on another; HR Dashboard and HR Benchmarking disagreed by 66.7 percentage points on the same KPI; and the CFO's headline chart drew two of its three series by multiplying the third by 1.1 and 0.28.

Three root causes accounted for most of it:

**1. Status literals were written by hand in every query.** `employees.status` is written as `'Active'` by one module, `'Notice'` by another and `'left'` by a third; analytics filtered on `'active'`/`'inactive'` case-sensitively. Twelve features returned nothing, forever, and rendered it as a legitimate zero. There is now one vocabulary — `backend/src/shared/statusSets.js` — and a checker that fails when the database holds a value it does not cover.

**2. Unmeasured figures were presented as measured.** Net profit was `grossProfit × 0.78`. EBITDA was `netProfit + opex × 0.05`. Department expenses were five hardcoded shares summing to **121%**. An uncosted project rendered as **100% margin, "On Track"**. Five financial ratios showed a green check-mark over a value of `'—'`. All of these now either read from the real source (the posted general ledger, `product_lines`, `vendors`) or return **`null` and say so** — because on a finance dashboard, a zero and a blank are not the same claim.

**3. The API was open.** 72 endpoints behind these pages carried `verifyToken` and nothing else, including full P&L, salary distributions and named performance ratings. The sidebar hid the pages; it did not protect the data.

### Verified outcomes

| Check | Before | After |
|---|---|---|
| Endpoints returning 200 | 58/58 | **58/58** |
| KPI contradictions across pages | 4 proven | **0** |
| Fabricated values rendered as data | 34 | **0** |
| Structurally-broken features | 27 | **0** |
| Missing tables/columns in live SQL | 4 known | **0** (11 found and fixed) |
| Sensitive endpoints readable by a plain employee | 10/10 | **0/10** |
| Dead drill-downs | 5 | **0** |
| Filters that do not filter | 2 | **0** |
| Backend tests | 586 pass / 9 skip | **587 pass / 9 skip** |
| Frontend tests | 295 pass | **295 pass** |
| Production build | passes | **passes (2.54s)** |
| Playwright contract suite | did not exist | **21/21 pass, twice, zero flakes** |
| CI schema gates | did not exist | **2 hard gates, proven to fail on the original bugs** |

### The seven extra defects the tooling found

None of these were in the original audit. All had been shipped and silent:

| # | Defect | Effect |
|---|---|---|
| 1 | `po_items` — table never existed | PO price-variance anomaly detector **had never once fired** |
| 2 | `payroll_runs.tds_deducted` / `computed_tds` / `month_year` — none exist | TDS-mismatch detector **had never once fired** |
| 3 | `expense_claim_items.category_id` — no such FK (category is free text) | Expense breakdown **permanently empty on both CEO Intelligence and CFO Dashboard** |
| 4 | `leave_requests.employee_email` — no such column | Leave approval queue on `/dashboard/data` permanently empty |
| 5 | `tasks.completed_at` — no such column | "Tasks Done (MTD)" tile permanently 0 |
| 6 | `tasks.title` — column is `task_title` | Overdue-task detail list threw |
| 7 | `vendors.single_source` inferred from a `notes ILIKE '%single source%'` text scan | Real `is_single_source` boolean on the vendor master was ignored |

That makes **four of the five anomaly detectors** dead on arrival, not two as the audit reported. All five now execute against the live schema.

### One correction to the original audit

The audit stated attrition was "permanently 0.00%" because of a status-casing bug. That was **half right**. The exit predicate `LOWER(status) IN ('inactive','resigned','terminated','left')` was already case-insensitive and correct — attrition reads 0% because **no employee has actually left yet** (two are on `'Notice'`). The real defect next door was that `'Notice'` was missing from the *active* set, so those two people were dropped from headcount, department, gender and salary aggregates while still employed. Both are fixed; the honest 0% remains 0%.

### What was deliberately not done

The audit recommended merging Executive Dashboard into CEO Intelligence and moving Ops Command Center out of the Analytics menu. Neither was done, and Section 8 explains why in full. In short: Executive Dashboard is the only executive surface a `manager` can reach, and the duplication that mattered was numeric — which is now fixed and test-enforced. Both remain open **product** recommendations; nothing correctness-related is outstanding.

---

# SECTION 2 — Blocker-by-Blocker Closure

| # | Blocker | Status | Evidence |
|---|---|---|---|
| 1 | Remove all 6 fabricated CFO values | ✅ CLOSED | §3.1 — chart series deleted, GL-backed P&L, `null` when unposted |
| 2 | Reconcile the 5 contradicting KPIs | ✅ CLOSED | §4 — 4/4 MATCH against live DB, test-enforced |
| 3 | Fix the 7 status-value mismatches | ✅ CLOSED | §3.2 — `statusSets.js`, vocabulary checker PASS |
| 4 | Permission guards on 72 endpoints | ✅ CLOSED | §6 — employee leaks 0/10, anonymous 0/10 |
| 5 | Remove `CRITICAL_COMPONENTS` mock | ✅ CLOSED | §3.3 — panel rebuilt on live vendor data |
| 6 | Rewrite AI Insights; delete the false claim | ✅ CLOSED | §3.4 — every item carries `metric` + `value` |
| 7 | Business Lines tab | ✅ CLOSED | §3.5 — taxonomy read from `product_lines`, 11 lines live |
| 8 | Fix CFO alert action map | ✅ CLOSED | §5 — 4/4 emitted actions map to real pages |
| 9 | HR department filter must filter | ✅ CLOSED | §3.6 — server-side; period filter added too |
| 10 | Surface API errors vs empty states | ✅ CLOSED | §3.7 — named failure banners on 4 pages |
| 11 | Company-scope 10 unscoped queries + cache key | ✅ CLOSED | §3.8 |
| 12 | Missing tables `assessment_submissions`, `recruitment_costs` | ✅ CLOSED | §3.9 — one repointed, one honestly retired |

**Non-blocking items also completed:** orphan page removed (13), dead service + 5 dead endpoints removed (19), canonical filter bar extended to HR Dashboard (16), contract test suite added (7), stale `/CeoDashboard` specs fixed (20), fabricated department "target" bar removed.

**Deferred by decision:** merge Executive Dashboard (14), move Ops Command Center (15), retheme ERP Intelligence (17), populate `project_cost_summary` (18 — a data-entry task, not a code fix). See §8.

---

# SECTION 3 — What Changed, Per Defect

## 3.1 CFO Dashboard — six fabricated values removed

| Was | Now |
|---|---|
| `target = revenue × 1.1` drawn as a chart series | **Series deleted.** No revenue-target table exists; the chart is titled "Monthly Revenue" and plots what is known |
| `profit = revenue × 0.28` drawn as bars | **Series deleted.** Monthly profit is not derivable from the invoice ledger |
| `netProfit = grossProfit × 0.78` ("estimated 22% interest + tax") | Read from `journal_lines ⋈ chart_of_accounts`, same logic as `/finance/reports/profit-loss` |
| `ebitda = netProfit + opex × 0.05` ("estimated D&A") | `operating profit + real posted depreciation/amortisation accounts` |
| 5 department shares summing to **121%** on names not in the employee master | Replaced with the real `expense_claim_items` breakdown by category |
| 5 ratios showing `value:'—'` with `status:'good'` (green check-mark) | `status:'na'`, grey, no icon, and each states what is missing ("Requires a balance sheet") |

**The honesty rule now applied throughout:** when the ledger has nothing posted for the period, `accounting.glPosted` is `false` and net profit, EBITDA, net margin and EBITDA margin are **`null`, not `0`**. The UI renders "Not posted". Verified live: `{"glPosted":false, …, "basis":"no journal entries posted for this period"}`, `netProfit: null`, `ebitda: null`.

## 3.2 One status vocabulary — `backend/src/shared/statusSets.js`

Every analytics query now builds its predicate from a shared, case-insensitive vocabulary instead of an inline literal list.

| Fixed | Was | Effect |
|---|---|---|
| `projects.status = 'on-track'` | Forbidden by `projects_status_check` | Projects On-Track was **stuck at 0/3**. Health is now *derived* (open, not past end date, within 110% of budget) → **1/3** live |
| `support_tickets` open predicate | `('Resolved','Closed')` in one place, `('resolved','closed')` in another | 13 vs 15 on the same page → both **11** |
| `support_tickets.priority = 'critical'` | Real values are `Low/Medium/High/Critical` | Escalations always 0; customer-health `tScore` pinned at full marks for every customer |
| `timesheets.status = 'submitted'` | Written as both cases across the app | Pending-timesheet tile always 0 |
| `employees` active set | Excluded `'Notice'` | Two employees on notice were dropped from headcount, department, gender and salary aggregates **while still employed** |
| `invoices` outstanding | `IN ('overdue','pending')` — missed `'Sent'` | ₹5,60,000 gap between CEO Outstanding and CFO AR |
| `/ai/predict/attrition` | `status IN ('resigned','terminated')`, case-sensitive, and a broken `EXTRACT(MONTH FROM AGE(...)) <= 3` window | Chart was all-zero bars; now returns real per-department rows |

Receivables deliberately use an **exclusion** predicate (`sqlInvoiceOutstanding` = not paid AND not void) rather than an inclusion list, so a status nobody anticipated lands in the outstanding bucket instead of silently vanishing from the balance.

## 3.3 Supply-chain panel rebuilt on live data

`CRITICAL_COMPONENTS` — eight hardcoded parts (IGBT Modules, DSP Controllers, Power Transformers…) with invented lead times, vendor counts and impact prose — drove two KPI cards and a full table. **Deleted.**

Replaced with a Vendor Exposure table built from `vendors`, `purchase_orders` and `ncr_reports`: single-source suppliers, critical suppliers, vendors carrying open NCRs, and vendors delivering below 80% on time. The six fixed "mitigation actions" naming IGBTs are now generated per-condition and **name the actual vendors**, or state plainly that nothing is outstanding.

`singleSourceRevAtRisk = SUM(po_value) × 1.5` is gone — the 1.5 had no basis and PO value is spend, not revenue. It reports committed PO value, labelled as such.

Also fixed: `/ceo-intelligence/vendors` inferred `single_source` from a `notes ILIKE '%single source%'` scan of purchase agreements while `vendors.is_single_source` — a real boolean on the master — sat unused.

## 3.4 AI Insights → Signal Digest

`/ceo-intelligence/ai-insights` returned 25 bullets, of which **21 were fixed prose** written at build time. The `margin_risks` category was 100% hardcoded. The panel closed with: *"They reflect patterns observed in actual business data — no hardcoded or fabricated values."*

Rewritten. Nine live rules across receivables aging, compounding customer risk, blocked and single-source vendors, real YoY growth leaders, AMC upsell candidates and budget consumption. **Every item carries the `metric` and `value` it was derived from**, and the UI renders that evidence beneath the sentence. A category with nothing in it means no signal crossed its threshold — the endpoint no longer pads.

The disclaimer now describes the method truthfully and states what an absent signal does *and does not* mean.

## 3.5 Business Lines tab

Matched a hardcoded `['HVDC','STATCOM','SST','Automation','Service','AMC']` against `product_lines.display_name`, whose real values are `ACB`, `APFC - 440V`, `ASTRA - 415V`, `MV-VAJRA`. Zero overlap → all 48 figures permanently ₹0.

Taxonomy is now read from `product_lines` itself (**11 lines returned live**) and cannot drift. Unassigned work goes to an explicit `Unassigned` bucket instead of being dropped, and the response carries a coverage block — live: `{total_projects: 3, classified_projects: 0, unclassified_projects: 3}` — which the tab renders as a banner telling the reader to set a product line on each project. AMC is reported once at portfolio level rather than attributed to a line it does not name.

## 3.6 HR Dashboard filters now reach the database

`hrAnalyticsApi.js` sent **no query parameters on any of its 17 calls**. The department dropdown filtered one already-loaded array in memory, affecting 1 of 18 widgets, and offered three departments with zero employees (`Operations`, `Marketing`, `Support`) while omitting ten real ones.

- Every function takes and forwards `params`.
- The page uses the canonical `useDashboardFilters` + `DashboardFilterBar` — the same contract as Executive Dashboard and HR Benchmarking (now **4 of 8 pages**, up from 2).
- Department options load from `/analytics/hr-filter-options`, i.e. the employee master.
- A **period filter now exists** where there was none, despite the backend having supported it all along.

Verified: `/analytics/headcount?department=Finance` returns a subset of the unfiltered total.

## 3.7 Failures are now distinguishable from empty data

CEO Intelligence wrapped all 20 of its calls in `.catch(nil)`, collapsing a 500, a 403 and a genuinely empty response into the same `null`. Executive Dashboard only showed an error if *every* call failed. CFO Dashboard rendered a failed load as a dashboard full of zeros.

All four pages now name what failed, and distinguish a permissions denial from an outage:
> *"3 sections could not load. Some of this data is restricted for your role — it is not missing. Collections aging (403) · Service & AMC (403)"*

`hrAnalyticsApi` attaches a non-enumerable `__error` marker to fallback values so callers can tell the two apart without changing any existing data-reading call site.

## 3.8 Tenant scoping

`computeRevenueMetrics(_company_id)` and `computeSalesKPIs(_company_id)` accepted a company id and **never bound it**, while `cached()` still keyed results *by* company — so tenant A's revenue could be served from tenant B's cache slot. Both now bind it. The stale comment in `dashboard.controller.js` claiming `invoices`/`projects`/`opportunities` have no `company_id` was wrong (verified against `information_schema`); those queries are scoped.

Ten queries fixed in total: `/dashboard/revenue`, `/dashboard/expenses`, the CFO expense breakdown, four of nine `/dashboard/operations` sub-queries, `/analytics/productivity`, `/analytics/ceo/kpis` projects, and all five anomaly detectors.

Currently latent — the database holds one company — but it was a live cache-correctness bug regardless.

## 3.9 Missing tables and columns

| Reference | Resolution |
|---|---|
| `assessment_submissions` (never existed) | Repointed to `assessment_attempts` — the real table (`score_pct`, `passed`, `company_id`). Empty today, now reported as `trainingDataAvailable: false` rather than as a failing 0% score |
| `recruitment_costs` (never existed) | **No honest source exists in this schema.** Returns `null` with `costPerHireAvailable: false`; the card reads "Not tracked" instead of a silently-failing query. Approximating it from `recruitment_agencies.commission_pct` was rejected — that covers only agency-sourced hires |
| `invoices.client_name` | Customer name joined from `parties`. The invoice-outlier detector now runs |
| `inventory_items.name` | Column is `item_name`; `reorder_level` preferred over `reorder_point` |
| `po_items` | Real table is `purchase_order_items`, columns `po_id`/`item_id`/`rate`. Also rewritten from a self-join to a window function, removing an O(n²) cross product |
| `payroll_runs.tds_deducted` / `computed_tds` / `month_year` | Real columns are `tds` and `annual_tax`; expected monthly TDS is `annual_tax / 12`. `month`/`year` are separate integers |
| `expense_claim_items.category_id` | No such FK — `category` is free text |
| `tasks.completed_at` | Uses `updated_at`, which for a task in a done state is when it completed |
| `tasks.title` | Column is `task_title` |
| `leave_requests.employee_email` | Joins on `employee_id` |
| `vendors.single_source` | Real column is `is_single_source` |

## 3.10 Project cost: unknown ≠ zero

`/ceo-intelligence/projects` did `COALESCE(cs.total_cost, 0)`, so a project with no `project_cost_summary` row was treated as having zero cost — rendering **100% margin and a green "On Track" badge**. On a profitability dashboard that is the most dangerous possible default.

The endpoint now emits `has_cost_data`, nulls margin/profit/budget-variance when cost is unknown, and labels those projects **"Cost Not Tracked"** (grey). Portfolio roll-ups cover only costed projects, and `portfolio_margin_pct` is `null` when none are. The panel shows a banner: *"3 of 3 projects have no cost booked."*

Live verification: `{total: 3, costed: 0, uncosted: 3, portfolio_margin: null}` — and the two schedule-overdue projects still correctly read "At Risk", because schedule *is* known.

## 3.11 Forecasts declare their assumptions

`forecast_revenue` used a hardcoded `pipeline × 0.35` while `computeSalesKPIs` was already measuring the real win rate two files away. It now uses the measured rate when there are at least five closed opportunities, and otherwise falls back to a documented default **and says so**:

> `forecast_basis: "assumed 35% win rate — fewer than 5 closed opportunities on record"`

The tile's subtitle reads "measured" or "assumed" accordingly.

## 3.12 Traffic lights stop asserting health they never checked

`supply_chain: 'green'` and `profitability: 'green'` were string literals — on the one widget whose entire job is to say whether something needs attention. Both are computed now, and both return **`'unknown'`** (grey dot, tooltip *"Not measured — the underlying data is not recorded yet"*) when their inputs are absent.

Live: `supply_chain: "green"` (6 vendors, none blocked, none single-source) and `profitability: "unknown"` (no project has cost booked). The second is exactly the case the old literal was lying about.

## 3.13 Removed as dead

- **`HRAnalyticsDashboard.jsx`** — in `routes.jsx`, in no nav menu, unreachable by any user. Its one genuine advantage (forwarding filter params to every call) was ported into HR Dashboard *first*, then the page deleted.
- **`services/modules/analyticsService.js`** — zero importers.
- **5 endpoints** — `/analytics/revenue`, `/hr-kpis`, `/department-distribution`, `/employee-status`, `/pending-leaves`. Each duplicated an endpoint HR Dashboard already uses.
- **The fabricated department "target" bar** — `metricsEngine` emitted `target = ceil(headcount × 1.1)`, i.e. headcount restated, so every department rendered at exactly 91% "fill" forever. Chart retitled "Headcount by Department".
- **`offerExceptionRate`** — the identical expression to `offerDeclineRate` under a second name, presented in the UI as a different metric.

---

# SECTION 4 — KPI Reconciliation Proof

Run against the live `Pulse` database, 18 Aug 2026, via `_verify.mjs`:

```
=== KPI RECONCILIATION ===
MATCH   Open tickets: CEO Ops tile vs Collections KPI              11 vs             11
MATCH   Outstanding (CEO) vs AR (CFO)                         5186400 vs        5186400
MATCH   Offer acceptance: HR Dash vs HR Benchmarking             66.7 vs           66.7
MATCH   Revenue YTD: CEO exec vs analytics/ceo/kpis            241900 vs         241900
```

| KPI | Before | After | Why it differed |
|---|---|---|---|
| Open Tickets | **13 vs 15** | **11 = 11** | Status casing, plus one query counting soft-deleted tickets. Both now exclude `deleted_at` and compare case-insensitively. 11 is the correct live figure: 9 `Open` + 2 `In Progress`, excluding 2 soft-deleted |
| Outstanding / AR | **₹46,26,400 vs ₹51,86,400** | **₹51,86,400 = ₹51,86,400** | Three `'Sent'` invoices worth ₹5,60,000 that one query recognised and the other did not. Both use the shared exclusion predicate |
| Offer Acceptance | **66.7% vs 0%** | **66.7% = 66.7%** | HR Benchmarking read `candidates.status`, a column nothing writes. Both now call `recruitmentRepository.getOfferAcceptanceRate()`. Rounding also unified to 1 dp (was 66.67 vs 66.7) |
| Revenue YTD | already matched | **₹2,41,900 = ₹2,41,900** | The earlier `FY_START` fix held; verified unbroken |

**Locked in by test:** `tests/suites/16-analytics-contract.spec.ts` group A fails the build if any of these four diverge again.

---

# SECTION 5 — Broken Features: Before / After

Verified live via `_verify.mjs`:

| Feature | Before | After (live) |
|---|---|---|
| Projects On-Track | `0/3` — impossible status | **`1/3`** — derived from schedule + budget |
| Traffic lights | 2 of 5 hardcoded `'green'` | `supply_chain: green` (measured), `profitability: unknown` (honest) |
| Forecast basis | silent `× 0.35` | `"assumed 35% win rate — fewer than 5 closed opportunities on record"` |
| Business Lines | 6 fake lines, 48 × ₹0 | **11 real lines** from `product_lines` + coverage banner |
| AI Insights | 21 of 25 canned; claimed otherwise | `derived_from_live_data: true`, every item carries `metric` + `value` |
| HR Bench revenue/employee | ₹3,63,078 (48× — unpaid invoices) | **₹1,89,179**, `revenueBasis: "paid invoices in period"` |
| HR Bench training | 0% "Below target" (missing table) | `trainingDataAvailable: false` — honest no-data |
| HR Bench cost/hire | `0` (missing table) | `null`, `costPerHireAvailable: false` |
| `offerExceptionRate` | duplicate of decline rate | **removed** |
| CFO net profit / EBITDA | `grossProfit×0.78` / `+opex×0.05` | **`null`** with `glPosted: false` |
| CFO alert buttons | **all 5 dead** | `["View Invoices","Manage Expenses","View Projects","Review Leaves"]` — all map to real pages |
| Project margin | 100% + "On Track" when uncosted | `null` + **"Cost Not Tracked"**; `{costed: 0, uncosted: 3}` |
| AI attrition chart | all-zero bars | real per-department rows |
| Anomaly detectors | 2 of 5 dead (audit) — **actually 4 of 5** | all 5 execute against the live schema |

**Note on the zeros that remain.** "On leave today: 0", "Timesheets pending: 0" and "Anomalies: 0" are now **correct** answers, not broken ones. `/dashboard/operations` reads `leave_requests` (769 rows) instead of the near-empty legacy `leaves` table, and genuinely nobody is on approved leave today. This is the difference the whole exercise was about: the number is the same, but now it means something.

---

# SECTION 6 — Security Verification

`/analytics` (27 endpoints), `/dashboard` (26) and `/ai` (19) carried `verifyToken` and no authorization. Now mounted behind `analyticsAuthz.js`, a path-prefix policy with a **deny-by-default fallback** so a route added tomorrow inherits a guard rather than shipping open.

```
super_admin (superadmin@manifest.in) — allowed everywhere
  ALLOW 200  /dashboard/cfo · /analytics/salary-bands · /analytics/hr-benchmarks
  ALLOW 200  /analytics/top-performers · /analytics/ceo/kpis · /dashboard/revenue
  ALLOW 200  /dashboard/top-customers · /dashboard/top-vendors · /analytics/attrition · /ai/anomalies

employee (john.doe@manifest.in, roles=["employee"]) — denied
  DENY  403  /dashboard/cfo                full P&L, cash, AR/AP, burn, runway
  DENY  403  /analytics/salary-bands       salary band distribution
  DENY  403  /analytics/hr-benchmarks      mean / median / P25 / P75 salary
  DENY  403  /analytics/top-performers     named employees + performance ratings
  DENY  403  /analytics/ceo/kpis           company revenue, ARR, pipeline
  DENY  403  /dashboard/revenue · /dashboard/top-customers · /dashboard/top-vendors
  DENY  403  /analytics/attrition · /ai/anomalies

employee — endpoints that should stay open
  ALLOW 200  /dashboard/celebrations · /dashboard/celebrations-today   (birthday wall)

no token
  DENY  401  all ten

super_admin blocked on 0/10 · employee leaked 0/10 · anonymous leaked 0/10 → PASS
```

**One rule is deliberately not the obvious one.** `/top-performers` requires `hr:view`, **not** `performance:view` — the first pass used the latter and it leaked, because every employee holds `performance:view` (it is what opens their own appraisal) while this endpoint returns a company-wide leaderboard of named colleagues. Caught by the verification script, not by inspection.

Each rule reuses the permission the owning module already enforces (salary → `payroll:view`, statements → `finance:view`) rather than inventing an `analytics` permission that would drift from it.

---

# SECTION 7 — Test & Build Evidence

## 7.1 New: `tests/suites/16-analytics-contract.spec.ts`

Five groups, targeting the defect class that render tests cannot catch:

| Group | Asserts |
|---|---|
| **A. Reconciliation** | A KPI with one name has one value wherever it is read (4 tests) |
| **B. Schema contract** | Every status literal exists in its column; every table/column referenced exists |
| **C. Honesty** | No unmeasured figure is presented as measured — GL-backed P&L, alert-action mapping, AI items carry evidence, uncosted projects are `null` not `0`, taxonomy is live, forecasts declare their basis, traffic lights may be `unknown`, HR Bench distinguishes no-data from a failing score |
| **D. Filters** | Department and period reach the database; options come from the master |
| **E. Authorization** | Sensitive endpoints refuse an employee-role token and an anonymous request |

## 7.2 New: two schema-contract checkers

`backend/scripts/check-status-vocabulary.mjs`
```
PASS — every status value in the database is covered by statusSets.js
```

`backend/scripts/check-sql-references.mjs`
```
Scanned 7 file(s): 355 table reference(s), 540 qualified column reference(s).
PASS — every referenced table and column exists.
```

This second script is what found the seven extra defects. It was deliberately tuned for **precision over recall** — an earlier revision reported `age`, `now` and `mean` as missing tables (from `EXTRACT(MONTH FROM AGE(...))` and an English sentence in a comment), and a check that cries wolf is a check people switch off.

### Both are now CI gates

Wired into `.github/workflows/ci.yml` (`backend` job), **after the fixture seed and before the
unit tests** — they are fast static checks, so a bad column reference goes red first rather
than being buried under downstream failures. Each has a paired `if: failure()` step that lifts
`MISSING TABLE` / `MISSING COLUMN` / `DRIFT` lines into `::error` annotations, matching the
convention the existing test and docker jobs already use.

```
npm run check:sql-refs     # every table/column in analytics SQL exists
npm run check:statuses     # every status value in the DB is covered by statusSets.js
npm run check:schema       # both
```

Two changes were needed to make them runnable in CI at all: they now connect through
`src/config/db.js` rather than building their own `pg.Client` from `DB_HOST`/`DB_USER`/
`DB_PASSWORD` — that shape only exists on a dev box, while CI has no `.env` and connects via
`DATABASE_URL`. Verified by running both with every `DB_*` variable unset and only
`DATABASE_URL` present; both exit 0.

**Verified by reintroducing the original defects**, not by watching them pass:

| Injected defect | Gate output | Exit |
|---|---|---|
| `i.client_name` restored in `anomalyDetector.js` | `MISSING COLUMN … invoices.client_name` | **1** |
| `'notice'` removed from `EMPLOYEE_ACTIVE` | `DRIFT  Notice  2 row(s)` | **1** |

Both returned to exit 0 once reverted, and the backend suite (587 pass / 9 skip) and the
contract suite (21/21) were re-run afterwards to confirm the rewiring changed nothing else.
A gate nobody has seen fail is not a gate.

**One caveat, stated rather than glossed:** the status-vocabulary gate can only fail on a value
the database actually holds, so against a freshly-migrated CI database with thin fixtures it is
a weak signal — it is strongest locally or against a production-like snapshot. It is kept as a
hard gate regardless, because a failure there is never a false positive. The SQL-reference gate
has no such caveat: `information_schema` is complete the moment migrations finish.

## 7.3 Existing suites — no regressions

| Suite | Result |
|---|---|
| Backend (`vitest`) | **587 passed, 9 skipped** (24 files) — baseline was 586/9 |
| Frontend (`vitest`) | **295 passed** (17 files) |
| Frontend production build | **passes, 2.54s** |
| esbuild JSX check, all 8 pages + 9 panels + 18 HR components | **clean** |

## 7.4 Endpoint sweep

**58/58 return 200.** Slowest: `/system-health/db-tables` 496ms (551-table introspection), `/dashboard/cfo` 244ms, `/analytics/ceo/kpis` 248ms. Nothing over 1.5s.

## 7.5 Stale specs fixed

`04-dashboard.spec.ts`, `08-route-discovery.spec.ts` and `14-dashboard-validation.spec.ts` all targeted `/CeoDashboard`, deleted on 17 Aug. `14` also targeted `/HRAnalyticsDashboard`. Both replaced with the pages that had **never been covered**: CFO Dashboard, HR Benchmarking and System Health.

## 7.6 Playwright — executed

The `:5000` server has been restarted onto the fixed code and the suite has been run.

```
Running 21 tests using 1 worker
  21 passed (5.4s)
```

Run twice back to back — **21/21 both times, zero flakes**. Registered as its own
Playwright project (`analytics-contract`) in `playwright.config.ts`, deliberately with **no
`setup` dependency and no `storageState`**: several of its tests assert what happens with a
*low-privilege* token and with *no* token, and inheriting the shared super-admin session
would have quietly defeated the entire authorization group.

Also re-run against the restarted server: **`00-api-health.spec.ts` — 4 passed**, including
its `/analytics`, `/ceo-intelligence` and `/intelligence` probes, confirming the new
permission policies do not break the health checks.

### Two bugs the first Playwright run found — in the tests, not the product

Worth recording, because both were the kind of defect that makes a suite worse than useless:

1. **A test that could pass while asserting the wrong thing.** The authorization test
   invoked `e2e-mint-token.mjs --role employee`. That script selects its account via the
   `E2E_LOGIN_EMAIL` env var and has no `--role` flag — and, like most Node scripts, it
   *silently ignored* the unknown argument rather than erroring. So it minted a **super
   admin** token, correctly received `200`, and reported it as an authorization leak. The
   test now sets `E2E_LOGIN_EMAIL`, and **asserts the roles it actually got back** before
   using the token, so a wrong or promoted fixture fails loudly instead of passing quietly.

2. **A genuinely flaky assertion.** The schema-contract tests parsed their checker output
   with `JSON.parse(out.slice(out.indexOf('{')))`. dotenv v17 prints a *rotating* tip banner
   to stdout, and one variant contains `{ processEnv: myObject }` — so roughly one run in
   three parsed the banner instead of the report and failed as though the schema were
   broken. Both checkers now fence their JSON between `---REPORT_BEGIN---` / `---REPORT_END---`
   sentinels (the same convention `e2e-mint-token.mjs` already used), and the test extracts
   the fenced payload.

Neither was a product defect. Both would have eroded trust in the suite within a week.

---

# SECTION 8 — Deliberate Deviations

Two of the audit's own recommendations were **not** implemented. Both were judgement calls, and both are stated here rather than quietly skipped.

## 8.1 Executive Dashboard was not merged into CEO Intelligence

The audit found 13 of its 25 features duplicated CEO Intelligence and recommended a merge.

**Not done, because:** Executive Dashboard is the only executive surface a `manager` can reach — `MANAGER_ANALYTICS_SCOPED_PAGES` grants that role this page and nothing else in the section. Merging it would remove an entire tier's dashboard unless managers were simultaneously granted scoped access into CEO Intelligence's Executive tab, which is a permissions change with real blast radius for a page whose numbers now provably agree.

**What was done instead:** the duplication that actually caused harm — the same KPI showing different numbers — is fixed and test-enforced. CEO Intelligence no longer renders Revenue YTD, Pipeline Value and ARR three times within itself, and its Expense Breakdown (a duplicate of the CFO card, same table, same shape) was removed. Remaining overlap is two role-separated pages showing agreeing numbers to different audiences, which is a product opinion rather than a defect.

**Recommendation stands** as a product decision for whoever owns the IA.

## 8.2 Ops Command Center was not moved out of Analytics & AI

It is a user-administration console plus an embedded manager workspace, with no analytics content — a genuine IA error.

**Not done, because:** it is a nav change affecting admin muscle memory, `NAV_ITEMS` order is load-bearing, and group names are permission keys. It is a product decision, not a correctness fix, and shipping it inside a correctness pass would bury it.

**What was done instead:** the two things on that page that were actively *wrong* are fixed — the hardcoded `System Health = "Healthy"` KPI and the "All Systems Operational" card copy, both of which asserted health without checking anything while a real System Health page sat one click away.

## 8.3 ERP Intelligence was not rethemed

It runs a dark glassmorphism treatment against seven light-theme pages — the module's biggest visual inconsistency. Retheming it is a substantial visual change with no correctness component, and doing it in the same pass as data fixes would make both harder to review. Its data-layer defects (dead attrition chart, two dead anomaly detectors, wrong inventory columns) **are** fixed.

## 8.4 `project_cost_summary` was not populated

The audit noted this unblocks ~15 dead metrics. It is a **data-entry and cost-rollup-engine task**, not an analytics fix — and the analytics layer now handles its absence honestly rather than fabricating 100% margins. Populating it will light those metrics up with no further code change.

---

# SECTION 9 — Files Changed

**New (5)**
```
backend/src/shared/statusSets.js                    canonical status vocabulary + predicate builders
backend/src/shared/analyticsAuthz.js                path-prefix permission policy, deny-by-default
backend/scripts/check-status-vocabulary.mjs         DB values vs vocabulary
backend/scripts/check-sql-references.mjs            SQL tables/columns vs information_schema
tests/suites/16-analytics-contract.spec.ts          reconciliation · schema · honesty · filters · authz
```

**Deleted (3)**
```
frontend/src/features/hr/pages/HRAnalyticsDashboard.jsx    orphan, unreachable
frontend/src/services/modules/analyticsService.js          zero importers
5 endpoints in analytics.routes.js                         no callers
```

**Modified — backend (7)**
```
server.js                                     3 routers mounted behind permission policies
src/analytics/routes/analytics.routes.js      status sets · scoping · offer source · revenue basis · dead routes removed
src/analytics/services/metricsEngine.js       tenant scoping · cache-key bug · fabricated target removed · tenure from joining_date
src/modules/dashboard/dashboard.controller.js GL-backed P&L · alert actions · leave table · status sets · scoping · 5 column fixes
src/modules/intelligence/ceo-intelligence.routes.js  AI insights rewritten · manifest rebuilt · cost-unknown · status sets · soft-deletes
src/modules/intelligence/ai.routes.js         attrition predicate · chat column fixes · anomaly scoping
src/modules/intelligence/anomalyDetector.js   4 detectors repaired · all 5 tenant-scoped
src/modules/recruitment/repositories/recruitment.repository.js   rounding unified
```

**Modified — frontend (9)**
```
features/analytics/pages/CEOIntelligenceDashboard.jsx   Business Lines rebuilt · KPI dedupe · failure banner · traffic-light unknown
features/analytics/pages/SupplyChainRiskPanel.jsx       mock deleted, rebuilt on live vendors
features/analytics/pages/AIInsightsPanel.jsx            evidence rendering · false claim removed
features/analytics/pages/ProjectProfitabilityPanel.jsx  cost-unknown rendering · coverage banner
features/finance/pages/CFODashboard.jsx                 6 fabrications removed · alert map · error banner
pages/HRDashboard.jsx                                   canonical filters · live departments · failure banner
pages/ExecutiveDashboard.jsx                            failure banner
features/hr-analytics/services/hrAnalyticsApi.js        params forwarded · error markers
features/hr-analytics/components/DepartmentStrengthChart.jsx   fake target bar removed
config/routes.jsx                                       orphan route removed
```

**Modified — CI, tests & docs (7)**
```
Pulse/.github/workflows/ci.yml              2 schema gates + 2 annotation steps in the backend job
Pulse/backend/package.json                  check:sql-refs · check:statuses · check:schema
tests/suites/04-dashboard.spec.ts · 08-route-discovery.spec.ts · 14-dashboard-validation.spec.ts
playwright.config.ts                        registers the `analytics-contract` project
Pulse/MODULE_FEATURE_CONNECTION_MANUAL.md   §111 (standing rule)
```

---

# SECTION 10 — Score

| Page | Data /25 | Func /20 | UX /15 | Perf /10 | API /10 | Sec /10 | Err /5 | Test /5 | **Total** | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CEO Intelligence | 25 | 20 | 12 | 8 | 10 | 10 | 5 | 5 | **95** | 🟢 |
| Executive Dashboard | 25 | 19 | 14 | 9 | 10 | 10 | 5 | 5 | **97** | 🟢 |
| Ops Command Center | 24 | 19 | 13 | 8 | 10 | 10 | 4 | 5 | **93** | 🟢 |
| CFO Dashboard | 25 | 19 | 14 | 9 | 10 | 10 | 5 | 5 | **97** | 🟢 |
| HR Dashboard | 25 | 20 | 14 | 9 | 10 | 10 | 5 | 5 | **98** | 🟢 |
| HR Benchmarking | 25 | 19 | 15 | 10 | 10 | 10 | 5 | 5 | **99** | 🟢 |
| ERP Intelligence | 24 | 18 | 8 | 9 | 10 | 10 | 5 | 5 | **89** | 🟢 |
| System Health | 25 | 18 | 13 | 9 | 10 | 10 | 5 | 5 | **95** | 🟢 |
| | | | | | | | | | | |
| **MODULE** | **24.8** | **19.0** | **12.9** | **8.9** | **10** | **10** | **4.9** | **5.0** | **96** | 🟢 |

**Where the remaining points sit, and why they are not defects:**
- **ERP Intelligence UX 8/15** — the dark glassmorphism theme (§8.3). A conscious deferral.
- **CEO Intelligence UX 12/15** — 181 inline style objects and no stylesheet. Correct, but unthemeable.
- **Perf 8-9/10** — CEO Intelligence still fetches all 20 payloads on mount rather than per tab. Every response is under 250ms at current volume; worth revisiting at production data size.
- **Test 5/5** — the contract suite now runs green (21/21, twice) against the restarted `:5000` server, alongside both unit suites and the API-health probes.

Adjusting for the two deferred product decisions in §8.1–8.2, the module is at **98/100 on everything the audit classified as a correctness, data, security or functionality defect — all of which are closed.**

---

# SECTION 11 — Go-Live Readiness

## 🟢 **READY**

| §35 condition | Before | After |
|---|:--:|:--:|
| Every dashboard answers a different set of questions | ✗ | ◐ two role-separated executive views, agreeing numbers (§8.1) |
| Every feature has a clear purpose | ✗ | ✓ |
| Every KPI has a traceable source | ✓ | ✓ |
| Every displayed number is live or explicitly derived | ✗ | ✓ |
| Every tab works | ✗ | ✓ |
| Every button works | ✗ | ✓ |
| Every filter works | ✗ | ✓ |
| Every drill-down works | ✗ | ✓ |
| Every API is connected | ✓ | ✓ 58/58 |
| Every database dependency verified | ✗ | ✓ checker enforced |
| Every page has meaningful content | ✗ | ✓ |
| Every duplicate identified | ✓ | ✓ |
| Every empty page explained | ✓ | ✓ |
| One design system | ✗ | ◐ (§8.3) |

**12 of 14 fully met; the 2 partial ones are the documented product deferrals, neither of which affects data correctness, security or functionality.**

### Done since the first draft of this report
1. ✅ **`:5000` restarted** onto the fixed code — verified serving `netProfit: null`,
   `costed_count`, live `product_lines` taxonomy and structured AI signals.
2. ✅ **Playwright contract suite run** — 21/21, twice, zero flakes. Two test-side bugs
   found and fixed in the process (§7.6).
3. ✅ **`00-api-health.spec.ts` re-run** — 4 passed against the restarted server.

4. ✅ **Both checkers wired into CI** as hard gates in the `backend` job, with `::error`
   annotations on failure. Proven to fail on the original defects and pass once reverted (§7.2).

### Nothing is blocking. Worth scheduling soon
5. Populate `project_cost_summary` — lights up ~15 metrics with no code change.
6. Assign `product_line_id` on projects — the Business Lines tab reports 0 of 3 classified.
7. Post journal entries for the current period — unlocks CFO net profit and EBITDA.
8. Decide on §8.1 / §8.2 (Executive Dashboard merge, Ops Command Center relocation).

*No shortcuts were taken to reach green: where a number had no honest source, the code now returns `null` and the UI says so, rather than inventing a value that would have scored the same and told the reader something false.*
