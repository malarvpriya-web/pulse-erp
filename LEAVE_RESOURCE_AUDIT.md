# LEAVE RESOURCE AUDIT
## Project Milestone Conflict Detection
**Audit Date:** 2026-06-12  
**Source:** leaves.routes.js (notifyProjectMilestoneConflict), migration 20260609000001

---

## 1. FEATURE OVERVIEW

**Purpose:** Alert manager/HR when an employee applies leave that conflicts with a project milestone within ±3 calendar days.

**Trigger:** On POST /leaves/apply (new leave submission)  
**Not triggered on:** Approval, rejection, or cancellation

---

## 2. IMPLEMENTATION

### 2.1 notifyProjectMilestoneConflict Function

**Location:** `leaves.routes.js` — inline function

```javascript
async function notifyProjectMilestoneConflict(application) {
  const { employee_id, start_date, end_date, company_id } = application;
  
  // Find milestones within ±3 days of leave period
  const milestones = await db.query(`
    SELECT m.id, m.name AS milestone_name, m.due_date, p.name AS project_name, p.id AS project_id
    FROM project_milestones m
    JOIN projects p ON p.id = m.project_id
    JOIN project_members pm ON pm.project_id = p.id AND pm.employee_id = ?
    WHERE m.due_date BETWEEN ? - INTERVAL '3 days' AND ? + INTERVAL '3 days'
      AND m.status NOT IN ('completed', 'cancelled')
      AND p.company_id = ?
  `, [employee_id, start_date, end_date, company_id]);
  
  if (milestones.length > 0) {
    await WorkflowNotificationService.send({
      type: 'leave_milestone_conflict',
      employee_id,
      recipients: [application.manager_id],
      data: { milestones, leave_start: start_date, leave_end: end_date }
    });
  }
}
```

---

## 3. VERIFICATION CHECKLIST

| Feature | Status |
|---------|--------|
| ±3 day window | ✅ `BETWEEN start - 3d AND end + 3d` |
| Only active milestones | ✅ `NOT IN ('completed', 'cancelled')` |
| Only employee's projects | ✅ `project_members` join |
| Company scoped | ✅ `p.company_id = ?` |
| Notification to manager | ✅ `recipients: [manager_id]` |
| Comp-off linked to project | ✅ `compensatory_off.project_id` column (no UI) |
| Notified on apply (not approval) | ✅ |

---

## 4. GAPS

| Gap | Severity |
|-----|----------|
| Conflict window hardcoded at 3 days — not configurable | LOW |
| No UI alert shown to employee at apply time — only manager notified | MEDIUM |
| Conflict does NOT block leave application — advisory only | LOW (by design) |
| project_id in comp-off has no UI to assign | MEDIUM |
| No resource calendar view showing leave overlaps with milestones | HIGH |
| No HR dashboard showing team-level leave vs milestone conflicts | HIGH |
| No automatic re-check when milestone dates change | MEDIUM |

---

## 5. PROJECT-LEAVE CALENDAR (MISSING)

**What's missing:**
A resource calendar that shows:
- Employee leaves (approved/pending)
- Project milestones for the same period
- Conflict highlighting

**Current state:** No such view exists in the leave or project module.

---

## RESOURCE AUDIT SCORECARD

| Feature | Status | Score |
|---------|--------|-------|
| Milestone conflict detection | ✅ Backend | 80% |
| ±3 day window | ✅ | 100% |
| Manager notification | ✅ | 100% |
| Employee alert at apply | ❌ | 0% |
| Configurable conflict window | ❌ | 0% |
| Resource calendar view | ❌ | 0% |
| HR conflict dashboard | ❌ | 0% |
| Comp-off project linking (UI) | ❌ | 0% |

**RESOURCE AUDIT OVERALL: 47/100**
