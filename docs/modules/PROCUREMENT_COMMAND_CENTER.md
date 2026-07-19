# Procurement Command Center

## Purpose
The Procurement Command Center gives the CPO / Purchase Manager a live cross-vendor intelligence view — aggregated vendor health, spend concentration, risk exposure, and delivery performance — without drilling into individual vendors.

---

## Route
```
GET /vendor-360/command-center           (backend)
```
> Note: This route is declared BEFORE `/:vendorId` in `vendor360.routes.js` to prevent Express treating "command-center" as a vendorId.

---

## Backend

### API: `GET /api/v1/vendor-360/command-center`
Auth: `verifyToken` required. Scoped to `req.user.company_id`.

**Response shape:**
```json
{
  "summary": {
    "active_vendors":     42,
    "open_rfqs":          8,
    "open_pos":           23,
    "delayed_deliveries": 5
  },
  "top_spend_vendors": [
    { "id": 12, "vendor_name": "ABB India Ltd", "total_po_value": 15000000, "po_count": 7 }
  ],
  "top_ncr_vendors": [
    { "id": 8, "vendor_name": "XYZ Fabricators", "open_ncrs": 4, "total_ncrs": 6 }
  ],
  "most_delayed_vendors": [
    { "id": 19, "vendor_name": "Generic Logistics", "delayed_grns": 3, "total_grns": 5, "delay_pct": 60 }
  ],
  "most_reliable_vendors": [
    { "id": 3, "vendor_name": "Siemens Ltd", "on_time_pct": 98, "total_grns": 45 }
  ],
  "vendor_distribution": [
    { "status": "Active",      "count": 38 },
    { "status": "Blacklisted", "count": 2  },
    { "status": "Suspended",   "count": 2  }
  ]
}
```

---

## Data Sources (6 parallel queries in `repo.commandCenterData`)

| Data | Query | Notes |
|------|-------|-------|
| `summary` | COUNT from `vendors`, `rfqs`, `purchase_orders`, `goods_receipts` | All filtered by `company_id` |
| `top_spend_vendors` | JOIN `purchase_orders` GROUP BY vendor | Top 5 by `SUM(total_amount_inr)` |
| `top_ncr_vendors` | JOIN `ncr_reports` GROUP BY vendor | Top 5 by open NCR count |
| `most_delayed_vendors` | JOIN `goods_receipts` GROUP BY vendor | `delayed_grns / total_grns DESC` |
| `most_reliable_vendors` | JOIN `goods_receipts` GROUP BY vendor | `on_time_pct DESC`, min 5 GRNs |
| `vendor_distribution` | GROUP BY status | Pie/doughnut chart data |

---

## CEO Traceability Test

For strategic vendors (Semikron, ABB, Siemens, etc.), a CEO must be able to answer these 9 questions from the Vendor 360 page alone:

| # | Question | Source |
|---|----------|--------|
| 1 | How much have we spent with this vendor? | `procurement.summary.total_po_value` |
| 2 | Which projects use this vendor? | `projects.projects[].project_name` |
| 3 | What materials do we buy from them? | `inventory.supplied_items[].item_name` |
| 4 | How many NCRs have they raised? | `quality.summary.total_ncrs` + NCR table |
| 5 | Any open CAPAs? | `quality.summary.open_capa` |
| 6 | Delivery delays? | `delivery.summary.delayed_count` + GRN table |
| 7 | Outstanding payments? | `finance.summary.outstanding_amount` |
| 8 | What is their score? | `scorecard.overall_score` + classification |
| 9 | What is their risk level? | `risk.overall_risk` + red_flags |

All 9 answers are available from the Vendor 360 page for any vendor with sufficient transactional history.

---

## Procurement Command Center (UI — future page)
The command center data powers a dedicated page at `/procurement/command-center` (planned for Phase 50):

**Planned sections:**
1. **Summary Ribbon** — 4 KPI tiles (Active Vendors, Open RFQs, Open POs, Delayed Deliveries)
2. **Spend Concentration** — Horizontal bar chart: Top 10 vendors by total PO value
3. **Quality Risk Heat Map** — Vendors × (open NCRs, critical NCRs, overdue CAPAs)
4. **Delivery Reliability** — Scatter plot: On-Time% vs. Total GRNs
5. **Vendor Distribution Donut** — Active / Suspended / Blacklisted
6. **Alerts Panel** — Live feed: overdue GRNs, critical NCRs, outstanding > credit limit

---

## MVC File Chain

```
vendor360.routes.js          → GET /command-center
  vendor360.controller.js    → ctrl.commandCenter
    vendor360.service.js     → svc.commandCenter(companyId)
      vendor360.repository.js → repo.commandCenterData(companyId)
```
