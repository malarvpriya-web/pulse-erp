# Supply Chain Exposure Model
## Phase 49H | Pulse ERP

---

## Overview

The Supply Chain Exposure Model identifies and quantifies risk to project delivery and revenue
from vendor-side failures, single-source dependencies, and critical component lead times.

---

## Risk Dimensions

### 1. Single-Source Vendors

A vendor is classified as **Single Source** when:
- `purchase_orders.notes ILIKE '%single source%'` OR `ILIKE '%sole source%'`
- No alternate vendor has been qualified for the same part/commodity

**Impact**: If a single-source vendor is blocked, delayed, or fails quality — there is NO alternate supplier.

**Revenue At Risk Formula**:
```
Revenue At Risk = single_source_vendor_spend × 1.5
```
(Factor of 1.5 accounts for project delays, rework, and expedite costs)

---

### 2. Critical Component Risk Matrix

Power electronics manufacturing (HVDC, STATCOM, SST, Automation) has specific strategic components:

| Component | Risk Level | Typical Lead Time | Source Count | Impact |
|-----------|-----------|-------------------|--------------|--------|
| IGBT Modules | Critical | 90–120 days | 1 | Core switching element — halts all converter builds |
| DSP Controllers | Critical | 60–90 days | 1 | All automation and control systems |
| Power Transformers | High | 60–90 days | 2 | SST, HVDC converter projects |
| DC Capacitors | High | 45–60 days | 2 | Energy storage and converter assemblies |
| Semiconductors | High | 60–75 days | 3 | PCB assemblies across all product lines |
| Gate Drive Boards | Medium | 30–45 days | 2 | STATCOM and inverter assemblies |
| Current Sensors | Medium | 21–30 days | 3 | Protection and metering |
| HV Cables & Bus Bars | Medium | 30–45 days | 4 | HVDC terminations |

---

### 3. Vendor Health Risk Overlay

Vendors are cross-referenced against:
- **Scorecard Overall**: < 3.0 → Watchlist risk
- **Open NCRs**: > 2 open NCRs → High risk
- **OTD %**: < 80% → Critical delivery risk
- **Status**: 'Blocked' → Do not issue new POs
- **Critical Vendor Flag**: Must have qualified alternate

---

### 4. Project Revenue Impact

For vendors with open POs tied to active projects:
- `project_count` = number of active projects with open POs from this vendor
- `revenue_at_risk` (estimate) = project_count × ₹20L avg project size

---

## Risk Scoring

```
Vendor Risk Score =
  health_factor       (Blocked: +4, Watchlist: +2)
+ single_source       (+2 if single-source)
+ ncr_factor          (open > 2: +2, open > 0: +1)
+ otd_factor          (OTD < 80%: +2, < 90%: +1)
+ critical_vendor     (+2 if critical_vendor flag set)

Risk Level:
  ≥ 6 → Critical
  ≥ 4 → High
  ≥ 2 → Medium
  < 2 → Low
```

---

## Mitigation Actions (Embedded in Dashboard)

1. Qualify alternate IGBT suppliers — current single-source is the highest risk
2. Maintain 90-day safety stock for IGBTs, DSP controllers, power transformers
3. Issue advance POs 90+ days before project start for long lead-time components
4. Negotiate SLAs with critical vendors — include delivery penalty clauses
5. Perform quarterly vendor audits for all Critical/Single-Source vendors
6. Develop dual-source qualification plans for all Critical-rated components

---

## Strategic Alerts (Auto-generated)

Supply chain alerts are generated when:
- A vendor is Blocked (status = 'Blocked')
- A vendor has > 2 open NCRs
- A single-source vendor has a critical ticket or NCR open
- OTD drops below 80% for a vendor with open POs on active projects

These appear in the **War Room** tab under "Vendor" category alerts.

---

## API Endpoint

```
GET /api/v1/ceo-intelligence/vendors
```

Returns:
- `vendors[]`: All vendors with health, risk, single_source, projects_impacted, critical_items
- `high_risk[]`: Filtered vendors with risk = Critical or High
- `single_source_vendors[]`: All single-source vendors
- `summary.single_source_count`: Total single-source vendor count
