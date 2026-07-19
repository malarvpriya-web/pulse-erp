# VENDOR DOCUMENT STRATEGY — Phase 49C-7/8

## Document Types

### Compliance Documents
| Document | Required | Expiry | Verification By |
|----------|----------|--------|----------------|
| GST Certificate | Mandatory | Annual | Finance |
| PAN | Mandatory | Never | Finance |
| MSME Certificate | If applicable | Never | Finance |
| Udyam Certificate | If applicable | Never | Finance |
| Factory License | Manufacturing vendors | Annual | Quality |
| Import Export (IEC) | Import vendors | Never | SCM |

### Quality Documents
| Document | Required | Expiry | Verification By |
|----------|----------|--------|----------------|
| ISO 9001 Certificate | Preferred | 3 years | Quality |
| ISO 14001 Certificate | Environmental | 3 years | Quality |
| IATF 16949 | Automotive | 3 years | Quality |
| Test Reports | Product-specific | Per batch | Quality |
| Quality Certificates | Per contract | Per contract | Quality |

### Commercial Documents
| Document | Required | Expiry | Verification By |
|----------|----------|--------|----------------|
| Cancelled Cheque | Mandatory | Never | Finance |
| Bank Proof Letter | Mandatory | 1 year | Finance |
| NDA | Preferred | Per agreement | Legal/Management |
| Supplier Agreement | Mandatory | Per agreement | SCM/Management |
| Technical Catalogues | Preferred | Never | SCM/Quality |

---

## Google Drive Folder Structure (49C-8)

For each approved vendor, a folder is auto-created:
```
Vendors/
└── {Vendor Name}/
    ├── 01 Registration       ← Registration form, submitted documents
    ├── 02 GST                ← GST certificate, filings
    ├── 03 PAN                ← PAN card copy
    ├── 04 Bank               ← Cancelled cheque, bank letter
    ├── 05 Agreements         ← NDA, supplier agreement, contracts
    ├── 06 Certifications     ← ISO, factory license, other certs
    ├── 07 Quotations         ← RFQ responses, commercial quotes
    ├── 08 Purchase Orders    ← All POs issued to this vendor
    ├── 09 Quality Records    ← Inspection reports, test results
    ├── 10 Audits             ← Vendor audit reports
    ├── 11 NCR                ← Non-conformance reports
    ├── 12 CAPA               ← Corrective action records
    ├── 13 Invoices           ← Vendor invoices
    └── 14 Payments           ← Payment advice, remittances
```

### Drive Integration Flow
1. Management approves vendor
2. System calls Google Drive API to create root folder under `Vendors/`
3. 14 subfolders created automatically
4. `vendor_drive_folders` table populated with folder IDs
5. `vendors.vendor_folder_id` and `vendors.vendor_folder_url` updated
6. Future document uploads go to the appropriate subfolder

### Saving Drive Details
```sql
-- vendor_drive_folders
root_folder_id   VARCHAR(200)  -- Google Drive folder ID
root_folder_url  TEXT          -- Shareable link
folder_map       JSONB         -- { "01_Registration": "folder_id", ... }

-- vendor_documents
drive_file_id    VARCHAR(200)  -- Specific file ID in Drive
drive_file_url   TEXT          -- Direct file link
drive_folder_id  VARCHAR(200)  -- Parent folder ID
```

---

## Document Verification Process

```
Upload → vendor_documents (verified=false)
           │
           ▼
    Finance/Quality reviews document
           │
     ┌─────┴─────┐
     │  Verified  │
     └─────┬─────┘
           ▼
    verified=true, verified_by=user_id, verified_at=now()
```

---

## Document Expiry Tracking

Expiry dates stored in `vendor_documents.expiry_date`.
Documents expiring within 30 days trigger alerts in the Vendor Dashboard.

```sql
SELECT v.vendor_name, d.doc_type, d.expiry_date
FROM vendor_documents d
JOIN vendors v ON v.id = d.vendor_id
WHERE d.expiry_date < NOW() + INTERVAL '30 days'
AND d.expiry_date > NOW()
ORDER BY d.expiry_date ASC;
```

---

## API Endpoints

```
POST /api/v1/vendor-registration/:id/documents     — attach doc to registration
POST /api/v1/vendor-approval/vendors/:id/documents — attach doc to approved vendor
PUT  /api/v1/vendor-approval/documents/:id/verify  — Finance/Quality verification
GET  /api/v1/vendor-approval/vendors/:id/documents — list all vendor docs

POST /api/v1/vendor-registration/:id/drive-folder  — save Drive folder mapping
```
