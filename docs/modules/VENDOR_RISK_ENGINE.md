# Vendor Risk Engine

## Overview
The risk engine evaluates 5 independent dimensions and surfaces red flags + strategic classification flags. It runs server-side on `GET /vendor-360/:id/risk` (lazy-loaded when user opens the Risk tab).

---

## Risk Levels
`Low → Medium → High → Critical`

The overall risk is the **maximum** across all 5 dimensions.

---

## 5 Risk Dimensions

### 1. Financial Risk 💰
| Level    | Condition |
|----------|-----------|
| High     | Outstanding > 90% of credit limit |
| Medium   | Outstanding > 70% of credit limit, OR pending_bills > 5 |
| Low      | Otherwise |

**Data sources:** `vendor_bills`, `vendor_finance_metrics`, `vendors.credit_limit`

### 2. Quality Risk 🔬
| Level    | Condition |
|----------|-----------|
| Critical | Any Critical severity NCR open |
| High     | open_ncrs > 3 |
| Medium   | open_ncrs > 0 |
| Low      | No open NCRs |

**Data sources:** `vendor_ncrs` (or `ncr_reports`), filtered by `status != 'Closed'`

### 3. Delivery Risk 🚚
| Level    | Condition |
|----------|-----------|
| High     | delayed_pct > 30% OR open_pos > 15 |
| Medium   | delayed_pct > 15% OR open_pos > 8 |
| Low      | Otherwise |

`delayed_pct = delayed_grns / total_grns × 100`

**Data sources:** `goods_receipts` (GRN with expected vs actual dates), `purchase_orders`

### 4. Dependency Risk 🔗
| Level    | Condition |
|----------|-----------|
| High     | vendor.is_single_source = true OR avg_lead_time > 90 days |
| Medium   | avg_lead_time > 45 days |
| Low      | Otherwise |

**Data sources:** `vendors.is_single_source`, `delivery_metrics.avg_lead_time_days`

### 5. Compliance Risk 📋
| Level    | Condition |
|----------|-----------|
| High     | GSTIN missing OR overdue_capas > 3 |
| Medium   | overdue_capas > 0 |
| Low      | Otherwise |

Overdue CAPAs = CAPAs where `status != 'closed'` AND `due_date < NOW()`

**Data sources:** `vendors.gstin`, `vendor_capas`

---

## Strategic Supplier Flags

These are boolean flags derived independently of risk levels:

| Flag             | Condition |
|------------------|-----------|
| `single_source`  | `vendor.is_single_source = true` |
| `long_lead_supplier` | `avg_lead_time_days > 90` |
| `critical_supplier` | `overall_risk in ('High', 'Critical')` |
| `high_spend`     | `total_spend > ₹50 Lakh` |
| `project_critical` | vendor linked to ≥ 3 active projects |

---

## Red Flag Dashboard
Auto-generated list of plain-English alerts shown as red flag cards (🚩) in the Risk tab:

- `{n} critical NCR(s) unresolved`
- `{n} open NCRs`
- `{n} pending bill(s) — ₹Xk outstanding`
- `{n} delayed GRN(s) out of {total}`
- `{n} CAPA(s) past due date`
- `GST number not on record`
- `PAN number not on record`
- `Incomplete compliance documentation` (< 3 of 5 docs present)
- `Vendor critical to {n} active projects (single-point dependency)`

---

## Manifest Special Validation (9 Categories)
Shown in VendorRiskPanel for industrial context. These map to Pulse ERP's key component categories for power electronics / EPC projects:

| # | Category | Icon | Validation |
|---|----------|------|-----------|
| 1 | IGBT Modules | ⚡ | Cert + test report required |
| 2 | Transformers | 🔌 | Type test + FAT required |
| 3 | Capacitors | 🔋 | Batch QC report required |
| 4 | Semiconductors | 💻 | Country of origin + datasheet |
| 5 | Fabrication | 🏗️ | ISO 3834 / weld cert |
| 6 | Panel Builders | 📦 | UL / IEC panel standard |
| 7 | Testing Labs | 🔬 | NABL accreditation |
| 8 | Logistics | 🚛 | Insurance + hazmat capability |
| 9 | Commissioning | 🔧 | Site competency + insurance |

---

## API

### GET /vendor-360/:id/risk

**Response shape:**
```json
{
  "overall_risk": "Medium",
  "dimensions": {
    "financial":   { "level": "Low",    "outstanding": 120000, "pending_bills": 1, "description": "..." },
    "quality":     { "level": "Medium", "total_ncrs": 3, "open_ncrs": 1, "critical_ncrs": 0, "overdue_capas": 0, "description": "..." },
    "delivery":    { "level": "Medium", "delayed_grns": 2, "total_grns": 10, "overdue_ratio": 20.0, "avg_lead_time": 45, "description": "..." },
    "dependency":  { "level": "Low",    "projects": 2, "open_pos": 3, "description": "..." },
    "compliance":  { "level": "Low",    "docs_complete": 4, "docs_total": 5, "has_gst": true, "has_pan": true, "has_bank": true, "has_msme": false, "has_iso": true, "overdue_capas": 0, "description": "..." }
  },
  "strategic_flags": {
    "single_source": false,
    "long_lead_supplier": false,
    "critical_supplier": false,
    "high_spend": true,
    "project_critical": false
  },
  "red_flags": [
    "1 open NCRs",
    "2 delayed GRN(s) out of 10",
    "MSME number not on record"
  ]
}
```

---

## Component: VendorRiskPanel.jsx
Props: `riskData` (shape above), `vendorName` (string)

Renders:
1. **Overall Risk Banner** — color-coded heading + 4-circle visual meter
2. **Red Flag Dashboard** — grid of 🚩 cards (only shown when red_flags.length > 0)
3. **5 Dimension Cards** — each with `RiskMeter` bar and detail rows
4. **Strategic Supplier Panel** — 5 classification chips (greyed out if not active)
5. **Manifest Special Validation** — 9 category validation checklist
