# Analytics & AI — E2E Report

**Date:** 2026-08-18, revised 2026-08-19 · **Result:** **51/51 Playwright tests pass** across 3 projects,
run against the project's own dev stack.

Playwright genuinely ran. Every number below is from an actual run, not a claim.

---

## 1. Environment

| | |
|---|---|
| Backend under test | `http://localhost:5000` — the project's own dev server, **restarted onto the fixed code** |
| Frontend under test | `http://localhost:5173` — the project's own Vite dev server |
| Browser | Chromium (headless), 1440×900 |
| Auth | `e2e-mint-token.mjs` → six `localStorage` keys → `storageState` |

> The final run used **no environment overrides and no private ports** — this is the stack a developer
> actually runs. Both servers were restarted so they serve the fixed code; verified by
> `/analytics/manufacturing/work-centre` reporting `in_progress: 2` (it reported `0` before) and CFO
> returning real accrual figures.

`tests/auth.setup.ts` and `playwright.config.ts` now read `PULSE_API_BASE` / `PULSE_FRONT_BASE`
(defaulting to the documented `:5000` / `:5173`), so a run can be pointed at staging or a second dev pair
without editing either file.

---

## 2. Results

| Project | Tests | Result |
|---|---|---|
| `analytics-contract` | 23 | **23 pass** |
| `tenant-isolation` | 6 | **6 pass** |
| `analytics-browser` | 22 | **22 pass** |
| **Total** | **51** | **51 pass, 0 fail, 0 flaky** |

Two tests were added on 2026-08-19: one asserting **no posted journal entry is left unattributed to a
company**, and one driving the **five mutating actions** the earlier revision could not click.

---

## 3. Browser coverage — all eight Analytics & AI pages

The page list is derived from the `Analytics & AI` group in `frontend/src/config/routes.jsx`, so a page
added to the menu without a test here shows up as a gap rather than going unchecked.

| Page | Route | Renders | Reload | Console/exception clean | No 5xx |
|---|---|---|---|---|---|
| CEO Intelligence | `/CEOIntelligenceDashboard` | ✅ | ✅ | ✅ | ✅ |
| Executive Dashboard | `/ExecutiveDashboard` | ✅ | ✅ | ✅ | ✅ |
| Ops Command Center | `/AdminDashboard` | ✅ | ✅ | ✅ | ✅ |
| CFO Dashboard | `/CFODashboard` | ✅ | ✅ | ✅ | ✅ |
| HR Dashboard | `/HRDashboard` | ✅ | ✅ | ✅ | ✅ |
| HR Benchmarking | `/HRBenchmarkingDashboard` | ✅ | ✅ | ✅ | ✅ |
| ERP Intelligence | `/ERPIntelligence` | ✅ | ✅ | ✅ | ✅ |
| System Health | `/SystemHealth` | ✅ | ✅ | ✅ | ✅ |

Per page the suite asserts: the app shell is present, the URL was not bounced to `/login`, the body
carries **content specific to that page**, no error boundary, no uncaught exception, no console error,
no 5xx from any request the page made. Both direct navigation and a hard reload (deep-link path) are
covered.

### 3.1 A weak assertion caught and fixed mid-pass

The first version matched markers like `/Headcount|Attrition|HR/i`. The sidebar contains the words
"HR", "Reports", "Analytics & AI" and a "Revenue" group — so those regexes **matched application chrome
and would have passed on a completely blank page**. Markers are now page-specific text that only exists
once the page's own content has rendered (`Total Employees`, `Department Headcount`,
`Accounts Receivable`, `P&L Bridge`, `Module Activity`, `Migrations`, …).

A related correction: an initial probe concluded both dashboards rendered nothing, because it waited
1.5 s. These pages fetch on mount and again once their filter bar resolves its options, so content can
be ~4 s behind `networkidle`. The settle is now 3.5 s.

---

## 4. Tabs and sub-views

**CEO Intelligence** — every tab in the strip is clicked; each must render without an error boundary and
without throwing. All pass.

The page **prefetches all 20 endpoints on mount** rather than fetching per tab, so switching tabs is
instant and issues no new request. The first version of this test waited for a request after clicking and
therefore reported a working tab as broken. The test now asserts the real contract: the data was fetched
up front (`executive-summary`, `collections`, `customers`, `projects` all observed on mount), and
switching tabs renders it without fault.

---

## 5. Filters — verified server-side, not cosmetic

| Filter | Control | Assertion | Result |
|---|---|---|---|
| HR Dashboard — period | `<select>` on the Analytics tab | fires a `GET /analytics/*` carrying a query string | ✅ |
| HR Dashboard — department | `<select>` on the Analytics tab | same, for every visible select | ✅ |
| CFO Dashboard — period | button strip `YTD / Q1–Q4` | fires `GET /dashboard/cfo` **with `period=Q2` in the URL** | ✅ |

The CFO assertion checks the *value* reaches the backend, not merely that a request fired — a filter that
calls the server and drops its value on the floor is the same bug wearing a disguise.

The filters live on HR Dashboard's **Analytics** tab, not the default Overview tab. A filter test that
only inspects the landing view finds no controls and concludes, wrongly, that the page has none.

This closes the historical defect where the department dropdown filtered one already-loaded array in
memory, so 17 of 18 widgets ignored it and no request was ever sent.

---

## 6. Unauthorized access

A context with `storageState: { cookies: [], origins: [] }` navigating to `/CFODashboard`:
redirected to `/login`, no token in `localStorage`, and **no financial figures** (`Receivable`, `EBITDA`,
`Net Profit`, `Burn Rate`) anywhere in the body.

### 6.1 A test bug that faked a P0

The first version created the context with `browser.newContext()` inside the test. That **inherits the
project's `use` options, including `storageState`**, so the "signed-out" browser arrived already
authenticated and the test failed with *"signed-out user was not sent to login"* — which reads exactly
like a critical auth-bypass. Reproducing it standalone showed the app redirects correctly. The test now
clears `storageState` via `test.use` and asserts the token really is absent before drawing any conclusion.

---

## 7. Contract suite (23 tests)

- **Reconciliation (5)** — open tickets agree between the Operations tile and the Collections KPI;
  CEO "Outstanding" equals CFO "AR"; offer acceptance agrees between HR Dashboard and HR Benchmarking;
  revenue YTD agrees across every surface; revenue-per-employee uses the same revenue definition.
- **Schema contract (2)** — status vocabulary, SQL references.
- **Honesty (10)** — CFO GL, **every posted journal entry attributed to a company** *(new)*, alert actions
  map to real pages, AI insights derived, project margin null not zero, business lines from the master,
  forecast declares whether measured, traffic lights `unknown`, HR benchmarking distinguishes no-data.
- **Filters (3)**, **Authorization (3)**.
- **Mutating actions (1)** *(new)* — drives the five write actions and their authorization through
  `backend/scripts/audit/mutating-actions-probe.mjs`; fails the build on any non-`ok` result.

---

## 8. What is not covered

- **Exports/downloads** — this module's surface exposes no export endpoint.
- **Mobile viewports** — desktop only (1440×900).
- **Cross-browser** — Chromium only.
- **Production build in a browser** — the browser suite runs against the Vite dev server. The production
  bundle is verified to build cleanly and resolve the right API host, but was not driven in a browser.
- **Scale** — the browser suite runs against the shipped dataset. API-level correctness *was* re-verified
  at 10 000 invoices (hardening report §6), but the browser pass was not repeated at that volume.
- **Live LLM responses** — `/ai/llm-chat` is verified for routing, authorization and the
  unconfigured-key contract, but is not made to spend a token.

---

## 9. Reproducing

```bash
# 1. the usual dev stack
cd Pulse && npm run dev:backend      # :5000
cd Pulse && npm run dev:frontend     # :5173

# 2. all three analytics suites — no overrides needed
cd Pulse && npm run test:analytics
```

To point the suite at staging or a second dev pair, set `PULSE_API`, `PULSE_API_BASE` and
`PULSE_FRONT_BASE`; they default to the documented dev ports.

> ✅ **The suite is in the git repository.** `playwright.config.ts` and `tests/` (37 source files) live
> under `Pulse/` and are tracked; generated output is gitignored. CI runs the three analytics projects as
> blocking steps in the docker job. Until 2026-08-19 the suite sat one level above the repo root,
> untracked, and **no E2E gate had ever executed in CI**.
