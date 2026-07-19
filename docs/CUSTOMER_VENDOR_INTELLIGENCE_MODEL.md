# Customer & Vendor Intelligence Model
## Phase 49H | Pulse ERP

---

## Customer Health Score (0–100)

### Scoring Dimensions

| Dimension | Max Points | Description |
|-----------|-----------|-------------|
| Payment Health | 25 | Deducted per overdue invoice |
| Project Margin | 25 | Based on project profitability |
| Service Health | 25 | Deducted per critical/escalated ticket |
| AMC Engagement | 25 | Active AMC = 25pts, No AMC = 10pts |

### Health Classifications

| Label | Score Range | Color | Meaning |
|-------|------------|-------|---------|
| Excellent | 90–100 | #16a34a (Green) | Healthy, growing, no risk signals |
| Good | 75–89 | #2563eb (Blue) | Stable with minor watchpoints |
| Watchlist | 60–74 | #d97706 (Amber) | Requires proactive management |
| Critical | 0–59 | #dc2626 (Red) | Immediate intervention required |

### Customer Risk Level

Computed independently from health score:

```
Risk Score = Health Factor + Outstanding Factor + NCR Factor + Ticket Factor

Health Factor:  health < 60 → +3, health < 75 → +2, health < 90 → +1
Outstanding:    > ₹5L → +2, > ₹1L → +1
NCR Factor:     open_ncr > 2 → +2, > 0 → +1
Ticket Factor:  critical_tickets > 0 → +2

Risk Level: score ≥ 5 → Critical | ≥ 3 → High | ≥ 1 → Medium | 0 → Low
```

### Growth Classification

- Revenue growth calculated as: `(current_FY_revenue - prev_FY_revenue) / prev_FY_revenue × 100`
- Growth leaders: sorted by highest % growth
- Upsell opportunities: customers without AMC and revenue > ₹5L → "AMC Upsell"
- Rapidly growing accounts → "Expand Account"

---

## Vendor Health Score (0–5)

### Scoring Dimensions (via Vendor Scorecard)

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Quality Score | 20% | Product/service quality rating |
| Delivery Score | 20% | On-time delivery performance |
| Cost Score | 20% | Price competitiveness |
| Support Score | 20% | Responsiveness and support quality |
| Compliance Score | 20% | Documentation and regulatory compliance |

**Overall = (Q + D + C + S + Co) / 5**

### Vendor Health Classifications

| Label | Score | Color | Meaning |
|-------|-------|-------|---------|
| Preferred | ≥ 4.0 | #16a34a (Green) | High performer, preferred partner |
| Approved | ≥ 3.0 | #2563eb (Blue) | Meets requirements, active use |
| Watchlist | ≥ 2.0 | #d97706 (Amber) | Performance concerns, monitor |
| Blocked | < 2.0 or open_ncrs > 3 | #dc2626 (Red) | Do not issue new POs |

### Vendor Risk Score

```
Risk Score = Health Factor + Single Source + NCR + OTD + Critical Vendor

Health Factor:  Blocked → +4, Watchlist → +2
Single Source:  is_single_source → +2
NCR Factor:     open_ncrs > 2 → +2, > 0 → +1
OTD Factor:     OTD < 80% → +2, < 90% → +1
Critical Vendor: critical_vendor flag → +2

Risk Level: score ≥ 6 → Critical | ≥ 4 → High | ≥ 2 → Medium | 0 → Low
```

---

## Executive Questions Answered

| CEO Question | Data Source | Dashboard Section |
|-------------|-------------|-------------------|
| Where is revenue coming from? | invoices × parties | Executive Summary + Customer Intelligence |
| Which customers are growing? | FY comparison | Customer Growth Center |
| Which customers are risky? | Health + Risk scores | Customer Risk Center |
| Which vendors threaten deliveries? | Scorecard + NCR + OTD | Vendor Risk Center |
| Which projects are losing money? | contract_value vs actual_cost | Project Profitability → Loss-Making |
| Which projects are most profitable? | profit margin % | Project Profitability → Top Profitable |
| How much revenue is at risk? | Outstanding + Single Source | Collections + Supply Chain Exposure |
| What will revenue be next quarter? | Pipeline × 35% + run-rate | Executive KPIs → Forecast Revenue |
| Which AMC renewals are coming? | amc_contracts × end_date | Collections & AMC → Expiring Contracts |
| Which collections require action? | Aging buckets + risk | Collections → Top Defaulters |
