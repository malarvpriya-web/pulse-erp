# INVENTORY ↔ QUALITY INTEGRATION AUDIT
## Step 14 — Incoming Inspection, Stock Hold, Rejected Material, NCR, CAPA
### Audited: 2026-06-13

---

## QUALITY ROUTES — quality.routes.js

**Mount:** `v1Router.use("/quality", verifyToken, qualityRoutes)`

The QualityManagement.jsx page calls `/quality/checklists` routes.
The quality module is a separate module from inventory.

---

## INCOMING INSPECTION

### Warehouse Inward — Inspection Flag (VERIFIED)
**File:** `backend/src/modules/warehouse/warehouse.routes.js:108`
```javascript
POST /warehouse/inward
Input: { gr_number, supplier, items, bin_id, inspection_required = false }

if (!inspection_required && warehouseId) {
  // Write stock_ledger entry (items go to storage) ✅
} else {
  // Items held for inspection, NOT added to stock_ledger ✅
  return { status: 'pending_inspection' }
}
```

**Verdict:** Inspection hold flag exists at the bin/inward level.
When `inspection_required=true`, items are NOT added to stock_ledger.

### GRN → Inspection
**File:** `backend/src/modules/procurement/services/grn.service.js`
**Finding:** GRN service does NOT support `inspection_required`. It always creates:
1. inventory_batches entry ✅
2. stock_ledger entry with transaction_type='purchase' ✅

**Gap:** GRN bypasses inspection — items from formal PO/GRN go directly to available stock without quality hold.

---

## STOCK HOLD TRACKING

| Feature | Status | Evidence |
|---------|--------|----------|
| Hold flag on batch | ❌ MISSING | inventory_batches has no 'hold' or 'quarantine' status |
| Quarantine stock tracking | ❌ MISSING | No quarantine_qty or hold_qty in inventory_batches |
| Hold reason | ❌ MISSING | No field |
| Approved stock label | ❌ MISSING | No approved_status field |
| Rejected material status | ❌ MISSING | No rejected_qty |
| Stock Hold via GRN | ❌ MISSING | GRN always goes to available stock |

**The `inventory_batches.status` only supports: active/depleted/expired**
**Missing statuses: hold/quarantine/rejected/approved**

---

## NCR (NON-CONFORMANCE REPORT)

**Status: ❌ MISSING**
No NCR table, no NCR routes, no NCR UI in inventory module.
The quality module may have quality_checklists but no NCR linkage to inventory.

---

## CAPA (CORRECTIVE AND PREVENTIVE ACTION)

**Status: ❌ MISSING**
No CAPA table linked to inventory quality holds.

---

## RELEASE TO STOCK

**Status: ❌ MISSING**
There is no "Release to Stock" API that:
1. Changes batch status from 'hold' to 'active'
2. Creates stock_ledger entry for items cleared by QC
3. Links to quality inspection record

---

## QUALITY CHECKLIST (QualityManagement.jsx)

**Available:**
- GET /quality/checklists → list checklists
- POST /quality/checklists → create checklist
- PUT /quality/checklists/:id → update checklist
- Checklist types: inward, in-process, final

**Gap:** Quality checklists have no direct link to:
- inventory_batches (no batch_id on checklist)
- goods_received_notes (no grn_id on checklist)
- stock holds or release actions

---

## MANIFEST QUALITY REQUIREMENTS

| Requirement | Status | Impact |
|------------|--------|--------|
| Incoming IGBT inspection | ❌ | Cannot hold IGBT batch for QC before stock |
| FPGA/DSP incoming test | ❌ | No inspection workflow |
| Capacitor bank QC hold | ❌ | No quarantine status |
| Rejected material tracking | ❌ | No rejected stock classification |
| Approved Stock label | ❌ | No approved_status on batch |
| Warranty return stock | ❌ | No warranty_return stock type |
| Repair stock | ❌ | No repair_stock classification |

---

## QUALITY INTEGRATION SCORE

| Feature | Score | Notes |
|---------|-------|-------|
| Incoming inspection flag (manual) | 3/5 | Warehouse inward only, not GRN |
| Quality checklist | 3/5 | Exists but not linked to inventory |
| Stock Hold / Quarantine | 0/5 | No quarantine status in batch |
| Rejected material | 0/5 | No rejected classification |
| Release to stock | 0/5 | Not implemented |
| NCR | 0/5 | Not implemented |
| CAPA | 0/5 | Not implemented |
| GRN → QC Hold | 0/5 | GRN bypasses inspection |

**Overall: 6/40 = 15% — MAJOR GAP**
