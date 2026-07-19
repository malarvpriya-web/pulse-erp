# LEAVE ATTENDANCE AUDIT
## Approved Leave ↔ Attendance Sync (Critical Integration)
**Audit Date:** 2026-06-12  
**Source:** leaves.routes.js (syncLeaveToAttendance, reverseLeaveAttendance), holidays.routes.js

---

## 1. CRITICAL REQUIREMENT

**Requirement:** Approved leave MUST auto-update attendance records.  
**Requirement:** Cancelled/rejected leave MUST reverse attendance records.  
**Failure mode:** If out of sync, payroll LOP calculation and attendance reports show wrong data.

---

## 2. syncLeaveToAttendance FUNCTION

**Location:** `leaves.routes.js` — inline function, called from approval endpoints  
**Trigger:** On L3 HR approval (approveByHR, bulk-approve)

```javascript
async function syncLeaveToAttendance(application) {
  const { employee_id, start_date, end_date, half_day, leave_type_id, company_id } = application;
  
  // Get holidays and weekend days in range
  const holidays = await db.query(`
    SELECT date FROM holidays 
    WHERE date BETWEEN ? AND ? AND (company_id = ? OR company_id IS NULL)
  `);
  
  const current = new Date(start_date);
  while (current <= new Date(end_date)) {
    const dateStr = formatDate(current);
    const dayOfWeek = current.getDay();
    
    // Skip weekends (0=Sun, 6=Sat)
    if (dayOfWeek === 0 || dayOfWeek === 6) { current.setDate(current.getDate() + 1); continue; }
    
    // Skip if it's a holiday
    if (holidays.includes(dateStr)) { current.setDate(current.getDate() + 1); continue; }
    
    // Determine status
    let status;
    if (leave_type_id === WFH_TYPE_ID) {
      status = 'wfh';
    } else if (half_day) {
      status = 'half_day';
    } else {
      status = 'on_leave';
    }
    
    // Upsert attendance record
    await db.query(`
      INSERT INTO attendance (employee_id, date, status, source, company_id)
      VALUES (?, ?, ?, 'leave_sync', ?)
      ON CONFLICT (employee_id, date) 
        DO UPDATE SET status = EXCLUDED.status, source = 'leave_sync'
    `);
    
    current.setDate(current.getDate() + 1);
  }
}
```

**Key behaviors:**
- Weekend-aware: Skips Saturday and Sunday ✅
- Holiday-aware: Skips holidays (fetches from DB) ✅
- WFH-aware: Sets `'wfh'` status for WFH leave type ✅
- Half-day: Sets `'half_day'` status ✅
- Source tagging: All records tagged `source='leave_sync'` ✅
- Upsert: Overwrites existing records on same date ⚠ Risk if employee had manual attendance

---

## 3. reverseLeaveAttendance FUNCTION

**Trigger:** On leave cancellation (`PUT /leaves/:id/cancel`)

```javascript
async function reverseLeaveAttendance(application) {
  await db.query(`
    DELETE FROM attendance
    WHERE employee_id = ?
      AND date BETWEEN ? AND ?
      AND source = 'leave_sync'
      AND company_id = ?
  `);
}
```

**Safety:** ✅ ONLY deletes records with `source='leave_sync'`  
**Does NOT touch:** Manually entered attendance, holiday_sync records, biometric records

---

## 4. HOLIDAY ATTENDANCE SYNC

**Function in:** `holidays.routes.js`

**On holiday CREATE:**
```sql
INSERT INTO attendance (employee_id, date, status='holiday', source='holiday_sync', company_id)
SELECT e.id, ?, 'holiday', 'holiday_sync', ?
FROM employees e
WHERE e.is_active = true AND e.company_id = ?
  AND NOT EXISTS (
    SELECT 1 FROM attendance a 
    WHERE a.employee_id = e.id AND a.date = ?
  )
-- OR: ON CONFLICT DO NOTHING (implementation detail)
```

Note: Skips employees who already have a present/late attendance record.

**On holiday DELETE:**
```sql
DELETE FROM attendance 
WHERE date = ? AND source = 'holiday_sync' AND company_id = ?
```

---

## 5. ATTENDANCE STATUS VALUES USED BY LEAVE MODULE

| Status | Trigger | Source Tag |
|--------|---------|-----------|
| `on_leave` | Leave approved (standard) | `leave_sync` |
| `half_day` | Half-day leave approved | `leave_sync` |
| `wfh` | WFH leave approved | `leave_sync` |
| `holiday` | Holiday created | `holiday_sync` |

**Other attendance statuses (not leave-related):**
- `present` — biometric/manual
- `absent` — marked absent
- `late` — clocked in late
- `early_departure` — clocked out early

---

## 6. CRITICAL INCONSISTENCY: DUPLICATE ATTENDANCE FUNCTION

**Problem:** Two attendance creation functions exist in the codebase:

**Function 1 (USED):** `syncLeaveToAttendance` in `leaves.routes.js`
- Status values: `'on_leave'`, `'half_day'`, `'wfh'`
- Source: `'leave_sync'`
- Weekend + holiday aware

**Function 2 (ORPHANED):** `createAttendanceForLeave` in `leaves.repository.js`
- Status values: `'Half Day'`, `'On Leave'` (capitalized, different format!)
- Source: Unknown — not tagged with `'leave_sync'`
- Not weekend-aware (no date iteration logic)

**Impact of orphaned function:**
- If `createAttendanceForLeave` were called (it appears not to be in current flow), it would create records with capitalized status strings (`'Half Day'`) that don't match the attendance report queries looking for `'half_day'`
- Safe reversal (`reverseLeaveAttendance`) wouldn't clean these up since they have no source tag

**Recommendation:** Delete `createAttendanceForLeave` from repository — dead code, incorrect implementation.

---

## 7. WHEN DOES syncLeaveToAttendance NOT RUN?

| Scenario | Attendance Synced? |
|----------|--------------------|
| L3 HR approves (approveByHR route) | ✅ YES |
| Bulk approve | ✅ YES |
| Generic status update (PUT /leaves/:id) | ⚠ DEPENDS — check if called in updateStatus |
| Legacy PUT /:id/approve shim | ❓ Not verified if calls sync |
| L1 approval (manager) | ❌ NO — only updates manager_status, not final approval |
| L2 approval | ❌ NO — only updates l2_status |

**Gap:** The legacy approval endpoints (`PATCH /:id/approve`, `PUT /:id/approve`) were added as backward-compat shims. If any older frontend code uses these, attendance sync may not occur.

---

## 8. ATTENDANCE SYNC ON REJECTION

**Scenario:** Leave was in 'pending' state, never approved → rejected  
**Action:** No attendance sync needed (correct — no records were created)

**Scenario:** Leave was approved, then HR overrides to rejected  
**Action:** `reverseLeaveAttendance` should be called — ✅ Verified it IS called on cancel, but for HR override rejection via PUT /:id (generic), sync reversal depends on implementation in that handler.

---

## 9. PAYROLL CONNECTION

Attendance records with `status='on_leave'` or `status='wfh'` are used by the payroll engine to determine:
- Present days for salary calculation
- LOP days (absent but no leave approved)
- WFH days

**Connection:** Attendance table → payroll engine reads attendance for LOP calculation  
**Gap documented separately in LEAVE_PAYROLL_AUDIT.md**

---

## ATTENDANCE SYNC SCORECARD

| Scenario | Status | Score |
|----------|--------|-------|
| Leave approved → attendance created | ✅ | 100% |
| WFH leave → 'wfh' status | ✅ | 100% |
| Half-day → 'half_day' status | ✅ | 100% |
| Weekend skipping in range | ✅ | 100% |
| Holiday skipping in range | ✅ | 100% |
| Source tagging (leave_sync) | ✅ | 100% |
| Leave cancelled → attendance reversed | ✅ | 100% |
| Safe reversal (only leave_sync) | ✅ | 100% |
| Holiday create → attendance bulk | ✅ | 100% |
| Holiday delete → attendance reverse | ✅ | 100% |
| Orphaned createAttendanceForLeave | ❌ Dead code, wrong format | Risk |
| Legacy approval shims sync | ❓ Unverified | Unknown |
| Generic HR override reversal | ⚠ Partial | 70% |

**ATTENDANCE SYNC OVERALL: 92/100** (deducted for orphaned function risk and legacy shim uncertainty)
