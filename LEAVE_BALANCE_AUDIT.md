# LEAVE BALANCE AUDIT
## Opening Balance → Accrual → Carry Forward → Available Balance
**Audit Date:** 2026-06-12  
**Source:** leaves.repository.js, accrual.routes.js, leave.cron.js, migration 20260605000001

---

## 1. BALANCE TABLE SCHEMA

**Table:** `leave_balances`  
**Key columns:**

| Column | Type | Default | Written By |
|--------|------|---------|-----------|
| employee_id | integer | — | On allocation/init |
| leave_type_id | integer | — | On allocation/init |
| year | integer | — | On allocation/init |
| allocated_days | numeric | 0 | Manual alloc, bulk alloc, accrual cron |
| used_days | numeric | 0 | approveByHR(), encashment approve |
| encashed_days | numeric | 0 | encashment approve only |
| carried_forward_days | numeric | 0 | CF cron, CF expire |
| opening_balance | numeric | 0 | **NEVER WRITTEN — BUG** |
| updated_at | timestamp | — | On any update |

---

## 2. BALANCE FORMULA

### 2.1 Expected Formula (CHRO Standard)
```
Available = Opening Balance + Accrued + Carry Forward − Used − Encashed − Pending
```

### 2.2 Actual Formula (getLeaveBalance in leaves.repository.js)
```sql
available_days = MAX(0, lb.allocated_days - used_days_subquery - pending_days_subquery)

WHERE:
  used_days_subquery = COALESCE(SUM(number_of_days) FROM leave_applications 
                       WHERE status IN ('approved', 'completed') AND year = ?)
  pending_days_subquery = COALESCE(SUM(number_of_days) FROM leave_applications 
                          WHERE status = 'pending' AND year = ?)
```

### 2.3 Formula Gap Analysis

| Component | Expected | Actual | Status |
|-----------|----------|--------|--------|
| Opening Balance | opening_balance | NOT in formula | ❌ MISSING (always 0) |
| Accrued | accrual additions to allocated_days | allocated_days includes it | ✅ Correct |
| Carry Forward | carried_forward_days added to allocated | allocated_days includes CF | ✅ Correct |
| Used | used_days (approved) | Live subquery from applications | ✅ Correct |
| Pending | pending_days | Live subquery from applications | ✅ Correct |
| Encashed | encashed_days | **Not subtracted** (but added to used_days on encashment approve) | ⚠ Indirect |

### 2.4 Encashed Days Handling

**Encashment approve logic:**
```javascript
// encashment.routes.js approve/:id
UPDATE leave_balances
SET encashed_days += days_encashed,
    used_days += days_encashed   // ← encashed treated as "used"
```

This means encashed days flow into `used_days`, which IS subtracted in the formula. So the formula effectively accounts for encashment — but confusingly lumps encashment with actual usage. Reports show `used_days` that includes encashed leave, making leave register misleading.

---

## 3. OPENING BALANCE — CRITICAL FAILURE

**DB Column:** `leave_balances.opening_balance` — exists since migration 20260605  
**Written by:** NOTHING — no code path writes to this column  
**Current value:** Always 0 for all employees

**When should it be set?**
1. On year start (carry-forward run): the days being carried forward should set `opening_balance` on the new year's record
2. On initial balance initialization: for employees joining mid-year, prior service balance should seed `opening_balance`
3. On manual balance adjustment by HR

**Impact:** The "opening balance" display (if any UI shows it) will always be ₹0. Statutory leave registers that require opening balance (Form-wise) cannot be generated.

---

## 4. BALANCE INITIALIZATION

**Endpoint:** POST `/leaves/balance/initialize`  
**Purpose:** Create a zero-balance record for a new employee × leave type × year  
**Logic:** UPSERT leave_balances with allocated_days = 0 (HR then manually allocates)

**Gap:** `opening_balance` not set even during initialization.

---

## 5. MANUAL ALLOCATION

**Endpoint:** POST `/leaves/allocate`  
**Purpose:** HR allocates specific number of days to an employee  
**Logic:** UPSERT leave_balances SET allocated_days = ? WHERE employee_id+leave_type_id+year

**Gap:** Does not distinguish between "new allocation" and "adjustment". Any change overwrites allocated_days entirely — no delta/adjustment log.

---

## 6. BULK ALLOCATION

**Endpoint:** POST `/leaves/bulk-allocate`  
**Purpose:** Copy one year's allocation to all active employees  
**Logic:** 
```
For each leave_type:
  For each active employee:
    UPSERT leave_balances SET allocated_days = leave_type.annual_quota
```

**Gap:** Bulk allocation uses `annual_quota` from leave_types, ignoring any per-employee adjustments. Running bulk after individual adjustments would overwrite custom allocations.

---

## 7. USED DAYS CALCULATION

**Method:** Live subquery (not from `lb.used_days` column)

```sql
(SELECT COALESCE(SUM(la.number_of_days), 0)
 FROM leave_applications la
 WHERE la.employee_id = lb.employee_id
   AND la.leave_type_id = lb.leave_type_id
   AND EXTRACT(YEAR FROM la.start_date) = ?
   AND la.status IN ('approved', 'completed')
   AND la.deleted_at IS NULL) AS used_days_live
```

**Strength:** Always accurate — reads actual approved applications, not a cached counter.  
**Risk:** At scale (many applications), live subquery adds query cost. Consider indexed materialized view for reporting.

---

## 8. CARRY FORWARD BALANCE FLOW

**Year N → Year N+1:**
```
1. Cron runs Jan 1:
   remaining = leave_balances[year=N].allocated_days - used_days_live
   cf_days = MIN(remaining, leave_types.max_carry_forward_days)
   
2. Creates/upserts leave_balances[year=N+1]:
   allocated_days += cf_days
   carried_forward_days = cf_days

3. Updates leave_balances[year=N]:
   carried_forward_days = cf_days  (audit trail on old year)
   
4. opening_balance[year=N+1] = 0  ← BUG: should = cf_days
```

---

## 9. NEGATIVE BALANCE HANDLING

**Condition:** `allow_negative_balance = true` (Emergency Leave only)  
**Enforcement:**
```
available = MAX(0, allocated - used - pending) for normal leaves
For EML: balance can go below 0 — no MAX(0) guard, deficit tracked in used_days
```

**Gap:** No explicit display of negative balance in frontend — users may not realize they've gone into deficit.

---

## 10. BALANCE DISPLAY (Frontend)

**ApplyLeave.jsx balance cards:**
- Shows per-type balance: allocated, used, available
- Progress bar (available/allocated %)
- Color: green → yellow → red based on remaining percentage

**Gap:** `carried_forward_days` and `encashed_days` not individually displayed — only net available shown. Employees cannot see breakdown.

---

## BALANCE AUDIT CRITICAL FINDINGS

| ID | Finding | Severity |
|----|---------|----------|
| BAL-1 | opening_balance NEVER written — always 0 | CRITICAL |
| BAL-2 | No balance change audit trail (who changed what when) | HIGH |
| BAL-3 | Bulk allocation overwrites manual adjustments | HIGH |
| BAL-4 | encashed_days lumped into used_days — reports misleading | MEDIUM |
| BAL-5 | carried_forward_days breakdown not shown to employee | MEDIUM |
| BAL-6 | Negative balance no explicit indicator in UI | MEDIUM |
| BAL-7 | No balance adjustment endpoint for HR corrections | MEDIUM |
| BAL-8 | Live subquery for used_days may be slow at scale | LOW |

## BALANCE AUDIT SCORECARD

| Sub-Area | Score |
|----------|-------|
| Balance Formula (used, pending) | 95% |
| Opening Balance | 0% — CRITICAL FAILURE |
| Accrual Integration | 90% |
| Carry Forward Integration | 85% |
| Encashment Integration | 70% — indirect, misleading |
| Initialization | 80% |
| Frontend Display | 70% — no breakdown |

**BALANCE AUDIT OVERALL: 70/100**
