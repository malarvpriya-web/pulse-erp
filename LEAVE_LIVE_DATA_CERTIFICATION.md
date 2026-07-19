# LEAVE LIVE DATA CERTIFICATION
## Every Data Source Classified: LIVE / STATIC / DEV / MOCK / HARDCODED
**Audit Date:** 2026-06-12  
**Method:** Verified each data source against actual route handlers, repository queries, frontend components

---

## Classification Legend
- **LIVE** — reads from PostgreSQL at runtime, company_id scoped
- **STATIC** — configuration constant in code, not DB-driven
- **HARDCODED** — literal value baked into UI or response, not from DB
- **DEV/MOCK** — fake data used only for development, not production paths
- **CONDITIONAL** — LIVE when connected, falls back to hardcoded on error

---

## 1. LEAVE BALANCE DATA

| Field | Source | Classification | File |
|-------|--------|----------------|------|
| allocated_days | leave_balances.allocated_days | **LIVE** | leaves.repository.js:getLeaveBalance |
| used_days | Subquery COUNT from leave_applications (approved) | **LIVE** | leaves.repository.js — live compute |
| pending_days | Subquery COUNT from leave_applications (pending) | **LIVE** | leaves.repository.js — live compute |
| carried_forward_days | leave_balances.carried_forward_days | **LIVE** | leaves.repository.js |
| encashed_days | leave_balances.encashed_days | **LIVE** | leaves.repository.js |
| available_days | MAX(0, allocated - used - pending) | **LIVE** | Computed in getLeaveBalance() |
| opening_balance | leave_balances.opening_balance | **LIVE (always 0)** | Column exists, NEVER written — effectively hardcoded 0 |

**⚠ CRITICAL: opening_balance column is always 0** — no code path ever writes to it.

---

## 2. LEAVE TYPES DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Leave type list (GET /leaves/types) | leave_types table | **LIVE** |
| Policy attributes (quota, accrual, etc.) | leave_types columns | **LIVE** |
| Company-level policy overrides | leave_policies table | **DEAD** — table populated by migration seeds only, no code reads from leave_policies to override leave_types |
| Annual quota default seeded values | Migration seeds | **STATIC** — only override by editing leave_types record |

---

## 3. LEAVE APPLICATION DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Application list (all filters) | leave_applications + JOINs | **LIVE** |
| Approval history | leave_approval_history | **LIVE** |
| Employee name/department | employees JOIN | **LIVE** |
| Attachment URL | documents table / S3 path | **LIVE** |
| is_lop flag | Computed on apply (probation + balance check) | **LIVE** |
| Overlap detection | live query on leave_applications | **LIVE** |
| Sandwich rule | leave_types.sandwich_rule + holiday query | **LIVE** |
| Policy enforcement (min_notice, max_consecutive) | leave_types columns at apply time | **LIVE** |

---

## 4. HOLIDAY DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Holiday list | holidays table | **LIVE** |
| Upcoming filter | holidays WHERE date >= NOW() | **LIVE** |
| Zone filter | holidays.zone_id → master_zones | **LIVE** |
| Holiday type (National/State/etc.) | holidays.type column | **LIVE** |
| National holidays pre-seeded | Migration seeds | **STATIC** — used as base; company can add more |
| Zone ID in add modal | NOT exposed in UI | **GAP** — zone_id cannot be set at create time |

---

## 5. COMP OFF DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Comp off records | compensatory_off table | **LIVE** |
| Balance summary (available/pending/expired) | Aggregate query on compensatory_off | **LIVE** |
| Expiry date | work_date + INTERVAL '3 months' (at create time) | **LIVE** |
| Expiry reversal | Cron job daily 00:30 | **LIVE** |
| Project link | compensatory_off.project_id | **LIVE** — column exists, UI does not expose it |

---

## 6. LEAVE ENCASHMENT DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Encashment list | leave_encashments table | **LIVE** |
| Rate per day calculation | basic_salary / 26 | **LIVE** — reads employees.basic_salary |
| TDS calculation | gross_amount * 0.1 | **LIVE** — but incorrect (10%, should be per tax slab) |
| TDS comment in code | "30% TDS" in comment | **HARDCODED WRONG COMMENT** — code does 10% |
| Payroll post (net_amount) | payroll_runs.leave_encashment_amount | **LIVE** — writes on approval |
| Eligible days calculation | leave_balances.allocated_days - used_days - max_encash_days | **LIVE** |

---

## 7. ACCRUAL DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Monthly accrual (auto cron) | leave_types.accrual_days_per_month per company | **LIVE** |
| Pro-rata for mid-month joiners | employees.date_of_joining | **LIVE** |
| Carry forward (auto cron Jan 1) | leave_balances.allocated_days + carried_forward_days | **LIVE** |
| CF expiry (auto cron 1st of month) | leave_balances.carried_forward_days, carry_forward_expiry_months | **LIVE** |
| Accrual audit trail | NO dedicated table — updates leave_balances directly | **GAP** — no per-event history |
| GET /leaves/accrual-history endpoint | Exists in route | **LIVE** — reads from leave_balances history |

---

## 8. LEAVE REPORTS DATA

| Report | Source | Classification |
|--------|--------|----------------|
| Leave register | leave_applications, employees, departments | **LIVE** |
| Leave summary | leave_balances CROSS JOIN leave_types | **LIVE** |
| Leave liability (₹) | leave_balances × salary data | **LIVE** |
| LOP report | leave_applications WHERE is_lop=true | **LIVE** |
| Department summary | GROUP BY department | **LIVE** |
| Approval performance | leave_approval_history, employees | **LIVE** |

---

## 9. CALENDAR DATA

| Field | Source | Classification |
|-------|--------|----------------|
| Approved leaves on calendar | leave_applications WHERE status='approved' | **LIVE** |
| Holiday overlay | holidays table | **LIVE** |
| On-leave-today count | GET /leaves/on-leave-today | **LIVE** |
| AbortController on month change | frontend LeaveCalendar.jsx | **LIVE** — cancels stale requests |

---

## 10. NOTIFICATION DATA

| Notification | Source | Classification |
|-------------|--------|----------------|
| Leave submitted notification | WorkflowNotificationService | **LIVE** |
| Leave approved/rejected | WorkflowNotificationService | **LIVE** |
| SLA escalation (>3 days pending) | Cron weekdays 09:00 + WorkflowNotificationService | **LIVE** |
| Project milestone conflict (±3 days) | live query on projects/milestones | **LIVE** |
| Notification dedup | notifications table | **LIVE** (Phase 47/48 fix) |

---

## 11. DASHBOARD WIDGET DATA

| Widget | Source | Classification |
|--------|--------|----------------|
| MyLeaveWidget.jsx | GET /leaves/my (current user) | **LIVE** |
| Balance summary in ApplyLeave | GET /leaves/balance/:empId | **LIVE** |
| On leave today count | GET /leaves/on-leave-today | **LIVE** |

---

## OVERALL CERTIFICATION SCORECARD

| Category | Status | Score |
|----------|--------|-------|
| Leave Balance | LIVE with 1 dead field (opening_balance) | 90% |
| Leave Types | LIVE (leave_policies table unused) | 85% |
| Applications | LIVE — all fields from DB | 100% |
| Holidays | LIVE (zone UI gap) | 90% |
| Comp Off | LIVE | 95% |
| Encashment | LIVE (TDS % incorrect) | 80% |
| Accrual | LIVE (no audit trail table) | 85% |
| Reports | LIVE | 100% |
| Calendar | LIVE | 100% |
| Notifications | LIVE | 100% |
| Dashboard | LIVE | 100% |

**TOTAL LIVE DATA SCORE: 93/100**

---

## CRITICAL DEAD/BROKEN DATA PATHS

| ID | Issue | Impact |
|----|-------|--------|
| LD-1 | `opening_balance` never written → always 0 | Balance formula incomplete |
| LD-2 | `leave_policies` table completely unused by application code | Per-company policy overrides silently ignored |
| LD-3 | TDS rate hardcoded as 10% (code) vs "30%" (comment) | Tax compliance risk |
| LD-4 | `compensatory_off.project_id` exists but no UI to set/display it | Project-linked comp-off not tracked |
| LD-5 | `zone_id` in HolidayCalendar add modal missing | Zonal holiday assignment impossible from UI |
