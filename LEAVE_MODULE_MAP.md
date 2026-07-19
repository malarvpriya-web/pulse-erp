# LEAVE MODULE MAP
## Complete Inventory — Pulse ERP Leave Management System
**Audit Date:** 2026-06-12  
**Auditor Role:** CHRO / HR Operations Head / ERP Architect  
**Verification:** All paths verified against actual files — no assumptions

---

## 1. BACKEND ROUTES

### 1.1 Main Leave Routes
**File:** `backend/server.js` → mounts at `/api/v1/leaves`  
**Route File:** `backend/src/modules/leaves/routes/leaves.routes.js`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/leaves/types` | GET | List all active leave types |
| `/leaves/types` | POST | Create new leave type |
| `/leaves/types/:id` | PUT | Update leave type |
| `/leaves/types/:id` | DELETE | Soft-delete leave type |
| `/leaves/balance` | GET | Current user's balance |
| `/leaves/balance/:employee_id` | GET | Specific employee's balance |
| `/leaves/balance/initialize` | POST | Initialize balance for new employee |
| `/leaves/bulk-allocate` | POST | Bulk allocate to all employees |
| `/leaves/allocations` | GET | All allocations (admin view) |
| `/leaves/allocate` | POST | Create/update single allocation |
| `/leaves/applications` | GET | List applications (filtered) |
| `/leaves/applications/:id` | GET | Single application detail |
| `/leaves/applications/:id/history` | GET | Approval history |
| `/leaves/apply` | POST | Submit leave application |
| `/leaves/approve/manager/:id` | POST | L1 Manager approval |
| `/leaves/reject/manager/:id` | POST | L1 Manager rejection |
| `/leaves/approve/l2/:id` | POST | L2 Dept Head approval |
| `/leaves/reject/l2/:id` | POST | L2 Dept Head rejection |
| `/leaves/approve/hr/:id` | POST | L3 HR final approval |
| `/leaves/reject/hr/:id` | POST | L3 HR final rejection |
| `/leaves/bulk-approve` | POST | Bulk approve (HR/Admin) |
| `/leaves/applications/:id/status` | PUT | Generic status update (HR/Admin) |
| `/leaves/calendar` | GET | Approved leaves for calendar |
| `/leaves/analytics` | GET | Leave analytics by type |
| `/leaves/` | GET | Compat shim — all applications |
| `/leaves/` | POST | Compat shim — apply |
| `/leaves/my` | GET | Current user's applications |
| `/leaves/team` | GET | Team's applications (role-scoped) |
| `/leaves/:id/approve` | PATCH/PUT | Legacy approval shim |
| `/leaves/:id/reject` | PATCH/PUT | Legacy reject shim |
| `/leaves/:id/cancel` | PUT | Cancel leave (employee/HR) |
| `/leaves/:id` | PUT | Generic status update |
| `/leaves/on-leave-today` | GET | Employees on leave today |
| `/leaves/delegate/:id` | POST | Manager delegates approver |
| `/leaves/accrual-history` | GET | Per-employee monthly accrual log |
| `/leaves/carry-forward-report` | GET | Annual carry-forward audit |
| `/leaves/:id/workflow` | GET | Workflow engine status |
| `/leaves/:id/workflow/advance` | POST | Advance workflow step |

### 1.2 Comp Off Routes
**File:** `backend/src/modules/leaves/routes/compoff.routes.js`  
**Mount:** `/api/v1/comp-off`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/comp-off` | GET | List comp off records (role-scoped) |
| `/comp-off` | POST | Submit new comp off request |
| `/comp-off/approve/:id` | POST | Approve → credits leave balance |
| `/comp-off/reject/:id` | POST | Reject request |
| `/comp-off/expire` | POST | Manual expiry trigger |
| `/comp-off/balance/:employee_id` | GET | Comp off balance summary |

### 1.3 Leave Encashment Routes
**File:** `backend/src/modules/leaves/routes/encashment.routes.js`  
**Mount:** `/api/v1/leave-encashment`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/leave-encashment` | GET | List encashment records |
| `/leave-encashment` | POST | Create encashment record (HR) |
| `/leave-encashment/approve/:id` | POST | Approve + deduct balance + payroll post |
| `/leave-encashment/reject/:id` | POST | Reject/cancel encashment |
| `/leave-encashment/eligible/:employee_id` | GET | Check eligibility & max encashable |

### 1.4 Accrual Routes
**File:** `backend/src/modules/leaves/routes/accrual.routes.js`  
**Mount:** `/api/v1/leave-accrual`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/leave-accrual/run` | POST | Manual monthly accrual trigger |
| `/leave-accrual/carry-forward` | POST | Year-end carry forward |
| `/leave-accrual/expire` | POST | Expire stale carry-forward balances |

### 1.5 Holiday Routes
**File:** `backend/src/modules/holidays/routes/holidays.routes.js`  
**Mount:** `/api/v1/holidays`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/holidays` | GET | List holidays (year/zone/upcoming filters) |
| `/holidays` | POST | Create holiday + auto attendance sync |
| `/holidays/:id` | PATCH | Edit holiday |
| `/holidays/:id` | DELETE | Delete + reverse attendance |

### 1.6 Leave Reports Routes
**File:** `backend/src/modules/reports/routes/reports.routes.js`  
**Mount:** `/api/v1/reports`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/reports/leave` | GET | Leave summary report |
| `/reports/leave/summary` | GET | Employee balance summary |
| `/reports/leave/liability` | GET | Leave liability (₹) report |
| `/reports/leave/lop` | GET | LOP report |
| `/reports/leave/department` | GET | Department leave summary |
| `/reports/leave/approval-performance` | GET | Approver SLA performance |

---

## 2. BACKEND SERVICES / REPOSITORIES

### 2.1 Repository
**File:** `backend/src/modules/leaves/repositories/leaves.repository.js`

Functions:
- `getLeaveTypes()` — fetch active types
- `getLeaveBalance(employee_id, year)` — normalized balance with pending subquery
- `initializeLeaveBalance(employee_id, year)` — seed new employee balance
- `applyLeave(data)` — insert application
- `findApplications(filters)` — filtered list with JOINs
- `findById(id)` — single with JOINs
- `approveByManager(id, manager_id, comments)` — L1 approval + history
- `rejectByManager(id, manager_id, comments)` — L1 rejection + history
- `approveByL2(id, l2_approver_id, comments)` — L2 approval + history
- `rejectByL2(id, l2_approver_id, comments)` — L2 rejection + history
- `approveByHR(id, hr_id, comments)` — L3 approval + history + balance increment
- `rejectByHR(id, hr_id, comments)` — L3 rejection + history
- `updateStatus(id, status, actor_id, comments)` — generic status update
- `incrementUsedBalance(client, application)` — update leave_balances.used_days
- `decrementUsedBalance(client, application)` — reverse on cancel
- `createAttendanceForLeave(application)` — auto attendance sync
- `getLeaveCalendar(filters)` — calendar data
- `getLeaveAnalytics(filters)` — analytics aggregation

### 2.2 Reports Repository
**File:** `backend/src/modules/reports/repositories/reports.repository.js`

Leave-related functions:
- `getLeaveReport(filters)` — full leave register
- `getLeaveSummaryReport(filters)` — balance summary CROSS JOIN
- `getLeaveLiabilityReport(filters)` — ₹ liability by employee/type
- `getLOPReport(filters)` — LOP days and deduction
- `getDepartmentLeaveReport(filters)` — department aggregation
- `getApprovalPerformanceReport(filters)` — approver SLA metrics

### 2.3 Frontend Service
**File:** `frontend/src/services/leaveService.js`

Exports: `getLeaves`, `getMyLeaves`, `getTeamLeaves`, `getLeaveApplications`, `getLeaveBalance`, `getLeaveCalendar`, `getLeaveAnalytics`, `applyLeave`, `approveLeave`, `approveLeaveL1`, `approveLeaveL2`, `rejectLeave`, `cancelLeave`, `bulkApproveLeaves`, `getLeaveTypes`, `getCompOffRecords`, `submitCompOff`, `approveCompOff`, `rejectCompOff`, `getCompOffBalance`, `getEncashments`, `createEncashment`, `getEligibleEncashment`, `runAccrual`, `runCarryForward`

---

## 3. CRON JOBS

**File:** `backend/src/jobs/leave.cron.js`  
**Status:** Registered in `backend/server.js` line 148

| Job | Schedule | Timezone |
|-----|----------|----------|
| Monthly Accrual | 1st of month, 01:00 | Asia/Kolkata |
| Year-End Carry Forward | 1 Jan, 02:00 | Asia/Kolkata |
| Carry Forward Expiry | 1st of month, 01:30 | Asia/Kolkata |
| Comp Off Expiry | Daily, 00:30 | Asia/Kolkata |
| Approval SLA Escalation | Weekdays, 09:00 | Asia/Kolkata |

---

## 4. DATABASE TABLES

### 4.1 `leave_types`
**Migration:** `20260424000001_leaves_schema.js` + `20260605000001_leave_policy_attributes.js` + `20260603000001_leave_types_company_scoping.js`

Columns: `id`, `leave_name`, `leave_code`, `annual_quota`, `description`, `is_active`, `deleted_at`, `company_id`, `carry_forward_allowed`, `max_carry_forward_days`, `carry_forward_expiry_months`, `accrual_type`, `accrual_days_per_month`, `allow_negative_balance`, `requires_attachment`, `requires_medical_cert_days`, `min_notice_days`, `max_consecutive_days`, `allow_half_day`, `is_encashable`, `max_encash_days_per_year`, `gender_restriction`, `allowed_in_probation`, `is_paid`, `is_lop_type`, `is_comp_off_type`, `sandwich_rule`, `include_holidays`, `include_weekends`

**Seeded Types:** Annual Leave, Sick Leave, Casual Leave, Compensatory Leave, Maternity Leave, Paternity Leave, Earned Leave, Privilege Leave, Bereavement Leave, Marriage Leave, Loss of Pay, On Duty, Training Leave, Plant Shutdown, Work From Home, Optional Holiday, Sabbatical, Safety Training, Study Leave, Travel Leave, Emergency Leave, Site Leave, Shutdown Leave, Field Duty Leave

### 4.2 `leave_balances`
**Migration:** `20260424000001` + `20260605000001`

Columns: `id`, `employee_id`, `leave_type_id`, `year`, `allocated_days`, `used_days`, `encashed_days`, `carried_forward_days`, `opening_balance`, `updated_at`  
Constraint: UNIQUE (employee_id, leave_type_id, year)

### 4.3 `leave_applications`
**Migration:** `20260424000001` + `20260527000001` + `20260605000001` + `20260609000001`

Columns: `id`, `employee_id`, `leave_type_id`, `start_date`, `end_date`, `number_of_days`, `reason`, `attachment_url`, `manager_id`, `manager_status`, `manager_comments`, `manager_approved_at`, `l2_approver_id`, `l2_status`, `l2_comments`, `l2_approved_at`, `hr_id`, `hr_status`, `hr_comments`, `hr_approved_at`, `status`, `half_day`, `half_day_session`, `is_lop`, `clubbing_flag`, `withdrawal_reason`, `delegate_approver_id`, `applied_at`, `deleted_at`, `created_at`, `updated_at`

### 4.4 `leave_approval_history`
**Migration:** `20260424000001` + `20260527000001`

Columns: `id`, `leave_application_id`, `approver_id`, `approval_level (1/2/3)`, `action`, `comments`, `created_at`

### 4.5 `leave_policies`
**Migration:** `20260605000001`

Columns: `id`, `company_id`, `leave_type_id`, `policy_name`, `accrual_type`, `accrual_days_per_month`, `accrual_start`, `probation_allowed`, `notice_period_allowed`, `min_notice_days`, `max_consecutive_days`, `sandwich_rule`, `include_weekends`, `include_holidays`, `carry_forward_allowed`, `max_carry_forward_days`, `carry_forward_expiry_months`, `allow_negative_balance`, `requires_attachment`, `requires_medical_cert_days`, `gender_restriction`, `department_restriction`, `is_active`

### 4.6 `compensatory_off`
**Migration:** `20260605000001` + `20260609000001`

Columns: `id`, `employee_id`, `work_date`, `hours_worked`, `holiday_id`, `reason`, `status (pending/approved/rejected/used)`, `approved_by`, `approved_at`, `comments`, `expires_on`, `credited`, `company_id`, `project_id`, `created_at`, `updated_at`

### 4.7 `leave_encashments`
**Migration:** `20260605000001`

Columns: `id`, `employee_id`, `leave_type_id`, `year`, `days_encashed`, `rate_per_day`, `gross_amount`, `tds_amount`, `net_amount`, `encashment_month`, `encashment_year`, `payroll_run_id`, `status (pending/approved/paid/cancelled)`, `approved_by`, `approved_at`, `reason`, `company_id`, `created_at`, `updated_at`

### 4.8 `holidays`
**Migration:** `20260531000006_holiday_zones.js` + `20260601000008` + `20260604000001`

Columns: `id`, `name`, `date`, `type`, `description`, `company_id`, `zone_id`, `created_at`, `updated_at`

---

## 5. FRONTEND PAGES

**Base path:** `frontend/src/features/leaves/pages/`

| Page | File | Navigation ID | Roles |
|------|------|--------------|-------|
| My Leaves | `MyLeaves.jsx` | leaves.my | All |
| Apply Leave | `ApplyLeave.jsx` | leaves.apply | All |
| Leave Approvals | `LeaveApprovals.jsx` | leaves.approvals | Manager, HR, Admin |
| Team Leaves | `TeamLeaves.jsx` | leaves.team | Manager, HR, Admin |
| Leave Calendar | `LeaveCalendar.jsx` | leaves.calendar | All |
| Holiday Calendar | `HolidayCalendar.jsx` | leaves.holidays | All |
| Comp Off | `CompOffPage.jsx` | leaves.compoff | All |
| All Leaves | `AllLeaves.jsx` | leaves.all | Admin, HR |
| Leave Reports | `LeaveReports.jsx` | leaves.reports | Admin, HR |
| Leave Encashment | `LeaveEncashmentPage.jsx` | leaves.encashment | Admin, HR |
| Leave Settings | `LeaveSettings.jsx` | leaves.settings | Admin, HR |

**Also registered under HR module:**
- `HolidayCalendar` at `hr.holiday` (separate from leaves.holidays — DUPLICATE)
- `AllLeaves` at `hr.leave_mgmt` (DUPLICATE of leaves.all)

**Dashboard Widget:**
- `frontend/src/components/dashboard/widgets/MyLeaveWidget.jsx`

---

## 6. MIGRATION TIMELINE

| Migration | Date | Purpose |
|-----------|------|---------|
| `20260424000001_leaves_schema.js` | 2026-04-24 | Initial schema: leave_types, leave_balances, leave_applications, leave_approval_history |
| `20260527000001_leave_l2_approval.js` | 2026-05-27 | L2 approver columns, approval_level up to 3 |
| `20260531000006_holiday_zones.js` | 2026-05-31 | Holiday zone support, master_zones |
| `20260601000008_holidays_company_id.js` | 2026-06-01 | company_id on holidays |
| `20260603000001_leave_types_company_scoping.js` | 2026-06-03 | company_id on leave_types |
| `20260604000001_holidays_dedup_unique.js` | 2026-06-04 | Unique constraint on holidays |
| `20260605000001_leave_policy_attributes.js` | 2026-06-05 | Full policy columns, leave_policies, compensatory_off, leave_encashments |
| `20260609000001_leave_module_hardening.js` | 2026-06-09 | project_id on comp-off, delegate_approver_id, payroll_runs.leave_encashment_amount, industrial leave types |

---

## 7. AUDIT CONFIGURATION

- **Approval Levels:** L1 (Manager) → L2 (Dept Head, optional) → L3 (HR)
- **Attendance Sync:** Automatic on approval, reverse on rejection/cancellation
- **Holiday Sync:** Automatic on holiday create/delete
- **Notifications:** WorkflowNotificationService — submitted, approved, rejected, escalated, leave_milestone_conflict
- **Audit Trail:** logAudit on all CUD operations
- **Permissions:** requirePermission('leaves', 'view/add/edit/delete/approve')
- **Company Scoping:** All tables have company_id, req.scope?.company_id used throughout
