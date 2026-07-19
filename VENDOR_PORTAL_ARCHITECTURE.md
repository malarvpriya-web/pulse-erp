# VENDOR PORTAL ARCHITECTURE — Phase 49C

## Overview
Complete vendor lifecycle management: self-registration → approval → scorecard → risk → procurement integration.

---

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `vendors` | Master vendor record (extended Phase 49C) |
| `vendor_registrations` | Self-registration + approval workflow tracking |
| `vendor_contacts` | Multiple contacts per vendor (Commercial/Technical/Quality/Finance/Management) |
| `vendor_bank_details` | Bank accounts with Finance verification flag |
| `vendor_documents` | Document registry with Drive links + expiry tracking |
| `vendor_drive_folders` | Google Drive folder mapping (14 subfolders) |
| `vendor_risk_assessments` | 5-dimension risk scores over time |
| `vendor_scorecards` | 6-dimension quarterly scorecard |
| `vendor_ncr` | Non-Conformance Reports |
| `vendor_capa` | Corrective & Preventive Actions |

### Extended `vendors` Columns (Phase 49C)
```
vendor_code, vendor_type, vendor_category, udyam_number, msme_status,
iec, cin, website, country, postal_code,
year_established, employee_count, annual_turnover,
factory_locations (JSONB), office_locations (JSONB),
vendor_folder_id, vendor_folder_url,
approved_by, approved_at, classification,
scm_score, quality_score, finance_score, risk_score, risk_rating,
is_critical_supplier, is_single_source, is_long_lead,
registration_id, deleted_at
```

---

## Backend Architecture

### Route Files

| File | Mount | Auth |
|------|-------|------|
| `vendor-registration.routes.js` | `/api/v1/vendor-registration` | Mixed (public submit + auth list) |
| `vendor-approval.routes.js` | `/api/v1/vendor-approval` | `verifyToken` |
| `vendor.routes.js` | `/api/v1/` | `verifyToken` |
| `vendor-portal.routes.js` | `/api/v1/vendor-portal` | `verifyToken` |
| `vendor360.routes.js` | `/api/v1/vendor-360` | `verifyToken` |

### Key Backend Endpoints

```
POST  /vendor-registration/submit            — public, submit new registration
POST  /vendor-registration/:id/verify-email  — public, OTP verify
POST  /vendor-registration/:id/verify-mobile — public, OTP verify  
POST  /vendor-registration/:id/finalize      — public, submit after OTP
GET   /vendor-registration/status/:id        — public, vendor tracks own status
GET   /vendor-registration                   — auth, list all registrations
POST  /vendor-registration/check-duplicate   — public, GSTIN/PAN/Name check

PUT   /vendor-approval/:id/scm-review        — roles: procurement, scm, admin
PUT   /vendor-approval/:id/quality-review    — roles: quality, admin
PUT   /vendor-approval/:id/finance-review    — roles: finance, admin
PUT   /vendor-approval/:id/management-review — roles: manager, director, admin

GET   /vendor-approval/queue                 — role-filtered approval queue
GET   /vendor-approval/dashboard/stats       — KPI cards
GET   /vendor-approval/dashboard/charts      — distribution charts
GET   /vendor-approval/vendors/:id/traceability — CEO traceability

POST  /vendor-approval/ncr                   — create NCR
POST  /vendor-approval/capa                  — create CAPA
POST  /vendor-approval/vendors/:id/risk      — save risk assessment
```

### Service Layer
- `vendor.service.js` — Risk engine (5-dimension), duplicate detection, classification update, Drive folder structure
- `vendor.repository.js` — All DB access (findAll, findById, create, update, softDelete, getStats, search by GSTIN/PAN)

---

## Frontend Architecture

### Page Components

| Component | Route Key | Purpose |
|-----------|-----------|---------|
| `VendorRegistration.jsx` | `VendorRegistration` | Public 7-step wizard (public: true) |
| `VendorDashboard.jsx` | `VendorDashboard` | Main command centre + CEO traceability |
| `VendorApprovalQueue.jsx` | `VendorApprovalQueue` | Multi-stage approval review |
| `VendorRiskDashboard.jsx` | `VendorRiskDashboard` | Risk engine + radar charts |
| `VendorManagement.jsx` | `VendorManagement` | Vendor master CRUD |
| `VendorScorecard.jsx` | `VendorScorecard` | Quarterly scorecard |
| `VendorPortal.jsx` | `VendorPortal` | Approved vendor self-service |
| `Vendor360.jsx` | `Vendor360` | Analytics & insights |

### Navigation (Procurement submenu, Phase 49C additions)
```
Vendor Dashboard    → VendorDashboard
Vendor Master       → VendorManagement
Approval Queue      → VendorApprovalQueue   (NEW)
Risk Engine         → VendorRiskDashboard   (NEW)
Vendor 360°          → Vendor360
Vendor Portal       → VendorPortal
Vendor Scorecard    → VendorScorecard
```

---

## Vendor Types (49C-3)
Raw Material · Electrical Components · Electronics · Semiconductors ·
Transformers · Fabrication · Machining · Packaging · Logistics ·
Service Provider · Commissioning Partner · AMC Partner · Consultant ·
Contract Labour · Other

## Vendor Classification (49C-15)
| Score | Classification |
|-------|---------------|
| ≥85   | Preferred |
| 65–84 | Approved |
| 40–64 | Watchlist |
| <40   | Blocked |

## Duplicate Detection (49C-23)
Checked at registration submit time and on GSTIN/PAN blur:
- Same GSTIN → warn/block
- Same PAN → warn/block
- Same vendor name (case-insensitive) → warn

## Industrial Special Tracking (49C-24)
Flags on vendor master:
- `is_critical_supplier` — HVDC, STATCOM, Transformers, IGBT, Semiconductor suppliers
- `is_single_source` — only supplier for a part/category
- `is_long_lead` — ≥12 week lead time items

---

## Migration File
`backend/src/database/migrations/20260616000002_phase49c_vendor_portal.js`
Run via existing migration runner.
