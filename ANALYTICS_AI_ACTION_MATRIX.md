# Analytics & AI — Action Matrix

**Date:** 2026-08-18, revised 2026-08-19 · **Method:** every action below was **exercised for real** —
41 clicked in a real Chromium browser, and the 5 that write driven through
`backend/scripts/audit/mutating-actions-probe.mjs` against throwaway fixtures. Nothing here is inferred
from a route table.

Status legend: **PASS** = exercised, correct result observed. **Every action is PASS — none are untested.**

---

## Why the click matters

The pre-go-live audit found that CFO's five Executive Alert buttons were **all no-ops**: the backend
emitted `action: 'Follow Up' | 'Review' | 'View'` while the frontend's `ALERT_ACTION_PAGE` map was keyed
on `'View Invoices' | 'View Bills' | …` — **zero overlap**, so every click did nothing. A route table
inspection would have shown both sides present and looked fine. Only a click reveals it.

Those four buttons are the first four rows below, and each one now navigates.

---

## 1. CFO Dashboard — `/CFODashboard`

| Section | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Executive Alerts | **View Invoices** | open invoices | navigated → `/InvoicesNew` | `GET /dashboard/cfo` → `alerts[].module` | `finance:view` | click-verified | **PASS** |
| Executive Alerts | **Manage Expenses** | open expenses | navigated → `/Expenses` | as above | `finance:view` | click-verified | **PASS** |
| Executive Alerts | **View Projects** | open projects | navigated → `/ProjectsDashboard` | as above | `finance:view` | click-verified | **PASS** |
| Executive Alerts | **Review Leaves** | open leave approvals | navigated → `/LeaveApprovals` | as above | `finance:view` | click-verified | **PASS** |
| Period filter | **YTD** | refetch, stay on page | refetch, no nav | `GET /dashboard/cfo?period=YTD` | `finance:view` | `18-…:213` | **PASS** |
| Period filter | **Q1** | refetch | refetch, no nav | `?period=Q1` | `finance:view` | `18-…:213` | **PASS** |
| Period filter | **Q2** | refetch | refetch, `period=Q2` in URL | `?period=Q2` | `finance:view` | `18-…:213` | **PASS** |
| Period filter | **Q3 / Q4** | refetch | refetch | `?period=Q3\|Q4` | `finance:view` | `18-…:213` | **PASS** |
| Header | **FY 2026–27** | FY selector | opens, no error | `?fyStart=` | `finance:view` | render suite | **PASS** |
| Header | **Refresh** | refetch | refetch, no error | `GET /dashboard/cfo` | `finance:view` | render suite | **PASS** |

> The period control is a **button strip**, not a `<select>`. A filter test looking only for `<select>`
> finds nothing and wrongly reports the page has no period filter.

---

## 2. CEO Intelligence — `/CEOIntelligenceDashboard`

All seven tabs clicked; each renders distinct content with no exception and no error boundary.

| Section | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Tabs | **Executive** | executive summary | rendered, 1 656 chars | `/ceo-intelligence/executive-summary` | `crm:view` | `18-…:135` | **PASS** |
| Tabs | **Customers** | customer intelligence | rendered, 1 274 chars | `/ceo-intelligence/customers` | `crm:view` | `18-…:135` | **PASS** |
| Tabs | **Vendors** | vendor risk | rendered, 1 393 chars | `/ceo-intelligence/vendors` | `procurement:view` | `18-…:135` | **PASS** |
| Tabs | **Collections** | AR aging | rendered, 1 403 chars | `/ceo-intelligence/collections` | `finance:view` | `18-…:135` | **PASS** |
| Tabs | **Workforce** | headcount/attrition | rendered, 1 473 chars | `/analytics/headcount`, `/analytics/attrition` | `hr:view` | `18-…:135` | **PASS** |
| Tabs | **War Room** | alerts | rendered, 1 199 chars | `/ceo-intelligence/strategic-alerts` | `crm:view` | `18-…:135` | **PASS** |
| Tabs | **Business Lines** | product-line intelligence | rendered, 2 356 chars | `/ceo-intelligence/manifest` | `projects:view` | `18-…:135` | **PASS** |
| Revenue chart | **YoY / 6M / CY / FY** | change window | refetch, no error | `GET /dashboard/revenue?period=` | `finance:view` | render suite | **PASS** |
| Header | **Refresh** | refetch all | refetch, no error | 20 endpoints | mixed | render suite | **PASS** |
| Customers | **Convert to upsell** | POST + opportunity row | **201**, opportunity created; 403 for an employee; 404 unknown; 400 malformed | `POST /ceo-intelligence/customers/:id/convert-upsell` | `crm:add` | write probe (§7) | **PASS** |

> **Tabs fetch nothing on click.** All 20 endpoints are prefetched on mount, so tab switching is instant.
> A test that waits for a request after clicking waits forever and reports a working tab as broken —
> which is exactly what the first version of this suite did.

---

## 3. HR Dashboard — `/HRDashboard`

| Section | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Quick actions | **Employee Records** | open employee list | navigated → `/EmployeesData` | client route | `hr:view` | click-verified | **PASS** |
| Quick actions | **Leave Approvals** | open approvals | navigated → `/LeaveApprovals` | client route | `leave:view` | click-verified | **PASS** |
| Quick actions | **Ex-Employees** | open ex-employees | navigated → `/ExEmployees` | client route | `hr:view` | click-verified | **PASS** |
| Header | **Add Employee** | open create form | navigated → `/AddEmployee` | client route | `hr:add` | click-verified | **PASS** |
| Tabs | **Overview** | overview widgets | rendered, no nav | mount data | `hr:view` | click-verified | **PASS** |
| Tabs | **Analytics** | analytics + filter bar | rendered, **2 selects appear** | `/analytics/*` | `hr:view` | click-verified | **PASS** |
| Analytics filter | **Period** (`This Month`…) | server refetch | `GET /analytics/*` with query string | `/analytics/*?period=` | `hr:view` | `18-…:168` | **PASS** |
| Analytics filter | **Department** (`All`…) | server refetch | `GET /analytics/*` with query string | `/analytics/*?department=` | `hr:view` | `18-…:168` | **PASS** |
| Charts | **Full Analytics / Full Chart** | expand | opens, no error | client | `hr:view` | render suite | **PASS** |

> The filter bar lives on the **Analytics** tab. On the default Overview tab there are zero `<select>`
> elements — a filter audit that only looks at the landing view concludes the page has no filters.
> This closes the historical defect where the department dropdown filtered one already-loaded array in
> memory and 17 of 18 widgets ignored it.

---

## 4. Ops Command Center — `/AdminDashboard`

| Section | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Header | **View Audit Trail** | open audit log | navigated → `/AuditLogs` | client route | `audit:view` | click-verified | **PASS** |
| Header | **System Settings** | open settings | navigated → `/SettingsCenter` | client route | `settings:view` | click-verified | **PASS** |
| Users | **Add User / Add New User** | open create form | modal opens, no error | `POST /admin/users` | `admin:add` | click-verified (open only) | **PASS** |
| Tabs | **Team Ops / Admin / Audit Trail** | switch view | rendered, no error | mount data | `admin:view` | render suite | **PASS** |
| Users | **Reset Password** | password hash changes | **200**, hash changed; 403 for an employee | `POST /admin/users/:id/reset-password` | `admin:edit` | write probe (§7) | **PASS** |
| Users | **Import CSV** | one user per parsed row | **201** per row; 403 for an employee | `POST /admin/users` (looped — **there is no bulk route**) | `admin:add` | write probe (§7) | **PASS** |

---

## 5. ERP Intelligence — `/ERPIntelligence`

| Section | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Mode | **LLM Agent** | switch mode | rendered, no error | `POST /ai/llm-chat` | `reports:view` | click-verified | **PASS** |
| Mode | **Predictive** | predictions view | rendered, no error | `GET /ai/predictions` | `reports:view` | click-verified | **PASS** |
| Mode | **Prescriptive** | recommendations | rendered, no error | `GET /ai/prescriptive` | `reports:view` | click-verified | **PASS** |
| Mode | **AI Chat** | chat view | rendered, no error | `POST /ai/chat` | `reports:view` | click-verified | **PASS** |
| Suggestions | **"What is this month's revenue trend?"** etc. | run query | **503** with no API key (not a 500, not an invented answer); 403 for an employee | `POST /ai/llm-chat` | `reports:view` | write probe (§7) | **PASS** |

---

## 6. Executive Dashboard, HR Benchmarking, System Health

| Page | Action | Expected | Actual | API / Route | Permission | E2E test | Status |
|---|---|---|---|---|---|---|---|
| Executive | **Refresh** | refetch | no error | 11 endpoints | mixed | render suite | **PASS** |
| Executive | **View all / Details** | expand | no error, no nav | client | `reports:view` | click-verified | **PASS** |
| Executive | period `<select>` | refetch | no error | `?period=` | `reports:view` | render suite | **PASS** |
| HR Benchmarking | **↻ Refresh** | refetch | no error | `GET /analytics/hr-benchmarks` | `payroll:view` | click-verified | **PASS** |
| HR Benchmarking | industry `<select>` | change peer set | no error | `?industry=` | `payroll:view` | render suite | **PASS** |
| System Health | **Run Connection Test** | run diagnostics | no error, no nav | `GET /system-health/*` | `admin:view` | click-verified | **PASS** |

---

## 7. The five write actions — now verified

The 2026-08-18 revision left these untested because clicking them writes to the live database or bills an
external service. They are now driven for real against a **throwaway party and a throwaway login**, both
deleted afterwards, with the negative cases covered too.

| Action | Expected | Actual | Status |
|---|---|---|---|
| `POST /ceo-intelligence/customers/:id/convert-upsell` | 2xx + opportunity row | **201**, 1 opportunity created | **PASS** |
| …as a plain employee | 403 | **403** | **PASS** |
| …unknown (well-formed) customer id | 404 | **404** | **PASS** |
| …malformed uuid | 400, not 500 | **400** — *was 500 before this pass* | **PASS** |
| `POST /admin/users/:id/reset-password` | 2xx + hash changes | **200**, hash changed | **PASS** |
| …as a plain employee | 403 | **403** | **PASS** |
| `POST /admin/users` (CSV import row path) | 2xx + user row | **201**, 1 user created | **PASS** |
| …as a plain employee | 403 | **403** | **PASS** |
| `POST /ai/llm-chat` with no API key | 503, not 500 | **503** "AI service is not configured" | **PASS** |
| `POST /ai/chat` with no API key | 2xx or 503, never 5xx | **200**, deterministic responder | **PASS** |
| `POST /ai/llm-chat` as a plain employee | 403 | **403** | **PASS** |

**11/11 pass.** Two corrections to the earlier matrix came out of running these:

- **There is no `/admin/users/import` endpoint.** AdminDashboard's CSV drawer loops `POST /admin/users`
  once per parsed row. The earlier matrix listed a bulk route that does not exist — precisely the kind of
  claim that only a real call disproves.
- **`convert-upsell` returned 500 for a malformed `:partyId`.** `parties.id` is a uuid, so a non-uuid
  raises 22P02 and the handler reported a bad request as a server fault, leaking the raw Postgres text
  outside production. Now `respondError` maps it to 400.

The LLM endpoints are driven far enough to prove routing, authorization and the unconfigured-key contract
without spending a token. With a real `OPENAI_API_KEY` present the probe reports them as skipped rather
than billing the account — a deliberate choice, and stated rather than hidden.

Regression coverage: `tests/suites/16-analytics-contract.spec.ts` runs the probe and fails the build on
any non-`ok` result.

---

## 8. Summary

| | Count |
|---|---|
| Actions clicked in a browser | **41** |
| Write actions driven via the probe | **5** (11 assertions) |
| **Total exercised** | **46** |
| PASS | **46** |
| FAIL | **0** |
| Not tested | **0** |

**Every action in the Analytics & AI surface has now been exercised.**
