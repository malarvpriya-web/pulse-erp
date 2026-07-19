# LEAVE CALENDAR AUDIT
## Team / Dept / Company Calendar, Conflict Detection
**Audit Date:** 2026-06-12  
**Source:** LeaveCalendar.jsx, leaves.routes.js (GET /calendar)

---

## 1. LEAVE CALENDAR FRONTEND

**File:** `LeaveCalendar.jsx` (413 lines)  
**Route:** `/leaves/calendar`  
**Access:** All roles

### 1.1 Features
- Interactive monthly grid calendar
- Holiday overlay (dots for each holiday)
- Leave dots per day (up to 5 visible per day)
- Department/employee filter (admin/HR only)
- Click-day detail panel showing who is on leave
- "On leave today" sidebar with employee list
- Monthly summary: total days taken, by type breakdown
- Previous/Next month navigation
- AbortController on month change (cancels stale requests)

### 1.2 APIs Called
```javascript
GET /api/v1/leaves/calendar?month=6&year=2026&department_id=?&employee_id=?
  → Returns approved leaves for the selected month
  → employee filter: admin/HR can filter by any employee
  → department filter: shows entire department's leaves

GET /api/v1/holidays?year=2026
  → Returns all holidays for the year (overlay)
  → Fetched once on mount, not per month
```

---

## 2. BACKEND: GET /leaves/calendar

**Logic:**
```sql
SELECT la.*, e.name, e.department_id, d.name AS department_name, lt.leave_name, lt.leave_code
FROM leave_applications la
JOIN employees e ON e.id = la.employee_id
JOIN leave_types lt ON lt.id = la.leave_type_id
LEFT JOIN departments d ON d.id = e.department_id
WHERE la.status = 'approved'
  AND la.start_date <= last_day_of_month
  AND la.end_date >= first_day_of_month
  AND la.company_id = ?
  [AND e.department_id = ? IF department filter]
  [AND la.employee_id = ? IF employee filter]
ORDER BY la.start_date
```

---

## 3. CONFLICT DETECTION

**Team-level conflict:** The calendar shows multiple employees on the same day, making visual conflict detection possible — but there is no automated alert for "too many people on leave on the same date."

**Minimum staffing enforcement:** ❌ NOT IMPLEMENTED  
**Maximum concurrent leave per department:** ❌ NOT IMPLEMENTED  
**Leave overlap for same employee:** ✅ Detected at apply time (POST /apply overlap check)

---

## 4. ON LEAVE TODAY

**Endpoint:** GET `/leaves/on-leave-today`

```sql
SELECT e.id, e.name, e.department_id, lt.leave_name
FROM leave_applications la
JOIN employees e ON e.id = la.employee_id
JOIN leave_types lt ON lt.id = la.leave_type_id
WHERE la.status = 'approved'
  AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
  AND la.company_id = ?
```

---

## 5. GAPS

| Gap | Severity |
|-----|----------|
| No minimum staffing enforcement | HIGH |
| No maximum leave % per department | HIGH |
| No export of calendar to PDF/Excel | MEDIUM |
| No iCalendar (.ics) export | MEDIUM |
| Holiday dots not distinguished by type (color coding) | LOW |
| Calendar doesn't show pending leaves — only approved | LOW (by design) |
| No recurring leave pattern detection | LOW |

---

## CALENDAR AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Monthly grid view | ✅ | 100% |
| Holiday overlay | ✅ | 100% |
| Leave dots per day | ✅ | 100% |
| Department/employee filter | ✅ Admin/HR | 100% |
| Day detail panel | ✅ | 100% |
| On leave today list | ✅ | 100% |
| AbortController (no stale requests) | ✅ | 100% |
| Conflict detection (same employee) | ✅ At apply time | 100% |
| Minimum staffing enforcement | ❌ | 0% |
| Max concurrent leave | ❌ | 0% |
| Calendar export | ❌ | 0% |
| iCal export | ❌ | 0% |

**CALENDAR OVERALL: 75/100**
