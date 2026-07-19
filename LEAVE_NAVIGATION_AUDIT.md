# LEAVE NAVIGATION AUDIT
## Menu → Route → Component → API → DB Mapping
**Audit Date:** 2026-06-12  
**Verification:** moduleRegistry.js + server.js + route files verified

---

## Navigation Chain Map

### 1. My Leaves
```
Sidebar: "My Leaves" (leaves.my, icon: FileText, all roles)
  └─ Route: /leaves/my
       └─ Component: MyLeaves.jsx
            ├─ API: GET /api/v1/leaves/my  ← leaves.routes.js
            │    └─ DB: leave_applications WHERE employee_id = req.user.employee_id
            └─ API: PUT /api/v1/leaves/:id/cancel
                 └─ DB: UPDATE leave_applications SET status='cancelled'
                        + decrementUsedBalance → UPDATE leave_balances
                        + reverseLeaveAttendance → DELETE attendance WHERE source='leave_sync'
```

### 2. Apply Leave
```
Sidebar: "Apply Leave" (leaves.apply, icon: PlusCircle, all roles)
  └─ Route: /leaves/apply
       └─ Component: ApplyLeave.jsx
            ├─ API: GET /api/v1/leaves/balance/:empId
            │    └─ DB: leave_balances, leave_applications (pending subquery)
            ├─ API: GET /api/v1/leaves/types
            │    └─ DB: leave_types WHERE is_active=true
            ├─ API: GET /api/v1/holidays
            │    └─ DB: holidays
            ├─ API: GET /api/v1/employees  (admin only — to pick employee)
            │    └─ DB: employees
            ├─ API: POST /api/v1/documents/upload  (attachment)
            │    └─ File storage (local/S3)
            └─ API: POST /api/v1/leaves/apply
                 └─ DB: INSERT INTO leave_applications
                        Policy checks: balance, min_notice_days, max_consecutive_days,
                        requires_attachment, gender_restriction, probation, sandwich, overlap
```

### 3. Leave Approvals
```
Sidebar: "Leave Approvals" (leaves.approvals, icon: CheckSquare)
  Roles: manager, team_lead, department_head, l2_approver, hr, hr_manager, admin, super_admin
  └─ Route: /leaves/approvals
       └─ Component: LeaveApprovals.jsx
            ├─ Tab "L1 Manager":
            │    ├─ API: GET /api/v1/leaves/applications?manager_status=pending
            │    │    └─ DB: leave_applications + JOINs
            │    ├─ API: POST /api/v1/leaves/approve/manager/:id
            │    │    └─ DB: UPDATE manager_status='approved', leave_approval_history
            │    │           + syncLeaveToAttendance (if final approval) — NOT triggered here
            │    ├─ API: POST /api/v1/leaves/reject/manager/:id
            │    └─ API: POST /api/v1/leaves/bulk-approve
            ├─ Tab "L2 Dept Head":
            │    ├─ API: GET /api/v1/leaves/applications?l2_status=pending
            │    ├─ API: POST /api/v1/leaves/approve/l2/:id
            │    │    └─ DB: UPDATE l2_status='approved', leave_approval_history
            │    └─ API: POST /api/v1/leaves/reject/l2/:id
            ├─ Tab "L3 HR Final":
            │    ├─ API: GET /api/v1/leaves/applications?hr_status=pending
            │    ├─ API: POST /api/v1/leaves/approve/hr/:id
            │    │    └─ DB: UPDATE hr_status='approved', status='approved', leave_approval_history
            │    │           + incrementUsedBalance → leave_balances.used_days++
            │    │           + syncLeaveToAttendance → INSERT attendance (source='leave_sync')
            │    └─ API: POST /api/v1/leaves/reject/hr/:id
            └─ Detail Drawer:
                 └─ API: GET /api/v1/leaves/applications/:id/history
                      └─ DB: leave_approval_history ORDER BY level
```

### 4. Team Leaves
```
Sidebar: "Team" (leaves.team, icon: Users)
  Roles: manager, team_lead, department_head, l2_approver, hr, admin
  └─ Route: /leaves/team
       └─ Component: TeamLeaves.jsx
            └─ API: GET /api/v1/leaves/team
                 └─ DB: leave_applications WHERE manager_id = req.user.employee_id
                        (HR/Admin see all)
```

### 5. Leave Calendar
```
Sidebar: "Calendar" (leaves.calendar, icon: Calendar, all roles)
  └─ Route: /leaves/calendar
       └─ Component: LeaveCalendar.jsx
            ├─ API: GET /api/v1/leaves/calendar  (AbortController, on month change)
            │    └─ DB: leave_applications WHERE status='approved' + employee JOINs
            └─ API: GET /api/v1/holidays
                 └─ DB: holidays
```

### 6. Holiday Calendar
```
Sidebar: "Holidays" (leaves.holidays, icon: Star, all roles + hr)
  └─ Route: /leaves/holidays
       └─ Component: HolidayCalendar.jsx (leaves/ version)
            ├─ API: GET /api/v1/holidays
            │    └─ DB: holidays WHERE company_id = req.scope.company_id
            ├─ API: POST /api/v1/holidays  (admin/hr only — create)
            │    └─ DB: INSERT INTO holidays
            │           + Auto: INSERT INTO attendance (status='holiday', source='holiday_sync')
            └─ API: DELETE /api/v1/holidays/:id
                 └─ DB: DELETE FROM holidays
                        + Auto: DELETE FROM attendance WHERE source='holiday_sync' AND date=holiday.date
```

### 7. Comp Off
```
Sidebar: "Comp Off" (leaves.compoff, icon: RefreshCw, all roles)
  └─ Route: /leaves/compoff
       └─ Component: CompOffPage.jsx  [NOTE: moduleRegistry page key is 'CompOff', maps to CompOffPage.jsx]
            ├─ API: GET /api/v1/comp-off
            │    └─ DB: compensatory_off (role-scoped)
            ├─ API: GET /api/v1/comp-off/balance/:empId
            │    └─ DB: compensatory_off aggregate
            ├─ API: GET /api/v1/holidays?upcoming=true
            └─ API: POST /api/v1/comp-off
                 └─ DB: INSERT INTO compensatory_off
                        expires_on = work_date + INTERVAL '3 months'
```

### 8. All Leaves
```
Sidebar: "All Leaves" (leaves.all, icon: List)
  Roles: admin, hr, hr_manager, super_admin
  └─ Route: /leaves/all
       └─ Component: AllLeaves.jsx
            ├─ API: GET /api/v1/leaves/applications  (all employees)
            │    └─ DB: leave_applications + JOINs (all employees in company)
            └─ API: PUT /api/v1/leaves/applications/:id/status  (HR override)
                 └─ DB: UPDATE leave_applications SET status = ?
```

### 9. Leave Reports
```
Sidebar: "Reports" (leaves.reports, icon: BarChart2)
  Roles: admin, hr only
  └─ Route: /leaves/reports
       └─ Component: LeaveReports.jsx
            ├─ API: GET /api/v1/reports/leave
            ├─ API: GET /api/v1/reports/leave/summary
            ├─ API: GET /api/v1/reports/leave/liability
            ├─ API: GET /api/v1/reports/leave/lop
            ├─ API: GET /api/v1/reports/leave/department
            └─ API: GET /api/v1/reports/leave/approval-performance
                 └─ DB: leave_applications, leave_balances, employees, departments (JOINs)
```

### 10. Leave Encashment
```
Sidebar: "Encashment" (leaves.encashment, icon: DollarSign)
  Roles: admin, hr only
  └─ Route: /leaves/encashment
       └─ Component: LeaveEncashmentPage.jsx
            ├─ API: GET /api/v1/leave-encashment
            │    └─ DB: leave_encashments + JOINs
            ├─ API: GET /api/v1/leave-encashment/eligible/:empId
            │    └─ DB: leave_balances, leave_types (is_encashable=true)
            ├─ API: POST /api/v1/leave-encashment
            │    └─ DB: INSERT INTO leave_encashments (rate=basic/26, tds=gross*0.1)
            └─ API: POST /api/v1/leave-encashment/approve/:id
                 └─ DB: TRANSACTION:
                        UPDATE leave_encashments SET status='approved'
                        + UPDATE leave_balances SET encashed_days += days, used_days += days
                        + UPDATE payroll_runs SET leave_encashment_amount += net_amount
```

### 11. Leave Settings
```
Sidebar: "Settings" (leaves.settings, icon: Settings)
  Roles: admin, hr only
  └─ Route: /leaves/settings
       └─ Component: LeaveSettings.jsx
            ├─ Tab "Leave Types":
            │    ├─ API: GET /api/v1/leaves/types
            │    ├─ API: POST /api/v1/leaves/types  (create)
            │    ├─ API: PUT /api/v1/leaves/types/:id  (edit)
            │    └─ API: DELETE /api/v1/leaves/types/:id
            ├─ Tab "Allocations":
            │    ├─ API: GET /api/v1/leaves/allocations
            │    ├─ API: POST /api/v1/leaves/allocate  (single)
            │    └─ API: POST /api/v1/leaves/bulk-allocate  (all employees)
            ├─ Tab "Policy Rules":
            │    └─ INFORMATIONAL ONLY — no CRUD (AUDIT GAP: leave_policies table unused from UI)
            └─ Tab "Accrual & Carry Forward":
                 ├─ API: POST /api/v1/leave-accrual/run
                 ├─ API: POST /api/v1/leave-accrual/carry-forward
                 └─ API: POST /api/v1/leave-accrual/expire
```

### 12. HR Module Duplicates
```
HR Sidebar: "Leave Management" (hr.leave_mgmt)
  └─ Maps to AllLeaves.jsx  — DUPLICATE of leaves.all

HR Sidebar: "Holidays" (hr.holiday)
  └─ Maps to HolidayCalendar.jsx  — DUPLICATE of leaves.holidays
```

---

## Navigation Gaps Identified

| Gap | Severity | Detail |
|-----|----------|--------|
| leave_policies CRUD UI missing | HIGH | Table exists in DB, columns seeded, but Policy Rules tab in LeaveSettings is informational only — no edit UI |
| leaveService.approveLeave() always calls HR endpoint | HIGH | `approveLeave()` in leaveService.js calls `/leaves/approve/hr/:id` regardless of user role — L1/L2 approvals from service always bypass correct endpoint |
| TeamLeaves page — content unknown | MEDIUM | teamleaves.jsx not deeply verified in this audit session |
| Zone selector missing in HolidayCalendar Add modal | MEDIUM | zone_id column exists, GET supports filter, but create modal has no zone selector |
| Comp Off page routing mismatch | LOW | moduleRegistry key='CompOff' but component file is CompOffPage.jsx — mismatch may cause lazy load issues depending on dynamic import |
| HR module duplicates AllLeaves + HolidayCalendar | LOW | Same page reachable from two sidebar locations |
| No dedicated /withdraw endpoint | MEDIUM | withdrawal_reason column exists in DB but no POST /leaves/:id/withdraw — cancel used for both |
