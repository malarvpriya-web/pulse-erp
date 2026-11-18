# HR Module: Page-by-Page Audit (2026-11-16)

**Status: audited, then fixed the same day on the owner's instruction ("fix").** Nothing is committed. Every finding below carries its status: **Fixed**, **Open**, or **Needs you**.

**How it was checked:**
- **Live API:** about 110 HR endpoints were called on the running backend with real tokens for three logins: HR (`hr@manifest.in`), super admin, and an employee (EMP002).
- **Database:** the dev database `Pulse` was read through a read-only session.
- **Code:** every page in the HR and Employees menus was read.
- **Baseline:** the 11-12 check (`HR_PRODUCTION_READINESS_CHECK_2026-11-12.md`) and its §274–§276 fixes.

> **Before testing in the browser:** restart the dev backend on :5000. It was started before these changes and still runs the old code. Stopping it from this session was blocked.

## 1. Verdict

- **Before the fixes:** the code worked, with no 500s and every page on live data, but junk data showed on screen, there were seven bugs, and several inputs and steps were missing.
- **The fixes:**
  - All seven bugs are fixed, plus six more found while fixing (§3).
  - Every input and step on the owner's list is in place (§4, §5).
  - The junk data on the owner's list is deleted, with a backup (§6).
- **Biggest find during the fixes:** no F&F settlement could be approved from the screens at all (§3, N1). That's now fixed.

**What still stops a go-live is data only you can supply:**
- The real company bank account and its ledger link.
- The company TAN.
- The real bank, PF, UAN, PAN and DOB of EMP001–003.

The remaining open items are listed in §7.

### Corrections to the 11-12 report

- **The 769 leave rows are not displayed.** They sit in `leave_requests`, a frozen legacy table. The Leave pages, payroll and the dashboards read `leave_applications`, which has 5 rows.
- **Workforce Analytics does not use leave data.** Its numbers are correct for the 3 employees.
- **HR Documents never held the 15 documents.** They are in `company_documents`, which the HR Documents tab does not read. The tab reads `hr_downloads`, which was empty.
- **Clearance:** since §274 a new exit already starts with a fresh clearance. B7 was the earlier exit's record being overwritten, not ticks carrying over.

## 2. Page by page (status now)

Legend: ✔ fine · ⚠ open · **Fixed** = changed today

### Employees menu

| Page | Status | Notes |
|---|---|---|
| **Dashboard** | ⚠ Open | The data-quality card says "0 records need attention" while Payroll blocks EMP001/002 for bank, IFSC and PAN errors. It checks that a field is filled, not that it is valid (`employee.service.js` dataQuality). Not on the fix list. |
| **All Employees** | **Fixed** | Biometric device user ID and default shift are now on Add/Edit Employee: validated, unique per company, shift must belong to the company. ⚠ The Terminate dialog still has its own 6-reason list (`EmployeesData.jsx:400`). ⚠ Sub-department is still in Org Setup only. |
| **Ex-Employees** | **Fixed** (B1) | Deleted records no longer listed (32 test rows gone from the list). |
| **Background Verification** | **Fixed** | Test agency "Test" deleted. Its one check, on a deleted test employee, was detached. |

### HR menu

| Page | Status | Notes |
|---|---|---|
| **Internships** | **Fixed** | New **Stipends** tab: HR raises a month's stipends (pro-rated, by frequency), can correct one with a reason or cancel it. Finance records the payment (UTR, value date, bank account), never the person who raised it. Intern form has bank details. Test intern "test tet" deleted. ⚠ No accounting journal is posted for a stipend; Finance books it in Accounting. ⚠ The View Intern "Attendance" placeholder card is still there. |
| **Payroll Center** | ✔ | Live; the release check shows the real blockers (October draft, attendance sync, EMP001/002 bank/PAN, no TAN). Needs your data. |
| **Announcements** | **Fixed** | Categories are now an editable master list (Settings → Master Data, or "+ Add new…" in the picker). **HR can archive and restore** (hr, hr_manager, hr_exec; decision of 17 Nov, migration `20261116000011`). ⚠ Targeting is still all / department / one employee. |
| **Workforce Analytics & Reports** | ✔ | Correct; flags EMP003's DOB. |
| **My Dashboard** | **Fixed** | New cards: **Assets Issued to You** (the actual list, not a count) and **Company Forms & Documents** (HR Documents with the "all staff" audience). |
| **My Details** | ⚠ Needs you | Shows the placeholder bank and statutory values of EMP001–003. |
| **My Gate Passes** | ✔ | Ready. |
| **Employee Records → Asset Management** | **Fixed** | Test asset "a/a/a" deleted. |
| **Employee Records → Policies** | **Fixed** (B6) | A new version asks again. "Send reminder" now notifies those who haven't accepted the current version, in your company only; it used to send nothing and count every company. Test/SEED policies deleted. |
| **Employee Records → HR Documents** | **Fixed** | Categories editable (master list). Staff can read "all" documents (on My Dashboard), managers also "managers" ones; writing is still HR only. ⚠ File type stays a fixed list (it's a file format, detected from the link). ⚠ Two document stores remain (`hr_downloads`, `company_documents`). |
| **Department Heads** | ✔ | Real data. |
| **Probation Management** | **Fixed** (B5) | A failed load says what failed, with Try again. 47 stale reminders for EMP003 deleted. |
| **Exit Management → Exits & Settlement** | **Fixed** (B3, B4, N1–N3); the Clearance Tracker tab moved into the Exit Checklist | <ul><li>Interview analytics count only real exits.</li><li>Access is the matrix.</li><li>F&F has a **Review** page (approve or record payment without recomputing).</li><li>**F&F** is in the Approval Center.</li><li>The "F&F" button no longer silently recomputes an approved settlement.</li></ul> ⚠ Payment still needs a real company bank account. |
| **Exit Management → Exit Checklist** (was Offboarding Checklist) | **Merged** (decision of 17 Nov); **Fixed** (B1, B2, N4, N5) | **One checklist per leaver:** <ul><li>**Automatic checks:** assets returned, advances settled, logins disabled.</li><li>**Sign-offs:** HR, Finance, reporting manager.</li><li>**Your company's items:** owner, due date, notes, Notify.</li></ul> The F&F cannot be paid until all three are done. Paying it closes the exit and moves the person to Ex-Employees, so "Mark complete" is gone. A new exit archives the previous one's checklist. The page shows only the items saved on the server (no hidden built-in list). "Reset to defaults" offers a starter list without the automatic checks. The checklist is empty today: HR must add the real items. |
| **Succession Center** | **Fixed** | Talent pool types are an editable master list. |
| **Gate Pass & Visitors** | ✔ | Ready. |

## 3. Bugs

| # | Bug | Status |
|---|---|---|
| B1 | Ex-Employees and the Offboarding list showed deleted employees | **Fixed**: `deleted_at IS NULL` in both queries |
| B2 | Offboarding checklist shared by every company; one company's save replaced all | **Fixed**: migration `20261116000003` adds `company_id`. Existing rows become a shared default a company uses until it saves its own. The per-employee checklist read/write also checks the company now (it took any id). |
| B3 | Exit interview analytics built from seed rows and people who never left | **Fixed**: only interviews tied to that employee's own live exit count. Recording one needs an exit (409 `NO_EXIT`). FK on `employee_id` (migration `20261116000004`, NOT VALID). |
| B4 | Exit access from role lists in code, one role only | **Fixed**: new matrix modules `exit` (view / edit) and `fnf` (Finance's F&F read), migration `20261116000005`, seeded to today's access. They show in Roles Setup, and every role a user holds counts. Onboarding's checks and HR Documents' audience check now count all roles too. |
| B5 | Probation load failure looked like "no one on probation" | **Fixed** |
| B6 | New policy version kept old acknowledgements | **Fixed**: migration `20261116000006`. Each acknowledgement records its version; only the current version counts (Policies, Home, counts). Every version's acknowledgement is kept. |
| B7 | A new exit overwrote the previous exit's clearance | **Fixed**: migration `20261116000007` adds `exit_clearance_history`. The old clearance is kept, linked to its exit. `GET /exit/clearance/:id/history`. The probation "do not confirm" exit now starts a fresh clearance like the other paths. F-34: FKs added on policy acknowledgements and employee documents (NOT VALID). |

**Found and fixed while fixing:**

| # | Bug | Status |
|---|---|---|
| N1 | **No F&F could be approved from the UI.** Every way of viewing a settlement recomputed it, which recorded the viewer as its computer, so the approve step then refused them (SELF_APPROVAL). Finance roles could not open Exit Management at all. | **Fixed**: read-only `GET /exit/fnf/review/:exit` and a **Settlement Review** page (fnf:view) showing the saved version, who computed and approved it, clearance blockers, and Approve / Record payment only when the server allows, with the reason when not |
| N2 | The "F&F" button recomputed an approved settlement just to look at it, silently cancelling the approval | **Fixed**: disabled once approved; **Review** opens the saved version |
| N3 | `GET /exit/clearance/:id`, `/status` and `/exit/employee/:id` read another company's employee by id | **Fixed**: company-scoped (404) |
| N4 | Offboarding **Notify** answered "Notification queued" and sent nothing | **Fixed** |
| N5 | Policy **Send reminder** sent nothing and counted every company's employees | **Fixed** |
| N6 | HR Documents audience used one role only (hr_manager saw only "all" documents) | **Fixed** |

## 4. Inputs that couldn't be set

| Input | Status |
|---|---|
| Biometric device user ID | **Fixed**: Add/Edit Employee |
| Default shift | **Fixed**: Add/Edit Employee (shifts from Attendance → Shifts) |
| Announcement categories, HR Document categories, succession pool types | **Fixed**: master lists, migration `20261116000008` (seeded with the old values; pool types are stored by name now, and the old CHECK was dropped) |
| Offboarding assignees | **Fixed**: your departments + Reporting manager |
| Sub-department | ⚠ Open: Org Setup only |
| HR Document file type | Kept fixed on purpose (a file format) |

## 5. Missing steps

| Step | Status |
|---|---|
| F&F in the Approval Center | **Fixed**: type `fnf`, two stages (Finance approval → Payment), never one's own, never the computer or the approver. Opens Settlement Review. Off while `HR_CONTAINMENT_FNF` is on. |
| Employees see their assets | **Fixed**: My Dashboard |
| Employees open HR Documents | **Fixed**: My Dashboard → Company Forms (the Employee Records hub stays HR-only, per your 11-11 instruction) |
| Intern stipend payment | **Fixed**: Internships → Stipends; Finance page `InternStipends`; Approval Center type `stip`; migration `20261116000009` |
| HR logins linked to employees | **Needs you.** User Management already links a login to an employee (since 11-10). `hr@manifest.in` is one of the three admin logins kept without an employee on purpose, and the 22 `pilot.*` logins are role-test logins with no employee to link. Nothing was changed; tell me which real HR person each HR login belongs to, or which test logins to deactivate. |
| One store for company documents | ⚠ Open |

## 6. Junk data

**Deleted 16 Nov** (backup `_backups/hr_junk_cleanup_2026-11-16T15-36-43-385Z.json`, sha256 `c1406c93…c1be`, audit 190300–190308):

| Data | Rows |
|---|---|
| Policies "test" + "SEED Hr Policies 9/10/11" | 4 (+ 5 acknowledgements) |
| Offboarding checklist "SEED item label…" | 5 (+ 5 progress rows) |
| Employee documents "SEED Employee Documents 1–5" | 5 |
| Intern "test tet" | 1 |
| Asset "a / a / a" | 1 |
| BGV agency "Test" | 1 (its one check, on deleted test employee 46, detached) |
| Probation reminders for EMP003 (closed, no decision) | 47 |

**Still there (not on the list you approved):**
- 32 deleted test employees (no longer shown anywhere).
- 7 seed exit interviews (no longer counted).
- 2 notes on EMP001.
- The hidden "TEST" announcement.
- `leave_requests` (769, not shown).
- The `onboarding_records` / `onboarding_tasks` tables (F-26).
- Shifts "QA General 0930" and "SEED Hr Shifts 9–11".
- Logins: 22 `pilot.*` and 6 test-tenant admins.

**Needs you:**
- EMP001–003 bank, PF, UAN, PAN and DOB.
- The company bank account and its ledger link.
- The TAN.

## 7. Still open

1. Employees Dashboard data-quality card checks presence, not validity.
2. Announcement targeting (branch, designation, role); archive is admin-only.
3. Two company-document stores.
4. Sub-department editable only in Org Setup.
5. Terminate dialog's own reason list; View Intern "Attendance" placeholder.
6. F-25 (4 duplicate route mounts in `server.js`), F-26 (unused onboarding tables).
7. Stipend payments post no accounting journal.
8. Clearance history has an API but no screen yet.
9. A checksum warning on `20261116000001_rd_improvement_inputs.js` (edited after it was applied; from the R&D work, not HR).

### Decisions

- **Done 17 Nov:** HR may archive announcements; the two exit checklists are merged into one.
- **Still needed:** which logins to link or deactivate (§5).

## 8. Verification

- **Migrations** `20261116000003`–`…0011`: applied to dev `Pulse` and the test DB `pulse_e2e`. (`…0010` makes the clearance-history keys cascade; without it, other suites could not delete their test exits.)
- **New tests, all passing:**
  - `hrAuditFixes.integration.test.js` (6) and `hrAuditFixes2.integration.test.js` (11): real routes and database.
  - `probationLoadError.page.test.jsx` (2) and `settlementReview.page.test.jsx` (2).
- **Backend `test:db`** (17 Nov, after the two decisions): 6,420 passed, 1 failed.
  - The failure is `integration.projectCreation` "moving an opportunity to Won". Since the §277 rule, a PATCH to Won returns 400. It is not HR; that test needs updating to the close endpoint.
  - `announcementsSafety` was updated to the new rule (HR archives). `hrC6ExitWorkflow` moved its clearance test to the Exit Checklist.
  - Earlier runs caught three regressions from these changes, all fixed: the clearance-history FKs (now cascade) and an unscoped employee write (now company-scoped).
- **Frontend suite:** 1,758 passed.
