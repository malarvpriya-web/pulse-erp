# VENDOR RISK MODEL — Phase 49C-14

## Overview
5-dimension weighted risk engine. Score 0–100 (higher = riskier).

## Risk Rating Thresholds
| Score | Rating | Action |
|-------|--------|--------|
| 0–29 | Low | Standard monitoring |
| 30–49 | Medium | Quarterly review |
| 50–69 | High | Monthly review, mitigation required |
| 70–100 | Critical | Escalate to Management, source alternatives |

---

## Dimension Weights

| Dimension | Weight | Driver |
|-----------|--------|--------|
| Financial Risk | 25% | GST, PAN, turnover, bank verification |
| Quality Risk | 25% | NCR count, quality scorecard, ISO certs |
| Delivery Risk | 20% | Late delivery %, delivery scorecard |
| Compliance Risk | 20% | Missing/expired documents, regulatory |
| Dependency Risk | 10% | Single source, long lead, critical supplier |

---

## Dimension Scoring

### 1. Financial Risk (0–100)
```
+20 if no GSTIN
+15 if no PAN
+20 if no annual turnover declared
+15 if annual_turnover < ₹10 Lakh
+30 if no verified cancelled cheque
= capped at 100
```

### 2. Quality Risk (0–100)
```
+15 per NCR in last 12 months (max 60)
+20 if any open NCRs
+max(0, 80 - quality_scorecard_score) if scorecard exists
+20 if no ISO/quality certification
= capped at 100
```

### 3. Delivery Risk (0–100)
```
+(late_pos / total_pos) × 100 × 1.5 (max 60)
+max(0, (80 - delivery_scorecard_score) × 0.5) if scorecard exists
+10 if no year_established data
= capped at 100
```

### 4. Compliance Risk (0–100)
```
For each critical doc [GST Certificate, PAN, Bank Proof]:
  +15 if doc missing
  +8  if doc present but not verified
  +12 if doc expired
+5 if no MSME/Udyam registration
= capped at 100
```

### 5. Dependency Risk (0–100)
```
+50 if is_single_source = true
+30 if is_long_lead = true
+20 if is_critical_supplier = true
= capped at 100
```

---

## Overall Risk Formula

```
overall = (financial × 0.25)
         + (quality   × 0.25)
         + (delivery  × 0.20)
         + (compliance × 0.20)
         + (dependency × 0.10)
```

---

## Initial Risk (New Vendors)
Computed at management approval before first scorecard:
```
+15 if no GSTIN
+15 if no PAN
+10 if no turnover declared
+5  if no MSME/Udyam
+15 if no ISO certs listed
+5  if no employee count
= capped at 100
```

---

## Integration Points

### Scorecard → Risk
Quarterly scorecard directly feeds Quality Risk and Delivery Risk dimensions.

### NCR → Risk
NCR records from `vendor_ncr` table feed Quality Risk (count in 12 months, open count).

### Risk → Classification
After each risk assessment, vendor classification is updated:
```
score ≥ 85 overall_scorecard → Preferred
score ≥ 65 → Approved
score ≥ 40 → Watchlist
score < 40 → Blocked
```
(Note: risk raises; scorecard lowers the classification threshold in opposite direction)

### PO Data → Delivery Risk
```sql
SELECT COUNT(*) FILTER (WHERE status IN ('delayed','overdue')) AS late_pos,
       COUNT(*) AS total_pos
FROM purchase_orders WHERE supplier_id = $vendorId
```

---

## Database
Risk history stored in `vendor_risk_assessments`:
```sql
financial_risk, quality_risk, delivery_risk,
compliance_risk, dependency_risk,
overall_risk_score, risk_rating,
ncr_count_12m, late_delivery_pct,
assessment_date, assessed_by
```

---

## API
```
GET  /api/v1/vendor-approval/vendors/:id/risk
     — list assessment history

POST /api/v1/vendor-approval/vendors/:id/risk
     Body: { financial_risk, quality_risk, delivery_risk, compliance_risk, dependency_risk, notes }
     — manual assessment (also auto-updates vendors.risk_score + vendors.risk_rating)
```

---

## CEO Questions Answered (49C-25)

| Question | Source |
|----------|--------|
| Who approved this vendor? | `vendors.approved_by` → user lookup |
| Which projects used this vendor? | JOIN `purchase_orders` → `projects` |
| How much spend? | SUM `purchase_orders.total_amount` |
| How many NCRs? | COUNT `vendor_ncr` |
| How many CAPAs? | COUNT `vendor_capa` |
| Quality score? | `vendor_scorecards.quality_score` |
| Delivery score? | `vendor_scorecards.delivery_score` |
| Outstanding payments? | SUM pending `vendor_payments` |
| Risk rating? | `vendors.risk_rating` or latest `vendor_risk_assessments` |

Traceability endpoint: `GET /api/v1/vendor-approval/vendors/:id/traceability`
Returns all of the above in a single response. If any field cannot be answered, `traceability_score = 'VENDOR TRACEABILITY FAILURE'`.
