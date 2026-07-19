# CUSTOMER HEALTH CALCULATION — Phase 49F

## Scoring Engine: `customerHealth.service.js`

### Dimension 1: Revenue Score (max 20)

**Growth sub-score (0–12):**
| Condition                  | Points |
|----------------------------|--------|
| Revenue growth > 10% YoY   | 12     |
| Revenue growth 0–10% YoY   |  9     |
| Revenue decline 0–10% YoY  |  5     |
| Revenue declining > 10%    |  0     |
| New customer (no prior year)|  9    |

**Order frequency sub-score (0–8):**
| Orders in last 12 months | Points |
|--------------------------|--------|
| 6+                       |  8     |
| 3–5                      |  6     |
| 1–2                      |  3     |
| 0                        |  0     |

### Dimension 2: Collections Score (max 20)

| Condition             | Score |
|-----------------------|-------|
| No overdue invoices   |  20   |
| Overdue ≤ 30 days     |  15   |
| Overdue 31–60 days    |  10   |
| Overdue 90+ days      |   0   |

Additional deductions:
- Avg days to pay > 90d: -5
- Avg days to pay > 60d: -3

### Dimension 3: Profitability Score (max 15)

| Margin %         | Points |
|------------------|--------|
| > 25%            |  15    |
| 15–25%           |  10    |
| 0–15%            |   5    |
| Negative / 0     |   0    |
| AMC-only customer |  8    |

Source: `projects.budget_amount` vs `projects.actual_cost` for completed projects.

### Dimension 4: Project Success Score (max 10)

| Condition                          | Points |
|------------------------------------|--------|
| No projects                        |   7    |
| 0 delayed/failed/overdue           |  10    |
| 1 delayed or overdue               |   7    |
| 2–3 delayed/failed/overdue         |   3    |
| 4+ delayed/failed/overdue          |   0    |

### Dimension 5: Quality Score (max 10)

| Condition                         | Points |
|-----------------------------------|--------|
| No NCRs, no complaints            |  10    |
| Minor NCRs or low complaints      |   7    |
| 3+ NCRs in 12m or open NCRs > 2  |   3    |
| Major NCRs > 2 or complaints > 5  |   0    |

### Dimension 6: Service Score (max 10)

| Condition                                  | Points |
|--------------------------------------------|--------|
| No tickets                                 |   8    |
| Close rate ≥ 90% AND avg resolution ≤ 7d   |  10    |
| Close rate ≥ 75%                           |   7    |
| Any critical open ticket                   |   0    |
| 5+ open tickets                            |   3    |
| Otherwise                                  |   5    |

### Dimension 7: AMC Score (max 5)

| Condition        | Points |
|------------------|--------|
| Active AMC       |   5    |
| No AMC / Expired |   0    |

### Dimension 8: Engagement Score (max 5)

| Touchpoints (visits + emails + activities, last 12m) | Points |
|------------------------------------------------------|--------|
| 10+                                                  |   5    |
| 4–9                                                  |   3    |
| 0–3                                                  |   0    |

### Dimension 9: Risk Buffer Score (max 5)

Derived from the worst risk across Collections, Projects, and Quality:

| Composite Risk | Points |
|----------------|--------|
| All low        |   5    |
| Any medium     |   3    |
| Any high       |   1    |
| Any critical   |   0    |

## Caching
- Individual customer scores: 5-minute TTL
- CEO dashboard aggregate: 2-minute TTL
- Active alerts: 1-minute TTL

## Persistence
- Scores are upserted to `customer_health_scores` on every calculation
- Monthly snapshots stored to `customer_health_history` (first of month)
- Alerts deduplicated per alert_type per 7-day window

## API Endpoints
```
GET  /api/v1/crm/health-engine/dashboard       CEO overview
GET  /api/v1/crm/health-engine/sales           Sales dashboard
GET  /api/v1/crm/health-engine/service         Service dashboard
GET  /api/v1/crm/health-engine/finance         Finance dashboard
GET  /api/v1/crm/health-engine/projects        Project dashboard
GET  /api/v1/crm/health-engine/alerts          Active alerts
GET  /api/v1/crm/health-engine/customer/:id    Single customer health
GET  /api/v1/crm/health-engine/customer/:id/trend  12-month trend
POST /api/v1/crm/health-engine/recalculate/:id     Trigger recalculation
POST /api/v1/crm/health-engine/recalculate-all     Bulk recalculation
```
