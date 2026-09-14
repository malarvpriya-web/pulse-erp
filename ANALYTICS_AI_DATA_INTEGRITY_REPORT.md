# Analytics & AI — Data Integrity Report

**Date:** 2026-08-18, revised 2026-08-19 · **Result:** **20/20 KPIs reconcile** (now including live
accrual figures) · 11 silently-dead queries fixed · 0 fabricated values remain in the shipped code.

---

## 1. Reconciliation

`backend/scripts/audit/kpi-reconcile.mjs` recomputes each KPI **from the source tables**, not by calling
the helper the endpoint calls — a shared helper that is wrong would otherwise reconcile perfectly with
itself.

| KPI | Endpoint | API | Independent DB query | |
|---|---|---|---|---|
| Revenue YTD | `/analytics/ceo/kpis` | 241 900 | 241 900 | ✅ |
| Accounts receivable | `/dashboard/cfo` | 5 186 400 | 5 186 400 | ✅ |
| Headcount | `/analytics/headcount` | 34 | 34 | ✅ |
| Open tickets | `/dashboard/operations` | 11 | 11 | ✅ |
| Active projects | `/dashboard/project-health` | 3 | 3 | ✅ |
| Production orders in progress | `/analytics/manufacturing/work-centre` | 2 | 2 | ✅ |
| Pipeline value | `/dashboard/sales` | 4 259 009 | 4 259 009 | ✅ |
| Top-customer rows | `/dashboard/top-customers` | 5 | 5 | ✅ |
| Overdue invoice rows | `/dashboard/cash?detail=true` | 10 | 10 | ✅ |
| AI revenue forecast computed | `/ai/predictions` | no error | — | ✅ |
| AI attrition risk computed | `/ai/predictions` | no error | — | ✅ |
| AI stockout risk computed | `/ai/predictions` | no error | — | ✅ |
| AI lead conversion computed | `/ai/predictions` | no error | — | ✅ |
| AI attrition departments | `/ai/predictions` | 15 | 15 | ✅ |
| AI lead conversion rows | `/ai/predictions` | 5 | 5 | ✅ |
| CFO `glPosted` matches the ledger | `/dashboard/cfo` | false | false | ✅ |
| CFO explains *why* the ledger is empty | `/dashboard/cfo` | 3 | 3 | ✅ |
| CFO net profit null when unposted | `/dashboard/cfo` | null | null | ✅ |
| CFO EBITDA null when unposted | `/dashboard/cfo` | null | null | ✅ |

**20/20 reconciled**, at both the shipped scale and a seeded 10 000-invoice dataset.

Since the 2026-08-18 revision the CFO rows changed from asserting *nullness* to asserting *values*: with
every journal entry now attributed to a company (see §5), net profit and EBITDA are real numbers and are
recomputed here straight from `journal_lines ⋈ chart_of_accounts` over the same window the endpoint uses.

| KPI | API | Independent DB query | |
|---|---|---|---|
| CFO `glRevenue` | 560 000 | 560 000 | ✅ |
| CFO `cogs` | 0 | 0 | ✅ |
| CFO `netProfit` | 560 000 | 560 000 | ✅ |
| Unattributed ledger lines | 0 | 0 | ✅ |

Two of these initially differed and both turned out to be *my expectation* being wrong rather than the
application:

- **AI attrition departments 15 vs 14** — the endpoint groups employees with no department as
  `'Unassigned'` rather than dropping them. `COUNT(DISTINCT department)` skips NULL, so the original
  expectation asserted the old, lossy behaviour. Corrected to count the bucket.
- **CFO `glPosted`** — the expectation asked "does `journal_lines` have any rows at all", when the
  endpoint's contract is "are there posted P&L lines **for this company in this period**". Corrected to
  the scoped, windowed question. See §4.

---

## 2. Silently-dead queries (fixed)

Each was wrapped so the error never surfaced. The feature reported "no data" indefinitely —
indistinguishable from a genuinely quiet dataset.

| Query | Broken reference | What the user saw |
|---|---|---|
| Work-centre KPI | `production_orders.completed_at` — **never existed** | `in_progress: 0` while **2 orders sat in `planned`** |
| Work-centre throughput trend | same | permanently empty chart |
| Scrap-rate fallback | same, inside an unreachable `.catch` | dead twice: `sqN` resolves rather than rejects, so the fallback could never run |
| Cash overdue detail | `invoices.client_name` — **never existed** | "top overdue invoices" empty while **15 were overdue** |
| Project-health budget | `projects.budget_used` / `.total_budget` | budget utilisation permanently null |
| Project-health completions | `tasks.completed_at` — **never existed** | completed-this-month permanently 0 |
| AI attrition risk | `employees.date_of_joining` + `status='active'` vs stored `'Active'` | **panel never rendered, in any environment** |
| AI stockout risk | `inventory_items.name` / `.unit` | panel never rendered |
| AI lead conversion | `leads.deal_value` / `.stage` | panel never rendered |
| AI attrition `ORDER BY` | output alias inside an expression — invalid in Postgres | query errored |
| `/intelligence/branches` | `employees.status IN ('active',…)` vs `'Active'` | employee count always 0 |

**Three of the four AI prediction panels had never once rendered.** All four now compute:
`revenue_forecast` 4 points · `attrition_risk` 15 departments · `stockout_risk` genuinely `no_data: true`
(every `reorder_point` is 0, so nothing is below it — honest) · `lead_conversion` 5 rows.

---

## 3. Fabricated values

Scanned the whole Analytics & AI surface, backend and frontend, for `Math.random`, arbitrary multipliers,
synthetic KPIs, fake targets, mock analytics and placeholder business data.

**Backend: clean.** The historical offenders are gone and their removal is documented in place —
`metricsEngine` no longer emits `target = headcount * 1.1`; CFO no longer derives
`netProfit = grossProfit * 0.78` or `ebitda = netProfit + opex * 0.05`.

**Frontend: clean.** No `Math.random` anywhere in the module. `SupplyChainRiskPanel`'s eight fake
`CRITICAL_COMPONENTS` are gone. The CFO chart no longer computes `target = revenue * 1.1` or
`profit = revenue * 0.28`.

**Two surviving constants, both declared rather than hidden:**

| Constant | Where | Why it is not fabrication |
|---|---|---|
| `× 0.88` / `× 1.12` | `/ai/predictions` revenue forecast | A ±12 % confidence band on a linear regression, emitted as separate `low`/`high` fields beside `predicted`. A stated model assumption, not a business figure. |
| `0.35` win rate | `/ceo-intelligence/manifest` | Ships alongside `forecast_is_measured: false`, so the consumer is told it is an assumption. |
| `× 0.85` | HR Benchmarking traffic light | An amber threshold — a presentation rule, not a value. |

---

## 4. Unmeasured ≠ zero

The design rule is enforced across the module. Fixed in this pass:

| Surface | Was | Now |
|---|---|---|
| Project Profitability **Cost** column | `₹0` — the one number on a row whose Profit and Margin both read `—` | `—`, greyed, with "No cost booked yet" |
| Portfolio **Total Contract Value** | **₹0** while the table below listed 3 × ₹50 000 — a card contradicting the rows it summarised | ₹150 000 across all projects |
| Portfolio **Total Cost** / **Total Profit** | `0` (sum over an empty set) | `null` → "No cost booked yet" |
| Portfolio margin base | costed-subset profit ÷ *all* contract value | ÷ costed-subset contract value, so the ratio compares like with like |
| Work-centre KPI on query failure | `0` | `null` + `kpi_available: false` |
| `avg_cycle_hrs` with nothing completed | `0` hours | `null` — not measurable yet |
| AI attrition department grouping | a group labelled `null` | `'Unassigned'` |

Already correct and re-verified: uncosted projects return `has_cost_data: false`, null margin and the
label `Cost Not Tracked` — **not** 100 % margin and a green "On Track". Traffic lights can report
`'unknown'`. HR Benchmarking emits `trainingDataAvailable` / `costPerHireAvailable`.

---

## 5. CFO: correct scoping, misleading sentence — and the underlying data gap, now closed

CFO reported **"no journal entries posted for this period"**. The ledger holds **nine posted entries**.

Every one carries `company_id = NULL`, so a company-scoped CFO correctly matches none of them. The
scoping is right — including them would be a cross-tenant leak. The *sentence* was the defect: it sent an
accountant to post entries that already exist, instead of to the attribution problem.

The endpoint now runs a second, unscoped count of the same window purely to choose the explanation
(never as a figure), and reports:

> journal entries exist for this period but none are attributed to your company
> (journal_entries.company_id is null) — accrual figures cannot be reported for this tenant

plus `unattributedLedgerLines: 3`. `CFODashboard.jsx` renders the backend's reason instead of its own
hardcoded string.

### 5.1 The root cause, fixed 2026-08-19

`journal.repository.js#createEntry` did not include `company_id` in its INSERT column list. Nine call
sites write through it — invoices, receipts, payments, bills, COGS, depreciation — so every entry they
produced was unattributed. Two further writers (GST RCM self-invoice, opening-balance migration) had the
same gap. **All 10 writers now set it**, and the repository derives the company from the source document
when a caller cannot supply one.

`backend/scripts/audit/backfill-journal-company.mjs` attributed the nine existing entries and their 18
lines — seven from their own source document (`invoices.company_id`, `fixed_assets.company_id`), two from
the sole-company case. It refuses to guess when a database holds more than one company and the evidence is
ambiguous, because attributing an entry to the *wrong* tenant is worse than leaving it unattributed.

**Result:** `glPosted: true`, `basis: 'posted general ledger'`, net profit **₹5 60 000**, EBITDA
**₹5 60 000** — all reconciling against a direct `journal_lines ⋈ chart_of_accounts` query, and
`unattributedLedgerLines: 0`.

A regression test in `tests/suites/16-analytics-contract.spec.ts` asserts that count stays at zero, so a
future writer that forgets `company_id` turns the build red instead of silently emptying the CFO's P&L.

---

## 6. Business lines

Derived from the `product_lines` master, with `taxonomy_source: 'product_lines'` declared in the payload.
All ten real lines are present (`ACB`, `APFC - 440V`, `APFC - 690V`, `ASTRA - 415V`, `ASTRA - 690V`,
`LEONINE - 415V`, `MBheem AHF`, `MV-VAJRA`, `RTPFC - 440V`, `RTPFC - 690V`) — no hard-coded list.

Unclassified projects are shown **explicitly** as `Unassigned` (3 projects, ₹70 000 revenue), never
silently excluded, and `coverage` reports `classified_projects: 0 / unclassified_projects: 3`.
`has_cost_data: false` and `margin_pct: null` per line.

---

## 7. AI insight traceability

`/ceo-intelligence/ai-insights` returns `signal_count: 0` with all five categories empty and:

> No signals crossed their thresholds in the current data. This reflects the records on file — it is not
> an assessment of areas the ERP does not yet track.

`derived_from_live_data: true`. Nothing is invented when there is nothing to say.

**Anomaly detection round-trip** (`scripts/audit/anomaly-fixture.mjs`) covers all three required cases:

| Case | Setup | Result |
|---|---|---|
| Insufficient data | 3 invoices in the 90-day window; detector needs ≥ 5 | inert, correctly silent |
| No anomaly | +6 invoices clustered at ~₹100 000 | **0 fixture rows flagged** |
| Known anomaly | +1 invoice at ₹10 000 000 | **detected**: `Invoice Amount Outlier`, severity `high`, `3.0σ from mean (₹11.17L)`, with `affected_id` and `variance_amount` |
| Restored | fixture removed | back to baseline |

That last column matters: a green "no anomalies" is meaningless until the same code has been shown to go
red on a real one. Before the schema audit, **four of five detectors threw on every run** (`po_items`,
three `payroll_runs` columns, and `invoices.client_name` — none of which exist) and reported zero.

---

## 8. Provenance of every headline KPI

| KPI | Source | Filters | Null behaviour |
|---|---|---|---|
| Revenue YTD | `invoices.total_amount` | paid statuses; `invoice_date ≥ FY start (1 Apr)`; company | 0 when no paid invoices |
| AR | `invoices.total_amount` | not paid/cancelled; not deleted; company | 0 |
| Headcount | `employees` | `EMPLOYEE_ACTIVE` incl. `'notice'`; company | 0 |
| Attrition | `employees` | `EMPLOYEE_EXITED`, case-insensitive | 0 % — **nobody has left**, not a broken query |
| Open tickets | `support_tickets` | not `TICKET_CLOSED`; not deleted; company | 0 |
| Pipeline | `opportunities.expected_value` | not deleted; company | 0 |
| Project margin | `project_cost_summary` | company | **null** + `has_cost_data: false` |
| Net profit / EBITDA | `journal_lines ⋈ chart_of_accounts` | posted; period; company | **null** + `glPosted: false` |
| Business lines | `product_lines` | — | `Unassigned` bucket |

**Revenue reconciles at ₹241 900 across CEO Intelligence, `metricsEngine`, `/dashboard/revenue` and
CFO.** The `FY_START` convention holds — revenue windows never use `date_trunc('year')`.
