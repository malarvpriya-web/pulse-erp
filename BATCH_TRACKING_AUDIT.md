# BATCH TRACKING AUDIT
## Step 7 — Batch Creation, Allocation, Traceability, Consumption, History
### Audited: 2026-06-13

---

## DATABASE SCHEMA — inventory_batches

```sql
inventory_batches:
  id SERIAL PK
  item_id → inventory_items(id) ON DELETE CASCADE
  warehouse_id → warehouses(id) ON DELETE CASCADE
  batch_number VARCHAR(100) NOT NULL
  received_date DATE NOT NULL DEFAULT CURRENT_DATE
  expiry_date DATE (nullable)
  supplier_id → vendors(id) ON DELETE SET NULL
  grn_id INTEGER (soft link to goods_received_notes)
  quantity_received NUMERIC(15,4) NOT NULL DEFAULT 0
  quantity_available NUMERIC(15,4) NOT NULL DEFAULT 0
  quantity_consumed NUMERIC(15,4) NOT NULL DEFAULT 0
  quantity_reserved NUMERIC(15,4) NOT NULL DEFAULT 0
  rate NUMERIC(15,4) NOT NULL DEFAULT 0
  status VARCHAR(20) CHECK(active/depleted/expired) NOT NULL DEFAULT 'active'
  deleted_at TIMESTAMPTZ
  created_at / updated_at TIMESTAMPTZ
```

**INDEX:** `idx_inv_batches_item_wh ON inventory_batches(item_id, warehouse_id)` ✅

---

## VIEW — v_batch_stock

```sql
v_batch_stock:
  ALL inventory_batches columns
  + item_code, item_name, unit_of_measure (from inventory_items)
  + warehouse_name (from warehouses)
  + age_days (CURRENT_DATE - received_date)
  + stock_value (quantity_available × rate)
  + stock_status ('depleted'/'expiring_soon'/'active') -- derived
```

---

## BATCH OPERATIONS AUDIT

| Operation | API | DB | Status |
|-----------|-----|----|----|
| Create Batch | POST /inventory/advanced/batches | inventory_batches INSERT | ✅ LIVE |
| List Batches | GET /inventory/advanced/batches | v_batch_stock SELECT | ✅ LIVE |
| Consume Batch | PUT /inventory/advanced/batches/:id/consume | inventory_batches UPDATE | ✅ LIVE |
| Batch from GRN | createBatch() called from grn.service.js | inventory_batches INSERT | ✅ AUTO |
| Filter by item | ?item_id= | v_batch_stock WHERE | ✅ |
| Filter by warehouse | ?warehouse_id= | v_batch_stock WHERE | ✅ |
| Filter by status | ?status= | v_batch_stock WHERE | ✅ |
| Batch allocation | POST /inventory/advanced/allocations | inventory_allocations INSERT | ✅ LIVE |
| Reserve batch | POST /inventory/advanced/reservations (with batch_id) | inventory_reservations | ✅ LIVE |
| Batch UPDATE | ❌ MISSING | — | No edit endpoint |
| Batch DELETE | ❌ MISSING | — | No soft delete via API |
| Batch history | ❌ MISSING | — | No history/audit trail endpoint |

---

## BATCH CREATION FLOWS

### Auto-creation on GRN (VERIFIED)
**File:** `backend/src/modules/procurement/services/grn.service.js:33-43`
```javascript
await advancedInventoryRepo.createBatch({
  item_id: item.item_id,
  warehouse_id: data.warehouse_id,
  batch_number: item.batch_number || `GRN-${grnNumber}-${item.item_id.substring(0,4)}`,
  received_date: data.received_date,
  expiry_date: item.expiry_date || null,
  supplier_id: po.supplier_id,  // ← Vendor linked ✅
  grn_id: grn.id,               // ← GRN linked ✅
  quantity_received: item.quantity_received,
  rate: item.rate
});
```
**Vendor → Batch link: ✅ (supplier_id)**
**GRN → Batch link: ✅ (grn_id)**

### Manual Batch Creation (VERIFIED)
**File:** `BatchTracking.jsx:56-60`
- Form: item_id, warehouse_id, batch_number, received_date, expiry_date, supplier_id, quantity_received, rate
- API: POST /inventory/advanced/batches ✅

---

## BATCH TRACEABILITY — CRITICAL ASSESSMENT

### Question: "Which production order consumed IGBT batch IGBT-APR-01?"

**Available data:**
- inventory_batches.id → grn_id → goods_received_notes → purchase_order_id → vendor
- inventory_reservations.batch_id → reference_type, reference_id (can link to production order)
- inventory_allocations.batch_id → reference_type, reference_id

**Verdict: PARTIAL**
- Batch → GRN → Vendor ✅ (batch.grn_id, batch.supplier_id)
- Batch → Reservation (production order) ✅ IF reservation was created with batch_id and reference_type='production_order'
- Batch → Stock Ledger ❌ (stock_ledger has no batch_id column — cannot trace batch consumption from ledger)
- Batch → Customer ❌ (no dispatch record links batch to sales order or customer)

### Question: "Which customer received batch capacitor C-2026-04?"
**Answer: CANNOT BE ANSWERED** — stock_ledger has no batch_id; dispatch/pick_list has no batch_id
**Classification: TRACEABILITY FAILURE for batch→customer chain**

---

## EXPIRY TRACKING

| Feature | Status |
|---------|--------|
| expiry_date field in batch | ✅ Present |
| Expiring soon view (30 days) | ✅ v_batch_stock.stock_status='expiring_soon' |
| Expiring batches count in dashboard | ✅ advanced/dashboard |
| Auto-expire status update | ❌ MISSING — no cron/trigger to set status='expired' |
| Alert on expiry | ❌ MISSING — no auto stock_alert created for expiring batches |

---

## BATCH TRACKING AUDIT SCORE

| Category | Score | Notes |
|----------|-------|-------|
| Batch Creation (manual) | 5/5 | Complete |
| Batch Creation (auto GRN) | 5/5 | Complete, vendor+GRN linked |
| Batch Allocation | 4/5 | Works, no batch-level stock ledger link |
| Batch Traceability (to GRN/vendor) | 5/5 | Via grn_id and supplier_id |
| Batch Traceability (to production) | 3/5 | Via reservations only |
| Batch Traceability (to customer) | 0/5 | MISSING — no batch→dispatch→customer |
| Expiry Tracking | 3/5 | View exists, no auto-expire |
| Batch History/Audit Trail | 1/5 | Only via stock_ledger (no batch_id) |

**Overall: 26/40 = 65%**
