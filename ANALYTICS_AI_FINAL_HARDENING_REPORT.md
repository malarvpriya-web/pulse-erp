# Analytics & AI — Final Hardening Report

**Date:** 2026-08-18, revised 2026-08-19
**Scope:** the eight pages in the `Analytics & AI` menu and the 77-endpoint backend surface behind them.
**Verdict:** 🟢 **READY FOR GO-LIVE** — every technical gate passes and all three blockers are closed (§9).

> **Revision 2026-08-19.** The 2026-08-18 verdict was CONDITIONALLY READY pending three blockers. All
> three are now closed: the E2E suite is in the repository and CI-gated, every journal entry is
> attributed to a company (CFO now reports real accrual figures), and the module has been measured
> against a production-scale dataset. Five previously-untested mutating actions were also driven for
> real, which surfaced one further defect (§3.7). Counts and evidence below are from the revised run.

This pass did not assume the previous remediation (`ANALYTICS_AI_REMEDIATION_REPORT.md`, "🟢 95/100") was
correct. It re-derived every claim from the running application and the live database. **The previous
report's headline claims were largely accurate for what it measured — but three of its measuring
instruments were themselves broken, and the classes of defect they could not see were the serious ones.**

---

## 1. Executive summary

| | Before this pass | After |
|---|---|---|
| SQL-reference checker coverage | 7 of 15 analytics source files | **15 of 15** |
| SQL-reference checker parser | EXTRACT suppression dead (literal `0x08` byte) | **repaired + byte-level regression test** |
| Cross-tenant leaks | unknown — untestable with 1 company | **9 found, 9 fixed, 0 remain** |
| KPI reconciliation vs direct DB query | 4 KPIs | **19/19** |
| Browser (real Chromium) verification | none | **22 tests, 8 pages, all pass** |
| RBAC probes | 1 low-privilege token | **2 156 probes = 26 roles × 77 endpoints + anon + bad-token** |
| Backend tests | 587 pass | **596 pass / 9 skip** |
| Playwright | 21 (API-level only) | **51 across 3 suites** |
| Silently-dead analytics queries | unknown | **11 found and fixed** |
| Mutating actions verified | 0 of 5 | **5 of 5** (11 assertions incl. authz) |
| Journal entries attributed to a company | 0 of 9 | **9 of 9** |
| Largest dataset measured | 35 invoices | **10 000 invoices / 5 000 tickets / 2 000 employees** |
| E2E suite in the git repository | **no** — untracked, never ran in CI | **yes**, 37 files, CI-gated |

**26 defects were found and fixed in this pass.** None of them were visible to the checks that existed
when it started.

---

## 2. Why the previous pass could not have found these

Three instruments were reporting green while blind:

**2.1 — The SQL-reference checker scanned 7 of the module's 15 files.**
`manufacturing.routes.js`, `powerQuality.routes.js`, `intelligence.routes.js`,
`user-dashboard.routes.js`, `metricsCalculator.js`, `aiPayroll.controller.js`, `kpiNarrator.js` and
`ticketThreadNarrator.js` were never scanned. Extending the list surfaced **18 broken references
immediately**.

**2.2 — Its EXTRACT false-positive suppression was dead code.**

```
0000020   C   a   l   l       =       /  \b   (   E   X   T   R   A   C
```

`od -c` shows a literal **backspace byte (0x08)** where the source was meant to read `\b`. In a regex
literal that matches an actual backspace character, so the branch never fired. Terminals *render* a
backspace by moving the cursor left, so the line looked correct in every editor, every diff and every
review. `src/__tests__/analytics.schemaGuards.test.js` now asserts at byte level that neither checker
contains a control character.

**2.3 — Tenant isolation was unfalsifiable.**
The database held one company. Every isolation claim was untestable: a query that ignores `company_id`
entirely returns the correct answer when there is only one tenant. The previous audit read the code and
filed ten unscoped queries as *"latent, 1 tenant today"*. Seeding a second company showed they were
**not latent** — nine of them were leaking live.

---

## 3. Defects found and fixed

### 3.1 Cross-tenant data leaks (P0 — 9 endpoints)

Proven by seeding Company B with marked records (`ZZTENANT`, invoice ₹7,777,777, opportunity ₹8,888,888)
and sweeping every endpoint as an admin of each company. Both fixtures hold the **same role**, so any
difference is scoping and nothing else.

| Endpoint | Leak | Fix |
|---|---|---|
| `/analytics/manufacturing/work-centre` | `in_progress: 3` shown to **both** tenants (2 + 1) | company scope on `work_centres`/`production_orders`; `test_runs` scoped via its production order or project |
| `/dashboard/finance` | B's ₹7,777,777 invoice in A's receivable; 12 unscoped queries | all 12 bound to `company_id` |
| `/dashboard/cash` | AR/AP/aging/bank balance summed every tenant | all bound |
| `/dashboard/data` | B's invoice inside A's **Revenue MTD KPI** | executive + manager blocks bound |
| `/dashboard/sales` | B's ₹8,888,888 opportunity in A's pipeline | bound |
| `/dashboard/top-customers` | identical leaderboard for both tenants | bound |
| `/dashboard/top-vendors` | identical leaderboard for both tenants | bound |
| `/dashboard/project-health` | `active_projects` counted both tenants | bound; `tasks` scoped through its project |
| `/ai/predictions` | B's invoice in A's revenue forecast; 4 unscoped queries | all bound |

**Verified after fix:** A receivable ₹51.86 L vs B ₹77.78 L · A pipeline 5 stages vs B 1 · A projects 3
vs B 1 · A work-centre `in_progress` 2 vs B 1. Probe reports **0 findings**.

### 3.2 Silently-dead queries (P1 — 11)

Each was wrapped in `try/catch` or `.catch(() => [])`, so a nonexistent column produced "no data"
forever — indistinguishable from a quiet dataset.

| Location | Broken reference | Symptom |
|---|---|---|
| `manufacturing.routes.js` work-centre KPI | `production_orders.completed_at` (never existed) | **reported `in_progress: 0` while 2 orders sat in `planned`** |
| `manufacturing.routes.js` throughput trend | same | trend permanently empty |
| `manufacturing.routes.js` scrap fallback | same, inside an unreachable `.catch` | dead twice over |
| `dashboard.controller.js` cash detail | `invoices.client_name` (never existed) | **"top overdue invoices" empty while 15 were overdue** |
| `dashboard.controller.js` project health | `projects.budget_used` / `.total_budget` | budget utilisation permanently null |
| `dashboard.controller.js` project health | `tasks.completed_at` (never existed) | completed-this-month permanently 0 |
| `ai.routes.js` attrition_risk | `employees.date_of_joining` + `status='active'` vs stored `'Active'` | **panel never once rendered** |
| `ai.routes.js` stockout_risk | `inventory_items.name` / `.unit` | panel never rendered |
| `ai.routes.js` lead_conversion | `leads.deal_value` / `.stage` | panel never rendered |
| `ai.routes.js` attrition ORDER BY | output alias inside an expression | invalid SQL |
| `intelligence.routes.js` branches | `employees.status IN ('active',…)` vs `'Active'` | employee count always 0 |

**3 of the 4 AI prediction panels had never rendered in any environment.** All four now compute.

### 3.3 Authorization (P0)

`/api/v1/intelligence/*` — 46 endpoints — was mounted with `verifyToken` and **no permission policy**.
A plain `employee` could read `/intelligence/roles` (the whole role table) and `/intelligence/rules`
(rule-engine configuration): both returned **200**. Now gated by `intelligencePolicy`, deny-by-default at
`admin:view`, with per-domain rules. Both return **403**.

### 3.4 Truthfulness — unmeasured presented as measured (P1)

| Surface | Was | Now |
|---|---|---|
| Project Profitability *Cost* column | `₹0` beside `—` profit and `—` margin | `—` with "No cost booked yet" |
| Portfolio *Total Contract Value* | **₹0** while the table below listed 3 × ₹50,000 | ₹150,000 across all projects; costed subset carried separately for margin |
| Portfolio *Total Cost* / *Total Profit* | `0` (sum of an empty set) | `null` → "No cost booked yet" |
| Work-centre KPI on query failure | `0` | `null` + `kpi_available: false` |
| CFO net profit / EBITDA reason | hardcoded "No journal entries for this period" | the backend's real reason (see §3.5) |
| `/ai/predictions` errors | `note: err.message` — raw SQL **in a 200 body**, which the 5xx sanitizer never sees | generic message; detail to server logs |
| AI attrition departments | a group labelled `null` | `'Unassigned'` |

### 3.5 A misleading — not wrong — CFO message

CFO reported *"no journal entries posted for this period"*. There **are** nine posted entries. Every one
carries `company_id = NULL`, so a company-scoped CFO correctly sees none. The scoping is right; the
sentence sent an accountant to post entries that already exist. It now distinguishes the two cases and
reports `unattributedLedgerLines`, and the frontend renders the backend's reason instead of its own.

### 3.6 Error handling (P2)

`?period=NOT_A_PERIOD` returned **200**, silently fell back to YTD, and **echoed the bogus period back**,
so a caller believed it had data for a period that does not exist. Now `400` listing the allowed values.

### 3.7 Mutating actions — one further defect (P2)

Driving the five write actions for real (§4.2) surfaced one more:
`POST /ceo-intelligence/customers/:partyId/convert-upsell` returned **500** for a malformed `:partyId`.
`parties.id` is a uuid, so a non-uuid reaches Postgres and raises 22P02; the handler's
`catch` turned that into a server fault and, outside production, returned the raw Postgres text. It now
uses `respondError`, giving **400** for a malformed id and **404** for a well-formed one that matches
nothing.

---

## 4. Verification evidence

All figures produced on **2026-08-19** against the project's own dev stack — backend `:5000`, frontend
`:5173` — both restarted onto the fixed code. No environment overrides, no private ports: this is the
stack a developer actually runs.

| Gate | Result | Evidence |
|---|---|---|
| Backend unit + integration | **596 pass / 9 skip / 0 fail** (25 files) | `npx vitest run`, stable over 3 consecutive runs |
| Frontend unit | **295 pass / 0 fail** (17 files) | `npx vitest run` |
| SQL-reference checker | **PASS** — 15 files, 451 tables, 805 columns | `npm run check:sql-refs` |
| Status-vocabulary checker | **PASS** | `npm run check:statuses` |
| Checker negative fixtures | **9/9 pass** — both checkers proven to fail on injected defects | `analytics.schemaGuards.test.js` |
| KPI reconciliation | **20/20 match** independent DB queries | `scripts/audit/kpi-reconcile.mjs` |
| Mutating actions | **11/11 pass** — 5 write actions + their authz | `scripts/audit/mutating-actions-probe.mjs` |
| RBAC | **2 156 probes**, 0 × 5xx, 0 × 404, anon/bad-token 401 on all 77 | `scripts/audit/rbac-probe.mjs` |
| Tenant isolation | **0 findings**; suite proven to go red on a reintroduced leak | `scripts/audit/tenant-leak-probe.mjs` |
| Anomaly detection | **PASS** — insufficient-data / no-anomaly / known-anomaly all correct | `scripts/audit/anomaly-fixture.mjs` |
| Playwright | **51/51 pass** (contract 23, tenant 6, browser 22) | 3 projects, run against `:5000`/`:5173` |
| Performance @ production scale | p50 **17 ms**, p95 **204 ms**, nothing > 1 s | 10 000 invoices — `scripts/audit/perf-probe.mjs` |
| Production build | **PASS** — 2.85 s, no source maps, API base resolves to prod host | `vite build --mode production` |

### 4.1 Gates proven to fail, not just to pass

A gate that only ever passes proves nothing. Each of these was made to go red on demand:

- **SQL checker** — injected a missing column, a missing table, and a defect in one of the eight
  newly-covered files: all three caught, exit 1.
- **Status checker** — dropped `'notice'` from `EMPLOYEE_ACTIVE`: caught, exit 1.
- **Tenant isolation** — removed the `company_id` binding from `/dashboard/sales`: the suite failed and
  named the endpoint. Fix restored, suite green again.
- **Anomaly detector** — planted a 3.0σ invoice: detected, with `affected_id` and `variance_amount`;
  removed: silent again.

### 4.2 The five write actions, driven for real

`scripts/audit/mutating-actions-probe.mjs` runs each against a throwaway party and a throwaway login,
then deletes both. All 11 assertions pass:

| Action | Result |
|---|---|
| `POST /ceo-intelligence/customers/:id/convert-upsell` | **201**, opportunity row created |
| …as a plain employee | **403** |
| …unknown (well-formed) customer id | **404** |
| …malformed uuid | **400** — was 500 before this pass (§3.7) |
| `POST /admin/users/:id/reset-password` | **200**, password hash changed |
| …as a plain employee | **403** |
| `POST /admin/users` (the CSV import row path) | **201**, user created |
| …as a plain employee | **403** |
| `POST /ai/llm-chat` with no API key | **503** "AI service is not configured" — not a 500, not a fabricated answer |
| `POST /ai/chat` with no API key | **200**, deterministic keyword responder |
| `POST /ai/llm-chat` as a plain employee | **403** |

There is **no bulk import endpoint**: AdminDashboard's CSV drawer loops `POST /admin/users` once per
parsed row, so that is the route the probe exercises. The action matrix previously listed
`/admin/users/import`, which does not exist.

The LLM calls are driven far enough to prove routing, authorization and the unconfigured-key contract
without spending a token. With a real `OPENAI_API_KEY` present the probe reports those two as skipped
rather than billing the account.

## 5. RBAC summary

26 roles × 77 endpoints. Only `admin` and `super_admin` reach all 77.

| Data class | Reachable by |
|---|---|
| Salary bands, HR benchmarks, payroll AI | admin, super_admin, finance_manager, hr, hr_manager, payroll_admin |
| CFO P&L, cash, collections | admin, super_admin, accounts_exec, finance, finance_manager |
| Named performance leaderboard | admin, super_admin, hr, hr_exec, hr_manager, payroll_admin |
| CEO executive summary | admin, super_admin, sales_exec, sales_manager |
| `/intelligence/*` administration | admin, super_admin |
| Celebrations (birthday wall) | every authenticated user — by design |

A plain `employee` reaches **4 of 77**: celebrations ×2, `/analytics/satisfaction` and
`/dashboard/leave-summary` — both verified aggregate-only, no named individuals.

Anonymous and bad-token requests: **401 on all 77**.

---

## 6. Performance

Measured twice: once on the shipped dataset, once against a seeded production-scale one
(`scripts/audit/scale-fixture.mjs`: 10 000 invoices, 5 000 tickets, 4 000 bills, 2 000 employees,
2 000 opportunities, 2 000 production orders, 3 000 journal lines, 500 projects — all removed afterwards).

| | Shipped data (35 invoices) | **Production scale (10 000 invoices)** |
|---|---|---|
| Overall p50 | 13 ms | **17 ms** |
| Overall p95 | 121 ms | **204 ms** |
| Endpoints over 1 s | 0 | **0** |
| Largest payload | 7.1 KB | **26.8 KB** (`/ceo-intelligence/projects`, `LIMIT 50` — bounded) |

Slowest at scale: `/dashboard/live-kpis` 241/305 ms · `/ai/prescriptive` 140/204 ms ·
`/dashboard/cfo` 151/184 ms · `/ceo-intelligence/ai-insights` 113/182 ms ·
`/ceo-intelligence/vendors` 112/121 ms.

**A 285× increase in row count cost roughly 1.7× in latency**, which is what an indexed, company-scoped
query set should look like. Nothing degrades non-linearly and no endpoint approaches a second.

**Correctness holds at scale**, which matters more than the timings: all **20/20 KPI reconciliations**
and the full **tenant-isolation suite** were re-run against the seeded dataset and passed. A scoping bug
that only appears with volume would have shown up here.

**CEO Intelligence issues 20 endpoint calls on mount**, in parallel, covering every tab. At scale the
wall time is still bounded by the slowest (~305 ms), so it is not a latency problem, and it is why tab
switching is instant. **Not changed** — lazy-loading per tab is a design change whose only measurable
benefit is saved server work, and the risk of introducing a scoping regression outweighs it.

## 7. Production build

`vite build --mode production` — clean, 2.85 s, **no source maps shipped**, `VITE_API_URL` correctly
resolves to `https://api.manifest-tech.in/api` (8 occurrences).

Two `localhost` strings survive, both benign:
- `localhost:9000` ×2 — the **input placeholder** for the Tally Gateway URL, which genuinely runs on the
  operator's own machine. Correct.
- `localhost:5000` ×1 — the `VITE_API_URL || 'http://localhost:5000/api'` fallback in
  `services/api/client.js`. Unreachable when the variable is set. **Left alone deliberately**: hardening
  it touches the API client every module shares, which is outside this module's scope. Flagged in §10.

---

## 8. CI

The three analytics Playwright projects — contract, tenant-isolation, browser — now run as **blocking**
steps in `.github/workflows/ci.yml` (docker job, after the stack boots), with `::error` annotation and
artefact upload on failure.

**They can now actually run.** Until this pass the entire suite lived outside the repository and was
untracked, so no E2E gate had ever executed in CI — including the 21 contract tests the previous
remediation cited as its evidence. `playwright.config.ts`, `tests/` (37 source files) and the merged root
`package.json` are now inside the repo; generated output (`tests/reports/`, `tests/.auth/`,
`test-results/`) is gitignored. The docker job also gained a Node runtime, which it did not have — it
previously only shelled out to `docker compose`.

Already present and unchanged: migrations, test-fixture seed, both schema checkers as hard gates (before
the unit tests), backend tests, the authorization-coverage ratchet, frontend lint/test/build, and a full
docker build + boot.

## 9. Blockers — all closed

**1. ✅ The E2E suite is now in the repository.**
Was: the git root is `Pulse_WORKING/Pulse/`, while `playwright.config.ts`, `tests/` and the root
`package.json` sat one level above it, untracked — so every E2E gate was uncommitted and had never run in
CI. Now: 37 source files moved under `Pulse/`, path references rewritten to resolve from the repo root
rather than an absolute developer path, root `package.json` merged (test scripts + devDependencies,
`npm run test:analytics`), generated output gitignored, CI job wired and given a Node runtime.
**Verified: 51/51 pass from the new location, run against `:5000`/`:5173`.**

**2. ✅ Journal entries are attributed to a company.**
Was: all nine posted entries carried `company_id = NULL`, so a company-scoped CFO matched none of them
and net profit / EBITDA read "Not available". Root cause: `journal.repository.js#createEntry` omitted
`company_id` from its column list, affecting **nine call sites**; two other writers (GST RCM self-invoice,
opening-balance migration) had the same gap.
Now: the repository accepts `company_id` and, when a caller cannot supply one, derives it from the source
document it is already referencing; the callers that have it pass it explicitly; all **10 writers** set it;
`scripts/audit/backfill-journal-company.mjs` attributed the 9 existing entries (7 from their source
document, 2 from the sole-company case) and their 18 lines.
**Verified: CFO now reports net profit ₹5 60 000 and EBITDA ₹5 60 000 from `basis: 'posted general
ledger'`, and those figures reconcile against a direct `journal_lines ⋈ chart_of_accounts` query.**
A regression test asserts `unattributedLedgerLines === 0`.

**3. ✅ Performance is measured at production scale.**
Was: 34 employees / 35 invoices / 3 projects — numbers that said nothing about real volume.
Now: measured at 10 000 invoices and 5 000 tickets (§6). p95 204 ms, nothing over 1 s, correctness
re-verified at that volume. The fixture is repeatable (`scale-fixture.mjs --up --scale=N`) so this can be
re-run against any target volume.

## 10. Open findings not fixed (with reasons)

| Finding | Why not fixed |
|---|---|
| `/intelligence/*` — 8 capabilities have no backing table (`sla_config`, `sla_tracking`, `dashboard_widgets`, `documents`, `project_costs`, `budget_vs_actual`, `profit_tracker`, `masters`), none of which appears in any migration in the repo's history | They now return **501** with a clear message instead of a 500 leaking schema, and the checker lists them as UNIMPLEMENTED on every run. Building nine tables or deleting 46 endpoints is a product decision. |
| `/intelligence/*` has **zero** frontend callers | Deleting a 813-line router is a product decision. It is now guarded, so the exposure is closed either way. |
| `services/api/client.js` falls back to `localhost:5000` | Shared by every module; outside this scope. |
| CFO `dso: 2980 days` | Arithmetically correct (AR ÷ tiny YTD revenue × days). An artifact of thin data, not a defect. |
| `/dashboard/leave-summary` shows company-wide pending count to any employee | Aggregate-only, guarded by `leave:view` which employees hold to see their own leave. Product decision. |
| CEO Intelligence prefetches 20 endpoints on mount | See §6 — measured, not a latency problem, and changing it risks a scoping regression. |

---

## 11. Files changed

**Backend — analytics**
- `src/modules/dashboard/dashboard.controller.js` — 9 tenant fixes, 3 column fixes, period validation, unattributed-ledger probe
- `src/analytics/routes/manufacturing.routes.js` — `completed_at` fix, company scoping, failure-vs-empty markers, dead fallback removed
- `src/modules/intelligence/ai.routes.js` — 4 prediction queries fixed + scoped, SQL-message leak closed
- `src/modules/intelligence/ceo-intelligence.routes.js` — portfolio roll-up contradictions, `respondError` on convert-upsell, company-filter interpolation hardened (31 sites routed through one coercing helper)
- `src/modules/intelligence/intelligence.routes.js` — 501 short-circuit, 9 column fixes, canonical status predicate
- `src/shared/analyticsAuthz.js` — `intelligencePolicy`
- `server.js` — guarded `/intelligence` mount

**Backend — finance (blocker 2)**
- `src/modules/finance/repositories/journal.repository.js` — `createEntry` persists `company_id`, with a source-document fallback
- `src/modules/finance/services/{invoice,receipt,depreciation}.service.js` — pass `company_id` explicitly
- `src/modules/finance/gst.routes.js`, `accounting.routes.js` — the two remaining writers that omitted it

**Checkers and audit tooling**
- `scripts/check-sql-references.mjs` — 0x08 byte repaired, 8 files added, `CHECK_SRC_ROOT`, UNIMPLEMENTED bucket
- `scripts/check-status-vocabulary.mjs` — `CHECK_SRC_ROOT`
- `src/__tests__/analytics.schemaGuards.test.js` — **new**, 9 negative fixtures
- `scripts/audit/` — **new**: `rbac-probe`, `tenant-fixture`, `tenant-leak-probe`, `kpi-reconcile`,
  `anomaly-fixture`, `perf-probe`, `scale-fixture`, `mutating-actions-probe`, `backfill-journal-company`

**Frontend**
- `features/analytics/pages/ProjectProfitabilityPanel.jsx` — cost/profit honesty
- `features/finance/pages/CFODashboard.jsx` — renders the backend's GL reason

**Tests / CI / repo layout**
- `tests/` (37 files), `playwright.config.ts`, `scripts-analysis/` — **moved into the repository**
- `package.json` — merged test scripts + devDependencies; `test:analytics`, `test:e2e`
- `.gitignore` — generated test output excluded
- `tests/suites/16-analytics-contract.spec.ts` — +2 tests (ledger attribution, mutating actions) = 23
- `tests/suites/17-tenant-isolation.spec.ts` — **new**, 6 tests
- `tests/suites/18-analytics-browser.spec.ts` — **new**, 22 tests
- `tests/auth.setup.ts` — repo-relative backend path; configurable target
- `.github/workflows/ci.yml` — E2E gates now runnable + blocking; Node runtime added to the docker job
