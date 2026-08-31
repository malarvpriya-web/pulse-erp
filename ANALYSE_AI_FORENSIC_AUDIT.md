# Analyse & AI — Forensic Architecture, Live Data, Information Flow, UI/UX and AI Integrity Audit

**Repository:** `C:\Users\malar\OneDrive\Desktop\Pulse_WORKING`
**Measured:** 21 Aug 2026, against the live `Pulse` database (PostgreSQL 18.2, 552 tables, 1 company) and a running instance on `:5000`/`:5173`
**Pass:** 3 (follows `ANALYTICS_AI_PRE_GOLIVE_AUDIT.md` §111 and `ANALYTICS_AI_FINAL_HARDENING_REPORT.md` §112)
**Artifact:** https://claude.ai/code/artifact/0370e850-fc31-4534-8e2b-baddbc9e8bf5
**Architecture record:** manual §119

---

> **STATUS: REMEDIATED 2026-08-25 — 54/100 → 98/100, GO-LIVE.**
> All 5 P0 and 13 P1 findings are closed. A sixth tenant leak (`/ai/payroll/*`) was
> found by the rebuilt probe during remediation and closed too. The audit below is
> preserved unchanged as the record of what the defects were; **do not read it as a
> list of open issues.** Remediation detail: manual **§119.1**.
>
> Re-certify by RUNNING these, never by reading this file:
>
> | Gate | Before | After |
> |---|---:|---:|
> | `scripts/audit/sql-failure-probe.mjs` | 19 rejections / 12 endpoints | **0 / 124** |
> | `scripts/audit/tenant-leak-probe.mjs` | 18 findings, 68 endpoints probed | **0, 121 probed** |
> | `scripts/audit/kpi-reconcile.mjs` | 20/20 | **21/21** |
> | Revenue YTD across 6 publishers | 4 different values | **one (₹241,900)** |
> | `npm --prefix backend test` | 669 | **713 pass** |
> | `npm --prefix frontend test` | 295 pass / 3 fail | **298 / 0** |
> | Playwright analytics suites | 51/51 | **51/51** |
>
> **Still open, and yours to decide:** nothing is committed (last commit 11 Aug), and
> two divergent copies of the E2E suite exist. See §15.

---

## 1. Executive verdict

```
ANALYSE & AI
Production readiness: 54 / 100

DO NOT GO-LIVE
```

Two cross-tenant leaks were **reproduced live**, one of them into an AI recommendation. The
ERP assistant answers *"No overdue invoices found"* while fifteen invoices sit past due.
Nineteen SQL statements fail on every request and are converted to zeros and empty arrays
before they reach the screen.

None of this is architectural. Every P0 is a localised SQL or scoping fix, and the surrounding
module is genuinely strong — KPI reconciliation, data freshness, RBAC and performance all pass
on evidence.

The two earlier passes closed 38 defects and signed the module off. That work holds up; I
re-ran their gates and their evidence and it is real. What this pass found is a *class* of
defect their instruments were structurally unable to see: SQL that parses, references only
real tables, passes every static check, and then throws at execution time into a
`.catch(() => [])`.

### Top 10 risks

| # | Risk | Evidence | Sev |
|---|------|----------|-----|
| 1 | All 8 `/analytics/pq/*` endpoints serve every tenant's Power Quality data — zero `company_id` in the router | company-49 `test_runs` row moved company 1's `total_tests` 5 → 6 | P0 |
| 2 | An AI recommendation ingests another tenant's records | company-49 leave request moved `/ai/prescriptive` 159 → 160 | P0 |
| 3 | The ERP assistant issues false all-clears on money | "No overdue invoices found" vs 15 overdue in the DB | P0 |
| 4 | CFO cash-flow + revenue-forecast cards empty — `invoices.amount` never existed | `cashFlowMonthly []`, `forecastData []`, `historicalRevenue []` | P0 |
| 5 | Every vendor scored *Watchlist / High risk* from two invalid statements | `42601 syntax error at or near "AND"` × 2 | P0 |
| 6 | Revenue YTD has four values across five endpoints | ₹241,900 · ₹1,162,300 · ₹6,290,800 · ₹0 | P1 |
| 7 | CFO shows "This month ₹2.4L" in August — that is April's figure | `rows.at(-1)` = last month *with data* | P1 |
| 8 | `derived_from_live_data: true` asserted while a signal query throws | `42883 integer = uuid`; `customer_risks` always 0 | P1 |
| 9 | Both remediation passes are uncommitted; last commit 11 Aug | 682 modified · 12 deleted · 107 untracked | P1 |
| 10 | The E2E suite cited as the closed CI gate is untracked; `test:analytics` absent from the committed manifest | `git status: ?? tests/ · ?? playwright.config.ts` | P1 |

### Scoring

| Dimension | Score | Why |
|---|---:|---|
| Architecture | 9 / 15 | Clean layering, genuinely canonical shared modules; three parallel analytics stacks, a 1,700-line controller |
| Live data integrity | 8 / 15 | Freshness proven, zero mock data; 19 silent query failures on 12 endpoints |
| KPI accuracy | 5 / 10 | 20/20 canonical reconciliations match; four competing revenue definitions ship alongside |
| Information flow | 6 / 10 | Traces clean end to end; 56 of 141 endpoints uncalled, 6 of 8 pages off the filter contract |
| UI / buttons | 7 / 10 | 51/51 browser tests green, every action wired; a deleted page still reachable, one card mislabelled |
| AI data integrity | 6 / 15 | No fabricated numbers, no LLM as system of record; false all-clears, a proven leak, heuristics labelled as forecasts |
| Duplication / SSOT | 4 / 10 | Status vocabulary properly centralised; revenue, headcount and audit-log queries are not |
| Security / tenancy | 2 / 5 | RBAC excellent, no IDOR; two live cross-tenant leaks, ~30 unscoped queries |
| Performance | 5 / 5 | p50 12 ms, p95 148 ms, max 466 ms; no N+1, no unbounded scan |
| Testing / observability | 2 / 5 | 1,015 tests green over a proven leak and 19 dead queries; E2E gate cannot run in CI |
| **Total** | **54 / 100** | |

---

## 2. Module architecture, as built

No analytics warehouse, no materialised view, no snapshot table, no ETL. Every figure is
computed on the request path from live transactional tables. The database holds 552 base
tables, 3 views (all inventory, none used here) and **zero** materialised views.

```
Transactional tables (invoices, employees, projects, opportunities, test_runs, …)
        |
        |  direct SQL on the request path
        v
Route handlers  /analytics · /dashboard · /ceo-intelligence · /ai · /intelligence
        |   +-- shared/statusSets.js        isIn() / notIn()          CANONICAL, CI-enforced
        |   +-- shared/analyticsAuthz.js    path-prefix, deny by default
        |   +-- shared/dashboardFilters.js  resolveRange()
        |   +-- analytics/services/metricsEngine.js   60s in-process TTL cache
        v
Swallow layer   safeQuery / sqN / sq1 / q() / .catch(() => [])     ← 78 call sites
        |                                   ^ a rejected query becomes 0 or [] HERE
        v
JSON response   always HTTP 200
        v
React pages     8 in the Analytics & AI menu + MyAnalytics
        v
Recharts / cards
```

Both shared modules from §111 are doing real work. `statusSets.js` is the only place a status
literal appears in analytics SQL and a CI gate enforces it against live values.
`analyticsAuthz.js` denies by default, so a new route inherits a guard.

The weakness is the swallow layer. 78 call sites convert a query rejection into an empty
result and the response is 200 either way. Section 5 flows entirely from that decision.

**Stack duplication.** Three routers compute overlapping business metrics from the same tables
with different formulas: `/analytics` (40 endpoints), `/dashboard` (26), `/ceo-intelligence`
(10). A fourth, `/intelligence` (49), has no frontend caller at all; eight of its tables have
never existed in any migration and those routes are correctly short-circuited to 501, though
the dead query text remains.

---

## 3. Feature inventory

| Page | Route key | Calls | Primary API | Filters | State |
|---|---|---:|---|---|---|
| CEO Intelligence | `CEOIntelligenceDashboard` | 15 | `/ceo-intelligence/*` (9) | 1 of 15 calls | 2 defects |
| Executive Dashboard | `ExecutiveDashboard` | 12 | `/dashboard/*` (8) | canonical contract | clean |
| Ops Command Center | `AdminDashboard` | 4 | `/admin/users`, `/audit` | none | user admin, not analytics |
| CFO Dashboard | `CFODashboard` | 2 | `/dashboard/cfo` | period strip | 2 defects (P0) |
| HR Dashboard | `HRDashboard` | 18 | `/analytics/*` via `hrAnalyticsApi` | canonical contract | 2 defects |
| HR Benchmarking | `HRBenchmarkingDashboard` | 1 | `/analytics/hr-benchmarks` | none | clean |
| ERP Intelligence | `ERPIntelligence` | 9 | `/ai/*` | forecast days | 2 defects (P0) |
| System Health | `SystemHealth` | 1 | `/system-health/db-tables` | none | clean |
| My Analytics | `MyAnalytics` | 8 | `/user-dashboard/*` | self + year | clean |
| HR Analytics *(unlisted)* | `HRAnalyticsDashboard` | 8 | 4 endpoints deleted | — | **all 8 calls 404** |

### The tenth page should not exist

`analytics.routes.js` documents HR Analytics Dashboard as removed — *"its one genuine
advantage has been ported into HR Dashboard's Analytics tab, and the page deleted."* The four
backing endpoints **were** deleted. The `.jsx` was not. `autoRouter.js` globs
`features/**/pages/*.jsx`, the file matches no exclusion rule, so it is auto-registered as a
route, folded into the HR menu as an orphan, and indexed by global search.

```
404  /api/analytics/hr-kpis
404  /api/analytics/department-distribution
404  /api/analytics/employee-status
404  /api/analytics/pending-leaves
```

### Endpoint surface

| Router | Routes | GET | No frontend caller | Note |
|---|---:|---:|---:|---|
| `/analytics` | 40 | 40 | 12 | includes `/pq` (8) and `/manufacturing` (4) |
| `/dashboard` | 26 | 25 | 11 | largely superseded by `/home/summary` |
| `/ai` | 23 | 18 | 4 | 3 LLM-backed, 20 SQL/rule-based |
| `/intelligence` | 49 | 28 | 28 | zero callers; 10 endpoints 501 by design |
| `/ceo-intelligence` | 10 | 9 | 0 | fully consumed |
| `/user-dashboard` | 8 | 8 | 0 | self-scoped |
| `/system-health` | 1 | 1 | 0 | admin-only |
| **Total** | **157** | **122** | **56 of 141 paths** | 40% unreachable from the UI |

---

## 4. Information flow

**Working — revenue YTD on CEO Intelligence**

```
KpiCard "Total Revenue (YTD)"
  -> GET /api/analytics/ceo/kpis
  -> metricsEngine.computeRevenueMetrics(company_id)     cached 60s, key includes company_id
  -> SELECT SUM(total_amount) FROM invoices
       WHERE isIn(status, INVOICE_PAID) AND invoice_date >= FY_START AND company_id = $1
  -> 18 paid invoices, 1 inside the FY window
  -> Rs 241,900     independently recomputed from the DB: MATCH
```

**Broken — cash flow on the CFO Dashboard**

```
Card "Cash Flow - Inflow vs outflow by month"
  -> GET /api/dashboard/cfo?period=YTD
  -> getCFODashboard -> safeOne(...)
  -> SELECT ... SUM(COALESCE(total_amount, amount, 0)) ... FROM invoices ...
  -> Postgres: 42703 column "amount" does not exist
  -> safeQuery catch -> []
  -> cashFlowMonthly: []   forecastData: []   historicalRevenue: []
  -> HTTP 200 OK
  -> UI: "No cash flow data for this period" - Inflow Rs 0 - Outflow Rs 0 - Net Rs 0
```

The two traces are the same shape. The only difference is that one query names a column that
exists. Nothing between the database and the CFO's screen distinguishes them.

---

## 5. Live data audit

### Freshness — verified by mutation (§7)

Inserted one paid invoice of ₹100,000, re-read three revenue surfaces, deleted it.

```
before                                   241,900
expected                                 341,900

/dashboard/cfo .kpis.revenue             341,900   immediate
/ceo-intelligence .revenue_ytd           341,900   immediate
/analytics/ceo/kpis .revenue.value       241,900   stale -> 341,900 after 66s (60s TTL)

cleanup: remaining probe rows = 0
```

Correct, with one caveat: two CEO-facing surfaces can disagree for up to a minute and neither
carries an "as of" timestamp.

### Nineteen silent query failures

Instrumented `pg.Pool.prototype.query` on a live server, swept all 122 readable endpoints.
Now committed as `backend/scripts/audit/sql-failure-probe.mjs`.

```
122 endpoint(s) called, 19 query rejection(s) on 12 endpoint(s)
of which 8 endpoints render on a page a user can open today
```

| Endpoint | SQLSTATE | Root cause | User sees | Live? |
|---|---|---|---|---|
| `/dashboard/cfo` | 42703 ×2 | `invoices.amount` never existed | "No cash flow data"; empty forecast | on screen |
| `/ceo-intelligence/vendors` | 42601 ×2 | `cwBase` emits `AND company_id=1` after a bare `FROM` | all 6 vendors scored 0 → "Watchlist / High" | on screen |
| `/ceo-intelligence/ai-insights` | 42883 | `support_tickets.customer_id` integer vs `parties.id` uuid | `customer_risks` always empty | on screen |
| `/analytics/salary-bands` | 42803 | `GROUP BY band` binds to `employees.band`, not the alias | salary-band chart permanently empty | on screen |
| `/analytics/absenteeism` | 42703 | `attendance` has no `company_id` | absenteeism permanently 0% | on screen |
| `/analytics/headcount` | 42P18 | `$2` referenced, one param bound (4th instance) | "On leave" permanently 0 | on screen |
| `/ai/prescriptive` | 42703 ×2 | `inventory_items.name`, `employees.date_of_joining` | 2 recommendation categories never fire | on screen |
| `/dashboard/revenue` | — | wrong, not failed (see §6) | "This month" shows April | on screen |
| `/dashboard/live-kpis` | 42703 ×4, 42702 | `invoices.amount`, `audit_logs.action`, ambiguous `company_id` | revenue 0/0/0, approvals 0, activity [] | no caller |
| `/dashboard/activity` | 42703 | `audit_logs.action` — real cols `action_type`, `module_name` | activity feed always empty | no caller |
| `/dashboard/leave-summary` | 42703 | `leaves` has no `company_id` | leave-by-type always empty | no caller |
| `/dashboard/approvals` | 42702 | ambiguous `company_id` across a join | pending-leave list always empty | no caller |
| `/analytics/manufacturing/ecn-frequency` | 42P02 | `$1` in text, no params bound | ECN breakdown empty | no caller |

**Why the CI gate is green.** `check-sql-references.mjs` passes, correctly. It scans 314 files
and validates every table reference and every *qualified* `alias.column`. Its own source states
the limit: *"SELECT-side unqualified columns remain unchecked."* Its ratchet baseline holds
zero findings. Every failure above is an unqualified column, a type mismatch, a bind-arity
error, a name-resolution collision, or a syntax error — none expressible in a reference
checker. The gate is not broken; it answers a different question.

### Classification

| Class | Endpoints | Share | Basis |
|---|---:|---:|---|
| Fully live — direct transactional reads, verified | 104 | 85% | SQL traced to source rows; freshness propagates |
| Live but cached (60s in-process TTL) | 6 | 5% | `metricsEngine` `cached()` wrappers |
| Dead — query fails, presented as empty | 12 | 10% | runtime probe |
| Snapshot / materialised | 0 | 0% | no matviews, no snapshot tables |
| Static / configuration | 0 | 0% | — |
| **Mock or fabricated** | **0** | **0%** | swept both trees; every hit is a comment recording a *removed* mock |

The fabricated-data problem §111 found — `target = revenue × 1.1`, `profit = revenue × 0.28`,
eight invented critical components, five hardcoded departments summing to 121% — **is gone.**
That fix held.

---

## 6. KPI audit

`kpi-reconcile.mjs` passes 20 of 20 against independently computed database values — revenue,
AR, headcount, tickets, projects, pipeline, work-centre throughput, and the full CFO ledger
chain including `netProfit ₹560,000` traced to `journal_lines`. Re-run and confirmed.

It reconciles the endpoints that work. Widening the comparison is where divergence appears.

### Revenue YTD — four answers

```
  241,900  /ceo-intelligence/executive-summary .revenue_ytd   CANONICAL: paid, FY from 1 Apr
  241,900  /dashboard/cfo .kpis.revenue                       CANONICAL
1,162,300  /dashboard/revenue .ytd                            rolling 6 months, mislabelled
6,290,800  /dashboard/summary .revenueYTD                     all statuses, calendar year,
                                                              created_at, unscoped
        0  /dashboard/live-kpis .revenue.ytd                  query fails on invoices.amount

Independently recomputed from the database:
  241,900  paid, invoice_date >= 2026-04-01              = canonical
1,162,300  paid, last 6 months                           = /dashboard/revenue
3,387,700  paid, calendar year to date
6,290,800  ALL statuses, calendar year, by created_at    = /dashboard/summary
```

`/dashboard/summary`'s single line carries four defects: no status filter (drafts and
cancellations count as revenue), calendar year rather than the Indian FY the rest of the app
uses, `created_at` rather than `invoice_date`, and no `company_id` predicate.

### "This month" is four months old

`/dashboard/revenue` derives `thisMonth` as `rows.at(-1)` — the last month that produced a
row, not the current month.

```
GET /dashboard/revenue?period=fy&year=2027   (the exact call CFODashboard.jsx:163 makes)
months:    [ "Apr '26" ]
thisMonth: 241900     <- rendered as "This month" on 21 Aug 2026
lastMonth: 0
revTrend:  0%         <- division by zero, silently swallowed
```

Monthly paid revenue in the DB: Nov 25 885,000 · Dec 25 2,159,400 · Jan 26 1,752,400 ·
Feb 26 821,100 · Mar 26 572,300 · Apr 26 241,900 · **Aug 26 0**.

### Cross-endpoint agreement

| Metric | Sources | Distinct values | Detail |
|---|---:|---:|---|
| Revenue YTD | 5 | **4** | 241,900 · 1,162,300 · 6,290,800 · 0 |
| Revenue MTD | 3 | **2** | 0 (correct) vs 241,900 (April) |
| Headcount | 6 | **2** | 34 includes `Notice`; 32 excludes it. DB: 30 Active + 2 Notice + 2 Probation |
| Pending approvals | 3 | **2** | 168 vs 0 (failed query) |
| Active projects | 6 | **2** | 4 vs 1 — CEO Intelligence uses a stricter status set |
| Open tickets | 2 | 1 | 11 everywhere |
| AR / outstanding | 4 | 1 | ₹5,186,400 everywhere |
| Pipeline | 3 | 1 | ₹4,259,009 everywhere |

The headcount split is defensible — "still on payroll" and "actively working" are different
questions — but both are labelled *Total Employees* with no qualifier.

---

## 7. AI audit

**`OPENAI_API_KEY` in the running environment is the literal placeholder
`your-openai-api-key-here`.** `/ai/llm-chat` and `/ai/nav-search` return 503; `/ai/ceo-insights`
falls back to its rule narrator. Today every shipped "AI" output is a rule engine, a keyword
matcher, or an OLS fit over at most six points.

### Capability register

| Capability | Mechanism | Numbers from | Tenant safe | Traceable | Hallucination risk |
|---|---|---|---|---|---|
| `/ai/chat` | keyword → 8 fixed SQL branches | DB | **no — 0 of 8 scoped** | emits `query_used` | **false negatives** |
| `/ai/llm-chat` | gpt-4o-mini + leave-balance context | model | pending count unscoped | none | no verified figures in context |
| `/ai/ceo-insights` | LLM if keyed, else 4-rule narrator | caller payload | n/a | `source` returned, UI discards it | low |
| `/ai/predictions` | OLS over ≤6 monthly points | DB | scoped | `insufficient_history`, `no_data`, `query_failed` | honest |
| `/ai/anomalies` | 5 detectors, one z-score | DB | 4 of 5 scoped | cites the figure | cannot fire below n=9 |
| `/ai/prescriptive` | threshold rules | DB | **leak proven** | cites the figure | 2 detectors dead |
| `/ceo-intelligence/ai-insights` | 9 signal queries + thresholds | DB | scoped | every line cites its metric | completeness flag hardcoded |
| `/ai/predict/*` (9) | hand-tuned scoring tables | DB | mixed | partial | heuristics labelled as predictions |

### The assistant reports all-clear on money it cannot see

```
POST /api/ai/chat, live, against the same database

Q  "show me overdue invoices"
A  "No overdue invoices found."             invoices.client_name does not exist
DB 15 overdue invoices                      query_used: "invoices WHERE due_date < NOW()"

Q  "payroll summary"
A  "No payroll data found for last month."  payroll_runs has no gross_salary / pf_amount
DB 5 payroll rows                           / tds_deducted / net_salary / month_year
                                            real cols: gross, net_pay, employee_pf, tds,
                                            month, year

Q  "low stock items"
A  "No items below reorder point currently."
DB 0                                        genuinely correct
```

Only the third answer is trustworthy and nothing distinguishes it from the first two. This is
the brief's critical case: `DATA_UNAVAILABLE` presented as `SUCCESS_EMPTY`, on receivables.

### Cross-tenant data inside an AI recommendation

`/ai/prescriptive` counts `SELECT COUNT(*) FROM leave_requests WHERE status = 'pending'` — no
company predicate.

```
Second tenant raised via scripts/audit/tenant-fixture.mjs --up (company 49), removed after

before   "159 pending leave requests ..."
after    "160 pending leave requests ..."   LEAK CONFIRMED
cleanup  remaining probe rows = 0 - companies = 1
```

### The completeness flag is asserted, not derived

`/ceo-intelligence/ai-insights` is the best-built AI surface here: nine measured signals, every
line citing its figure, an honest empty state. It also returns `derived_from_live_data: true`
as a **literal**, commented *"Explicit contract with the UI: everything in `insights` is
measured."*

One of its nine queries throws `42883 operator does not exist: integer = uuid` on every call —
`support_tickets.customer_id` is integer, `parties.id` is uuid. The churn-risk signal
(customers carrying both overdue money and open tickets) has never once fired.

```
summary                "9 signal(s) detected ... Every line below cites the figure it was
                        derived from."
derived_from_live_data true
customer_risks         0      <- the query behind this rejected
collection_risks       2      OK  Rs 46.3 L across 14 invoices - matches the DB exactly
growth_opportunities   5      OK
margin_risks           2      OK
```

### Forecasts, anomalies, recommendations

- **Revenue forecast (`/ai/predictions`)** — OLS on at most six monthly points, three months
  out, with a flat ±12% band not derived from residuals. Months with no invoices are dropped
  rather than zero-filled, so the x-axis is "nth month with data", biasing the slope. The
  source query has **no status filter** — a fifth revenue definition.
- **CFO forecast** — `base × 1.2` and `base × 0.8`, growth clamped to [−10%, +20%], default 4%,
  presented as "Optimistic / Base Case / Conservative · trend-based". Fixed multipliers, not
  scenarios.
- **Invoice anomaly detector** — >2.5σ from a 90-day mean using *population* σ, gated at n ≥ 5.
  Max attainable |z| is (n−1)/√n: 1.79 at n=5, 2.47 at n=8. **It cannot fire below n = 9.**
- **Attrition risk** — "employees with under two years' tenure", presented as `risk_pct` under
  "Attrition Risk by Department". A tenure ratio, not a risk model.
- **Lead conversion** — a hardcoded stage→score table (negotiation 72, proposal 55, …) rendered
  as a numeric score that reads as a probability.
- **PQ test-failure detector** — carries the comment *"test_runs carries no company_id"*. It
  does. Unscoped on a false premise written into the code.

### Prompts, cost, provenance

- `/ai/ceo-insights` interpolates `JSON.stringify(dashboardData)` — an **unbounded,
  client-supplied object** — straight into the prompt, with no size cap, no schema and **no
  rate limit**. Only `/ai/llm-chat` is limited, at 20/day, in a process-local `Map` that resets
  on restart and multiplies by instance count.
- The card is labelled **"AI Insights (GPT)"**. The response carries `source: "rules"`.
  `AIInsightCard.jsx` never reads that field.
- That narrator states *"Attrition rate is 0.0% — within the healthy 10–12% benchmark"*.
  Attrition reads 0% because nobody has left — unmeasured presented as healthy.
- **No page fires an LLM call per render.** The only mount-time call is `AIInsightCard`, guarded
  by a ref and `disabled={loading}`. Prompts contain no secrets and no unnecessary PII. Nothing
  makes the model the system of record for a business figure. Those parts are right.

---

## 8. Buttons, filters, exports, drill-down

All eight pages load clean, survive a hard reload and open every tab without error — verified
in a real browser. The five CFO executive-alert buttons §111 found to be no-ops are now
correctly wired: the backend emits `View Invoices | Manage Expenses | View Projects | Review
Leaves | View Inventory` and all five resolve in `ALERT_ACTION_PAGE`. Double-submit is guarded.

```
npx playwright test --project=analytics-contract --project=tenant-isolation --project=analytics-browser
51 passed (4.5m)   8 pages render - 8 survive reload - every CEO tab opens -
                   HR + CFO filters re-query - signed-out browser refused
```

### Filters

| Page | Mechanism | Reaches the query? |
|---|---|---|
| Executive Dashboard | `useDashboardFilters` + `DashboardFilterBar` | yes — verified in browser |
| HR Dashboard | `useDashboardFilters` + `DashboardFilterBar` | yes — verified in browser |
| CFO Dashboard | bespoke period button strip | yes |
| CEO Intelligence | bespoke; 1 of 15 calls carries params | its 9 core endpoints accept none |
| ERP Intelligence | forecast-days selector only | partial |
| HR Benchmarking | none — endpoint supports `resolveRange` | capability unreachable |
| System Health / Ops Command Center | none | n/a |

Two of eight pages are on the canonical contract. A malformed date is handled three ways:
`/dashboard/cfo` returns a clean 400 with allowed values, `resolveRange` endpoints silently
substitute the default period, and the six `/analytics/employee-reports/*` routes throw 500.

### Exports

```
/analytics/employee-reports/headcount                        6578 B
/analytics/employee-reports/headcount?department=Finance     6578 B   filter ignored
  ...&format=xlsx                                           25316 B   filter ignored

/analytics/pq/export   derives ?days=<span length> from the filter bar; backend applies
                       created_at >= NOW() - days
                       -> a historical window exports the last N days instead
                       -> period=all sends 3650, server clamps to 365
```

The employee-report exports accept only `format`; the seven sibling analytics endpoints all
take department and period through `hrFrags(req)`. The PQ export uses a `days` vocabulary while
every other PQ endpoint uses `period/from/to`.

### Drill-down

CEO Intelligence and CFO expand cards into modals with the full series, and alert rows navigate
to the owning module. There is **no numeric drill path** from a KPI to its contributing rows —
no revenue → month → customer → invoice → line. A real gap for a board-facing surface, though
not a defect in anything that exists.

---

## 9. Duplication

| Function | Implementations | Same answer? | Canonical |
|---|---|---|---|
| Revenue YTD | `metricsEngine` · `ceo-intelligence` · `getCFODashboard` · `getDashboardRevenue` · `getDashboardSummary` · `getLiveKPIs` | **no — 4 values** | `computeRevenueMetrics` |
| Headcount | `metricsEngine` · `getDashboardWorkforce` · `getDashboardSummary` · `getLiveKPIs` | **no — 34 vs 32** | `EMPLOYEE_ACTIVE` |
| Audit-log feed | `/intelligence/audit-logs` (correct cols) · `/dashboard/activity` + `getLiveKPIs` (wrong cols) | **one works, two dead** | `/intelligence/audit-logs` |
| Status vocabulary | `shared/statusSets.js` only | yes | CI-enforced |
| Analytics authorization | `shared/analyticsAuthz.js` only | yes | deny by default |
| Tenant scoping helper | `cc()/cw2()` · `scopeFrags()` ×2 · `cidClause()` · `hrFrags()` · nothing in `/pq` | five idioms | none |
| Period resolution | `resolveRange()` · `/dashboard/revenue` legacy `6m/fy/cy` · `/pq/export` `days` | three vocabularies | `shared/dashboardFilters.js` |
| E2E suite | `Pulse/tests/` (20 specs, 19 Aug) · `Pulse_WORKING/tests/` (20 specs, 18 Aug) | divergent — 352 vs 396 lines | `Pulse/tests/` (untracked) |

56 of 141 endpoint paths have no caller anywhere in `frontend/src`. Twenty-eight are the
`/intelligence` router, consciously deferred. The other 28 are live, authenticated, maintained
code nothing calls — including all four `/analytics/manufacturing/*` endpoints, which §112 spent
effort fixing a tenant leak on.

---

## 10. Cross-module reconciliation

| Metric | Analyse & AI | Source module | Agree? | Explanation |
|---|---:|---:|---|---|
| Revenue YTD | ₹241,900 | ₹241,900 | yes | paid invoices from FY start; `FY_START` shared |
| Accounts receivable | ₹5,186,400 | ₹5,186,400 | yes | the ₹560,000 `Sent`-status gap is closed |
| Net profit | ₹560,000 | ₹560,000 | yes | `journal_lines ⋈ chart_of_accounts`, `glPosted:true` |
| Pipeline | ₹4,259,009 | ₹4,259,009 | yes | open opportunities |
| Open tickets | 11 | 11 | yes | case-sensitivity divergence closed |
| Production in progress | 3 | 3 | yes | — |
| Headcount | 34 / 32 | 34 | partly | legitimate definitional split, unlabelled |
| Active projects | 4 / 1 | 4 | **no** | CEO Intelligence uses a narrower `PROJECT_ACTIVE` set |
| Open NCRs (vendor view) | 0 | 8 | **no** | the vendor NCR query is syntactically invalid |
| Attrition | 0.0% | 0.0% | yes | correct — nobody has left; 2 on `Notice` |

---

## 11. Security and tenant isolation

### Authorization — strong

```
Every readable endpoint, called as john.doe@manifest.in (roles: ["employee"])

403 x 105    501 x 1    200 x 16

the 16:  8 x /user-dashboard/* (self-scoped, verified)
         3 x /dashboard/celebration*
         /analytics/satisfaction - /dashboard/leave-summary
         /intelligence/workflows - /intelligence/workflow-instances
         /intelligence/notification-rules   (9 KB of rule config)
```

No IDOR: `?employee_id=`, `?employeeId=` and `?company_id=` are all ignored in favour of the
token's claims. `companyOf(req)` is used consistently. The 31 interpolated `company_id`
fragments in `ceo-intelligence.routes.js` route through a helper that re-coerces to integer at
the point of interpolation.

### Tenant isolation — two proven leaks

`tenant-leak-probe.mjs` passes. It covers **68 of 122** endpoints, and `tenant-fixture.mjs`
seeds **none** of `test_runs`, `test_run_measurements`, `maintenance_*`, `ncr_reports`,
`audit_logs`, `expense_claims`, `approvals` or `payroll_runs`. A leak in any of those is
invisible to it — and reads as PASS.

```
Static census - queries observed on the wire during a full endpoint sweep
320  business SELECTs observed
 63  with no company_id predicate anywhere   across 35 endpoints
     of which ~30 read a table that DOES have a company_id column

powerQuality.routes.js - 8 endpoints, 497 lines
grep -c "company_id|companyOf"  ->  0
manufacturing.routes.js (same folder, fixed in §112) -> 11
```

```
Reproduced live: insert one test_run owned by company 49, read /analytics/pq/kpis as company 1

baseline total_tests                      5
after company-B row dated yesterday       6   CROSS-TENANT LEAK CONFIRMED
after own-company row dated TODAY         6   today's row not counted

second finding: pqWindow() applies  created_at <= $2::date
                which truncates to midnight, so EVERY PQ DASHBOARD EXCLUDES THE CURRENT DAY
```

### Other exposure

- `/ai/chat` — all eight branches unscoped. In a two-tenant deployment, "what is our cash
  position?" returns both companies' totals.
- `/ai/llm-chat` — the pending-approvals count injected into the system prompt is unscoped, and
  role gating uses `req.user.role` where roles are many-to-many.
- `/ai/ceo-insights` and `/ai/nav-search` reach an external model with no rate limit; the former
  forwards an unbounded client-supplied object.
- In development a malformed date returns raw Postgres text in a 500 body. `errorSanitizer`
  rewrites 5xx in production only, so this is dev-only — but the missing 400 validation is real.

---

## 12. Performance

```
122 endpoints, sequential, warm cache, current data volume

p50   12 ms      p90   40 ms      p95   148 ms      max   466 ms

slowest        466 ms  /dashboard/cfo              (ledger chain + 9 aggregates)
               280 ms  /analytics/hr-benchmarks
               253 ms  /ai/anomalies               (5 detectors)
               191 ms  /system-health/db-tables    (introspects 552 tables)
largest     161 KB     /intelligence/role-permissions   909 rows, unpaginated
             54 KB     /system-health/db-tables
```

No N+1, no unbounded scans, no `SELECT *` on a hot path. §112 measured p95 204 ms at 10,000
invoices — 285× the rows for ~1.7× the latency. CEO Intelligence prefetches all its endpoints
on mount and completes in ~300 ms.

Two caching notes. The `metricsEngine` cache is keyed on `company_id` (correct) but caches the
**fallback** on failure — a transient error is served as real data for 60 s. Both that cache and
the LLM rate limiter are process-local, so a multi-instance deployment gives different users
different numbers within the TTL and multiplies the 20/day AI cap by the instance count.

---

## 13. Test coverage

```
backend    vitest      669 passed, 9 skipped, 27 files
frontend   vitest      295 passed, 3 failed  (smoke.leaves x2, smoke.Sales x1 - outside module)
e2e        playwright  51 passed   contract 24 - tenant 6 - browser 21
gates      check:sql-refs PASS (314 files)   check:statuses PASS
recon      kpi-reconcile  20/20 MATCH

All of the above was green while sections 5 and 11 were true.
```

| Gap | Consequence | Required |
|---|---|---|
| No runtime SQL-failure gate | 19 rejected queries invisible to every check | **added this pass** — `scripts/audit/sql-failure-probe.mjs`, exits 1 on any rejection |
| Leak probe covers 68 of 122 endpoints | the PQ router was never asked | drive the endpoint list from route discovery, not a literal |
| Tenant fixture seeds ~10 of ~40 read tables | a leak in an unseeded table reads as PASS | seed every table the module reads, or assert the probe touched it |
| `tests/` and `playwright.config.ts` untracked | the E2E gate cannot run in CI at all | `git add`; delete the divergent copy above the repo |
| `test:analytics` missing from committed `package.json` | the CI step fails with "missing script" | commit the script |
| `analytics.intelligenceContract.test.js` does not exist | the SQL gate cites it as the guard on the 501 short-circuits | write it, or correct the comment |
| No test asserts a metric name maps to one formula | four revenue definitions coexisted undetected | a reconciler assertion per shared metric name |
| No date-boundary tests | PQ excludes today; "this month" shows April | fixture rows at midnight, month end, FY boundary |

---

## 14. Defect register

### P0 — blocks go-live

| ID | Finding | Location | Fix |
|---|---|---|---|
| P0-1 | All 8 Power Quality endpoints serve every tenant's test data. Reproduced live. | `analytics/routes/powerQuality.routes.js` — 0 occurrences of `company_id` | Scope through `companyOf(req)`; join measurements via `test_runs` |
| P0-2 | An AI recommendation counts another tenant's records. Reproduced live (159 → 160). | `ai.routes.js /prescriptive` — `leave_requests`, `purchase_orders` | Bind `company_id` in both queries |
| P0-3 | The assistant answers "No overdue invoices found" with 15 overdue, and "No payroll data" with data present. | `ai.routes.js /chat` — `invoices.client_name`, `payroll_runs.gross_salary` et al. | Use `parties.name` via `customer_id`; use `gross/net_pay/tds/month/year`. Return an explicit unavailable state, never a negative finding |
| P0-4 | CFO cash-flow, historical-revenue and forecast cards empty. | `dashboard.controller.js` — `COALESCE(total_amount, amount, 0)` | Drop the `amount` fallback (5 sites) |
| P0-5 | All 6 vendors scored *Watchlist / High risk* from two invalid statements. | `ceo-intelligence.routes.js:560, 566` — `${cwBase}` after a bare `FROM` | `cw2(companyId)`; render "not scored" rather than 0 when no scorecard exists |

### P1 — high

| ID | Finding | Fix |
|---|---|---|
| P1-1 | Revenue YTD has four values across five endpoints | Route all five through `computeRevenueMetrics`; delete `getDashboardSummary`'s inline query |
| P1-2 | "This month" renders the last month with data (April, in August) | Zero-fill the month series; select the current month explicitly |
| P1-3 | `derived_from_live_data: true` hardcoded while a signal query throws | Derive the flag from actual query outcomes; report degraded signals by name |
| P1-4 | `/analytics/salary-bands` permanently empty — `GROUP BY band` binds to `employees.band` | `GROUP BY 1`, exactly as `metricsEngine`'s gender query already does |
| P1-5 | `/analytics/absenteeism` permanently 0 — `attendance` has no `company_id` | Scope through `employees` |
| P1-6 | `onLeave` permanently 0 — `$2` referenced, one param bound (4th instance) | Build the params array alongside the fragment; add a lint rule |
| P1-7 | Every PQ dashboard excludes the current day | `created_at < ($2::date + INTERVAL '1 day')` |
| P1-8 | ~30 unscoped queries remain across 35 endpoints | Work the census; adopt one scoping helper |
| P1-9 | Leak probe covers 68/122 endpoints; fixture seeds a fraction of the read tables | Discover endpoints from routes; assert per-table coverage |
| P1-10 | E2E suite and `playwright.config.ts` untracked; `test:analytics` not in the committed manifest | Commit them; remove the divergent copy above the repo root |
| P1-11 | Both remediation passes are uncommitted — 682 modified, 12 deleted, 107 untracked, last commit 11 Aug | Commit and push. Until then a deploy from origin ships the pre-fix code |
| P1-12 | Unbounded client payload into an LLM prompt with no rate limit | Schema + size cap; extend the limiter to every LLM route; move it out of process memory |
| P1-13 | Deleted page still auto-routed, auto-navigable and searchable; all 8 of its calls 404 | Delete the file, or add it to `NON_PAGE_FILES` |

### P2 — medium

| ID | Finding |
|---|---|
| P2-1 | Card labelled "AI Insights (GPT)" renders rule-based output; the `source` field is returned and discarded |
| P2-2 | Forecast bands are fixed multipliers (±12%, ×1.2, ×0.8) presented as scenarios |
| P2-3 | Invoice anomaly detector cannot fire below n=9; max \|z\| for population σ is (n−1)/√n |
| P2-4 | `/dashboard/summary` revenue: no status filter, calendar year, `created_at`, unscoped |
| P2-5 | PQ export exports the wrong window for any range not ending today; `period=all` clamped to 365 days |
| P2-6 | Employee-report exports ignore department and period |
| P2-7 | Six of eight pages are off the canonical filter contract |
| P2-8 | Malformed dates 500 on six export endpoints; three different behaviours module-wide |
| P2-9 | 56 of 141 endpoint paths have no caller; 28 outside the deferred `/intelligence` router |
| P2-10 | Metrics cache stores failure fallbacks for 60 s; cache and rate limiter are process-local |
| P2-11 | Two divergent copies of the entire E2E suite |
| P2-12 | Plain employees can read notification rules, workflow definitions and company-wide leave counts |
| P2-13 | PQ anomaly detector unscoped on a false premise stated in its own comment |

### P3 — low

| ID | Finding |
|---|---|
| P3-1 | `analytics.intelligenceContract.test.js`, cited by the SQL gate as its safety net, does not exist |
| P3-2 | Three frontend tests failing (Leaves ×2, Sales ×1) — outside this module |
| P3-3 | No "as of" timestamp on cached KPI surfaces |
| P3-4 | HR Benchmarking has no period control though the endpoint supports one |
| P3-5 | `/ai/nav-search` reports "No match" when the provider is unreachable |
| P3-6 | `/ai/llm-chat` gates on `req.user.role` in a many-to-many role system |
| P3-7 | Rule narrator states attrition is "within the healthy benchmark" from an unmeasured 0% |

---

## 15. Remediation plan

Ordered by dependency. Each phase ends in a check that fails before the fix and passes after.

| Phase | Work | Closes | Exit check |
|---|---|---|---|
| **1 · Make it visible** | Wire `sql-failure-probe.mjs` into CI beside the schema gates. Widen the leak probe to route-discovered endpoints and the fixture to every table the module reads. | P1-9 | Probe goes red on today's tree |
| **2 · Stop the leaks** | Scope the PQ router; scope `/ai/prescriptive` and all 8 `/ai/chat` branches; work the 63-query census; adopt one scoping helper. | P0-1, P0-2, P1-8, P2-13 | Widened leak probe finds nothing |
| **3 · Fix the dead SQL** | All 19 rejections. Then replace `.catch(() => [])` with a wrapper returning a distinguishable `DATA_UNAVAILABLE` surfaced in the payload. | P0-3, P0-4, P0-5, P1-4, P1-5, P1-6 | Probe green; a forced failure renders an error state, not a zero |
| **4 · One definition per metric** | Collapse revenue onto `computeRevenueMetrics`; fix "this month"; label the headcount and project-status variants; fix the PQ day boundary. | P1-1, P1-2, P1-7, P2-4 | Reconciler asserts one value per metric name across every publisher |
| **5 · AI honesty** | Derive `derived_from_live_data`; surface `source` in the card and retitle it; label heuristics as heuristics; state the anomaly detector's minimum sample. | P1-3, P2-1, P2-2, P2-3, P3-7 | A stubbed query failure flips the flag and names the signal |
| **6 · AI cost & access** | Schema and size cap on `/ai/ceo-insights`; rate-limit every LLM route from shared storage; tighten the three over-permissive reads. | P1-12, P2-12 | An oversized payload is rejected; the limiter survives a restart |
| **7 · Surface** | Delete the orphan page; propagate filters into exports and align the PQ export vocabulary; validate dates to 400; put the remaining six pages on the filter contract; retire the 28 uncalled endpoints. | P1-13, P2-5…P2-9, P3-4 | Export bytes change with the filter; no 500 on a malformed date |
| **8 · Land it** | Commit the E2E suite, `playwright.config.ts` and `test:analytics`; delete the divergent copy; commit and push both remediation passes; write the missing contract test. | P1-10, P1-11, P2-11, P3-1 | A clean clone of origin runs `npm run test:analytics` green |

**Phase 8 is not last in importance.** It is last only because it should carry the other seven
phases with it. Right now the entire Analyse & AI remediation — both prior passes, every gate,
every fix — exists as uncommitted changes in one working tree. The last commit on this
repository is 11 August. Nothing described as closed by the previous audits is closed anywhere
but here.

---

## 16. Before / after baseline

"Before" is the state measured on 21 Aug 2026, not the state the previous reports described.
Where the two differ, the difference is a claim their instruments could not test.

| Metric | Reported closed (19 Aug) | Measured (21 Aug) | Evidence |
|---|---:|---:|---|
| Overall score | 98 / 100 | **54 / 100** | this document |
| Endpoints returning 200 | 58 / 58 | 121 / 122 | full sweep; one 404 is a valid missing id |
| Silent query failures | 0 | **19 on 12 endpoints** | `sql-failure-probe.mjs` |
| Live cross-tenant leaks | 0 | **2 reproduced** | fixture insert, 5→6 and 159→160 |
| Unscoped analytics queries | 0 | **~30 of 320** | wire-level census |
| Duplicate KPI definitions | 0 | **4 for revenue, 2 for headcount** | cross-endpoint comparison |
| Mock / fabricated values | 0 | **0** | full-tree sweep — **holds** |
| Broken buttons | 0 | **0** | 51/51 browser tests — **holds** |
| KPI reconciliations | 20 / 20 | **20 / 20** | re-run — **holds** |
| Backend tests | 596 pass | 669 pass / 9 skip | vitest |
| Frontend tests | 295 pass | 295 pass / **3 fail** | failures outside this module |
| Playwright | 51 / 51 | **51 / 51** | re-run — **holds** |
| E2E gate runs in CI | yes | **no — suite untracked** | `git status: ?? tests/` |
| Remediation committed | — | **no — 682 M, 12 D, 107 ??** | last commit 11 Aug |
| P0 defects | 0 | **5** | §14 |
| P1 defects | 0 | **13** | §14 |

---

## Method

Findings were produced against the live `Pulse` database and a running instance of the
application, not from reading code.

- **Endpoint behaviour** — a sweep of all 122 readable routes, discovered from the route files.
- **SQL failures** — `pg.Pool.prototype.query` wrapped on a real server booted on `:5099`;
  every rejection recorded and attributed to the endpoint that swallowed it. Committed as
  `backend/scripts/audit/sql-failure-probe.mjs` (+ `sql-failure-probe.boot.mjs`); exits 1 on any
  rejection.
- **Tenant leaks** — a second company created with the project's own `tenant-fixture.mjs`, one
  row inserted under it, the endpoint read as company 1, then removed.
- **Freshness** — a paid invoice inserted and deleted, three surfaces re-read at 1.2 s and 66 s.
- **RBAC** — every endpoint called with a token minted for `john.doe@manifest.in` (roles
  `["employee"]`), roles asserted before the token was trusted.
- **KPI truth** — recomputed directly in SQL and compared against the API response.

Every mutation was reverted and verified reverted. The database ends this audit with one
company and no probe rows.

**Left behind:** one new file, `backend/scripts/audit/sql-failure-probe.mjs` and its boot shim.
No other repository file was modified by the audit itself; `MODULE_FEATURE_CONNECTION_MANUAL.md`
§119 records the architecture impact.
