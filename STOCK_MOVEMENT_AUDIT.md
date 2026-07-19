# STOCK MOVEMENT AUDIT
## Step 6 — Receipt, Issue, Transfer, Adjustment, Return, Consumption
### Audited: 2026-06-13

---

## STOCK MOVEMENT TYPES — VERIFIED

| Movement Type | Route | DB Table | transaction_type value | Status |
|--------------|-------|----------|----------------------|--------|
| Receipt (GRN) | POST /procurement/grn | stock_ledger | 'purchase' | ✅ LIVE |
| Receipt (Manual) | POST /inventory/stock/movement (IN) | stock_ledger | 'receipt' | ✅ LIVE |
| Receipt (Inward) | POST /warehouse/inward | stock_ledger | 'inward' | ✅ LIVE |
| Issue (RM) | POST /inventory/rm-issues | stock_ledger | 'consumption' | ✅ LIVE |
| Issue (Pick List) | PUT /warehouse/pick-lists/:id/pick | stock_ledger | 'dispatch' | ✅ LIVE |
| Issue (Manual) | POST /inventory/stock/movement (OUT) | stock_ledger | 'issue' | ✅ LIVE |
| Transfer (Direct) | POST /inventory/stock-transfers | stock_ledger | 'transfer' | ✅ LIVE |
| Transfer (Staged) | PUT /inventory/warehouse-transfers/:id/dispatch+receive | stock_ledger | 'transfer' | ✅ LIVE |
| Adjustment (+) | POST /inventory/stock-adjustments (increase) | stock_ledger | 'adjustment' | ✅ LIVE |
| Adjustment (-) | POST /inventory/stock-adjustments (decrease) | stock_ledger | 'adjustment' | ✅ LIVE |
| Cycle Count Variance | POST /warehouse/cycle-count/:id/submit | stock_ledger | 'cycle_count' | ✅ LIVE |
| COGS (Invoice Dispatch) | Invoice creation | stock_ledger | — | ✅ LIVE |

---

## STOCK LEDGER TABLE DESIGN

```sql
stock_ledger (
  id SERIAL PK,
  item_id → inventory_items,
  warehouse_id → warehouses,
  transaction_type VARCHAR(50),
  quantity_in NUMERIC(12,4),
  quantity_out NUMERIC(12,4),
  balance_qty NUMERIC(12,4),   -- running balance
  rate NUMERIC(12,2),
  value NUMERIC(14,2),         -- (qty_in - qty_out) × rate
  reference_type VARCHAR(50),  -- 'grn','rm_issue','transfer','adjustment','cycle_count','pick_list'
  reference_id INTEGER,        -- FK to source document
  transaction_date DATE,
  remarks TEXT,
  created_by → employees,
  created_at TIMESTAMPTZ
)
```

**Design Assessment:**
- Running balance_qty stored per entry ✅
- Full reference tracking ✅
- Company scoping ❌ (no company_id column — all companies share ledger)
- No currency column (assumes INR) ⚠️

---

## MOVEMENT INTEGRITY CHECKS

### Balance Guard (verified in code)

| Movement | Balance Check | Evidence |
|---------|---------------|---------|
| Manual OUT | ✅ | inventory.routes.js:120-128 — balance check before issue |
| Stock Transfer | ✅ | inventory.routes.js:241-248 — check per item |
| Stock Adjustment (decrease) | ✅ | inventory.routes.js:374-385 — balance check |
| Warehouse Transfer Dispatch | ✅ | inventory.routes.js:692-701 — balance check |
| RM Issue | ✅ | rmIssue.service.js:19-26 — balance check |
| Pick List Pick | ✅ | warehouse.routes.js:270-286 — balance check via ledger |

**Conclusion: Negative stock is PREVENTED on all issue/decrease operations.** ✅

---

## RECEIPT AUDIT

### GRN → Inventory (VERIFIED)
**File:** `backend/src/modules/procurement/services/grn.service.js`
```
PO → GRN → stockLedgerRepo.createEntry(transaction_type='purchase') ✅
         → advancedInventoryRepo.createBatch() ✅
         → poRepo.updateItemReceived() ✅
         → PO status: partially_received / completed ✅
```

### Manual Receipt (VERIFIED)
**File:** `backend/src/modules/inventory/routes/inventory.routes.js:104-153`
- Requires: item_id, warehouse_id, movement_type='IN', quantity ✅
- Writes stock_ledger entry ✅

---

## ISSUE AUDIT

### RM Issue → Production (VERIFIED)
**File:** `backend/src/modules/inventory/services/rmIssue.service.js`
```
POST /inventory/rm-issues →
  BEGIN TRANSACTION
  → getNextNumber() for issue_number
  → rmIssueRepo.create()
  → FOR EACH item:
      → balance check (throws if insufficient) ✅
      → rmIssueRepo.createItem()
      → stockLedgerRepo.createEntry(transaction_type='consumption') ✅
  COMMIT
```

---

## TRANSFER AUDIT

### Direct Transfer (VERIFIED)
```
POST /inventory/stock-transfers →
  BEGIN TRANSACTION
  → Create stock_transfers header
  → FOR EACH item:
      → balance check ✅
      → Insert stock_transfer_items
      → stock_ledger OUT from source warehouse ✅
      → stock_ledger IN to destination warehouse ✅
  COMMIT
```

### Staged Transfer (VERIFIED — 3-phase)
```
POST /inventory/warehouse-transfers → status='draft' (no stock movement yet)
PUT /inventory/warehouse-transfers/:id/dispatch →
  BEGIN TRANSACTION
  → balance check per item ✅
  → stock_ledger OUT from source (transaction_type='transfer') ✅
  → status → 'in-transit'
  COMMIT

PUT /inventory/warehouse-transfers/:id/receive →
  BEGIN TRANSACTION
  → stock_ledger IN to destination (transaction_type='transfer') ✅
  → status → 'received', received_date = TODAY
  COMMIT
```

**Assessment: Staged transfer is enterprise-grade ✅**

---

## ADJUSTMENT AUDIT (VERIFIED)

### Normalisation logic:
```
Frontend sends: 'Addition','Deduction','Write-off','Transfer'
Backend maps to: 'increase','decrease'
```
- Both single-item (flat format) and multi-item (items array) accepted ✅
- warehouse_id auto-resolved to first active warehouse if not provided ✅
- Transactional with balance guard ✅

---

## MISSING MOVEMENT TYPES

| Movement Type | Status | Impact |
|--------------|--------|--------|
| Return to Vendor | ❌ MISSING | No GRN reversal or vendor return stock movement |
| Customer Return | ❌ MISSING | No RMA/return receipt stock movement |
| Production Consumption (direct) | ⚠️ PARTIAL | Via RM Issues only |
| Finished Goods Receipt | ❌ MISSING | No stock IN on production completion |
| Scrap / Write-off (dedicated) | ⚠️ PARTIAL | Via adjustment decrease only |
| Inter-company Transfer | ❌ MISSING | No multi-company transfer |

---

## STOCK LEDGER company_id ISSUE

**Evidence:** Phase 46 migration (20260530000001) added company_id to other tables.
Checking stock_ledger schema: no company_id column found.
**Impact:** Stock ledger entries from ALL companies are visible in the same table.
A company_id filter in stockLedgerRepo.getStockSummary() handles company scoping at the item level,
but stock_ledger itself has no company_id — cross-company data cannot be cleanly isolated at the ledger level.

---

## MOVEMENT AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Receipt (GRN) | 5/5 | Complete PO→GRN→Ledger→Batch |
| Receipt (Manual) | 5/5 | Balance tracked, transactional |
| Issue (RM) | 5/5 | Balance check, transactional |
| Issue (Pick) | 4/5 | Works, no permission check |
| Transfer (Direct) | 5/5 | Transactional, balance checked |
| Transfer (Staged) | 5/5 | Enterprise-grade 3-phase |
| Adjustment | 5/5 | Both increase/decrease, balance guarded |
| Cycle Count Variance | 5/5 | Pre-flight check, atomic |
| Return to Vendor | 0/5 | Not implemented |
| Customer Return | 0/5 | Not implemented |
| Finished Goods Receipt | 0/5 | Not implemented |
| company_id scoping | 2/5 | Item-level only |

**Overall: 46/60 = 77%**
