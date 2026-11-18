# Pulse ERP — HR Module Functional, Workflow & Integration Audit

**Date:** 03 Nov 26 · **Type:** read-only audit. No code, schema, API, UI, workflow or data was changed.
**Method:** each menu row was traced through its React page, the API calls it makes, the Express route and guard, and the PostgreSQL tables it uses. Live row counts and schema came from read-only queries (`SET SESSION … READ ONLY`) against the dev database `Pulse`. Findings from earlier passes (§187–§213 of `MODULE_FEATURE_CONNECTION_MANUAL.md`) were re-checked in the current code, not assumed.

**How to read this report.** Every defect has one ID (`F-nn`) and is described once, in §8 *Technical Issues Register*. The page sections, the integration matrix and the action plan refer to those IDs instead of repeating them.

**Limits on what could be verified**
- **No browser session.** Nothing here was clicked through in a browser. UI behaviour is inferred from the code and the API contract. Where a click outcome is stated, it comes from the route guard or the response shape.
- **Mostly seed data.** Live data is mostly seed or QA rows (5 exits, 5 IT declarations, 0 bank change requests, 0 probation reviews, 1 intern). So "measured" findings show the state of the records, not real usage volumes.
- **Some areas only checked at the seams.** Leave, Attendance, Timesheets, Learning Center and Performance internals were checked only where they connect to HR pages. Their own audits are in the `LEAVE_*`, `ATTENDANCE_*`, `LND_*` and `PERFORMANCE_*` files.
- **Statutory rates not re-checked.** Payroll statutory correctness is covered by `PAYROLL_DATA_FLOW_AUDIT.md` (Parts 1–14) and was not repeated. Only its connections to the HR pages were checked.

---

## 1. Executive Summary

**Overall assessment.** Most of the HR module's individual screens are well built and tenant-scoped. Internships, Announcements, Succession and Gate Pass have each had a hardening pass. The weak point is **the employee lifecycle between pages**:
- probation decisions never reach the employee record;
- an exit can be finalised by three independent paths;
- the F&F calculation is wrong in three separate ways;
- leavers can drop out of their final month's payroll;
- exited employees keep working logins.

These are workflow and integration defects, not cosmetic ones. Several of them affect money and access.

| Metric | Count |
|---|---|
| HR menu rows audited | **13**: the 12 requested, plus **Self Service** (`EmployeeSelfService`), which is a separate row in the same menu |
| Embedded sub-pages / tabs audited | 4 Employee Records tabs, 2 Exit tabs, 6 Payroll sections, 6 Succession tabs, 3 Gate Pass tabs, plus hidden pages (`MyAnnouncements`, `MyProbationReviews`, `MyInternEvaluations`, Add/Edit/View Intern) |
| Functional (works end to end for its own purpose) | **5**: Internships, Announcements, Workforce Analytics, Succession Center, Gate Pass & Visitors |
| Partially functional | **6**: Payroll Center, IT Declaration Review, Bank Detail Approvals, My Dashboard, Self Service, Employee Records |
| Incomplete or unsafe workflow | **2**: Probation Management, Exit Management |

**Critical risks (P0)**
1. **F&F settlement is wrong in three ways.**
   - Leave encashment is always ₹0 (F-01).
   - Notice recovery grows each day after the last working day (F-02).
   - Final salary, loans and claims are left out, and a different salary source from payroll is used (F-03).
2. **Leavers drop out of their final month's payroll.** The last-working-day job sets them to `Left`, and the payroll eligibility rule then excludes them (F-04).
3. **F&F is computed, approved and "paid" by the same HR role** with no Finance posting and no payment record (F-05).
4. **4 exited employees still have active logins** (EMP010, EMP011, EMP014, EMP034) (F-06).
5. **Policy acknowledgements, a legal record, can be filed for anyone and are stored under the wrong identifier** (F-07).
6. **Offboarding "Complete" finalises an exit without clearance or F&F** (F-08).
7. **TDS uses unreviewed IT declarations and ignores 80C/HRA declarations.** A database error silently becomes "no declarations" (F-09).

**Major integration gaps**
- Probation decisions have no effect on the employee record (F-11).
- Recruitment hires skip probation (F-12).
- Payroll ignores bank verification (F-20).
- HR has no Finance posting for F&F or intern stipends (F-22).
- IT declarations, bank changes, resignations and F&F are missing from the Approval Center (F-36).

**Major duplication**
- Exit is written from 4 screens and 7 code paths, and has 2 clearance checklists (D-01 to D-03).
- My Dashboard and Self Service repeat the same dashboard and clock-in (D-05, D-06).
- Biometric device management appears in both HR and Attendance (D-07).
- 7 dead API alias mounts (D-08).

---

## 2. Complete HR Page Inventory

| # | Menu row → page key | Files | Purpose | Status | Related modules |
|---|---|---|---|---|---|
| 1 | Internships → `Internships` (+ `AddIntern`, `EditIntern`, `ViewIntern`, `MyInternEvaluations`) | `features/internships/pages/*`; `modules/hr/internships.routes.js`, `internEvaluations.routes.js`, `internConversion.js` | Register of interns (a separate population with INT codes, not counted as employees), evaluations, certificates, conversion to employee | **Functional**, with gaps F-30 | Employees (mentor, conversion), Recruitment (none, see F-30), Finance (none, see F-22) |
| 2 | Payroll Center → `PayrollCenter` (6 sections) | `features/hr/pages/PayrollCenter.jsx` + `Payroll`, `SalaryStructure`, `PayslipGenerator`, `PayslipViewer`, `PayrollForm16/24Q`, `PayrollSettings`; `modules/payroll/*` | Settings → structures → processing → payslips → statutory returns | **Partial**: approval correctly blocked by the release gate; F-04, F-09, F-22 | Attendance, Leave (LOP), Loans, Finance (GL), TDS |
| 3 | IT Declaration Review → `ITDeclarationReview` | `features/hr/pages/ITDeclarationReview.jsx`; `modules/hr/selfservice.routes.js:65-250` | HR reviews employee tax declarations | **Partial**: the review works, but payroll does not respect its outcome (F-09, F-23) | Self Service, Payroll TDS |
| 4 | Bank Detail Approvals → `BankChangeApprovals` | `features/hr/pages/BankChangeApprovals.jsx`; `employees/bankChange.service.js`; `employee.routes.js:33-38` | Maker-checker on bank details; verify-as-is | **Partial**: the workflow works, but the result is not used downstream (F-20) | Employees, Payroll, Finance (Accounts notified) |
| 5 | Announcements → `Announcements` (+ `MyAnnouncements` reader) | `features/hr/pages/Announcements.jsx`; `backend/src/announcements/*` | Publish company announcements with targeting and read receipts | **Functional**, with gaps F-29 | Home, Notifications, Employees |
| 6 | Workforce Analytics & Reports → `EmployeeReports` | `features/hr/pages/EmployeeReports.jsx`; `GET /analytics/workforce`, `/analytics/employee-reports/*` | Headcount composition, joining/attrition, 3 CSV exports | **Functional**, narrow scope (F-32) | Employees, Exit, Documents |
| 7 | My Dashboard → `EmployeeDashboard` | `pages/EmployeeDashboard.jsx` | Personal punch, leave, tasks, payslip, announcements | **Partial**: dead links for employees (F-18) | Attendance, Leave, Tasks, Payroll, Timesheets |
| 8 | Self Service → `EmployeeSelfService` | `features/hr/pages/EmployeeSelfService.jsx`; `modules/hr/selfservice.routes.js` | Own IT declarations, document vault, reimbursements, profile update | **Partial**: F-23, F-24, D-06 | Payroll, Travel/Expense, Employees |
| 9 | Employee Records → `EmployeeRecords` (tabs: Documents · Asset Management · Policies · HR Documents) | `EmployeeRecords.jsx` + `EmployeeDocuments`, `EmployeeAssets`, `Policies`, `Downloads`; `/self-service/documents`, `/employee-assets`, `/hr/policies`, `/hr/downloads` | HR document register, asset allocation, policy acknowledgement, downloadable forms | **Partial**: F-07, F-19, F-33 | Assets, Exit clearance, Home |
| 10 | Probation Management → `Probation` (+ `MyProbationReviews`) | `features/hr/pages/Probation.jsx`; `backend/src/probation/*`; `jobs/probation.cron.js` | Track probation end, request a head's review, record the outcome | **Incomplete**: F-11, F-12 | Employees, Department heads, Approval Center (`prob`) |
| 11 | Exit Management → `ExitCenter` (tabs: Exits & Settlement · Offboarding Checklist) | `ExitCenter.jsx`, `ExitManagement.jsx`, `Offboarding.jsx`; `modules/hr/exit.routes.js`, `fnf.service.js`, `hr.routes.js:570-1032`; crons `exitStatusSync`, `fnfAutoTrigger` | Resignation → notice → clearance → interview → F&F → offboarding | **Incomplete / unsafe**: F-01 to F-08, F-14 to F-17 | Employees, Assets, Travel advances, Payroll, Finance, Auth |
| 12 | Succession Center → `SuccessionCenter` (6 tabs) | `SuccessionCenter.jsx` + 6 pages; `modules/hr/succession.routes.js` | Critical roles, 9-box, pipeline, development plans, talent pools | **Functional** (remediated §209–§212); live data is mostly emptied seed rows | Performance (assessment sync), Employees |
| 13 | Gate Pass & Visitors → `BiometricAccess` (tabs: Attendance Import · Gate Passes · Visitors) | `BiometricAccess.jsx`, `components/biometric/*`; `modules/hr/biometric.routes.js` | Gate passes with an approver chain, visitor register, biometric import | **Functional**, but the page scope is wrong (F-31) and has a privacy gap (F-21) | Attendance, Approval Center (`gate`), Employees |

**HR-related functions found outside the HR menu.** These are relevant to the lifecycle.
- **Onboarding checklist.** Templates are in `hr_onboarding_checklist_templates`, and progress is per employee. It is reachable only inside **Employee Profile** (`features/employees/pages/EmployeeProfile.jsx`). `GET /onboarding/pending` exists but has **no caller**, so HR has no onboarding queue.
- **Background Verification.** This is in the Employees menu, module `bgv`.
- **Ex-Employees.** This is in the Employees menu. It writes `PATCH /employees/ex/:id/exit-details`, so it is a second exit editor.
- **Learning Center pages.** These have their own menu and were not audited here.

---

## 3. Individual Page Audit

### 3.1 Internships
- **Business purpose.** Interns are a separate population with INT codes, kept out of headcount and payroll. The page manages the internship from start to completion, the certificate, and conversion to employee.
- **Existing functionality.**
  - Summary cards, where each card applies the exact filter that produced its count (`Internships.jsx:10-17`).
  - A register with 13 filters stored in the URL.
  - A Reports tab and a Document Templates tab.
  - On the backend: list, summary, filter-options, mentor-options, code minting, templates CRUD, complete, certificate issue and revoke, and conversion eligibility (`internships.routes.js:497-1180`).
  - Mentor evaluation workflow (`internEvaluations.routes.js`).
- **Inputs.** The mentor is validated as a current employee of the same company (`internships.routes.js:297-310`). Files are limited to 5 MB.
- **Filters.** Search is debounced. There are department, college, status, stage, mentor, type and duration filters, plus start and end date ranges. Filters show as removable chips with a *Clear all*. **Missing:** pagination, column sorting and an export of the register (F-30).
- **Actions.** View and Edit appear on every row. *+ Add Intern* is always shown. Neither button checks a permission in the UI, although the server enforces `internships:add/edit` (F-30). There is no delete or archive, which is acceptable because the record is kept for good.
- **Workflow.**
  - Status runs Onboarding → Active → Completed.
  - Completion needs an HR-approved evaluation (`trg_interns_completion_guard`).
  - Conversion goes through the normal `POST /employees` with `from_intern_id`, in one transaction (`internConversion.js:1-22`). **This is the model the other lifecycle hand-offs should copy** (see F-12).
- **API/DB.** Tables are `interns`, `intern_evaluations`, `intern_evaluation_events`, `intern_documents`, `intern_certificates` and `intern_audit_events`. The FKs are present: company, mentor, converted employee and completion evaluation.
- **Integration.** Conversion to employee is implemented. Recruitment → intern is **missing**. Stipends have no payment path (F-22).
- **Duplicate functionality.** None.
- **Unnecessary functionality.** The hero's *View Employees →* button is a navigation shortcut with no internship purpose. It can be removed (P3).
- **Recommended structure.** Keep it as is. Add pagination, sorting and export, gate the buttons on permission, and add a Stipend Payout action that hands off to Finance.

### 3.2 Payroll Center
- **Business purpose.** One home for payroll, in workflow order.
- **Existing functionality.**
  - The section list is in `components/payroll/payrollCenterTabs.js`.
  - Release readiness gate (`payrollReleaseGate.js`), maker-checker (`generated_by`), loans with `installmentFor()`, and statutory rules by effective date.
  - The audit history is in `PAYROLL_DATA_FLOW_AUDIT.md` Parts 1–14.
- **Inputs, filters and actions.** Owned by each embedded page and covered by the earlier audit. This pass found nothing new at the page level.
- **Workflow.** Generate → approve → mark paid. Approval is server-gated (422 with blockers). The 7 October blockers come from the release gate itself and are correct behaviour, not defects.
- **Integration defects found in this pass.**
  - Declarations are consumed incorrectly (F-09).
  - Leavers are excluded from their final month (F-04).
  - Unverified bank details are payable (F-20).
  - The journal has never posted live, and the loan GL mapping is missing (F-22).
- **Duplicate functionality.** The six sub-page keys still route on their own and are redirected into the hub. They have no NAV row, so the section allowlist never applies to their URLs (F-28).
- **Recommended structure.** Keep the six sections. Add a **"Leavers this period"** panel to Processing so final-salary cases cannot disappear silently (see F-04).

### 3.3 IT Declaration Review
- **Business purpose.** HR verifies employees' tax-saving declarations before they reduce TDS.
- **Existing functionality.**
  - A financial-year selector and status tabs.
  - Approve, Reject (a reason is required), Reopen, and History from the audit log (`ITDeclarationReview.jsx:37-173`).
  - Proof links are made safe with `safeLink`.
  - The server gates are `it_declarations:view/approve`, and duplicate filings are refused with 409 (`selfservice.routes.js:96-104`).
- **Inputs.** The reviewer cannot change the amount, which is acceptable. Only the rejection reason is entered.
- **Filters.** FY and status only. **Missing:** employee search, department filter, section (type) filter, amount sort and export.
- **Actions.** Correctly limited by `can_review`. **Missing:** bulk approve, partial approval (an approved amount lower than the declared amount), and a proof-verified flag.
- **Workflow defect.** The review has no effect on tax. Payroll counts `submitted` rows as well as `approved` ones, so an unreviewed declaration already reduces TDS (F-09).
- **Data.** All 5 live rows have `status='active'` and type values `Routine/Standard/General/Primary`, which are seed artefacts. They never appear under *Submitted*, and payroll ignores them (F-23, F-34).
- **Missing functionality.** There is no declaration window, no separate proof-submission phase (provisional vs actual declarations), no regime choice per employee, and no Approval Center source (F-36).
- **Recommended structure.** Keep the page. Add filters, partial approval and FY locking, and make payroll read only `approved` amounts.

### 3.4 Bank Detail Approvals
- **Business purpose.** Maker-checker control on salary bank accounts.
- **Existing functionality.**
  - Status tabs; Approve, Reject (reason required) and Withdraw.
  - Masked numbers for holders who only have `:add`.
  - "Entered by you — another HR person approves" (`BankChangeApprovals.jsx:97-130`).
  - Verify-as-is with a 409 if the details changed in the meantime (§206).
- **Filters.** Status only. **Missing:** employee search and date range. These matter only at scale; P3.
- **Workflow.** Implemented correctly as far as the approval goes. **Downstream:** payroll and the salary bank file never read `bank_verified_at` (F-20). Employees cannot raise a change themselves (F-20). There is no Approval Center source (F-36).
- **Data.** There are 0 requests. All 4 live bank records failed the format check in §205 and still need correction.
- **Recommended structure.** Keep the page. Add an employee-initiated request with a proof upload (cancelled cheque or bank letter). Block disbursement for unverified accounts once the business enables enforcement.

### 3.5 Announcements
- **Business purpose.** Company communication, targeted to a group, with read tracking.
- **Existing functionality.**
  - Tabs All, Active, Scheduled, Inactive, Expired; search; a create and edit drawer with a rich-text editor.
  - Priority, category, date range and target; pin, toggle and archive.
  - Read counts (`Announcements.jsx:225-440`).
  - On the server, the matrix is enforced on management routes (`announcement.routes.js:21-26`). One visibility module feeds `/active`, Home and read receipts. Each announcement is notified once only, by a 5-minute cron.
- **Inputs.**
  - The **department dropdown is built from whichever employees happen to load** (`Announcements.jsx:280-288`), not from the department master. A department with no active staff cannot be targeted, and spelling variants show up as separate departments.
  - **Categories are hardcoded** (`Announcements.jsx:23`).
- **Targeting.** Only `all`, `department` and `employee` are supported (`announcement.visibility.js:41-44`). There is no branch, designation or role targeting.
- **Missing.** Attachments; required acknowledgement for policy-type notices (which belongs in Policies); a per-announcement report of who has read it.
- **Recommended structure.** Keep the page. Source departments from the master, move categories to master data, and add branch targeting.

### 3.6 Workforce Analytics & Reports
- **Business purpose.** Workforce composition and attrition for HR.
- **Existing functionality.**
  - 10 composition cards, of which 6 drill into All Employees.
  - Joining and attrition trend.
  - Global filters: department, location, type, designation, gender, status, skill.
  - Headcount, attrition and document-expiry CSV exports, with every cell formula-quoted and Aadhaar masked (`EmployeeReports.jsx:46-438`).
  - Links are hidden when the user lacks the permission.
- **Gaps.**
  - The page only analyses the **employee master** (F-32). It has nothing on leave or absenteeism, attendance or late arrivals, payroll cost by department (the endpoint exists in Payroll), probation due or overdue, time-to-hire or offer acceptance, training completion, or exit reasons beyond the attrition CSV.
  - The age, experience and workforce-category cards cannot drill down. This is documented as intentional.
- **Recommended structure.** Keep the page. Add a "Lifecycle" band (probation due, notice, F&F pending) and a "Cost" band (from the payroll department-cost report), and keep the CSV section.

### 3.7 My Dashboard
- **Business purpose.** The signed-in person's daily view.
- **Existing functionality.** It makes 11 parallel reads (`EmployeeDashboard.jsx:295-306`). It offers clock in/out (`POST /attendance/clock`, `:413`), quick leave apply (`:519`) and shortcuts.
- **Defects.**
  - The 3 *payslip* links go to `PayslipViewer` (`:467`, `:803`, `:1104`). That page sits in the **Finance** section, which the `employee` role does not hold (`menuCatalog.js:401-405`), so employees get **Access Denied** (F-18).
  - *View All* on Company Announcements goes to the HR administration page `Announcements` (`:914`), not to `MyAnnouncements` (F-18).
- **Duplicate functionality.** Clock-in, holidays, announcements and tasks also appear on the Self Service Dashboard tab (D-05, D-06).
- **Recommended structure.** Keep this page as the one personal dashboard and fix the two link targets. Remove the duplicate tab from Self Service.

### 3.8 Self Service
- **Business purpose.** Employee-initiated HR transactions.
- **Tabs.** Dashboard · IT Declaration · Document Vault · Reimbursements · Profile Update (`EmployeeSelfService.jsx:369`).
- **Input defects.**
  - **IT Declaration.**
    - The type list is `80C/80D/HRA/LTA/other` (`:571`), which does not match what the payroll engine reads (F-09).
    - Proof is a free-text **"Proof URL"** box (`:586`), not a file upload.
    - The "Est. tax saving" figure is hardcoded at 30% whatever the regime (`:559`).
    - The server accepts any type string and any financial year (`selfservice.routes.js:88-90`) (F-23).
  - **Document Vault.** The "Upload Document" form also takes a **URL text box** (`:655`) and then reports "Document uploaded". The backend accepts a real multipart file (`selfservice.routes.js:337`, `upload.single('file')`), but the page never sends one (F-24).
  - **Profile Update.** Only address and emergency contact can be updated (`:819`). Bank is correctly refused, but there is no request path (F-20).
- **Missing.** A "My assets" view (F-19), resignation (F-17), a gate pass request (F-31), and an "acknowledge policy" shortcut.
- **Recommended structure.** Turn Self Service into the employee's **request centre**: Declarations · Documents · Claims · Profile & Bank change · Assets · Resignation. Remove its Dashboard tab (D-06).

### 3.9 Employee Records
- **Business purpose.** HR's documentary record of employees and company-wide HR artefacts.
- **Tabs.** Employee Documents (module `employee_documents`) · Asset Management · Policies · HR Documents (`EmployeeRecords.jsx`).
- **Documents.** Pending, Verified and Rejected status changes; expiry flags; HR upload and delete through `/self-service/documents`. The daily `jobs/documentExpiry.cron.js` sends reminders. The table has an FK to `companies` only, **not to `employees`**, and 1 orphan row was measured (F-34).
- **Asset Management.**
  - Allocation, transfer, maintenance and soft-delete (`employee-assets.routes.js:56-356`).
  - Exit clearance correctly reads pending allocations (`exit.routes.js:93-134`). This is the one real cross-module gate in Exit.
  - The tab is **shown to employees** (`EmployeeAssets` is in `EMPLOYEE_SELF_SERVICE_PAGES`), but its first call needs `assets:view`, which employees are denied (F-19).
  - The router scope fails open when the company is null (F-10).
  - Allocations are not linked to `fixed_assets` (D-11).
- **Policies.**
  - Create and edit, with version, effective date, review date and the `requires_acknowledgement` flag.
  - Acknowledgement counts.
  - The acknowledgement endpoint is unsafe (F-07). A version change does not ask for a fresh acknowledgement (F-33).
- **HR Documents** (`hr_downloads`, 0 rows). Company forms. Scoped and fails closed since §208.
- **Recommended structure.** Keep the 4 tabs and their distinct purposes (§207). Fix F-07, F-19 and F-33. Show the Asset Management tab to employees as **read-only "My assets"**, or remove it from their view.

### 3.10 Probation Management
- **Business purpose.** Confirm, extend or end each new hire's probation on time.
- **Existing functionality.**
  - The list is employees with status `Probation` (`Probation.jsx:134-137`).
  - A notify/request-review flow (`POST /probation`); company policy settings.
  - Department-head reviews (`probation_reviews`, `MyProbationReviews`, reassign).
  - The daily reminder cron; an Approval Center `prob` source.
- **Inputs.** The decision select is *Confirmed / Extended / Terminated* (`:820-824`), with a rating and comments.
- **Workflow defects.**
  - **The decision has no effect** (F-11). `PUT /probation/:id` only writes `decision/performance_rating/comments` onto a *notification* row (`probation.service.js:275-309`). The employee's status, `confirmation_date` and `probation_end_date` are never changed, no letter is produced, and "Terminated" never opens an exit.
  - **Measured:** 9 decisions are recorded (3 Confirm, 2 Terminate, 4 Extend Probation). Every one of the 14 Probation employees is still Probation, and none has a confirmation date.
  - The stored vocabulary (`Extend Probation`) does not match what the UI checks (`extended`, `:195`), so the 4 historical extensions do not show as extensions.
- **Data defect (F-12).** **13 of 14 Probation employees have no `probation_end_date`.** The due and overdue logic cannot work for them, and recruitment hires never enter probation at all.
- **Duplicate functionality.** Two decision vocabularies describe the same outcome: `probation_notifications.decision` and `probation_reviews.recommendation` (`confirm/extend/not_confirm`) (D-13).
- **Recommended structure.**
  1. **Due list**, with end date, days left and review status.
  2. **Reviews**, requested from and answered by the head.
  3. **HR decision**, which writes the employee record in the same transaction: Confirm sets status Active and `confirmation_date`; Extend sets a new `probation_end_date` with a reason; Not confirmed opens an exit request of type termination.
  4. **History.**

### 3.11 Exit Management
- **Business purpose.** Controlled separation: resignation → acceptance → notice → clearance → exit interview → F&F → relieving → access removal.
- **Existing functionality.**
  - Initiate, active exits, withdraw (§ withdraw, one transaction), interviews and analytics.
  - F&F compute, approve and pay; a clearance checklist with blockers (assets, travel advances, access, NOCs).
  - An offboarding checklist from templates, with notify and complete.
  - Crons `exitStatusSync` (status on the last working day) and `fnfAutoTrigger`.
- **Input and validation defects.**
  - `separation_type` and `fnf_status` are free text, with no CHECK. Live values are `resignation/Standard/General/Primary`, and one row has `fnf_status='active'` (F-14).
  - There is **no resignation date** column. `exit_requests` has only `created_at` (F-02).
- **Workflow defects.**
  - **F&F amount:** F-01, F-02, F-03.
  - **F&F control:** compute, approve and pay all sit behind the same `requireHRWrite` (`exit.routes.js:591-718`), with no Finance step or journal (F-05).
  - **Three finalisation paths**, two of them ungated (F-08, D-03).
  - **Logins:** access is revoked only if someone ticks a box (F-06).
  - **Clearance:** one HR save ticks Finance and Manager NOCs (`exit.routes.js:744-790`), and save errors are swallowed in the UI (`ExitManagement.jsx:178`) (F-15).
  - **Gates:** role checks use a single `req.user.role` (`exit.routes.js:23-37`) (F-16).
  - **Self-service:** no employee resignation and no manager acceptance (F-17).
  - **Duplicate exits:** there is no unique "one open exit per employee" guard. **Measured:** 2 Active employees (ids 35 and 45) have open exits, and a `Left` employee (id 11) still has an `active` exit (F-14).
- **Duplicate functionality.** D-01, D-02, D-03, D-14.
- **Recommended structure.** One state machine, owned by Exit Management:
  1. **Requests**, raised by the employee or HR.
  2. **Acceptance** by the manager or HR, which fixes the LWD.
  3. **Notice**.
  4. **Clearance**: one templated checklist per exit request, each NOC signed by its own department.
  5. **Exit interview**.
  6. **F&F**: HR prepares, Finance approves and posts, the payment is recorded.
  7. **Close**: status set to the exit status, `exit_date` set, login disabled, relieving letter issued.

  Employee Profile and Ex-Employees become read-only views of this record.

### 3.12 Succession Center
- **Business purpose.** Continuity for critical roles.
- **Existing functionality.**
  - Tabs: Planning (dashboard, 9-box, critical roles, alerts), Leadership Pipeline, Development Plans (with actions and mentoring), Talent Pools, Reports, Settings.
  - All pages call `/succession/*` only (verified in each page).
  - Module `succession` is enforced on the server. Ratings are kept to 2 decimal places, an assessment history exists, and the `is_test` filter applies.
  - The performance-finalise step syncs into `talent_assessments` (§209).
- **Gaps.**
  - The Settings tab is shown to view-only holders. The server refuses the save, but the tab should be hidden (P3).
  - The `notify_roles` setting is stored but deliberately sends nothing (§211).
  - After the seed cleanup the live data is close to empty, so the screens cannot yet be judged in use.
- **Duplicate functionality.** `/hr/succession` and `/succession/succession` are alias mounts with no callers (D-08).
- **Recommended structure.** Keep the page; remediation is done. Optional later: link Development Plan actions to Learning Center courses.

### 3.13 Gate Pass & Visitors
- **Business purpose.** Controlled movement of staff out of the premises, and the visitor register.
- **Existing functionality.**
  - Gate passes with the approver chain head → manager → HR, no self-approval, an Approval Center `gate` source, and cancel and complete actions.
  - Visitors: check-in, check-out and badge.
  - A KPI strip (punched in, late, early exits, visitors inside).
- **Page-scope defect (F-31).** The **default tab is "Attendance Import"**: devices, sync and CSV. That is attendance infrastructure, and it duplicates Attendance Settings → Devices (D-07).
- **Missing.** Employees cannot request their own gate pass: `POST /gate-passes` needs `hr:add` (`biometric.routes.js:1302`). There is no security-desk role to mark out and in at the gate. Completion is HR-only.
- **Privacy (F-21).** `GET /visitors` returns `v.*`, including `id_number`, unmasked (`biometric.routes.js:1501`).
- **Recommended structure.** Rename the page to "Gate & Visitors" and keep two tabs, Gate Passes and Visitors. Move Attendance Import to Attendance. Add an employee "Request gate pass" in Self Service and a Security role for gate check.

---

## 4. HR Integration Matrix

| # | Source → Destination | Data | Trigger | Status | Issues | Recommendation |
|---|---|---|---|---|---|---|
| 1 | Recruitment → Employee Records | Candidate → employee row, login, onboarding checklist | Hire (`recruitment.repository.js` `hireCandidate`, INSERT at `:2028-2036`) | **Implemented but bypasses the employee service** | Sets `status='Active'`, `joining_date=CURRENT_DATE`, no probation dates, no branch or manager. The mandatory-field checks of `POST /employees` (bank, address) are skipped (F-12) | Route hires through `POST /employees`, as intern conversion does |
| 2 | Employee ↔ Attendance | Biometric logs → `attendance_records`; one shared shift rule | Device sync / CSV / clock | Implemented (§197–§198) | Device management exists in two places (D-07). How exited employees are handled was not verified | Relocate device tab |
| 3 | Employee ↔ Leaves | Balances, LOP → payroll drafts | Leave approval, payroll generate | Implemented for payroll | **F&F reads non-existent columns, so encashment is ₹0** (F-01) | Fix F&F to use `leave_balances` (allocated + carried forward − used − encashed) by `leave_type_id` |
| 4 | Employee ↔ Timesheets | Own timesheets on My Dashboard | Read | Implemented (read) | Not audited further | — |
| 5 | Employee ↔ Payroll | Eligibility E1–E6, salary revisions | Generate | Implemented | E2 is status-based, so leavers are excluded (F-04). F&F uses `employees.basic_salary`, which is not the payroll salary source (F-03) | Make E2 date-based; give F&F one salary source |
| 6 | Self Service → IT Declaration Review → Payroll TDS | Declarations | Submit / review / generate | **Partially connected** | Payroll counts `submitted` rows; types don't match; errors are swallowed (F-09) | Approved only; one section vocabulary |
| 7 | Employee ↔ Bank Detail Approvals → Payroll/Finance | Bank details, verification stamp | Approve | Approval implemented; **disconnected downstream** | Unverified accounts are payable (F-20) | Enforcement flag in payroll and payment batch |
| 8 | Employee ↔ Probation | Status, end date, decision | Review / decision | **Broken write-back** | Decisions never update the employee (F-11); end dates missing (F-12) | HR decision writes the employee record in one transaction |
| 9 | Employee ↔ Learning Center | Training, competencies | — | Not verified in this pass | — | Cover in an L&D-specific pass |
| 10 | Performance → Succession | Review ratings → `talent_assessments` | Finalise | Implemented (§209) | Probation reviews are separate from performance reviews; acceptable | Keep |
| 11 | Employee ↔ Exit | Status, exit date, login, clearance | Exit actions, crons | **Fragmented** | 7 writers (D-01, D-14); logins stay active (F-06); ungated finalisation (F-08) | One exit state machine |
| 12 | Employee ↔ Succession | Employees in plans and pools | Read / write | Implemented, same-company checks | `is_test` applies to Succession only (user decision) | Keep |
| 13 | Internships → Employee Records | Intern → employee | Conversion | **Implemented correctly** (`internConversion.js`) | — | Use as the pattern for row 1 |
| 13b | Recruitment → Internships | Candidate → intern | — | **Missing** | Interns are created by hand | Add a "hire as intern" outcome on intern openings, if intern hiring goes through ATS |
| 14 | Announcements → Portal / Notifications | Visible announcements, bell, read receipts | Publish cron | Implemented | My Dashboard link targets the admin page (F-18); department list not from master (F-29) | Fix the link |
| 15 | Gate Pass & Visitors ↔ Employee / Security | Requester, approver chain, host | Create / approve | Implemented for HR-raised passes | No employee request; no security role; visitor ID unmasked (F-21, F-31) | Add ESS request and security role |
| 16 | Workforce Analytics ↔ HR modules | Employees, exits, documents | Read | Partial | No leave, attendance, payroll cost, probation or recruitment data (F-32) | Extend |
| 17 | HR → Finance | Payroll journal, loan GL, F&F, stipends, claims | Approve / pay | **Mostly missing in practice** | Payroll journal code exists but no journal has ever posted, and loan approval is blocked until a GL mapping exists (Payroll audit Parts 13–14). F&F: no journal or payment (F-05). Stipends: no path (F-22). Bank change: Accounts are notified | F&F and stipend payables posted by Finance |

---

## 5. Duplication Register

| ID | Duplication | Affected | Business purpose traced | Action |
|---|---|---|---|---|
| D-01 | **Exit is edited from 4 screens**: Exit Management, Offboarding tab, Employee Profile (`/employees/:id/offboard`, `PUT /exit/clearance`, `PATCH /employees/ex/:id/exit-details`) and Ex-Employees (`exit-details`) | ExitCenter, EmployeeProfile, ExEmployees | All maintain the same `exit_requests` / `exit_clearance` / employee status | **MERGE**: Exit Management is the only writer; the others become read-only links |
| D-02 | **Two clearance checklists**: `exit_clearance` (fixed booleans and NOCs, gates F&F) and `hr_offboarding_checklist_*` (templated tasks, gates nothing) | Exits & Settlement tab, Offboarding tab | Both record "has this leaver handed everything over" | **MERGE** into one templated checklist per *exit request*. The F&F gate reads it |
| D-03 | **Three exit finalisation paths**: F&F pay (`exit.routes.js:651`, clearance-gated), Offboarding complete (`hr.routes.js:968`, ungated), `exitStatusSync.cron.js` (date-driven, ungated) | Exit | All set the employee to the exit status | **REWORK**: one finalise step, gated on clearance. The cron moves Notice to "LWD reached" only |
| D-04 | `onboarding_records` / `onboarding_tasks` (5 seed rows each) referenced only by seeds; the live checklist is `hr_onboarding_checklist_*` | — | None, dead | **REMOVE** after the owner confirms (separate migration) |
| D-05 | Clock in/out on My Dashboard (`EmployeeDashboard.jsx:413`) **and** the Self Service dashboard (`EmployeeSelfService.jsx:194`) **and** the Attendance pages | Personal pages | Same `POST /attendance/clock` | **KEEP** on My Dashboard and Attendance; **REMOVE** from Self Service |
| D-06 | Self Service "Dashboard" tab repeats My Dashboard (attendance today, holidays, announcements, tasks: `EmployeeSelfService.jsx:120-128`) | Self Service, My Dashboard | Same personal summary | **REMOVE** the tab; Self Service = requests only |
| D-07 | Biometric devices / import on Gate Pass & Visitors **and** Attendance Settings → Devices | BiometricAccess, AttendanceSettings | Attendance infrastructure | **RELOCATE** to Attendance |
| D-08 | 7 alias mounts with **0 callers**: `/hr/succession`, `/succession/succession`, `/payroll/salary-structures`, `/salary-structures/salary-structures`, `/payroll` (self-service router under payroll field rules), `/employees/self-service`, `/self-service/self-service` (`server.js:949-955`) | API | None, extra attack surface | **REMOVE** |
| D-09 | Employee status written by: `PATCH /employees/:id/status`, `PUT /employees/:id`, exit withdraw, F&F pay, Offboarding complete, exit cron, ex-employee fix (`employee.routes.js:157-200`) | Employees, Exit, Probation | One lifecycle field | **REWORK**: one transition function with an allowed-transition table (F-13) |
| D-10 | Probation outcome in two vocabularies: `probation_notifications.decision` (free text) and `probation_reviews.recommendation` (`confirm/extend/not_confirm`) | Probation | Same decision | **MERGE**: head recommends (review), HR decides (one decision record) |
| D-11 | Assets in 3 tables (`employee_asset_allocations`, `fixed_assets`, `assets_register`), matched only by serial in a read-only union (`assets.routes.js:1-20`) | Employee Records, Assets, Maintenance | Different facets of one physical asset | **RETAIN WITH IMPROVEMENTS**: allocation carries an optional `fixed_asset_id` |
| D-12 | IT declaration and bank approvals have their own pages but are absent from the Approval Center | Approvals | The inbox is meant to be the one place to act (§ approvals inbox) | **RETAIN** the pages; **ADD** as Approval Center sources (F-36) |
| D-13 | Same as D-10 (cross-reference kept for the page section) | — | — | — |
| D-14 | Exit **creation** in 3 handlers: `POST /exit/requests`, `POST /exit/initiate`, `POST /employees/:id/offboard` | Exit, Employee Profile | Same record | **MERGE** into one create endpoint with a unique open-exit guard |

**Checked and *not* duplicates (KEEP).**
- Employee Documents vs Document Vault: same table, HR register vs own vault (§207).
- Policies vs HR Documents: Policies needs acknowledgement; HR Documents are plain forms.
- `talent_pools` (candidates) vs `employee_talent_pools` (succession): different populations. Renaming would make this clearer (P3).

---

## 6. Missing Functionality Register

Only functions within the current ERP scope are listed. The state column says whether the function is missing, partial, disconnected or done.

| Capability | State | Evidence / note | Priority |
|---|---|---|---|
| Confirmation workflow (decision → employee record, letter) | **Disconnected** | F-11 | P1 |
| Probation dates on every new hire | **Partial** | F-12 (13 of 14 missing; recruitment path sets none) | P1 |
| Employee-initiated resignation + manager acceptance | **Missing** | F-17 | P1 |
| F&F with final salary, loans, claims, assets, Finance posting | **Partial / wrong** | F-01 to F-05 | P0 |
| Relieving / experience letter on exit close | **Missing** | No generator in exit routes | P2 |
| Access removal on exit | **Partial** (manual tick only) | F-06 | P0 |
| Onboarding queue for HR (who is still onboarding) | **Missing UI** | `GET /onboarding/pending` has no caller | P2 |
| Employment history (transfers, promotions, designation changes) | **Not verified** | Salary revisions exist; no designation/department history table was found in the HR pages | P2 (verify) |
| Employee bank change request with proof | **Missing** | F-20 | P1 |
| Declaration window + proof phase + per-employee regime | **Missing** | F-23 | P1 |
| Document upload from Self Service (real file) | **Partial** | F-24 (backend ready) | P1 |
| "My assets" for employees | **Missing** | F-19 | P2 |
| Gate pass request by the employee; security gate role | **Missing** | F-31 | P2 |
| Intern stipend payout | **Missing** | F-22 | P2 |
| Policy re-acknowledgement on a new version | **Missing** | F-33 | P2 |
| Lifecycle and cost KPIs in Workforce Analytics | **Partial** | F-32 | P2 |
| HR items in the Approval Center (IT declarations, bank change, resignation, F&F) | **Missing** | F-36 | P2 |
| Announcement branch targeting / attachments | **Missing** | F-29 | P3 |
| Already correct | **Done** | Intern lifecycle and conversion; announcement visibility and notify; bank maker-checker approval; succession security; gate pass approver chain; asset-based exit blocker; payroll release gate | — |

---

## 7. UI Simplification Register

| Page | Retain | Remove | Merge | Relocate | Redesign |
|---|---|---|---|---|---|
| Internships | Cards, register, reports, templates | Hero *View Employees →* | — | — | Add pagination, sort, export; permission-aware buttons |
| Payroll Center | 6 sections | — | — | — | "Leavers this period" panel in Processing |
| IT Declaration Review | Review flow, history | — | Into the Approval Center as a source as well | — | Employee search, section filter, partial approve; pulse classes instead of inline styles |
| Bank Detail Approvals | Flow | — | Approval Center source | — | Employee search |
| Announcements | Drawer, tabs, pin/toggle | — | — | — | Department and category from masters |
| Workforce Analytics | Composition, attrition, exports | — | — | — | Lifecycle and cost bands |
| My Dashboard | All cards | — | — | — | Fix payslip / announcement targets (F-18) |
| Self Service | Declarations, Vault, Claims, Profile | **Dashboard tab**, clock-in (D-05, D-06) | — | — | Real file inputs; add Bank change, Assets, Resignation, Gate pass |
| Employee Records | 4 tabs | — | — | — | Asset tab read-only "My assets" for employees |
| Probation | Due list, reviews, settings | Free-text decision without effect | Two decision vocabularies (D-10) | — | Due list → Reviews → HR Decision → History |
| Exit Management | Exits, interviews, F&F | — | Offboarding checklist into clearance (D-02); the Profile and Ex-Employees editors (D-01) | — | One state-machine stepper per exit |
| Succession | 6 tabs | — | — | — | Hide Settings for view-only |
| Gate Pass & Visitors | Gate passes, visitors | — | — | **Attendance Import → Attendance** (D-07) | Two-tab page; security desk view |

---

## 8. Technical Issues Register

Severity uses the plan's P0–P3. "Measured" = confirmed against live dev data; otherwise the finding is proven from the code path.

### P0: financial, security, data integrity

**F-01 · F&F leave encashment is always ₹0.**
- **Code.** `fnf.service.js:52-63` selects `SUM(balance) … WHERE leave_type ILIKE '%earned%'`.
- **Schema.** `leave_balances` has no `balance` and no `leave_type` column. Its columns are `leave_type_id`, `allocated_days`, `used_days`, `encashed_days`, `carried_forward_days`, `opening_balance` and `year` (measured, `information_schema`).
- **Effect.** The query throws, `catch (_) { leaveBalance = 0; }` swallows it, and every F&F shows 0 days.
- **Also.** Even with the right columns, the query has no year filter, so it would add up every year's balance.

**F-02 · Notice-period recovery is measured against today.**
- **Code.** `fnf.service.js:45`: `servedDays = min(NP, max(0, round((LWD − now)/day) + NP))`.
- **Effect.** When the LWD is in the past, the shortfall equals the days elapsed since the LWD. The recovery therefore grows by one day's basic for every day the F&F is computed late, and a genuine short notice is never computed at all.
- **Root cause.** `exit_requests` has **no resignation or acceptance date** column, so the true shortfall cannot be computed.
- **Live.** Exit #1 holds `net_payable = −69,230.70`.

**F-03 · F&F leaves out amounts and uses a different salary source from payroll.**
- **Salary source.** It uses `employees.basic_salary` (`fnf.service.js:37`), which the payroll audit says is not a payroll source (payroll pays from salary revisions).
- **Left out.** Final-month salary, outstanding `payroll_loans` and advances, unpaid `expense_claims`, and the value of unreturned assets.
- **Fabricated figure.** `pfBalance = basic × 0.24 × months` (`:72`) is an invented PF balance, and a TDS figure is derived from it. The PF corpus is held by EPFO, not by the employer.
- **Not configurable.** The day rate is fixed at /26, and the gratuity threshold is 5 complete years (`:66-69`). Neither can be changed in policy settings.

**F-04 · Leavers are excluded from their final month's payroll.**
- **Code.** `exitStatusSync.cron.js:36-55` sets `status = 'Left'` on the LWD but does **not** set `exit_date`. Payroll eligibility E2 requires status Active, Probation or Notice (`payrollEligibility.js:37,51`).
- **Effect.** Payroll for a leaver's month, generated after the LWD, excludes them outright, although `prorationFor()` could prorate on `exit_date` (`payrollEngine.js:186-195`). F&F does not include the final salary either (F-03), so it is paid nowhere.
- **Verification.** Proven from the code path. No live leaver month was available to observe.

**F-05 · F&F has no segregation of duties and no accounting.**
- **Code.** Compute, approve and pay all sit behind `requireHRWrite` (`exit.routes.js:32-37, 591-718`), the same role set throughout.
- **Effect.** "Pay" sets `fnf_status='paid'` and closes the exit. No journal is posted, no payment or bank reference is recorded, and Finance is never involved.

**F-06 · Exited employees keep working logins.**
- **Code.** A login is disabled only when HR ticks `access_revoked` in clearance (`exit.routes.js:791`). The cron, Offboarding complete and F&F pay never touch `users.is_active`, and auth checks only `users.is_active` (`auth.service.js:150,199`; `auth.middleware.js:67`).
- **Measured.** EMP010 (resigned, user 873), EMP011 (Left, 878), EMP014 (Left, 886) and EMP034 (Left, 907) all have **`is_active = true`**.
- **Caution.** These may be QA artefacts. Decide per account; do not bulk-disable.

**F-07 · Policy acknowledgements can be forged and are stored under the wrong identifier.**
- **Body-supplied identity.** `POST /hr/policies/:id/acknowledge` takes `employee_id` from the request body (`hr.routes.js:341-345`), so any signed-in user can acknowledge a policy on someone else's behalf.
- **Wrong id type.** The fallback is `req.user.userId`, a `users.id`. The UI sends `user?.id || user?.employee_id` (`Policies.jsx:105, 324`), so normally a `users.id` too. `my-acknowledgements` reads by `users.id` (`hr.routes.js:186-188`), while the register joins `employees.id` (`:360-366`). Because the two id ranges overlap (users 1–50,019; employees 1–50,836), real acknowledgements are attributed to whichever employee happens to have that numeric id.
- **No tenant check.** There is no check that the policy belongs to the caller's company.
- **No tests** cover this route.

**F-08 · Offboarding "Complete" finalises an exit without clearance or F&F.**
- **Code.** `hr.routes.js:968-1032` closes the open exit request and sets the employee to the exit status. It never consults the clearance blockers that F&F pay enforces (`exit.routes.js:670-680`).

**F-09 · TDS consumes declarations incorrectly.**
- **Unreviewed rows count.** `payroll.service.js:167-170` sums `status IN ('approved','submitted')`, so HR review does not gate tax.
- **Vocabulary mismatch.** Only `80d`, `80ccd` and `lta` are read (`:214-216`), while Self Service offers `80C/80D/HRA/LTA/other` (`EmployeeSelfService.jsx:571`). Declared 80C investments beyond employee PF, HRA and "other" never reduce TDS (`payrollEngine.js:375-391`; HRA exemption is explicitly not computed). NPS (80CCD) is read but cannot be declared.
- **Silent failure.** `.catch(() => empty)` turns a query failure into "no declarations", which means higher TDS with no error.

**F-10 · Null-company scope still fails open in HR-adjacent routes.**
- **Where.** `($n::int IS NULL OR company_id = $n)` appears in:
  - `employee-assets.routes.js:37,47` (via `companyOf`);
  - `assets.routes.js:25,34-47,111-119` (`req.scope?.company_id ?? null`, "NULL = all");
  - `PATCH /employees/:id/status` (`employee.routes.js:~483`);
  - `GET /hr/policies/acknowledgement-counts` (`hr.routes.js:203-211`, also counts `company_id IS NULL` policies);
  - onboarding `employeeInScope` (null = global, `onboarding.routes.js:21-28`).
- **Contradiction.** This goes against the §180 rule that a null company is not a global scope.
- **Severity.** P1 rather than P0 until someone measures which live logins resolve to a null company.

### P1: workflow and integration

| ID | Issue | Evidence |
|---|---|---|
| F-11 | Probation decision does not update the employee; vocabulary drift | `probation.service.js:275-309`; `Probation.jsx:195,294,820-824`; measured 9 decisions, 0 confirmations |
| F-12 | 13/14 Probation employees have no `probation_end_date`. `hireCandidate` inserts `status='Active'`, `joining_date=CURRENT_DATE` and no probation fields, bypassing `employee.service` | measured; `recruitment.repository.js:2028-2036` |
| F-13 | `PATCH /employees/:id/status` allows any transition (e.g. Left → Active, which bypasses withdraw and its login rules); `confirmation_date` uses the UTC "today" (`toISOString`), a day behind IST from 00:00 to 05:30 | `employee.routes.js:453-490` |
| F-14 | No "one open exit per employee" constraint; no CHECK on `exit_requests.status/separation_type/fnf_status`; `exit_requests` has no `company_id` | measured: open exits on Active employees 35 and 45; Left employee 11 with an active exit; vocabulary `resignation/Standard/General/Primary`, `fnf_status='active'` |
| F-15 | Clearance: one HR `PUT` records Finance and Manager NOCs under the HR actor's id; `exit_clearance` is UNIQUE per **employee**, not per exit (a second exit reuses the old row); the UI swallows save errors | `exit.routes.js:744-790`; `exit_clearance_employee_id_key`; `ExitManagement.jsx:178` |
| F-16 | Exit and onboarding gates read the single `req.user.role` while roles are many-to-many (`allowRoles` elsewhere uses `rolesOf`). A user with HR as a secondary role is refused | `exit.routes.js:23-37`; `onboarding.routes.js:36` |
| F-17 | No employee resignation, no manager acceptance, no resignation date, no exit source in the Approval Center | grep: no resign path in self-service; `exit_requests` columns |
| F-18 | Employees cannot open My Payslip (Finance section not in their allowlist); My Dashboard's announcements "View All" opens the HR admin page | `menuCatalog.js:401-405`; `EmployeeDashboard.jsx:467,803,914,1104` |
| F-19 | Asset Management tab shown to employees but its API needs `assets:view`; there is no "My assets" anywhere | `menuCatalog.js` `EMPLOYEE_SELF_SERVICE_PAGES`; `employee-assets.routes.js:56` |
| F-20 | Payroll and payment ignore `bank_verified_at` (format check only); employees have no bank change request path | `payrollEligibility.js:101-103`; `grep bank_verified_at` (payroll/finance: none) |
| F-21 | Visitor `id_number` (may be Aadhaar) returned unmasked to every `hr:view` holder | `biometric.routes.js:1501` |
| F-22 | HR → Finance: F&F not posted; intern stipends have no payment path; payroll journal never posted live and loan GL mapping absent | §4 row 17 |
| F-23 | Declaration inputs: free-text type and FY (`selfservice.routes.js:88-90`), URL "proof" (`EmployeeSelfService.jsx:586`), fixed 30% saving (`:559`), no window or lock; all 5 live rows are unusable seed rows | measured |
| F-24 | Self Service document "upload" sends a URL; the backend multipart path is unused | `EmployeeSelfService.jsx:655`; `selfservice.routes.js:337` |

### P2: technical debt and operational

| ID | Issue | Evidence |
|---|---|---|
| F-25 | 7 dead alias mounts (D-08), including the whole self-service router re-exposed under `/payroll` with payroll field rules | `server.js:949-955` |
| F-26 | Dead tables `onboarding_records`, `onboarding_tasks` (D-04) | seed-only references |
| F-27 | Import-time DDL (`pool.query('ALTER/CREATE TABLE …')` at module load): `hr.routes.js` 18 statements (`:12`, `:40`), `biometric.routes.js` 6 (`:407-412`), `announcement.service.js` 4. This is the same class that caused the §223 lock contention | grep |
| F-28 | Hub child pages without NAV rows (Payroll ×6, Succession ×6), so the section allowlist never applies to their URLs; module gates are the only control | `routes.jsx` nav-row count |
| F-29 | Announcement departments from loaded employees, categories hardcoded, no branch, designation or role targeting | `Announcements.jsx:23,280-288`; `announcement.visibility.js:41-44` |
| F-30 | Internships: no pagination, sort or export; Add/Edit not permission-aware in the UI; no Recruitment → intern link | `Internships.jsx:141,281`; `internships.routes.js:497-505` |
| F-31 | Gate Pass page defaults to Attendance Import; employees cannot request passes (`hr:add`); no security role | `BiometricAccess.jsx:34,108`; `biometric.routes.js:1302` |
| F-32 | Workforce Analytics limited to master data | `EmployeeReports.jsx:46-96,354-361` |
| F-33 | A policy version change does not require re-acknowledgement (`ON CONFLICT (policy_id, employee_id)`) | `hr.routes.js:349-351` |
| F-34 | Missing FKs to `employees`: `it_declarations`, `employee_documents`, `hr_policy_acknowledgements`, `gate_passes`, `visitors.host_employee_id` (1 orphan each measured in declarations and documents). Missing CHECKs: `it_declarations.status`, `exit_requests.*`, `probation_notifications.decision` | measured `information_schema` / `pg_constraint` |
| F-35 | No tests for `computeFnf`, the policy acknowledge route, or probation decision effects | `__tests__` grep |
| F-36 | Approval Center lacks IT declaration, bank change, resignation and F&F sources (it has leave, reg, ot, exp, adv, gate, ieval, prob, offer, requisition, pay, travel) | `approvals.sources.js` |

### P3: UI and usability

| ID | Issue |
|---|---|
| F-37 | ITDeclarationReview, BankChangeApprovals and Self Service are styled with inline `style={{}}` instead of the `.pulse-*` classes (CLAUDE.md conventions) |
| F-38 | The Succession Settings tab is visible to view-only holders |
| F-39 | IT/Bank review pages lack employee search and export |
| F-40 | `talent_pools` vs `employee_talent_pools` naming is ambiguous |

---

## 9. Recommended Final HR Architecture

```
HR
├─ Workforce
│   ├─ Workforce Analytics & Reports    (+ lifecycle and cost bands)
│   └─ Internships                       (unchanged; + stipend payout → Finance)
├─ Lifecycle                             (one record per stage, each writes the employee via ONE transition function)
│   ├─ Onboarding           NEW row → existing /onboarding/pending queue + checklist (moved out of Profile-only)
│   ├─ Probation Management Due → Reviews → HR Decision (writes status / dates / letter) → History
│   └─ Exit Management      Request → Acceptance → Notice → Clearance (ONE templated checklist per exit)
│                           → Interview → F&F (HR prepares, Finance approves and posts) → Close (status, exit_date,
│                           login off, relieving letter)
├─ Payroll & Compliance
│   ├─ Payroll Center       (6 sections; "Leavers this period")
│   ├─ IT Declaration Review(approved-only feeds TDS; FY lock; proof phase)
│   └─ Bank Detail Approvals(enforcement flag on payment)
├─ Records & Communication
│   ├─ Employee Records     Documents · Assets · Policies (versioned re-ack) · HR Documents
│   └─ Announcements
├─ Talent
│   └─ Succession Center    (unchanged)
├─ Security & Access
│   └─ Gate & Visitors      Gate Passes · Visitors      (Attendance Import → Attendance menu)
└─ Self Service (personal)
    ├─ My Dashboard         the single personal summary (clock-in lives here)
    └─ Self Service         Requests: Declarations · Documents (file upload) · Claims · Profile & Bank change
                            · My Assets · Gate pass · Resignation
```

**Placement principles**
- **One writer per record.** Exit Management owns `exit_requests` and clearance. Employee Profile and Ex-Employees only read them.
- **One status transition function** with an allowed-transition table. Every lifecycle page calls it. No direct `UPDATE employees SET status`.
- **Every approval is visible in the Approval Center.** Specialist pages stay as the detailed workspace.
- **Every hire goes through `POST /employees`**, whether from an intern, a candidate or a manual entry, so probation dates, mandatory fields and logins are set consistently.

---

## 10. Prioritised Action Plan

**Every item needs approval before work starts. Items marked ⚑ involve a business or policy decision.**

### P0: do first
1. **F-01, F-02, F-03 · Rebuild F&F as one service.**
   - Earned-leave balance comes from `leave_balances` columns, by type and year.
   - ⚑ Add a resignation/acceptance date column, and compute the notice shortfall from it.
   - One salary source, the payroll revision.
   - Include final-month salary, loan and advance recovery, pending claims and asset recovery.
   - Remove the fabricated PF figure.
   - ⚑ Day-rate and gratuity rules move into policy settings.
   - Add tests.
2. **F-04 · Make payroll eligibility E2 date-based.** A leaver is payable through `exit_date`. The cron writes `exit_date` with the status. Add a "Leavers this period" check.
3. **F-05 · Separate F&F duties.** HR prepares, Finance approves and pays. Posting a journal and recording the payment reference are required to reach `paid`.
4. **F-06 · Disable the login on any finalisation path.** ⚑ Review the 4 measured accounts individually.
5. **F-07 · Fix policy acknowledgement.** Identity comes from `employeeOf(req)` only, plus a same-company check on the policy. ⚑ Decide what to do with existing acknowledgement rows (ambiguous ids).
6. **F-08 · Gate Offboarding Complete on the same clearance and F&F conditions as F&F pay**, or remove it once D-02 lands.
7. **F-09 · Fix declarations in TDS.** Read approved amounts only. One section vocabulary shared by Self Service and the engine (80C, 80D, 80CCD(1B), HRA with rent, LTA, other). Fail loudly on a query error. ⚑ Decide the provisional-vs-proof policy for months before proofs are approved.

### P1: essential workflow and integration
8. **F-11, D-10 · Make the probation HR decision write the employee record.** Confirm, Extend or Not-confirm writes the employee row and audit, and generates a letter. One decision vocabulary.
9. **F-12 · Route `hireCandidate` through the employee service.** ⚑ Backfill probation end dates for the 13 employees, with HR supplying the dates.
10. **F-13, D-09 · One status transition function** with an allowed-transition table.
11. **F-14, D-01, D-02, D-03, D-14 · One exit state machine.** Unique open exit per employee, CHECK vocabularies, clearance per exit request. ⚑ Resolve the 3 inconsistent live exits (ids 16, 17, 18).
12. **F-15 · Department-signed NOCs** and visible save errors.
13. **F-16 · Multi-role gates** in exit and onboarding.
14. **F-17 · Employee resignation** in Self Service, plus manager acceptance and an Approval Center source.
15. **F-18 · Fix the personal-page links.** ⚑ Decide how employees reach My Payslip (move it to the HR self-service group, or add PayslipViewer to the personal pages).
16. **F-19 · Read-only My Assets** for employees.
17. **F-20 · Employee bank change request with proof.** ⚑ Enforcement flag that blocks unverified accounts from payment.
18. **F-21 · Mask visitor ID numbers** except for an explicit permission.
19. **F-10 · Close the null-company fail-open** in the asset, status, policy-count and onboarding paths, after measuring which logins are affected.
20. **F-22 · Finance hand-offs** for F&F and stipends (journal + payable). ⚑ Finance to provide the GL mappings.
21. **F-23, F-24 · Self Service inputs.** Real file uploads, validated type and FY, ⚑ declaration window.

### P2: missing functionality and operations
- F-25 / D-08: remove the dead alias mounts.
- F-26 / D-04: drop the dead onboarding tables (after confirmation).
- F-27: move import-time DDL into migrations.
- F-28: give hub child pages NAV rows.
- Onboarding row and queue.
- F-29: announcement masters and branch targeting.
- F-30: Internships pagination and export.
- F-31 / D-07: Gate page scope; employee gate pass request.
- F-32: Workforce Analytics bands.
- F-33: policy re-acknowledgement on version change.
- F-34: FKs and CHECKs, each with a pre-check for violating rows.
- F-35: tests.
- F-36: Approval Center sources.
- Relieving letter.

### P3: UI and usability
- F-37: move inline styles to `.pulse-*` classes.
- F-38: hide Succession Settings for view-only holders.
- F-39: search and export on the review pages.
- F-40: pool naming.
- Remove the Internships hero shortcut.
- D-05 / D-06: remove the Self Service Dashboard tab.

---

*Architecture Impact: ✅ None. This audit changed no code, routes, tables or workflows, so `MODULE_FEATURE_CONNECTION_MANUAL.md` was not edited. Once the P0/P1 items are approved and built, the Employee Lifecycle and Exit sections of the manual will need updating.*
