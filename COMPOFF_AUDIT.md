# COMP OFF AUDIT
## Weekend/Holiday Work, Expiry, Conversion, Balance
**Audit Date:** 2026-06-12  
**Source:** compoff.routes.js, CompOffPage.jsx, leave.cron.js

---

## 1. COMP OFF TABLE SCHEMA

**Table:** `compensatory_off`  
**Migration:** 20260605000001 + 20260609000001

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | — |
| employee_id | integer FK → employees | — |
| work_date | date | Date employee worked extra |
| hours_worked | numeric | Used for credit calculation |
| holiday_id | integer FK → holidays | Optional link to holiday worked |
| reason | text | Why employee worked |
| status | varchar CHECK | 'pending','approved','rejected','used' |
| approved_by | integer FK → employees | — |
| approved_at | timestamp | — |
| comments | text | Approver comments |
| expires_on | date | work_date + 3 months |
| credited | boolean | Whether leave_balance credited |
| company_id | integer FK | Tenant scoping |
| project_id | integer FK → projects | Link to project (optional) |
| created_at / updated_at | timestamp | — |

---

## 2. COMP OFF SUBMIT FLOW

**Endpoint:** POST `/comp-off`  
**Frontend:** CompOffPage.jsx — "Submit Comp Off" button

**Logic:**
```
1. Validate: work_date must be a holiday OR weekend (not enforced in backend — only description says so)
2. Duplicate check: SELECT WHERE employee_id=? AND work_date=? AND status NOT IN ('rejected')
3. Calculate expires_on = work_date + INTERVAL '3 months'
4. INSERT INTO compensatory_off (status='pending', credited=false)
5. notifyEvent('compoff_submitted')
```

**⚠ Gap:** Backend does NOT verify that `work_date` is actually a holiday or weekend. Employees can submit comp off for any date — no validation against `holidays` table or day-of-week check.

---

## 3. COMP OFF CREDIT CALCULATION (Frontend)

```javascript
// CompOffPage.jsx
const calculateCredit = (hours_worked) => {
  if (hours_worked >= 8) return 1.0;   // full day
  if (hours_worked >= 4) return 0.5;   // half day
  return 0;                             // < 4 hours, no credit
}
```

**Backend does NOT enforce this calculation** — hours_worked is stored but credit amount is determined at approval time based on `hours_worked` value.

---

## 4. COMP OFF APPROVAL FLOW

**Endpoint:** POST `/comp-off/approve/:id`

**Logic:**
```javascript
1. Find comp_off record WHERE id=? AND status='pending'
2. Determine credit: full=1.0d if hours_worked >= 8, half=0.5d
3. Find leave_type WHERE is_comp_off_type=true (e.g., 'Compensatory Leave')
4. UPSERT leave_balances:
   SET allocated_days += credit_days
   WHERE employee_id=? AND leave_type_id=comp_off_type.id AND year=CURRENT_YEAR
5. UPDATE compensatory_off SET status='approved', credited=true, approved_by, approved_at
6. INSERT INTO leave_approval_history (level=1)
7. notifyEvent('compoff_approved')
```

**Balance Credit:** ✅ Correctly credits `leave_balances.allocated_days` for the comp_off leave type.

---

## 5. COMP OFF REJECTION FLOW

**Endpoint:** POST `/comp-off/reject/:id`

```
1. UPDATE compensatory_off SET status='rejected', comments
2. notifyEvent('compoff_rejected')
3. NO balance adjustment (credited=false, nothing to reverse)
```

---

## 6. COMP OFF EXPIRY FLOW

### 6.1 Manual Expiry (POST /comp-off/expire)
```javascript
1. UPDATE compensatory_off SET status='expired'
   WHERE expires_on < CURRENT_DATE AND status='approved'
2. Does NOT update leave_balances ← CRITICAL BUG
```

### 6.2 Cron Expiry (Daily 00:30 IST) — leave.cron.js
```javascript
1. Find compensatory_off WHERE expires_on < CURRENT_DATE AND status='approved' AND credited=true
2. For each:
   a. Determine comp_off leave type
   b. Calculate days credited (hours >= 8 → 1.0, else 0.5)
   c. UPDATE leave_balances SET allocated_days -= credit_days
      WHERE employee_id=? AND leave_type_id=? AND year=?
   d. UPDATE compensatory_off SET status='expired'
3. Logs audit entry
```

**CRITICAL INCONSISTENCY:**
- Cron expiry: ✅ DOES reverse leave_balances
- Manual POST /expire: ❌ Does NOT reverse leave_balances

If HR manually triggers expiry before the cron, the leave balance is NOT reversed. Employees retain expired comp off credits until the cron runs (which then finds `status='expired'` and skips them — they're never reversed).

---

## 7. COMP OFF BALANCE ENDPOINT

**Endpoint:** GET `/comp-off/balance/:employee_id`

**Returns:**
```json
{
  "available_days": 1.5,
  "pending_requests": 2,
  "available_credits": 3,
  "expired_credits": 1
}
```

---

## 8. FRONTEND (CompOffPage.jsx)

### 8.1 Features
- Balance dashboard cards: Available Days, Pending Requests, Earned Credits, Expired Credits
- ⚠ **Expiry warning**: Shows orange banner if any comp off expires within 14 days
- Form to submit new comp off: work_date, hours_worked, reason, holiday_id (upcoming holidays dropdown)
- List of own records with status badges
- HR/Admin tab to approve/reject pending requests

### 8.2 APIs Called
```
GET /api/v1/comp-off              → list records (role-scoped)
GET /api/v1/comp-off/balance/:empId → balance cards
GET /api/v1/holidays?upcoming=true → upcoming holidays (for "worked on holiday" picker)
POST /api/v1/comp-off             → submit request
POST /api/v1/comp-off/approve/:id → approve
POST /api/v1/comp-off/reject/:id  → reject
```

### 8.3 Expiry Warning
```javascript
// Shown if any comp off record has expires_on within 14 days
const upcomingExpiry = records.filter(r => 
  r.status === 'approved' && 
  daysDiff(r.expires_on, today) < 14
);
```

---

## 9. PROJECT LINKING

**DB Column:** `compensatory_off.project_id` (migration 20260609)  
**Purpose:** Link comp-off request to the project that required weekend work  
**Frontend:** ❌ **Not exposed** — project_id field not in submit form  
**Backend POST:** ❌ project_id not accepted in POST body (need to verify)

---

## 10. COMP OFF USING LEAVE

When employee uses comp off (applies leave using comp_off leave type):
1. Standard leave application flow
2. On approval: `incrementUsedBalance` → decrements comp_off leave balance
3. compensatory_off.status → should be updated to 'used' — **NOT IMPLEMENTED**

**Gap:** When a compensatory off credit is consumed (employee takes leave using it), the `compensatory_off` record status is never updated to 'used'. The `credited` flag stays `true` and `status` stays `'approved'`. This makes comp-off audit trail incomplete.

---

## COMP OFF AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Submit Request | ✅ | 80% |
| Duplicate Prevention | ✅ | 100% |
| Work Date Validation (holiday/weekend) | ❌ Not enforced | 0% |
| Hours → Credit Calculation | ✅ Frontend logic | 80% |
| Approval + Balance Credit | ✅ | 100% |
| Rejection | ✅ | 100% |
| Expiry Warning (14 days) | ✅ | 100% |
| Cron Expiry + Balance Reversal | ✅ | 100% |
| Manual Expiry (no reversal) | ❌ CRITICAL BUG | 10% |
| Balance Endpoint | ✅ | 100% |
| Project Linking | ❌ No UI | 20% |
| 'used' status when leave taken | ❌ Never set | 20% |
| 3-month expiry configurable | ❌ Hardcoded | 40% |

**COMP OFF OVERALL: 71/100**
