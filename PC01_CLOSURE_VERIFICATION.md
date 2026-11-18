# PC-01 Closure Verification

**Date:** 04 Nov 2026 · **Type:** read-only verification (no code, migration, permission or data change) · **Scope:** PC-01 payroll backend access control and the five approved closure decisions (manual §229–§231)

**Result: PASS, with one process exception (§4).** Four risks are carried forward (§5).

---

## 1. Results

| # | Check | Result |
|---|---|---|
| 1 | Dev and test permission matrices match, including the salary-proposal change | **PASS** |
| 2 | The five decisions match the matrix, backend, frontend and manual §231 | **PASS** |
| 3 | No unintended change to payroll runs, salary assignments, employees or per-user overrides | **PASS** |
| 4 | September 2026 payroll and EMP011 run #41 unchanged | **PASS** |
| 5 | Containment switches enabled | **PASS** |
| 6 | No production access, deployment or commit | **PASS** |

## 2. Evidence

### 2.1 Permission matrix (read-only snapshots)

| | Dev (`Pulse`) | Test (`pulse_e2e`) |
|---|---|---|
| `role_permissions` rows | 1,354 | 1,354 |
| (role, module) flag differences between the two | 0 | 0 |
| `salary_proposals` approve | admin, finance_manager, super_admin | admin, finance_manager, super_admin |
| Per-user overrides (`permissions`) | 74, identical to the pre-PC-01 baseline | 0, identical to its baseline |
| `20261104000001` applied | 03:44:19Z | 03:46:20Z |
| `20261104000002` applied | 05:19:47Z | 05:30:54Z (re-applied after the rollback test) |

Dev versus the pre-PC-01 baseline: 1,224 → 1,354 rows (+130 rows in five new modules), with two `payroll` approve changes: finance_manager gained it, hr_manager lost it. Since the last verified snapshots, neither database has changed (0 added, 0 removed, 0 changed).

### 2.2 The five closure decisions

| Decision | Matrix | Backend | Frontend | §231 |
|---|---|---|---|---|
| 1. Salary-proposal approval: Finance and the administrators only | `salary_proposals` approve held by admin, super_admin and finance_manager only | proposal approve and reject require `salary_proposals:approve` (`salaryStructure.routes.js`) | n/a (no role list in the UI) | ✓ |
| 2. No company-wide increment view for finance_manager | `performance:approve` = admin, hr, super_admin; `payroll:edit` = admin, hr, hr_manager, payroll_admin, super_admin (finance_manager in neither) | `readsAllIncrements()` gates the list, a single recommendation and the budget summary; managers keep direct reports via `increment_team` | IncrementPlanning shows the Budget tab on the same rule | ✓ |
| 3. Leave encashment | `payroll:edit` (claims for others), `payroll:view` (amounts) | `ENCASHMENT_FOR_OTHERS`, `ENCASHMENT_AMOUNT_COMPUTED`, `ENCASHMENT_TDS_RATE`; amount fields removed from the list and create responses (`encashment.routes.js`) | picker limited to self without `payroll:edit`; totals hidden when amounts are withheld | ✓ |
| 4. Anomaly cron per company | `payroll:view` recipients | `runAnomalyDetectionCheck` runs one company at a time; TDS-mismatch recipients are users holding `payroll:view`, company-scoped; other alert types are role-routed within the company | n/a | ✓ |
| 5. Onboarding salary needs `payroll:edit` | `payroll:edit` as above | `SALARY_PERMISSION` on create and edit; blank salary fields are dropped (`employee.controller.js`) | AddEmployee shows the salary read-only and sends no salary fields without `payroll:edit` | ✓ |

Manual sections §229, §230 and §231 are present; `check:manual` PASS.

Recorded test results, from the implementation run:
- Backend: 5,727 passed, 0 failed.
- Frontend: 1,562 passed, 0 failed.
- `integration.pc01ClosureDecisions`: 22 tests; 13 fail against the old code and matrix.
- `pc01ClosureForms`: 5 tests; 3 fail against the old pages.

No tests were run during this verification.

### 2.3 Data integrity (dev, read-only, as of 04 Nov 2026)

| Table | State |
|---|---|
| `payroll_runs` | 52 rows; 0 created or updated today; latest change 20 Oct 2026 |
| `employee_salary_assignments` | 1,597 rows; 0 created today |
| `employees` | 47 rows; 0 created, 0 updated today |
| `salary_revision_proposals` / `leave_encashments` / `increment_recommendations` | 0 created or updated today |
| `permissions` (per-user overrides) | 74 rows, identical to the pre-PC-01 snapshot |

Test DB: none of the throwaway test companies (prefix `ZZPC01`) remain.

### 2.4 September 2026 and run #41 (dev)

| | Value |
|---|---|
| Run #41 | EMP011 · 09/2026 · **pending** · net ₹2,809 · gross ₹2,850 · last updated 30 Sep 2026 13:54Z |
| September 2026 | 32 runs, all pending · net ₹18,65,801 · gross ₹31,01,611 · last updated 30 Sep 2026 |

### 2.5 Containment switches

`shared/hrContainment.js`: each switch is on unless its variable is set to `off`. Neither `HR_CONTAINMENT_FNF` nor `HR_CONTAINMENT_EXIT_STATUS` is set in any env file, so F&F settlement stays suspended and exit status changes only through the workflow.

### 2.6 Production, deployment, commits

- Only the local dev database `Pulse` and the isolated `pulse_e2e` were used. No production host was accessed and nothing was deployed.
- Latest git commit: `f434736`, 27 Sep 2026. There are no commits since; all PC-01 work is uncommitted in the working tree.

## 3. What PC-01 changed, in brief

- **Permissions:** two migrations (`20261104000001`, `20261104000002`).
- **Payroll routes:** payroll, salary-structure, salary-revision, TDS 24Q, settings and increment routes are enforced from the permission matrix.
- **Salary visibility:** master Basic only for `payroll:view` holders or the employee themself; salary-derived figures in overtime cost, AI anomalies, AI chat and leave encashment follow the same rule.
- **Payment:** Mark Paid is limited to finance_manager and refused for the run's preparer. This is temporary until PC-02.
- **Navigation:** Payroll Center pages and actions are shown according to the user's permissions.

## 4. Process exception

**Dev migration ran before the dev "before" snapshot (decision 1, `20261104000002`).**

| Time (UTC) | Event |
|---|---|
| 05:19:44 | Migration file written |
| 05:19:47 | The running dev server applied it automatically (startup auto-migration), not the planned `npm run migrate` |
| 05:19:54 | Dev "before" snapshot taken, already showing the new state |

**What was done:**
- The dev diff was verified against the post-PC-01 dev snapshot (03:47:23Z) instead.
- Result: exactly two rows changed (`salary_proposals.can_approve`: hr_manager true → false, payroll_admin true → false), with overrides identical.
- On the test DB the full sequence ran as planned: snapshot, apply, diff, rollback (row-for-row identical, ids included), re-apply.

**Impact:** none on the final state; the dev change is exactly the approved one. The one gap is that dev was not snapshotted immediately before its own apply.

**Prevention:** snapshot dev before any migration file is created, or stop the dev server first.

## 5. Outstanding risks (carried forward, not fixed)

| ID | Risk | Detail |
|---|---|---|
| R-1 | Encashment approval permissions and payroll side effects | Approval needs only `leaves:approve`, which manager, department_head and hr_exec hold, and it covers any claim in the company. Approving adds the amount to the employee's draft payroll run, so a non-payroll role changes payroll. |
| R-2 | Company-wide leave-balance visibility | `GET /leave-encashment/eligible/:employee_id` needs only `leaves:view` and returns any same-company colleague's leave balances (no salary data). |
| R-3 | Unscoped `/ai/anomalies` for users without a company | The route passes a null company to `detectAnomalies`, which then scans every tenant. TDS-mismatch rows are withheld without `payroll:view`; the other anomaly types are not. |
| R-4 | hr_exec cannot create employees | Bank details are mandatory on Add Employee, and hr_exec lacks `employee_bank:add` / `edit`, so every create attempt is refused (predates PC-01). |

Also still open from PC-01:
- Mark Paid restricted to finance_manager is temporary until PC-02.
- Admin and super_admin bypass the frontend's general permission check, so pages may still show some actions their server refuses (payment is handled; this needs re-checking for future grants).
