# Analytics & AI — Tenant Isolation Report

**Date:** 2026-08-18, revised 2026-08-19 · **Result:** 9 live leaks found, 9 fixed, **0 remaining** —
re-verified against a 10 000-invoice dataset.

---

## 1. Why this had never actually been tested

The database ships with **one company**. That makes every isolation claim unfalsifiable: a query that
ignores `company_id` entirely returns the correct answer when there is only one tenant, so it passes
every test, every reconciliation and every manual check.

The previous audit read the code, found ten queries that took a `company_id` and ignored it, and filed
them as *"latent, 1 tenant today"*. **They were not latent.** They were live defects that could not be
observed without a second tenant.

Inspecting `_company_id` in source is not a test. This report is built on a second real company.

---

## 2. Method

`backend/scripts/audit/tenant-fixture.mjs --up` creates:

| Object | Marker |
|---|---|
| Company B | `code = ZZTENANTB` |
| Employee | `first_name = ZZTENANT`, `basic_salary = 123456` |
| User | `zztenant.b@zztenant.invalid`, **role `admin`** |
| Project | `ZZTENANT-PRJ-B1`, budget **9 999 999** |
| Invoice | `ZZTENANT-INV-B1`, total **7 777 777** |
| Production order | `ZZTENANT-PO-B1`, 42 units |
| Opportunity | `ZZTENANT Tenant B Opportunity`, value **8 888 888** |
| Support ticket | `ZZTENANT-TKT-B1` |

Company B's user holds **the same role as Company A's** (`admin`), so permissions are identical and any
difference in what comes back is scoping and nothing else.

`tenant-leak-probe.mjs` then calls **68 endpoints** as each company's admin and flags three things:

1. **`B-marker-in-A`** — Company B's marker string in a Company A response.
2. **`B-value-in-A`** — one of B's distinctive amounts (7 777 777 / 8 888 888 / 9 999 999) inside an A
   response. A string cannot survive `SUM()`; a number can, so this catches aggregate leakage that a text
   search would miss.
3. **`identical-across-tenants`** — a non-trivial response byte-identical for both. The signature of a
   query that never bound `company_id` at all. Empty and all-zero bodies are excluded: two tenants
   legitimately produce the same empty result.

---

## 3. Findings — before

**10 findings across 9 endpoints.**

| Endpoint | Finding | Evidence |
|---|---|---|
| `/analytics/manufacturing/work-centre` | identical | `in_progress: 3` served to **both** tenants — A's two orders plus B's one |
| `/dashboard/finance` | value + identical | receivable `12 964 177` for both, containing B's `7 777 777` |
| `/dashboard/cash` | identical | AR `12 964 177` for both |
| `/dashboard/data` | value | B's `7 777 777` inside A's **Revenue (MTD)** KPI |
| `/dashboard/sales` | identical | `prospecting: 9 068 888` = A's 180 000 + B's 8 888 888 |
| `/dashboard/top-customers` | identical | same five customers for both |
| `/dashboard/top-vendors` | identical | same five vendors for both |
| `/dashboard/project-health` | identical | `active_projects: 4` = A's 3 + B's 1 |
| `/ai/predictions` | value | B's `7 777 777` in A's `revenue_forecast.historical[4]` |

---

## 4. Fixes

Every table involved already had a `company_id`; none of the queries used it.

- **`dashboard.controller.js`** — `getFinanceDashboard` (12 queries), `getDashboardCashPosition`
  (9 queries), `getDashboardSalesPipeline`, `getTopCustomers`, `getTopVendors`,
  `getDashboardProjectHealth`, `getExecutiveData`, `getManagerData`, and the `/dashboard/summary` alert
  UNION whose second and third arms were unscoped while its first arm was.
- **`manufacturing.routes.js`** — the router had *no* scoping at all. `work_centres`,
  `production_orders`, `production_scrap` and `engineering_changes` are now bound directly.
  `test_runs` / `test_run_measurements` carry no `company_id`, so they are scoped through the production
  order or project the run belongs to; a run reachable from neither is excluded when a company scope is
  in force — counting it for everyone is the leak, counting it for nobody is the safe direction.
- **`ai.routes.js`** — all four `/ai/predictions` queries bound.

`tasks` has no `company_id`; it is scoped through its project, matching what `/analytics/productivity`
already did.

A null company id still means a genuinely global scope (an unassigned super admin), preserving the
established `($1 IS NULL OR company_id = $1)` convention.

---

## 5. Findings — after

```
{"findings":0,"byKind":{}}
```

All 68 endpoints return **200 for both tenants** — an endpoint that 403s for one side would "not leak"
trivially, so the suite asserts both sides get real data first.

**Values now diverge correctly:**

| Endpoint | Company A | Company B |
|---|---|---|
| `/dashboard/finance` receivable | ₹5 186 400 | ₹7 777 777 |
| `/dashboard/cash` AR | ₹5 186 400 | ₹7 777 777 |
| `/dashboard/sales` | 5 stages | 1 stage (₹8 888 888) |
| `/dashboard/project-health` active | 3 | 1 |
| `/analytics/manufacturing/work-centre` in-progress | 2 | 1 |
| `/dashboard/top-customers` | 5 rows | 0 rows |

---

## 6. The suite is proven to catch a regression

A passing isolation test means nothing unless it can fail. The `company_id` binding was removed from
`/dashboard/sales`, the server restarted, and the suite re-run:

```
1 failed
  @P0 Multi-tenant isolation › no endpoint returns byte-identical data to two different tenants
      "ep": "/dashboard/sales"
```

It failed, and named the endpoint. The fix was restored and the suite went green again (6/6).

---

## 7. Regression coverage

`tests/suites/17-tenant-isolation.spec.ts` — Playwright project `tenant-isolation`, **6 tests**:

1. the fixture really is two companies with identical roles
2. both tenants can reach every endpoint (no false PASS from a 403)
3. Company B's records never appear in Company A's responses
4. Company B's values never appear inside Company A's aggregates
5. no endpoint returns byte-identical data to two different tenants
6. the probe found nothing of any kind

The fixture is created in `beforeAll` and torn down in `afterAll`.

**Teardown is schema-driven.** Creating a company has side effects elsewhere in the app — seeded
interview question banks, notification rules, customer-health rows written by the nightly cron — so a
hand-written child list goes stale the moment any of those change and leaves the company undeletable,
which then makes the next `--up` fail on a unique constraint. Teardown instead enumerates every table
carrying a `company_id`, deletes that company's rows, and repeats while progress is being made so
foreign-key ordering resolves itself. Verified: `companies` returns to a single row and zero marked
records remain.

---

## 8. Re-verified at production scale

A scoping bug can hide behind small numbers: with three projects, a missing filter and a correct one can
produce the same-looking output. The isolation suite was therefore re-run against a seeded dataset of
10 000 invoices, 5 000 tickets, 4 000 bills, 2 000 employees, 2 000 opportunities and 500 projects
(`backend/scripts/audit/scale-fixture.mjs`, removed afterwards).

**All 6 isolation tests and all 23 contract tests passed at that volume**, and the KPI reconciliation
stayed at 20/20. The findings count remained 0.

---

## 9. Scope of this evidence

- **Covered:** dashboards, KPIs, charts, tables, filters, drill-downs, aggregate endpoints, AI insights,
  AI anomalies — 68 endpoints, both directions.
- **Not covered:** exports/downloads (no export endpoint in this module's surface), and background jobs.
  The crons reuse the same scoped service functions, but this pass did not drive them.
- **Cache keys:** the analytics cache key already includes `company_id`. The defect was never the key —
  it was that `computeRevenueMetrics` / `computeSalesKPIs` accepted a `_company_id` and ignored it while
  the key varied on it. Those functions are now bound.
- **Client-supplied tenant ids:** no endpoint in this surface reads `company_id` from
  `req.body`/`req.query`. Every one resolves it from `req.scope`, set by `verifyToken` from the JWT
  claim with a DB fallback (`shared/scope.js`).
