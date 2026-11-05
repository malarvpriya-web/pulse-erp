# PC-01 — Payroll Backend Access Control: Permission Mapping Proposal

> **Update 04 Nov 26: decisions D1–D7 received.** The exact matrix change for confirmation is in **§6** at the end of this document. Nothing has been changed yet.

**Date:** 03 Nov 26 · **Status:** PROPOSAL, awaiting decisions. **Nothing has been implemented.**
**Not changed:** code, database records, configuration, payroll data. September 2026 and run #41 are untouched; containment switches are on.
**Prepared for:** the HR, Payroll and Finance decision-makers who approve PC-01, and the implementer.

## 1. The permission architecture today (verified)

- **Central check.** `requirePermission(module, action)` and `can(req, module, action)` (`middlewares/auth.middleware.js:237-360`).
  - Actions: `view` · `add` · `edit` · `delete` · `approve` · `export`.
  - **Resolution order:** a user-level row in `permissions`, which **replaces** the role grants entirely if present; otherwise the **union** of every role the user holds (`role_permissions`).
  - **Fails closed:** no row means 403 `PERMISSION_NOT_CONFIGURED`.
- **Global matrix.** It applies to all companies (no `company_id` column). Tenant isolation is done in each query with `companyOf(req)`.
- **The `payroll` module in the matrix** (no user-level overrides exist):

| Role | view | add | edit | delete | approve | export | Active logins (dev) |
|---|---|---|---|---|---|---|---|
| super_admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 1 |
| admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 7 |
| payroll_admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 1 |
| hr_manager | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 1 |
| hr | ✔ | ✔ | ✔ | — | — | ✔ | 2 |
| finance_manager | ✔ | — | — | — | — | ✔ | 1 |
| hr_exec, manager, finance, accounts_exec, all others | — | — | — | — | — | — | 1 / 1 / 1 / 1 |

- **What the payroll code actually uses instead:**
  - `PAYROLL_READ_ROLES` = admin, super_admin, hr, hr_manager, **hr_exec**, payroll_admin, **manager**, **finance_manager** (`payrollAccess.js:17`) guards every read **and write** in `payroll.routes.js`. The same list is copied in `salaryStructure.routes.js:14`.
  - `FINANCE_ROLES` = admin, super_admin, **finance_manager**, payroll_admin guards payroll approve and arrears approve.
  - `PROPOSAL_APPROVERS` = admin, super_admin, **hr_manager**, **finance_manager**, payroll_admin guards salary-proposal approve/reject.
  - `POST /payroll/statutory-rules` is limited to admin, super_admin, payroll_admin.

## 2. Endpoints and the proposed permission

**Scope.** "Self or grant" means the existing own-record rule stays (`ownPayslipOrForbidden`: the caller's own employee only, resolved from the login, never from the request), and the HR override changes from the role list to `can(payroll, view)`. All routes stay behind `verifyToken`, `companyOf` scoping and `auditMutations('payroll')`. The approval gates inside `approvePayroll` (release readiness, `PREPARER_UNKNOWN`, `MAKER_CHECKER`) are untouched.

### 2.1 `payroll.routes.js` (`/payroll/*`)

| Endpoint | Today | Proposed |
|---|---|---|
| `GET /`, `/summary`, `/trend`, `/compliance`, `/eligibility`, `/cycle`, `/release-readiness`, `/statutory-rules`, `/form16-status` | read list | `payroll:view` |
| `GET /employee/:id`, `/payslips/:id`, `/history/:employeeId` | read list | `payroll:view` |
| `GET /form16/:employeeId`, `/form16/:employeeId/pdf`, `/payslip-pdf/:id` | read list | `payroll:view` |
| `GET /register` (JSON) | read list | `payroll:view` |
| `GET /register?format=csv`, `GET /pf-ecr`, `/esi-challan`, `/statutory-bonus` (files) | read list | `payroll:export` (see **D4**) |
| `GET /dept-cost` | read list | `payroll:view` |
| `GET /my-payslips` | signed-in, own | unchanged (own only) |
| `GET /payslips`, `POST /email-payslip` | own **or** read list | own **or** `payroll:view` |
| `POST /compute-slip`, `/bulk-generate`, `/generate-pdf-data/:id` (preview, no write) | read list | `payroll:view` |
| `POST /generate`, `/run`, `/save-slip` (write runs) | read list | `payroll:add` |
| `GET /arrears`, `/arrears/compute`, `/loan-advances`, `/loan-advances/:id/repayments` | read list | `payroll:view` |
| `POST /arrears`, `/loan-advances`, `/loan-advances/:id/prepay`, `/loan-advances/:id/close` | read list | `payroll:edit` |
| `POST /approve` | FINANCE_ROLES | **D1** |
| `PUT /arrears/:id/approve` | FINANCE_ROLES | **D1** (same rule as payroll approve) |
| `POST /:id/mark-paid` | read list | **D2** |
| `POST /statutory-rules` | admin, super_admin, payroll_admin | **D3** |

### 2.2 `salaryStructure.routes.js` (mounted at `/salary-structures`, `/payroll/salary-structures`, `/salary-structures/salary-structures`)

| Endpoint | Today | Proposed |
|---|---|---|
| `GET /`, `/salary-structures`, `/:id`, `/assignments`, `/proposals` | read list | `payroll:view` |
| `POST /ctc-preview` (calculation only) | read list | `payroll:view` |
| `POST /` (create), `/:id/copy` | read list | `payroll:add` |
| `PUT /:id`, `POST /:id/assign`, `POST /proposals` | read list | `payroll:edit` |
| `POST /proposals/:id/approve`, `/reject` | PROPOSAL_APPROVERS | **D1** |

### 2.3 Related salary endpoints outside these routers (requirement 7)

| Endpoint | Today | Finding | Proposed |
|---|---|---|---|
| `GET /employees/:id/salary-revisions` (`employee.routes.js:45`) | hardcoded list incl. **hr_exec, finance_manager** | outside the matrix | `payroll:view` (**D5**) |
| `/ai/payroll/trends`, `/departments`, `/anomalies` | `aiPolicy` → `payroll:view` | **already correct** | no change |
| Reports catalogue payroll reports | `permission: ['payroll','view']` | **already correct** | no change |
| `GET /self-service/dashboard` and the declaration routes | explicit `self_service` / `it_declarations` grants (§202) | already correct | no change |
| `/tds/form24q`, `/tds/form24q-download` | `finance:view` (finance, accounts_exec, finance_manager) | every employee's salary, PAN and TDS visible to Finance staff | **D6** |
| `/performance/increments/recommendations` (+ `/:id`, `/budget-summary`) | single `req.user.role` check; **manager sees all company recommendations** | salary data to line managers; ignores the matrix | **D7** (outside PC-01 unless you include it) |
| `POST /performance/increments/recommendations/:id/push-payroll` | `isHR` (hr, admin, super_admin; single role) | writes salary revisions outside the payroll permission | **D7** |
| `POST /integrations/whatsapp/send` | signed-in only | PC-07; not payroll data, but used by the payslip viewer | separate (PC-07) |

## 3. Effect of the proposal on each role (if D1–D3 follow the matrix)

| Role | Gains | Loses |
|---|---|---|
| manager | — | **all payroll and salary access** |
| hr_exec | — | **all payroll and salary access** (including salary-revision history) |
| finance_manager | — | payroll approve, arrears approve, proposal approve, generate, mark-paid, loans and arrears entry, salary assignment. **Keeps** view and export. |
| hr | — | mark-paid (if D2 → `payroll:approve`) |
| hr_manager | **payroll approve, arrears approve, statutory-rule recording, mark-paid** | — |
| payroll_admin, admin, super_admin | — | — |

## 4. Decisions required before implementation

| ID | Question | Option A — follow the matrix as it stands (no data change) | Option B | Note |
|---|---|---|---|---|
| **D1** | Who approves payroll, arrears and salary proposals? | `payroll:approve`: admin, super_admin, payroll_admin, **hr_manager**. **finance_manager loses approval.** | Keep Finance as the payroll approver. This needs a **matrix change** (grant finance_manager `payroll:approve`, and decide whether hr_manager keeps it), i.e. a database record change outside this task's boundaries. | Today's code comment says "Finance approves a period", and requirement 5 says Finance must not gain approval *by default*. These conflict unless Finance approval is granted explicitly. Maker-checker still applies in both options. |
| **D2** | Until PC-02 replaces it: who may mark salaries paid? | `payroll:approve`: same holders as D1A; hr loses it | `payroll:edit` (hr, hr_manager, payroll_admin, admin; preparers could then also pay) | A recommends A, because payment should not sit with the preparer. PC-02 then moves payment to Finance. |
| **D3** | Who records statutory rule versions and the CTC policy (which clears release blockers)? | `payroll:approve` (adds hr_manager) | Keep admin / super_admin / payroll_admin only (a code-level list, outside the matrix) | Recording a rule unblocks approval, so it is itself a control |
| **D4** | Do statutory files (PF ECR, ESI challan, bonus, register CSV) need `payroll:export`, or is `payroll:view` enough? | `export` (hr, hr_manager, payroll_admin, admin, finance_manager hold it) | `view` | Same holders today either way; `export` keeps the distinction for later |
| **D5** | Include `GET /employees/:id/salary-revisions` in PC-01 (→ `payroll:view`; hr_exec loses it)? | Include | Leave for later | Recommended: include (same data as salary assignments) |
| **D6** | Should Finance roles holding `finance:view` (finance, accounts_exec) see the salary 24Q extract (all employees' salary, PAN, TDS)? | Keep as is (Finance files TDS) | Require `payroll:export` as well | Not changed in PC-01 unless you decide B |
| **D7** | Fix the Performance increments endpoints (manager sees all salary recommendations; `push-payroll` writes salaries) in PC-01? | Include: `payroll:view` for salary figures, `payroll:edit` for push-payroll; keep the manager's own-team view only if you want it | Separate task | It is a salary bypass outside the Payroll Center |

## 5. Plan once decided (for review; not started)

1. Replace the three role lists with `requirePermission` / `can` per §2. Keep `ownEmployeeId` and the own-only paths exactly. Remove `PAYROLL_READ_ROLES` and `hasPayrollReadRole`, or turn them into thin wrappers over `can(payroll, view)`.
2. No change to calculation, payment logic, navigation, data, or the gates inside `approvePayroll`.
3. **Tests** (isolated test database `pulse_e2e`, real router and `verifyToken`, two throwaway companies):
   - every endpoint × each role: admin, payroll_admin, hr_manager, hr, hr_exec, manager, finance_manager, finance, employee;
   - a user-level override that grants or denies;
   - multi-role users (e.g. employee + hr);
   - own payslip still allowed for employees;
   - cross-company ids → 404 / empty for a permitted HR user of another company;
   - no company → refused;
   - maker-checker and release-gate refusals unchanged (approve by the preparer → 403 `MAKER_CHECKER`; unknown preparer → 422).
   - Mutation check against the old lists.
4. **Regression:** full backend suite on `pulse_e2e`, full frontend suite. Plus a check that the frontend's own visibility rules don't now show payroll pages to roles the server refuses.

---

## 6. Permission-matrix change for confirmation (decisions D1–D7)

**Status: NOT APPLIED. Awaiting your explicit confirmation of §6.2 and §6.3, and your answers in §6.5.** No code has been changed either. Code and matrix changes ship together once confirmed.

### 6.1 Can every decision be represented in the existing matrix?

**Yes.** Every decision maps onto the existing `role_permissions` table (role × module × view/add/edit/delete/approve/export), using **new module names** beside `payroll`, as §202 (`it_declarations`, `employee_bank`, …) and §209 (`succession`) did. **No workaround and no hardcoded role list is needed.** The one exception is the **"payer ≠ preparer" rule (D2)**. It compares people, not roles, so it is a code check next to the existing maker-checker, not a matrix right. It reuses `payroll_runs.generated_by`, which already exists.

### 6.2 Changes to the EXISTING `payroll` module (the only non-additive part)

| Role | Right | Now | Proposed | Why |
|---|---|---|---|---|
| finance_manager | approve | false | **true** | D1: Finance keeps payroll and arrears approval. Today's code approvers are admin, super_admin, finance_manager, payroll_admin. |
| hr_manager | approve | true | **false** | Keeps the payroll/arrears approver set **exactly as today** once approval is read from the matrix. Today nothing in the code reads `payroll:approve`, so hr_manager never actually approved payroll. Without this change, PC-01 would silently make hr_manager a payroll approver. hr_manager keeps salary-proposal approval through the new module in §6.3. |

**No other existing row changes.** The resulting `payroll` matrix:

| Role | view | add | edit | delete | approve | export |
|---|---|---|---|---|---|---|
| super_admin, admin, payroll_admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| hr_manager | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| hr | ✔ | ✔ | ✔ | — | — | ✔ |
| finance_manager | ✔ | — | — | — | ✔ | ✔ |
| everyone else | — | — | — | — | — | — |

### 6.3 NEW modules (additive; every role gets a row, false unless listed)

| New module | Right(s) used | Granted to | Implements |
|---|---|---|---|
| `salary_proposals` | approve | super_admin, admin, hr_manager, finance_manager, payroll_admin | D1: approve/reject salary proposals. Exactly today's `PROPOSAL_APPROVERS`. |
| `payroll_payment` | approve | **finance_manager** (+ see Q1) | D2: temporary "mark paid", plus a code check that the payer is not the run's preparer |
| `payroll_statutory_config` | edit | **admin, payroll_admin** (+ see Q2) | D3: `POST /payroll/statutory-rules` (rule versions and the `ctc.definition` CTC policy), plus whatever Q3 decides |
| `payroll_tds_extract` | export | finance, accounts_exec, finance_manager, admin, super_admin (+ see Q4) | D6: `GET /tds/form24q` and `/tds/form24q-download` only. Exactly today's holders (they reach it through `finance:view`). It grants **no** payroll visibility. |
| `increment_team` | view, add | **manager, department_head** (see Q5) | D7: list, view and create increment recommendations for **the caller's own direct reports only** (`employees.reporting_manager_id = caller`) |

**Existing rights reused, unchanged:**
- **`payroll:view`** for company-wide increment data, budget summary, salary-revision history and all payroll reads.
- **`payroll:edit`** for push-to-payroll (CTC mode: creates a draft proposal), salary structures and assignments.
- **`payroll:export`** for PF ECR, ESI challan, statutory bonus and the register CSV (D4).
- **`performance:approve`** for increment approve/reject and bands. Its holders are admin, hr and super_admin, identical to today's in-code `isHR`.

### 6.4 Effect on people (dev database, active logins)

| Role (logins) | Payroll / salary effect after PC-01 |
|---|---|
| manager (1) | Loses all payroll and salary reads and writes. Keeps increment recommendations **for direct reports only**. |
| hr_exec (1) | Loses all payroll and salary access, including salary-revision history |
| department_head (1 active) | **Gains** increment recommendations for direct reports (today blocked by the single-role `isMgr` check) — Q5 |
| finance_manager (1) | Keeps view, export, payroll, arrears and proposal approval. Gains only the explicit payment right (today it could already mark paid through the read list). Loses generate, loans and arrears entry, salary assignment and structures. |
| finance (1), accounts_exec (1) | Keep the Form 24Q extract only. No payroll visibility. |
| hr (2) | Loses mark-paid. Keeps view, generate, structures, loans, arrears entry, export. |
| hr_manager (1) | Loses mark-paid. Statutory-rule recording: still not allowed. Keeps proposal approval. Payroll/arrears approval: still not allowed. |
| payroll_admin (1) | Loses mark-paid (not Finance, per D2). Everything else unchanged. |
| admin (7), super_admin (1) | Lose mark-paid unless Q1 = yes; super_admin loses statutory-rule recording unless Q2 = yes. Otherwise unchanged. |
| employees | Unchanged: own payslips only |

### 6.5 Questions to answer with your confirmation

| # | Question | My suggestion |
|---|---|---|
| **Q1** | Mark paid (D2): only finance_manager? Or also the `finance` role and/or super_admin? | finance_manager only, as the strictest reading of D2 |
| **Q2** | Statutory configuration (D3): admin and payroll_admin only, or also super_admin (the platform owner, which today holds every right)? | Include super_admin |
| **Q3** | D3 says "CTC-policy configuration". The **`ctc_mode` switch** and the **statutory switches** (state, PT local body, PF/ESI/PT on-off) live in Payroll Settings, editable today by anyone with `payroll:edit` (including hr and hr_manager). Should changes to those keys also require `payroll_statutory_config:edit`? Other settings would stay on `payroll:edit`. | Yes, for `ctc_mode` and the statutory keys |
| **Q4** | Form 24Q extract (D6): add payroll_admin and hr_manager? Today they get 403 on the Payroll Center Tax tab, because the TDS router needs `finance:view`. | Add payroll_admin only, if you want the Payroll Center tab to work for payroll; otherwise keep exactly today's holders |
| **Q5** | Increment team scope (D7): include department_head (direct reports only), or manager only? | Include both, direct reports only |
| **Q6** | Push to payroll **outside CTC mode** currently writes the salary revision directly. D7 says salary changes must go through the proposal workflow, which exists only in CTC mode. Refuse push-to-payroll when CTC mode is off (409 `SALARY_PROPOSAL_REQUIRED`), leaving the salary-structure assignment screen (`payroll:edit`) as the only direct path? | Yes. Company 1 is in CTC mode, so there is no effect today. |

### 6.6 How the matrix change would be applied (development only)

- **Mechanism.** One additive migration file, following §202's pattern (`2026110400000x_payroll_access_control_permissions.js`):
  - inserts the §6.3 rows for all 26 roles with `ON CONFLICT DO NOTHING`;
  - makes the two §6.2 updates **only if the row still holds the expected old value** (so an administrator's later edit is never overwritten);
  - **`down()`** restores the two `payroll` values and deletes the five new modules' rows only.
- **Before applying:** snapshot `role_permissions` to the scratchpad and print the exact before/after diff.
- **Where it runs.** Applied to the development database by running the migration runner explicitly (no dev server is running, so nothing auto-applies), and to the isolated test database `pulse_e2e` for the tests. **Not committed, not deployed.**
- **Not touched:** no employee, salary, payroll, settings or audit row.
