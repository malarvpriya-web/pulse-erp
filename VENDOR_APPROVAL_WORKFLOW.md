# VENDOR APPROVAL WORKFLOW — Phase 49C-9

## Flow Diagram

```
Vendor (Public Portal)
        │
        ▼
   [Submit Registration]
   status = 'Draft' → 'Submitted'
        │
        ▼ (OTP email verified)
   status = 'Submitted'
        │
        ▼
┌─────────────────────┐
│   SCM REVIEW        │  Roles: procurement, scm, admin
│   · Products        │
│   · Capacity        │  Decision:
│   · Lead Time       │    Approve → status = 'Pending Quality Review'
│   · MOQ             │    Hold    → status = 'On Hold'
│   · References      │    Reject  → status = 'Rejected'
│   SCM Score: 0–100  │
└─────────────────────┘
        │ (Approved)
        ▼
┌─────────────────────┐
│   QUALITY REVIEW    │  Roles: quality, admin
│   · ISO certs       │
│   · Inspection cap  │  Decision:
│   · Testing cap     │    Approve → status = 'Pending Finance Review'
│   · QMS processes   │    Hold    → status = 'On Hold'
│   · NCR history     │    Reject  → status = 'Rejected'
│   Quality Score 0–100│
└─────────────────────┘
        │ (Approved)
        ▼
┌─────────────────────┐
│   FINANCE REVIEW    │  Roles: finance, admin
│   · GST verify      │
│   · PAN verify      │  Decision:
│   · Bank details    │    Approve → status = 'Pending Management Review'
│   · Credit terms    │    Hold    → status = 'On Hold'
│   · Compliance      │    Reject  → status = 'Rejected'
│   Finance Score 0–100│
└─────────────────────┘
        │ (Approved)
        ▼
┌─────────────────────┐
│ MANAGEMENT REVIEW   │  Roles: manager, director, super_admin, admin
│   · SCM Score       │
│   · Quality Score   │  Decision:
│   · Finance Score   │    Approved            → status = 'Approved'
│   · Risk Score      │    Conditional Approval → status = 'Approved'
│   · Overall risk    │    Rejected            → status = 'Rejected'
└─────────────────────┘
        │ (Approved)
        ▼
 AUTO-PROMOTE to VENDOR MASTER
   · Generate vendor_code (VND-XXXX)
   · Copy registration data to vendors table
   · Migrate contacts → vendor_contacts
   · Migrate bank → vendor_bank_details
   · Migrate docs → vendor_documents
   · Create initial risk assessment
   · Set classification = 'Approved'
```

---

## Status State Machine

| Status | Description | Next States |
|--------|-------------|-------------|
| Draft | Not yet submitted | Submitted |
| Submitted | Registration submitted | Pending SCM Review |
| Pending SCM Review | Awaiting SCM decision | Pending Quality Review, On Hold, Rejected |
| Pending Quality Review | Awaiting Quality decision | Pending Finance Review, On Hold, Rejected |
| Pending Finance Review | Awaiting Finance decision | Pending Management Review, On Hold, Rejected |
| Pending Management Review | Awaiting final decision | Approved, Rejected |
| Approved | Fully approved, vendor created | — |
| On Hold | Paused for more info | Any Review stage |
| Rejected | Declined | — (can re-register) |
| Blocked | Post-approval suspension | Active |

---

## Role → Stage Mapping

| Role | Can Review |
|------|-----------|
| procurement / scm | SCM Review |
| quality | Quality Review |
| finance | Finance Review |
| manager / director | Management Review |
| admin / super_admin | All stages |

---

## Audit Trail
Every review action is logged via `logAudit()`:
```js
{
  module: 'vendor_approval',
  recordType: 'vendor_registration',
  action: 'scm_review' | 'quality_review' | 'finance_review' | 'management_review',
  newData: { decision, remarks, score }
}
```

---

## API Endpoints

```
PUT /api/v1/vendor-approval/:id/scm-review
    Body: { decision, remarks, scm_score, products_verified, capacity_verified, ... }

PUT /api/v1/vendor-approval/:id/quality-review
    Body: { decision, remarks, quality_score, iso_verified, inspection_capability, ... }

PUT /api/v1/vendor-approval/:id/finance-review
    Body: { decision, remarks, finance_score, gst_verified, pan_verified, bank_verified, ... }

PUT /api/v1/vendor-approval/:id/management-review
    Body: { decision: 'Approved'|'Conditional Approval'|'Rejected', remarks }

GET /api/v1/vendor-approval/queue?stage=scm|quality|finance|management
```
