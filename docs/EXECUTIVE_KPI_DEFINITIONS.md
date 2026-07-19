# Executive KPI Definitions
## Phase 49H | Pulse ERP — CEO Intelligence Dashboard

---

## Section 1 — Executive Summary KPIs

| KPI | Definition | Data Source | Formula |
|-----|-----------|-------------|---------|
| Revenue This Month | Total paid invoice value in current calendar month | `invoices.total_amount WHERE status='paid' AND invoice_date >= month_start` | SUM |
| Revenue YTD | Total paid revenue since April 1 of current financial year | `invoices.total_amount WHERE status='paid' AND invoice_date >= fy_start` | SUM |
| Gross Margin % | (Revenue - COGS) / Revenue | `project_cost_summary` vs `invoices` | (contract - cost) / contract |
| Net Margin % | Profit after all costs / Revenue | project profitability data | portfolio_margin_pct |
| Outstanding Collections | Sum of unpaid/overdue invoices | `invoices WHERE status IN ('overdue','pending')` | SUM |
| Pipeline Value | Sum of open CRM opportunity values | `crm_opportunities WHERE stage NOT IN ('Closed Won','Closed Lost')` | SUM |
| Forecast Revenue | Pipeline × 35% conversion + run-rate × 3 months | Calculated | pipeline × 0.35 + (ytd / months) × 3 |
| Cash Position | Revenue YTD − Vendor Payables | invoices + vendor_invoices | rev_ytd - vendor_payable |
| AMC Annual Revenue | Sum of active AMC contract annual values | `amc_contracts WHERE status='active'` | SUM |

---

## Traffic Lights — Business Health Signals

| Signal | Green | Amber | Red |
|--------|-------|-------|-----|
| Revenue | Any revenue collected | — | Zero revenue this month |
| Collections | Outstanding < 15% of YTD | Outstanding 15–30% of YTD | Outstanding > 30% of YTD |
| Projects | Zero delayed projects | — | > 2 delayed projects |
| Supply Chain | No blocked vendors | 1 blocked vendor | Multiple blocked/watchlist |
| Profitability | Portfolio margin > 15% | Portfolio margin 5–15% | Portfolio margin < 5% |

---

## Section 2 — Customer Intelligence KPIs

| KPI | Definition |
|-----|-----------|
| Total Customers | Distinct customers with at least one invoice |
| Excellent / Good / Watchlist / Critical | Count by health classification |
| Revenue (Customer) | Paid invoices for current FY |
| Outstanding (Customer) | Unpaid/overdue invoices |
| Health Score | 0–100 composite score (see Customer Intelligence Model) |
| Revenue Growth % | (Current FY revenue − Prior FY revenue) / Prior FY × 100 |
| AMC Revenue | Sum of annual_value for active AMC contracts |
| Upsell Opportunity | Derived: No AMC + revenue > ₹5L → AMC Upsell; Growth > 50% → Expand Account |

---

## Section 5 — Sales Command KPIs

| KPI | Definition |
|-----|-----------|
| Pipeline Value | Open CRM opportunities × expected_value |
| Won Revenue | CRM opportunities in 'Closed Won' stage |
| Lost Revenue | CRM opportunities in 'Closed Lost' stage |
| Conversion Rate | Won / (Won + Lost) × 100 |
| Forecast Revenue | Pipeline × 35% + YTD run-rate projection |

---

## Section 6 — Vendor Intelligence KPIs

| KPI | Definition |
|-----|-----------|
| Total Vendors | All vendors in vendor master |
| Preferred / Approved / Watchlist / Blocked | Count by health classification |
| Total Spend | Sum of all PO values |
| OTD % | On-Time Delivery: (completed POs / total POs) × 100 |
| Open NCRs | Non-conformance reports with status ≠ 'Closed' |

---

## Section 9 — Project Intelligence KPIs

| KPI | Definition |
|-----|-----------|
| Active Projects | status IN ('active', 'in_progress') |
| Delayed Projects | expected_end_date < today AND status not completed |
| Over Budget | actual_cost > 110% of budget_amount |
| Loss-Making | profit (contract_value − actual_cost) < 0 |
| Portfolio Margin % | (total_profit / total_contract_value) × 100 |
| Budget Variance % | (actual_cost − budget) / budget × 100 |

---

## Section 11 — Collections Aging Buckets

| Bucket | Definition |
|--------|-----------|
| 0–30 Days | Days since due_date: 0–30 |
| 31–60 Days | Days since due_date: 31–60 |
| 61–90 Days | Days since due_date: 61–90 |
| 90+ Days | Days since due_date: > 90 (highest risk) |

Collections Risk Level per customer:
- Critical: max_overdue_days > 90
- High: > 60
- Medium: > 30
- Low: ≤ 30

---

## Section 12 — Service & AMC KPIs

| KPI | Definition |
|-----|-----------|
| Open Tickets | support_tickets WHERE status NOT IN ('resolved','closed') |
| Escalations | priority='critical' OR status='escalated' |
| Active AMC | amc_contracts WHERE status='active' |
| Expiring AMC (90d) | end_date BETWEEN today AND today+90 days |
| AMC Revenue | SUM(annual_value) for active contracts |
| Renewal Forecast | SUM(annual_value) for contracts expiring in 90 days |

---

## Financial Year Definition

FY starts April 1. Calculated dynamically:
```js
const fyStart = now.getMonth() >= 3
  ? `${now.getFullYear()}-04-01`
  : `${now.getFullYear() - 1}-04-01`;
```
Displayed as "FY 25-26", "FY 26-27" etc.
