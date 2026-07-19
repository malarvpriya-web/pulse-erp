# CUSTOMER HEALTH ALERTS — Phase 49F-14

## Alert Types

| Alert Type        | Trigger Condition                          | Severity |
|-------------------|--------------------------------------------|----------|
| `revenue_drop`    | Revenue decline > 25% YoY                 | Critical |
| `overdue_90`      | Invoice overdue > 90 days                 | Critical |
| `score_drop`      | Health score dropped > 15 pts vs last month | Critical |
| `low_margin`      | Project margin < 10% (with budget > 0)    | Warning  |
| `repeated_ncr`    | NCRs raised > 3 in last 12 months         | Warning  |
| `repeated_delays` | 2+ projects delayed or overdue            | Warning  |
| `amc_expired`     | AMC expired with no active coverage       | Warning  |

## Deduplication
Alerts of the same `alert_type` for the same customer are not repeated within **7 days** unless the previous alert was resolved.

## Table: `customer_health_alerts`

| Column           | Description                              |
|------------------|------------------------------------------|
| alert_type       | Type identifier (see above)              |
| alert_severity   | `info` \| `warning` \| `critical`        |
| alert_title      | Short human-readable title               |
| alert_message    | Detailed message with metric values      |
| metric_value     | The actual metric that triggered         |
| threshold_value  | The threshold that was breached          |
| is_read          | Marked by user on first view             |
| is_resolved      | Marked resolved by team                  |
| resolved_by      | employee.id who resolved                 |
| triggered_at     | When alert was first generated           |

## Resolution Workflow
1. Alert appears in Health Engine → Alerts tab
2. Responsible team (Sales/Finance/Service/PM) reviews
3. Team takes action (customer call, collections, recovery plan)
4. Marks alert as resolved via `PATCH /api/v1/crm/health-engine/alerts/:id/resolve`
5. If root cause not addressed, alert re-triggers after 7 days

## Integration Points
- CEO Dashboard: Alert count badge on top-right
- Customer 360: `CustomerHealthWidget` shows risk dot
- `CustomerRiskPanel`: Recommended actions per risk type
- `CustomerHealthDashboard`: Dedicated Alerts tab with full list

## Alert Escalation Guidance

| Severity | Response Time  | Who Reviews         |
|----------|----------------|---------------------|
| Critical | Same day       | VP Sales / Finance  |
| Warning  | Within 1 week  | Account Manager     |
| Info     | Next review    | Sales Rep           |
