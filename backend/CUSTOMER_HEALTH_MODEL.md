# CUSTOMER HEALTH MODEL — Phase 49F

## Overview
Every customer is scored 0–100 across 9 weighted dimensions. Score is stored in `customer_health_scores` and re-computed on demand or nightly.

## Dimension Weights

| # | Dimension      | Max Score | Source Tables                               |
|---|----------------|-----------|---------------------------------------------|
| 1 | Revenue        | 20        | invoices (paid)                             |
| 2 | Collections    | 20        | invoices (overdue/pending)                  |
| 3 | Profitability  | 15        | projects (budget vs actual), amc_contracts  |
| 4 | Project Success| 10        | projects (delays, failures)                 |
| 5 | Quality        | 10        | non_conformance_reports, support_tickets    |
| 6 | Service        | 10        | support_tickets, field_service_visits       |
| 7 | AMC            |  5        | amc_contracts                               |
| 8 | Engagement     |  5        | customer_visits, crm_emails, crm_activities |
| 9 | Risk Buffer    |  5        | Derived from dimensions 2, 4, 5             |
|   | **TOTAL**      | **100**   |                                             |

## Classification (49F-12)

| Score   | Status     | Color  |
|---------|------------|--------|
| 90–100  | Excellent  | Green  |
| 75–89   | Good       | Blue   |
| 50–74   | Watchlist  | Amber  |
| 0–49    | Critical   | Red    |

## Segmentation (49F-16)

| Segment         | Criteria                                    |
|-----------------|---------------------------------------------|
| Strategic       | Score ≥ 85 AND revenue_12m ≥ ₹50 L         |
| Key Account     | Score ≥ 75 AND revenue_12m ≥ ₹10 L         |
| Growth Account  | Revenue growth > 15% AND score ≥ 50         |
| Standard Account| Score ≥ 50                                  |
| At-Risk Account | Score < 50                                  |

## Manifest Special Model (49F-23)
For HVDC, STATCOM, SST, Industrial Automation customers:
- `fat_success_pct` — Factory Acceptance Test pass rate
- `sat_success_pct` — Site Acceptance Test acceptance rate
- `commissioning_success_pct` — Commissioning acceptance rate
- `warranty_claims_count` — Total warranty claims
- `amc_renewal_pct` — Active vs total AMC contracts

## Database Tables
- `customer_health_scores` — Current score (upserted)
- `customer_health_history` — Monthly snapshots (49F-13)
- `customer_health_alerts` — Early warning system (49F-14)
