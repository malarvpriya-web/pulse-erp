# Pulse ERP — Payroll Center Functional Audit and Recommended Design

**Date:** 03 Nov 26 · **Type:** read-only audit, awaiting approval. **Prepared for:** HR, Payroll and Finance management, and the implementation team.

**Method and limits**
- **No screenshots** came with the request, so this audit is based on the repository code (frontend pages → API calls → backend routes → tables) and read-only queries against the development database `Pulse`.
- **Not done:**
  - no code, route, configuration, migration or record was changed;
  - no payroll was generated, approved, released or regenerated;
  - production was not accessed.
- **Still in force:** September 2026 payroll and run #41 are untouched, and the containment switches remain on.
- **Previous audits not repeated.** Earlier payroll audits (`PAYROLL_DATA_FLOW_AUDIT.md` Parts 1–14) and the HR audit (F-nn) are referenced, not repeated.
- **Live data is thin.** Company 1 has **never approved or paid a payroll in Pulse**, so many paths are verified from code only. Where a statement relies on code alone, it says so.

---

## 0. Summary

**The Payroll Center has six sections:** Overview, Payroll Processing, Salary Structures & Loans, Payslips (2 views), Tax & Statutory (2 views), Settings. They cover the core cycle (structures → generate → approve → payslip → tax extract), and the approval controls are sound:
- release gate;
- preparer-must-be-recorded;
- maker ≠ checker.

**Main problems**

1. **Access is far wider than the permission matrix (P0).** Every payroll endpoint is guarded by one hardcoded list, which includes **`manager`, `hr_exec` and `finance_manager`**. The role matrix gives `manager` and `hr_exec` **no** payroll access, and `finance_manager` view only. So line managers can read every employee's salary and payslip, generate payroll, and **mark salaries paid**.
2. **"Mark paid" is not a payment.** HR-side roles can mark any approved salary paid with no bank reference, and there is no bank file or reconciliation. Salary payment rails don't exist (Finance payment batches are supplier-only).
3. **Payroll is currently deadlocked for new salaries.** CTC mode is on for company 1, so salary changes need a proposal. Proposal approval is blocked until a CTC policy is recorded, and **that can only be recorded through an API with no screen**. The same applies to clearing every statutory release blocker. **No payroll can be approved from the UI today.**
4. **Inputs reach a run inconsistently:**
   - attendance sync writes LOP days onto drafts **without recomputing pay**;
   - leave encashment is written to a column **the engine never reads**;
   - bonuses can't be entered at all;
   - LOP, overtime and declaration lookups **fail silently to zero**.
5. **Much is built but has no screen:** PF ECR, ESI challan, statutory bonus, payroll register, department cost, arrears workflow, statutory-rule versions, payroll history.
6. **Duplicated or misleading functions:**
   - a client-side arrears calculator that disagrees with the server arrears feature and saves nothing;
   - two settings key families (Payroll Settings vs Setup Wizard);
   - unused `/payroll/run` alias services;
   - a WhatsApp "payslip" button that sends only a template message, through an endpoint **any signed-in user can call**.

---

## A. Page and functionality inventory

The Payroll Center hub is `features/hr/pages/PayrollCenter.jsx`; its section map is `components/payroll/payrollCenterTabs.js`.

**Legend.**
- **Works:** ✅ works · ◐ works with defects · ❌ broken or unusable · ⓒ code-verified only (no live data).
- **Class:** **E** essential · **C** combine · **I** integrate from another module · **U** unnecessary.

### A1. Overview (`components/payroll/PayrollOverview.jsx`)

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| 5-step status: Settings → Structures → Generate → Approve → Payslips | ◐ | `GET /payroll/summary`, `GET /payroll/release-readiness` | `payroll_runs`, `company_settings`, `payroll_statutory_rules`, `employee_salary_assignments` | — | E | Fixed to the **current month**: the stuck September batch is invisible (PC-18). "pending" is shown as "draft" (PC-24). The release step says blockers clear by recording rules, which has no screen (PC-03). |

### A2. Payroll Processing (`pages/Payroll.jsx`)

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| Month list of runs, KPIs, trend | ✅ | `GET /payroll`, `/summary`, `/trend` | `payroll_runs` | Workforce Analytics has none | E | — |
| Eligibility banner (eligible vs in draft) | ✅ | `GET /payroll/eligibility` | employees, revisions, structures | — | E | — |
| Release readiness (blockers) | ✅ | `GET /payroll/release-readiness` | `payroll_statutory_rules`, settings | — | E | Blockers can't be cleared from any screen (PC-03) |
| Generate | ◐ ⓒ | `POST /payroll/generate` | `payroll_runs` (+ attendance OT, `payroll_attendance_summary`, loans, arrears, declarations) | `/payroll/run` alias (unused) | E | Deletes drafts of now-ineligible staff (would delete 29 September runs, including #41; PC-12). Silent zero on lookup errors (PC-06). No bonus or other one-time input (PC-09). Leavers excluded (F-04). |
| Approve (Finance) | ✅ ⓒ | `POST /payroll/approve` | `payroll_runs`, `payroll_loan_repayments`, `journal_entries` | — | E | Gates sound (release gate, `PREPARER_UNKNOWN`, `MAKER_CHECKER`). **GL posting failure is logged and skipped** (PC-08). |
| Mark paid (row / all) | ◐ ⓒ | `POST /payroll/:id/mark-paid` | `payroll_runs`, `journal_entries` (Dr 2040 / Cr 1001) | Finance payment batches (supplier-only) | **I** | Allowed for the read-role list, including `manager` (PC-01/02). No payment reference required. Bulk is many parallel calls with no atomicity (PC-13). |
| View payslip PDF | ✅ | `GET /payroll/payslip-pdf/:id` | `payroll_runs` | Payslips section | C | Same viewer as Payslips |
| Statutory-rule guidance text | ◐ | refers to `POST /payroll/statutory-rules` | — | — | E | Text instruction instead of a screen (PC-03) |

### A3. Salary Structures & Loans (`pages/SalaryStructure.jsx`, 3 tabs)

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| Structures: list, create, edit, copy | ✅ | `GET/POST/PUT /salary-structures`, `/:id/copy` | `salary_structures` | — | E | **Import-time seeding** of two global structures (`salaryStructure.routes.js:54`) (PC-20). Only 2 structures exist, both global (`company_id` NULL). |
| CTC preview | ✅ ⓒ | `POST /salary-structures/ctc-preview` | settings, rules | Payslip what-if preview | C | — |
| Employee assignments (salary revision) | ❌ for company 1 | `POST /salary-structures/:id/assign` (single and bulk) | `employee_salary_assignments` | Add Employee (bank/salary fields), offer letters | E | Company 1 has **CTC mode on**, so this returns **409 CTC_MODE**. It must go through proposals, which are blocked (PC-04). With CTC mode off it is a direct write by any read-role (no approval; PC-01). Default effective date uses UTC "today" (PC-23). |
| Salary proposals (CTC mode) | ❌ | `GET/POST /salary-structures/proposals`, `/:id/approve\|reject` | `salary_revision_proposals` (0 rows) | — | E | Approval blocked by `CTC_POLICY_NOT_RECORDED`, with no screen to record it (PC-04) |
| Revision history | ✅ | `GET /employees/:id/salary-revisions` | `employee_salary_assignments` | Employee Profile | C | — |
| **Arrears calculator (client-side)** | ❌ misleading | none | none | **Server arrears** (`/payroll/arrears*`, no screen) | **U → replace** | Basic difference × months only; no HRA/PF/proration for part months; saves nothing (PC-10) |
| Loans & advances: list, create, prepay, close | ◐ ⓒ | `/payroll/loan-advances*` | `payroll_loans` (5 rows, all seed), `payroll_loan_repayments` | Travel advances (Travel module) | E | No approval step for a new loan. Disbursement not posted to GL. Repayment recovery needs Finance's loan GL mapping (Part 14). Repayment history endpoint has no screen. |

### A4. Payslips

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| **Preview & distribute** (`PayslipGenerator.jsx`): what-if preview, PDF data, email | ◐ | `POST /payroll/compute-slip`, `/generate-pdf-data/:id`, `/email-payslip`; `GET /payroll/cycle` | `payroll_runs`, `payslip_email_log` (5) | CTC preview; Payslip viewer | C | Mixes two jobs: a **what-if calculator** (watermarked) and **distribution** of issued payslips. Email needs SMTP (503 if not configured). `/save-slip` and `/bulk-generate` exist without a screen. |
| **Payslip viewer** (`PayslipViewer.jsx`) | ◐ | `GET /payroll/payslips`, `POST /payroll/email-payslip`, `POST /integrations/whatsapp/send` | `payroll_runs` | Home "My payslips" widget (`GET /payroll/my-payslips`) | E | Also the employees' **"My Payslip"**, but listed under the Finance menu, which employees cannot open (F-18). WhatsApp sends only a "payslip ready" template, through an **unguarded endpoint** (PC-07). |

### A5. Tax & Statutory

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| Form 16 / Form 130 (annual certificate) | ✅ ⓒ | `GET /payroll/form16-status`, `/form16/:id/pdf` | `payroll_runs` (approved/paid only) | — | E | Empty in practice (nothing approved). Part B depends on the TDS defects in P0-7. |
| Form 138 / Form 24Q (quarterly extract) | ✅ ⓒ | `GET /tds/form24q`, `/tds/form24q-download` (Finance TDS router, `finance:view`) | `payroll_runs`, `tds_transactions` | Finance → TDS module (26Q, 16A, challan tracking) | **I** | A data extract, not a filed return. Challan (deposit) details live in Finance TDS. |
| **PF ECR, ESI challan, statutory bonus** | ⓒ, **no screen** | `GET /payroll/pf-ecr`, `/esi-challan`, `/statutory-bonus` | `payroll_runs` | — | E | Built but unreachable (PC-11) |
| PT and LWF returns | **missing** | — | — | — | E | PC-15 |
| Statutory rule versions (to clear release blockers) | **API only** | `GET/POST /payroll/statutory-rules` | `payroll_statutory_rules` (**0 rows**) | — | E | PC-03 |
| IT declaration review | ✅ (in the HR menu) | `/self-service/it-declarations/*` | `it_declarations` | HR → IT Declaration Review | I (link) | Engine use defective (F-09 / P0-7) |

### A6. Settings (`pages/PayrollSettings.jsx` → shared `ModuleSettingsPanel`)

| Function | Works | API | Tables | Elsewhere? | Class | Defects |
|---|---|---|---|---|---|---|
| Pay cycle, components, PF/ESI/PT, regime, CTC mode, statutory state/ULB | ◐ | `GET/POST /settings/payroll` | `company_settings` (module `payroll`) | **Settings → Setup Wizard** writes the same blob with a second key family | E | Stored blob holds **paired duplicate keys** (`pay_day`/`pay_day_of_month`, `cutoff_day`/`payroll_cutoff_day`, `frequency`/`pay_frequency`, `tds_auto`/`tds_auto_calculate`, `pt`/`professional_tax`, …). They are normalised in code (`payrollSettings.js`), but two screens edit them (PC-16). **CTC mode was switched on (last save 29 Oct 26, user 848)** without the CTC policy recorded, which caused the deadlock in PC-04. |

### A7. Backend payroll capability with no screen

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /payroll/register` | payroll register (final or preparation basis) | E — needed for review and audit |
| `GET /payroll/dept-cost` | department cost (approved + paid; drafts separate) | E — management report |
| `GET /payroll/pf-ecr`, `/esi-challan`, `/statutory-bonus` | statutory files and reports | E |
| `GET/POST /payroll/arrears*`, `PUT /arrears/:id/approve` | arrears with approval (5 rows, all seed) | E — replaces the client calculator |
| `GET/POST /payroll/statutory-rules` | record verified rule versions | E — clears release blockers |
| `GET /payroll/history/:employeeId` | employee pay history | C — belongs in Employee Profile / payslips |
| `GET /payroll/compliance` | compliance summary | review before use |
| `POST /payroll/save-slip`, `/bulk-generate` | legacy slip saving and bulk preview | **U** — superseded by generate/approve |
| `POST /payroll/run` + `services/payrollService.js`, `services/modules/hrService.js` | alias of generate | **U** — no screen imports these services |
| `GET /payroll/loan-advances/:id/repayments` | repayment history | E — show in the loan detail |

---

## B. Recommended navigation structure

**Rules applied:**
- Keep every essential function.
- Pull in, don't duplicate: Finance owns payments, journals and reconciliation; Attendance owns attendance; Leave owns balances; Exit Management owns separations.
- Keep company isolation and permission checks.
- **Keep every approval and release control.**

```
Payroll Center
├─ 1. Overview            month selector · calendar & cut-off status · open exceptions · leavers this month
├─ 2. Run Payroll         (one period workspace, in order)
│     ├─ Inputs           attendance & LOP sync status (from Attendance) · one-time earnings/deductions
│     │                   (bonus, incentives, other deductions — NEW) · arrears (server feature) ·
│     │                   leave encashments (from Leave) · leavers & final months (from Exit Management)
│     ├─ Review           generate · exceptions & validation · register (preparation basis) · payslip preview
│     ├─ Approve          release readiness · maker-checker approval (Finance)
│     └─ Payment status   read-only: payment batch, bank reference, journal posting (actions live in Finance)
├─ 3. Employee Pay Setup  salary structures · revisions & proposals (CTC mode) · loans & advances
│                         (with approval & repayment history) · pay simulator (the current what-if preview)
├─ 4. Payslips            issued payslips (viewer) · distribution (email; WhatsApp notice) · distribution log
├─ 5. Statutory & Tax     TDS: Form 138/24Q extract, Form 130/16 · PF ECR · ESI challan · PT & LWF returns (NEW) ·
│                         statutory bonus · challan reference capture (link to Finance TDS) ·
│                         statutory rule versions (recording screen, NEW) · link: IT Declaration Review (HR)
├─ 6. Reports             payroll register (final) · department cost · employee pay history · audit trail
└─ 7. Settings            the one payroll settings editor (Setup Wizard writes through the same normalised keys)
```

**Combined or reorganised pages**

| Proposed page | Combines |
|---|---|
| Run Payroll | Payroll Processing (as is), plus the inputs that today reach runs by side doors (attendance sync, leave encashment, arrears) and the missing one-time inputs |
| Employee Pay Setup | Salary Structures & Loans, plus the pay simulator moved from Payslips. Removes the client arrears calculator. |
| Payslips | The viewer plus the distribution half of "Preview & distribute" |
| Statutory & Tax | Form 16/130 and 138/24Q, plus the three unreachable statutory endpoints, plus PT/LWF, plus the rules screen |
| Reports | The unreachable register, department-cost and history endpoints |

**Employee self-service stays outside the Payroll Center.** "My Payslip" moves to the HR → Self Service group, so employees can reach it (F-18). It uses the same viewer in own-only mode, already enforced on the server by `ownPayslipOrForbidden`.

---

## C. Retain, merge, relocate or remove

| Item | Decision | Reason |
|---|---|---|
| Overview | **Retain, improve** | Useful status flow; add a month selector and an exceptions panel |
| Payroll Processing (generate / approve) | **Retain, extend into Run Payroll** | Core; controls are sound |
| Mark paid (HR side) | **Relocate to Finance** | Payment is a Finance act. Payroll shows the status. Requires a bank reference (PC-02). |
| Salary structures, assignments, proposals | **Retain** (Employee Pay Setup) | Core |
| Client-side arrears calculator | **Remove; replace** with the server arrears feature | Wrong formula, saves nothing, duplicates a better backend (PC-10) |
| Loans & advances | **Retain, add approval and disbursement accounting** | Core; travel advances stay in Travel (no duplication) |
| What-if payslip preview | **Relocate** to Employee Pay Setup as "Pay simulator" | A planning tool, not a payslip; keep the watermark |
| Payslip distribution and viewer | **Merge** into Payslips | One place for issued payslips |
| WhatsApp send | **Retain only after guarding** the endpoint (PC-07), labelled "notify on WhatsApp" | It sends no payslip |
| Form 16/130, Form 138/24Q | **Retain** | Statutory |
| PF ECR, ESI challan, statutory bonus | **Add screens** (Statutory & Tax) | Built, unreachable |
| Register, department cost, history | **Add screens** (Reports) | Built, unreachable |
| Statutory rule versions | **Add a screen** | Release blockers can't otherwise be cleared |
| Settings (Payroll) vs Setup Wizard payroll step | **Merge** to one editor; the wizard calls the same API and keys | Two key families (PC-16) |
| `/payroll/run`, `payrollService.js`, `hrService.js` payroll calls | **Remove** (after a final search) | Unused aliases |
| `/payroll/save-slip`, `/payroll/bulk-generate` | **Remove** (after confirming no external caller) | Superseded |
| IT Declaration Review | **Keep in HR**; link from Statutory & Tax | HR owns review; no duplicate page |
| Expense claims and reimbursements | **Do not add to payroll** | Already paid through Travel/Expense with Finance; adding them would duplicate |

---

## D. Missing functionality checklist

| Capability | Status today | Evidence | Recommended location |
|---|---|---|---|
| Payroll calendar and cut-off | **Partial**: settings hold pay day and cut-off; `GET /payroll/cycle` reports them; the release gate checks consistency. No calendar, no period lock, cut-off not enforced on inputs. | `payroll.service.js:978`, `payrollReleaseGate.js` | Overview (calendar) + Run Payroll (period lock) |
| Attendance, leave and LOP | **Partial / inconsistent**: LOP from `payroll_attendance_summary` (Attendance sync). Sync writes `lop_days` onto drafts **without recomputing pay** (PC-05). Lookup errors become 0 (PC-06). Notice-period absences not auto-marked (Exit design ED-16). | `attendance.routes.js:2709-2713`, `payroll.service.js:139-147` | Run Payroll → Inputs (status from Attendance; no duplicate entry) |
| Salary revisions | **Blocked** for company 1 (PC-04) | settings `ctc_mode: true`, proposals 0, rules 0 | Employee Pay Setup |
| Arrears | **Backend only** (server feature, seed data only); client calculator wrong | `/payroll/arrears*`; `SalaryStructure.jsx:76-96` | Run Payroll → Inputs |
| Bonuses and one-time earnings/deductions | **Missing** in real runs (engine supports `bonus`; generate never passes it) | `payroll.service.js` (bonus only in preview overrides) | Run Payroll → Inputs |
| Loans and advances | **Partial**: no approval, disbursement not journaled, repayment history unseen | Part 13/14 | Employee Pay Setup |
| Reimbursements | **Handled elsewhere** (Travel/Expense → Finance) | §202 | No payroll page (avoid duplication) |
| Exit and final settlement | **Missing**: leavers excluded from the final month; F&F suspended | F-04, P0-2, Exit design | Run Payroll → Inputs (leavers from Exit Management); settlement stays in Exit/Finance |
| Validation, maker-checker, approval | **Present and sound** for approval. **Missing** for salary-revision approval (CTC mode off) and loan creation. | `approvePayroll` gates | Keep; extend |
| Bank transfer, payment tracking, reconciliation | **Missing**: no salary bank file; payment batches are supplier-only; no reconciliation | `payment_batch_items` (supplier_id) | **Finance** (payment batch with employee payee) — status shown in Run Payroll |
| Payroll accounting | **Partial**: journal at approval (failure skipped, PC-08); disbursement journal at mark-paid; no payroll journal has ever posted | `payroll.controller.js:236-254` | Finance (posting), visible in Run Payroll |
| Tax declarations, proofs, TDS | **Partial / defective** (P0-7, C7 paper) | F-09 | HR IT Declaration Review + engine fix |
| PF / ESI / PT / LWF challans and returns | PF ECR and ESI challan **without screens**; PT/LWF returns **missing**; TDS deposit tracking in Finance TDS (vendor-focused) | §A7 | Statutory & Tax |
| Payslips and self-service | Generation ✅; distribution ◐ (SMTP); employees blocked from the viewer page (F-18); Home widget works | — | Payslips + HR Self Service |
| Audit trail and exceptions | Mutations audited (`auditMutations('payroll')`), validation issues per run, eligibility reasons. No exceptions queue; history endpoint unseen. | — | Overview (exceptions) + Reports (audit) |

---

## E. Broken functionality and severity

| ID | Sev. | Defect | Evidence |
|---|---|---|---|
| **PC-01** | **P0** | Payroll access ignores the permission matrix. One hardcoded list (`PAYROLL_READ_ROLES` = admin, super_admin, hr, hr_manager, **hr_exec**, payroll_admin, **manager**, **finance_manager**) guards every payroll and salary-structure endpoint: read, generate, salary assignment, loans, arrears, payslips and Form 16 of any employee, PF ECR. The matrix gives `manager` and `hr_exec` **no** payroll rights and `finance_manager` view only. No field rules restrict them. **Active holders:** `manager` 1, `hr_exec` 1, `finance_manager` 1. | `payroll.routes.js:44`, `payrollAccess.js:17`, `salaryStructure.routes.js:14`; `role_permissions` (module payroll) |
| **PC-02** | **P0** | "Mark paid" is allowed for the same read list (including `manager`), needs no bank or payment reference, and posts a disbursement journal (Dr 2040 / Cr 1001) from HR's click. Approval is limited to Finance roles; payment is not. | `payroll.routes.js:138`; `payroll.service.js:726-780`; `Payroll.jsx:174-199` |
| **PC-03** | P1 | Release blockers (statutory rule versions, the CTC policy) can only be cleared through `POST /payroll/statutory-rules`, an API with no screen; `payroll_statutory_rules` has 0 rows. **No payroll can be approved through the UI.** | `Payroll.jsx:470`; table count |
| **PC-04** | P1 | **Salary-revision deadlock** for company 1. CTC mode is on, so direct assignment returns 409, and proposals are blocked by `CTC_POLICY_NOT_RECORDED`. No UI path can give anyone a new salary. | settings `ctc_mode: true` (saved 29 Oct 26); `ctcService.js:159`; `salaryStructure.routes.js:19-20` |
| **PC-05** | P1 | Attendance payroll-sync writes `lop_days` onto draft runs without recomputing gross, net or LOP amount, so a draft's LOP and amounts disagree until it is regenerated. Approving a synced-but-not-regenerated draft pays the old amounts. | `attendance.routes.js:2709-2713` |
| **PC-06** | P1 | Overtime, LOP and declaration lookups in period building end with `.catch(() => empty)`. A database error silently means **no LOP and no overtime** (overpayment and underpayment) and no declarations. | `payroll.service.js:139-147, 166-170` |
| **PC-07** | P1 | `POST /integrations/whatsapp/send` has **no permission check**. Any signed-in user can send any template to any number on the company's WhatsApp account. The payroll button labelled as sharing a payslip sends only a template message. | `whatsapp.routes.js:99`; `PayslipViewer.jsx:230-234` |
| **PC-08** | P1 | Payroll approval logs and continues when the GL journal fails ("GL posting skipped"), so a period can be approved with no accounting. | `payroll.controller.js:252-254` |
| **PC-09** | P1 | Bonuses and other one-time earnings or deductions can't be entered into a real run (only the what-if preview takes them) | `payroll.service.js:405` (overrides only) |
| **PC-10** | P1 | The client-side arrears calculator is wrong (Basic difference only; whole months; no PF, HRA or proration) and saves nothing. The server arrears workflow with approval has no screen. | `SalaryStructure.jsx:76-96, 704-734`; `/payroll/arrears*` |
| **PC-11** | P2 | PF ECR, ESI challan and statutory bonus reports exist with no screen | §A7 |
| **PC-12** | P1 | Regenerating a month deletes pending runs of now-ineligible employees. **September 2026 regeneration would delete 29 of 32 runs, including #41.** Protected by the administrative instruction (sign-off pack C1), not by code. | `payroll.service.js:308-309` |
| **PC-13** | P2 | "Mark all paid" fires one request per employee in parallel. A partial failure leaves a mixed state, and the toast says only "failed". | `Payroll.jsx:184-199` |
| **PC-14** | P1 | Leave encashment adds its **net** amount to `payroll_runs.leave_encashment_amount`, a column the payroll engine never reads. Gross, net and TDS are unchanged, and regeneration drops it. The encashment looks "linked to payroll" but is not paid by it. | `encashment.routes.js:194-199`; no engine reference |
| **PC-15** | P2 | PT and LWF return or challan outputs are missing | — |
| **PC-16** | P2 | Payroll settings are edited by two screens (Payroll Settings, Setup Wizard) with different key names. They are normalised in code, but the stored blob holds both families, and the Overview flags conflicts. | `company_settings` keys; `payrollSettings.js` |
| **PC-17** | P1 | Employees can't open "My Payslip" (Finance menu) — same as F-18 | `menuCatalog.js:401-405` |
| **PC-18** | P2 | The Overview is fixed to the current month; an earlier stuck month (September 2026) is not visible | `PayrollOverview.jsx` |
| **PC-19** | P2 | Loans: no approval step for creation; disbursement not journaled | Part 13/14 |
| **PC-20** | P3 | Import-time seeding of global salary structures in the router file | `salaryStructure.routes.js:54` |
| **PC-21** | P3 | Unused alias routes and services (`/payroll/run`, `/save-slip`, `/bulk-generate`, `payrollService.js`, `hrService.js`) | §A7 |
| **PC-22** | P3 | Payroll and salary endpoints use hardcoded role lists instead of `requirePermission('payroll', …)` (cause of PC-01) | as PC-01 |
| **PC-23** | P3 | Default revision effective date uses UTC "today" (a day behind IST between 00:00 and 05:30) | `salaryStructure.routes.js:310` |
| **PC-24** | P3 | Overview labels pending runs as "draft" | `PayrollOverview.jsx` |

**Data states noted, not defects of this page:**
- the September 2026 batch (32 pending, no preparer);
- EMP038's annual-as-monthly revision;
- seed loans and arrears.

All are covered by the sign-off pack and are not to be touched.

---

## F. Cross-module dependencies and integration requirements

| Module | Payroll needs | Today | Requirement |
|---|---|---|---|
| **Attendance** | LOP, overtime, night shift per period; period freeze | Sync writes the summary and patches `lop_days` (PC-05) | The sync only writes the summary. Payroll reads it at generate time and shows sync status. A run is stale if synced after generation. |
| **Leave** | LOP leave types; encashment amounts | Encashment written to an unused column (PC-14) | Encashment becomes a one-time earning input read by generate, with TDS through the engine |
| **Employees** | Joining and exit dates, bank details (verified), PAN, state/branch | Bank verification not enforced (F-20); branch missing for all (payroll audit Part 7) | Read only; bank verification gate (P0 F-20) |
| **Exit Management** | Leavers' final month; F&F components | Leavers excluded (F-04); F&F suspended | Exit design Phase 4: date-based eligibility, leaver panel, off-cycle final run (ED-9) |
| **Finance** | Journals (approval, disbursement, loans); payments; reconciliation; TDS challans | Journal at approval can be skipped (PC-08); payment = HR click (PC-02); payment batches supplier-only | Posting atomic with approval. Salary payment through Finance payment batches (employee payee, NEFT file, UTR). Reconciliation in Finance. Loan GL mapping (Part 14). |
| **Travel / Expense** | none (reimbursements paid separately) | correct | Keep separate; show nothing in payroll |
| **HR Self Service / IT Declarations** | Approved declarations, regime | F-09 | P0-7 and C7 decision (MD-15) |
| **Settings / Setup Wizard** | One settings source | two key families (PC-16) | Wizard writes through the payroll settings API |
| **Integrations (WhatsApp, e-mail)** | Payslip notices | WhatsApp unguarded (PC-07); SMTP optional | Permission on send; payslip e-mail log already exists |

**Constraints for every change:**
- Every query stays scoped by `companyOf(req)` and fails closed without a company.
- Approval keeps the release gate, `PREPARER_UNKNOWN` and `MAKER_CHECKER`.
- `auditMutations('payroll')` remains on every payroll route.

---

## G. Recommended implementation sequence

Each step needs approval, tests on the isolated test database, and the manual updated. **September 2026 stays untouched throughout**, and containment stays on.

| Step | Scope | Fixes | Depends on |
|---|---|---|---|
| 1 | **Access control.** Replace the hardcoded lists with `requirePermission('payroll', view/add/edit/approve)` and multi-role checks. Own-payslip access unchanged. Guard WhatsApp send. Measure the role holders affected first. | PC-01, PC-22, PC-07 | Management confirms the payroll matrix per role (ED-22 style) |
| 2 | **Payment control.** Remove HR mark-paid. Payment status comes from Finance (payment batch with employee payee, UTR). Disbursement journal at payment. | PC-02, PC-13 | Finance decisions MD-10/MD-11; Exit design P0-3 payment-batch change |
| 3 | **Unblock approvals.** Statutory rules and CTC policy recording screen (admin/payroll_admin, with evidence fields), or management decides to switch CTC mode off until the policy is recorded. | PC-03, PC-04 | Finance/HR decision on CTC definition |
| 4 | **Inputs.** Generate reads one-time earnings/deductions, server arrears and leave encashment. The attendance sync stops patching runs (marks stale instead). Lookup errors fail loudly. | PC-05, PC-06, PC-09, PC-10, PC-14 | P0-7 (declarations), MD-15 |
| 5 | **Accounting atomicity.** The approval transaction includes the journal, or the approval fails. | PC-08 | Finance GL mapping |
| 6 | **Navigation.** The structure in §B: Run Payroll workspace, Employee Pay Setup, Payslips merge, Statutory & Tax and Reports screens for the existing endpoints, My Payslip in Self Service, Overview month selector and exceptions. Settings single editor. Remove the dead aliases. | PC-11, PC-15, PC-16, PC-17, PC-18, PC-20, PC-21, PC-24 | Steps 1–4 for the content |
| 7 | **Exit integration.** Leaver panel, date-based eligibility, off-cycle final run. | F-04, PC-12 (safer regeneration: never delete runs that have evidence value without confirmation) | Exit design Phase 4, ED-9 |
| 8 | **Statutory outputs.** PT/LWF returns; TDS challan reference capture, linked to Finance TDS. | PC-15 | Legal/tax confirmation of formats |

**Do first, independent of the redesign:** steps 1 and 2. They are the only P0 items, and they change no calculation.
