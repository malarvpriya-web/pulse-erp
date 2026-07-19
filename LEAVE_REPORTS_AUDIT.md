# LEAVE REPORTS AUDIT
## All Reports, Exports (CSV / Excel / PDF)
**Audit Date:** 2026-06-12  
**Source:** LeaveReports.jsx, reports.routes.js, reports.repository.js

---

## 1. AVAILABLE REPORTS

### 1.1 Leave Register
**Endpoint:** GET `/reports/leave`  
**Filters:** year, month, department, employee_id, status, leave_type_id  
**Fields:** Employee name, Department, Leave type, Start date, End date, Days, Status, Applied date, Manager, HR, Reason  
**Export:** CSV (client-side Blob)

### 1.2 Leave Balance Summary
**Endpoint:** GET `/reports/leave/summary`  
**Logic:** CROSS JOIN leave_types × employees → shows full balance sheet per employee × type  
**Fields:** Employee, Leave type, Allocated, Used, Pending, Available, Carry Forward, Encashed  
**Export:** CSV

### 1.3 Leave Liability Report
**Endpoint:** GET `/reports/leave/liability`  
**Logic:** `available_days × (basic_salary / 26) = liability per employee per type`  
**Fields:** Employee, Leave type, Available days, Rate/day, Liability (₹), Department  
**Export:** CSV  
**Use case:** Financial provisioning — how much the company "owes" employees in unconsumed leave

### 1.4 LOP Report
**Endpoint:** GET `/reports/leave/lop`  
**Logic:** `leave_applications WHERE is_lop=true OR leave_types.is_lop_type=true`  
**Fields:** Employee, Department, LOP days, Month, Salary impact (₹)  
**Export:** CSV

### 1.5 Department Leave Summary
**Endpoint:** GET `/reports/leave/department`  
**Logic:** GROUP BY department  
**Fields:** Department, Total employees, Total leave days, Average per employee, Leave by type breakdown  
**Export:** CSV

### 1.6 Approval Performance Report
**Endpoint:** GET `/reports/leave/approval-performance`  
**Logic:** Reads leave_approval_history, calculates avg approval time per approver  
**Fields:** Approver name, Level, Total approved, Total rejected, Avg turnaround (days), SLA breaches  
**Export:** CSV

---

## 2. EXPORT FORMATS

**Available:**
- ✅ CSV — client-side generation via Blob API

**Missing:**
- ❌ Excel (.xlsx) — no server-side Excel generation
- ❌ PDF — no PDF report generation
- ❌ Print view — no printer-friendly layout

---

## 3. FILTERS AVAILABLE IN UI (LeaveReports.jsx)

| Filter | Available |
|--------|-----------|
| Year | ✅ Dropdown |
| Month | ✅ Dropdown |
| Department | ✅ Dropdown |
| Status | ✅ Dropdown |
| Report type | ✅ 6 options |
| Employee | ❌ Not in filter UI (passed via URL for direct links only) |
| Leave type | ❌ Not in filter UI |

---

## 4. STATUTORY REPORTS MISSING

| Report | Required By | Status |
|--------|------------|--------|
| Annual Leave Register (Form A) | Factories Act 1948 | ❌ Missing |
| Leave Account per employee | Factories Act | ❌ Missing (balance summary is close) |
| Encashment statement | Income Tax | ❌ Missing |
| LOP register with payroll deduction | Payroll audit | ⚠ LOP report exists but deduction not linked |
| Maternity benefit register | Maternity Benefit Act | ❌ Missing |

---

## 5. REPORTS AUDIT SCORECARD

| Report | Status | Score |
|--------|--------|-------|
| Leave register | ✅ | 100% |
| Balance summary | ✅ | 90% |
| Liability report | ✅ | 90% |
| LOP report | ✅ | 80% |
| Department summary | ✅ | 90% |
| Approval performance | ✅ | 90% |
| CSV export | ✅ | 100% |
| Excel export | ❌ | 0% |
| PDF export | ❌ | 0% |
| Factories Act Form A | ❌ | 0% |
| Maternity benefit register | ❌ | 0% |
| Employee filter in UI | ❌ | 20% |
| Leave type filter in UI | ❌ | 20% |

**REPORTS OVERALL: 70/100**
