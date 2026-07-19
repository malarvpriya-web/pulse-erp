# LEAVE CONSOLIDATION PLAN
## Duplication Elimination, Dead Code, Architecture Cleanup
**Audit Date:** 2026-06-12

---

## 1. DEAD CODE — IMMEDIATE REMOVAL

### 1.1 `createAttendanceForLeave` in leaves.repository.js
**Problem:** Orphaned function using wrong status strings (`'Half Day'`, `'On Leave'`) vs the active `syncLeaveToAttendance` (`'half_day'`, `'on_leave'`). Source tag missing. Never called in approval flow.  
**Action:** Delete `createAttendanceForLeave` from `leaves.repository.js`  
**Risk of removal:** Zero — confirmed unused in active code paths

### 1.2 Legacy Approval Shims
**Routes:** `PATCH /:id/approve`, `PUT /:id/approve`, `PATCH /:id/reject`, `PUT /:id/reject`  
**Problem:** Backward-compat aliases that may not call `syncLeaveToAttendance` — attendance sync gap risk  
**Action:** Verify each shim calls sync, then deprecate or merge into `/approve/hr/:id`

---

## 2. DUPLICATE PAGES — CONSOLIDATION

### 2.1 HolidayCalendar.jsx — Two Copies
| File | Module | Navigation ID |
|------|--------|--------------|
| `frontend/src/features/leaves/pages/HolidayCalendar.jsx` | Leaves | `leaves.holidays` |
| `frontend/src/features/hr/pages/HolidayCalendar.jsx` | HR | `hr.holiday` |

**Action:** Read HR version, compare with leaves version, merge into single shared component at `frontend/src/features/leaves/pages/HolidayCalendar.jsx`. Update `hr.holiday` navigation entry to import from leaves path.

### 2.2 AllLeaves.jsx — Two Navigation Entries
| Location | Navigation ID |
|----------|--------------|
| Leaves module | `leaves.all` |
| HR module | `hr.leave_mgmt` |

**Action:** Both already point to the same component file. Remove `hr.leave_mgmt` entry from HR module in `moduleRegistry.js` — it's redundant.

---

## 3. UNUSED DB TABLE — leave_policies

**Table:** `leave_policies` — created in migration 20260605, comprehensive schema, NEVER read or written by application code.

**Options:**
1. **Implement it:** Add CRUD API + UI in LeaveSettings.jsx "Policy Rules" tab, use leave_policies for per-company overrides instead of leave_types columns
2. **Drop it:** Remove table and migration if per-company policy overrides are out of scope

**Recommendation:** Implement Option 1 — the table is already designed and seeded. The "Policy Rules" tab in LeaveSettings.jsx already exists (informational only). Activating it completes a half-built feature.

---

## 4. leaveService.js — approveLeave() Fix

**Problem:** `approveLeave()` always calls `/leaves/approve/hr/:id` regardless of caller role.

**Fix:**
```javascript
// BEFORE (broken)
approveLeave: (id, data) => apiClient.post(`/leaves/approve/hr/${id}`, data),

// AFTER (role-aware — or remove entirely, use specific L1/L2/L3 functions)
// Option A: Rename to approveLeaveHR and update all callers explicitly
approveLeaveHR: (id, data) => apiClient.post(`/leaves/approve/hr/${id}`, data),
// Option B: Accept level parameter
approveLeave: (id, level, data) => {
  const endpoints = { 1: 'manager', 2: 'l2', 3: 'hr' };
  return apiClient.post(`/leaves/approve/${endpoints[level]}/${id}`, data);
}
```

**Components to update after fix:** `LeaveApprovals.jsx` — verify it uses `approveLeaveL1`, `approveLeaveL2`, `approveLeave` correctly per tab.

---

## 5. BACKEND ROUTE DUPLICATION

### 5.1 Dual Mount
```javascript
v1Router.use("/leaves", verifyToken, leavesNewRoutes);
v1Router.use("/leaves-new", verifyToken, leavesNewRoutes); // backward-compat alias
```

**Action:** Search frontend for any calls to `/leaves-new/*`. If none, remove the alias mount.

### 5.2 Dual Apply Endpoints
- `POST /leaves/apply` (explicit, enforces all policies)
- `POST /leaves/` (compat shim)

**Action:** Verify no frontend uses `POST /leaves/` directly, then remove the shim.

---

## 6. OPENING BALANCE — IMPLEMENTATION

**Current state:** Column exists, always 0.

**Fix:** Three write points needed:
```javascript
// 1. In carry-forward cron / POST /leave-accrual/carry-forward:
await db.query(`
  INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (employee_id, leave_type_id, year)
  DO UPDATE SET allocated_days = leave_balances.allocated_days + EXCLUDED.carried_forward_days,
                carried_forward_days = EXCLUDED.carried_forward_days,
                opening_balance = EXCLUDED.opening_balance  -- ← SET THIS
`, [emp_id, lt_id, next_year, cf_days, cf_days, cf_days]);

// 2. In POST /leaves/balance/initialize (new employee):
opening_balance = manual_allocation_amount (if provided)

// 3. In POST /leaves/allocate (HR manual adjustment):
// If year is newly starting, set opening_balance = allocated_days
```

---

## 7. CONSOLIDATION PRIORITY ORDER

| Priority | Item | Effort | Risk |
|----------|------|--------|------|
| P0 | Fix opening_balance write | Small (3 code points) | Low |
| P0 | Fix leaveService.approveLeave() | Small (rename + caller update) | Low |
| P0 | Delete createAttendanceForLeave dead code | Tiny (delete one function) | Zero |
| P1 | Activate leave_policies CRUD | Medium (API + UI) | Medium |
| P1 | Fix manual POST /comp-off/expire balance reversal | Small (add balance update) | Low |
| P1 | Fix TDS calculation (10% → slab-based) | Medium | Low |
| P2 | Merge duplicate HolidayCalendar.jsx | Small | Low |
| P2 | Remove hr.leave_mgmt duplicate nav entry | Tiny | Zero |
| P2 | Add zone selector to HolidayCalendar add modal | Small | Low |
| P2 | Remove /leaves-new alias | Tiny | Zero |
| P3 | Add accrual audit trail table | Medium | Low |
| P3 | Add Excel/PDF export to LeaveReports | Large | Low |
| P3 | Implement L2 mandatory config | Medium | Medium |
| P3 | Implement withdraw endpoint (separate from cancel) | Small | Low |
| P3 | Expose delegation UI | Small | Low |
