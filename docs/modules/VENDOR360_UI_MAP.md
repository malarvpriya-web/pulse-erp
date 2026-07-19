# Vendor 360° — UI Map

## Route
```
/procurement/vendor-360/:vendorId    (component: Vendor360.jsx)
```

## Deep Links From
| Module | Trigger | Target |
|--------|---------|--------|
| RFQ    | Vendor name link | `/procurement/vendor-360/:id` |
| PO     | Vendor name link | `/procurement/vendor-360/:id` |
| GRN    | Vendor column    | `/procurement/vendor-360/:id` |
| NCR    | Vendor name link | `/procurement/vendor-360/:id` |
| CAPA   | Vendor column    | `/procurement/vendor-360/:id` |
| Inventory | Supplier column | `/procurement/vendor-360/:id` |
| Projects  | Vendor POs tab  | `/procurement/vendor-360/:id` |

---

## Page Layout

### Left Panel (280 px, fixed)
- Search input (debounced, server-side)
- Vendor list: Name, Code/Type, PO count, PO value, score badge

### Right Panel (flex-1)
**Header Block**
- Row 1: Vendor Name + Code + Status badge + MSME badge + ISO badge + Health pill + Action Buttons
- Action Buttons: `+ Score Vendor`, `Create RFQ`, `Create PO`, `Raise NCR`, `Vendor Portal`
- Inline ScoreForm: appears below header when "Score Vendor" is clicked
- Row 2: 8 KPI Cards (grid, auto-fill)
- Tab Bar: 10 tabs

**8 KPI Cards**
| # | Label | Source field |
|---|-------|-------------|
| 1 | Total Spend | `procurement.summary.total_po_value` |
| 2 | Outstanding | `finance.summary.outstanding_amount` |
| 3 | Open PO Value | `procurement.summary.open_po_value` |
| 4 | On-Time Delivery | `delivery.summary.on_time_delivery_percent` |
| 5 | Overall Score | `scorecard.overall_score` |
| 6 | Open NCRs | `quality.summary.open_ncr` (red if > 0) |
| 7 | Open CAPAs | `quality.summary.open_capa` (amber if > 0) |
| 8 | Projects | `projects.summary.projects_count` |

---

## 10 Tabs

### Overview
- Vendor Profile panel: GST, PAN, Email, Phone, City/State, Payment Terms, Credit Limit, Bank, IFSC, MSME, ISO
- Vendor Health gauge + breakdown grid
- Quick stats: Total POs, Open POs, Total GRNs, Total Bills
- Contacts grid (avatar cards)

### Commercial
- 8 summary KPI cards: Total PO Value, Open PO Value, Avg Order Value, POs Awarded, Open POs, Closed POs, RFQs, RFQ Wins
- Table: Recent Purchase Orders (PO#, Date, Amount, Status, Delivery Date)
- Table: RFQ History (RFQ#, Date, Required By, Quote Value, Delivery Days, Winner)

### Quality
- 7 summary KPI cards: Total Inspections, Pass Rate, Total NCRs, Open NCRs, Critical NCRs, Open CAPAs, Rejection Qty
- Table: NCR/Rejection Log (NCR#, Date, Defect, Severity, Qty Affected, Status)
- Table: CAPA Actions (CAPA ID, NCR, Action, Due Date, Status, Verified)

### Projects
- Delegates to `<VendorProjectImpact projectsData={...} />`
- Summary cards: Total Projects, Active, Total PO Value, Open PO Value, At Risk
- Project cards with status/risk badge, PO value, NCR count, budget bar

### Inventory
- 4 summary KPI cards: Unique Items, Stock Value, Critical Items, Long Lead Items
- Critical Stock Alert panel (red, if items below reorder level)
- Table: Items Supplied sorted by value (Item, Code, UOM, Qty, Value, POs, Last Ordered)

### Finance
- 7 summary KPI cards: Total Spend, Amount Paid, Outstanding, Total Bills, Pending Bills, Avg Payment Days, TDS
- Table: Bills/Invoices (Bill#, Date, Due Date, Amount, Balance, Status, TDS)

### Documents
- Drive Folder Structure (13 canonical folders)
- Compliance Checklist (GST, PAN, Bank, MSME, ISO, Agreement)

### Scorecard
- If no score: empty state + "Score Vendor" button
- Classification Banner (Preferred/Approved/Watchlist/Blocked) with icon + color + description
- Overall score circle (0–100) + last scored date
- 5 dimension gauges (Quality, Delivery, Cost, Support, Compliance) + Radar chart
- Weighted breakdown table (dimension, weight%, raw score, weighted pts, bar)
- Formula note footer

### Timeline
- Legend: 8 event types color-coded
- Chronological event cards with icon, title, amount, status, date
- "Load More" pagination (20 events/page)
- **Lazy-loaded** on first tab click (`GET /vendor-360/:id/timeline`)

### Risk
- Delegates to `<VendorRiskPanel riskData={...} vendorName={...} />`
- Overall risk banner + 4-circle meter
- Red Flag Dashboard
- 5 Dimension Cards with RiskMeter bars
- Strategic Supplier Classification panel
- Manifest Special Validation (9 categories)
- **Lazy-loaded** on first tab click (`GET /vendor-360/:id/risk`)

---

## API Calls Made

| Event | Endpoint | Notes |
|-------|----------|-------|
| Vendor list load / search | `GET /vendor-360` | With `?search=` param |
| Vendor selected | `GET /vendor-360/:id` | Single unified call |
| Timeline tab first open | `GET /vendor-360/:id/timeline` | Lazy, cached |
| Risk tab first open | `GET /vendor-360/:id/risk` | Lazy, cached |
| Score Vendor form submit | `POST /vendor-360/:id/scorecard` | Reloads full vendor after save |

---

## Component Files
| File | Purpose |
|------|---------|
| `Vendor360.jsx` | Main page shell, tabs, header, API orchestration |
| `VendorProjectImpact.jsx` | Projects tab — project cards with risk/status |
| `VendorRiskPanel.jsx` | Risk tab — 5-dimension risk + strategic flags |
