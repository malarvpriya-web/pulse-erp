# VENDOR 360 API MAP — Phase 49D

Base URL: `/api/vendor-360`
Auth: Bearer JWT (verifyToken middleware on all routes)
Tenant isolation: `company_id` extracted from JWT, enforced on every query.

---

## ENDPOINTS

### 1. List Vendors
```
GET /api/vendor-360
```
**Query params:** `search`, `status`

**Response:**
```json
[
  {
    "id": 42,
    "name": "Shreem Transformers Pvt Ltd",
    "vendor_code": "VND-0042",
    "vendor_type": "Manufacturer",
    "status": "approved",
    "email": "purchase@shreem.in",
    "phone": "+91-9999999999",
    "city": "Pune",
    "state": "Maharashtra",
    "category": "Electrical",
    "msme_status": "Micro",
    "po_count": 38,
    "po_value": 4750000.00,
    "score": 84.2,
    "created_at": "2025-01-15T09:00:00Z"
  }
]
```

---

### 2. Full 360 View ★ PRIMARY API
```
GET /api/vendor-360/:vendorId
```

**Response shape:**
```json
{
  "vendor":       { id, name, vendor_code, vendor_type, category, status, email, phone, city, state, address, website, credit_limit, payment_terms },
  "contacts":     [ { id, contact_name, designation, email, phone, mobile, is_primary, department } ],
  "registration": { gstin, pan, msme_status, udyam_number, bank_name, bank_account, ifsc, approval_status, iso_certificates },
  "procurement": {
    "summary": { total_po_value, open_po_value, closed_po_value, awarded_orders, open_pos, closed_pos, cancelled_pos, average_order_value, rfq_count, rfq_wins },
    "purchase_orders": [ ...last 20 ],
    "rfqs":            [ ...last 30 ],
    "traceability":    { question_which_bom_items, question_which_pos, question_which_grns, po_grn_map }
  },
  "delivery": {
    "summary": { total_grns, on_time_count, delayed_count, partial_deliveries, on_time_delivery_percent, average_lead_time },
    "grns": [ ...last 20 ]
  },
  "quality": {
    "summary": { total_inspections, inspection_pass_rate, open_ncr, open_capa, total_ncrs, critical_ncrs, rejection_qty, vendor_ppm },
    "ncrs":      [ ...last 15 ],
    "capas":     [ ...last 10 ],
    "snapshots": [ ...last 6 monthly ],
    "traceability": { ncr_count, open_ncrs, capa_count, open_capas, rejected_qty, accepted_inspections, pass_pct, rejected_items }
  },
  "inventory": {
    "summary": { unique_items, stock_value, critical_materials, long_lead_items },
    "supplied_items": [ ...top 50 by value ],
    "critical_stock": [ ...items at or below reorder level ],
    "critical_flags": [ { type, label, severity, detail?, items? } ]
  },
  "projects": {
    "summary": { projects_count, active_projects, critical_projects, total_vendor_value },
    "projects": [ { project_name, status, priority, start_date, end_date, contract_value, vendor_po_value, po_count } ]
  },
  "finance": {
    "summary": { total_spend, paid_amount, outstanding_amount, total_bills, pending_bills, average_payment_days, total_tds },
    "bills": [ ...last 15 ],
    "traceability": { total_spend, outstanding, pending_bills, credit_terms, avg_payment_cycle, latest_bills }
  },
  "documents": {
    "vendor_name": "Shreem Transformers Pvt Ltd",
    "root": "Vendors/Shreem Transformers Pvt Ltd",
    "folders": [ { id, name, description } ],
    "compliance": { gstin, pan, msme_status, udyam_number, iso_certificates }
  },
  "scorecard": {
    "quality_score": 85.0,
    "delivery_score": 78.5,
    "cost_score": 72.0,
    "support_score": 70.0,
    "compliance_score": 90.0,
    "overall_score": 79.1,
    "classification": "Approved",
    "source": "stored | computed",
    "scored_at": "2026-05-01T00:00:00Z"
  },
  "risk": {
    "overall": "Medium",
    "breakdown": { "financial": "Low", "quality": "Medium", "delivery": "Low", "compliance": "Low", "dependency": "Medium" }
  },
  "health": {
    "score": 77,
    "label": "Good",
    "color": "#2563eb",
    "breakdown": { quality, delivery, open_ncrs, capa_closure_pct, payment_stability }
  }
}
```

---

### 3. Timeline
```
GET /api/vendor-360/:vendorId/timeline
```
**Response:** Array of events, newest first (max 80)
```json
[
  { "type": "po",          "icon": "package",        "title": "PO: PO-2026-0042", "date": "2026-05-10", "amount": 125000, "status": "Completed" },
  { "type": "grn",         "icon": "check-circle",   "title": "GRN: GRN-2026-038", "date": "2026-05-18", "status": "completed" },
  { "type": "ncr",         "icon": "alert-triangle", "title": "NCR: NCR-2026-004", "description": "Major", "date": "2026-04-02", "status": "Closed" },
  { "type": "bill",        "icon": "file-text",      "title": "Bill: BILL-2026-012", "date": "2026-05-20", "amount": 125000, "status": "paid" },
  { "type": "scorecard",   "icon": "star",           "title": "Scored: 79.1/100",  "date": "2026-05-01", "status": "completed" },
  { "type": "registration","icon": "building",       "title": "Vendor Registered", "date": "2025-01-15", "status": "active" }
]
```
Event types: `registration` | `first_po` | `po` | `grn` | `ncr` | `bill` | `scorecard` | `rfq`

---

### 4. Scorecard — GET (compute or retrieve)
```
GET /api/vendor-360/:vendorId/scorecard
```
Returns live-computed scorecard if no stored entry exists.

### 4b. Scorecard — POST (manual entry)
```
POST /api/vendor-360/:vendorId/scorecard
Content-Type: application/json

{
  "quality_score":    85,
  "delivery_score":   78,
  "cost_score":       72,
  "support_score":    70,
  "compliance_score": 90,
  "notes": "Quarterly review Q1-2026"
}
```
Response: `201 Created` with persisted scorecard row.

---

### 5. Risk
```
GET /api/vendor-360/:vendorId/risk
```
```json
{
  "overall": "Medium",
  "breakdown": {
    "financial":  "Low",
    "quality":    "Medium",
    "delivery":   "Low",
    "compliance": "Low",
    "dependency": "Medium"
  }
}
```
Risk levels: `Low` | `Medium` | `High` | `Critical`

---

### 6. Documents
```
GET /api/vendor-360/:vendorId/documents
```
```json
{
  "vendor_name": "Shreem Transformers Pvt Ltd",
  "root": "Vendors/Shreem Transformers Pvt Ltd",
  "folders": [
    { "id": "01", "name": "01 Registration",    "description": "Vendor registration form & KYC documents" },
    { "id": "02", "name": "02 GST Certificate", "description": "GSTIN registration certificate" },
    ...
  ],
  "compliance": { "gstin": "27AABCS1234A1Z5", "pan": "AABCS1234A", "msme_status": "Micro" }
}
```

---

## CLASSIFICATION TABLE

| Overall Score | Classification | Meaning |
|---------------|---------------|---------|
| ≥ 80          | Preferred     | Strategic supplier, first-choice for RFQs |
| 60–79         | Approved      | On the approved vendor list |
| 40–59         | Watchlist     | Under performance review |
| < 40          | Blocked       | Do not issue POs |

---

## HEALTH LABEL TABLE

| Health Score | Label     | Color   |
|-------------|-----------|---------|
| ≥ 85        | Excellent | #16a34a |
| 70–84       | Good      | #2563eb |
| 50–69       | Watchlist | #d97706 |
| < 50        | Critical  | #dc2626 |

---

## RISK LEVEL TABLE

| Dimension   | Low             | Medium              | High                  | Critical        |
|-------------|-----------------|---------------------|-----------------------|-----------------|
| Financial   | Outstanding < 70% of limit | Outstanding 70–90% | Outstanding > 90% of limit | — |
| Quality     | 0 open NCRs     | 1–3 open NCRs       | 4+ open NCRs          | Any Critical NCR |
| Delivery    | < 15% delayed   | 15–30% delayed      | > 30% delayed         | — |
| Compliance  | All CAPAs closed| 1+ overdue CAPA     | 4+ overdue CAPAs OR invalid GSTIN | — |
| Dependency  | Lead time ≤ 45d | Lead time 46–90d    | Lead time > 90d OR single-source | — |

---

## FILE LOCATIONS

| File | Path |
|------|------|
| Routes     | `src/modules/procurement/routes/vendor360.routes.js` |
| Controller | `src/modules/procurement/controllers/vendor360.controller.js` |
| Service    | `src/modules/procurement/services/vendor360.service.js` |
| Repository | `src/modules/procurement/repositories/vendor360.repository.js` |

Mount point in `server.js`:
```javascript
v1Router.use("/vendor-360", verifyToken, vendor360Routes);
```
