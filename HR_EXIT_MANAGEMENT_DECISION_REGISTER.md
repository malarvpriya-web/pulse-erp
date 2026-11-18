# Employee Exit Management — Decision Register (ED-1 to ED-22)

**Date:** 03 Nov 26 · **Source:** `HR_EMPLOYEE_EXIT_LIFECYCLE_DESIGN.md` §17
**Prepared for:** HR management, Finance management, and the company's legal and tax advisers
**Status:** FOR REVIEW. **No decision in this register has been approved.** The "recommended option" in each entry is a proposal for discussion, not a choice made on management's behalf. Nothing has been implemented, and Phase 1 has not started.

## How to read this register

- **Current behaviour** is what Pulse does today, verified in the code or measured read-only in the dev database this week. Where the containment changes now in the working tree alter the behaviour, that is stated.
- **Legal points marked ⚖** are summaries of the law as generally understood, written so the right questions reach the advisers. **They are not legal or tax advice.** Several areas changed recently and must be confirmed against the current text:
  - the four Labour Codes (the payroll audit records the Code on Social Security wage rules as applying from 21 Nov 2025);
  - the Income-tax Act 2025, which applies to tax year 2026-27;
  - the Digital Personal Data Protection Act 2023 and its Rules.
- **Blocks** names the implementation phase that cannot finish without the decision (phases are defined in the design, §20).
- **"Safe to finalise now"** means no external advice is needed and the decision changes no statutory amount. It does not mean the recommendation is right; that is management's call.

---

## 1. Overview

| ID | Question (short) | Owner | Professional advice | Can finalise now? | Blocks |
|---|---|---|---|---|---|
| ED-1 | Notice periods and how notice is counted | Joint | ⚖ Legal (contracts, standing orders, IR Code) | After legal check | Phase 1 (seeded as unverified), Phase 4 |
| ED-2 | Pay in lieu of notice on termination | Joint | ⚖ Legal | No | Phase 4 |
| ED-3 | Gratuity rules and nominee record | Joint | ⚖ Legal + tax | No | Phase 4 |
| ED-4 | Retirement age; system suggestions | HR | ⚖ Legal (retirement age only) | Suggestions part: yes | Phase 1 (type), Phase 5 |
| ED-5 | Absconding procedure | HR | ⚖ Legal | No | Phase 1 (type), Phase 5 |
| ED-6 | When access is revoked, per exit type | HR (with IT) | None | **Yes** | Phase 2 |
| ED-7 | One exit status `Left` for all types | HR | None | **Yes** | Phase 1 |
| ED-8 | Recover loans, advances, claims, assets via settlement? | Joint | ⚖ Legal (permitted deductions) | No | Phase 3, Phase 4 |
| ED-9 | Off-cycle final salary; payment deadline | Joint | ⚖ Legal | No | Phase 4 |
| ED-10 | Exit interview and letters before closure | HR | None | **Yes** | Phase 3 |
| ED-11 | How ex-employees receive payslips, Form 130 and letters | Joint | None (privacy review optional) | **Yes** | Phase 3 |
| ED-12 | Login check on database error: fail open or closed | HR with IT | None | **Yes** (part) | Phase 2 |
| ED-13 | Leave encashment at exit | Joint | ⚖ Legal (state and central leave law) | No | Phase 4 |
| ED-14 | Tax treatment of settlement components | Finance | ⚖ Tax | No | Phase 4 |
| ED-15 | Settled when paid, or when reconciled | Finance | None | **Yes** | Phase 4 |
| ED-16 | Auto-mark absence while serving notice | Joint | None | **Yes** | Phase 5 |
| ED-17 | Prompt a backfill requisition on acceptance | HR | None | **Yes** | Phase 5 |
| ED-18 | Rehire: continuous or new service | Joint | ⚖ Legal (gratuity continuity) | No | Phase 1 (rehire), Phase 4 |
| ED-19 | Which events are emailed, and to which address | HR | None | **Yes** | Phase 3 |
| ED-20 | Retention of exit documents and interview data | HR | ⚖ Legal (privacy, statutory records) | No | Phase 6 |
| ED-21 | E-signature on exit letters | HR | Optional | **Yes** | Phase 3 (optional) |
| ED-22 | Who holds which exit permissions | Joint | None | **Yes** | Phase 1 |

**Summary:**
- **Safe to finalise now (no external advice):** ED-6, ED-7, ED-10, ED-11, ED-12, ED-15, ED-16, ED-17, ED-19, ED-21, ED-22, and the "suggestions" half of ED-4.
- **Require professional confirmation before finalising:** ED-1, ED-2, ED-3, ED-4 (retirement age), ED-5, ED-8, ED-9, ED-13, ED-14, ED-18, ED-20.

**What Phase 1 needs** (the exit case and the single-writer rule): ED-7 and ED-22 decided; ED-18 decided for rehire. ED-1, ED-4 and ED-5 can start as *unverified* policies, which let cases be recorded but block settlement until confirmed. This is the design's release-gate approach.

---

## 2. HR management decisions

### ED-4 · Retirement age and system suggestions
1. **Question.** What is the retirement age, by employment type if it differs? Should Pulse *suggest* a retirement exit (and a contract-expiry exit) when the date approaches, for HR to confirm?
2. **Current behaviour.**
   - No retirement-age setting and no contract-end-date field exist.
   - `employees.dob` exists. Retirement can only be entered by hand, as an exit of type "retirement".
3. **Recommended option.**
   - Record the retirement age from the company's existing appointment terms or standing orders, as an effective-dated policy.
   - Pulse **suggests** (never starts) a retirement or contract-expiry case 90 days ahead, for HR to confirm.
   - Add `contract_end_date` for fixed-term staff.
4. **Business justification.** Planned exits get notice, clearance and settlement on time. Suggestions keep HR in control and avoid automatic separations.
5. **Impact.**
   - HR: a short queue of suggestions.
   - Employees: earlier communication.
   - Payroll: final runs planned in advance.
   - Succession: earlier vacancy signal.
   - Data entry: contract end dates for existing fixed-term staff.
6. **⚖ Legal.** Private-sector retirement age is generally set by contract or standing orders rather than by a single statute. Confirm what the company's documents say, and whether any standing order applies to its workforce.
7. **Professional confirmation.** Legal, for the age only. Suggestions need none.
8. **Dependencies.** ED-19 (who is notified); ED-22 (who confirms).
9. **If delayed.** Retirement and contract expiry remain manual cases (they still work). Phase 5 suggestions wait.

### ED-5 · Absconding procedure
1. **Question.** After how many consecutive days of unauthorised absence should Pulse flag possible absconding? What procedure follows (contact attempts, show-cause notice, enquiry)? Is the settlement held until the procedure ends?
2. **Current behaviour.**
   - "Absconding" exists only as a free-text exit reason; it is recorded as a termination.
   - No absence-based detection exists.
   - EMP014 was set to Left with the reason "Absconding" through Edit Employee, a path now blocked, with no exit record.
3. **Recommended option.**
   - A configurable **N days** (value from the company's standing orders or policy).
   - Pulse **flags** the case to HR; HR records each procedural step.
   - The case is created as type `absconding` with settlement **on hold** until HR releases it.
   - Access is revoked on HR confirmation (see ED-6).
4. **Business justification.** A documented, consistent procedure protects the company if the separation is later disputed, and stops pay running for someone who has stopped attending.
5. **Impact.**
   - HR: procedural steps per case.
   - Payroll: no pay for the absence (depends on ED-16 for unmarked days).
   - Finance: settlement held.
   - Employees: protection against wrongful separation through a recorded process.
6. **⚖ Legal.** Treating absence as abandonment usually requires the procedure in the applicable standing orders or contract, and natural-justice steps (notice to the last known address, opportunity to explain) before the separation is final. Confirm the procedure, the N value, and whether withholding the settlement is permitted, and for how long.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** ED-16 (attendance must mark the absences); ED-6 (access timing); ED-8 (recoveries).
9. **If delayed.** Absconding can be recorded as a type, with manual handling, but no detection. Absence risk continues: unmarked notice-period days are not loss of pay today.

### ED-6 · When access is revoked
1. **Question.** For each exit type, when should Pulse disable the employee's login, sessions, push devices and reset codes?
2. **Current behaviour.**
   - Only when HR ticks "Access revoked" in clearance.
   - 4 exited employees still have active logins.
   - EMP034's account still receives operational alerts daily.
3. **Recommended option.**
   - **Resignation, retirement, contract expiry:** automatically at 00:05 IST on the day **after** the last working day.
   - **Termination, absconding, death:** immediately when HR accepts the case.
   - HR may revoke earlier at any time.
4. **Business justification.**
   - Staff keep access while they are still working and handing over.
   - People separated for cause or by absence lose it at once.
   - Removes the dependence on someone remembering to tick a box.
5. **Impact.**
   - IT: no manual step (biometric device removal stays a clearance task).
   - HR: tasks to reassign approvals, direct reports and alerts.
   - Employees: no self-service after exit; see ED-11.
6. **Legal.** No statute fixes the timing. Information-security and confidentiality obligations favour prompt revocation.
7. **Professional confirmation.** None.
8. **Dependencies.** ED-11 (document access after exit); ED-12 (defence in depth).
9. **If delayed.** Phase 2 cannot start. Exited logins keep working; the C4 accounts await separate HR approval.

### ED-7 · One exit status for every exit type
1. **Question.** Should every completed exit set the employee's status to the single value `Left`, with the exit type recorded on the case?
2. **Current behaviour.**
   - Most paths write `Left`, but the last-working-day job writes `terminated` for terminations.
   - Live data also holds a lowercase `resigned`.
   - Readers already treat all of these as "exited".
3. **Recommended option.** **Yes, `Left` for all.**
   - Existing `resigned`/`terminated` rows are mapped to `Left` in migration.
   - The original value is preserved in the employment history.
4. **Business justification.** One status removes the synonym drift that has caused counting errors before. Reports group by exit type from the case instead.
5. **Impact.**
   - HR: reports by exit type rather than by status.
   - Workforce Analytics: no change in totals.
   - Payroll and attendance: unchanged (they treat all exit statuses alike).
6. **Legal.** None.
7. **Professional confirmation.** None.
8. **Dependencies.** None.
9. **If delayed.** Phase 1 cannot finalise its status rules.

### ED-10 · Exit interview and letters before closure
1. **Question.** Must an exit interview be completed (or formally waived with a reason) before a case can close? Which letters must be issued before closure?
2. **Current behaviour.**
   - Interviews are optional and not linked to completion.
   - Pulse cannot generate relieving or experience letters at all.
3. **Recommended option.**
   - **Interview:** required, or waived with a recorded reason (for example death or absconding).
   - **Relieving letter:** mandatory before closure.
   - **Experience letter:** issued on closure or on request.
   - **No-dues certificate:** generated when clearance completes.
4. **Business justification.** A relieving letter is what the departing employee normally needs for the next employer. A recorded interview (or waiver) gives consistent attrition data.
5. **Impact.**
   - HR: templates to set up once.
   - Employees: documents issued reliably.
   - Analytics: complete exit-reason data.
6. **Legal.** Generally none for the interview. Some states' shop and establishment laws or standing orders require a service certificate on request (confirm locally if relevant).
7. **Professional confirmation.** None (optional local check).
8. **Dependencies.** ED-19 (delivery); ED-21 (signature); ED-20 (retention).
9. **If delayed.** Phase 3 cannot define its closure checks. Departing employees still get no system-generated letters.

### ED-12 · Login check when the database check fails
1. **Question.**
   - (a) Should Pulse refuse a login whose linked employee has left, even if the account was not disabled?
   - (b) If the per-request database check itself fails, should requests from employee-linked logins be refused (fail closed) rather than accepted on the token alone?
2. **Current behaviour.**
   - (a) Not checked.
   - (b) On a database error, the request is accepted on the token alone (`verifyToken` fallback).
3. **Recommended option.**
   - **(a) Yes**, now. It costs nothing in availability.
   - **(b) Decide after measurement.** Log how often the fallback fires for a month, then choose.
4. **Business justification.**
   - (a) closes the gap if a revocation step is ever missed.
   - (b) trades security against the system staying usable during database trouble, so it should be decided on evidence.
5. **Impact.**
   - IT: monitoring for (b).
   - Users: none for (a). Possible lock-outs during database incidents if (b) becomes fail-closed.
6. **Legal.** None.
7. **Professional confirmation.** None (IT owner input).
8. **Dependencies.** ED-6.
9. **If delayed.** (a) delays a safety net in Phase 2. (b) has no immediate effect.

### ED-17 · Backfill requisition prompt
1. **Question.** When an exit is accepted, should Pulse prompt the manager or HR to raise a replacement requisition?
2. **Current behaviour.** No link between exits and recruitment.
3. **Recommended option.** **Prompt only** (a one-click "Raise backfill requisition" on the case). No automatic requisition.
4. **Business justification.** Speeds replacement without creating requisitions for roles that will not be refilled.
5. **Impact.** Recruitment gets earlier demand. No financial effect until a requisition is approved.
6. **Legal.** None.
7. **Professional confirmation.** None.
8. **Dependencies.** ED-22 (who may raise it).
9. **If delayed.** No effect on core exits; Phase 5 item only.

### ED-19 · Notifications and email
1. **Question.** Which exit events are emailed (not only in-app)? Should messages after the last working day go to the employee's personal email?
2. **Current behaviour.**
   - Starting an exit notifies nobody.
   - The only exit notification is "F&F ready for approval".
3. **Recommended option.**
   - **Email:** acceptance, last-working-day reminder, settlement statement, payment advice, and issued letters (to the **personal** email after the last working day).
   - **In-app:** internal steps (clearance items, approvals).
4. **Business justification.** Departing employees lose system access (ED-6), so external email is the only reliable channel for what they need afterwards.
5. **Impact.**
   - HR: templates.
   - IT: email delivery must be configured (SMTP is optional today; payslip email errors when it is not set).
   - Employees: need a valid personal email on record.
6. **Legal.** Sending personal financial details by email is a privacy matter. See ED-20 and ED-11.
7. **Professional confirmation.** None (privacy review optional).
8. **Dependencies.** ED-6, ED-11, ED-20.
9. **If delayed.** Phase 3 notifications would be in-app only, which doesn't reach employees who have left.

### ED-20 · Retention of exit records
1. **Question.** How long are exit documents, settlement records and exit-interview responses kept? What is anonymised or deleted afterwards?
2. **Current behaviour.**
   - No retention rule for exit data.
   - Nothing in the exit lifecycle is deleted.
   - Interview free text is kept indefinitely.
3. **Recommended option.**
   - Keep **settlement, tax and payroll records** for the longest applicable statutory period.
   - Keep **letters** for the same period.
   - **Anonymise interview free text** after a set period (for example 3 years), keeping the ratings for analytics.
   - Final periods to be set after legal advice.
4. **Business justification.** Statutory records must be producible. Personal opinions in interview notes should not be kept longer than they are useful.
5. **Impact.** IT: a retention job (Phase 6). HR: a policy statement for employees.
6. **⚖ Legal.**
   - Tax, labour and accounting laws require certain records to be kept for fixed periods.
   - Data protection law requires personal data to be kept only as long as needed for its purpose.
   - Confirm each period, and the current state of the DPDP Act 2023 and its Rules.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** ED-10, ED-11.
9. **If delayed.** No immediate effect (nothing is deleted). Phase 6 retention work waits.

### ED-21 · E-signature on exit letters
1. **Question.** Should relieving, experience and acceptance letters be e-signed? If so, how?
2. **Current behaviour.** No exit letters exist. A Zoho Sign integration exists in Pulse but has not been verified for this use.
3. **Recommended option.** **Not required for the first release**: issue letters as PDFs on company letterhead with a named signatory. Evaluate e-signature as a later option.
4. **Business justification.** Keeps Phase 3 small. Recipients generally accept letterhead PDFs.
5. **Impact.** None now. A later e-signature option needs signatory set-up.
6. **Legal.** Electronic signatures are recognised in Indian law under the IT Act 2000 when made by an approved method. Confirm only if a recipient requires a signed copy.
7. **Professional confirmation.** Optional.
8. **Dependencies.** ED-10.
9. **If delayed.** No effect; the default applies.

---

## 3. Finance management decisions

### ED-14 · Tax treatment of settlement components
1. **Question.** How is each settlement component taxed and reported? The components are: final salary, leave encashment, gratuity, notice pay recovered or paid, and recoveries. Where is the tax deducted?
2. **Current behaviour.**
   - The settlement engine shows an invented "TDS on PF" figure. There is no PF balance source; the PF corpus is held by EPFO.
   - Final salary has no payroll path for leavers (P0-2).
   - No settlement tax logic exists.
3. **Recommended option.** Run every **taxable salary component through the employee's final payroll run**, so TDS, Form 138 and Form 130 come from one engine. The settlement shows the tax but does not compute it separately. Exemptions are applied as the tax adviser confirms.
4. **Business justification.** One tax engine avoids two answers for the same person. It also keeps the year-end certificate consistent with deductions.
5. **Impact.**
   - Payroll: settlement components become one-time pay lines in the final run.
   - Finance: TDS payable from one source.
   - Employees: one certificate.
6. **⚖ Tax.**
   - The 1961 Act gave specific exemptions on separation (e.g. gratuity within a limit; leave encashment on retirement within a limit).
   - The Income-tax Act 2025 (tax year 2026-27) renumbers these provisions, and may change them.
   - Confirm for each component: taxability, exemption limits, treatment of notice pay paid by the employee, and the reporting form and section.
7. **Professional confirmation.** **Tax adviser — required.**
8. **Dependencies.** ED-9 (final run timing); ED-3, ED-13 (component amounts).
9. **If delayed.** Phase 4 cannot finish. Settlement approval stays suspended (containment C3), so settlements continue outside Pulse.

### ED-15 · When a settlement counts as settled
1. **Question.** Does an exit case count as "settled" (allowing closure) when the payment is **recorded**, or only when it is **reconciled** against the bank statement?
2. **Current behaviour.**
   - HR marks the settlement "paid" with no payment record (now suspended).
   - Bank reconciliation exists for other payments (`bank_statement_lines`).
3. **Recommended option.** **Settled when paid** (payment recorded with UTR, date and bank account). Reconciliation is tracked separately, with an exception report for anything unreconciled after a set number of days. It does not block the exit closing.
4. **Business justification.** Bank statements are imported on Finance's schedule. Tying exit closure to them would hold cases open for reasons unrelated to the employee.
5. **Impact.** Finance: an exception report to review. HR: cases close promptly.
6. **Legal.** None.
7. **Professional confirmation.** None.
8. **Dependencies.** MD-10 and MD-11 from the P0 design (accounts and payers).
9. **If delayed.** Phase 4 needs it.

---

## 4. Joint HR / Finance decisions

### ED-1 · Notice periods and how notice is counted
1. **Question.**
   - What notice period applies, by employment type, grade and probation status?
   - From which day does notice run (tender date, next day, or acceptance)?
   - Calendar or working days?
   - May an employee buy out the remaining notice?
2. **Current behaviour.**
   - HR types a number when starting an exit, or the settlement assumes **60 days**.
   - `employees.notice_period_days` is empty for every employee with an exit.
   - The settlement measures notice served against **today's date**, so the result changes with the click date (F-02).
3. **Recommended option.**
   - Record the notice periods **already stated in appointment letters or standing orders**, as a policy by employment type and grade (with probation as a separate row), plus a per-employee override where a letter differs.
   - Count calendar days from the day **after** the resignation is tendered.
   - Allow buy-out with HR approval.
   - Pulse never assumes a value. Missing data blocks the settlement.
4. **Business justification.** The company's existing commitments are the authority, and recording them is what makes recoveries defensible. A fixed counting rule makes the same exit give the same answer every time.
5. **Impact.**
   - HR: a one-off data exercise.
   - Finance: recoveries become predictable.
   - Employees: consistent treatment.
   - Payroll: last working days known in advance.
6. **⚖ Legal.** Notice terms come mainly from the contract and any standing orders. For workers covered by industrial-relations law, separation by the employer may carry its own notice requirement. Confirm that the recorded periods match the documents, and whether different rules apply to any category of staff.
7. **Professional confirmation.** **Legal — required** (to confirm the documents and categories).
8. **Dependencies.** None. ED-2 and ED-13 depend on it.
9. **If delayed.** Cases can still be recorded (Phase 1 seeds the policy as *unverified*), but **no settlement can be approved** (Phase 4). Notice recovery stays unreliable.

### ED-2 · Pay in lieu of notice when the company ends employment
1. **Question.** When the company ends employment without the employee serving notice, what does the company pay in lieu (basis and days)? When does it not apply?
2. **Current behaviour.** The settlement always treats a shortfall as a **recovery from the employee**, even for a termination. It recovers more the later it is computed.
3. **Recommended option.**
   - Follow the appointment letter.
   - Where the letter is silent, **block the settlement until legal confirms the basis**. Pulse must not apply a default.
   - The direction (recover vs pay) follows the exit type, as the design specifies.
4. **Business justification.** The current behaviour charges the employee for the company's own decision. That is a likely source of disputes.
5. **Impact.** Finance: termination settlements can increase. Employees: a correct direction. HR: termination letters must state the treatment.
6. **⚖ Legal.** Pay in lieu is governed by the contract. For workers covered by industrial-relations law, retrenchment may require notice or wages in lieu, plus compensation. Confirm the basis (which wages; how many days) and the categories affected.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** ED-1; MD-1 (day rate).
9. **If delayed.** Termination settlements cannot be approved in Pulse.

### ED-3 · Gratuity rules and nominee record
1. **Question.**
   - When is gratuity payable (service threshold; death and disablement; fixed-term staff)?
   - How are part-years counted? Which wage is the base? What is the ceiling?
   - Should Pulse hold a proper nominee record?
2. **Current behaviour.**
   - Gratuity only after **5 complete years** (part-years dropped).
   - Base: `employees.basic_salary`, which only 5 of 43 current employees have.
   - Ceiling ₹20,00,000.
   - The CTC calculator uses a different base (Code wages).
   - Only a free-text `nominee_name` exists.
3. **Recommended option.**
   - Apply the **statutory rule as confirmed by legal**, recorded as a dated rule.
   - Use **one wage base** in both CTC and settlement.
   - Add a **nominee record** (name, relationship, share, bank details verified by Finance).
4. **Business justification.** Gratuity is often the largest settlement amount. One confirmed rule avoids under- or over-payment, and the CTC shown at hiring will match the payout.
5. **Impact.**
   - Finance: a provisioning question (ED-14 / MD-10).
   - HR: nominee data collection.
   - Employees: correct entitlement.
   - Payroll: the CTC calculator is aligned.
6. **⚖ Legal.**
   - The Payment of Gratuity Act 1972 traditionally provided 15 days' wages per completed year (counting more than six months as a year), on a 26-day month, after five years of continuous service, except on death or disablement, up to a notified ceiling.
   - The Code on Social Security 2020 carries gratuity forward, with provisions for fixed-term employees and a new definition of wages.
   - Confirm which provisions apply now, and the current ceiling, rounding, threshold and wage base.
7. **Professional confirmation.** **Legal — required**; **tax** for exemption (ED-14).
8. **Dependencies.** ED-18 (continuity of service); ED-14.
9. **If delayed.** No settlement with gratuity can be approved. Every employee with five or more years is affected.

### ED-8 · Recoveries and pending claims at exit
1. **Question.**
   - Should outstanding loans, travel advances and the value of unreturned assets be **recovered through the settlement**, or must they be settled separately before it?
   - Should approved but unpaid expense claims be paid in the settlement, or through the claims process?
   - How is an unreturned asset valued?
2. **Current behaviour.**
   - An unsettled travel advance **blocks** payment.
   - Loans and claims are **ignored**.
   - An asset blocks payment until returned.
3. **Recommended option.**
   - **Recover** loans (balance after the final payroll), advances and agreed asset values **through the settlement**, as recovery lines.
   - **Pay claims through the existing claims process**, which has its own approvals and payment. The case cannot close while a claim is pending.
   - Asset value: written-down value from the asset register, or an agreed amount.
4. **Business justification.** Recovering through one settlement avoids chasing former employees. Keeping claims in their own flow avoids a second approval path for the same money.
5. **Impact.**
   - Finance: recovery accounting through the loan GL mapping (Part 14 of the payroll audit).
   - Employees: one statement.
   - Assets: valuation input.
   - Travel: advance settlement updates the advance record.
6. **⚖ Legal.** Deductions from an employee's wages are restricted to authorised kinds and limits under wage law. Recoveries from a final settlement may need the employee's written consent or a contractual clause. Confirm what may be deducted, and whether a settlement counts as "wages" for these limits.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** MD-10 (accounts); ED-14 (tax on recoveries, if any).
9. **If delayed.** Phase 3 (clearance items) and Phase 4 (settlement lines) cannot be finalised, and recoveries stay manual.

### ED-9 · Final salary timing and off-cycle run
1. **Question.** Must a leaver's final salary be paid before the next monthly payroll? Should Pulse support a **single-employee off-cycle final run**?
2. **Current behaviour.**
   - Payroll is a monthly batch, approved for the whole month.
   - A leaver whose status has changed is **excluded** from their final month, and regenerating the month deletes their draft (P0-2).
3. **Recommended option.** **Support an off-cycle final run**, with the same maker-checker as monthly payroll, used whenever the legal deadline falls before the normal pay date.
4. **Business justification.** It makes the timely payment of final wages possible without paying the whole company early.
5. **Impact.**
   - Payroll: a new run type (high-care change to the approval code).
   - Finance: more frequent salary payments.
   - Employees: earlier final pay.
6. **⚖ Legal.** Wage law sets a short deadline for paying wages on separation. The Code on Wages 2019 is generally read as requiring payment within two working days of removal, dismissal, retrenchment or resignation. Confirm the deadline and to which components it applies.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** ED-14 (tax in the final run).
9. **If delayed.** Phase 4 cannot finish. Final salaries keep depending on the monthly cycle and the manual runbook (C2).

### ED-11 · Documents for ex-employees
1. **Question.** How does a former employee receive payslips, the annual tax certificate (Form 130) and exit letters, once their login is disabled?
2. **Current behaviour.**
   - No route exists. Ex-employees either keep a working login (the risk in ED-6) or receive nothing.
   - Payslips can already be emailed by Payroll.
3. **Recommended option.**
   - **Email to the personal address on record**, using the existing payslip email path and the new letters.
   - HR can re-send on request.
   - **No login is kept alive** for this.
4. **Business justification.** Meets the employee's needs without the security cost of keeping accounts open.
5. **Impact.**
   - HR / Payroll: re-send requests.
   - IT: email must be configured.
   - Employees: need a correct personal email.
6. **Legal.** The employer must issue the annual tax certificate to employees, including those who have left (confirm timing and form with the tax adviser under ED-14). Emailing personal financial data is a privacy matter (ED-20).
7. **Professional confirmation.** None, beyond the ED-14 tax point.
8. **Dependencies.** ED-6, ED-19, ED-20.
9. **If delayed.** ED-6 is harder to agree, because access must stay open for documents.

### ED-13 · Leave encashment at exit
1. **Question.**
   - Which leave types are encashed at exit, and with what caps?
   - Is an annual allocation pro-rated to the last working day?
   - Is a negative balance recovered?
   - Does leave stop accruing after the last working day?
2. **Current behaviour.**
   - The settlement reads columns that do not exist, so **leave encashment is always ₹0** (F-01).
   - Only "Earned Leave" is marked encashable (15 days/year cap, configured for in-service encashment).
   - Accrual stops only when the status is `Left`.
3. **Recommended option.**
   - Encash the types marked encashable (today: Earned Leave).
   - Apply the statutory minimum and any more generous company policy.
   - Pro-rate the annual allocation to the last working day.
   - Recover a negative balance only where policy and law allow (see ED-8).
   - Stop accrual at the last working day.
4. **Business justification.** Encashment is owed money that is currently always shown as zero. A clear rule makes it correct and consistent.
5. **Impact.**
   - Finance: settlements increase to the correct amount.
   - HR: policy statement.
   - Leave module: balance updated when Finance approves.
   - Employees: correct payment.
6. **⚖ Legal.** Several laws (for example factory and shop and establishment laws, and their successors under the labour codes) require payment for unused earned leave on leaving. They vary by state and category. Confirm the applicable minimum and its basis.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** MD-1 (day rate); ED-8 (negative balance); ED-14 (tax).
9. **If delayed.** Settlements cannot be approved in Pulse. Every leaver with unused leave is affected.

### ED-16 · Absence marking while serving notice
1. **Question.** Should the daily auto-absent process include employees serving notice, so unrecorded days become absent (and potentially loss of pay)?
2. **Current behaviour.** The auto-absent job covers only Active and Probation employees (`attendance.cron.js:68`). Employees on notice who do not attend are **never** marked absent, and are paid for those days.
3. **Recommended option.** **Include employees on notice**, the same as other employees, with notice to staff before it starts.
4. **Business justification.** The notice period is a working period. Treating its attendance differently pays for days not worked, and hides absconding (ED-5).
5. **Impact.**
   - Employees on notice: loss of pay for unrecorded days, unless they regularise them.
   - Payroll: lower pay where attendance is missing.
   - HR: more regularisation requests.
6. **Legal.** No separate rule for notice-period attendance is expected, but the change affects pay, so staff should be informed in advance.
7. **Professional confirmation.** None.
8. **Dependencies.** ED-5.
9. **If delayed.** Pay continues for unrecorded notice days, and absconding detection (ED-5) cannot rely on attendance.

### ED-18 · Rehire: continuous or new service
1. **Question.** When a former employee is rehired, does service count as continuous for gratuity, leave and notice, or does a new period start? Under what conditions (gap length, settlement already paid)?
2. **Current behaviour.**
   - Rehire reuses the employee record, **overwrites the joining date** and clears the exit date.
   - Earlier service periods survive only in the audit log.
   - Terminated employees cannot be rehired.
3. **Recommended option.**
   - Keep every employment period as history.
   - Treat a rehire as **new service by default**. Count earlier service only where law requires it or management grants it case by case (recorded).
   - Keep the existing rule that terminated employees are not rehired, unless HR overrides it with a reason.
4. **Business justification.** Preserving history is necessary in any case. A default of new service avoids paying gratuity twice for the same years once a settlement has already paid them.
5. **Impact.**
   - HR: a choice on each rehire.
   - Finance: gratuity exposure is clear.
   - Employees: transparent treatment.
6. **⚖ Legal.** Continuity of service for gratuity has specific legal meanings (for example, interruptions that do not break continuity). Confirm when earlier service must count, and the effect of a gratuity already paid.
7. **Professional confirmation.** **Legal — required.**
8. **Dependencies.** ED-3.
9. **If delayed.** Phase 1 cannot move rehire into the new workflow. The current rehire keeps overwriting history.

### ED-22 · Who holds which exit permissions
1. **Question.** Which roles may start, accept, sign each department's clearance, prepare and approve settlements, pay, and configure exit policies?
2. **Current behaviour.**
   - Exit checks a single role against a fixed list. A person whose HR role is a secondary role is refused.
   - One HR person can sign every department's clearance.
   - HR approves and pays settlements alone.
3. **Recommended option** (all subject to Roles Setup):

| Action | Proposed holders |
|---|---|
| Start a case | HR executive / HR manager; employees for their own resignation |
| Accept a resignation | the reporting manager, or HR where none is active (the existing rule) |
| Approve other exit types | HR manager, not the person who started it |
| Sign clearance | each department's own permission holders (IT, Admin, Finance, HR); the reporting manager for the manager item |
| Prepare a settlement | HR / Payroll |
| HR-approve a settlement | HR manager, not the preparer |
| Finance-approve and post | Finance approver |
| Pay | Finance payments role |
| Change exit settings | HR manager / admin |

4. **Business justification.** Separation of duties is the core fix for F-05 and F-15. Using the permission matrix lets each company adjust it without code changes.
5. **Impact.** Every role touching exits is affected. Each company's Roles Setup needs a review.
6. **Legal.** None directly. It supports internal financial controls and audit.
7. **Professional confirmation.** None (internal audit input welcome).
8. **Dependencies.** ED-6, ED-15.
9. **If delayed.** Phase 1 cannot ship its permission checks.

---

## 5. Legal and tax adviser confirmations

These are the questions to send. Each needs a written answer before the related decision is finalised. Answers should cite the provision relied on, under the law in force for tax year 2026-27 and after the labour codes.

| # | Question | For | Adviser |
|---|---|---|---|
| L-1 | Do the notice periods recorded from our appointment letters and standing orders apply to every category of staff? Does any category have a statutory notice rule? | ED-1 | Legal |
| L-2 | Basis and days of pay in lieu of notice when the company ends employment; when retrenchment rules apply | ED-2 | Legal |
| L-3 | Gratuity: threshold, part-year rounding, wage base, ceiling, death/disablement, fixed-term staff, nominee requirements | ED-3 | Legal |
| L-4 | Is there a statutory retirement age for our workforce, or only what the contract and standing orders say? | ED-4 | Legal |
| L-5 | Procedure before treating absence as abandonment; may the settlement be withheld, and for how long? | ED-5 | Legal |
| L-6 | Permitted deductions from a final settlement (loans, advances, assets, notice shortfall); consent requirements | ED-8 | Legal |
| L-7 | Deadline for paying final wages on separation, and which components it covers | ED-9 | Legal |
| L-8 | Minimum leave encashment on leaving, by state and category, and its basis | ED-13 | Legal |
| T-1 | Taxability, exemptions and reporting of each settlement component; treatment of notice pay paid by the employee; certificate timing for leavers | ED-14, ED-11 | Tax |
| L-9 | When earlier service must count for gratuity on rehire; effect of gratuity already paid | ED-18 | Legal |
| L-10 | Retention periods for payroll, tax, settlement and HR records; data-protection limits on exit-interview data | ED-20 | Legal |

---

## 6. Related decisions from the P0 design (not part of ED-1 to ED-22)

These were raised in `HR_P0_REMEDIATION_DESIGN_2026-11-03.md` and are required for the same phases. They are listed so they are not lost.

| ID | Decision | Owner | Needed for |
|---|---|---|---|
| MD-1 | Day rate for leave encashment and notice (today Basic ÷ 26 in two places, unapproved) | Joint | ED-2, ED-13, Phase 4 |
| MD-2 | Salary source for settlements (salary revision, as payroll uses, vs employee master) | Finance | Phase 4 |
| MD-10 | Chart-of-accounts entries for gratuity, leave encashment, notice recovery, settlement payable, employee receivable, rounding | Finance | Phase 4 |
| MD-11 | Finance approvers, paying bank account, write-off authority for amounts owed by leavers | Finance | Phase 4 |
| MD-15 | IT declarations: policy option A/B/C and per-employee regime (see `HR_C7_TDS_DECLARATION_POLICY_2026-11-03.md`) | Joint + tax | P0-7 |
| C4 | Disable or keep each of the 4 exited logins (see `HR_C4_ACCOUNT_VERIFICATION_2026-11-03.md`) | HR | immediate |

---

## 7. Sign-off

For each decision, please record the option chosen, any change to the recommendation, the approver, the date, and the adviser reference where one is required. Implementation of each phase begins only after every decision listed under its "Blocks" column is signed, and after your separate approval to start the phase.

| ID | Option chosen | Approved by | Date | Adviser reference |
|---|---|---|---|---|
| ED-1 | | | | |
| ED-2 | | | | |
| ED-3 | | | | |
| ED-4 | | | | |
| ED-5 | | | | |
| ED-6 | | | | |
| ED-7 | | | | |
| ED-8 | | | | |
| ED-9 | | | | |
| ED-10 | | | | |
| ED-11 | | | | |
| ED-12 | | | | |
| ED-13 | | | | |
| ED-14 | | | | |
| ED-15 | | | | |
| ED-16 | | | | |
| ED-17 | | | | |
| ED-18 | | | | |
| ED-19 | | | | |
| ED-20 | | | | |
| ED-21 | | | | |
| ED-22 | | | | |
