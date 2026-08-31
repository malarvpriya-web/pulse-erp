# Analytics & AI — Go-Live Checklist

**Date:** 2026-08-18, revised 2026-08-19
**Verdict:** 🟢 **READY FOR GO-LIVE**

All three blockers from the 2026-08-18 revision are closed. Every mandatory gate passes, verified against
the project's own dev stack (`:5000` / `:5173`) running the fixed code.

---

## Part 1 — Phase 17 regression audit

The original audit's fourteen categories, re-tested from scratch. No "mostly fixed".

| # | Category | Status | Evidence |
|---|---|---|---|
| 1 | Fabricated CFO values | **PASS** | `netProfit`/`ebitda` now come from the posted ledger (₹5 60 000 each) and reconcile against a direct `journal_lines ⋈ chart_of_accounts` query; the `*0.78` / `+opex*0.05` derivations are gone |
| 2 | Contradicting KPIs | **PASS** | 5 cross-surface reconciliations green; **one new contradiction found and fixed**: portfolio "Total Contract Value ₹0" above a table of 3 × ₹50 000 |
| 3 | Status mismatches | **PASS** | `check-statuses` PASS; proven to fail when `'notice'` is dropped; one live casing bug fixed in `/intelligence/branches` |
| 4 | Endpoint permissions | **PASS** | 2 156 probes; `/intelligence/*` (46 endpoints) was **unguarded** — a plain employee got 200 on `/roles` and `/rules`; now 403 |
| 5 | Mock critical components | **PASS** | no `Math.random` anywhere in the module; `CRITICAL_COMPONENTS` gone |
| 6 | Fake AI insights | **PASS** | `derived_from_live_data: true`; anomaly round-trip proven in all three cases (insufficient / none / known) |
| 7 | Hard-coded Business Lines | **PASS** | all 10 lines from `product_lines`; `taxonomy_source` declared; unclassified shown as `Unassigned`, not dropped |
| 8 | CFO alert actions | **PASS** | all four **clicked**: → `/InvoicesNew`, `/Expenses`, `/ProjectsDashboard`, `/LeaveApprovals` |
| 9 | HR filter bugs | **PASS** | period + department both fire `GET /analytics/*` **with a query string**; browser-verified |
| 10 | API error masking | **PASS** | 400/401/403/404/501 all correct; `?period=NOT_A_PERIOD` now 400; `/ai/predictions` no longer returns raw SQL in a 200 body; convert-upsell no longer 500s on a malformed uuid |
| 11 | Tenant scoping | **PASS** | **9 live leaks found and fixed**; probe reports 0, re-verified at 10 000-invoice scale; suite proven to fail on a reintroduced leak |
| 12 | Missing tables | **PASS** | 8 never-existed tables now 501 + listed as UNIMPLEMENTED every run |
| 13 | SQL reference defects | **PASS** | checker coverage 7 → 15 files; **18 hidden defects** surfaced; 0x08 parser byte repaired |
| 14 | Status vocabulary defects | **PASS** | PASS + negative fixture |

**14/14 PASS.**

---

## Part 2 — Mandatory gates

| Gate | Result | Evidence |
|---|---|---|
| Backend unit + integration | ✅ **596 pass / 9 skip / 0 fail** | 25 files, stable over 3 consecutive runs |
| Frontend unit | ✅ **295 pass / 0 fail** | 17 files |
| SQL-reference checker | ✅ PASS | 15 files · 451 tables · 805 columns |
| Status-vocabulary checker | ✅ PASS | live DB values vs `statusSets.js` |
| Checkers proven to detect defects | ✅ **9/9** | `analytics.schemaGuards.test.js` |
| KPI reconciliation | ✅ **20/20** | independent DB queries, incl. live accrual figures |
| Mutating actions | ✅ **11/11** | all 5 write actions + their authorization |
| RBAC | ✅ 0 × 5xx, anon/bad-token 401 on all 77 | 2 156 probes |
| Tenant isolation | ✅ **0 findings** | 68 endpoints × 2 companies, re-verified at scale |
| Anomaly detection | ✅ PASS | 3 cases + traceable evidence |
| Playwright E2E | ✅ **51/51** | 3 projects, against `:5000`/`:5173` |
| Browser render, deep link, reload | ✅ 8/8 pages | Chromium |
| Every action exercised | ✅ **46/46** | 41 clicked + 5 driven via the write probe |
| Performance @ production scale | ✅ p50 17 ms · p95 204 ms · 0 over 1 s | 10 000 invoices |
| Production build | ✅ clean, no source maps, prod API host | `vite build --mode production` |
| CI schema gates | ✅ blocking | `ci.yml` backend job |
| CI E2E gates | ✅ **blocking and runnable** | suite now in the repo |

---

## Part 3 — Blockers: all closed

### ✅ Blocker 1 — E2E suite is in the repository *(was: CI)*

The git root is `Pulse_WORKING/Pulse/`. `playwright.config.ts`, `tests/` and the root `package.json` sat
one level **above** it and were **untracked** — so every E2E gate, including the 21 contract tests the
previous remediation cited as its evidence, was uncommitted and had never run in CI.

**Closed.** 37 source files moved under `Pulse/`; path references rewritten to resolve from the repo root
instead of a hard-coded developer path; root `package.json` merged (test scripts + devDependencies, plus
`npm run test:analytics`); generated output gitignored; CI wired to run the three projects as blocking
steps, and given the Node runtime the docker job previously lacked.

**Verified: 51/51 pass from the new location.**

### ✅ Blocker 2 — Journal entries are attributed to a company *(was: data)*

All nine posted entries carried `company_id = NULL`, so a company-scoped CFO matched none of them and net
profit / EBITDA read "Not available". The cause was `journal.repository.js#createEntry` omitting
`company_id` from its column list — affecting nine call sites — plus two other writers with the same gap.

**Closed.** The repository now persists `company_id`, deriving it from the source document when a caller
cannot supply one; callers that have it pass it explicitly; all 10 writers set it; the 9 existing entries
and their 18 lines were backfilled (7 from their source document, 2 from the sole-company case).

**Verified: net profit ₹5 60 000 and EBITDA ₹5 60 000 from `basis: 'posted general ledger'`, reconciling
against a direct ledger query.** A regression test asserts `unattributedLedgerLines === 0`.

### ✅ Blocker 3 — Performance measured at production scale *(was: data)*

**Closed.** Seeded 10 000 invoices, 5 000 tickets, 4 000 bills, 2 000 employees, 2 000 opportunities,
2 000 production orders, 3 000 journal lines and 500 projects, then measured and removed the fixture.

p50 **17 ms**, p95 **204 ms**, **nothing over 1 s**. A 285× increase in rows cost ~1.7× in latency.
Crucially, **20/20 KPI reconciliations and the full tenant-isolation suite were re-run at that volume and
passed** — a scoping bug that only appears with data would have surfaced there.

---

## Part 4 — Remaining business-data gaps

Not defects. The analytics are correct; the source tables are empty. Each renders an honest
"not available" state today.

| Gap | Effect | Unblocks |
|---|---|---|
| `project_cost_summary` empty | all project margins null, `Cost Not Tracked` | ~15 metrics — the highest-value single fix |
| `performance_reviews` empty | satisfaction score 0, top performers empty | HR performance analytics |
| `amc_contracts` empty | ARR ₹0 | recurring-revenue view |
| `sales_targets` empty | no target-vs-actual | sales attainment |
| `production_scrap`, `test_runs` empty | scrap + burn-test charts empty | manufacturing quality |
| `inventory_items.reorder_point` all 0 | stockout risk correctly `no_data` | inventory AI |
| 0 of 3 projects classified to a product line | everything in `Unassigned` | business-line P&L |
| 3 invoices in the 90-day window (detector needs ≥ 5) | invoice-outlier detector inert | anomaly detection |

> These are why several panels are empty on the shipped dataset. They are **not** blockers: every one of
> them is reported truthfully rather than as a zero, which is the property this audit was checking.

---

## Part 5 — Product / UX decisions for the owner

Not correctness issues. Listed so they are decided rather than defaulted.

| Decision | Recommendation |
|---|---|
| `/api/v1/intelligence/*` — 46 endpoints, **zero** frontend callers, 8 capabilities with no backing table | Delete the router, or build the nine tables. It is guarded and returns honest 501s either way, so this is not urgent. |
| CEO Intelligence prefetches 20 endpoints on mount | Leave as is. Measured at ~305 ms wall time even at 10 000 invoices; tab switching is instant because of it. |
| `/dashboard/leave-summary` shows a company-wide pending count to any employee | Aggregate-only, guarded by `leave:view` which employees hold for their own leave. Acceptable; confirm intent. |
| `services/api/client.js` falls back to `localhost:5000` when `VITE_API_URL` is unset | Harden to fail loudly in a production build. Shared by every module, so out of scope here. |
| Executive Dashboard not merged into CEO Intelligence | Keep — it is the only executive surface `manager` can reach. Numeric duplication is fixed and test-enforced. |
| Ops Command Center in the Analytics menu despite being user administration | Menu taxonomy decision. |
| ERP Intelligence's dark glassmorphism vs the rest of the module | Visual decision. |
| CFO `dso` on thin data | Arithmetically correct but large when revenue is small. Consider suppressing DSO below a minimum revenue base. |

---

## Part 6 — Pre-deployment sequence

1. ✅ **Dev servers restarted onto the fixed code.** `:5000` and `:5173` verified serving it —
   `/analytics/manufacturing/work-centre` reports `in_progress: 2` (was 0), CFO reports real accruals,
   and a plain employee gets 403 from `/intelligence/roles`.
2. ✅ **E2E suite committed** — confirm your next CI run executes the three analytics projects.
3. `npm run check:schema` → both PASS.
4. `npx vitest run` in `backend/` and `frontend/` → 596 and 295.
5. `npm run test:analytics` → 51/51.
6. `vite build --mode production`; confirm the API host is `api.manifest-tech.in`.
7. Optional, before a large migration: `node backend/scripts/audit/scale-fixture.mjs --up --scale=5`,
   re-run `perf-probe.mjs`, then `--down`.

**Sign-off condition: met.**

---

## Part 7 — Verdict

**READY FOR GO-LIVE.**

The Analytics & AI module is production-safe, data-truthful, tenant-isolated, RBAC-enforced,
scale-verified and regression-protected.

26 defects were found and fixed in this pass — including **9 live cross-tenant leaks**, **3 AI panels
that had never once rendered**, **an entire unguarded 46-endpoint router**, and **every journal entry in
the ledger being invisible to its own company**. None were visible to the checks that existed when it
began, because three of those checks were themselves broken.

What makes the verdict defensible is not that the gates are green — it is that each one has been made to
go **red** on a deliberately injected defect, and the suite that proves it now lives in the repository
where the next change has to pass it.
