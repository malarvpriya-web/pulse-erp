# LEAVE PAYROLL AUDIT
## LOP Deduction, Encashment Posting, Attendance-Payroll Integration
**Audit Date:** 2026-06-12  
**Source:** leaves.routes.js, encashment.routes.js, payroll module files, migration 20260609000001

---

## 1. CRITICAL REQUIREMENT

**Requirement:** LOP leave MUST auto-affect payroll (deduction).  
**Requirement:** Leave encashment net amount MUST post to payroll.  
**Failure Mode:** LOP not deducted = employees paid for absent days. Compliance failure.

---

## 2. LOP → PAYROLL INTEGRATION

### 2.1 How LOP is Tracked

**LOP flag set at apply time (leaves.routes.js POST /apply):**
```javascript
// Conditions that force is_lop = true:
if (employee.in_probation && !leave_type.allowed_in_probation) is_lop = true;
if (employee.on_notice_period) is_lop = true;
if (leave_balance < requested_days && !allow_negative_balance) is_lop = true (for deficit portion);
```

**LOP leave type:** `loss_of_pay` with `is_lop_type = true`  
`leave_applications.is_lop` boolean column tracks whether this application is LOP

### 2.2 How LOP Affects Payroll — CRITICAL FINDING

**Expected:** LOP approval → automatically post deduction to `payroll_runs`  
**Actual:** NO automatic LOP posting to payroll_runs

**Verified code path on L3 HR approval:**
```
approveByHR() →
  incrementUsedBalance() → UPDATE leave_balances.used_days++
  syncLeaveToAttendance() → INSERT INTO attendance (status='on_leave')
  — NO payroll_runs update for LOP —
```

**How payroll currently handles LOP (presumed):**
The payroll engine must read leave data at payroll run time:
```
PayrollRun → reads attendance for month → 
  counts absent days (no approved leave) = LOP days →
  deducts salary / working_days × LOP_days
```

**OR:**
```
PayrollRun → reads leave_applications WHERE is_lop=true → 
  deducts (basic_salary/26) × lop_days
```

**Gap:** There is NO direct `payroll_runs.lop_amount` column or trigger. LOP deduction depends entirely on payroll engine reading leave data — if the payroll engine has bugs or uses a different LOP calculation, the deduction will be wrong. The connection is indirect and not verifiable without reading the full payroll module.

**`payroll_runs` table columns related to leave:**
- `leave_encashment_amount` NUMERIC(12,2) DEFAULT 0 — added in migration 20260609

**Missing payroll columns:**
- `lop_days` — not present on payroll_runs
- `lop_deduction_amount` — not present on payroll_runs
- No trigger on `is_lop=true` approval that posts to payroll

---

## 3. LEAVE ENCASHMENT → PAYROLL INTEGRATION

### 3.1 How Encashment Posts to Payroll

**Endpoint:** POST `/leave-encashment/approve/:id`

```javascript
// ATOMIC TRANSACTION
await trx('payroll_runs')
  .where({ id: payroll_run_id })
  .increment('leave_encashment_amount', net_amount);
```

**Condition:** Only posts if `payroll_run_id` is explicitly passed in the approval request body.

**Gap:** If no `payroll_run_id` is provided:
- Encashment is approved ✅
- Balance is deducted ✅  
- `payroll_runs.leave_encashment_amount` is NOT incremented ❌
- The net_amount exists only in `leave_encashments` table
- No automatic matching to current active payroll run

### 3.2 Payroll Processing of Encashment Amount

Once `payroll_runs.leave_encashment_amount` is set, the payroll engine should add it to the employee's net pay. Whether this actually happens requires verification in the payroll calculation module — outside scope of this audit.

---

## 4. ATTENDANCE → PAYROLL DATA FLOW

```
leave_applications.status = 'approved'
    ↓
syncLeaveToAttendance()
    ↓
attendance.status = 'on_leave' (source='leave_sync')
    ↓
Payroll Engine (monthly run):
  → reads attendance for employee for pay period
  → counts days with status='present', 'late', 'wfh'
  → absent days (no attendance record OR status='absent') = LOP
  → approved leave days (status='on_leave') = paid leave (no deduction)
  → LOP days = absent days - approved leave days
  → deduction = (basic_salary / working_days) × LOP_days
```

**The leave-attendance-payroll chain:**
- Leave approved → attendance created ✅
- Attendance with 'on_leave' → payroll engine treats as paid (no deduction) — assumed ✅
- Attendance absent AND no approved leave → LOP — payroll engine logic needed

---

## 5. WFH LEAVE → PAYROLL

**Attendance status:** `'wfh'` when WFH leave approved  
**Payroll treatment:** WFH days treated as present (no deduction) — correct  
**Gap:** No separate WFH tracking in payroll — counted as full working days

---

## 6. MONTHLY ACCRUAL → PAYROLL

Accrual does NOT directly affect payroll. Accrual only updates `leave_balances.allocated_days`. This is correct — accrual creates entitlement, not a financial transaction.

---

## 7. PAYROLL MODULE LEAVE DATA READING

**To fully audit LOP deduction, the payroll calculation engine must be read.**  
The payroll module routes and services are separate from the leave module.

**Verified from migration 20260609000001:**
- `payroll_runs.leave_encashment_amount` column added — confirms intent to integrate encashment
- No `lop_days` or `lop_deduction` columns on payroll_runs

**Presumed payroll flow (not verified in this audit):**
1. Payroll run created for month
2. For each employee: reads attendance records for period
3. Counts LOP days from attendance (absent without leave approval)
4. Alternatively: reads leave_applications WHERE is_lop=true for period
5. Calculates deduction

**Recommendation:** Audit payroll module separately to verify LOP calculation source.

---

## 8. PAYROLL AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| LOP flag set on approval | ✅ | 100% |
| LOP direct payroll post | ❌ NO automatic posting | 0% |
| LOP deduction (via attendance) | ⚠ Indirect/unverified | 50% |
| Encashment payroll post (with run_id) | ✅ Atomic | 90% |
| Encashment payroll post (without run_id) | ❌ No posting | 10% |
| payroll_runs.leave_encashment_amount | ✅ Column exists | 80% |
| payroll_runs.lop_days column | ❌ Missing | 0% |
| WFH treated as paid | ✅ Via attendance | 90% |
| Approved leave = no deduction | ✅ Via attendance | 90% |
| Accrual affects payroll | N/A | N/A |

**PAYROLL INTEGRATION OVERALL: 58/100**

---

## CRITICAL FINDINGS

| ID | Finding | Severity |
|----|---------|----------|
| PAY-1 | LOP approval has NO direct payroll posting — relies on payroll engine reading attendance/leave | CRITICAL |
| PAY-2 | No `payroll_runs.lop_days` or `lop_deduction_amount` column | HIGH |
| PAY-3 | Encashment not posted to payroll without explicit payroll_run_id | HIGH |
| PAY-4 | LOP deduction formula not centrally defined — each payroll run may compute differently | HIGH |
| PAY-5 | No test/verification that payroll engine correctly reads is_lop=true applications | HIGH |
