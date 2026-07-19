# LEAVE DASHBOARD CERTIFICATION
## Live vs Mock Data on Dashboard
**Audit Date:** 2026-06-12  
**Source:** MyLeaveWidget.jsx, dashboard integration

---

## 1. DASHBOARD LEAVE WIDGET

**File:** `frontend/src/components/dashboard/widgets/MyLeaveWidget.jsx`

### 1.1 Data Sources

| Widget Element | API | DB Source | Classification |
|----------------|-----|-----------|----------------|
| My balance per type | GET /leaves/balance | leave_balances + live subquery | **LIVE** |
| My pending requests | GET /leaves/my?status=pending | leave_applications | **LIVE** |
| My approved leaves YTD | GET /leaves/my?status=approved | leave_applications | **LIVE** |
| Holidays this month | GET /holidays?upcoming=true | holidays | **LIVE** |
| On leave today count | GET /leaves/on-leave-today | leave_applications | **LIVE** |

### 1.2 Error States

**Phase 45 audit noted:** Error states were added to silent-catch widgets in Phase 45 dashboard certification.  
**Leave widget:** Has error boundary — shows "Unable to load leave data" on API failure rather than empty/stale data.

---

## 2. APPLY LEAVE PAGE BALANCE CARDS

**Component:** `ApplyLeave.jsx` — balance cards at top  
**Source:** GET /leaves/balance/:empId  
**Classification:** **LIVE** — real-time balance with live pending subquery

---

## 3. LEAVE CALENDAR DASHBOARD

**Component:** `LeaveCalendar.jsx`  
**On leave today sidebar:** GET /leaves/on-leave-today → **LIVE**  
**Monthly summary:** Computed from fetched calendar data → **LIVE**

---

## 4. LEAVE DASHBOARD CERTIFICATION SCORECARD

| Element | Status |
|---------|--------|
| Balance cards | ✅ LIVE |
| Pending applications | ✅ LIVE |
| Approved YTD | ✅ LIVE |
| Holidays | ✅ LIVE |
| On leave today | ✅ LIVE |
| Error states | ✅ Present |
| Hardcoded fallbacks | ❌ None found |

**DASHBOARD CERTIFICATION: PASS — All data LIVE**  
**Score: 100/100**
