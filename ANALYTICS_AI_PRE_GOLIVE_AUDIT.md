# Analytics & AI — Pre-Go-Live Feature Inventory, Duplication & Live-Data Audit

**Date:** 18 Aug 2026
**Scope:** every page under the `Analytics & AI` nav section, their sub-tabs, panels, APIs and database sources.
**Method:** full source read of all 8 pages + 9 embedded panels + 18 HR-analytics components, full read of the 5 backing route files, and **direct queries against the live `Pulse` Postgres database (551 tables)** to prove or disprove every number.
**Code changed:** none. This is inventory-only, per instruction §32. No architecture was touched, so no `MODULE_FEATURE_CONNECTION_MANUAL.md` entry is required for this pass.

---

# SECTION 1 — Executive Summary

## Verdict: 🔴 **NOT READY FOR GO-LIVE**

The module is *not* mostly-working-with-rough-edges. Three separate classes of defect are present, and two of them are the kind that destroy trust in a BI product the first week it is used.

**1. Fabricated numbers are rendered as business data on the CFO's primary chart.**
`CFODashboard.jsx` computes the "Target" and "Profit" series of its headline *Revenue vs Target* chart as `revenue × 1.1` and `revenue × 0.28`. The backend computes Net Profit as `grossProfit × 0.78` (a hardcoded 22% tax+interest guess) and EBITDA as `netProfit + opex × 0.05` (a hardcoded 5% D&A guess). The "Department Expenses" card splits OpEx across five hardcoded departments using hardcoded shares that **sum to 121%**. None of these are data.

**2. The same KPI reports different numbers on different pages — and in one case on the same page.**
- *Open Tickets*: CEO Intelligence → Operations tab shows **13**; CEO Intelligence → Collections tab shows **15**. Same page, same day. Cause: one query says `NOT IN ('Resolved','Closed')`, the other `NOT IN ('resolved','closed')`, and `support_tickets.status` is capitalised.
- *Offer Acceptance Rate*: HR Dashboard shows **66.7%** (from `offer_letters`); HR Benchmarking shows **0%** (from `candidates.status`, a column nothing in the app writes). Both are in the same nav group.
- *Outstanding vs AR*: CEO Intelligence shows **₹46,26,400**; CFO Dashboard shows **₹51,86,400**. The ₹5,60,000 gap is three invoices with status `'Sent'`, which one query includes and the other excludes.

**3. Whole features are structurally dead — they cannot ever produce a value, regardless of data.**
- *Business Lines tab* (CEO Intelligence): matches a hardcoded list `['HVDC','STATCOM','SST','Automation','Service','AMC']` against `product_lines.display_name`, whose actual values are `ACB`, `APFC - 440V`, `MV-VAJRA`… Zero overlap. Six cards of zeros, permanently.
- *Projects On-Track* (CEO KPI strip): filters `projects.status = 'on-track'`; the `projects_status_check` constraint only permits `planning|active|on_hold|completed|cancelled`. Permanently `0/3`.
- *Attrition Risk by Department* (ERP Intelligence): filters `status IN ('resigned','terminated')`; real statuses are `Active|Notice|Probation`. Permanently all-zero bars.
- *Invoice Amount Outlier* + *Low Attendance* anomalies: query a column that does not exist (`invoices.client_name`) and a status casing that never matches. Both fail silently into `catch(_){}`.
- *Training Effectiveness* and *Cost per Hire* (HR Benchmarking): query `assessment_submissions` and `recruitment_costs` — **neither table exists**.

**4. "AI Insights" is 84% canned prose.** `/ceo-intelligence/ai-insights` returns 25 bullets across 5 categories. Only 4 are derived from data. The `margin_risks` category is 100% hardcoded. The panel that renders it states verbatim: *"They reflect patterns observed in actual business data — no hardcoded or fabricated values."* That claim is false.

**5. The APIs behind every one of these pages are authenticated-only.** `/analytics/*` (27 endpoints), `/dashboard/*` (26) and `/ai/*` (19) carry **zero** `requirePermission` or `allowRoles` calls. Any logged-in employee can `GET /api/v1/analytics/salary-bands`, `/analytics/hr-benchmarks` (median/P25/P75 salary), `/analytics/top-performers` (named staff + ratings) and `/dashboard/cfo` (full P&L, cash, AR/AP, runway). The nav gating in `menuCatalog.js` is careful and correct, but it is UI-only and is not a security control.

**6. There is a ninth, hidden, better HR analytics page.** `HRAnalyticsDashboard` is registered in `routes.jsx` with no nav entry, reachable only by typing the URL. It uses the canonical `useDashboardFilters`/`DashboardFilterBar` contract, loads its department list live from `/analytics/hr-filter-options`, and passes filter params to every endpoint — all three things the *visible* HR Dashboard fails to do. Four backend endpoints exist solely to serve it.

### What is genuinely good
- Revenue YTD now reconciles at **₹2,41,900** across CEO Intelligence, `metricsEngine`, `/dashboard/revenue` and CFO Dashboard. The `FY_START` fix held.
- `/ceo-intelligence/*` is the only router in the module with per-route `requirePermission` (11 of 11 routes).
- `/ai/prescriptive` is fully live, company-scoped and honest.
- `System Health`'s backend (`/system-health/db-tables`) is exemplary: live catalog introspection, exact re-count of zero-estimate tables, admin-gated.
- The empty-state copy across CEO Intelligence and Executive Dashboard is unusually good — it names the missing data and the module to go fix it.

### Headline counts

| | Count |
|---|---:|
| Pages audited | 8 visible + 1 hidden + 9 embedded panels |
| Distinct features inventoried | 214 |
| API endpoints consumed | 41 |
| Data elements classified LIVE / CALCULATED-LIVE | 138 (64%) |
| STATIC / MOCK / PLACEHOLDER | 34 (16%) |
| BROKEN (structurally cannot return a value) | 27 (13%) |
| EMPTY-EXPECTED (source table genuinely empty) | 15 (7%) |
| UNKNOWN after audit | **0** |
| Cross-page KPI contradictions proven against live DB | 5 |
| Dead buttons / drill-downs | 6 |
| Missing DB tables referenced in SQL | 2 |
| Endpoints with no permission check | 72 |

---

# SECTION 2 — Complete Page Inventory

Nav definition: `frontend/src/config/routes.jsx:590-602`.

| # | Nav label | Route key | Source file | LoC | Group | Roles with nav access |
|---|---|---|---|---:|---|---|
| 1 | CEO Intelligence | `CEOIntelligenceDashboard` | `features/analytics/pages/CEOIntelligenceDashboard.jsx` | 1348 | Executive | super_admin, admin |
| 2 | Executive Dashboard | `ExecutiveDashboard` | `pages/ExecutiveDashboard.jsx` | 642 | Executive | super_admin, admin, **manager** |
| 3 | Ops Command Center | `AdminDashboard` | `pages/AdminDashboard.jsx` | 797 | Executive | super_admin, admin |
| 4 | CFO Dashboard | `CFODashboard` | `features/finance/pages/CFODashboard.jsx` | 745 | Functional | super_admin, admin, **finance** |
| 5 | HR Dashboard | `HRDashboard` | `pages/HRDashboard.jsx` | 710 | Functional | super_admin, admin, **hr** |
| 6 | HR Benchmarking | `HRBenchmarkingDashboard` | `features/hr/pages/HRBenchmarkingDashboard.jsx` | 412 | Functional | super_admin, admin, **hr** |
| 7 | ERP Intelligence | `ERPIntelligence` | `features/ai/pages/ERPIntelligence.jsx` | 676 | Platform | super_admin, admin |
| 8 | System Health | `SystemHealth` | `features/admin/pages/SystemHealth.jsx` | 634 | Platform | super_admin, admin |

Role scoping is enforced in `config/menuCatalog.js` via `canHrAccessPage()` (`HR_SCOPED_PAGES`), `canFinanceAccessPage()` (`FINANCE_ANALYTICS_SCOPED_PAGES`) and `canManagerAccessPage()` (`MANAGER_ANALYTICS_SCOPED_PAGES`). The design is sound and well-commented.

### 2.1 Hidden / non-navigable routes in scope

| Route key | File | LoC | Status |
|---|---|---:|---|
| `HRAnalyticsDashboard` | `features/hr/pages/HRAnalyticsDashboard.jsx` | 429 | **ORPHANED** — in `routes.jsx:123`, in no `NAV_ITEMS` submenu. Reachable only by direct URL. Fully built, filter-correct, consumes 4 endpoints nothing else uses. |

### 2.2 Embedded panels (routable-by-file but excluded from the router)

`config/autoRouter.js`'s `NON_PAGE_SUFFIX = /(Panel|Widget|Heatmap|Trend)$/` correctly keeps these out of the sidebar, router and global search. All are imported directly by CEO Intelligence.

| Panel | LoC | Rendered as |
|---|---:|---|
| `RevenueForecastPanel.jsx` | 237 | CEO → Sales tab |
| `CustomerRiskPanel.jsx` | 180 | CEO → Customers → Risk Center |
| `VendorRiskPanel.jsx` | 159 | CEO → Vendors → Risk Center |
| `SupplyChainRiskPanel.jsx` | 207 | CEO → Vendors → Supply Chain Exposure |
| `ProjectProfitabilityPanel.jsx` | 233 | CEO → Projects tab |
| `CollectionRiskPanel.jsx` | 199 | CEO → Collections tab |
| `StrategicAlertsPanel.jsx` | 225 | CEO → War Room → Strategic Alerts |
| `AIInsightsPanel.jsx` | 211 | CEO → War Room → AI Insights |
| `AIInsightCard.jsx` (`features/ai/components`) | — | CEO → War Room → GPT Executive Brief |

### 2.3 Whole pages embedded inside another page

| Embedded page | LoC | Host |
|---|---:|---|
| `ManagerDashboard.jsx` | 939 | Ops Command Center → "Team Ops" tab (`hideHeader` prop) |

### 2.4 Dead code found in scope

| Artefact | Finding |
|---|---|
| `services/modules/analyticsService.js` | **Zero importers.** Dead service wrapping `/analytics/headcount`, `/attrition`, `/dept-workforce`, `/revenue`, `/ceo/kpis`. |
| `GET /analytics/revenue` | **No live caller** — only the dead service above references it. |
| `tests/suites/04-dashboard.spec.ts:139` and `14-dashboard-validation.spec.ts:59` | Both still target `/CeoDashboard`, deleted on 17 Aug 2026. Stale tests. |

---

# SECTION 3 — Feature Inventory

Legend for **Tag** (per §34): `UNIQUE` · `SHARED-VALID` · `DUPLICATE` · `PARTIAL-DUPLICATE` · `REDUNDANT` · `BROKEN` · `INCOMPLETE`
Legend for **Data** (per §6): `LIVE` · `CALC-LIVE` · `CACHED-LIVE` · `STATIC` · `MOCK` · `PLACEHOLDER` · `BROKEN`

## PAGE 1 — CEO Intelligence

### Route
`/CEOIntelligenceDashboard`

### Purpose
Strategic executive view across customer, vendor, project, collections, workforce and operational intelligence. The **only** executive dashboard since `CeoDashboard` was deleted on 17 Aug 2026 and merged in here.

### Primary users
super_admin, admin (CEO/MD in practice). **No frontend role gate on the component itself.**

### Tabs
10 top-level: Executive · Customers · Sales · Vendors · Projects · Collections · Workforce · Operations · War Room · Business Lines.
Plus sub-nav groups: Customers (Top 20 / Risk Center / Growth Center), Vendors (Top Vendors / Risk Center / Supply Chain Exposure), War Room (Strategic Alerts / AI Insights / GPT Executive Brief), Projects (5 views inside `ProjectProfitabilityPanel`).

### Persistent chrome

| Feature | Type | Data | API | Tag | Notes |
|---|---|---|---|---|---|
| Sticky header + Refresh | Action | — | re-runs all 20 calls | UNIQUE | Aborts in-flight via `AbortController` |
| "Synced HH:MM" | Label | CALC-LIVE | client clock | SHARED-VALID | |
| Red-alert chip to War Room | Drill-down | LIVE | `/ceo-intelligence/strategic-alerts` counts.red | UNIQUE | Works |
| KPI strip (6 tiles, persists on every tab) | KPI row | mixed | `/analytics/ceo/kpis` | PARTIAL-DUPLICATE | See below |

**KPI strip detail** — `/analytics/ceo/kpis` to `metricsEngine.js`

| Tile | Formula | Source table | Data | Tag | Defect |
|---|---|---|---|---|---|
| Revenue | `SUM(total_amount) WHERE status='paid' AND invoice_date>=FY_START` | `invoices` | LIVE | SHARED-VALID | **Not company-scoped** — `computeRevenueMetrics(_company_id)` ignores its argument |
| ARR | `SUM(contract_value) WHERE status='active'` | `amc_contracts` | EMPTY-EXPECTED | UNIQUE | Rupees 0 — table has 0 rows. Honest. |
| Headcount | `COUNT(*)` | `employees` | LIVE | SHARED-VALID | 34 |
| Attrition | `departures/headcount x 100` over 12m | `employees` | BROKEN | SHARED-VALID | Filters `status IN ('inactive','resigned','terminated','left')`; real statuses are `Active/Notice/Probation`. **Permanently 0.00%** |
| Open Pipeline | `SUM(expected_value)` open stages | `opportunities` | LIVE | SHARED-VALID | Rs 42,59,009 — **not company-scoped** |
| Projects On-Track | `COUNT(*) WHERE status='on-track'` | `projects` | **BROKEN** | UNIQUE | `projects_status_check` forbids `'on-track'`. **Permanently 0/3.** Also unscoped and ignores `deleted_at`. |

### TAB 1 — Executive Summary

| # | Feature | Type | Formula / source | API | Data | Tag |
|---|---|---|---|---|---|---|
| 1 | Revenue This Month | KPI | `SUM(total_amount)` paid, `invoice_date>=month_start` | `/ceo-intelligence/executive-summary` | LIVE | SHARED-VALID |
| 2 | Revenue YTD | KPI | same, `>=FY_START`, equals **Rs 2,41,900** | same | LIVE | DUPLICATE of KPI-strip Revenue |
| 3 | ARR | KPI | `amc_contracts` | `/analytics/ceo/kpis` | EMPTY-EXPECTED | DUPLICATE of strip |
| 4 | Outstanding Collections | KPI | `SUM WHERE status IN ('overdue','pending')`, equals **Rs 46,26,400** | exec-summary | LIVE | PARTIAL-DUPLICATE — excludes 3 `'Sent'` invoices worth Rs 5,60,000 that CFO AR includes |
| 5 | Pipeline Value | KPI | `opportunities.expected_value` | exec-summary | LIVE | DUPLICATE of strip |
| 6 | Avg Deal Size | KPI | `won_value / won_count` | `/analytics/sales` | LIVE | SHARED-VALID |
| 7 | Forecast Revenue | KPI | `pipeline x 0.35 + (revYTD/monthsElapsed) x 3` | exec-summary | **CALC-LIVE with STATIC coefficient** | INCOMPLETE — the 0.35 conversion rate is hardcoded, never measured |
| 8 | Cash Position | KPI | `revenueYTD - SUM(bills.balance WHERE pending/overdue)` | exec-summary | CALC-LIVE | UNIQUE — **this is not a cash position**; it is YTD revenue minus open payables. Contradicts CFO `receipts - payments` = Rs 0 |
| 9 | AMC Annual Revenue | KPI | `amc_contracts.contract_value` | exec-summary | EMPTY-EXPECTED | DUPLICATE of ARR (identical query) |
| 10 | Active Customers | KPI | `COUNT(DISTINCT customer_id)` | exec-summary | LIVE | UNIQUE — **2** |
| 11 | Business Health Signals (5 traffic lights) | Widget | rule-based | exec-summary | **2 of 5 STATIC** | INCOMPLETE — `supply_chain:'green'` and `profitability:'green'` are literals |
| 12 | Revenue Trend chart | Area chart | `/dashboard/revenue` by `created_at`, overlaid with exec-summary outstanding | 2 APIs | LIVE | PARTIAL-DUPLICATE of Executive Dashboard chart |
| 13 | Period toggle 6M/CY/FY | Filter | re-issues `/dashboard/revenue?period=` | — | — | UNIQUE — **works** |
| 14 | Year stepper | Filter | `?year=` | — | — | UNIQUE — works |
| 15 | YoY toggle | Filter | `?compare=true` returns `prevValues` | — | — | UNIQUE — works |
| 16 | Chart expand modal | Action | — | — | — | SHARED-VALID |
| 17 | Quick Stats x4 (Customers / Vendors / Active Proj / Delayed Proj) | KPI row | 3 endpoints | — | LIVE | DUPLICATE — Total Customers repeats #10, Active Projects repeats the strip |
| 18 | Expense Breakdown (donut + bar list) | Chart | `expense_claim_items` join `expense_categories`, current month | `/dashboard/expenses` | EMPTY-EXPECTED | UNIQUE — `expense_claim_items` has **0 rows**; also **not company-scoped** |
| 19 | Executive Alerts (rule engine) | Widget | `insightsEngine.js`, 8 rules | client-side | CALC-LIVE | PARTIAL-DUPLICATE of Executive Dashboard "AI Business Insights" (4 of 8 rules identical) |

### TAB 2 — Customer Intelligence

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 20-24 | Health cards x5 (Total / Excellent / Good / Watchlist / Critical) | KPI row | `/ceo-intelligence/customers` summary | CALC-LIVE | UNIQUE |
| 25 | Sub-nav x3 | Tabs | — | — | UNIQUE |
| 26 | Top 20 Customers table (6 cols) | Table | `parties` join `invoices`, `HAVING COUNT(i.id)>0` | LIVE | UNIQUE — **only 2 rows survive**; the label "Total Customers" really means "customers with invoices" (10 exist in `parties`) |
| 27 | Margin % column | Metric | `(SUM(budget_amount) - SUM(cs.total_cost))/budget` via `project_cost_summary` | **EMPTY** | BROKEN-BY-DATA — `project_cost_summary` has **0 rows**, so margin is always null and renders "—" |
| 28 | Health score (100-pt) | Calc | `pScore(25) + mScore(25) + tScore(25) + amcScore(25)` | CALC-LIVE | UNIQUE — **`tScore` is a constant 25**: it subtracts `critical_tickets`, computed as `priority='critical'`, but real priorities are `High/Medium/Low`. A quarter of the score is inert. `amcScore` is likewise pinned at 10. |
| 29 | Risk level badge | Calc | composite | CALC-LIVE | UNIQUE |
| 30 | Customer Health donut | Pie | health_distribution | CALC-LIVE | UNIQUE |
| 31 | Customer Risk Center panel | Panel | at_risk | CALC-LIVE | UNIQUE |
| 32 | Growth Center cards | Cards | YoY prev_revenue vs current | LIVE | UNIQUE |
| 33 | **Convert-to-Opportunity button** | Write action | `POST /ceo-intelligence/customers/:id/convert-upsell` | LIVE | UNIQUE — real transactional write, `requirePermission('crm','add')` |

### TAB 3 — Sales Command (RevenueForecastPanel)

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 34-40 | 7 KPIs: Pipeline / Forecast / Revenue YTD / Conversion / Avg Deal / Achievement / Gap-to-Target | KPI row | exec-summary + `/analytics/sales` + `/sales-command-center/summary` | LIVE (Forecast uses the static 0.35) | **DUPLICATE** — Pipeline, Forecast, Revenue YTD and Avg Deal all repeat Tab 1 verbatim |
| 41 | Sales Pipeline by Stage | Bar list | `/dashboard/sales` stages | LIVE | PARTIAL-DUPLICATE of Executive Dashboard pipeline card |
| 42 | Revenue vs Outstanding Trend | Composed chart | exec-summary revenue_trend | LIVE | **DUPLICATE** of Tab-1 Revenue Trend (same array, different chart type) |
| 43 | Target vs Achievement | Grouped bar | `/sales-command-center/team-targets` | EMPTY-EXPECTED | UNIQUE — `sales_targets` has 0 rows |
| 44 | Top Performers table | Table | `/salesperson-scorecard` | EMPTY-EXPECTED | UNIQUE |
| 45 | Bottom Performers table | Table | same array, `slice(-6).reverse()` | EMPTY-EXPECTED | **REDUNDANT** — with 6 or fewer salespeople this renders identical rows to #44 |

### TAB 4 — Vendor Intelligence

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 46-50 | 5 KPIs (Total / Preferred / Approved / Watchlist / Blocked) | KPI row | `/ceo-intelligence/vendors` | LIVE | UNIQUE |
| 51 | Top Vendors by Spend table (7 cols) | Table | `vendors` join `purchase_orders`, `vendor_scorecards`, `ncr_reports` | LIVE / partial | UNIQUE |
| 52 | Score column (0-5) | Metric | `vendor_scorecards` | EMPTY-EXPECTED | UNIQUE — 0 rows, so every vendor shows "—" |
| 53 | OTD % column | Metric | GRN vs PO promised date | LIVE | UNIQUE |
| 54 | SS / CV badges | Badge | `vendors.single_source`, `critical_vendor` | LIVE | UNIQUE |
| 55 | Vendor Health donut | Pie | distribution | CALC-LIVE | UNIQUE |
| 56 | Vendor Risk Center | Panel | high_risk | CALC-LIVE | UNIQUE |
| 57 | **Critical Components table (8 rows)** | Table | `CRITICAL_COMPONENTS` constant, `SupplyChainRiskPanel.jsx:20-29` | **MOCK** | **REDUNDANT** — 8 hardcoded parts (IGBT Modules, DSP Controllers, ...) with invented lead-times, vendor counts and impact prose |
| 58 | "Critical Components" exposure card | KPI | `CRITICAL_COMPONENTS.filter(risk==='Critical').length` | **STATIC** | REDUNDANT — always **2** |
| 59 | "Long Lead Vendors" card | KPI | live `critical_items>0` **or falls back to the mock array** | MOCK-fallback | INCOMPLETE |
| 60 | "Revenue at risk" figure | KPI | `SUM(po_value) x 1.5` | **CALC with invented multiplier** | INCOMPLETE |
| 61 | Single-Source Suppliers table | Table | `vendors.single_source` | LIVE | UNIQUE |
| 62 | Blocked Vendors card | KPI | summary.blocked_count | LIVE | UNIQUE |

### TAB 5 — Projects and P&L (ProjectProfitabilityPanel)

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 63-70 | 8 KPIs (Active / Delayed / OverBudget / LossMaking / ContractValue / Cost / Profit / Margin) | KPI rows | `/ceo-intelligence/projects` | **mostly Rs 0** | UNIQUE — `project_cost_summary` is empty, so `actual_cost=0` for all 3 projects, Profit equals Contract Value and Margin reads 100% |
| 71 | View switcher x5 (Overview / Profitable / Loss / OverBudget / Delayed) | Tabs | — | — | UNIQUE |
| 72 | Budget vs Actual chart | Bar | `budget_amount` vs `cs.total_cost` | HALF-EMPTY | INCOMPLETE — the actual bar is always 0 |
| 73 | Project Health donut | Pie | derived label | CALC-LIVE | UNIQUE — every project reads "On Track" purely because cost is 0 |
| 74 | 5 project tables | Tables | filtered arrays | LIVE | UNIQUE |
| 75 | Cost breakdown by `cost_type` | Chart | `project_cost_lines` | EMPTY | INCOMPLETE |
| — | `summary.active_projects` | Metric | `['active','in_progress'].includes(status)` | LIVE | `'in_progress'` is not a valid status — dead branch |

### TAB 6 — Collections and AMC (CollectionRiskPanel)

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 76-80 | Aging KPIs: Total plus 0-30 / 31-60 / 61-90 / 90+ | KPI row | `/ceo-intelligence/collections` | LIVE | UNIQUE — genuinely good |
| 81 | Aging distribution chart | Chart | bucket sums | LIVE | UNIQUE |
| 82 | Customer aging table plus risk badge | Table | `parties` join `invoices` on `due_date` | LIVE | UNIQUE |
| 83-88 | Service and AMC: Open Tickets / Escalations / Active AMC / Expiring 90d / AMC Revenue / Renewal Forecast | KPI row | `/ceo-intelligence/service-amc` | mixed | **DUPLICATE + BROKEN** |
| | Open Tickets equals **15** | | `NOT IN ('resolved','closed')` — lowercase | **BROKEN** | Contradicts the Operations tab's **13** |
| | Escalations equals **0** | | `priority='critical' OR status='escalated'` | **BROKEN** | Neither value exists in `support_tickets` |
| | AMC x4 | | `amc_contracts` | EMPTY-EXPECTED | DUPLICATE of the Tab-1 AMC KPI |
| 89 | Expiring contracts table | Table | `amc_contracts` join `sales_orders`, `parties` | EMPTY-EXPECTED | UNIQUE |

### TAB 7 — Workforce

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 90-95 | 6 KPIs: Headcount / Active / New Hires MTD / Departures / On Leave / Attrition | KPI row | `/analytics/headcount` + `/attrition` | LIVE except attrition | **DUPLICATE of HR Dashboard** |
| | On Leave | | `leave_applications` (4 rows) | EMPTY | The real leave table is `leave_requests` with **769 rows** |
| | Attrition | | see strip | BROKEN | Permanently 0.00% |
| 96 | Attrition Analysis card (rate plus 4 sub-metrics) | Widget | `/analytics/attrition` | BROKEN | DUPLICATE of #95 |
| | "Industry benchmark: 10-12%" | Label | hardcoded string | **STATIC** | Acceptable as a reference line |
| | At Risk | Metric | `atRisk: 0` literal, `metricsEngine.js:141` | **STATIC** | INCOMPLETE — hardcoded zero |
| 97 | Gender Diversity donut plus bars | Chart | `employees.gender` | LIVE but thin | **DUPLICATE of HR Benchmarking** — only 4 of 32 actives have gender recorded |
| 98 | Departmental Workforce bar list | Chart | `/analytics/dept-workforce` | LIVE | **DUPLICATE of HR Dashboard Department Strength** |

### TAB 8 — Operations Command

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 99-107 | 9 drill-through tiles | Tiles | `/dashboard/operations` | LIVE | **PARTIAL-DUPLICATE of Executive Dashboard** |
| | Open Tickets equals **13** | | `NOT IN ('Resolved','Closed')` — capitalised | **CONTRADICTS Tab 6's 15** | |
| | On Leave Today | | `leaves` table (1 row) | BROKEN-BY-SOURCE | wrong table |
| | Low Stock | | `current_stock <= reorder_level AND > 0` | LIVE (0) | |
| | Timesheets Pending | | `status='submitted'` lowercase | **BROKEN** | Only `'approved'` exists; ManagerDashboard queries `'Submitted'` |
| | Open Recruitments | | `job_openings.status='open'` | LIVE (0) | Both rows are `'closed'` |
| 108 | Tile navigation (9 targets) | Drill-down | `setPage()` | — | **All 9 targets resolve** — `InvoicesNew` and `FinanceDashboardNew` are valid curated route keys |
| 109 | System Alerts card | Widget | `/dashboard/alerts` | LIVE | **DUPLICATE of Executive Dashboard Smart Alerts** (same endpoint) |
| 110 | Travel Cost by Employee | Bar list | `/travel/analytics/by-employee` | LIVE | UNIQUE |
| 111 | Travel Cost by Project | Bar list | `/travel/analytics/by-project` | LIVE | UNIQUE |

### TAB 9 — War Room

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 112 | Sub-nav x3 | Tabs | — | — | UNIQUE |
| 113 | Strategic Alerts (6 detectors) | Panel | `/ceo-intelligence/strategic-alerts` | LIVE | UNIQUE |
| 114 | Severity filter (all / red / amber / unacked) | Filter | client-side | — | UNIQUE — works |
| 115 | **Acknowledge / Acknowledge All** | Action | **client-side `useState(Set)` only** | — | **INCOMPLETE** — acknowledgement is never persisted; the backend hardcodes `acknowledged:false` on every alert, so a refresh silently discards it |
| 116 | **AI Insights panel (25 bullets)** | Panel | `/ceo-intelligence/ai-insights` | **21 of 25 STATIC** | **REDUNDANT** — see Section 13 |
| 117 | Panel disclaimer text | Label | `AIInsightsPanel.jsx:205` | **FALSE STATEMENT** | Claims "no hardcoded or fabricated values" |
| 118 | GPT Executive Brief | Panel | `POST /ai/ceo-insights` to `narrateKpis()` | LIVE-or-fallback | UNIQUE — degrades to rule-based narration with no LLM key |

### TAB 10 — Business Lines

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 119 | 6 business-line cards x 8 metrics = 48 values | Cards | `/ceo-intelligence/manifest` | **BROKEN** | **REDUNDANT** — `BUSINESS_LINES = ['HVDC','STATCOM','SST','Automation','Service','AMC']` is a hardcoded literal list matched against `product_lines.display_name`, whose real values are `ACB`, `APFC - 440V`, `ASTRA - 415V`, `MV-VAJRA` and similar. **Zero overlap. 0 of 3 projects have `product_line_id` set; 0 of 8 opportunities have `product_line`.** All 48 values are permanently Rs 0 / 0%. |
| 120 | Forecast per line | Metric | `revenue + pipeline x 0.35` | STATIC coefficient | INCOMPLETE |

**Total CEO Intelligence features: 120**

---

## PAGE 2 — Executive Dashboard

### Route
`/ExecutiveDashboard`

### Purpose
As built: a personalised, cross-module executive landing page with a period filter and quick navigation. It has no purpose that CEO Intelligence's Executive tab does not already cover — see Section 8.

### Primary users
super_admin, admin, manager. **The only page in the module with a component-level `RequireRole`** (`['super_admin','admin','manager']`).

### Tabs
None — single scrolling cockpit under a "fit contract" CSS layout.

### Features

| # | Feature | Type | Formula / source | API | Data | Tag |
|---|---|---|---|---|---|---|
| 121 | Time-aware greeting | Label | `new Date().getHours()` + `localStorage.name` | — | CALC-LIVE | UNIQUE |
| 122 | Quick-nav chips x6 (Finance / Sales / HR / Projects / Approvals / Reports) | Nav | hardcoded target list | — | STATIC-BY-DESIGN | UNIQUE — all 6 targets resolve |
| 123 | **DashboardFilterBar** (period + custom range) | Filter | `useDashboardFilters({defaultPeriod:'fytd'})` | `?period=` to `/dashboard/revenue` and `/finance/reports/profit-loss` | — | UNIQUE — **canonical contract, works**. Only 2 of 8 pages use it. |
| 124 | Revenue YTD KPI | KPI | `SUM(total_amount) paid` by `created_at` in range | `/dashboard/revenue` | LIVE | **DUPLICATE** of CEO Intelligence Revenue YTD (same Rs 2,41,900, different query path) |
| 125 | Total Headcount KPI | KPI | `employees` active+probation | `/dashboard/workforce` | LIVE | **DUPLICATE** of CEO Workforce tab |
| 126 | Sales Pipeline KPI | KPI | sum of `/dashboard/sales` stage values | `/dashboard/sales` | LIVE | **DUPLICATE** (different source than CEO's `opportunities.expected_value` — two pipeline definitions) |
| 127 | Active Projects KPI | KPI | `projects` not completed/cancelled | `/dashboard/operations` | LIVE | **DUPLICATE** of CEO Ops tile |
| 128 | Net Profit YTD KPI | KPI | `/finance/reports/profit-loss` | finance | LIVE | PARTIAL-DUPLICATE of CFO Net Profit (**different formula** — CFO applies a 0.78 multiplier, this does not) |
| 129 | 403-aware Net Profit hiding | Behaviour | drops the tile on a permission denial | — | — | UNIQUE — good defensive UX |
| 130 | Attrition Rate KPI | KPI | `/analytics/attrition` rate, else `wf.attrition/wf.total` | `/analytics/attrition` | BROKEN | **DUPLICATE** of CEO strip — same permanently-0% bug |
| 131 | Open Alerts KPI | KPI | `alerts.length` | `/dashboard/alerts` | LIVE | **DUPLICATE** of CEO Ops System Alerts |
| 132 | KPI click-through (6 of 7 tiles) | Drill-down | `setPage()` | — | — | UNIQUE — all targets resolve |
| 133 | **AI Business Insights (max 4)** | Widget | client rule engine, `generateInsights()` in-file | — | CALC-LIVE | **PARTIAL-DUPLICATE** of CEO Executive Alerts — a *second, separate* rule engine with overlapping rules |
| 134 | Conversion-rate fallback `22` | Constant | `conversionRate ?? 22` labelled "22% (est.)" | — | **STATIC** | INCOMPLETE — disclosed, but still a magic number |
| 135 | No-data guidance insights | Widget | fires when `hasRevenueData` / `hasHeadcountData` false | — | CALC-LIVE | UNIQUE — best empty-state handling in the module |
| 136 | Revenue Trend area chart + expand | Chart | `/dashboard/revenue` | LIVE | **DUPLICATE** of CEO Tab-1 chart |
| 137 | Sales Pipeline stage bars + total | Chart | `/dashboard/sales` | LIVE | **DUPLICATE** of CEO Sales-tab funnel |
| 138 | Smart Alerts card + expand | Widget | `/dashboard/alerts`, `type!=='info'` filtered out | LIVE | **DUPLICATE** of CEO Ops System Alerts (identical endpoint) |
| 139 | Workforce by Dept horizontal bars | Chart | `/dashboard/workforce` byDepartment | LIVE | **DUPLICATE** of CEO Departmental Workforce and HR Dashboard Dept Strength (three copies) |
| 140 | Workforce stat row (Total / Active / New Hires) | Stats | same | LIVE | DUPLICATE |
| 141 | Headcount Trend (hires vs attrition, 12m) | Chart | `/dashboard/headcount-trend` | LIVE | PARTIAL-DUPLICATE of HR Dashboard Hiring Trend |
| 142 | Top Customers ranked bars | Chart | `/dashboard/top-customers` | LIVE | **DUPLICATE** of CEO Top-20 Customers table |
| 143 | Top Vendors ranked bars | Chart | `/dashboard/top-vendors` | LIVE | **DUPLICATE** of CEO Top Vendors table |
| 144 | "View all" links x5 | Drill-down | `setPage()` | — | — | UNIQUE — all resolve |
| 145 | Refresh + "Updated HH:MM" | Action | `AbortController` guarded | — | — | SHARED-VALID |

**Total Executive Dashboard features: 25. Of these, 13 are exact or near duplicates of CEO Intelligence.**

---

## PAGE 3 — Ops Command Center

### Route
`/AdminDashboard`

### Purpose
**Mislabelled.** The nav calls it "Ops Command Center" and the page heading calls it "Operations Dashboard", but the page is a **user-administration console plus an embedded manager workspace**. It contains no operational analytics.

### Primary users
super_admin, admin. **No `RequireRole` on the component.** Tab visibility keys off `useAuth().role` — a single-role string check, which conflicts with the many-to-many `user_roles` convention used elsewhere in the codebase.

### Tabs
2: **Team Ops** (renders the whole 939-line `ManagerDashboard` with `hideHeader`) and **Admin** (admin/super_admin only).

### Features — Admin tab

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 146 | Total Users KPI | KPI | `/admin/users` length | LIVE | UNIQUE |
| 147 | Active Users KPI | KPI | client filter | CALC-LIVE | UNIQUE |
| 148 | Inactive Users KPI | KPI | client filter | CALC-LIVE | UNIQUE |
| 149 | Admins KPI | KPI | client filter on `u.role` | CALC-LIVE | UNIQUE — single-role field, will under-count multi-role admins |
| 150 | **System Health KPI = "Healthy"** | KPI | `value="Healthy"` literal, `AdminDashboard.jsx:422` | **STATIC** | **REDUNDANT** — never checks anything. Contradicts the real System Health page. |
| 151 | **Storage KPI = "—"** | KPI | `value="—"`, sub "Usage not available" | **PLACEHOLDER** | INCOMPLETE |
| 152 | User Management table (7 cols) | Table | `/admin/users` | LIVE | UNIQUE |
| 153 | User search | Filter | client-side | — | UNIQUE — works |
| 154 | Activate / deactivate toggle | Write action | `/admin/users/:id` | LIVE | UNIQUE |
| 155 | Reset-password drawer + strength meter | Write action | `/admin/users/:id/reset-password` | LIVE | UNIQUE — uses `crypto.getRandomValues`, not `Math.random` |
| 156 | Add User drawer + per-module permission grid | Write action | `POST /admin/users` | LIVE | UNIQUE |
| 157 | **Hardcoded `DEPARTMENTS` list (11)** | Dropdown | in-file constant | **STATIC** | INCOMPLETE — does not match the 14 real `employees.department` values |
| 158 | **Hardcoded `PERM_MODULES` (7)** | Grid | in-file constant | **STATIC** | INCOMPLETE — the app has ~40 modules |
| 159 | CSV bulk import | Write action | `POST /admin/users` per row | LIVE | UNIQUE |
| 160 | Quick Actions x5 | Nav | `setPage()` | — | UNIQUE — all resolve |
| 161 | **System Health card: "All Systems Operational"** | Widget | hardcoded copy | **STATIC** | **REDUNDANT** — asserts health without a check; only the click-through to `SystemHealth` is real |
| 162 | Module Activity chart + expand | Chart | `/admin/module-activity` | LIVE | UNIQUE |
| 163 | Audit trail feed | Feed | `/audit/?limit=20` | LIVE | UNIQUE |
| 164 | Toast notifications | UX | — | — | SHARED-VALID |

### Features — Team Ops tab (ManagerDashboard, embedded)

| # | Feature | Type | Source | Tag |
|---|---|---|---|---|
| 165 | Team roster + today's attendance status | Table | `/employees`, `/attendance/today` | UNIQUE (belongs to Manager workspace) |
| 166 | Approval queue x3 (Leave / Timesheet / Travel) with inline approve/reject | Write actions | `/leaves/team`, `/timesheets`, `/travel/requests` | **REDUNDANT here** — duplicates the Approvals module |
| 167 | Department Budget vs Actual | Chart | `/manager/budget` | UNIQUE |
| 168 | Team capacity | Widget | `/manager/team-capacity` | UNIQUE |
| 169 | Targets | Widget | `/manager/targets` | UNIQUE |
| 170 | Post announcement | Write action | `POST /announcements` | REDUNDANT here |
| 171 | Schedule meeting | Write action | `POST /meetings` | REDUNDANT here |
| 172 | On-leave-today list | Widget | `/attendance/on-leave-today` | PARTIAL-DUPLICATE of CEO Ops "On Leave Today" tile |

**Total Ops Command Center features: 27. Zero are analytics.**

---

## PAGE 4 — CFO Dashboard

### Route
`/CFODashboard`

### Purpose
Financial command view: P&L, cash flow, ratios, working capital, forecast.

### Primary users
super_admin, admin, finance. **No `RequireRole`.**

### Tabs
None. Filters are an FY selector (`FYContext`) plus a YTD/Q1/Q2/Q3/Q4 period strip — a *third* filter idiom in this module.

### Features

| # | Feature | Type | Formula / source | Data | Tag |
|---|---|---|---|---|---|
| 173 | FY selector | Filter | `FYContext`, sends `?fyStart=` | — | UNIQUE — works |
| 174 | Period strip YTD/Q1-Q4 | Filter | sends `?period=`, re-queries | — | UNIQUE — works |
| 175 | Revenue KPI + sparkline | KPI | `SUM(total_amount) WHERE LOWER(status)='paid'` by **`created_at`** | LIVE | PARTIAL-DUPLICATE of CEO Revenue YTD — CEO windows on `invoice_date`; identical today, will diverge on any back-dated invoice |
| 176 | **Net Profit KPI** | KPI | `grossProfit > 0 ? grossProfit * 0.78 : grossProfit` | **CALC with FABRICATED coefficient** | **REDUNDANT** — the 22% "estimated interest + tax" is a hardcoded guess presented as a financial result |
| 177 | **EBITDA KPI** | KPI | `netProfit + opex * 0.05` | **CALC with FABRICATED coefficient** | **REDUNDANT** — the 5% D&A estimate is hardcoded |
| 178 | Cash and Equivalents KPI | KPI | `SUM(receipts.amount) - SUM(payments.amount)`, all-time | EMPTY-EXPECTED | UNIQUE — both tables are empty, so **Rs 0**. Also all-time while the label implies the selected period. |
| 179 | Accounts Receivable KPI | KPI | `SUM WHERE status NOT IN ('paid','cancelled')`, **Rs 51,86,400** | LIVE | **CONTRADICTS** CEO Outstanding Collections (Rs 46,26,400); the Rs 5,60,000 delta is 3 `'Sent'` invoices |
| 180 | DSO | Metric | `ar / (revenue / daysInPeriod)` | CALC-LIVE | UNIQUE |
| 181 | Monthly Burn + Runway | KPI | `opex / monthsInPeriod`; runway null when cash <= 0 | CALC-LIVE | UNIQUE — correct null handling |
| 182 | **Revenue vs Target chart** | Chart | `revenue` LIVE; **`target = revenue * 1.1`**; **`profit = revenue * 0.28`** | **MOCK** | **REDUNDANT** — 2 of the 3 series on the CFO's headline chart are invented from the third |
| 183 | Target / Gap chips | KPI | `revenue * 1.1`, `revenue * 0.1` | **MOCK** | REDUNDANT — labelled "(+10%)" but presented alongside real figures |
| 184 | P&L Bridge waterfall | Chart | Revenue / OpEx / Gross / EBITDA / Net | CALC (2 of 5 fabricated) | PARTIAL-DUPLICATE of the ratio grid |
| 185 | Margin rows x3 | Stats | `pct(x, revenue)` | CALC | DUPLICATE of #190-192 |
| 186 | Cash Flow Breakdown chart | Chart | paid invoices minus (approved claims + paid bills), 6m generate_series | LIVE | UNIQUE — correct month gap-filling |
| 187 | Inflow / Outflow / Net chips | Stats | client reduce | CALC-LIVE | UNIQUE |
| 188 | **Revenue Forecast (3 scenarios)** | Chart | 3-month moving average; growth clamped to -10%..+20%, default **0.04**; optimistic `x1.2`, conservative `x0.8` | CALC-LIVE with STATIC bands | INCOMPLETE — disclosed as "trend-based", but the scenario multipliers are arbitrary |
| 189-201 | **Key Financial Ratios grid (12 tiles)**, subtitled "Computed from live data" | Grid | mixed | **5 of 12 PLACEHOLDER** | **INCOMPLETE** |
| | Current, Quick, Gross Margin, Net Margin, EBITDA Margin, A/R Days, A/P Days | | live | CALC-LIVE | Net/EBITDA margins inherit the fabricated coefficients |
| | **Debt/Equity, ROE, ROA, Inventory Turns, Interest Coverage** | | `value:'—'`, **`status:'good'`** | **PLACEHOLDER** | Render as green "good" check-marks with no data behind them |
| 202 | **Department Expenses card** | Chart | `[{Engineering,0.36},{Sales,0.30},{Operations,0.23},{Marketing,0.18},{HR,0.14}]` x `opex` | **MOCK** | **REDUNDANT** — hardcoded departments that do not match the DB, and the shares **sum to 1.21**, so the "split" exceeds total OpEx by 21% |
| 203 | Working Capital gauges x3 | Gauges | collections / cash-ratio / liquidity % | CALC-LIVE | UNIQUE |
| 204 | Working capital stats x3 | Stats | AR-AP, AR/AP, quick ratio | CALC-LIVE | DUPLICATE of the ratio grid |
| 205 | Expense Structure donut + legend | Chart | `expense_claim_items` for period | EMPTY-EXPECTED | **DUPLICATE of CEO Expense Breakdown** (same table, same shape) |
| 206 | Executive Alerts (5 rules) | Widget | overdue invoices / pending claims / overdue tasks / pending leaves / low stock | LIVE-ish | PARTIAL-DUPLICATE of CEO System Alerts |
| | Pending-leaves alert | | queries the `leaves` table (1 row) | **BROKEN-BY-SOURCE** | Real pending leave count is **159** in `leave_requests` |
| 207 | **Alert action buttons** | Drill-down | `ALERT_ACTION_PAGE[a.action]` | **BROKEN** | **Every alert button is a no-op.** Backend emits actions `Follow Up` / `Review` / `View`; the frontend map keys are `View Invoices` / `View Bills` / `Reconcile` / `Process Payments` / `Review Budget` / `View Reports` / `Manage Expenses`. **Zero overlap** — the lookup is always `undefined` and the guard silently swallows the click. |
| 208 | 3 expand modals | Action | — | — | SHARED-VALID |

**Total CFO Dashboard features: 36. Six are fabricated, five are placeholders, one drill-down class is entirely dead.**

---

## PAGE 5 — HR Dashboard

### Route
`/HRDashboard`

### Purpose
People operations landing page (Overview) plus a workforce analytics deck (Analytics).

### Primary users
super_admin, admin, hr. **No `RequireRole`;** `canManage` uses a single-role string check.

### Tabs
2: **Overview**, **Analytics** (lazy-loaded on first switch).

### Features — Overview tab

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 209-213 | Summary stats (Total / Active / Probation / Left / Avg Tenure) | KPI row | `/employees/analytics` | LIVE | PARTIAL-DUPLICATE of CEO Workforce tab |
| 214 | **Overview attrition rate** | KPI | **frontend** `Math.round(s.left / s.total * 100)` | CALC-LIVE | **DUPLICATE and CONTRADICTORY** — the Analytics tab of the *same page* uses the backend `/analytics/attrition` rate, a different formula |
| 215 | HR Alerts (probation ending, work anniversaries) | Widget | client scan of `/employees` | CALC-LIVE | UNIQUE |
| 216 | Pending leave approvals + inline approve/reject | Write actions | `/leaves?status=pending`, `POST /approvals/:id/*` | LIVE | REDUNDANT — duplicates Approvals module and Leave Approvals |
| 217 | HR insights (4 rules) | Widget | in-file `generateHRInsights()` | CALC-LIVE | **PARTIAL-DUPLICATE** — a *third* rule engine, overlapping `insightsEngine.js` and `/analytics/insights/hr` |
| 218 | Hires vs Exits trend | Chart | `/employees/analytics` | LIVE | DUPLICATE of Analytics-tab Hiring Trend |
| 219 | Department breakdown bars | Chart | `/employees/analytics` | LIVE | DUPLICATE of Analytics-tab Department Strength |
| 220 | Gender pie | Chart | `/employees/analytics` | LIVE | DUPLICATE of Analytics-tab gender chart and CEO gender chart |
| 221 | Onboarding widget | Widget | `/analytics/onboarding` | LIVE | UNIQUE |
| 222 | Compliance widget | Widget | `/analytics/compliance-alerts` | LIVE | UNIQUE |
| 223 | Org summary widget | Widget | client | CALC-LIVE | UNIQUE |
| 224 | Quick actions x6 | Nav | `setPage()` | — | UNIQUE — all resolve |
| 225 | Add Employee button (`canManage`) | Nav | — | — | UNIQUE |

### Features — Analytics tab

| # | Feature | Type | API | Data | Tag |
|---|---|---|---|---|---|
| 226 | **Department filter dropdown** | Filter | none | **BROKEN** | **The filter is decorative.** `hrAnalyticsApi.js` sends **no query params on any of its 17 calls**. The dropdown only filters the already-loaded `deptWorkforce` array in memory, affecting exactly **1 of 18 widgets**. |
| 227 | **Hardcoded `DEPTS` list** | Dropdown | in-file constant | **STATIC** | **BROKEN** — offers `Operations`, `Marketing`, `Support` (**0 employees each**) and omits `Human Resources` (4), `Management` (3), `Service` (3), `Production` (2), `Procurement` (2), `Quality` (2), `IT`, `Stores`, `General`, `Projects`. Selecting a phantom department yields an empty chart. |
| 228 | *(missing)* Period filter | Filter | — | — | **INCOMPLETE** — the backend `hrFrags()` fully supports `?period=/from=/to=`, unreachable from this page |
| 229 | Headcount card | KPI | `/analytics/headcount` | LIVE | DUPLICATE of CEO Workforce |
| 230 | Attrition Rate card | KPI | `/analytics/attrition` | **BROKEN** | DUPLICATE + permanently 0.00% |
| 231 | **Offer Acceptance card = 66.7%** | KPI | `/analytics/offer-acceptance` to `recruitmentRepository` to `offer_letters` | LIVE | **CONTRADICTS HR Benchmarking's 0%** |
| 232 | Absenteeism card | KPI | `attendance` last 30d | LIVE | UNIQUE |
| 233 | Time to Hire card | KPI | `/analytics/time-to-hire` | LIVE | PARTIAL-DUPLICATE of HR Benchmarking Avg Days to Hire |
| 234 | Satisfaction card | KPI | `/analytics/satisfaction` | LIVE | PARTIAL-DUPLICATE of HR Benchmarking Engagement Score |
| 235 | Headcount Trend 12m | Chart | `/analytics/headcount-trend` | LIVE | UNIQUE |
| 236 | Attrition Trend | Chart | `/analytics/attrition-trend` | **BROKEN** | Same status-casing bug — always empty |
| 237 | Hiring Trend | Chart | `/analytics/hiring-trend` | LIVE (hires only) | UNIQUE — the departures series is always 0 |
| 238 | **Salary Band chart** | Chart | `/analytics/salary-bands` | LIVE but thin | UNIQUE — **only 5 of 34 employees have `basic_salary` populated**, undisclosed |
| 239 | Gender Distribution | Chart | `/analytics/gender` | LIVE | **DUPLICATE** of CEO gender chart and HR Benchmarking gender bar |
| 240 | **Department Strength chart with "Target" bar** | Chart | `/analytics/dept-workforce` | **target is FABRICATED** | **REDUNDANT** — `metricsEngine.js` sets `target: Math.ceil(headcount * 1.1)`, so every department renders at exactly 91% fill. It is not a headcount plan. |
| 241 | Productivity Trend | Chart | `tasks` done-rate, 6m | LIVE (3 rows) | UNIQUE |
| 242 | Top Performers table + drill to profile | Table | `performance_reviews` | EMPTY-EXPECTED | UNIQUE — 0 rows |
| 243 | Insights panel (API + client rules merged) | Widget | `/analytics/insights/hr` + `insightsEngine` | CALC-LIVE | PARTIAL-DUPLICATE |
| 244 | Refresh | Action | per-tab | — | SHARED-VALID |

**Total HR Dashboard features: 36. The department filter — its only filter — does not filter.**

---

## PAGE 6 — HR Benchmarking

### Route
`/HRBenchmarkingDashboard`

### Purpose
Compare live HR metrics against industry benchmark targets. Genuinely distinct from HR Dashboard *in intent*; heavily overlapping *in metric set*.

### Primary users
super_admin, admin, hr. **No `RequireRole`.**

### Tabs
None — a rail-plus-4-bands single-viewport layout. Backed by a **single** endpoint, `/analytics/hr-benchmarks`.

### Features

| # | Feature | Type | Backend index / source | Data | Tag |
|---|---|---|---|---|---|
| 245 | **DashboardFilterBar** | Filter | `useDashboardFilters({defaultPeriod:'last12m'})`, params forwarded | — | UNIQUE — **canonical contract, works** |
| 246 | Refresh + StrictMode-safe abort | Action | handles `CanceledError`/`ERR_CANCELED` | — | UNIQUE — good |
| 247 | Avg Days to Hire (bm 30) | Metric | [0] `employees` join `candidates` on email, `stage IN ('joined','accepted')` | LIVE-if-matched | PARTIAL-DUPLICATE of HR Dashboard Time-to-Hire |
| 248 | Time to Fill (bm 45) | Metric | [12] `job_openings` filled/closed | LIVE | UNIQUE |
| 249 | **Offer Acceptance Rate (bm 70) = 0%** | Metric | [1] **`candidates.status IN ('offered','accepted','joined','declined')`** | **BROKEN** | **CONTRADICTS HR Dashboard's 66.7%.** All 3 candidate rows have `status='active'`. The correct source, `offer_letters` (3 offered / 2 accepted), is what `/analytics/offer-acceptance` already uses — and a comment at `analytics.routes.js:259` explicitly documents that `candidates.status` is a column nothing writes. This endpoint re-introduced the bug that was fixed there. |
| 250 | **Offer Exception Rate (bm 15)** | Metric | [1] `declined / offered` | **BROKEN + DUPLICATE** | Identical formula to `offerDeclineRate`, relabelled. Two names, one number, both 0. |
| 251 | **Cost per Hire** | Metric | [13] `SELECT ... FROM recruitment_costs` | **BROKEN** | **The `recruitment_costs` table does not exist.** `sq1` swallows the error and returns null, so the card silently shows "N/A" forever. |
| 252 | **Revenue per Employee** | Metric | [2] `SUM(total_amount) FROM invoices` — **no status filter** | **CALC-LIVE but INCONSISTENT** | Returns **Rs 1,16,18,500** for the period versus the **Rs 2,41,900** every other page calls revenue — a **48x** difference, because this is the only revenue query in the module that counts unpaid invoices. Revenue/Employee therefore reads ~Rs 3.6 L instead of ~Rs 7.5 K. |
| 253 | **Training Effectiveness (bm 70)** | Metric | [3] `SELECT ... FROM assessment_submissions` | **BROKEN** | **The `assessment_submissions` table does not exist.** Card shows 0% "Below target" permanently; sub-label reads "0 assessments, pass 0%". |
| 254 | **Employee Turnover Rate (bm 10) = 0.0%** | Metric | [5] `status IN ('inactive','terminated','left','resigned','ex-employee')` | **BROKEN** | No employee ever holds any of those statuses (real: `Active`/`Notice`/`Probation`). Permanently 0.0%, permanently "On target". |
| 255 | Engagement Score (bm 75) | Metric | [6] `performance_reviews` avg rating | EMPTY-EXPECTED | 0 rows |
| 256 | Acquisition Rate (bm 15) | Metric | [7] new hires / active | LIVE | UNIQUE |
| 257 | **Compa-Ratio (bm 1.0)** | Metric | [8] `avgSalary / medianSalary` = 56,250/52,500 = **1.07** | **MIS-DEFINED** | A compa-ratio is *actual salary / salary-band midpoint*. This is a mean-to-median ratio, which sits near 1.0 for any distribution — the benchmark can never be informative. Computed from **5 of 32** employees. |
| 258 | Median Salary + P25/P75 | Metric | [8] `PERCENTILE_CONT` | LIVE but thin | UNIQUE — **5 of 32** employees have `basic_salary > 0`; the 84% coverage gap is not disclosed |
| 259 | Benefits Utilization (bm 80) | Metric | [11] distinct `leave_applications.employee_id` / active | EMPTY-EXPECTED | UNIQUE — reads `leave_applications` (4 rows), not `leave_requests` (769) |
| 260 | **Gender Diversity Female (bm 40) = 6.3%** | Metric | [9] `female / COUNT(*) active` = 2/32 | LIVE but MISLEADING | **DUPLICATE** of CEO and HR Dashboard gender charts. Only **4 of 32** actives have `gender` recorded; the denominator counts all 32, so the metric is 87.5% driven by nulls and will always read "Below target". |
| 261 | Women in Leadership (bm 30) | Metric | [10] designation LIKE manager/director/head/vp/chief/president/lead | LIVE | UNIQUE — good pattern |
| 262 | Appraisal Ratings distribution bar | Chart | [4] `performance_reviews` banded | EMPTY-EXPECTED | UNIQUE |
| 263 | Overall Gender split bar | Chart | [9] | LIVE | **DUPLICATE of #260** — same two numbers, second rendering |
| 264 | Leadership Gender split bar | Chart | [10] | LIVE | DUPLICATE of #261 |
| 265 | Benchmark reference footer | Label | 12 hardcoded thresholds | **STATIC-BY-DESIGN** | SHARED-VALID — legitimate as reference targets, but not configurable and not sourced |
| 266 | On-target / below-target status dot | Indicator | client compare | CALC-LIVE | UNIQUE |
| 267 | `period_label` echo | Label | backend echoes the resolved window | LIVE | UNIQUE — good practice |

**Total HR Benchmarking features: 23. Five of the fifteen metrics are structurally incapable of returning a value.**

---

## PAGE 7 — ERP Intelligence

### Route
`/ERPIntelligence`

### Purpose
Natural-language querying, predictive forecasting and prescriptive recommendations across modules.

### Primary users
super_admin, admin. **No `RequireRole`.**

### Tabs
4: **LLM Agent** · **Predictive** · **Prescriptive** · **AI Chat**.

### Features

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 268 | Suggested-query tabs x4 (Revenue / HR / Inventory / Finance) with 3 prompts each | UX | in-file constant | STATIC-BY-DESIGN | UNIQUE |
| 269 | **LLM Agent query box** | Search | `POST /ai/query` | mixed | **INCOMPLETE** — the "LLM" path needs `OPENAI_API_KEY`; **the configured value is not an OpenAI key**, so it falls through to `queryERPIntelligence()` |
| 270 | `queryERPIntelligence()` | Logic | **2 regex patterns only**: `why is (x) payroll (y) higher` and `predict cash flow / cashflow / forecast` | CALC-LIVE within its 2 patterns | **INCOMPLETE** — every other question returns the fallback string, which contains a typo ("Engineeing payroll") |
| 271 | Query history (last 10) + replay | UX | client state | — | UNIQUE |
| 272 | Forecast horizon pills 7/30/90/180d | Filter | `?days=` to `/ai/cashflow/forecast` | — | UNIQUE — **works** (a fourth filter idiom) |
| 273 | Export CSV (cash-flow forecast) | Export | client Blob | LIVE | UNIQUE — **the only working export in the entire module** |
| 274 | Inflow / Outflow / Net summary cards | KPI row | `/ai/cashflow/forecast` | LIVE | UNIQUE |
| 275 | Cash Flow Forecast area chart | Chart | open invoices/bills grouped by `due_date` | LIVE | **PARTIAL-DUPLICATE of CFO Cash Flow** — and note it is not a forecast model, it is a due-date roll-up |
| | Casing latent bug | | `status NOT IN ('Paid','Cancelled')` vs real lowercase `'paid'` | — | Currently harmless (paid rows carry `balance = 0`) but wrong |
| 276 | **Anomaly chips row** | Widget | `/ai/anomalies` (5 detectors) | **2 of 5 BROKEN** | INCOMPLETE |
| | Invoice Amount Outlier | | `SELECT ... client_name FROM invoices` | **BROKEN** | **`invoices.client_name` does not exist** — query throws, `catch(_){}` swallows it, detector never fires |
| | Low Attendance | | `WHERE e.status='active'` | **BROKEN** | Real value is `'Active'` — matches 0 rows |
| | PO Price Variance / TDS Mismatch / PQ Test Failure | | live | EMPTY-EXPECTED | source tables empty |
| | *(all 5)* | | | | **None are company-scoped** |
| 277 | **Attrition Risk by Department** | Chart | `/ai/predict/attrition` | **BROKEN** | Filters `status IN ('resigned','terminated')` — permanently all-zero bars |
| 278 | Sales Forecast | Chart | `/ai/predict/sales`, weekly `sales_orders` | LIVE (4 rows) | UNIQUE — labelled "forecast" but plots history only |
| 279 | Inventory Demand Forecast | Chart | `/ai/predict/inventory`, `stock_ledger` velocity + ROP | LIVE | UNIQUE — good model, mirrors the EOQ planner |
| 280 | Lead Priority Queue | List | `/ai/predict/lead-priority` | LIVE | UNIQUE |
| 281 | **Prescriptive recommendations** | Cards | `/ai/prescriptive` — stockouts, overdue AR, revenue decline, and more | LIVE | UNIQUE — **fully live and company-scoped; the best AI feature in the module** |
| 282 | AI Chat (multi-turn, 20-msg history) | Chat | `POST /ai/llm-chat` to OpenAI `gpt-4o-mini` | **UNAVAILABLE** | INCOMPLETE — returns 503 "AI service is not configured" without a valid key |
| 283 | Role-aware starter chips | UX | `ROLE_CHIPS` constant | STATIC-BY-DESIGN | UNIQUE |
| 284 | Rate limit 20/day + remaining counter | Control | in-memory `Map` | LIVE | UNIQUE — **not persisted; resets on every server restart** |
| 285 | Thumbs up/down feedback | Action | `POST /ai/feedback` | LIVE | UNIQUE |
| 286 | Clear chat | Action | client | — | SHARED-VALID |
| 287 | **Empty-state CTA "Configure Integrations"** | Nav | to `IntegrationsHub` | — | **MISLEADING** — every chart on this tab reads the local Postgres database; no integration exists that would populate them |

**Total ERP Intelligence features: 20.**

---

## PAGE 8 — System Health

### Route
`/SystemHealth`

### Purpose
As built: **database table coverage and record-count introspection**. It is not a system-health monitor — it reports no uptime, CPU, memory, request latency percentiles, error rates, queue depth or service status.

### Primary users
admin, super_admin. Route-level `allowRoles('admin','super_admin')` on the backend. **No `RequireRole` on the component** — a non-admin who reaches the URL sees a single "Auth" diagnostic row rather than a proper denial.

### Tabs
None.

### Features

| # | Feature | Type | Source | Data | Tag |
|---|---|---|---|---|---|
| 288 | **"Run Connection Test" button** | Action | `testAllConnections()` | — | UNIQUE — **the page is blank until clicked**; no auto-load |
| 289 | Progress bar 0-100% | UX | callback | — | UNIQUE |
| 290 | 6 KPI cards (Total Tables / Live / Auth / Empty / Errors / Total Records) | KPI row | `/system-health/db-tables` | LIVE | UNIQUE |
| 291 | Connectivity Health % | Gauge | `healthy / total` | CALC-LIVE | UNIQUE |
| 292 | Data Coverage % | Gauge | `withRecords / live200` | CALC-LIVE | UNIQUE |
| 293 | Issues panel (errors + empties, collapsible) | Widget | derived tiers | CALC-LIVE | UNIQUE |
| 294 | Grouped table list, 44 groups, `GROUP_ORDER` | Table | regex prefix rules in `systemHealth.routes.js` | LIVE | UNIQUE |
| 295 | Per-row status pill / HTTP badge / latency pill / record pill | Badges | derived | CALC-LIVE | UNIQUE |
| 296 | Group collapse toggles | UX | client | — | UNIQUE |
| 297 | Exact re-count of zero-estimate tables | Logic | batched `UNION ALL` counts, 100 at a time | LIVE | UNIQUE — **excellent**; avoids the classic stale-`reltuples` false-empty |
| 298 | Timeout + unreachable-backend diagnostics | Error state | 20s `AbortSignal.timeout` | — | UNIQUE — best error handling in the module |
| 299 | **"{total \|\| '200+'} tables"** | Label | hardcoded fallback string | **STATIC** | INCOMPLETE — trivial, but the real count is **551** |
| 300 | *(missing)* Auto-refresh / scheduling | — | — | — | INCOMPLETE |
| 301 | *(missing)* Export | — | — | — | INCOMPLETE |

**Total System Health features: 14.**

---

## PAGE 9 (HIDDEN) — HR Analytics Dashboard

### Route
`/HRAnalyticsDashboard` — registered at `routes.jsx:123`, **absent from every `NAV_ITEMS` submenu**. Reachable only by typing the URL.

| # | Feature | Type | Source | Tag |
|---|---|---|---|---|
| 302 | **DashboardFilterBar (canonical)** | Filter | `useDashboardFilters` | UNIQUE — the correct contract, which the *visible* HR Dashboard lacks |
| 303 | **Live department options** | Filter | `GET /analytics/hr-filter-options` | UNIQUE — the correct source, which the visible HR Dashboard hardcodes |
| 304 | **Params forwarded to every call** (`opts`) | Behaviour | 8 endpoints | UNIQUE — the thing the visible HR Dashboard fails to do |
| 305 | HR KPI deck | KPI row | `GET /analytics/hr-kpis` | **Endpoint has no other caller** |
| 306 | Department distribution | Chart | `GET /analytics/department-distribution` | **No other caller** |
| 307 | Employee status split | Chart | `GET /analytics/employee-status` | **No other caller** |
| 308 | Age distribution | Chart | `GET /analytics/age-distribution` | shared with EmployeeReports |
| 309 | Pending leaves | Widget | `GET /analytics/pending-leaves` | **No other caller** |
| 310 | Document expiry | Widget | `GET /analytics/employee-reports/doc-expiry` | shared |
| 311 | Attrition + hiring trends | Charts | shared endpoints | DUPLICATE of HR Dashboard |

**Four backend endpoints exist solely to serve a page no user can navigate to.**

---

# SECTION 4 — KPI Inventory

Every KPI that appears anywhere in Analytics & AI, with its exact calculation, source and cross-page reuse. Values marked **[live]** were computed directly against the `Pulse` database on 18 Aug 2026.

## 4.1 Revenue family

### Revenue YTD
```
SUM(invoices.total_amount) WHERE LOWER(status)='paid'
                             AND invoice_date >= FY_START   -- 2026-04-01
```
- **Source:** `invoices` · **API:** `/ceo-intelligence/executive-summary`, `/analytics/ceo/kpis`
- **Aggregation:** SUM · **Refresh:** on load / Refresh · **Cache:** 60 s in-process (`METRICS_CACHE_TTL_MS`)
- **Computed in:** database
- **[live] = Rs 2,41,900**
- **Appears on:** CEO Intelligence (KPI strip + Executive tab + Sales tab), Executive Dashboard, CFO Dashboard, RevenueForecastPanel
- **Verdict:** **SHARED-VALID.** The `FY_START` unification held — all four surfaces reconcile. Keep one definition; CEO Intelligence should own it.
- **Caveat:** `computeRevenueMetrics` ignores its `company_id` argument.

### Revenue (CFO period variant)
```
SUM(total_amount) WHERE LOWER(status)='paid' AND created_at BETWEEN period
```
Windows on **`created_at`**, not `invoice_date`. Identical today; will diverge the first time an invoice is back-dated. **PARTIAL-DUPLICATE.**

### Revenue per Employee (HR Benchmarking)
```
SUM(invoices.total_amount) / active_headcount     -- NO status filter
```
**[live] = Rs 1,16,18,500 / 32 = Rs 3,63,078.** The numerator includes unpaid, overdue and `'Sent'` invoices — **48x** the figure every other page calls revenue. **BROKEN-BY-DEFINITION.**

### Forecast Revenue
```
pipeline_value * 0.35 + (revenue_ytd / months_elapsed) * 3
```
The 0.35 conversion rate is a hardcoded constant, never measured, even though `computeSalesKPIs` already calculates a real `conversionRate`. **INCOMPLETE.** Appears on CEO Executive tab and Sales tab (**DUPLICATE**).

### Net Profit — two incompatible definitions
| Page | Formula | Verdict |
|---|---|---|
| CFO Dashboard | `(revenue - opex) * 0.78` | **FABRICATED** — 22% tax+interest guess |
| Executive Dashboard | `/finance/reports/profit-loss` `net_profit` | LIVE |
Two dashboards, one label, different arithmetic. **BROKEN-BY-DEFINITION.**

### EBITDA
`netProfit + opex * 0.05`. The 5% D&A is hardcoded. CFO Dashboard only. **FABRICATED.**

### ARR
`SUM(amc_contracts.contract_value) WHERE status='active'`. **[live] = Rs 0** (0 rows). Honest empty. Appears twice on CEO Intelligence under two names (`ARR`, `AMC Annual Revenue`) from the identical query — **DUPLICATE**.

## 4.2 Receivables family

| KPI | Formula | [live] | Page | Verdict |
|---|---|---:|---|---|
| Outstanding Collections | `SUM WHERE status IN ('overdue','pending')` | Rs 46,26,400 | CEO Intelligence | PARTIAL-DUPLICATE |
| Accounts Receivable | `SUM WHERE status NOT IN ('paid','cancelled')` | Rs 51,86,400 | CFO Dashboard | PARTIAL-DUPLICATE |
| **Delta** | 3 invoices with `status='Sent'` | **Rs 5,60,000** | — | **DEFECT** |

`'Sent'` is an orphan status value (3 rows) that the whole-lowercase enumeration everywhere else does not recognise. Aging buckets, DSO, the cash-flow forecast and the CEO traffic light all inherit the ambiguity.

## 4.3 Workforce family

| KPI | Formula | Source | [live] | Pages | Verdict |
|---|---|---|---:|---|---|
| Headcount | `COUNT(*)` | `employees` | 34 | CEO, Exec, HR Dash | SHARED-VALID |
| Active | `LOWER(status) IN ('active','probation')` | `employees` | 32 | CEO, Exec, HR Dash | SHARED-VALID |
| **Attrition Rate** | `departures/headcount*100` over 12m, `status IN ('inactive','resigned','terminated','left')` | `employees` | **0.00% permanently** | CEO strip, CEO Workforce, Exec Dash, HR Dash Analytics | **BROKEN** — real statuses are `Active`/`Notice`/`Probation` |
| **Overview attrition** | `s.left / s.total` (frontend) | `/employees/analytics` | different | HR Dash Overview | **CONTRADICTS the Analytics tab of the same page** |
| **Turnover Rate** | `departed/active*100`, same broken status list | `employees` | **0.0% permanently** | HR Benchmarking | **BROKEN + DUPLICATE of Attrition** |
| On Leave Today | 3 different tables across 3 endpoints | `leaves` (1 row) / `leave_applications` (4) / `leave_requests` (**769**) | 0 everywhere | CEO Ops, CEO Workforce, CFO alert | **BROKEN-BY-SOURCE** |
| New Hires MTD | `created_at >= month_start` | `employees` | live | CEO, Exec, HR | SHARED-VALID |
| Avg Tenure | `AVG(NOW() - created_at)/365` | `employees` | live | CEO Workforce | UNIQUE — uses `created_at`, not `joining_date` |
| At Risk | literal `0` | — | 0 | CEO Workforce | **STATIC** |
| Gender Female % | `female / COUNT(*) active` = 2/32 | `employees` | **6.3%** | CEO, HR Dash, HR Bench (x2) | **DUPLICATE x4** — 4 of 32 have `gender` set; the denominator counts all 32 |

## 4.4 Recruitment family — the contradiction

| Page | KPI | Query | [live] |
|---|---|---|---:|
| HR Dashboard | Offer Acceptance Rate | `offer_letters.offer_status`: 3 offered, 2 accepted | **66.7%** |
| HR Benchmarking | Offer Acceptance Rate | `candidates.status IN ('offered','accepted','joined','declined')` | **0%** |

All 3 `candidates` rows have `status='active'`. `analytics.routes.js:259` documents that `candidates.status` is never written and routes `/analytics/offer-acceptance` through `recruitmentRepository` instead — but `/analytics/hr-benchmarks` reintroduced the original query. **Fix: point `[1]` at `recruitmentRepository.getOfferAcceptanceRate()`.**

Also: `offerExceptionRate` and `offerDeclineRate` are the *same expression* (`declined/offered`) exposed under two names, and the UI labels one of them "declined / exceptions". **DUPLICATE.**

## 4.5 Operations family

| KPI | Formula | [live] | Page | Verdict |
|---|---|---:|---|---|
| **Open Tickets** | `NOT IN ('Resolved','Closed')` — capitalised | **13** | CEO Ops tab | **CONTRADICTION** |
| **Open Tickets** | `NOT IN ('resolved','closed')` — lowercase | **15** | CEO Collections tab | **same page, same KPI, +2** |
| Escalations | `priority='critical' OR status='escalated'` | **0 permanently** | CEO Collections | **BROKEN** — real priorities are `High/Medium/Low` |
| Critical tickets (health score input) | `priority='critical'` | 0 permanently | CEO Customers | **BROKEN** — pins 25 of the 100 health points |
| Timesheets Pending | `status='submitted'` | **0** | CEO Ops | **BROKEN** — only `'approved'` exists; ManagerDashboard queries `'Submitted'` |
| Active Projects | `status NOT IN ('completed','cancelled')` | 3 | CEO Ops, CEO Exec, Exec Dash | DUPLICATE x3 |
| **Projects On-Track** | `status='on-track'` | **0/3 permanently** | CEO strip | **BROKEN** — status forbidden by `projects_status_check` |
| Low Stock | `current_stock <= reorder_level AND > 0` | 0 | CEO Ops, CFO alert | SHARED-VALID (but `/ai/*` uses `reorder_point` — two thresholds) |
| Open Recruitments | `job_openings.status='open'` | 0 | CEO Ops | LIVE (both rows `closed`) |

## 4.6 Project profitability family

All of these depend on `project_cost_summary`, which has **0 rows**:
- Customer `margin_pct` (CEO Customers) — always null, renders "—"
- Project `actual_cost`, `profit`, `margin_pct`, `budget_variance_pct` (CEO Projects) — profit == contract value, margin == 100%
- Portfolio Margin — 100%
- Project Health label — every project reads "On Track"
- Business Line `cost` / `profit` / `margin_pct` — all zero

**EMPTY-BY-DATA, not broken code** — but the derived labels are actively misleading: a project with unknown cost is displayed as 100%-margin and "On Track".

## 4.7 HR Benchmarking metrics — full status

| Metric | Benchmark | Source | Status |
|---|---:|---|---|
| Avg Days to Hire | 30 | `employees` join `candidates` | LIVE-if-matched |
| Time to Fill | 45 | `job_openings` | LIVE |
| Offer Acceptance | 70% | `candidates.status` | **BROKEN — 0%** |
| Offer Exception | 15% | same as decline rate | **BROKEN + DUPLICATE** |
| Cost per Hire | — | `recruitment_costs` | **BROKEN — table missing** |
| Revenue per Employee | — | `invoices` unfiltered | **INCONSISTENT — 48x** |
| Training Effectiveness | 70% | `assessment_submissions` | **BROKEN — table missing** |
| Turnover Rate | 10% | `employees` | **BROKEN — 0.0%** |
| Engagement Score | 75% | `performance_reviews` | EMPTY (0 rows) |
| Acquisition Rate | 15% | `employees` | LIVE |
| Compa-Ratio | 1.0 | avg/median salary | **MIS-DEFINED** — 1.07 from 5 of 32 |
| Median Salary | — | `basic_salary` | LIVE, 5 of 32 coverage undisclosed |
| Benefits Utilization | 80% | `leave_applications` | EMPTY — wrong table |
| Gender Diversity | 40% | `employees.gender` | LIVE but 87.5% null denominator |
| Women in Leadership | 30% | designation LIKE | LIVE |

**5 of 15 cannot ever return a value. 3 more are computed from under 20% data coverage with no disclosure.**

---

# SECTION 5 — Data Source Map

## 5.1 Endpoint to route-file to table

| Endpoint | Route file | Primary tables | Company-scoped | Permission guard |
|---|---|---|:--:|---|
| `GET /ceo-intelligence/executive-summary` | `intelligence/ceo-intelligence.routes.js:28` | invoices, opportunities, projects, bills, vendors, amc_contracts | yes | `crm:view` |
| `GET /ceo-intelligence/customers` | `:112` | parties, invoices, projects, project_cost_summary, support_tickets, amc_contracts, sales_orders, ncr_reports | yes | `crm:view` |
| `POST /ceo-intelligence/customers/:id/convert-upsell` | `:306` | opportunities (write), tasks, notifications | yes | `crm:add` |
| `GET /ceo-intelligence/vendors` | `:408` | vendors, purchase_orders, vendor_scorecards, ncr_reports, goods_receipt_notes | yes | `procurement:view` |
| `GET /ceo-intelligence/projects` | `:563` | projects, parties, project_cost_summary, project_cost_lines | yes | `projects:view` |
| `GET /ceo-intelligence/collections` | `:653` | parties, invoices | yes | `finance:view` |
| `GET /ceo-intelligence/service-amc` | `:702` | support_tickets, amc_contracts, sales_orders, parties | yes | `crm:view` |
| `GET /ceo-intelligence/strategic-alerts` | `:766` | parties, invoices, vendors, ncr_reports, projects, project_cost_summary, amc_contracts | yes | `crm:view` |
| `GET /ceo-intelligence/ai-insights` | `:863` | parties, invoices, vendors | yes | `crm:view` |
| `GET /ceo-intelligence/manifest` | `:947` | projects, product_lines, project_cost_summary, opportunities, amc_contracts | yes | `projects:view` |
| `GET /analytics/ceo/kpis` | `analytics/routes/analytics.routes.js:398` | employees, invoices, amc_contracts, opportunities, projects | **projects: NO** | **none** |
| `GET /analytics/headcount` | `:112` to `metricsEngine` | employees, leave_applications | yes | **none** |
| `GET /analytics/attrition` | `:122` | employees | yes | **none** |
| `GET /analytics/dept-workforce` | `:132` | employees | yes | **none** |
| `GET /analytics/sales` | `:152` | opportunities | **NO** | **none** |
| `GET /analytics/revenue` | `:142` | invoices, amc_contracts | **NO** | **none** — *no live caller* |
| `GET /analytics/gender` | `:162` | employees | yes | **none** |
| `GET /analytics/attrition-trend` | `:176` | employees | yes | **none** |
| `GET /analytics/hiring-trend` | `:209` | employees | yes | **none** |
| `GET /analytics/offer-acceptance` | `:259` to recruitment repo | offer_letters | yes | **none** |
| `GET /analytics/absenteeism` | `:270` | attendance, employees | partial | **none** |
| `GET /analytics/productivity` | `:298` | tasks | **NO** | **none** |
| `GET /analytics/top-performers` | `:323` | employees, performance_reviews | yes | **none** — **exposes named staff + ratings** |
| `GET /analytics/insights/hr` | `:360` | employees, leave_applications | yes | **none** |
| `GET /analytics/headcount-trend` | `:439` | employees | yes | **none** |
| `GET /analytics/salary-bands` | `:471` | employees | yes | **none** — **exposes salary distribution** |
| `GET /analytics/time-to-hire` | `:508` | candidates, employees | yes | **none** |
| `GET /analytics/satisfaction` | `:519` | performance_reviews | yes | **none** |
| `GET /analytics/onboarding` | `:564` | hr_onboarding_checklist_progress | yes | **none** |
| `GET /analytics/compliance-alerts` | `:617` | employee_compliance_docs, employee_documents | yes | **none** |
| `GET /analytics/hr-filter-options` | `:654` | employees | yes | **none** |
| `GET /analytics/hr-kpis` | `:669` | employees | yes | **none** — *orphan page only* |
| `GET /analytics/department-distribution` | `:725` | employees | yes | **none** — *orphan page only* |
| `GET /analytics/employee-status` | `:758` | employees | yes | **none** — *orphan page only* |
| `GET /analytics/pending-leaves` | `:778` | leave_applications | yes | **none** — *orphan page only* |
| `GET /analytics/age-distribution` | `:797` | employees | yes | **none** |
| `GET /analytics/hr-benchmarks` | `:1012` | employees, candidates, invoices, **assessment_submissions (MISSING)**, performance_reviews, job_openings, leave_applications, **recruitment_costs (MISSING)** | yes | **none** — **exposes median/P25/P75 salary** |
| `GET /dashboard/revenue` | `dashboard/dashboard.controller.js:94` | invoices | **NO** | **none** |
| `GET /dashboard/expenses` | `:169` | expense_claim_items, expense_categories | **NO** | **none** |
| `GET /dashboard/workforce` | `:191` | employees, attendance, leaves | partial | **none** |
| `GET /dashboard/alerts` | — | multiple | partial | **none** |
| `GET /dashboard/sales` | — | opportunities, crm_pipeline_stages | partial | **none** |
| `GET /dashboard/operations` | — | projects, support_tickets, inventory_items, invoices, leaves, tasks, timesheets, job_openings | **partial (4 of 9 unscoped)** | **none** |
| `GET /dashboard/top-customers` | — | invoices, parties | partial | **none** |
| `GET /dashboard/top-vendors` | — | purchase_orders, vendors | partial | **none** |
| `GET /dashboard/headcount-trend` | — | employees | yes | **none** |
| `GET /dashboard/cfo` | `:1201` | invoices, expense_claims, bills, receipts, payments, expense_claim_items, tasks, leaves, inventory_items | **partial — expByCategory unscoped** | **none** — **exposes full P&L** |
| `GET /ai/anomalies` | `intelligence/anomalyDetector.js` | invoices, employees, attendance, po_items, payroll_runs, test_runs | **NO (all 5)** | **none** |
| `GET /ai/predict/attrition` | `ai.routes.js:471` | employees | yes | **none** |
| `GET /ai/predict/sales` | `:494` | sales_orders | yes | **none** |
| `GET /ai/predict/inventory` | `:514` | inventory_items, stock_ledger | yes | **none** |
| `GET /ai/predict/lead-priority` | `:779` | opportunities | yes | **none** |
| `GET /ai/prescriptive` | `:989` | inventory_items, invoices | yes | **none** |
| `GET /ai/cashflow/forecast` | `aiPayroll.service.js:306` | invoices, bills | **NO** | **none** |
| `POST /ai/query` | `aiPayroll.controller.js:93` | payroll, invoices, bills, employees | partial | **none** |
| `POST /ai/llm-chat` | `ai.routes.js:35` | leave_balances, leave_requests, employees, users to OpenAI | n/a | **none** |
| `POST /ai/ceo-insights` | `ai.routes.js:17` | request payload only | n/a | **none** |
| `GET /system-health/db-tables` | `admin/systemHealth.routes.js:79` | `pg_class`, `pg_stat_user_tables`, `information_schema.columns` | n/a | **`allowRoles('admin','super_admin')`** |
| `GET /travel/analytics/by-employee` / `by-project` | travel routes | travel_requests, expense_claims | yes | travel guards |
| `GET /sales-command-center/summary` / `team-targets` / `salesperson-scorecard` | SCC routes | sales_targets, opportunities, invoices | yes | SCC guards |
| `GET /finance/reports/profit-loss` | finance routes | journal_entries, accounts | yes | `finance:view` |

## 5.2 UI to database trace — worked example

**CEO Intelligence, Executive tab, "Outstanding Collections" tile showing Rs 46,26,400:**

```
CEOIntelligenceDashboard.jsx:355   <KpiCard label="Outstanding Collections" value={fmtL(kpis.outstanding_collections)} />
  <- state `summary`                  set at line 1101 from exec.data
  <- api.get('/ceo-intelligence/executive-summary')            line 1076
  <- axios client, baseURL /api/v1
  <- server.js:697  v1Router.use("/ceo-intelligence", verifyToken, ceoIntelligenceRoutes)
  <- ceo-intelligence.routes.js:28   requirePermission('crm','view')
  <- companyOf(req) -> company_id = 1
  <- pool.query(`SELECT COALESCE(SUM(total_amount),0) AS v FROM invoices
                 WHERE status IN ('overdue','pending') AND company_id=1`)
  <- table `invoices` (35 rows) -> 6 overdue (Rs 22,72,800) + 8 pending (Rs 23,53,600)
  = Rs 46,26,400   [verified directly against the database]
```
Excluded by this filter: 3 invoices with `status='Sent'` worth Rs 5,60,000, which the CFO Dashboard's AR query *does* include.

## 5.3 Missing tables referenced in live SQL

| Table | Referenced at | Consequence |
|---|---|---|
| `assessment_submissions` | `analytics.routes.js:1096` | HR Benchmarking "Training Effectiveness" permanently 0%, silently |
| `recruitment_costs` | `analytics.routes.js:1186` | HR Benchmarking "Cost per Hire" permanently N/A, silently |

Both are wrapped in `sq1()`, which logs to `console.error` and returns `null`. Nothing surfaces to the UI.

## 5.4 Missing columns referenced in live SQL

| Column | Referenced at | Consequence |
|---|---|---|
| `invoices.client_name` | `anomalyDetector.js:18` | Invoice-outlier anomaly detector never fires; error swallowed by `catch(_){}` |
| `inventory_items.name` | `ai.routes.js:189` (`/ai/chat`) | Low-stock answer always reports "no items below reorder point" |

## 5.5 Status-value mismatches (the dominant defect class)

| Table | Real values (live) | Code expects | Affected features |
|---|---|---|---|
| `employees.status` | `Active`(30), `Notice`(2), `Probation`(2) | `inactive`, `resigned`, `terminated`, `left`, `ex-employee`, `active` (lower) | Attrition (4 pages), Turnover, attrition-trend, `/ai/predict/attrition`, low-attendance anomaly, `/ai/chat` headcount |
| `projects.status` | `active`(1), `planning`(2) | `on-track`, `in_progress` | Projects On-Track KPI, active-project counts |
| `support_tickets.status` | `Open`(11), `In Progress`(2), `Resolved`(2) | both `('Resolved','Closed')` **and** `('resolved','closed')` | **13 vs 15 open tickets on the same page** |
| `support_tickets.priority` | `High`(5), `Medium`(6), `Low`(4) | `critical` | Escalations KPI, customer health `tScore` |
| `timesheets.status` | `approved`(1) | `submitted` / `Submitted` | Timesheets Pending tile |
| `invoices.status` | `paid`, `pending`, `overdue`, **`Sent`**(3) | lowercase enumerations only | Rs 5,60,000 AR/Outstanding gap |
| `candidates.status` | `active`(3) | `offered/accepted/joined/declined` | Offer Acceptance 0% vs 66.7% |

## 5.6 Table-drift: four leave tables, three consumed

| Table | Rows | Read by |
|---|---:|---|
| `leave_requests` | **769** | `/ai/llm-chat` context only |
| `leave_applications` | 4 | `computeHeadcount` onLeave, HR insights, HR Benchmarking benefits utilisation |
| `leaves` | 1 | `/dashboard/workforce`, `/dashboard/operations`, CFO pending-leave alert |
| `leave_balances` | — | `/ai/llm-chat` |

Every "On Leave Today" and "pending leaves" figure in the module reads one of the two nearly-empty tables. The real one (769 rows, **159 pending**) is invisible to analytics.

---

# SECTION 6 — Live Data Audit

## 6.1 STATIC — hardcoded values rendered as business data

| # | Value | Location | Rendered as | Severity |
|---|---|---|---|---|
| S1 | `target = revenue * 1.1` | `CFODashboard.jsx:200` | "Target" line on the Revenue vs Target chart | **P0** |
| S2 | `profit = revenue * 0.28` | `CFODashboard.jsx:200` | "Profit" bars on the same chart | **P0** |
| S3 | `netProfit = grossProfit * 0.78` | `dashboard.controller.js:1388` | Net Profit headline KPI + Net Margin ratio | **P0** |
| S4 | `ebitda = netProfit + opex * 0.05` | `dashboard.controller.js:1390` | EBITDA headline KPI + EBITDA Margin | **P0** |
| S5 | Department shares `{0.36, 0.30, 0.23, 0.18, 0.14}` on 5 hardcoded departments (**sum = 1.21**) | `CFODashboard.jsx:614-620` | "Department Expenses" card | **P0** |
| S6 | `CRITICAL_COMPONENTS` — 8 fake parts with fake lead-times/vendor-counts/impact prose | `SupplyChainRiskPanel.jsx:20-29` | Critical Components table + 2 exposure KPI cards | **P0** |
| S7 | 21 of 25 "AI Insight" bullets; `margin_risks` 100% canned | `ceo-intelligence.routes.js:892-943` | War Room "AI Insights" | **P0** |
| S8 | `target = ceil(headcount * 1.1)` | `metricsEngine.js:157` | "Target" bar on Department Strength — every dept renders 91% | **P1** |
| S9 | `BUSINESS_LINES = ['HVDC','STATCOM','SST','Automation','Service','AMC']` | `ceo-intelligence.routes.js:952` | The entire Business Lines tab (48 values) | **P1** |
| S10 | `System Health = "Healthy"` | `AdminDashboard.jsx:422` | KPI card on Ops Command Center | **P1** |
| S11 | `"All Systems Operational"` | `AdminDashboard.jsx:530` | System-health card copy | **P1** |
| S12 | 5 ratios pinned to `'—'` with `status:'good'` | `CFODashboard.jsx:266-270` | Green "good" chips for Debt/Equity, ROE, ROA, Inventory Turns, Interest Coverage | **P1** |
| S13 | `pipeline * 0.35` conversion rate | `ceo-intelligence.routes.js:75, 1032` | Forecast Revenue KPI (x2) + business-line forecast | **P1** |
| S14 | `traffic_lights.supply_chain='green'`, `.profitability='green'` | `ceo-intelligence.routes.js:82-83` | 2 of 5 Business Health Signals | **P1** |
| S15 | `singleSourceRevAtRisk = SUM(po_value) * 1.5` | `SupplyChainRiskPanel.jsx:59` | "Revenue at risk" figure | **P2** |
| S16 | `atRisk: 0` | `metricsEngine.js:141` | "At Risk" employee count | **P2** |
| S17 | `conversionRate ?? 22` labelled "22% (est.)" | `ExecutiveDashboard.jsx:59` | AI Business Insight text | **P2** |
| S18 | growth default `0.04`, optimistic `x1.2`, conservative `x0.8` | `dashboard.controller.js:1441-1456` | CFO Revenue Forecast scenario bands | **P2** |
| S19 | `DEPTS = ['All','Engineering','Sales','HR','Finance','Operations','Marketing','Support']` | `HRDashboard.jsx:47` | Department filter — 3 phantom, 10 real ones missing | **P1** |
| S20 | `DEPARTMENTS` (11) and `PERM_MODULES` (7) | `AdminDashboard.jsx:28,33` | Add-user form | **P2** |
| S21 | `"{total \|\| '200+'} tables"` | `SystemHealth.jsx:308` | Header subtitle (real count 551) | **P3** |
| S22 | 12 benchmark thresholds | `HRBenchmarkingDashboard.jsx` | Reference targets | **P3 — legitimate**, but not configurable |
| S23 | "Industry benchmark: 10-12%" | `CEOIntelligenceDashboard.jsx:836` | Attrition card | **P3 — legitimate** |

**No `Math.random()` anywhere in the module.** The only randomness is `crypto.getRandomValues` in the admin password generator, which is correct.

## 6.2 BROKEN — expected data exists but cannot be retrieved

| # | Feature | Root cause | Verified |
|---|---|---|---|
| B1 | Projects On-Track KPI | `status='on-track'` forbidden by `projects_status_check` | 0/3 |
| B2 | Attrition Rate (4 surfaces) | status-value mismatch | 0.00% |
| B3 | Turnover Rate (HR Bench) | same | 0.0% |
| B4 | Attrition Trend chart | same | empty |
| B5 | `/ai/predict/attrition` chart | same | all-zero |
| B6 | Low Attendance anomaly | `e.status='active'` vs `'Active'` | never fires |
| B7 | Invoice Outlier anomaly | `invoices.client_name` does not exist | never fires |
| B8 | Escalations KPI | `priority='critical'` never matches | 0 |
| B9 | Customer health `tScore` | same — pins 25 of 100 points | constant |
| B10 | Timesheets Pending tile | `status='submitted'` vs `'approved'` | 0 |
| B11 | Offer Acceptance (HR Bench) | `candidates.status` never written | 0% vs 66.7% |
| B12 | Offer Exception Rate | duplicate of decline rate, same broken source | 0% |
| B13 | Training Effectiveness | `assessment_submissions` table missing | 0% |
| B14 | Cost per Hire | `recruitment_costs` table missing | N/A |
| B15 | Business Lines tab (48 values) | taxonomy mismatch + `product_line_id` unset | all zero |
| B16 | On Leave Today (3 surfaces) | reads `leaves`/`leave_applications`, not `leave_requests` | 0 |
| B17 | CFO pending-leave alert | reads `leaves` (1 row); real pending = 159 | never fires |
| B18 | CFO alert action buttons (all 5) | `ALERT_ACTION_PAGE` keys do not match backend action strings | dead click |
| B19 | Revenue per Employee | no status filter -> 48x every other revenue figure | Rs 3.6 L |
| B20 | HR Dashboard department filter | no params sent on any of 17 calls | affects 1 of 18 widgets |
| B21 | Open Tickets 13 vs 15 | status casing differs between two endpoints on one page | proven |
| B22 | AR vs Outstanding | `'Sent'` status included by one, excluded by the other | Rs 5,60,000 |
| B23 | HR Dash Overview vs Analytics attrition | two formulas on one page | contradictory |
| B24 | Strategic-alert acknowledgement | client-only `Set`, backend hardcodes `acknowledged:false` | lost on refresh |
| B25 | `/ai/chat` low-stock answer | `inventory_items.name` does not exist | always "no items" |
| B26 | `/ai/chat` headcount answer | `status='active'` never matches | always empty |
| B27 | `queryERPIntelligence` fallback typo | "Engineeing payroll" | user-visible |

## 6.3 EMPTY-EXPECTED — source table genuinely has no rows

| Feature | Table | Rows |
|---|---|---:|
| ARR / AMC Annual Revenue / Active AMC / Expiring 90d / Renewal Forecast / expiring-contracts table | `amc_contracts` | 0 |
| All project cost, profit, margin and portfolio figures | `project_cost_summary` | 0 |
| Project cost breakdown by type | `project_cost_lines` | 0 |
| Vendor scorecard Score column | `vendor_scorecards` | 0 |
| CEO Expense Breakdown + CFO Expense Structure | `expense_claim_items` | 0 |
| CFO Cash and Equivalents, runway | `receipts`, `payments` | 0, 0 |
| Target vs Achievement, Top/Bottom Performers | `sales_targets` | 0 |
| Top Performers, Engagement Score, Appraisal Distribution | `performance_reviews` | 0 |
| TDS Mismatch anomaly | `payroll_runs` | 0 |

These are **legitimate empty states**, correctly labelled in most places. Two exceptions where the empty state produces a *wrong positive claim*:
- A project with no cost data is displayed as **100% margin, "On Track"** rather than "cost unknown".
- `traffic_lights.profitability` reads **green** while profitability is entirely unmeasured.

## 6.4 Live-data classification totals

| Classification | Count | Share |
|---|---:|---:|
| LIVE | 96 | 45% |
| CALCULATED-LIVE | 42 | 20% |
| CACHED-LIVE (60 s `metricsEngine` TTL) | 6 | 3% |
| STATIC | 23 | 11% |
| MOCK | 6 | 3% |
| PLACEHOLDER | 5 | 2% |
| BROKEN | 27 | 13% |
| EMPTY-EXPECTED | 15 | 7% |
| **UNKNOWN** | **0** | **0%** |

---

# SECTION 7 — Live Data Proof

Ten-point verification per §7, executed against the live `Pulse` database.

| # | Check | Result |
|---|---|---|
| 1 | API request is made | **PASS** — all 41 endpoints traced from a UI call site |
| 2 | API returns successfully | **PASS with caveats** — every page wraps calls in `Promise.allSettled` or `.catch(nil)`, so failures degrade silently instead of surfacing |
| 3 | Response contains actual data | **PARTIAL** — 15 features return legitimately empty payloads, 27 return structurally impossible values |
| 4 | Data corresponds to DB records | **VERIFIED for 12 headline KPIs** (table below) |
| 5 | Frontend renders the response | **PASS** |
| 6 | Filters change the request | **PARTIAL** — see Section 15 |
| 7 | Date-range changes affect results | **PARTIAL** — 4 of 8 pages have no date filter |
| 8 | Refresh produces current data | **PASS** — every page has a Refresh; `metricsEngine` caches 60 s |
| 9 | No stale hardcoded value displayed | **FAIL** — 23 static + 6 mock + 5 placeholder values |
| 10 | Errors handled | **PARTIAL** — no page white-screens, but most failures are indistinguishable from "no data" |

## 7.1 Database to API to UI reconciliation

| KPI | DB query result | API returns | UI shows | Match |
|---|---:|---:|---:|:--:|
| CEO Revenue YTD | Rs 2,41,900 | 241900 | Rs 2.4 L | yes |
| Exec Dashboard Revenue YTD | Rs 2,41,900 | 241900 | Rs 2.4L | yes |
| CFO Revenue (YTD) | Rs 2,41,900 | 241900 | Rs 2.42 L | yes |
| CEO Outstanding Collections | Rs 46,26,400 | 4626400 | Rs 46.3 L | yes |
| CFO Accounts Receivable | Rs 51,86,400 | 5186400 | Rs 51.86 L | yes (**but contradicts the row above**) |
| CEO Pipeline Value | Rs 42,59,009 | 4259009 | Rs 42.6 L | yes |
| Headcount | 34 | 34 | 34 | yes |
| Active employees | 32 | 32 | 32 | yes |
| ARR | Rs 0 | 0 | Rs 0 | yes (honest empty) |
| Projects On-Track | 0 of 3 | `{value:0, outOf:3}` | 0/3 | renders correctly, **but is structurally unreachable** |
| CEO Ops Open Tickets | 13 | 13 | 13 | yes |
| CEO Collections Open Tickets | 15 | 15 | 15 | yes (**contradicts the row above**) |
| HR Dash Offer Acceptance | 2 of 3 = 66.67% | 66.67 | 66.7% | yes |
| HR Bench Offer Acceptance | 0 of 0 = 0% | 0 | 0% | renders correctly, **contradicts the row above** |
| HR Bench Revenue/Employee | Rs 1,16,18,500 / 32 | 363078 | Rs 3,63,078 | renders correctly, **48x every other revenue figure** |
| HR Bench Gender Female | 2 of 32 = 6.3% | 6.3 | 6.3% | renders correctly, **87.5% null denominator** |
| HR Bench Compa-Ratio | 56250/52500 | 1.07 | 1.07x | renders correctly, **wrong definition** |
| CFO Cash | 0 - 0 | 0 | Rs 0 | yes |

**Conclusion:** the pipeline from database to screen is faithful. The defects are in the **queries and the formulas**, not in the transport. Five KPIs are internally contradictory across pages, and the UI renders both sides of every contradiction with equal confidence.

---

# SECTION 8 — Duplication Matrix

Legend: `Y` present · `—` absent · `D` duplicate · `C` contextual/shared (legitimate) · `P` partial overlap · `R` recommend removal or rework

| Feature | CEO | Exec | Ops | CFO | HR | HRBench | ERP-Intel | SysHealth | Classification |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Revenue YTD | C | D | — | D | — | R | — | — | Shared KPI; Exec+CFO duplicate CEO; HRBench uses an incompatible definition |
| Revenue trend chart | C | D | — | D | — | — | — | — | Three renderings of the same series |
| Net Profit | — | P | — | C | — | — | — | — | Two different formulas |
| EBITDA | — | — | — | C | — | — | — | — | Unique to CFO (fabricated) |
| Cash position | P | — | — | C | — | — | P | — | Three definitions: revenue-payables, receipts-payments, due-date roll-up |
| Outstanding / AR | C | — | — | D | — | — | — | — | Rs 5.6 L apart |
| AR aging buckets | C | — | — | — | — | — | — | — | UNIQUE to CEO — should move to CFO |
| Sales pipeline value | C | D | — | — | — | — | — | — | Two sources: `opportunities` vs `/dashboard/sales` |
| Pipeline by stage | D | D | — | — | — | — | — | — | CEO renders it twice (Exec tab + Sales tab) |
| Avg deal size | D | — | — | — | — | — | — | — | CEO renders it twice |
| Conversion rate | C | P | — | — | — | — | — | — | Exec falls back to the literal 22 |
| Revenue forecast | D | — | — | C | — | — | P | — | CEO twice (static 0.35); CFO 3-scenario; ERP-Intel due-date roll-up |
| Top customers | C | D | — | — | — | — | — | — | Table vs ranked bars, same concept |
| Top vendors | C | D | — | — | — | — | — | — | Same |
| Customer health scoring | C | — | — | — | — | — | — | — | UNIQUE |
| Vendor risk / scorecards | C | — | — | — | — | — | — | — | UNIQUE |
| Supply-chain exposure | R | — | — | — | — | — | — | — | Mock-driven |
| Project profitability | C | — | — | — | — | — | — | — | UNIQUE (data-empty) |
| Active projects count | D | D | — | — | — | — | — | — | Three renderings |
| Headcount | D | D | — | — | C | — | — | — | Three renderings |
| Attrition rate | D | D | — | — | D | D | D | — | **Five renderings, all permanently 0%** |
| Gender diversity | D | — | — | — | D | C | — | — | **Four renderings** |
| Department workforce | D | D | — | — | D | — | — | — | **Three renderings** |
| Hiring / headcount trend | — | D | — | — | C | P | — | — | Two renderings |
| On leave today | D | — | D | D | — | — | — | — | Three renderings, three different tables |
| Offer acceptance | — | — | — | — | C | R | — | — | **66.7% vs 0% — must consolidate** |
| Time to hire | — | — | — | — | D | C | — | — | Two renderings |
| Engagement / satisfaction | — | — | — | — | D | C | — | — | Two renderings |
| Salary bands / median | — | — | — | — | C | D | — | — | Two renderings |
| Expense breakdown by category | D | — | — | C | — | — | — | — | Same table, two pages |
| Rule-based insight engine | D | D | — | — | D | — | — | — | **Three separate engines**: `insightsEngine.js`, `ExecutiveDashboard.generateInsights`, `HRDashboard.generateHRInsights`, plus a 4th server-side at `/analytics/insights/hr` |
| System alerts | D | D | — | D | — | — | — | — | `/dashboard/alerts` rendered on three pages, plus CFO's own alert set |
| Ops drill-through tiles | C | P | — | — | — | — | — | — | Exec KPIs overlap 4 of 9 CEO tiles |
| Approval queues | — | — | R | — | R | — | — | — | Both duplicate the Approvals module |
| User administration | — | — | C | — | — | — | — | — | UNIQUE — but not analytics |
| Audit trail / module activity | — | — | C | — | — | — | — | — | UNIQUE — but not analytics |
| AI narrative insights | C | — | — | — | — | — | P | — | CEO 84% canned; ERP-Intel genuinely live |
| Anomaly detection | — | — | — | — | — | — | C | — | UNIQUE |
| Prescriptive recommendations | — | — | — | — | — | — | C | — | UNIQUE — best AI feature |
| NL query / chat | — | — | — | — | — | — | C | — | UNIQUE |
| Predictive charts | — | — | — | — | — | — | C | — | UNIQUE |
| DB table introspection | — | — | P | — | — | — | — | C | Ops asserts "Healthy" without checking |
| Export | — | — | — | — | — | — | C | — | **Only CSV export in the module** |
| Canonical filter bar | — | C | — | — | — | C | — | — | Only 2 of 8 |

## 8.1 Exact duplicates (same KPI, same calculation, same purpose)

| # | KPI | Pages | Action |
|---|---|---|---|
| E1 | Revenue YTD | CEO strip, CEO Exec tab, CEO Sales tab, Exec Dash | Render once per page; CEO renders it **three times on one page** |
| E2 | Pipeline Value | CEO strip, CEO Exec tab, CEO Sales tab | Same |
| E3 | Avg Deal Size | CEO Exec tab, CEO Sales tab | Same |
| E4 | ARR and "AMC Annual Revenue" | CEO strip, CEO Exec tab | Identical query, two labels |
| E5 | Revenue trend series | CEO Exec tab (area), CEO Sales tab (composed) | Same array, two charts |
| E6 | Attrition Rate | CEO strip, CEO Workforce, Exec Dash, HR Dash, HR Bench (as "Turnover") | Collapse to one owner |
| E7 | Gender diversity | CEO Workforce, HR Dash, HR Bench card, HR Bench chart | Collapse to HR Bench |
| E8 | Department workforce | CEO Workforce, Exec Dash, HR Dash | Collapse to HR Dash |
| E9 | System alerts (`/dashboard/alerts`) | CEO Ops, Exec Dash | Collapse to CEO Ops |
| E10 | Expense by category | CEO Exec tab, CFO Expense Structure | Collapse to CFO |
| E11 | Top Customers / Top Vendors | CEO Customers+Vendors, Exec Dash | Collapse to CEO |
| E12 | `offerDeclineRate` and `offerExceptionRate` | HR Bench | Same expression, two labels |
| E13 | Top vs Bottom Performers | CEO Sales tab | Identical rows when the team is 6 or fewer |
| E14 | Margin rows and the ratio grid | CFO | Gross/EBITDA/Net margin rendered twice |
| E15 | Working-capital stats and the ratio grid | CFO | Quick ratio, AR/AP rendered twice |

## 8.2 Functional duplicates (different UI, same business function)

| # | Function | Implementations |
|---|---|---|
| F1 | Rule-based insight generation | **4** — `insightsEngine.js` (client, 8 rules), `ExecutiveDashboard.generateInsights` (client), `HRDashboard.generateHRInsights` (client), `/analytics/insights/hr` (server) |
| F2 | Sales pipeline | `opportunities.expected_value` (CEO) vs `/dashboard/sales` stage sums (Exec, CEO Sales tab) |
| F3 | Cash position | 3 mutually-inconsistent definitions |
| F4 | Revenue forecast | 3 models with 3 different assumption sets |
| F5 | Approvals inbox | ManagerDashboard, HR Dashboard, and the Approvals module |
| F6 | Health check | Ops Command Center's hardcoded assertion vs the real System Health page |
| F7 | HR analytics deck | HR Dashboard Analytics tab vs the hidden `HRAnalyticsDashboard` |

## 8.3 Partial duplicates (overlapping, different purpose)

| # | Overlap | Assessment |
|---|---|---|
| P1 | CEO Executive tab vs Executive Dashboard | **13 of 25 Exec features duplicate CEO.** The remaining 12 are the filter bar, quick-nav, greeting and the P&L-sourced Net Profit |
| P2 | CEO Operations tab vs Executive Dashboard KPIs | 4 of 9 tiles overlap |
| P3 | HR Dashboard Analytics vs HR Benchmarking | 6 metrics overlap; benchmarking framing is the only differentiator |
| P4 | CEO Collections tab vs CFO Dashboard | AR aging belongs to CFO; it lives on CEO |
| P5 | ERP-Intel cash-flow forecast vs CFO cash flow | Same tables, different windowing |

## 8.4 Legitimate contextual repetition (keep)

- Revenue and Headcount on an executive summary alongside their functional owners — **provided the number is identical**, which for Revenue it now is.
- Benchmark thresholds repeated in card and footer on HR Benchmarking — reinforcement, not duplication.
- Open-ticket counts on both a customer-health view and an operations view — **provided they agree**, which today they do not.

## 8.5 Unnecessary repetition (remove)

- CEO Intelligence renders Revenue YTD, Pipeline Value and Avg Deal Size **three times within itself** (strip, Executive tab, Sales tab).
- Executive Dashboard is 52% a re-render of CEO Intelligence.
- Four separate rule engines producing overlapping prose.
- Top and Bottom Performers side by side on a small team.

---

# SECTION 9 — Page Responsibility Matrix

| Page | Primary user | Primary purpose | Unique features | Shared features | Must NOT duplicate |
|---|---|---|---|---|---|
| **CEO Intelligence** | CEO / MD | Company-wide strategic health: which customers, vendors, projects and collections need executive attention this week | Customer health scoring, vendor risk, AR aging, strategic-alert war room, business-line P&L, upsell to CRM conversion | Revenue, headcount, pipeline | Functional deep-dives that CFO/HR own |
| **Executive Dashboard** | Manager, dept head | *(as built: nothing CEO Intelligence does not do)* | Canonical period filter, quick-nav, 403-aware degradation | Everything else | — |
| **Ops Command Center** | Admin | *(as built: user administration + manager approvals — not analytics)* | User CRUD, permissions, CSV import, audit feed | — | The System Health assertion |
| **CFO Dashboard** | CFO, finance | Financial position and decisions: P&L, cash, ratios, working capital, forecast | EBITDA, DSO/DPO, burn/runway, waterfall, gauges, cash-flow bridge, scenario forecast | Revenue | Nothing — but must **own** AR aging, currently on CEO |
| **HR Dashboard** | HR manager | Day-to-day people operations plus workforce analytics | Onboarding, compliance, probation alerts, salary bands, productivity | Headcount, attrition | Benchmark comparisons (HR Bench owns those) |
| **HR Benchmarking** | HR head, CHRO | *Are we competitive?* Every metric against an external target | Compa-ratio, cost-per-hire, time-to-fill, women in leadership, benefits utilisation, on/below-target framing | Attrition, gender, salary | Raw operational counts (HR Dash owns those) |
| **ERP Intelligence** | Any analyst | Cross-module AI: ask, predict, prescribe | NL query, anomaly detection, prescriptive actions, multi-module forecasting, CSV export | — | Re-rendering dashboard KPIs |
| **System Health** | Admin / DevOps | Platform and data-layer integrity: which tables are connected, populated, erroring | DB introspection, per-table record counts, latency, coverage % | — | Business data |

## 9.1 "Why does this page exist?" — answered

| Page | Clear answer? | Note |
|---|:--:|---|
| CEO Intelligence | **Yes** | Strategic, cross-functional, decision-oriented |
| Executive Dashboard | **NO** | 13 of 25 features duplicate CEO Intelligence. Its genuinely unique assets are the canonical filter bar and the manager-tier role grant — both portable |
| Ops Command Center | **NO — as an Analytics page** | It is a valuable admin console filed under the wrong menu |
| CFO Dashboard | **Yes** | Distinct financial decision support |
| HR Dashboard | **Yes** | Operational people management |
| HR Benchmarking | **Yes** | Comparative framing is genuinely different |
| ERP Intelligence | **Yes** | The only true AI surface |
| System Health | **Yes**, but misnamed | It is database coverage, not system health |

---

# SECTION 10 — UI / UX Consistency Audit

The eight pages do **not** feel like one product. Five distinct visual systems are in play.

## 10.1 Consistency matrix

| Component | CEO | Exec | Ops | CFO | HR | HRBench | ERP-Intel | SysHealth | Consistent? |
|---|---|---|---|---|---|---|---|---|:--:|
| Styling method | 181 inline, **0 classNames** | dashkit + own CSS | own CSS | own CSS | 98 inline, dashkit | dashkit + own CSS | own CSS | 129 inline, **3 classNames** | **NO** |
| Dedicated stylesheet | **none** | `ExecutiveDashboard.css` | `AdminDashboard.css` | `CFODashboard.css` | **none** | `HRBenchmarkingDashboard.css` | `ERPIntelligence.css` | **none** | **NO** |
| Page background | `#f8f7ff` | dashkit | `#fff` | `#fff` | dashkit | `#fff` | **dark glass** | `#f1f5f9` | **NO** |
| Primary accent | `#6B3FDB` | `#6B3FDB` | `#6366f1` | `#6366f1` | `#6B3FDB` | `#6B3FDB` | mixed | `#6B3FDB` | **NO** |
| Card radius | 14 | dashkit | dashkit | dashkit | mixed | 11 | glass | 12 | **NO** |
| Card border | `1px #e9e4ff` + 4px left accent | dashkit | dashkit | dashkit | `#e9e4ff` | `#e5e7eb` + top accent | translucent | `#e9e4ff` | **NO** |
| KPI tile design | left-accent bar, 24px value | dashkit `dk-kpi`, icon chip | icon-left `adm-kpi` | gradient exec tiles | dashkit | top-accent + benchmark dot | glass card | icon + value | **NO — 6 designs** |
| Chart library | Recharts | Recharts | Recharts | Recharts | Recharts | **none (CSS bars)** | Recharts | **none** | Partial |
| Chart axis colour | `#9ca3af` | `#9ca3af` | default | `#9ca3af` | default | n/a | **`rgba(255,255,255,0.4)`** | n/a | **NO** |
| Tooltip style | default | custom white | default | default | custom white | n/a | **dark glass** | n/a | **NO** |
| Tab design | pill row, purple fill | none | segmented grey | period strip | segmented grey | none | underline switcher | none | **NO — 4 designs** |
| Filter idiom | 6M/CY/FY + year stepper | **DashboardFilterBar** | none | FY selector + YTD/Q1-Q4 | dept dropdown only | **DashboardFilterBar** | 7/30/90/180d pills | none | **NO — 5 idioms** |
| Loading state | spinner | `dk-kpi-sk` skeleton | `adm-shimmer` | "Refreshing..." text | `hr-shimmer` | `hrb-card-skel` | spinner | progress bar | **NO — 6 designs** |
| Empty state | centred grey text | `dk-empty` icon+copy | `EmptyState` component | `cfo-empty` | `EmptyState` component | `hrb-muted` | icon + CTA | issues panel | **NO — 6 designs** |
| Error state | none (silent) | none (silent) | toast | none (silent) | red banner | red banner | inline + Retry | full diagnostic row | **NO** |
| Refresh control | purple button | `dk-btn primary` | icon button | outline button | icon button | `dk-btn` | none | primary CTA | **NO** |
| Expand-chart control | `ChartExpandButton` | `DashCard expandable` | `ChartExpandButton` | own `Modal` | `ChartExpandButton` | none | none | none | Partial |
| Currency format | `Cr / L / K` 2dp | `Cr / L / K` 1dp | n/a | `Cr / L` 2dp | n/a | `toLocaleString` raw | `toLocaleString` raw | n/a | **NO — 4 formats** |
| Date format | `en-GB` `DD Mon YY` | `en-GB` `DD Mon YY` | relative "5m ago" | `en-GB` + `en-US` time | `en-GB` | none | none | `toLocaleTimeString` | Partial |
| Section heading | 18px/800 | `dk-title` | `adm-section-title` | `cfo-card-title` | 22px/700 | `hrb-rail-title` | `h3` | inline 20px/800 | **NO** |
| Responsive | fixed `repeat(5,1fr)` grids | fit-contract CSS | CSS grid | 12-col grid | fixed `repeat(6,1fr)` | rail + bands | flex | fixed `repeat(6,1fr)` | **NO** |

## 10.2 Specific inconsistencies

1. **ERP Intelligence is a different product.** Dark glassmorphism, white-on-dark axes, translucent cards — against seven light-theme pages. Highest-impact visual defect.
2. **Three pages have no stylesheet at all.** CEO Intelligence (181 inline style objects, zero classNames), System Health (129), HR Dashboard (98). Unthemeable, unmaintainable, and they cannot honour any future design-token change.
3. **Six KPI tile designs** for what is conceptually one component. `DashCard`/`dashkit.css` exists and is used by only 3 of 8 pages.
4. **Five filter idioms.** The canonical `useDashboardFilters` + `DashboardFilterBar` contract exists, is documented, and is used by only Executive Dashboard and HR Benchmarking.
5. **Currency formatting differs on adjacent tiles.** CEO prints `Rs 2.42 L`, Executive prints `Rs 2.4L` (no space), HR Benchmarking prints `Rs 56,250` unabbreviated.
6. **Fixed-column grids break below ~1280 px.** `repeat(5, 1fr)` on CEO's health cards, `repeat(6, 1fr)` on HR's KPI row and System Health's KPI row.
7. **Error states are absent on four pages.** CEO Intelligence, Executive Dashboard and CFO all swallow failures into empty states; a user cannot distinguish "no data" from "the API 500'd".

## 10.3 Assessment against instruction §13 ("do not create different design languages")

**Violated.** The module currently ships five design languages. Content differs correctly; presentation does not.

---

# SECTION 11 — Empty Page Audit

## EMPTY — EXPECTED (legitimate)

| Page / section | Reason | Copy quality |
|---|---|---|
| CEO Collections and AMC (AMC half) | `amc_contracts` empty | Good |
| CEO Sales — Target vs Achievement, Top/Bottom Performers | `sales_targets` empty | Adequate |
| CEO Executive — Expense Breakdown | `expense_claim_items` empty | Good — "No expense data" |
| CFO Expense Structure | Same | Good — names the period |
| CFO Cash Flow | `receipts`/`payments` empty | Good |
| HR Dashboard — Top Performers | `performance_reviews` empty | Good |
| HR Bench — Appraisal Distribution | Same | **Excellent** — "No appraisal data for the selected period" |
| HR Bench — Women in Leadership | Genuinely 0 matches | **Excellent** — explains the designation match |
| CEO Vendors — Score column | `vendor_scorecards` empty | Adequate ("—") |
| ERP-Intel — Prescriptive (when quiet) | No triggers fired | Good |

## EMPTY — BUG (data exists, UI or API is broken)

| Page / section | Real data available | Why it is empty |
|---|---|---|
| CEO Ops — On Leave Today | **769 rows** in `leave_requests` | Queries `leaves` (1 row) |
| CEO Workforce — On Leave | Same | Queries `leave_applications` (4 rows) |
| CFO — pending-leave alert | **159 pending** | Queries `leaves` |
| CEO Ops — Timesheets Pending | 1 timesheet | `status='submitted'` vs `'approved'` |
| CEO Collections — Escalations | 15 tickets exist | `priority='critical'` never matches |
| HR Bench — Offer Acceptance | 3 offers, 2 accepted | Wrong table |
| ERP-Intel — Attrition Risk chart | 34 employees, 2 on Notice | Status mismatch |
| ERP-Intel — anomaly chips | 35 invoices, 210 attendance rows | Missing column + status casing |
| HR Dash — Attrition Trend | 2 employees on Notice | Status mismatch |
| CEO Customers — Margin column | 3 projects with budgets | `project_cost_summary` never populated by the cost-rollup engine |

## EMPTY — INCOMPLETE (designed, not implemented)

| Page / section | Gap |
|---|---|
| CFO — 5 of 12 financial ratios | Debt/Equity, ROE, ROA, Inventory Turns, Interest Coverage — no balance sheet, no equity, no COGS, no debt register |
| Ops Command Center — Storage KPI | "Usage not available" |
| CEO Business Lines | Taxonomy never wired; `product_line_id` unset on every project |
| CEO Strategic Alerts — acknowledgement | Client-only; no persistence table |
| System Health — auto-refresh, export, alert thresholds | Not built |
| HR Dashboard — period filter | Backend supports it; UI does not send it |

## EMPTY — UNNECESSARY

| Page / section | Reason |
|---|---|
| CEO Sales — Bottom Performers | Renders the same six rows as Top Performers on a small team |
| CEO Vendors — Critical Components | Mock data; provides no information about this business |
| Ops Command Center — System Health KPI + card | Asserts health without checking |

## Pages that render blank on first load

| Page | Behaviour |
|---|---|
| **System Health** | Header and a button only, until "Run Connection Test" is clicked. By design, but a first-time user sees an empty page. |
| **ERP Intelligence, LLM Agent tab** | Suggestion chips and an input; no result until a query is submitted. Reasonable. |

**No page white-screens.** No `ErrorBoundary` trips were found in any code path.

---

# SECTION 12 — Broken Feature Audit

| ID | Feature | Page | Type | Root cause | Severity |
|---|---|---|---|---|---|
| BF-01 | 5 Executive Alert action buttons | CFO | Dead drill-down | `ALERT_ACTION_PAGE` keys do not intersect the backend's action strings | **P0** |
| BF-02 | Department filter | HR Dashboard | Dead filter | No query params sent on any of 17 calls | **P0** |
| BF-03 | Business Lines tab (48 values) | CEO | Dead feature | Hardcoded taxonomy vs `product_lines` | **P0** |
| BF-04 | Projects On-Track KPI | CEO | Impossible query | `status='on-track'` forbidden by constraint | **P0** |
| BF-05 | Attrition Rate | CEO x2, Exec, HR Dash | Impossible query | Status-value mismatch | **P0** |
| BF-06 | Turnover Rate | HR Bench | Impossible query | Same | **P0** |
| BF-07 | Offer Acceptance Rate | HR Bench | Wrong source | `candidates.status` never written | **P0** |
| BF-08 | Training Effectiveness | HR Bench | Missing table | `assessment_submissions` | **P0** |
| BF-09 | Cost per Hire | HR Bench | Missing table | `recruitment_costs` | **P0** |
| BF-10 | Open Tickets 13 vs 15 | CEO (two tabs) | Casing | `('Resolved','Closed')` vs lowercase | **P0** |
| BF-11 | Escalations KPI | CEO | Casing | `priority='critical'` | **P1** |
| BF-12 | Customer health `tScore` | CEO | Casing | Same — pins 25 of 100 points | **P1** |
| BF-13 | Timesheets Pending tile | CEO | Casing | `'submitted'` vs `'approved'` | **P1** |
| BF-14 | On Leave Today (x3) | CEO x2, CFO | Wrong table | `leaves` / `leave_applications` vs `leave_requests` | **P1** |
| BF-15 | Attrition Risk chart | ERP-Intel | Impossible query | Status mismatch | **P1** |
| BF-16 | Invoice Outlier anomaly | ERP-Intel | Missing column | `invoices.client_name` | **P1** |
| BF-17 | Low Attendance anomaly | ERP-Intel | Casing | `e.status='active'` | **P1** |
| BF-18 | `/ai/chat` low-stock answer | AIAssistant | Missing column | `inventory_items.name` | **P1** |
| BF-19 | `/ai/chat` headcount answer | AIAssistant | Casing | `status='active'` | **P1** |
| BF-20 | AI Chat tab | ERP-Intel | Unconfigured | No valid `OPENAI_API_KEY` -> 503 | **P1** |
| BF-21 | LLM Agent free-text | ERP-Intel | 2-pattern matcher | Everything else returns a fallback with a typo | **P1** |
| BF-22 | Strategic-alert acknowledgement | CEO | No persistence | Client `Set` only | **P1** |
| BF-23 | AR vs Outstanding Rs 5.6 L gap | CEO / CFO | Orphan `'Sent'` status | Two enumerations | **P1** |
| BF-24 | Revenue per Employee 48x | HR Bench | Missing status filter | Counts unpaid invoices | **P1** |
| BF-25 | HR Overview vs Analytics attrition | HR Dash | Two formulas on one page | Frontend vs backend | **P1** |
| BF-26 | Compa-ratio definition | HR Bench | Wrong formula | avg/median, not actual/midpoint | **P2** |
| BF-27 | Department Strength "Target" bar | HR Dash | Fabricated | `headcount * 1.1` | **P2** |
| BF-28 | Rate-limit counter resets | ERP-Intel | In-memory `Map` | Lost on restart | **P2** |
| BF-29 | Empty-state CTA to IntegrationsHub | ERP-Intel | Wrong guidance | Data is local, not integrated | **P2** |
| BF-30 | `queryERPIntelligence` typo | ERP-Intel | Copy | "Engineeing" | **P3** |
| BF-31 | `'200+' tables` fallback | SysHealth | Stale literal | Real count 551 | **P3** |
| BF-32 | Stale e2e specs target `/CeoDashboard` | tests | Deleted route | 2 spec files | **P2** |

**No broken navigation found.** All 30 `setPage()` targets across the module resolve to real routes.

---

# SECTION 13 — AI Audit

| Feature | Purpose | Input | Source | Model / logic | Output | Live? | Cached? | Duplicated? | Verdict |
|---|---|---|---|---|---|:--:|:--:|---|---|
| **CEO "AI Insights"** | Strategic guidance | 3 counts | `parties`, `invoices`, `vendors` | Template strings | 25 bullets, 5 categories | **4 of 25** | No | — | **REPACKAGED — not intelligence.** `margin_risks` is 100% canned. `growth_opportunities` asserts "Top 5 customers show 40%+ YoY growth" without querying growth, and "Pipeline conversion at ~35%" restating the hardcoded coefficient. The panel claims "no hardcoded or fabricated values." |
| **GPT Executive Brief** | Narrative KPI summary | dashboard payload | client-supplied | OpenAI if keyed, else `narrateKpis()` rules | Prose | Yes | No | — | **HONEST** — degrades gracefully, invents no numbers |
| **Executive Alerts (CEO)** | Rule signals | attrition, growth, pipeline, targets, at-risk | live | `insightsEngine.js`, 8 rules, all `!= null` guarded | Up to 8 alerts | Yes | No | Overlaps Exec Dash | **GENUINE** — self-suppresses on missing inputs. 2 of 8 rules can never fire (attrition is always 0) |
| **AI Business Insights (Exec)** | Rule signals | revenue trend, attrition, approvals, pipeline, margin | live | in-file rules | Max 4 | Yes | No | **Overlaps the above** | PARTIAL-DUPLICATE; one literal `22` fallback |
| **HR Insights** | HR rule signals | attrition, hires, pending leaves | live | 3rd client engine + `/analytics/insights/hr` | 3-4 items | Yes | No | Overlaps both | PARTIAL-DUPLICATE |
| **Anomaly detection** | Outlier surfacing | invoices, attendance, POs, payroll, tests | live | mean +/- 2.5 sigma, thresholds | Ranked list | **2 of 5 broken** | No | — | **PARTIALLY BROKEN**, and none of the 5 detectors are company-scoped |
| **Cash-flow forecast** | 7-180 day liquidity | open invoices/bills by `due_date` | live | Aggregation, no model | Daily series | Yes | 60 s | Overlaps CFO | **HONEST but mislabelled** — a due-date roll-up, not a forecast |
| **Attrition prediction** | Dept risk | `employees` | live | Ratio | Bar chart | **BROKEN** | No | Overlaps 4 attrition KPIs | **BROKEN** |
| **Sales forecast** | Pipeline outlook | `sales_orders` | live | Weekly grouping | Area chart | Yes | No | — | **MISLABELLED** — plots history only, no projection |
| **Inventory demand** | Stock-out risk | `stock_ledger` velocity + ROP | live | `dailyDemand x leadTime + safetyStock` | Ranked items | Yes | No | — | **GENUINE** — mirrors the EOQ planner |
| **Lead priority** | Deal ranking | `opportunities` | live | Weighted score + top driver | Ranked queue | Yes | No | — | **GENUINE** — explainable |
| **Prescriptive** | Recommended actions | inventory, AR, revenue trend | live | Threshold rules with rationale + impact | Action cards | Yes | No | — | **BEST AI FEATURE** — live, scoped, explainable, actionable |
| **NL query (`/ai/query`)** | Ask the ERP | free text | live | LLM if keyed, else 2 regexes | Answer + data | Partial | 60 s | — | **INCOMPLETE** |
| **AI Chat (`/ai/llm-chat`)** | Assistant | messages + leave/role context | live | `gpt-4o-mini` | Reply | **No key** | No | — | **UNAVAILABLE** |
| **Smart search (`/ai/nav-search`)** | Nav assist | query | routes | Fuzzy match | Suggestions | Yes | No | — | Out of scope, works |

## 13.1 Does each AI feature add intelligence, or repackage the dashboard?

| Adds real intelligence | Repackages | Broken / unavailable |
|---|---|---|
| Prescriptive recommendations | CEO "AI Insights" (84% canned) | Attrition prediction |
| Inventory demand forecasting | Cash-flow "forecast" | AI Chat (no key) |
| Lead priority scoring | Sales "forecast" (history only) | 2 of 5 anomaly detectors |
| Anomaly detection (the 3 working detectors) | 3 overlapping rule engines | NL query beyond 2 patterns |
| GPT Executive Brief | | |

**Confidence scores:** none of the 15 AI features expose a confidence or uncertainty measure. **Explainability:** only Prescriptive and Lead Priority state *why*. **Refresh:** all on page load; nothing is scheduled except the two cron jobs (`kpiDigest.cron.js`, `anomalyDetection.cron.js`) that reuse `narrateKpis()` and `detectAnomalies()`.

---

# SECTION 14 — Cross-Module Connectivity

| Source module | Consumed by | Via | Tables | Transformation | Health |
|---|---|---|---|---|---|
| **Finance / AR** | CEO (Exec, Collections), CFO, Exec Dash, HR Bench | `/ceo-intelligence/*`, `/dashboard/revenue`, `/dashboard/cfo`, `/analytics/hr-benchmarks` | `invoices`, `bills`, `receipts`, `payments`, `expense_claims`, `expense_claim_items` | SUM by status + date window | **DEGRADED** — 4 different revenue window/status combinations |
| **CRM** | CEO (Customers, Sales, Vendors), Exec Dash | `/ceo-intelligence/customers`, `/analytics/sales`, `/dashboard/sales` | `parties`, `opportunities`, `crm_pipeline_stages`, `leads` | health scoring, pipeline sums | **GOOD** |
| **Sales** | CEO Sales tab | `/sales-command-center/*` | `sales_orders`, `sales_targets` | target vs achieved | **EMPTY** — `sales_targets` unpopulated |
| **HRM** | CEO Workforce, Exec, HR Dash, HR Bench, ERP-Intel | `/analytics/*`, `/dashboard/workforce` | `employees`, `leave_*`, `attendance` | counts, rates, distributions | **DEGRADED** — status casing breaks every attrition metric; 4 leave tables |
| **Recruitment** | HR Dash, HR Bench | `/analytics/offer-acceptance`, `/time-to-hire`, `/hr-benchmarks` | `candidates`, `offer_letters`, `job_openings` | acceptance/fill rates | **CONFLICTED** — two sources, two answers |
| **Performance** | HR Dash, HR Bench | `/analytics/top-performers`, `/satisfaction`, `/hr-benchmarks` | `performance_reviews` | avg rating, banding | **EMPTY** — 0 rows |
| **Projects** | CEO (Exec, Projects, Business Lines, Ops), Exec Dash | `/ceo-intelligence/projects`, `/manifest`, `/dashboard/operations` | `projects`, `project_cost_summary`, `project_cost_lines`, `product_lines` | margin, health, delay | **BROKEN** — cost summary empty; `product_line_id` unset; `'on-track'` impossible |
| **Procurement** | CEO Vendors, Exec Dash | `/ceo-intelligence/vendors`, `/dashboard/top-vendors` | `vendors`, `purchase_orders`, `goods_receipt_notes`, `vendor_scorecards` | spend, OTD, scorecard | **PARTIAL** — scorecards empty |
| **Quality** | CEO (Customers, Vendors, Alerts) | `/ceo-intelligence/*` | `ncr_reports`, `quality_tests`, `test_runs` | open-NCR counts | **GOOD** |
| **Service Desk** | CEO (Customers, Collections, Ops) | `/ceo-intelligence/*`, `/dashboard/operations` | `support_tickets` | open/escalated counts | **CONFLICTED** — 13 vs 15 |
| **Inventory** | CEO Ops, CFO alerts, ERP-Intel | `/dashboard/operations`, `/ai/predict/inventory`, `/ai/prescriptive` | `inventory_items`, `stock_ledger` | ROP, velocity | **PARTIAL** — `reorder_level` vs `reorder_point` used inconsistently |
| **Production** | — | — | `production_orders` | — | **NOT CONNECTED** — no Analytics surface reads it |
| **Timesheets** | CEO Ops | `/dashboard/operations` | `timesheets` | pending count | **BROKEN** — status casing |
| **Travel** | CEO Ops | `/travel/analytics/*` | `travel_requests`, `expense_claims` | spend by employee/project | **GOOD** — 284 rows |
| **Engineering / R&D** | — | — | `eng_development`, `rd_artifacts` | — | **NOT CONNECTED** |
| **Compliance** | HR Dash | `/analytics/compliance-alerts` | `employee_compliance_docs` | expiry alerts | **GOOD** |
| **Maintenance / IoT** | — | — | `device_telemetry`, `device_alerts` | — | **NOT CONNECTED** |
| **Marketing** | — | — | `campaigns` | — | **NOT CONNECTED** |
| **Logistics / Warehouse** | — | — | — | — | **NOT CONNECTED** |

## 14.1 Missing integrations worth having

| Gap | Where it would go | Value |
|---|---|---|
| **Production throughput / OEE** | CEO Operations tab | A manufacturing ERP with no production metric on the executive dashboard |
| **Quality cost (cost of poor quality)** | CEO Projects / CFO | NCRs are counted but never costed |
| **Service SLA attainment / MTTR** | CEO Collections and AMC | Ticket counts exist; SLA performance does not |
| **Procurement savings vs budget** | CFO | PO spend is shown; savings are not |
| **Order backlog / book-to-bill** | CEO Executive | The single most important manufacturing executive KPI is absent |
| **IoT fleet uptime** | CEO Operations | Telemetry exists and is unused |

---

# SECTION 15 — Filter Validation

Every filter in the module, tested by tracing the request path from control to SQL binding.

| Page | Filter | Sends a param? | Changes the query? | Verdict |
|---|---|:--:|:--:|---|
| CEO Intelligence | Period 6M / CY / FY | **Yes** `?period=` | **Yes** | **WORKS** — but affects only the Revenue Trend chart; the other 19 calls are unfiltered |
| CEO Intelligence | Year stepper | **Yes** `?year=` | **Yes** | **WORKS** (CY/FY only) |
| CEO Intelligence | YoY compare | **Yes** `?compare=true` | **Yes** | **WORKS** |
| CEO Intelligence | Customer sub-nav | No | Client array switch | By design |
| CEO Intelligence | Vendor sub-nav | No | Client array switch | By design |
| CEO Intelligence | Project view x5 | No | Client array switch | By design |
| CEO Intelligence | Alert severity filter | No | Client filter | By design |
| Executive Dashboard | **DashboardFilterBar** period | **Yes** `?period=/from=/to=` | **Yes** on `/dashboard/revenue` and `/finance/reports/profit-loss` | **WORKS** — canonical. Alerts/approvals/headcount deliberately unfiltered and documented |
| Executive Dashboard | Custom date range | **Yes** | **Yes** | **WORKS** |
| Ops Command Center | User search | No | Client filter | By design |
| Ops Command Center | *(no analytics filter)* | — | — | **MISSING** |
| CFO Dashboard | FY selector | **Yes** `?fyStart=` | **Yes** | **WORKS** |
| CFO Dashboard | Period YTD / Q1-Q4 | **Yes** `?period=` | **Yes** | **WORKS** |
| CFO Dashboard | — | — | — | Cash balance ignores the period (all-time `receipts - payments`) — **inconsistent** |
| **HR Dashboard** | **Department dropdown** | **NO** | **NO** | **BUG** — `hrAnalyticsApi.js` sends no params on any of its 17 calls; only `deptWorkforce` is filtered client-side, affecting 1 of 18 widgets |
| **HR Dashboard** | *(no period filter)* | — | — | **MISSING** — backend `hrFrags()` supports it |
| HR Benchmarking | **DashboardFilterBar** period | **Yes** | **Yes** — every period-sensitive subquery | **WORKS** — and echoes `period_label` back |
| ERP Intelligence | Forecast horizon 7/30/90/180d | **Yes** `?days=` | **Yes** | **WORKS** |
| ERP Intelligence | Suggested-query category | No | Client | By design |
| System Health | *(none)* | — | — | N/A |

## 15.1 Filters requested by §15 that do not exist anywhere in the module

Location · Employee · Project · Customer · Vendor · Product · Business unit · Status · Region.

Only **Period** (5 idioms) and **Department** (1, broken) are implemented. Given `projects.zone`, `projects.site_city`, `projects.site_state`, `employees.department`, `parties.city`/`state` and `product_lines` all exist in the schema, this is a substantial gap.

---

# SECTION 16 — Drill-down Validation

| Source | Destination | Route resolves? | Filters passed? | Verdict |
|---|---|:--:|:--:|---|
| CEO Ops tile: Active Projects | `ProjectsDashboard` | Yes | **No** | Works, no context |
| CEO Ops tile: Open Tickets | `AllTickets` | Yes | **No** | Works, no context |
| CEO Ops tile: Pending Invoices | `InvoicesNew` | Yes (curated key) | **No** | Works, no context |
| CEO Ops tile: Overdue Tasks | `Projects` | Yes | **No** | Works, no context |
| CEO Ops tile: Timesheets Pending | `Timesheets` | Yes | **No** | Works, no context |
| CEO Ops tile: Open Recruitments | `RecruitmentDashboard` | Yes | **No** | Works, no context |
| CEO Ops tile: Low Stock | `InventoryDashboard` | Yes | **No** | Works, no context |
| CEO Ops tile: Tasks Done MTD | `Projects` | Yes | **No** | Works, no context |
| CEO Ops tile: On Leave Today | `AllLeaves` | Yes | **No** | Works, no context |
| CEO red-alert chip | War Room tab | Yes | n/a | **WORKS** |
| CEO Customers: Convert upsell | `POST` -> opportunity | Yes | n/a | **WORKS** — real write |
| Exec Dash: 6 KPI tiles | Finance / Employees / Sales / Projects | Yes | **No** | Works, no context |
| Exec Dash: quick-nav x6 | 6 modules | Yes | n/a | **WORKS** |
| Exec Dash: View-all x5 | 5 modules | Yes | **No** | Works, no context |
| Ops: Audit Trail / Settings / SystemHealth | 3 pages | Yes | n/a | **WORKS** |
| **CFO: 5 Executive Alert buttons** | — | **N/A** | — | **BROKEN — every one is a no-op** |
| HR Dash: quick actions x6 | 6 HR pages | Yes | n/a | **WORKS** |
| HR Dash: Top Performer row | `EmployeeProfile` | Yes | **Yes** — via `sessionStorage` | **WORKS** — the only context-passing drill-down in the module |
| ERP-Intel: Configure Integrations | `IntegrationsHub` | Yes | n/a | Resolves, but **misleading** |
| HR Bench | *(none)* | — | — | **MISSING** — no drill-down at all |
| System Health | *(none)* | — | — | **MISSING** |

**Summary:** 30 of 31 navigations resolve; **1 class (5 buttons) is dead**. Only 1 of 30 passes context. Clicking "6 delayed projects" lands on an unfiltered project list.

---

# SECTION 17 — Security and Permissions

## 17.1 Backend guards

| Router | Endpoints | Guard | Verdict |
|---|---:|---|---|
| `/ceo-intelligence` | 10 | `verifyToken` + `requirePermission` on **all 10** | **GOOD** |
| `/system-health` | 2 | `verifyToken` + `allowRoles('admin','super_admin')` | **GOOD** |
| **`/analytics`** | **27** | `verifyToken` only | **GAP** |
| **`/dashboard`** | **26** | `verifyToken` only | **GAP** |
| **`/ai`** | **19** | `verifyToken` only | **GAP** |

**72 endpoints behind the Analytics & AI pages carry no authorisation check beyond "is logged in".**

## 17.2 Sensitive data reachable by any authenticated employee

| Endpoint | Exposes |
|---|---|
| `GET /api/v1/analytics/salary-bands` | Salary band distribution across the company |
| `GET /api/v1/analytics/hr-benchmarks` | Average, **median, P25 and P75 salary**; gender split; leadership gender split |
| `GET /api/v1/analytics/top-performers` | **Named employees with performance ratings and departments** |
| `GET /api/v1/analytics/ceo/kpis` | Company revenue, ARR, pipeline, headcount |
| `GET /api/v1/dashboard/cfo` | **Full P&L**: revenue, opex, gross/net profit, EBITDA, cash, AR, AP, DSO, DPO, burn rate, runway |
| `GET /api/v1/dashboard/revenue` | Monthly revenue series |
| `GET /api/v1/dashboard/top-customers` / `top-vendors` | Named customers and vendors with revenue and spend |
| `GET /api/v1/analytics/attrition` / `headcount` / `gender` | Workforce composition |
| `GET /api/v1/ai/anomalies` | Named employees with attendance percentages; invoice outliers |

The UI gating in `menuCatalog.js` is well-designed — hr sees only its two pages, finance only CFO, manager only Executive — but it is client-side and does not constrain the API.

## 17.3 Multi-tenant scoping

Confirmed via `information_schema`: `invoices`, `projects`, `opportunities`, `expense_claims`, `amc_contracts`, `support_tickets`, `vendors`, `parties`, `employees` and 13 others **all have `company_id`**. The comment at `dashboard.controller.js:77` asserting they do not is **stale**.

| Unscoped query | Location | Leaks |
|---|---|---|
| `computeRevenueMetrics(_company_id)` | `metricsEngine.js:171` | Revenue, ARR, MRR, growth |
| `computeSalesKPIs(_company_id)` | `metricsEngine.js:205` | Pipeline, conversion, avg deal |
| `/analytics/ceo/kpis` projects subquery | `analytics.routes.js:412` | Active + on-track project counts |
| `revSql()` in `/dashboard/revenue` | `dashboard.controller.js:84` | Monthly revenue series |
| `getDashboardExpenses` | `dashboard.controller.js:171` | Expense categories |
| CFO `expByCatRows` | `dashboard.controller.js:1315` | Expense breakdown |
| `/dashboard/operations` — projects, invoices, tasks, timesheets | 4 of 9 subqueries | Cross-tenant counts |
| `/analytics/productivity` | `analytics.routes.js:300` | Task completion |
| `detectAnomalies()` — all 5 detectors | `anomalyDetector.js` | Invoices, employees, POs, payroll, tests |
| `getPredictiveCashFlow()` | `aiPayroll.service.js:306` | Invoice/bill balances |

**Latent, not currently exploitable:** the database holds exactly **1 company** and all rows carry `company_id = 1`. These become live leaks the moment a second tenant is provisioned. Note that `metricsEngine`'s cache **key** includes `company_id` while the **query** does not — so tenant A's revenue would be cached under tenant B's key.

## 17.4 Frontend role gates

| Page | `RequireRole` |
|---|---|
| Executive Dashboard | `['super_admin','admin','manager']` |
| **The other 7** | **none** |

`HRDashboard` (`HR_ROLES.has(String(role))`) and `AdminDashboard` (`role === 'super_admin'`) both test a **single role string**, which conflicts with the many-to-many `user_roles` model used elsewhere; a user holding `hr` as a secondary role will be mis-gated.

---

# SECTION 18 — Performance

| Page | API calls on load | Duplicate calls | Payload risk | Notes |
|---|---:|---|---|---|
| **CEO Intelligence** | **21** (20 parallel + 1 revenue) | `/analytics/sales` also called by the Sales panel; `/dashboard/sales` overlaps `/analytics/sales` | `/ceo-intelligence/customers` returns `customers`, **`all_customers`**, `health_distribution`, `growth_leaders`, `at_risk` — the full list is sent even though only 20 rows render | Heaviest page in the app. All 20 fire on **every** load regardless of the active tab. `AbortController` correctly cancels stale loads. |
| Executive Dashboard | 12 | — | small | `Promise.allSettled` + abort |
| Ops Command Center | 3 + ManagerDashboard's 10 = **13** | — | `/admin/users` unpaginated | Team Ops tab loads even when hidden |
| CFO Dashboard | 2 | — | moderate | 17 parallel subqueries server-side; efficient |
| HR Dashboard | 5 (Overview) + 15 (Analytics, lazy) | `/analytics/headcount` and `/attrition` also on CEO/Exec | `/employees` returns **every employee** to compute 6 client-side alerts | Lazy Analytics tab is good |
| HR Benchmarking | **1** | — | small | **Best-performing page.** 14 parallel subqueries in one endpoint |
| ERP Intelligence | 7 | — | small | Forecast refetches on horizon change |
| System Health | 1 (on demand) | — | 551 rows + exact re-counts | Zero-estimate re-count loops in batches of 100 — sound |

## 18.1 Specific performance findings

1. **CEO Intelligence fires 20 requests for a tab the user may never open.** The Business Lines, Vendors, Projects and Collections payloads are all fetched on mount. Lazy-loading per tab (as HR Dashboard already does) would cut initial load by roughly 60%.
2. **`all_customers` is sent and discarded.** `/ceo-intelligence/customers` returns both `customers` (20) and `all_customers` (every row). Only the first is rendered.
3. **`/employees` full-table fetch on HR Dashboard Overview** purely to compute probation and anniversary alerts client-side. That belongs in SQL.
4. **`metricsEngine` 60 s cache is keyed by `company_id` but the queries ignore it** — correct behaviour today with one tenant, wrong the moment there are two.
5. **`/dashboard/*` sets `Cache-Control: private, max-age=60`** (15 s for live-kpis). Good.
6. **No pagination anywhere.** `/admin/users`, `/employees`, `/ceo-intelligence/customers` all return unbounded sets.
7. **No slow queries observed** — the database is small (551 tables, low row counts). Performance under production volume is **untested and untestable at present**.

---

# SECTION 19 — Automated Testing

## 19.1 Existing coverage

| Suite | Analytics coverage |
|---|---|
| `tests/suites/04-dashboard.spec.ts` | CEO Intelligence renders (P0) + tab count >= 2 (P1); render-only smoke for Executive, HR, Admin, ERP Intelligence — **and `/CeoDashboard`, a route deleted on 17 Aug 2026** |
| `tests/suites/07-dashboard-reconciliation.spec.ts` | CEO Intelligence reconciliation checks |
| `tests/suites/08-route-discovery.spec.ts` | Lists `/CEOIntelligenceDashboard`, `/CeoDashboard`, `/ExecutiveDashboard`, `/HRDashboard`, `/AdminDashboard`, `/ERPIntelligence`, `/SystemHealth`, `/HRAnalyticsDashboard` |
| `tests/suites/14-dashboard-validation.spec.ts` | CEO Intelligence + HR Dashboard + `/CeoDashboard` (stale) |
| `tests/suites/00-api-health.spec.ts` | `/analytics` root only, `rootGetOptional` |
| `frontend/src/__tests__/smoke.HR.test.jsx` | Only frontend unit test touching any of these pages |
| `backend/src/__tests__/dashboardFilters.test.js` | Filter-preset resolution |

## 19.2 Not covered at all

- **CFO Dashboard** — no e2e, no unit test. The page with the most fabricated data has zero coverage.
- **HR Benchmarking** — none.
- **System Health** — none.
- **All 9 CEO Intelligence panels** — none.
- **Every KPI value** — no test asserts a number against the database.
- **Filters** — no test proves a filter changes a result.
- **Permissions** — no test proves a non-admin cannot fetch `/dashboard/cfo`.
- **Duplication** — no test detects that two pages disagree.

## 19.3 Tests that would have caught the P0 defects

| Defect | Test that catches it |
|---|---|
| Open Tickets 13 vs 15 | Cross-page KPI reconciliation: assert every KPI with the same name returns the same value |
| Offer Acceptance 66.7% vs 0% | Same |
| AR vs Outstanding Rs 5.6 L | Same |
| Status-casing bugs (7 of them) | Schema contract test: for each enum-like column, assert every literal used in application SQL exists in `SELECT DISTINCT` |
| `assessment_submissions` / `recruitment_costs` missing | Static scan of SQL for table names, cross-checked against `information_schema.tables` |
| `invoices.client_name` missing | Same, for columns |
| CFO dead alert buttons | Contract test: assert every backend `action` string is a key in `ALERT_ACTION_PAGE` |
| HR department filter | Network assertion: change the filter, assert the outbound request URL changed |
| Fabricated CFO series | Lint rule banning numeric literals multiplied into a rendered chart series |

## 19.4 Live smoke run

Not executed. Running Playwright requires the dev server plus a seeded login, and the memory note *"dev server needs restart — ask user"* applies. **This is the one item in the audit brief I did not complete, and it is called out here rather than glossed over.** Everything else in this report was verified by source inspection plus direct database queries. Say the word and I will start the stack and run suites 04, 07 and 14 with a fresh reconciliation spec.

---

# SECTION 20 — Console and Network Audit (static analysis)

Predicted from source inspection; a live browser pass is pending (see §19.4).

## 20.1 Expected console output

| Severity | Source | Note |
|---|---|---|
| **Server error log** | `[analytics] sq1 failed: relation "assessment_submissions" does not exist` | Every HR Benchmarking load |
| **Server error log** | `[analytics] sq1 failed: relation "recruitment_costs" does not exist` | Every HR Benchmarking load |
| **Silent (swallowed)** | `column "client_name" does not exist` | `anomalyDetector.js` `catch(_){}` — never logged |
| **Silent (swallowed)** | `column "name" does not exist` on `inventory_items` | `/ai/chat` `.catch(() => ({rows:[]}))` |
| React warning | Recharts `<Cell key={i}>` index keys in 6 places | Cosmetic |
| No errors expected | — | No `ErrorBoundary` path reachable; every fetch is `allSettled`/`catch`-guarded |

## 20.2 Expected network results

| Status | Endpoint | Condition |
|---|---|---|
| 200 | 39 of 41 endpoints | Normal |
| **503** | `POST /ai/llm-chat` | No valid `OPENAI_API_KEY` — AI Chat tab |
| **403** | `/finance/reports/profit-loss` | For `manager` on Executive Dashboard — **handled gracefully**, tile is dropped |
| **403** | `/system-health/db-tables` | For non-admins — surfaces as one "Auth" row |
| **Duplicate** | `/analytics/sales` | Fetched by CEO Intelligence and again by `RevenueForecastPanel` |
| **Overlapping** | `/dashboard/sales` + `/analytics/sales` | Two pipeline sources on one page load |
| **Over-fetch** | `/ceo-intelligence/customers` | Returns `all_customers` alongside the 20 that render |
| **Over-fetch** | `/employees` | Full table on HR Dashboard Overview |

**No 4xx/5xx is surfaced to the user on any page except ERP Intelligence and HR Benchmarking.** Everywhere else a failed call is indistinguishable from an empty result — the single biggest observability gap in the module.

---

# SECTION 21 — Database Validation

Per §25, proving the provenance of every headline number. All values below were read directly from the `Pulse` database on 18 Aug 2026.

| Page | KPI | API | Backend query | Table.field | Result |
|---|---|---|---|---|---:|
| CEO | Revenue YTD | `/ceo-intelligence/executive-summary` | `SUM(total_amount) WHERE status='paid' AND invoice_date >= '2026-04-01' AND company_id=1` | `invoices.total_amount` | **Rs 2,41,900** |
| CEO | Outstanding | same | `SUM WHERE status IN ('overdue','pending')` | `invoices.total_amount` | **Rs 46,26,400** (6 overdue Rs 22,72,800 + 8 pending Rs 23,53,600) |
| CEO | Pipeline | same | `SUM(expected_value) WHERE deleted_at IS NULL AND stage NOT IN (closed...)` | `opportunities.expected_value` | **Rs 42,59,009** (7 of 8 rows) |
| CEO | Cash Position | same | `revenueYTD - SUM(bills.balance WHERE pending/overdue)` | `invoices` + `bills` | Rs 2,41,900 - Rs 1,13,000 |
| CEO | ARR | `/analytics/ceo/kpis` | `SUM(contract_value) WHERE status='active'` | `amc_contracts` | **Rs 0** (0 rows) |
| CEO | Active Customers | exec-summary | `COUNT(DISTINCT customer_id)` | `invoices.customer_id` | **2** |
| CEO | Total Customers (Customers tab) | `/ceo-intelligence/customers` | `parties` join `invoices` `HAVING COUNT(i.id)>0` | `parties.id` | **2** of 10 customer parties |
| CEO | Projects On-Track | `/analytics/ceo/kpis` | `COUNT(*) WHERE LOWER(status)='on-track'` | `projects.status` | **0 of 3** — impossible by constraint |
| CEO | Open Tickets (Ops) | `/dashboard/operations` | `COUNT WHERE status NOT IN ('Resolved','Closed')` | `support_tickets.status` | **13** |
| CEO | Open Tickets (Collections) | `/ceo-intelligence/service-amc` | `COUNT WHERE status NOT IN ('resolved','closed')` | `support_tickets.status` | **15** |
| CEO | Escalations | same | `priority='critical' OR status='escalated'` | `support_tickets.priority` | **0** — priorities are High/Medium/Low |
| CFO | Revenue YTD | `/dashboard/cfo` | `SUM WHERE LOWER(status)='paid' AND created_at BETWEEN 2026-04-01 AND today` | `invoices.total_amount` | **Rs 2,41,900** |
| CFO | Accounts Receivable | same | `SUM WHERE status NOT IN ('paid','cancelled')` | `invoices.total_amount` | **Rs 51,86,400** |
| CFO | Cash and Equivalents | same | `SUM(receipts.amount) - SUM(payments.amount)` | `receipts`, `payments` | **Rs 0** (both empty) |
| CFO | Net Profit | same | `(revenue - opex) x 0.78` | derived | **fabricated coefficient** |
| CFO | EBITDA | same | `netProfit + opex x 0.05` | derived | **fabricated coefficient** |
| Exec | Revenue YTD | `/dashboard/revenue` | `SUM WHERE LOWER(status)='paid'` grouped by `created_at` month | `invoices.total_amount` | **Rs 2,41,900** |
| HR Dash | Headcount | `/analytics/headcount` | `COUNT(*)` | `employees` | **34** |
| HR Dash | Active | same | `LOWER(status) IN ('active','probation')` | `employees.status` | **32** |
| HR Dash | Attrition | `/analytics/attrition` | `status IN ('inactive','resigned','terminated','left')` last 12m | `employees.status` | **0.00%** — no such status exists |
| HR Dash | Offer Acceptance | `/analytics/offer-acceptance` | `offer_status IN ('sent','accepted','declined')` vs `='accepted'` | `offer_letters.offer_status` | **2/3 = 66.67%** |
| HR Bench | Offer Acceptance | `/analytics/hr-benchmarks` | `candidates.status IN ('offered','accepted','joined','declined')` | `candidates.status` | **0/0 = 0%** — all 3 rows are `'active'` |
| HR Bench | Turnover Rate | same | `departed / active` | `employees.status` | **0/32 = 0.0%** |
| HR Bench | Revenue per Employee | same | `SUM(total_amount) / 32` — **no status filter** | `invoices.total_amount` | **Rs 1,16,18,500 / 32 = Rs 3,63,078** |
| HR Bench | Gender Female | same | `female / COUNT(*) active` | `employees.gender` | **2/32 = 6.3%** (only 4 of 32 have gender set) |
| HR Bench | Compa-Ratio | same | `avg_salary / median_salary` | `employees.basic_salary` | **56,250/52,500 = 1.07** (5 of 32 have salary set) |
| HR Bench | Training Effectiveness | same | `AVG(score) FROM assessment_submissions` | **table missing** | **0%** |
| HR Bench | Cost per Hire | same | `SUM(amount)/COUNT(hire_id) FROM recruitment_costs` | **table missing** | **N/A** |
| SysHealth | Total Tables | `/system-health/db-tables` | `pg_class WHERE relkind='r' AND nspname='public'` | catalog | **551** |

**Every number on the screen is now explained.** No unexplained figure remains.

---

# SECTION 22 — Feature Ownership Matrix

| Feature | Primary page | Secondary context | Should it exist elsewhere? | Reason |
|---|---|---|---|---|
| Revenue YTD | **CFO Dashboard** | CEO Intelligence (strip) | Yes, once | Finance owns the definition; CEO needs the headline |
| Revenue trend chart | **CFO Dashboard** | CEO Intelligence | **No** — remove from Executive Dashboard | Three renderings is two too many |
| Net Profit / EBITDA / margins | **CFO Dashboard** | CEO strip (net margin only) | Net margin only | Full P&L is a finance surface |
| Cash position / runway | **CFO Dashboard** | — | **No** | CEO's "cash position" is not cash |
| AR aging buckets | **CFO Dashboard** | CEO Collections (summary only) | Summary only | **Currently mis-homed on CEO** |
| Expense breakdown | **CFO Dashboard** | — | **No** — remove from CEO | Exact duplicate |
| Sales pipeline value | **Sales Command Center** | CEO strip, CFO forecast | Headline only | One source of truth: `opportunities` |
| Pipeline by stage | **Sales Command Center** | CEO Sales tab | Once | CEO renders it twice today |
| Revenue forecast | **CFO Dashboard** | CEO Executive (headline) | Headline only | One model, three consumers |
| Customer health scoring | **CEO Intelligence** | Customer 360 | Yes | Strategic by nature |
| Customer risk / at-risk list | **CEO Intelligence** | — | No | Unique |
| Vendor risk / scorecards | **CEO Intelligence** | Vendor 360 | Yes | Strategic |
| Supply-chain exposure | **Procurement** | CEO Vendors (summary) | Summary only | Needs a real component master, not a mock array |
| Project profitability | **Projects 360** | CEO Projects (portfolio roll-up) | Roll-up only | Needs `project_cost_summary` populated |
| Business-line P&L | **CEO Intelligence** | — | No | Unique — but must be rebuilt on the real taxonomy |
| Headcount | **HR Dashboard** | CEO strip, Exec | Headline only | HR owns it |
| Attrition rate | **HR Dashboard** | CEO strip, HR Bench (as benchmark) | Headline + benchmark | Five renderings today |
| Gender diversity | **HR Benchmarking** | — | **No** — remove from CEO and HR Dash | Benchmarking is the right frame |
| Department workforce | **HR Dashboard** | — | **No** — remove from CEO and Exec | Three renderings |
| Salary bands / median | **HR Benchmarking** | HR Dash (bands chart) | Both, different cuts | Distribution vs benchmark |
| Offer acceptance | **HR Benchmarking** | Recruitment Dashboard | Yes | **Must use one source: `offer_letters`** |
| Time to hire / fill | **HR Benchmarking** | Recruitment | Yes | Benchmark frame |
| Onboarding / compliance | **HR Dashboard** | — | No | Operational |
| Operational counts (tiles) | **CEO Intelligence** | — | **No** — remove the overlapping Exec KPIs | Drill-through is the value |
| System alerts | **CEO Intelligence** | — | **No** — remove from Executive Dashboard | Same endpoint, twice |
| Rule-based insights | **CEO Intelligence** | — | **No** — consolidate all 4 engines into `insightsEngine.js` | Four engines, one job |
| Anomaly detection | **ERP Intelligence** | — | No | Unique |
| Prescriptive actions | **ERP Intelligence** | — | No | Unique and excellent |
| NL query / chat | **ERP Intelligence** | Global search | Yes | Unique |
| Predictive charts | **ERP Intelligence** | — | No | Unique |
| DB table health | **System Health** | — | **No** — remove Ops Command Center's fake assertion | One truth |
| User administration | **Admin / Access Control** | — | **No** — move out of Analytics entirely | Not analytics |
| Manager approvals | **Approvals module** | — | **No** — remove from Ops and HR Dash | Not analytics |
| Canonical period filter | **all 8 pages** | — | **Yes, everywhere** | Currently 2 of 8 |

---

# SECTION 23 — Unnecessary Pages

| Page | Verdict | Recommendation | Rationale |
|---|---|---|---|
| **Executive Dashboard** | **MERGE** | Fold its 12 unique elements into CEO Intelligence's Executive tab; grant `manager` scoped access to that tab; retire the route | 13 of 25 features duplicate CEO Intelligence. Its real assets — the canonical filter bar, the 403-aware degradation, the quick-nav chips and the manager role grant — are all portable. Keeping two executive dashboards guarantees the numbers drift apart again. |
| **Ops Command Center** | **MOVE** | Relocate to `Administration` as "User Administration"; move the Team Ops tab to the Approvals module or a Manager Workspace | It is a user-admin console plus a manager approvals queue. It contains zero analytics. Its presence under Analytics & AI is the clearest information-architecture error in the module. |
| **HR Benchmarking** | **KEEP** | Fix the 5 broken metrics; remove the 3 overlaps with HR Dashboard | The comparative frame is genuinely distinct and is the model the rest of the module should follow: one endpoint, canonical filter, echoed period label. |
| **HR Dashboard** | **KEEP + REDESIGN** | Adopt `HRAnalyticsDashboard`'s filter implementation wholesale, then delete that orphan | Two HR analytics pages exist and the hidden one is technically better. |
| **`HRAnalyticsDashboard`** (hidden) | **MERGE then DELETE** | Port its filter contract and its 4 exclusive endpoints into HR Dashboard's Analytics tab | An unreachable page is dead weight and four endpoints exist only to serve it. |
| **System Health** | **KEEP + RENAME** | Rename to "Data Health" or "Database Coverage"; add auto-run on load | The name promises platform monitoring it does not deliver. |
| **CEO Intelligence** | **KEEP + TRIM** | Remove the Business Lines tab until the taxonomy is real; delete the Supply-Chain mock table; deduplicate the 3 internal repeats of Revenue/Pipeline/Avg-Deal | 10 tabs is defensible; 3 of them being empty or fake is not. |
| **CFO Dashboard** | **KEEP + FIX** | Remove every fabricated series before go-live | The concept is right; the arithmetic is not. |
| **ERP Intelligence** | **KEEP + RETHEME** | Bring into the shared light design system; relabel "forecast" charts that plot history | The strongest concept in the module, presented as a different product. |

---

# SECTION 24 — Missing Features

Only items with a concrete business case are listed, per §29.

## CRITICAL — required before go-live

| # | Feature | Why |
|---|---|---|
| C1 | **Single KPI definition registry** | Five KPIs currently contradict each other across pages. Until Revenue, Attrition, Open Tickets, Offer Acceptance and AR have exactly one query each, every fix will regress. |
| C2 | **Permission guards on `/analytics`, `/dashboard`, `/ai`** | 72 endpoints, including full P&L and salary distributions, are open to any authenticated employee. |
| C3 | **Error surfacing** | Four pages cannot distinguish an API failure from an empty result. A CFO seeing Rs 0 must know whether that is the truth or a 500. |
| C4 | **Remove every fabricated series** | The CFO chart, department expense split, net-profit and EBITDA coefficients, `CRITICAL_COMPONENTS`, the department "target" bar, and 21 of 25 AI Insight bullets. |
| C5 | **Fix the 7 status-casing mismatches** | One root cause behind 12 of the 27 broken features. |
| C6 | **Company-scope the 10 unscoped queries** | Latent cross-tenant leak; also a cache-key correctness bug. |

## HIGH — shortly after go-live

| # | Feature | Why |
|---|---|---|
| H1 | Canonical `DashboardFilterBar` on all 8 pages | Five filter idioms; two pages have no date filter at all |
| H2 | Working HR department filter | The only filter on HR Dashboard does not filter |
| H3 | Drill-downs that carry context | 29 of 30 land on unfiltered lists |
| H4 | Populate `project_cost_summary` | Unblocks ~15 dead margin/profit/health metrics at once |
| H5 | Export on every dashboard | Exactly one CSV export exists in the whole module |
| H6 | Persist strategic-alert acknowledgement | Acknowledging is the point of a war room |
| H7 | Cross-page KPI reconciliation test | Would have caught 5 of the 6 P0s |
| H8 | Production / manufacturing KPIs on the executive view | A manufacturing ERP with no production metric for the CEO |

## MEDIUM

| # | Feature |
|---|---|
| M1 | Order backlog and book-to-bill on CEO Executive |
| M2 | Real business-line taxonomy wired to `product_lines`, then rebuild the Business Lines tab |
| M3 | Service SLA attainment and MTTR on the Collections and AMC tab |
| M4 | Cost of poor quality — NCRs are counted but never costed |
| M5 | Region / zone filter (`projects.zone`, `site_state` already exist) |
| M6 | Confidence intervals on the three forecast surfaces |
| M7 | System Health auto-run plus scheduled snapshots and trend |
| M8 | Scheduled email digest of the CEO brief (`kpiDigest.cron.js` already exists) |

## LOW

| # | Feature |
|---|---|
| L1 | Saved views / personal dashboard layouts |
| L2 | Configurable HR benchmark thresholds (currently hardcoded) |
| L3 | Annotation of chart points |
| L4 | Mobile-optimised executive view |
| L5 | Anomaly-detection sensitivity tuning |

---

# SECTION 25 — Duplicate Features to Merge, Remove or Reposition

| # | Action | Target | Detail |
|---|---|---|---|
| D1 | **MERGE** | Executive Dashboard into CEO Intelligence | Port the filter bar, quick-nav, greeting, 403-aware Net Profit and the manager role grant; retire the route |
| D2 | **MOVE** | Ops Command Center out of Analytics | To Administration; Team Ops tab to Approvals |
| D3 | **MERGE** | `HRAnalyticsDashboard` into HR Dashboard | Adopt its filter implementation; then delete it and keep its 4 endpoints |
| D4 | **REMOVE** | CEO Executive tab Expense Breakdown | Exact duplicate of the CFO card |
| D5 | **REMOVE** | CEO Workforce gender chart | HR Benchmarking owns diversity |
| D6 | **REMOVE** | CEO + Executive department workforce charts | HR Dashboard owns it |
| D7 | **REMOVE** | Executive Dashboard Smart Alerts | Same endpoint as CEO Ops System Alerts |
| D8 | **REMOVE** | CEO Sales tab Revenue-vs-Outstanding chart | Same array as the Executive tab chart |
| D9 | **DEDUPE** | CEO's internal triples | Revenue YTD, Pipeline Value and Avg Deal Size each render three times on one page |
| D10 | **REMOVE** | "AMC Annual Revenue" KPI | Identical query to ARR |
| D11 | **REMOVE** | HR Bench "Offer Exception Rate" | Same expression as `offerDeclineRate` |
| D12 | **REMOVE** | CEO Sales Bottom Performers | Duplicates Top Performers on small teams |
| D13 | **CONSOLIDATE** | 4 rule engines into `insightsEngine.js` | One engine, per-page rule subsets |
| D14 | **CONSOLIDATE** | 3 cash-position definitions into the CFO one | Revenue-minus-payables is not cash |
| D15 | **CONSOLIDATE** | 2 pipeline sources into `opportunities` | `/dashboard/sales` and `/analytics/sales` disagree |
| D16 | **REPOSITION** | AR aging from CEO to CFO | CEO keeps the summary tile only |
| D17 | **REMOVE** | Ops Command Center's "System Health: Healthy" KPI and card copy | Asserts health without checking |
| D18 | **REMOVE** | CFO margin rows and working-capital stats | Already in the ratio grid |
| D19 | **DELETE** | `services/modules/analyticsService.js` and `GET /analytics/revenue` | Zero callers |
| D20 | **FIX** | Stale `/CeoDashboard` targets in 2 spec files | Route deleted 17 Aug 2026 |

---

# SECTION 26 — Recommended Final Information Architecture

```
Analytics & AI
│
├─ EXECUTIVE
│   └─ CEO Intelligence                       [the single executive surface]
│       ├─ Executive Summary   ← absorbs Executive Dashboard's unique elements
│       │                        + canonical DashboardFilterBar
│       ├─ Customers           ← health · risk · growth · upsell-to-CRM
│       ├─ Sales               ← pipeline · targets · scorecard  (dedup'd)
│       ├─ Vendors             ← risk · scorecards  (mock table removed)
│       ├─ Projects            ← portfolio P&L  (once cost rollup is live)
│       ├─ Collections & AMC   ← summary only; aging moves to CFO
│       ├─ Operations          ← the 9 drill-through tiles, context-passing
│       └─ War Room            ← strategic alerts (persisted) + GPT brief
│                                 ["AI Insights" removed until it is real]
│       [Business Lines tab hidden until the product taxonomy is wired]
│       [manager role granted scoped access to Executive Summary only]
│
├─ FUNCTIONAL
│   ├─ CFO Dashboard                          [+ AR aging, − all fabricated series]
│   ├─ HR Dashboard                           [+ HRAnalyticsDashboard's filters]
│   └─ HR Benchmarking                        [5 broken metrics fixed]
│
└─ PLATFORM
    ├─ ERP Intelligence                       [retheme to the shared light system]
    └─ Data Health                            [renamed from System Health]

Moved out of Analytics & AI:
    Administration → User Administration       (was "Ops Command Center", Admin tab)
    Approvals      → Manager Workspace         (was "Ops Command Center", Team Ops tab)

Deleted:
    ExecutiveDashboard route
    HRAnalyticsDashboard route (after merge)
    services/modules/analyticsService.js
    GET /analytics/revenue
```

**8 nav entries become 6.** Every remaining page answers a question no other page answers.

---

# SECTION 27 — Pre-Go-Live Quality Score

Scored per §30: Data correctness 25 · Functionality 20 · UX consistency 15 · Performance 10 · API connectivity 10 · Security 10 · Error/empty states 5 · Testing 5.

| Page | Data /25 | Func /20 | UX /15 | Perf /10 | API /10 | Sec /10 | Err /5 | Test /5 | **Total** | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CEO Intelligence | 11 | 13 | 7 | 5 | 9 | 7 | 2 | 3 | **57** | 🔴 NOT READY |
| Executive Dashboard | 16 | 15 | 12 | 8 | 9 | 6 | 3 | 2 | **71** | 🟡 GO WITH FIXES |
| Ops Command Center | 14 | 16 | 10 | 7 | 8 | 5 | 3 | 2 | **65** | 🟡 (wrong module) |
| **CFO Dashboard** | **6** | 12 | 11 | 8 | 8 | 4 | 2 | **0** | **51** | 🔴 **NOT READY** |
| HR Dashboard | 12 | 11 | 9 | 7 | 8 | 5 | 3 | 2 | **57** | 🔴 NOT READY |
| HR Benchmarking | 9 | 13 | 13 | 10 | 9 | 5 | 4 | 0 | **63** | 🔴 NOT READY |
| ERP Intelligence | 14 | 13 | 5 | 8 | 7 | 5 | 4 | 2 | **58** | 🔴 NOT READY |
| System Health | 23 | 16 | 11 | 9 | 10 | 9 | 5 | 0 | **83** | 🟡 GO WITH FIXES |
| | | | | | | | | | | |
| **MODULE AVERAGE** | **13.1** | **13.6** | **9.8** | **7.8** | **8.5** | **5.8** | **3.3** | **1.4** | **63.1** | 🔴 **NOT READY** |

### Score commentary

- **CFO Dashboard, 51 — lowest.** Six fabricated values on the financial dashboard, five placeholder ratios rendered as "good", five dead alert buttons, and zero test coverage. This is the page that must not ship as-is.
- **CEO Intelligence, 57.** Enormous surface, genuinely valuable in places (collections aging, customer health, upsell conversion), but it contradicts itself on Open Tickets, carries a permanently dead tab, a mock supply-chain table, and an "AI Insights" panel that is 84% canned prose while claiming otherwise.
- **HR Benchmarking, 63.** The best-engineered page in the module — one endpoint, canonical filters, echoed period label, excellent empty states — dragged down by 5 of 15 metrics being structurally unable to return a value.
- **System Health, 83 — highest.** Honest, well-built, well-guarded. Loses points only for the misleading name and no auto-load.
- **Security, 5.8/10 module-wide.** Driven almost entirely by the 72 unguarded endpoints.
- **Testing, 1.4/5.** The two lowest-scoring pages have zero coverage between them.

---

# SECTION 28 — Go-Live Readiness

## 🔴 NOT READY

### Blocking (must fix before go-live)

| # | Blocker | Effort |
|---|---|---|
| 1 | Remove or replace all 6 fabricated values on CFO Dashboard (target x1.1, profit x0.28, net x0.78, EBITDA +5%, department shares, 5 "good" placeholders) | M |
| 2 | Reconcile the 5 contradicting KPIs: Open Tickets, Offer Acceptance, AR vs Outstanding, Attrition, HR Overview vs Analytics | M |
| 3 | Fix the 7 status-value mismatches (one root cause behind 12 broken features) | S |
| 4 | Add permission guards to `/analytics`, `/dashboard`, `/ai` — 72 endpoints exposing P&L, salary bands, named performance ratings | M |
| 5 | Remove `CRITICAL_COMPONENTS` mock table and its 2 derived KPI cards | S |
| 6 | Remove or rewrite the CEO "AI Insights" panel; delete the false "no hardcoded or fabricated values" claim | S |
| 7 | Hide the Business Lines tab until the product taxonomy is wired | S |
| 8 | Fix the CFO alert action map — all 5 buttons are no-ops | S |
| 9 | Make the HR Dashboard department filter actually filter, or remove it | S |
| 10 | Surface API errors distinctly from empty states on the 4 pages that swallow them | M |
| 11 | Company-scope the 10 unscoped queries and fix the `metricsEngine` cache-key mismatch | M |
| 12 | Create `assessment_submissions` and `recruitment_costs`, or remove the 2 metrics that query them | S |

### Non-blocking but strongly recommended

| # | Item |
|---|---|
| 13 | Merge Executive Dashboard into CEO Intelligence |
| 14 | Move Ops Command Center out of Analytics & AI |
| 15 | Merge `HRAnalyticsDashboard` into HR Dashboard, then delete it |
| 16 | Roll `DashboardFilterBar` out to all remaining pages |
| 17 | Retheme ERP Intelligence into the shared light design system |
| 18 | Populate `project_cost_summary` — unblocks ~15 dead metrics at once |
| 19 | Add a cross-page KPI reconciliation test suite |
| 20 | Fix the 2 stale `/CeoDashboard` e2e specs |

### Ship-ready today

- **System Health** (rename recommended)
- **`/ai/prescriptive`**, **`/ai/predict/inventory`**, **`/ai/predict/lead-priority`**
- **CEO Collections aging**, **customer health scoring**, **upsell-to-CRM conversion**
- **The Revenue YTD reconciliation** — Rs 2,41,900 agrees across all four surfaces

### Estimated effort to 🟢

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Blockers 1-12 | ~5-7 days |
| 2 | IA consolidation (13-15) | ~4-5 days |
| 3 | Consistency + tests (16-20) | ~5-6 days |
| | **Total to green** | **~3 weeks** |

---

## FINAL PRINCIPLE — status against §35

| Requirement | Status |
|---|:--:|
| Every dashboard answers a different set of questions | ✗ — 2 of 8 have no unique purpose |
| Every feature has a clear purpose | ✗ — 6 mock + 5 placeholder features |
| Every KPI has a traceable source | ✓ — all 214 traced; 0 UNKNOWN |
| Every displayed number is live or explicitly derived from live data | ✗ — 34 static/mock/placeholder |
| Every tab works | ✗ — Business Lines permanently empty |
| Every button works | ✗ — 5 CFO alert buttons dead |
| Every filter works | ✗ — HR department filter is decorative |
| Every drill-down works | ✗ — 5 dead; 29 of 30 pass no context |
| Every API is connected | ✓ — 41 of 41 reachable |
| Every database dependency verified | ✗ — 2 tables and 2 columns missing |
| Every page has meaningful content | ✗ — Business Lines empty by construction |
| Every duplicate identified | ✓ — 15 exact, 7 functional, 5 partial |
| Every empty page explained | ✓ — all classified |
| Every dashboard follows one design system | ✗ — 5 design languages |

**11 of 14 conditions unmet. The module is not production-ready.**

---

*End of audit. No application code was modified. Findings are ordered so that the twelve blockers in Section 28 can be worked directly; each links back to the evidence in Sections 3-7 and the live database values in Section 21.*
