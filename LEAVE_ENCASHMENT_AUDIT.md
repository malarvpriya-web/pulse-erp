# LEAVE ENCASHMENT AUDIT
## Eligibility, Rate Calculation, TDS, Payroll Posting
**Audit Date:** 2026-06-12  
**Source:** encashment.routes.js, LeaveEncashmentPage.jsx, migration 20260605000001

---

## 1. ENCASHMENT TABLE SCHEMA

**Table:** `leave_encashments`  
**Migration:** 20260605000001

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | — |
| employee_id | integer FK | — |
| leave_type_id | integer FK | Must be is_encashable=true |
| year | integer | Encashment year |
| days_encashed | numeric | Number of days encashed |
| rate_per_day | numeric | basic_salary / 26 |
| gross_amount | numeric | days_encashed × rate_per_day |
| tds_amount | numeric | gross_amount × 0.10 |
| net_amount | numeric | gross_amount − tds_amount |
| encashment_month | integer | Month 1-12 |
| encashment_year | integer | Year |
| payroll_run_id | integer FK | → payroll_runs |
| status | varchar CHECK | 'pending','approved','paid','cancelled' |
| approved_by | integer FK | — |
| approved_at | timestamp | — |
| reason | text | — |
| company_id | integer FK | — |

---

## 2. ELIGIBILITY CHECK

**Endpoint:** GET `/leave-encashment/eligible/:employee_id`

**Logic:**
```sql
SELECT lt.leave_name, lt.max_encash_days_per_year,
       lb.allocated_days, lb.used_days, lb.encashed_days,
       GREATEST(0, lb.allocated_days - lb.used_days - lb.encashed_days - lt.max_encash_days_per_year) AS max_encashable_now
FROM leave_types lt
JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.employee_id = ? AND lb.year = CURRENT_YEAR
WHERE lt.is_encashable = true AND lt.is_active = true
```

**Encashable leave types (from seeds):**
- EL (Earned Leave): is_encashable=true, max_encash_days_per_year=15
- PL (Privilege Leave): is_encashable=true, max_encash_days_per_year=15
- SL2 (Site Leave): is_encashable=true, max_encash_days_per_year=3
- FDL (Field Duty Leave): is_encashable=true, max_encash_days_per_year=5

---

## 3. RATE CALCULATION

**Rate per day:** `basic_salary / 26`  
**Source:** `employees.basic_salary` (read at time of encashment creation)  
**Divisor:** 26 — standard working days per month in India

```javascript
// encashment.routes.js
const employee = await db.query(`SELECT basic_salary FROM employees WHERE id = ?`, [employee_id]);
const rate_per_day = Number(employee.basic_salary) / 26;
const gross_amount = days_encashed * rate_per_day;
```

---

## 4. TDS CALCULATION — CRITICAL BUG

**Code:**
```javascript
const tds_amount = gross_amount * 0.1;   // 10% TDS
```

**Comment in code:**
```
// TDS at 30% per Income Tax Act
```

**CRITICAL DISCREPANCY:**
- Code applies **10% TDS**
- Comment says **30% TDS**
- Correct per Indian tax law: Leave encashment TDS depends on employee's income tax slab
  - Exempt up to ₹25L (under Section 10(10AA) for non-government employees at retirement)
  - For mid-service encashment: taxable as salary — should be at applicable slab rate (5%, 20%, or 30%)
  - Hardcoded 10% is incorrect for high-earners

**Impact:** Tax under-deducted for employees in 20% or 30% bracket. Compliance risk.

---

## 5. PAYROLL POSTING

**On encashment approval:**
```javascript
// ATOMIC TRANSACTION
await db.transaction(async (trx) => {
  // 1. Approve encashment record
  await trx('leave_encashments').update({ status: 'approved', approved_by, approved_at });
  
  // 2. Deduct from leave balance
  await trx('leave_balances')
    .where({ employee_id, leave_type_id, year })
    .increment('encashed_days', days_encashed)
    .increment('used_days', days_encashed);
  
  // 3. Post to payroll_runs (if active payroll run exists)
  if (payroll_run_id) {
    await trx('payroll_runs')
      .where({ id: payroll_run_id })
      .increment('leave_encashment_amount', net_amount);
  }
});
```

**Transaction safety:** ✅ Fully atomic — balance deduction and payroll post in one transaction.

**Gap:** Payroll post only happens if `payroll_run_id` is explicitly provided. If no payroll run is linked, the net_amount is approved but NOT posted anywhere. The encashment amount floats as a standalone record without payroll integration.

---

## 6. REJECTION/CANCELLATION

**Endpoint:** POST `/leave-encashment/reject/:id`

```javascript
1. UPDATE leave_encashments SET status='cancelled'
2. Does NOT reverse leave_balances (balance was never debited on pending)
3. Correct — balance only debited on approval
```

---

## 7. FRONTEND (LeaveEncashmentPage.jsx)

### 7.1 Summary Cards
- Total days encashed (current year)
- Gross amount (₹)
- TDS deducted (₹)
- Net amount (₹)

### 7.2 Create Encashment Modal
- Employee picker (admin/hr)
- Leave type picker (filtered to is_encashable=true)
- Shows eligible balance from GET /eligible/:empId
- Days to encash input (validated against max_encashable_now)
- Shows calculated gross, TDS, net before submit

### 7.3 APIs Called
```
GET /api/v1/leave-encashment               → list
GET /api/v1/leave-encashment/eligible/:id  → eligibility check
GET /api/v1/employees                      → employee picker
GET /api/v1/leaves/types                   → leave type picker
POST /api/v1/leave-encashment              → create
POST /api/v1/leave-encashment/approve/:id  → approve
POST /api/v1/leave-encashment/reject/:id   → reject/cancel
```

---

## 8. ENCASHMENT AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Eligibility check | ✅ | 95% |
| Rate calculation (basic/26) | ✅ | 100% |
| TDS calculation | ❌ 10% hardcoded, comment says 30% | 20% |
| Atomic balance deduction | ✅ | 100% |
| Payroll posting | ⚠ Only if payroll_run_id provided | 60% |
| Transaction safety | ✅ | 100% |
| Frontend display | ✅ | 90% |
| Max encash per year cap | ✅ | 100% |
| Status tracking (pending→approved→paid) | ✅ | 90% |
| Rejection/cancellation | ✅ | 100% |
| Slab-based TDS | ❌ Not implemented | 0% |
| Form 12BB / TDS certificate | ❌ Not implemented | 0% |

**ENCASHMENT OVERALL: 73/100**

---

## CRITICAL FINDINGS

| ID | Finding | Severity |
|----|---------|----------|
| ENC-1 | TDS hardcoded at 10% — comment says 30%, law says slab-based | CRITICAL |
| ENC-2 | Payroll posting only if payroll_run_id provided — orphan encashments possible | HIGH |
| ENC-3 | No Form 12BB or TDS certificate generation | HIGH |
| ENC-4 | No salary revision reflection — rate uses current basic_salary, not period-applicable salary | MEDIUM |
| ENC-5 | No encashment on separation/resignation flow | MEDIUM |
| ENC-6 | encashed_days + used_days confusingly lumped together | LOW |
