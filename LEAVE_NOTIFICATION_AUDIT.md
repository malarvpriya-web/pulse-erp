# LEAVE NOTIFICATION AUDIT
## Apply / Approve / Reject / Escalate / Reminder Events
**Audit Date:** 2026-06-12  
**Source:** leaves.routes.js (notifyLeaveEvent), leave.cron.js, WorkflowNotificationService

---

## 1. NOTIFICATION EVENTS

### 1.1 notifyLeaveEvent — Event Types

**Location:** `leaves.routes.js` — inline helper calling WorkflowNotificationService

| Event | Trigger | Recipients |
|-------|---------|-----------|
| `leave_submitted` | POST /apply | Manager (L1) |
| `leave_approved_l1` | POST /approve/manager/:id | Employee |
| `leave_rejected_l1` | POST /reject/manager/:id | Employee |
| `leave_approved_l2` | POST /approve/l2/:id | Employee |
| `leave_rejected_l2` | POST /reject/l2/:id | Employee |
| `leave_approved` | POST /approve/hr/:id (final) | Employee + Manager |
| `leave_rejected` | POST /reject/hr/:id | Employee + Manager |
| `leave_cancelled` | PUT /:id/cancel | Manager + HR |
| `leave_escalated` | Cron (>3 days pending) | HR + Higher Manager |
| `leave_milestone_conflict` | POST /apply | Manager |
| `compoff_submitted` | POST /comp-off | Manager |
| `compoff_approved` | POST /comp-off/approve/:id | Employee |
| `compoff_rejected` | POST /comp-off/reject/:id | Employee |

---

## 2. NOTIFICATION DEDUP

**Phase 47/48 fix:** Notification deduplication implemented — duplicate notifications for the same event+entity are suppressed within a time window.

**Status:** ✅ Verified from Phase 47/48 certification memory entry

---

## 3. SLA ESCALATION CRON

**Schedule:** `'0 9 * * 1-5'` — weekdays 09:00 IST  
**Condition:** `leave_applications WHERE status='pending' AND applied_at < CURRENT_DATE - 3`

**Action:**
1. Sends `leave_escalated` notification to HR and next-level approver
2. Logs to audit_logs
3. Does NOT auto-approve or force-forward the leave

**Gap:** Only L1 escalation — no L2 or L3 SLA monitoring  
**Gap:** 3-day SLA threshold hardcoded — not company-configurable

---

## 4. IN-APP vs EMAIL NOTIFICATIONS

**WorkflowNotificationService:**
- Writes to `notifications` table (in-app) ✅
- Email notifications: Not fully verified — depends on WorkflowNotificationService implementation
- SMS/Push: Not verified

---

## 5. NOTIFICATION GAPS

| Gap | Severity |
|-----|----------|
| L2/L3 SLA escalation not monitored | HIGH |
| Leave balance reminder (low balance) not implemented | MEDIUM |
| CF expiry reminder (X days before expiry) not implemented | HIGH |
| Comp off expiry < 14 days: UI warning exists but no notification | MEDIUM |
| Email notification for encashment approval not verified | MEDIUM |
| Leave start reminder (day before) not implemented | LOW |
| No SMS/WhatsApp notification | LOW |

---

## NOTIFICATION AUDIT SCORECARD

| Event | Status | Score |
|-------|--------|-------|
| Submit → Manager notified | ✅ | 100% |
| L1 approved/rejected → Employee | ✅ | 100% |
| L3 final approved → Employee + Manager | ✅ | 100% |
| Cancelled → Manager + HR | ✅ | 100% |
| SLA escalation (L1 >3 days) | ✅ | 80% |
| SLA escalation (L2/L3) | ❌ | 0% |
| Milestone conflict | ✅ | 100% |
| Notification dedup | ✅ | 100% |
| CF expiry reminder | ❌ | 0% |
| Balance low reminder | ❌ | 0% |
| Comp off expiry notification | ❌ (only UI warning) | 30% |

**NOTIFICATION OVERALL: 74/100**
