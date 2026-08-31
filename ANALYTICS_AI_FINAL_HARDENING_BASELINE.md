# Analytics & AI — Final Hardening Baseline (Phase 0)

**Captured:** 2026-08-18, before any change in this pass.
Kept as the "before" picture the final report is measured against.

## Environment as found

| | |
|---|---|
| Repo root | `Pulse_WORKING/Pulse/` (git) — **`Pulse_WORKING/` is NOT a repo** |
| Backend | Node/Express + Postgres, `:5000` (user's own dev server, PID 11740) |
| Frontend | React + Vite, `:5173` |
| Database | Postgres `:5432`, 551 tables, **1 company** (`id=1`, MANIFEST) |
| Migrations | 308 applied / 303 total, 17 tamper warnings, 0 pending |
| Node | v24.13.1 |

## The module

Eight pages in the `Analytics & AI` group (`frontend/src/config/routes.jsx:589`):

| Menu entry | Page | File |
|---|---|---|
| CEO Intelligence | `CEOIntelligenceDashboard` | `features/analytics/pages/` |
| Executive Dashboard | `ExecutiveDashboard` | `pages/` |
| Ops Command Center | `AdminDashboard` | `pages/` |
| CFO Dashboard | `CFODashboard` | `features/finance/pages/` |
| HR Dashboard | `HRDashboard` | `pages/` |
| HR Benchmarking | `HRBenchmarkingDashboard` | `features/hr/pages/` |
| ERP Intelligence | `ERPIntelligence` | `features/ai/pages/` |
| System Health | `SystemHealth` | `features/admin/pages/` |

Backend: 9 259 lines across `src/analytics/`, `src/modules/analytics/`,
`src/modules/intelligence/`, `src/modules/dashboard/`. Mounts: `/analytics`, `/dashboard`, `/ai`,
`/ceo-intelligence`, `/intelligence`, `/user-dashboard`.

## Baseline test results

| | |
|---|---|
| Backend vitest | 587 pass / 9 skip (24 files) |
| Frontend vitest | 295 pass (17 files) |
| `check:sql-refs` | PASS — **7 files scanned** |
| `check:statuses` | PASS |
| Playwright | 21 API-level tests (`16-analytics-contract.spec.ts`) |
| Browser E2E | **none** |
| Tenant isolation tests | **none** |
| Backend analytics unit tests | **none** — no analytics file in `src/__tests__/` |

## Known issues carried in

From `ANALYTICS_AI_PRE_GOLIVE_AUDIT.md` (63/100) and `ANALYTICS_AI_REMEDIATION_REPORT.md` (95/100,
"all 12 blockers fixed"). Treated as a starting point only, not as fact.

## Gaps identified at Phase 0

1. `check-sql-references.mjs` scans **7 of 15** files with SQL — `manufacturing.routes.js`,
   `powerQuality.routes.js`, `intelligence.routes.js`, `user-dashboard.routes.js`,
   `metricsCalculator.js`, `aiPayroll.controller.js`, `kpiNarrator.js`, `ticketThreadNarrator.js`
   are unscanned.
2. **Tenant isolation is untestable** — one company in the database, so a query that ignores
   `company_id` still returns the right answer.
3. No browser verification of any page.
4. `/api/v1/intelligence` and `/api/v1/user-dashboard` mounted with `verifyToken` and **no permission
   policy** (`/analytics`, `/dashboard`, `/ai` are policied; `/ceo-intelligence` is per-route).
5. RBAC evidence covers one low-privilege token, not the 26 roles that exist.
6. No performance measurement.
7. The Playwright suite is **outside the git repository** — CI cannot run it.

## Environment requirements

- Postgres reachable via `backend/.env` (`DB_*`) or `DATABASE_URL`; both checkers connect through
  `src/config/db.js`, not their own client.
- `JWT_SECRET` must match the running server for `e2e-mint-token.mjs`.
- Low-privilege fixture: `john.doe@manifest.in` (`employee`), override `PULSE_LOW_PRIV_EMAIL`.
- `e2e-mint-token.mjs` selects its account via **`E2E_LOGIN_EMAIL`**, not a `--role` flag, and silently
  ignores unknown argv — `--role employee` mints a **super_admin** token.
- dotenv v17 prints a rotating banner to stdout; any script a test parses must fence its JSON.

## Unresolved risks at Phase 0

| Risk | Why it matters |
|---|---|
| Single tenant | every isolation claim unfalsifiable |
| Empty source tables | `project_cost_summary`, `performance_reviews`, `amc_contracts`, `sales_targets`, `receipts`, `payments` all 0 rows |
| Checkers only ever observed passing | a gate that cannot fail proves nothing |
| Prior evidence is API-level only | cannot catch a page that throws on mount |
