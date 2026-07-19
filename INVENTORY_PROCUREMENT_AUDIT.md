# INVENTORY ↔ PROCUREMENT INTEGRATION AUDIT
## Step 12 — PO → GRN → Inventory → Finance
### Audited: 2026-06-13

---

## INTEGRATION FLOW VERIFIED

### PO → GRN → Inventory Chain

```
POST /procurement/grn → grn.service.js:createGRN()
  BEGIN TRANSACTION
  ├── poRepo.findById(po_id)                   → get PO + supplier_id
  ├── grnRepo.getNextNumber()                  → auto GRN number
  ├── grnRepo.create()                         → INSERT goods_received_notes
  ├── FOR EACH item:
  │   ├── grnRepo.createItem()                 → INSERT grn_items
  │   ├── poRepo.updateItemReceived()          → UPDATE purchase_order_items.received_quantity
  │   ├── advancedInventoryRepo.createBatch()  → INSERT inventory_batches ✅
  │   │     (supplier_id, grn_id linked)
  │   └── stockLedgerRepo.createEntry()        → INSERT stock_ledger (transaction_type='purchase') ✅
  ├── Check if all items received:
  │   ├── allReceived → poRepo.updateStatus('completed') ✅
  │   └── partial    → poRepo.updateStatus('partially_received') ✅
  COMMIT
```

**Status: ✅ COMPLETE — PO→GRN→Inventory is fully wired**

---

## DETAILED VERIFICATION

| Integration Point | File | Status |
|-----------------|------|--------|
| GRN creates stock_ledger entry | grn.service.js:46-58 | ✅ VERIFIED |
| GRN creates inventory_batch | grn.service.js:33-43 | ✅ VERIFIED |
| GRN links batch to supplier | grn.service.js:37 (supplier_id: po.supplier_id) | ✅ VERIFIED |
| GRN links batch to grn_id | grn.service.js:39 (grn_id: grn.id) | ✅ VERIFIED |
| PO status update on receipt | grn.service.js:63-70 | ✅ VERIFIED |
| Partial receipt tracking | poRepo.updateItemReceived() | ✅ VERIFIED |
| Warehouse destination | data.warehouse_id passed through | ✅ VERIFIED |

---

## RETURNS → INVENTORY

### Vendor Return Flow
**Status: ❌ MISSING**
- No route for vendor return (debit note updates but no stock OUT movement)
- debitNotes.routes.js exists but does not create stock_ledger entries
- A vendor return should: stock_ledger OUT from warehouse + debit note to vendor

### Goods Return Note (GRN Reversal)
**Status: ❌ MISSING**
- No route for reversing a GRN
- No reject-on-GRN flow (items that fail QC inspection)

---

## VENDOR REPLACEMENT → INVENTORY

**Status: ❌ MISSING**
- No replacement receipt flow (rejected goods returned, replacement received)
- This should be: Vendor Return (stock OUT) → New GRN (stock IN) — not automated

---

## REORDER → PROCUREMENT LINK

**Auto-generate PRs from reorder alerts (VERIFIED):**
```javascript
// inventory.routes.js:502-522
POST /inventory/reorder-alerts/generate-pos
  → For each item_id:
    purchaseRequestRepo.create({
      request_number,
      requested_by_employee_id,
      notes: 'Auto-generated reorder alert for item_name',
      items: [{ item_id, item_name, quantity: reorder_level * 2 }]
    })
```
**Status: ✅ LIVE — Creates purchase_requests from reorder alerts**

**Purchase Suggestion → PR conversion (VERIFIED):**
```javascript
// advancedInventory.routes.js:165-186
POST /inventory/advanced/purchase-suggestions/:id/convert
  → purchaseRequestRepo.create()
  → repo.convertSuggestionToPR()
```
**Status: ✅ LIVE**

---

## LANDED COST → INVENTORY

**Status: ✅ LIVE (calculation only)**
```
POST /inventory/landed-costs → stores freight+customs+insurance+other
POST /inventory/landed-costs/:id/allocate → allocates to PO items by value or qty
```
**Gap:** Landed cost allocation does NOT update stock_ledger rates.
The actual inventory cost per unit is not adjusted upward when landed costs are allocated.
**Impact:** Valuation understates true landed cost per item.

---

## PROCUREMENT INTEGRATION SCORE

| Flow | Score | Notes |
|------|-------|-------|
| PO → GRN | 5/5 | Complete |
| GRN → Stock Ledger | 5/5 | Transactional |
| GRN → Batch creation | 5/5 | Supplier + GRN linked |
| PO status tracking | 5/5 | partial/completed |
| Vendor Return → Stock | 0/5 | Not implemented |
| Replacement → Stock | 0/5 | Not implemented |
| GRN → GL Journal | 0/5 | Not implemented (only COGS on invoice) |
| Reorder → Auto PR | 5/5 | Implemented |
| Suggestion → PR | 5/5 | Implemented |
| Landed Cost → Rate | 1/5 | Stored but not applied to stock rates |

**Overall: 31/50 = 62%**
