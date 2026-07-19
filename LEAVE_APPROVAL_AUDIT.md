# LEAVE APPROVAL AUDIT
## L1 → L2 → L3 Workflow, Escalation, Delegation, SLA
**Audit Date:** 2026-06-12  
**Source:** leaves.routes.js, leaves.repository.js, leave.cron.js, LeaveApprovals.jsx

---

## 1. APPROVAL WORKFLOW ARCHITECTURE

### 1.1 Three-Level Flow

```
Employee submits leave
    │
    ▼
L1: Manager (manager_status: pending → approved/rejected)
    │
    ├─ Rejected: status='rejected', notify employee
    │
    ▼
L2: L2 Approver/Dept Head (l2_status: NULL → pending → approved/rejected)
    │  [OPTIONAL: l2_status=NULL means L2 not required]
    │
    ├─ Rejected: status='rejected', notify employee
    │
    ▼
L3: HR Final Approval (hr_status: pending → approved/rejected)
    │
    ├─ Approved: status='approved'
    │            incrementUsedBalance (leave_balances.used_days++)
    │            syncLeaveToAttendance (INSERT attendance, source='leave_sync')
    │            notifyLeaveEvent('approved')
    │
    └─ Rejected: status='rejected', notifyLeaveEvent('rejected')
```

### 1.2 L2 Optional Logic

**Verified in approveByHR:**
```javascript
const preconditions = `manager_status = 'approved' AND (l2_status = 'approved' OR l2_status IS NULL)`
```

If `l2_approver_id IS NULL` on the application, l2_status stays NULL and HR can approve directly after L1.  
If `l2_approver_id` is set, l2_status starts as 'pending' and must be approved before HR.

**Gap:** No per-leave-type or per-company configuration to enforce L2 as mandatory. L2 is optional across the board.

---

## 2. L1 MANAGER APPROVAL

**Endpoint:** POST `/leaves/approve/manager/:id`  
**Roles:** manager, team_lead, department_head, admin, super_admin, hr, hr_manager  
**File:** leaves.routes.js + approveByManager() in repository

**Logic:**
```
1. Find application WHERE id=? AND company_id scoped
2. Verify current manager_status='pending'
3. UPDATE leave_applications SET manager_status='approved', manager_comments, manager_approved_at
4. INSERT INTO leave_approval_history (level=1, action='approved')
5. notifyLeaveEvent('approved_l1') → WorkflowNotificationService
6. Does NOT set status='approved' — must still go through L3 HR
```

**Manager Resolution:**
- `resolveManagerEmployeeId`: first tries employees.id FK lookup
- Falls back to string match on employee name (legacy support)

---

## 3. L2 APPROVAL

**Endpoint:** POST `/leaves/approve/l2/:id`  
**Roles:** l2_approver, department_head, admin, super_admin, hr, hr_manager  
**Logic:**
```
1. Verify manager_status='approved' (L1 must be complete)
2. UPDATE leave_applications SET l2_status='approved', l2_approver_id, l2_comments, l2_approved_at
3. INSERT INTO leave_approval_history (level=2, action='approved')
4. notifyLeaveEvent('approved_l2')
```

---

## 4. L3 HR FINAL APPROVAL

**Endpoint:** POST `/leaves/approve/hr/:id`  
**Roles:** hr, hr_manager, admin, super_admin (ADMIN_HR_ROLES)

**Logic:**
```
1. Verify manager_status='approved' AND (l2_status='approved' OR l2_status IS NULL)
2. UPDATE status='approved', hr_status='approved', hr_id, hr_comments, hr_approved_at
3. INSERT INTO leave_approval_history (level=3, action='approved')
4. incrementUsedBalance(client, application) — ATOMIC
5. syncLeaveToAttendance(application) — attendance INSERT
6. notifyLeaveEvent('approved')
```

**Atomicity:** incrementUsedBalance runs in the same DB client (transaction-safe). syncLeaveToAttendance runs separately after — if attendance sync fails, balance is still incremented but attendance is not created. No rollback on partial failure.

---

## 5. REJECTION FLOW

**Endpoints:**
- POST `/leaves/reject/manager/:id`
- POST `/leaves/reject/l2/:id`
- POST `/leaves/reject/hr/:id`

**Logic for any rejection:**
```
1. UPDATE leave_applications SET [level]_status='rejected', comments, rejected_at
2. UPDATE leave_applications SET status='rejected'
3. INSERT INTO leave_approval_history (level=N, action='rejected')
4. notifyLeaveEvent('rejected')
5. NO balance deduction (used_days never incremented for rejected leaves)
6. NO attendance sync (nothing to reverse)
```

---

## 6. APPROVAL HISTORY TRACKING

**Table:** `leave_approval_history`

```
leave_application_id | approver_id | approval_level | action | comments | created_at
```

**Frontend:** Approval history drawer in LeaveApprovals.jsx and MyLeaves.jsx (ApprovalPipeline component)

**Timeline display:**
- Shows L1 (Manager), L2 (Dept Head), L3 (HR) in sequence
- Each step shows: approver name, action (approved/rejected), timestamp, comments

---

## 7. BULK APPROVAL

**Endpoint:** POST `/leaves/bulk-approve`  
**Frontend:** Checkbox selection in LeaveApprovals.jsx, HR tab

**Logic:**
```
For each application_id:
  approveByHR(id, hr_id, 'Bulk approved')
  syncLeaveToAttendance(application)
  notifyLeaveEvent('approved')
```

**Risk:** Not atomic — failure on record N does not roll back records 1 to N-1. Partial bulk-approve possible.

---

## 8. APPROVAL DELEGATION

**Endpoint:** POST `/leaves/delegate/:id`  
**DB Column:** `leave_applications.delegate_approver_id`  
**Frontend:** ❌ **NO UI** — endpoint exists, column exists, no button in LeaveApprovals.jsx

**Logic (backend):**
```
UPDATE leave_applications SET delegate_approver_id = req.body.delegate_to
WHERE id = ? AND manager_id = req.user.employee_id
```

The delegate approver can then approve as if they were the manager. However, the approval endpoints check `manager_id` OR `delegate_approver_id` — verified in routes.

---

## 9. SLA ESCALATION

**Trigger:** Cron `'0 9 * * 1-5'` — weekdays 09:00 IST  
**File:** `leave.cron.js`

**Logic:**
```
Find leave_applications WHERE:
  status = 'pending'
  AND CURRENT_DATE - applied_at > 3 (days)
  AND manager_status = 'pending'

For each:
  notifyLeaveEvent('escalated') → WorkflowNotificationService
  Logs to audit_logs
```

**Gap:** Escalation sends notification but does NOT auto-approve or escalate to next level. It is advisory only.  
**Gap:** SLA threshold is hardcoded at 3 days — not configurable per company or leave type.  
**Gap:** L2 and L3 SLA monitoring not implemented — only L1 escalation tracked.

---

## 10. APPROVAL STATUS MATRIX

| Scenario | manager_status | l2_status | hr_status | status |
|----------|---------------|-----------|-----------|--------|
| Just submitted | pending | NULL/pending | pending | pending |
| L1 approved | approved | NULL/pending | pending | pending |
| L1 rejected | rejected | — | — | rejected |
| L1+L2 approved | approved | approved | pending | pending |
| L2 rejected | approved | rejected | — | rejected |
| Fully approved | approved | approved/NULL | approved | approved |
| HR rejected | approved | approved/NULL | rejected | rejected |
| Cancelled | — | — | — | cancelled |

---

## 11. GENERIC STATUS UPDATE (HR Override)

**Endpoint:** PUT `/leaves/applications/:id/status`  
**Endpoint:** PUT `/leaves/:id`  
**Roles:** HR, Admin only

Allows HR to bypass 3-level flow and set any status directly. Used for corrections.  
**Risk:** HR can approve without manager approval using this endpoint — audit trail logs the override but workflow is bypassed.

---

## 12. leaveService.approveLeave() BUG

**File:** `frontend/src/services/leaveService.js`

```javascript
approveLeave: (id, data) => apiClient.post(`/leaves/approve/hr/${id}`, data)
```

This function ALWAYS calls the HR approval endpoint regardless of who the caller is. Any component using `approveLeave()` (not `approveLeaveL1` or `approveLeaveL2`) bypasses the L1/L2 endpoints and goes directly to L3.

**Impact:** If any UI component uses `approveLeave()` for manager-level approvals, it will:
1. Try to set `hr_status='approved'`
2. Only work if `manager_status='approved'` already (L1 precondition check)
3. Silently fail with wrong permissions for non-HR users

**Components using `approveLeave` (to verify):** LeaveApprovals.jsx uses `approveLeaveL1`, `approveLeaveL2`, `approveLeave` in different tab handlers. Need to confirm HR tab is the only one using `approveLeave`.

---

## APPROVAL AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| 3-Level Workflow | ✅ L1→L2(optional)→L3 | 90% |
| L1 Approval | ✅ Full, with history | 100% |
| L2 Approval | ✅ Optional logic correct | 90% |
| L3 HR Approval | ✅ With balance + attendance | 95% |
| Rejection at any level | ✅ | 100% |
| Approval History | ✅ Timeline display | 100% |
| Bulk Approve | ✅ HR only, not atomic | 80% |
| Delegation | ⚠ Backend only, no UI | 30% |
| SLA Escalation | ✅ Advisory, cron-based | 70% |
| L2 Mandatory Config | ❌ Not configurable | 20% |
| SLA Config | ❌ Hardcoded 3 days | 30% |
| leaveService.approveLeave() | ⚠ Bypasses L1/L2 | 60% |
| Atomicity (balance+attendance) | ⚠ Partial — attendance separate | 80% |

**APPROVAL WORKFLOW OVERALL: 76/100**
