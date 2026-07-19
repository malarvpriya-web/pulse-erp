# STOCK TRANSFER AUDIT
## Step 9 — Warehouse, Project, Site, Service Transfers + Approval
### Audited: 2026-06-13

---

## TWO TRANSFER MECHANISMS

### Mechanism 1: Direct Transfer (stock_transfers table)
**Route:** POST /inventory/stock-transfers
**File:** inventory.routes.js:223-297
**Workflow:** Single-step — immediate stock movement on POST

### Mechanism 2: Staged Transfer (warehouse_transfers table)
**Route:** POST /inventory/warehouse-transfers → dispatch → receive
**File:** inventory.routes.js:631-779 (InventoryIntelligence page)
**Workflow:** draft → in-transit → received (3-phase)

---

## DATABASE SCHEMA AUDIT

### stock_transfers
```sql
  id, transfer_number VARCHAR(50) UNIQUE,
  from_warehouse_id → warehouses,
  to_warehouse_id → warehouses,
  transfer_date DATE NOT NULL,
  transferred_by INTEGER,
  notes TEXT,
  created_at, deleted_at
```

### stock_transfer_items
```sql
  id, transfer_id → stock_transfers,
  item_id → inventory_items,
  quantity NUMERIC(15,4),
  created_at
```

### warehouse_transfers
```sql
  id, transfer_number VARCHAR(50) UNIQUE,
  from_warehouse_id → warehouses,
  to_warehouse_id → warehouses,
  items JSONB NOT NULL DEFAULT '[]',  ← items stored as JSON
  status VARCHAR(20) CHECK(draft/in-transit/received/cancelled),
  transfer_date DATE,
  received_date DATE,
  notes TEXT,
  created_by INTEGER,
  created_at, deleted_at
```

---

## TRANSFER TYPES VERIFIED

| Transfer Type | Route | Status | Notes |
|--------------|-------|--------|-------|
| Warehouse → Warehouse | POST /inventory/stock-transfers | ✅ LIVE | Both tables |
| Staged W→W (draft) | POST /inventory/warehouse-transfers | ✅ LIVE | draft status |
| Staged W→W (dispatch) | PUT /inventory/warehouse-transfers/:id/dispatch | ✅ LIVE | stock OUT from source |
| Staged W→W (receive) | PUT /inventory/warehouse-transfers/:id/receive | ✅ LIVE | stock IN at destination |
| Project Transfer | ❌ MISSING | — | No project_id in transfer tables |
| Site Transfer | ❌ MISSING | — | No site_id in transfer tables |
| Service Transfer | ❌ MISSING | — | No service_order_id |
| Return Transfer | ❌ MISSING | — | No return/reversal flow |
| Inter-company Transfer | ❌ MISSING | — | No company reference |

---

## TRANSFER INTEGRITY CHECKS

### Direct Transfer
```javascript
// Per item balance check:
const balRes = await client.query(
  `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
   FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
  [item.item_id, req.body.from_warehouse_id]
);
const available = parseFloat(balRes.rows[0].balance);
if (available < parseFloat(item.quantity)) {
  throw new Error(`Insufficient stock...`); // ✅ GUARDED
}
```

### Staged Transfer Dispatch
```javascript
if (available < qty) {
  throw Object.assign(
    new Error(`Insufficient stock for item ${item.item_id}...`),
    { status: 422 }
  ); // ✅ GUARDED
}
```

---

## APPROVAL WORKFLOW — MISSING

| Approval Feature | Status | Impact |
|-----------------|--------|--------|
| Transfer Approval before dispatch | ❌ MISSING | Anyone with edit permission can dispatch |
| Approval workflow integration | ❌ MISSING | No workflow_engine hook |
| Value threshold approval | ❌ MISSING | High-value transfers not auto-escalated |
| Manager sign-off | ❌ MISSING | No approval_by column |

---

## TRANSFER AUDIT SCORE

| Feature | Score | Notes |
|---------|-------|-------|
| Warehouse Transfer (direct) | 5/5 | Full balance check, transactional |
| Staged Transfer Workflow | 5/5 | Enterprise-grade, 3-phase |
| Project Transfer | 0/5 | Not implemented |
| Site Transfer | 0/5 | Not implemented |
| Service Transfer | 0/5 | Not implemented |
| Approval Workflow | 0/5 | Not implemented |
| Transfer History | 4/5 | Via stock_ledger reference_type='transfer' |
| Cancellation | 1/5 | warehouse_transfers has 'cancelled' status but no cancel route |

**Overall: 15/40 = 38% — Only warehouse-to-warehouse supported**
