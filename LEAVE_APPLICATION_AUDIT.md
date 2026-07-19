# LEAVE APPLICATION AUDIT
## Apply / Edit / Cancel / Withdraw / Half-Day / Attachment Flows
**Audit Date:** 2026-06-12  
**Source:** ApplyLeave.jsx, MyLeaves.jsx, leaves.routes.js, leaves.repository.js

---

## 1. APPLY LEAVE FLOW

### 1.1 Frontend (ApplyLeave.jsx)
**Route:** `/leaves/apply`  
**Component:** `ApplyLeave.jsx` (515 lines)

**Step 1 — Data Loading:**
```
On mount:
  GET /leaves/balance/:empId       → balance cards per type
  GET /leaves/types                → dropdown list
  GET /holidays                    → for business-day calculation
  GET /employees (admin only)      → employee picker
```

**Step 2 — Employee Selection:**
- Regular employee: auto-filled from `req.user.employee_id`
- Admin/HR: dropdown to pick any employee in company
- AdminPickerVerified: ✅

**Step 3 — Leave Type Selection:**
- Shows balance card with used/remaining for selected type
- Progress bar fills as days decrease
- Alert shown if: balance low, probation restriction, gender restriction
- WFH type shows distinct messaging

**Step 4 — Date Selection:**
- Date range picker (start_date + end_date)
- Half-day toggle: AM / PM session selector (shown only if `allow_half_day=true`)
- Business-day count: excludes weekends + holidays (live from holidays API)
- **GAP:** Sandwich rule NOT applied in day count preview

**Step 5 — Validation Warnings (frontend):**
- Clubbing warning if another leave within ±2 days
- Advance notice warning if start < today + min_notice_days
- Medical cert warning if days > requires_medical_cert_days (sick leave)
- Balance warning if requested > available

**Step 6 — Attachment Upload:**
- Shown if `requires_attachment=true`
- POST /documents/upload (max 5MB — validated frontend)
- Returns attachment_url stored with application

**Step 7 — Submit:**
- POST /api/v1/leaves/apply
- Success: navigate to My Leaves
- Error: toast message from API

---

### 1.2 Backend (POST /leaves/apply)
**File:** `leaves.routes.js`

**Policy enforcement order:**
1. `resolveLeaveTypeId` — finds leave_type by ID or name string
2. `resolveManagerEmployeeId` — FK lookup then name-string fallback
3. Overlap detection: SELECT from leave_applications WHERE dates overlap AND status != 'cancelled'
4. Balance check: available_days >= requested_days (or allow_negative_balance)
5. `min_notice_days` check
6. `max_consecutive_days` check
7. `requires_attachment` check
8. `gender_restriction` check — 403 if mismatch
9. Probation check → force is_lop if restricted type
10. Notice period check → force is_lop
11. Sandwich rule → recalculate number_of_days
12. `INSERT INTO leave_applications` (status='pending', manager_status='pending', hr_status='pending')
13. `notifyLeaveEvent('submitted', application)` → WorkflowNotificationService
14. `notifyProjectMilestoneConflict(application)` → checks projects/milestones ±3 days

**Notification on apply:** ✅ Verified — WorkflowNotificationService fires on submit.

---

## 2. EDIT LEAVE FLOW

**Endpoint:** PUT `/api/v1/leaves/:id`  
**Available in frontend:** ❌ **NOT EXPOSED**

**Analysis:**
- Backend PUT /:id endpoint exists (generic status update used by HR/Admin)
- ApplyLeave.jsx does not have an "Edit" mode for pending applications
- MyLeaves.jsx shows pending applications but has no "Edit" button
- **AUDIT FINDING:** Leave edit is NOT available to employees. Once submitted, only cancel and re-apply is the path.

---

## 3. CANCEL LEAVE FLOW

**Endpoint:** PUT `/api/v1/leaves/:id/cancel`  
**Frontend:** `MyLeaves.jsx` — Cancel button on pending/approved cards

**Backend logic (verified):**
```
1. Find application by ID + company_id scope
2. Verify employee owns the application (or HR/Admin)
3. If status='approved': decrementUsedBalance → leave_balances.used_days--
4. If status='approved': reverseLeaveAttendance → DELETE attendance WHERE source='leave_sync' AND date IN (leave_date_range)
5. UPDATE leave_applications SET status='cancelled', withdrawal_reason = req.body.reason
6. notifyLeaveEvent('cancelled')
```

**Reversal safety:** ✅ `reverseLeaveAttendance` only deletes records tagged `source='leave_sync'` — safe, does not touch manually created attendance.

**Frontend cancel confirmation:** ✅ Confirmation modal shown before cancel API call.

---

## 4. WITHDRAW LEAVE FLOW

**Status:** ⚠ PARTIAL IMPLEMENTATION

**DB Column:** `leave_applications.withdrawal_reason` — exists (migration 20260605)  
**Dedicated endpoint:** ❌ NO POST `/leaves/:id/withdraw` endpoint  
**Current path:** Cancel endpoint (`PUT /:id/cancel`) stores `withdrawal_reason` in body  
**UI:** No distinction between "Cancel" and "Withdraw" in MyLeaves.jsx — both use same cancel button

**Gap:** Withdrawal (retracting an approved leave after approval but before leave date) is semantically different from cancellation, but both flow through the same endpoint and same button. HR cannot distinguish between pre-approval cancels and post-approval withdrawals in reports.

---

## 5. HALF-DAY LEAVE

**Endpoint:** POST /leaves/apply with `half_day=true`, `half_day_session='AM'|'PM'`  
**Frontend:** Toggle in ApplyLeave.jsx — shown only when `allow_half_day=true`

**Backend handling (verified):**
```
If half_day = true:
  number_of_days = 0.5
  half_day_session stored for AM/PM
  
syncLeaveToAttendance:
  If half_day: status = 'half_day' (not 'on_leave')
```

**Attendance sync for half-day:** ✅ Verified — `syncLeaveToAttendance` checks `half_day` flag and sets attendance status to `'half_day'`.

**Leave type eligibility check:** ✅ Backend validates `allow_half_day=true` before processing half-day.

---

## 6. ATTACHMENT FLOW

**Upload:** POST /documents/upload (before leave apply)  
**Storage:** Local filesystem or S3 (configurable via environment)  
**Returned:** attachment_url stored in leave_applications.attachment_url

**Enforcement:**
- Frontend: Shows file picker when `requires_attachment=true`, validates 5MB max
- Backend: Returns 400 if `requires_attachment=true` AND `!attachment_url`
- Gap: No virus scanning on uploaded attachments

---

## 7. BULK APPROVE FLOW (HR/Admin)

**Endpoint:** POST `/leaves/bulk-approve`  
**Frontend:** `LeaveApprovals.jsx` — checkbox selection + bulk approve button  
**Roles:** HR, Admin only

**Logic:**
```
For each application_id in array:
  approveByHR() → status='approved', incrementUsedBalance, syncLeaveToAttendance
  notifyLeaveEvent('approved')
```

**Transaction safety:** Each approval is individual — partial bulk-approve may leave some approved, some pending on error. No single atomic transaction wrapping the batch.

---

## 8. DELEGATE APPROVER

**Endpoint:** POST `/leaves/delegate/:id`  
**DB Column:** `leave_applications.delegate_approver_id`  
**Frontend:** ⚠ **NOT EXPOSED** — endpoint and column exist but no UI to set delegate

---

## APPLICATION AUDIT SCORECARD

| Feature | Backend | Frontend | Score |
|---------|---------|----------|-------|
| Apply Leave | ✅ Full policy enforcement | ✅ Balance cards, warnings | 95% |
| Half-Day | ✅ 0.5d calculation, attendance sync | ✅ AM/PM toggle | 100% |
| Attachment | ✅ Required enforcement | ✅ Upload, 5MB limit | 90% |
| Overlap Detection | ✅ | ✅ Warning | 100% |
| Sandwich Rule | ✅ Backend | ❌ Not in day-count preview | 70% |
| Edit Leave | ❌ No employee edit flow | ❌ No edit button | 10% |
| Cancel Leave | ✅ With balance reversal + attendance reverse | ✅ Confirmation modal | 100% |
| Withdraw Leave | ⚠ Uses cancel endpoint | ❌ No distinct UI | 40% |
| Delegate Approver | ✅ Column + endpoint | ❌ No UI | 30% |
| Bulk Approve | ✅ | ✅ Checkbox selection | 90% |
| Admin Employee Pick | ✅ | ✅ | 100% |
| Project Conflict Alert | ✅ ±3 days detection | ❌ Not shown in apply UI | 60% |

**APPLICATION FLOW OVERALL: 78/100**
